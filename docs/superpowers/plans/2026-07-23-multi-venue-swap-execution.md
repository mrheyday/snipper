# Multi-Venue Swap Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `SniperSearcher`, `FlashLoanReceiver`, and `DelegatedExecutor` execute swaps against an owner-managed allowlist of routers (Uniswap V3, SushiSwap V3, PancakeSwap V3) instead of one hardcoded router each, and make `FlashSizer`'s existing multi-venue quote search the single source of truth for which venue actually executes.

**Architecture:** Replace each contract's `immutable`/`constant` router with an `allowedRouters` mapping + `allowRouter`/`revokeRouter` (mirrors the existing `allowedExecutors` pattern). Thread a `router` parameter through every off-chain call site down to the contract call. Widen `EXECUTION_VENUE_PROTOCOLS` to the 3 verified venues and make `FlashSizer` pick both loan size and execution route in one search, replacing the separately-built (and Uniswap-only) path `main.ts` currently constructs.

**Tech Stack:** Solidity 0.8.36 / Foundry (contracts), TypeScript / ethers v6 (bot).

## Global Constraints

- Verified addresses (see spec `docs/superpowers/specs/2026-07-23-multi-venue-swap-execution-design.md`, "Address verification" section) — use these exact values, nowhere else:
  - Uniswap V3: router `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`, factory `0x1F98431c8aD98523631AE4a59f267346ea31F984`, quoter `0x61fFE014bA17989E743c5F6cB21bF9697530B21e`
  - SushiSwap V3: router `0x8A21F6768C1f8075791D08546Dadf6daA0bE820c`, factory `0x1af415a1EbA07a4986a52B6f2e7dE7003D82231e`, quoter `0x0524E833cCD057e4d7A296e3aaAb9f7675964Ce1`
  - PancakeSwap V3: router `0x32226588378236Fd0c7c4053999F88aC0e5cAc77`, factory `0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865`, quoter `0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997`
- Camelot V3 and Ramses are NOT execution venues in this plan (see spec "Deferred") — do not add them to `EXECUTION_VENUE_PROTOCOLS` or any contract allowlist.
- `router` is always added as the 2nd parameter (right after `tokenIn`/`token`/`asset`) in every function signature touched — keep this position consistent across all contracts and off-chain call sites.
- `npm test` (→ `cd contracts && forge test`) must pass after every contract task. There is no TypeScript test framework in this repo — do not add one.
- Never broadcast a deployment or run any `--broadcast` / mainnet-writing command. This plan ends at a fork dry-run (Task 10); actual mainnet redeploy is a separate, manual, human-driven step outside this plan.

---

### Task 1: SniperSearcher.sol — router allowlist

**Files:**
- Modify: `contracts/src/SniperSearcher.sol`
- Modify: `contracts/test/SniperSearcher.t.sol`

**Interfaces:**
- Produces: `SniperSearcher.executeSwap(address tokenIn, address router, uint256 amountIn, bytes calldata path, uint256 minAmountOut)`, `executeSwapWithDeadline(address tokenIn, address router, uint256 amountIn, bytes calldata path, uint256 minAmountOut, uint256 deadline)`, `allowRouter(address)`, `revokeRouter(address)`, `allowedRouters(address) view returns (bool)`, constructor `SniperSearcher(address[] memory initialRouters, uint256 minAmountBitLength)`. New errors `RouterNotAllowed(address)`, `NoRoutersProvided()`. New events `RouterAllowed(address indexed)`, `RouterRevoked(address indexed)`. `swapRouter` immutable is REMOVED — later tasks must not reference it.

- [ ] **Step 1: Replace `contracts/src/SniperSearcher.sol` with the full updated contract**

```solidity
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
error DeadlineExceeded();
error AmountTooSmall(uint256 amountIn, uint256 minBitLength);
error InvalidPath();
error TokenInMismatch(address expected, address pathTokenIn);
error ZeroAddress();
error Reentrancy();
error RouterNotAllowed(address router);
error NoRoutersProvided();

/// @title SniperSearcher
/// @notice Owner-scoped Uniswap-V3-style exact-input executor for MEV / flash-loan callers.
/// @dev Allowed executors (e.g. FlashLoanReceiver) pull tokenIn via transferFrom, swap on
///      an allowlisted router, then receive tokenOut back for Aave repay or profit.
contract SniperSearcher is Multicallable {
    /// @dev Uni V3 single-hop path = token(20) + fee(3) + token(20) = 43 bytes.
    uint256 private constant MIN_PATH_LENGTH = 43;
    /// @dev Default max age for executeSwap when caller omits an explicit deadline.
    uint256 private constant DEFAULT_DEADLINE_SECONDS = 120;

    address public owner;
    uint256 public immutable chainId;

    mapping(address executor => bool allowed) public allowedExecutors;
    mapping(address router => bool allowed) public allowedRouters;

    /// @notice Min bit-length of amountIn (0 = disabled). Immutable dust short-circuit.
    uint256 public immutable minAmountBitLength;

    /// @dev Transient reentrancy lock (Cancun/Osaka tstore).
    bool transient locked;

    event Swap(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ExecutorAllowed(address indexed executor);
    event ExecutorRevoked(address indexed executor);
    event RouterAllowed(address indexed router);
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

    constructor(address[] memory initialRouters, uint256 _minAmountBitLength) {
        if (initialRouters.length == 0) revert NoRoutersProvided();
        owner = msg.sender;
        for (uint256 i = 0; i < initialRouters.length; ++i) {
            if (initialRouters[i] == address(0)) revert ZeroAddress();
            allowedRouters[initialRouters[i]] = true;
            emit RouterAllowed(initialRouters[i]);
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

    function allowRouter(address router) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        allowedRouters[router] = true;
        emit RouterAllowed(router);
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
```

- [ ] **Step 2: Replace `contracts/test/SniperSearcher.t.sol` with the full updated test file**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {Test} from "forge-std/Test.sol";
import {SniperSearcher} from "../src/SniperSearcher.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @dev SwapRouter02-shaped mock: pulls tokenIn, mints amountIn of tokenOut to recipient.
contract MockRouter02 {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut) {
        require(params.path.length >= 43, "path");
        address tokenIn = address(bytes20(params.path[0:20]));
        address tokenOut = address(bytes20(params.path[params.path.length - 20:]));
        require(ERC20Mock(tokenIn).transferFrom(msg.sender, address(this), params.amountIn), "in");
        amountOut = params.amountIn;
        require(amountOut >= params.amountOutMinimum, "min");
        ERC20Mock(tokenOut).mint(params.recipient, amountOut);
    }
}

