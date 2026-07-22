# Dynamic Gas Optimization Guide

## Overview

The `GasOptimizer` module provides real-time gas price monitoring and cost analysis for all execution modes. It helps determine the most cost-effective execution path and optimizes transaction parameters based on network conditions.

---

## Quick Start

### Initialize

```typescript
import GasOptimizer from '../src/gasOptimizer';

const optimizer = new GasOptimizer(42161); // Arbitrum chainId
```

### Get Current Gas Prices

```typescript
const prices = await optimizer.getCurrentGasPrices();
console.log(`Base fee: ${prices.baseFee}`);
console.log(`Max fee: ${prices.maxFeePerGas}`);
console.log(`Priority fee: ${prices.maxPriorityFeePerGas}`);
```

### Estimate Execution Costs

```typescript
// Estimate each mode's gas cost
const direct = await optimizer.estimateDirectModeGas();
const flashLoan = await optimizer.estimateFlashLoanModeGas(swapAmount);
const eip7702 = await optimizer.estimateEIP7702ModeGas();
const erc4337 = await optimizer.estimateERC4337ModeGas();

console.log(`Direct cost: ${direct.estimatedCost.toString()}`);
console.log(`Flash loan cost: ${flashLoan.estimatedCost.toString()}`);
console.log(`EIP-7702 cost: ${eip7702.estimatedCost.toString()}`);
console.log(`ERC-4337 cost: ${erc4337.estimatedCost.toString()}`);
```

---

## Core Features

### 1. Gas Price Monitoring

**Real-time gas metrics:**
- Base fee per gas
- Priority fee
- Max fee per gas
- Network gas price

```typescript
const { baseFee, priorityFee, maxFeePerGas } = await optimizer.getCurrentGasPrices();
```

### 2. Mode-Specific Gas Estimation

Each execution mode has different gas requirements:

| Mode | Base Gas | Typical Total | Notes |
|------|----------|---------------|-------|
| **Direct** | 45k approval | ~145k | Fastest, cheapest |
| **Flash Loan** | 70k initiation | ~200k | +0.09% premium |
| **EIP-7702** | 5k auth | ~105k | Requires Prague |
| **ERC-4337** | 50k EntryPoint | ~170k | Bundler overhead |

```typescript
// Direct mode
const directEst = await optimizer.estimateDirectModeGas();
// Result: ~145,000 gas

// Flash loan mode
const flashEst = await optimizer.estimateFlashLoanModeGas(
  BigNumber.from('1000000000000000000') // 1 token
);
// Result: ~200,000 gas + premium

// EIP-7702 mode
const eip7702Est = await optimizer.estimateEIP7702ModeGas();
// Result: ~105,000 gas (most efficient)

// ERC-4337 mode
const erc4337Est = await optimizer.estimateERC4337ModeGas();
// Result: ~170,000 gas
```

### 3. Profitability Analysis

Calculates net profit for each execution mode:

```typescript
const analysis = await optimizer.analyzeProfitability(
  swapAmount,           // Input amount
  outputAmount,         // Expected output
  inputPrice,          // Input token price
  outputPrice          // Output token price
);

// Results:
// [
//   { mode: 'direct', grossProfit: 100k, gasCost: 50k, netProfit: 50k, ... },
//   { mode: 'flashLoan', grossProfit: 100k, gasCost: 60k, netProfit: 40k, ... },
//   { mode: 'eip7702', grossProfit: 100k, gasCost: 45k, netProfit: 55k, ... },
//   { mode: 'erc4337', grossProfit: 100k, gasCost: 55k, netProfit: 45k, ... }
// ]

// Pick the most profitable
const best = analysis.reduce((a, b) => 
  a.netProfit.gt(b.netProfit) ? a : b
);

if (best.isRentable) {
  console.log(`✅ Execute via ${best.mode}`);
  console.log(`   Profit: ${best.netProfit.toString()}`);
  console.log(`   Margin: ${best.profitMargin.toFixed(2)}%`);
}
```

### 4. Dynamic Parameter Optimization

Automatically adjust transaction parameters based on gas prices:

