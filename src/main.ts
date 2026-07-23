import { ethers } from 'ethers';
import { ExecutionBridge, ExecutionMode } from './bridge';
import { encodePath, validatePath, getOptimalFee } from './uniswap';
import { DEXAggregator, EXECUTION_VENUE_PROTOCOLS } from './dexAggregator';
import {
  provider,
  signer,
  getDeadline,
  SNIPER_SEARCHER_ADDRESS,
  FLASH_LOAN_RECEIVER_ADDRESS,
  DELEGATED_EXECUTOR_ADDRESS,
  BATCH_EXECUTOR_ADDRESS,
  SWAP_ROUTER_ADDRESS,
} from './config';
import { Contract } from 'ethers';
import { Logger } from './logger';
import { validateAndChecksumAddress, validateFeeTier } from './validation';
import { bitquery } from './bitquery';
import {
  assertRouterAllowed,
  isFlashBaseToken,
  isRouterAllowed,
  isSnipePairAllowed,
  logAllowlistSummary,
  AAVE_FLASH_BASE_TOKENS,
} from './allowlist';
import { getBestSnipeTokens } from './snipeTokenSet';

interface OpportunityParams {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  path: Buffer;
  minAmountOut: bigint;
  deadline: number;
  estimatedProfit: bigint;
  poolAddress?: string;
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
      assertRouterAllowed(SWAP_ROUTER_ADDRESS);
      logAllowlistSummary();

      // Bitquery: rank hot pairs + new pools against allowlist + Aave flash bases
      logger.info('Discovering best sniping token set (Bitquery + allowlist)...');
      const discovered = await getBestSnipeTokens();
      const { Token0, Token1, set: tokenSet } = discovered;
      const detectedPool = discovered.pool;

      if (!Token0 || !Token1) {
        throw new Error(
          'Failed to detect allowlisted snipe tokens (check BITQUERY_TOKEN / ALLOWED_TOKENS)'
        );
      }
      if (!isSnipePairAllowed(Token0.token.address, Token1.token.address)) {
        throw new Error(
          `Pair not allowlisted: ${Token0.token.address} / ${Token1.token.address}`
        );
      }
      if (tokenSet.candidates.length) {
        logger.info(`Top snipe candidates (${tokenSet.candidates.length}):`);
        for (const c of tokenSet.candidates.slice(0, 5)) {
          logger.info(
            `  #${c.rank} score=${c.score.toFixed(1)} ${c.baseSymbol ?? c.baseToken.slice(0, 8)}→${
              c.targetSymbol ?? c.targetToken.slice(0, 8)
            } [${c.source}] trades=${c.tradeCount ?? 0}`
          );
        }
      }
      if (detectedPool) {
        logger.info(`Pool address from Bitquery: ${detectedPool}`);
      }
      if (discovered.fee !== undefined) {
        logger.info(`Pool fee tier from event: ${discovered.fee}`);
      }

      const walletAddress = await signer.getAddress();

      // Orient: flash borrow base (Aave) → target listing
      let tokenFromObj = Token0;
      let tokenToObj = Token1;

