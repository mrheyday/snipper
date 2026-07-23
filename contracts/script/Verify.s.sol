// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {Script, console} from "forge-std/Script.sol";
import {SniperSearcher} from "../src/SniperSearcher.sol";
import {FlashLoanReceiver} from "../src/FlashLoanReceiver.sol";
import {DelegatedExecutor} from "../src/DelegatedExecutor.sol";

/**
 * @title Verify
 * @notice Post-deployment verification — hard-fails on wiring mismatches.
 *
 *   forge script script/Verify.s.sol --rpc-url arbitrum
 *
 * Env: SNIPER_SEARCHER_ADDRESS, FLASH_LOAN_RECEIVER_ADDRESS, DELEGATED_EXECUTOR_ADDRESS
 * Optional: BATCH_EXECUTOR_ADDRESS (defaults to canonical BEBE)
 */
contract Verify is Script {
    address constant SWAP_ROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    address constant AAVE_POOL_ARBITRUM = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address constant AAVE_POOL_SEPOLIA = 0xB9C5a95a8f8D7ad8E64d64eF53e6aBaA40a5bF18;
    address constant CANONICAL_BEBE = 0x00000000BEBEDB7C30ee418158e26E31a5A8f3E2;

    function run() external view {
        console.log("");
        console.log("=============================================================");
        console.log("         CONTRACT VERIFICATION (HARD FAIL ON MISMATCH)");
        console.log("=============================================================");
        console.log("");

        address sniperSearcher = vm.envAddress("SNIPER_SEARCHER_ADDRESS");
        address flashLoanReceiver = vm.envAddress("FLASH_LOAN_RECEIVER_ADDRESS");
        address delegatedExecutor = vm.envAddress("DELEGATED_EXECUTOR_ADDRESS");
        address batchExecutor = CANONICAL_BEBE;
        try vm.envAddress("BATCH_EXECUTOR_ADDRESS") returns (address b) {
            if (b != address(0)) batchExecutor = b;
        } catch {}

        console.log("Chain:", block.chainid);
        require(block.chainid == 42161 || block.chainid == 421614, "unsupported chain");

        address expectedPool = block.chainid == 42161 ? AAVE_POOL_ARBITRUM : AAVE_POOL_SEPOLIA;

        // --- SniperSearcher ---
        require(_isContract(sniperSearcher), "SniperSearcher: no code");
        SniperSearcher ss = SniperSearcher(payable(sniperSearcher));
        require(ss.swapRouter() == SWAP_ROUTER, "SniperSearcher: bad swapRouter");
        require(ss.chainId() == block.chainid, "SniperSearcher: chainId mismatch");
        require(ss.allowedExecutors(flashLoanReceiver), "SniperSearcher: Flash not allowedExecutor");
        console.log("[PASS] SniperSearcher wiring");
        console.log("       owner=", ss.owner());
        console.log("       minAmountBitLength=", ss.minAmountBitLength());

        // --- FlashLoanReceiver ---
        require(_isContract(flashLoanReceiver), "FlashLoanReceiver: no code");
        FlashLoanReceiver flr = FlashLoanReceiver(payable(flashLoanReceiver));
        require(flr.swapExecutor() == sniperSearcher, "Flash: swapExecutor != Sniper");
        require(flr.lendingPool() == expectedPool, "Flash: bad lendingPool");
        require(flr.owner() == ss.owner(), "Flash: owner != Sniper owner");
        console.log("[PASS] FlashLoanReceiver wiring");
        console.log("       owner=", flr.owner());

        // --- DelegatedExecutor ---
        require(_isContract(delegatedExecutor), "DelegatedExecutor: no code");
        DelegatedExecutor de = DelegatedExecutor(payable(delegatedExecutor));
        require(de.owner() == ss.owner(), "DelegatedExecutor: owner mismatch");
        console.log("[PASS] DelegatedExecutor");
        console.log("       owner=", de.owner());
        console.log("       minAmountBitLength=", de.minAmountBitLength());

        // --- BEBE / batch executor ---
        require(_isContract(batchExecutor), "BATCH_EXECUTOR: no code");
        console.log("[PASS] Batch executor has code");
        console.log("       address=", batchExecutor);
        if (batchExecutor == CANONICAL_BEBE) {
            console.log("       (canonical Vectorized BEBE)");
        }

        console.log("");
        console.log("[PASS] All production wiring checks passed");
        console.log("");
    }

    function _isContract(address addr) internal view returns (bool) {
        uint256 size;
        assembly {
            size := extcodesize(addr)
        }
        return size > 0;
    }
}
