# Providers

A Provider is a read-only connection to the blockchain (or an aggregate of several). All provider classes implement the common `Provider` interface, so code written against the interface works regardless of which concrete provider is used.

## Common constructors

```typescript
import { JsonRpcProvider, BrowserProvider, WebSocketProvider, FallbackProvider, AlchemyProvider, InfuraProvider } from "ethers";

// HTTP/HTTPS JSON-RPC — most common for backends/bots
const provider = new JsonRpcProvider(url?: string | FetchRequest, network?: Networkish, options?: JsonRpcApiProviderOptions);

// Wraps an injected EIP-1193 provider (e.g. window.ethereum) — browser dApps
const browserProvider = new BrowserProvider(ethereum: Eip1193Provider, network?: Networkish, options?: BrowserProviderOptions);
// EIP-6963 multi-wallet discovery:
const discovered = await BrowserProvider.discover(options?: BrowserDiscoverOptions); // -> BrowserProvider | null

// Persistent WebSocket connection — use when you need live event subscriptions
const wsProvider = new WebSocketProvider(url: string | WebSocketLike | WebSocketCreator, network?: Networkish, options?);

// Aggregates multiple providers, weights/quorum-checks responses for resilience
const fallback = new FallbackProvider(providers: Array<AbstractProvider | FallbackProviderConfig>, network?: Networkish, options?);
```

If you omit `network`, ethers auto-detects it from the endpoint on first use. Passing it explicitly skips that round trip and is recommended for anything long-running (bots, servers) — it also lets ethers assert the endpoint matches the expected chain instead of silently connecting to the wrong one.

## Core read methods

All of these exist on any `Provider`:

```typescript
await provider.getNetwork();                       // -> Network { chainId, name }
await provider.getBlockNumber();                    // -> number
await provider.getBlock(blockHashOrTag);             // -> Block | null
await provider.getTransaction(hash);                  // -> TransactionResponse | null
await provider.getTransactionReceipt(hash);           // -> TransactionReceipt | null
await provider.waitForTransaction(hash, confirms?, timeout?); // -> TransactionReceipt | null
await provider.getBalance(addressOrName, blockTag?);  // -> bigint (wei)
await provider.getTransactionCount(address, blockTag?); // -> number (nonce)
await provider.getCode(address, blockTag?);            // -> string (hex bytecode)
await provider.getStorage(address, position, blockTag?);
await provider.estimateGas(tx: TransactionRequest);     // -> bigint
await provider.call(tx: TransactionRequest);             // -> string (raw return data)
await provider.getFeeData();                             // -> FeeData { gasPrice, maxFeePerGas, maxPriorityFeePerGas }
await provider.broadcastTransaction(signedTx: string);   // -> TransactionResponse
```

`getBalance`/`getTransactionCount`/etc. accept ENS names anywhere an address is expected, on networks with ENS support (mainnet). Don't assume ENS resolution works on L2s like Arbitrum — pass raw addresses there.

## Getting a Signer from a provider

`JsonRpcProvider`-family providers can hand you a `JsonRpcSigner` for an account the node itself manages (rare outside local dev nodes / Anvil / Hardhat):

```typescript
const signer = await provider.getSigner(address?: number | string); // -> Promise<JsonRpcSigner>
const managed = await provider.hasSigner(address);                   // -> boolean
```

For a bot/backend controlling its own key, use a `Wallet` connected to the provider instead — see `wallets-signers.md`.

## Events

Providers/contracts share an `EventEmitter`-like API:

```typescript
provider.on("block", (blockNumber) => { /* new block */ });
provider.on(filter, listener); // filter = address, topics, or an object { address, topics }
provider.once(event, listener);
provider.off(event, listener);
provider.removeAllListeners(event?);
```

WebSocketProvider delivers these near-instantly via the live socket; JsonRpcProvider polls (`provider.pollingInterval`, default ~4s) — for latency-sensitive event handling (e.g. sniping/MEV-adjacent code), prefer WebSocketProvider or a dedicated log-subscription endpoint over polling.

## Gotchas

- `provider.getFeeData().lastBaseFeePerGas` **does not exist** in v6 (v5 had it). Get the current base fee from `(await provider.getBlock("latest")).baseFeePerGas` instead, or just use `feeData.maxFeePerGas`, which already factors it in.
- All provider network calls are async and return bigint for anything wei/gas-denominated — never assume `number`.
- `FallbackProvider` quorum defaults can cause slower responses than a single provider; tune `options.quorum` if you need lower latency and can tolerate less cross-checking.
