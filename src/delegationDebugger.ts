import { ethers } from 'ethers';
import { Logger } from './logger';

const logger = new Logger('DelegationDebugger');

/**
 * Detailed delegation flow state
 */
export interface DelegationState {
  phase: 'init' | 'validation' | 'approval' | 'delegation' | 'execution' | 'settlement' | 'error';
  timestamp: number;
  eoa: string;
  executor: string;
  tokenIn: string;
  amountIn: bigint;
  details: Record<string, unknown>;
  error?: string;
}

/**
 * Comprehensive delegation debugger
 * Logs every step of the EIP-7702 delegation flow
 */
export class DelegationDebugger {
  private states: DelegationState[] = [];
  private startTime: number = 0;

  constructor() {
    this.startTime = Date.now();
  }

  /**
   * Log initialization phase
   */
  logInit(params: { eoa: string; executor: string; tokenIn: string; amountIn: bigint }): void {
    this.addState('init', params, {
      initiatedAt: new Date().toISOString(),
      eoa: params.eoa,
      executor: params.executor,
      token: params.tokenIn,
      amount: ethers.formatUnits(params.amountIn, 18),
    });

    logger.info('🔄 EIP-7702 Delegation Flow Started');
    logger.info('═'.repeat(70));
    logger.info('PHASE 1: INITIALIZATION');
    logger.info('─'.repeat(70));
    logger.info(`EOA Address: ${params.eoa}`);
    logger.info(`Executor: ${params.executor}`);
    logger.info(`Token In: ${params.tokenIn}`);
    logger.info(`Amount: ${ethers.formatUnits(params.amountIn, 18)}`);
    logger.info('═'.repeat(70));
  }

  /**
   * Log validation checks
   */
  logValidation(checks: {
    eoaBalance: { has: bigint; needs: bigint };
    eoaNonce: number;
    eoaEth: bigint;
    executorCode: boolean;
    approval: bigint;
    deadline: number;
  }): void {
    this.addState('validation', checks, {
      eoaBalance: ethers.formatUnits(checks.eoaBalance.has, 18),
      needsBalance: ethers.formatUnits(checks.eoaBalance.needs, 18),
      balanceSufficient: (checks.eoaBalance.has >= checks.eoaBalance.needs),
      eoaNonce: checks.eoaNonce,
      eoaEth: ethers.formatEther(checks.eoaEth),
      hasExecutorCode: checks.executorCode,
      approved: ethers.formatUnits(checks.approval, 18),
      deadlineValid: checks.deadline > Math.floor(Date.now() / 1000),
    });

    logger.info('PHASE 2: PRE-FLIGHT VALIDATION');
    logger.info('─'.repeat(70));

    const balanceSufficient = (checks.eoaBalance.has >= checks.eoaBalance.needs);
    logger.info(
      `${balanceSufficient ? '✅' : '❌'} Token Balance: ${ethers.formatUnits(
        checks.eoaBalance.has,
        18
      )} (need ${ethers.formatUnits(checks.eoaBalance.needs, 18)})`
    );

    logger.info(`✅ EOA Nonce: ${checks.eoaNonce}`);

    const ethSufficient = checks.eoaEth > ethers.parseEther('0.001');
    logger.info(
      `${ethSufficient ? '✅' : '⚠️'} Gas (ETH): ${ethers.formatEther(checks.eoaEth)}`
    );

    logger.info(
      `${checks.executorCode ? '✅' : '⚠️'} Executor Code: ${
        checks.executorCode ? 'Deployed' : 'Not deployed'
      }`
    );

    logger.info(
      `${(checks.approval > 0) ? '✅' : '⚠️'} Approval: ${ethers.formatUnits(
        checks.approval,
        18
      )}`
    );

    const deadlineValid = checks.deadline > Math.floor(Date.now() / 1000);
    logger.info(
      `${deadlineValid ? '✅' : '❌'} Deadline: ${new Date(checks.deadline * 1000).toISOString()}`
    );

    logger.info('═'.repeat(70));
  }

