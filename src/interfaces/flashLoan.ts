
/**
 * Flash Loan Provider interface
 */
export interface IFlashLoanProvider {
  name: string;
  address: string;
  fee: number; // in basis points (e.g., 5 = 0.05% on Arbitrum Aave V3)
}

/**
 * Flash Loan Request structure
 */
export interface FlashLoanRequest {
  token: string;
  amount: bigint;
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
  amount: bigint;
  premium: bigint;
  initiator: string;
}

/**
 * Aave V3 Flash Loan interface
 */
export interface IAaveV3FlashLoan {
  flashLoanSimple(
    receiver: string,
    token: string,
    amount: bigint,
    params: string,
    referralCode: number
  ): Promise<unknown>;

  flashLoan(
    receiver: string,
    tokens: string[],
    amounts: bigint[],
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
    amount: bigint,
    minOutputAmount: bigint,
    path: Buffer
  ): Promise<{
    success: boolean;
    txHash?: string;
    profit?: bigint;
    error?: string;
  }>;

  calculateFlashLoanFee(amount: bigint): bigint;
}

/**
 * Dydx V3 Flash Loan (alternative)
 */
export interface IDydxV3FlashLoan {
  operate(calls: unknown[]): Promise<unknown>;
}
