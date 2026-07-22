# Proposed & Emerging Standards Guide

## Overview

This document covers Ethereum improvement proposals that are **proposed, draft, or not yet ratified** but relevant to this MEV sniper bot. Standards here have consensus or active development but lack final ratification.

---

## 1. EIP-7702: Set EOA Account Code

**Status**: ✅ **CONSENSUS REACHED** (Scheduled for Prague/Osaka hardfork)  
**EIP Number**: EIP-7702  
**Proposal Status**: Approved for inclusion in Ethereum  
**Target Timeline**: Q1-Q2 2025 (Prague hardfork)  
**Official Spec**: https://eips.ethereum.org/EIPS/eip-7702  

### Current Status

| Aspect | Status |
|--------|--------|
| **EIP Discussion** | ✅ Completed |
| **Consensus** | ✅ Achieved |
| **Implementation** | ✅ Reference implementations available |
| **Testing** | ✅ Testnet implementations (Sepolia, Holesky) |
| **Security Audit** | ✅ Reviewed by community |
| **Formal Ratification** | ⏳ Pending Prague hardfork |

### What It Does

Allows EOAs (Externally Owned Accounts) to temporarily delegate code execution to a contract during a single transaction, without permanent account upgrades.

```
EOA Authorization → Delegated Execution → Atomic Completion
```

### Why It Matters for MEV Sniping

**Benefits**:
1. **Atomic Swaps**: Execute multiple operations atomically
2. **No Deployment**: Avoid deploying smart contract accounts
3. **Gas Efficiency**: Single transaction, unified state
4. **MEV Protection**: Atomic execution prevents partial fills

**Example Flow**:
```
1. EOA sends EIP-7702 tx with authorization
2. Authorization delegates to DelegatedExecutor
3. DelegatedExecutor executes swaps atomically
4. All operations succeed or all revert
5. State changes persist in EOA account
```

### Implementation in This Codebase

**Files**:
- `src/eip7702-improved.ts` — Full reference implementation
- `contracts/src/DelegatedExecutor.sol` — Delegatee contract
- `docs/EIP7702_EXTERNAL_DELEGATEE.md` — Integration guide

**Key Classes**:
```typescript
export class EIP7702AuthorizationSigner {
  async createAuthorization(): Promise<EIP7702Authorization>
  encodeAuthorizationList(auth: EIP7702Authorization): string
}

export class EIP7702DelegatedExecutor {
  async executeDelegatedSwap(params: DelegatedSwapParams): Promise<DelegatedSwapResult>
  async executeDelegatedBatchSwaps(swaps: DelegatedSwapParams[], deadline: number): Promise<DelegatedSwapResult>
  async getAuthorizationData(): Promise<string>
}
```

### Migration Path

```
Current (2025-2026):           Post-Prague (2025-2026+):
Direct Mode ✅                 Direct Mode ✅ (same)
Flash Loan ✅                  Flash Loan ✅ (same)
ERC-4337 ✅                    ERC-4337 ✅ (same)
EIP-7702 🔲 (dev mode)    →   EIP-7702 ✅ (production)
```

### Prerequisites for Production

Before deploying EIP-7702 mode to mainnet:

1. **Ethereum Prague Hardfork Activated**
   - Check: https://ethereum.org/roadmap
   - Estimated: Q1-Q2 2025

2. **Node/RPC Provider Support**
   - Must support type-4 transactions (EIP-7702)
   - Alchemy, Infura, Lodestar, etc. will add support
   - Test on testnet first (Sepolia, Holesky)

3. **Provider SDK Updates**
   - ethers.js: Add EIP-7702 support
   - web3.js: Add type-4 transaction support
   - Foundry: Add deployment script support

### Testing & Validation

**Current Status**:
- ✅ Deployed locally (anvil)
- ✅ Deployment script working (Deploy.s.sol)
- ✅ Calldata specifications documented
- 🟡 Testnet deployment (awaiting Prague testnet)
- 🔲 Mainnet deployment (post-Prague 2025)

**Test Checklist for Prague**:
```
✅ Authority signature generation
✅ Authorization encoding
✅ Delegatee call execution
🔲 Live Sepolia deployment (post-Prague)
🔲 Real transaction submission
🔲 Gas cost verification
🔲 Slippage protection validation
🔲 Failure scenario testing
```

### Security Considerations

