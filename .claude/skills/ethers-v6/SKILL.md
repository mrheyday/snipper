---
name: ethers-v6
description: Authoritative reference for ethers.js v6 (tested against v6.17), the Ethereum/EVM JavaScript library. Use this whenever writing, reviewing, or debugging any code that imports from "ethers" — providers (JsonRpcProvider, WebSocketProvider, FallbackProvider), Contract/ContractFactory calls, Wallet/Signer/HDNodeWallet, BigInt-based math and unit conversion (parseEther, formatUnits), ABI encoding/decoding (Interface, AbiCoder), transactions including EIP-7702 type-4 "SetCode" transactions and authorization lists (signer.authorize, delegation designators, account abstraction via EOA code delegation), events/logs, or crypto utilities (keccak256, getAddress, solidityPacked). Also use this when migrating code from ethers v5 to v6 (BigNumber → BigInt, ethers.utils.* → flat exports, provider/signer API changes) — this project's package.json currently pins ethers ^5.8.0, so flag v5-vs-v6 API mismatches when they come up. Trigger on "ethers", "JsonRpcProvider", "parseUnits", "formatEther", "Contract(", "Wallet(", "BigNumber", "ethers v6", "EIP-7702", "type 4 transaction", "authorizationList", "delegated executor", or any Solidity/EVM interaction code written in TypeScript/JavaScript.
---

# ethers.js v6 Reference

Source of truth: https://docs.ethers.org/v6/single-page/ (verified against v6.17). Use this skill instead of relying on memory — ethers v5 and v6 have incompatible APIs and it's easy to write v5-flavored code (BigNumber, `.utils.*`, `ethers.providers.*`) that silently doesn't exist in v6.

## Project context

`snipper`'s `package.json` currently pins `"ethers": "^5.8.0"`. If you're asked to write or fix ethers code here without an explicit v6 migration in progress, check which major version is actually installed (`grep '"ethers"' package.json`) before assuming v6 APIs apply — v5 code should keep using `ethers.BigNumber`, `ethers.providers.JsonRpcProvider`, `ethers.utils.parseEther`, etc. If the user is migrating to v6, read `references/migration-v5-to-v6.md` first.

## The single most important v6 change

**`BigNumber` is gone.** All integer values (balances, gas, token amounts) are native ES2020 `bigint`. This cascades into everything:
- Literals use the `n` suffix: `1000n`, not `BigNumber.from(1000)`.
- Arithmetic uses real operators: `a + b`, `a * b`, `a >= b` — not `.add()`, `.mul()`, `.gte()`.
- `typeof value === "bigint"`, and `JSON.stringify` will throw on it unless you convert first.
- Division truncates toward zero like normal integer math (no separate `.div()` semantics to worry about).

Second most important change: **flat imports.** Everything is exported directly from `"ethers"` (and via `ethers/providers`, `ethers/contract`, etc. for tree-shaking) — there's no more `ethers.utils.*` or `ethers.providers.*` namespacing. `import { JsonRpcProvider, Contract, Wallet, parseEther, formatUnits, keccak256, getAddress } from "ethers"`.

## Reference index

Read the relevant file before writing non-trivial code in that area — each covers the real constructor signatures, method behavior, and gotchas, not just a happy-path snippet.

| Topic | File | Covers |
|---|---|---|
| Providers | `references/providers.md` | JsonRpcProvider, BrowserProvider, WebSocketProvider, FallbackProvider, network detection, polling, events |
| Contracts | `references/contracts.md` | Contract instantiation, read/write calls, `staticCall`, `populateTransaction`, ContractFactory, filters/events, `queryFilter` |
| Wallets & Signers | `references/wallets-signers.md` | Wallet, HDNodeWallet, mnemonics, signMessage/signTransaction/signTypedData, connecting to a provider, VoidSigner |
| BigInt & units | `references/bigint-units.md` | bigint arithmetic, formatEther/parseEther, formatUnits/parseUnits, FixedNumber |
| ABI & Interface | `references/abi-interface.md` | Interface, AbiCoder, encodeFunctionData/decodeFunctionResult, parseLog, Human-Readable ABI |
| Transactions | `references/transactions.md` | TransactionRequest/Response/Receipt, estimateGas, EIP-1559 fee fields, `tx.wait()`, nonce handling |
| Crypto & utils | `references/utils.md` | keccak256, id(), getAddress/isAddress, hexlify/getBytes, toUtf8Bytes, solidityPacked* |
| v5 → v6 migration | `references/migration-v5-to-v6.md` | Side-by-side API diffs for every breaking change — the fastest way to translate existing v5 code |

## Working conventions

- Prefer `parseUnits`/`formatUnits` over hand-rolled decimal math — token decimals vary, and these handle rounding/precision correctly.
- Contract read calls (`view`/`pure`) return typed values (bigint, string, etc.) directly; write calls return a `ContractTransactionResponse` — always `await tx.wait()` before treating a state change as final.
- When simulating a state-changing call without sending it (pre-flight checks, slippage/revert-reason probing), use `contract.method.staticCall(...)` rather than deploying a separate read-only wrapper.
- Errors from reverts, insufficient funds, gas mis-estimation etc. all come back as typed `EthersError` objects with a `.code` (e.g. `"CALL_EXCEPTION"`, `"INSUFFICIENT_FUNDS"`) — check `.code`, not string-matching `error.message`.
- Don't reintroduce v5 patterns (`.add()`, `ethers.utils.parseEther`, `ethers.providers.Web3Provider`) in new v6 code — grep for these as a quick self-check after writing ethers code.
