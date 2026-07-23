# Migrating v5 → v6

Side-by-side reference for translating existing v5 code. This project's `package.json` currently pins `ethers@^5.8.0` — check before assuming a file is already on v6.

## Imports

```typescript
// v5: namespaced, sub-package imports needed for granular control
import { ethers } from "ethers";
import { providers } from "ethers";
const { InfuraProvider } = providers;
import { InfuraProvider } from "@ethersproject/providers"; // alt granular import

// v6: everything flat off the root package
import { ethers } from "ethers";
import { InfuraProvider, JsonRpcProvider, Contract, Wallet, parseEther, formatUnits } from "ethers";
import { InfuraProvider } from "ethers/providers"; // granular, tree-shakeable equivalent
```

There is no more `ethers.utils`, `ethers.providers`, `ethers.constants`, or `ethers.errors` namespace — those members moved to the flat top-level export.

## Big numbers — the biggest behavioral change

```typescript
// v5                                          // v6
BigNumber.from("1000")                          1000n
BigNumber.from(1000)                            BigInt(1000)
value1.add(value2)                              value1 + value2
value1.sub(value2)                              value1 - value2
value1.mul(value2)                              value1 * value2
value1.div(value2)                              value1 / value2
value1.eq(value2)                               value1 === value2
value1.gte(value2)                              value1 >= value2
value1.isZero()                                 value1 === 0n
```

Anywhere v5 code checked `value instanceof BigNumber` or imported `BigNumber` from `"ethers"`, v6 code should check `typeof value === "bigint"` instead. `FixedNumber` still exists in v6 unchanged, for genuine fixed-point decimal needs — see `bigint-units.md`.

## Providers

```typescript
// v5                                          // v6
new ethers.providers.JsonRpcProvider(url)        new ethers.JsonRpcProvider(url)  // or: import { JsonRpcProvider }
new ethers.providers.Web3Provider(ethereum)      new ethers.BrowserProvider(ethereum)
new ethers.providers.WebSocketProvider(url)      new ethers.WebSocketProvider(url) // unchanged name, flat import now
new ethers.providers.FallbackProvider(providers) new ethers.FallbackProvider(providers) // config shape also changed — check options
provider.getGasPrice()                            (await provider.getFeeData()).gasPrice
feeData.lastBaseFeePerGas                          (await provider.getBlock("latest")).baseFeePerGas   // field removed
```

## Contracts

Contract instantiation and read/write calling conventions are largely unchanged (`new Contract(address, abi, providerOrSigner)`, `await contract.method(...)`), but everything numeric returned now comes back as `bigint` instead of `BigNumber` — any `.toString()`/`.add()`-style post-processing on return values needs the bigint treatment above. `staticCall`, `populateTransaction`, and `estimateGas` as sub-methods on a contract function (`contract.method.staticCall(...)`) are unchanged in shape between v5 and v6.

## Signers / Wallets

```typescript
// v5                                          // v6
wallet.connect(provider)                         wallet.connect(provider) // unchanged, still returns a new instance
ethers.Wallet.createRandom()                      Wallet.createRandom()    // unchanged
ethers.Wallet.fromMnemonic(phrase)                Wallet.fromPhrase(phrase) // renamed
```

## Hex / bytes utilities

```typescript
// v5                                          // v6
ethers.utils.arrayify(value)                      getBytes(value)
ethers.utils.hexValue(value)                       toQuantity(value)
ethers.utils.hexlify(value)                        hexlify(value)          // unchanged name, flat import
ethers.utils.toUtf8Bytes(text)                     toUtf8Bytes(text)       // unchanged name, flat import
ethers.utils.solidityPack(types, values)           solidityPacked(types, values)
ethers.utils.solidityKeccak256(types, values)      solidityPackedKeccak256(types, values)
ethers.utils.soliditySha256(types, values)         solidityPackedSha256(types, values)
```

## Units

```typescript
// v5                                          // v6
ethers.utils.formatEther(wei)                     formatEther(wei)   // unchanged name, flat import, returns string same as before
ethers.utils.parseEther(str)                       parseEther(str)     // now returns bigint, not BigNumber
ethers.utils.formatUnits(value, decimals)           formatUnits(value, decimals)
ethers.utils.parseUnits(str, decimals)               parseUnits(str, decimals)
```

## Migration checklist for a file

1. Replace `ethers.utils.X` / `ethers.providers.X` imports with flat `import { X } from "ethers"`.
2. Grep the file for `.add(`, `.sub(`, `.mul(`, `.div(`, `.eq(`, `.gte(`, `.lte(`, `.gt(`, `.lt(`, `.isZero(` on any value that used to be a `BigNumber` — convert to native operators.
3. Grep for `BigNumber.from(` — convert to a `bigint` literal, `BigInt(...)`, or leave as a parsed string via `parseUnits`/`parseEther` if it's a decimal amount.
4. Check any `JSON.stringify` or logging of numeric contract/tx values — bigint needs `.toString()` first or it throws.
5. Check any code reading `feeData.lastBaseFeePerGas` — that field is gone; pull `baseFeePerGas` from the latest block instead.
6. Check `Wallet.fromMnemonic` → `Wallet.fromPhrase`.
7. Re-run the test suite — v6's stricter typing (bigint vs number vs BigNumber) tends to surface silent v5 coercion bugs at compile/runtime that were previously masked.
