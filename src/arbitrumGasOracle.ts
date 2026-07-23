import { ethers, Contract } from 'ethers';
import { provider } from './config';
import { Logger } from './logger';

const logger = new Logger('ArbitrumGasOracle');

/**
 * Arbitrum ArbGasInfo contract interface
 * Provides L1 and L2 gas price information
 * Contract: 0x000000000000000000000000000000000000006F (precompile)
 */
const ARBGAS_INFO_ADDRESS = '0x000000000000000000000000000000000000006F';

const ARBGAS_INFO_ABI = [
  'function getPricesInWei() external view returns (uint256, uint256, uint256, uint256, uint256, uint256)',
  'function getL1BaseFeeEstimate() external view returns (uint256)',
  'function getPerL2TxGasLimit() external view returns (uint256)',
  'function getPerL2TxGasCost() external view returns (uint256)',
];

/**
 * Arbitrum gas pricing information
 */
interface ArbitrumGasPrices {
  l1BaseFeeWei: bigint; // L1 base fee per byte
  l2BaseFeeWei: bigint; // L2 base fee per gas
  l2MinimumBaseFee: bigint; // Minimum L2 base fee
  storageGasPricePerByte: bigint; // Storage gas price
  calldataGasPerBytePosted: bigint; // Calldata gas cost
  timestamp: number;
}

/**
 * Estimated L1 and L2 costs
 */
interface EstimatedCosts {
  l2GasCost: bigint; // Pure L2 execution cost
  l1CalldataCost: bigint; // L1 calldata cost (portion of tx data posted to L1)
  totalEstimatedCost: bigint; // L2 + L1 calldata
  percentageL1: number; // Percentage of cost from L1
  percentageL2: number; // Percentage of cost from L2
}

/**
 * Arbitrum L1/L2 gas oracle
 * Combines L1 (Ethereum) and L2 (Arbitrum) gas costs
 */
export class ArbitrumGasOracle {
  private arbGasInfo: Contract;
  private l2Provider: ethers.Provider;
  private l1Provider: ethers.JsonRpcProvider;

  constructor(arbitrumProvider: ethers.Provider, l1RpcUrl?: string) {
    this.l2Provider = arbitrumProvider;
    this.arbGasInfo = new ethers.Contract(ARBGAS_INFO_ADDRESS, ARBGAS_INFO_ABI, arbitrumProvider);

    // Use provided L1 RPC or fall back to Ethereum mainnet
    const rpcUrl = l1RpcUrl || 'https://eth-mainnet.g.alchemy.com/v2/demo';
    this.l1Provider = new ethers.JsonRpcProvider(rpcUrl);

    logger.info('Initialized ArbitrumGasOracle');
  }

  /**
   * Get current Arbitrum gas prices (L1 + L2)
   */
  async getArbitrumGasPrices(): Promise<ArbitrumGasPrices> {
    try {
      // Get L1 base fee from Arbitrum
      const l1BaseFee = await this.arbGasInfo.getL1BaseFeeEstimate();

      // Get L2 base fee from Arbitrum
      const l2BaseFee = (await this.l2Provider.getFeeData()).gasPrice ?? 0n;

      // Get Arbitrum-specific prices
      const prices = await this.arbGasInfo.getPricesInWei();
      // Returns: [per2TxGas, per2TxByte, per1GasByte, per1TxByte, calldataMarginal, minimumBaseFee]
      const [
        perL2TxGas,
        perL2TxByte,
        perL1GasByte,
        // perL1TxByte (unused, reserved for future use),
        calldataMarginal,
        minimumBaseFee,
      ] = prices;

      logger.info(`Arbitrum gas prices:`);
      logger.info(`  L1 base fee: ${ethers.formatUnits(l1BaseFee, 'gwei')} gwei`);
      logger.info(`  L2 base fee: ${ethers.formatUnits(l2BaseFee, 'gwei')} gwei`);
      logger.info(`  L2 per-tx gas: ${ethers.formatUnits(perL2TxGas, 'gwei')} gwei`);
      logger.info(`  L1 per-byte: ${ethers.formatUnits(perL1GasByte, 'gwei')} gwei`);

      return {
        l1BaseFeeWei: l1BaseFee,
        l2BaseFeeWei: l2BaseFee,
        l2MinimumBaseFee: minimumBaseFee,
        storageGasPricePerByte: perL2TxByte,
        calldataGasPerBytePosted: calldataMarginal,
        timestamp: Math.floor(Date.now() / 1000),
      };
    } catch (error) {
      logger.error(`Failed to get Arbitrum gas prices: ${error}`);
      throw error;
    }
  }

  /**
   * Get L1 gas price (Ethereum base fee)
   */
  async getL1GasPrice(): Promise<bigint> {
    try {
      const block = await this.l1Provider.getBlock('latest');
      if (!block) throw new Error('no L1 block');
      const baseFee = block.baseFeePerGas ?? 0n;

      logger.info(`L1 base fee: ${ethers.formatUnits(baseFee, 'gwei')} gwei`);
      return baseFee;
    } catch (error) {
      logger.error(`Failed to get L1 gas price: ${error}`);
      throw error;
    }
  }

