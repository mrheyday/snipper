# ABI & Interface

`Interface` is the low-level class behind every `Contract` — use it directly when you need to encode/decode calldata or logs without a live `Contract` instance (e.g. building calldata for a multicall, decoding logs from a raw `eth_getLogs` response, or parsing mempool transaction data).

## Creating an Interface

```typescript
import { Interface } from "ethers";

const iface = new Interface(abi); // Human-Readable string[] or JSON ABI array
// or, if you already have an Interface/ABI value of unknown shape:
const iface2 = Interface.from(value);
```

## Encoding calldata

```typescript
const data: string = iface.encodeFunctionData("transfer", [to, amount]);
// data is ready to drop straight into a TransactionRequest.data field

const decodedArgs = iface.decodeFunctionData("transfer", txData); // -> Result (array-like + named access)
```

## Decoding return data / errors

```typescript
const result = iface.decodeFunctionResult("balanceOf", rawReturnedBytes); // -> Result
const errorInfo = iface.decodeErrorResult("SomeCustomError", revertData);  // -> Result
```

For most call-and-decode flows, prefer letting `Contract` do this for you (`contracts.md`) — reach for raw `Interface` methods when you're not going through a `Contract` object at all.

## Parsing logs / events

```typescript
// From a raw receipt log: { data: string, topics: string[] }
const parsed = iface.parseLog(log); // -> LogDescription | null (null if the ABI doesn't recognize this log's topic0)

if (parsed) {
  console.log(parsed.name, parsed.args); // e.g. "Transfer", [from, to, amount]
}
```

`iface.hasEvent(key)` / `iface.hasFunction(key)` let you check membership by name, signature, or selector/topic hash before attempting to parse — useful when scanning logs from multiple contract types where not every log matches this ABI.

## AbiCoder (lowest level)

Only needed for encoding/decoding raw Solidity types outside the context of a specific function call (e.g. hashing struct data for EIP-712, or building non-standard calldata):

```typescript
import { AbiCoder } from "ethers";

const coder = AbiCoder.defaultAbiCoder(); // shared singleton

const encoded: string = coder.encode(["uint256", "address"], [amount, addr]);
const decoded = coder.decode(["uint256", "address"], data);
```

## Gotchas

- `Result` objects returned by decode methods are array-like (index access `result[0]`) **and** support named access for named ABI params (`result.amount`) — but only if the ABI fragment actually named that parameter. Don't assume named access always works; check the ABI or index by position defensively.
- `parseLog` returns `null` (not a throw) when the log's topic0 doesn't match any event in the ABI — always null-check before accessing `.name`/`.args`, especially when iterating logs from a transaction that touched multiple contracts.
- Overloaded functions need the full signature when looking them up ambiguously: `iface.getFunction("transfer(address,uint256)")` rather than just `"transfer"` if multiple overloads exist.
