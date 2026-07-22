// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ISwapRouter {
    struct ExactInputSingleParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IUniswapV3Router02 {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

error Unauthorized();
error InsufficientAmountOut(uint256 received, uint256 minimum);
error SwapFailed();
error TransferFailed();

/// @title SniperSearcher
/// @notice MEV searcher contract for Arbitrum sniper bot
/// @dev Executes token swaps on Uniswap V3 for MEV opportunities
contract SniperSearcher {
    using SafeERC20 for IERC20;

    address public immutable owner;
    address public immutable swapRouter;
    uint256 public immutable chainId;

    // Access control for flash loan receiver and other executors
    mapping(address executor => bool allowed) public allowedExecutors;

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

    constructor(address _swapRouter) {
        owner = msg.sender;
        swapRouter = _swapRouter;
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
        // Transfer tokens from caller to this contract
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        // Approve router
        IERC20(tokenIn).forceApprove(swapRouter, amountIn);

        // Execute swap
        try IUniswapV3Router02(swapRouter)
            .exactInput(
                IUniswapV3Router02.ExactInputParams({
                    path: path,
                    recipient: address(this),
                    deadline: block.timestamp + 30 seconds,
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

        if (amountOut < minAmountOut) {
            revert InsufficientAmountOut(amountOut, minAmountOut);
        }

        emit Swap(tokenIn, _getTokenOut(path), amountIn, amountOut);
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
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(swapRouter, amountIn);

        try IUniswapV3Router02(swapRouter)
            .exactInput(
                IUniswapV3Router02.ExactInputParams({
                    path: path,
                    recipient: address(this),
                    deadline: deadline,
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

        if (amountOut < minAmountOut) {
            revert InsufficientAmountOut(amountOut, minAmountOut);
        }

        emit Swap(tokenIn, _getTokenOut(path), amountIn, amountOut);
    }

    /// @notice Withdraw tokens from contract
    /// @param token Token to withdraw
    /// @param to Recipient address
    /// @param amount Amount to withdraw
    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        if (amount == 0) amount = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
    }

    /// @notice Withdraw multiple tokens
    /// @param tokens Array of token addresses
    /// @param to Recipient address
    function withdrawAll(address[] calldata tokens, address to) external onlyOwner {
        for (uint256 i = 0; i < tokens.length; ++i) {
            uint256 balance = IERC20(tokens[i]).balanceOf(address(this));
            if (balance > 0) {
                IERC20(tokens[i]).safeTransfer(to, balance);
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
            emit Withdrawn(token, to, balance);
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

    /// @dev Extract output token from Uniswap V3 path encoding
    function _getTokenOut(bytes calldata path) internal pure returns (address) {
        require(path.length >= 20, "Invalid path");
        return address(bytes20(path[path.length - 20:]));
    }

    /// @notice Receive ETH for gas refunds
    receive() external payable {}
}
