// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {Test, console} from "forge-std/Test.sol";
import {SniperSearcher} from "../src/SniperSearcher.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

contract SniperSearcherTest is Test {
    SniperSearcher public searcher;
    ERC20Mock public tokenA;
    ERC20Mock public tokenB;
    address public owner;
    address public user;

    error Unauthorized();
    error SwapFailed();

    event Swap(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);

    function setUp() public {
        owner = makeAddr("owner");
        user = makeAddr("user");

        // Deploy contracts
        vm.prank(owner);
        searcher = new SniperSearcher(address(this)); // Use test contract as mock router

        // Deploy mock tokens
        tokenA = new ERC20Mock("Token A", "TKNA", 18);
        tokenB = new ERC20Mock("Token B", "TKNB", 6);

        // Mint tokens
        tokenA.mint(user, 1000e18);
        tokenB.mint(address(this), 10000e6); // Mock router needs tokens
    }

    function test_Deployment() public {
        assertEq(searcher.owner(), owner);
        assertEq(searcher.chainId(), block.chainid);
    }

    function test_RevertWhen_UnauthorizedCaller() public {
        bytes memory path = abi.encodePacked(address(tokenA), uint24(3000), address(tokenB));

        vm.prank(user);
        vm.expectRevert(Unauthorized.selector);
        searcher.executeSwap(address(tokenA), 100e18, path, 0);
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
        uint256 amountB = 100e6;

        tokenA.mint(address(searcher), amountA);
        tokenB.mint(address(searcher), amountB);

        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);

        vm.prank(owner);
        searcher.withdrawAll(tokens, user);

        assertEq(tokenA.balanceOf(user), 1000e18 + amountA);
        assertEq(tokenB.balanceOf(user), amountB);
        assertEq(tokenA.balanceOf(address(searcher)), 0);
        assertEq(tokenB.balanceOf(address(searcher)), 0);
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
}
