import { BigNumber, ethers, Signer, providers } from 'ethers';
import { UiPoolDataProvider } from '@aave/contract-helpers';
import { signer, provider } from './config';
import { FLASH_LOAN_RECEIVER_ABI } from './contractABIs';
import { Logger } from './logger';

const logger = new Logger('FlashLoanExecutor');

// Aave V3 Arbitrum periphery addresses, verified on-chain and cross-checked against
// bgd-labs/aave-address-book (AaveV3Arbitrum.sol). POOL_ADDRESSES_PROVIDER matches
// ADDRESSES_PROVIDER() read directly off the live Aave V3 Pool at
// 0x794a61358D6845594F94dc1DB02A252b5b4814aD.
const UI_POOL_DATA_PROVIDER_ADDRESS = '0x91E04cf78e53aEBe609e8a7f2003e7EECD743F2B';
const POOL_ADDRESSES_PROVIDER_ADDRESS = '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb';
const ARBITRUM_CHAIN_ID = 42161;

interface FlashLoanParams {
  token: string;
  amount: BigNumber;
  swapPath: Buffer;
  minAmountOut: BigNumber;
}

interface FlashLoanResult {
  success: boolean;
  txHash?: string;
  profit?: BigNumber;
  error?: string;
  gasUsed?: BigNumber;
  revertReason?: string;
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
 * 4. Receiver repays loan + 0.09% fee
 * 5. Profit extracted to wallet
 */
export class FlashLoanExecutor {
  private receiver: ethers.Contract;
  private executorSigner: Signer;
  private poolDataProvider: UiPoolDataProvider;

