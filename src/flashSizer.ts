import { BigNumber, ethers } from 'ethers';
import { UiPoolDataProvider } from '@aave/contract-helpers';
import { provider } from './config';
import { DEXAggregator } from './dexAggregator';
import { Logger } from './logger';

const logger = new Logger('FlashSizer');

// Aave V3 Arbitrum addresses (same as flashExecutor.ts)
const UI_POOL_DATA_PROVIDER_ADDRESS = '0x91E04cf78e53aEBe609e8a7f2003e7EECD743F2B';
const POOL_ADDRESSES_PROVIDER_ADDRESS = '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb';
const ARBITRUM_CHAIN_ID = 42161;

// Aave flash loan fee: 0.09% = 9 bps
const FLASH_FEE_BPS = 9n;
const BPS_DENOM = 10_000n;

// How many evenly-spaced candidate sizes to probe in the coarse scan
const SEARCH_STEPS = 10;

// Safety cap: never borrow more than this fraction of available liquidity.
// Prevents pool drain and keeps price impact in check.
const MAX_LIQUIDITY_FRACTION_BPS = 3000n; // 30 %

// Minimum loan size — below this the gas cost outweighs profit (6-decimal tokens).
const MIN_LOAN_WEI = ethers.utils.parseUnits('10', 6);

export interface SizedLoan {
  /** Final borrow amount (after liquidity + slippage checks) */
  amount: BigNumber;
  /** Quoted output from DEX at this amount */
  expectedOutput: BigNumber;
  /** Minimum acceptable output (slippage-protected) */
  minAmountOut: BigNumber;
  /** Available reserve liquidity at query time */
  availableLiquidity: BigNumber;
  /** Aave fee for this loan */
  fee: BigNumber;
  /** Expected net profit (minAmountOut - principal - fee) */
  netProfit: BigNumber;
  /** Which DEX gave the best route */
  dexName: string;
}

export interface SizerConfig {
  /**
   * Hard upper cap on borrow (e.g. from CLI or strategy config).
   * Dynamic sizing will NEVER exceed this value.
   * Set to MaxUint256 to rely purely on on-chain liquidity cap.
   */
  maxBorrowCap: BigNumber;
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
}

