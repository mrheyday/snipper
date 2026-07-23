// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {Multicallable} from "solady/utils/Multicallable.sol";
import {MegaMEVOptimizationLib} from "./MegaMEVOptimizationLib.sol";

/// @dev Minimal ERC20 surface for rescue balance queries.
interface IERC20Like {
    function balanceOf(address account) external view returns (uint256);
}

/// @dev Uniswap-V3-style SwapRouter02 exactInput — struct form, NO per-call deadline.
///      Selector: exactInput((bytes,address,uint256,uint256)) = 0xb858183f
///      Deadlines are enforced in this contract (see DeadlineExceeded checks).
interface IUniswapV3Router02 {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

error SwapFailed();
error TransferFailed();
error DeadlineExceeded();
error AmountTooSmall(uint256 amountIn, uint256 minBitLength);
error InvalidPath();
error TokenInMismatch(address expected, address pathTokenIn);
error CallbackDisabled();
error ZeroAddress();
error RouterNotAllowed(address router);
error NoRoutersProvided();

/// @title DelegatedExecutor
/// @notice Contract for EIP-7702 EOA delegation
/// @dev Allows EOA to execute swaps without pre-deployment via account code delegation
contract DelegatedExecutor is Multicallable {
    // Reentrancy guard using transient storage (0.8.28+)
    bytes32 private transient locked;

    // Access control: mapping of allowed EOAs
    mapping(address eoa => bool allowed) public allowedEOAs;
    mapping(address router => bool allowed) public allowedRouters;
    address public owner;

    /// @notice Minimum bit-length (via the native CLZ opcode) an `amountIn` must have to
    ///         proceed to the swap. 0 disables the check. Set once at deployment (immutable,
    ///         not owner-settable) to keep deployed bytecode small.
    uint256 public immutable minAmountBitLength;

    event Swap(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);
    event Delegated(address indexed eoa, bytes32 nonce);
    event EOAAllowed(address indexed eoa);
    event EOARevoked(address indexed eoa);
    event RouterAllowed(address indexed router);
    event RouterRevoked(address indexed router);

    // Reentrancy guard modifier using transient storage
    modifier nonReentrant() {
        require(locked == bytes32(0), "Reentrancy detected");
        locked = bytes32(uint256(1));
        _;
        locked = bytes32(0);
    }

    // Access control modifier.
    // Under EIP-7702 the EOA calls *itself* (address(this) == msg.sender) with
    // delegated code; that self-call is always authorized. Pre-deployed use still
    // requires the caller to be on the allow-list.
    modifier onlyAllowedEOA() {
        require(
            msg.sender == address(this) || allowedEOAs[msg.sender],
            "EOA not authorized"
        );
        _;
    }

    /// @dev Pull `amount` of `token` into this account when needed.
    ///      Under EIP-7702 self-execution, tokens already sit on the EOA so the
    ///      transferFrom is skipped (and would fail without a self-allowance).
    function _pullIn(address token, uint256 amount) internal {
        if (msg.sender == address(this)) {
            // Tokens are already on the delegated EOA; nothing to pull.
            return;
        }
        SafeTransferLib.safeTransferFrom(token, msg.sender, address(this), amount);
    }

    /// @dev Recipient for swap outputs: keep funds on the account executing the
    ///      code (EOA under 7702, or this contract when called externally).
    function _recipient() internal view returns (address) {
        return address(this);
    }

    // Owner control modifier
    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    constructor(address[] memory initialRouters, uint256 _minAmountBitLength) {
        if (initialRouters.length == 0) revert NoRoutersProvided();
        owner = msg.sender;
        allowedEOAs[msg.sender] = true;
        for (uint256 i = 0; i < initialRouters.length; ++i) {
            if (initialRouters[i] == address(0)) revert ZeroAddress();
            allowedRouters[initialRouters[i]] = true;
            emit RouterAllowed(initialRouters[i]);
        }
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

    /// @notice Allow a router to be used as the swap venue
    function allowRouter(address router) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        allowedRouters[router] = true;
        emit RouterAllowed(router);
    }

    /// @notice Revoke a router
    function revokeRouter(address router) external onlyOwner {
        allowedRouters[router] = false;
        emit RouterRevoked(router);
    }

    /// @notice Execute swap via EIP-7702 delegation
    /// @dev Called when EOA code points to this contract (via SetCode tx)
    /// @param tokenIn Input token
    /// @param router Allowlisted Uniswap-V3-style router to swap against
    /// @param amountIn Input amount
    /// @param path Encoded swap path
    /// @param minAmountOut Minimum output
    /// @param deadline Tx deadline
    function executeSwap(
        address tokenIn,
        address router,
        uint256 amountIn,
        bytes calldata path,
        uint256 minAmountOut,
        uint256 deadline
    ) external nonReentrant onlyAllowedEOA returns (uint256 amountOut) {
        if (!allowedRouters[router]) revert RouterNotAllowed(router);
        if (block.timestamp > deadline) revert DeadlineExceeded();
        _checkMinAmount(amountIn);
        _validatePath(tokenIn, path);

        // Under EIP-7702, tokens already sit on the EOA (address(this)); externally
        // they are pulled from msg.sender into this contract first.
        _pullIn(tokenIn, amountIn);

        SafeTransferLib.safeApproveWithRetry(tokenIn, router, amountIn);

        // SwapRouter02 struct exactInput (0xb858183f) — recipient is this account under 7702.
        try IUniswapV3Router02(router).exactInput(
            IUniswapV3Router02.ExactInputParams({
                path: path,
                recipient: _recipient(),
                amountIn: amountIn,
                amountOutMinimum: minAmountOut
            })
        ) returns (uint256 out) {
            amountOut = out;
        } catch {
            revert SwapFailed();
        }

        SafeTransferLib.safeApprove(tokenIn, router, 0);

        // Under 7702 funds stay on the EOA; external allowlisted callers get tokenOut back.
        address tokenOut = _getTokenOut(path);
        if (msg.sender != address(this)) {
            SafeTransferLib.safeTransfer(tokenOut, msg.sender, amountOut);
        }

        emit Swap(tokenIn, tokenOut, amountIn, amountOut);
    }

    /// @notice Multi-hop swap with callback support
    /// @dev Advanced execution for complex paths
    /// @dev Callbacks are restricted to whitelisted functions for security
    function executeSwapWithCallback(
        address tokenIn,
        address router,
        uint256 amountIn,
        bytes calldata path,
        uint256 minAmountOut,
        uint256 deadline,
        bytes calldata callbackData
    ) external nonReentrant onlyAllowedEOA returns (uint256 amountOut) {
        if (!allowedRouters[router]) revert RouterNotAllowed(router);
        if (block.timestamp > deadline) revert DeadlineExceeded();
        _checkMinAmount(amountIn);
        _validatePath(tokenIn, path);
        // Callback path disabled until an explicit selector allowlist is productized.
        if (callbackData.length > 0) revert CallbackDisabled();

        _pullIn(tokenIn, amountIn);
        SafeTransferLib.safeApproveWithRetry(tokenIn, router, amountIn);

        try IUniswapV3Router02(router).exactInput(
            IUniswapV3Router02.ExactInputParams({
                path: path,
                recipient: _recipient(),
                amountIn: amountIn,
                amountOutMinimum: minAmountOut
            })
        ) returns (uint256 out) {
            amountOut = out;
        } catch {
            revert SwapFailed();
        }

        SafeTransferLib.safeApprove(tokenIn, router, 0);

        // Output already on this account under 7702; when called externally, forward it.
        address tokenOut = _getTokenOut(path);
        if (msg.sender != address(this)) {
            SafeTransferLib.safeTransfer(tokenOut, msg.sender, amountOut);
        }

        emit Swap(tokenIn, tokenOut, amountIn, amountOut);
    }

    /// @notice Batch execute multiple swaps atomically, all against the same router
    /// @dev All swaps execute in order; if one fails, entire transaction reverts
    struct SwapRequest {
        address tokenIn;
        uint256 amountIn;
        bytes path;
        uint256 minAmountOut;
    }

    function executeBatchSwaps(SwapRequest[] calldata swaps, address router, uint256 deadline)
        external
        nonReentrant
        onlyAllowedEOA
        returns (uint256[] memory amountsOut)
    {
        if (!allowedRouters[router]) revert RouterNotAllowed(router);
        if (block.timestamp > deadline) revert DeadlineExceeded();

        amountsOut = new uint256[](swaps.length);

        for (uint256 i = 0; i < swaps.length; ++i) {
            SwapRequest calldata swap = swaps[i];
            _checkMinAmount(swap.amountIn);
            _validatePath(swap.tokenIn, swap.path);

            _pullIn(swap.tokenIn, swap.amountIn);
            SafeTransferLib.safeApproveWithRetry(swap.tokenIn, router, swap.amountIn);

            try IUniswapV3Router02(router).exactInput(
                IUniswapV3Router02.ExactInputParams({
                    path: swap.path,
                    recipient: _recipient(),
                    amountIn: swap.amountIn,
                    amountOutMinimum: swap.minAmountOut
                })
            ) returns (uint256 out) {
                amountsOut[i] = out;
            } catch {
                revert SwapFailed();
            }

            SafeTransferLib.safeApprove(swap.tokenIn, router, 0);

            address tokenOut = _getTokenOut(swap.path);
            if (msg.sender != address(this)) {
                SafeTransferLib.safeTransfer(tokenOut, msg.sender, amountsOut[i]);
            }

            emit Swap(swap.tokenIn, tokenOut, swap.amountIn, amountsOut[i]);
        }
    }

    /// @notice Owner rescue for ERC20 stuck on the *implementation* (not 7702 EOA storage).
    /// @dev Under EIP-7702, `owner` lives in the EOA's storage slot and is typically unset
    ///      (zero); rescue is intended for the pre-deployed contract address only.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) amount = IERC20Like(token).balanceOf(address(this));
        SafeTransferLib.safeTransfer(token, to, amount);
    }

    /// @notice Owner rescue for ETH stuck on the implementation.
    function rescueETH(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) amount = address(this).balance;
        SafeTransferLib.safeTransferETH(to, amount);
    }

    /// @notice Receive tokens (for fallback swaps)
    receive() external payable {}

    /// @dev Uni V3 path = tokenIn(20) | fee(3) | ... | tokenOut(20); min one hop = 43 bytes.
    function _validatePath(address tokenIn, bytes calldata path) internal pure {
        if (path.length < 43) revert InvalidPath();
        if ((path.length - 20) % 23 != 0) revert InvalidPath();
        address pathTokenIn = address(bytes20(path[0:20]));
        if (pathTokenIn != tokenIn) revert TokenInMismatch(tokenIn, pathTokenIn);
    }

    /// @dev Internal: extract output token from Uniswap V3 path
    function _getTokenOut(bytes calldata path) internal pure returns (address) {
        if (path.length < 20) revert InvalidPath();
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
