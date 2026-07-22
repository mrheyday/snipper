import { BigNumber } from 'ethers';

/**
 * Slippage Guard Configuration
 */
export interface SlippageConfig {
  maxSlippageBps: number; // Maximum slippage in basis points (e.g., 50 = 0.5%)
  maxPriceImpactBps: number; // Maximum price impact in basis points
  minProfitBps: number; // Minimum profit threshold in basis points
  emergencySlippageBps: number; // Emergency mode slippage limit (higher tolerance)
}

/**
 * Slippage Analysis Result
 */
export interface SlippageAnalysis {
  expectedOutput: BigNumber;
  minAmountOut: BigNumber;
  slippageBps: number; // in basis points
  priceImpactBps: number;
  isAcceptable: boolean;
  safetyMargin: number; // percentage above minimum
  warnings: string[];
}

/**
 * Price Movement Snapshot
 */
export interface PriceSnapshot {
  timestamp: number;
  price: BigNumber;
  liquidity: BigNumber;
}

/**
 * Slippage Guard - Protects against unfavorable price movements
 */
export class SlippageGuard {
  private config: SlippageConfig;
  private priceHistory: Map<string, PriceSnapshot[]>;
  private emergencyMode: boolean;

  constructor(config: SlippageConfig) {
    this.config = config;
    this.priceHistory = new Map();
    this.emergencyMode = false;
  }

  /**
   * Calculate minimum output with slippage protection
   */
  calculateMinimumOutput(
    expectedOutput: BigNumber,
    slippageBps: number = this.config.maxSlippageBps
  ): BigNumber {
    const slippageAmount = expectedOutput.mul(slippageBps).div(10000);
    return expectedOutput.sub(slippageAmount);
  }

  /**
   * Analyze slippage for a swap
   */
  analyzeSlippage(
    amountIn: BigNumber,
    expectedOutput: BigNumber,
    priceQuote: BigNumber,
    routerQuote: BigNumber
  ): SlippageAnalysis {
    const warnings: string[] = [];
    const slippageAmount = expectedOutput.sub(routerQuote);
    const slippageBps = slippageAmount.mul(10000).div(expectedOutput);
    const slippageNum = slippageBps.toNumber();

    const maxSlippageBps = this.emergencyMode
      ? this.config.emergencySlippageBps
      : this.config.maxSlippageBps;

    const isAcceptable = slippageNum <= maxSlippageBps;

    // Check price impact
    const priceImpactAmount = priceQuote.sub(routerQuote);
    const priceImpactBps = priceImpactAmount.mul(10000).div(priceQuote);
    const priceImpactNum = priceImpactBps.toNumber();

    if (priceImpactNum > this.config.maxPriceImpactBps) {
      warnings.push(
        `High price impact: ${(priceImpactNum / 100).toFixed(2)}% exceeds ${(
          this.config.maxPriceImpactBps / 100
        ).toFixed(2)}%`
      );
    }

    // Check slippage
    if (slippageNum > maxSlippageBps) {
      warnings.push(
        `Slippage: ${(slippageNum / 100).toFixed(2)}% exceeds ${(maxSlippageBps / 100).toFixed(2)}%`
      );
    }

    // Check profit
    const profit = routerQuote.sub(amountIn);
    const profitBps = profit.mul(10000).div(amountIn);
    const profitNum = profitBps.toNumber();

    if (profitNum < this.config.minProfitBps) {
      warnings.push(
        `Low profit: ${(profitNum / 100).toFixed(2)}% below threshold ${(
          this.config.minProfitBps / 100
        ).toFixed(2)}%`
      );
    }

    const minAmountOut = this.calculateMinimumOutput(expectedOutput);
    const safetyMargin =
      (routerQuote.sub(minAmountOut).toNumber() / minAmountOut.toNumber()) * 100 || 0;

    return {
      expectedOutput,
      minAmountOut,
      slippageBps: slippageNum,
      priceImpactBps: priceImpactNum,
      isAcceptable,
      safetyMargin,
      warnings,
    };
  }

  /**
   * Monitor price for sandwich attack detection
   */
  recordPriceSnapshot(poolId: string, price: BigNumber, liquidity: BigNumber): void {
    const snapshot: PriceSnapshot = {
      timestamp: Date.now(),
      price,
      liquidity,
    };

    if (!this.priceHistory.has(poolId)) {
      this.priceHistory.set(poolId, []);
    }

    const history = this.priceHistory.get(poolId)!;
    history.push(snapshot);

    // Keep only last 100 snapshots to save memory
    if (history.length > 100) {
      history.shift();
    }
  }