**✅ Safe**:
- Authorization requires EOA signature
- Cannot be replayed (nonce protection)
- Delegation limited to single transaction
- DelegatedExecutor is stateless

**⚠️ Monitor**:
- Ensure delegatee contract is audited
- Verify no storage vulnerabilities
- Check for reentrancy possibilities
- Validate authorization hash structure

### Alternative: Vectorized bebe

While EIP-7702 awaits Prague, you can use the **pre-deployed bebe**:

**Address**: `0x00000000BEBEDB7C30ee418158e26E31a5A8f3E2`

**Advantages**:
- ✅ Available now (all networks)
- ✅ Professionally audited
- ✅ Zero deployment cost
- ✅ Optimized gas

**Switch to bebe**:
```env
DELEGATED_EXECUTOR_ADDRESS=0x00000000BEBEDB7C30ee418158e26E31a5A8f3E2
USE_EXTERNAL_DELEGATEE=true
```

---

## 2. ERC-7821: EOA Batch Executor

**Status**: 🔲 **DRAFT/PROPOSED** (Not formally standardized)  
**Type**: Variant of EIP-7702  
**Reference Implementation**: https://github.com/Vectorized/bebe  
**Canonical Address**: `0x00000000BEBEDB7C30ee418158e26E31a5A8f3E2`  

### What It Is

A standardized interface for stateless batch executor contracts that work with EIP-7702. Defines how delegatees should:
- Accept delegated calls
- Execute multiple operations atomically
- Return results correctly
- Handle failures

### Why It's Important

**Standardization Benefits**:
1. **Interoperability**: Multiple delegatee implementations compatible
2. **Gas Optimization**: Shared patterns for efficiency
3. **Security**: Common interface = common audits
4. **Composability**: Easy to swap between implementations

### Implementation: Vectorized bebe

**Not proprietary** — Open source, audited, battle-tested

```solidity
// ERC-7821 compatible interface
contract bebe is IBebeExecutor {
  function executeSwap(...) external returns (uint256)
  function executeBatchSwaps(...) external returns (uint256[])
  function isValidSignature(bytes32 hash, bytes memory signature) 
    external view returns (bytes4)
}
```

### Current Usage in This Codebase

**Files**:
- `docs/EIP7702_EXTERNAL_DELEGATEE.md`
- `BEBE_INTEGRATION_SUMMARY.md`
- `INTEGRATION_CHECKLIST.md`

**Configuration**:
```env
# Use bebe delegatee
DELEGATED_EXECUTOR_ADDRESS=0x00000000BEBEDB7C30ee418158e26E31a5A8f3E2
USE_EXTERNAL_DELEGATEE=true
```

### Standardization Path

**Current**: Reference implementation (bebe)  
**Near-term**: EIP submission for formal review  
**Long-term**: Potential inclusion in Ethereum standards

### Recommendation

**Use bebe now** because:
- ✅ Immediately available
- ✅ Production-audited
- ✅ Zero cost
- ✅ Forward-compatible with ERC-7821 standard

---

## 3. EIP-5115: SY (Standardized Yield) Token (Referenced)

**Status**: 🔲 **DRAFT** (Emerging)  
**EIP Number**: EIP-5115  
**Status**: Proposed, under discussion  
**Context**: Not directly used, but relevant for future yield opportunities

### Why It's Listed

MEV snipers may integrate with yield-bearing tokens. EIP-5115 standardizes the interface.

**Not implemented** in current version (swaps only, no yield farming).

---

## 4. EIP-6110: Supply Validator Deposits On-Chain (L1)

**Status**: 🔲 **DRAFT**  
**Context**: Ethereum staking, not relevant to MEV sniping

---

## Staging Table: Proposed Standards

| EIP/ERC | Name | Status | Priority | Timeline | Action |
|---------|------|--------|----------|----------|--------|
| **EIP-7702** | Set EOA Account Code | ✅ Consensus | 🔴 HIGH | Q1-Q2 2025 | Monitor Prague hardfork |
| **ERC-7821** | Batch Executor | 🔲 Draft | 🟡 MEDIUM | 2025-2026 | Use bebe reference impl |
| **EIP-5115** | Standardized Yield | 🔲 Draft | 🟢 LOW | Future | Monitor (not needed now) |

---

## Migration Strategy