  /**
   * Log approval step
   */
  logApproval(params: {
    token: string;
    executor: string;
    amount: bigint;
    txHash?: string;
    status: 'pending' | 'confirmed' | 'failed';
  }): void {
    this.addState('approval', params, {
      status: params.status,
      txHash: params.txHash,
    });

    logger.info('PHASE 3: TOKEN APPROVAL');
    logger.info('─'.repeat(70));

    const icon = params.status === 'confirmed' ? '✅' : params.status === 'pending' ? '⏳' : '❌';
    logger.info(`${icon} Status: ${params.status.toUpperCase()}`);
    logger.info(`Token: ${params.token}`);
    logger.info(`Spender: ${params.executor}`);
    logger.info(`Amount: ${ethers.formatUnits(params.amount, 18)}`);

    if (params.txHash) {
      logger.info(`Transaction: ${params.txHash}`);
    }

    logger.info('═'.repeat(70));
  }

  /**
   * Log delegation setup
   */
  logDelegation(params: {
    eoa: string;
    executor: string;
    delegateeCode: string;
    txHash?: string;
    status: 'pending' | 'confirmed' | 'failed';
  }): void {
    this.addState('delegation', params, {
      status: params.status,
      txHash: params.txHash,
    });

    logger.info('PHASE 4: EIP-7702 DELEGATION');
    logger.info('─'.repeat(70));

    const icon = params.status === 'confirmed' ? '✅' : params.status === 'pending' ? '⏳' : '❌';
    logger.info(`${icon} Status: ${params.status.toUpperCase()}`);
    logger.info(`EOA: ${params.eoa}`);
    logger.info(`Setting account code to: ${params.executor}`);
    logger.info(`Code size: ${(params.delegateeCode.length - 2) / 2} bytes`);

    if (params.txHash) {
      logger.info(`Transaction: ${params.txHash}`);
    }

    logger.info('═'.repeat(70));
  }

  /**
   * Log execution attempt
   */
  logExecution(params: {
    eoa: string;
    executor: string;
    tokenIn: string;
    amountIn: bigint;
    minAmountOut: bigint;
    deadline: number;
    gasEstimate?: bigint;
    gasLimit?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
    txHash?: string;
    status: 'pending' | 'confirmed' | 'failed';
    error?: string;
  }): void {
    this.addState('execution', params, {
      status: params.status,
      txHash: params.txHash,
      error: params.error,
    });

    logger.info('PHASE 5: SWAP EXECUTION');
    logger.info('─'.repeat(70));

    const icon = params.status === 'confirmed' ? '✅' : params.status === 'pending' ? '⏳' : '❌';
    logger.info(`${icon} Status: ${params.status.toUpperCase()}`);

    logger.info(`\n📊 Swap Parameters:`);
    logger.info(`  EOA: ${params.eoa}`);
    logger.info(`  Executor: ${params.executor}`);
    logger.info(`  Token In: ${params.tokenIn}`);
    logger.info(`  Amount In: ${ethers.formatUnits(params.amountIn, 18)}`);
    logger.info(`  Min Amount Out: ${ethers.formatUnits(params.minAmountOut, 18)}`);
    logger.info(`  Deadline: ${new Date(params.deadline * 1000).toISOString()}`);

    if (params.gasEstimate || params.gasLimit) {
      logger.info(`\n⛽ Gas Details:`);
      if (params.gasEstimate) {
        logger.info(`  Estimated: ${params.gasEstimate.toString()}`);
      }
      if (params.gasLimit) {
        logger.info(`  Limit: ${params.gasLimit.toString()}`);
      }
    }

    if (params.maxFeePerGas || params.maxPriorityFeePerGas) {
      logger.info(`\n💰 Fee Market (EIP-1559):`);
      if (params.maxFeePerGas) {
        logger.info(`  Max Fee: ${ethers.formatUnits(params.maxFeePerGas, 'gwei')} gwei`);
      }
      if (params.maxPriorityFeePerGas) {
        logger.info(
          `  Priority Fee: ${ethers.formatUnits(params.maxPriorityFeePerGas, 'gwei')} gwei`
        );
      }
    }

    if (params.txHash) {
      logger.info(`\n🔗 Transaction: ${params.txHash}`);
    }

    if (params.error) {
      logger.error(`\n❌ Error: ${params.error}`);
    }

    logger.info('═'.repeat(70));
  }

