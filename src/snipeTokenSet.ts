/**
 * Discover best sniping token set via Bitquery + allowlists + Aave flash eligibility.
 */
import { getAddress, isAddress } from 'ethers';
import { Logger } from './logger';
import {
  bitquery,
  isWethPair,
  WETH_ARBITRUM,
  type HotPair,
  type PoolCreatedEvent,
} from './bitquery';
import {
  getAllowedRouters,
  isFlashBaseToken,
  isRouterAllowed,
  isSnipePairAllowed,
  logAllowlistSummary,
  AAVE_FLASH_BASE_TOKENS,
} from './allowlist';
import { getReserveEligibility } from './aaveReserves';
import { ARBITRUM_DEPLOY } from './config';
import { buildERC20TokenWithContract, type TokenWithContract } from './tokens';
import { provider } from './config';

const logger = new Logger('SnipeTokenSet');

export type SnipeCandidate = {
  rank: number;
  score: number;
  baseToken: string; // flash borrow asset
  targetToken: string; // new listing / snipe side
  baseSymbol?: string;
  targetSymbol?: string;
  pool?: string;
  fee?: number;
  protocol?: string;
  source: 'pool_created' | 'hot_pair' | 'static_base';
  tradeCount?: number;
  aaveLiquidity?: string;
  reasons: string[];
};

export type SnipeTokenSet = {
  generatedAt: string;
  routers: string[];
  flashBases: string[];
  candidates: SnipeCandidate[];
  /** Best pick for immediate snipe (if any). */
  best?: SnipeCandidate;
  /** Token wrappers for best pool when resolvable. */
  bestTokens?: {
    Token0: TokenWithContract | null;
    Token1: TokenWithContract | null;
    pool?: string;
    fee?: number;
  };
};

function otherSide(a: string, b: string, base: string): string {
  return a.toLowerCase() === base.toLowerCase() ? b : a;
}

function pickBase(token0: string, token1: string): string | null {
  if (isFlashBaseToken(token0)) return getAddress(token0);
  if (isFlashBaseToken(token1)) return getAddress(token1);
  return null;
}

/**
 * Score a candidate: higher = better for sniping.
 * Weights: Aave liquidity, recent trade heat, new pool, WETH preference.
 */
function scoreCandidate(c: {
  aaveLiq: bigint;
  tradeCount: number;
  isNewPool: boolean;
  baseIsWeth: boolean;
  hasPool: boolean;
}): number {
  let s = 0;
  // Liquidity in eth-ish units (rough): log scale
  if (c.aaveLiq > 0n) {
    const ethApprox = Number(c.aaveLiq / 10n ** 15n); // milli-ETH scale for 18-dec
    s += Math.min(40, Math.log10(1 + Math.max(1, ethApprox)) * 12);
  }
  s += Math.min(30, c.tradeCount * 3);
  if (c.isNewPool) s += 25;
  if (c.baseIsWeth) s += 10;
  if (c.hasPool) s += 5;
  return s;
}

/**
 * Build ranked sniping set from Bitquery (hot pairs + new pools) filtered by allowlist.
 */
