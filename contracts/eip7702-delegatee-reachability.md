# EIP-7702 Delegatee Call Reachability

How a delegated EOA (type-4 / SetCode) can reach other contracts.

## Mental model

    EOA (code = 0xef0100 || delegatee)
       |
       | type-4 tx: to = EOA, data = <delegatee function>
       v
    delegatee bytecode runs with address(this) == EOA
       |
       +-- DelegatedExecutor  -> ONLY Uniswap V3 SwapRouter02 (hardcoded)
       |                        + self multicall of its own methods
       |
       +-- BasicEOABatchExecutor (BEBE / ERC-7821)
                                  -> arbitrary CALL list (to, value, data)
                                  -> any router / Aave / ERC20 / etc.

## Current support matrix

| Delegatee | Multi-target CALL to other contracts? | How |
|---|---|---|
| DelegatedExecutor | **No** (single target) | Hardcoded SWAP_ROUTER. executeSwap* / executeBatchSwaps only talk to Uniswap V3. Multicallable.multicall only delegatecalls itself. _executeCallback only address(this).call. |
| BasicEOABatchExecutor | **Yes** | ERC-7821 execute(mode, abi.encode(calls[])). Each Call{to,value,data} is a real CALL from the EOA. Auth: empty opData requires msg.sender == address(this) (7702 self-call). |

## TypeScript entry points

- Single-router swaps: EIP7702Executor (src/eip7702.ts) + DELEGATED_EXECUTOR_ADDRESS
- Multi-target batch: BatchEOAExecutor (src/eip7702.ts) + BATCH_EXECUTOR_ADDRESS
  - executeBatchCalls([{to, value, data}, ...])
  - approveAndSwap({ tokenIn, router, amountIn, path, minAmountOut }) helper

## Env

    DELEGATED_EXECUTOR_ADDRESS=0x...   # Uniswap-only delegatee
    BATCH_EXECUTOR_ADDRESS=0x...       # multi-target BEBE (optional)

Deploy script now deploys both. Set BATCH_EXECUTOR_ADDRESS after deploy to enable multi-target mode.

## Gaps / intentional limits

1. DelegatedExecutor will not grow an open call(target, data) — that would reintroduce the audit CRITICAL (arbitrary callback). Keep it Uniswap-scoped.
2. BEBE has no target whitelist — any contract is reachable once the EOA authorizes it. Treat the authorized delegatee as full account control for the auth lifetime.
3. Clear delegation after sensitive batches with clearAfter: true or clearDelegation().
