import { provider } from './config';
import { Logger } from './logger';

const logger = new Logger('NonceManager');

/**
 * Transaction state tracking
 */
interface PendingTransaction {
  nonce: number;
  txHash: string;
  timestamp: number;
  blockNumber: number;
  status: 'pending' | 'confirmed' | 'failed' | 'dropped';
  retryCount: number;
}

/**
 * Nonce recovery result
 */
interface NonceRecovery {
  currentOnChainNonce: number;
  pendingNonces: number[];
  droppedNonces: number[];
  nextAvailableNonce: number;
  recovered: boolean;
}

/**
 * Automatic nonce manager for safe transaction submission
 * Handles nonce tracking, recovery, and retry logic
 */
export class NonceManager {
  private walletAddress: string;
  private currentNonce: number;
  private pendingTransactions: Map<number, PendingTransaction>;
  private maxRetries: number = 3;
  private noncePendingTimeout: number = 60 * 1000; // 60 seconds
  private isRecovering: boolean = false;

  constructor(walletAddress: string) {
    this.walletAddress = walletAddress;
    this.currentNonce = 0;
    this.pendingTransactions = new Map();
    logger.info(`Initialized NonceManager for ${walletAddress}`);
  }

  /**
   * Initialize nonce from on-chain state
   */
  async initialize(): Promise<void> {
    try {
      const onChainNonce = await provider.getTransactionCount(this.walletAddress, 'latest');
      this.currentNonce = onChainNonce;
      logger.info(`NonceManager initialized with nonce ${this.currentNonce}`);
    } catch (error) {
      logger.error(`Failed to initialize nonce: ${error}`);
      throw error;
    }
  }

  /**
   * Get next available nonce (increments local counter)
   */
  getNextNonce(): number {
    const nonce = this.currentNonce;
    this.currentNonce += 1;
    logger.info(`Allocated nonce: ${nonce} (next: ${this.currentNonce})`);
    return nonce;
  }

  /**
   * Get current nonce without incrementing
   */
  getCurrentNonce(): number {
    return this.currentNonce;
  }

  /**
   * Track a submitted transaction
   */
  trackTransaction(nonce: number, txHash: string): void {
    const blockNumber = provider.getBlockNumber().then((bn) => bn);

    blockNumber.then((bn) => {
      this.pendingTransactions.set(nonce, {
        nonce,
        txHash,
        timestamp: Date.now(),
        blockNumber: bn,
        status: 'pending',
        retryCount: 0,
      });

      logger.info(`Tracking transaction: nonce=${nonce}, txHash=${txHash}`);
    });
  }

  /**
   * Mark transaction as confirmed
   */
  async confirmTransaction(nonce: number): Promise<void> {
    const pending = this.pendingTransactions.get(nonce);
    if (pending) {
      pending.status = 'confirmed';
      logger.info(`Transaction confirmed: nonce=${nonce}`);
    } else {
      logger.warn(`No pending transaction found for nonce ${nonce}`);
    }
  }

  /**
   * Mark transaction as failed and prepare for retry
   */
  async markTransactionFailed(nonce: number): Promise<boolean> {
    const pending = this.pendingTransactions.get(nonce);
    if (!pending) {
      logger.warn(`No pending transaction found for nonce ${nonce}`);
      return false;
    }

    pending.retryCount += 1;
    logger.warn(`Transaction failed: nonce=${nonce}, retries=${pending.retryCount}`);

    if (pending.retryCount >= this.maxRetries) {
      pending.status = 'failed';
      logger.error(`Transaction exceeded max retries: nonce=${nonce}`);
      return false;
    }

    return true;
  }

  /**
   * Check for and handle dropped/pending transactions
   */
  async checkPendingTransactions(): Promise<{
    confirmed: number[];
    dropped: number[];
    stillPending: number[];
  }> {
    const confirmed: number[] = [];
    const dropped: number[] = [];
    const stillPending: number[] = [];

    for (const [nonce, tx] of this.pendingTransactions) {
      // Already confirmed
      if (tx.status === 'confirmed') {
        confirmed.push(nonce);
        continue;
      }

      // Already failed
      if (tx.status === 'failed') {
        dropped.push(nonce);
        continue;
      }

      // Check if transaction is still pending on-chain
      try {
        const receipt = await provider.getTransactionReceipt(tx.txHash);

        if (receipt) {
          // Transaction was mined
          tx.status = receipt.status === 1 ? 'confirmed' : 'failed';
          if (tx.status === 'confirmed') {
            confirmed.push(nonce);
          } else {
            dropped.push(nonce);
          }
        } else if (Date.now() - tx.timestamp > this.noncePendingTimeout) {
          // Transaction pending for too long
          tx.status = 'dropped';
          dropped.push(nonce);
          logger.warn(`Transaction dropped (timeout): nonce=${nonce}, txHash=${tx.txHash}`);
        } else {
          // Still pending
          stillPending.push(nonce);
        }
      } catch (error) {
        logger.error(`Error checking transaction ${tx.txHash}: ${error}`);
        stillPending.push(nonce);
      }
    }

    logger.info(
      `Pending transactions: confirmed=${confirmed.length}, dropped=${dropped.length}, pending=${stillPending.length}`
    );

    return {
      confirmed,
      dropped,
      stillPending,
    };
  }

