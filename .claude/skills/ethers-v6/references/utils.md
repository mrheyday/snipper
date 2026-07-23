# Crypto & Utility Functions

All flat exports from `"ethers"` in v6 — no `ethers.utils.*` namespace.

## Hashing

```typescript
import { keccak256, id, sha256 } from "ethers";

keccak256(data: BytesLike): string;   // hash of raw bytes/hex — data must already be bytes, NOT a UTF-8 string
id(text: string): string;              // keccak256 of the UTF-8 encoding of `text` — the common shortcut for e.g. event topic0 / error selectors
sha256(data: BytesLike): string;
```

`keccak256("hello")` is wrong if you mean "hash this string" — `"hello"` isn't valid `BytesLike` unless it happens to look like hex. Use `id("hello")` for hashing arbitrary UTF-8 text, or `keccak256(toUtf8Bytes("hello"))` explicitly.

## Addresses

```typescript
import { getAddress, isAddress } from "ethers";

getAddress(address: string): string; // normalizes to EIP-55 checksummed form; throws on invalid checksum/format
isAddress(value: string): boolean;    // safe boolean check, never throws
```

Always run untrusted/external address strings through `getAddress` (or at least `isAddress`) before using them — silently accepting a malformed or wrong-checksum address is a common source of funds-sent-to-nowhere bugs.

## Bytes / hex conversion

```typescript
import { hexlify, getBytes, toUtf8Bytes, toUtf8String, toQuantity } from "ethers";

hexlify(data: BytesLike): string;      // bytes -> "0x..." hex string
getBytes(value: BytesLike): Uint8Array; // hex string -> bytes (replaces v5's `arrayify`)
toUtf8Bytes(text: string): Uint8Array;   // UTF-8 string -> bytes
toUtf8String(bytes: BytesLike): string;   // bytes -> UTF-8 string
toQuantity(value: BigNumberish): string;   // -> minimal "0x..." hex quantity (replaces v5's `hexValue`)
```

## Solidity-style packed encoding

```typescript
import { solidityPacked, solidityPackedKeccak256, solidityPackedSha256 } from "ethers";

const packed: string = solidityPacked(["address", "uint256"], [addr, amount]);
const hash: string = solidityPackedKeccak256(["address", "uint256"], [addr, amount]);
```

These replace v5's `ethers.utils.solidityPack` / `solidityKeccak256` / `soliditySha256` — same behavior (tightly-packed, non-padded encoding matching Solidity's `abi.encodePacked`), new flat names.

## Message signing helpers

```typescript
import { verifyMessage, hashMessage } from "ethers";

const signerAddress = verifyMessage(message: string | Uint8Array, signature: SignatureLike): string;
const digest = hashMessage(message: string | Uint8Array): string; // the EIP-191 prefixed digest that gets signed
```

## Gotchas

- `keccak256` vs `id`: the single most common mix-up. `keccak256` expects `BytesLike` (already-encoded data); `id` expects a plain string and does the UTF-8 encoding for you.
- `toQuantity`/`getBytes` are the v6 replacements for v5's `hexValue`/`arrayify` — if you see those v5 names in code being ported, swap them here.
- Address comparison should go through `getAddress` (or at least `.toLowerCase()`) on both sides — raw string `===` on two address strings will fail if one is checksummed and the other isn't.
