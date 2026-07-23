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
        searcher = new SniperSearcher(address(this), 0); // Use test contract as mock router

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
        uint256 amountOut = searcher.executeSwap(address(tokenA), 100e18, path, 0);
        amountOut; // call is expected to revert; captured only to satisfy the return-value check
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

    function test_MinAmountBitLength_DisabledByDefault() public {
        assertEq(searcher.minAmountBitLength(), 0);
    }

    function test_MinAmountBitLength_RevertsOnDustBeforeAnyExternalCall() public {
        bytes memory path = abi.encodePacked(address(tokenA), uint24(3000), address(tokenB));

        // minAmountBitLength is immutable; deploy a separate instance with the guard
        // enabled (e.g. reject anything below ~1.1e15 wei, i.e. bitLength < 50). Deployed
        // by (and thus owned by) this test contract, so no prank is needed to call it.
        SniperSearcher guarded = new SniperSearcher(address(this), 50);

        // 1 wei has bitLength 1, well under the 50-bit floor.
        vm.expectRevert(abi.encodeWithSignature("AmountTooSmall(uint256,uint256)", 1, 50));
        uint256 amountOut = guarded.executeSwap(address(tokenA), 1, path, 0);
        amountOut; // call is expected to revert; captured only to satisfy the return-value check

        // No tokens should have moved: the guard fires before safeTransferFrom.
        // (This test contract was never minted any tokenA in setUp — still 0.)
        assertEq(tokenA.balanceOf(address(this)), 0);
    }

    function test_MinAmountBitLength_GasSavedOnRejectedDust() public {
        bytes memory path = abi.encodePacked(address(tokenA), uint24(3000), address(tokenB));

        SniperSearcher guarded = new SniperSearcher(address(this), 50);

        uint256 gasBefore = gasleft();
        try guarded.executeSwap(address(tokenA), 1, path, 0) {
            revert("expected revert");
        } catch {
            // expected
        }
        uint256 gasUsedOnRejectedDust = gasBefore - gasleft();

        // A real swap attempt (even one that ultimately fails at the router) pays for
        // approve() + safeTransferFrom() first; the dust guard short-circuits before both.
        // 50k gas is a generous ceiling for "revert before any external call" on this path.
        assertLt(gasUsedOnRejectedDust, 50_000);
    }

    function test_Multicall_BatchesOwnerCallsWithCorrectSender() public {
        address executorA = makeAddr("executorA");
        address executorB = makeAddr("executorB");

        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(SniperSearcher.allowExecutor, (executorA));
        calls[1] = abi.encodeCall(SniperSearcher.allowExecutor, (executorB));

        // delegatecall inside multicall must preserve msg.sender, so both onlyOwner
        // checks should see `owner` and succeed.
        vm.prank(owner);
        bytes[] memory results = searcher.multicall(calls);

        assertEq(results.length, calls.length);
        assertTrue(searcher.allowedExecutors(executorA));
        assertTrue(searcher.allowedExecutors(executorB));
    }

    function test_Multicall_RevertsForNonOwner() public {
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(SniperSearcher.allowExecutor, (user));

        // msg.sender preserved as `user` through the delegatecall, so the inner
        // onlyOwner check must still reject it.
        vm.prank(user);
        vm.expectRevert(Unauthorized.selector);
        bytes[] memory results = searcher.multicall(calls);
        results; // call is expected to revert; captured only to satisfy the return-value check
    }
}
