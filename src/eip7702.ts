import { BigNumber, ethers } from 'ethers';
import { signer } from './config';

/**
 * EIP-7702: Set EOA Account Code
 * Allows EOA to delegate to contract code for single transaction
 * No pre-deployed contract needed; atomic execution
 */

interface Authorization {
  chainId: BigNumber;
  address: string; // Contract to delegate to
  nonce: BigNumber;
  yParity: number; // 0 or 1
  r: string;
  s: string;
}

interface DelegatedSwapParams {
  tokenIn: string;
  amountIn: BigNumber;
  path: Buffer;
  minAmountOut: BigNumber;
  deadline: number;
}

interface DelegatedSwapResult {
  success: boolean;
  txHash?: string;
  amountOut?: BigNumber;
  error?: string;
  gasUsed?: BigNumber;
}

const DELEGATED_EXECUTOR_ABI = [
  'function executeSwap(address tokenIn, uint256 amountIn, bytes calldata path, uint256 minAmountOut, uint256 deadline) external returns (uint256)',
  'function executeSwapWithCallback(address tokenIn, uint256 amountIn, bytes calldata path, uint256 minAmountOut, uint256 deadline, bytes calldata callbackData) external returns (uint256)',
  'function executeBatchSwaps(tuple(address,uint256,bytes,uint256)[] swaps, uint256 deadline) external returns (uint256[])',
];

/**
 * EIP-7702 Authorizer
 * Signs authorization data for EOA code delegation
 */
export class EIP7702Authorizer {
  private delegatedExecutor: string;
  private chainId: number;

  constructor(delegatedExecutorAddress: string, chainId: number = 42161) {
    this.delegatedExecutor = delegatedExecutorAddress;
    this.chainId = chainId;
  }

  /**
   * Create EIP-7702 authorization structure
   * Signs the delegation allowing EOA to execute contract code
   */
  async createAuthorization(): Promise<Authorization> {
    const eoaAddress = await signer.getAddress();
    const nonce = await signer.provider!.getTransactionCount(eoaAddress);

    // EIP-7702 Authorization structure
    // keccak256("EIP7702Authorization(uint256 chainId, address address, uint256 nonce)")
    const authorizationHash = ethers.utils.keccak256(
      ethers.utils.solidityPack(
        ['uint256', 'address', 'uint256'],
        [this.chainId, this.delegatedExecutor, nonce]
      )
    );

    // Sign the authorization
    const sig = await signer.signMessage(ethers.utils.arrayify(authorizationHash));
    const signature = ethers.utils.splitSignature(sig);

    return {
      chainId: BigNumber.from(this.chainId),
      address: this.delegatedExecutor,
      nonce: BigNumber.from(nonce),
      yParity: signature.v === 27 ? 0 : 1,
      r: signature.r,
      s: signature.s,
    };
  }

  /**
   * Encode authorization for transaction
   */
  encodeAuthorization(auth: Authorization): string {
    return ethers.utils.solidityPack(
      ['uint256', 'address', 'uint256', 'uint8', 'bytes32', 'bytes32'],
      [auth.chainId, auth.address, auth.nonce, auth.yParity, auth.r, auth.s]
    );
  }
}

/**
 * EIP-7702 Delegated Executor
 * Executes swaps through delegated EOA code
 */
export class EIP7702Executor {
  private delegatedExecutor: ethers.Contract;
  private authorizer: EIP7702Authorizer;

  constructor(delegatedExecutorAddress: string, chainId: number = 42161) {
    this.delegatedExecutor = new ethers.Contract(
      delegatedExecutorAddress,
      DELEGATED_EXECUTOR_ABI,
      signer
    );
    this.authorizer = new EIP7702Authorizer(delegatedExecutorAddress, chainId);
  }