      if (isFlashBaseToken(Token1.token.address) && !isFlashBaseToken(Token0.token.address)) {
        tokenFromObj = Token1;
        tokenToObj = Token0;
      } else if (isFlashBaseToken(Token0.token.address)) {
        tokenFromObj = Token0;
        tokenToObj = Token1;
      } else if (
        AAVE_FLASH_BASE_TOKENS.map((t) => t.toLowerCase()).includes(
          Token1.token.address.toLowerCase()
        )
      ) {
        tokenFromObj = Token1;
        tokenToObj = Token0;
      } else {
        const bal0 = await Token0.contract.balanceOf(walletAddress);
        const bal1 = await Token1.contract.balanceOf(walletAddress);
        if (bal0 === 0n && bal1 > 0n) {
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
      logger.info(`Wallet ETH balance: ${ethers.formatEther(walletBalance)} ETH`);

      const tokenBalance = await tokenFromObj.contract.balanceOf(walletAddress);
      logger.info(
        `Input token balance: ${ethers.formatUnits(tokenBalance, tokenFrom.decimals)} ${tokenFrom.symbol}`
      );

      // Flash loans require zero upfront capital — no balance check needed.
      // FlashSizer will verify the loan is viable against Aave liquidity before
      // any on-chain transaction is submitted.
      logger.info('Flash-loan mode: skipping wallet token balance check (no capital required)');

      // Multi-DEX Path Finding — query with a 1-token sentinel to discover the
      // best fee tier. FlashSizer will re-quote at the dynamically computed size.
      logger.info('Discovering best Uniswap V3 fee tier (allowlisted router only)...');
      // Only Uniswap V3 — SniperSearcher is hard-wired to SwapRouter02
      const dexAggregator = new DEXAggregator(provider, EXECUTION_VENUE_PROTOCOLS);
      const probeAmount = ethers.parseUnits('1', tokenFrom.decimals);
      const bestRoute = await dexAggregator.findBestRoute(
        tokenFrom.address,
        tokenTo.address,
        probeAmount
      );
      if (bestRoute && !isRouterAllowed(bestRoute.protocol.routerAddress)) {
        throw new Error(`Route router not allowlisted: ${bestRoute.protocol.routerAddress}`);
      }

      const feeTier = bestRoute
        ? bestRoute.feeTier
        : getOptimalFee(tokenFrom.address, tokenTo.address);
      validateFeeTier(feeTier);

      logger.info(`Fee tier selected: ${feeTier} (${(feeTier / 10000) * 100}%)`);

      // FlashLoanSimple requires repay in the SAME asset. Path must round-trip:
      //   tokenFrom → tokenTo → tokenFrom  (2 hops, same fee tier for simplicity)
      const path = encodePath(
        [tokenFrom.address, tokenTo.address, tokenFrom.address],
        [feeTier, feeTier]
      );

      if (
        !validatePath(
          [tokenFrom.address, tokenTo.address, tokenFrom.address],
          [feeTier, feeTier]
        )
      ) {
        throw new Error('Invalid round-trip swap path');
      }
      logger.info(
        `Round-trip path for flash repay: ${tokenFrom.symbol} → ${tokenTo.symbol} → ${tokenFrom.symbol}`
      );

      // In dynamic flash-loan mode, amountIn and minAmountOut are sentinels —
      // FlashSizer inside the bridge will compute the actual optimal loan size
      // from live Aave liquidity and a fresh DEX quote at that exact amount.
      const sentinelAmount = probeAmount;

      // Optional: short-lived DEX-trade watcher for the output token (confirmation / MEV noise)
      let tradeWatch: { unsubscribe: () => void } | undefined;
      if (bitquery.configured) {
        tradeWatch = bitquery.subscribeDexTrades(
          (t) => {
            logger.info(
              `DEX trade ${t.protocol || '?'}: sell ${t.sellAmount || '?'} ` +
                `${t.sellToken || '?'} -> buy ${t.buyAmount || '?'} ${t.buyToken || '?'}` +
                (t.txHash ? ` tx=${t.txHash.slice(0, 10)}...` : '')
            );
          },
          {
            token: tokenTo.address,
            onError: (e) => logger.warn(`DEX trade stream: ${e.message}`),
          }
        );
      }

      // Execute via bridge (dynamic sizing happens inside bridge.executeFlashLoan)
      logger.info('Executing flash loan via execution bridge (dynamic sizing)...');
      try {
        const result = await this.executeWithRetry({
          tokenIn: tokenFrom.address,
          tokenOut: tokenTo.address,
          amountIn: sentinelAmount, // overridden by FlashSizer inside the bridge
          path,
          minAmountOut: 0n, // overridden by FlashSizer inside the bridge
          deadline: getDeadline(2), // ~120s for snipes (matches on-chain default)
          estimatedProfit: 0n,
          poolAddress: detectedPool,
        });

      if (!result.success) {
          throw new Error(`Execution failed: ${result.error}`);
        }

        logger.info(`✓ Swap successful!`);
        logger.info(`  Mode: ${result.mode}`);
        logger.info(`  Tx: ${result.txHash}`);
        logger.info(`  Gas: ${result.gasUsed?.toString()}`);
        logger.info(`  Profit: ${ethers.formatUnits(result.profit || 0, 18)}`);
      } finally {
        tradeWatch?.unsubscribe();
      }
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
   * Verify bot setup - validates all contract addresses, wiring, and ownership.
   */
  private async verifySetup(): Promise<void> {
    logger.info('Verifying setup...');

    const blockNumber = await provider.getBlockNumber();
    logger.info(`✓ RPC connected (block ${blockNumber})`);

    const walletAddress = validateAndChecksumAddress(await signer.getAddress());
    logger.info(`✓ Wallet: ${walletAddress}`);

    const requireCode = async (label: string, addr: string) => {
      const code = await provider.getCode(addr);
      if (code === '0x') throw new Error(`${label} not deployed at ${addr}`);
      logger.info(`✓ ${label}: ${addr}`);
    };

    await requireCode('SniperSearcher', SNIPER_SEARCHER_ADDRESS);
    await requireCode('FlashLoanReceiver', FLASH_LOAN_RECEIVER_ADDRESS);
    await requireCode('DelegatedExecutor', DELEGATED_EXECUTOR_ADDRESS);
    if (BATCH_EXECUTOR_ADDRESS) {
      await requireCode('BatchExecutor/BEBE', BATCH_EXECUTOR_ADDRESS);
    }

    // Production wiring asserts (must match Deploy + Verify scripts).
    const sniper = new Contract(
      SNIPER_SEARCHER_ADDRESS,
      [
        'function owner() view returns (address)',
        'function swapRouter() view returns (address)',
        'function allowedExecutors(address) view returns (bool)',
        'function minAmountBitLength() view returns (uint256)',
      ],
      provider
    );
    const flash = new Contract(
      FLASH_LOAN_RECEIVER_ADDRESS,
      [
        'function owner() view returns (address)',
        'function swapExecutor() view returns (address)',
        'function lendingPool() view returns (address)',
      ],
      provider
    );

    const [sOwner, sRouter, flashAllowed, minBits, fOwner, fExec, fPool] =
      await Promise.all([
        sniper.owner() as Promise<string>,
        sniper.swapRouter() as Promise<string>,
        sniper.allowedExecutors(FLASH_LOAN_RECEIVER_ADDRESS) as Promise<boolean>,
        sniper.minAmountBitLength() as Promise<bigint>,
        flash.owner() as Promise<string>,
        flash.swapExecutor() as Promise<string>,
        flash.lendingPool() as Promise<string>,
      ]);

    if (sRouter.toLowerCase() !== SWAP_ROUTER_ADDRESS.toLowerCase()) {
      throw new Error(
        `SniperSearcher.swapRouter (${sRouter}) != SWAP_ROUTER_ADDRESS (${SWAP_ROUTER_ADDRESS})`
      );
    }
    if (!flashAllowed) {
      throw new Error(
        'SniperSearcher.allowedExecutors(FlashLoanReceiver) is false — run allowExecutor'
      );
    }
    if (fExec.toLowerCase() !== SNIPER_SEARCHER_ADDRESS.toLowerCase()) {
      throw new Error(
        `FlashLoanReceiver.swapExecutor (${fExec}) != SniperSearcher (${SNIPER_SEARCHER_ADDRESS})`
      );
    }
    if (fOwner.toLowerCase() !== walletAddress.toLowerCase()) {
      throw new Error(
        `FlashLoanReceiver.owner (${fOwner}) != bot wallet (${walletAddress}) — cannot initiateFlashLoan`
      );
    }
    if (sOwner.toLowerCase() !== walletAddress.toLowerCase()) {
      logger.warn(
        `SniperSearcher.owner (${sOwner}) != wallet (${walletAddress}) — direct mode needs owner or allowlist`
      );
    }
    if (minBits > 0n) {
      logger.warn(
        `SniperSearcher.minAmountBitLength=${minBits} — 6-decimal assets may revert AmountTooSmall; prefer 0`
      );
    }
    logger.info(`✓ Flash owner matches wallet; allowExecutor wired; pool=${fPool}`);
    logger.info(`✓ SwapRouter: ${sRouter}`);

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
