# Multi-Venue Swap Execution — Design

Date: 2026-07-23
Status: Approved (pending implementation plan)

## Goal

Today, best-route *quoting* already spans 5 Arbitrum DEXes (`ARBITRUM_DEX_PROTOCOLS` in
`src/dexAggregator.ts`), but actual on-chain *execution* — both the flash-loan path and the
direct-swap path — is hardcoded to Uniswap V3's SwapRouter02 only, because the venue is baked
into contract constructors as `immutable`/`constant`. This spec widens execution to 4 venues:

- Uniswap V3
- SushiSwap V3
- Ramses V2
- PancakeSwap V3

Camelot V3 is explicitly **out of scope** for execution (see "Deferred").

## Background: why this needs a contract change, not just a TS change

Three on-chain contracts each hardcode a single router/executor at construction time:

- `SniperSearcher.sol:46` — `address public immutable swapRouter;` (Uniswap V3 SwapRouter02 ABI:
  `exactInput(ExactInputParams)`). Used by both the live flash-loan path and the currently-dormant
  direct-mode path (`src/executor.ts`).
- `FlashLoanReceiver.sol:58` — `address public immutable swapExecutor;` (points at one
  `SniperSearcher`).
- `DelegatedExecutor.sol:41` — `address constant SWAP_ROUTER = 0x68b3...` (even more rigid — not
  even a constructor param). Used only by the standalone EIP-7702 swap path
  (`bridge.ts:executeEIP7702`), which is currently dead code in production: `main.ts` locks the
  bridge to `ExecutionMode.FLASH_LOAN` with no fallback (`main.ts:50`, `bridge.ts:99-108`), so this
  path never actually runs today.

None of these can select a router at call time without code changes. This spec changes all three
to an owner-managed allowlist, mirroring the `allowedExecutors` pattern `SniperSearcher` already
uses.

## Existing correctness gap this design also fixes

`FlashSizer` (`src/flashSizer.ts`) already round-trip-quotes across **all** DEX protocols
(`ARBITRUM_DEX_PROTOCOLS`, including Camelot) to pick the optimal loan *size*
(`evaluateSize` → `findBestRoundTripRoute`, called up to ~18 times per candidate pair during its
binary search). But the swap *path* actually sent on-chain is built separately, earlier, and
Uniswap-only: `main.ts:164-190` probes a single 1-token amount via `EXECUTION_VENUE_PROTOCOLS`
(today: Uniswap V3 only) and hands that fixed path to the bridge.

This means FlashSizer's chosen "best" venue and the venue actually executed against can silently
diverge. It's currently masked because execution is Uniswap-only anyway — a non-Uniswap "best"
quote from FlashSizer never reaches the chain. Once execution opens to 4 venues, this becomes a
real bug (size computed against one venue's price curve, trade executed against another's,
potential revert or a wrongly-computed `minAmountOut`).

Fix: FlashSizer becomes the single source of truth for both size *and* route. See "Off-chain
changes" below.

## Contract changes

### `SniperSearcher.sol`

- Remove `address public immutable swapRouter;`.
- Add `mapping(address router => bool allowed) public allowedRouters;`.
- Constructor takes an initial router list (`address[] memory initialRouters`) instead of one
  address; seeds the allowlist at deploy so no extra owner tx is needed for the first routers.
  `minAmountBitLength` and `chainId` handling unchanged.
- Add `allowRouter(address)` / `revokeRouter(address)` (`onlyOwner`), mirroring
  `allowExecutor`/`revokeExecutor` exactly. New events `RouterAllowed`/`RouterRevoked`.
- `executeSwap` / `executeSwapWithDeadline` gain a `router` parameter:
  `executeSwap(address tokenIn, address router, uint256 amountIn, bytes calldata path, uint256 minAmountOut)`.
  New error `RouterNotAllowed(address router)`, checked first in `_executeSwap`, before any
  approve/transfer.
- `_executeSwap` uses the validated `router` in place of the old immutable `swapRouter` for the
  approve + `exactInput` call.
- `_validatePath` is unchanged — its fee-tiered encoding (`(path.length - 20) % 23 == 0`) is valid
  for all 4 in-scope venues (all genuine Uniswap V3 forks).

### `FlashLoanReceiver.sol`

- `swapExecutor` stays `immutable` — it still points at the one `SniperSearcher`. Only *which
  router SniperSearcher is told to use* becomes selectable per call.
- `initiateFlashLoan` gains a `router` parameter, threaded into the `abi.encode`d `params` blob
  passed to Aave alongside `token`/`swapPath`/`minAmountOut`.
