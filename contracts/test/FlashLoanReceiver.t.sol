// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {Test} from "forge-std/Test.sol";
import {SniperSearcher} from "../src/SniperSearcher.sol";
import {FlashLoanReceiver} from "../src/FlashLoanReceiver.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @dev Minimal Uniswap V3 SwapRouter02 mock matching IUniswapV3Router02 struct ABI.
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
        address tokenOut = address(bytes20(params.path[23:43]));
        // Pull input from caller (SniperSearcher)
        require(ERC20Mock(tokenIn).transferFrom(msg.sender, address(this), params.amountIn), "in");
        amountOut = params.amountIn; // 1:1 mock
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
        searcher = new SniperSearcher(address(router), 0);
        flash = new FlashLoanReceiver(address(searcher), pool);

        // Deploy must whitelist FlashLoanReceiver (matches Deploy.s.sol step 5)
        searcher.allowExecutor(address(flash));

        tokenA = new ERC20Mock("A", "A", 18);
        tokenB = new ERC20Mock("B", "B", 18);
    }

    function _pathAB() internal view returns (bytes memory) {
        return abi.encodePacked(address(tokenA), uint24(3000), address(tokenB));
    }

    function _pathBA() internal view returns (bytes memory) {
        return abi.encodePacked(address(tokenB), uint24(3000), address(tokenA));
    }

    /// Round-trip path A->B->A encoded as single multi-hop is complex for mock;
    /// flash path uses one hop: borrow A, swap to B (profit on B), but repay needs A.
    /// So for repay test we simulate same-asset "arb": path A->A-style by minting A back.
    /// Better: borrow A, swap A->B on searcher which returns B to flash; then we only
    /// prove approve + allowExecutor + return-to-caller. Repay with same-asset needs
    /// path that ends in A. Use path A->B with minOut, then mint A back as "second leg".
    function test_ExecuteOperation_ApprovesExecutorAndReturnsOutToFlash() public {
        uint256 amount = 100e18;
        uint256 premium = amount * 5 / 10_000; // 0.05% (live Arbitrum FLASHLOAN_PREMIUM_TOTAL)
        bytes memory path = _pathAB();
        uint256 minOut = 100e18;

        // Simulate Aave transferring flash-borrowed A to receiver.
        tokenA.mint(address(flash), amount);

        // Fund router side is handled by mock mint of tokenOut.
        bytes memory params = abi.encode(address(tokenA), path, minOut);

        // After one hop, flash holds B not A — repay would fail. Fund the premium+loan
        // of A so repay path is still exercised after the swap callback.
        tokenA.mint(address(flash), amount + premium);

        bool ok = flash.executeOperation(address(tokenA), amount, premium, address(flash), params);
        assertTrue(ok);

        // Searcher should not retain output (returned to flash).
        assertEq(tokenB.balanceOf(address(searcher)), 0);
        // Flash received the swap out.
        assertEq(tokenB.balanceOf(address(flash)), minOut);
        // Allowance to searcher cleared after swap.
        assertEq(tokenA.allowance(address(flash), address(searcher)), 0);
        // Aave was approved for amount+premium (standing until Aave pulls).
        assertEq(tokenA.allowance(address(flash), pool), amount + premium);
    }

    function test_ExecuteOperation_RevertsWhenExecutorNotAllowed() public {
        // Fresh searcher without allowExecutor
        SniperSearcher locked = new SniperSearcher(address(router), 0);
        FlashLoanReceiver orphan = new FlashLoanReceiver(address(locked), pool);

        uint256 amount = 100e18;
        tokenA.mint(address(orphan), amount);
        bytes memory params = abi.encode(address(tokenA), _pathAB(), uint256(0));

        vm.expectRevert(); // Unauthorized from SniperSearcher
        orphan.executeOperation(address(tokenA), amount, 0, address(orphan), params);
    }

    function test_ExecuteOperation_RevertsWithoutAssetApprovalPath() public {
        // If searcher is allowed but flash has zero balance, transferFrom fails.
        uint256 amount = 100e18;
        // no mint to flash
        bytes memory params = abi.encode(address(tokenA), _pathAB(), uint256(0));
        vm.expectRevert();
        flash.executeOperation(address(tokenA), amount, 0, address(flash), params);
    }

    function test_AllowExecutor_DeployWiresFlash() public view {
        assertTrue(searcher.allowedExecutors(address(flash)));
    }

    // Aave pool entrypoint unused in unit tests (we call executeOperation directly),
    // but provide so `pool == address(this)` looks like a realistic peer.
    function flashLoanSimple(address, address, uint256, bytes calldata, uint16) external pure {}
}
