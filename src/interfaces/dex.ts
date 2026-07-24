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
  liquidity?: bigint;
  sqrtPriceX96?: bigint;
  tick?: number;
  dex: DEXType;
}

/**
 * Swap parameters
 */
export interface SwapParams {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minAmountOut: bigint;
  deadline: number;
  path?: string[]; // Optional routing path for multi-hop
  feeTiers?: FeeTier[]; // Fee tiers for each hop
  recipient?: string;
}

/**
 * Swap result
 */
export interface SwapResult {
  amountOut: bigint;
  priceImpact: number; // in basis points
  executionPrice: bigint;
  path: string[];
  gasEstimate: bigint;
}

/**
 * Quote result
 */
export interface QuoteResult {
  amountIn: bigint;
  amountOut: bigint;
  priceImpact: number; // in basis points
  executionPrice: bigint;
  fee: bigint;
  gasEstimate: bigint;
}

/**
 * Uniswap V3 specific interfaces
 */
export interface IUniswapV3Pool {
  token0(): Promise<string>;
  token1(): Promise<string>;
  fee(): Promise<FeeTier>;
  liquidity(): Promise<bigint>;
  slot0(): Promise<{
    sqrtPriceX96: bigint;
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
    amountSpecified: bigint,
    sqrtPriceLimitX96: bigint,
    data: string
  ): Promise<unknown>;
}

/**
 * Uniswap V3 Router interface
 */
export interface IUniswapV3Router {
  swapExactTokensForTokens(
    amountIn: bigint,
    amountOutMinimum: bigint,
    path: string[],
    to: string,
    deadline: number
  ): Promise<bigint[]>;

  swapTokensForExactTokens(
    amountOut: bigint,
    amountInMaximum: bigint,
    path: string[],
    to: string,
    deadline: number
  ): Promise<bigint[]>;
}

/**
 * Quote callback for Uniswap V3
 */
export interface IUniswapV3Quoter {
  quoteExactInputSingle(
    tokenIn: string,
    tokenOut: string,
    fee: FeeTier,
    amountIn: bigint,
    sqrtPriceLimitX96: bigint
  ): Promise<{ amountOut: bigint }>;

  quoteExactOutputSingle(
    tokenIn: string,
    tokenOut: string,
    fee: FeeTier,
    amount: bigint,
    sqrtPriceLimitX96: bigint
  ): Promise<{ amountIn: bigint }>;
}

/**
 * DEX Aggregator interface
 */
export interface IDEXAggregator {
  getQuote(params: SwapParams): Promise<QuoteResult>;
  executeSwap(params: SwapParams): Promise<SwapResult>;
  getBestRoute(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<SwapParams>;
}

/**
 * Pool monitoring interface
 */
export interface IPoolMonitor {
  watchPool(poolAddress: string): void;
  unwatchPool(poolAddress: string): void;
  getPriceUpdate(poolAddress: string): Promise<{ price: bigint; timestamp: number }>;
}

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
  gasLimit?: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  slippage: SlippageConfig;
  deadline: number; // in seconds
}
