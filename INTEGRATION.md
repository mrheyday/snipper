# Arbitrum Sniper Bot - Integration Guide

Complete flow from Bitquery pool detection → smart contract execution → profit withdrawal.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     TypeScript Bot (Node.js)                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  1. getTokens() ─→ Bitquery API                                 │
│     Detects latest Uniswap V3 pool creation events              │
│     Returns Token0 (WETH), Token1 (new token)                   │
│                                                                   │
│  2. Route Calculation                                            │
│     - Get AlphaRouter swap route                                │
│     - Estimate output amount                                    │
│     - Calculate slippage + min output                           │
│                                                                   │
│  3. Path Encoding (uniswap.ts)                                  │
│     - encodePath([WETH, Token1], [3000])                        │
│     - Creates bytes path for Uniswap V3                         │
│                                                                   │
│  4. Executor Call (executor.ts)                                 │
│     executor.executeSwap({                                      │
│       tokenIn: WETH,                                            │
│       amountIn: 0.001 ETH,                                      │
│       path: encoded path,                                       │
│       minAmountOut: calculated minimum                          │
│     })                                                           │
│                                                                   │
│  5. Gas Monitoring                                              │
│     - Estimate gas via contract                                 │
│     - Apply 10% buffer                                          │
│     - Wait 3 confirmations                                      │
│                                                                   │
│  6. Profit Extraction                                           │
│     executor.withdraw(Token1, walletAddress)                    │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│              Solidity Smart Contract (Arbitrum)                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  SniperSearcher.sol (0x...)                                     │
│                                                                   │
│  1. receiveTokens (WETH from bot)                               │
│  2. approve() Uniswap SwapRouter02                              │
│  3. exactInput() → Uniswap V3                                   │
│     Swap WETH → Token1                                          │
│  4. hold Token1 (profit)                                        │
│  5. transfer() Token1 back to bot wallet                        │
│                                                                   │
│  Gas: ~150-200k per swap (varies by pool complexity)            │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│              Uniswap V3 (Arbitrum Protocol)                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  SwapRouter02: 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45      │
│                                                                   │
│  1. Execute multi-hop route                                    │
│  2. Optimized pricing via AlphaRouter                           │
│  3. Handle slippage                                             │
│  4. Return output tokens                                        │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

## Usage Examples

### 1. Basic Pool Detection + Swap

```typescript
import { getTokens } from './tokens';
import { SniperExecutor } from './executor';
import { encodePath, calculateMinimumOutput } from './uniswap';
import { AlphaRouter, SwapType } from '@uniswap/smart-order-router';
import { CurrencyAmount, TradeType, Percent } from '@uniswap/sdk-core';
import { provider, signer, CHAIN_ID, SLIPPAGE_TOLERANCE, DEADLINE } from './config';

async function executeSnipe() {
  // 1. Detect pool
  const { Token0, Token1 } = await getTokens();
  if (!Token0 || !Token1) throw new Error('Tokens not found');

  const tokenFrom = Token0.token;
  const tokenTo = Token1.token;
  const tokenFromContract = Token0.contract;

  // 2. Get swap amount from CLI
  const amountIn = ethers.utils.parseUnits(process.argv[2], tokenFrom.decimals);
  const walletAddress = await signer.getAddress();

  // 3. Route calculation
  const router = new AlphaRouter({ chainId: CHAIN_ID, provider });
  const route = await router.route(
    CurrencyAmount.fromRawAmount(tokenFrom, amountIn.toString()),
    tokenTo,
    TradeType.EXACT_INPUT,
    {
      recipient: walletAddress,
      slippageTolerance: SLIPPAGE_TOLERANCE,
      deadline: DEADLINE,
      type: SwapType.SWAP_ROUTER_02,
    }
  );

  if (!route) throw new Error('No route found');

  // 4. Encode path
  const path = encodePath([tokenFrom.address, tokenTo.address], [3000]);
  const minOut = calculateMinimumOutput(route.quote, 0.5); // 0.5% slippage

  // 5. Execute via searcher contract
  const executor = new SniperExecutor(SNIPER_SEARCHER_ADDRESS, signer);
  const result = await executor.executeSwap({
    tokenIn: tokenFrom.address,
    amountIn: amountIn,
    path: path,
    minAmountOut: minOut,
  });

  if (!result.success) {
    console.error('Swap failed:', result.error);
    process.exit(1);
  }

  // 6. Withdraw profit
  const balance = await executor.getBalance(tokenTo.address);
  console.log(`💰 Profit: ${ethers.utils.formatUnits(balance, tokenTo.decimals)} ${tokenTo.symbol}`);

  const withdrawResult = await executor.withdraw(tokenTo.address, walletAddress);
  console.log(`Withdrawn to: ${walletAddress}`);
}

executeSnipe().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

### 2. Custom Deadline

```typescript
const deadline = Math.floor(Date.now() / 1000) + 60; // 60 seconds

