# Arbitrum Sniper Bot — Deployment Report

**Generated:** 2026-07-23  
**Network:** Arbitrum One (Mainnet)  
**Chain ID:** 42161  
**Status:** Deployed + verified on Arbiscan

## Deployed Contracts

| Contract          | Address                                      | Notes                              |
| ----------------- | -------------------------------------------- | ---------------------------------- |
| SniperSearcher    | `0xAC7465949D3178C9F13d629c6417b2a02D50DdC8` | minAmountBitLength=0               |
| DelegatedExecutor | `0xc7a5B0873CB174A78017A66b541B24be64fBAde4` | minAmountBitLength=0               |
| FlashLoanReceiver | `0xdce71b4f28dcc5686B3B4e8790bD6051345A89b8` | swapExecutor=Sniper, pool=Aave V3  |
| BEBE              | `0x00000000BEBEDB7C30ee418158e26E31a5A8f3E2` | canonical CREATE2 (not redeployed) |

## Owner

`0x00000001386687D89e6A36aE01C5e5F75acF61Af`

## Wiring

- `SniperSearcher.allowedExecutors(FlashLoanReceiver) = true`
- `FlashLoanReceiver.swapExecutor = SniperSearcher`
- `FlashLoanReceiver.lendingPool = 0x794a61358D6845594F94dc1DB02A252b5b4814aD`
- `SniperSearcher.swapRouter = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`

## Env

```env
SNIPER_SEARCHER_ADDRESS=0xAC7465949D3178C9F13d629c6417b2a02D50DdC8
FLASH_LOAN_RECEIVER_ADDRESS=0xdce71b4f28dcc5686B3B4e8790bD6051345A89b8
DELEGATED_EXECUTOR_ADDRESS=0xc7a5B0873CB174A78017A66b541B24be64fBAde4
BATCH_EXECUTOR_ADDRESS=0x00000000BEBEDB7C30ee418158e26E31a5A8f3E2
```

## Calldata

See `contracts/delegatee-calldata.md`.
