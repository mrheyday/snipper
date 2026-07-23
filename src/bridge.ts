import { ethers } from 'ethers';
import { SniperExecutor } from './executor';
import { FlashLoanExecutor } from './flashExecutor';
import { EIP7702Executor } from './eip7702';
import { FlashSizer } from './flashSizer';
import { signer, provider, FLASH_USE_TYPE4 } from './config';

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
  /**
   * When true (default when preferredMode === FLASH_LOAN), the bridge queries
   * FlashSizer on every execution to determine the optimal borrow amount from
   * live Aave liquidity and DEX quotes.  The opportunity's amountIn is used
   * only as an upper bound; the dynamic size may be smaller or larger.
   */
  dynamicFlashSize?: boolean;
}

interface SwapOpportunity {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  path: Buffer;
  minAmountOut: bigint;
  deadline: number;
  estimatedProfit?: bigint;
  /** Optional DEX pool for Bitquery slippage/depth sizing */
  poolAddress?: string;
}

interface BridgeExecutionResult {
  success: boolean;
  mode: ExecutionMode;
  txHash?: string;
  amountOut?: bigint;
  profit?: bigint;
  gasUsed?: bigint;
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

  private flashSizer: FlashSizer;

  constructor(config: BridgeConfig) {
    this.config = config;
    this.directExecutor = new SniperExecutor(config.sniperSearcherAddress, signer);
    this.flashExecutor = new FlashLoanExecutor(config.flashLoanReceiverAddress);
    this.eip7702Executor = new EIP7702Executor(config.delegatedExecutorAddress);
    // FlashSizer is always instantiated; it is only invoked when dynamicFlashSize is true.
    this.flashSizer = new FlashSizer({
      // Use 0.5% slippage ceiling — never relaxed during size search
      maxSlippageBps: 50,
      // Require at least 0.10% net profit after Aave fee and worst-case slippage
      minProfitBps: 10,
    });
  }