const result = await executor.executeSwapWithDeadline({
  tokenIn: tokenAddress,
  amountIn: amount,
  path: encodedPath,
  minAmountOut: minOut,
  deadline: deadline,
});
```

### 3. Multi-Token Withdrawal

```typescript
const tokens = [tokenA.address, tokenB.address, tokenC.address];
const walletAddress = await signer.getAddress();

const result = await executor.withdrawAll(tokens, walletAddress);
console.log(`Withdrew ${tokens.length} tokens`);
```

### 4. Path Encoding & Validation

```typescript
import { encodePath, decodePath, validatePath, formatPath } from './uniswap';

// Encode a path
const tokens = ['0xWETH...', '0xToken1...', '0xToken2...'];
const fees = [3000, 500]; // WETH → Token1 (0.3%), Token1 → Token2 (0.05%)

if (!validatePath(tokens, fees)) {
  throw new Error('Invalid path');
}

const encoded = encodePath(tokens, fees);
console.log(`Path: ${formatPath(tokens, fees)}`);

// Decode a path
const { tokens: decodedTokens, fees: decodedFees } = decodePath(encoded);
console.log(decodedTokens, decodedFees);
```

## Configuration

### Environment Variables (.env)

```bash
# Wallet
WALLET_PRIVATE_KEY=0x...

# Arbitrum
RPC=https://arb1.arbitrum.io/rpc
CHAIN_ID=42161

# Uniswap V3
SWAP_ROUTER_ADDRESS=0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45

# Sniper
SNIPER_SEARCHER_ADDRESS=0x...  # Deployed SniperSearcher contract

# Slippage
SLIPPAGE_TOLERANCE=0.5  # 0.5%
DEADLINE_IN_MINUTES=30