contract SniperSearcherTest is Test {
    SniperSearcher public searcher;
    MockRouter02 public router;
    MockRouter02 public router2;
    ERC20Mock public tokenA;
    ERC20Mock public tokenB;
    address public owner;
    address public user;
    address public executor;

    error Unauthorized();
    error SwapFailed();
    error DeadlineExceeded();
    error InvalidPath();
    error TokenInMismatch(address expected, address pathTokenIn);
    error ZeroAddress();
    error AmountTooSmall(uint256 amountIn, uint256 minBitLength);
    error RouterNotAllowed(address router);
    error NoRoutersProvided();

    event Swap(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event RouterAllowed(address indexed router);
    event RouterRevoked(address indexed router);

    function setUp() public {
        owner = makeAddr("owner");
        user = makeAddr("user");
        executor = makeAddr("executor");

        router = new MockRouter02();
        router2 = new MockRouter02();
        address[] memory routers = new address[](1);
        routers[0] = address(router);
        vm.prank(owner);
        searcher = new SniperSearcher(routers, 0);

        tokenA = new ERC20Mock("Token A", "TKNA", 18);
        tokenB = new ERC20Mock("Token B", "TKNB", 18);

        tokenA.mint(owner, 1000e18);
        tokenA.mint(user, 1000e18);
        tokenA.mint(executor, 1000e18);
    }

    function _pathAB() internal view returns (bytes memory) {
        return abi.encodePacked(address(tokenA), uint24(3000), address(tokenB));
    }

    function test_Deployment() public view {
        assertEq(searcher.owner(), owner);
        assertTrue(searcher.allowedRouters(address(router)));
        assertEq(searcher.chainId(), block.chainid);
    }

    function test_RevertWhen_ZeroRouterInInitialList() public {
        address[] memory routers = new address[](1);
        routers[0] = address(0);
        vm.expectRevert(ZeroAddress.selector);
        new SniperSearcher(routers, 0);
    }

    function test_RevertWhen_NoRoutersProvided() public {
        address[] memory routers = new address[](0);
        vm.expectRevert(NoRoutersProvided.selector);
        new SniperSearcher(routers, 0);
    }

    function test_RevertWhen_UnauthorizedCaller() public {
        bytes memory path = _pathAB();
        vm.prank(user);
        vm.expectRevert(Unauthorized.selector);
        searcher.executeSwap(address(tokenA), address(router), 100e18, path, 0);
    }

    function test_ExecuteSwap_Success_ReturnsOutToCaller() public {
        bytes memory path = _pathAB();
        uint256 amountIn = 100e18;

        vm.startPrank(owner);
        tokenA.approve(address(searcher), amountIn);
        uint256 out = searcher.executeSwap(address(tokenA), address(router), amountIn, path, amountIn);
        vm.stopPrank();

        assertEq(out, amountIn);
        assertEq(tokenB.balanceOf(owner), amountIn);
        assertEq(tokenB.balanceOf(address(searcher)), 0);
        assertEq(tokenA.allowance(address(searcher), address(router)), 0);
    }

    function test_RevertWhen_RouterNotAllowed() public {
        bytes memory path = _pathAB();
        uint256 amountIn = 100e18;

        vm.startPrank(owner);
        tokenA.approve(address(searcher), amountIn);
        vm.expectRevert(abi.encodeWithSelector(RouterNotAllowed.selector, address(router2)));
        searcher.executeSwap(address(tokenA), address(router2), amountIn, path, 0);
        vm.stopPrank();
    }

    function test_AllowRouter_ThenSwapSucceeds() public {
        bytes memory path = _pathAB();
        uint256 amountIn = 100e18;

        vm.prank(owner);
        vm.expectEmit(true, false, false, false);
        emit RouterAllowed(address(router2));
        searcher.allowRouter(address(router2));

        vm.startPrank(owner);
        tokenA.approve(address(searcher), amountIn);
        uint256 out = searcher.executeSwap(address(tokenA), address(router2), amountIn, path, amountIn);
        vm.stopPrank();

        assertEq(out, amountIn);
        assertEq(tokenB.balanceOf(owner), amountIn);
    }

    function test_RevokeRouter_ThenSwapReverts() public {
        vm.prank(owner);
        vm.expectEmit(true, false, false, false);
        emit RouterRevoked(address(router));
        searcher.revokeRouter(address(router));

        bytes memory path = _pathAB();
        vm.startPrank(owner);
        tokenA.approve(address(searcher), 100e18);
        vm.expectRevert(abi.encodeWithSelector(RouterNotAllowed.selector, address(router)));
        searcher.executeSwap(address(tokenA), address(router), 100e18, path, 0);
        vm.stopPrank();
    }

    function test_RevertWhen_AllowRouter_NotOwner() public {
        vm.prank(user);
        vm.expectRevert(Unauthorized.selector);
        searcher.allowRouter(address(router2));
    }

    function test_AllowedExecutor_CanSwapAndReceivesOut() public {
        bytes memory path = _pathAB();
        uint256 amountIn = 50e18;

        vm.prank(owner);
        searcher.allowExecutor(executor);

        vm.startPrank(executor);
        tokenA.approve(address(searcher), amountIn);
        uint256 out = searcher.executeSwap(address(tokenA), address(router), amountIn, path, 0);
        vm.stopPrank();

        assertEq(out, amountIn);
        assertEq(tokenB.balanceOf(executor), amountIn);
    }

    function test_RevertWhen_PathTooShort() public {
        vm.startPrank(owner);
        tokenA.approve(address(searcher), 100e18);
        vm.expectRevert(InvalidPath.selector);
        searcher.executeSwap(address(tokenA), address(router), 100e18, abi.encodePacked(address(tokenA)), 0);
        vm.stopPrank();
    }

    function test_RevertWhen_TokenInMismatch() public {
        bytes memory path = _pathAB();
        vm.startPrank(owner);
        tokenA.approve(address(searcher), 100e18);
        vm.expectRevert(abi.encodeWithSelector(TokenInMismatch.selector, address(tokenB), address(tokenA)));
        searcher.executeSwap(address(tokenB), address(router), 100e18, path, 0);
        vm.stopPrank();
    }

    function test_RevertWhen_DeadlineExceeded() public {
        bytes memory path = _pathAB();
        vm.startPrank(owner);
        tokenA.approve(address(searcher), 100e18);
        vm.expectRevert(DeadlineExceeded.selector);
        searcher.executeSwapWithDeadline(address(tokenA), address(router), 100e18, path, 0, block.timestamp - 1);
        vm.stopPrank();
    }

    function test_ExecuteSwapWithDeadline_Success() public {
        bytes memory path = _pathAB();
        uint256 amountIn = 100e18;

        vm.startPrank(owner);
        tokenA.approve(address(searcher), amountIn);
        uint256 out = searcher.executeSwapWithDeadline(
            address(tokenA), address(router), amountIn, path, amountIn, block.timestamp + 60
        );
        vm.stopPrank();

        assertEq(out, amountIn);
    }

    function test_TransferOwnership() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        vm.expectEmit(true, true, false, false);
        emit OwnershipTransferred(owner, newOwner);
        searcher.transferOwnership(newOwner);
        assertEq(searcher.owner(), newOwner);
    }

    function test_RevertWhen_TransferOwnershipZero() public {
        vm.prank(owner);
        vm.expectRevert(ZeroAddress.selector);
        searcher.transferOwnership(address(0));
    }

    function test_Withdraw() public {
        tokenB.mint(address(searcher), 50e18);
        address to = makeAddr("to");
        vm.prank(owner);
        searcher.withdraw(address(tokenB), to, 0);
        assertEq(tokenB.balanceOf(to), 50e18);
    }

    function test_WithdrawAll() public {
        tokenA.mint(address(searcher), 10e18);
        tokenB.mint(address(searcher), 20e18);
        address to = makeAddr("to");
        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        vm.prank(owner);
        searcher.withdrawAll(tokens, to);
        assertEq(tokenA.balanceOf(to), 10e18);
        assertEq(tokenB.balanceOf(to), 20e18);
    }

    function test_GetBalance() public {
        tokenA.mint(address(searcher), 5e18);
        assertEq(searcher.getBalance(address(tokenA)), 5e18);
    }

    function test_ReceiveETH() public {
        (bool success,) = payable(address(searcher)).call{value: 1 ether}("");
        require(success);
        assertEq(address(searcher).balance, 1 ether);
    }

    function test_Fuzz_WithdrawAmount(uint256 amount) public {
        amount = bound(amount, 1, 1_000_000e18);
        tokenA.mint(address(searcher), amount);
        address to = makeAddr("to");
        vm.prank(owner);
        searcher.withdraw(address(tokenA), to, amount);
        assertEq(tokenA.balanceOf(to), amount);
    }

    function test_MinAmountBitLength_DisabledByDefault() public view {
        assertEq(searcher.minAmountBitLength(), 0);
    }

    function test_MinAmountBitLength_RevertsOnDustBeforeAnyExternalCall() public {
        address[] memory routers = new address[](1);
        routers[0] = address(router);
        vm.prank(owner);
        SniperSearcher strict = new SniperSearcher(routers, 32);

        bytes memory path = _pathAB();
        vm.startPrank(owner);
        tokenA.approve(address(strict), 1);
        vm.expectRevert(abi.encodeWithSelector(AmountTooSmall.selector, uint256(1), uint256(32)));
        strict.executeSwap(address(tokenA), address(router), 1, path, 0);
        vm.stopPrank();
    }

    function test_MinAmountBitLength_GasSavedOnRejectedDust() public {
        address[] memory routers = new address[](1);
        routers[0] = address(router);
        vm.prank(owner);
        SniperSearcher strict = new SniperSearcher(routers, 32);

        bytes memory path = _pathAB();
        vm.startPrank(owner);
        tokenA.approve(address(strict), 1);
        uint256 gasBefore = gasleft();
        try strict.executeSwap(address(tokenA), address(router), 1, path, 0) {
            revert("expected revert");
        } catch {
            uint256 gasUsed = gasBefore - gasleft();
            assertLt(gasUsed, 50_000);
        }
        vm.stopPrank();
    }

    function test_Multicall_BatchesOwnerCallsWithCorrectSender() public {
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(SniperSearcher.allowExecutor, (executor));
        calls[1] = abi.encodeCall(SniperSearcher.allowRouter, (address(router2)));
        vm.prank(owner);
        searcher.multicall(calls);
        assertTrue(searcher.allowedExecutors(executor));
        assertTrue(searcher.allowedRouters(address(router2)));
    }

    function test_Multicall_RevertsForNonOwner() public {
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(SniperSearcher.allowExecutor, (executor));
        vm.prank(user);
        vm.expectRevert(Unauthorized.selector);
        searcher.multicall(calls);
    }

    function test_RevokeExecutor() public {
        vm.startPrank(owner);
        searcher.allowExecutor(executor);
        assertTrue(searcher.allowedExecutors(executor));
        searcher.revokeExecutor(executor);
        assertFalse(searcher.allowedExecutors(executor));
        vm.stopPrank();
    }
}
```

- [ ] **Step 3: Run the SniperSearcher test suite**

Run: `cd contracts && forge test --match-contract SniperSearcherTest -vv`
Expected: all tests PASS (constructor now takes `address[]`; every `executeSwap`/`executeSwapWithDeadline` call site in the test file already includes the `router` argument above).

- [ ] **Step 4: Commit**

```bash
git add contracts/src/SniperSearcher.sol contracts/test/SniperSearcher.t.sol
git commit -m "feat: router allowlist on SniperSearcher, replacing immutable swapRouter"
```

---

### Task 2: FlashLoanReceiver.sol — thread router through the flash-loan callback

**Files:**
- Modify: `contracts/src/FlashLoanReceiver.sol`
- Modify: `contracts/test/FlashLoanReceiver.t.sol`

**Interfaces:**
- Consumes: `SniperSearcher.executeSwap(address tokenIn, address router, uint256 amountIn, bytes calldata path, uint256 minAmountOut)` from Task 1 — `ISwapExecutor` in this file must match that exact signature.
- Produces: `FlashLoanReceiver.initiateFlashLoan(address token, address router, uint256 amount, bytes calldata swapPath, uint256 minAmountOut)`. `swapExecutor` immutable is unchanged (still points at one SniperSearcher).

- [ ] **Step 1: Replace `contracts/src/FlashLoanReceiver.sol` with the full updated contract**

```solidity
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
    function executeSwap(address tokenIn, address router, uint256 amountIn, bytes calldata path, uint256 minAmountOut)
        external
        returns (uint256);
}

error Unauthorized();
error FlashLoanFailed();
error InsufficientRepayment(uint256 available, uint256 required);
error PathMustEndInBorrowAsset(address pathEnd, address borrowAsset);
error InvalidSwapPath();
error MinAmountOutTooLow(uint256 minAmountOut, uint256 minRepay);
error ZeroAddress();
error Reentrancy();

