# Automatic Nonce Manager Guide

## Overview

The `NonceManager` handles transaction nonce management automatically, preventing nonce collisions, managing retries, and recovering from failed/dropped transactions.

---

## Quick Start

### Initialize

```typescript
import { initializeNonceManager, getNonceManager } from '../src/nonceManager';

// Initialize once at startup
const nonceManager = await initializeNonceManager(walletAddress);
```

### Get Nonce for Transaction

```typescript
const nonceManager = getNonceManager();
const nonce = nonceManager.getNextNonce();

// Use in transaction
const tx = await signer.sendTransaction({
  to: recipient,
  data: callData,
  nonce: nonce,
});
```

### Track Transaction

```typescript
nonceManager.trackTransaction(nonce, tx.hash);
```

### Confirm Transaction

```typescript
await nonceManager.confirmTransaction(nonce);
```

---

## Core Features

### 1. Automatic Nonce Allocation

**Get next sequential nonce:**
```typescript
const nonce1 = nonceManager.getNextNonce(); // Returns 0, increments to 1
const nonce2 = nonceManager.getNextNonce(); // Returns 1, increments to 2
const nonce3 = nonceManager.getNextNonce(); // Returns 2, increments to 3
```

**Get current nonce without incrementing:**
```typescript
const current = nonceManager.getCurrentNonce(); // Returns 3, doesn't increment
```

### 2. Transaction Tracking

**Track submitted transactions:**
```typescript
nonceManager.trackTransaction(nonce, txHash);

// Internally tracks:
// - nonce
// - txHash
// - timestamp
// - block number
// - status (pending/confirmed/failed/dropped)
// - retry count
```

**Mark as confirmed:**
```typescript
await nonceManager.confirmTransaction(nonce);
```

**Mark as failed (enables retry):**
```typescript
const canRetry = await nonceManager.markTransactionFailed(nonce);
if (canRetry) {
  // Can retry with same nonce
  const newTx = await signer.sendTransaction({
    ...txParams,
    nonce: nonce, // Reuse nonce
    gasPrice: higherGasPrice, // Higher gas to replace
  });
} else {
  // Max retries exceeded
  console.log('Transaction failed after max retries');
}
```

### 3. Pending Transaction Monitoring

**Check status of all pending transactions:**
```typescript
const status = await nonceManager.checkPendingTransactions();

// Returns:
// {
//   confirmed: [0, 1, 3],           // Confirmed nonces
//   dropped: [2],                    // Dropped nonces
//   stillPending: [4, 5]             // Still pending nonces
// }
```

### 4. Nonce State Recovery

**Recover from gaps or dropped transactions:**
```typescript
const recovery = await nonceManager.recoverNonceState();

// Returns:
// {
//   currentOnChainNonce: 5,          // What's on-chain
//   pendingNonces: [4],              // Awaiting confirmation
//   droppedNonces: [2, 3],           // Failed/dropped
//   nextAvailableNonce: 5,           // Safe to use next
//   recovered: true                  // Successfully recovered
// }
```

### 5. Transaction History

**Get all tracked transactions:**
```typescript
const history = nonceManager.getTransactionHistory();
// Returns: PendingTransaction[]

// Example output:
// [
//   { nonce: 0, txHash: '0x...', status: 'confirmed', retryCount: 0 },
//   { nonce: 1, txHash: '0x...', status: 'pending', retryCount: 1 },
//   { nonce: 2, txHash: '0x...', status: 'failed', retryCount: 3 },
// ]
```

**Get specific transaction:**
```typescript
const tx = nonceManager.getTransaction(2);
if (tx) {
  console.log(`Nonce 2: ${tx.status}, ${tx.retryCount} retries`);
}
```

### 6. Cleanup Old Transactions

**Remove old confirmed/failed transactions (older than 1 hour):**
```typescript
const cleaned = nonceManager.cleanupOldTransactions();
console.log(`Cleaned up ${cleaned} transactions`);
```

### 7. Statistics & Monitoring

