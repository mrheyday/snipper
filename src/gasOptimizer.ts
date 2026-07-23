import { ethers } from 'ethers';
import { provider } from './config';
import { Logger } from './logger';

const logger = new Logger('GasOptimizer');

/**
 * Gas cost estimation for different execution modes
 */
interface GasEstimate {
  mode: 'direct' | 'flashLoan' | 'eip7702' | 'erc4337';
  gasLimit: bigint;
  gasPrice: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  estimatedCost: bigint;
  description: string;
}

/**
 * Profitability analysis
 */
interface ProfitabilityAnalysis {
  mode: 'direct' | 'flashLoan' | 'eip7702' | 'erc4337';
  grossProfit: bigint;
  gasCost: bigint;
  netProfit: bigint;
  profitMargin: number; // percentage
  isRentable: boolean;
  recommendation: string;
}

/**
 * Dynamic gas optimization and cost analysis
 */
export class GasOptimizer {
  private readonly chainId: number; // For EIP-7702 authorization hashing
  private readonly flashLoanPremium: bigint; // bps hint; live Pool is source of truth
  private readonly slippageBuffer: bigint; // additional slippage allowance

  constructor(chainId: number = 42161) {
    this.chainId = chainId;
    // Arbitrum Aave V3 FLASHLOAN_PREMIUM_TOTAL = 5 bps (was 9 at V3 launch)
    this.flashLoanPremium = BigInt(5);
    this.slippageBuffer = BigInt(10); // 0.1% additional buffer

    logger.info(`Initialized GasOptimizer for chain ${this.chainId}`);
  }

  /**
   * Get current gas prices and network conditions
   */
  async getCurrentGasPrices(): Promise<{
    baseFee: bigint;
    priorityFee: bigint;
    maxFeePerGas: bigint;
    gasPriceStandard: bigint;
  }> {
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? 0n;
    const block = await provider.getBlock('latest');
    const baseFee = block?.baseFeePerGas ?? gasPrice;

    // Priority fee: use 25th percentile for standard, 50th for priority
    const priorityFee = ethers.parseUnits('1', 'gwei'); // 1 gwei standard
    const maxFeePerGas = baseFee * 3n + priorityFee; // 3x base + priority

    logger.info(`Current gas prices:`);
    logger.info(`  Base Fee: ${ethers.formatUnits(baseFee, 'gwei')} gwei`);
    logger.info(`  Priority Fee: ${ethers.formatUnits(priorityFee, 'gwei')} gwei`);
    logger.info(`  Max Fee: ${ethers.formatUnits(maxFeePerGas, 'gwei')} gwei`);

    return {
      baseFee,
      priorityFee,
      maxFeePerGas,
      gasPriceStandard: gasPrice ?? 0n,
    };
  }

  /**
   * Estimate gas for Direct mode (SniperSearcher)
   * Gas breakdown:
   * - Approval: ~45,000 gas
   * - Swap execution: ~100,000 gas
   * - Total: ~145,000 gas
   */
  async estimateDirectModeGas(): Promise<GasEstimate> {
    const { maxFeePerGas, baseFee, priorityFee } = await this.getCurrentGasPrices();

    const gasLimit = BigInt('145000'); // Typical swap
    const estimatedCost = gasLimit * maxFeePerGas;

    return {
      mode: 'direct',
      gasLimit,
      gasPrice: baseFee,
      maxFeePerGas,
      maxPriorityFeePerGas: priorityFee,
      estimatedCost,
      description: 'Direct swap via SniperSearcher (no approval needed)',
    };
  }

  /**
   * Estimate gas for Flash Loan mode (FlashLoanReceiver)
   * Gas breakdown:
   * - Flash loan initiation: ~70,000 gas
   * - Swap in callback: ~100,000 gas
   * - Repayment: ~30,000 gas
   * - Total: ~200,000 gas
   * Note: Plus flash loan premium (Aave FLASHLOAN_PREMIUM_TOTAL bps)
   */
  async estimateFlashLoanModeGas(borrowAmount: bigint): Promise<GasEstimate> {
    const { maxFeePerGas, baseFee, priorityFee } = await this.getCurrentGasPrices();

    const gasLimit = BigInt('200000'); // Typical flash loan
    const estimatedCost = gasLimit * maxFeePerGas;

    // Calculate flash loan premium (hint bps; on-chain uses callback premium)
    const premiumBps = this.flashLoanPremium;
    const premiumAmount = (borrowAmount * BigInt(premiumBps)) / BigInt(10000);

    return {
      mode: 'flashLoan',
      gasLimit,
      gasPrice: baseFee,
      maxFeePerGas,
      maxPriorityFeePerGas: priorityFee,
      estimatedCost: estimatedCost + premiumAmount,
      description: `Flash loan swap (${this.formatBN(premiumAmount)} premium)`,
    };
  }

