import { ethers } from 'ethers';
import { provider, signer } from './config';
import { Logger } from './logger';
import { validateAndChecksumAddress } from './validation';

const logger = new Logger('ERC4337');

/**
 * ERC-4337: Account Abstraction
 * Enables smart contract wallets with gas abstraction
 * Bundlers handle transaction ordering and gas payment
 *
 * Key Components:
 * - UserOperation: Intent-based transaction from wallet
 * - EntryPoint: Contract coordinating validation + execution
 * - Bundler: Collects UserOps and submits batches
 * - Paymaster: Sponsor gas fees
 *
 * Reference: https://eips.ethereum.org/EIPS/eip-4337
 */

interface UserOperation {
  sender: string;
  nonce: bigint;
  initCode: string;
  callData: string;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymasterAndData: string;
  signature: string;
}

interface SmartWalletExecutionResult {
  success: boolean;
  userOpHash?: string;
  txHash?: string;
  error?: string;
  receipt?: ethers.TransactionReceipt;
}

/**
 * Smart Wallet for Account Abstraction
 * Executes swaps and flash loans through account abstraction
 */
export class ERC4337SmartWallet {
  private entryPoint: string;
  private walletAddress: string;
  private chainId: number;

  constructor(walletAddress: string, entryPointAddress: string, chainId: number = 42161) {
    this.walletAddress = validateAndChecksumAddress(walletAddress);
    this.entryPoint = validateAndChecksumAddress(entryPointAddress);
    this.chainId = chainId;

    logger.info(`Initialized ERC-4337 wallet: ${this.walletAddress}`);
    logger.info(`Entry Point: ${this.entryPoint}`);
  }

  /**
   * Create UserOperation for swap execution
   * Enables gasless execution through bundler
   */
  async createSwapUserOperation(params: {
    swapRouterAddress: string;
    tokenIn: string;
    amountIn: bigint;
    minAmountOut: bigint;
    path: Buffer;
    deadline: number;
  }): Promise<UserOperation> {
    const nonce = await this.getWalletNonce();

    logger.info(`Creating UserOperation with nonce ${nonce}`);

    // SwapRouter02 exactInput((bytes,address,uint256,uint256)) — no deadline field
    const swapRouterInterface = new ethers.Interface([
      'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
    ]);

    const callData = swapRouterInterface.encodeFunctionData('exactInput', [
      {
        path: ethers.hexlify(params.path),
        recipient: this.walletAddress,
        amountIn: params.amountIn,
        amountOutMinimum: params.minAmountOut,
      },
    ]);

    // Wrap in wallet executeCall (sample structure)
    const walletInterface = new ethers.Interface([
      'function executeCall(address target, uint256 value, bytes calldata data) external',
    ]);

    const walletCallData = walletInterface.encodeFunctionData('executeCall', [
      params.swapRouterAddress,
      BigInt(0),
      callData,
    ]);

    const gasPrice = (await provider.getFeeData()).gasPrice ?? 0n;
    const baseFee = (await provider.getBlock('latest'))?.baseFeePerGas ?? gasPrice;

    return {
      sender: this.walletAddress,
      nonce: BigInt(nonce),
      initCode: '0x', // No factory call needed if wallet exists
      callData: walletCallData,
      callGasLimit: BigInt('200000'),
      verificationGasLimit: BigInt('100000'),
      preVerificationGas: BigInt('50000'),
      maxFeePerGas: (baseFee * 2n), // 2x current base fee
      maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
      paymasterAndData: '0x', // No paymaster for now
      signature: '0x', // Will be signed
    };
  }

