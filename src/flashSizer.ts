import { ethers } from 'ethers';
import { provider } from './config';
import { DEXAggregator, ARBITRUM_DEX_PROTOCOLS } from './dexAggregator';
import { Logger } from './logger';
import { getAvailableLiquidity, getReserveEligibility } from './aaveReserves';
import { bitquery } from './bitquery';

const logger = new Logger('FlashSizer');

// Aave V3 Arbitrum addresses (same as flashExecutor.ts)
const UI_POOL_DATA_PROVIDER_ADDRESS = '0x91E04cf78e53aEBe609e8a7f2003e7EECD743F2B';
const POOL_ADDRESSES_PROVIDER_ADDRESS = '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb';
const ARBITRUM_CHAIN_ID = 42161;

// Aave V3 Arbitrum FLASHLOAN_PREMIUM_TOTAL (live 2026-07-23): 5 bps = 0.05%
// Governance-updatable — prefer reading Pool when available.
const FLASH_FEE_BPS = 5n;
const BPS_DENOM = 10_000n;

// How many evenly-spaced candidate sizes to probe in the coarse scan
const SEARCH_STEPS = 10;

// Safety cap: never borrow more than this fraction of available liquidity.
// Prevents pool drain and keeps price impact in check.
const MAX_LIQUIDITY_FRACTION_BPS = 3000n; // 30 %

// Minimum loan size — below this the gas cost outweighs profit (6-decimal tokens).
const MIN_LOAN_WEI = ethers.parseUnits('10', 6);

export interface SizedLoan {
  /** Final borrow amount (after liquidity + slippage checks) */
  amount: bigint;
  /** Quoted output from DEX at this amount */
  expectedOutput: bigint;
  /** Minimum acceptable output (slippage-protected) */
  minAmountOut: bigint;
  /** Available reserve liquidity at query time */
  availableLiquidity: bigint;
  /** Aave fee for this loan */
  fee: bigint;
  /** Expected net profit (minAmountOut - principal - fee) */
  netProfit: bigint;
  /** Which DEX gave the best route */
  dexName: string;
}

export interface SizerConfig {
  /**
   * Hard upper cap on borrow (e.g. from CLI or strategy config).
   * Dynamic sizing will NEVER exceed this value.
   * Set to MaxUint256 to rely purely on on-chain liquidity cap.
   */
  maxBorrowCap: bigint;
  /**
   * Slippage tolerance in basis points applied to the quoted output.
   * The size search never relaxes this — it shrinks the loan instead.
   */
  maxSlippageBps: number;
  /**
   * Minimum profit threshold in basis points of the loan principal.
   * Loans whose worst-case net profit is below this are rejected.
   */
  minProfitBps: number;
  /**
   * Token decimals for the borrow asset (used for pretty-printing only).
   */
  tokenDecimals?: number;
  /**
   * Optional Uniswap/DEX pool address. When set and Bitquery is configured,
   * DEXPoolSlippages MaxAmountIn at maxSlippageBps further caps the search.
   */
  poolAddress?: string;
}

const DEFAULT_CONFIG: SizerConfig = {
  maxBorrowCap: ethers.MaxUint256,
  maxSlippageBps: parseInt(process.env.MAX_SLIPPAGE_BPS || '50', 10), // 0.50 % — hard ceiling, never violated
  minProfitBps: parseInt(process.env.MIN_PROFIT_BPS || '10', 10), // 0.10 % net profit floor after fee + slippage
  tokenDecimals: 18,
};

/**
 * FlashSizer — determines the optimal flash loan amount for a given opportunity.
 *
 * Algorithm
 * ---------
 * 1. Fetch available Aave V3 reserve liquidity for the borrow token.
 * 2. Apply a 30 % safety cap (and the caller's hard maxBorrowCap).
 * 3. Probe SEARCH_STEPS evenly-spaced candidate amounts to find which sizes
 *    satisfy both the slippage constraint AND the minimum profit floor.
 * 4. Binary-refine around the best candidate to maximise loan size.
 * 5. Return the winning SizedLoan, or null if no profitable size exists.
 *
 * Slippage is NEVER relaxed during the search — the loan is shrunk instead.
 */
export class FlashSizer {
  private dexAggregator: DEXAggregator;
  private config: SizerConfig;

