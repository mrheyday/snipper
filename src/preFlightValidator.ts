import { BigNumber, ethers } from 'ethers';
import { Logger } from './logger';

const logger = new Logger('PreFlightValidator');

/**
 * Pre-flight validation results
 */
export interface ValidationResult {
  valid: boolean;
  checks: CheckResult[];
  warnings: string[];
  errors: string[];
  summary: string;
}

export interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Pre-flight validator for EIP-7702 delegated swaps
 * Prevents failed transactions by validating all preconditions
 */
export class PreFlightValidator {
  private provider: ethers.providers.Provider;

  constructor(provider: ethers.providers.Provider) {
    this.provider = provider;
  }

  /**
   * Validate all preconditions for a delegated swap
   */
  async validateDelegatedSwap(params: {
    delegatedExecutor: string;
    delegatedEOA: string;
    tokenIn: string;
    amountIn: BigNumber;
    deadline: number;
  }): Promise<ValidationResult> {
    const checks: CheckResult[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];

    logger.info(`Starting pre-flight validation for delegated swap`);
    logger.info(`  EOA: ${params.delegatedEOA}`);
    logger.info(`  Executor: ${params.delegatedExecutor}`);
    logger.info(`  Token: ${params.tokenIn}`);
    logger.info(`  Amount: ${ethers.utils.formatUnits(params.amountIn, 18)}`);

    // 1. Check deadline
    checks.push(this._validateDeadline(params.deadline));

    // 2. Check EOA has balance
    checks.push(
      await this._validateEOABalance(params.delegatedEOA, params.tokenIn, params.amountIn)
    );

    // 3. Check EOA nonce
    checks.push(await this._validateEOANonce(params.delegatedEOA));

    // 4. Check executor code is set
    checks.push(await this._validateExecutorCode(params.delegatedExecutor));

    // 5. Check approval (if needed)
    checks.push(
      await this._validateApproval(
        params.delegatedEOA,
        params.delegatedExecutor,
        params.tokenIn,
        params.amountIn
      )
    );

    // 6. Check contract has swap router
    checks.push(await this._validateSwapRouter());

    // 7. Check gas availability
    checks.push(await this._validateGasAvailability(params.delegatedEOA));

    // Categorize results
    for (const check of checks) {
      if (check.status === 'fail') {
        errors.push(check.message);
      } else if (check.status === 'warn') {
        warnings.push(check.message);
      }
    }

    const valid = errors.length === 0;
    const summary = this._generateSummary(checks, valid);

    logger.info(`Validation complete: ${valid ? '✅ PASS' : '❌ FAIL'}`);
    if (errors.length > 0) {
      logger.error(`  Errors: ${errors.length}`);
      errors.forEach((e) => logger.error(`    - ${e}`));
    }
    if (warnings.length > 0) {
      logger.warn(`  Warnings: ${warnings.length}`);
      warnings.forEach((w) => logger.warn(`    - ${w}`));
    }

    return {
      valid,
      checks,
      warnings,
      errors,
      summary,
    };
  }

  /**
   * Validate deadline hasn't passed
   */
  private _validateDeadline(deadline: number): CheckResult {
    const now = Math.floor(Date.now() / 1000);
    const passed = deadline > now;
    const timeRemaining = deadline - now;

    return {
      name: 'Deadline',
      status: passed ? 'pass' : 'fail',
      message: passed
        ? `Deadline valid (${timeRemaining}s remaining)`
        : `Deadline expired (${Math.abs(timeRemaining)}s ago)`,
      details: {
        deadline,
        now,
        timeRemaining,
      },
    };
  }

  /**
   * Validate EOA has sufficient token balance
   */
  private async _validateEOABalance(
    eoa: string,
    token: string,
    amountNeeded: BigNumber
  ): Promise<CheckResult> {
    try {
      const erc20 = new ethers.Contract(
        token,
        ['function balanceOf(address) view returns (uint256)'],
        this.provider
      );

      const balance = await erc20.balanceOf(eoa);
      const sufficient = balance.gte(amountNeeded);

      return {
        name: 'EOA Balance',
        status: sufficient ? 'pass' : 'fail',
        message: sufficient
          ? `Balance sufficient: ${ethers.utils.formatUnits(balance, 18)}`
          : `Insufficient balance: have ${ethers.utils.formatUnits(balance, 18)}, need ${ethers.utils.formatUnits(amountNeeded, 18)}`,
        details: {
          balance: balance.toString(),
          needed: amountNeeded.toString(),
          sufficient,
        },
      };
    } catch (error) {
      return {
        name: 'EOA Balance',
        status: 'fail',
        message: `Failed to check balance: ${error}`,
        details: { error: String(error) },
      };
    }
  }