/// @title FlashLoanReceiver
/// @notice Aave V3 flashLoanSimple receiver for single-block arbitrage on Arbitrum.
/// @dev Conforms to IFlashLoanSimpleReceiver. Flow (one tx / one block):
///      1. owner (or type-4 delegated EOA owner) calls initiateFlashLoan(token, router, ...)
///      2. Pool transfers `amount` here, then calls executeOperation
///      3. We approve SniperSearcher, swap via the caller-selected router (path MUST end in
///         `asset` for repay), approve Pool for amount+premium; Pool pulls on return
///      4. Leftover `asset` is profit — withdraw promptly (griefing risk if parked)
contract FlashLoanReceiver {
    address public owner;
    address public immutable swapExecutor;
    address public immutable lendingPool;

    /// @dev Off-chain / UI hint only. Live fee is Pool.FLASHLOAN_PREMIUM_TOTAL() (bps).
    ///      Repay always uses the `premium` argument from the Pool callback — never this.
    ///      Arbitrum mainnet read 2026-07-23: 5 bps. Was historically 9 bps at V3 launch.
    uint256 public constant FLASH_LOAN_PREMIUM_RATE_BPS_HINT = 5;

    bool transient locked;

    event FlashLoanExecuted(address indexed token, uint256 amount, uint256 premium, uint256 profit);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (locked) revert Reentrancy();
        locked = true;
        _;
        locked = false;
    }

    constructor(address _swapExecutor, address _lendingPool) {
        if (_swapExecutor == address(0) || _lendingPool == address(0)) revert ZeroAddress();
        owner = msg.sender;
        swapExecutor = _swapExecutor;
        lendingPool = _lendingPool;
    }

    /// @notice Transfer ownership (two-step not required for hot MEV ops; still explicit).
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }

    /// @notice Live premium bps from the configured Aave Pool (governance-updatable).
    function flashLoanPremiumBps() external view returns (uint256) {
        return uint256(IPool(lendingPool).FLASHLOAN_PREMIUM_TOTAL());
    }

    /// @notice Initiate flashLoanSimple with this contract as receiver (docs path 3).
    /// @param token Reserve asset to borrow (must have borrowing enabled)
    /// @param router Uniswap-V3-style router SniperSearcher should swap against (must be
    ///        on SniperSearcher's allowedRouters)
    /// @param amount Amount to borrow
    /// @param swapPath Uniswap V3 path; final token MUST equal `token` (round-trip)
    /// @param minAmountOut Minimum final amountOut of the borrow asset
    function initiateFlashLoan(
        address token,
        address router,
        uint256 amount,
        bytes calldata swapPath,
        uint256 minAmountOut
    ) external onlyOwner nonReentrant {
        // Min 2 hops (66 bytes): token|fee|mid|fee|token — single hop cannot repay flash.
        if (swapPath.length < 66 || (swapPath.length - 20) % 23 != 0) revert InvalidSwapPath();
        address pathEnd = address(bytes20(swapPath[swapPath.length - 20:]));
        if (pathEnd != token) revert PathMustEndInBorrowAsset(pathEnd, token);

        // Reject loans that cannot repay even in the best case (uses live premium bps).
        uint256 premiumBps = uint256(IPool(lendingPool).FLASHLOAN_PREMIUM_TOTAL());
        uint256 minRepay = amount + (amount * premiumBps) / 10_000;
        if (minAmountOut < minRepay) revert MinAmountOutTooLow(minAmountOut, minRepay);

        bytes memory params = abi.encode(token, router, swapPath, minAmountOut);
        // receiverAddress = address(this): same-contract path from Aave docs
        IPool(lendingPool).flashLoanSimple(address(this), token, amount, params, 0);
    }

    /// @notice Aave V3 Pool callback after funds are transferred in.
    /// @dev Must approve Pool for amount+premium before returning true. Do not transfer.
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        nonReentrant
        returns (bool)
    {
        if (msg.sender != lendingPool) revert Unauthorized();
        // Only loans we initiated (prevents third-party griefing via forced callback)
        require(initiator == address(this), "Initiator mismatch");

        (, address router, bytes memory swapPath, uint256 minAmountOut) =
            abi.decode(params, (address, address, bytes, uint256));

        // Defense-in-depth: re-validate path in callback (not only at initiate).
        // swapPath is memory (from abi.decode) so slice via assembly, not calldata range.
        if (swapPath.length < 66 || (swapPath.length - 20) % 23 != 0) revert InvalidSwapPath();
        address pathEnd;
        /// @solidity memory-safe-assembly
        assembly {
            pathEnd := shr(96, mload(add(add(swapPath, 0x20), sub(mload(swapPath), 20))))
        }
        if (pathEnd != asset) revert PathMustEndInBorrowAsset(pathEnd, asset);

        // SniperSearcher pulls via transferFrom(msg.sender=this)
        SafeTransferLib.safeApproveWithRetry(asset, swapExecutor, amount);

        // Path must return the borrow asset (round-trip arb). Output is transferred
        // back to this contract by SniperSearcher (allowed-executor path).
        ISwapExecutor(swapExecutor).executeSwap(asset, router, amount, swapPath, minAmountOut);

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
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) amount = IERC20(token).balanceOf(address(this));
        SafeTransferLib.safeTransfer(token, to, amount);
    }

    /// @notice Withdraw ETH from contract
    /// @param to Recipient address
    /// @param amount Amount to withdraw (0 = all)
    function withdrawETH(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) amount = address(this).balance;
        SafeTransferLib.safeTransferETH(to, amount);
    }

    /// @notice Emergency recovery for stuck tokens
    /// @param token Token to recover
    /// @param to Recipient address
    function emergencyWithdrawToken(address token, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            SafeTransferLib.safeTransfer(token, to, balance);
        }
    }

    /// @notice Emergency recovery for stuck ETH (alias for withdrawETH)
    /// @param to Recipient address
    function emergencyWithdrawETH(address payable to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
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
```

- [ ] **Step 2: Replace `contracts/test/FlashLoanReceiver.t.sol` with the full updated test file**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {Test} from "forge-std/Test.sol";
import {SniperSearcher} from "../src/SniperSearcher.sol";
import {FlashLoanReceiver} from "../src/FlashLoanReceiver.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @dev Minimal Uniswap V3 SwapRouter02 mock matching IUniswapV3Router02 struct ABI.
///      Supports single- and multi-hop paths; mints path-end token 1:1 for amountIn.
contract MockRouter02 {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut) {
        require(params.path.length >= 43, "bad path");
        address tokenIn = address(bytes20(params.path[0:20]));
        address tokenOut = address(bytes20(params.path[params.path.length - 20:]));
        // Pull input from caller (SniperSearcher)
        require(ERC20Mock(tokenIn).transferFrom(msg.sender, address(this), params.amountIn), "in");
        amountOut = params.amountIn; // 1:1 mock (round-trip arb with zero edge)
        require(amountOut >= params.amountOutMinimum, "min");
        ERC20Mock(tokenOut).mint(params.recipient, amountOut);
    }
}

/// @notice FlashLoanReceiver + SniperSearcher approval/allowlist/repay path.
contract FlashLoanReceiverTest is Test {
    SniperSearcher public searcher;
    FlashLoanReceiver public flash;
    MockRouter02 public router;
    ERC20Mock public tokenA;
    ERC20Mock public tokenB;

    address public owner;
    address public pool; // simulated Aave pool = this test by default

    function setUp() public {
        owner = address(this);
        pool = address(this);

        router = new MockRouter02();
        address[] memory routers = new address[](1);
        routers[0] = address(router);
        searcher = new SniperSearcher(routers, 0);
        flash = new FlashLoanReceiver(address(searcher), pool);

        // Deploy must whitelist FlashLoanReceiver (matches Deploy.s.sol step 5)
        searcher.allowExecutor(address(flash));

        tokenA = new ERC20Mock("A", "A", 18);
        tokenB = new ERC20Mock("B", "B", 18);
    }

    /// Round-trip A -> B -> A (two hops, 66 bytes) so path ends in borrow asset.
    function _pathABA() internal view returns (bytes memory) {
        return abi.encodePacked(address(tokenA), uint24(3000), address(tokenB), uint24(3000), address(tokenA));
    }

    /// @dev Round-trip flash: borrow A, swap A->B->A via searcher, approve Aave for repay.
    function test_ExecuteOperation_ApprovesExecutorAndReturnsOutToFlash() public {
        uint256 amount = 100e18;
        uint256 premium = amount * 5 / 10_000; // 0.05% (live Arbitrum FLASHLOAN_PREMIUM_TOTAL)
        bytes memory path = _pathABA();
        // minOut must cover amount+premium for real initiates; mock returns 1:1 so
        // we mint extra A for the premium after the swap returns amount of A.
        uint256 minOut = amount;

        // Simulate Aave transferring flash-borrowed A to receiver.
        tokenA.mint(address(flash), amount);

        bytes memory params = abi.encode(address(tokenA), address(router), path, minOut);

        // Mock returns amount of A (1:1). Mint premium so amount+premium is available.
        tokenA.mint(address(flash), premium);

        bool ok = flash.executeOperation(address(tokenA), amount, premium, address(flash), params);
        assertTrue(ok);

        // Searcher should not retain output (returned to flash).
        assertEq(tokenA.balanceOf(address(searcher)), 0);
        // Flash holds borrowed+minted output for repay (amount from swap + premium minted).
        assertGe(tokenA.balanceOf(address(flash)), amount + premium);
        // Allowance to searcher cleared after swap.
        assertEq(tokenA.allowance(address(flash), address(searcher)), 0);
        // Aave was approved for amount+premium (standing until Aave pulls).
        assertEq(tokenA.allowance(address(flash), pool), amount + premium);
    }

    function test_ExecuteOperation_RevertsWhenExecutorNotAllowed() public {
        // Fresh searcher without allowExecutor
        address[] memory routers = new address[](1);
        routers[0] = address(router);
        SniperSearcher locked = new SniperSearcher(routers, 0);
        FlashLoanReceiver orphan = new FlashLoanReceiver(address(locked), pool);

        uint256 amount = 100e18;
        tokenA.mint(address(orphan), amount);
        bytes memory params = abi.encode(address(tokenA), address(router), _pathABA(), amount);

        vm.expectRevert(); // Unauthorized from SniperSearcher
        orphan.executeOperation(address(tokenA), amount, 0, address(orphan), params);
    }

    function test_ExecuteOperation_RevertsWithoutAssetApprovalPath() public {
        // If searcher is allowed but flash has zero balance, transferFrom fails.
        uint256 amount = 100e18;
        // no mint to flash
        bytes memory params = abi.encode(address(tokenA), address(router), _pathABA(), amount);
        vm.expectRevert();
        flash.executeOperation(address(tokenA), amount, 0, address(flash), params);
    }

    function test_InitiateFlashLoan_RevertsWhenMinOutBelowRepay() public {
        // Pool is address(this) and has no FLASHLOAN_PREMIUM_TOTAL — use vm.mockCall.
        vm.mockCall(
            pool,
            abi.encodeWithSignature("FLASHLOAN_PREMIUM_TOTAL()"),
            abi.encode(uint128(5))
        );
        uint256 amount = 100e18;
        // minRepay = amount + amount*5/10000 = 100.05e18; pass lower minOut
        vm.expectRevert();
        flash.initiateFlashLoan(address(tokenA), address(router), amount, _pathABA(), amount);
    }

    function test_AllowExecutor_DeployWiresFlash() public view {
        assertTrue(searcher.allowedExecutors(address(flash)));
    }

    // Aave pool entrypoint unused in unit tests (we call executeOperation directly),
    // but provide so `pool == address(this)` looks like a realistic peer.
    function flashLoanSimple(address, address, uint256, bytes calldata, uint16) external pure {}

    function FLASHLOAN_PREMIUM_TOTAL() external pure returns (uint128) {
        return 5;
    }
}
```

- [ ] **Step 3: Run the FlashLoanReceiver test suite**

Run: `cd contracts && forge test --match-contract FlashLoanReceiverTest -vv`
Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add contracts/src/FlashLoanReceiver.sol contracts/test/FlashLoanReceiver.t.sol
git commit -m "feat: thread router selection through FlashLoanReceiver's Aave callback"
```

---

### Task 3: DelegatedExecutor.sol — router allowlist on the dormant EIP-7702 path

**Files:**
- Modify: `contracts/src/DelegatedExecutor.sol`
- Modify: `contracts/test/DelegatedExecutor.t.sol`

**Interfaces:**
- Produces: `DelegatedExecutor.executeSwap(address tokenIn, address router, uint256 amountIn, bytes calldata path, uint256 minAmountOut, uint256 deadline)`, `executeSwapWithCallback(address tokenIn, address router, uint256 amountIn, bytes calldata path, uint256 minAmountOut, uint256 deadline, bytes calldata callbackData)`, `executeBatchSwaps(SwapRequest[] calldata swaps, address router, uint256 deadline)`, `allowRouter(address)`, `revokeRouter(address)`, `allowedRouters(address) view returns (bool)`, constructor `DelegatedExecutor(address[] memory initialRouters, uint256 minAmountBitLength)`. `SWAP_ROUTER` constant is REMOVED.

- [ ] **Step 1: Replace `contracts/src/DelegatedExecutor.sol` with the full updated contract**

```solidity
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
```

- [ ] **Step 2: Replace `contracts/test/DelegatedExecutor.t.sol` with the full updated test file**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {Test, console} from "forge-std/Test.sol";
import {DelegatedExecutor} from "../src/DelegatedExecutor.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @dev SwapRouter02-shaped mock: pulls tokenIn, mints amountIn of tokenOut to recipient.
contract MockRouter02 {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut) {
        require(params.path.length >= 43, "path");
        address tokenIn = address(bytes20(params.path[0:20]));
        address tokenOut = address(bytes20(params.path[params.path.length - 20:]));
        require(ERC20Mock(tokenIn).transferFrom(msg.sender, address(this), params.amountIn), "in");
        amountOut = params.amountIn;
        require(amountOut >= params.amountOutMinimum, "min");
        ERC20Mock(tokenOut).mint(params.recipient, amountOut);
    }
}

contract DelegatedExecutorTest is Test {
    DelegatedExecutor public executor;
    MockRouter02 public router;
    MockRouter02 public router2;
    ERC20Mock public tokenA;
    ERC20Mock public tokenB;
    address public user;

    error DeadlineExceeded();
    error SwapFailed();
    error InvalidPath();
    error CallbackDisabled();
    error RouterNotAllowed(address router);
    error NoRoutersProvided();
    error ZeroAddress();

    event Swap(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);
    event RouterAllowed(address indexed router);
    event RouterRevoked(address indexed router);

    function setUp() public {
        router = new MockRouter02();
        router2 = new MockRouter02();
        address[] memory routers = new address[](1);
        routers[0] = address(router);
        executor = new DelegatedExecutor(routers, 0);
        tokenA = new ERC20Mock("Token A", "TKNA", 18);
        tokenB = new ERC20Mock("Token B", "TKNB", 6);

        user = makeAddr("user");
        tokenA.mint(user, 1000e18);
        tokenB.mint(address(this), 10000e6);
    }

    function test_RevertWhen_NoRoutersProvided() public {
        address[] memory routers = new address[](0);
        vm.expectRevert(NoRoutersProvided.selector);
        new DelegatedExecutor(routers, 0);
    }

    function test_ExecuteSwap_Success() public {
        uint256 amountIn = 100e18;
        bytes memory path = abi.encodePacked(address(tokenA), uint24(3000), address(tokenB));
        uint256 deadline = block.timestamp + 300;

        tokenA.mint(user, amountIn);
        executor.allowEOA(user);

        vm.startPrank(user);
        tokenA.approve(address(executor), amountIn);
        uint256 amountOut = executor.executeSwap(address(tokenA), address(router), amountIn, path, 0, deadline);
        vm.stopPrank();

        assertEq(amountOut, amountIn);
        assertEq(tokenB.balanceOf(user), amountIn);
    }

    function test_RevertWhen_RouterNotAllowed() public {
        uint256 amountIn = 100e18;
        bytes memory path = abi.encodePacked(address(tokenA), uint24(3000), address(tokenB));
        executor.allowEOA(user);

        vm.startPrank(user);
        tokenA.approve(address(executor), amountIn);
        vm.expectRevert(abi.encodeWithSelector(RouterNotAllowed.selector, address(router2)));
        executor.executeSwap(address(tokenA), address(router2), amountIn, path, 0, block.timestamp + 300);
        vm.stopPrank();
    }

    function test_AllowRouter_ThenSwapSucceeds() public {
        vm.expectEmit(true, false, false, false);
        emit RouterAllowed(address(router2));
        executor.allowRouter(address(router2));

        uint256 amountIn = 100e18;
        bytes memory path = abi.encodePacked(address(tokenA), uint24(3000), address(tokenB));
        executor.allowEOA(user);

        vm.startPrank(user);
        tokenA.approve(address(executor), amountIn);
        uint256 amountOut = executor.executeSwap(address(tokenA), address(router2), amountIn, path, 0, block.timestamp + 300);
        vm.stopPrank();

        assertEq(amountOut, amountIn);
    }

    function test_RevokeRouter_ThenSwapReverts() public {
        vm.expectEmit(true, false, false, false);
        emit RouterRevoked(address(router));
        executor.revokeRouter(address(router));

        uint256 amountIn = 100e18;
        bytes memory path = abi.encodePacked(address(tokenA), uint24(3000), address(tokenB));
        executor.allowEOA(user);

        vm.startPrank(user);
        tokenA.approve(address(executor), amountIn);
        vm.expectRevert(abi.encodeWithSelector(RouterNotAllowed.selector, address(router)));
        executor.executeSwap(address(tokenA), address(router), amountIn, path, 0, block.timestamp + 300);
        vm.stopPrank();
    }

    function test_RevertWhen_DeadlineExceeded() public {
        uint256 amountIn = 100e18;
        bytes memory path = abi.encodePacked(address(tokenA), uint24(3000), address(tokenB));
        uint256 deadline = block.timestamp - 1; // Expired

        tokenA.mint(user, amountIn);
        executor.allowEOA(user);

        vm.startPrank(user);
        tokenA.approve(address(executor), amountIn);
        vm.expectRevert(DeadlineExceeded.selector);
        executor.executeSwap(address(tokenA), address(router), amountIn, path, 0, deadline);
        vm.stopPrank();
    }

    function test_Fuzz_DeadlineValidation(uint256 futureTime) public {
        futureTime = bound(futureTime, block.timestamp + 1, block.timestamp + 10000);
        uint256 amountIn = 100e18;
        bytes memory path = abi.encodePacked(address(tokenA), uint24(3000), address(tokenB));

        tokenA.mint(user, amountIn);
        executor.allowEOA(user);

        vm.startPrank(user);
        tokenA.approve(address(executor), amountIn);
        uint256 amountOut = executor.executeSwap(address(tokenA), address(router), amountIn, path, 0, futureTime);
        vm.stopPrank();

        assertEq(amountOut, amountIn);
    }

    function test_RevertWhen_InvalidPath() public {
        executor.allowEOA(user);
        bytes memory bad = abi.encodePacked(address(tokenA));
        vm.prank(user);
        vm.expectRevert(InvalidPath.selector);
        executor.executeSwap(address(tokenA), address(router), 1e18, bad, 0, block.timestamp + 60);
    }

    function test_RevertWhen_CallbackDisabled() public {
        executor.allowEOA(user);
        bytes memory path = abi.encodePacked(address(tokenA), uint24(3000), address(tokenB));
        bytes memory cb = hex"deadbeef";
        vm.prank(user);
        tokenA.approve(address(executor), 1e18);
        vm.prank(user);
        vm.expectRevert(CallbackDisabled.selector);
        executor.executeSwapWithCallback(address(tokenA), address(router), 1e18, path, 0, block.timestamp + 60, cb);
    }

    function test_ReceiveETH() public {
        uint256 amount = 1 ether;
        (bool success,) = payable(address(executor)).call{value: amount}("");
        require(success);
        assertEq(address(executor).balance, amount);
    }
}
```

- [ ] **Step 3: Run the DelegatedExecutor test suite**

Run: `cd contracts && forge test --match-contract DelegatedExecutorTest -vv`
Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add contracts/src/DelegatedExecutor.sol contracts/test/DelegatedExecutor.t.sol
git commit -m "feat: router allowlist on DelegatedExecutor (dormant EIP-7702 path)"
```

---

### Task 4: DeployRegistry.sol + Deploy.s.sol + Configure.s.sol + Verify.s.sol — multi-router constructor args and wiring checks

**Files:**
- Modify: `contracts/src/DeployRegistry.sol`
- Modify: `contracts/script/Deploy.s.sol`
- Modify: `contracts/script/Configure.s.sol`
- Modify: `contracts/script/Verify.s.sol`

**Interfaces:**
- Consumes: `SniperSearcher(address[] memory initialRouters, uint256 minAmountBitLength)` and `DelegatedExecutor(address[] memory initialRouters, uint256 minAmountBitLength)` from Tasks 1 and 3. `SniperSearcher.allowedRouters(address) view returns (bool)`, `allowRouter(address)` from Task 1. `DelegatedExecutor.allowedRouters(address) view returns (bool)`, `allowRouter(address)` from Task 3.
- Produces: `DeployRegistry.sniperInitialRouters() returns (address[] memory)` — the verified 3-address list, reused by both `sniperConstructorArgs()` and `delegatedConstructorArgs()`.

- [ ] **Step 1: In `contracts/src/DeployRegistry.sol`, add the verified router constants and an initial-routers helper**

Add these three constants right after the existing `SWAP_ROUTER` constant (which stays — it's still the Uniswap V3 router and other code may reference it):

```solidity
    /// @dev SushiSwap V3 SwapRouter (Arbitrum One). Verified on-chain 2026-07-23: its own
    ///      factory() call returns SWAP_ROUTER_SUSHISWAP_FACTORY; address matches
    ///      sushiswap/v3-periphery's checked-in deployments/arbitrum/SwapRouter.json.
    address internal constant SWAP_ROUTER_SUSHISWAP = 0x8A21F6768C1f8075791D08546Dadf6daA0bE820c;

    /// @dev SushiSwap V3 Factory (Arbitrum One).
    address internal constant SWAP_ROUTER_SUSHISWAP_FACTORY = 0x1af415a1EbA07a4986a52B6f2e7dE7003D82231e;

    /// @dev PancakeSwap V3 SmartRouter (Arbitrum One). Source:
    ///      developer.pancakeswap.finance/contracts/v3/addresses. Verified on-chain 2026-07-23
    ///      by probing exactInput(...) directly (reverted with Uniswap periphery's own "STF"
    ///      transfer-failure string) and by its factory() matching PANCAKE_V3_FACTORY.
    address internal constant SWAP_ROUTER_PANCAKESWAP = 0x32226588378236Fd0c7c4053999F88aC0e5cAc77;

    /// @dev PancakeSwap V3 Factory (Arbitrum One).
    address internal constant PANCAKE_V3_FACTORY = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;
```

Then add a helper function (place it near `sniperConstructorArgs()`):

```solidity
    /// @dev Verified execution-venue routers: Uniswap V3, SushiSwap V3, PancakeSwap V3.
    ///      Ramses and Camelot V3 are explicitly excluded — see the design spec's
    ///      "Address verification" / "Deferred" sections for why. Shared by both
    ///      SniperSearcher and DelegatedExecutor's constructors.
    function sniperInitialRouters() internal pure returns (address[] memory routers) {
        routers = new address[](3);
        routers[0] = SWAP_ROUTER; // Uniswap V3
        routers[1] = SWAP_ROUTER_SUSHISWAP;
        routers[2] = SWAP_ROUTER_PANCAKESWAP;
    }
```

- [ ] **Step 2: In `contracts/src/DeployRegistry.sol`, update the constructor-arg helper functions**

Replace:

```solidity
    /// @dev SniperSearcher(swapRouter, minAmountBitLength)
    function sniperConstructorArgs() internal pure returns (address swapRouter, uint256 minBits) {
        return (SWAP_ROUTER, MIN_AMOUNT_BIT_LENGTH);
    }
```

with:

```solidity
    /// @dev SniperSearcher(initialRouters, minAmountBitLength)
    function sniperConstructorArgs() internal pure returns (address[] memory routers, uint256 minBits) {
        return (sniperInitialRouters(), MIN_AMOUNT_BIT_LENGTH);
    }
```

Replace:

```solidity
    /// @dev DelegatedExecutor(minAmountBitLength)
    function delegatedConstructorArgs() internal pure returns (uint256 minBits) {
        return MIN_AMOUNT_BIT_LENGTH;
    }
```

with:

```solidity
    /// @dev DelegatedExecutor(initialRouters, minAmountBitLength)
    function delegatedConstructorArgs() internal pure returns (address[] memory routers, uint256 minBits) {
        return (sniperInitialRouters(), MIN_AMOUNT_BIT_LENGTH);
    }
```

Replace:

```solidity
    /// @dev ABI-encoded constructor args for forge verify / explorers.
    function sniperConstructorArgsEncoded() internal pure returns (bytes memory) {
        return abi.encode(SWAP_ROUTER, MIN_AMOUNT_BIT_LENGTH);
    }
```

with:

```solidity
    /// @dev ABI-encoded constructor args for forge verify / explorers.
    function sniperConstructorArgsEncoded() internal pure returns (bytes memory) {
        return abi.encode(sniperInitialRouters(), MIN_AMOUNT_BIT_LENGTH);
    }
```

Replace:

```solidity
    function delegatedConstructorArgsEncoded() internal pure returns (bytes memory) {
        return abi.encode(MIN_AMOUNT_BIT_LENGTH);
    }
```

with:

```solidity
    function delegatedConstructorArgsEncoded() internal pure returns (bytes memory) {
        return abi.encode(sniperInitialRouters(), MIN_AMOUNT_BIT_LENGTH);
    }
```

- [ ] **Step 3: Update `contracts/script/Deploy.s.sol`**

Replace:

```solidity
        (address swapRouter, uint256 minAmountBitLength) = DeployRegistry.sniperConstructorArgs();
```

with:

```solidity
        (address[] memory routers, uint256 minAmountBitLength) = DeployRegistry.sniperConstructorArgs();
```

Replace:

```solidity
        console.log("  SwapRouter:", swapRouter);
```

with a loop (place it directly below the existing `console.log("  Deployer:", deployer);` line, before the `console.log("  Aave Pool:", aavePool);` line):

```solidity
        for (uint256 i = 0; i < routers.length; ++i) {
            console.log("  Router[%s]:", i, routers[i]);
        }
```

(remove the old single-line `console.log("  SwapRouter:", swapRouter);`)

Replace:

```solidity
        SniperSearcher sniperSearcher = new SniperSearcher(swapRouter, minAmountBitLength);
```

with:

```solidity
        SniperSearcher sniperSearcher = new SniperSearcher(routers, minAmountBitLength);
```

Replace:

```solidity
        DelegatedExecutor delegatedExecutor = new DelegatedExecutor(minAmountBitLength);
```

with:

```solidity
        (address[] memory delegatedRouters, uint256 delegatedMinBits) = DeployRegistry.delegatedConstructorArgs();
        DelegatedExecutor delegatedExecutor = new DelegatedExecutor(delegatedRouters, delegatedMinBits);
```

Replace the summary section's:

```solidity
        console.log("Configuration:");
        console.log("  SwapRouter:             ", swapRouter);
```

with:

```solidity
        console.log("Configuration:");
        for (uint256 i = 0; i < routers.length; ++i) {
            console.log("  Router[%s]:             ", i, routers[i]);
        }
```

Replace:

```solidity
        console.log("EIP-7702 roles:");
        console.log("  DelegatedExecutor       = single-target Uniswap swaps (hardcoded router)");
```

with:

```solidity
        console.log("EIP-7702 roles:");
        console.log("  DelegatedExecutor       = single-target swaps via allowlisted router");
```

Replace:

```solidity
        console.log("  SniperSearcher approves Uniswap SwapRouter02 per-swap then revokes");
```

with:

```solidity
        console.log("  SniperSearcher approves the caller-selected allowlisted router per-swap then revokes");
```

Update the `DeploymentAddresses` struct field `swapRouter` (singular `address`) — since there are now 3 routers, remove that field from the struct (it is only used for logging inside `_saveDeploymentAddresses`, which is already a no-op — `addresses;` — so removing the field is safe):

```solidity
    struct DeploymentAddresses {
        address sniperSearcher;
        address flashLoanReceiver;
        address delegatedExecutor;
        address basicEoaBatchExecutor;
        address aavePool;
    }
```

and update the `_saveDeploymentAddresses(...)` call site to drop the `swapRouter: swapRouter,` line.

- [ ] **Step 4: Update `contracts/script/Configure.s.sol`**

Replace:

```solidity
        require(ss.swapRouter() == DeployRegistry.SWAP_ROUTER, "Sniper: swapRouter mismatch");
```

with a loop that checks every expected router is allowlisted:

```solidity
        address[] memory expectedRouters = DeployRegistry.sniperInitialRouters();
        for (uint256 i = 0; i < expectedRouters.length; ++i) {
            require(ss.allowedRouters(expectedRouters[i]), "Sniper: expected router not allowlisted");
        }
```

Replace the following log line:

```solidity
        console.log("  SniperSearcher.swapRouter         =", ss.swapRouter());
```

with:

```solidity
        for (uint256 i = 0; i < expectedRouters.length; ++i) {
            console.log("  SniperSearcher.allowedRouters[%s]  =", i, expectedRouters[i]);
        }
```

In the "[3] Permissions" section, add a check + wiring step for `DelegatedExecutor`'s routers alongside the existing `flashAllowed`/`ownerAllowedEoa` checks. Replace:

```solidity
        console.log("[3] Permissions");
        bool flashAllowed = ss.allowedExecutors(flash);
        bool ownerAllowedEoa = de.allowedEOAs(owner);
        console.log("  allowedExecutors(Flash) =", flashAllowed);
        console.log("  allowedEOAs(owner)      =", ownerAllowedEoa);

        if (flashAllowed && ownerAllowedEoa) {
            console.log("  [OK] no on-chain writes needed");
        } else if (!broadcast) {
            console.log("  [SKIP] would configure; set PRIVATE_KEY and --broadcast to apply");
            if (!flashAllowed) {
                console.log("    missing: SniperSearcher.allowExecutor(FlashLoanReceiver)");
            }
            if (!ownerAllowedEoa) {
                console.log("    missing: DelegatedExecutor.allowEOA(owner)");
            }
        } else {
            require(vm.addr(pk) == owner, "PRIVATE_KEY is not contract owner");
            vm.startBroadcast(pk);
            if (!flashAllowed) {
                console.log("  -> allowExecutor(Flash)");
                ss.allowExecutor(flash);
            }
            if (!ownerAllowedEoa) {
                console.log("  -> allowEOA(owner)");
                de.allowEOA(owner);
            }
            vm.stopBroadcast();
            console.log("  allowedExecutors(Flash) =", ss.allowedExecutors(flash));
            console.log("  allowedEOAs(owner)      =", de.allowedEOAs(owner));
            require(ss.allowedExecutors(flash), "allowExecutor failed");
            require(de.allowedEOAs(owner), "allowEOA failed");
            console.log("  [OK] permissions configured");
        }
```

with:

```solidity
        console.log("[3] Permissions");
        bool flashAllowed = ss.allowedExecutors(flash);
        bool ownerAllowedEoa = de.allowedEOAs(owner);
        console.log("  allowedExecutors(Flash) =", flashAllowed);
        console.log("  allowedEOAs(owner)      =", ownerAllowedEoa);

        bool[] memory delegatedRouterMissing = new bool[](expectedRouters.length);
        bool anyDelegatedRouterMissing = false;
        for (uint256 i = 0; i < expectedRouters.length; ++i) {
            bool allowed = de.allowedRouters(expectedRouters[i]);
            delegatedRouterMissing[i] = !allowed;
            if (!allowed) anyDelegatedRouterMissing = true;
            console.log("  DelegatedExecutor.allowedRouters[%s] =", i, allowed);
        }

        if (flashAllowed && ownerAllowedEoa && !anyDelegatedRouterMissing) {
            console.log("  [OK] no on-chain writes needed");
        } else if (!broadcast) {
            console.log("  [SKIP] would configure; set PRIVATE_KEY and --broadcast to apply");
            if (!flashAllowed) {
                console.log("    missing: SniperSearcher.allowExecutor(FlashLoanReceiver)");
            }
            if (!ownerAllowedEoa) {
                console.log("    missing: DelegatedExecutor.allowEOA(owner)");
            }
            for (uint256 i = 0; i < expectedRouters.length; ++i) {
                if (delegatedRouterMissing[i]) {
                    console.log("    missing: DelegatedExecutor.allowRouter(...)", expectedRouters[i]);
                }
            }
        } else {
            require(vm.addr(pk) == owner, "PRIVATE_KEY is not contract owner");
            vm.startBroadcast(pk);
            if (!flashAllowed) {
                console.log("  -> allowExecutor(Flash)");
                ss.allowExecutor(flash);
            }
            if (!ownerAllowedEoa) {
                console.log("  -> allowEOA(owner)");
                de.allowEOA(owner);
            }
            for (uint256 i = 0; i < expectedRouters.length; ++i) {
                if (delegatedRouterMissing[i]) {
                    console.log("  -> DelegatedExecutor.allowRouter(...)", expectedRouters[i]);
                    de.allowRouter(expectedRouters[i]);
                }
            }
            vm.stopBroadcast();
            console.log("  allowedExecutors(Flash) =", ss.allowedExecutors(flash));
            console.log("  allowedEOAs(owner)      =", de.allowedEOAs(owner));
            require(ss.allowedExecutors(flash), "allowExecutor failed");
            require(de.allowedEOAs(owner), "allowEOA failed");
            for (uint256 i = 0; i < expectedRouters.length; ++i) {
                require(de.allowedRouters(expectedRouters[i]), "DelegatedExecutor allowRouter failed");
            }
            console.log("  [OK] permissions configured");
        }
```

- [ ] **Step 5: Update `contracts/script/Verify.s.sol`**

Replace:

```solidity
        require(ss.swapRouter() == DeployRegistry.SWAP_ROUTER, "SniperSearcher: bad swapRouter");
```

with:

```solidity
        address[] memory expectedRouters = DeployRegistry.sniperInitialRouters();
        for (uint256 i = 0; i < expectedRouters.length; ++i) {
            require(ss.allowedRouters(expectedRouters[i]), "SniperSearcher: expected router not allowlisted");
        }
```

Replace:

```solidity
        console.log("       swapRouter=", ss.swapRouter());
```

with:

```solidity
        for (uint256 i = 0; i < expectedRouters.length; ++i) {
            console.log("       allowedRouters[%s]=", i, expectedRouters[i]);
        }
```

- [ ] **Step 6: Compile and confirm no leftover references to the removed fields**

Run: `cd contracts && forge build`
Expected: builds cleanly. If it fails referencing `swapRouter()` or `SWAP_ROUTER` in a place not covered above, grep for it and fix — every remaining reference to `ss.swapRouter()` must be replaced by an `allowedRouters(...)` check.

Run: `grep -rn "\.swapRouter()" contracts/script contracts/test 2>/dev/null`
Expected: no output (every call site was updated in Tasks 1-4).

- [ ] **Step 7: Commit**

```bash
git add contracts/src/DeployRegistry.sol contracts/script/Deploy.s.sol contracts/script/Configure.s.sol contracts/script/Verify.s.sol
git commit -m "feat: multi-router constructor args and wiring checks in deploy scripts"
```

---

### Task 5: Regenerate `src/contractABIs.ts` from the updated contracts

**Files:**
- Modify: `src/contractABIs.ts` (generated — do not hand-edit)

**Interfaces:**
- Consumes: the compiled `contracts/out/SniperSearcher.sol/SniperSearcher.json`, `contracts/out/FlashLoanReceiver.sol/FlashLoanReceiver.json`, `contracts/out/DelegatedExecutor.sol/DelegatedExecutor.json` artifacts produced by Tasks 1-4.
- Produces: `SNIPER_SEARCHER_ABI`, `FLASH_LOAN_RECEIVER_ABI`, `DELEGATED_EXECUTOR_ABI` reflecting the new `router` parameters — every later off-chain task (6-9) calls contract methods through these ABIs.

- [ ] **Step 1: Run the existing regen script**

Run: `node scripts/regen-abis-and-prod-fixes.mjs`
Expected: prints `wrote contractABIs.ts <byte count>`. This runs `forge build` internally and rewrites `src/contractABIs.ts` from the fresh build artifacts — do not edit that file by hand.

- [ ] **Step 2: Confirm the new ABIs include the `router` parameter**

Run: `grep -n "'router'" src/contractABIs.ts | head -5`
Expected: at least one match (the regenerated `executeSwap`/`executeSwapWithDeadline`/`initiateFlashLoan` entries now list a `router` input).

- [ ] **Step 3: Type-check the project**

Run: `npx tsc --noEmit`
Expected: no new errors introduced by the ABI regeneration itself (errors from Tasks 6-9's call sites not yet updated are expected at this point and will be fixed in those tasks — if this is the first task run in isolation, ignore errors from files this task doesn't touch).

- [ ] **Step 4: Commit**

```bash
git add src/contractABIs.ts
git commit -m "chore: regenerate contractABIs.ts for router-allowlist contracts"
```

---

### Task 6: dexAggregator.ts — verified addresses, 3-venue execution list, factory resolution

**Files:**
- Modify: `src/dexAggregator.ts`

**Interfaces:**
- Produces: `DEXProtocolConfig.factoryAddress: string` (new field on every entry), `EXECUTION_VENUE_PROTOCOLS` now containing Uniswap V3 + SushiSwap V3 + PancakeSwap V3 (was Uniswap V3 only), `resolvePoolAddress(factory: string, tokenA: string, tokenB: string, feeTier: number, provider: Provider): Promise<string>`.
- Consumed by: Task 8 (`flashSizer.ts`'s Bitquery cross-check) uses `factoryAddress` + `resolvePoolAddress`; Task 9's off-chain callers use `EXECUTION_VENUE_PROTOCOLS`.

- [ ] **Step 1: Replace the `ARBITRUM_DEX_PROTOCOLS` array and `DEXProtocolConfig` interface**

Replace:

```typescript
export interface DEXProtocolConfig {
  name: string;
  dexType: DEXType;
  routerAddress: string;
  quoterAddress: string;
  supportedFeeTiers: number[];
}
```

with:

```typescript
export interface DEXProtocolConfig {
  name: string;
  dexType: DEXType;
  routerAddress: string;
  quoterAddress: string;
  /** Uniswap-V3-style factory, used to resolve a pair's pool address for the
   *  Bitquery cross-check (see flashSizer.ts). Not needed for quoting itself —
   *  the Quoter contracts resolve pools internally via their own factory. */
  factoryAddress: string;
  supportedFeeTiers: number[];
}
```

Replace the whole `ARBITRUM_DEX_PROTOCOLS` array:

```typescript
export const ARBITRUM_DEX_PROTOCOLS: DEXProtocolConfig[] = [
  {
    name: 'Uniswap V3',
    dexType: DEXType.UNISWAP_V3,
    routerAddress: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoterAddress: QUOTER_ADDRESS || '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    supportedFeeTiers: [100, 500, 3000, 10000],
  },
  {
    name: 'Camelot V3',
    dexType: DEXType.UNISWAP_V3,
    routerAddress: '0x1f721E29952737f584742468A36dB1B0A6FAaA4e',
    quoterAddress: '0x05b2210874e4c27892b157a92ddf3e5caecbca7a',
    supportedFeeTiers: [100, 500, 3000],
  },
  {
    name: 'Ramses V2',
    dexType: DEXType.UNISWAP_V3,
    routerAddress: '0xAAA8888997e59099A6d43576d313d1000ee72023',
    quoterAddress: '0xAAACa9dFf3F66b1070A647242880b91e9f13e73A',
    supportedFeeTiers: [100, 500, 3000],
  },
  {
    name: 'SushiSwap V3',
    dexType: DEXType.UNISWAP_V3,
    routerAddress: '0x8A21F534350174092bF581A056D43B59a997A811',
    quoterAddress: '0x0d4A22F2d2DDCe8d753c1869E4c1d739B948332C',
    supportedFeeTiers: [100, 500, 3000, 10000],
  },
  {
    name: 'PancakeSwap V3',
    dexType: DEXType.UNISWAP_V3,
    routerAddress: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4',
    quoterAddress: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
    supportedFeeTiers: [100, 500, 3000, 10000],
  },
];

/** Protocols whose router is wired into SniperSearcher / SwapRouter02 execution. */
export const EXECUTION_VENUE_PROTOCOLS: DEXProtocolConfig[] = ARBITRUM_DEX_PROTOCOLS.filter(
  (p) => p.name === 'Uniswap V3'
);
```

with:

```typescript
// Camelot V3 (Algebra engine — dynamic fees, no fee bytes in its path encoding, different
// exactInputSingle call shape) and Ramses (Solidly-family AMM — stable/volatile pool flag,
// different router call shape) are NOT Uniswap-V3-style forks and are deliberately excluded
// from this list, not just from EXECUTION_VENUE_PROTOCOLS: their previous entries pointed at
// addresses with no deployed contract on Arbitrum One, and even correct addresses for them
// would need dedicated adapters, not the exactInput(ExactInputParams) call this file assumes.
// See docs/superpowers/specs/2026-07-23-multi-venue-swap-execution-design.md, "Address
// verification" / "Deferred", for the full verification trail and follow-up scope.
export const ARBITRUM_DEX_PROTOCOLS: DEXProtocolConfig[] = [
  {
    name: 'Uniswap V3',
    dexType: DEXType.UNISWAP_V3,
    routerAddress: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoterAddress: QUOTER_ADDRESS || '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    supportedFeeTiers: [100, 500, 3000, 10000],
  },
  {
    name: 'SushiSwap V3',
    dexType: DEXType.UNISWAP_V3,
    routerAddress: '0x8A21F6768C1f8075791D08546Dadf6daA0bE820c',
    quoterAddress: '0x0524E833cCD057e4d7A296e3aaAb9f7675964Ce1',
    factoryAddress: '0x1af415a1EbA07a4986a52B6f2e7dE7003D82231e',
    supportedFeeTiers: [100, 500, 3000, 10000],
  },
  {
    name: 'PancakeSwap V3',
    dexType: DEXType.UNISWAP_V3,
    routerAddress: '0x32226588378236Fd0c7c4053999F88aC0e5cAc77',
    quoterAddress: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
    factoryAddress: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    supportedFeeTiers: [100, 500, 3000, 10000],
  },
];

/** Protocols whose router is wired into SniperSearcher / SwapRouter02-style execution. */
export const EXECUTION_VENUE_PROTOCOLS: DEXProtocolConfig[] = ARBITRUM_DEX_PROTOCOLS;
```

- [ ] **Step 2: Add a pool-address resolver**

Add this near the bottom of the class (after `getRoundTripQuote`, before `getQuoteForProtocol`, or as a standalone exported function above the class — place it as a standalone exported function so `flashSizer.ts` can import it directly without instantiating `DEXAggregator`):

```typescript
const UNISWAP_V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
];

