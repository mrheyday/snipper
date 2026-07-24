import { Percent } from '@uniswap/sdk-core';
import { JsonRpcProvider, Wallet, type Provider } from 'ethers';
import { config as loadEnvironmentVariables } from 'dotenv';
import {
  getRequiredEnv,
  getOptionalEnv,
  validatePrivateKey,
  validateAndChecksumAddress,
  validateRPC,
  validateDeadline,
  validateSlippage,
} from './validation';

loadEnvironmentVariables();

// Validate and load required environment variables
const WALLET_PRIVATE_KEY = getRequiredEnv('WALLET_PRIVATE_KEY');
validatePrivateKey(WALLET_PRIVATE_KEY);

const SWAP_ROUTER_ADDRESS = validateAndChecksumAddress(getRequiredEnv('SWAP_ROUTER_ADDRESS'));

// Uniswap V3 QuoterV2 on Arbitrum One (note: ends in 7530..., not mainnet 7540...)
const QUOTER_ADDRESS = validateAndChecksumAddress(
  getOptionalEnv('QUOTER_ADDRESS', '0x61fFE014bA17989E743c5F6cB21bF9697530B21e')
);

// Canonical Permit2 CREATE2 address (Arbitrum + most EVMs)
const PERMIT2_ADDRESS = validateAndChecksumAddress(
  getOptionalEnv('PERMIT2_ADDRESS', '0x000000000022D473030F116dDEE9F6B43aC78BA3')
);

/**
 * Arbitrum One production deploy (2026-07-23) — verified on Arbiscan.
 * Constructor args match contracts/src/DeployRegistry.sol.
 * Override via env for forks / redeploys.
 */
export const ARBITRUM_DEPLOY = {
  chainId: 42161,
  owner: '0x00000001386687D89e6A36aE01C5e5F75acF61Af',
  sniperSearcher: '0xBa0FAb34298983BC114Afa52685521571C1d84F9',
  flashLoanReceiver: '0x37895b70656E70F8CF252C97BdB3Aee95D175bEF',
  delegatedExecutor: '0x91d9891F34FEE2Bf55ED3129C19bc4FbD5cE4C57',
  /** Vectorized BEBE CREATE2 (canonical multi-target batch; no constructor). */
  bebe: '0x00000000BEBEDB7C30ee418158e26E31a5A8f3E2',
  swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  aaveV3Pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  minAmountBitLength: 0,
  /** Registered constructor arguments used at deploy. */
  constructors: {
    sniperSearcher: {
      // Post dual-ABI: constructor is (RouterConfig[] initialRouters, uint256 minAmountBitLength),
      // RouterConfig = (address router, bool legacyAbi). SushiSwap V3 = legacyAbi true.
      types: ['(address,bool)[]', 'uint256'] as const,
      args: [
        [
          ['0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', false], // Uniswap V3
          ['0x8A21F6768C1f8075791D08546Dadf6daA0bE820c', true], // SushiSwap V3 (legacy 5-field ABI)
          ['0x32226588378236Fd0c7c4053999F88aC0e5cAc77', false], // PancakeSwap V3
        ],
        0n, // minAmountBitLength
      ] as const,
      /** ABI-encoded (no 0x offset) for forge verify --constructor-args */
      encoded:
        '0x00000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000300000000000000000000000068b3465833fb72a70ecdf485e0e4c7bd8665fc4500000000000000000000000000000000000000000000000000000000000000000000000000000000000000008a21f6768c1f8075791d08546dadf6daa0be820c000000000000000000000000000000000000000000000000000000000000000100000000000000000000000032226588378236fd0c7c4053999f88ac0e5cac770000000000000000000000000000000000000000000000000000000000000000',
    },
    delegatedExecutor: {
      // Same RouterConfig[] constructor shape as SniperSearcher.
      types: ['(address,bool)[]', 'uint256'] as const,
      args: [
        [
          ['0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', false], // Uniswap V3
          ['0x8A21F6768C1f8075791D08546Dadf6daA0bE820c', true], // SushiSwap V3 (legacy 5-field ABI)
          ['0x32226588378236Fd0c7c4053999F88aC0e5cAc77', false], // PancakeSwap V3
        ],
        0n, // minAmountBitLength
      ] as const,
      encoded:
        '0x00000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000300000000000000000000000068b3465833fb72a70ecdf485e0e4c7bd8665fc4500000000000000000000000000000000000000000000000000000000000000000000000000000000000000008a21f6768c1f8075791d08546dadf6daa0be820c000000000000000000000000000000000000000000000000000000000000000100000000000000000000000032226588378236fd0c7c4053999f88ac0e5cac770000000000000000000000000000000000000000000000000000000000000000',
    },
    flashLoanReceiver: {
      types: ['address', 'address'] as const,
      args: [
        '0xBa0FAb34298983BC114Afa52685521571C1d84F9', // SniperSearcher (new deploy)
        '0x794a61358D6845594F94dc1DB02A252b5b4814aD', // Aave V3 Pool
      ] as const,
      encoded:
        '0x000000000000000000000000ba0fab34298983bc114afa52685521571c1d84f9000000000000000000000000794a61358d6845594f94dc1db02a252b5b4814ad',
    },
    basicEoaBatchExecutor: {
      types: [] as const,
      args: [] as const,
      encoded: '0x',
    },
  },
  /** Expected post-deploy permissions. */
  permissions: {
    sniperAllowsFlash: true,
    delegatedAllowsOwnerEoa: true,
  },
} as const;

