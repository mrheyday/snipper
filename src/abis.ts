/**
 * Complete smart contract ABI definitions
 * Extracted from contract compilation artifacts
 */

export const SNIPER_SEARCHER_ABI = [
  // Events
  'event Swap(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)',
  'event Withdrawn(address indexed token, address indexed to, uint256 amount)',
  'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
  'event ExecutorAllowed(address indexed executor)',
  'event ExecutorRevoked(address indexed executor)',

  // View functions
  'function getBalance(address token) external view returns (uint256)',
  'function owner() external view returns (address)',
  'function swapRouter() external view returns (address)',
  'function allowedExecutors(address executor) external view returns (bool)',
  'function minAmountBitLength() external view returns (uint256)',

  // State-changing functions
  'function executeSwap(address tokenIn, uint256 amountIn, bytes calldata path, uint256 minAmountOut) external returns (uint256 amountOut)',
  'function executeSwapWithDeadline(address tokenIn, uint256 amountIn, bytes calldata path, uint256 minAmountOut, uint256 deadline) external returns (uint256 amountOut)',
  'function allowExecutor(address executor) external',
  'function revokeExecutor(address executor) external',
  'function transferOwnership(address newOwner) external',
  'function withdraw(address token, address to, uint256 amount) external',
  'function withdrawAll(address[] calldata tokens, address to) external',
  'function withdrawETH(address payable to, uint256 amount) external',
  'function emergencyWithdrawToken(address token, address to) external',
  'function emergencyWithdrawETH(address payable to) external',
];

export const FLASH_LOAN_RECEIVER_ABI = [
  // Events
  'event FlashLoanExecuted(address indexed initiator, address indexed token, uint256 amount, uint256 fee)',
  'event ExecutionFailed(string reason)',

  // View functions
  'function POOL() external view returns (address)',
  'function owner() external view returns (address)',

  // State-changing functions (called by Aave flash loan)
  'function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params) external returns (bool)',
  'function withdraw(address token, address to, uint256 amount) external',
  'function withdrawETH(address payable to) external',
];

export const DELEGATED_EXECUTOR_ABI = [
  // Events
  'event SwapExecutedViaDelegate(address indexed caller, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)',
  'event BatchSwapsExecuted(uint256 count)',

  // View functions
  'function owner() external view returns (address)',
  'function balance(address token) external view returns (uint256)',

  // State-changing functions
  'function executeSwap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, bytes calldata path) external payable returns (uint256 amountOut)',
  'function executeSwapWithCallback(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, bytes calldata path, bytes calldata callbackData) external payable returns (uint256 amountOut)',
  'function executeBatchSwaps(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, bytes path)[] swaps) external payable returns (uint256[] amountOuts)',
  'function withdraw(address token, uint256 amount) external',
  'function withdrawETH(uint256 amount) external',
];

export const AAVE_V3_POOL_ABI = [
  'function flashLoanSimple(address receiver, address token, uint256 amount, bytes calldata params, uint16 referralCode) external',
  'function getReserveData(address asset) external view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 variableBorrowIndex, uint128 currentLiquidityRate, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint8 id) data)',
];

export const UNISWAP_V3_ROUTER_ABI = [
  'function exactInputSingle(tuple(bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)',
  'function exactInput(tuple(bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params) external payable returns (uint256 amountOut)',
  'function exactOutputSingle(tuple(bytes path, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountIn)',
  'function multicall(uint256 deadline, bytes[] data) external payable returns (bytes[] results)',
];

// QuoterV2: richer return data (sqrtPriceX96After, initializedTicksCrossed, gasEstimate)
// vs V1's single uint256. Struct-based params, not positional.
export const UNISWAP_V3_QUOTER_ABI = [
  'function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  'function quoteExactInput(bytes memory path, uint256 amountIn) external returns (uint256 amountOut, uint160[] memory sqrtPriceX96AfterList, uint32[] memory initializedTicksCrossedList, uint256 gasEstimate)',
];

export const ERC20_ABI = [
  // Events
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',

  // View functions
  'function name() external view returns (string)',
  'function symbol() external view returns (string)',
  'function decimals() external view returns (uint8)',
  'function totalSupply() external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',

  // State-changing functions
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function transfer(address to, uint256 amount) external returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) external returns (bool)',
];

export const PERMIT2_ABI = [
  // Permit2 for gas-efficient approvals
  'function permit(address owner, tuple(address token, uint160 amount, uint48 expiration, uint48 nonce) permitted, bytes calldata signature) external',
  'function permitTransferFrom(tuple(address from, address to, uint160 amount) transferDetails, tuple(address token, uint160 amount, uint48 expiration, uint48 nonce) permitted, bytes calldata signature) external',
  'function transferFrom(address from, address to, uint160 amount, address token) external',
  'function allowance(address owner, address token, address spender) external view returns (uint160 amount, uint48 expiration, uint48 nonce)',
];

export default {
  SNIPER_SEARCHER_ABI,
  FLASH_LOAN_RECEIVER_ABI,
  DELEGATED_EXECUTOR_ABI,
  AAVE_V3_POOL_ABI,
  UNISWAP_V3_ROUTER_ABI,
  UNISWAP_V3_QUOTER_ABI,
  ERC20_ABI,
  PERMIT2_ABI,
};
