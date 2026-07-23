import { BigNumber, ethers } from 'ethers';
import { getTokens } from './tokens';
import { ExecutionBridge, ExecutionMode } from './bridge';
import { encodePath, validatePath, getOptimalFee } from './uniswap';
import { DEXAggregator } from './dexAggregator';
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
      preferredMode: ExecutionMode.FLASH_LOAN,
      dynamicFlashSize: true, // size is computed on-chain from Aave liquidity
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

      const AAVE_RESERVE_TOKENS = [
        '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // WETH
        '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', // USDT
        '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC
        '0x2f2a2543d76a4166549f7aaab2e75bef0aefc5b0', // WBTC
        '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', // DAI
      ];

      const walletAddress = await signer.getAddress();

      // Orient input token (prefer Aave V3 reserve assets for flash loan borrowing, or WETH/wallet balance)
      let tokenFromObj = Token0;
      let tokenToObj = Token1;

      if (AAVE_RESERVE_TOKENS.includes(Token1.token.address.toLowerCase())) {
        tokenFromObj = Token1;
        tokenToObj = Token0;
      } else if (AAVE_RESERVE_TOKENS.includes(Token0.token.address.toLowerCase())) {
        tokenFromObj = Token0;
        tokenToObj = Token1;
      } else {
        const bal0 = await Token0.contract.balanceOf(walletAddress);
        const bal1 = await Token1.contract.balanceOf(walletAddress);
        if (bal0.isZero() && bal1.gt(0)) {
          tokenFromObj = Token1;
          tokenToObj = Token0;
        }
      }

      const tokenFrom = tokenFromObj.token;
      const tokenTo = tokenToObj.token;

      logger.info(
        `Target Snipe Direction: ${tokenFrom.symbol} (${tokenFrom.address}) → ${tokenTo.symbol} (${tokenTo.address})`
      );

      // Validate wallet balances
      const walletBalance = await provider.getBalance(walletAddress);
      logger.info(`Wallet ETH balance: ${ethers.utils.formatEther(walletBalance)} ETH`);

      const tokenBalance = await tokenFromObj.contract.balanceOf(walletAddress);
      logger.info(
        `Input token balance: ${ethers.utils.formatUnits(tokenBalance, tokenFrom.decimals)} ${tokenFrom.symbol}`
      );

      // Flash loans require zero upfront capital — no balance check needed.
      // FlashSizer will verify the loan is viable against Aave liquidity before
      // any on-chain transaction is submitted.
      logger.info('Flash-loan mode: skipping wallet token balance check (no capital required)');

      // Multi-DEX Path Finding — query with a 1-token sentinel to discover the
      // best fee tier. FlashSizer will re-quote at the dynamically computed size.
      logger.info('Discovering best DEX route and fee tier...');
      const dexAggregator = new DEXAggregator(provider);
      const probeAmount = ethers.utils.parseUnits('1', tokenFrom.decimals);
      const bestRoute = await dexAggregator.findBestRoute(
        tokenFrom.address,
        tokenTo.address,
        probeAmount
      );

      const feeTier = bestRoute
        ? bestRoute.feeTier
        : getOptimalFee(tokenFrom.address, tokenTo.address);
      validateFeeTier(feeTier);

      logger.info(`Fee tier selected: ${feeTier} (${(feeTier / 10000) * 100}%)`);

      // Encode swap path
      const path = encodePath([tokenFrom.address, tokenTo.address], [feeTier]);

      if (!validatePath([tokenFrom.address, tokenTo.address], [feeTier])) {
        throw new Error('Invalid swap path');
      }

      // In dynamic flash-loan mode, amountIn and minAmountOut are sentinels —
      // FlashSizer inside the bridge will compute the actual optimal loan size
      // from live Aave liquidity and a fresh DEX quote at that exact amount.
      const sentinelAmount = probeAmount;

      // Execute via bridge (dynamic sizing happens inside bridge.executeFlashLoan)
      logger.info('Executing flash loan via execution bridge (dynamic sizing)...');
      const result = await this.executeWithRetry({
        tokenIn: tokenFrom.address,
        tokenOut: tokenTo.address,
        amountIn: sentinelAmount, // overridden by FlashSizer inside the bridge
        path,
        minAmountOut: BigNumber.from(0), // overridden by FlashSizer inside the bridge
        deadline: DEADLINE,
        estimatedProfit: BigNumber.from(0),
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
    const config: Config = {
      sniperSearcherAddress: SNIPER_SEARCHER_ADDRESS,
      flashLoanReceiverAddress: FLASH_LOAN_RECEIVER_ADDRESS,
      delegatedExecutorAddress: DELEGATED_EXECUTOR_ADDRESS,
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
