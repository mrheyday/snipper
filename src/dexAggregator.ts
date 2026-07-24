import { ethers } from 'ethers';
import type { Provider } from 'ethers';
import { Logger } from './logger';
import { UNISWAP_V3_QUOTER_ABI } from './abis';
import { DEXType } from './interfaces/dex';
import { QUOTER_ADDRESS } from './config';
import { encodePath } from './uniswap';

const logger = new Logger('DEXAggregator');

export interface DEXProtocolConfig {
  name: string;
  dexType: DEXType;
  routerAddress: string;
  quoterAddress: string;
  /** Uniswap-V3-style factory, used to resolve a pair's pool address for the
   *  Bitquery cross-check (see flashSizer.ts). Not needed for quoting itself —
   *  the Quoter contracts resolve pools internally via their own factory. */
  factoryAddress: string;
  supportedFeeTiers: number[];
}

export interface BestRouteResult {
  protocol: DEXProtocolConfig;
  tokenIn: string;
  tokenOut: string;
  feeTier: number;
  amountIn: bigint;
  amountOut: bigint;
  executionPrice: bigint;
}

// Camelot V3 (Algebra engine — dynamic fees, no fee bytes in its path encoding, different
// exactInputSingle call shape) and Ramses (Solidly-family AMM — stable/volatile pool flag,
// different router call shape) are NOT Uniswap-V3-style forks and are deliberately excluded
// from this list, not just from EXECUTION_VENUE_PROTOCOLS: their previous entries pointed at
// addresses with no deployed contract on Arbitrum One, and even correct addresses for them
// would need dedicated adapters, not the exactInput(ExactInputParams) call this file assumes.
// See docs/superpowers/specs/2026-07-23-multi-venue-swap-execution-design.md, "Address
// verification" / "Deferred", for the full verification trail and follow-up scope.
export const ARBITRUM_DEX_PROTOCOLS: DEXProtocolConfig[] = [
  {
    name: 'Uniswap V3',
    dexType: DEXType.UNISWAP_V3,
    routerAddress: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoterAddress: QUOTER_ADDRESS || '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    supportedFeeTiers: [100, 500, 3000, 10000],
  },
  {
    name: 'SushiSwap V3',
    dexType: DEXType.UNISWAP_V3,
    routerAddress: '0x8A21F6768C1f8075791D08546Dadf6daA0bE820c',
    quoterAddress: '0x0524E833cCD057e4d7A296e3aaAb9f7675964Ce1',
    factoryAddress: '0x1af415a1EbA07a4986a52B6f2e7dE7003D82231e',
    supportedFeeTiers: [100, 500, 3000, 10000],
  },
  {
    name: 'PancakeSwap V3',
    dexType: DEXType.UNISWAP_V3,
    routerAddress: '0x32226588378236Fd0c7c4053999F88aC0e5cAc77',
    quoterAddress: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
    factoryAddress: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    supportedFeeTiers: [100, 500, 3000, 10000],
  },
];

/** Protocols whose router is wired into SniperSearcher / SwapRouter02-style execution. */
export const EXECUTION_VENUE_PROTOCOLS: DEXProtocolConfig[] = ARBITRUM_DEX_PROTOCOLS;

const UNISWAP_V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
];

/**
 * Resolve a Uniswap-V3-style pool address for a token pair + fee tier via the venue's
 * own factory. Used only by the Bitquery cross-check (flashSizer.ts) — quoting itself
 * doesn't need this, the Quoter contracts resolve pools internally.
 */
export async function resolvePoolAddress(
  factoryAddress: string,
  tokenA: string,
  tokenB: string,
  feeTier: number,
  provider: Provider
): Promise<string | null> {
  try {
    const factory = new ethers.Contract(factoryAddress, UNISWAP_V3_FACTORY_ABI, provider);
    const pool: string = await factory.getPool(tokenA, tokenB, feeTier);
    if (!pool || pool === ethers.ZeroAddress) return null;
    return pool;
  } catch {
    return null;
  }
}

export class DEXAggregator {
  private provider: Provider;
  private protocols: DEXProtocolConfig[];

  /**
   * @param customProtocols Override protocol list. Production flash/direct path
   *   must use Uniswap V3 only (SniperSearcher is hard-wired to SwapRouter02).
   *   Pass full ARBITRUM_DEX_PROTOCOLS only for discovery/research tools.
   */
  constructor(provider: Provider, customProtocols?: DEXProtocolConfig[]) {
    this.provider = provider;
    // Default to Uniswap-only so size and execution share the same venue.
    this.protocols = customProtocols || EXECUTION_VENUE_PROTOCOLS;
  }