```typescript
const params = await optimizer.optimizeExecutionParams(
  BigNumber.from('50') // Base slippage in bps (0.5%)
);

// Returns:
// {
//   slippageTolerance: 50-60 bps (increased if gas is high),
//   deadline: 5 minutes from now,
//   priorityFee: current priority fee,
//   maxFeePerGas: 3x base + priority
// }

const tx = await executor.executeSwap({
  ...swapParams,
  slippageTolerance: params.slippageTolerance,
  deadline: params.deadline,
  maxFeePerGas: params.maxFeePerGas,
  maxPriorityFeePerGas: params.priorityFee,
});
```

### 5. Profitability Threshold Analysis

Determine the minimum output price needed for profitability:

```typescript
const threshold = await optimizer.estimateProfitabilityThreshold(
  swapAmount,
  inputPrice
);

// Returns:
// {
//   breakEvenPrice: price where profit = 0,
//   profitThreshold: break-even + 0.5% margin,
//   requiredOutputPrice: minimum price to execute
// }

if (expectedOutputPrice.gte(threshold.requiredOutputPrice)) {
  console.log('✅ Swap is profitable');
} else {
  console.log('❌ Swap would lose money');
}
```

### 6. Gas Price Alerts

Monitor gas price levels and get status:

```typescript
const alerts = await optimizer.getGasPriceAlerts();

// Returns:
// {
//   normal: 50 gwei,
//   high: 100 gwei,
//   veryHigh: 200 gwei,
//   status: 'high' | 'normal' | 'veryHigh'
// }

if (alerts.status === 'veryHigh') {
  console.log('⚠️ Gas prices very high, wait for reduction');
} else if (alerts.status === 'normal') {
  console.log('✅ Good gas prices, execute now');
}
```

---

## Integration Examples

### Example 1: Simple Cost Comparison

```typescript
import GasOptimizer from './src/gasOptimizer';

async function compareCosts() {
  const optimizer = new GasOptimizer();

  const direct = await optimizer.estimateDirectModeGas();
  const flash = await optimizer.estimateFlashLoanModeGas(
    BigNumber.from('1000000000000000000')
  );

  console.log(`Direct: ${direct.estimatedCost.toString()} wei`);
  console.log(`Flash: ${flash.estimatedCost.toString()} wei`);

  if (direct.estimatedCost.lt(flash.estimatedCost)) {
    console.log('Use Direct mode (cheaper)');
  } else {
    console.log('Use Flash Loan mode (acceptable)');
  }
}
```

### Example 2: Profitability-Based Mode Selection

```typescript
async function selectOptimalMode(
  swapAmount: BigNumber,
  expectedOutput: BigNumber
) {
  const optimizer = new GasOptimizer();

  const analysis = await optimizer.analyzeProfitability(
    swapAmount,
    expectedOutput,
    tokenAPrice,
    tokenBPrice
  );

  // Filter for profitable modes
  const profitable = analysis.filter(a => a.isRentable);

  if (profitable.length === 0) {
    console.log('❌ No profitable modes');
    return null;
  }

  // Select highest profit
  const best = profitable.reduce((a, b) =>
    a.netProfit.gt(b.netProfit) ? a : b
  );

  console.log(`✅ Execute via ${best.mode}`);
  console.log(`   Net profit: ${best.netProfit.toString()}`);
  console.log(`   Margin: ${best.profitMargin.toFixed(2)}%`);

  return best.mode;
}
```

### Example 3: Gas Price-Based Execution Strategy

```typescript
async function executeWithGasOptimization() {
  const optimizer = new GasOptimizer();

  // Check gas prices
  const alerts = await optimizer.getGasPriceAlerts();

  if (alerts.status === 'veryHigh') {
    console.log('Gas too high, waiting...');
    return;
  }

  // Get optimized parameters
  const params = await optimizer.optimizeExecutionParams(
    BigNumber.from('50') // 0.5% base slippage
  );

  // Analyze profitability with current gas prices
  const analysis = await optimizer.analyzeProfitability(
    swapAmount,
    expectedOutput,
    inputPrice,
    outputPrice
  );

  const best = analysis.find(a => a.isRentable);
  if (!best) {
    console.log('Not profitable at current gas prices');
    return;
  }

  // Execute with optimized parameters
  const result = await executor.executeSwap({
    tokenIn,
    amountIn: swapAmount,
    path,
    minAmountOut: expectedOutput.mul(10000 - params.slippageTolerance).div(10000),
    deadline: params.deadline,
  });

  console.log(`✅ Executed via ${best.mode}`);
  console.log(`   Profit: ${result.amountOut.sub(expectedOutput).toString()}`);
}
```