  constructor(config: Partial<SizerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // Use ALL known DEX protocols for quoting — not just Uniswap V3.
    // Execution is still Uniswap V3 only (SniperSearcher hard-wired), but the
    // sizer must be able to see pools on Camelot, Ramses, SushiSwap etc. so
    // that tokens without a Uni V3 pool aren't silently abandoned.
    this.dexAggregator = new DEXAggregator(provider, ARBITRUM_DEX_PROTOCOLS);
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Compute the optimal flash loan size for round-trip arb:
   * borrow `tokenIn`, swap tokenIn → midToken → tokenIn, repay Aave.
   *
   * Quotes are ALWAYS multi-hop ending in the borrow asset so
   * minAmountOut is comparable to amount+premium.
   *
   * @param tokenIn   Borrow / repay asset (Aave reserve)
   * @param midToken  Intermediate hop (e.g. new listing / arb target)
   * @param opts.poolAddress  Optional pool for Bitquery slippage depth cap
   */
  async computeOptimalSize(
    tokenIn: string,
    midToken: string,
    opts?: { poolAddress?: string }
  ): Promise<SizedLoan | null> {
    logger.info(`[FlashSizer] Computing optimal flash loan size (round-trip)`);
    logger.info(`  Borrow/repay: ${tokenIn}`);
    logger.info(`  Mid hop:      ${midToken}`);

    // 1. Fetch on-chain liquidity
    const availableLiquidity = await this.fetchAvailableLiquidity(tokenIn);
    if (availableLiquidity <= 0) {
      logger.warn(`[FlashSizer] No liquidity available for ${tokenIn}`);
      return null;
    }

    const decimals = this.config.tokenDecimals ?? 18;
    logger.info(`  Aave liquidity: ${ethers.formatUnits(availableLiquidity, decimals)}`);

    const minLoanWei = decimals === 6 ? ethers.parseUnits('1', 6) : ethers.parseUnits('0.0001', decimals);

    // 2. Apply caps (Aave fraction + hard max)
    const liquidityCap = BigInt((availableLiquidity * MAX_LIQUIDITY_FRACTION_BPS) / BPS_DENOM);
    let upperBound = this.minBN(liquidityCap, this.config.maxBorrowCap);

    // 2b. Bitquery pool depth at target slippage (pre-trade gate)
    const pool = opts?.poolAddress || this.config.poolAddress;
    if (pool && bitquery.configured) {
      const maxIn = await bitquery.maxInputAtSlippage(pool, tokenIn, this.config.maxSlippageBps);
      if (maxIn) {
        try {
          // Bitquery MaxAmountIn is typically a decimal string of token units.
          // Prefer raw integer parse; fall back to parseUnits if dotted.
          let dexCap: bigint;
          if (maxIn.includes('.')) {
            dexCap = ethers.parseUnits(maxIn, decimals);
          } else {
            dexCap = BigInt(maxIn);
          }
          if (dexCap > 0) {
            logger.info(
              `  Bitquery MaxAmountIn@${this.config.maxSlippageBps}bps: ` +
                `${ethers.formatUnits(dexCap, decimals)}`
            );
            upperBound = this.minBN(upperBound, dexCap);
          }
        } catch (e) {
          logger.warn(
            `  Bitquery depth parse skipped: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      } else {
        logger.info('  Bitquery slippage depth unavailable; using Aave/hard caps only');
      }

      // Optional log of reserves for operator visibility
      try {
        const liq = await bitquery.poolLiquidity(pool, 1);
        if (liq[0]) {
          logger.info(
            `  Pool reserves (Bitquery): A=${liq[0].amountA} B=${liq[0].amountB} ` +
              `(${liq[0].protocol || 'dex'})`
          );
        }
      } catch {
        /* non-fatal */
      }
    }

    if (upperBound < minLoanWei) {
      logger.warn(
        `[FlashSizer] Upper bound ${ethers.formatUnits(upperBound, decimals)} below min loan threshold`
      );
      return null;
    }

    logger.info(
      `  Search range: [${ethers.formatUnits(minLoanWei, decimals)}, ` +
        `${ethers.formatUnits(upperBound, decimals)}]`
    );

    // 3. Pre-check: make sure at least one DEX has a quote at minimum size.
    //    This avoids burning SEARCH_STEPS RPC calls on a token with no pool.
    const minProbe = await this.dexAggregator.findBestRoundTripRoute(tokenIn, midToken, minLoanWei);
    if (!minProbe || minProbe.amountOut <= 0n) {
      logger.warn(
        `[FlashSizer] No round-trip DEX quote found for ${tokenIn} → ${midToken} → ${tokenIn}. ` +
          `Check that a pool exists on Uniswap V3, Camelot, Ramses, or SushiSwap.`
      );
      return null;
    }
    logger.info(`  Route found via ${minProbe.protocol.name} (fee ${minProbe.feeTier}) at min size.`);

    // 4. Binary / step search (round-trip quotes)
    const result = await this.binarySearch(tokenIn, midToken, upperBound, availableLiquidity, minLoanWei);

    if (!result) {
      logger.warn(`[FlashSizer] No profitable, slippage-safe size found`);
    } else {
      logger.info(
        `[FlashSizer] ✓ Optimal loan: ` +
          `${ethers.formatUnits(result.amount, decimals)} ` +
          `| fee: ${ethers.formatUnits(result.fee, decimals)} ` +
          `| net profit: ${ethers.formatUnits(result.netProfit, decimals)} ` +
          `| via ${result.dexName}`
      );
    }

    return result;
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Coarse step scan followed by binary refinement.
   * Returns the largest candidate that satisfies all constraints.
   */
  private async binarySearch(
    tokenIn: string,
    tokenOut: string,
    upperBound: bigint,
    availableLiquidity: bigint,
    minLoanWei: bigint
  ): Promise<SizedLoan | null> {
    const lo0 = minLoanWei;
    const stepSize = (upperBound - lo0) / BigInt(SEARCH_STEPS);

    // Coarse scan — probe SEARCH_STEPS equally spaced amounts plus the ceiling
    const candidates: bigint[] = [];
    for (let i = 1; i <= SEARCH_STEPS; i++) {
      candidates.push(lo0 + stepSize * BigInt(i));
    }
    candidates.push(upperBound);

    let bestResult: SizedLoan | null = null;

    for (const candidate of candidates) {
      const result = await this.evaluateSize(tokenIn, tokenOut, candidate, availableLiquidity);
      if (result && (!bestResult || result.amount > bestResult.amount)) {
        bestResult = result;
      }
    }

    if (!bestResult) return null;

    // Binary refinement in [bestResult.amount, upperBound] to maximise size
    let lo = bestResult.amount;
    let hi = upperBound;

    for (let iter = 0; iter < 8; iter++) {
      const mid = (lo + hi) / 2n;
      if (mid <= lo) break;

      const result = await this.evaluateSize(tokenIn, tokenOut, mid, availableLiquidity);
      if (result) {
        bestResult = result;
        lo = mid;
      } else {
        hi = mid;
      }
    }

    return bestResult;
  }

  /**
   * Evaluate a single candidate loan size via A→mid→A quote (borrow asset out).
   *
   * Constraints:
   *  a) amount ≤ availableLiquidity
   *  b) round-trip DEX quote positive
   *  c) minAmountOut (final borrow-asset) > repayment (amount + fee)
   *  d) netProfit ≥ minProfitBps of amount
   */
  private async evaluateSize(
    tokenIn: string,
    midToken: string,
    amount: bigint,
    availableLiquidity: bigint
  ): Promise<SizedLoan | null> {
    if (amount > availableLiquidity) return null;

    // Round-trip quote — amountOut is back in tokenIn units (repay asset)
    const route = await this.dexAggregator.findBestRoundTripRoute(tokenIn, midToken, amount);
    if (!route || route.amountOut <= 0n) return null;

    const expectedOutput = route.amountOut;

    const slippageDeduction = (expectedOutput * BigInt(this.config.maxSlippageBps)) / 10000n;
    const minAmountOut = expectedOutput - slippageDeduction;

    const fee = (amount * FLASH_FEE_BPS) / BPS_DENOM;
    const repayment = amount + fee;

    // Must cover Aave pull of amount+premium in the SAME asset
    if (minAmountOut <= repayment) return null;

    const netProfit = minAmountOut - repayment;
    const minProfitRequired = (amount * BigInt(this.config.minProfitBps)) / BPS_DENOM;
    if (netProfit < minProfitRequired) return null;

    return {
      amount,
      expectedOutput,
      minAmountOut,
      availableLiquidity,
      fee,
      netProfit,
      dexName: route.protocol.name,
    };
  }

  /**
   * Fetch the on-chain borrowable liquidity from Aave V3 for a given token.
   * Returns 0n if the reserve is not eligible for flash loans.
   */
  async fetchAvailableLiquidity(token: string): Promise<bigint> {
    try {
      const elig = await getReserveEligibility(token);
      if (!elig.eligible) {
        logger.warn('[FlashSizer] Reserve not eligible: ' + (elig.reason || token));
        return 0n;
      }
      const liq = elig.liquidity ?? (await getAvailableLiquidity(token));
      if (liq <= 0n) {
        logger.warn('[FlashSizer] No liquidity available for ' + token);
        return 0n;
      }
      return liq;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn('[FlashSizer] Liquidity fetch failed: ' + reason + ' — returning 0');
      return 0n;
    }
  }

  private minBN(a: bigint, b: bigint): bigint {
    return a < b ? a : b;
  }
}

export default FlashSizer;