  /**
   * Find best swap route across all supported DEXes on Arbitrum
   */
  async findBestRoute(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint
  ): Promise<BestRouteResult | null> {
    logger.info(
      `Aggregating DEX quotes for ${tokenIn} → ${tokenOut} (${amountIn.toString()} wei)...`
    );

    const quotePromises: Promise<BestRouteResult | null>[] = [];

    for (const protocol of this.protocols) {
      for (const feeTier of protocol.supportedFeeTiers) {
        quotePromises.push(
          this.getQuoteForProtocol(protocol, tokenIn, tokenOut, amountIn, feeTier)
        );
      }
    }

    const results = await Promise.allSettled(quotePromises);

    let bestRoute: BestRouteResult | null = null;

    for (const res of results) {
      if (res.status === 'fulfilled' && res.value) {
        const route = res.value;
        if (!bestRoute || route.amountOut > bestRoute.amountOut) {
          bestRoute = route;
        }
      }
    }

    if (bestRoute) {
      logger.info(
        `✓ Best DEX Route: ${bestRoute.protocol.name} (Fee: ${bestRoute.feeTier}) -> Output: ${bestRoute.amountOut.toString()}`
      );
    } else {
      logger.warn(`No valid DEX routes returned a positive quote.`);
    }

    return bestRoute;
  }

  /**
   * Flash-loan sizing quote: borrow asset A, route A→mid→A on one DEX/fee tier.
   * amountOut is back in `tokenIn` units so it is comparable to Aave repayment.
   */
  async findBestRoundTripRoute(
    tokenIn: string,
    midToken: string,
    amountIn: bigint
  ): Promise<BestRouteResult | null> {
    logger.info(
      `Aggregating round-trip quotes ${tokenIn} → ${midToken} → ${tokenIn} (${amountIn.toString()} wei)...`
    );

    const quotePromises: Promise<BestRouteResult | null>[] = [];
    for (const protocol of this.protocols) {
      for (const feeTier of protocol.supportedFeeTiers) {
        quotePromises.push(this.getRoundTripQuote(protocol, tokenIn, midToken, amountIn, feeTier));
      }
    }

    const results = await Promise.allSettled(quotePromises);
    let bestRoute: BestRouteResult | null = null;
    for (const res of results) {
      if (res.status === 'fulfilled' && res.value) {
        const route = res.value;
        if (!bestRoute || route.amountOut > bestRoute.amountOut) {
          bestRoute = route;
        }
      }
    }

    if (bestRoute) {
      logger.info(
        `✓ Best round-trip: ${bestRoute.protocol.name} fee=${bestRoute.feeTier} ` +
          `→ final ${bestRoute.amountOut.toString()} of borrow asset`
      );
    } else {
      logger.warn('No positive round-trip DEX quote.');
    }
    return bestRoute;
  }

  private async getRoundTripQuote(
    protocol: DEXProtocolConfig,
    tokenIn: string,
    midToken: string,
    amountIn: bigint,
    feeTier: number
  ): Promise<BestRouteResult | null> {
    try {
      const quoter = new ethers.Contract(
        protocol.quoterAddress,
        UNISWAP_V3_QUOTER_ABI,
        this.provider
      );
      const pathBuf = encodePath([tokenIn, midToken, tokenIn], [feeTier, feeTier]);
      const pathHex = ethers.hexlify(pathBuf);
      const [amountOut]: [bigint] = await quoter.quoteExactInput.staticCall(pathHex, amountIn);
      if (amountOut && amountOut > 0n) {
        return {
          protocol,
          tokenIn,
          tokenOut: tokenIn, // round-trip ends in borrow asset
          feeTier,
          amountIn,
          amountOut,
          executionPrice: (amountOut * BigInt(ethers.WeiPerEther)) / BigInt(amountIn),
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  private async getQuoteForProtocol(
    protocol: DEXProtocolConfig,
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    feeTier: number
  ): Promise<BestRouteResult | null> {
    try {
      const quoter = new ethers.Contract(
        protocol.quoterAddress,
        UNISWAP_V3_QUOTER_ABI,
        this.provider
      );
      const [amountOut]: [bigint] = await quoter.quoteExactInputSingle.staticCall({
        tokenIn,
        tokenOut,
        amountIn,
        fee: feeTier,
        sqrtPriceLimitX96: 0,
      });

      if (amountOut && amountOut > 0) {
        return {
          protocol,
          tokenIn,
          tokenOut,
          feeTier,
          amountIn,
          amountOut,
          executionPrice: (amountOut * BigInt(ethers.WeiPerEther)) / BigInt(amountIn),
        };
      }
      return null;
    } catch {
      // Return null if pool does not exist or quote reverts
      return null;
    }
  }
}