**Get nonce statistics:**
```typescript
const stats = nonceManager.getStatistics();
// {
//   currentNonce: 10,
//   totalTracked: 8,
//   confirmed: 6,
//   pending: 1,
//   failed: 1,
//   dropped: 0
// }
```

**Log state:**
```typescript
nonceManager.logState();
// Logs:
//   Current nonce: 10
//   Confirmed: 6
//   Pending: 1
//   Failed: 1
//   Dropped: 0
```

---

## Integration Patterns

### Pattern 1: Simple Transaction

```typescript
async function executeSwap(swapParams) {
  const nonceManager = getNonceManager();
  const nonce = nonceManager.getNextNonce();

  try {
    const tx = await executor.executeSwap({
      ...swapParams,
      nonce: nonce,
    });

    nonceManager.trackTransaction(nonce, tx.hash);

    // Wait for confirmation
    const receipt = await tx.wait();
    if (receipt.status === 1) {
      await nonceManager.confirmTransaction(nonce);
      return receipt;
    }
  } catch (error) {
    const canRetry = await nonceManager.markTransactionFailed(nonce);
    if (canRetry) {
      // Retry with higher gas
      return executeSwapWithRetry(swapParams, nonce);
    }
    throw error;
  }
}
```

### Pattern 2: Batch Transactions

```typescript
async function executeBatchSwaps(swaps) {
  const nonceManager = getNonceManager();
  const results = [];

  for (const swap of swaps) {
    const nonce = nonceManager.getNextNonce();

    try {
      const tx = await executor.executeSwap({
        ...swap,
        nonce: nonce,
      });

      nonceManager.trackTransaction(nonce, tx.hash);
      results.push({ nonce, tx });
    } catch (error) {
      logger.error(`Failed to execute swap at nonce ${nonce}: ${error}`);
    }
  }

  // Wait for all to complete
  for (const { nonce, tx } of results) {
    const receipt = await tx.wait();
    if (receipt.status === 1) {
      await nonceManager.confirmTransaction(nonce);
    } else {
      await nonceManager.markTransactionFailed(nonce);
    }
  }

  return results;
}
```

### Pattern 3: Recovery After Failure

```typescript
async function recoverFromFailure() {
  const nonceManager = getNonceManager();

  // Check pending transactions
  const status = await nonceManager.checkPendingTransactions();
  console.log(`Pending: ${status.stillPending.length}`);

  // Recover state from on-chain
  const recovery = await nonceManager.recoverNonceState();

  if (!recovery.recovered) {
    console.log(`Warning: ${recovery.droppedNonces.length} dropped nonces`);
    // Manually handle dropped transactions if needed
  }

  // Get next safe nonce
  const nextNonce = nonceManager.getCurrentNonce();
  console.log(`Safe to use nonce: ${nextNonce}`);
}
```

### Pattern 4: Monitoring Loop

```typescript
async function monitorTransactions() {
  const nonceManager = getNonceManager();
  const interval = setInterval(async () => {
    const status = await nonceManager.checkPendingTransactions();

    if (status.dropped.length > 0) {
      logger.warn(`${status.dropped.length} transactions dropped`);
    }

    nonceManager.logState();

    // Cleanup old transactions periodically
    const cleaned = nonceManager.cleanupOldTransactions();
  }, 30 * 1000); // Check every 30 seconds

  return interval;
}
```

---

## Transaction Lifecycle

```
1. ALLOCATION
   ├─ getNextNonce() → Allocate nonce 0
   └─ Local counter increments to 1

2. SUBMISSION
   ├─ Send transaction with nonce 0
   ├─ trackTransaction(0, txHash)
   └─ Status: PENDING

3. CONFIRMATION (Success)
   ├─ Transaction mined
   ├─ checkPendingTransactions() detects receipt
   ├─ confirmTransaction(0)
   └─ Status: CONFIRMED

4. FAILED (Retry)
   ├─ Transaction reverts
   ├─ markTransactionFailed(0) → retryCount++
   ├─ Send replacement with same nonce 0, higher gas
   ├─ trackTransaction(0, newTxHash)
   └─ Status: PENDING

5. DROPPED (After Max Retries)
   ├─ Max retries exceeded (default: 3)
   └─ Status: FAILED/DROPPED
```