  constructor(receiverAddress: string, executorSigner?: Signer) {
    this.executorSigner = executorSigner || signer;
    this.receiver = new ethers.Contract(
      receiverAddress,
      FLASH_LOAN_RECEIVER_ABI,
      this.executorSigner
    );
    this.poolDataProvider = new UiPoolDataProvider({
      uiPoolDataProviderAddress: UI_POOL_DATA_PROVIDER_ADDRESS,
      provider,
      chainId: ARBITRUM_CHAIN_ID,
    });
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
    try {
      const { reservesData } = await this.poolDataProvider.getReservesHumanized({
        lendingPoolAddressProvider: POOL_ADDRESSES_PROVIDER_ADDRESS,
      });

      const reserve = reservesData.find(
        (r) => r.underlyingAsset.toLowerCase() === token.toLowerCase()
      );

      if (!reserve) {
        return { eligible: false, reason: 'Not an Aave V3 Arbitrum reserve' };
      }
      if (!reserve.isActive) {
        return { eligible: false, reason: 'Reserve is not active' };
      }
      if (reserve.isPaused) {
        return { eligible: false, reason: 'Reserve is paused' };
      }
      if (reserve.isFrozen) {
        return { eligible: false, reason: 'Reserve is frozen' };
      }
      if (!reserve.borrowingEnabled) {
        return { eligible: false, reason: 'Borrowing disabled for this reserve' };
      }

      return { eligible: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(`Reserve eligibility check failed, proceeding without it: ${reason}`);
      return { eligible: true };
    }
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
      logger.info(`Borrowing: ${ethers.utils.formatUnits(params.amount, 18)}`);
      logger.info(`Min output: ${ethers.utils.formatUnits(params.minAmountOut, 18)}`);
      logger.info('Fee: 0.09% (Aave V3)');

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

      // Estimate gas
      const gasEstimate = await this.estimateFlashLoanGas(params);
      logger.info(`Gas estimate: ${gasEstimate.toString()}`);

      // Initiate flash loan
      const tx = await this.receiver.initiateFlashLoan(
        params.token,
        params.amount,
        params.swapPath,
        params.minAmountOut,
        {
          gasLimit: gasEstimate.mul(115).div(100), // 15% buffer
          maxFeePerGas: await provider.getGasPrice().then((p) => p.mul(120).div(100)), // 20% above current
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
      if (profit.gt(0)) {
        logger.info(`Estimated profit: ${ethers.utils.formatUnits(profit, 18)}`);
      }

      return {
        success: true,
        txHash,
        profit: profit,
        gasUsed: receipt.gasUsed,
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
      .reduce((sum, r) => sum.add(r.profit!), BigNumber.from(0));

    logger.info(`Batch complete: ${successCount}/${loanBatches.length} successful`);
    logger.info(`Total profit: ${ethers.utils.formatUnits(totalProfit, 18)}`);

    return results;
  }

  /**
   * Withdraw profit from flash loan receiver
   * @param token Token to withdraw
   * @param to Recipient address
   * @param amount Amount to withdraw (0 = all)
   */
  async withdraw(token: string, to: string, amount?: BigNumber): Promise<FlashLoanResult> {
    let txHash: string | undefined;
    try {
      logger.info('Withdrawing from flash loan receiver');

      const withdrawAmount = amount || (await this.getBalance(token));
      logger.info(`Token: ${token}, Amount: ${ethers.utils.formatUnits(withdrawAmount, 18)}`);

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
  async getBalance(token: string): Promise<BigNumber> {
    try {
      const balance = await this.receiver.getBalance(token);
      return BigNumber.from(balance);
    } catch (error) {
      logger.warn(
        `Failed to get balance: ${error instanceof Error ? error.message : String(error)}`
      );
      return BigNumber.from(0);
    }
  }

  /**
   * Get receiver contract address
   */
  getReceiverAddress(): string {
    return this.receiver.address;
  }

  /**
   * Estimate profit from flash loan arbitrage
   * profit = outputAmount - loanAmount - fee
   * where fee = loanAmount * 0.0009 (0.09%)
   */
  private async getProfitEstimate(params: FlashLoanParams): Promise<BigNumber> {
    const fee = params.amount.mul(9).div(10000); // 0.09% fee
    const totalCost = params.amount.add(fee);

    // Estimate: if we get at least minAmountOut, profit is:
    return params.minAmountOut.sub(totalCost).gt(0)
      ? params.minAmountOut.sub(totalCost)
      : BigNumber.from(0);
  }

  /**
   * Estimate gas for flash loan
   */
  private async estimateFlashLoanGas(params: FlashLoanParams): Promise<BigNumber> {
    try {
      const gasEstimate = await this.receiver.estimateGas.initiateFlashLoan(
        params.token,
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
  ): Promise<providers.TransactionReceipt | null> {
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
        const result = await provider.call(txRequest, tx.blockNumber);
        if (result === '0x') return 'Unknown error';

        // Try to decode as Error(string)
        try {
          const iface = new ethers.utils.Interface(['function Error(string) public pure']);
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
}

/**
 * Flash Loan Helper Functions
 */

/**
 * Calculate Aave flash loan fee
 * Fee = amount × 0.09% (0.0009)
 */
export function calculateFlashLoanFee(amount: BigNumber): BigNumber {
  return amount.mul(9).div(10000);
}

/**
 * Calculate break-even price for flash loan arbitrage
 * breakEvenPrice = (loanAmount + fee) / outputTokens
 */
export function calculateBreakEvenPrice(
  loanAmount: BigNumber,
  expectedOutput: BigNumber,
  outputDecimals: number = 18
): number {
  const fee = calculateFlashLoanFee(loanAmount);
  const totalCost = loanAmount.add(fee);
  const breakEven = totalCost.div(expectedOutput);
  return parseFloat(ethers.utils.formatUnits(breakEven, outputDecimals));
}

/**
 * Calculate max borrow amount given gas budget
 * maxBorrow = gasbudget / (gasPricePerBorrow + 0.09% fee cost)
 */
export function calculateMaxBorrowAmount(
  gasBudgetWei: BigNumber,
  gasPriceWei: BigNumber
): BigNumber {
  // Calculate max borrow given gas budget
  const maxFromBudget = gasBudgetWei.div(gasPriceWei);

  // Fee impact: for every 1 token borrowed, 0.0009 is paid as fee
  // Effective cost = 1.0009 per token
  return maxFromBudget.mul(10000).div(10009);
}

export default FlashLoanExecutor;
