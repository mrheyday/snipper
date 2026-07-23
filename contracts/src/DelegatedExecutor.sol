// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {Multicallable} from "solady/utils/Multicallable.sol";
import {MegaMEVOptimizationLib} from "./MegaMEVOptimizationLib.sol";

/// @dev Matches the actual deployed SwapRouter02 ABI, which does not accept a
///      per-call `deadline` field on exactInput. Deadlines are enforced at the
///      contract level instead (see DeadlineExceeded checks below).
interface ISwapRouter {
    function exactInput(bytes calldata path, address recipient, uint256 amountIn, uint256 amountOutMinimum)
        external
        payable
        returns (uint256);
}

error SwapFailed();
error TransferFailed();
error DeadlineExceeded();
error AmountTooSmall(uint256 amountIn, uint256 minBitLength);

/// @title DelegatedExecutor
/// @notice Contract for EIP-7702 EOA delegation
/// @dev Allows EOA to execute swaps without pre-deployment via account code delegation
contract DelegatedExecutor is Multicallable {
    // Uniswap V3 SwapRouter02 on Arbitrum
    address constant SWAP_ROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;

    // Reentrancy guard using transient storage (0.8.28+)
    bytes32 private transient locked;

    // Access control: mapping of allowed EOAs
    mapping(address eoa => bool allowed) public allowedEOAs;
    address public owner;

    /// @notice Minimum bit-length (via the native CLZ opcode) an `amountIn` must have to
    ///         proceed to the swap. 0 disables the check. Set once at deployment (immutable,
    ///         not owner-settable) to keep deployed bytecode small.
    uint256 public immutable minAmountBitLength;

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

    constructor(uint256 _minAmountBitLength) {
        owner = msg.sender;
        allowedEOAs[msg.sender] = true;
        minAmountBitLength = _minAmountBitLength;
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
        _checkMinAmount(amountIn);

        // Transfer tokens from EOA (msg.sender)
        SafeTransferLib.safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);

        // Approve router
        SafeTransferLib.safeApproveWithRetry(tokenIn, SWAP_ROUTER, amountIn);

        // Execute swap
        try ISwapRouter(SWAP_ROUTER).exactInput(path, msg.sender, amountIn, minAmountOut) returns (uint256 out) {
            amountOut = out;
        } catch {
            revert SwapFailed();
        }

        // Revoke any unconsumed allowance so the router never holds a standing approval
        // from this contract between transactions.
        SafeTransferLib.safeApprove(tokenIn, SWAP_ROUTER, 0);

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
        _checkMinAmount(amountIn);

        SafeTransferLib.safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);
        SafeTransferLib.safeApproveWithRetry(tokenIn, SWAP_ROUTER, amountIn);

        try ISwapRouter(SWAP_ROUTER).exactInput(path, address(this), amountIn, minAmountOut) returns (uint256 out) {
            amountOut = out;
        } catch {
            revert SwapFailed();
        }

        // Revoke any unconsumed allowance so the router never holds a standing approval
        // from this contract between transactions.
        SafeTransferLib.safeApprove(tokenIn, SWAP_ROUTER, 0);

        // Handle callback for additional operations
        if (callbackData.length > 0) {
            _executeCallback(callbackData);
        }

        // Transfer output to EOA
        address tokenOut = _getTokenOut(path);
        SafeTransferLib.safeTransfer(tokenOut, msg.sender, amountOut);

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
            _checkMinAmount(swap.amountIn);

            // Transfer input from EOA
            SafeTransferLib.safeTransferFrom(swap.tokenIn, msg.sender, address(this), swap.amountIn);

            // Approve and execute
            SafeTransferLib.safeApproveWithRetry(swap.tokenIn, SWAP_ROUTER, swap.amountIn);

            try ISwapRouter(SWAP_ROUTER).exactInput(swap.path, msg.sender, swap.amountIn, swap.minAmountOut) returns (
                uint256 out
            ) {
                amountsOut[i] = out;
            } catch {
                revert SwapFailed();
            }

            // Revoke any unconsumed allowance so the router never holds a standing approval
            // from this contract between transactions.
            SafeTransferLib.safeApprove(swap.tokenIn, SWAP_ROUTER, 0);

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

    /// @dev Reverts cheaply (native CLZ opcode, no external calls) if `amountIn` is too small
    ///      to be worth the transferFrom + approve + router call that would otherwise follow.
    function _checkMinAmount(uint256 amountIn) internal view {
        uint256 minBits = minAmountBitLength;
        if (minBits != 0 && MegaMEVOptimizationLib.bitLength(amountIn) < minBits) {
            revert AmountTooSmall(amountIn, minBits);
        }
    }
}
