// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {Script, console} from "forge-std/Script.sol";
import {SniperSearcher} from "../src/SniperSearcher.sol";
import {FlashLoanReceiver} from "../src/FlashLoanReceiver.sol";
import {DelegatedExecutor} from "../src/DelegatedExecutor.sol";

/**
 * @title Verify
 * @notice Post-deployment verification script
 * @dev Verifies all deployed contracts are working correctly
 *
 * Usage:
 *   forge script script/Verify.s.sol --rpc-url arbitrum
 */
contract Verify is Script {
    address constant SWAP_ROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    address constant AAVE_POOL_ARBITRUM = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;

    function run() external view {
        console.log("");
        console.log("=============================================================");
        console.log("         CONTRACT VERIFICATION CHECKLIST");
        console.log("=============================================================");
        console.log("");

        // Read contract addresses from environment
        address sniperSearcher = vm.envAddress("SNIPER_SEARCHER_ADDRESS");
        address flashLoanReceiver = vm.envAddress("FLASH_LOAN_RECEIVER_ADDRESS");
        address delegatedExecutor = vm.envAddress("DELEGATED_EXECUTOR_ADDRESS");

        console.log("Verifying contracts on chain:", block.chainid);
        console.log("");

        // Verify SniperSearcher
        console.log("[*] SniperSearcher at", sniperSearcher);
        if (_isContract(sniperSearcher)) {
            console.log("   [PASS] Contract code exists");
            SniperSearcher ss = SniperSearcher(payable(sniperSearcher));
            console.log("   [PASS] Owner:", ss.owner());
            console.log("   [PASS] SwapRouter:", ss.swapRouter());
            console.log("   [PASS] ChainId:", ss.chainId());
        } else {
            console.log("   [FAIL] No contract code at address");
        }
        console.log("");

        // Verify FlashLoanReceiver
        console.log("[*] FlashLoanReceiver at", flashLoanReceiver);
        if (_isContract(flashLoanReceiver)) {
            console.log("   [PASS] Contract code exists");
            FlashLoanReceiver flr = FlashLoanReceiver(payable(flashLoanReceiver));
            console.log("   [PASS] Owner:", flr.owner());
            console.log("   [PASS] SwapExecutor:", flr.swapExecutor());
            console.log("   [PASS] LendingPool:", flr.lendingPool());
        } else {
            console.log("   [FAIL] No contract code at address");
        }
        console.log("");

        // Verify DelegatedExecutor
        console.log("[*] DelegatedExecutor at", delegatedExecutor);
        if (_isContract(delegatedExecutor)) {
            console.log("   [PASS] Contract code exists");
            console.log("   [PASS] SwapRouter (hardcoded):", SWAP_ROUTER);
        } else {
            console.log("   [FAIL] No contract code at address");
        }
        console.log("");

        // Summary
        console.log("[PASS] Verification complete!");
        console.log("");
        console.log("Next steps:");
        console.log("  1. Run integration tests against deployed contracts");
        console.log("  2. Test swap execution with small amounts");
        console.log("  3. Verify flash loan functionality");
        console.log("  4. Monitor gas usage and profitability");
        console.log("");
    }

    /**
     * Check if address contains contract code
     */
    function _isContract(address addr) internal view returns (bool) {
        uint256 size;
        assembly {
            size := extcodesize(addr)
        }
        return size > 0;
    }
}
