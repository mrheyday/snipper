// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {Script, console} from "forge-std/Script.sol";
import {SniperSearcher} from "../src/SniperSearcher.sol";
import {FlashLoanReceiver} from "../src/FlashLoanReceiver.sol";
import {DelegatedExecutor} from "../src/DelegatedExecutor.sol";
import {DeployRegistry} from "../src/DeployRegistry.sol";

/**
 * @title Configure
 * @notice Post-deploy on-chain configuration + constructor-value audit.
 *
 * Ensures:
 *   1. Live immutables match DeployRegistry constructor args
 *   2. SniperSearcher.allowExecutor(FlashLoanReceiver)
 *   3. DelegatedExecutor.allowEOA(owner) for non-7702 external path
 *
 * Usage:
 *   forge script script/Configure.s.sol --rpc-url $RPC
 *   forge script script/Configure.s.sol --rpc-url $RPC --broadcast
 *
 * Env (optional overrides; default = DeployRegistry production):
 *   SNIPER_SEARCHER_ADDRESS, FLASH_LOAN_RECEIVER_ADDRESS, DELEGATED_EXECUTOR_ADDRESS
 *   PRIVATE_KEY (required for --broadcast)
 */
contract Configure is Script {
    function run() external {
        address sniper = _envOr("SNIPER_SEARCHER_ADDRESS", DeployRegistry.SNIPER_SEARCHER);
        address flash = _envOr("FLASH_LOAN_RECEIVER_ADDRESS", DeployRegistry.FLASH_LOAN_RECEIVER);
        address delegated = _envOr("DELEGATED_EXECUTOR_ADDRESS", DeployRegistry.DELEGATED_EXECUTOR);

        console.log("");
        console.log("========== ON-CHAIN CONFIGURE + CONSTRUCTOR AUDIT ==========");
        console.log("chainId ", block.chainid);
        console.log("sniper  ", sniper);
        console.log("flash   ", flash);
        console.log("delegated", delegated);
        console.log("");

        SniperSearcher ss = SniperSearcher(payable(sniper));
        FlashLoanReceiver fl = FlashLoanReceiver(payable(flash));
        DelegatedExecutor de = DelegatedExecutor(payable(delegated));

        // --- Constructor / immutable audit ---
        console.log("[1] Constructor values (on-chain vs DeployRegistry)");
        address[] memory expectedRouters = DeployRegistry.sniperInitialRouters();
        for (uint256 i = 0; i < expectedRouters.length; ++i) {
            require(ss.allowedRouters(expectedRouters[i]), "Sniper: expected router not allowlisted");
        }
        require(ss.minAmountBitLength() == DeployRegistry.MIN_AMOUNT_BIT_LENGTH, "Sniper: minBits");
        require(ss.chainId() == block.chainid, "Sniper: chainId");
        for (uint256 i = 0; i < expectedRouters.length; ++i) {
            console.log("  SniperSearcher.allowedRouters[%s]  =", i, expectedRouters[i]);
        }
        console.log("  SniperSearcher.minAmountBitLength =", ss.minAmountBitLength());
        console.log("  SniperSearcher.chainId            =", ss.chainId());
        console.log("  SniperSearcher.owner              =", ss.owner());

        require(fl.swapExecutor() == sniper, "Flash: swapExecutor != sniper");
        require(
            fl.lendingPool() == DeployRegistry.aavePoolForChain(block.chainid),
            "Flash: lendingPool mismatch"
        );
        console.log("  FlashLoanReceiver.swapExecutor    =", fl.swapExecutor());
        console.log("  FlashLoanReceiver.lendingPool     =", fl.lendingPool());
        console.log("  FlashLoanReceiver.owner           =", fl.owner());

        require(de.minAmountBitLength() == DeployRegistry.MIN_AMOUNT_BIT_LENGTH, "Delegated: minBits");
        console.log("  DelegatedExecutor.minAmountBitLength =", de.minAmountBitLength());
        console.log("  DelegatedExecutor.owner              =", de.owner());
        console.log("  [OK] constructor immutables match registry");
        console.log("");

        // Encoded args for explorers / re-verify
        console.log("[2] ABI-encoded constructor args (registry)");
        console.logBytes(DeployRegistry.sniperConstructorArgsEncoded());
        console.logBytes(DeployRegistry.flashConstructorArgsEncodedArbitrum());
        console.logBytes(DeployRegistry.delegatedConstructorArgsEncoded());
        console.log("");

        // --- On-chain permission wiring ---
        address owner = ss.owner();
        require(owner == fl.owner() && owner == de.owner(), "owners diverge");

        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        bool broadcast = pk != 0;

        console.log("[3] Permissions");
        bool flashAllowed = ss.allowedExecutors(flash);
        bool ownerAllowedEoa = de.allowedEOAs(owner);
        console.log("  allowedExecutors(Flash) =", flashAllowed);
        console.log("  allowedEOAs(owner)      =", ownerAllowedEoa);

        bool[] memory delegatedRouterMissing = new bool[](expectedRouters.length);
        bool anyDelegatedRouterMissing = false;
        for (uint256 i = 0; i < expectedRouters.length; ++i) {
            bool allowed = de.allowedRouters(expectedRouters[i]);
            delegatedRouterMissing[i] = !allowed;
            if (!allowed) anyDelegatedRouterMissing = true;
            console.log("  DelegatedExecutor.allowedRouters[%s] =", i, allowed);
        }

        if (flashAllowed && ownerAllowedEoa && !anyDelegatedRouterMissing) {
            console.log("  [OK] no on-chain writes needed");
        } else if (!broadcast) {
            console.log("  [SKIP] would configure; set PRIVATE_KEY and --broadcast to apply");
            if (!flashAllowed) {
                console.log("    missing: SniperSearcher.allowExecutor(FlashLoanReceiver)");
            }
            if (!ownerAllowedEoa) {
                console.log("    missing: DelegatedExecutor.allowEOA(owner)");
            }
            for (uint256 i = 0; i < expectedRouters.length; ++i) {
                if (delegatedRouterMissing[i]) {
                    console.log("    missing: DelegatedExecutor.allowRouter(...)", expectedRouters[i]);
                }
            }
        } else {
            require(vm.addr(pk) == owner, "PRIVATE_KEY is not contract owner");
            vm.startBroadcast(pk);
            if (!flashAllowed) {
                console.log("  -> allowExecutor(Flash)");
                ss.allowExecutor(flash);
            }
            if (!ownerAllowedEoa) {
                console.log("  -> allowEOA(owner)");
                de.allowEOA(owner);
            }
            for (uint256 i = 0; i < expectedRouters.length; ++i) {
                if (delegatedRouterMissing[i]) {
                    console.log("  -> DelegatedExecutor.allowRouter(...)", expectedRouters[i]);
                    de.allowRouter(expectedRouters[i]);
                }
            }
            vm.stopBroadcast();
            console.log("  allowedExecutors(Flash) =", ss.allowedExecutors(flash));
            console.log("  allowedEOAs(owner)      =", de.allowedEOAs(owner));
            require(ss.allowedExecutors(flash), "allowExecutor failed");
            require(de.allowedEOAs(owner), "allowEOA failed");
            for (uint256 i = 0; i < expectedRouters.length; ++i) {
                require(de.allowedRouters(expectedRouters[i]), "DelegatedExecutor allowRouter failed");
            }
            console.log("  [OK] permissions configured");
        }

        console.log("");
        console.log("[PASS] Configure complete");
        console.log("");
    }

    function _envOr(string memory key, address fallbackAddr) internal view returns (address) {
        try vm.envAddress(key) returns (address a) {
            if (a != address(0)) return a;
        } catch {}
        return fallbackAddr;
    }
}