  /**
   * Detect sandwich attack by analyzing price movements
   */
  detectSandwichAttack(poolId: string, threshold: number = 200): boolean {
    const history = this.priceHistory.get(poolId);
    if (!history || history.length < 2) {
      return false;
    }

    const recentSnapshots = history.slice(-5); // Check last 5 snapshots
    const oldest = recentSnapshots[0];
    const newest = recentSnapshots[recentSnapshots.length - 1];

    const priceChange = newest.price.sub(oldest.price);
    const priceChangeBps = priceChange.mul(10000).div(oldest.price).toNumber();

    // Threshold in basis points (e.g., 200 = 2% sudden movement)
    return Math.abs(priceChangeBps) > threshold;
  }

  /**
   * Calculate safe swap amount to stay under max slippage
   */
  calculateSafeSwapAmount(
    totalLiquidity: BigNumber,
    maxSlippageBps: number = this.config.maxSlippageBps
  ): BigNumber {
    // Safe amount = liquidity * (maxSlippage / 10000) * 0.1
    // Conservative: 10% of what slippage would allow
    const safeAmount = totalLiquidity.mul(maxSlippageBps).div(10000).div(10);
    return safeAmount;
  }

  /**
   * Validate swap parameters against slippage limits
   */
  validateSwap(
    amountIn: BigNumber,
    minAmountOut: BigNumber,
    expectedOutput: BigNumber
  ): {
    isValid: boolean;
    reason?: string;
    slippageBps: number;
  } {
    const slippageAmount = expectedOutput.sub(minAmountOut);
    const slippageBps = slippageAmount.mul(10000).div(expectedOutput).toNumber();

    const maxSlippageBps = this.emergencyMode
      ? this.config.emergencySlippageBps
      : this.config.maxSlippageBps;

    if (slippageBps > maxSlippageBps) {
      return {
        isValid: false,
        reason: `Slippage ${(slippageBps / 100).toFixed(2)}% exceeds max ${(
          maxSlippageBps / 100
        ).toFixed(2)}%`,
        slippageBps,
      };
    }

    const profit = minAmountOut.sub(amountIn);
    if (profit.lte(0)) {
      return {
        isValid: false,
        reason: 'No profit after slippage',
        slippageBps,
      };
    }

    return {
      isValid: true,
      slippageBps,
    };
  }

  /**
   * Enable emergency mode (higher slippage tolerance)
   */
  enableEmergencyMode(): void {
    this.emergencyMode = true;
  }

  /**
   * Disable emergency mode
   */
  disableEmergencyMode(): void {
    this.emergencyMode = false;
  }

  /**
   * Check if in emergency mode
   */
  isEmergencyMode(): boolean {
    return this.emergencyMode;
  }

  /**
   * Clear price history
   */
  clearHistory(): void {
    this.priceHistory.clear();
  }

  /**
   * Get price history for a pool
   */
  getHistory(poolId: string): PriceSnapshot[] {
    return this.priceHistory.get(poolId) || [];
  }

  /**
   * Calculate average price over time window
   */
  getAveragePrice(poolId: string, windowMs: number = 60000): BigNumber | null {
    const history = this.priceHistory.get(poolId);
    if (!history || history.length === 0) return null;

    const now = Date.now();
    const recentSnapshots = history.filter((s) => now - s.timestamp <= windowMs);

    if (recentSnapshots.length === 0) return null;

    const sum = recentSnapshots.reduce((acc, s) => acc.add(s.price), BigNumber.from(0));
    return sum.div(recentSnapshots.length);
  }

  /**
   * Get price volatility
   */
  getPriceVolatility(poolId: string, windowMs: number = 60000): number {
    const history = this.priceHistory.get(poolId);
    if (!history || history.length < 2) return 0;

    const now = Date.now();
    const recentSnapshots = history.filter((s) => now - s.timestamp <= windowMs);

    if (recentSnapshots.length < 2) return 0;

    const prices = recentSnapshots.map((s) => s.price.toNumber());
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const variance = prices.reduce((sum, p) => sum + Math.pow(p - avg, 2), 0) / prices.length;
    const stdDev = Math.sqrt(variance);

    return (stdDev / avg) * 100; // Return as percentage
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<SlippageConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Get current configuration
   */
  getConfig(): SlippageConfig {
    return { ...this.config };
  }
}

export default SlippageGuard;
