import { Contract, Signer, ethers } from 'ethers';

/**
 * Flash Loan Callback Handler
 * Executes arbitrage/swap logic within flash loan callback
 */
export class FlashLoanCallbackHandler {
  private signer: Signer;
  private flashLoanReceiverAddress: string;

  constructor(signer: Signer, flashLoanReceiverAddress: string) {
    this.signer = signer;
    this.flashLoanReceiverAddress = flashLoanReceiverAddress;
  }

  /**
   * Build callback data for flash loan execution
   */
  buildCallbackData(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    minOutputAmount: bigint,
    path: Buffer,
    swapRouterAddress: string
  ): string {
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    return abiCoder.encode(
      ['address', 'address', 'uint256', 'uint256', 'bytes', 'address'],
      [tokenIn, tokenOut, amountIn, minOutputAmount, path, swapRouterAddress]
    );
  }

  /**
   * Decode callback data from flash loan
   */
  decodeCallbackData(callbackData: string): {
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    minOutputAmount: bigint;
    path: Buffer;
    swapRouterAddress: string;
  } {
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const decoded = abiCoder.decode(
      ['address', 'address', 'uint256', 'uint256', 'bytes', 'address'],
      callbackData
    );

    return {
      tokenIn: decoded[0],
      tokenOut: decoded[1],
      amountIn: decoded[2],
      minOutputAmount: decoded[3],
      path: decoded[4],
      swapRouterAddress: decoded[5],
    };
  }

  /**
   * Estimate Aave V3 flash loan fee.
   * Live Arbitrum FLASHLOAN_PREMIUM_TOTAL = 5 bps (0.05%). Prefer reading
   * Pool.FLASHLOAN_PREMIUM_TOTAL() or FlashLoanReceiver.flashLoanPremiumBps()
   * for production sizing — this default is a hint only.
   */
  calculateFlashLoanFee(amount: bigint, feeBasisPoints: number = 5): bigint {
    return (amount * BigInt(feeBasisPoints)) / BigInt(10000);
  }

  /**
   * Simulate flash loan execution
   */
  async simulateFlashLoanExecution(
    _borrowToken: string,
    borrowAmount: bigint,
    callbackData: string
  ): Promise<{
    profit: bigint;
    fee: bigint;
    totalRepayment: bigint;
    isViable: boolean;
  }> {
    const decoded = this.decodeCallbackData(callbackData);
    const fee = this.calculateFlashLoanFee(borrowAmount);
    const totalRepayment = borrowAmount + fee;

    // In production, this would simulate the actual swap
    // For now, we estimate based on minOutputAmount
    const estimatedOutput = decoded.minOutputAmount;
    const profit = estimatedOutput > totalRepayment ? estimatedOutput - totalRepayment : 0n;

    return {
      profit,
      fee,
      totalRepayment,
      isViable: profit > 0,
    };
  }

  /**
   * Execute swap within flash loan callback context
   */
  async executeSwapInCallback(
    swapRouter: Contract,
    params: {
      tokenIn: string;
      tokenOut: string;
      amountIn: bigint;
      minOutputAmount: bigint;
      path: Buffer;
      deadline: number;
    }
  ): Promise<{ amountOut: bigint; txHash: string }> {
    try {
      // Build swap call
      const swapAbi = [
        'function swap((bytes,address,uint256,uint256,uint256) params) external payable returns (uint256)',
      ];

      const router = new Contract(
        (await (swapRouter as any).getAddress?.()) ??
          String((swapRouter as any).target ?? (swapRouter as any).address),
        swapAbi,
        this.signer
      );

      // Execute swap
      const tx = await router.swap(
        [params.path, params.tokenOut, params.amountIn, params.minOutputAmount, params.deadline],
        {
          gasLimit: BigInt(500000),
        }
      );

      const receipt = await tx.wait();
      return {
        amountOut: params.minOutputAmount, // In production, extract from receipt
        txHash: receipt.hash,
      };
    } catch (error) {
      const err = new Error(
        `Swap execution failed: ${error instanceof Error ? error.message : String(error)}`
      );
      throw err;
    }
  }

  /**
   * Verify repayment requirements
   */
  async verifyRepaymentBalance(
    token: Contract,
    requiredAmount: bigint,
    fromAddress: string
  ): Promise<boolean> {
    const balance = await token.balanceOf(fromAddress);
    return balance >= requiredAmount;
  }

  /**
   * Approve token for repayment
   */
  async approveTokenForRepayment(
    token: Contract,
    spender: string,
    amount: bigint
  ): Promise<string> {
    const tx = await token.approve(spender, amount);
    const receipt = await tx.wait();
    return receipt.hash;
  }

  /**
   * Execute full flash loan arbitrage flow
   */
  async executeFlashLoanArbitrage(
    aaveLendingPool: Contract,
    _swapRouter: Contract,
    borrowToken: string,
    borrowAmount: bigint,
    callbackData: string
  ): Promise<{
    success: boolean;
    profit?: bigint;
    fee?: bigint;
    txHash?: string;
    error?: string;
  }> {
    try {
      // 1. Simulate to check viability
      const simulation = await this.simulateFlashLoanExecution(
        borrowToken,
        borrowAmount,
        callbackData
      );

      if (!simulation.isViable) {
        return {
          success: false,
          error: 'Arbitrage not viable: profit <= fee',
        };
      }

      // 2. Initiate flash loan
      const tx = await aaveLendingPool.flashLoanSimple(
        this.flashLoanReceiverAddress,
        borrowToken,
        borrowAmount,
        callbackData,
        0 // referral code
      );

      const receipt = await tx.wait();

      return {
        success: true,
        profit: simulation.profit,
        fee: simulation.fee,
        txHash: receipt.hash,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Handle flash loan callback from Aave
   * This would be implemented in the smart contract
   */
  generateCallbackSignature(): string {
    // Aave V3 callback function signature
    const signature = 'executeOperation(address,uint256,uint256,address,bytes)';
    return ethers.keccak256(ethers.toUtf8Bytes(signature));
  }

  /**
   * Generate approval data for callback execution
   */
  generateApprovalData(
    token: string,
    amount: bigint,
    spender: string
  ): {
    to: string;
    data: string;
  } {
    const erc20Abi = ['function approve(address spender, uint256 amount)'];
    const iface = new ethers.Interface(erc20Abi);
    const data = iface.encodeFunctionData('approve', [spender, amount]);

    return {
      to: token,
      data,
    };
  }
}

export default FlashLoanCallbackHandler;
