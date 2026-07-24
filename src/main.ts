import { ethers } from 'ethers';
import { ExecutionBridge, ExecutionMode } from './bridge';
import { encodePath, validatePath } from './uniswap';
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
  isRouterAllowed,
  isSnipePairAllowed,
  logAllowlistSummary,
} from './allowlist';
import { getBestSnipeTokens } from './snipeTokenSet';

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
  private isRunning = true;
  private loopIntervalMs: number;

  constructor(config: Config) {
    this.config = config;
    this.loopIntervalMs = parseInt(process.env.LOOP_INTERVAL_MS || '3000', 10);
    this.bridge = new ExecutionBridge({
      sniperSearcherAddress: config.sniperSearcherAddress,
      flashLoanReceiverAddress: config.flashLoanReceiverAddress,
      delegatedExecutorAddress: config.delegatedExecutorAddress,
      preferredMode: ExecutionMode.FLASH_LOAN,
      dynamicFlashSize: true, // size is computed on-chain from Aave liquidity
    });
  }

  /**
   * Stop continuous loop gracefully
   */
  stop(): void {
    this.isRunning = false;
  }

  /**
   * Continuous loop execution
   */
  async runLoop(): Promise<void> {
    logger.info('🚀 Starting Arbitrum Sniper Bot in continuous loop mode...');

    // Verify setup once before entering main execution loop
    await this.verifySetup();
    assertRouterAllowed(SWAP_ROUTER_ADDRESS);
    logAllowlistSummary();

    let iteration = 0;
    while (this.isRunning) {
      iteration++;
      logger.info(`\n=================== LOOP ITERATION #${iteration} ===================`);
      try {
        await this.runSingleIteration();
      } catch (error) {
        logger.warn(
          `Iteration #${iteration} outcome: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      if (this.isRunning) {
        logger.info(`Sleeping ${this.loopIntervalMs}ms before next iteration...`);
        await new Promise((resolve) => setTimeout(resolve, this.loopIntervalMs));
      }
    }
    logger.info('Bot loop stopped cleanly.');
  }

  /**
   * Single iteration scan & trade execution
   */
  private async runSingleIteration(): Promise<void> {
    // Bitquery: rank hot pairs + new pools against allowlist + Aave flash bases
    logger.info('Discovering best sniping token set (Bitquery + allowlist)...');
    const discovered = await getBestSnipeTokens();
    const { set: tokenSet } = discovered;

    if (tokenSet.candidates.length) {
      logger.info(`Top snipe candidates (${tokenSet.candidates.length}):`);
      for (const c of tokenSet.candidates.slice(0, 5)) {
        logger.info(
          `  #${c.rank} score=${c.score.toFixed(1)} ${
            c.baseSymbol ?? c.baseToken.slice(0, 8)
          }→${c.targetSymbol ?? c.targetToken.slice(0, 8)} [${c.source}] trades=${
            c.tradeCount ?? 0
          }`
        );
      }
    }

    if (!tokenSet.candidates.length) {
      throw new Error(
        'No sniping candidates found (check BITQUERY_TOKEN / ALLOWED_TOKENS)'
      );
    }

    // Walk candidates in ranked order — skip to next if no arb found for this pair.
    for (const candidate of tokenSet.candidates) {
      if (!isSnipePairAllowed(candidate.baseToken, candidate.targetToken)) continue;

      const result = await this.tryCandidatePair(candidate);
      if (result === 'no_arb') {
        logger.info(
          `  Skipping ${candidate.baseToken.slice(0, 8)}→${candidate.targetToken.slice(0, 8)}: no profitable arb at current prices`
        );
        continue;
      }
      if (result === 'success') return;
      // 'error' = transient failure — stop and surface the error for retry next iteration
      throw new Error(
        `Execution error on ${candidate.baseToken.slice(0, 8)}→${candidate.targetToken.slice(0, 8)}`
      );
    }

    throw new Error('All candidates exhausted — no profitable arb found this iteration');
  }

  /**
   * Attempt a flash-loan arb for one candidate pair.
   * Returns:
   *  'success'  — trade executed
   *  'no_arb'   — FlashSizer found no profitable size (skip to next candidate)
   *  'error'    — transient RPC/tx error (surface to caller)
   */
  private async tryCandidatePair(
    candidate: import('./snipeTokenSet').SnipeCandidate
  ): Promise<'success' | 'no_arb' | 'error'> {
    const { buildERC20TokenWithContract } = await import('./tokens');
    const baseObj = await buildERC20TokenWithContract(candidate.baseToken, provider);
    const targetObj = await buildERC20TokenWithContract(candidate.targetToken, provider);
    if (!baseObj || !targetObj) return 'no_arb';

    const tokenFrom = baseObj.token;
    const tokenTo = targetObj.token;
    logger.info(
      `Trying: ${tokenFrom.symbol} (${tokenFrom.address}) → ${tokenTo.symbol} (${tokenTo.address})`
    );

    // Discover best Uniswap V3 fee tier (execution venue only)
    const dexAggregator = new DEXAggregator(provider, EXECUTION_VENUE_PROTOCOLS);
    const probeAmount = ethers.parseUnits('1', tokenFrom.decimals);
    const bestRoute = await dexAggregator.findBestRoute(
      tokenFrom.address,
      tokenTo.address,
      probeAmount
    );
    if (!bestRoute) {
      logger.info(`  No Uniswap V3 route for this pair — skipping`);
      return 'no_arb';
    }
    if (!isRouterAllowed(bestRoute.protocol.routerAddress)) {
      logger.warn(`  Router not allowlisted: ${bestRoute.protocol.routerAddress}`);
      return 'no_arb';
    }

    const feeTier = bestRoute.feeTier;
    validateFeeTier(feeTier);
    logger.info(`  Fee tier: ${feeTier} (${(feeTier / 10000) * 100}%)`);

    const path = encodePath(
      [tokenFrom.address, tokenTo.address, tokenFrom.address],
      [feeTier, feeTier]
    );
    if (!validatePath([tokenFrom.address, tokenTo.address, tokenFrom.address], [feeTier, feeTier])) {
      return 'no_arb';
    }

    const walletAddress = await signer.getAddress();
    const walletBalance = await provider.getBalance(walletAddress);
    logger.info(`  Wallet ETH: ${ethers.formatEther(walletBalance)}`);

    // Subscribe to live DEX trades for this target while executing
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
        { token: tokenTo.address, onError: (e) => logger.warn(`DEX trade stream: ${e.message}`) }
      );
    }

    try {
      logger.info('  Executing flash loan via bridge (dynamic sizing)...');
      const result = await this.bridge.executeOptimal({
        tokenIn: tokenFrom.address,
        tokenOut: tokenTo.address,
        amountIn: probeAmount,
        path,
        minAmountOut: 0n,
        deadline: getDeadline(2),
        estimatedProfit: 0n,
        poolAddress: candidate.pool,
      });

      if (!result.success) {
        // FlashSizer returns a specific message for the no-arb case
        if (
          result.error?.includes('no profitable loan size') ||
          result.error?.includes('No round-trip DEX quote')
        ) {
          return 'no_arb';
        }
        logger.warn(`  Execution failed: ${result.error}`);
        return 'error';
      }

      logger.info(`✓ Swap successful!`);
      logger.info(`  Mode: ${result.mode}`);
      logger.info(`  Tx: ${result.txHash}`);
      logger.info(`  Gas: ${result.gasUsed?.toString()}`);
      logger.info(`  Profit: ${ethers.formatUnits(result.profit || 0n, tokenFrom.decimals)} ${tokenFrom.symbol}`);
      return 'success';
    } catch (e) {
      logger.warn(`  tryCandidatePair error: ${e instanceof Error ? e.message : String(e)}`);
      return 'error';
    } finally {
      tradeWatch?.unsubscribe();
    }
  }

  /**
   * Execute with retry logic
   */
  private async executeWithRetry(opportunity: Parameters<ExecutionBridge['executeOptimal']>[0]) {
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
        'function allowedRouters(address) view returns (bool)',
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

    const [sOwner, flashAllowed, minBits, fOwner, fExec, fPool] = await Promise.all([
      sniper.owner() as Promise<string>,
      sniper.allowedExecutors(FLASH_LOAN_RECEIVER_ADDRESS) as Promise<boolean>,
      sniper.minAmountBitLength() as Promise<bigint>,
      flash.owner() as Promise<string>,
      flash.swapExecutor() as Promise<string>,
      flash.lendingPool() as Promise<string>,
    ]);

    // Every execution venue's router must be allowlisted on-chain (mirrors Verify.s.sol).
    // Replaces the old single immutable `swapRouter()` getter, removed when SniperSearcher
    // moved to a per-router allowlist — reading it now would revert and abort boot.
    for (const p of EXECUTION_VENUE_PROTOCOLS) {
      const routerAllowed = (await sniper.allowedRouters(p.routerAddress)) as boolean;
      if (!routerAllowed) {
        throw new Error(
          `SniperSearcher.allowedRouters(${p.name} ${p.routerAddress}) is false — run Configure/allowRouter`
        );
      }
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
    logger.info(
      `✓ Allowlisted routers (${EXECUTION_VENUE_PROTOCOLS.length}): ` +
        EXECUTION_VENUE_PROTOCOLS.map((p) => p.name).join(', ')
    );

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
  const config: Config = {
    sniperSearcherAddress: SNIPER_SEARCHER_ADDRESS,
    flashLoanReceiverAddress: FLASH_LOAN_RECEIVER_ADDRESS,
    delegatedExecutorAddress: DELEGATED_EXECUTOR_ADDRESS,
    maxRetries: 3,
    retryDelayMs: 2000,
  };

  const bot = new SniperBot(config);

  process.on('SIGINT', () => {
    logger.info('Received SIGINT — stopping bot...');
    bot.stop();
  });
  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM — stopping bot...');
    bot.stop();
  });

  await bot.runLoop();
}

main().catch((error) => {
  logger.error(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