---

## Configuration

### Max Retries

```typescript
// Default: 3 retries
nonceManager.maxRetries = 5; // Custom value
```

### Pending Timeout

```typescript
// Default: 60 seconds
nonceManager.noncePendingTimeout = 120 * 1000; // 2 minutes
```

---

## Best Practices

### 1. Always Initialize at Startup

```typescript
async function startup() {
  const nonceManager = await initializeNonceManager(walletAddress);
  // Nonce synced with on-chain state
}
```

### 2. Track Every Transaction

```typescript
nonceManager.trackTransaction(nonce, tx.hash);
// Don't skip this - enables recovery
```

### 3. Confirm After Success

```typescript
const receipt = await tx.wait();
if (receipt.status === 1) {
  await nonceManager.confirmTransaction(nonce);
}
```

### 4. Handle Failures Gracefully

```typescript
try {
  const tx = await sendTransaction(nonce);
} catch (error) {
  const canRetry = await nonceManager.markTransactionFailed(nonce);
  if (canRetry) {
    // Retry with higher gas price
  }
}
```

### 5. Monitor Pending Transactions

```typescript
// Periodically check status
const status = await nonceManager.checkPendingTransactions();
if (status.dropped.length > 0) {
  logger.warn(`${status.dropped.length} transactions dropped`);
}
```

### 6. Recover After Crashes

```typescript
// On startup after crash
const recovery = await nonceManager.recoverNonceState();
if (!recovery.recovered) {
  logger.warn('Nonce recovery incomplete - manual intervention may be needed');
}
```

### 7. Clean Up Periodically

```typescript
// Daily cleanup
const cleaned = nonceManager.cleanupOldTransactions();
logger.info(`Cleaned ${cleaned} old transactions`);
```

---

## Error Scenarios

### Scenario 1: Transaction Pending Too Long

**Symptoms**: Transaction not mined after 60 seconds

**Recovery**:
```typescript
// Check and handle
const status = await nonceManager.checkPendingTransactions();
if (status.dropped.includes(nonce)) {
  // Retry with higher gas
  const canRetry = await nonceManager.markTransactionFailed(nonce);
  if (canRetry) {
    const newTx = await signer.sendTransaction({
      ...txParams,
      nonce: nonce,
      gasPrice: higherGasPrice,
    });
  }
}
```

### Scenario 2: Nonce Gap (Dropped Transaction)

**Symptoms**: On-chain nonce jumped (e.g., 0, 1, 3 - skipped 2)

**Recovery**:
```typescript
// Recover state
const recovery = await nonceManager.recoverNonceState();
console.log(`Dropped nonces: ${recovery.droppedNonces}`);

// Next transaction will use correct nonce
const nextNonce = nonceManager.getCurrentNonce(); // Safe to use
```

### Scenario 3: Max Retries Exceeded

**Symptoms**: Transaction failed 3 times

**Action**:
```typescript
const canRetry = await nonceManager.markTransactionFailed(nonce);
if (!canRetry) {
  // Max retries exceeded
  logger.error(`Transaction ${nonce} failed after max retries`);
  // Skip this transaction, move to next
  const nextNonce = nonceManager.getNextNonce();
}
```

---

## Monitoring

### Key Metrics

- **Current Nonce**: Next available nonce
- **Confirmed**: Successfully mined
- **Pending**: Awaiting confirmation
- **Failed**: Exceeded retries
- **Dropped**: Missing from chain

### Alerts

Set up alerts for:
- Pending transactions > 5
- Failed transactions > 2
- Dropped nonces (nonce gaps)

---

## References

- **EIP-155**: Signed Transaction & Nonce handling
- **Mempool**: Transaction inclusion dynamics
- **RBF (Replace-by-Fee)**: Retry mechanism

---

**Last Updated**: 2026-07-22  
**Status**: ✅ Production Ready  
**Next Features**: Transaction batching, nonce hints from protocol
