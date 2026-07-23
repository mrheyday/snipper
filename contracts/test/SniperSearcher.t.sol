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
        vm.startPrank(owner);
        SniperSearcher strict = new SniperSearcher(routers, 32);

        bytes memory path = _pathAB();
        tokenA.approve(address(strict), 1);
        vm.expectRevert(abi.encodeWithSelector(AmountTooSmall.selector, uint256(1), uint256(32)));
        strict.executeSwap(address(tokenA), address(router), 1, path, 0);
        vm.stopPrank();
    }

    function test_MinAmountBitLength_GasSavedOnRejectedDust() public {
        address[] memory routers = new address[](1);
        routers[0] = address(router);
        vm.startPrank(owner);
        SniperSearcher strict = new SniperSearcher(routers, 32);

        bytes memory path = _pathAB();
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
