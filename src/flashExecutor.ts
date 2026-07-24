import { ethers, Signer, Wallet } from 'ethers';
import { signer, provider, BATCH_EXECUTOR_ADDRESS, CHAIN_ID, FLASH_USE_TYPE4 } from './config';
import { FLASH_LOAN_RECEIVER_ABI } from './contractABIs';
import { BatchEOAExecutor, BatchCall } from './eip7702';
import { getEip1559Fees } from './fees';
import { Logger } from './logger';
import { getReserveEligibility } from './aaveReserves';

const logger = new Logger('FlashLoanExecutor');

/** Encoded initiateFlashLoan(address,address,uint256,bytes,uint256) for type-4 batches. */
const INITIATE_FLASH_IFACE = new ethers.Interface([
  'function initiateFlashLoan(address token, address router, uint256 amount, bytes swapPath, uint256 minAmountOut)',
]);

// Aave V3 Arbitrum periphery addresses, verified on-chain and cross-checked against
// bgd-labs/aave-address-book (AaveV3Arbitrum.sol). POOL_ADDRESSES_PROVIDER matches
// ADDRESSES_PROVIDER() read directly off the live Aave V3 Pool at
// 0x794a61358D6845594F94dc1DB02A252b5b4814aD.
const UI_POOL_DATA_PROVIDER_ADDRESS = '0x91E04cf78e53aEBe609e8a7f2003e7EECD743F2B';
const POOL_ADDRESSES_PROVIDER_ADDRESS = '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb';
const ARBITRUM_CHAIN_ID = 42161;

interface FlashLoanParams {
  token: string;
  /** Router SniperSearcher should swap against (must be on its allowedRouters). */
  router: string;
  amount: bigint;
  swapPath: Buffer | string;
  minAmountOut: bigint;
  /**
   * When true (and BATCH_EXECUTOR_ADDRESS is configured), initiate via EIP-7702
   * type-4: EOA authorizes BasicEOABatchExecutor then CALLs FlashLoanReceiver.
   * Owner of FlashLoanReceiver must be the signing EOA (msg.sender under 7702).
   */
  useType4?: boolean;
}

interface FlashLoanResult {
  success: boolean;
  txHash?: string;
  profit?: bigint;
  error?: string;
  gasUsed?: bigint;
  revertReason?: string;
  /** Set when the initiation tx was EIP-7702 type-4. */
  type4?: boolean;
}

// Aave V3 Lending Pool on Arbitrum: 0x794a61358D6845594F94dc1DB02A252b5b4814aD
// Used in FlashLoanReceiver contract deployment

/**
 * Flash Loan Executor
 * Executes arbitrage using Aave flash loans (0% interest, only fee paid)
 *
 * Flow:
 * 1. Bot initiates flash loan
 * 2. Aave transfers tokens to receiver
 * 3. Receiver executes arbitrage swap
 * 4. Receiver approves Pool for amount+premium (Aave pulls — do not transfer)
 * 5. Profit (leftover borrow asset) withdrawn by owner
 *
 * Aave V3 docs compliance:
 * - Uses flashLoanSimple (single reserve, no debt mode, fee not waived)
 * - executeOperation returns true; premium from callback is repay source of truth
 * - Live Arbitrum FLASHLOAN_PREMIUM_TOTAL = 5 bps (not the historical 9)
 */
export class FlashLoanExecutor {
  private receiver: ethers.Contract;
  private executorSigner: Signer;
  private batchExecutor: BatchEOAExecutor | null;

  constructor(receiverAddress: string, executorSigner?: Signer) {
    this.executorSigner = executorSigner || signer;
    this.receiver = new ethers.Contract(
      receiverAddress,
      FLASH_LOAN_RECEIVER_ABI,
      this.executorSigner
    );
    // Optional EIP-7702 type-4 path (requires BATCH_EXECUTOR_ADDRESS + Wallet signer).
    if (BATCH_EXECUTOR_ADDRESS && this.executorSigner instanceof Wallet) {
      this.batchExecutor = new BatchEOAExecutor(
        BATCH_EXECUTOR_ADDRESS,
        CHAIN_ID,
        this.executorSigner
      );
    } else {
      this.batchExecutor = null;
    }
  }

  /** True when this executor can send type-4 flash initiations. */
  supportsType4(): boolean {
    return this.batchExecutor !== null;
  }