export async function discoverSnipeTokenSet(opts?: {
  poolLimit?: number;
  tradeLimit?: number;
  maxCandidates?: number;
}): Promise<SnipeTokenSet> {
  logAllowlistSummary();
  const routers = getAllowedRouters().filter(isRouterAllowed);
  const flashBases = [...AAVE_FLASH_BASE_TOKENS].map((t) => getAddress(t.toLowerCase()));

  const poolLimit = opts?.poolLimit ?? 15;
  const tradeLimit = opts?.tradeLimit ?? 80;
  const maxCandidates = opts?.maxCandidates ?? 12;

  let newPools: PoolCreatedEvent[] = [];
  let hot: HotPair[] = [];

  if (bitquery.configured) {
    const [pools, pairs] = await Promise.all([
      bitquery.findRecentWethPools(poolLimit).catch((e) => {
        logger.warn(`PoolCreated query failed: ${e instanceof Error ? e.message : e}`);
        return [] as PoolCreatedEvent[];
      }),
      bitquery.recentHotPairs({ limit: tradeLimit, wethOnly: true }).catch((e) => {
        logger.warn(`Hot pairs query failed: ${e instanceof Error ? e.message : e}`);
        return [] as HotPair[];
      }),
    ]);
    newPools = pools;
    hot = pairs;
    logger.info(`Bitquery: ${newPools.length} new WETH pools, ${hot.length} hot pairs`);
  } else {
    logger.warn('BITQUERY_TOKEN not set — ranking static flash bases only');
  }

  type Acc = {
    baseToken: string;
    targetToken: string;
    pool?: string;
    fee?: number;
    protocol?: string;
    source: SnipeCandidate['source'];
    tradeCount: number;
    isNewPool: boolean;
    reasons: string[];
    baseSymbol?: string;
    targetSymbol?: string;
  };
  const acc = new Map<string, Acc>();

  const add = (row: Acc) => {
    if (!isSnipePairAllowed(row.baseToken, row.targetToken)) return;
    const key = `${row.baseToken.toLowerCase()}_${row.targetToken.toLowerCase()}`;
    const prev = acc.get(key);
    if (!prev) {
      acc.set(key, row);
      return;
    }
    prev.tradeCount += row.tradeCount;
    prev.isNewPool = prev.isNewPool || row.isNewPool;
    if (!prev.pool && row.pool) prev.pool = row.pool;
    if (row.fee !== undefined) prev.fee = row.fee;
    prev.reasons.push(...row.reasons);
  };

  for (const p of newPools) {
    if (!isSnipePairAllowed(p.token0, p.token1)) continue;
    const base = pickBase(p.token0, p.token1);
    if (!base) continue;
    const target = otherSide(p.token0, p.token1, base);
    add({
      baseToken: base,
      targetToken: getAddress(target),
      pool: p.pool,
      fee: p.fee,
      source: 'pool_created',
      tradeCount: 0,
      isNewPool: true,
      reasons: ['recent PoolCreated'],
    });
  }

  for (const h of hot) {
    if (!isSnipePairAllowed(h.tokenA, h.tokenB)) continue;
    const base = pickBase(h.tokenA, h.tokenB);
    if (!base) continue;
    const target = otherSide(h.tokenA, h.tokenB, base);
    const baseIsA = h.tokenA.toLowerCase() === base.toLowerCase();
    add({
      baseToken: base,
      targetToken: getAddress(target),
      protocol: h.protocol,
      source: 'hot_pair',
      tradeCount: h.tradeCount,
      isNewPool: false,
      reasons: [`hot trades x${h.tradeCount}`],
      baseSymbol: baseIsA ? h.symbolA : h.symbolB,
      targetSymbol: baseIsA ? h.symbolB : h.symbolA,
    });
  }

  // Always surface static flash bases as borrow candidates (no target yet)
  for (const b of flashBases) {
    const key = `base_only_${b.toLowerCase()}`;
    if (![...acc.keys()].some((k) => k.startsWith(b.toLowerCase()))) {
      // keep bases for liquidity ranking even without a target
      void key;
    }
  }

  // Enrich with Aave liquidity for base tokens
  const baseLiq = new Map<string, bigint>();
  await Promise.all(
    [...new Set([...acc.values()].map((c) => c.baseToken))].map(async (base) => {
      const elig = await getReserveEligibility(base);
      baseLiq.set(base.toLowerCase(), elig.eligible ? elig.liquidity ?? 0n : 0n);
      if (!elig.eligible) {
        logger.info(`Flash base ${base.slice(0, 10)}… not eligible: ${elig.reason}`);
      }
    })
  );

  // Pre-filter bases that are not flash-eligible
  const eligibleBases = new Set<string>();
  await Promise.all(
    [...baseLiq.keys()].map(async (b) => {
      const elig = await getReserveEligibility(b);
      if (elig.eligible) {
        eligibleBases.add(b);
        if (elig.liquidity !== undefined) baseLiq.set(b, elig.liquidity);
      }
    })
  );

  const scored: SnipeCandidate[] = [];
  for (const row of acc.values()) {
    if (!eligibleBases.has(row.baseToken.toLowerCase())) continue;
    const liq = baseLiq.get(row.baseToken.toLowerCase()) ?? 0n;
    const score = scoreCandidate({
      aaveLiq: liq,
      tradeCount: row.tradeCount,
      isNewPool: row.isNewPool,
      baseIsWeth: row.baseToken.toLowerCase() === WETH_ARBITRUM.toLowerCase(),
      hasPool: Boolean(row.pool),
    });
    scored.push({
      rank: 0,
      score,
      baseToken: row.baseToken,
      targetToken: row.targetToken,
      baseSymbol: row.baseSymbol,
      targetSymbol: row.targetSymbol,
      pool: row.pool,
      fee: row.fee,
      protocol: row.protocol,
      source: row.source,
      tradeCount: row.tradeCount,
      aaveLiquidity: liq.toString(),
      reasons: row.reasons,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, maxCandidates).map((c, i) => ({ ...c, rank: i + 1 }));

  const best = top[0];
  let bestTokens: SnipeTokenSet['bestTokens'];
  if (best) {
    const [t0, t1] = await Promise.all([
      buildERC20TokenWithContract(best.baseToken, provider),
      buildERC20TokenWithContract(best.targetToken, provider),
    ]);
    bestTokens = {
      Token0: t0,
      Token1: t1,
      pool: best.pool,
      fee: best.fee,
    };
    logger.info(
      `Best snipe: ${best.baseSymbol ?? best.baseToken.slice(0, 8)} → ${
        best.targetSymbol ?? best.targetToken.slice(0, 8)
      } score=${best.score.toFixed(1)} (${best.source})`
    );
  } else {
    logger.warn('No sniping candidates after allowlist + Aave filters');
  }

  return {
    generatedAt: new Date().toISOString(),
    routers: routers.length ? routers : [ARBITRUM_DEPLOY.swapRouter02],
    flashBases,
    candidates: top,
    best,
    bestTokens,
  };
}

/**
 * Resolve tokens for main bot loop: prefer Bitquery-ranked set, fall back to latest pool.
 */
export async function getBestSnipeTokens(): Promise<{
  Token0: TokenWithContract | null;
  Token1: TokenWithContract | null;
  pool?: string;
  fee?: number;
  set: SnipeTokenSet;
}> {
  const set = await discoverSnipeTokenSet();
  if (set.bestTokens?.Token0 && set.bestTokens?.Token1) {
    return {
      Token0: set.bestTokens.Token0,
      Token1: set.bestTokens.Token1,
      pool: set.bestTokens.pool,
      fee: set.bestTokens.fee,
      set,
    };
  }
  // Fallback: first allowlisted new pool via tokens.getTokens path
  const { getTokens } = await import('./tokens');
  const t = await getTokens({ wethOnly: true });
  return { Token0: t.Token0, Token1: t.Token1, pool: t.pool, fee: t.fee, set };
}
