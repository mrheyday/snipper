# Arbitrum Sniper Bot - Complete Setup Guide

Production-ready MEV sniper bot with three execution modes: direct swaps, flash loans, and EIP-7702 delegation.

## Prerequisites

- Node.js 18+
- Arbitrum wallet with ETH for gas + tokens to swap
- Bitquery API token (free tier available)
- RPC endpoint for Arbitrum (or use default)

## 1. Installation

```bash
# Clone and install
cd arbitrum-sniper-bot
npm install

# Or with bun
bun install
```

## 2. Contract Deployment

Deploy Solidity contracts to Arbitrum:

```bash
cd contracts

# Arbitrum Mainnet
forge script script/Deploy.s.sol \
  --rpc-url arbitrum \
  --broadcast \
  --verify

# Or Arbitrum Sepolia testnet
forge script script/Deploy.s.sol \
  --rpc-url arbitrum_sepolia \
  --broadcast \
  --verify
```

**Save the deployed addresses** from the output.

## 3. Environment Configuration

Copy template and fill in values:

```bash
cp .env.example .env
```

Edit `.env`:

```bash
# Wallet
WALLET_PRIVATE_KEY=0x...                        # Your Arbitrum wallet private key

# RPC
RPC=https://arb1.arbitrum.io/rpc               # Arbitrum RPC (or custom)
CHAIN_ID=42161                                  # Arbitrum mainnet

# Uniswap
SWAP_ROUTER_ADDRESS=0x68b3465833fb72A70...    # Uniswap V3 SwapRouter02

# Contracts (from deployment)
SNIPER_SEARCHER_ADDRESS=0x...                  # Deployed SniperSearcher
FLASH_LOAN_RECEIVER_ADDRESS=0x...              # Deployed FlashLoanReceiver
DELEGATED_EXECUTOR_ADDRESS=0x...               # Deployed DelegatedExecutor

# Slippage & Timing
SLIPPAGE_TOLERANCE=0.5                         # 0.5% slippage tolerance
DEADLINE_IN_MINUTES=30                         # Transaction deadline

# Bitquery
BITQUERY_TOKEN=...                             # Get from https://bitquery.io
```

## 4. Quick Test (Testnet)

Test on Arbitrum Sepolia first:

```bash
# 1. Get testnet ETH and tokens from faucet
# https://sepoliafaucet.com (ETH)
# https://www.uniswap.org/faucet (tokens)

# 2. Update .env with Sepolia addresses
# CHAIN_ID=421614
# RPC=https://sepolia-rollup.arbitrum.io/rpc

# 3. Run bot
bun dev -- 0.001  # Swap 0.001 ETH worth of tokens
```

## 5. Production Deployment (Mainnet)

When ready for real funds:

```bash
# 1. Update .env with mainnet addresses
# CHAIN_ID=42161
# RPC=https://arb1.arbitrum.io/rpc

# 2. Fund wallet
# Send WETH or tokens to your wallet

# 3. Run bot
bun dev -- 0.001  # Start with small amount
```

## 6. Execution Modes

Bot automatically selects the best mode:

### Mode 1: Direct (Pre-deployed Contract)
- **When**: Capital available, persistent trades
- **Capital**: Required upfront
- **Fee**: 0% (only gas)
- **Gas**: ~150k
- **Best for**: Frequent trading

### Mode 2: Flash Loan (Aave V3)
- **When**: Zero capital, high profit
- **Capital**: Not required
- **Fee**: 0.09% of borrowed amount
- **Gas**: ~500k
- **Best for**: One-shot arbitrage, low capital

### Mode 3: EIP-7702 (Delegated Code)
- **When**: One-time opportunities, privacy
- **Capital**: Required but returned after tx
- **Fee**: 0% (only gas)
- **Gas**: ~150k
- **Best for**: Fleeting opportunities, discrete execution

Bridge automatically selects optimal mode and falls back if needed.

## 7. Running the Bot

```bash
# Single swap
bun dev -- 0.001

# Or run main.ts directly
ts-node src/main.ts 0.001

# With debugging
DEBUG=1 bun dev -- 0.001
```

**Output example:**
```
[2026-07-22T14:30:00.000Z] ℹ️  [SniperBot] Starting Arbitrum Sniper Bot
[2026-07-22T14:30:00.100Z] ✅ [SniperBot] RPC connected (block 12345678)
[2026-07-22T14:30:00.200Z] ✅ [SniperBot] Wallet: 0x...
[2026-07-22T14:30:01.000Z] ℹ️  [SniperBot] Detecting latest Uniswap V3 pool...
[2026-07-22T14:30:02.000Z] ℹ️  [SniperBot] Pool detected: WETH → NEWTOKEN
[2026-07-22T14:30:02.500Z] ℹ️  [SniperBot] Calculating optimal swap route...
[2026-07-22T14:30:03.000Z] ℹ️  [SniperBot] Route calculated: 1234.56 NEWTOKEN
[2026-07-22T14:30:03.100Z] ℹ️  [SniperBot] Estimated profit: 234.56 NEWTOKEN
[2026-07-22T14:30:03.200Z] ℹ️  [SniperBot] Executing swap via execution bridge...
[2026-07-22T14:30:03.300Z] 🌉 [ExecutionBridge] Execution Bridge - Optimal Strategy
[2026-07-22T14:30:03.400Z] 🌉 [ExecutionBridge] Selected mode: flash_loan
[2026-07-22T14:30:04.000Z] ✅ [SniperBot] Swap successful!
[2026-07-22T14:30:04.100Z]   Mode: flash_loan
[2026-07-22T14:30:04.200Z]   Tx: 0x...
[2026-07-22T14:30:04.300Z]   Gas: 487,234
[2026-07-22T14:30:04.400Z]   Profit: 234.56 NEWTOKEN
```