/**
 * Resolve a Uniswap-V3-style pool address for a token pair + fee tier via the venue's
 * own factory. Used only by the Bitquery cross-check (flashSizer.ts) — quoting itself
 * doesn't need this, the Quoter contracts resolve pools internally.
 */
export async function resolvePoolAddress(
  factoryAddress: string,
  tokenA: string,
  tokenB: string,
  feeTier: number,
  provider: Provider
): Promise<string | null> {
  try {
    const factory = new ethers.Contract(factoryAddress, UNISWAP_V3_FACTORY_ABI, provider);
    const pool: string = await factory.getPool(tokenA, tokenB, feeTier);
    if (!pool || pool === ethers.ZeroAddress) return null;
    return pool;
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors from `dexAggregator.ts` itself. Errors from other files that reference the old `ARBITRUM_DEX_PROTOCOLS` shape (e.g. `flashSizer.ts` before Task 8) are expected and fixed in later tasks.

- [ ] **Step 4: Commit**

```bash
git add src/dexAggregator.ts
git commit -m "fix: replace dead DEX addresses with verified ones, widen execution to 3 venues"
```

---

### Task 7: allowlist.ts — widen the off-chain router allowlist to match the 3 execution venues

**Files:**
- Modify: `src/allowlist.ts`

**Interfaces:**
- Consumes: `ARBITRUM_DEX_PROTOCOLS` from Task 6 (for the 3 verified router addresses).
- Produces: `getAllowedRouters()` / `isRouterAllowed()` now recognize all 3 execution-venue routers, not just `SwapRouter02`.

- [ ] **Step 1: Replace `ALLOWED_ROUTERS_DEFAULT`**

Replace:

```typescript
/** Uniswap V3 SwapRouter02 — only execution venue wired into SniperSearcher. */
export const ALLOWED_ROUTERS_DEFAULT = [
  ARBITRUM_DEPLOY.swapRouter02,
  '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
] as const;
```

with:

```typescript
/** Execution venues wired into SniperSearcher's router allowlist: Uniswap V3, SushiSwap V3,
 *  PancakeSwap V3. Kept as a literal list (not imported from dexAggregator.ts) so this file
 *  has no import-order dependency on it; addresses must stay in sync with
 *  dexAggregator.ts's ARBITRUM_DEX_PROTOCOLS and DeployRegistry.sol's sniperInitialRouters(). */
export const ALLOWED_ROUTERS_DEFAULT = [
  ARBITRUM_DEPLOY.swapRouter02,
  '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', // Uniswap V3
  '0x8A21F6768C1f8075791D08546Dadf6daA0bE820c', // SushiSwap V3
  '0x32226588378236Fd0c7c4053999F88aC0e5cAc77', // PancakeSwap V3
] as const;
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors from `allowlist.ts`.

- [ ] **Step 3: Manual check**

Run: `node -e "const {getAllowedRouters} = require('./dist/allowlist.js'); console.log(getAllowedRouters());"` — if `dist/` isn't built yet, instead run `npx ts-node -e "import('./src/allowlist').then(m => console.log(m.getAllowedRouters()))"`
Expected: prints an array containing (case-normalized) `0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45`, `0x8a21f6768c1f8075791d08546dadf6daa0be820c`, and `0x32226588378236fd0c7c4053999f88ac0e5cac77`.

- [ ] **Step 4: Commit**

```bash
git add src/allowlist.ts
git commit -m "feat: allowlist SushiSwap V3 and PancakeSwap V3 routers off-chain"
```

---

### Task 8: flashSizer.ts — 3-venue sizing, router/feeTier in SizedLoan, Bitquery cross-check

**Files:**
- Modify: `src/flashSizer.ts`

**Interfaces:**
- Consumes: `EXECUTION_VENUE_PROTOCOLS` from Task 6, `resolvePoolAddress` from Task 6, `bitquery.maxInputAtSlippage(pool, tokenIn, targetSlippageBps)` (already exists, unchanged signature).
- Produces: `SizedLoan.router: string`, `SizedLoan.feeTier: number` (new fields) — Task 9's `bridge.ts` reads these to rebuild the execution path.

- [ ] **Step 1: Switch the internal aggregator from `ARBITRUM_DEX_PROTOCOLS` to `EXECUTION_VENUE_PROTOCOLS`**

Replace:

```typescript
import { DEXAggregator, ARBITRUM_DEX_PROTOCOLS } from './dexAggregator';
```

with:

```typescript
import { DEXAggregator, EXECUTION_VENUE_PROTOCOLS, resolvePoolAddress } from './dexAggregator';
```

Replace:

```typescript
    // Use ALL known DEX protocols for quoting — not just Uniswap V3.
    // Execution is still Uniswap V3 only (SniperSearcher hard-wired), but the sizer must be
    // able to see pools on Camelot, Ramses, SushiSwap etc. so that tokens without a Uni V3
    // pool aren't silently abandoned.
    this.dexAggregator = new DEXAggregator(provider, ARBITRUM_DEX_PROTOCOLS);
```

with:

```typescript
    // Scoped to EXECUTION_VENUE_PROTOCOLS (not the wider ARBITRUM_DEX_PROTOCOLS): whatever
    // this search picks as "best" becomes the router/path that actually executes (see
    // bridge.ts), so it must never consider a venue execution can't reach. No real-world
    // regression from this scoping — main.ts's own pre-check already gates on
    // EXECUTION_VENUE_PROTOCOLS before this class ever runs.
    this.dexAggregator = new DEXAggregator(provider, EXECUTION_VENUE_PROTOCOLS);
```

- [ ] **Step 2: Add `router` and `feeTier` to `SizedLoan`**

Replace:

```typescript
export interface SizedLoan {
  /** Final borrow amount (after liquidity + slippage checks) */
  amount: bigint;
  /** Quoted output from DEX at this amount */
  expectedOutput: bigint;
  /** Minimum acceptable output (slippage-protected) */
  minAmountOut: bigint;
  /** Available reserve liquidity at query time */
  availableLiquidity: bigint;
  /** Aave fee for this loan */
  fee: bigint;
  /** Expected net profit (minAmountOut - principal - fee) */
  netProfit: bigint;
  /** Which DEX gave the best route */
  dexName: string;
}
```

with:

```typescript
export interface SizedLoan {
  /** Final borrow amount (after liquidity + slippage checks) */
  amount: bigint;
  /** Quoted output from DEX at this amount */
  expectedOutput: bigint;
  /** Minimum acceptable output (slippage-protected) */
  minAmountOut: bigint;
  /** Available reserve liquidity at query time */
  availableLiquidity: bigint;
  /** Aave fee for this loan */
  fee: bigint;
  /** Expected net profit (minAmountOut - principal - fee) */
  netProfit: bigint;
  /** Which DEX gave the best route */
  dexName: string;
  /** Router address for the winning venue — this IS what executes on-chain (bridge.ts
   *  rebuilds the swap path from this + feeTier rather than reusing any earlier guess). */
  router: string;
  /** Fee tier for the winning venue's round-trip path */
  feeTier: number;
}
```

- [ ] **Step 3: Populate `router`/`feeTier` in `evaluateSize`**

Replace:

```typescript
    return {
      amount,
      expectedOutput,
      minAmountOut,
      availableLiquidity,
      fee,
      netProfit,
      dexName: route.protocol.name,
    };
```

with:

```typescript
    return {
      amount,
      expectedOutput,
      minAmountOut,
      availableLiquidity,
      fee,
      netProfit,
      dexName: route.protocol.name,
      router: route.protocol.routerAddress,
      feeTier: route.feeTier,
    };
```

- [ ] **Step 4: Add the Bitquery cross-check as a final gate in `computeOptimalSize`**

Find the end of `computeOptimalSize`, currently:

```typescript
    // 4. Binary / step search (round-trip quotes)
    const result = await this.binarySearch(tokenIn, midToken, upperBound, availableLiquidity, minLoanWei);

    if (!result) {
      logger.warn(`[FlashSizer] No profitable, slippage-safe size found`);
    } else {
      logger.info(
        `[FlashSizer] ✓ Optimal loan: ` +
          `${ethers.formatUnits(result.amount, decimals)} ` +
          `| fee: ${ethers.formatUnits(result.fee, decimals)} ` +
          `| net profit: ${ethers.formatUnits(result.netProfit, decimals)} ` +
          `| via ${result.dexName}`
      );
    }

    return result;
  }
```

Replace with:

```typescript
    // 4. Binary / step search (round-trip quotes)
    const result = await this.binarySearch(tokenIn, midToken, upperBound, availableLiquidity, minLoanWei);

    if (!result) {
      logger.warn(`[FlashSizer] No profitable, slippage-safe size found`);
      return null;
    }

    logger.info(
      `[FlashSizer] ✓ Optimal loan: ` +
        `${ethers.formatUnits(result.amount, decimals)} ` +
        `| fee: ${ethers.formatUnits(result.fee, decimals)} ` +
        `| net profit: ${ethers.formatUnits(result.netProfit, decimals)} ` +
        `| via ${result.dexName}`
    );

    // 5. Bitquery cross-check on the WINNING venue only (one call, not per search-step —
    //    see the design spec's "Bitquery cross-check" section for why per-step/per-venue
    //    calls would blow through rate limits).
    if (bitquery.configured) {
      const winningProtocol = this.dexAggregator['protocols'].find(
        (p) => p.routerAddress.toLowerCase() === result.router.toLowerCase()
      );
      if (winningProtocol) {
        const winningPool = await resolvePoolAddress(
          winningProtocol.factoryAddress,
          tokenIn,
          midToken,
          result.feeTier,
          provider
        );
        if (winningPool) {
          const bitqueryMax = await bitquery.maxInputAtSlippage(
            winningPool,
            tokenIn,
            this.config.maxSlippageBps
          );
          if (bitqueryMax) {
            let bitqueryCap: bigint;
            try {
              bitqueryCap = bitqueryMax.includes('.')
                ? ethers.parseUnits(bitqueryMax, decimals)
                : BigInt(bitqueryMax);
            } catch {
              bitqueryCap = 0n;
            }
            if (bitqueryCap > 0n && result.amount > bitqueryCap) {
              logger.warn(
                `[FlashSizer] Bitquery cross-check rejected ${result.dexName}: sized amount ` +
                  `${ethers.formatUnits(result.amount, decimals)} exceeds Bitquery's max input ` +
                  `${ethers.formatUnits(bitqueryCap, decimals)} at ${this.config.maxSlippageBps}bps ` +
                  `for pool ${winningPool}`
              );
              return null;
            }
          } else {
            logger.info(
              `[FlashSizer] No Bitquery coverage for winning pool ${winningPool} — proceeding without cross-check`
            );
          }
        }
      }
    }

    return result;
  }