  /**
   * Estimate gas for EIP-7702 mode (DelegatedExecutor)
   * Gas breakdown:
   * - Authorization encoding: ~5,000 gas
   * - Delegated execution: ~100,000 gas
   * - Total: ~105,000 gas
   * Note: EIP-7702 requires Prague hardfork
   */
  async estimateEIP7702ModeGas(): Promise<GasEstimate> {
    const { maxFeePerGas, baseFee, priorityFee } = await this.getCurrentGasPrices();

    const gasLimit = BigInt('105000'); // EIP-7702 optimized
    const estimatedCost = gasLimit * maxFeePerGas;

    return {
      mode: 'eip7702',
      gasLimit,
      gasPrice: baseFee,
      maxFeePerGas,
      maxPriorityFeePerGas: priorityFee,
      estimatedCost,
      description: 'EIP-7702 delegated execution (Prague hardfork required)',
    };
  }

  /**
   * Estimate gas for ERC-4337 mode (SmartWallet)
   * Gas breakdown:
   * - EntryPoint validation: ~50,000 gas
   * - Wallet execution: ~100,000 gas
   * - Bundler overhead: ~20,000 gas
   * - Total: ~170,000 gas
   */
  async estimateERC4337ModeGas(): Promise<GasEstimate> {
    const { maxFeePerGas, baseFee, priorityFee } = await this.getCurrentGasPrices();

    const gasLimit = BigInt('170000'); // ERC-4337 with bundler
    const estimatedCost = gasLimit * maxFeePerGas;

    return {
      mode: 'erc4337',
      gasLimit,
      gasPrice: baseFee,
      maxFeePerGas,
      maxPriorityFeePerGas: priorityFee,
      estimatedCost,
      description: 'ERC-4337 smart wallet execution (bundler)',
    };
  }

  /**
   * Analyze profitability of execution modes
   */
  async analyzeProfitability(
    swapAmount: bigint,
    outputAmount: bigint,
    inputPrice: bigint,
    outputPrice: bigint
  ): Promise<ProfitabilityAnalysis[]> {
    const estimates = await Promise.all([
      this.estimateDirectModeGas(),
      this.estimateFlashLoanModeGas(swapAmount),
      this.estimateEIP7702ModeGas(),
      this.estimateERC4337ModeGas(),
    ]);

    // Calculate gross profit
    const inputValue = (swapAmount * BigInt(inputPrice)) / BigInt(BigInt('1e18'));
    const outputValue = (outputAmount * BigInt(outputPrice)) / BigInt(BigInt('1e18'));
    const grossProfit = outputValue - inputValue;

    return estimates.map((est) => {
      const netProfit = grossProfit - est.estimatedCost;
      const profitMargin =
        outputValue > 0 ? Number((netProfit * BigInt(10000)) / BigInt(outputValue)) / 100 : 0;

      const isRentable = netProfit > 0 && profitMargin > 0.1; // >0.1% margin

      return {
        mode: est.mode,
        grossProfit,
        gasCost: est.estimatedCost,
        netProfit,
        profitMargin,
        isRentable,
        recommendation: this.generateRecommendation(est.mode, isRentable, profitMargin),
      };
    });
  }

  /**
   * Generate recommendation based on profitability
   */
  private generateRecommendation(mode: string, isRentable: boolean, margin: number): string {
    if (!isRentable) {
      return `❌ Not profitable (margin: ${margin.toFixed(2)}%)`;
    }

    if (mode === 'direct' && margin > 1) {
      return `✅ RECOMMENDED (Direct mode, margin: ${margin.toFixed(2)}%)`;
    }
    if (mode === 'flashLoan' && margin > 0.5) {
      return `✅ Good (Flash loan, margin: ${margin.toFixed(2)}%)`;
    }
    if (mode === 'eip7702' && margin > 0.8) {
      return `✅ Optimal (EIP-7702, margin: ${margin.toFixed(2)}%, post-Prague)`;
    }
    if (mode === 'erc4337' && margin > 0.6) {
      return `✅ Viable (ERC-4337, margin: ${margin.toFixed(2)}%)`;
    }

    return `⚠️ Marginal (margin: ${margin.toFixed(2)}%)`;
  }

