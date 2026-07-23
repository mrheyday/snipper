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
