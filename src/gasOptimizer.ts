import { BigNumber, ethers } from 'ethers';
import { provider } from './config';
import { Logger } from './logger';

const logger = new Logger('GasOptimizer');

/**
 * Gas cost estimation for different execution modes
 */
interface GasEstimate {
  mode: 'direct' | 'flashLoan' | 'eip7702' | 'erc4337';
  gasLimit: BigNumber;
  gasPrice: BigNumber;
  maxFeePerGas: BigNumber;
  maxPriorityFeePerGas: BigNumber;
  estimatedCost: BigNumber;
  description: string;
}

/**
 * Profitability analysis
 */
interface ProfitabilityAnalysis {
  mode: 'direct' | 'flashLoan' | 'eip7702' | 'erc4337';
  grossProfit: BigNumber;
  gasCost: BigNumber;
  netProfit: BigNumber;
  profitMargin: number; // percentage
  isRentable: boolean;
  recommendation: string;
}

/**
 * Dynamic gas optimization and cost analysis
 */
export class GasOptimizer {
  private readonly chainId: number; // For EIP-7702 authorization hashing
  private readonly flashLoanPremium: BigNumber; // bps hint; live Pool is source of truth
  private readonly slippageBuffer: BigNumber; // additional slippage allowance

  constructor(chainId: number = 42161) {
    this.chainId = chainId;
    // Arbitrum Aave V3 FLASHLOAN_PREMIUM_TOTAL = 5 bps (was 9 at V3 launch)
    this.flashLoanPremium = BigNumber.from(5);
    this.slippageBuffer = BigNumber.from(10); // 0.1% additional buffer

    logger.info(`Initialized GasOptimizer for chain ${this.chainId}`);
  }

