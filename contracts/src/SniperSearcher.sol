// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {Multicallable} from "solady/utils/Multicallable.sol";
import {MegaMEVOptimizationLib} from "./MegaMEVOptimizationLib.sol";

/// @dev Local ERC20 surface — only balanceOf is read on-chain; rest for tooling.
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

/// @dev Uniswap-V3-style SwapRouter02 exactInput (no per-call deadline field).
///      Used by routers registered with legacyAbi = false (Uniswap V3, PancakeSwap V3).
interface IUniswapV3Router02 {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @dev Older-generation Uniswap V3 periphery ISwapRouter exactInput — deadline INSIDE the
///      struct. Used by routers registered with legacyAbi = true (SushiSwap V3's real deployed
///      router on Arbitrum uses this shape, not SwapRouter02's — confirmed via mainnet-fork
///      dry run 2026-07-24: the 4-field call reverts with empty data, the 5-field call with
///      deadline succeeds).
interface ILegacySwapRouter {
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
error DeadlineExceeded();
error AmountTooSmall(uint256 amountIn, uint256 minBitLength);
error InvalidPath();
error TokenInMismatch(address expected, address pathTokenIn);
error ZeroAddress();
error Reentrancy();
error RouterNotAllowed(address router);
error NoRoutersProvided();

/// @title SniperSearcher
/// @notice Owner-scoped exact-input executor for MEV / flash-loan callers, supporting two
///         Uniswap-V3-family router ABI shapes (SwapRouter02-style and older ISwapRouter-style).
/// @dev Allowed executors (e.g. FlashLoanReceiver) pull tokenIn via transferFrom, swap on
///      an allowlisted router (using the ABI shape recorded for that router), then receive
///      tokenOut back for Aave repay or profit.
contract SniperSearcher is Multicallable {
    /// @dev Uni V3 single-hop path = token(20) + fee(3) + token(20) = 43 bytes.
    uint256 private constant MIN_PATH_LENGTH = 43;
    /// @dev Default max age for executeSwap when caller omits an explicit deadline.
    uint256 private constant DEFAULT_DEADLINE_SECONDS = 120;

    /// @param router Router contract address.
    /// @param legacyAbi True = older ISwapRouter (5-field ExactInputParams, deadline inside).
    ///        False = SwapRouter02-style (4-field, no deadline field).
    struct RouterConfig {
        address router;
        bool legacyAbi;
    }

    address public owner;
    uint256 public immutable chainId;

    mapping(address executor => bool allowed) public allowedExecutors;
    mapping(address router => bool allowed) public allowedRouters;
    mapping(address router => bool legacy) public routerIsLegacyAbi;

    /// @notice Min bit-length of amountIn (0 = disabled). Immutable dust short-circuit.
    uint256 public immutable minAmountBitLength;

    /// @dev Transient reentrancy lock (Cancun/Osaka tstore).
    bool transient locked;

    event Swap(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ExecutorAllowed(address indexed executor);
    event ExecutorRevoked(address indexed executor);
    event RouterAllowed(address indexed router, bool legacyAbi);
    event RouterRevoked(address indexed router);

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyOwnerOrAllowedExecutor() {
        if (msg.sender != owner && !allowedExecutors[msg.sender]) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (locked) revert Reentrancy();
        locked = true;
        _;
        locked = false;
    }

    constructor(RouterConfig[] memory initialRouters, uint256 _minAmountBitLength) {
        if (initialRouters.length == 0) revert NoRoutersProvided();
        owner = msg.sender;
        for (uint256 i = 0; i < initialRouters.length; ++i) {
            address r = initialRouters[i].router;
            if (r == address(0)) revert ZeroAddress();
            allowedRouters[r] = true;
            routerIsLegacyAbi[r] = initialRouters[i].legacyAbi;
            emit RouterAllowed(r, initialRouters[i].legacyAbi);
        }
        minAmountBitLength = _minAmountBitLength;
        uint256 id;
        assembly {
            id := chainid()
        }
        chainId = id;
    }

    function allowExecutor(address executor) external onlyOwner {
        if (executor == address(0)) revert ZeroAddress();
        allowedExecutors[executor] = true;
        emit ExecutorAllowed(executor);
    }

    function revokeExecutor(address executor) external onlyOwner {
        allowedExecutors[executor] = false;
        emit ExecutorRevoked(executor);
    }

    function allowRouter(address router, bool legacyAbi) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        allowedRouters[router] = true;
        routerIsLegacyAbi[router] = legacyAbi;
        emit RouterAllowed(router, legacyAbi);
    }

    function revokeRouter(address router) external onlyOwner {
        allowedRouters[router] = false;
        emit RouterRevoked(router);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }

    /// @notice Exact-input swap with default deadline (now + 120s).
    function executeSwap(address tokenIn, address router, uint256 amountIn, bytes calldata path, uint256 minAmountOut)
        external
        onlyOwnerOrAllowedExecutor
        nonReentrant
        returns (uint256 amountOut)
    {
        amountOut =
            _executeSwap(tokenIn, router, amountIn, path, minAmountOut, block.timestamp + DEFAULT_DEADLINE_SECONDS);
    }

    /// @notice Exact-input swap with explicit deadline.
    function executeSwapWithDeadline(
        address tokenIn,
        address router,
        uint256 amountIn,
        bytes calldata path,
        uint256 minAmountOut,
        uint256 deadline
    ) external onlyOwnerOrAllowedExecutor nonReentrant returns (uint256 amountOut) {
        amountOut = _executeSwap(tokenIn, router, amountIn, path, minAmountOut, deadline);
    }

    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) amount = IERC20(token).balanceOf(address(this));
        SafeTransferLib.safeTransfer(token, to, amount);
        emit Withdrawn(token, to, amount);
    }