  /**
   * Validate EOA nonce is accessible
   */
  private async _validateEOANonce(eoa: string): Promise<CheckResult> {
    try {
      const nonce = await this.provider.getTransactionCount(eoa, 'latest');
      return {
        name: 'EOA Nonce',
        status: 'pass',
        message: `EOA nonce: ${nonce}`,
        details: { nonce },
      };
    } catch (error) {
      return {
        name: 'EOA Nonce',
        status: 'warn',
        message: `Could not verify nonce: ${error}`,
        details: { error: String(error) },
      };
    }
  }

  /**
   * Validate executor contract code is deployed
   */
  private async _validateExecutorCode(executor: string): Promise<CheckResult> {
    try {
      const code = await this.provider.getCode(executor);
      const hasCode = code !== '0x';

      return {
        name: 'Executor Code',
        status: hasCode ? 'pass' : 'warn',
        message: hasCode
          ? `Executor code deployed (${(code.length - 2) / 2} bytes)`
          : `Executor has no code (delegation may not be set)`,
        details: {
          codeLength: code.length,
          hasCode,
        },
      };
    } catch (error) {
      return {
        name: 'Executor Code',
        status: 'warn',
        message: `Could not verify executor code: ${error}`,
        details: { error: String(error) },
      };
    }
  }

  /**
   * Validate EOA has approved executor to spend tokens
   */
  private async _validateApproval(
    eoa: string,
    executor: string,
    token: string,
    amountNeeded: BigNumber
  ): Promise<CheckResult> {
    try {
      const erc20 = new ethers.Contract(
        token,
        ['function allowance(address,address) view returns (uint256)'],
        this.provider
      );

      const allowance = await erc20.allowance(eoa, executor);
      const sufficient = allowance.gte(amountNeeded);

      return {
        name: 'Token Approval',
        status: sufficient ? 'pass' : 'warn',
        message: sufficient
          ? `Executor approved: ${ethers.utils.formatUnits(allowance, 18)}`
          : `Approval insufficient: ${ethers.utils.formatUnits(allowance, 18)}, need ${ethers.utils.formatUnits(amountNeeded, 18)}`,
        details: {
          allowance: allowance.toString(),
          needed: amountNeeded.toString(),
          sufficient,
        },
      };
    } catch (error) {
      return {
        name: 'Token Approval',
        status: 'warn',
        message: `Could not verify approval: ${error}`,
        details: { error: String(error) },
      };
    }
  }

  /**
   * Validate swap router is accessible (basic check)
   */
  private async _validateSwapRouter(): Promise<CheckResult> {
    try {
      // Uniswap V3 SwapRouter02 on Arbitrum
      const swapRouter = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
      const code = await this.provider.getCode(swapRouter);
      const hasCode = code !== '0x';

      return {
        name: 'Swap Router',
        status: hasCode ? 'pass' : 'fail',
        message: hasCode
          ? `Uniswap V3 SwapRouter deployed`
          : `Swap router not found on this network`,
        details: { swapRouter, hasCode },
      };
    } catch (error) {
      return {
        name: 'Swap Router',
        status: 'warn',
        message: `Could not verify swap router: ${error}`,
        details: { error: String(error) },
      };
    }
  }

  /**
   * Validate EOA has sufficient ETH for gas
   */
  private async _validateGasAvailability(eoa: string): Promise<CheckResult> {
    try {
      const balance = await this.provider.getBalance(eoa);
      const minGas = ethers.utils.parseEther('0.001'); // ~0.001 ETH for gas
      const sufficient = balance.gte(minGas);

      return {
        name: 'Gas (ETH)',
        status: sufficient ? 'pass' : 'warn',
        message: sufficient
          ? `EOA has ETH: ${ethers.utils.formatEther(balance)}`
          : `Low ETH balance: ${ethers.utils.formatEther(balance)} (recommend > 0.001 ETH for gas)`,
        details: {
          balance: balance.toString(),
          minRequired: minGas.toString(),
          sufficient,
        },
      };
    } catch (error) {
      return {
        name: 'Gas (ETH)',
        status: 'warn',
        message: `Could not verify ETH balance: ${error}`,
        details: { error: String(error) },
      };
    }
  }

  /**
   * Generate human-readable summary
   */
  private _generateSummary(checks: CheckResult[], valid: boolean): string {
    const passed = checks.filter((c) => c.status === 'pass').length;
    const failed = checks.filter((c) => c.status === 'fail').length;
    const warned = checks.filter((c) => c.status === 'warn').length;

    return `Pre-flight validation: ${passed}/${checks.length} checks passed${
      failed > 0 ? `, ${failed} FAILED` : ''
    }${warned > 0 ? `, ${warned} warnings` : ''}. ${
      valid ? '✅ Ready to execute' : '❌ Cannot proceed'
    }`;
  }
}

export default PreFlightValidator;
