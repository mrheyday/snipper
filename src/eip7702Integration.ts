import { ethers, Wallet } from 'ethers';
import { Logger } from './logger';
import PreFlightValidator from './preFlightValidator';
import EIP7702TestHarness from './eip7702TestHarness';
import DelegationDebugger from './delegationDebugger';
import {
  EIP7702Executor,
  getDelegationStatus,
  signAuthorization,
  DelegatedSwapResult,
} from './eip7702';
import { CHAIN_ID } from './config';

const logger = new Logger('EIP7702Integration');

/**
 * Complete EIP-7702 delegated swap execution with full debugging.
 * Uses the spec-compliant type-4 path in eip7702.ts (raw auth digest +
 * eth_sendRawTransaction), not a plain Contract.executeSwap call.
 */
export class EIP7702Integration {
  private provider: ethers.JsonRpcProvider;
  private providerUrl: string;
  private signer: Wallet;
  private validator: PreFlightValidator;
  private debugger: DelegationDebugger;

  constructor(providerUrl: string, signerKey: string) {
    this.providerUrl = providerUrl;
    this.provider = new ethers.JsonRpcProvider(providerUrl);
    this.signer = new Wallet(signerKey, this.provider);
    this.validator = new PreFlightValidator(this.provider);
    this.debugger = new DelegationDebugger();
  }

  async executeDelegatedSwap(params: {
    delegatedExecutor: string;
    tokenIn: string;
    amountIn: bigint;
    minAmountOut: bigint;
    deadline: number;
    swapPath: string | Buffer;
    clearAfter?: boolean;
  }): Promise<{
    success: boolean;
    txHash?: string;
    gasUsed?: bigint;
    amountOut?: bigint;
    error?: string;
    delegationCode?: string;
  }> {
    const eoa = this.signer.address;

    this.debugger.logInit({
      eoa,
      executor: params.delegatedExecutor,
      tokenIn: params.tokenIn,
      amountIn: params.amountIn,
    });

    try {
      logger.info('Running pre-flight validation...');
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
          error: 'Validation failed: ' + validationResult.errors.join(', '),
          context: { validationResult },
        });
        return {
          success: false,
          error: 'Pre-flight validation failed: ' + validationResult.errors[0],
        };
      }

      const status = await getDelegationStatus(eoa);
      const tokenBal = await new ethers.Contract(
        params.tokenIn,
        ['function balanceOf(address) view returns (uint256)'],
        this.provider
      ).balanceOf(eoa);

      this.debugger.logValidation({
        eoaBalance: { has: tokenBal, needs: params.amountIn },
        eoaNonce: status.nonce,
        eoaEth: await this.provider.getBalance(eoa),
        executorCode: true,
        approval: 0n,
        deadline: params.deadline,
      });

      const authPreview = await signAuthorization(this.signer, params.delegatedExecutor, {
        chainId: CHAIN_ID,
        nonce: status.nonce,
      });
      logger.info(
        'Authorization preview: delegate=' +
          authPreview.address +
          ' nonce=' +
          authPreview.nonce +
          ' yParity=' +
          authPreview.yParity
      );

      this.debugger.logApproval({
        token: params.tokenIn,
        executor: params.delegatedExecutor,
        amount: params.amountIn,
        status: 'confirmed',
      });

      const executor = new EIP7702Executor(params.delegatedExecutor, CHAIN_ID, this.signer);

      logger.info('Sending type-4 delegated swap via EIP7702Executor...');
      const result: DelegatedSwapResult = await executor.executeDelegatedSwap({
        tokenIn: params.tokenIn,
        amountIn: params.amountIn,
        path: params.swapPath,
        minAmountOut: params.minAmountOut,
        deadline: params.deadline,
        clearAfter: params.clearAfter,
      });

      if (!result.success) {
        this.debugger.logError({
          phase: 'execution',
          error: result.error || 'unknown',
          context: { txHash: result.txHash },
        });
        return {
          success: false,
          error: result.error,
          txHash: result.txHash,
          gasUsed: result.gasUsed,
        };
      }

      this.debugger.logSettlement({
        txHash: result.txHash || '',
        blockNumber: 0,
        gasUsed: result.gasUsed || 0n,
        transactionFee: 0n,
        status: 'success',
      });

      logger.info('Swap successful: ' + result.txHash);
      return {
        success: true,
        txHash: result.txHash,
        gasUsed: result.gasUsed,
        delegationCode: result.delegationCode,
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
      logger.error('Swap failed: ' + errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  async runDiagnostics(): Promise<void> {
    logger.info('Running comprehensive EIP-7702 diagnostics...');
    const harness = new EIP7702TestHarness(this.providerUrl, this.signer.privateKey);
    const results = await harness.runFullTestSuite();
    this.debugger.printDebugReport();
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;
    logger.info('Diagnostics complete: ' + passed + '/' + results.length + ' tests passed');
    if (failed > 0) logger.warn(String(failed) + ' test(s) need attention');
  }

  async simulateDelegatedSwap(params: {
    delegatedExecutor: string;
    tokenIn: string;
    amountIn: bigint;
    minAmountOut: bigint;
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
  await integration.runDiagnostics();

  logger.info('Simulating delegated swap...');
  const simulation = await integration.simulateDelegatedSwap({
    delegatedExecutor: options.delegatedExecutor,
    tokenIn: options.tokenIn,
    amountIn: ethers.parseEther(options.amountIn),
    minAmountOut: ethers.parseEther(options.minAmountOut),
    deadline: Math.floor(Date.now() / 1000) + 300,
    swapPath: options.swapPath,
  });

  if (!simulation.wouldSucceed) {
    logger.error('Simulation failed:');
    simulation.errors.forEach((e) => logger.error('  - ' + e));
    return;
  }

  logger.info('Executing delegated swap (type-4)...');
  const result = await integration.executeDelegatedSwap({
    delegatedExecutor: options.delegatedExecutor,
    tokenIn: options.tokenIn,
    amountIn: ethers.parseEther(options.amountIn),
    minAmountOut: ethers.parseEther(options.minAmountOut),
    deadline: Math.floor(Date.now() / 1000) + 300,
    swapPath: options.swapPath,
  });

  if (result.success) {
    logger.info('SUCCESS: ' + result.txHash);
  } else {
    logger.error('FAILED: ' + result.error);
  }
}

export default EIP7702Integration;