  /**
   * Create UserOperation for flash loan execution
   * Enables flash loan + swap in single batched operation
   */
  async createFlashLoanUserOperation(params: {
    lendingPoolAddress: string;
    borrowToken: string;
    borrowAmount: bigint;
    swapRouterAddress: string;
    path: Buffer;
    minAmountOut: bigint;
    deadline: number;
  }): Promise<UserOperation> {
    const nonce = await this.getWalletNonce();

    logger.info(`Creating Flash Loan UserOperation with nonce ${nonce}`);

    // Prepare flash loan initiation call
    const lendingPoolInterface = new ethers.Interface([
      'function flashLoanSimple(address receiver, address token, uint256 amount, bytes calldata params, uint16 referralCode) external',
    ]);

    // Encode swap as callback params
    const swapData = ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'bytes', 'uint256'],
      [params.swapRouterAddress, params.path, params.minAmountOut]
    );

    const flashLoanCall = lendingPoolInterface.encodeFunctionData('flashLoanSimple', [
      this.walletAddress, // Callback receiver
      params.borrowToken,
      params.borrowAmount,
      swapData,
      0, // No referral
    ]);

    // Wrap in wallet executeCall
    const walletInterface = new ethers.Interface([
      'function executeCall(address target, uint256 value, bytes calldata data) external',
    ]);

    const walletCallData = walletInterface.encodeFunctionData('executeCall', [
      params.lendingPoolAddress,
      BigInt(0),
      flashLoanCall,
    ]);

    const gasPrice = (await provider.getFeeData()).gasPrice ?? 0n;
    const baseFee = (await provider.getBlock('latest'))?.baseFeePerGas ?? gasPrice;

    return {
      sender: this.walletAddress,
      nonce: BigInt(nonce),
      initCode: '0x',
      callData: walletCallData,
      callGasLimit: BigInt('400000'), // Flash loans need more gas
      verificationGasLimit: BigInt('150000'),
      preVerificationGas: BigInt('100000'),
      maxFeePerGas: (baseFee * 2n),
      maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
      paymasterAndData: '0x',
      signature: '0x',
    };
  }

  /**
   * Sign UserOperation
   * Signs intent for bundler submission
   */
  async signUserOperation(userOp: UserOperation): Promise<UserOperation> {
    logger.info('Signing UserOperation');

    // Pack and hash per EIP-4337
    const encoded = this.encodeUserOperation(userOp);
    const hash = ethers.keccak256(encoded);

    // Sign hash
    const sig = await signer.signMessage(ethers.getBytes(hash));

    return {
      ...userOp,
      signature: sig,
    };
  }

  /**
   * Send UserOperation to bundler
   * Real implementation would use bundler RPC endpoint
   */
  async sendUserOperation(userOp: UserOperation): Promise<SmartWalletExecutionResult> {
    try {
      logger.info(`Sending UserOperation from ${userOp.sender}`);

      // Calculate UserOp hash
      const userOpHash = this.calculateUserOpHash(userOp);
      logger.info(`UserOp Hash: ${userOpHash}`);

      // In production, send to bundler RPC endpoint:
      // const bundlerProvider = new ethers.JsonRpcProvider(bundlerEndpoint);
      // const userOpHash = await bundlerProvider.send('eth_sendUserOperation', [userOp, entryPoint]);

      // Simulate execution (replace with real bundler call)
      logger.warn(
        'Note: Production requires bundler RPC endpoint (Alchemy, Pimlico, Stackup, etc.)'
      );

      return {
        success: true,
        userOpHash,
        error: 'Awaiting bundler submission (dev mode)',
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`UserOperation submission failed: ${errorMsg}`);

      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Get wallet nonce for next UserOperation
   */
  private async getWalletNonce(): Promise<number> {
    // In production, call entryPoint.getNonce(walletAddress, 0)
    const nonce = await provider.getTransactionCount(this.walletAddress);
    return nonce;
  }

  /**
   * Encode UserOperation per EIP-4337 spec
   */
  private encodeUserOperation(userOp: UserOperation): string {
    return ethers.solidityPacked(
      [
        'address',
        'uint256',
        'bytes32',
        'bytes32',
        'uint256',
        'uint256',
        'uint256',
        'uint256',
        'uint256',
        'bytes32',
      ],
      [
        userOp.sender,
        userOp.nonce,
        ethers.keccak256(userOp.initCode),
        ethers.keccak256(userOp.callData),
        userOp.callGasLimit,
        userOp.verificationGasLimit,
        userOp.preVerificationGas,
        userOp.maxFeePerGas,
        userOp.maxPriorityFeePerGas,
        ethers.keccak256(userOp.paymasterAndData),
      ]
    );
  }

  /**
   * Calculate UserOp hash (simplified)
   */
  private calculateUserOpHash(userOp: UserOperation): string {
    const encoded = this.encodeUserOperation(userOp);
    return ethers.keccak256(
      ethers.solidityPacked(
        ['bytes32', 'address', 'uint256'],
        [ethers.keccak256(encoded), this.entryPoint, this.chainId]
      )
    );
  }
}

/**
 * Bundler client for submitting UserOperations
 * Integrates with Alchemy, Pimlico, Stackup bundler networks
 */
export class ERC4337BundlerClient {
  private bundlerUrl: string;
  private entryPoint: string;

  constructor(bundlerUrl: string, entryPointAddress: string) {
    this.bundlerUrl = bundlerUrl;
    this.entryPoint = entryPointAddress;

    logger.info(`Initialized ERC-4337 Bundler: ${bundlerUrl}`);
  }

  /**
   * Submit UserOperation to bundler
   * Bundler validates, batches, and executes
   */
  async sendUserOperation(userOp: UserOperation): Promise<string> {
    logger.info('Sending UserOperation to bundler');

    try {
      const response = await fetch(this.bundlerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_sendUserOperation',
          params: [this.formatUserOp(userOp), this.entryPoint],
        }),
      });

      if (!response.ok) {
        throw new Error(`Bundler error: ${response.statusText}`);
      }

      const data = (await response.json()) as { result?: string; error?: { message: string } };

      if (data.error) {
        throw new Error(`Bundler RPC error: ${data.error.message}`);
      }

      if (!data.result) {
        throw new Error('No UserOp hash returned');
      }

      logger.info(`UserOp submitted: ${data.result}`);
      return data.result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Bundler submission failed: ${errorMsg}`);
      throw error;
    }
  }

  /**
   * Get UserOperation receipt
   */
  async getUserOperationReceipt(userOpHash: string): Promise<ethers.TransactionReceipt | null> {
    try {
      const response = await fetch(this.bundlerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getUserOperationReceipt',
          params: [userOpHash],
        }),
      });

      const data = (await response.json()) as {
        result?: ethers.TransactionReceipt;
        error?: { message: string };
      };

      if (data.error) {
        return null;
      }

      return data.result || null;
    } catch (error) {
      logger.error(`Failed to get UserOp receipt: ${error}`);
      return null;
    }
  }

  /**
   * Format UserOperation for JSON-RPC
   */
  private formatUserOp(userOp: UserOperation): Record<string, string> {
    return {
      sender: userOp.sender,
      nonce: ethers.toBeHex(userOp.nonce),
      initCode: userOp.initCode,
      callData: userOp.callData,
      callGasLimit: ethers.toBeHex(userOp.callGasLimit),
      verificationGasLimit: ethers.toBeHex(userOp.verificationGasLimit),
      preVerificationGas: ethers.toBeHex(userOp.preVerificationGas),
      maxFeePerGas: ethers.toBeHex(userOp.maxFeePerGas),
      maxPriorityFeePerGas: ethers.toBeHex(userOp.maxPriorityFeePerGas),
      paymasterAndData: userOp.paymasterAndData,
      signature: userOp.signature,
    };
  }
}

export default ERC4337SmartWallet;
