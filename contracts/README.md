# Arbitrum Sniper Bot Contracts

Solidity smart contracts for MEV searcher execution on Arbitrum using Foundry.

## Contracts

### SniperSearcher.sol

Core MEV searcher contract that:
- Receives tokens from the bot
- Executes swaps on Uniswap V3 SwapRouter02
- Manages profits and withdrawals
- Owner-controlled operations

**Key Features:**
- `executeSwap()` — Execute exact-input swap with 30-second deadline
- `executeSwapWithDeadline()` — Execute swap with custom deadline
- `withdraw()` — Withdraw specific token amount
- `withdrawAll()` — Withdraw all tokens in one transaction
- `getBalance()` — Check token balance
- Receive ETH for gas refunds

**Security:**
- Only owner can execute swaps and withdraw
- SafeERC20 for safe token transfers
- Input validation for amounts and paths
- Custom errors for gas efficiency

## Testing

```bash
# Run all tests
forge test

# Run with verbose output
forge test -vvv

# Run specific test
forge test --match-test test_Deployment

# With gas report
forge test --gas-report
```

**Test Coverage:**
- ✓ Deployment initialization
- ✓ Unauthorized caller reversion
- ✓ Token withdrawal
- ✓ Multi-token withdrawal
- ✓ Balance checking
- ✓ ETH receipt
- ✓ Fuzz testing (withdraw amounts)

## Deployment

### Arbitrum Mainnet

```bash
export PRIVATE_KEY=0x...
export ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc
export ARBISCAN_API_KEY=...

forge script script/Deploy.s.sol --rpc-url arbitrum --broadcast --verify
```

### Arbitrum Sepolia Testnet

```bash
export ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc

forge script script/Deploy.s.sol --rpc-url arbitrum_sepolia --broadcast --verify
```

**Uniswap V3 SwapRouter02 Addresses:**
- Arbitrum Mainnet: `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`
- Arbitrum Sepolia: `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`

## Integration with Bot

The TypeScript bot (`../src/`) calls the searcher contract:

1. **Detection**: Bot detects new pool via Bitquery
2. **Route**: Calculates swap path and amounts
3. **Contract Call**: Executes `executeSwap()` on searcher
4. **Settlement**: Contract sends output tokens back to bot
5. **Withdrawal**: Bot withdraws profits to wallet

## Development

```bash
# Build
forge build

# Lint
forge lint

# Format
forge fmt

# Coverage
forge coverage
```

## Configuration

See `foundry.toml` for:
- Solidity version (0.8.36)
- EVM target (Osaka)
- Optimizer settings (runs: 200)
- Test configuration
- RPC endpoints
- Etherscan API keys

## Security Considerations

⚠️ **Before mainnet deployment:**

1. **Audit**: Have contracts reviewed by security firm
2. **Testing**: Run full test suite on forked Arbitrum
3. **Limits**: Set max swap amounts in bot
4. **Keys**: Never commit `.env` with real keys
5. **Reentrancy**: Contracts use SafeERC20; review for custom tokens
6. **Gas**: Monitor gas prices; set appropriate limits

## References

- [Foundry Book](https://book.getfoundry.sh)
- [Solidity 0.8.36 Docs](https://docs.soliditylang.org)
- [Uniswap V3 Protocol](https://docs.uniswap.org/contracts/v3/overview)
- [Arbitrum Docs](https://docs.arbitrum.io)
- [OpenZeppelin Contracts](https://docs.openzeppelin.com/contracts/)

## License

MIT
