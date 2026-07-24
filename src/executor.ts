import { ethers, Signer } from 'ethers';
import { signer, provider } from './config';
import { SNIPER_SEARCHER_ABI } from './contractABIs';
import { getEip1559Fees } from './fees';
import { Logger } from './logger';

const logger = new Logger('SniperExecutor');

interface SwapParams {
  tokenIn: string;
  router: string;
  amountIn: bigint;
  path: Buffer;
  minAmountOut: bigint;
  deadline?: number;
}

interface ExecutionResult {
  success: boolean;
  txHash?: string;
  amountOut?: bigint;
  error?: string;
  gasUsed?: bigint;
  revertReason?: string;
}

export class SniperExecutor {
  private searcher: ethers.Contract;
  private executorSigner: Signer;

  constructor(searcherAddress: string, executorSigner?: Signer) {
    this.executorSigner = executorSigner || signer;
    this.searcher = new ethers.Contract(searcherAddress, SNIPER_SEARCHER_ABI, this.executorSigner);
  }

  /**
   * Execute swap through SniperSearcher contract with transaction polling
   */
  async executeSwap(params: SwapParams): Promise<ExecutionResult> {
    let txHash: string | undefined;
    try {
      logger.info('Executing swap via SniperSearcher');
      logger.info(`Input: ${ethers.formatUnits(params.amountIn, 18)}`);
      logger.info(`Min output: ${ethers.formatUnits(params.minAmountOut, 18)}`);

      // Exact-amount approve only (never MaxUint256 — limits blast radius if key leaks)
      await this.ensureAllowance(params.tokenIn, params.amountIn);

      // Prefer deadline-bound entrypoint (S-3). Default 120s matches on-chain executeSwap.
      const deadline =
        params.deadline && params.deadline > 0
          ? params.deadline
          : Math.floor(Date.now() / 1000) + 120;

      const gasEstimate = await this.estimateSwapGasWithDeadline({
        ...params,
        deadline,
      });
      logger.info(`Gas estimate: ${gasEstimate.toString()}`);
      logger.info(`Deadline: ${deadline}`);

      const fees = await getEip1559Fees();
      const tx = await this.searcher.executeSwapWithDeadline(
        params.tokenIn,
        params.router,
        params.amountIn,
        params.path,
        params.minAmountOut,
        deadline,
        {
          gasLimit: (gasEstimate * 110n) / 100n, // 10% buffer
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        }
      );

      txHash = tx.hash;
      logger.info(`Transaction sent: ${txHash}`);

      // Poll for confirmation with timeout
      if (!txHash) {
        throw new Error('Transaction sent but no hash returned');
      }

      const receipt = await this.pollTransactionStatus(txHash, 30 * 1000, 12); // 30s max, 12 blocks

      if (!receipt) {
        return {
          success: false,
          error: 'Transaction timeout - no confirmation after 30s',
          txHash,
        };
      }

      if (receipt.status === 0) {
        const revertReason = await this.decodeRevertReason(txHash);
        logger.error(`Transaction reverted: ${revertReason}`);
        return {
          success: false,
          error: 'Transaction reverted',
          revertReason,
          txHash,
        };
      }

      logger.info(`Confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed}`);

      return {
        success: true,
        txHash,
        gasUsed: receipt.gasUsed,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Swap execution failed: ${errorMsg}`);

      return {
        success: false,
        error: errorMsg,
        txHash,
      };
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
   * Decode revert reason from failed transaction (custom errors + Error(string)).
   */
  private async decodeRevertReason(txHashValue: string): Promise<string> {
    try {
      const tx = await provider.getTransaction(txHashValue);
      if (!tx) return 'Transaction not found';

      const txRequest = {
        to: tx.to,
        from: tx.from,
        data: tx.data,
        value: tx.value,
      };

      try {
        await provider.call({ ...txRequest, blockTag: tx.blockNumber ?? undefined });
        return 'Unknown error (call succeeded on replay)';
      } catch (callError: unknown) {
        const err = callError as {
          data?: string;
          reason?: string;
          message?: string;
          error?: { data?: string };
        };
        const data =
          err.data ||
          err.error?.data ||
          (typeof err.message === 'string' && err.message.includes('0x')
            ? err.message.match(/0x[0-9a-fA-F]+/)?.[0]
            : undefined);
        if (data && data !== '0x') {
          try {
            const parsed = this.searcher.interface.parseError(data);
            if (parsed) return `${parsed.name}(${parsed.args.map(String).join(', ')})`;
          } catch {
            /* fall through */
          }
          return `Raw error data: ${String(data).slice(0, 200)}`;
        }
        if (err.reason) return err.reason;
        return err.message || 'Call failed';
      }
    } catch (error) {
      return error instanceof Error ? error.message : 'Unknown error';
    }
  }

  /**
   * Ensure searcher can pull exactly `amount` of token (exact approve, not infinite).
   */
  private async ensureAllowance(token: string, amount: bigint): Promise<void> {
    const erc20 = new ethers.Contract(
      token,
      [
        'function allowance(address,address) view returns (uint256)',
        'function approve(address,uint256) returns (bool)',
      ],
      this.executorSigner
    );
    const ownerAddress = await this.executorSigner.getAddress();
    const currentAllowance: bigint = await erc20.allowance(
      ownerAddress,
      this.searcher.target as string
    );
    if (currentAllowance >= amount) return;

    // Reset to 0 first for non-standard ERC20s that require it, then set exact amount.
    if (currentAllowance > 0) {
      const resetTx = await erc20.approve(this.searcher.target as string, 0);
      await resetTx.wait(1);
    }
    logger.info(
      `Approving SniperSearcher (${this.searcher.target as string}) for exact ${amount.toString()} of ${token}...`
    );
    const approveTx = await erc20.approve(this.searcher.target as string, amount);
    await approveTx.wait(1);
    logger.info('✓ Exact approval confirmed');
  }

  /**
   * Execute swap with custom deadline
   */
  async executeSwapWithDeadline(
    params: SwapParams & { deadline: number }
  ): Promise<ExecutionResult> {
    try {
      console.log(
        `\n📊 Executing swap with deadline ${new Date(params.deadline * 1000).toISOString()}...`
      );

      await this.ensureAllowance(params.tokenIn, params.amountIn);

      const gasEstimate = await this.estimateSwapGasWithDeadline(params);
      console.log(`  Gas estimate: ${gasEstimate.toString()}`);

      const tx = await this.searcher.executeSwapWithDeadline(
        params.tokenIn,
        params.router,
        params.amountIn,
        params.path,
        params.minAmountOut,
        params.deadline,
        {
          gasLimit: (gasEstimate * 110n) / 100n,
        }
      );

      console.log(`✋ Transaction sent: ${tx.hash}`);

      const receipt = await tx.wait(3);

      if (!receipt) {
        return {
          success: false,
          error: 'Transaction failed',
        };
      }

      console.log(`✅ Confirmed in block ${receipt.blockNumber}`);
      return {
        success: true,
        txHash: tx.hash,
        gasUsed: receipt.gasUsed,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`❌ Swap failed: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Withdraw tokens from searcher contract
   */
  async withdraw(token: string, to: string, amount?: bigint): Promise<ExecutionResult> {
    try {
      console.log(`\n💸 Withdrawing from searcher...`);

      const withdrawAmount = amount || (await this.getBalance(token));
      console.log(`  Token: ${token}`);
      console.log(`  Amount: ${ethers.formatUnits(withdrawAmount, 18)}`);
      console.log(`  To: ${to}`);

      const tx = await this.searcher.withdraw(token, to, withdrawAmount);
      console.log(`✋ Transaction sent: ${tx.hash}`);

      const receipt = await tx.wait(3);

      if (!receipt) {
        return {
          success: false,
          error: 'Withdrawal failed',
        };
      }

      console.log(`✅ Withdrawn successfully`);
      return {
        success: true,
        txHash: tx.hash,
        gasUsed: receipt.gasUsed,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`❌ Withdrawal failed: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Withdraw multiple tokens at once
   */
  async withdrawAll(tokens: string[], to: string): Promise<ExecutionResult> {
    try {
      console.log(`\n💸 Withdrawing ${tokens.length} tokens...`);

      const tx = await this.searcher.withdrawAll(tokens, to);
      console.log(`✋ Transaction sent: ${tx.hash}`);

      const receipt = await tx.wait(3);

      if (!receipt) {
        return {
          success: false,
          error: 'Multi-withdrawal failed',
        };
      }

      console.log(`✅ All tokens withdrawn`);
      return {
        success: true,
        txHash: tx.hash,
        gasUsed: receipt.gasUsed,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`❌ Withdrawal failed: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Check balance of token in searcher
   */
  async getBalance(token: string): Promise<bigint> {
    try {
      const balance = await this.searcher.getBalance(token);
      return BigInt(balance);
    } catch (error) {
      console.error('Failed to get balance:', error);
      return BigInt(0);
    }
  }

  /**
   * Estimate gas for swap
   */
  private async estimateSwapGas(params: SwapParams): Promise<bigint> {
    try {
      const gasEstimate = await this.searcher.executeSwap.estimateGas(
        params.tokenIn,
        params.amountIn,
        params.path,
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
   * Estimate gas for swap with deadline
   */
  private async estimateSwapGasWithDeadline(
    params: SwapParams & { deadline: number }
  ): Promise<bigint> {
    try {
      const gasEstimate = await this.searcher.executeSwapWithDeadline.estimateGas(
        params.tokenIn,
        params.router,
        params.amountIn,
        params.path,
        params.minAmountOut,
        params.deadline
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
   * Get searcher address
   */
  getSearcherAddress(): string {
    return this.searcher.target as string;
  }
}

export default SniperExecutor;