```

Note: `this.dexAggregator['protocols']` reaches a private field from outside the class. Prefer adding a small public accessor on `DEXAggregator` instead of the bracket-index workaround — in `dexAggregator.ts` (already committed in Task 6), add:

```typescript
  /** Read-only access to the configured protocol list (used by FlashSizer's Bitquery cross-check). */
  getProtocols(): DEXProtocolConfig[] {
    return this.protocols;
  }
```

and use `this.dexAggregator.getProtocols().find(...)` instead of the bracket-index form above. If Task 6 has already been completed and committed by the time this task runs, amend Task 6's commit is not necessary — just add this method as part of this task's `flashSizer.ts` diff scope (touching `dexAggregator.ts` again here is fine; commit it together with this task).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors from `flashSizer.ts` or `dexAggregator.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/flashSizer.ts src/dexAggregator.ts
git commit -m "feat: FlashSizer picks router+feeTier alongside size, adds Bitquery cross-check"
```

---

### Task 9: bridge.ts, flashExecutor.ts, executor.ts, eip7702.ts — thread router through the off-chain call chain

**Files:**
- Modify: `src/bridge.ts`
- Modify: `src/flashExecutor.ts`
- Modify: `src/executor.ts`
- Modify: `src/eip7702.ts`

**Interfaces:**
- Consumes: `SizedLoan.router`/`SizedLoan.feeTier` from Task 8; `FlashLoanReceiver.initiateFlashLoan(address token, address router, uint256 amount, bytes calldata swapPath, uint256 minAmountOut)` from Task 2; `SniperSearcher.executeSwapWithDeadline(address tokenIn, address router, ...)` from Task 1; `DelegatedExecutor.executeSwap(address tokenIn, address router, ...)` from Task 3.
- Produces: `SwapOpportunity.router: string` (new field, used by the DIRECT/EIP7702 branches), `FlashLoanParams.router: string`, `SwapParams.router: string` (executor.ts), `EIP7702Executor`'s swap params gain `router`.

- [ ] **Step 1: In `src/bridge.ts`, add `router` to `SwapOpportunity` and rebuild the flash-loan path from FlashSizer's answer**

Replace:

```typescript
interface SwapOpportunity {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  path: Buffer;
  minAmountOut: bigint;
  deadline: number;
  estimatedProfit?: bigint;
  /** Optional DEX pool for Bitquery slippage/depth sizing */
  poolAddress?: string;
}
```

with:

```typescript
interface SwapOpportunity {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  path: Buffer;
  minAmountOut: bigint;
  deadline: number;
  estimatedProfit?: bigint;
  /** Optional DEX pool for Bitquery slippage/depth sizing */
  poolAddress?: string;
  /** Router to use for DIRECT/EIP7702 modes (ignored by FLASH_LOAN — that mode gets its
   *  router from FlashSizer's answer, the single source of truth for execution venue). */
  router?: string;
}
```

Replace the `executeFlashLoan` method's dynamic-size branch:

```typescript
    if (useDynamic) {
      console.log(`  ⚡ Flash loan — computing dynamic loan size via FlashSizer...`);
      const sized = await this.flashSizer.computeOptimalSize(
        opportunity.tokenIn,
        opportunity.tokenOut,
        { poolAddress: opportunity.poolAddress }
      );

      if (!sized) {
        return {
          success: false,
          mode: ExecutionMode.FLASH_LOAN,
          error:
            'FlashSizer: no profitable loan size found. ' +
            'Possible causes: no DEX pool for this pair (check FlashSizer logs for route), ' +
            'insufficient Aave liquidity, or DEX round-trip fees exceed arb spread.',
        };
      }

      console.log(`  ⚡ Flash loan execution via Aave V3 (dynamic size)`);
      console.log(`     Loan amount:   ${ethers.formatUnits(sized.amount, 18)}`);
      console.log(`     Expected out:  ${ethers.formatUnits(sized.expectedOutput, 18)}`);
      console.log(`     Min amount out:${ethers.formatUnits(sized.minAmountOut, 18)}`);
      console.log(`     Aave fee:      ${ethers.formatUnits(sized.fee, 18)}`);
      console.log(`     Net profit:    ${ethers.formatUnits(sized.netProfit, 18)}`);
      console.log(`     DEX:           ${sized.dexName}`);

      loanAmount = sized.amount;
      loanMinAmountOut = sized.minAmountOut;
    } else {
      console.log(`  ⚡ Flash loan execution via Aave V3 (fixed size from config)`);
    }

    const result = await this.flashExecutor.executeFlashLoanArbitrage({
      token: opportunity.tokenIn,
      amount: loanAmount,
      swapPath: opportunity.path,
      minAmountOut: loanMinAmountOut,
      useType4: FLASH_USE_TYPE4,
    });
