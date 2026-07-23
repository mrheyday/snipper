import { BigNumber, ethers, Signer, providers } from 'ethers';
import { signer, provider } from './config';
import { SNIPER_SEARCHER_ABI } from './abis';
import { Logger } from './logger';

const logger = new Logger('SniperExecutor');

interface SwapParams {
  tokenIn: string;
  amountIn: BigNumber;
  path: Buffer;
  minAmountOut: BigNumber;
  deadline?: number;
}

interface ExecutionResult {
  success: boolean;
  txHash?: string;
  amountOut?: BigNumber;
  error?: string;
  gasUsed?: BigNumber;
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
      logger.info(`Input: ${ethers.utils.formatUnits(params.amountIn, 18)}`);
      logger.info(`Min output: ${ethers.utils.formatUnits(params.minAmountOut, 18)}`);

      // Check & ensure token allowance for searcher contract
      const erc20 = new ethers.Contract(
        params.tokenIn,
        [
          'function allowance(address,address) view returns (uint256)',
          'function approve(address,uint256) returns (bool)',
        ],
        this.executorSigner
      );
      const ownerAddress = await this.executorSigner.getAddress();
      const currentAllowance: BigNumber = await erc20.allowance(
        ownerAddress,
        this.searcher.address
      );
      if (currentAllowance.lt(params.amountIn)) {
        logger.info(`Approving SniperSearcher (${this.searcher.address}) for ${params.tokenIn}...`);
        const approveTx = await erc20.approve(this.searcher.address, ethers.constants.MaxUint256);
        await approveTx.wait(1);
        logger.info('✓ Approval confirmed');
      }

      // Estimate gas
      const gasEstimate = await this.estimateSwapGas(params);
      logger.info(`Gas estimate: ${gasEstimate.toString()}`);

      // Execute swap
      const tx = await this.searcher.executeSwap(
        params.tokenIn,
        params.amountIn,
        params.path,
        params.minAmountOut,
        {
          gasLimit: gasEstimate.mul(110).div(100), // 10% buffer
          maxFeePerGas: await provider.getGasPrice().then((p) => p.mul(120).div(100)), // 20% above current
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

      const gasEstimate = await this.estimateSwapGasWithDeadline(params);
      console.log(`  Gas estimate: ${gasEstimate.toString()}`);

      const tx = await this.searcher.executeSwapWithDeadline(
        params.tokenIn,
        params.amountIn,
        params.path,
        params.minAmountOut,
        params.deadline,
        {
          gasLimit: gasEstimate.mul(110).div(100),
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
  async withdraw(token: string, to: string, amount?: BigNumber): Promise<ExecutionResult> {
    try {
      console.log(`\n💸 Withdrawing from searcher...`);

      const withdrawAmount = amount || (await this.getBalance(token));
      console.log(`  Token: ${token}`);
      console.log(`  Amount: ${ethers.utils.formatUnits(withdrawAmount, 18)}`);
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
  async getBalance(token: string): Promise<BigNumber> {
    try {
      const balance = await this.searcher.getBalance(token);
      return BigNumber.from(balance);
    } catch (error) {
      console.error('Failed to get balance:', error);
      return BigNumber.from(0);
    }
  }

  /**
   * Estimate gas for swap
   */
  private async estimateSwapGas(params: SwapParams): Promise<BigNumber> {
    try {
      const gasEstimate = await this.searcher.estimateGas.executeSwap(
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
  ): Promise<BigNumber> {
    try {
      const gasEstimate = await this.searcher.estimateGas.executeSwapWithDeadline(
        params.tokenIn,
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
    return this.searcher.address;
  }
}

export default SniperExecutor;