  /**
   * Recover nonce state from on-chain data
   * Identifies gaps and dropped transactions
   */
  async recoverNonceState(): Promise<NonceRecovery> {
    if (this.isRecovering) {
      logger.warn('Nonce recovery already in progress');
      return {
        currentOnChainNonce: this.currentNonce,
        pendingNonces: [],
        droppedNonces: [],
        nextAvailableNonce: this.currentNonce,
        recovered: false,
      };
    }

    this.isRecovering = true;

    try {
      // Get current on-chain nonce
      const onChainNonce = await provider.getTransactionCount(this.walletAddress, 'latest');

      logger.info(`Recovering nonce state:`);
      logger.info(`  On-chain nonce: ${onChainNonce}`);
      logger.info(`  Local nonce: ${this.currentNonce}`);

      // Identify pending and dropped nonces
      const pendingNonces: number[] = [];
      const droppedNonces: number[] = [];

      for (let i = onChainNonce; i < this.currentNonce; i++) {
        const pending = this.pendingTransactions.get(i);
        if (pending) {
          if (pending.status === 'dropped' || pending.status === 'failed') {
            droppedNonces.push(i);
          } else {
            pendingNonces.push(i);
          }
        } else {
          // Nonce not in our tracking - likely dropped
          droppedNonces.push(i);
        }
      }

      // Determine next available nonce
      let nextAvailableNonce = onChainNonce;
      if (pendingNonces.length > 0) {
        // Skip pending nonces
        nextAvailableNonce = Math.max(...pendingNonces) + 1;
      }

      const recovered = !droppedNonces.some((n) => pendingNonces.includes(n));

      logger.info(`Nonce recovery complete:`);
      logger.info(`  Pending nonces: ${pendingNonces}`);
      logger.info(`  Dropped nonces: ${droppedNonces}`);
      logger.info(`  Next available: ${nextAvailableNonce}`);
      logger.info(`  Recovered: ${recovered}`);

      if (recovered) {
        this.currentNonce = nextAvailableNonce;
      }

      return {
        currentOnChainNonce: onChainNonce,
        pendingNonces,
        droppedNonces,
        nextAvailableNonce,
        recovered,
      };
    } catch (error) {
      logger.error(`Nonce recovery failed: ${error}`);
      throw error;
    } finally {
      this.isRecovering = false;
    }
  }

  /**
   * Get transaction history
   */
  getTransactionHistory(): PendingTransaction[] {
    return Array.from(this.pendingTransactions.values()).sort((a, b) => a.nonce - b.nonce);
  }

  /**
   * Get transaction by nonce
   */
  getTransaction(nonce: number): PendingTransaction | undefined {
    return this.pendingTransactions.get(nonce);
  }

  /**
   * Clear old transactions from tracking (older than 1 hour)
   */
  cleanupOldTransactions(): number {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    let cleaned = 0;

    for (const [nonce, tx] of this.pendingTransactions) {
      if (tx.timestamp < oneHourAgo && (tx.status === 'confirmed' || tx.status === 'failed')) {
        this.pendingTransactions.delete(nonce);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info(`Cleaned up ${cleaned} old transactions`);
    }

    return cleaned;
  }

  /**
   * Get nonce statistics
   */
  getStatistics(): {
    currentNonce: number;
    totalTracked: number;
    confirmed: number;
    pending: number;
    failed: number;
    dropped: number;
  } {
    const stats = {
      currentNonce: this.currentNonce,
      totalTracked: this.pendingTransactions.size,
      confirmed: 0,
      pending: 0,
      failed: 0,
      dropped: 0,
    };

    for (const tx of this.pendingTransactions.values()) {
      if (tx.status === 'confirmed') stats.confirmed++;
      else if (tx.status === 'pending') stats.pending++;
      else if (tx.status === 'failed') stats.failed++;
      else if (tx.status === 'dropped') stats.dropped++;
    }

    return stats;
  }

  /**
   * Reset nonce manager (careful - only after full recovery)
   */
  async resetToOnChainState(): Promise<void> {
    const onChainNonce = await provider.getTransactionCount(this.walletAddress, 'latest');
    this.currentNonce = onChainNonce;
    this.pendingTransactions.clear();
    logger.warn(`NonceManager reset to on-chain state: nonce=${onChainNonce}`);
  }

  /**
   * Log current state
   */
  logState(): void {
    const stats = this.getStatistics();
    logger.info(`NonceManager state:`);
    logger.info(`  Current nonce: ${stats.currentNonce}`);
    logger.info(`  Confirmed: ${stats.confirmed}`);
    logger.info(`  Pending: ${stats.pending}`);
    logger.info(`  Failed: ${stats.failed}`);
    logger.info(`  Dropped: ${stats.dropped}`);
  }
}

/**
 * Create singleton instance
 */
let instance: NonceManager | null = null;

export async function initializeNonceManager(walletAddress: string): Promise<NonceManager> {
  if (instance) {
    logger.warn('NonceManager already initialized');
    return instance;
  }

  instance = new NonceManager(walletAddress);
  await instance.initialize();
  return instance;
}

export function getNonceManager(): NonceManager {
  if (!instance) {
    throw new Error('NonceManager not initialized. Call initializeNonceManager first.');
  }
  return instance;
}

export default NonceManager;