const SNIPER_SEARCHER_ADDRESS = validateAndChecksumAddress(
  getOptionalEnv('SNIPER_SEARCHER_ADDRESS', ARBITRUM_DEPLOY.sniperSearcher)
);

const FLASH_LOAN_RECEIVER_ADDRESS = validateAndChecksumAddress(
  getOptionalEnv('FLASH_LOAN_RECEIVER_ADDRESS', ARBITRUM_DEPLOY.flashLoanReceiver)
);

const DELEGATED_EXECUTOR_ADDRESS = validateAndChecksumAddress(
  getOptionalEnv('DELEGATED_EXECUTOR_ADDRESS', ARBITRUM_DEPLOY.delegatedExecutor)
);

// Solady BEBE / ERC-7821 multi-target batch executor for EIP-7702.
// Canonical CREATE2 address (Vectorized/bebe) — same on all networks.
// Override with BATCH_EXECUTOR_ADDRESS for a self-deployed instance.
export const BEBE_CANONICAL_ADDRESS = ARBITRUM_DEPLOY.bebe;
const BATCH_EXECUTOR_ADDRESS_RAW = getOptionalEnv('BATCH_EXECUTOR_ADDRESS', BEBE_CANONICAL_ADDRESS);
const BATCH_EXECUTOR_ADDRESS = BATCH_EXECUTOR_ADDRESS_RAW
  ? validateAndChecksumAddress(BATCH_EXECUTOR_ADDRESS_RAW)
  : '';

export const CHAIN_ID = parseInt(getOptionalEnv('CHAIN_ID', '42161'));

const DEADLINE_MINUTES = parseInt(getOptionalEnv('DEADLINE_IN_MINUTES', '30'));

/**
 * Fresh per-tx deadline (seconds since epoch). Do not cache at module load —
 * long-running bots would send expired deadlines.
 */
export function getDeadline(minutes: number = DEADLINE_MINUTES): number {
  const deadline = Math.floor(Date.now() / 1000 + minutes * 60);
  validateDeadline(deadline);
  return deadline;
}

/** @deprecated Prefer getDeadline() per transaction — this freezes at import. */
export const DEADLINE = getDeadline();

/** Prefer BEBE type-4 flash initiation when signer is a Wallet and owner matches. */
export const FLASH_USE_TYPE4 = getOptionalEnv('FLASH_USE_TYPE4', 'false').toLowerCase() === 'true';

const SLIPPAGE_BPS = parseInt(getOptionalEnv('SLIPPAGE_TOLERANCE', '50'));
validateSlippage(SLIPPAGE_BPS);
export const SLIPPAGE_TOLERANCE = new Percent(SLIPPAGE_BPS, 10000);

const RPC_URL = getRequiredEnv('RPC');
validateRPC(RPC_URL);
export const provider = new JsonRpcProvider(RPC_URL);

export const signer = new Wallet(WALLET_PRIVATE_KEY, provider);

// Export validated contract addresses
export {
  SWAP_ROUTER_ADDRESS,
  QUOTER_ADDRESS,
  PERMIT2_ADDRESS,
  SNIPER_SEARCHER_ADDRESS,
  FLASH_LOAN_RECEIVER_ADDRESS,
  DELEGATED_EXECUTOR_ADDRESS,
  BATCH_EXECUTOR_ADDRESS,
};

// Verify signer has valid address
export const SIGNER_ADDRESS = validateAndChecksumAddress(signer.address);
