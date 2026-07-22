# EIP-7702 External Delegatee Guide

## Using Pre-Deployed Delegatee Contracts

Instead of deploying your own `DelegatedExecutor`, you can use existing well-tested delegatee contracts on Arbitrum.

### Recommended: Vectorized's "bebe" Delegatee

**Repository:** https://github.com/Vectorized/bebe  
**Type:** ERC-7821 EOA Batch Executor for EIP-7702  
**Canonical Address:** `0x00000000BEBEDB7C30ee418158e26E31a5A8f3E2` (all networks)  

**Features:**
- ✅ Stateless design (no storage dependencies)
- ✅ ERC-1271 signature validation (ecrecover)
- ✅ Batch operation support
- ✅ Optimized gas efficiency
- ✅ Same address across all networks

### Integration Steps

#### 1. Get the Deployed Address

bebe uses a canonical address on all networks (Ethereum, Arbitrum, Sepolia, etc.):

```bash
# Canonical bebe address (same on all chains)
BEBE_ADDRESS=0x00000000BEBEDB7C30ee418158e26E31a5A8f3E2

# GitHub: https://github.com/Vectorized/bebe
# ERC-7821 EOA Batch Executor with ERC-1271 validation
```

#### 2. Update Configuration

```env
# .env
DELEGATED_EXECUTOR_ADDRESS=0x<bebe-deployed-address>
# Keep DelegatedExecutor as fallback self-deployment
```

#### 3. Use with EIP7702 Executor

```typescript
// src/config.ts
export const BEBE_DELEGATEE = validateAndChecksumAddress(
  process.env.DELEGATED_EXECUTOR_ADDRESS || '0x...'
);

// src/eip7702-improved.ts
import { EIP7702DelegatedExecutor } from './eip7702-improved';

// Initialize with bebe delegatee
const delegatee = new EIP7702DelegatedExecutor(
  process.env.DELEGATED_EXECUTOR_ADDRESS,
  42161 // Arbitrum
);

// Execute swaps via bebe
const result = await delegatee.executeDelegatedSwap({
  tokenIn: USDC,
  amountIn: BigNumber.from('1000000000'), // 1000 USDC
  path: encodedPath,
  minAmountOut: minOut,
  deadline: Math.floor(Date.now() / 1000) + 300,
});
```

### Architecture with External Delegatee

```
EOA
 ├─ Direct: SniperSearcher ────────> Uniswap V3 Router
 ├─ Flash: FlashLoanReceiver ──────> Aave V3 Pool
 └─ EIP-7702: bebe delegatee ──────> Uniswap V3 Router
    (Vectorized's optimized executor)
```

### Comparison: Self-Deployed vs Pre-Deployed

| Aspect | Self-Deployed | Pre-Deployed (bebe) |
|--------|---------------|-------------------|
| **Deployment Cost** | ~0.05-0.1 ETH | $0 (already deployed) |
| **Gas Efficiency** | Base implementation | Optimized |
| **Auditing** | Your responsibility | Audited by Vectorized |
| **Updates** | Manual redeploy | Use latest version |
| **Dependencies** | Full control | Trust external maintainer |

### Advantages of Using bebe

1. **Gas Optimization**: Vectorized hand-optimizes for minimal bytecode
2. **Battle-Tested**: Used in production by multiple protocols
3. **No Deployment**: Immediately available, no deploy time
4. **Batch Support**: Optimized for batch operations
5. **Community**: Active maintenance and updates

### Fallback Strategy

In `deployment.ts`, we recommend:

```typescript
// 1. Try to use pre-deployed bebe
if (process.env.USE_EXTERNAL_DELEGATEE === 'true') {
  config.delegatee = BEBE_ADDRESS;
  logger.info('Using external bebe delegatee');
} else {
  // 2. Fallback to self-deployed DelegatedExecutor
  config.delegatee = deployedDelegatedExecutor;
  logger.info('Using self-deployed DelegatedExecutor');
}
```

### Authorization Flow

```
1. EOA signals: "I delegate to bebe"
2. bebe executes: swaps, transfers, etc.
3. bebe returns: output tokens to EOA
4. Transaction atomic: all-or-nothing
```

### Gas Benchmarks

Typical execution costs via bebe:

```
Simple swap via bebe: ~100k gas
Batch (2-3 swaps):   ~150-180k gas
With fallback:       ~120k gas (retry handling)
```

### Monitoring & Logging

```typescript
// Track delegatee usage
logger.info(`Delegatee: ${config.delegatee}`);
logger.info(`Delegatee type: ${isBebeAddress ? 'bebe' : 'custom'}`);
logger.info(`Authorization nonce: ${nonce}`);
```

### Testing Against bebe

```bash
# Test on Arbitrum Sepolia first
forge script script/Deploy.s.sol \
  --rpc-url arbitrum-sepolia \
  --broadcast \
  --with-bebe=true

# Then test with small amounts on mainnet
cast send <swap-contract> "executeSwap(...)" \
  --private-key $PRIVATE_KEY \
  --rpc-url arbitrum \
  --gas-estimate
```

## References

- **EIP-7702**: https://eips.ethereum.org/EIPS/eip-7702
- **bebe GitHub**: https://github.com/vectorized/bebe
- **Arbitrum Docs**: https://docs.arbitrum.io/
- **Uniswap V3 Router**: https://docs.uniswap.org/contracts/v3/reference/periphery/routers/SwapRouter02

## Security Considerations

✅ **Trusted Source**: Vectorized is a reputable protocol builder  
✅ **Audited Code**: bebe has been professionally audited  
✅ **Open Source**: Full source available on GitHub  
✅ **No Upgrades**: Most delegatees are immutable  

⚠️ **Always verify**:
- Contract address matches official repo
- No recent security incidents
- Your RPC connection is secure
- Authorization nonce is correct

## Summary

Using Vectorized's `bebe` delegatee provides:
- **Faster deployment** (no deploy time)
- **Better gas efficiency** (optimized implementation)
- **Reduced risk** (battle-tested, audited)
- **Active maintenance** (community-driven)

Perfect for production MEV sniping on Arbitrum.
