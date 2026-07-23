import { ethers } from 'ethers';

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
  expectedOutput: bigint;
  minAmountOut: bigint;
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
  price: bigint;
  liquidity: bigint;
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
    expectedOutput: bigint,
    slippageBps: number = this.config.maxSlippageBps
  ): bigint {
    const slippageAmount = (expectedOutput * BigInt(slippageBps)) / BigInt(10000);
    return expectedOutput - slippageAmount;
  }

  /**
   * Analyze slippage for a swap
   */
  analyzeSlippage(
    amountIn: bigint,
    expectedOutput: bigint,
    priceQuote: bigint,
    routerQuote: bigint
  ): SlippageAnalysis {
    const warnings: string[] = [];
    const slippageAmount = expectedOutput - routerQuote;
    const slippageBps = (slippageAmount * BigInt(10000)) / BigInt(expectedOutput);
    const slippageNum = Number(slippageBps);

    const maxSlippageBps = this.emergencyMode
      ? this.config.emergencySlippageBps
      : this.config.maxSlippageBps;

    const isAcceptable = slippageNum <= maxSlippageBps;

    // Check price impact
    const priceImpactAmount = priceQuote - routerQuote;
    const priceImpactBps = (priceImpactAmount * BigInt(10000)) / BigInt(priceQuote);
    const priceImpactNum = Number(priceImpactBps);

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
    const profit = routerQuote - amountIn;
    const profitBps = (profit * BigInt(10000)) / BigInt(amountIn);
    const profitNum = Number(profitBps);

    if (profitNum < this.config.minProfitBps) {
      warnings.push(
        `Low profit: ${(profitNum / 100).toFixed(2)}% below threshold ${(
          this.config.minProfitBps / 100
        ).toFixed(2)}%`
      );
    }

    const minAmountOut = this.calculateMinimumOutput(expectedOutput);
    const safetyMargin =
      minAmountOut === 0n
        ? 0
        : Number(((routerQuote - minAmountOut) * 10000n) / minAmountOut) / 100;

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
  recordPriceSnapshot(poolId: string, price: bigint, liquidity: bigint): void {
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

    const priceChange = newest.price - oldest.price;
    const priceChangeBps = (priceChange * BigInt(10000)) / BigInt(Number(oldest.price));

    // Threshold in basis points (e.g., 200 = 2% sudden movement)
    return Math.abs(Number(priceChangeBps)) > threshold;
  }

  /**
   * Calculate safe swap amount to stay under max slippage
   */
  calculateSafeSwapAmount(
    totalLiquidity: bigint,
    maxSlippageBps: number = this.config.maxSlippageBps
  ): bigint {
    // Safe amount = liquidity * (maxSlippage / 10000n) * 0.1
    // Conservative: 10% of what slippage would allow
    const safeAmount = (totalLiquidity * BigInt(maxSlippageBps)) / BigInt(10000 / 10);
    return safeAmount;
  }

  /**
   * Validate swap parameters against slippage limits
   */
  validateSwap(
    amountIn: bigint,
    minAmountOut: bigint,
    expectedOutput: bigint
  ): {
    isValid: boolean;
    reason?: string;
    slippageBps: number;
  } {
    const slippageAmount = expectedOutput - minAmountOut;
    const slippageBpsBn = expectedOutput === 0n ? 0n : (slippageAmount * 10000n) / expectedOutput;
    const slippageBps = Number(slippageBpsBn);

    const maxSlippageBps = this.emergencyMode
      ? this.config.emergencySlippageBps
      : this.config.maxSlippageBps;

    if (slippageBps > maxSlippageBps) {
      return {
        isValid: false,
        reason: `Slippage ${(slippageBps / 100).toFixed(2)}% exceeds max ${(maxSlippageBps / 100).toFixed(2)}%`,
        slippageBps,
      };
    }

    const profit = minAmountOut - amountIn;
    if (profit <= 0) {
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
  getAveragePrice(poolId: string, windowMs: number = 60000): bigint | null {
    const history = this.priceHistory.get(poolId);
    if (!history || history.length === 0) return null;

    const now = Date.now();
    const recentSnapshots = history.filter((s) => now - s.timestamp <= windowMs);

    if (recentSnapshots.length === 0) return null;

    const sum = recentSnapshots.reduce((acc, s) => acc + s.price, BigInt(0));
    return sum / BigInt(recentSnapshots.length);
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

    const prices = recentSnapshots.map((s) => Number(s.price));
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
