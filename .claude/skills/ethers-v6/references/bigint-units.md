# BigInt & Unit Conversion

## `BigNumber` is gone — use native `bigint`

v6 replaced the custom `BigNumber` class entirely with ES2020 `bigint`. Any value that was a `BigNumber` in v5 (balances, gas, token amounts, block numbers in some contexts) is now a plain JS `bigint` in v6.

```typescript
// v5                                  // v6
BigNumber.from("1000")                 1000n                    // literal
BigNumber.from(1000)                   BigInt(1000)             // from number
value1.add(value2)                     value1 + value2
value1.sub(value2)                     value1 - value2
value1.mul(value2)                     value1 * value2
value1.div(value2)                     value1 / value2           // truncates toward 0
value1.eq(value2)                      value1 === value2
value1.gte(value2)                     value1 >= value2
value1.isZero()                        value1 === 0n
value1.toString()                      value1.toString()          // unchanged
value1.toNumber()                      Number(value1)             // may lose precision for large values
```

### Gotchas specific to `bigint`

- **You cannot mix `bigint` and `number` in arithmetic** — `1000n + 1` throws `TypeError: Cannot mix BigInt and other types`. Convert explicitly: `1000n + BigInt(1)`.
- `bigint` division truncates (like integer division), it does not round — be careful in fee/slippage math where you'd want rounding.
- `JSON.stringify({ amount: 1000n })` throws `TypeError: Do not know how to serialize a BigInt`. Convert to string first (`amount.toString()`) before logging/serializing to JSON, or use a custom `replacer`.
- `bigint` cannot be negative-zero or fractional — for fixed-point/decimal math beyond simple integer amounts, see `FixedNumber` below rather than hand-rolling.

## Unit conversion

```typescript
import { formatEther, parseEther, formatUnits, parseUnits } from "ethers";

// Ether-specific (18 decimals) — most common for native ETH amounts
const wei: bigint = parseEther("1.5");       // 1500000000000000000n
const asString: string = formatEther(wei);    // "1.5"

// General-purpose — pass a decimal count or a known unit name
const raw: bigint = parseUnits("1000", 9);     // -> 1000000000000n  (9 decimals, e.g. gwei-scale)
const gwei: bigint = parseUnits("1", "gwei");  // -> 1000000000n
const display: string = formatUnits(raw, 9);   // -> "1000.0"

// Real-world: converting an ERC-20 balance using the token's own `decimals()`
const decimals: bigint = await tokenContract.decimals(); // note: bigint, not number
const balance: bigint = await tokenContract.balanceOf(addr);
const human = formatUnits(balance, decimals); // formatUnits accepts bigint or number for the decimals arg
```

`parseEther`/`parseUnits` take a decimal **string** (not a `number`) as the amount — this avoids floating-point precision loss on the input side. Never do `parseEther(someFloat.toString())` if `someFloat` was computed via floating-point math on a large value; prefer keeping amounts as strings/bigints end-to-end.

## FixedNumber

For fixed-point decimal math that doesn't fit the plain-integer `bigint` model (e.g. displaying/accumulating fractional values with controlled precision), `FixedNumber` is still available in v6 — it wasn't replaced by `bigint`, since `bigint` only handles integers.

```typescript
import { FixedNumber } from "ethers";
const a = FixedNumber.fromString("1.23456", "fixed128x18");
```

Reach for this only when integer/wei-scale math genuinely doesn't fit — for token amounts, `parseUnits`/`formatUnits` + `bigint` is almost always the right tool.
