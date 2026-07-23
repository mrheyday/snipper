import { ethers } from 'ethers';
import { validateAndChecksumAddress, validateFeeTier } from './validation';

export interface IUniswapV3Router02 {
  exactInput(params: ExactInputParams): Promise<bigint>;
  exactInputSingle(params: ExactInputSingleParams): Promise<bigint>;
}

export interface ExactInputParams {
  path: Buffer;
  recipient: string;
  deadline: number;
  amountIn: bigint;
  amountOutMinimum: bigint;
}

export interface ExactInputSingleParams {
  tokenIn: string;
  tokenOut: string;
  fee: number;
  recipient: string;
  deadline: number;
  amountIn: bigint;
  amountOutMinimum: bigint;
  sqrtPriceLimitX96: bigint;
}

/**
 * Encode a swap path for Uniswap V3 multi-hop swaps
 * Path format: token0 → (fee) → token1 → (fee) → token2 → ...
 *
 * @param tokens Array of token addresses (will be checksummed)
 * @param fees Array of pool fees (3000, 500, etc.)
 * @returns Encoded path as Buffer
 */
export function encodePath(tokens: string[], fees: number[]): Buffer {
  if (tokens.length !== fees.length + 1) {
    throw new Error('tokens length must be fees length + 1');
  }

  // Validate and checksum all addresses
  const checksummedTokens = tokens.map((t) => validateAndChecksumAddress(t));

  // Validate all fee tiers
  for (const fee of fees) {
    validateFeeTier(fee);
  }

  let encoded = '0x';
  for (let i = 0; i < checksummedTokens.length; i++) {
    // Add token (remove 0x prefix)
    encoded += checksummedTokens[i].slice(2);

    // Add fee if not last token
    if (i < fees.length) {
      encoded += fees[i].toString(16).padStart(6, '0');
    }
  }

  return Buffer.from(encoded.slice(2), 'hex');
}

/**
 * Decode a Uniswap V3 swap path
 *
 * @param encoded Encoded path as hex string or Buffer
 * @returns Object with tokens array and fees array
 */
export function decodePath(encoded: string | Buffer): {
  tokens: string[];
  fees: number[];
} {
  const hex = typeof encoded === 'string' ? encoded : encoded.toString('hex');
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;

  const tokens: string[] = [];
  const fees: number[] = [];

  let offset = 0;

  while (offset < cleanHex.length) {
    // Read token (20 bytes = 40 hex chars)
    const token = '0x' + cleanHex.slice(offset, offset + 40);
    tokens.push(ethers.getAddress(token));
    offset += 40;

    // Read fee (3 bytes = 6 hex chars) if not at end
    if (offset < cleanHex.length) {
      const feeHex = cleanHex.slice(offset, offset + 6);
      fees.push(parseInt(feeHex, 16));
      offset += 6;
    }
  }

  return { tokens, fees };
}

/**
 * Common Uniswap V3 pool fees
 */
export const UNISWAP_FEES = {
  LOWEST: 100,
  LOW: 500,
  MEDIUM: 3000,
  HIGH: 10000,
} as const;

/**
 * Get optimal fee tier based on token volatility
 * Returns most common fee tier for token pair
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function getOptimalFee(tokenA: string, tokenB: string): number {
  // Default to medium fee (3000 = 0.3%)
  // In production, query Uniswap subgraph for actual pool fees
  return UNISWAP_FEES.MEDIUM;
}

/**
 * Calculate minimum output with slippage tolerance
 *
 * @param expectedOutput Expected output amount
 * @param slippagePercent Slippage tolerance in percentage (e.g., 0.5 for 0.5%)
 * @returns Minimum acceptable output
 */
export function calculateMinimumOutput(
  expectedOutput: bigint,
  slippagePercent: number
): bigint {
  const slippageBps = Math.floor(slippagePercent * 100); // Convert to basis points
  return expectedOutput * BigInt(10000 - slippageBps) / BigInt(10000);
}

/**
 * Validate a swap path - checks token addresses and fee tiers
 */
export function validatePath(tokens: string[], fees: number[]): boolean {
  if (tokens.length < 2) {
    throw new Error('Path must have at least 2 tokens');
  }

  if (tokens.length !== fees.length + 1) {
    throw new Error('Invalid fees array length');
  }

  // Validate all token addresses
  for (const token of tokens) {
    try {
      validateAndChecksumAddress(token);
    } catch (error) {
      const err = new Error(`Invalid token address: ${token}`) as Error & { cause: unknown };
      err.cause = error;
      throw err;
    }
  }

  // Validate all fee tiers
  for (const fee of fees) {
    try {
      validateFeeTier(fee);
    } catch (error) {
      const err = new Error(`Invalid fee tier: ${fee}`) as Error & { cause: unknown };
      err.cause = error;
      throw err;
    }
  }

  return true;
}

/**
 * Format swap path for display
 */
export function formatPath(tokens: string[], fees: number[]): string {
  let path = tokens[0].slice(0, 6) + '...';
  for (let i = 0; i < fees.length; i++) {
    const feePercent = (fees[i] / 10000) * 100;
    path += ` →(${feePercent}%)→ `;
    path += tokens[i + 1].slice(0, 6) + '...';
  }
  return path;
}

export default {
  encodePath,
  decodePath,
  UNISWAP_FEES,
  getOptimalFee,
  calculateMinimumOutput,
  validatePath,
  formatPath,
};
