// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {Script, console} from "forge-std/Script.sol";
import {SniperSearcher} from "../src/SniperSearcher.sol";
import {FlashLoanReceiver} from "../src/FlashLoanReceiver.sol";
import {DelegatedExecutor} from "../src/DelegatedExecutor.sol";
import {DeployRegistry} from "../src/DeployRegistry.sol";

/**
 * @title Verify
 * @notice Post-deployment verification — hard-fails on wiring / constructor mismatches.
 *
 *   forge script script/Verify.s.sol --rpc-url $RPC
 *
 * Env optional (defaults DeployRegistry production addresses):
 *   SNIPER_SEARCHER_ADDRESS, FLASH_LOAN_RECEIVER_ADDRESS, DELEGATED_EXECUTOR_ADDRESS, BATCH_EXECUTOR_ADDRESS
 */
contract Verify is Script {
    function run() external view {
        console.log("");
        console.log("=============================================================");
        console.log("         CONTRACT VERIFICATION (HARD FAIL ON MISMATCH)");
        console.log("=============================================================");
        console.log("");

        address sniperSearcher = _envOr("SNIPER_SEARCHER_ADDRESS", DeployRegistry.SNIPER_SEARCHER);
        address flashLoanReceiver = _envOr("FLASH_LOAN_RECEIVER_ADDRESS", DeployRegistry.FLASH_LOAN_RECEIVER);
        address delegatedExecutor = _envOr("DELEGATED_EXECUTOR_ADDRESS", DeployRegistry.DELEGATED_EXECUTOR);
        address batchExecutor = _envOr("BATCH_EXECUTOR_ADDRESS", DeployRegistry.BEBE);

        console.log("Chain:", block.chainid);
        require(
            block.chainid == DeployRegistry.CHAIN_ID_ARBITRUM
                || block.chainid == DeployRegistry.CHAIN_ID_ARBITRUM_SEPOLIA,
            "unsupported chain"
        );

        address expectedPool = DeployRegistry.aavePoolForChain(block.chainid);

        // --- SniperSearcher (constructor: initialRouters[], minAmountBitLength) ---
        require(_isContract(sniperSearcher), "SniperSearcher: no code");
        SniperSearcher ss = SniperSearcher(payable(sniperSearcher));
        address[] memory expectedRouters = DeployRegistry.sniperInitialRouters();
        for (uint256 i = 0; i < expectedRouters.length; ++i) {
            require(ss.allowedRouters(expectedRouters[i]), "SniperSearcher: expected router not allowlisted");
        }
        require(
            ss.minAmountBitLength() == DeployRegistry.MIN_AMOUNT_BIT_LENGTH, "SniperSearcher: minBits"
        );
        require(ss.chainId() == block.chainid, "SniperSearcher: chainId mismatch");
        require(ss.allowedExecutors(flashLoanReceiver), "SniperSearcher: Flash not allowedExecutor");
        console.log("[PASS] SniperSearcher wiring + constructor");
        console.log("       owner=", ss.owner());
        console.log("       minAmountBitLength=", ss.minAmountBitLength());
        for (uint256 i = 0; i < expectedRouters.length; ++i) {
            console.log("       allowedRouters[%s]=", i, expectedRouters[i]);
        }

        // --- FlashLoanReceiver (constructor: swapExecutor, lendingPool) ---
        require(_isContract(flashLoanReceiver), "FlashLoanReceiver: no code");
        FlashLoanReceiver flr = FlashLoanReceiver(payable(flashLoanReceiver));
        require(flr.swapExecutor() == sniperSearcher, "Flash: swapExecutor != Sniper");
        require(flr.lendingPool() == expectedPool, "Flash: bad lendingPool");
        require(flr.owner() == ss.owner(), "Flash: owner != Sniper owner");
        console.log("[PASS] FlashLoanReceiver wiring + constructor");
        console.log("       owner=", flr.owner());
        console.log("       swapExecutor=", flr.swapExecutor());
        console.log("       lendingPool=", flr.lendingPool());

        // --- DelegatedExecutor (constructor: minAmountBitLength) ---
        require(_isContract(delegatedExecutor), "DelegatedExecutor: no code");
        DelegatedExecutor de = DelegatedExecutor(payable(delegatedExecutor));
        require(de.owner() == ss.owner(), "DelegatedExecutor: owner mismatch");
        require(
            de.minAmountBitLength() == DeployRegistry.MIN_AMOUNT_BIT_LENGTH, "Delegated: minBits"
        );
        console.log("[PASS] DelegatedExecutor wiring + constructor");
        console.log("       owner=", de.owner());
        console.log("       minAmountBitLength=", de.minAmountBitLength());

        // --- BEBE / batch executor ---
        require(_isContract(batchExecutor), "BATCH_EXECUTOR: no code");
        console.log("[PASS] Batch executor has code");
        console.log("       address=", batchExecutor);
        if (batchExecutor == DeployRegistry.BEBE) {
            console.log("       (canonical Vectorized BEBE)");
        }

        console.log("");
        console.log("[PASS] All production wiring checks passed");
        console.log("");
    }

    function _envOr(string memory key, address fallbackAddr) internal view returns (address) {
        try vm.envAddress(key) returns (address a) {
            if (a != address(0)) return a;
        } catch {}
        return fallbackAddr;
    }

    function _isContract(address addr) internal view returns (bool) {
        uint256 size;
        assembly {
            size := extcodesize(addr)
        }
        return size > 0;
    }
}
