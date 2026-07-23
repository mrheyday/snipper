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

    event Swap(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    function setUp() public {
        owner = makeAddr("owner");
        user = makeAddr("user");
        executor = makeAddr("executor");

        router = new MockRouter02();
        vm.prank(owner);
        searcher = new SniperSearcher(address(router), 0);

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
        assertEq(searcher.swapRouter(), address(router));
        assertEq(searcher.chainId(), block.chainid);
    }

    function test_RevertWhen_ZeroRouter() public {
        vm.expectRevert(ZeroAddress.selector);
        new SniperSearcher(address(0), 0);
    }

    function test_RevertWhen_UnauthorizedCaller() public {
        bytes memory path = _pathAB();
        vm.prank(user);
        vm.expectRevert(Unauthorized.selector);
        searcher.executeSwap(address(tokenA), 100e18, path, 0);
    }

    function test_ExecuteSwap_Success_ReturnsOutToCaller() public {
        bytes memory path = _pathAB();
        uint256 amountIn = 100e18;

        vm.startPrank(owner);
        tokenA.approve(address(searcher), amountIn);
        uint256 out = searcher.executeSwap(address(tokenA), amountIn, path, amountIn);
        vm.stopPrank();

        assertEq(out, amountIn);
        assertEq(tokenB.balanceOf(owner), amountIn);
        assertEq(tokenB.balanceOf(address(searcher)), 0);
        assertEq(tokenA.allowance(address(searcher), address(router)), 0);
    }

    function test_AllowedExecutor_CanSwapAndReceivesOut() public {
        bytes memory path = _pathAB();
        uint256 amountIn = 50e18;

        vm.prank(owner);
        searcher.allowExecutor(executor);

        vm.startPrank(executor);
        tokenA.approve(address(searcher), amountIn);
        uint256 out = searcher.executeSwap(address(tokenA), amountIn, path, 0);
        vm.stopPrank();

        assertEq(out, amountIn);
        assertEq(tokenB.balanceOf(executor), amountIn);
    }

    function test_RevertWhen_PathTooShort() public {
        bytes memory bad = abi.encodePacked(address(tokenA)); // 20 bytes
        vm.prank(owner);
        tokenA.approve(address(searcher), 1e18);
        vm.prank(owner);
        vm.expectRevert(InvalidPath.selector);
        searcher.executeSwap(address(tokenA), 1e18, bad, 0);
    }

    function test_RevertWhen_TokenInMismatch() public {
        // path starts with tokenB but tokenIn is tokenA
        bytes memory path = abi.encodePacked(address(tokenB), uint24(3000), address(tokenA));
        vm.prank(owner);
        tokenA.approve(address(searcher), 1e18);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TokenInMismatch.selector, address(tokenA), address(tokenB)));
        searcher.executeSwap(address(tokenA), 1e18, path, 0);
    }

    function test_RevertWhen_DeadlineExceeded() public {
        bytes memory path = _pathAB();
        vm.prank(owner);
        tokenA.approve(address(searcher), 1e18);
        vm.warp(block.timestamp + 1000);
        vm.prank(owner);
        vm.expectRevert(DeadlineExceeded.selector);
        searcher.executeSwapWithDeadline(address(tokenA), 1e18, path, 0, block.timestamp - 1);
    }

    function test_ExecuteSwapWithDeadline_Success() public {
        bytes memory path = _pathAB();
        uint256 amountIn = 10e18;
        uint256 deadline = block.timestamp + 60;

        vm.startPrank(owner);
        tokenA.approve(address(searcher), amountIn);
        uint256 out = searcher.executeSwapWithDeadline(address(tokenA), amountIn, path, 0, deadline);
        vm.stopPrank();

        assertEq(out, amountIn);
        assertEq(tokenB.balanceOf(owner), amountIn);
    }

    function test_TransferOwnership() public {
        address next = makeAddr("next");
        vm.prank(owner);
        vm.expectEmit(true, true, false, false);
        emit OwnershipTransferred(owner, next);
        searcher.transferOwnership(next);
        assertEq(searcher.owner(), next);

        // old owner cannot withdraw
        vm.prank(owner);
        vm.expectRevert(Unauthorized.selector);
        searcher.withdraw(address(tokenA), owner, 0);

        // new owner can allow executor
        vm.prank(next);
        searcher.allowExecutor(executor);
        assertTrue(searcher.allowedExecutors(executor));
    }

    function test_RevertWhen_TransferOwnershipZero() public {
        vm.prank(owner);
        vm.expectRevert(ZeroAddress.selector);
        searcher.transferOwnership(address(0));
    }

    function test_Withdraw() public {
        uint256 amount = 100e18;
        tokenA.mint(address(searcher), amount);

        vm.prank(owner);
        searcher.withdraw(address(tokenA), user, amount);

        assertEq(tokenA.balanceOf(user), 1000e18 + amount);
        assertEq(tokenA.balanceOf(address(searcher)), 0);
    }

    function test_WithdrawAll() public {
        uint256 amountA = 50e18;
        uint256 amountB = 100e18;
        tokenA.mint(address(searcher), amountA);
        tokenB.mint(address(searcher), amountB);

        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);

        vm.prank(owner);
        searcher.withdrawAll(tokens, user);

        assertEq(tokenA.balanceOf(user), 1000e18 + amountA);
        assertEq(tokenB.balanceOf(user), amountB);
    }

    function test_GetBalance() public {
        uint256 amount = 250e18;
        tokenA.mint(address(searcher), amount);
        assertEq(searcher.getBalance(address(tokenA)), amount);
    }

    function test_ReceiveETH() public {
        uint256 amount = 1 ether;
        (bool success,) = payable(address(searcher)).call{value: amount}("");
        require(success, "ETH transfer failed");
        assertEq(address(searcher).balance, amount);
    }

    function test_Fuzz_WithdrawAmount(uint256 amount) public {
        amount = bound(amount, 1, type(uint128).max);
        tokenA.mint(address(searcher), amount);

        vm.prank(owner);
        searcher.withdraw(address(tokenA), user, amount);

        assertEq(tokenA.balanceOf(address(searcher)), 0);
        assertEq(tokenA.balanceOf(user), 1000e18 + amount);
    }

    function test_MinAmountBitLength_DisabledByDefault() public view {
        assertEq(searcher.minAmountBitLength(), 0);
    }

    function test_MinAmountBitLength_RevertsOnDustBeforeAnyExternalCall() public {
        bytes memory path = _pathAB();
        SniperSearcher guarded = new SniperSearcher(address(router), 50);

        vm.expectRevert(abi.encodeWithSelector(AmountTooSmall.selector, 1, 50));
        guarded.executeSwap(address(tokenA), 1, path, 0);

        assertEq(tokenA.balanceOf(address(this)), 0);
    }

    function test_MinAmountBitLength_GasSavedOnRejectedDust() public {
        bytes memory path = _pathAB();
        SniperSearcher guarded = new SniperSearcher(address(router), 50);

        uint256 gasBefore = gasleft();
        try guarded.executeSwap(address(tokenA), 1, path, 0) {
            revert("expected revert");
        } catch {}
        uint256 gasUsedOnRejectedDust = gasBefore - gasleft();
        assertLt(gasUsedOnRejectedDust, 50_000);
    }

    function test_Multicall_BatchesOwnerCallsWithCorrectSender() public {
        address executorA = makeAddr("executorA");
        address executorB = makeAddr("executorB");

        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(SniperSearcher.allowExecutor, (executorA));
        calls[1] = abi.encodeCall(SniperSearcher.allowExecutor, (executorB));

        vm.prank(owner);
        bytes[] memory results = searcher.multicall(calls);

        assertEq(results.length, calls.length);
        assertTrue(searcher.allowedExecutors(executorA));
        assertTrue(searcher.allowedExecutors(executorB));
    }

    function test_Multicall_RevertsForNonOwner() public {
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(SniperSearcher.allowExecutor, (user));

        vm.prank(user);
        vm.expectRevert(Unauthorized.selector);
        searcher.multicall(calls);
    }

    function test_RevokeExecutor() public {
        vm.prank(owner);
        searcher.allowExecutor(executor);
        vm.prank(owner);
        searcher.revokeExecutor(executor);

        vm.prank(executor);
        tokenA.approve(address(searcher), 1e18);
        vm.prank(executor);
        vm.expectRevert(Unauthorized.selector);
        searcher.executeSwap(address(tokenA), 1e18, _pathAB(), 0);
    }
}
