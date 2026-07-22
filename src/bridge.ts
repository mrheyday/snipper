import { BigNumber, ethers } from 'ethers';
import { SniperExecutor } from './executor';
import { FlashLoanExecutor } from './flashExecutor';
import { EIP7702Executor } from './eip7702';
import { signer } from './config';

/**
 * Execution Mode Strategy
 * Determines which backend to use for optimal execution
 */
enum ExecutionMode {
  DIRECT = 'direct', // Pre-deployed SniperSearcher
  FLASH_LOAN = 'flash_loan', // Aave V3 flash loan
  EIP7702 = 'eip7702', // Delegated EOA code
}

interface BridgeConfig {
  sniperSearcherAddress: string;
  flashLoanReceiverAddress: string;
  delegatedExecutorAddress: string;
  preferredMode?: ExecutionMode;
}

interface SwapOpportunity {
  tokenIn: string;
  tokenOut: string;
  amountIn: BigNumber;
  path: Buffer;
  minAmountOut: BigNumber;
  deadline: number;
  estimatedProfit?: BigNumber;
}

interface BridgeExecutionResult {
  success: boolean;
  mode: ExecutionMode;
  txHash?: string;
  amountOut?: BigNumber;
  profit?: BigNumber;
  gasUsed?: BigNumber;
  error?: string;
  fallbackAttempted?: boolean;
}

/**
 * Execution Bridge
 * Unified interface for all three execution modes
 * Auto-selects best strategy or falls back between modes
 */
export class ExecutionBridge {
  private directExecutor: SniperExecutor;
  private flashExecutor: FlashLoanExecutor;
  private eip7702Executor: EIP7702Executor;
  private config: BridgeConfig;

  constructor(config: BridgeConfig) {
    this.config = config;
    this.directExecutor = new SniperExecutor(config.sniperSearcherAddress, signer);
    this.flashExecutor = new FlashLoanExecutor(config.flashLoanReceiverAddress);
    this.eip7702Executor = new EIP7702Executor(config.delegatedExecutorAddress);
  }

  /**
   * Execute swap via best available strategy
   * Tries preferred mode, falls back to alternatives if needed
   */
  async executeOptimal(opportunity: SwapOpportunity): Promise<BridgeExecutionResult> {
    console.log(`\n🌉 Execution Bridge - Optimal Strategy`);
    console.log(`  Token in: ${opportunity.tokenIn}`);
    console.log(`  Amount: ${ethers.utils.formatUnits(opportunity.amountIn, 18)}`);

    // Analyze conditions to determine best mode
    const mode = await this.selectOptimalMode(opportunity);
    console.log(`  Selected mode: ${mode}`);

    // Try preferred mode
    const result = await this.executeByMode(mode, opportunity);
    if (result.success) return result;

    // Fallback cascade
    console.log(`  Mode ${mode} failed, attempting fallback...`);
    result.fallbackAttempted = true;

    const alternativeModes = this.getAlternativeModes(mode);
    for (const altMode of alternativeModes) {
      console.log(`  Trying fallback: ${altMode}`);
      const altResult = await this.executeByMode(altMode, opportunity);
      if (altResult.success) {
        altResult.mode = altMode;
        altResult.fallbackAttempted = true;
        return altResult;
      }
    }

    return {
      success: false,
      mode: mode,
      error: 'All execution modes failed',
      fallbackAttempted: true,
    };
  }

  /**
   * Execute using specific mode
   */
  private async executeByMode(
    mode: ExecutionMode,
    opportunity: SwapOpportunity
  ): Promise<BridgeExecutionResult> {
    try {
      switch (mode) {
        case ExecutionMode.DIRECT:
          return await this.executeDirect(opportunity);

        case ExecutionMode.FLASH_LOAN:
          return await this.executeFlashLoan(opportunity);

        case ExecutionMode.EIP7702:
          return await this.executeEIP7702(opportunity);

        default:
          return {
            success: false,
            mode: mode,
            error: `Unknown execution mode: ${mode}`,
          };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        mode: mode,
        error: errorMsg,
      };
    }
  }

