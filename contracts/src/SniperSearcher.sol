// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {Multicallable} from "solady/utils/Multicallable.sol";
import {MegaMEVOptimizationLib} from "./MegaMEVOptimizationLib.sol";

/// @dev Full ERC20 + metadata interface (EIP-20 core + the `name`/`symbol`/`decimals`
///      extension), defined locally so the contract has no OpenZeppelin dependency.
///      Only `balanceOf` is actually called on-chain here; the rest is kept for
///      completeness/tooling (e.g. off-chain callers introspecting this interface).
interface IERC20 {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}

interface ISwapRouter {
    struct ExactInputSingleParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @dev Matches the actual deployed SwapRouter02 ABI, which (unlike the original V1
///      ISwapRouter) does not accept a per-call `deadline` field on exactInput/exactInputSingle.
interface IUniswapV3Router02 {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

error Unauthorized();
error InsufficientAmountOut(uint256 received, uint256 minimum);
error SwapFailed();
error TransferFailed();
error DeadlineExceeded();
error AmountTooSmall(uint256 amountIn, uint256 minBitLength);

/// @title SniperSearcher
/// @notice MEV searcher contract for Arbitrum sniper bot
/// @dev Executes token swaps on Uniswap V3 for MEV opportunities
contract SniperSearcher is Multicallable {
    address public immutable owner;
    address public immutable swapRouter;
    uint256 public immutable chainId;

    // Access control for flash loan receiver and other executors
    mapping(address executor => bool allowed) public allowedExecutors;

    /// @notice Minimum bit-length (via the native CLZ opcode) an `amountIn` must have to
    ///         proceed to the swap. 0 disables the check. Set once at deployment (immutable,
    ///         not owner-settable) to keep deployed bytecode small — rejecting a dust trade
    ///         here is far cheaper than paying for a transferFrom + approve + router call
    ///         that was never going to be worth it.
    uint256 public immutable minAmountBitLength;

    event Swap(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ExecutorAllowed(address indexed executor);
    event ExecutorRevoked(address indexed executor);

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyOwnerOrAllowedExecutor() {
        if (msg.sender != owner && !allowedExecutors[msg.sender]) revert Unauthorized();
        _;
    }

    constructor(address _swapRouter, uint256 _minAmountBitLength) {
        owner = msg.sender;
        swapRouter = _swapRouter;
        minAmountBitLength = _minAmountBitLength;
        uint256 id;
        assembly {
            id := chainid()
        }
        chainId = id;
    }

    /// @notice Allow an executor (like FlashLoanReceiver) to call swap functions
    function allowExecutor(address executor) external onlyOwner {
        require(executor != address(0), "Invalid executor");
        allowedExecutors[executor] = true;
        emit ExecutorAllowed(executor);
    }

    /// @notice Revoke an executor's access
    function revokeExecutor(address executor) external onlyOwner {
        allowedExecutors[executor] = false;
        emit ExecutorRevoked(executor);
    }

    /// @notice Execute exact-input swap on Uniswap V3
    /// @param tokenIn Input token address
    /// @param amountIn Amount of input token
    /// @param path Encoded swap path (tokenIn → ... → tokenOut)
    /// @param minAmountOut Minimum acceptable output amount
    /// @return amountOut Amount of output token received
    function executeSwap(address tokenIn, uint256 amountIn, bytes calldata path, uint256 minAmountOut)
        external
        onlyOwnerOrAllowedExecutor
        returns (uint256 amountOut)
    {
        _checkMinAmount(amountIn);

        // Transfer tokens from caller to this contract
        SafeTransferLib.safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);

        // Approve router
        SafeTransferLib.safeApproveWithRetry(tokenIn, swapRouter, amountIn);

        // Execute swap
        try IUniswapV3Router02(swapRouter)
            .exactInput(
                IUniswapV3Router02.ExactInputParams({
                    path: path,
                    recipient: address(this),
                    amountIn: amountIn,
                    amountOutMinimum: minAmountOut
                })
            ) returns (
            uint256 out
        ) {
            amountOut = out;
        } catch {
            revert SwapFailed();
        }

        // Revoke any unconsumed allowance so the router never holds a standing approval
        // from this contract between transactions.
        SafeTransferLib.safeApprove(tokenIn, swapRouter, 0);

        if (amountOut < minAmountOut) {
            revert InsufficientAmountOut(amountOut, minAmountOut);
        }

        // Return proceeds to caller so FlashLoanReceiver (and other allowed
        // executors) can repay Aave / keep profit. Owner calls keep tokens here
        // unless the owner is itself the msg.sender path — still transfer so
        // balance accounting is consistent for nested executor flows.
        address tokenOut = _getTokenOut(path);
        SafeTransferLib.safeTransfer(tokenOut, msg.sender, amountOut);

        emit Swap(tokenIn, tokenOut, amountIn, amountOut);
    }

    /// @notice Execute multi-hop swap with custom deadline
    /// @param tokenIn Input token
    /// @param amountIn Input amount
    /// @param path Encoded swap path
    /// @param minAmountOut Minimum output
    /// @param deadline Transaction deadline
    /// @return amountOut Output amount
    function executeSwapWithDeadline(
        address tokenIn,
        uint256 amountIn,
        bytes calldata path,
        uint256 minAmountOut,
        uint256 deadline
    ) external onlyOwnerOrAllowedExecutor returns (uint256 amountOut) {
        if (block.timestamp > deadline) revert DeadlineExceeded();
        _checkMinAmount(amountIn);

        SafeTransferLib.safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);
        SafeTransferLib.safeApproveWithRetry(tokenIn, swapRouter, amountIn);

        try IUniswapV3Router02(swapRouter)
            .exactInput(
                IUniswapV3Router02.ExactInputParams({
                    path: path,
                    recipient: address(this),
                    amountIn: amountIn,
                    amountOutMinimum: minAmountOut
                })
            ) returns (
            uint256 out
        ) {
            amountOut = out;
        } catch {
            revert SwapFailed();
        }

        // Revoke any unconsumed allowance so the router never holds a standing approval
        // from this contract between transactions.
        SafeTransferLib.safeApprove(tokenIn, swapRouter, 0);

        if (amountOut < minAmountOut) {
            revert InsufficientAmountOut(amountOut, minAmountOut);
        }

        address tokenOut = _getTokenOut(path);
        SafeTransferLib.safeTransfer(tokenOut, msg.sender, amountOut);

        emit Swap(tokenIn, tokenOut, amountIn, amountOut);
    }

    /// @notice Withdraw tokens from contract
    /// @param token Token to withdraw
    /// @param to Recipient address
    /// @param amount Amount to withdraw
    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        if (amount == 0) amount = IERC20(token).balanceOf(address(this));
        SafeTransferLib.safeTransfer(token, to, amount);
        emit Withdrawn(token, to, amount);
    }

    /// @notice Withdraw multiple tokens
    /// @param tokens Array of token addresses
    /// @param to Recipient address
    function withdrawAll(address[] calldata tokens, address to) external onlyOwner {
        for (uint256 i = 0; i < tokens.length; ++i) {
            uint256 balance = IERC20(tokens[i]).balanceOf(address(this));
            if (balance > 0) {
                SafeTransferLib.safeTransfer(tokens[i], to, balance);
                emit Withdrawn(tokens[i], to, balance);
            }
        }
    }

    /// @notice Check balance of a token
    /// @param token Token address
    /// @return Balance of token in this contract
    function getBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
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
            emit Withdrawn(token, to, balance);
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

    /// @dev Extract output token from Uniswap V3 path encoding
    function _getTokenOut(bytes calldata path) internal pure returns (address) {
        require(path.length >= 20, "Invalid path");
        return address(bytes20(path[path.length - 20:]));
    }

    /// @dev Reverts cheaply (native CLZ opcode, no external calls) if `amountIn` is too small
    ///      to be worth the transferFrom + approve + router call that would otherwise follow.
    function _checkMinAmount(uint256 amountIn) internal view {
        uint256 minBits = minAmountBitLength;
        if (minBits != 0 && MegaMEVOptimizationLib.bitLength(amountIn) < minBits) {
            revert AmountTooSmall(amountIn, minBits);
        }
    }

    /// @notice Receive ETH for gas refunds
    receive() external payable {}
}