  /**
   * Estimate total cost for a transaction on Arbitrum
   * Includes both L2 execution and L1 calldata costs
   */
  async estimateTransactionCost(
    txData: string, // Hex-encoded transaction data
    gasLimit: bigint
  ): Promise<EstimatedCosts> {
    const prices = await this.getArbitrumGasPrices();

    // Estimate calldata cost (each byte of tx data posted to L1)
    // This is approximately 16 gas per non-zero byte, 4 gas per zero byte
    const calldataBytes = (txData.length - 2) / 2; // Convert hex to bytes
    const calldataCost = (BigInt(calldataBytes) * prices.calldataGasPerBytePosted);

    // L2 execution cost
    const l2Cost = (gasLimit * prices.l2BaseFeeWei);

    // Total cost = L2 execution + L1 calldata
    const totalCost = (l2Cost + calldataCost);

    const percentageL1 = (totalCost > 0) ? Number((calldataCost * 10000n) / totalCost) / 100 : 0;
    const percentageL2 = 100 - percentageL1;

    logger.info(`Transaction cost breakdown:`);
    logger.info(`  L2 execution: ${ethers.formatUnits(l2Cost, 'gwei')} gwei`);
    logger.info(`  L1 calldata: ${ethers.formatUnits(calldataCost, 'gwei')} gwei`);
    logger.info(`  Total: ${ethers.formatUnits(totalCost, 'gwei')} gwei`);
    logger.info(`  L1%: ${percentageL1.toFixed(2)}%`);
    logger.info(`  L2%: ${percentageL2.toFixed(2)}%`);

    return {
      l2GasCost: l2Cost,
      l1CalldataCost: calldataCost,
      totalEstimatedCost: totalCost,
      percentageL1,
      percentageL2,
    };
  }

  /**
   * Compare Arbitrum vs L1 Ethereum costs
   */
  async compareWithL1(
    txData: string,
    gasLimit: bigint
  ): Promise<{
    l1Cost: bigint;
    l2Cost: bigint;
    savings: bigint;
    savingsPercent: number;
  }> {
    const l1GasPrice = await this.getL1GasPrice();
    const arbitrumCosts = await this.estimateTransactionCost(txData, gasLimit);

    // L1 would cost: gasLimit * L1 base fee
    const l1Cost = (gasLimit * l1GasPrice);

    // Arbitrum costs: L2 + L1 calldata
    const l2Cost = arbitrumCosts.totalEstimatedCost;

    // Calculate savings
    const savings = (l1Cost - l2Cost);
    const savingsPercent = (l1Cost > 0) ? Number((savings * 10000n) / l1Cost) / 100 : 0;

    logger.info(`L1 vs L2 Comparison:`);
    logger.info(`  L1 cost: ${ethers.formatUnits(l1Cost, 'gwei')} gwei`);
    logger.info(`  L2 cost: ${ethers.formatUnits(l2Cost, 'gwei')} gwei`);
    logger.info(
      `  Savings: ${ethers.formatUnits(savings, 'gwei')} gwei (${savingsPercent.toFixed(2)}%)`
    );

    return {
      l1Cost,
      l2Cost,
      savings,
      savingsPercent,
    };
  }

  /**
   * Estimate cost for different execution modes on Arbitrum
   */
  async estimateModeCosts(): Promise<
    {
      mode: string;
      estimatedGas: bigint;
      estimatedCalldataBytes: number;
      totalCostEstimate: bigint;
    }[]
  > {
    const prices = await this.getArbitrumGasPrices();

    // Typical calldata sizes for each mode
    const modes = [
      {
        mode: 'Direct',
        estimatedGas: BigInt('145000'),
        calldataBytes: 260, // Typical swap calldata
      },
      {
        mode: 'FlashLoan',
        estimatedGas: BigInt('200000'),
        calldataBytes: 320, // Larger due to callback
      },
      {
        mode: 'EIP-7702',
        estimatedGas: BigInt('105000'),
        calldataBytes: 280, // Authorization + swap
      },
      {
        mode: 'ERC-4337',
        estimatedGas: BigInt('170000'),
        calldataBytes: 480, // UserOp overhead
      },
    ];

    return modes.map(({ mode, estimatedGas, calldataBytes }) => {
      const l2Cost = (estimatedGas * prices.l2BaseFeeWei);
      const l1Cost = (BigInt(calldataBytes) * prices.calldataGasPerBytePosted);
      const totalCost = (l2Cost + l1Cost);

      return {
        mode,
        estimatedGas,
        estimatedCalldataBytes: calldataBytes,
        totalCostEstimate: totalCost,
      };
    });
  }

  /**
   * Get Arbitrum fee details for logging/monitoring
   */
  async getArbitrumFeeDetails(): Promise<{
    l1Component: bigint; // What portion goes to L1
    l2Component: bigint; // What portion goes to L2
    networkFeeAccount: string;
    feeMethod: string;
  }> {
    const prices = await this.getArbitrumGasPrices();

    // Typical swap transaction
    const typicalGasLimit = BigInt('145000');
    const typicalCalldataBytes = 260;

    const l2Component = (typicalGasLimit * prices.l2BaseFeeWei);
    const l1Component = (BigInt(typicalCalldataBytes) * prices.calldataGasPerBytePosted);

    return {
      l1Component,
      l2Component,
      networkFeeAccount: '0x00...',
      feeMethod: 'EIP-1559 (L2) + Calldata (L1)',
    };
  }

  /**
   * Optimize execution based on L1/L2 costs
   */
  async recommendOptimalMode(): Promise<{
    mode: string;
    reason: string;
    estimatedCost: bigint;
  }> {
    const modeCosts = await this.estimateModeCosts();

    // Find cheapest mode
    const cheapest = modeCosts.reduce((a, b) =>
      (a.totalCostEstimate < b.totalCostEstimate) ? a : b
    );

    const reason = cheapest.totalCostEstimate < BigInt('10000000000000000000')
      ? 'Low L1 calldata cost'
      : 'Optimized for L2 execution';

    logger.info(`Recommended mode: ${cheapest.mode} (${reason})`);

    return {
      mode: cheapest.mode,
      reason,
      estimatedCost: cheapest.totalCostEstimate,
    };
  }
}

export default ArbitrumGasOracle;
