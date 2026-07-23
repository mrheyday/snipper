// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

/// @dev Aave V3 IFlashLoanSimpleReceiver — must return true; Pool reverts otherwise.
///      Signature matches aave-v3-origin `IFlashLoanSimpleReceiver.executeOperation`.
interface IFlashLoanSimpleReceiver {
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        returns (bool);
}

/// @dev Aave V3 Pool — flashLoanSimple only (single reserve, no debt mode, no fee waiver).
///      Docs: Pool pulls amount+premium after executeOperation; approve, do not transfer.
interface IPool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    /// @dev Total flash fee in bps (live Arbitrum was 5 as of check; governance-updatable).
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
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
/// @notice Aave V3 flashLoanSimple receiver for single-block arbitrage on Arbitrum.
/// @dev Conforms to IFlashLoanSimpleReceiver. Flow (one tx / one block):
///      1. owner (or type-4 delegated EOA owner) calls initiateFlashLoan
///      2. Pool transfers `amount` here, then calls executeOperation
///      3. We approve SniperSearcher, swap (path MUST end in `asset` for repay),
///         approve Pool for amount+premium; Pool pulls on return
///      4. Leftover `asset` is profit — withdraw promptly (griefing risk if parked)
contract FlashLoanReceiver {
    address public immutable owner;
    address public immutable swapExecutor;
    address public immutable lendingPool;

    /// @dev Off-chain / UI hint only. Live fee is Pool.FLASHLOAN_PREMIUM_TOTAL() (bps).
    ///      Repay always uses the `premium` argument from the Pool callback — never this.
    ///      Arbitrum mainnet read 2026-07-23: 5 bps. Was historically 9 bps at V3 launch.
    uint256 public constant FLASH_LOAN_PREMIUM_RATE_BPS_HINT = 5;

    event FlashLoanExecuted(address indexed token, uint256 amount, uint256 premium, uint256 profit);

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address _swapExecutor, address _lendingPool) {
        owner = msg.sender;
        swapExecutor = _swapExecutor;
        lendingPool = _lendingPool;
    }

    /// @notice Live premium bps from the configured Aave Pool (governance-updatable).
    function flashLoanPremiumBps() external view returns (uint256) {
        return uint256(IPool(lendingPool).FLASHLOAN_PREMIUM_TOTAL());
    }

    /// @notice Initiate flashLoanSimple with this contract as receiver (docs path 3).
    /// @param token Reserve asset to borrow (must have borrowing enabled)
    /// @param amount Amount to borrow
    /// @param swapPath Uniswap V3 path; final token MUST equal `token` (round-trip)
    /// @param minAmountOut Minimum final amountOut of the borrow asset
    function initiateFlashLoan(address token, uint256 amount, bytes calldata swapPath, uint256 minAmountOut)
        external
        onlyOwner
    {
        bytes memory params = abi.encode(token, swapPath, minAmountOut);
        // receiverAddress = address(this): same-contract path from Aave docs
        IPool(lendingPool).flashLoanSimple(address(this), token, amount, params, 0);
    }

    /// @notice Aave V3 Pool callback after funds are transferred in.
    /// @dev Must approve Pool for amount+premium before returning true. Do not transfer.
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        returns (bool)
    {
        if (msg.sender != lendingPool) revert Unauthorized();
        // Only loans we initiated (prevents third-party griefing via forced callback)
        require(initiator == address(this), "Initiator mismatch");

        (, bytes memory swapPath, uint256 minAmountOut) = abi.decode(params, (address, bytes, uint256));

        // SniperSearcher pulls via transferFrom(msg.sender=this)
        SafeTransferLib.safeApproveWithRetry(asset, swapExecutor, amount);

        // Path must return the borrow asset (round-trip arb). Output is transferred
        // back to this contract by SniperSearcher (allowed-executor path).
        ISwapExecutor(swapExecutor).executeSwap(asset, amount, swapPath, minAmountOut);

        // Never leave a standing approval on the searcher between txs
        SafeTransferLib.safeApprove(asset, swapExecutor, 0);

        // Aave pulls amount+premium after we return — use callback premium, not a constant
        uint256 amountOwed = amount + premium;
        uint256 balance = IERC20(asset).balanceOf(address(this));
        if (balance < amountOwed) {
            revert InsufficientRepayment(balance, amountOwed);
        }

        // Approve Pool only — docs: funds are pulled, not pushed
        SafeTransferLib.safeApproveWithRetry(asset, lendingPool, amountOwed);

        uint256 profit = balance - amountOwed;
        emit FlashLoanExecuted(asset, amount, premium, profit);

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
