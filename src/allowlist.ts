/**
 * Off-chain allowlists for routers and sniping tokens.
 * SniperSearcher has no on-chain token map — this gates bot-side execution.
 */
import { getAddress, isAddress } from 'ethers';
import { getOptionalEnv } from './validation';
import { ARBITRUM_DEPLOY } from './config';
import { Logger } from './logger';

const logger = new Logger('Allowlist');

/** Execution venues wired into SniperSearcher's router allowlist: Uniswap V3, SushiSwap V3,
 *  PancakeSwap V3. Kept as a literal list (not imported from dexAggregator.ts) so this file
 *  has no import-order dependency on it; addresses must stay in sync with
 *  dexAggregator.ts's ARBITRUM_DEX_PROTOCOLS and DeployRegistry.sol's sniperInitialRouters(). */
export const ALLOWED_ROUTERS_DEFAULT = [
  ARBITRUM_DEPLOY.swapRouter02,
  '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', // Uniswap V3
  '0x8A21F6768C1f8075791D08546Dadf6daA0bE820c', // SushiSwap V3
  '0x32226588378236Fd0c7c4053999F88aC0e5cAc77', // PancakeSwap V3
] as const;

/**
 * Flash-loan base tokens (Aave V3 Arbitrum reserves commonly used for snipes).
 * Borrow leg of round-trip arb must be one of these (or extra ALLOWED_TOKENS).
 */
export const AAVE_FLASH_BASE_TOKENS = [
  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // USDC — flash-available ~30.4M
  '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH — flash-available ~22.9k
  // Bases deliberately limited to USDC + WETH: the profitable price differences live on
  // these two legs (e.g. LINK/WETH depth ~$550k vs LINK/USDC ~$5.5k). USDT/WBTC/DAI/USDC.e/ARB
  // were removed as borrow bases — they remain reachable as swap TARGETS when paired with
  // USDC/WETH via isSnipePairAllowed. Both listed here are verified flash-loanable Aave V3
  // Arbitrum reserves.
] as const;

/**
 * Curated swap targets always considered against the flash bases, independent of Bitquery
 * discovery (seeded as base×target candidates in snipeTokenSet). These are NOT flash bases —
 * you borrow USDC/WETH and swap into these and back. Each verified on-chain with a live
 * USDC- or WETH-paired pool on an execution venue (Uniswap/Sushi/Pancake V3).
 */
export const CURATED_TARGET_TOKENS = [
  '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4', // LINK — Uni V3 LINK/WETH depth ~160 WETH (~$550k)
  '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', // cbBTC (Coinbase Wrapped BTC) — Uni V3 cbBTC/WETH ~4 WETH
] as const;

function parseAddressList(raw: string, label: string): string[] {
  if (!raw || !raw.trim()) return [];
  const out: string[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const t = part.trim();
    if (!t) continue;
    if (!isAddress(t)) {
      logger.warn(`${label}: skip invalid address ${t}`);
      continue;
    }
    out.push(getAddress(t));
  }
  return out;
}

function uniqLower(addrs: string[]): string[] {
  const m = new Map<string, string>();
  for (const a of addrs) {
    if (!isAddress(a)) continue;
    const c = getAddress(a);
    m.set(c.toLowerCase(), c);
  }
  return [...m.values()];
}

/** Routers the bot may target (quotes + execution). Default: SwapRouter02 only. */
export function getAllowedRouters(): string[] {
  const extra = parseAddressList(getOptionalEnv('ALLOWED_ROUTERS', ''), 'ALLOWED_ROUTERS');
  return uniqLower([...ALLOWED_ROUTERS_DEFAULT, ...extra]);
}

/**
 * Tokens allowed as flash borrow base and/or snipe targets.
 * Env ALLOWED_TOKENS merges with AAVE_FLASH_BASE_TOKENS (always included for flash path).
 * Env DENIED_TOKENS removes addresses from the set.
 */
export function getAllowedTokens(): string[] {
  const extra = parseAddressList(getOptionalEnv('ALLOWED_TOKENS', ''), 'ALLOWED_TOKENS');
  const denied = new Set(
    parseAddressList(getOptionalEnv('DENIED_TOKENS', ''), 'DENIED_TOKENS').map((a) =>
      a.toLowerCase()
    )
  );
  const base = uniqLower([
    ...AAVE_FLASH_BASE_TOKENS,
    ...CURATED_TARGET_TOKENS,
    ...extra,
  ]).filter((a) => !denied.has(a.toLowerCase()));
  return base;
}

export function isRouterAllowed(router: string): boolean {
  if (!isAddress(router)) return false;
  const r = getAddress(router).toLowerCase();
  return getAllowedRouters().some((x) => x.toLowerCase() === r);
}

export function isTokenAllowed(token: string): boolean {
  if (!isAddress(token)) return false;
  const t = getAddress(token).toLowerCase();
  // If ALLOWED_TOKENS is empty beyond bases, bases still apply.
  // New listing targets are allowed when paired with a base (see isSnipePairAllowed).
  return getAllowedTokens().some((x) => x.toLowerCase() === t);
}

export function isFlashBaseToken(token: string): boolean {
  if (!isAddress(token)) return false;
  const t = getAddress(token).toLowerCase();
  const bases = uniqLower([
    ...AAVE_FLASH_BASE_TOKENS,
    ...parseAddressList(getOptionalEnv('FLASH_BASE_TOKENS', ''), 'FLASH_BASE_TOKENS'),
  ]);
  return bases.some((x) => x.toLowerCase() === t);
}

/**
 * Snipe pair is allowed if:
 * - both tokens on allowlist, OR
 * - one side is a flash base and the other is not denied
 */
export function isSnipePairAllowed(tokenA: string, tokenB: string): boolean {
  if (!isAddress(tokenA) || !isAddress(tokenB)) return false;
  const a = getAddress(tokenA);
  const b = getAddress(tokenB);
  const denied = new Set(
    parseAddressList(getOptionalEnv('DENIED_TOKENS', ''), 'DENIED_TOKENS').map((x) =>
      x.toLowerCase()
    )
  );
  if (denied.has(a.toLowerCase()) || denied.has(b.toLowerCase())) return false;

  const aBase = isFlashBaseToken(a);
  const bBase = isFlashBaseToken(b);
  // Prefer base↔target pairs for flash snipes
  if (aBase || bBase) return true;
  // Both explicitly allowed
  return isTokenAllowed(a) && isTokenAllowed(b);
}

export function assertRouterAllowed(router: string): void {
  if (!isRouterAllowed(router)) {
    throw new Error(`Router not allowlisted: ${router}`);
  }
}

export function logAllowlistSummary(): void {
  logger.info(`Routers (${getAllowedRouters().length}): ${getAllowedRouters().join(', ')}`);
  logger.info(
    `Flash bases / allowed tokens (${getAllowedTokens().length}): ` +
      getAllowedTokens()
        .map((t) => t.slice(0, 10) + '…')
        .join(', ')
  );
}
