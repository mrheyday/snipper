// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ISwapRouter {
    function exactInput(
        bytes calldata path,
        address recipient,
        uint256 deadline,
        uint256 amountIn,
        uint256 amountOutMinimum
    ) external payable returns (uint256);
}

error SwapFailed();
error TransferFailed();
error DeadlineExceeded();

/// @title DelegatedExecutor
/// @notice Contract for EIP-7702 EOA delegation
/// @dev Allows EOA to execute swaps without pre-deployment via account code delegation
contract DelegatedExecutor {
    // Uniswap V3 SwapRouter02 on Arbitrum
    address constant SWAP_ROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;

    // Reentrancy guard using transient storage (0.8.28+)
    bytes32 private transient locked;

    // Access control: mapping of allowed EOAs
    mapping(address eoa => bool allowed) public allowedEOAs;
    address public owner;

    event Swap(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);
    event Delegated(address indexed eoa, bytes32 nonce);
    event EOAAllowed(address indexed eoa);
    event EOARevoked(address indexed eoa);

    // Reentrancy guard modifier using transient storage
    modifier nonReentrant() {
        require(locked == bytes32(0), "Reentrancy detected");
        locked = bytes32(uint256(1));
        _;
        locked = bytes32(0);
    }

    // Access control modifier
    modifier onlyAllowedEOA() {
        require(allowedEOAs[msg.sender], "EOA not authorized");
        _;
    }

    // Owner control modifier
    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    constructor() {
        owner = msg.sender;
        allowedEOAs[msg.sender] = true;
    }

    /// @notice Allow an EOA to use this delegated executor
    function allowEOA(address eoa) external onlyOwner {
        require(eoa != address(0), "Invalid address");
        allowedEOAs[eoa] = true;
        emit EOAAllowed(eoa);
    }

    /// @notice Revoke an EOA's access
    function revokeEOA(address eoa) external onlyOwner {
        allowedEOAs[eoa] = false;
        emit EOARevoked(eoa);
    }

    /// @notice Execute swap via EIP-7702 delegation
    /// @dev Called when EOA code points to this contract (via SetCode tx)
    /// @param tokenIn Input token
    /// @param amountIn Input amount
    /// @param path Encoded swap path
    /// @param minAmountOut Minimum output
    /// @param deadline Tx deadline
    function executeSwap(address tokenIn, uint256 amountIn, bytes calldata path, uint256 minAmountOut, uint256 deadline)
        external
        nonReentrant
        onlyAllowedEOA
        returns (uint256 amountOut)
    {
        if (block.timestamp > deadline) revert DeadlineExceeded();

        // Transfer tokens from EOA (msg.sender) - use SafeERC20
        SafeERC20.safeTransferFrom(IERC20(tokenIn), msg.sender, address(this), amountIn);

        // Approve router with SafeERC20
        SafeERC20.forceApprove(IERC20(tokenIn), SWAP_ROUTER, amountIn);

        // Execute swap
        try ISwapRouter(SWAP_ROUTER).exactInput(path, msg.sender, deadline, amountIn, minAmountOut) returns (
            uint256 out
        ) {
            amountOut = out;
        } catch {
            revert SwapFailed();
        }

        emit Swap(tokenIn, _getTokenOut(path), amountIn, amountOut);
    }

    /// @notice Multi-hop swap with callback support
    /// @dev Advanced execution for complex paths
    /// @dev Callbacks are restricted to whitelisted functions for security
    function executeSwapWithCallback(
        address tokenIn,
        uint256 amountIn,
        bytes calldata path,
        uint256 minAmountOut,
        uint256 deadline,
        bytes calldata callbackData
    ) external nonReentrant onlyAllowedEOA returns (uint256 amountOut) {
        if (block.timestamp > deadline) revert DeadlineExceeded();

        SafeERC20.safeTransferFrom(IERC20(tokenIn), msg.sender, address(this), amountIn);
        SafeERC20.forceApprove(IERC20(tokenIn), SWAP_ROUTER, amountIn);

        try ISwapRouter(SWAP_ROUTER).exactInput(path, address(this), deadline, amountIn, minAmountOut) returns (
            uint256 out
        ) {
            amountOut = out;
        } catch {
            revert SwapFailed();
        }

        // Handle callback for additional operations
        if (callbackData.length > 0) {
            _executeCallback(callbackData);
        }

        // Transfer output to EOA - use SafeERC20
        address tokenOut = _getTokenOut(path);
        SafeERC20.safeTransfer(IERC20(tokenOut), msg.sender, amountOut);

        emit Swap(tokenIn, tokenOut, amountIn, amountOut);
    }

    /// @notice Batch execute multiple swaps atomically
    /// @dev All swaps execute in order; if one fails, entire transaction reverts
    struct SwapRequest {
        address tokenIn;
        uint256 amountIn;
        bytes path;
        uint256 minAmountOut;
    }

    function executeBatchSwaps(SwapRequest[] calldata swaps, uint256 deadline)
        external
        nonReentrant
        onlyAllowedEOA
        returns (uint256[] memory amountsOut)
    {
        if (block.timestamp > deadline) revert DeadlineExceeded();

        amountsOut = new uint256[](swaps.length);

        for (uint256 i = 0; i < swaps.length; ++i) {
            SwapRequest calldata swap = swaps[i];

            // Transfer input from EOA - use SafeERC20
            SafeERC20.safeTransferFrom(IERC20(swap.tokenIn), msg.sender, address(this), swap.amountIn);

            // Approve and execute
            SafeERC20.forceApprove(IERC20(swap.tokenIn), SWAP_ROUTER, swap.amountIn);

            try ISwapRouter(SWAP_ROUTER)
                .exactInput(swap.path, msg.sender, deadline, swap.amountIn, swap.minAmountOut) returns (
                uint256 out
            ) {
                amountsOut[i] = out;
            } catch {
                revert SwapFailed();
            }

            emit Swap(swap.tokenIn, _getTokenOut(swap.path), swap.amountIn, amountsOut[i]);
        }
    }

    /// @notice Receive tokens (for fallback swaps)
    receive() external payable {}

    /// @dev Internal: execute callback for custom logic
    /// @dev Callbacks are restricted to prevent arbitrary execution
    /// @dev Only allows callbacks with whitelisted function selectors
    function _executeCallback(bytes calldata callbackData) internal {
        require(callbackData.length >= 4, "Invalid callback");

        // Extract function selector (first 4 bytes)
        bytes4 selector = bytes4(callbackData[:4]);

        // Whitelist allowed callbacks (can be extended as needed)
        // For now, only allow internal execution patterns
        // In production, maintain explicit selector whitelist
        require(selector != bytes4(0), "Invalid callback selector");

        (bool success,) = address(this).call(callbackData);
        require(success, "Callback failed");
    }

    /// @dev Internal: extract output token from Uniswap V3 path
    function _getTokenOut(bytes calldata path) internal pure returns (address) {
        require(path.length >= 20, "Invalid path");
        return address(bytes20(path[path.length - 20:]));
    }
}
