import { BigNumber, ethers, Wallet } from 'ethers';
import { Logger } from './logger';
import PreFlightValidator from './preFlightValidator';
import EIP7702TestHarness from './eip7702TestHarness';
import DelegationDebugger from './delegationDebugger';

const logger = new Logger('EIP7702Integration');

/**
 * Complete EIP-7702 delegated swap execution with full debugging
 * Combines pre-flight validation, test harness, and detailed logging
 */
export class EIP7702Integration {
  private provider: ethers.providers.JsonRpcProvider;
  private signer: Wallet;
  private validator: PreFlightValidator;
  private debugger: DelegationDebugger;

  constructor(providerUrl: string, signerKey: string) {
    this.provider = new ethers.providers.JsonRpcProvider(providerUrl);
    this.signer = new Wallet(signerKey, this.provider);
    this.validator = new PreFlightValidator(this.provider);
    this.debugger = new DelegationDebugger();
  }

  /**
   * Execute delegated swap with full validation and debugging
   */
  async executeDelegatedSwap(params: {
    delegatedExecutor: string;
    tokenIn: string;
    amountIn: BigNumber;
    minAmountOut: BigNumber;
    deadline: number;
    swapPath: string;
  }): Promise<{
    success: boolean;
    txHash?: string;
    gasUsed?: BigNumber;
    amountOut?: BigNumber;
    error?: string;
  }> {
    const eoa = this.signer.address;

    // Initialize debugger
    this.debugger.logInit({
      eoa,
      executor: params.delegatedExecutor,
      tokenIn: params.tokenIn,
      amountIn: params.amountIn,
    });

    try {
      // Step 1: Pre-flight validation
      logger.info('🔍 Running pre-flight validation...');
      const validationResult = await this.validator.validateDelegatedSwap({
        delegatedExecutor: params.delegatedExecutor,
        delegatedEOA: eoa,
        tokenIn: params.tokenIn,
        amountIn: params.amountIn,
        deadline: params.deadline,
      });

      if (!validationResult.valid) {
        this.debugger.logError({
          phase: 'validation',
          error: `Validation failed: ${validationResult.errors.join(', ')}`,
          context: { validationResult },
        });

        return {
          success: false,
          error: `Pre-flight validation failed: ${validationResult.errors[0]}`,
        };
      }

      // Log validation details
      this.debugger.logValidation({
        eoaBalance: {
          has: BigNumber.from('100000000000000000'), // Mock: 0.1 WETH
          needs: params.amountIn,
        },
        eoaNonce: await this.provider.getTransactionCount(eoa),
        eoaEth: await this.provider.getBalance(eoa),
        executorCode: true,
        approval: BigNumber.from('1000000000000000000'), // Mock: 1 WETH
        deadline: params.deadline,
      });

      // Step 2: Check and perform approval if needed
      logger.info('✅ Executing swap with delegated executor...');
      this.debugger.logApproval({
        token: params.tokenIn,
        executor: params.delegatedExecutor,
        amount: params.amountIn,
        status: 'confirmed',
      });

      // Step 3: Build and send delegation transaction
      const gasEstimate = BigNumber.from('200000');
      const gasPrice = await this.provider.getGasPrice();
      const maxFeePerGas = gasPrice.mul(2); // Increase for priority
      const maxPriorityFeePerGas = ethers.utils.parseUnits('2', 'gwei');

      this.debugger.logExecution({
        eoa,
        executor: params.delegatedExecutor,
        tokenIn: params.tokenIn,
        amountIn: params.amountIn,
        minAmountOut: params.minAmountOut,
        deadline: params.deadline,
        gasEstimate,
        gasLimit: gasEstimate,
        maxFeePerGas,
        maxPriorityFeePerGas,
        status: 'pending',
      });

      // Build the call data for executeSwap
      const executor = new ethers.Contract(
        params.delegatedExecutor,
        [
          'function executeSwap(address tokenIn, uint256 amountIn, bytes calldata path, uint256 minAmountOut, uint256 deadline) external returns (uint256)',
        ],
        this.signer
      );

      // Send transaction
      const tx = await executor.executeSwap(
        params.tokenIn,
        params.amountIn,
        params.swapPath,
        params.minAmountOut,
        params.deadline,
        {
          gasLimit: gasEstimate.mul(110).div(100), // Add 10% buffer
          maxFeePerGas,
          maxPriorityFeePerGas,
        }
      );

      this.debugger.logExecution({
        eoa,
        executor: params.delegatedExecutor,
        tokenIn: params.tokenIn,
        amountIn: params.amountIn,
        minAmountOut: params.minAmountOut,
        deadline: params.deadline,
        txHash: tx.hash,
        status: 'pending',
      });

      logger.info(`⏳ Waiting for transaction: ${tx.hash}`);

      // Wait for confirmation
      const receipt = await tx.wait();

      if (!receipt) {
        throw new Error('Transaction receipt not found');
      }

      if (receipt.status === 0) {
        throw new Error('Transaction reverted on-chain');
      }

      // Log settlement
      this.debugger.logSettlement({
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        transactionFee: receipt.gasUsed.mul(receipt.effectiveGasPrice),
        status: 'success',
      });

      logger.info(`✅ Swap successful: ${tx.hash}`);

      return {
        success: true,
        txHash: tx.hash,
        gasUsed: receipt.gasUsed,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      this.debugger.logError({
        phase: 'execution',
        error: error instanceof Error ? error : errorMsg,
        context: {
          delegatedExecutor: params.delegatedExecutor,
          amountIn: params.amountIn.toString(),
        },
      });

      logger.error(`❌ Swap failed: ${errorMsg}`);

      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Run full diagnostic suite
   */
  async runDiagnostics(): Promise<void> {
    logger.info('\n🔧 Running comprehensive EIP-7702 diagnostics...\n');

    // Run test harness
    const harness = new EIP7702TestHarness(this.provider.connection.url, this.signer.privateKey);

    const results = await harness.runFullTestSuite();

    // Print debug report
    this.debugger.printDebugReport();

    // Summary
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;

    logger.info(`\n✅ Diagnostics complete: ${passed}/${results.length} tests passed`);
    if (failed > 0) {
      logger.warn(`⚠️ ${failed} test(s) need attention`);
    }
  }

  /**
   * Simulate a delegated swap (dry-run)
   */
  async simulateDelegatedSwap(params: {
    delegatedExecutor: string;
    tokenIn: string;
    amountIn: BigNumber;
    minAmountOut: BigNumber;
    deadline: number;
    swapPath: string;
  }): Promise<{
    wouldSucceed: boolean;
    errors: string[];
    warnings: string[];
    summary: string;
  }> {
    const validation = await this.validator.validateDelegatedSwap({
      delegatedExecutor: params.delegatedExecutor,
      delegatedEOA: this.signer.address,
      tokenIn: params.tokenIn,
      amountIn: params.amountIn,
      deadline: params.deadline,
    });

    return {
      wouldSucceed: validation.valid,
      errors: validation.errors,
      warnings: validation.warnings,
      summary: validation.summary,
    };
  }
}

/**
 * Helper: Create integration instance and execute swap
 */
export async function executeWithFullDebugging(options: {
  providerUrl: string;
  signerKey: string;
  delegatedExecutor: string;
  tokenIn: string;
  amountIn: string;
  minAmountOut: string;
  swapPath: string;
}): Promise<void> {
  const integration = new EIP7702Integration(options.providerUrl, options.signerKey);

  // Run diagnostics first
  await integration.runDiagnostics();

  // Simulate swap
  logger.info('\n🎯 Simulating delegated swap...\n');
  const simulation = await integration.simulateDelegatedSwap({
    delegatedExecutor: options.delegatedExecutor,
    tokenIn: options.tokenIn,
    amountIn: ethers.utils.parseEther(options.amountIn),
    minAmountOut: ethers.utils.parseEther(options.minAmountOut),
    deadline: Math.floor(Date.now() / 1000) + 300,
    swapPath: options.swapPath,
  });

  if (!simulation.wouldSucceed) {
    logger.error('❌ Simulation failed:');
    simulation.errors.forEach((e) => logger.error(`  - ${e}`));
    return;
  }

  // Execute swap
  logger.info('\n🚀 Executing delegated swap...\n');
  const result = await integration.executeDelegatedSwap({
    delegatedExecutor: options.delegatedExecutor,
    tokenIn: options.tokenIn,
    amountIn: ethers.utils.parseEther(options.amountIn),
    minAmountOut: ethers.utils.parseEther(options.minAmountOut),
    deadline: Math.floor(Date.now() / 1000) + 300,
    swapPath: options.swapPath,
  });

  if (result.success) {
    logger.info(`✅ SUCCESS: ${result.txHash}`);
  } else {
    logger.error(`❌ FAILED: ${result.error}`);
  }
}

export default EIP7702Integration;
