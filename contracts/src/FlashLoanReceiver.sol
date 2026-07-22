// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IFlashLoanReceiver {
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        returns (bytes32);
}

interface ILendingPool {
    function flashLoan(address receiverAddress, address token, uint256 amount, bytes calldata params) external;
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
    using SafeERC20 for IERC20;

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
        ILendingPool(lendingPool).flashLoan(address(this), token, amount, params);
    }

    /// @notice Flash loan callback (called by lending pool)
    /// @dev Receives tokens, executes swap, repays loan + premium
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        returns (bytes32)
    {
        if (msg.sender != lendingPool) revert Unauthorized();
        require(initiator == address(this), "Initiator mismatch");

        (address token, bytes memory swapPath, uint256 minAmountOut) = abi.decode(params, (address, bytes, uint256));

        require(token == asset, "Token mismatch");

        // Execute arbitrage swap
        uint256 amountOut = ISwapExecutor(swapExecutor).executeSwap(asset, amount, swapPath, minAmountOut);

        // Calculate repayment (loan + fee)
        uint256 amountOwed = amount + premium;

        // Verify we have enough to repay
        uint256 balance = IERC20(asset).balanceOf(address(this));
        if (balance < amountOwed) {
            revert InsufficientRepayment(balance, amountOwed);
        }

        // Approve lending pool for repayment
        IERC20(asset).forceApprove(lendingPool, amountOwed);

        emit FlashLoanExecuted(asset, amount, premium, amountOut >= amountOwed ? amountOut - amountOwed : 0);

        return keccak256("ERC3156FlashBorrower.onFlashLoan");
    }

    /// @notice Withdraw profit to owner wallet
    /// @param token Token to withdraw
    /// @param to Recipient address
    /// @param amount Amount to withdraw (0 = all)
    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        if (amount == 0) amount = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice Withdraw ETH from contract
    /// @param to Recipient address
    /// @param amount Amount to withdraw (0 = all)
    function withdrawETH(address payable to, uint256 amount) external onlyOwner {
        if (amount == 0) amount = address(this).balance;
        require(to != address(0), "Invalid recipient");
        (bool success,) = to.call{value: amount}("");
        require(success, "ETH transfer failed");
    }

    /// @notice Emergency recovery for stuck tokens
    /// @param token Token to recover
    /// @param to Recipient address
    function emergencyWithdrawToken(address token, address to) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            IERC20(token).safeTransfer(to, balance);
        }
    }

    /// @notice Emergency recovery for stuck ETH (alias for withdrawETH)
    /// @param to Recipient address
    function emergencyWithdrawETH(address payable to) external onlyOwner {
        uint256 balance = address(this).balance;
        if (balance > 0) {
            (bool success,) = to.call{value: balance}("");
            require(success, "ETH transfer failed");
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