---

## Gas Cost Breakdown

### Direct Mode (~145k gas)

```
Approval phase:
  - ERC20 approval: ~45,000 gas
  
Swap phase:
  - Uniswap V3 routing: ~100,000 gas
  
Total: ~145,000 gas
```

### Flash Loan Mode (~200k gas + premium)

```
Initiation:
  - Aave pool call: ~70,000 gas
  
Callback:
  - Swap execution: ~100,000 gas
  - Repayment: ~30,000 gas
  
Total: ~200,000 gas
Premium: 0.09% of borrowed amount
```

### EIP-7702 Mode (~105k gas)

```
Authorization:
  - Signature encoding: ~5,000 gas
  
Execution:
  - Delegated swap: ~100,000 gas
  
Total: ~105,000 gas
Note: Requires Prague hardfork
```

### ERC-4337 Mode (~170k gas)

```
EntryPoint:
  - Validation: ~50,000 gas
  
Wallet:
  - Execution: ~100,000 gas
  
Bundler overhead:
  - Pre-verification: ~20,000 gas
  
Total: ~170,000 gas
```

---

## Configuration

### Adjust Flash Loan Premium

```typescript
const optimizer = new GasOptimizer(42161);

// Aave V3 on Arbitrum uses 9 basis points
// Change if using different protocol
```

### Customize Slippage Buffer

The optimizer can adjust slippage based on gas prices:
- Normal gas: use base slippage
- High gas (>3x base): add 0.1% buffer
- Very high gas (>5x base): add 0.2% buffer

---

## Monitoring & Alerts

### Log Gas Prices

```typescript
const prices = await optimizer.getCurrentGasPrices();
logger.info(`Gas prices: ${prices.maxFeePerGas} wei/gas`);
```

### Monitor Profitability

```typescript
const analysis = await optimizer.analyzeProfitability(
  swapAmount,
  outputAmount,
  inputPrice,
  outputPrice
);

analysis.forEach(result => {
  logger.info(`${result.mode}: ${result.recommendation}`);
});
```

### Set Price Alerts

```typescript
const alerts = await optimizer.getGasPriceAlerts();

if (alerts.status === 'high') {
  notifier.send(`⚠️ Gas prices high: ${alerts.high} gwei`);
}
```

---

## Best Practices

### 1. Always Check Profitability

```typescript
const analysis = await optimizer.analyzeProfitability(...);
if (!analysis.some(a => a.isRentable)) {
  return; // Skip this opportunity
}
```

### 2. Use Optimized Parameters

```typescript
const params = await optimizer.optimizeExecutionParams(baseSlippage);
// Always use params.slippageTolerance and params.maxFeePerGas
```

### 3. Monitor Gas Prices

```typescript
const alerts = await optimizer.getGasPriceAlerts();
if (alerts.status !== 'normal') {
  // Adjust strategy or wait
}
```

### 4. Select by Profitability

```typescript
const best = analysis.reduce((a, b) =>
  a.netProfit.gt(b.netProfit) ? a : b
);
// Always execute via best mode
```

### 5. Set Reasonable Deadlines

```typescript
const params = await optimizer.optimizeExecutionParams(...);
// Uses 5-minute deadline (300 seconds)
```

---

## Troubleshooting

### Q: Gas costs too high?

**A:** Check `optimizer.getGasPriceAlerts()`. If status is 'veryHigh', wait for gas prices to normalize.

### Q: No profitable modes?

**A:** All modes show negative profit. Either:
- Wait for better prices
- Reduce slippage expectations
- Look for larger opportunities

### Q: Which mode to use?

**A:** Always use `optimizer.analyzeProfitability()` to find the best mode. Profitability varies by:
- Current gas prices
- Swap opportunity size
- Market volatility

### Q: EIP-7702 not available?

**A:** Prague hardfork not activated. Use alternative modes (Direct, Flash Loan, ERC-4337).

---

## References

- **Gas Estimation**: Based on real Arbitrum data and Aave V3
- **EIP-1559**: Dynamic fee market (max fee, priority fee)
- **EIP-7702**: Set EOA Account Code (post-Prague)
- **ERC-4337**: Account Abstraction (bundler overhead)

---

**Last Updated**: 2026-07-22  
**Status**: ✅ Production Ready  
**Next Features**: Gas price prediction, MEV sandwich detection