- `executeOperation` decodes `router` from `params` and passes it through to
  `ISwapExecutor.executeSwap(asset, router, amount, swapPath, minAmountOut)` (interface updated to
  match SniperSearcher's new signature).
- Round-trip / repay-asset validation logic is unchanged — it's router-agnostic.

### `DelegatedExecutor.sol`

- Same treatment as `SniperSearcher`: `constant SWAP_ROUTER` → `allowedRouters` mapping +
  `allowRouter`/`revokeRouter`, swap entrypoint gains a `router` parameter.
- This is groundwork only — the contract isn't reachable from the live loop today. Brought in line
  so a future activation doesn't rediscover this gap.

## Off-chain changes

- **`dexAggregator.ts`**: `EXECUTION_VENUE_PROTOCOLS` widens from `[Uniswap V3]` to the 4 venues.
  Comment updated to explain the Camelot exclusion.
- **`flashSizer.ts`**:
  - Its internal `DEXAggregator` switches from `ARBITRUM_DEX_PROTOCOLS` (all 5) to
    `EXECUTION_VENUE_PROTOCOLS` (the 4 executable venues). This is the fix for the size/execution
    mismatch described above, not just a widening — it makes "best size" and "best route" the same
    search. No real-world regression from dropping Camelot here: `main.ts`'s pre-check already
    gates on `EXECUTION_VENUE_PROTOCOLS` *before* FlashSizer ever runs, so a Camelot-only pair is
    already filtered out upstream today.
  - `SizedLoan` gains `router: string` and `feeTier: number` fields (from the winning
    `route.protocol.routerAddress` / `route.feeTier`).
  - New post-search step (see "Bitquery cross-check" below).
- **`bridge.ts`**: `executeFlashLoan` rebuilds the swap path from `sized.router`/`sized.feeTier`
  (FlashSizer's answer) instead of reusing the path `main.ts` pre-built from the 1-token probe.
  DIRECT/EIP7702 branches are unaffected — they keep using `opportunity.path`/`opportunity.router`
  as built upstream (both paths remain dormant either way).
- **`flashExecutor.ts`**: `FlashLoanParams` gains `router: string`, passed through to
  `receiver.initiateFlashLoan(token, amount, router, swapPath, minAmountOut, ...)` and to the
  type-4 path's `INITIATE_FLASH_IFACE` (ABI updated to include the router param).
- **`executor.ts`** (`SniperExecutor`, dormant DIRECT mode): `SwapParams` gains `router`, passed to
  `searcher.executeSwapWithDeadline(tokenIn, router, amountIn, path, minAmountOut, deadline, ...)`.
- **`eip7702.ts`** (`EIP7702Executor`, dormant EIP-7702 mode): mirrors the same signature update
  for `DelegatedExecutor`'s new `router` param.
- **`allowlist.ts`**: `ALLOWED_ROUTERS_DEFAULT` widens from a single duplicated SwapRouter02 entry
  to the 4 router addresses (sourced from `dexAggregator.ts`'s protocol list), keeping the
  off-chain pre-flight gate (`isRouterAllowed`, called at `main.ts:175` and boot-time via
  `assertRouterAllowed`) in sync with what the contracts will accept on-chain. `ALLOWED_ROUTERS`
  env var can still add more / override.
- **`main.ts`**: no structural change needed — `EXECUTION_VENUE_PROTOCOLS` widening flows through
  automatically. Its own route-building becomes a cheap early feasibility check only ("does any
  venue have a pool at all"); FlashSizer's answer is what actually gets executed.

## Bitquery cross-check (new)

Bitquery currently plays three roles, none of which are route-selection: candidate discovery
(`snipeTokenSet.ts`), a pool-depth cap on loan size keyed to `candidate.pool`
(`flashSizer.ts` step 2b), and a live trade-stream during execution (`main.ts`). This spec adds a
fourth, narrowly scoped role: sanity-checking the venue FlashSizer's on-chain Quoter search picks.

Constraint: Bitquery's `poolSlippage`/`poolLiquidity` take a single pool address, and none of the
4 venues' Quoter calls currently expose pool addresses (Uniswap-style Quoters resolve the pool
internally via their own factory). Also, FlashSizer's binary search evaluates up to ~18 candidate
sizes per pair, each currently doing up to 4 on-chain Quoter calls — calling Bitquery at that same
per-size, per-venue granularity would mean up to ~72 GraphQL calls per candidate pair per ~3s loop
iteration, which would hit rate limits and add real latency. The existing depth-cap call is
deliberately done once, before the search — this addition follows the same shape.

- **`dexAggregator.ts`**: add `factoryAddress` to `DEXProtocolConfig` for each of the 4 execution
  venues, plus a `resolvePoolAddress(factory, tokenA, tokenB, feeTier)` helper (one `getPool()`
  view call).
- **`flashSizer.ts`**: after `binarySearch` converges on a final winner (router + feeTier +
  amount), add one more step before returning: resolve that venue's pool address, then call the
  **already-existing** `bitquery.maxInputAtSlippage(poolAddress, tokenIn, maxSlippageBps)` —
  pointed at the winning venue's pool instead of `candidate.pool`.
- **Guard logic:**
  - No Bitquery data for that pool → log and proceed (fail-open, matching the existing behavior
    when Bitquery has no coverage for a pool).
  - Bitquery data present and the winning `amount` exceeds Bitquery's implied max input at the
    slippage ceiling → reject the candidate (`computeOptimalSize` returns `null`), surfacing
    through the existing `no_arb` path — `main.ts` moves to the next ranked candidate. No new
    fallback-to-another-venue machinery; a Quoter/Bitquery disagreement should be rare, and sitting
    out one candidate for one iteration is simpler and safer than engineering a retry loop around
    what should be an anomaly.
- **Cost:** exactly one extra Bitquery call per candidate pair per iteration — same order of
  magnitude as the existing depth-cap call, not multiplied per venue or per search-step.

## Data flow (updated)

```
main.ts tryCandidatePair()
  ├─ DEXAggregator.findBestRoute() over 4 execution venues  — cheap early feasibility check only
  ├─ isRouterAllowed() gate (off-chain allowlist, now 4 routers)
  └─ bridge.executeOptimal()
       └─ executeFlashLoan()
            └─ FlashSizer.computeOptimalSize()
                 ├─ Aave liquidity cap, Bitquery candidate-pool depth cap (unchanged, step 2b)
                 ├─ binary search over 4 execution venues (was 5, Camelot dropped from sizing too)
                 ├─ resolve winning venue's pool address, Bitquery cross-check (new)
                 └─ return SizedLoan { amount, router, feeTier, ... }
            ├─ rebuild path from sized.router / sized.feeTier   (was: reuse main.ts's Uniswap-only path)
            └─ FlashLoanExecutor.executeFlashLoanArbitrage({ ..., router })
                 └─ receiver.initiateFlashLoan(token, amount, router, swapPath, minAmountOut)
                      └─ on-chain: Aave.flashLoanSimple → executeOperation
                           → SniperSearcher.executeSwap(tokenIn, router, ...)
                                → require(allowedRouters[router])
                                → IUniswapV3Router02(router).exactInput(...)
```

## Rollout

Removing `immutable`/`constant` router fields and changing function signatures is not
upgrade-compatible with the currently-deployed bytecode — new deployments are required, following
the existing pattern seen in `contracts/deployment-reports/`:

1. Update `DeployRegistry.sol` constructor args (router list, not a single address).
2. Redeploy via `Deploy.s.sol`.
3. Re-run `Configure.s.sol` (now also seeding `allowedRouters`, not just `allowExecutor`).
4. Re-run `Verify.s.sol` for explorer verification.
5. Write new `deployment-reports/deployment_<ts>.md` + `post_deploy_<ts>.md`, matching existing
   reports.
6. Update `.env` / `src/config.ts` to the new contract addresses.
7. Explicit pre-cutover checklist item: confirm zero standing balance on the old
   `FlashLoanReceiver` / `SniperSearcher` (sweep first if anything's parked) before retiring them.

## Testing

This repo's only test suite is Foundry (`npm test` → `cd contracts && forge test`); there is no
TypeScript test framework configured, so this spec doesn't introduce one.

- Extend `SniperSearcher.t.sol` / `FlashLoanReceiver.t.sol`: swap succeeds via each of the 4
  allowlisted routers (mocked), reverts on a non-allowlisted router, `allowRouter`/`revokeRouter`
  are owner-gated and emit events, existing path-validation cases still pass unchanged.
- New `DelegatedExecutor.t.sol` cases mirroring the same router-allowlist behavior.
- Pre-mainnet: one full flash-loan dry run on an Arbitrum mainnet fork (Anvil) deliberately routed
  through a non-Uniswap venue (e.g. a pair known to price better on Ramses) to prove the full round
  trip executes correctly before this ever touches real funds.

## Deferred (explicitly out of scope for this spec)

- **Camelot V3 execution.** Camelot V3 runs on Algebra's engine, not a Uniswap V3 fork: dynamic
  per-pool fees instead of fixed tiers, plain 20-byte-address path encoding (no 3-byte fee bytes
  between hops, breaking `_validatePath`'s `(path.length - 20) % 23 == 0` assumption), and a
  different `exactInputSingle` call shape (no `fee` field, has `limitSqrtPrice` instead). Camelot
  remains quote-only (still included in Bitquery-adjacent candidate discovery / general market
  visibility, but not in `EXECUTION_VENUE_PROTOCOLS`) until a follow-up spec designs the
  Algebra-style path/call encoding branch.
- **Activating the standalone EIP-7702 delegated-swap path.** `DelegatedExecutor` gets the same
  router-allowlist shape for consistency, but actually wiring `bridge.ts` to use
  `ExecutionMode.EIP7702` in production is not part of this change.
