/**
 * @deprecated DO NOT USE IN PRODUCTION.
 * Broken 7702 path: personal_sign auth, non-RLP digest, no authorizationList / type-4.
 * Use `./eip7702.ts` only. This module throws on construction to prevent accidental use.
 */
import { ethers } from 'ethers';
import { signer, provider } from './config';
import { Logger } from './logger';
import { validateAndChecksumAddress } from './validation';

const logger = new Logger('EIP7702');

const DEPRECATED_MSG = 'eip7702-improved is deprecated and unsafe. Import from ./eip7702 instead.';

/**
 * EIP-7702: Set EOA Account Code
 * Allows EOA to delegate code execution without pre-deployment
 * Authorization is signed and sent in transaction
 *
 * Reference: https://eips.ethereum.org/EIPS/eip-7702
 *
 * Transaction Structure:
 * - Type: 0x04 (EIP-7702)
 * - Authorization List: [{ address, nonce, r, s, yParity }]
 * - Regular tx fields: to, value, data, gas, gasPrice, etc.
 *
 * Prerequisites:
 * - Provider must support EIP-7702 transactions (Arbitrum after upgrade)
 * - Contract address must be valid
 * - EOA must sign authorization
 */

interface EIP7702Authorization {
  chainId: number;
  address: string;
  nonce: number;
  r: string;
  s: string;
  yParity: number;
}

interface DelegatedSwapParams {
  tokenIn: string;
  amountIn: bigint;
  path: Buffer;
  minAmountOut: bigint;
  deadline: number;
}

interface DelegatedSwapResult {
  success: boolean;
  txHash?: string;
  amountOut?: bigint;
  error?: string;
  gasUsed?: bigint;
  authorizationData?: string;
}

/**
 * EIP-7702 Authorization Signer
 * Creates signatures for EOA code delegation
 */
export class EIP7702AuthorizationSigner {
  private delegatedExecutor: string;
  private chainId: number;

  constructor(delegatedExecutorAddress: string, chainId: number = 42161) {
    throw new Error(DEPRECATED_MSG);
    this.delegatedExecutor = validateAndChecksumAddress(delegatedExecutorAddress);
    this.chainId = chainId;
  }

  /**
   * Create EIP-7702 authorization signature
   * Signer authorizes delegation to the DelegatedExecutor contract
   */
  async createAuthorization(): Promise<EIP7702Authorization> {
    const eoaAddress = await signer.getAddress();
    const nonce = await provider.getTransactionCount(eoaAddress);

    logger.info(
      `Creating EIP-7702 authorization for ${this.delegatedExecutor} with nonce ${nonce}`
    );

    // Build authorization hash per EIP-7702 spec
    // hash = keccak256(0x05 || chainId || address || nonce)
    const encodedData = ethers.solidityPacked(
      ['bytes1', 'uint256', 'address', 'uint256'],
      ['0x05', this.chainId, this.delegatedExecutor, nonce]
    );

    const authHash = ethers.keccak256(encodedData);

    // Sign authorization
    const sig = await signer.signMessage(ethers.getBytes(authHash));
    const { v, r, s } = ethers.Signature.from(sig);

    logger.info(`Authorization signed: r=${r.slice(0, 10)}...`);

    return {
      chainId: this.chainId,
      address: this.delegatedExecutor,
      nonce,
      r,
      s,
      yParity: v === 27 ? 0 : 1,
    };
  }

  /**
   * Encode authorization for inclusion in transaction
   */
  encodeAuthorizationList(auth: EIP7702Authorization): string {
    return ethers.solidityPacked(
      ['address', 'uint256', 'bytes32', 'bytes32', 'uint8'],
      [auth.address, auth.nonce, auth.r, auth.s, auth.yParity]
    );
  }
}

/**
 * EIP-7702 Delegated Executor
 * Executes swaps via delegated EOA code
 */
export class EIP7702DelegatedExecutor {
  private delegatedExecutor: ethers.Contract;
  private authorizer: EIP7702AuthorizationSigner;

  constructor(delegatedExecutorAddress: string, chainId: number = 42161) {
    throw new Error(DEPRECATED_MSG);
    this.delegatedExecutor = new ethers.Contract(
      validateAndChecksumAddress(delegatedExecutorAddress),
      [
        'function executeSwap(address tokenIn, uint256 amountIn, bytes calldata path, uint256 minAmountOut, uint256 deadline) external returns (uint256)',
        'function executeBatchSwaps(tuple(address tokenIn, uint256 amountIn, bytes path, uint256 minAmountOut)[] swaps, uint256 deadline) external returns (uint256[])',
      ],
      signer
    );
    this.authorizer = new EIP7702AuthorizationSigner(delegatedExecutorAddress, chainId);
  }

