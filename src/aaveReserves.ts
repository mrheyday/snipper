/**
 * Aave V3 Arbitrum reserve reads via ethers v6 (no @aave/contract-helpers).
 */
import { Contract, type Provider } from 'ethers';
import { provider as defaultProvider } from './config';

export const AAVE_POOL_ARBITRUM = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';
export const AAVE_POOL_ADDRESSES_PROVIDER =
  '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb';
export const AAVE_UI_POOL_DATA_PROVIDER =
  '0x91E04cf78e53aEBe609e8a7f2003e7EECD743F2B';

const UI_ABI = [
  'function getReservesData(address provider) view returns (tuple(string underlyingAsset, string name, string symbol, uint256 decimals, uint256 baseLTVasCollateral, uint256 reserveLiquidationThreshold, uint256 reserveLiquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen, uint128 liquidityIndex, uint128 variableBorrowIndex, uint128 liquidityRate, uint128 variableBorrowRate, uint128 stableBorrowRate, uint40 lastUpdateTimestamp, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint256 availableLiquidity, uint256 totalPrincipalStableDebt, uint256 averageStableRate, uint256 stableDebtLastUpdateTimestamp, uint256 totalScaledVariableDebt, uint256 priceInMarketReferenceCurrency, address priceOracle, uint256 variableRateSlope1, uint256 variableRateSlope2, uint256 stableRateSlope1, uint256 stableRateSlope2, uint256 baseStableBorrowRate, uint256 baseVariableBorrowRate, uint256 optimalUsageRatio, bool isPaused, bool isSiloedBorrowing, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt, bool flashLoanEnabled)[] , tuple(uint256 marketReferenceCurrencyUnit, int256 marketReferenceCurrencyPriceInUsd, int256 networkBaseTokenPriceInUsd, uint8 networkBaseTokenPriceDecimals))',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

const POOL_ABI = [
  'function getReserveData(address asset) view returns (tuple(uint256 configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt))',
  'function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)',
];

export type ReserveSummary = {
  underlyingAsset: string;
  decimals: number;
  isActive: boolean;
  isPaused: boolean;
  isFrozen: boolean;
  borrowingEnabled: boolean;
  flashLoanEnabled: boolean;
  availableLiquidity: bigint;
  aTokenAddress: string;
};

/** Best-effort: prefer aToken.balanceOf(pool) for available liquidity. */
export async function getAvailableLiquidity(
  asset: string,
  p: Provider = defaultProvider
): Promise<bigint> {
  const pool = new Contract(AAVE_POOL_ARBITRUM, POOL_ABI, p);
  try {
    const data = await pool.getReserveData(asset);
    const aToken = new Contract(data.aTokenAddress as string, ERC20_ABI, p);
    return BigInt(await aToken.balanceOf(AAVE_POOL_ARBITRUM));
  } catch {
    return 0n;
  }
}

export async function getReserveEligibility(
  asset: string,
  p: Provider = defaultProvider
): Promise<{ eligible: boolean; reason?: string; liquidity?: bigint }> {
  try {
    const pool = new Contract(AAVE_POOL_ARBITRUM, POOL_ABI, p);
    const data = await pool.getReserveData(asset);
    const aTokenAddr = data.aTokenAddress as string;
    if (!aTokenAddr || aTokenAddr === '0x0000000000000000000000000000000000000000') {
      return { eligible: false, reason: 'Not an Aave V3 Arbitrum reserve' };
    }
    const aToken = new Contract(aTokenAddr, ERC20_ABI, p);
    const liquidity = BigInt(await aToken.balanceOf(AAVE_POOL_ARBITRUM));
    // configuration bit packing: flashLoanEnabled is bit 63 in Aave V3
    const configuration = BigInt(data.configuration);
    const flashLoanEnabled = ((configuration >> 63n) & 1n) === 1n;
    const borrowingEnabled = ((configuration >> 58n) & 1n) === 1n;
    const isActive = ((configuration >> 56n) & 1n) === 1n;
    const isFrozen = ((configuration >> 57n) & 1n) === 1n;
    const isPaused = ((configuration >> 60n) & 1n) === 1n;
    if (!isActive) return { eligible: false, reason: 'Reserve is not active' };
    if (isPaused) return { eligible: false, reason: 'Reserve is paused' };
    if (isFrozen) return { eligible: false, reason: 'Reserve is frozen' };
    if (!borrowingEnabled && !flashLoanEnabled) {
      return { eligible: false, reason: 'Borrowing/flash loan disabled' };
    }
    if (!flashLoanEnabled) {
      return { eligible: false, reason: 'Flash loans disabled for reserve' };
    }
    return { eligible: true, liquidity };
  } catch (e) {
    // Fail closed: RPC/decode errors must not mark a reserve flashable.
    return {
      eligible: false,
      reason: `Reserve eligibility check failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
}

export async function getFlashLoanPremiumBps(
  p: Provider = defaultProvider
): Promise<number> {
  const pool = new Contract(AAVE_POOL_ARBITRUM, POOL_ABI, p);
  try {
    return Number(await pool.FLASHLOAN_PREMIUM_TOTAL());
  } catch {
    return 5;
  }
}

export { UI_ABI };