  /**
   * Check whether a token is a live, borrowable Aave V3 reserve on Arbitrum.
   * Flash loans require borrowing to be enabled for the asset; querying this
   * up front avoids sending a transaction that Aave would reject regardless
   * of our own contract logic (e.g. reserve not listed, or borrowing paused).
   */
  private async checkReserveEligibility(
    token: string
  ): Promise<{ eligible: boolean; reason?: string }> {
    const elig = await getReserveEligibility(token);
    return { eligible: elig.eligible, reason: elig.reason };
  }

  /**
   * Execute arbitrage using flash loan with transaction polling
   * @param params Flash loan parameters
   * @returns Execution result with profit
   */
  async executeFlashLoanArbitrage(params: FlashLoanParams): Promise<FlashLoanResult> {
    let txHash: string | undefined;
    try {
      logger.info('Initiating flash loan arbitrage');
      logger.info(`Borrowing: ${ethers.formatUnits(params.amount, 18)}`);
      logger.info(`Min output: ${ethers.formatUnits(params.minAmountOut, 18)}`);
      logger.info('Fee: Pool FLASHLOAN_PREMIUM_TOTAL bps (Arbitrum ~0.05%)');

      // Path must end in the borrow asset (Aave repay currency). Off-chain gate —
      // on-chain SniperSearcher only checks tokenIn == path start.
      const pathCheck = this.assertRoundTripPath(params.token, params.swapPath);
      if (!pathCheck.ok) {
        logger.warn(`Flash path rejected: ${pathCheck.reason}`);
        return { success: false, error: pathCheck.reason };
      }

      // Check reserve eligibility before attempting anything on-chain — cheap,
      // free (view calls only), and gives a clear reason instead of a bare revert.
      const eligibility = await this.checkReserveEligibility(params.token);
      if (!eligibility.eligible) {
        logger.warn(`Flash loan not possible: ${eligibility.reason}`);
        return {
          success: false,
          error: `Reserve not eligible for flash loan: ${eligibility.reason}`,
        };
      }

      // Type-4 path: EOA delegates to BEBE and CALLs FlashLoanReceiver.initiateFlashLoan.
      // Owner of the receiver must be the signing EOA (msg.sender under EIP-7702).
      const wantType4 = params.useType4 === true || (params.useType4 !== false && FLASH_USE_TYPE4);
      if (wantType4) {
        return this.executeFlashLoanType4(params);
      }

      // Owner must match signer for onlyOwner initiate.
      const owner: string = await this.receiver.owner();
      const signerAddr = await this.executorSigner.getAddress();
      if (owner.toLowerCase() !== signerAddr.toLowerCase()) {
        return {
          success: false,
          error: `FlashLoanReceiver.owner (${owner}) != signer (${signerAddr})`,
        };
      }

      // Estimate gas
      const gasEstimate = await this.estimateFlashLoanGas(params);
      logger.info(`Gas estimate: ${gasEstimate.toString()}`);

      const fees = await getEip1559Fees();
      // Initiate flash loan (standard type-2 EIP-1559 tx)
      const tx = await this.receiver.initiateFlashLoan(
        params.token,
        params.router,
        params.amount,
        params.swapPath,
        params.minAmountOut,
        {
          gasLimit: (gasEstimate * 115n) / 100n, // 15% buffer
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        }
      );

      txHash = tx.hash;
      logger.info(`Flash loan initiated: ${txHash}`);

      // Poll for confirmation with timeout
      if (!txHash) {
        throw new Error('Flash loan transaction sent but no hash returned');
      }

      const receipt = await this.pollTransactionStatus(txHash, 40 * 1000, 15); // 40s max, 15 blocks

      if (!receipt) {
        return {
          success: false,
          error: 'Flash loan timeout - no confirmation after 40s',
          txHash,
        };
      }

      if (receipt.status === 0) {
        const revertReason = await this.decodeRevertReason(txHash);
        logger.error(`Flash loan reverted: ${revertReason}`);
        return {
          success: false,
          error: 'Flash loan transaction reverted',
          revertReason,
          txHash,
        };
      }

      logger.info(
        `Flash loan completed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed}`
      );

      // Check profit
      const profit = await this.getProfitEstimate(params);
      if (profit > 0) {
        logger.info(`Estimated profit: ${ethers.formatUnits(profit, 18)}`);
      }

      return {
        success: true,
        txHash,
        profit: profit,
        gasUsed: receipt.gasUsed,
        type4: false,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Flash loan failed: ${errorMsg}`);

      return {
        success: false,
        error: errorMsg,
        txHash,
      };
    }
  }

  /**
   * Execute multiple flash loans in sequence
   * @param loanBatches Array of flash loan parameter sets
   */
  async executeBatchFlashLoans(loanBatches: FlashLoanParams[]): Promise<FlashLoanResult[]> {
    logger.info(`Executing batch flash loans (${loanBatches.length} total)`);
    const results: FlashLoanResult[] = [];

    for (let i = 0; i < loanBatches.length; i++) {
      logger.info(`[${i + 1}/${loanBatches.length}] Processing batch loan`);
      const result = await this.executeFlashLoanArbitrage(loanBatches[i]);
      results.push(result);

      // Small delay between loans to avoid rate limiting
      if (i < loanBatches.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const totalProfit = results
      .filter((r) => r.profit)
      .reduce((sum, r) => sum + r.profit!, BigInt(0));

    logger.info(`Batch complete: ${successCount}/${loanBatches.length} successful`);
    logger.info(`Total profit: ${ethers.formatUnits(totalProfit, 18)}`);

    return results;
  }

  /**
   * Withdraw profit from flash loan receiver
   * @param token Token to withdraw
   * @param to Recipient address
   * @param amount Amount to withdraw (0 = all)
   */
  async withdraw(token: string, to: string, amount?: bigint): Promise<FlashLoanResult> {
    let txHash: string | undefined;
    try {
      logger.info('Withdrawing from flash loan receiver');

      const withdrawAmount = amount || (await this.getBalance(token));
      logger.info(`Token: ${token}, Amount: ${ethers.formatUnits(withdrawAmount, 18)}`);

      const tx = await this.receiver.withdraw(token, to, withdrawAmount);
      txHash = tx.hash;
      logger.info(`Withdrawal initiated: ${txHash}`);

      const receipt = await tx.wait(3);

      if (!receipt) {
        return {
          success: false,
          error: 'Withdrawal failed - no receipt',
          txHash,
        };
      }

      logger.info(`Withdrawal successful`);
      return {
        success: true,
        txHash,
        gasUsed: receipt.gasUsed,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Withdrawal failed: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
        txHash,
      };
    }
  }

  /**
   * Check balance in flash loan receiver
   */
  async getBalance(token: string): Promise<bigint> {
    try {
      const balance = await this.receiver.getBalance(token);
      return BigInt(balance);
    } catch (error) {
      logger.warn(
        `Failed to get balance: ${error instanceof Error ? error.message : String(error)}`
      );
      return BigInt(0);
    }
  }

  /**
   * Get receiver contract address
   */
  getReceiverAddress(): string {
    return this.receiver.target as string;
  }

  /**
   * Estimate profit from flash loan arbitrage.
   * profit ≈ minAmountOut - loanAmount - fee
   * fee uses Pool premium bps when readable, else 5 bps Arbitrum hint.
   * Path must round-trip to the borrow asset for repay to succeed.
   */
  private async getProfitEstimate(params: FlashLoanParams): Promise<bigint> {
    const feeBps = await this.getFlashPremiumBps();
    const fee = (params.amount * BigInt(feeBps)) / BigInt(10000);
    const totalCost = params.amount + fee;

    return params.minAmountOut - totalCost > 0 ? params.minAmountOut - totalCost : 0n;
  }

  /**
   * Read live FLASHLOAN_PREMIUM_TOTAL via receiver.flashLoanPremiumBps(), fallback 5.
   */
  private async getFlashPremiumBps(): Promise<number> {
    try {
      const bps = await this.receiver.flashLoanPremiumBps();
      const n = Number(bps);
      if (n > 0 && n < 10_000) return n;
    } catch {
      // redeployed ABI / offline
    }
    return 5;
  }

  /**
   * Initiate flash loan via EIP-7702 type-4 + BasicEOABatchExecutor.
   *
   * Flow:
   *   1. EOA signs auth -> BasicEOABatchExecutor
   *   2. type-4 tx `to=EOA` data=execute([CALL FlashLoanReceiver.initiateFlashLoan])
   *   3. Under 7702, msg.sender of that CALL is the EOA (must be FlashLoanReceiver.owner)
   *   4. FlashLoanReceiver -> Aave.flashLoanSimple -> executeOperation
   *      - approves SniperSearcher, executeSwap, approves Aave for repay
   */
  private async executeFlashLoanType4(params: FlashLoanParams): Promise<FlashLoanResult> {
    if (!this.batchExecutor) {
      return {
        success: false,
        error: 'Type-4 flash loan unavailable: set BATCH_EXECUTOR_ADDRESS and use a Wallet signer',
        type4: true,
      };
    }

    const owner: string = await this.receiver.owner();
    const signerAddr = await this.executorSigner.getAddress();
    if (owner.toLowerCase() !== signerAddr.toLowerCase()) {
      return {
        success: false,
        error: `Type-4 flash requires FlashLoanReceiver.owner == EOA (owner=${owner}, eoa=${signerAddr})`,
        type4: true,
      };
    }

    const pathHex =
      typeof params.swapPath === 'string' ? params.swapPath : ethers.hexlify(params.swapPath);

    const data = INITIATE_FLASH_IFACE.encodeFunctionData('initiateFlashLoan', [
      params.token,
      params.router,
      params.amount,
      pathHex,
      params.minAmountOut,
    ]);

    const calls: BatchCall[] = [
      {
        to: this.receiver.target as string,
        data,
      },
    ];

    logger.info('Initiating flash loan via EIP-7702 type-4 batch');
    logger.info(`  receiver: ${this.receiver.target as string}`);
    logger.info(`  batchExecutor: ${this.batchExecutor.getExecutorAddress()}`);

    const balanceBefore: bigint = await this.receiver.getBalance(params.token);

    const result = await this.batchExecutor.executeBatchCalls(calls, {
      // Flash + Aave callback + Uniswap swap is heavier than a plain approve/swap.
      gasLimit: BigInt(1_200_000),
    });

    if (!result.success) {
      return {
        success: false,
        error: result.error ?? 'type-4 flash loan failed',
        txHash: result.txHash,
        gasUsed: result.gasUsed,
        type4: true,
      };
    }

    // Require on-chain evidence: FlashLoanExecuted log or balance increase (profit).
    let sawEvent = false;
    if (result.txHash) {
      try {
        const receipt = await provider.getTransactionReceipt(result.txHash);
        if (receipt) {
          for (const log of receipt.logs) {
            try {
              const parsed = this.receiver.interface.parseLog({
                topics: [...log.topics],
                data: log.data,
              });
              if (parsed?.name === 'FlashLoanExecuted') {
                sawEvent = true;
                break;
              }
            } catch {
              /* not our log */
            }
          }
        }
      } catch {
        /* non-fatal; fall through to balance check */
      }
    }

    const balanceAfter: bigint = await this.receiver.getBalance(params.token);
    const profit = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0n;

    if (!sawEvent && profit === 0n) {
      return {
        success: false,
        error:
          'type-4 tx confirmed but no FlashLoanExecuted event and no profit balance delta — auth/call may have been a no-op',
        txHash: result.txHash,
        gasUsed: result.gasUsed,
        type4: true,
      };
    }

    if (profit > 0n) {
      logger.info(`On-chain profit (balance delta): ${profit.toString()}`);
    }

    return {
      success: true,
      txHash: result.txHash,
      profit,
      gasUsed: result.gasUsed,
      type4: true,
    };
  }

  /**
   * Estimate gas for flash loan
   */
  private async estimateFlashLoanGas(params: FlashLoanParams): Promise<bigint> {
    try {
      const gasEstimate = await this.receiver.initiateFlashLoan.estimateGas(
        params.token,
        params.router,
        params.amount,
        params.swapPath,
        params.minAmountOut
      );
      return gasEstimate;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const err = new Error(
        `Gas estimation failed (transaction would revert): ${reason}`
      ) as Error & { cause: unknown };
      err.cause = error;
      throw err;
    }
  }

  /**
   * Poll transaction status until confirmation or timeout
   */
  private async pollTransactionStatus(
    txHash: string,
    maxWaitMs: number,
    maxBlocks: number
  ): Promise<ethers.TransactionReceipt | null> {
    const startTime = Date.now();
    const startBlock = await provider.getBlockNumber();

    while (Date.now() - startTime < maxWaitMs) {
      const receipt = await provider.getTransactionReceipt(txHash);

      if (receipt) {
        return receipt;
      }

      const currentBlock = await provider.getBlockNumber();
      if (currentBlock - startBlock >= maxBlocks) {
        return null;
      }

      // Wait 2 seconds before polling again
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    return null;
  }

  /**
   * Decode revert reason from failed transaction
   */
  private async decodeRevertReason(txHashValue: string): Promise<string> {
    try {
      const tx = await provider.getTransaction(txHashValue);
      if (!tx) return 'Transaction not found';

      // Create a transaction request for the call
      const txRequest = {
        to: tx.to,
        from: tx.from,
        data: tx.data,
        value: tx.value,
      };

      try {
        const result = await provider.call({ ...txRequest, blockTag: tx.blockNumber ?? undefined });
        if (result === '0x') return 'Unknown error';

        // Try to decode as Error(string)
        try {
          const iface = new ethers.Interface(['function Error(string) public pure']);
          const decoded = iface.decodeFunctionResult('Error', result);
          return decoded[0] as string;
        } catch {
          return `Raw error data: ${result.slice(0, 200)}`;
        }
      } catch (callError) {
        return callError instanceof Error ? callError.message : 'Call failed';
      }
    } catch (error) {
      return error instanceof Error ? error.message : 'Unknown error';
    }
  }

  /**
   * Uni V3 path must start AND end with the Aave borrow asset (round-trip repay).
   * Min length 66 bytes for two hops: t20|f3|t20|f3|t20.
   */
  private assertRoundTripPath(
    borrowToken: string,
    swapPath: Buffer | string
  ): { ok: true } | { ok: false; reason: string } {
    const hex =
      typeof swapPath === 'string'
        ? swapPath.startsWith('0x')
          ? swapPath.slice(2)
          : swapPath
        : Buffer.isBuffer(swapPath)
          ? swapPath.toString('hex')
          : Buffer.from(swapPath as ArrayBuffer).toString('hex');

    if (hex.length < 132) {
      // 66 bytes * 2 hex chars — single hop cannot repay flash in same asset
      return {
        ok: false,
        reason:
          `Flash path too short (${hex.length / 2} bytes). ` +
          'Need ≥2 hops ending in borrow asset (min 66 bytes).',
      };
    }
    if ((hex.length / 2 - 20) % 23 !== 0) {
      return { ok: false, reason: 'Flash path length is not a valid Uni V3 encoding' };
    }

    const start = ethers.getAddress('0x' + hex.slice(0, 40));
    const end = ethers.getAddress('0x' + hex.slice(-40));
    const borrow = ethers.getAddress(borrowToken);

    if (start !== borrow) {
      return {
        ok: false,
        reason: `Path tokenIn ${start} != borrow asset ${borrow}`,
      };
    }
    if (end !== borrow) {
      return {
        ok: false,
        reason:
          `Path tokenOut ${end} != borrow asset ${borrow}. ` +
          'Aave flashLoanSimple requires repay in the same asset (round-trip path).',
      };
    }
    return { ok: true };
  }
}

/**
 * Flash Loan Helper Functions
 */

/**
 * Estimate Aave V3 flash loan fee.
 * Default 5 bps matches Arbitrum FLASHLOAN_PREMIUM_TOTAL as of 2026-07-23.
 * Pass live bps from Pool.FLASHLOAN_PREMIUM_TOTAL() when available.
 */
export function calculateFlashLoanFee(amount: bigint, premiumBps: number = 5): bigint {
  return (amount * BigInt(premiumBps)) / BigInt(10000);
}

/**
 * Calculate break-even price for flash loan arbitrage
 * breakEvenPrice = (loanAmount + fee) / outputTokens
 */
export function calculateBreakEvenPrice(
  loanAmount: bigint,
  expectedOutput: bigint,
  outputDecimals: number = 18
): number {
  const fee = calculateFlashLoanFee(loanAmount);
  const totalCost = loanAmount + fee;
  const breakEven = totalCost / expectedOutput;
  return parseFloat(ethers.formatUnits(breakEven, outputDecimals));
}

/**
 * Calculate max borrow amount given gas budget
 * maxBorrow = gasbudget / (gasPricePerBorrow + ~0.05% fee cost)
 */
export function calculateMaxBorrowAmount(gasBudgetWei: bigint, gasPriceWei: bigint): bigint {
  // Calculate max borrow given gas budget
  const maxFromBudget = gasBudgetWei / gasPriceWei;

  // Fee impact at 5 bps: effective cost ≈ 1.0005 per token
  return (maxFromBudget * 10000n) / 10005n;
}

export default FlashLoanExecutor;
