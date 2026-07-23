import { BigNumber, ethers } from 'ethers';
import { Provider } from '@ethersproject/providers';
import { Logger } from './logger';
import { UNISWAP_V3_QUOTER_ABI } from './abis';
import { DEXType } from './interfaces/dex';
import { QUOTER_ADDRESS } from './config';

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
  amountIn: BigNumber;
  amountOut: BigNumber;
  executionPrice: BigNumber;
}

export const ARBITRUM_DEX_PROTOCOLS: DEXProtocolConfig[] = [
  {
    name: 'Uniswap V3',
    dexType: DEXType.UNISWAP_V3,
    routerAddress: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoterAddress: QUOTER_ADDRESS || '0x61fFe014bA17989E743c5F6cB21bF9697540B21e',
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

export class DEXAggregator {
  private provider: Provider;
  private protocols: DEXProtocolConfig[];

  constructor(provider: Provider, customProtocols?: DEXProtocolConfig[]) {
    this.provider = provider;
    this.protocols = customProtocols || ARBITRUM_DEX_PROTOCOLS;
  }

  /**
   * Find best swap route across all supported DEXes on Arbitrum
   */
  async findBestRoute(
    tokenIn: string,
    tokenOut: string,
    amountIn: BigNumber
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
        if (!bestRoute || route.amountOut.gt(bestRoute.amountOut)) {
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

  private async getQuoteForProtocol(
    protocol: DEXProtocolConfig,
    tokenIn: string,
    tokenOut: string,
    amountIn: BigNumber,
    feeTier: number
  ): Promise<BestRouteResult | null> {
    try {
      const quoter = new ethers.Contract(
        protocol.quoterAddress,
        UNISWAP_V3_QUOTER_ABI,
        this.provider
      );
      const [amountOut]: [BigNumber] = await quoter.callStatic.quoteExactInputSingle({
        tokenIn,
        tokenOut,
        amountIn,
        fee: feeTier,
        sqrtPriceLimitX96: 0,
      });

      if (amountOut && amountOut.gt(0)) {
        return {
          protocol,
          tokenIn,
          tokenOut,
          feeTier,
          amountIn,
          amountOut,
          executionPrice: amountOut.mul(ethers.constants.WeiPerEther).div(amountIn),
        };
      }
      return null;
    } catch {
      // Return null if pool does not exist or quote reverts
      return null;
    }
  }
}
