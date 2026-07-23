import { ethers } from 'ethers';

/**
 * Validation utilities for bot configuration and swap parameters
 */

/**
 * Validate and retrieve required environment variable
 */
export function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Validate and retrieve optional environment variable with default
 */
export function getOptionalEnv(name: string, defaultValue: string): string {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : defaultValue;
}

/**
 * Validate wallet private key format
 */
export function validatePrivateKey(key: string): void {
  if (!key.startsWith('0x')) {
    throw new Error('Private key must start with 0x');
  }
  if (key.length !== 66) {
    throw new Error('Private key must be 66 characters (0x + 64 hex chars)');
  }
  try {
    new ethers.Wallet(key);
  } catch (error) {
    const err = new Error(
      `Invalid private key format: ${error instanceof Error ? error.message : String(error)}`
    ) as Error & { cause: unknown };
    err.cause = error;
    throw err;
  }
}

/**
 * Validate and checksum Ethereum address (EIP-55)
 */
export function validateAndChecksumAddress(address: string): string {
  if (!ethers.isAddress(address)) {
    throw new Error(`Invalid Ethereum address: ${address}`);
  }
  return ethers.getAddress(address);
}

/**
 * Validate RPC URL
 */
export function validateRPC(rpcUrl: string): void {
  try {
    const url = new URL(rpcUrl);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
      throw new Error('Invalid RPC protocol');
    }
  } catch (error) {
    const err = new Error(
      `Invalid RPC URL: ${error instanceof Error ? error.message : String(error)}`
    ) as Error & { cause: unknown };
    err.cause = error;
    throw err;
  }
}

/**
 * Validate swap parameters
 */
export function validateSwapParams(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  minAmountOut: bigint
): void {
  // Validate tokens are different
  const checksummedIn = validateAndChecksumAddress(tokenIn);
  const checksummedOut = validateAndChecksumAddress(tokenOut);

  if (checksummedIn.toLowerCase() === checksummedOut.toLowerCase()) {
    throw new Error('tokenIn and tokenOut cannot be the same');
  }

  // Validate amounts are positive
  if (!amountIn || amountIn <= 0) {
    throw new Error('amountIn must be greater than 0');
  }

  if (!minAmountOut || minAmountOut < 0) {
    throw new Error('minAmountOut must be non-negative');
  }

  // Validate minAmountOut <= amountIn (sanity check)
  if (minAmountOut > amountIn * 2n) {
    throw new Error('minAmountOut suspiciously high compared to amountIn');
  }
}

/**
 * Validate fee tier for Uniswap V3
 */
export function validateFeeTier(feeTier: number): void {
  const validTiers = [100, 500, 3000, 10000];
  if (!validTiers.includes(feeTier)) {
    throw new Error(
      `Invalid Uniswap V3 fee tier: ${feeTier}. Must be one of: ${validTiers.join(', ')}`
    );
  }
}

/**
 * Validate deadline is in the future
 */
export function validateDeadline(deadline: number): void {
  const now = Math.floor(Date.now() / 1000);
  if (deadline <= now) {
    throw new Error('Deadline must be in the future');
  }
  if (deadline > now + 3600) {
    throw new Error('Deadline too far in the future (max 1 hour)');
  }
}

/**
 * Validate slippage is reasonable (0.01% to 50%)
 */
export function validateSlippage(slippageBps: number): void {
  if (slippageBps < 1) {
    throw new Error('Slippage tolerance too low (minimum 0.01%)');
  }
  if (slippageBps > 5000) {
    throw new Error('Slippage tolerance too high (maximum 50%)');
  }
}