  /**
   * Direct execution via pre-deployed SniperSearcher
   */
  private async executeDirect(opportunity: SwapOpportunity): Promise<BridgeExecutionResult> {
    console.log(`  💎 Direct execution via SniperSearcher`);

    const result = await this.directExecutor.executeSwap({
      tokenIn: opportunity.tokenIn,
      amountIn: opportunity.amountIn,
      path: opportunity.path,
      minAmountOut: opportunity.minAmountOut,
    });

    if (!result.success) {
      return {
        success: false,
        mode: ExecutionMode.DIRECT,
        error: result.error,
      };
    }

    return {
      success: true,
      mode: ExecutionMode.DIRECT,
      txHash: result.txHash,
      gasUsed: result.gasUsed,
      profit: opportunity.estimatedProfit,
    };
  }

  /**
   * Flash loan execution via Aave + FlashLoanReceiver
   */
  private async executeFlashLoan(opportunity: SwapOpportunity): Promise<BridgeExecutionResult> {
    console.log(`  ⚡ Flash loan execution via Aave V3`);

    const result = await this.flashExecutor.executeFlashLoanArbitrage({
      token: opportunity.tokenIn,
      amount: opportunity.amountIn,
      swapPath: opportunity.path,
      minAmountOut: opportunity.minAmountOut,
    });

    if (!result.success) {
      return {
        success: false,
        mode: ExecutionMode.FLASH_LOAN,
        error: result.error,
      };
    }

    return {
      success: true,
      mode: ExecutionMode.FLASH_LOAN,
      txHash: result.txHash,
      gasUsed: result.gasUsed,
      profit: result.profit,
    };
  }

  /**
   * EIP-7702 delegated execution
   */
  private async executeEIP7702(opportunity: SwapOpportunity): Promise<BridgeExecutionResult> {
    console.log(`  🔄 EIP-7702 delegated execution`);

    const result = await this.eip7702Executor.executeDelegatedSwap({
      tokenIn: opportunity.tokenIn,
      amountIn: opportunity.amountIn,
      path: opportunity.path,
      minAmountOut: opportunity.minAmountOut,
      deadline: opportunity.deadline,
    });

    if (!result.success) {
      return {
        success: false,
        mode: ExecutionMode.EIP7702,
        error: result.error,
      };
    }

    return {
      success: true,
      mode: ExecutionMode.EIP7702,
      txHash: result.txHash,
      gasUsed: result.gasUsed,
      profit: opportunity.estimatedProfit,
    };
  }

  /**
   * Select optimal execution mode based on conditions
   */
  private async selectOptimalMode(opportunity: SwapOpportunity): Promise<ExecutionMode> {
    // If preferred mode is set, use it
    if (this.config.preferredMode) {
      return this.config.preferredMode;
    }

    // Auto-select based on conditions
    const walletBalance = await signer.getBalance();

    // Check available capital
    const hasCapital = walletBalance.gte(opportunity.amountIn);

    // Flash loan has no capital requirement, lowest cost
    if (this.shouldUseFlashLoan(opportunity)) {
      return ExecutionMode.FLASH_LOAN;
    }

    // EIP-7702 for one-shot opportunities (no persistent contract cost)
    if (this.shouldUseEIP7702()) {
      return ExecutionMode.EIP7702;
    }

    // Fall back to direct if capital available
    if (hasCapital) {
      return ExecutionMode.DIRECT;
    }

    // Default to flash loan if low capital
    return ExecutionMode.FLASH_LOAN;
  }

  /**
   * Determine if flash loan is optimal
   */
  private shouldUseFlashLoan(opportunity: SwapOpportunity): boolean {
    // Flash loan is best for:
    // - Zero capital situations
    // - Large swaps (amortize 0.09% fee)
    // - Multiple opportunities in sequence
    return opportunity.amountIn.gt(BigNumber.from('1000000000000000000')); // > 1 token
  }

  /**
   * Determine if EIP-7702 is optimal
   */
  private shouldUseEIP7702(): boolean {
    // EIP-7702 is best for:
    // - One-time opportunities
    // - Private execution (code only deployed during tx)
    // - Lower gas than contract deployment
    return true; // Use by default when available
  }

