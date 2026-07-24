# Production Calldata Reference (Arbitrum One)

**Updated:** 2026-07-23  
**Chain ID:** 42161  
**Owner / deployer:** `0x00000001386687D89e6A36aE01C5e5F75acF61Af`

## Deployed addresses

| Contract          | Address                                      |
| ----------------- | -------------------------------------------- |
| SniperSearcher    | `0xAC7465949D3178C9F13d629c6417b2a02D50DdC8` |
| FlashLoanReceiver | `0xdce71b4f28dcc5686B3B4e8790bD6051345A89b8` |
| DelegatedExecutor | `0xc7a5B0873CB174A78017A66b541B24be64fBAde4` |
| BEBE (canonical)  | `0x00000000BEBEDB7C30ee418158e26E31a5A8f3E2` |
| SwapRouter02      | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` |
| Aave V3 Pool      | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` |

Selectors below are from the verified Solidity sources (solc 0.8.36 / via-ir).

---

## SniperSearcher

### `executeSwap(address,uint256,bytes,uint256)` → `0xdd824660`

```
function executeSwap(
  address tokenIn,
  uint256 amountIn,
  bytes path,
  uint256 minAmountOut
) external returns (uint256 amountOut)
```

Caller must be `owner` or `allowedExecutors`. Pulls `tokenIn` via `transferFrom`, swaps on SwapRouter02, returns `tokenOut` to caller.

### `executeSwapWithDeadline(address,uint256,bytes,uint256,uint256)` → `0x2a6ea44a`

Same as above with explicit `deadline` (unix seconds).

### `allowExecutor(address)` → `0xb1b05f2a`

Owner-only. FlashLoanReceiver must be allowlisted (already set at deploy).

---

## FlashLoanReceiver

### `initiateFlashLoan(address,uint256,bytes,uint256)` → `0xd4c4ca9b`

```
function initiateFlashLoan(
  address token,        // borrow / repay asset
  uint256 amount,
  bytes swapPath,       // Uni V3 multi-hop; MUST end in `token` (min 66 bytes / 2 hops)
  uint256 minAmountOut  // must be >= amount + premium (live FLASHLOAN_PREMIUM_TOTAL)
) external onlyOwner
```

**Example** (WETH round-trip WETH→USDC→WETH, 0.3% fees, 1 WETH, minOut ~1.0005 WETH):

```bash
cast calldata "initiateFlashLoan(address,uint256,bytes,uint256)" \
  0x82aF49447D8a07e3bd95BD0d56f35241523fBab1 \
  1000000000000000000 \
  0x82af49447d8a07e3bd95bd0d56f35241523fbab1000bb8af88d065e77c8cc2239327c5edb3a432268e5831000bb882af49447d8a07e3bd95bd0d56f35241523fbab1 \
  1000500000000000000
```

Selector prefix: `0xd4c4ca9b…`

### `executeOperation(...)` → `0x1b11d0ff`

Aave Pool callback only (`msg.sender == lendingPool`, `initiator == address(this)`).

### `transferOwnership(address)` → `0xf2fde38b`

### `flashLoanPremiumBps()` → `0x56d8940f`

---

## DelegatedExecutor (EIP-7702 single-target Uni)

### `executeSwap(address,uint256,bytes,uint256,uint256)` → `0x107db2c4`

```
function executeSwap(
  address tokenIn,
  uint256 amountIn,
  bytes path,
  uint256 minAmountOut,
  uint256 deadline
) external returns (uint256 amountOut)
```

Under 7702: `msg.sender == address(this)` (EOA self-call). External allowlisted EOAs get `tokenOut` transferred out.

**Type-4 pattern:** authorize EOA → this contract, `to = EOA`, `data = executeSwap(...)`.

### `executeBatchSwaps((address,uint256,bytes,uint256)[],uint256)` → `0x1435c9ac`

### `executeSwapWithCallback(...)` — callback data must be empty (`CallbackDisabled`)

---

## BEBE BasicEOABatchExecutor (multi-target)

Address: `0x00000000BEBEDB7C30ee418158e26E31a5A8f3E2`