  /**
   * Get current gas prices and network conditions
   */
  async getCurrentGasPrices(): Promise<{
    baseFee: BigNumber;
    priorityFee: BigNumber;
    maxFeePerGas: BigNumber;
    gasPriceStandard: BigNumber;
  }> {
    const gasPrice = await provider.getGasPrice();
    const block = await provider.getBlock('latest');
    const baseFee = block.baseFeePerGas || gasPrice;

    // Priority fee: use 25th percentile for standard, 50th for priority
    const priorityFee = ethers.utils.parseUnits('1', 'gwei'); // 1 gwei standard
    const maxFeePerGas = baseFee.mul(3).add(priorityFee); // 3x base + priority

    logger.info(`Current gas prices:`);
    logger.info(`  Base Fee: ${ethers.utils.formatUnits(baseFee, 'gwei')} gwei`);
    logger.info(`  Priority Fee: ${ethers.utils.formatUnits(priorityFee, 'gwei')} gwei`);
    logger.info(`  Max Fee: ${ethers.utils.formatUnits(maxFeePerGas, 'gwei')} gwei`);

    return {
      baseFee,
      priorityFee,
      maxFeePerGas,
      gasPriceStandard: gasPrice,
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

    const gasLimit = BigNumber.from('145000'); // Typical swap
    const estimatedCost = gasLimit.mul(maxFeePerGas);

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
  async estimateFlashLoanModeGas(borrowAmount: BigNumber): Promise<GasEstimate> {
    const { maxFeePerGas, baseFee, priorityFee } = await this.getCurrentGasPrices();

    const gasLimit = BigNumber.from('200000'); // Typical flash loan
    const estimatedCost = gasLimit.mul(maxFeePerGas);

    // Calculate flash loan premium (hint bps; on-chain uses callback premium)
    const premiumBps = this.flashLoanPremium;
    const premiumAmount = borrowAmount.mul(premiumBps).div(10000);

    return {
      mode: 'flashLoan',
      gasLimit,
      gasPrice: baseFee,
      maxFeePerGas,
      maxPriorityFeePerGas: priorityFee,
      estimatedCost: estimatedCost.add(premiumAmount),
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

    const gasLimit = BigNumber.from('105000'); // EIP-7702 optimized
    const estimatedCost = gasLimit.mul(maxFeePerGas);

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

    const gasLimit = BigNumber.from('170000'); // ERC-4337 with bundler
    const estimatedCost = gasLimit.mul(maxFeePerGas);

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
    swapAmount: BigNumber,
    outputAmount: BigNumber,
    inputPrice: BigNumber,
    outputPrice: BigNumber
  ): Promise<ProfitabilityAnalysis[]> {
    const estimates = await Promise.all([
      this.estimateDirectModeGas(),
      this.estimateFlashLoanModeGas(swapAmount),
      this.estimateEIP7702ModeGas(),
      this.estimateERC4337ModeGas(),
    ]);

    // Calculate gross profit
    const inputValue = swapAmount.mul(inputPrice).div(BigNumber.from('1e18'));
    const outputValue = outputAmount.mul(outputPrice).div(BigNumber.from('1e18'));
    const grossProfit = outputValue.sub(inputValue);

    return estimates.map((est) => {
      const netProfit = grossProfit.sub(est.estimatedCost);
      const profitMargin = outputValue.gt(0)
        ? Number(netProfit.mul(10000).div(outputValue)) / 100
        : 0;

      const isRentable = netProfit.gt(0) && profitMargin > 0.1; // >0.1% margin

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
  async optimizeExecutionParams(baseSlippage: BigNumber): Promise<{
    slippageTolerance: BigNumber;
    deadline: number;
    priorityFee: BigNumber;
    maxFeePerGas: BigNumber;
  }> {
    const { baseFee, priorityFee, maxFeePerGas } = await this.getCurrentGasPrices();

    // Adjust slippage based on gas prices
    // High gas = tighter slippage to ensure profitability
    const gasRatio = maxFeePerGas.mul(100).div(baseFee); // percentage of base fee
    const slippageAdjustment = gasRatio.gt(300) // >3x base fee = high gas
      ? this.slippageBuffer
      : BigNumber.from(0);

    const slippageTolerance = baseSlippage.add(slippageAdjustment);

    // Deadline: 5 minutes from now
    const deadline = Math.floor(Date.now() / 1000) + 300;

    logger.info(`Optimized execution parameters:`);
    logger.info(`  Slippage tolerance: ${ethers.utils.formatUnits(slippageTolerance, 0)} bps`);
    logger.info(`  Deadline: ${new Date(deadline * 1000).toISOString()}`);
    logger.info(`  Priority fee: ${ethers.utils.formatUnits(priorityFee, 'gwei')} gwei`);

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
    swapAmount: BigNumber,
    inputPrice: BigNumber
  ): Promise<{
    requiredOutputPrice: BigNumber;
    profitThreshold: BigNumber;
    breakEvenPrice: BigNumber;
  }> {
    const est = await this.estimateDirectModeGas();
    const gasCostInUsd = est.estimatedCost; // Approximation

    // Break-even: output value = input value + gas cost
    const breakEvenPrice = inputPrice.add(gasCostInUsd.mul(1e18).div(swapAmount));

    // Profitability threshold: break-even + 0.5% margin
    const profitThreshold = breakEvenPrice.mul(1005).div(1000);

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
    normal: BigNumber;
    high: BigNumber;
    veryHigh: BigNumber;
    status: 'normal' | 'high' | 'veryHigh';
  }> {
    const { maxFeePerGas } = await this.getCurrentGasPrices();

    // Define thresholds
    const normal = ethers.utils.parseUnits('50', 'gwei');
    const high = ethers.utils.parseUnits('100', 'gwei');
    const veryHigh = ethers.utils.parseUnits('200', 'gwei');

    let status: 'normal' | 'high' | 'veryHigh' = 'normal';
    if (maxFeePerGas.gte(veryHigh)) {
      status = 'veryHigh';
    } else if (maxFeePerGas.gte(high)) {
      status = 'high';
    }

    logger.info(`Gas price status: ${status}`);
    logger.info(`  Current max fee: ${ethers.utils.formatUnits(maxFeePerGas, 'gwei')} gwei`);
    logger.info(`  Normal: ${ethers.utils.formatUnits(normal, 'gwei')} gwei`);
    logger.info(`  High: ${ethers.utils.formatUnits(high, 'gwei')} gwei`);
    logger.info(`  Very High: ${ethers.utils.formatUnits(veryHigh, 'gwei')} gwei`);

    return {
      normal,
      high,
      veryHigh,
      status,
    };
  }

  /**
   * Format BigNumber for logging
   */
  private formatBN(value: BigNumber): string {
    return ethers.utils.formatUnits(value, 6).substring(0, 10);
  }
}

export default GasOptimizer;