  /**
   * Get alternative execution modes in fallback order
   */
  private getAlternativeModes(failed: ExecutionMode): ExecutionMode[] {
    switch (failed) {
      case ExecutionMode.DIRECT:
        return [ExecutionMode.FLASH_LOAN, ExecutionMode.EIP7702];
      case ExecutionMode.FLASH_LOAN:
        return [ExecutionMode.EIP7702, ExecutionMode.DIRECT];
      case ExecutionMode.EIP7702:
        return [ExecutionMode.FLASH_LOAN, ExecutionMode.DIRECT];
      default:
        return [ExecutionMode.DIRECT, ExecutionMode.FLASH_LOAN, ExecutionMode.EIP7702];
    }
  }

  /**
   * Get execution stats across all modes
   */
  async getExecutionStats(): Promise<{
    directReady: boolean;
    flashLoanReady: boolean;
    eip7702Ready: boolean;
    balance: BigNumber;
  }> {
    const balance = await signer.getBalance();

    return {
      directReady: balance.gt(0),
      flashLoanReady: true, // Always available (Aave)
      eip7702Ready: true, // Always available
      balance: balance,
    };
  }

  /**
   * Switch execution mode preference
   */
  setPreferredMode(mode: ExecutionMode | undefined): void {
    this.config.preferredMode = mode;
    console.log(`✓ Preferred execution mode: ${mode || 'auto'}`);
  }

  /**
   * Get current configuration
   */
  getConfig(): BridgeConfig {
    return this.config;
  }

  /**
   * Get executor for direct access
   */
  getExecutor(mode: ExecutionMode): SniperExecutor | FlashLoanExecutor | EIP7702Executor {
    switch (mode) {
      case ExecutionMode.DIRECT:
        return this.directExecutor;
      case ExecutionMode.FLASH_LOAN:
        return this.flashExecutor;
      case ExecutionMode.EIP7702:
        return this.eip7702Executor;
      default:
        throw new Error(`Unknown execution mode: ${mode}`);
    }
  }
}

/**
 * Bridge Strategy Analyzer
 * Analyzes which mode is optimal for given conditions
 */
export class BridgeStrategyAnalyzer {
  /**
   * Analyze swap opportunity and recommend mode
   */
  static analyzeOpportunity(opportunity: SwapOpportunity): {
    recommended: ExecutionMode;
    reasoning: string;
    estimated: { gas: number; cost: BigNumber; time: number };
  } {
    // Direct: needs capital upfront
    const directGas = 150000;
    const directCost = opportunity.amountIn;

    // Flash loan: 0.09% fee only
    const flashFee = opportunity.amountIn.mul(9).div(10000); // 0.09%

    // Recommend based on cost efficiency
    let recommended = ExecutionMode.DIRECT;
    let reasoning = 'Default strategy';

    if (opportunity.estimatedProfit?.lt(flashFee)) {
      recommended = ExecutionMode.EIP7702;
      reasoning = 'Profit too low for flash loan fee (0.09%)';
    } else if (opportunity.estimatedProfit && opportunity.estimatedProfit.gt(flashFee)) {
      recommended = ExecutionMode.FLASH_LOAN;
      reasoning = 'Large profit justifies flash loan fee';
    }

    return {
      recommended,
      reasoning,
      estimated: {
        gas: directGas,
        cost: directCost,
        time: 12000, // ~12 seconds for 3 blocks
      },
    };
  }

  /**
   * Compare execution costs
   */
  static compareCosts(
    opportunity: SwapOpportunity,
    gasPrice: BigNumber
  ): {
    direct: BigNumber;
    flashLoan: BigNumber;
    eip7702: BigNumber;
  } {
    const directGas = BigNumber.from(150000);
    const flashGas = BigNumber.from(500000);
    const eip7702Gas = BigNumber.from(150000);

    const directCost = directGas.mul(gasPrice);
    const flashCost = flashGas.mul(gasPrice).add(opportunity.amountIn.mul(9).div(10000)); // gas + fee
    const eip7702Cost = eip7702Gas.mul(gasPrice);

    return {
      direct: directCost,
      flashLoan: flashCost,
      eip7702: eip7702Cost,
    };
  }
}

export { ExecutionMode };
export default ExecutionBridge;