# Bitquery
BITQUERY_TOKEN=...
```

### Contract Deployment

Before running the bot, deploy the SniperSearcher contract:

```bash
cd contracts
forge script script/Deploy.s.sol --rpc-url arbitrum --broadcast --verify
```

Update `.env` with the deployed `SNIPER_SEARCHER_ADDRESS`.

## End-to-End Flow

### Step 1: Bot Detects Pool

```
Bitquery API → PoolCreated event for WETH + NewToken
→ Extract TokenA (WETH), TokenB (NewToken)
```

### Step 2: Calculate Route

```
Uniswap AlphaRouter
→ Find best path: WETH → 3000 bps → NewToken
→ Quote: 0.001 WETH = 1,234.56 NewToken (before slippage)
→ Min output: 1,234.56 × (1 - 0.5%) = 1,228.31 NewToken
```

### Step 3: Encode Path

```
encodePath([WETH_ADDR, TOKEN_ADDR], [3000])
→ 0xWETH_ADDR + "0BB8" + TOKEN_ADDR  (0xBB8 = 3000 in hex)
→ Pass to executeSwap()
```

### Step 4: Execute Swap

```
SniperExecutor.executeSwap()
├─ Transfer 0.001 WETH from bot → SniperSearcher
├─ Approve SwapRouter02 for 0.001 WETH
├─ Call SwapRouter02.exactInput()
│  └─ Execute: WETH → 3000 bps pool → NewToken
│     └─ Receive 1,234.56 NewToken (if no sandwich)
└─ Hold NewToken in contract
```

### Step 5: Withdrawal

```
SniperExecutor.withdraw()
├─ Check balance: 1,234.56 NewToken in SniperSearcher
├─ Transfer to bot wallet
└─ Bot now owns 1,234.56 NewToken
```

## Gas & Economics

### Gas Costs (Arbitrum Sepolia/Mainnet)

- **executeSwap()**: ~150-200k gas
  - Token transfer: ~50k
  - Approve: ~50k
  - Uniswap swap: ~50-100k (depends on route complexity)
  
- **withdraw()**: ~50-70k gas
  - Token transfer: ~50k
  - Write to storage: ~10-20k

- **At 0.1 gwei gas (typical L2 price):**
  - 150k gas × 0.1 gwei = 0.000015 ETH ≈ $0.05
  - Very cheap on Arbitrum vs Ethereum

### Profitability Calculation

```
Entry: 0.001 WETH = $3.50 (assuming $3500/ETH)
Output: 1,234.56 NewToken
Gas cost: 0.000015 ETH ≈ $0.05

Breakeven: NewToken price ≈ $3.50 / 1234.56 ≈ $0.0028 per token
(Profit if token trades above breakeven before exit)
```

## Monitoring & Debugging

### Enable Verbose Logging

```typescript
executor.executeSwap(params); // Already logs:
// 📊 Executing swap...
//   Input: 0.001 tokens
//   Min output: 1228.31
//   Gas estimate: 175,000
// ✋ Transaction sent: 0x...
// ✅ Confirmed in block 12345678
//    Gas used: 168,450
```

### Check Contract Balance

```typescript
const balance = await executor.getBalance(tokenAddress);
console.log(`Contract holds: ${balance.toString()} wei`);
```

### Simulate Path

```typescript
const { tokens, fees } = decodePath(encodedPath);
console.log(`Simulating: ${formatPath(tokens, fees)}`);
```

## Security Considerations

1. **Private Key Management**
   - Never commit `.env` with real keys
   - Use hardware wallet when possible: `--ledger` flag

2. **Contract Limits**
   - Set max swap amount in bot
   - Implement timeouts
   - Monitor gas prices

3. **Sandwich Prevention**
   - Use private RPC (e.g., MEV protection service)
   - Set tight deadlines (30 seconds)
   - Use slippage protection

4. **Token Validation**
   - Check token contract code
   - Avoid honeypots
   - Review contract events

## Troubleshooting

### "No route found"
- Token pair doesn't have liquidity
- Fee tier mismatch (try [500, 3000, 10000])
- Wait for more liquidity after pool creation

### "Insufficient output"
- Sandwich attack occurred
- Slippage too low
- Pool moved while tx pending

### "Gas estimation failed"
- Contract not deployed at address
- Searcher contract owner ≠ signer
- RPC endpoint timeout

### "Transaction failed"
- Insufficient ETH for gas
- Approval failed
- Deadline passed

## Next Steps

1. **Deploy SniperSearcher** to Arbitrum Sepolia testnet
2. **Test with small amounts** (0.0001 WETH)
3. **Monitor logs** and adjust slippage
4. **Scale up** to Arbitrum mainnet with real funds
5. **Add monitoring** (Discord/Telegram alerts)
6. **Optimize gas** (batch withdrawals, cheaper routes)

## References

- [Full API Docs](./README.md)
- [Solidity Contracts](./contracts/README.md)
- [Uniswap V3 Protocol](https://docs.uniswap.org/contracts/v3/overview)
- [Arbitrum Docs](https://docs.arbitrum.io)
- [Bitquery GraphQL](https://docs.bitquery.io)

---

**Built with:** TypeScript + Foundry + Uniswap SDK v5 + Bitquery