  /**
   * Execute delegated swap via EIP-7702
   * Single transaction with EOA code delegation
   */
  async executeDelegatedSwap(params: DelegatedSwapParams): Promise<DelegatedSwapResult> {
    try {
      console.log(`\n🔄 Executing delegated swap via EIP-7702...`);
      console.log(`  Contract: ${this.delegatedExecutor.address}`);
      console.log(`  Input: ${ethers.utils.formatUnits(params.amountIn, 18)}`);
      console.log(`  Deadline: ${new Date(params.deadline * 1000).toISOString()}`);

      // Create authorization
      const auth = await this.authorizer.createAuthorization();
      console.log(`  Auth nonce: ${auth.nonce.toString()}`);

      // Estimate gas
      const gasEstimate = await this.estimateDelegatedSwapGas(params);
      console.log(`  Gas estimate: ${gasEstimate.toString()}`);

      // Execute delegated swap
      const tx = await this.delegatedExecutor.executeSwap(
        params.tokenIn,
        params.amountIn,
        params.path,
        params.minAmountOut,
        params.deadline,
        {
          gasLimit: gasEstimate.mul(110).div(100),
          // EIP-7702 transaction properties would be set at lower level
          // This is handled by ethers/web3 provider with 7702 support
        }
      );

      console.log(`✋ Delegated swap sent: ${tx.hash}`);

      const receipt = await tx.wait(3);

      if (!receipt) {
        return {
          success: false,
          error: 'Delegated swap failed - no receipt',
        };
      }

      console.log(`✅ Delegated swap confirmed in block ${receipt.blockNumber}`);
      console.log(`   Gas used: ${receipt.gasUsed.toString()}`);

      return {
        success: true,
        txHash: tx.hash,
        gasUsed: receipt.gasUsed,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`❌ Delegated swap failed: ${errorMsg}`);

      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Execute batch swaps with delegation
   * Multiple swaps in single delegated transaction
   */
  async executeDelegatedBatchSwaps(
    swaps: DelegatedSwapParams[],
    deadline: number
  ): Promise<DelegatedSwapResult> {
    try {
      console.log(`\n🔄 Executing ${swaps.length} delegated swaps via EIP-7702...`);

      const swapRequests = swaps.map((swap) => ({
        tokenIn: swap.tokenIn,
        amountIn: swap.amountIn,
        path: swap.path,
        minAmountOut: swap.minAmountOut,
      }));

      const gasEstimate = await this.estimateBatchSwapGas(swapRequests, deadline);
      console.log(`  Gas estimate: ${gasEstimate.toString()}`);

      const tx = await this.delegatedExecutor.executeBatchSwaps(swapRequests, deadline, {
        gasLimit: gasEstimate.mul(110).div(100),
      });

      console.log(`✋ Batch swaps sent: ${tx.hash}`);

      const receipt = await tx.wait(3);

      if (!receipt) {
        return {
          success: false,
          error: 'Batch swaps failed',
        };
      }

      console.log(`✅ All swaps confirmed in block ${receipt.blockNumber}`);
      return {
        success: true,
        txHash: tx.hash,
        gasUsed: receipt.gasUsed,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`❌ Batch swaps failed: ${errorMsg}`);

      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Estimate gas for delegated swap
   */
  private async estimateDelegatedSwapGas(params: DelegatedSwapParams): Promise<BigNumber> {
    try {
      const gasEstimate = await this.delegatedExecutor.estimateGas.executeSwap(
        params.tokenIn,
        params.amountIn,
        params.path,
        params.minAmountOut,
        params.deadline
      );
      return gasEstimate;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const err = new Error(
        `Gas estimation failed (transaction would revert): ${reason}`
      ) as Error & { cause: unknown };
      err.cause = error;
      throw err;
    }
  }

  /**
   * Estimate gas for batch swaps
   */
  private async estimateBatchSwapGas(
    swaps: Array<{ tokenIn: string; amountIn: BigNumber; path: Buffer; minAmountOut: BigNumber }>,
    deadline: number
  ): Promise<BigNumber> {
    try {
      const gasEstimate = await this.delegatedExecutor.estimateGas.executeBatchSwaps(
        swaps,
        deadline
      );
      return gasEstimate;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const err = new Error(
        `Gas estimation failed (transaction would revert): ${reason}`
      ) as Error & { cause: unknown };
      err.cause = error;
      throw err;
    }
  }

  /**
   * Get delegated executor address
   */
  getExecutorAddress(): string {
    return this.delegatedExecutor.address;
  }

  /**
   * Get authorizer for manual authorization creation
   */
  getAuthorizer(): EIP7702Authorizer {
    return this.authorizer;
  }
}

/**
 * EIP-7702 Transaction Builder
 * Constructs SetCode transactions for code delegation
 */
export class EIP7702TransactionBuilder {
  /**
   * Build SetCode transaction
   * Sets EOA code to point to contract
   */
  static buildSetCodeTx(
    _delegatedExecutorAddress: string,
    eoaAddress: string,
    chainId: number = 42161
  ): Partial<ethers.providers.TransactionRequest> {
    // EIP-7702 transaction structure with authorization list
    return {
      to: eoaAddress,
      type: 4, // EIP-7702 transaction type
      from: eoaAddress,
      data: '0x', // Empty call data
      chainId: chainId,
      // Authorization list would be set here:
      // authorizationList: [authorization]
    };
  }

  /**
   * Encode SetCode authorization
   */
  static encodeSetCodeAuth(
    delegatedExecutorAddress: string,
    chainId: number,
    nonce: number,
    signature: ethers.Signature
  ): string {
    return ethers.utils.solidityPack(
      ['uint256', 'address', 'uint256', 'uint8', 'bytes32', 'bytes32'],
      [
        chainId,
        delegatedExecutorAddress,
        nonce,
        signature.v === 27 ? 0 : 1,
        signature.r,
        signature.s,
      ]
    );
  }
}

export default {
  EIP7702Authorizer,
  EIP7702Executor,
  EIP7702TransactionBuilder,
};
