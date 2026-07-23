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
        searcher = new SniperSearcher(address(router), 0);
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

        bytes memory params = abi.encode(address(tokenA), path, minOut);

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
        SniperSearcher locked = new SniperSearcher(address(router), 0);
        FlashLoanReceiver orphan = new FlashLoanReceiver(address(locked), pool);

        uint256 amount = 100e18;
        tokenA.mint(address(orphan), amount);
        bytes memory params = abi.encode(address(tokenA), _pathABA(), amount);

        vm.expectRevert(); // Unauthorized from SniperSearcher
        orphan.executeOperation(address(tokenA), amount, 0, address(orphan), params);
    }

    function test_ExecuteOperation_RevertsWithoutAssetApprovalPath() public {
        // If searcher is allowed but flash has zero balance, transferFrom fails.
        uint256 amount = 100e18;
        // no mint to flash
        bytes memory params = abi.encode(address(tokenA), _pathABA(), amount);
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
        flash.initiateFlashLoan(address(tokenA), amount, _pathABA(), amount);
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
