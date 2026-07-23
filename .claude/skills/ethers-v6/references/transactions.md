# Transactions

## Building a request

```typescript
import { TransactionRequest } from 'ethers';

const tx: TransactionRequest = {
  to: address,
  value: parseEther('0.1'), // bigint, wei
  data: encodedCalldata, // optional
  gasLimit: 21000n, // optional — omit to let ethers estimate
  maxFeePerGas: feeData.maxFeePerGas,
  maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
  nonce: explicitNonce, // optional — omit to let the provider assign it
  type: 2, // EIP-1559; omit type/leave unset to let ethers infer from fee fields
};
```

All numeric fields (`value`, `gasLimit`, `gasPrice`, `maxFeePerGas`, `maxPriorityFeePerGas`) are `bigint`, not `BigNumber` or `number`.

## Sending

```typescript
// Via a Contract method — see contracts.md
const tx = await contract.someMethod(args);
const receipt = await tx.wait();

// Direct value transfer / raw tx via a connected Signer
const txResponse = await signer.sendTransaction(tx);
const receipt = await txResponse.wait(confirms?: number, timeout?: number);
```

`wait()` resolves to a `TransactionReceipt` once mined with the requested confirmation count (default 1). It only resolves `null` if you explicitly pass `confirms: 0` and it hasn't been mined yet — with the default, treat the resolved value as present once the promise settles.

## Fee data (EIP-1559)

```typescript
const feeData = await provider.getFeeData();
// -> { gasPrice: bigint | null, maxFeePerGas: bigint | null, maxPriorityFeePerGas: bigint | null }
```

`feeData.maxFeePerGas` already incorporates ethers' own heuristic estimate of the current base fee — you generally don't need to compute it manually. If you do need the raw base fee (e.g. for custom fee-bumping logic in a sniper/MEV bot), read it off the latest block instead of `feeData` — v6 removed the v5 `lastBaseFeePerGas` field:

```typescript
const block = await provider.getBlock('latest');
const baseFeePerGas = block.baseFeePerGas; // bigint | null
```

## Gas estimation

```typescript
const estimate: bigint = await provider.estimateGas(tx);
// or, scoped to a specific contract method:
const estimate2: bigint = await contract.someMethod.estimateGas(...args);
```

`estimateGas` executes the call against current state to determine gas usage — it will throw the same `CallExceptionError` a real send would if the tx would revert. This makes it useful as a revert-detection pre-check, though `staticCall` (see `contracts.md`) is usually clearer when you only care about "would this revert," not the gas number.

## Receipts

```typescript
interface TransactionReceipt {
  hash: string;
  blockNumber: number;
  blockHash: string;
  status: number | null; // 1 = success, 0 = reverted (null only for pre-Byzantium chains)
  gasUsed: bigint;
  logs: Log[];
  // ...
}
```

Check `receipt.status === 1` explicitly if you need to distinguish "mined but reverted" from "mined and succeeded" — `wait()` resolving does not by itself guarantee success on some code paths depending on how the tx was sent; a `Contract` write call's `wait()` throws on revert, but a raw `provider.waitForTransaction` does not.

## Gotchas

- Nonce management: if you're sending multiple transactions back-to-back from the same signer faster than the provider processes them, don't rely on ethers' automatic nonce lookup for every send — it queries `getTransactionCount` per call and can race. Track and increment the nonce yourself for rapid-fire sends (relevant for bot/sniper-style code).
- `gasLimit` you provide is a **ceiling**, not what's actually charged — actual charge is `gasUsed * effectiveGasPrice`, read from the receipt.
- Legacy (`type: 0`) vs EIP-1559 (`type: 2`) transactions use different fee fields (`gasPrice` vs `maxFeePerGas`/`maxPriorityFeePerGas`) — don't set both families of fields on one request; ethers will complain about type ambiguity.
