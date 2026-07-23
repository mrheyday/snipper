/**
 * Shared EIP-1559 fee helper for type-2 and type-4 sends.
 */
import { provider } from './config';
import { ethers } from 'ethers';

export type FeeHints = {
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
};

/**
 * Resolve tip + max fee from the provider. Never uses legacy gasPrice alone
 * as maxFeePerGas without a priority component.
 */
export async function getEip1559Fees(opts?: {
  tipMultiplier?: number;
  maxMultiplier?: number;
}): Promise<FeeHints> {
  const tipMul = opts?.tipMultiplier ?? 1;
  const maxMul = opts?.maxMultiplier ?? 120; // percent of base estimate

  const fee = await provider.getFeeData();
  const tip = fee.maxPriorityFeePerGas ?? ethers.parseUnits('0.01', 'gwei');

  let maxFee = fee.maxFeePerGas ?? ((fee.gasPrice ?? tip * 2n) * BigInt(maxMul)) / 100n;

  const scaledTip = (tip * BigInt(Math.floor(tipMul * 100))) / 100n;
  if (maxFee < scaledTip) {
    maxFee = scaledTip * 2n;
  }

  return {
    maxPriorityFeePerGas: scaledTip,
    maxFeePerGas: maxFee,
  };
}