  /**
   * Execute swap via best available strategy
   * Tries preferred mode, falls back to alternatives if needed
   */
  async executeOptimal(opportunity: SwapOpportunity): Promise<BridgeExecutionResult> {
    console.log(`\n🌉 Execution Bridge - Optimal Strategy`);
    console.log(`  Token in: ${opportunity.tokenIn}`);
    console.log(`  Amount: ${ethers.formatUnits(opportunity.amountIn, 18)}`);

    // Analyze conditions to determine best mode
    const mode = await this.selectOptimalMode(opportunity);
    console.log(`  Selected mode: ${mode}`);

    // Try preferred mode
    const result = await this.executeByMode(mode, opportunity);
    if (result.success) return result;

    // Flash-loan-only: no fallback to other modes.
    // Capital-free execution is the entire point; falling back to direct would
    // require on-chain funds and defeats the purpose.
    if (
      mode === ExecutionMode.FLASH_LOAN ||
      this.config.preferredMode === ExecutionMode.FLASH_LOAN
    ) {
      console.log(`  Flash loan failed — no fallback permitted in flash-loan-only mode.`);
      return result;
    }

    // Fallback cascade for auto mode only (non-flash-loan preferred)
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
   * Flash loan execution via Aave + FlashLoanReceiver.
   *
   * When `dynamicFlashSize` is enabled (default for FLASH_LOAN mode), the borrow
   * amount is computed on-the-fly by FlashSizer:
   *   1. Queries live Aave reserve liquidity
   *   2. Caps at 30 % of that liquidity
   *   2b. Caps with Bitquery pool MaxAmountIn at slippage target (if pool set)
   *   3. Binary-searches for the largest amount whose DEX quote satisfies
   *      the slippage ceiling (0.5 %) and minimum profit floor (0.10 %)
   *
   * The slippage constraint is NEVER relaxed during the search.
   */
  private async executeFlashLoan(opportunity: SwapOpportunity): Promise<BridgeExecutionResult> {
    const useDynamic = this.config.dynamicFlashSize !== false; // default true

    let loanAmount = opportunity.amountIn;
    let loanMinAmountOut = opportunity.minAmountOut;

    if (useDynamic) {
      console.log(`  ⚡ Flash loan — computing dynamic loan size via FlashSizer...`);
      const sized = await this.flashSizer.computeOptimalSize(
        opportunity.tokenIn,
        opportunity.tokenOut,
        { poolAddress: opportunity.poolAddress }
      );

      if (!sized) {
        return {
          success: false,
          mode: ExecutionMode.FLASH_LOAN,
          error:
            'FlashSizer: no profitable loan size found. ' +
            'Possible causes: no DEX pool for this pair (check FlashSizer logs for route), ' +
            'insufficient Aave liquidity, or DEX round-trip fees exceed arb spread.',
        };
      }

      console.log(`  ⚡ Flash loan execution via Aave V3 (dynamic size)`);
      console.log(`     Loan amount:   ${ethers.formatUnits(sized.amount, 18)}`);
      console.log(`     Expected out:  ${ethers.formatUnits(sized.expectedOutput, 18)}`);
      console.log(`     Min amount out:${ethers.formatUnits(sized.minAmountOut, 18)}`);
      console.log(`     Aave fee:      ${ethers.formatUnits(sized.fee, 18)}`);
      console.log(`     Net profit:    ${ethers.formatUnits(sized.netProfit, 18)}`);
      console.log(`     DEX:           ${sized.dexName}`);

      loanAmount = sized.amount;
      loanMinAmountOut = sized.minAmountOut;
    } else {
      console.log(`  ⚡ Flash loan execution via Aave V3 (fixed size from config)`);
    }

    const result = await this.flashExecutor.executeFlashLoanArbitrage({
      token: opportunity.tokenIn,
      amount: loanAmount,
      swapPath: opportunity.path,
      minAmountOut: loanMinAmountOut,
      useType4: FLASH_USE_TYPE4,
    });

    if (!result.success) {
      return {
        success: false,
        mode: ExecutionMode.FLASH_LOAN,
        error: result.error,
      };
    }

    // Pull profit to the bot EOA promptly (standing inventory on receiver is griefable).
    if (result.profit && result.profit > 0n) {
      try {
        const to = await signer.getAddress();
        await this.flashExecutor.withdraw(opportunity.tokenIn, to, 0n);
        console.log(`  💰 Withdrew flash profit to ${to}`);
      } catch (e) {
        console.warn(
          `  ⚠ Profit withdraw failed (funds remain on receiver): ${
            e instanceof Error ? e.message : String(e)
          }`
        );
      }
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

    // Compare tokenIn balance (not ETH) for DIRECT vs capital-free modes.
    let tokenBalance = 0n;
    try {
      const erc20 = new ethers.Contract(
        opportunity.tokenIn,
        ['function balanceOf(address) view returns (uint256)'],
        provider
      );
      tokenBalance = BigInt(await erc20.balanceOf(await signer.getAddress()));
    } catch {
      tokenBalance = 0n;
    }
    const hasCapital = tokenBalance >= opportunity.amountIn;

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
    // - Large swaps (amortize ~0.05% Aave fee)
    // - Multiple opportunities in sequence
    return opportunity.amountIn > BigInt('1000000000000000000'); // > 1 token
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
    balance: bigint;
    eip7702Delegation?: string | null;
  }> {
    const balance = await provider.getBalance(await signer.getAddress());
    let eip7702Ready = true;
    let eip7702Delegation: string | null = null;
    try {
      const status = await this.eip7702Executor.getStatus();
      eip7702Delegation = status.delegate;
      // Ready if we can sign type-4 (always, with a funded EOA) — designator optional.
      eip7702Ready = balance > 0;
    } catch {
      eip7702Ready = false;
    }

    return {
      directReady: balance > 0,
      flashLoanReady: true, // Always available (Aave)
      eip7702Ready,
      balance: balance,
      eip7702Delegation,
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
    estimated: { gas: number; cost: bigint; time: number };
  } {
    // Direct: needs capital upfront
    const directGas = 150000;
    const directCost = opportunity.amountIn;

    // Flash loan: Aave V3 fee (Arbitrum live 5 bps / 0.05%; governance-updatable)
    const flashFee = (opportunity.amountIn * 5n) / 10000n;

    // Recommend based on cost efficiency
    let recommended = ExecutionMode.DIRECT;
    let reasoning = 'Default strategy';

    if ((opportunity.estimatedProfit ?? 0n) < flashFee) {
      recommended = ExecutionMode.EIP7702;
      reasoning = 'Profit too low for flash loan fee (~0.05%)';
    } else if (opportunity.estimatedProfit && opportunity.estimatedProfit > flashFee) {
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
    gasPrice: bigint
  ): {
    direct: bigint;
    flashLoan: bigint;
    eip7702: bigint;
  } {
    const directGas = BigInt(150000);
    const flashGas = BigInt(500000);
    const eip7702Gas = BigInt(150000);

    const directCost = directGas * gasPrice;
    const flashCost = flashGas * gasPrice + (opportunity.amountIn * 5n) / 10000n; // gas + fee
    const eip7702Cost = eip7702Gas * gasPrice;

    return {
      direct: directCost,
      flashLoan: flashCost,
      eip7702: eip7702Cost,
    };
  }
}

export { ExecutionMode };
export default ExecutionBridge;