```

with:

```typescript
    let loanRouter = opportunity.router;
    let loanPath = opportunity.path;

    if (useDynamic) {
      console.log(`  ⚡ Flash loan — computing dynamic loan size via FlashSizer...`);
      const sized = await this.flashSizer.computeOptimalSize(
        opportunity.tokenIn,
        opportunity.tokenOut,
        { poolAddress: opportunity.poolAddress }
      );

      if (!sized) {
        return {
          success: false,
          mode: ExecutionMode.FLASH_LOAN,
          error:
            'FlashSizer: no profitable loan size found. ' +
            'Possible causes: no DEX pool for this pair on Uniswap V3, SushiSwap V3, or ' +
            'PancakeSwap V3 (check FlashSizer logs for route), insufficient Aave liquidity, ' +
            'DEX round-trip fees exceed arb spread, or the Bitquery cross-check rejected the ' +
            'winning venue.',
        };
      }

      console.log(`  ⚡ Flash loan execution via Aave V3 (dynamic size)`);
      console.log(`     Loan amount:   ${ethers.formatUnits(sized.amount, 18)}`);
      console.log(`     Expected out:  ${ethers.formatUnits(sized.expectedOutput, 18)}`);
      console.log(`     Min amount out:${ethers.formatUnits(sized.minAmountOut, 18)}`);
      console.log(`     Aave fee:      ${ethers.formatUnits(sized.fee, 18)}`);
      console.log(`     Net profit:    ${ethers.formatUnits(sized.netProfit, 18)}`);
      console.log(`     DEX:           ${sized.dexName}`);

      loanAmount = sized.amount;
      loanMinAmountOut = sized.minAmountOut;
      loanRouter = sized.router;
      // FlashSizer picked this venue/feeTier for THIS amount — rebuild the path from its
      // answer rather than trusting whatever main.ts guessed from a small upfront probe.
      loanPath = Buffer.from(
        encodePath([opportunity.tokenIn, opportunity.tokenOut, opportunity.tokenIn], [sized.feeTier, sized.feeTier])
      );
    } else {
      console.log(`  ⚡ Flash loan execution via Aave V3 (fixed size from config)`);
    }

    if (!loanRouter) {
      return {
        success: false,
        mode: ExecutionMode.FLASH_LOAN,
        error: 'No router resolved for flash-loan execution (dynamicFlashSize disabled and opportunity.router unset)',
      };
    }

    const result = await this.flashExecutor.executeFlashLoanArbitrage({
      token: opportunity.tokenIn,
      router: loanRouter,
      amount: loanAmount,
      swapPath: loanPath,
      minAmountOut: loanMinAmountOut,
      useType4: FLASH_USE_TYPE4,
    });
