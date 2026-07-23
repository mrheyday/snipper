/**
 * Aave V3 lending ops via ethers v6 (no @aave/contract-helpers).
 */
import {
  Contract,
  MaxUint256,
  parseUnits,
  type Provider,
  type Signer,
} from 'ethers';
import { signer } from './config';
import { Logger } from './logger';
import { AAVE_POOL_ARBITRUM } from './aaveReserves';

const logger = new Logger('AaveLending');

export enum InterestRate {
  None = 'None',
  Stable = 'Stable',
  Variable = 'Variable',
}

const POOL_ABI = [
  'function supply(address asset,uint256 amount,address onBehalfOf,uint16 referralCode)',
  'function withdraw(address asset,uint256 amount,address to) returns (uint256)',
  'function borrow(address asset,uint256 amount,uint256 interestRateMode,uint16 referralCode,address onBehalfOf)',
  'function repay(address asset,uint256 amount,uint256 interestRateMode,address onBehalfOf) returns (uint256)',
];

const ERC20_ABI = [
  'function approve(address spender,uint256 amount) returns (bool)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

interface LendingResult {
  success: boolean;
  txHashes?: string[];
  error?: string;
}

function rateMode(mode: InterestRate): number {
  return mode === InterestRate.Stable ? 1 : 2;
}

export class AaveLending {
  private pool: Contract;
  private lendingSigner: Signer;

  constructor(lendingSigner?: Signer, _lendingProvider?: Provider) {
    this.lendingSigner = lendingSigner || signer;
    this.pool = new Contract(AAVE_POOL_ARBITRUM, POOL_ABI, this.lendingSigner);
  }

  private async token(reserve: string): Promise<Contract> {
    return new Contract(reserve, ERC20_ABI, this.lendingSigner);
  }

  private async amountRaw(reserve: string, amountHuman: string): Promise<bigint> {
    if (amountHuman === 'max') return MaxUint256;
    const t = await this.token(reserve);
    const decimals = Number(await t.decimals());
    return parseUnits(amountHuman, decimals);
  }

  private async ensureApprove(reserve: string, amount: bigint): Promise<string | undefined> {
    const user = await this.lendingSigner.getAddress();
    const t = await this.token(reserve);
    const current: bigint = await t.allowance(user, AAVE_POOL_ARBITRUM);
    if (current >= amount) return undefined;
    if (current > 0n) {
      const reset = await t.approve(AAVE_POOL_ARBITRUM, 0n);
      await reset.wait(1);
    }
    const tx = await t.approve(AAVE_POOL_ARBITRUM, amount);
    await tx.wait(1);
    return tx.hash as string;
  }

  async supply(reserveAddress: string, amountHuman: string): Promise<LendingResult> {
    try {
      const user = await this.lendingSigner.getAddress();
      const amount = await this.amountRaw(reserveAddress, amountHuman);
      logger.info('Supplying ' + amountHuman + ' of ' + reserveAddress);
      const hashes: string[] = [];
      const approveHash = await this.ensureApprove(reserveAddress, amount);
      if (approveHash) hashes.push(approveHash);
      const tx = await this.pool.supply(reserveAddress, amount, user, 0);
      const receipt = await tx.wait(1);
      if (!receipt || receipt.status === 0) {
        return { success: false, txHashes: hashes, error: 'supply reverted' };
      }
      hashes.push(tx.hash);
      return { success: true, txHashes: hashes };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async withdraw(reserveAddress: string, amountHuman: string): Promise<LendingResult> {
    try {
      const user = await this.lendingSigner.getAddress();
      const amount = await this.amountRaw(reserveAddress, amountHuman);
      logger.info('Withdrawing ' + amountHuman + ' of ' + reserveAddress);
      const tx = await this.pool.withdraw(reserveAddress, amount, user);
      const receipt = await tx.wait(1);
      if (!receipt || receipt.status === 0) {
        return { success: false, error: 'withdraw reverted' };
      }
      return { success: true, txHashes: [tx.hash] };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async borrow(
    reserveAddress: string,
    amountHuman: string,
    interestRateMode: InterestRate = InterestRate.Variable
  ): Promise<LendingResult> {
    try {
      const user = await this.lendingSigner.getAddress();
      const amount = await this.amountRaw(reserveAddress, amountHuman);
      logger.info('Borrowing ' + amountHuman + ' of ' + reserveAddress);
      const tx = await this.pool.borrow(
        reserveAddress,
        amount,
        rateMode(interestRateMode),
        0,
        user
      );
      const receipt = await tx.wait(1);
      if (!receipt || receipt.status === 0) {
        return { success: false, error: 'borrow reverted' };
      }
      return { success: true, txHashes: [tx.hash] };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async repay(
    reserveAddress: string,
    amountHuman: string,
    interestRateMode: InterestRate = InterestRate.Variable
  ): Promise<LendingResult> {
    try {
      const user = await this.lendingSigner.getAddress();
      const amount = await this.amountRaw(reserveAddress, amountHuman);
      logger.info('Repaying ' + amountHuman + ' of ' + reserveAddress);
      const hashes: string[] = [];
      const approveHash = await this.ensureApprove(reserveAddress, amount);
      if (approveHash) hashes.push(approveHash);
      const tx = await this.pool.repay(
        reserveAddress,
        amount,
        rateMode(interestRateMode),
        user
      );
      const receipt = await tx.wait(1);
      if (!receipt || receipt.status === 0) {
        return { success: false, txHashes: hashes, error: 'repay reverted' };
      }
      hashes.push(tx.hash);
      return { success: true, txHashes: hashes };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

export default AaveLending;
