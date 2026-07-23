import { Percent } from '@uniswap/sdk-core';
import { providers, Wallet } from 'ethers';
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

const QUOTER_ADDRESS = validateAndChecksumAddress(
  getOptionalEnv('QUOTER_ADDRESS', '0x61fFE014bA17989E743c5F6cB21bF9697530B21e')
);

const PERMIT2_ADDRESS = validateAndChecksumAddress(
  getOptionalEnv('PERMIT2_ADDRESS', '0x000000000022D473030f116DfC393aC15502d30e')
);

const SNIPER_SEARCHER_ADDRESS = validateAndChecksumAddress(
  getRequiredEnv('SNIPER_SEARCHER_ADDRESS')
);

const FLASH_LOAN_RECEIVER_ADDRESS = validateAndChecksumAddress(
  getRequiredEnv('FLASH_LOAN_RECEIVER_ADDRESS')
);

const DELEGATED_EXECUTOR_ADDRESS = validateAndChecksumAddress(
  getRequiredEnv('DELEGATED_EXECUTOR_ADDRESS')
);

export const CHAIN_ID = parseInt(getOptionalEnv('CHAIN_ID', '42161'));

const DEADLINE_MINUTES = parseInt(getOptionalEnv('DEADLINE_IN_MINUTES', '30'));
export const DEADLINE = Math.floor(Date.now() / 1000 + DEADLINE_MINUTES * 60);
validateDeadline(DEADLINE);

const SLIPPAGE_BPS = parseInt(getOptionalEnv('SLIPPAGE_TOLERANCE', '50'));
validateSlippage(SLIPPAGE_BPS);
export const SLIPPAGE_TOLERANCE = new Percent(SLIPPAGE_BPS, 10000);

const RPC_URL = getRequiredEnv('RPC');
validateRPC(RPC_URL);
export const provider = new providers.JsonRpcProvider(RPC_URL);

export const signer = new Wallet(WALLET_PRIVATE_KEY, provider);

// Export validated contract addresses
export {
  SWAP_ROUTER_ADDRESS,
  QUOTER_ADDRESS,
  PERMIT2_ADDRESS,
  SNIPER_SEARCHER_ADDRESS,
  FLASH_LOAN_RECEIVER_ADDRESS,
  DELEGATED_EXECUTOR_ADDRESS,
};

// Verify signer has valid address
export const SIGNER_ADDRESS = validateAndChecksumAddress(signer.address);
