# Wallets & Signers

`Signer` is the abstract interface for anything that can sign; `Wallet` (and its subclass `HDNodeWallet`) is the concrete implementation for a locally-held private key. Signing never requires a Provider — sending a transaction does.

## Creating a Wallet

```typescript
import { Wallet, HDNodeWallet } from "ethers";

// From a raw private key (32-byte hex, 0x-prefixed)
const wallet = new Wallet(privateKeyHex: string, provider?: Provider);

// Random new wallet (throws if no crypto RNG source available)
const random: HDNodeWallet = Wallet.createRandom(provider?: null | Provider);

// From a BIP-39 mnemonic phrase
const fromMnemonic: HDNodeWallet = Wallet.fromPhrase(phrase: string, provider?: Provider);

// From an encrypted JSON keystore (v3/v6 formats)
const fromJson = await Wallet.fromEncryptedJson(json: string, password: string | Uint8Array);
```

Connect (or reconnect) an existing wallet to a provider without recreating it:

```typescript
const connected = wallet.connect(provider); // returns a NEW Wallet instance connected to provider
```

`connect` does not mutate — always use the returned value.

## Signing

```typescript
// Message signing — no provider required
const sig = await signer.signMessage(message: string | Uint8Array);

// EIP-712 typed data
const sig712 = await signer.signTypedData(domain, types, value);

// Raw transaction signing (does not broadcast)
const rawTx = await signer.signTransaction(tx: TransactionRequest);

// Sign AND broadcast (needs a provider-connected signer)
const txResponse = await signer.sendTransaction(tx: TransactionRequest);
await txResponse.wait();
```

Verify a signed message against an address:

```typescript
import { verifyMessage } from "ethers";
const recovered = verifyMessage(message, signature); // -> address string; compare to expected signer
```

## Encrypting a wallet to JSON

```typescript
const json = await wallet.encrypt(password: string | Uint8Array, progressCallback?);
// encryptSync() exists but blocks the event loop — prefer the async version
```

## VoidSigner

Use `VoidSigner` when you need something with a Signer's *address* (e.g. to build `contract.connect(voidSigner.connect(provider))` for a `staticCall` "simulate as this address" check) but have no private key and never intend to actually sign:

```typescript
import { VoidSigner } from "ethers";
const other = new VoidSigner(address);
const contractAsOther = contract.connect(other.connect(provider));
await contractAsOther.someMethod.staticCall(...); // simulated as `address`, but any real signing call throws
```

## Gotchas

- Never log or persist a raw private key or mnemonic in application logs — treat `Wallet` instances the same as the secret they wrap.
- `Wallet.createRandom()`/`fromPhrase()` return `HDNodeWallet`, which has extra HD-derivation properties (`.path`, `.mnemonic`, `.deriveChild()`) that a plain `Wallet` from a raw key does not — don't assume `.mnemonic` exists on every wallet.
- A `Wallet` not connected to a provider can sign but cannot call `sendTransaction`, read balances, or estimate gas — connect it first for anything that touches chain state.
