import { BigNumber, Signer, providers } from 'ethers';
import { Pool, InterestRate, EthereumTransactionTypeExtended } from '@aave/contract-helpers';
import { signer, provider } from './config';
import { Logger } from './logger';

const logger = new Logger('AaveLending');

// Aave V3 Pool on Arbitrum, same address used throughout this project and
// verified on-chain (ADDRESSES_PROVIDER() cross-checked against the official
// bgd-labs/aave-address-book entry for Arbitrum).
const AAVE_POOL_ADDRESS = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';

export { InterestRate };

interface LendingResult {
  success: boolean;
  txHashes?: string[];
  error?: string;
}

/**
 * Aave V3 lending operations: supply, withdraw, borrow, repay.
 *
 * Unlike FlashLoanExecutor (borrow + repay atomically within one transaction,
 * no standing position), this maintains a real, ongoing Aave position: supplied
 * collateral and/or open debt that persists across transactions.
 */
export class AaveLending {
  private pool: Pool;
  private lendingSigner: Signer;

  constructor(lendingSigner?: Signer, lendingProvider?: providers.Provider) {
    this.lendingSigner = lendingSigner || signer;
    this.pool = new Pool(lendingProvider || provider, {
      POOL: AAVE_POOL_ADDRESS,
    });
  }

  /**
   * Supply (deposit) an asset as collateral. Earns supply APY; can be used
   * as collateral for borrowing if the reserve allows it.
   */
  async supply(reserveAddress: string, amountHuman: string): Promise<LendingResult> {
    const user = await this.lendingSigner.getAddress();
    logger.info(`Supplying ${amountHuman} of ${reserveAddress}`);

    const txs = await this.pool.supply({
      user,
      reserve: reserveAddress,
      amount: amountHuman,
    });

    return this._sendTxs(txs);
  }

  /**
   * Withdraw a previously supplied asset. Pass amount: 'max' to withdraw
   * the full suppliable balance (Aave's UINT256_MAX convention).
   */
  async withdraw(reserveAddress: string, amountHuman: string): Promise<LendingResult> {
    const user = await this.lendingSigner.getAddress();
    logger.info(`Withdrawing ${amountHuman} of ${reserveAddress}`);

    const txs = await this.pool.withdraw({
      user,
      reserve: reserveAddress,
      amount: amountHuman,
    });

    return this._sendTxs(txs);
  }

  /**
   * Borrow an asset against supplied collateral. Requires the reserve to
   * have borrowing enabled and the account to have sufficient collateral —
   * check both via UiPoolDataProvider before calling this.
   */
  async borrow(
    reserveAddress: string,
    amountHuman: string,
    interestRateMode: InterestRate = InterestRate.Variable
  ): Promise<LendingResult> {
    const user = await this.lendingSigner.getAddress();
    logger.info(`Borrowing ${amountHuman} of ${reserveAddress} (${interestRateMode} rate)`);

    const txs = await this.pool.borrow({
      user,
      reserve: reserveAddress,
      amount: amountHuman,
      interestRateMode,
    });

    return this._sendTxs(txs);
  }

  /**
   * Repay borrowed debt. Pass amount: 'max' to repay the full debt balance.
   */
  async repay(
    reserveAddress: string,
    amountHuman: string,
    interestRateMode: InterestRate = InterestRate.Variable
  ): Promise<LendingResult> {
    const user = await this.lendingSigner.getAddress();
    logger.info(`Repaying ${amountHuman} of ${reserveAddress} (${interestRateMode} rate)`);

    const txs = await this.pool.repay({
      user,
      reserve: reserveAddress,
      amount: amountHuman,
      interestRateMode,
    });

    return this._sendTxs(txs);
  }

  /**
   * Send a sequence of transactions (e.g. ERC20 approval followed by the
   * main action) returned by an @aave/contract-helpers Pool method, waiting
   * for each to confirm before sending the next.
   */
  private async _sendTxs(txs: EthereumTransactionTypeExtended[]): Promise<LendingResult> {
    const txHashes: string[] = [];
    try {
      for (const extendedTx of txs) {
        const populatedTx = await extendedTx.tx();
        const gasLimit = populatedTx.gasLimit
          ? BigNumber.from(populatedTx.gasLimit.toString()).mul(115).div(100)
          : undefined;

        const sentTx = await this.lendingSigner.sendTransaction({
          ...populatedTx,
          gasLimit,
        });
        logger.info(`[${extendedTx.txType}] sent: ${sentTx.hash}`);

        const receipt = await sentTx.wait(2);
        if (receipt.status === 0) {
          return {
            success: false,
            txHashes,
            error: `Transaction reverted: ${sentTx.hash}`,
          };
        }
        txHashes.push(sentTx.hash);
      }

      return { success: true, txHashes };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.error(`Lending operation failed: ${reason}`);
      return { success: false, txHashes, error: reason };
    }
  }
}

export default AaveLending;