const DEFAULT_CONFIG: SizerConfig = {
  maxBorrowCap: ethers.constants.MaxUint256,
  maxSlippageBps: 50,  // 0.50 % — hard ceiling, never violated
  minProfitBps: 10,    // 0.10 % net profit floor after fee + slippage
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
  private poolDataProvider: UiPoolDataProvider;
  private dexAggregator: DEXAggregator;
  private config: SizerConfig;

  constructor(config: Partial<SizerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.poolDataProvider = new UiPoolDataProvider({
      uiPoolDataProviderAddress: UI_POOL_DATA_PROVIDER_ADDRESS,
      provider,
      chainId: ARBITRUM_CHAIN_ID,
    });
    this.dexAggregator = new DEXAggregator(provider);
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Compute the optimal flash loan size for a swap from `tokenIn` → `tokenOut`.
   *
   * @param tokenIn   Address of the asset to borrow (and sell)
   * @param tokenOut  Address of the asset to receive
   * @returns SizedLoan if a profitable, slippage-safe loan exists; null otherwise.
   */
  async computeOptimalSize(
    tokenIn: string,
    tokenOut: string
  ): Promise<SizedLoan | null> {
    logger.info(`[FlashSizer] Computing optimal flash loan size`);
    logger.info(`  Borrow token:  ${tokenIn}`);
    logger.info(`  Receive token: ${tokenOut}`);

    // 1. Fetch on-chain liquidity
    const availableLiquidity = await this.fetchAvailableLiquidity(tokenIn);
    if (availableLiquidity.lte(0)) {
      logger.warn(`[FlashSizer] No liquidity available for ${tokenIn}`);
      return null;
    }

    const decimals = this.config.tokenDecimals ?? 18;
    logger.info(
      `  Aave liquidity: ${ethers.utils.formatUnits(availableLiquidity, decimals)}`
    );

    // 2. Apply caps
    const liquidityCap = BigNumber.from(
      (availableLiquidity.toBigInt() * MAX_LIQUIDITY_FRACTION_BPS) / BPS_DENOM
    );
    const upperBound = this.minBN(liquidityCap, this.config.maxBorrowCap);

    if (upperBound.lt(MIN_LOAN_WEI)) {
      logger.warn(
        `[FlashSizer] Upper bound ${ethers.utils.formatUnits(upperBound, decimals)} below min loan threshold`
      );
      return null;
    }

    logger.info(
      `  Search range: [${ethers.utils.formatUnits(MIN_LOAN_WEI, decimals)}, ` +
      `${ethers.utils.formatUnits(upperBound, decimals)}]`
    );

    // 3 & 4. Binary / step search
    const result = await this.binarySearch(tokenIn, tokenOut, upperBound, availableLiquidity);

    if (!result) {
      logger.warn(`[FlashSizer] No profitable, slippage-safe size found`);
    } else {
      logger.info(
        `[FlashSizer] ✓ Optimal loan: ` +
        `${ethers.utils.formatUnits(result.amount, decimals)} ` +
        `| fee: ${ethers.utils.formatUnits(result.fee, decimals)} ` +
        `| net profit: ${ethers.utils.formatUnits(result.netProfit, decimals)} ` +
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
    upperBound: BigNumber,
    availableLiquidity: BigNumber
  ): Promise<SizedLoan | null> {
    const lo0 = MIN_LOAN_WEI;
    const stepSize = upperBound.sub(lo0).div(SEARCH_STEPS);

    // Coarse scan — probe SEARCH_STEPS equally spaced amounts plus the ceiling
    const candidates: BigNumber[] = [];
    for (let i = 1; i <= SEARCH_STEPS; i++) {
      candidates.push(lo0.add(stepSize.mul(i)));
    }
    candidates.push(upperBound);

    let bestResult: SizedLoan | null = null;

    for (const candidate of candidates) {
      const result = await this.evaluateSize(tokenIn, tokenOut, candidate, availableLiquidity);
      if (result && (!bestResult || result.amount.gt(bestResult.amount))) {
        bestResult = result;
      }
    }

    if (!bestResult) return null;

    // Binary refinement in [bestResult.amount, upperBound] to maximise size
    let lo = bestResult.amount;
    let hi = upperBound;

    for (let iter = 0; iter < 8; iter++) {
      const mid = lo.add(hi).div(2);
      if (mid.lte(lo)) break;

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
   * Evaluate a single candidate loan size.
   * Returns SizedLoan iff all constraints pass; null otherwise.
   *
   * Constraints (in order):
   *  a) amount ≤ availableLiquidity
   *  b) DEX quote exists and is positive
   *  c) minAmountOut (quote - slippage) > repayment (amount + fee)
   *  d) netProfit ≥ minProfitBps of amount
   */
  private async evaluateSize(
    tokenIn: string,
    tokenOut: string,
    amount: BigNumber,
    availableLiquidity: BigNumber
  ): Promise<SizedLoan | null> {
    // (a) Liquidity guard
    if (amount.gt(availableLiquidity)) return null;

    // (b) Fresh DEX quote at this exact amount — no stale data
    const route = await this.dexAggregator.findBestRoute(tokenIn, tokenOut, amount);
    if (!route || route.amountOut.lte(0)) return null;

    const expectedOutput = route.amountOut;

    // (c) Slippage-protected minimum output — NEVER relax this
    const slippageDeduction = expectedOutput
      .mul(this.config.maxSlippageBps)
      .div(10_000);
    const minAmountOut = expectedOutput.sub(slippageDeduction);

    // Aave flash fee
    const fee = BigNumber.from((amount.toBigInt() * FLASH_FEE_BPS) / BPS_DENOM);
    const repayment = amount.add(fee);

    if (minAmountOut.lte(repayment)) return null; // worst-case output can't cover repayment

    // (d) Profit floor
    const netProfit = minAmountOut.sub(repayment);
    const minProfitRequired = BigNumber.from(
      (amount.toBigInt() * BigInt(this.config.minProfitBps)) / BPS_DENOM
    );
    if (netProfit.lt(minProfitRequired)) return null;

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
   * Returns BigNumber(0) if the reserve is not eligible for flash loans.
   */
  async fetchAvailableLiquidity(token: string): Promise<BigNumber> {
    try {
      const { reservesData } = await this.poolDataProvider.getReservesHumanized({
        lendingPoolAddressProvider: POOL_ADDRESSES_PROVIDER_ADDRESS,
      });

      const reserve = reservesData.find(
        (r) => r.underlyingAsset.toLowerCase() === token.toLowerCase()
      );

      if (!reserve) {
        logger.warn(`[FlashSizer] Token ${token} not listed as Aave V3 reserve`);
        return BigNumber.from(0);
      }

      if (!reserve.isActive || reserve.isPaused || reserve.isFrozen || !reserve.borrowingEnabled) {
        logger.warn(`[FlashSizer] Reserve for ${token} is not flash-loanable (status check failed)`);
        return BigNumber.from(0);
      }

      const decimals = reserve.decimals ?? 18;
      // availableLiquidity is a human-readable string; cap decimal places to avoid
      // parseUnits precision errors on very large numbers.
      const liquidityHuman = Number(reserve.availableLiquidity).toFixed(
        Math.min(6, decimals)
      );
      return ethers.utils.parseUnits(liquidityHuman, decimals);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(`[FlashSizer] Liquidity fetch failed: ${reason} — returning 0`);
      return BigNumber.from(0);
    }
  }

  private minBN(a: BigNumber, b: BigNumber): BigNumber {
    return a.lt(b) ? a : b;
  }
}

export default FlashSizer;
