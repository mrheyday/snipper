# Arbitrum Sniper Bot

A TypeScript-based sniper bot for Arbitrum that detects new token pools via Bitquery Events API and executes swaps using Uniswap SDK.

## Features

- **Real-time Pool Detection**: Monitors Uniswap V3 PoolCreated events on Arbitrum via Bitquery GraphQL API
- **Automated Swaps**: Executes swaps using Uniswap's AlphaRouter for optimal routing
- **Token Approval**: Automatically handles ERC20 approval when needed
- **Configurable Slippage**: Set custom slippage tolerance and transaction deadline

## Prerequisites

- Node.js 16+ with npm
- [Bitquery Free Developer Account](https://bitquery.io) with OAuth token
- Arbitrum wallet with:
  - Some Arbitrum ETH for transaction fees
  - WETH (or other tokens to trade) for swaps
- Arbitrum RPC endpoint (or use the default `https://arb1.arbitrum.io/rpc`)

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Edit `.env`:

```env
RPC=https://arb1.arbitrum.io/rpc
WALLET_PRIVATE_KEY=your_private_key_here
CHAIN_ID=42161
SWAP_ROUTER_ADDRESS=0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45
SLIPPAGE_TOLERANCE=5
DEADLINE_IN_MINUTES=30
BITQUERY_TOKEN=your_bitquery_oauth_token_here
```

### 3. Build

```bash
npm run build
```

### 4. Run

```bash
# Development (with ts-node)
npm run dev -- 0.001

# Production (compiled version)
npm start -- 0.001
```

Where `0.001` is the amount of WETH (or base token) to swap.

## How It Works

1. **Fetches Latest Pool**: Queries Bitquery Events API for the most recently created Uniswap V3 pool with WETH (0x82aF49447D8a07e3bd95BD0d56f35241523fBab1) as Token0
2. **Identifies Token1**: Extracts Token1 address from the pool creation event
3. **Validates Wallet**: Checks wallet has sufficient WETH balance for the swap
4. **Routes Swap**: Uses Uniswap AlphaRouter to find optimal swap path
5. **Approves & Swaps**:
   - Approves WETH spending if allowance insufficient
   - Executes swap with configured slippage and deadline
   - Waits for 3 confirmations before executing (optional)

## Customization

### Change Base Token

In `src/tokens.ts`, modify the WETH address in the query:

```graphql
Arguments: {startsWith: {Value: {Address: {is: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"}}}}
```

Replace with your desired base token address.

### Real-time Monitoring

Replace the GraphQL query with a subscription for real-time pool detection:

```graphql
subscription {
  EVM(network: arbitrum) {
    Events(
      orderBy: {descending: Block_Time}
      where: {Log: {Signature: {Name: {is: "PoolCreated"}}, SmartContract: {is: "0x1F98431c8aD98523631AE4a59f267346ea31F984"}}, Arguments: {startsWith: {Value: {Address: {is: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"}}}}}
    ) {
      # ... same fields
    }
  }
}
```

## ⚠️ Disclaimer

This material is for educational and informational purposes only. It is not investment advice. Readers should:

- Conduct their own research
- Understand smart contract risks
- Start with small amounts on testnet
- Use proper key management practices
- Monitor gas prices and slippage carefully

Trading with real funds carries significant risk. Use at your own risk.

## License

MIT

## References

- [Bitquery Documentation](https://docs.bitquery.io)
- [Uniswap SDK Documentation](https://docs.uniswap.org)
- [Arbitrum Network](https://arbitrum.io)
