# EIP-7702 / Type 4 ("SetCode") Transactions

EIP-7702 lets an EOA temporarily delegate its code to a contract for the duration it stays authorized, by including one or more signed **authorizations** in a type-4 transaction. ethers v6 (v6.13+) has native support for building, signing, and sending these — you should not need to hand-roll the digest or signature.

> **This project's current `src/eip7702.ts` is a hand-rolled v5 implementation** (`ethers.utils.keccak256` + `signer.signMessage(...)`) and is **not spec-compliant** — EIP-7702 authorizations are not EIP-191 personal-signed messages, they use their own magic-byte-prefixed RLP digest. Route new/fixed EIP-7702 work through the v6 `Signer.authorize()` API below rather than extending the manual approach in that file.

## The authorization object

Conceptually, an authorization is a signed tuple of `(chainId, address, nonce)`:

- `address` — the contract whose code the EOA delegates to.
- `chainId` — `0n` means the authorization is valid on **any** chain; a specific chain ID restricts it to that chain only.
- `nonce` — must match the authorizing account's nonce at the time the authorization is applied (not necessarily the transaction's own nonce — read the current spec/network behavior before assuming semantics, since this is the detail most likely to cause a rejected or misapplied authorization).

In ethers v6:

```typescript
interface AuthorizationRequest {
  address: string;
  nonce?: BigNumberish; // omit to let ethers fill in from the signer's current nonce
  chainId?: BigNumberish; // omit to default to the connected network; pass 0n explicitly for "any chain"
}

interface Authorization extends AuthorizationRequest {
  address: string;
  nonce: bigint;
  chainId: bigint;
  signature: Signature; // r, s, yParity
}
```

## Signing an authorization

```typescript
import { Wallet, JsonRpcProvider } from 'ethers';

const provider = new JsonRpcProvider(rpcUrl);
const signer = new Wallet(privateKey, provider);

// Signer.authorize() builds the correct EIP-7702 digest internally and signs it —
// do not construct this by hand with keccak256 + signMessage.
const authorization = await signer.authorize({
  address: delegateContractAddress, // the contract code this EOA will point to
  // nonce, chainId: optional, see above
});
```

`signer.authorize(...)` returns a fully-formed `Authorization` (including the populated `nonce`/`chainId` and the `signature`) — this is what goes into a transaction's `authorizationList`.

## Sending a type-4 transaction

```typescript
const tx = await signer.sendTransaction({
  type: 4,
  to: targetAddress, // the call this tx actually makes, separate from the delegation itself
  data: calldata,
  authorizationList: [authorization], // Array<AuthorizationLike>
});
await tx.wait();
```

A single transaction can carry multiple authorizations (e.g. delegating several accounts in one tx if you control all their keys), and the authorizing account does not have to be the same account that sends the transaction — a relayer/sponsor can submit a tx containing an authorization signed by a different EOA. If the authorizing account _is_ the tx sender, some clients allow omitting that authorization's nonce field for ethers to infer correctly; when in doubt, pass it explicitly rather than relying on inference.

## What actually happens on-chain

Once applied, the EOA's code is set to a **delegation designator**: `0xef0100` followed by the 20-byte delegate address. Calls to the EOA now execute the delegate contract's code with the EOA's own storage/context. This is why `DelegatedExecutor.sol`-style contracts in this repo exist — they're the code an EOA delegates _to_, not a contract you deploy-and-call in the usual sense.

To clear a delegation, authorize to the zero address (`0x0000000000000000000000000000000000000000`).

## Gotchas

- **Don't sign the authorization with `signMessage`.** That produces an EIP-191-prefixed personal-sign digest, which is a different digest than the EIP-7702 spec expects — a contract or client verifying the authorization the "real" way will reject it (or worse, recover the wrong address silently, depending on how verification is implemented). Always go through `signer.authorize()`.
- Confirm the target chain has actually activated EIP-7702 (it shipped with the Pectra hardfork on Ethereum mainnet; L2/rollup activation timing varies and Arbitrum's support may lag or diverge — verify against the specific chain and ethers/provider version you're targeting rather than assuming parity with mainnet).
- The delegation is **not permanent** in the sense of a proxy pattern — it persists in account state but the EOA's owner can always re-authorize to a different address or to the zero address to clear it. Don't design contracts assuming a delegation is immutable.
- `type: 4` transactions require `authorizationList` — omitting it while setting `type: 4` will fail; if you don't have an authorization to include, you almost certainly want a normal `type: 2` (EIP-1559) transaction instead.
