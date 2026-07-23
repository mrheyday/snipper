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
 * Override via env for forks / redeploys.
 */
export const ARBITRUM_DEPLOY = {
  chainId: 42161,
  owner: '0x00000001386687D89e6A36aE01C5e5F75acF61Af',
  sniperSearcher: '0xAC7465949D3178C9F13d629c6417b2a02D50DdC8',
  flashLoanReceiver: '0xdce71b4f28dcc5686B3B4e8790bD6051345A89b8',
  delegatedExecutor: '0xc7a5B0873CB174A78017A66b541B24be64fBAde4',
  /** Vectorized BEBE CREATE2 (canonical multi-target batch). */
  bebe: '0x00000000BEBEDB7C30ee418158e26E31a5A8f3E2',
  swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  aaveV3Pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  minAmountBitLength: 0,
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
const BATCH_EXECUTOR_ADDRESS_RAW = getOptionalEnv(
  'BATCH_EXECUTOR_ADDRESS',
  BEBE_CANONICAL_ADDRESS
);
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
export const FLASH_USE_TYPE4 =
  getOptionalEnv('FLASH_USE_TYPE4', 'false').toLowerCase() === 'true';

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