    function withdrawAll(address[] calldata tokens, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        for (uint256 i = 0; i < tokens.length; ++i) {
            uint256 balance = IERC20(tokens[i]).balanceOf(address(this));
            if (balance > 0) {
                SafeTransferLib.safeTransfer(tokens[i], to, balance);
                emit Withdrawn(tokens[i], to, balance);
            }
        }
    }

    function getBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    function withdrawETH(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) amount = address(this).balance;
        SafeTransferLib.safeTransferETH(to, amount);
    }

    function emergencyWithdrawToken(address token, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            SafeTransferLib.safeTransfer(token, to, balance);
            emit Withdrawn(token, to, balance);
        }
    }

    function emergencyWithdrawETH(address payable to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = address(this).balance;
        if (balance > 0) {
            SafeTransferLib.safeTransferETH(to, balance);
        }
    }

    receive() external payable {}

    function _executeSwap(
        address tokenIn,
        address router,
        uint256 amountIn,
        bytes calldata path,
        uint256 minAmountOut,
        uint256 deadline
    ) internal returns (uint256 amountOut) {
        if (!allowedRouters[router]) revert RouterNotAllowed(router);
        if (block.timestamp > deadline) revert DeadlineExceeded();
        _checkMinAmount(amountIn);
        _validatePath(tokenIn, path);

        SafeTransferLib.safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);
        SafeTransferLib.safeApproveWithRetry(tokenIn, router, amountIn);

        if (routerIsLegacyAbi[router]) {
            try ILegacySwapRouter(router).exactInput(
                ILegacySwapRouter.ExactInputParams({
                    path: path,
                    recipient: address(this),
                    deadline: deadline,
                    amountIn: amountIn,
                    amountOutMinimum: minAmountOut
                })
            ) returns (uint256 out) {
                amountOut = out;
            } catch {
                revert SwapFailed();
            }
        } else {
            try IUniswapV3Router02(router).exactInput(
                IUniswapV3Router02.ExactInputParams({
                    path: path,
                    recipient: address(this),
                    amountIn: amountIn,
                    amountOutMinimum: minAmountOut
                })
            ) returns (uint256 out) {
                amountOut = out;
            } catch {
                revert SwapFailed();
            }
        }

        SafeTransferLib.safeApprove(tokenIn, router, 0);

        if (amountOut < minAmountOut) {
            revert InsufficientAmountOut(amountOut, minAmountOut);
        }

        address tokenOut = _getTokenOut(path);
        SafeTransferLib.safeTransfer(tokenOut, msg.sender, amountOut);

        emit Swap(tokenIn, tokenOut, amountIn, amountOut);
    }

    /// @dev path = tokenIn(20) | fee(3) | ... | tokenOut(20); min one hop = 43 bytes.
    function _validatePath(address tokenIn, bytes calldata path) internal pure {
        if (path.length < MIN_PATH_LENGTH) revert InvalidPath();
        if ((path.length - 20) % 23 != 0) revert InvalidPath();
        address pathTokenIn = address(bytes20(path[0:20]));
        if (pathTokenIn != tokenIn) revert TokenInMismatch(tokenIn, pathTokenIn);
    }

    function _getTokenOut(bytes calldata path) internal pure returns (address) {
        return address(bytes20(path[path.length - 20:]));
    }

    function _checkMinAmount(uint256 amountIn) internal view {
        uint256 minBits = minAmountBitLength;
        if (minBits != 0 && MegaMEVOptimizationLib.bitLength(amountIn) < minBits) {
            revert AmountTooSmall(amountIn, minBits);
        }
    }
}
