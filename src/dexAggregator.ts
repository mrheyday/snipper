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

export const ARBITRUM_DEX_PROTOCOLS: DEXProtocolConfig[] = [
  {
    name: 'Uniswap V3',
    dexType: DEXType.UNISWAP_V3,
    routerAddress: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoterAddress: QUOTER_ADDRESS || '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    supportedFeeTiers: [100, 500, 3000, 10000],
  },
  {
    name: 'Camelot V3',
    dexType: DEXType.UNISWAP_V3,
    routerAddress: '0x1f721E29952737f584742468A36dB1B0A6FAaA4e',
    quoterAddress: '0x05b2210874e4c27892b157a92ddf3e5caecbca7a',
    supportedFeeTiers: [100, 500, 3000],
  },
  {
    name: 'Ramses V2',
    dexType: DEXType.UNISWAP_V3,
    routerAddress: '0xAAA8888997e59099A6d43576d313d1000ee72023',
    quoterAddress: '0xAAACa9dFf3F66b1070A647242880b91e9f13e73A',
    supportedFeeTiers: [100, 500, 3000],
  },
  {
    name: 'SushiSwap V3',
    dexType: DEXType.UNISWAP_V3,
    routerAddress: '0x8A21F534350174092bF581A056D43B59a997A811',
    quoterAddress: '0x0d4A22F2d2DDCe8d753c1869E4c1d739B948332C',
    supportedFeeTiers: [100, 500, 3000, 10000],
  },
  {
    name: 'PancakeSwap V3',
    dexType: DEXType.UNISWAP_V3,
    routerAddress: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4',
    quoterAddress: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
    supportedFeeTiers: [100, 500, 3000, 10000],
  },
];

/** Protocols whose router is wired into SniperSearcher / SwapRouter02 execution. */
export const EXECUTION_VENUE_PROTOCOLS: DEXProtocolConfig[] = ARBITRUM_DEX_PROTOCOLS.filter(
  (p) => p.name === 'Uniswap V3'
);

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