```

Add the import needed for `encodePath` at the top of `bridge.ts` (check first whether it's already imported — it is not, per the current file):

```typescript
import { encodePath } from './uniswap';
```

Replace the `executeDirect` method's call:

```typescript
    const result = await this.directExecutor.executeSwap({
      tokenIn: opportunity.tokenIn,
      amountIn: opportunity.amountIn,
      path: opportunity.path,
      minAmountOut: opportunity.minAmountOut,
    });
```

with:

```typescript
    if (!opportunity.router) {
      return {
        success: false,
        mode: ExecutionMode.DIRECT,
        error: 'DIRECT mode requires opportunity.router',
      };
    }

    const result = await this.directExecutor.executeSwap({
      tokenIn: opportunity.tokenIn,
      router: opportunity.router,
      amountIn: opportunity.amountIn,
      path: opportunity.path,
      minAmountOut: opportunity.minAmountOut,
    });
```

Replace the `executeEIP7702` method's call:

```typescript
    const result = await this.eip7702Executor.executeDelegatedSwap({
      tokenIn: opportunity.tokenIn,
      amountIn: opportunity.amountIn,
      path: opportunity.path,
      minAmountOut: opportunity.minAmountOut,
      deadline: opportunity.deadline,
    });
```

with:

```typescript
    if (!opportunity.router) {
      return {
        success: false,
        mode: ExecutionMode.EIP7702,
        error: 'EIP7702 mode requires opportunity.router',
      };
    }

    const result = await this.eip7702Executor.executeDelegatedSwap({
      tokenIn: opportunity.tokenIn,
      router: opportunity.router,
      amountIn: opportunity.amountIn,
      path: opportunity.path,
      minAmountOut: opportunity.minAmountOut,
      deadline: opportunity.deadline,
    });
```

- [ ] **Step 2: In `src/flashExecutor.ts`, add `router` to `FlashLoanParams` and thread it to both call paths**

Replace:

```typescript
interface FlashLoanParams {
  token: string;
  amount: bigint;
  swapPath: Buffer | string;
  minAmountOut: bigint;
  /**
   * When true (and BATCH_EXECUTOR_ADDRESS is configured), initiate via EIP-7702
   * type-4: EOA authorizes BasicEOABatchExecutor then CALLs FlashLoanReceiver.
   * Owner of FlashLoanReceiver must be the signing EOA (msg.sender under 7702).
   */
  useType4?: boolean;
}
```

with:

```typescript
interface FlashLoanParams {
  token: string;
  /** Router SniperSearcher should swap against (must be on its allowedRouters). */
  router: string;
  amount: bigint;
  swapPath: Buffer | string;
  minAmountOut: bigint;
  /**
   * When true (and BATCH_EXECUTOR_ADDRESS is configured), initiate via EIP-7702
   * type-4: EOA authorizes BasicEOABatchExecutor then CALLs FlashLoanReceiver.
   * Owner of FlashLoanReceiver must be the signing EOA (msg.sender under 7702).
   */
  useType4?: boolean;
}
```

Replace the `INITIATE_FLASH_IFACE` definition:

```typescript
const INITIATE_FLASH_IFACE = new ethers.Interface([
  'function initiateFlashLoan(address token, uint256 amount, bytes swapPath, uint256 minAmountOut)',
]);
```

with:

```typescript
const INITIATE_FLASH_IFACE = new ethers.Interface([
  'function initiateFlashLoan(address token, address router, uint256 amount, bytes swapPath, uint256 minAmountOut)',
]);
```

Replace the plain type-2 initiation call:

```typescript
      const tx = await this.receiver.initiateFlashLoan(
        params.token,
        params.amount,
        params.swapPath,
        params.minAmountOut,
        {
          gasLimit: (gasEstimate * 115n) / 100n, // 15% buffer
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        }
      );
```

with:

```typescript
      const tx = await this.receiver.initiateFlashLoan(
        params.token,
        params.router,
        params.amount,
        params.swapPath,
        params.minAmountOut,
        {
          gasLimit: (gasEstimate * 115n) / 100n, // 15% buffer
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        }
      );
```

Replace the gas-estimate call in `estimateFlashLoanGas`:

```typescript
      const gasEstimate = await this.receiver.initiateFlashLoan.estimateGas(
        params.token,
        params.amount,
        params.swapPath,
        params.minAmountOut
      );
```

with:

```typescript
      const gasEstimate = await this.receiver.initiateFlashLoan.estimateGas(
        params.token,
        params.router,
        params.amount,
        params.swapPath,
        params.minAmountOut
      );
```

Replace the type-4 path's encoded call:

```typescript
    const data = INITIATE_FLASH_IFACE.encodeFunctionData('initiateFlashLoan', [
      params.token,
      params.amount,
      pathHex,
      params.minAmountOut,
    ]);
```

with:

```typescript
    const data = INITIATE_FLASH_IFACE.encodeFunctionData('initiateFlashLoan', [
      params.token,
      params.router,
      params.amount,
      pathHex,
      params.minAmountOut,
    ]);
```

- [ ] **Step 3: In `src/executor.ts`, add `router` to `SwapParams` and thread it through**

Replace:

```typescript
interface SwapParams {
  tokenIn: string;
  amountIn: bigint;
  path: Buffer;
  minAmountOut: bigint;
  deadline?: number;
}
```

with:

```typescript
interface SwapParams {
  tokenIn: string;
  router: string;
  amountIn: bigint;
  path: Buffer;
  minAmountOut: bigint;
  deadline?: number;
}
```

Replace the `executeSwapWithDeadline` call in `executeSwap`:

```typescript
      const tx = await this.searcher.executeSwapWithDeadline(
        params.tokenIn,
        params.amountIn,
        params.path,
        params.minAmountOut,
        deadline,
        {
          gasLimit: (gasEstimate * 110n) / 100n, // 10% buffer
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        }
      );
