import { BigNumber } from 'ethers';

/**
 * DEX types and fee tiers
 */
export enum DEXType {
  UNISWAP_V2 = 'uniswap_v2',
  UNISWAP_V3 = 'uniswap_v3',
  UNISWAP_V4 = 'uniswap_v4',
  CURVE = 'curve',
  BALANCER = 'balancer',
  DODO = 'dodo',
  WOMBAT = 'wombat',
}

export enum FeeTier {
  LOWEST = 100, // 0.01%
  LOW = 500, // 0.05%
  MEDIUM = 3000, // 0.3%
  HIGH = 10000, // 1%
}

/**
 * Pool information structure
 */
export interface IPool {
  address: string;
  token0: string;
  token1: string;
  fee?: FeeTier;
  liquidity?: BigNumber;
  sqrtPriceX96?: BigNumber;
  tick?: number;
  dex: DEXType;
}

/**
 * Swap parameters
 */
export interface SwapParams {
  tokenIn: string;
  tokenOut: string;
  amountIn: BigNumber;
  minAmountOut: BigNumber;
  deadline: number;
  path?: string[]; // Optional routing path for multi-hop
  feeTiers?: FeeTier[]; // Fee tiers for each hop
  recipient?: string;
}

/**
 * Swap result
 */
export interface SwapResult {
  amountOut: BigNumber;
  priceImpact: number; // in basis points
  executionPrice: BigNumber;
  path: string[];
  gasEstimate: BigNumber;
}

/**
 * Quote result
 */
export interface QuoteResult {
  amountIn: BigNumber;
  amountOut: BigNumber;
  priceImpact: number; // in basis points
  executionPrice: BigNumber;
  fee: BigNumber;
  gasEstimate: BigNumber;
}

/**
 * Uniswap V3 specific interfaces
 */
export interface IUniswapV3Pool {
  token0(): Promise<string>;
  token1(): Promise<string>;
  fee(): Promise<FeeTier>;
  liquidity(): Promise<BigNumber>;
  slot0(): Promise<{
    sqrtPriceX96: BigNumber;
    tick: number;
    observationIndex: number;
    observationCardinality: number;
    observationCardinalityNext: number;
    feeProtocol: number;
    unlocked: boolean;
  }>;
  swap(
    recipient: string,
    zeroForOne: boolean,
    amountSpecified: BigNumber,
    sqrtPriceLimitX96: BigNumber,
    data: string
  ): Promise<unknown>;
}

/**
 * Uniswap V3 Router interface
 */
export interface IUniswapV3Router {
  swapExactTokensForTokens(
    amountIn: BigNumber,
    amountOutMinimum: BigNumber,
    path: string[],
    to: string,
    deadline: number
  ): Promise<BigNumber[]>;

  swapTokensForExactTokens(
    amountOut: BigNumber,
    amountInMaximum: BigNumber,
    path: string[],
    to: string,
    deadline: number
  ): Promise<BigNumber[]>;
}

/**
 * Quote callback for Uniswap V3
 */
export interface IUniswapV3Quoter {
  quoteExactInputSingle(
    tokenIn: string,
    tokenOut: string,
    fee: FeeTier,
    amountIn: BigNumber,
    sqrtPriceLimitX96: BigNumber
  ): Promise<{ amountOut: BigNumber }>;

  quoteExactOutputSingle(
    tokenIn: string,
    tokenOut: string,
    fee: FeeTier,
    amount: BigNumber,
    sqrtPriceLimitX96: BigNumber
  ): Promise<{ amountIn: BigNumber }>;
}

/**
 * DEX Aggregator interface
 */
export interface IDEXAggregator {
  getQuote(params: SwapParams): Promise<QuoteResult>;
  executeSwap(params: SwapParams): Promise<SwapResult>;
  getBestRoute(tokenIn: string, tokenOut: string, amountIn: BigNumber): Promise<SwapParams>;
}

/**
 * Pool monitoring interface
 */
export interface IPoolMonitor {
  watchPool(poolAddress: string): void;
  unwatchPool(poolAddress: string): void;
  getPriceUpdate(poolAddress: string): Promise<{ price: BigNumber; timestamp: number }>;
}

/**
 * Known DEX addresses on Arbitrum
 */
export const DEX_ADDRESSES = {
  arbitrum: {
    uniswapV3Router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    uniswapV3Factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    uniswapV3Quoter: '0xb27F1F9b63B33565Db3F05B3d9cFDA23dd927d0f',
    curveFactory: '0x0C0e5f27145aa72D1A2973d60741d84d0b062bC3',
    balancerVault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    dodoDpp: '0xE4b2Dfc82976062a6a0eB6e0564af5547AB41ffb',
  },
  ethereum: {
    uniswapV3Router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    uniswapV3Factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    uniswapV3Quoter: '0xb27F1F9b63B33565Db3F05B3d9cFDA23dd927d0f',
  },
};

/**
 * Slippage tolerance (in basis points)
 */
export interface SlippageConfig {
  tolerance: number; // in basis points (e.g., 50 = 0.5%)
  maxImpact: number; // max price impact in basis points
}

/**
 * Execution config
 */
export interface ExecutionConfig {
  gasLimit?: BigNumber;
  gasPrice?: BigNumber;
  maxFeePerGas?: BigNumber;
  maxPriorityFeePerGas?: BigNumber;
  slippage: SlippageConfig;
  deadline: number; // in seconds
}