  /**
   * Log transaction settlement
   */
  logSettlement(params: {
    txHash: string;
    blockNumber: number;
    gasUsed: bigint;
    transactionFee: bigint;
    amountOut?: bigint;
    profit?: bigint;
    status: 'success' | 'failed' | 'reverted';
    reason?: string;
  }): void {
    this.addState('settlement', params, {
      status: params.status,
      gasUsed: params.gasUsed.toString(),
      transactionFee: ethers.formatEther(params.transactionFee),
    });

    logger.info('PHASE 6: SETTLEMENT');
    logger.info('─'.repeat(70));

    const icon = params.status === 'success' ? '✅' : params.status === 'failed' ? '❌' : '⚠️';
    logger.info(`${icon} Status: ${params.status.toUpperCase()}`);

    logger.info(`\n📦 Transaction Settlement:`);
    logger.info(`  Hash: ${params.txHash}`);
    logger.info(`  Block: #${params.blockNumber}`);
    logger.info(`  Gas Used: ${params.gasUsed.toString()}`);
    logger.info(`  Fee: ${ethers.formatEther(params.transactionFee)} ETH`);

    if (params.amountOut) {
      logger.info(`  Amount Out: ${ethers.formatUnits(params.amountOut, 18)}`);
    }

    if (params.profit) {
      const profitAmount = params.profit;
      const isProfitable = (profitAmount > 0);
      logger.info(
        `  Profit: ${ethers.formatUnits(profitAmount, 18)} ${isProfitable ? '📈' : '📉'}`
      );
    }

    if (params.reason) {
      logger.error(`  Reason: ${params.reason}`);
    }

    logger.info('═'.repeat(70));
  }

  /**
   * Log error with context
   */
  logError(params: {
    phase: DelegationState['phase'];
    error: Error | string;
    context?: Record<string, unknown>;
  }): void {
    const errorMsg = typeof params.error === 'string' ? params.error : params.error.message;

    this.addState(
      'error',
      { error: errorMsg, ...params.context },
      {
        phase: params.phase,
        message: errorMsg,
        stack: typeof params.error !== 'string' ? params.error.stack : undefined,
      }
    );

    logger.error('❌ DELEGATION FAILED');
    logger.error('═'.repeat(70));
    logger.error(`Phase: ${params.phase.toUpperCase()}`);
    logger.error(`Error: ${errorMsg}`);

    if (params.context) {
      logger.error(`Context:`);
      Object.entries(params.context).forEach(([key, value]) => {
        logger.error(`  ${key}: ${JSON.stringify(value)}`);
      });
    }

    if (typeof params.error !== 'string' && params.error.stack) {
      logger.debug(`Stack:\n${params.error.stack}`);
    }

    logger.error('═'.repeat(70));
  }

  /**
   * Add state to history
   */
  private addState(
    phase: DelegationState['phase'],
    details: Record<string, unknown>,
    extra?: Record<string, unknown>
  ): void {
    this.states.push({
      phase,
      timestamp: Date.now(),
      eoa: (details.eoa as string) || '',
      executor: (details.executor as string) || '',
      tokenIn: (details.tokenIn as string) || '',
      amountIn: (details.amountIn as bigint) || 0n,
      details: { ...details, ...extra },
    });
  }

  /**
   * Get full debug report
   */
  getDebugReport(): {
    duration: number;
    phases: number;
    states: DelegationState[];
    summary: string;
  } {
    const duration = Date.now() - this.startTime;
    const summary = `Delegation flow: ${this.states.length} state(s) logged in ${duration}ms`;

    return {
      duration,
      phases: this.states.length,
      states: this.states,
      summary,
    };
  }

  /**
   * Print debug report
   */
  printDebugReport(): void {
    const report = this.getDebugReport();

    logger.info('\n📋 DEBUG REPORT');
    logger.info('═'.repeat(70));
    logger.info(`Total Duration: ${report.duration}ms`);
    logger.info(`Phases Logged: ${report.phases}`);
    logger.info(`Summary: ${report.summary}`);
    logger.info('═'.repeat(70));

    logger.info('\nState History:');
    report.states.forEach((state, idx) => {
      const phase = state.phase.toUpperCase().padEnd(12);
      const time = new Date(state.timestamp).toISOString().split('T')[1];
      logger.info(`  [${idx + 1}] ${phase} @ ${time}`);
      logger.debug(`      ${JSON.stringify(state.details, null, 2)}`);
    });
  }
}

export default DelegationDebugger;