  /**
   * Optimize execution parameters based on gas prices
   */
  async optimizeExecutionParams(baseSlippage: bigint): Promise<{
    slippageTolerance: bigint;
    deadline: number;
    priorityFee: bigint;
    maxFeePerGas: bigint;
  }> {
    const { baseFee, priorityFee, maxFeePerGas } = await this.getCurrentGasPrices();

    // Adjust slippage based on gas prices
    // High gas = tighter slippage to ensure profitability
    const gasRatio = (maxFeePerGas * BigInt(100)) / BigInt(baseFee); // percentage of base fee
    const slippageAdjustment =
      gasRatio > 300 // >3x base fee = high gas
        ? this.slippageBuffer
        : 0n;

    const slippageTolerance = baseSlippage + slippageAdjustment;

    // Deadline: 5 minutes from now
    const deadline = Math.floor(Date.now() / 1000) + 300;

    logger.info(`Optimized execution parameters:`);
    logger.info(`  Slippage tolerance: ${ethers.formatUnits(slippageTolerance, 0)} bps`);
    logger.info(`  Deadline: ${new Date(deadline * 1000).toISOString()}`);
    logger.info(`  Priority fee: ${ethers.formatUnits(priorityFee, 'gwei')} gwei`);

    return {
      slippageTolerance,
      deadline,
      priorityFee,
      maxFeePerGas,
    };
  }

  /**
   * Estimate cost to reach profitability threshold
   */
  async estimateProfitabilityThreshold(
    swapAmount: bigint,
    inputPrice: bigint
  ): Promise<{
    requiredOutputPrice: bigint;
    profitThreshold: bigint;
    breakEvenPrice: bigint;
  }> {
    const est = await this.estimateDirectModeGas();
    const gasCostInUsd = est.estimatedCost; // Approximation

    // Break-even: output value = input value + gas cost
    const breakEvenPrice = inputPrice + (gasCostInUsd * BigInt(1e18)) / BigInt(swapAmount);

    // Profitability threshold: break-even + 0.5% margin
    const profitThreshold = (breakEvenPrice * 1005n) / 1000n;

    const requiredOutputPrice = profitThreshold;

    logger.info(`Profitability analysis:`);
    logger.info(`  Break-even price: ${this.formatBN(breakEvenPrice)}`);
    logger.info(`  Profit threshold (0.5%): ${this.formatBN(profitThreshold)}`);

    return {
      requiredOutputPrice,
      profitThreshold,
      breakEvenPrice,
    };
  }

  /**
   * Get gas price alert thresholds
   */
  async getGasPriceAlerts(): Promise<{
    normal: bigint;
    high: bigint;
    veryHigh: bigint;
    status: 'normal' | 'high' | 'veryHigh';
  }> {
    const { maxFeePerGas } = await this.getCurrentGasPrices();

    // Define thresholds
    const normal = ethers.parseUnits('50', 'gwei');
    const high = ethers.parseUnits('100', 'gwei');
    const veryHigh = ethers.parseUnits('200', 'gwei');

    let status: 'normal' | 'high' | 'veryHigh' = 'normal';
    if (maxFeePerGas >= veryHigh) {
      status = 'veryHigh';
    } else if (maxFeePerGas >= high) {
      status = 'high';
    }

    logger.info(`Gas price status: ${status}`);
    logger.info(`  Current max fee: ${ethers.formatUnits(maxFeePerGas, 'gwei')} gwei`);
    logger.info(`  Normal: ${ethers.formatUnits(normal, 'gwei')} gwei`);
    logger.info(`  High: ${ethers.formatUnits(high, 'gwei')} gwei`);
    logger.info(`  Very High: ${ethers.formatUnits(veryHigh, 'gwei')} gwei`);

    return {
      normal,
      high,
      veryHigh,
      status,
    };
  }

  /**
   * Format bigint for logging
   */
  private formatBN(value: bigint): string {
    return ethers.formatUnits(value, 6).substring(0, 10);
  }
}

export default GasOptimizer;
