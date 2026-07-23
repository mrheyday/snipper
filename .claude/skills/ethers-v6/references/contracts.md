# Contracts

## Instantiation

```typescript
import { Contract } from 'ethers';

const abi = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address a) view returns (uint)',
  'function transfer(address to, uint amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint amount)',
];

// Read-only: pass a Provider
const readContract = new Contract(address, abi, provider);

// Read-write: pass a Signer (a Wallet connected to a provider, typically)
const writeContract = new Contract(address, abi, signer);
```

The ABI can be a Human-Readable ABI (array of Solidity-like signature strings, as above), a JSON ABI array from Foundry/Hardhat artifacts, or an `Interface` instance. Prefer passing the full JSON ABI from build artifacts over hand-writing Human-Readable strings when one is available — it's less error-prone for structs/tuples.

## Calling methods

```typescript
// view/pure functions resolve directly to typed values
const sym: string = await readContract.symbol();
const decimals: bigint = await readContract.decimals(); // note: bigint even for uint8
const balance: bigint = await readContract.balanceOf(someAddress);

// state-changing functions return a ContractTransactionResponse — always await .wait()
const tx = await writeContract.transfer(to, amount);
const receipt = await tx.wait(); // ContractTransactionReceipt | null
```

Every contract method also exposes sub-methods for lower-level control:

```typescript
await contract.transfer.staticCall(to, amount); // simulate without sending — needs only read access
await contract.transfer.estimateGas(to, amount); // -> bigint
await contract.transfer.populateTransaction(to, amount); // -> TransactionRequest (unsent, unsigned)
contract.transfer.fragment; // -> FunctionFragment (ABI metadata)
```

`staticCall` is the v6 way to do a pre-flight "would this revert?" check (e.g. before committing to a real transaction in a sniping/arbitrage flow) — it works against a Provider-connected contract, no signer required, since it never touches state.

## Switching signer/provider

```typescript
const contractAsOther = contract.connect(otherSignerOrProvider);
```

`connect` returns a new `Contract` instance; it does not mutate the original.

## ContractFactory (deployment)

```typescript
import { ContractFactory } from 'ethers';

const factory = new ContractFactory(abi, bytecode, signer);
const deployed = await factory.deploy(...constructorArgs);
await deployed.waitForDeployment();
const address = await deployed.getAddress();
```

## Events and logs

```typescript
// Live listener
contract.on("Transfer", (from, to, amount, event) => {
  // event.log is the full EventLog; event.removeListener() detaches this listener
});

// Filtered listener — null means "any value" for that indexed param
const filter = contract.filters.Transfer(null, "ethers.eth");
contract.on(filter, (from, to, amount, event) => { /* to === "ethers.eth" always */ });

// Catch-all
contract.on("*", (event) => { /* event.log has the raw EventLog */ });

// Historical query (no live subscription)
const events = await contract.queryFilter(filter, fromBlock?, toBlock?);
```

`contract.filters.EventName(...)` builds a typed filter from the ABI's indexed parameters — prefer this over hand-constructing `topics` arrays.

## Gotchas

- A method call resolves the _ABI-decoded return value_ for `view`/`pure` functions, not a transaction — don't `.wait()` on it.
- Overloaded functions (same name, different params) need explicit selection: `contract["transfer(address,uint256)"](...)`.
- If a write call reverts, ethers throws a `CallExceptionError` (`.code === "CALL_EXCEPTION"`) with `.reason`/`.data` populated when decodable — catch and inspect `.code`/`.reason`, not the raw message string.
- `tx.wait()` resolves to `null` only if you pass `confirms: 0` and the tx isn't yet mined; with the default of 1 confirmation it either resolves to a receipt or throws/hangs — don't assume a truthy check is unnecessary.
