# DelegatedExecutor Calldata Specification

## Contract Address
`0x1258AcDc63a0A8dc617c69d51470631cd59daC6A` (local deployment)

## Functions Available for EIP-7702 Delegation

### 1. executeSwap() - Single Swap
```solidity
function executeSwap(
    address tokenIn,
    uint256 amountIn,
    bytes calldata path,
    uint256 minAmountOut,
    uint256 deadline
) external returns (uint256 amountOut)
```

**Calldata Structure:**
```
Function Selector: 0x107db2c4  // executeSwap(address,uint256,bytes,uint256,uint256)
Parameter Encoding:
  tokenIn           (address)  - Input token address (EIP-55 checksummed)
  amountIn          (uint256)  - Amount of input tokens
  path              (bytes)    - Uniswap V3 swap path (encoded)
  minAmountOut      (uint256)  - Minimum acceptable output
  deadline          (uint256)  - Block timestamp deadline
```

**Example Swap Calldata:**
```
0x414bf389
  000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e5831  // USDC
  0000000000000000000000000000000000000000000000000000000000989680  // 10M (10 USDC)
  00000000000000000000000000000000000000000000000000000000000000a0  // path offset
  0000000000000000000000000000000000000000000000000de0b6b3a7640000  // minAmountOut
  000000000000000000000000000000000000000000000000000000006779f1a0  // deadline
  0000000000000000000000000000000000000000000000000000000000000026  // path length (38 bytes)
  af88d065e77c8cc2239327c5edb3a432268e583100000bb8942590194fb1b5   // path data
  800026748c07dd0000000000000000000000000000                        // (continues)
```

### 2. executeBatchSwaps() - Batch Execution
```solidity
function executeBatchSwaps(
    tuple(
        address tokenIn,
        uint256 amountIn,
        bytes path,
        uint256 minAmountOut
    )[] swaps,
    uint256 deadline
) external returns (uint256[] amountOuts)
```

**Use Cases:**
- Execute multiple swaps in single transaction
- Atomically bundle multiple opportunities
- Reduce transaction overhead

### 3. executeSwapWithCallback() - Callback Integration
```solidity
function executeSwapWithCallback(
    address tokenIn,
    uint256 amountIn,
    bytes calldata path,
    uint256 minAmountOut,
    uint256 deadline,
    bytes calldata callbackData
) external returns (uint256 amountOut)
```

## EIP-7702 Authorization Encoding

When delegating to DelegatedExecutor via EIP-7702:

```
Authorization Structure:
├─ type: 0x04 (EIP-7702)
├─ authorizationList[]
│  ├─ address: 0x1258AcDc63a0A8dc617c69d51470631cd59daC6A (delegatee)
│  ├─ nonce: current_nonce
│  ├─ r: signature_r
│  ├─ s: signature_s
│  ├─ yParity: v_parity
└─ callData: <delegatee function call>
```

## Gas Costs (Estimated)

| Operation | Gas | Notes |
|-----------|-----|-------|
| executeSwap() | ~100k | Single swap execution |
| executeBatchSwaps(2) | ~150k | Two swaps batched |
| executeBatchSwaps(3) | ~190k | Three swaps batched |
| With approval | +20k | SafeTransferFrom cost |
| With WETH wrap | +15k | Native ETH wrapping |

## Security Properties

✅ **Atomic Execution**: All-or-nothing semantics via delegated call  
✅ **Signature Required**: EOA must sign authorization  
✅ **Revert Safe**: Failed swaps revert entire transaction  
⚠️ **Has storage**: owner / allowedEOAs mapping (not fully stateless)  
✅ **Gas Efficient**: Inline execution, no DELEGATECALL overhead  

## Integration with EIP-7702

```
1. EOA generates authorization signature
   hash = keccak256(0x05 || chainId || delegatee || nonce)
   sig = sign(hash)

2. Construct delegated call
   target: DelegatedExecutor
   callData: executeSwap(...) encoding

3. Bundle in EIP-7702 transaction
   authorizationList: [{ delegatee, nonce, r, s, yParity }]
   to: (any address, often delegatee or swap recipient)
   data: (delegated call data)

4. Send transaction
   All calls execute under delegatee context
   EOA retains control via authorization

5. Calldata Verification
   Can be decoded and validated before signing
```

## Calldata Decoding Example

```solidity
// Decode executeSwap calldata
function decodeSwapCall(bytes calldata data) 
  external pure returns (
    address tokenIn,
    uint256 amountIn,
    bytes memory path,
    uint256 minAmountOut,
    uint256 deadline
  ) 
{
  // Skip 4-byte selector
  (tokenIn, amountIn, path, minAmountOut, deadline) = 
    abi.decode(data[4:], (address, uint256, bytes, uint256, uint256));
}
```

## Network Deployment Status

| Network | Status | Address |
|---------|--------|---------|
| Anvil Local | ✅ Deployed | 0x1258AcDc63a0A8dc617c69d51470631cd59daC6A |
| Arbitrum Sepolia | 🟡 Ready | (awaiting deployment) |
| Arbitrum Mainnet | 🟡 Ready | (awaiting deployment) |

## Next Steps

1. ✅ Local deployment verified on anvil
2. 🔲 Deploy to Arbitrum Sepolia (testnet)
3. 🔲 Test with small swap amounts ($10-50)
4. 🔲 Verify gas costs vs profits
5. 🔲 Deploy to Arbitrum Mainnet (production)

## Related Standards

- **EIP-7702**: Set EOA Account Code (https://eips.ethereum.org/EIPS/eip-7702)
- **ERC-7821**: EOA Batch Executor (variant used by bebe)
- **EIP-1559**: Dynamic fee market (Arbitrum integration)
- **Uniswap V3**: SwapRouter02 interface (execution target)



## Router wiring (production-critical)

DelegatedExecutor and SniperSearcher call Uniswap V3 **SwapRouter02**:

- `exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum))`
- selector: `0xb858183f`

Do **not** use positional `exactInput(bytes,address,uint256,uint256)` (`0x11b69c46`) — wrong ABI.

### Flash path wiring

```
EOA --type4--> BEBE.execute([CALL FlashLoanReceiver.initiateFlashLoan])
  --> Aave.flashLoanSimple(receiver=Flash)
  --> Flash.executeOperation
      --> approve SniperSearcher
      --> SniperSearcher.executeSwap  (must be allowExecutor'd at deploy)
      --> path MUST round-trip to borrow asset
      --> approve Aave for amount+premium
```

### Selector cheat-sheet

| Function | Selector |
|----------|----------|
| SniperSearcher.executeSwap(address,uint256,bytes,uint256) | 0xdd824660 |
| SniperSearcher.executeSwapWithDeadline(...,uint256) | (see ABI) |
| FlashLoanReceiver.initiateFlashLoan(...) | 0xd4c4ca9b |
| BEBE / ERC7821 execute(bytes32,bytes) | 0xe9ae5c53 |
| SwapRouter02 exactInput(ExactInputParams) | 0xb858183f |
| DelegatedExecutor.executeSwap(...,deadline) | 0x107db2c4 |
