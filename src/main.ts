import { BigNumber, ethers } from 'ethers';
import { getTokens } from './tokens';
import { ExecutionBridge } from './bridge';
import { encodePath, calculateMinimumOutput, validatePath, getOptimalFee } from './uniswap';
import {
  provider,
  signer,
  DEADLINE,
  SNIPER_SEARCHER_ADDRESS,
  FLASH_LOAN_RECEIVER_ADDRESS,
  DELEGATED_EXECUTOR_ADDRESS,
} from './config';
import { Logger } from './logger';
import { validateAndChecksumAddress, validateFeeTier } from './validation';

interface OpportunityParams {
  tokenIn: string;
  tokenOut: string;
  amountIn: BigNumber;
  path: Buffer;
  minAmountOut: BigNumber;
  deadline: number;
  estimatedProfit: BigNumber;
}

const logger = new Logger('SniperBot');

interface Config {
  sniperSearcherAddress: string;
  flashLoanReceiverAddress: string;
  delegatedExecutorAddress: string;
  swapAmount: BigNumber;
  maxRetries: number;
  retryDelayMs: number;
}

class SniperBot {
  private bridge: ExecutionBridge;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    this.bridge = new ExecutionBridge({
      sniperSearcherAddress: config.sniperSearcherAddress,
      flashLoanReceiverAddress: config.flashLoanReceiverAddress,
      delegatedExecutorAddress: config.delegatedExecutorAddress,
    });
  }

  /**
   * Main execution loop
   */
  async run(): Promise<void> {
    logger.info('Starting Arbitrum Sniper Bot');

    try {
      // Verify setup
      await this.verifySetup();

      // Detect pool
      logger.info('Detecting latest Uniswap V3 pool...');
      const { Token0, Token1 } = await getTokens();

      if (!Token0 || !Token1) {
        throw new Error('Failed to detect tokens from pool');
      }

      const tokenFrom = Token0.token;
      const tokenTo = Token1.token;
      const walletAddress = await signer.getAddress();

      logger.info(`Pool detected: ${tokenFrom.symbol} → ${tokenTo.symbol}`);

      // Validate wallet has sufficient balance
      const walletBalance = await provider.getBalance(walletAddress);
      logger.info(`Wallet balance: ${ethers.utils.formatEther(walletBalance)} ETH`);

      const tokenBalance = await Token0.contract.balanceOf(walletAddress);
      logger.info(
        `Token balance: ${ethers.utils.formatUnits(tokenBalance, tokenFrom.decimals)} ${tokenFrom.symbol}`
      );

      // Calculate quote
      logger.info('Calculating optimal swap route...');

      // Quote from router (simplified: use 1:1 ratio for demo)
      // In production, call Uniswap Quoter V3 for accurate pricing
      const quotedAmount = this.config.swapAmount.mul(95).div(100); // 95% of input (5% impact)
      const estimatedOutputRaw = quotedAmount;

      // Calculate minimum output with slippage protection (50 bps = 0.5%)
      const minOutput = calculateMinimumOutput(estimatedOutputRaw, 0.5);

      // Profit calculation: output minus input (proper comparison)
      // Note: This assumes 1:1 decimal ratio for demo; production should normalize decimals
      const estimatedProfit = estimatedOutputRaw.gt(this.config.swapAmount)
        ? estimatedOutputRaw.sub(this.config.swapAmount)
        : BigNumber.from(0);

      logger.info(
        `Route calculated: ${ethers.utils.formatUnits(estimatedOutputRaw, tokenTo.decimals)} ${tokenTo.symbol}`
      );
      logger.info(
        `Estimated profit: ${ethers.utils.formatUnits(estimatedProfit, tokenTo.decimals)} ${tokenTo.symbol}`
      );

      // Determine optimal fee tier based on token pair
      const feeTier = getOptimalFee(tokenFrom.address, tokenTo.address);
      validateFeeTier(feeTier);

      // Encode swap path
      const path = encodePath([tokenFrom.address, tokenTo.address], [feeTier]);

      if (!validatePath([tokenFrom.address, tokenTo.address], [feeTier])) {
        throw new Error('Invalid swap path');
      }

      logger.info(`Fee tier selected: ${feeTier} (${(feeTier / 10000) * 100}%)`);

      // Execute via bridge
      logger.info('Executing swap via execution bridge...');
      const result = await this.executeWithRetry({
        tokenIn: tokenFrom.address,
        tokenOut: tokenTo.address,
        amountIn: this.config.swapAmount,
        path,
        minAmountOut: minOutput,
        deadline: DEADLINE,
        estimatedProfit,
      });

      if (!result.success) {
        throw new Error(`Execution failed: ${result.error}`);
      }

      logger.info(`✓ Swap successful!`);
      logger.info(`  Mode: ${result.mode}`);
      logger.info(`  Tx: ${result.txHash}`);
      logger.info(`  Gas: ${result.gasUsed?.toString()}`);
      logger.info(`  Profit: ${ethers.utils.formatUnits(result.profit || 0, 18)}`);
    } catch (error) {
      logger.error(`Bot failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }

  /**
   * Execute with retry logic
   */
  private async executeWithRetry(opportunity: OpportunityParams) {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        logger.info(`Execution attempt ${attempt}/${this.config.maxRetries}`);
        const result = await this.bridge.executeOptimal(opportunity);

        if (result.success) {
          return result;
        }

        lastError = new Error(result.error);
        logger.warn(`Attempt ${attempt} failed: ${result.error}`);

        if (attempt < this.config.maxRetries) {
          logger.info(`Retrying in ${this.config.retryDelayMs}ms...`);
          await new Promise((resolve) => setTimeout(resolve, this.config.retryDelayMs));
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.error(`Attempt ${attempt} error: ${lastError.message}`);

        if (attempt < this.config.maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, this.config.retryDelayMs));
        }
      }
    }

    throw lastError || new Error('Execution failed after all retries');
  }

  /**
   * Verify bot setup - validates all contract addresses and RPC connection
   */
  private async verifySetup(): Promise<void> {
    logger.info('Verifying setup...');

    // Check RPC connection
    const blockNumber = await provider.getBlockNumber();
    logger.info(`✓ RPC connected (block ${blockNumber})`);

    // Check wallet
    const walletAddress = validateAndChecksumAddress(await signer.getAddress());
    logger.info(`✓ Wallet: ${walletAddress}`);

    // Validate contract addresses are deployed
    try {
      const sniperCode = await provider.getCode(SNIPER_SEARCHER_ADDRESS);
      if (sniperCode === '0x') {
        throw new Error(`SniperSearcher not deployed at ${SNIPER_SEARCHER_ADDRESS}`);
      }
      logger.info(`✓ SniperSearcher: ${SNIPER_SEARCHER_ADDRESS}`);

      const flashCode = await provider.getCode(FLASH_LOAN_RECEIVER_ADDRESS);
      if (flashCode === '0x') {
        throw new Error(`FlashLoanReceiver not deployed at ${FLASH_LOAN_RECEIVER_ADDRESS}`);
      }
      logger.info(`✓ FlashLoanReceiver: ${FLASH_LOAN_RECEIVER_ADDRESS}`);

      const delegatedCode = await provider.getCode(DELEGATED_EXECUTOR_ADDRESS);
      if (delegatedCode === '0x') {
        throw new Error(`DelegatedExecutor not deployed at ${DELEGATED_EXECUTOR_ADDRESS}`);
      }
      logger.info(`✓ DelegatedExecutor: ${DELEGATED_EXECUTOR_ADDRESS}`);
    } catch (error) {
      const err = new Error(
        `Contract validation failed: ${error instanceof Error ? error.message : String(error)}`
      ) as Error & { cause: unknown };
      err.cause = error;
      throw err;
    }

    // Check execution contracts status
    const stats = await this.bridge.getExecutionStats();
    logger.info(`✓ Direct mode: ${stats.directReady ? 'ready' : 'not ready'}`);
    logger.info(`✓ Flash loan: ${stats.flashLoanReady ? 'ready' : 'not ready'}`);
    logger.info(`✓ EIP-7702: ${stats.eip7702Ready ? 'ready' : 'not ready'}`);
  }
}

/**
 * Main entry point
 */
async function main() {
  try {
    // Contract addresses are validated in config.ts - use checksummed versions
    const swapAmount = process.argv[2]
      ? ethers.utils.parseUnits(process.argv[2], 18)
      : ethers.utils.parseUnits('0.001', 18);

    const config: Config = {
      sniperSearcherAddress: SNIPER_SEARCHER_ADDRESS,
      flashLoanReceiverAddress: FLASH_LOAN_RECEIVER_ADDRESS,
      delegatedExecutorAddress: DELEGATED_EXECUTOR_ADDRESS,
      swapAmount,
      maxRetries: 3,
      retryDelayMs: 2000,
    };

    const bot = new SniperBot(config);
    await bot.run();
  } catch (error) {
    logger.error(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
