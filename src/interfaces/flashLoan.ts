import { BigNumber } from 'ethers';

/**
 * Flash Loan Provider interface
 */
export interface IFlashLoanProvider {
  name: string;
  address: string;
  fee: number; // in basis points (e.g., 9 = 0.09%)
}

/**
 * Flash Loan Request structure
 */
export interface FlashLoanRequest {
  token: string;
  amount: BigNumber;
  borrower: string;
  initiator: string;
  callbackAddress: string;
  callbackData: string;
}

/**
 * Flash Loan Callback parameters
 */
export interface FlashLoanCallback {
  token: string;
  amount: BigNumber;
  premium: BigNumber;
  initiator: string;
}

/**
 * Aave V3 Flash Loan interface
 */
export interface IAaveV3FlashLoan {
  flashLoanSimple(
    receiver: string,
    token: string,
    amount: BigNumber,
    params: string,
    referralCode: number
  ): Promise<unknown>;

  flashLoan(
    receiver: string,
    tokens: string[],
    amounts: BigNumber[],
    modes: number[],
    onBehalfOf: string,
    params: string,
    referralCode: number
  ): Promise<unknown>;
}

/**
 * Flash Loan Executor interface
 */
export interface IFlashLoanExecutor {
  executeFlashLoan(
    token: string,
    amount: BigNumber,
    minOutputAmount: BigNumber,
    path: Buffer
  ): Promise<{
    success: boolean;
    txHash?: string;
    profit?: BigNumber;
    error?: string;
  }>;

  calculateFlashLoanFee(amount: BigNumber): BigNumber;
}

/**
 * Dydx V3 Flash Loan (alternative)
 */
export interface IDydxV3FlashLoan {
  operate(calls: unknown[]): Promise<unknown>;
}

export const AAVE_V3_ADDRESSES = {
  arbitrum: {
    lendingPool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    flashLoanReceiver: '', // to be deployed
  },
  ethereum: {
    lendingPool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4dE5E2',
    flashLoanReceiver: '', // to be deployed
  },
};

export const DYDX_V3_ADDRESSES = {
  arbitrum: '0x1a07460f4fCEb1e880857b3997b19dd931F34dD5',
  ethereum: '0x1E0447b19BB6EcFdAe1aB6DFf7B799EEe6c809a3',
};
