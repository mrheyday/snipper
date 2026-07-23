// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

/// @dev Aave V3 IFlashLoanSimpleReceiver — must return true to signal success.
interface IFlashLoanReceiver {
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        returns (bool);
}

/// @dev Aave V3 Pool interface — uses flashLoanSimple (not the legacy 4-arg flashLoan).
interface ILendingPool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface ISwapExecutor {
    function executeSwap(address tokenIn, uint256 amountIn, bytes calldata path, uint256 minAmountOut)
        external
        returns (uint256);
}

error Unauthorized();
error FlashLoanFailed();
error InsufficientRepayment(uint256 available, uint256 required);

/// @title FlashLoanReceiver
/// @notice Flash loan receiver for zero-cost arbitrage on Arbitrum
/// @dev Receives flash-loaned tokens, executes swaps, repays loan + fee
contract FlashLoanReceiver {
    address public immutable owner;
    address public immutable swapExecutor;
    address public immutable lendingPool;
    uint256 public constant FLASH_LOAN_PREMIUM_RATE = 9; // 0.09% (9 bps)

    event FlashLoanExecuted(address indexed token, uint256 amount, uint256 premium, uint256 profit);
    event SwapExecuted(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address _swapExecutor, address _lendingPool) {
        owner = msg.sender;
        swapExecutor = _swapExecutor;
        lendingPool = _lendingPool;
    }

    /// @notice Initiate flash loan for arbitrage
    /// @param token Token to borrow via flash loan
    /// @param amount Amount to borrow
    /// @param swapPath Encoded swap path for arbitrage
    /// @param minAmountOut Minimum output from swap
    function initiateFlashLoan(address token, uint256 amount, bytes calldata swapPath, uint256 minAmountOut)
        external
        onlyOwner
    {
        bytes memory params = abi.encode(token, swapPath, minAmountOut);
        // Aave V3: flashLoanSimple(receiver, asset, amount, params, referralCode)
        ILendingPool(lendingPool).flashLoanSimple(address(this), token, amount, params, 0);
    }

    /// @notice Flash loan callback — called by Aave V3 Pool after transferring funds.
    /// @dev Must return true; Aave V3 reverts if this returns false.
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        returns (bool)
    {
        if (msg.sender != lendingPool) revert Unauthorized();
        require(initiator == address(this), "Initiator mismatch");

        (, bytes memory swapPath, uint256 minAmountOut) = abi.decode(params, (address, bytes, uint256));

        // Execute arbitrage swap (receive tokenOut, keep any surplus as profit)
        uint256 amountOut = ISwapExecutor(swapExecutor).executeSwap(asset, amount, swapPath, minAmountOut);

        // Calculate repayment obligation (loan + Aave fee)
        uint256 amountOwed = amount + premium;

        // Verify we have enough of the borrow asset to repay
        uint256 balance = IERC20(asset).balanceOf(address(this));
        if (balance < amountOwed) {
            revert InsufficientRepayment(balance, amountOwed);
        }

        // Approve lending pool for repayment (Aave pulls this immediately after
        // executeOperation returns — never revoke before that pull).
        SafeTransferLib.safeApproveWithRetry(asset, lendingPool, amountOwed);

        emit FlashLoanExecuted(asset, amount, premium, amountOut >= amountOwed ? amountOut - amountOwed : 0);

        // Aave V3 requires true; any other value causes the pool to revert.
        return true;
    }

    /// @notice Withdraw profit to owner wallet
    /// @param token Token to withdraw
    /// @param to Recipient address
    /// @param amount Amount to withdraw (0 = all)
    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        if (amount == 0) amount = IERC20(token).balanceOf(address(this));
        SafeTransferLib.safeTransfer(token, to, amount);
    }

    /// @notice Withdraw ETH from contract
    /// @param to Recipient address
    /// @param amount Amount to withdraw (0 = all)
    function withdrawETH(address payable to, uint256 amount) external onlyOwner {
        if (amount == 0) amount = address(this).balance;
        require(to != address(0), "Invalid recipient");
        SafeTransferLib.safeTransferETH(to, amount);
    }

    /// @notice Emergency recovery for stuck tokens
    /// @param token Token to recover
    /// @param to Recipient address
    function emergencyWithdrawToken(address token, address to) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            SafeTransferLib.safeTransfer(token, to, balance);
        }
    }

    /// @notice Emergency recovery for stuck ETH (alias for withdrawETH)
    /// @param to Recipient address
    function emergencyWithdrawETH(address payable to) external onlyOwner {
        uint256 balance = address(this).balance;
        if (balance > 0) {
            SafeTransferLib.safeTransferETH(to, balance);
        }
    }

    /// @notice Check contract token balance
    /// @param token Token address
    /// @return Balance of token
    function getBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    /// @notice Receive ETH for gas refunds
    receive() external payable {}
}