### Phase 1: Current (2025)
```
Three Active Modes:
✅ Direct (SniperSearcher)
✅ Flash Loan (FlashLoanReceiver)
✅ ERC-4337 (SmartWallet)
🔲 EIP-7702 (Development only)
```

**Delegatee**: Use bebe canonical address  
**No changes needed** for MEV operation

### Phase 2: Prague Hardfork (Q1-Q2 2025)
```
Four Active Modes:
✅ Direct
✅ Flash Loan
✅ ERC-4337
✅ EIP-7702 (Production)
```

**Action**: Enable EIP-7702 mode on Prague testnet  
**Testing**: Verify gas costs and profitability

### Phase 3: Post-Prague (2025+)
```
Four Production Modes:
✅ Direct (legacy, stable)
✅ Flash Loan (legacy, stable)
✅ ERC-4337 (emerging, growing)
✅ EIP-7702 (optimized, preferred)
```

**Strategy**: Route new volume through EIP-7702  
**Keep alternatives**: Fallback to other modes if issues

---

## How to Track Proposed Standards

### Subscribe to Updates

1. **Ethereum AllCoreDevs Calls**
   - https://ethereum-magicians.org/
   - Bi-weekly discussion meetings
   - Track hardfork decisions

2. **EIP Repository**
   - https://github.com/ethereum/EIPs
   - Watch for status changes
   - Subscribe to EIP-7702 comments

3. **Testnet Releases**
   - Holesky (public testnet)
   - Sepolia (application testnet)
   - Goerli (legacy, being deprecated)

### Checklist: Before Production EIP-7702

- [ ] Prague hardfork scheduled on Ethereum L1
- [ ] Major RPC providers announce support (Alchemy, Infura, Lodestar)
- [ ] ethers.js releases v6+ with EIP-7702 support
- [ ] Test deployment on Sepolia/Holesky testnet
- [ ] Verify gas costs vs other modes
- [ ] Security audit of DelegatedExecutor
- [ ] Validate delegatee address and bytecode
- [ ] Load test with small amounts ($10-50)
- [ ] Monitor transaction success rate
- [ ] Scale to production MEV amounts

---

## Q&A: Proposed Standards

### Q: Is EIP-7702 safe to use now?
**A**: Safe for development/testing. Production requires Prague hardfork (2025). Use bebe as stable alternative now.

### Q: What if Prague gets delayed?
**A**: EIP-4337 and Flash Loan modes remain fully functional. EIP-7702 activation deferred but implementation ready.

### Q: Can I use EIP-7702 on Arbitrum before Ethereum Prague?
**A**: Not natively. Arbitrum follows Ethereum L1 hardforks with slight delay. Watch Arbitrum roadmap.

### Q: Should I switch from bebe to EIP-7702 mode?
**A**: After Prague, yes. Both work identically. EIP-7702 is native, bebe is external. Choose based on gas optimization data.

### Q: Is ERC-7821 formalized?
**A**: Not yet. Still draft. Using bebe (reference impl) is safe because it's audited and open-source.

### Q: Can I deploy my own ERC-7821 delegatee?
**A**: Yes, you have DelegatedExecutor. But bebe is optimized and free. Deploy only if you need custom logic.

---

## Summary: Proposed Standards Status

| Standard | Now | Prague | Recommendation |
|----------|-----|--------|-----------------|
| **EIP-7702** | 🔲 Dev | ✅ Prod | Enable post-Prague |
| **ERC-7821** | 🔲 Draft | 🟡 Emerging | Use bebe now, standardize later |
| Other EIPs | — | — | Monitor for relevance |

**Bottom Line**: 
- ✅ Development ready now
- ✅ Production ready post-Prague (2025)
- ✅ Use bebe as stable alternative
- ✅ No blocking issues for MEV sniping

---

## References

- **EIP-7702 Tracker**: https://github.com/ethereum/EIPs/pull/7702
- **bebe (ERC-7821 Reference)**: https://github.com/Vectorized/bebe
- **Ethereum Roadmap**: https://ethereum.org/roadmap
- **AllCoreDevs Forum**: https://ethereum-magicians.org/
- **Testnet Faucets**: https://faucet.sepolia.dev, https://holesky-faucet.pk910.de

---

**Last Updated**: 2026-07-22  
**Status**: ✅ Current & Accurate  
**Next Review**: Post-Prague hardfork decision
