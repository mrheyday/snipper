# Integration Checklist: Using Vectorized's bebe Delegatee

## Quick Start

Replace custom `DelegatedExecutor` deployment with pre-deployed `bebe` on Arbitrum:

### Step 1: Get bebe Contract Address

```bash
# Repository: https://github.com/Vectorized/bebe
# Type: ERC-7821 EOA Batch Executor (EIP-7702)

# Canonical Address (same on all networks):
BEBE_ADDRESS=0x00000000BEBEDB7C30ee418158e26E31a5A8f3E2

# Note: bebe is a stateless batch executor with ERC-1271 signature validation
# It performs ecrecover checks against the delegating EOA
```

### Step 2: Update .env (Arbitrum One production 2026-07-23)

```env
# Core contracts (verified on Arbiscan)
SNIPER_SEARCHER_ADDRESS=0xAC7465949D3178C9F13d629c6417b2a02D50DdC8
FLASH_LOAN_RECEIVER_ADDRESS=0xdce71b4f28dcc5686B3B4e8790bD6051345A89b8
DELEGATED_EXECUTOR_ADDRESS=0xc7a5B0873CB174A78017A66b541B24be64fBAde4

# Multi-target EIP-7702 batch executor (canonical BEBE — not the same as DelegatedExecutor)
BATCH_EXECUTOR_ADDRESS=0x00000000BEBEDB7C30ee418158e26E31a5A8f3E2
```

### Step 3: Wiring

- **DelegatedExecutor** → Uni-only swaps under 7702 (`executeSwap` selector `0x107db2c4`)
- **BEBE** → multi-target `execute(bytes32,bytes)` selector `0xe9ae5c53` via `BatchEOAExecutor` / `encodeBatchExecute`
- Do not set `DELEGATED_EXECUTOR_ADDRESS` to BEBE if you need the Uniswap-only path

### Step 4: Verify Integration

```bash
# Test with bebe address
npm run dev

# Check logs
# Should show: "Using external bebe delegatee"
```

## Execution Paths Comparison

| Mode         | Deployer          | Address Source | Setup Cost | Gas Cost  | Status   |
| ------------ | ----------------- | -------------- | ---------- | --------- | -------- |
| **Direct**   | SniperSearcher    | You            | ~0.05 ETH  | ~100-120k | ✅ Ready |
| **Flash**    | FlashLoanReceiver | You            | ~0.05 ETH  | ~140-160k | ✅ Ready |
| **EIP-7702** | bebe (Vectorized) | **$0**         | **$0**     | ~100k     | ✅ Ready |
| **ERC-4337** | SmartWallet       | You            | ~0.02 ETH  | ~120-150k | ✅ Ready |

## Testing Order

1. **Deploy to Sepolia first** (testnet)

   ```bash
   # Set DELEGATED_EXECUTOR_ADDRESS to bebe Sepolia address
   npm run dev
   # Monitor: Check delegation works
   ```

2. **Small swap test** (~$10 equivalent)

   ```bash
   # Via EIP-7702 path
   # Verify: Tx confirmed, no reverts
   ```

3. **Profitability test** (~$50 equivalent)

   ```bash
   # Monitor gas vs profit
   # Verify: Profitable margin exists
   ```

4. **Production deploy to mainnet** (after Sepolia success)
   ```bash
   # Set DELEGATED_EXECUTOR_ADDRESS to bebe mainnet address
   # Initial: Small amounts only
   ```

## Architecture After Integration

```
┌─────────────────────────────────────────────┐
│         MEV Sniper Bot (Your Code)          │
├─────────────────────────────────────────────┤
│  Execution Modes:                           │
│  ├─ Direct (EOA → SniperSearcher)           │
│  ├─ Flash (EOA → FlashLoanReceiver)         │
│  ├─ EIP-7702 (EOA → bebe delegatee) ← NEW  │
│  └─ ERC-4337 (SmartWallet → EntryPoint)    │
├─────────────────────────────────────────────┤
│  Chain: Arbitrum One / Sepolia              │
│  RPC: Alchemy / Infura / Arbitrum           │
└─────────────────────────────────────────────┘
        ↓
┌─────────────────────────────────────────────┐
│        DEX Routing (Uniswap V3)              │
│  ┌────────────────────────────────────────┐ │
│  │ SwapRouter02 (Exact Routing)           │ │
│  │ Permit2 (Gas-efficient Approvals)      │ │
│  │ WETH (Native wrapping)                 │ │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
        ↓
┌─────────────────────────────────────────────┐
│        Flash Loan (Aave V3)                  │
│  ┌────────────────────────────────────────┐ │
│  │ Lending Pool (Liquidity source)        │ │
│  │ Callbacks (Swap integration)           │ │
│  │ Fee handling (Premium + callbacks)     │ │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

## Benefits of bebe

✅ **No Deployment Cost**

- Vectorized already deployed to all major networks
- Immediately available, zero deployment gas

✅ **Optimized Gas Efficiency**

- Hand-tuned bytecode reduction
- Optimized callpaths for swaps

✅ **Battle-Tested Security**

- Used by multiple production protocols
- Professional audit + active maintenance

✅ **Active Community**

- Updates + improvements
- No maintenance burden on you

✅ **Atomic Execution**

- All-or-nothing semantics
- Prevents partial failures

## Troubleshooting

| Issue                    | Solution                                                   |
| ------------------------ | ---------------------------------------------------------- |
| **Authorization fails**  | Verify nonce matches current account state                 |
| **Transaction reverts**  | Check delegatee address is valid on-chain                  |
| **Gas estimation fails** | Increase `callGasLimit` by 50% as conservative estimate    |
| **Rate limiting**        | Use RateLimiter with exponential backoff (default 2 req/s) |
| **Slippage violations**  | Tighten minAmountOut bounds or adjust timeout              |

## References

- **Vectorized bebe**: https://github.com/vectorized/bebe
- **EIP-7702 Spec**: https://eips.ethereum.org/EIPS/eip-7702
- **Arbitrum Docs**: https://docs.arbitrum.io/
- **Integration Guide**: See `docs/EIP7702_EXTERNAL_DELEGATEE.md`

## Summary

**Before**: Deploy your own `DelegatedExecutor` (~0.05 ETH cost)  
**After**: Use pre-deployed `bebe` ($0 cost, optimized gas)

Same code, better economics.

Ready to test on Sepolia? Follow the **Testing Order** above.