```

with:

```typescript
      const tx = await this.searcher.executeSwapWithDeadline(
        params.tokenIn,
        params.router,
        params.amountIn,
        params.path,
        params.minAmountOut,
        deadline,
        {
          gasLimit: (gasEstimate * 110n) / 100n, // 10% buffer
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        }
      );
```

There is a second, separate public method in the same class that also calls `executeSwapWithDeadline` directly — `SniperExecutor.executeSwapWithDeadline(params)` (distinct from the `executeSwap` method updated above). Replace:

```typescript
      const tx = await this.searcher.executeSwapWithDeadline(
        params.tokenIn,
        params.amountIn,
        params.path,
        params.minAmountOut,
        params.deadline,
        {
          gasLimit: (gasEstimate * 110n) / 100n,
        }
      );
```

with:

```typescript
      const tx = await this.searcher.executeSwapWithDeadline(
        params.tokenIn,
        params.router,
        params.amountIn,
        params.path,
        params.minAmountOut,
        params.deadline,
        {
          gasLimit: (gasEstimate * 110n) / 100n,
        }
      );
```

Both call sites above share one private gas-estimate helper. Replace:

```typescript
  private async estimateSwapGasWithDeadline(
    params: SwapParams & { deadline: number }
  ): Promise<bigint> {
    try {
      const gasEstimate = await this.searcher.executeSwapWithDeadline.estimateGas(
        params.tokenIn,
        params.amountIn,
        params.path,
        params.minAmountOut,
        params.deadline
      );
      return gasEstimate;
    } catch (error) {
```

with:

```typescript
  private async estimateSwapGasWithDeadline(
    params: SwapParams & { deadline: number }
  ): Promise<bigint> {
    try {
      const gasEstimate = await this.searcher.executeSwapWithDeadline.estimateGas(
        params.tokenIn,
        params.router,
        params.amountIn,
        params.path,
        params.minAmountOut,
        params.deadline
      );
      return gasEstimate;
    } catch (error) {
```

- [ ] **Step 4: In `src/eip7702.ts`, add `router` to `DelegatedSwapParams` and thread it through both call sites that target `DelegatedExecutor`**

Replace the ABI interface (keep `allowEOA`/`allowedEOAs` unchanged, only the three swap entrypoints gain `router` in Task 3's position — 2nd parameter, after `tokenIn`; for `executeBatchSwaps`, after `swaps`):

```typescript
const DELEGATED_EXECUTOR_IFACE = new ethers.Interface([
  'function executeSwap(address tokenIn, uint256 amountIn, bytes calldata path, uint256 minAmountOut, uint256 deadline) external returns (uint256)',
  'function executeSwapWithCallback(address tokenIn, uint256 amountIn, bytes calldata path, uint256 minAmountOut, uint256 deadline, bytes calldata callbackData) external returns (uint256)',
  'function executeBatchSwaps(tuple(address tokenIn,uint256 amountIn,bytes path,uint256 minAmountOut)[] swaps, uint256 deadline) external returns (uint256[])',
  'function allowEOA(address eoa) external',
  'function allowedEOAs(address eoa) view returns (bool)',
]);
```

with:

```typescript
const DELEGATED_EXECUTOR_IFACE = new ethers.Interface([
  'function executeSwap(address tokenIn, address router, uint256 amountIn, bytes calldata path, uint256 minAmountOut, uint256 deadline) external returns (uint256)',
  'function executeSwapWithCallback(address tokenIn, address router, uint256 amountIn, bytes calldata path, uint256 minAmountOut, uint256 deadline, bytes calldata callbackData) external returns (uint256)',
  'function executeBatchSwaps(tuple(address tokenIn,uint256 amountIn,bytes path,uint256 minAmountOut)[] swaps, address router, uint256 deadline) external returns (uint256[])',
  'function allowEOA(address eoa) external',
  'function allowedEOAs(address eoa) view returns (bool)',
]);
```

Replace the `DelegatedSwapParams` interface:

```typescript
export interface DelegatedSwapParams {
  tokenIn: string;
  amountIn: bigint;
  path: Buffer | string;
  minAmountOut: bigint;
  deadline: number;
  gasLimit?: bigint;
  /** If true, clear EOA delegation after the swap with a follow-up type-4. */
  clearAfter?: boolean;
}
```

with:

```typescript
export interface DelegatedSwapParams {
  tokenIn: string;
  /** Router DelegatedExecutor should swap against (must be on its allowedRouters). */
  router: string;
  amountIn: bigint;
  path: Buffer | string;
  minAmountOut: bigint;
  deadline: number;
  gasLimit?: bigint;
  /** If true, clear EOA delegation after the swap with a follow-up type-4. */
  clearAfter?: boolean;
}
```

In `executeDelegatedSwap`, replace:

```typescript
      const data = DELEGATED_EXECUTOR_IFACE.encodeFunctionData('executeSwap', [
        params.tokenIn,
        params.amountIn,
        this.pathToHex(params.path),
        params.minAmountOut,
        params.deadline,
      ]);
```

with:

```typescript
      const data = DELEGATED_EXECUTOR_IFACE.encodeFunctionData('executeSwap', [
        params.tokenIn,
        params.router,
        params.amountIn,
        this.pathToHex(params.path),
        params.minAmountOut,
        params.deadline,
      ]);
```

`executeDelegatedBatchSwaps(swaps, deadline)` also calls `DelegatedExecutor.executeBatchSwaps` and needs a `router` parameter added (all swaps in a batch share one router, matching Task 3's contract signature). Replace:

```typescript
  async executeDelegatedBatchSwaps(
    swaps: DelegatedSwapParams[],
    deadline: number
  ): Promise<DelegatedSwapResult> {
    try {
      const eoa = await this.authority.getAddress();
      const swapRequests = swaps.map((s) => ({
        tokenIn: s.tokenIn,
        amountIn: s.amountIn,
        path: this.pathToHex(s.path),
        minAmountOut: s.minAmountOut,
      }));

      const data = DELEGATED_EXECUTOR_IFACE.encodeFunctionData('executeBatchSwaps', [
        swapRequests,
        deadline,
      ]);
```

with:

```typescript
  async executeDelegatedBatchSwaps(
    swaps: DelegatedSwapParams[],
    router: string,
    deadline: number
  ): Promise<DelegatedSwapResult> {
    try {
      const eoa = await this.authority.getAddress();
      const swapRequests = swaps.map((s) => ({
        tokenIn: s.tokenIn,
        amountIn: s.amountIn,
        path: this.pathToHex(s.path),
        minAmountOut: s.minAmountOut,
      }));

      const data = DELEGATED_EXECUTOR_IFACE.encodeFunctionData('executeBatchSwaps', [
        swapRequests,
        router,
        deadline,
      ]);
```

`approveAndSwap` (a separate method further down the same file, lines ~914-959) already takes its own `params.router` and calls `BasicEOABatchExecutor` directly — it never goes through `DELEGATED_EXECUTOR_IFACE` or `DelegatedExecutor` at all, so it needs no change here.

- [ ] **Step 5: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: no errors. This is the task where every remaining `router`-shaped type error from Tasks 6-8 should disappear — if errors remain, they name the exact file/line still missing a `router` argument.

- [ ] **Step 6: Commit**

```bash
git add src/bridge.ts src/flashExecutor.ts src/executor.ts src/eip7702.ts
git commit -m "feat: thread router selection through the off-chain execution call chain"
```

---

### Task 10: Fork dry-run — prove a non-Uniswap venue actually executes, without touching mainnet

**Files:**
- None modified — this task only runs verification commands.

**Interfaces:**
- Consumes: everything from Tasks 1-9.

- [ ] **Step 1: Start a local Anvil fork of Arbitrum One**

Run: `anvil --fork-url https://arb1.arbitrum.io/rpc --chain-id 42161 &`
Expected: Anvil prints a list of funded local accounts and `Listening on 127.0.0.1:8545`. Keep this running in the background for the rest of this task; kill it with `kill %1` (or the job's PID) when done.

- [ ] **Step 2: Deploy the updated contracts to the fork (NOT mainnet — this is a local fork RPC)**

Run:
```bash
cd contracts
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```
(That private key is Anvil's well-known default account #0 — funded automatically on every fork, safe to use only against the local fork, never mainnet.)
Expected: prints `[OK] SniperSearcher deployed to: 0x...`, `[OK] FlashLoanReceiver deployed to: 0x...`, `[OK] DelegatedExecutor deployed to: 0x...`, and confirms `allowedExecutors[FlashLoanReceiver] = true`. Note the three printed addresses for the next step.

- [ ] **Step 3: Run `Configure.s.sol` and `Verify.s.sol` against the fork**

Run:
```bash
SNIPER_SEARCHER_ADDRESS=<address from step 2> \
FLASH_LOAN_RECEIVER_ADDRESS=<address from step 2> \
DELEGATED_EXECUTOR_ADDRESS=<address from step 2> \
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  forge script script/Configure.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```
Expected: `[OK] permissions configured` or `[OK] no on-chain writes needed`, no `require` failures.

Run: `SNIPER_SEARCHER_ADDRESS=<address> FLASH_LOAN_RECEIVER_ADDRESS=<address> DELEGATED_EXECUTOR_ADDRESS=<address> forge script script/Verify.s.sol --rpc-url http://127.0.0.1:8545`
Expected: `[PASS] All production wiring checks passed`.

- [ ] **Step 4: Prove a swap actually executes through SushiSwap V3 specifically (not just Uniswap)**

Using `cast` against the fork, call `SniperSearcher.executeSwap` directly as the owner (Anvil account #0), with `router` set to the SushiSwap V3 address (`0x8A21F6768C1f8075791D08546Dadf6daA0bE820c`), on a real WETH/USDC pair that has liquidity on SushiSwap V3 on Arbitrum mainnet (verify the pool exists first — the fork mirrors real mainnet state, so a real SushiSwap V3 WETH/USDC pool at the 500 fee tier should be there):

```bash
# Confirm a real SushiSwap V3 WETH/USDC pool exists on the fork via its factory
cast call 0x1af415a1EbA07a4986a52B6f2e7dE7003D82231e \
  "getPool(address,address,uint24)(address)" \
  0x82aF49447D8a07e3bd95BD0d56f35241523fBab1 0xaf88d065e77c8cC2239327C5EDb3A432268e5831 500 \
  --rpc-url http://127.0.0.1:8545
```
Expected: a non-zero pool address. If it's zero, try fee tier `100` or `3000` instead of `500` and re-run.

Then fund the owner account with WETH on the fork (Anvil lets you set ERC20 balances via storage manipulation, or simpler: use `cast send` to wrap ETH into WETH, since Anvil accounts start with a large ETH balance):

```bash
cast send 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1 "deposit()" \
  --value 5ether --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --rpc-url http://127.0.0.1:8545

cast send 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1 "approve(address,uint256)" \
  <SniperSearcher address from step 2> $(cast --to-wei 1) \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --rpc-url http://127.0.0.1:8545
```

Then call `executeSwap` with a WETH→USDC path at the fee tier confirmed in the `getPool` check above (replace `500` if a different tier had the pool):

```bash
cast send <SniperSearcher address from step 2> \
  "executeSwap(address,address,uint256,bytes,uint256)" \
  0x82aF49447D8a07e3bd95BD0d56f35241523fBab1 \
  0x8A21F6768C1f8075791D08546Dadf6daA0bE820c \
  $(cast --to-wei 1) \
  $(cast concat-hex 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1 0x0001f4 0xaf88d065e77c8cC2239327C5EDb3A432268e5831) \
  0 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --rpc-url http://127.0.0.1:8545
```

Expected: the transaction succeeds (no revert), and its receipt logs include the `Swap` event from `SniperSearcher` — confirming a swap actually executed against SushiSwap V3's real router on a real mainnet-forked pool, not Uniswap.

- [ ] **Step 5: Tear down**

Run: `kill %1` (or find and kill the Anvil background job with `jobs` / `kill <PID>`)
Expected: fork process stops. No state from this task persists anywhere real — this was entirely local.

- [ ] **Step 6: Report results, no commit**

This task produces no code changes — it's a verification gate. Summarize the dry-run outcome (pool found, swap succeeded, event emitted) before considering this plan complete. If any step failed, that is a BLOCKED status for this task — do not proceed to declaring the plan done; escalate the specific failure.