### `execute(bytes32,bytes)` → `0xe9ae5c53`

ERC-7821 mode (batch, no opData):

```
mode = 0x0100000000000000000000000000000000000000000000000000000000000000
executionData = abi.encode(Call[]{(to, value, data), ...})
```

Auth: empty opData requires `msg.sender == address(this)` (7702 self-call).

**Example: EOA calls FlashLoanReceiver.initiateFlashLoan via BEBE**

1. Auth list → BEBE
2. `to = EOA`, `data = execute(mode, abi.encode([{ to: FlashLoanReceiver, value: 0, data: initiateFlashLoan_calldata }]))`

### `isValidSignature(bytes32,bytes)` → `0x1626ba7e`

ERC-1271: `ecrecover == address(this)` → magic `0x1626ba7e`, else `0xffffffff`.

### `supportsExecutionMode(bytes32)` → `0xd03c7914`

---

## Path encoding (Uniswap V3)

```
tokenIn (20) || fee (3) || tokenMid (20) || fee (3) || tokenOut (20)
# flash repay: tokenOut MUST equal borrow asset; min length 66 bytes (2 hops)
```

Fee `3000` = `0x000bb8`, fee `500` = `0x0001f4`.

---

## TypeScript encoding helpers

Hot path uses:

- `src/executor.ts` → `SNIPER_SEARCHER_ABI` / `executeSwapWithDeadline`
- `src/flashExecutor.ts` → `FLASH_LOAN_RECEIVER_ABI` / `initiateFlashLoan` (`0xd4c4ca9b`)
- `src/eip7702.ts` → DelegatedExecutor `0x107db2c4` or BEBE `0xe9ae5c53` + `encodeBatchExecute`

ABIs: `src/contractABIs.ts` (regenerated from Foundry `out/`).


## Router wiring (production-critical)

SniperSearcher and DelegatedExecutor swap against an owner-managed router allowlist
(Uniswap V3, SushiSwap V3, PancakeSwap V3). The router address is passed per-call; the
contract picks the router's exactInput ABI shape from its recorded `routerIsLegacyAbi` flag:

- **SwapRouter02-style** (Uniswap V3, PancakeSwap V3 — `legacyAbi = false`):
  `exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum))`
  selector `0xb858183f`
- **Legacy ISwapRouter** (SushiSwap V3 — `legacyAbi = true`):
  `exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum))`
  selector `0xc04b8d59`

SushiSwap V3's real Arbitrum router uses the legacy 5-field shape (deadline inside the struct) —
confirmed by mainnet-fork dry run 2026-07-24; the 4-field call reverts with empty data. See
`docs/superpowers/specs/2026-07-23-multi-venue-swap-execution-design.md`, "Dual-ABI router support".

### Flash path wiring

```
EOA --type4--> BEBE.execute([CALL FlashLoanReceiver.initiateFlashLoan(token, router, ...)])
  --> Aave.flashLoanSimple(receiver=Flash)
  --> Flash.executeOperation  (decodes router from params)
      --> approve SniperSearcher
      --> SniperSearcher.executeSwap(tokenIn, router, ...)  (must be allowExecutor'd at deploy)
      --> path MUST round-trip to borrow asset
      --> approve Aave for amount+premium
```

### Selector cheat-sheet (post-router-allowlist + dual-ABI, 2026-07-24)

| Function | Selector |
|----------|----------|
| SniperSearcher.executeSwap(address,address,uint256,bytes,uint256) | 0x68281967 |
| SniperSearcher.executeSwapWithDeadline(address,address,uint256,bytes,uint256,uint256) | 0x2628163f |
| FlashLoanReceiver.initiateFlashLoan(address,address,uint256,bytes,uint256) | 0x23c7f08e |
| DelegatedExecutor.executeSwap(address,address,uint256,bytes,uint256,uint256) | 0xf85b8959 |
| BEBE / ERC7821 execute(bytes32,bytes) | 0xe9ae5c53 |
| SwapRouter02 exactInput 4-field (Uni/Pancake) | 0xb858183f |
| Legacy ISwapRouter exactInput 5-field (Sushi) | 0xc04b8d59 |