  /**
   * Execute swap via EIP-7702 delegation
   * Creates authorization signature and sends delegated transaction
   */
  async executeDelegatedSwap(params: DelegatedSwapParams): Promise<DelegatedSwapResult> {
    let txHash = '';

    try {
      logger.info('Executing delegated swap via EIP-7702');
      logger.info(`Input: ${ethers.formatUnits(params.amountIn, 18)}`);
      logger.info(`Deadline: ${new Date(params.deadline * 1000).toISOString()}`);

      // Create authorization
      const auth = await this.authorizer.createAuthorization();
      const authEncoded = this.authorizer.encodeAuthorizationList(auth);

      logger.info(`Authorization nonce: ${auth.nonce}`);

      // Estimate gas
      try {
        const gasEstimate = await this.delegatedExecutor.executeSwap.estimateGas(
          params.tokenIn,
          params.amountIn,
          params.path,
          params.minAmountOut,
          params.deadline
        );
        logger.info(`Gas estimate: ${gasEstimate.toString()}`);
      } catch (error) {
        logger.warn(
          `Gas estimation failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      logger.info('Sending EIP-7702 delegated transaction');

      // Send delegated swap
      // Note: Standard sendTransaction won't include EIP-7702 fields
      // For production, use provider that supports EIP-7702 explicitly
      const tx = await this.delegatedExecutor.executeSwap(
        params.tokenIn,
        params.amountIn,
        params.path,
        params.minAmountOut,
        params.deadline,
        {
          gasLimit: BigInt('300000'), // Conservative estimate
          // EIP-7702 fields would be added by provider if supported:
          // authorizationList: [auth],
        }
      );

      txHash = tx.hash;
      logger.info(`Transaction sent: ${txHash}`);

      // Poll for confirmation
      const receipt = await provider.waitForTransaction(txHash, 3, 60000); // 3 confirmations, 60s timeout

      if (!receipt) {
        return {
          success: false,
          error: 'Transaction confirmation timeout',
          txHash,
          authorizationData: authEncoded,
        };
      }

      if (receipt.status === 0) {
        logger.error(`Transaction reverted`);
        return {
          success: false,
          error: 'Transaction reverted',
          txHash,
          authorizationData: authEncoded,
        };
      }

      logger.info(`Transaction confirmed in block ${receipt.blockNumber}`);
      logger.info(`Gas used: ${receipt.gasUsed}`);

      return {
        success: true,
        txHash,
        gasUsed: receipt.gasUsed,
        authorizationData: authEncoded,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Delegated swap failed: ${errorMsg}`);

      return {
        success: false,
        error: errorMsg,
        txHash,
      };
    }
  }

  /**
   * Execute batch swaps via EIP-7702
   * Multiple swaps in single delegated transaction
   */
  async executeDelegatedBatchSwaps(
    swaps: DelegatedSwapParams[],
    deadline: number
  ): Promise<DelegatedSwapResult> {
    let txHash = '';

    try {
      logger.info(`Executing ${swaps.length} delegated swaps via EIP-7702`);

      // Create authorization
      const auth = await this.authorizer.createAuthorization();
      const authEncoded = this.authorizer.encodeAuthorizationList(auth);

      // Prepare swap requests
      const swapRequests = swaps.map((swap) => ({
        tokenIn: swap.tokenIn,
        amountIn: swap.amountIn,
        path: swap.path,
        minAmountOut: swap.minAmountOut,
      }));

      // Execute batch
      const tx = await this.delegatedExecutor.executeBatchSwaps(swapRequests, deadline, {
        gasLimit: BigInt('500000'), // Conservative estimate for batch
      });

      txHash = tx.hash;
      logger.info(`Batch transaction sent: ${txHash}`);

      const receipt = await provider.waitForTransaction(txHash, 3, 60000);

      if (!receipt) {
        return {
          success: false,
          error: 'Batch execution timeout',
          txHash,
          authorizationData: authEncoded,
        };
      }

      if (receipt.status === 0) {
        logger.error(`Batch transaction reverted`);
        return {
          success: false,
          error: 'Batch execution reverted',
          txHash,
          authorizationData: authEncoded,
        };
      }

      logger.info(`Batch confirmed in block ${receipt.blockNumber}`);

      return {
        success: true,
        txHash,
        gasUsed: receipt.gasUsed,
        authorizationData: authEncoded,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Batch swaps failed: ${errorMsg}`);

      return {
        success: false,
        error: errorMsg,
        txHash,
      };
    }
  }

  /**
   * Get authorization data for external use
   * Useful for testing or external tx builders
   */
  async getAuthorizationData(): Promise<string> {
    const auth = await this.authorizer.createAuthorization();
    return this.authorizer.encodeAuthorizationList(auth);
  }
}

export default EIP7702DelegatedExecutor;
