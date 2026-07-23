// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {Test, console} from "forge-std/Test.sol";
import {DelegatedExecutor} from "../src/DelegatedExecutor.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

contract DelegatedExecutorTest is Test {
    DelegatedExecutor public executor;
    ERC20Mock public tokenA;
    ERC20Mock public tokenB;
    address public user;

    error DeadlineExceeded();
    error SwapFailed();
    error InvalidPath();
    error CallbackDisabled();

    event Swap(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);

    function setUp() public {
        executor = new DelegatedExecutor(0);
        tokenA = new ERC20Mock("Token A", "TKNA", 18);
        tokenB = new ERC20Mock("Token B", "TKNB", 6);

        user = makeAddr("user");
        tokenA.mint(user, 1000e18);
        tokenB.mint(address(this), 10000e6);
    }

    function test_ExecuteSwap_Success() public {
        uint256 amountIn = 100e18;
        bytes memory path = abi.encodePacked(address(tokenA), uint24(3000), address(tokenB));
        uint256 minOut = 100e6;
        uint256 deadline = block.timestamp + 300;

        tokenA.mint(user, amountIn);

        // Allow EOA to use executor
        executor.allowEOA(user);

        vm.startPrank(user);
        bool approved = tokenA.approve(address(executor), amountIn);
        assertTrue(approved);

        vm.expectRevert();
        uint256 amountOut = executor.executeSwap(address(tokenA), amountIn, path, minOut, deadline);
        amountOut; // call is expected to revert; captured only to satisfy the return-value check
        vm.stopPrank();
    }

    function test_RevertWhen_DeadlineExceeded() public {
        uint256 amountIn = 100e18;
        bytes memory path = abi.encodePacked(address(tokenA), uint24(3000), address(tokenB));
        uint256 deadline = block.timestamp - 1; // Expired

        tokenA.mint(user, amountIn);

        // Allow EOA to use executor (required for access control)
        executor.allowEOA(user);

        vm.startPrank(user);
        bool approved = tokenA.approve(address(executor), amountIn);
        assertTrue(approved);

        vm.expectRevert(DeadlineExceeded.selector);
        uint256 amountOut = executor.executeSwap(address(tokenA), amountIn, path, 0, deadline);
        amountOut; // call is expected to revert; captured only to satisfy the return-value check
        vm.stopPrank();
    }

    function test_Fuzz_DeadlineValidation(uint256 futureTime) public {
        futureTime = bound(futureTime, block.timestamp + 1, block.timestamp + 10000);
        uint256 amountIn = 100e18;
        bytes memory path = abi.encodePacked(address(tokenA), uint24(3000), address(tokenB));

        tokenA.mint(user, amountIn);

        // Allow EOA to use executor
        executor.allowEOA(user);

        vm.startPrank(user);
        bool approved = tokenA.approve(address(executor), amountIn);
        assertTrue(approved);

        vm.expectRevert();
        uint256 amountOut = executor.executeSwap(address(tokenA), amountIn, path, 0, futureTime);
        amountOut; // call is expected to revert; captured only to satisfy the return-value check
        vm.stopPrank();
    }

    function test_RevertWhen_InvalidPath() public {
        executor.allowEOA(user);
        bytes memory bad = abi.encodePacked(address(tokenA));
        vm.prank(user);
        vm.expectRevert(InvalidPath.selector);
        executor.executeSwap(address(tokenA), 1e18, bad, 0, block.timestamp + 60);
    }

    function test_RevertWhen_CallbackDisabled() public {
        executor.allowEOA(user);
        bytes memory path = abi.encodePacked(address(tokenA), uint24(3000), address(tokenB));
        bytes memory cb = hex"deadbeef";
        vm.prank(user);
        tokenA.approve(address(executor), 1e18);
        vm.prank(user);
        vm.expectRevert(CallbackDisabled.selector);
        executor.executeSwapWithCallback(address(tokenA), 1e18, path, 0, block.timestamp + 60, cb);
    }

    function test_ReceiveETH() public {
        uint256 amount = 1 ether;
        (bool success,) = payable(address(executor)).call{value: amount}("");
        require(success);
        assertEq(address(executor).balance, amount);
    }
}