## 8. Monitoring & Logs

```bash
# View debug logs
DEBUG=1 bun dev -- 0.001

# Filter logs by type
DEBUG=1 bun dev -- 0.001 2>&1 | grep "✅"  # Success only
DEBUG=1 bun dev -- 0.001 2>&1 | grep "⚠️"  # Warnings
DEBUG=1 bun dev -- 0.001 2>&1 | grep "❌"  # Errors
```

## 9. Safety Checks

Before running on mainnet:

- [ ] Test on Sepolia with small amounts
- [ ] Verify all contract addresses
- [ ] Check wallet has sufficient gas ETH
- [ ] Review slippage settings (0.5% is aggressive)
- [ ] Ensure private key is secure
- [ ] Test withdrawal flow
- [ ] Monitor gas prices
- [ ] Start with small swap amounts

## 10. Troubleshooting

### "No route found"
- Tokens don't have sufficient liquidity
- Try different token pair
- Check pool freshness (pool just created)

### "Insufficient output"
- Sandwich attack occurred
- Slippage too low (increase to 1%)
- Pool moved while tx pending

### "Not enough ETH for gas"
- Fund wallet with more ETH
- Check gas prices (may spike during congestion)
- Try flash loan mode (0 capital required)

### "Invalid swap path"
- Token addresses incorrect
- Fee tier unsupported
- Pool doesn't exist

### "All execution modes failed"
- Check all contract addresses
- Verify contracts deployed correctly
- Check Aave V3 availability
- Review RPC connection

## 11. Advanced Configuration

### Custom Slippage
```bash
# Edit .env
SLIPPAGE_TOLERANCE=1.0  # 1% (less aggressive)
```

### Custom Deadline
```bash
# Edit .env
DEADLINE_IN_MINUTES=60  # 60 seconds to execute
```

### Force Execution Mode
```typescript
// In bridge.ts
bridge.setPreferredMode(ExecutionMode.FLASH_LOAN);  // Always use flash loans
```

### Multi-Chain
```bash
# Update .env
CHAIN_ID=8453  # Base
RPC=https://mainnet.base.org

# Deploy to Base (same contracts work)
forge script script/Deploy.s.sol --rpc-url base --broadcast
```

## 12. Production Best Practices

- **Use hardware wallet**: `--ledger` flag for secure signing
- **Monitor gas**: Set max gas price limits
- **Private RPC**: Use MEV-protected RPC (Flashbots, MEV-Blocker)
- **Rate limiting**: Don't spam Bitquery (free tier: 1 req/sec)
- **Logging**: Log all executions to file for audit trail
- **Monitoring**: Set up alerts for failures
- **Incremental**: Start small, scale up gradually

## 13. Support & Resources

- **Docs**: See [INTEGRATION.md](./INTEGRATION.md)
- **Contract Docs**: See [contracts/README.md](./contracts/README.md)
- **Errors**: Check logs with `DEBUG=1`
- **Community**: Arbitrum Discord, Uniswap Discord

## 14. API Reference

```typescript
// Initialize bridge
const bridge = new ExecutionBridge({
  sniperSearcherAddress: '0x...',
  flashLoanReceiverAddress: '0x...',
  delegatedExecutorAddress: '0x...',
});

// Execute swap
const result = await bridge.executeOptimal({
  tokenIn: '0x...',
  tokenOut: '0x...',
  amountIn: BigNumber.from('1000000000000000000'),
  path: encodePath([tokenIn, tokenOut], [3000]),
  minAmountOut: calculateMinimumOutput(quote, 0.5),
  deadline: Math.floor(Date.now() / 1000) + 300,
  estimatedProfit: profit,
});

// Check execution stats
const stats = await bridge.getExecutionStats();
console.log(stats.flashLoanReady);  // true
console.log(stats.balance);         // 10 ETH
```

## 15. Deployment Checklist

- [ ] Contracts deployed to Arbitrum
- [ ] Environment variables configured
- [ ] RPC endpoint tested
- [ ] Wallet funded and verified
- [ ] Bitquery token configured
- [ ] Bot tested on testnet
- [ ] Safety checks completed
- [ ] Monitoring in place
- [ ] Backup plan documented
- [ ] Ready for production

---

**You're ready!** Run `bun dev -- 0.001` to start sniping opportunities on Arbitrum.

Questions? Check [INTEGRATION.md](./INTEGRATION.md) for detailed architecture and examples.
