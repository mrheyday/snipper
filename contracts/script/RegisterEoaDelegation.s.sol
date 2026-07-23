// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {Script, console} from "forge-std/Script.sol";
import {DelegatedExecutor} from "../src/DelegatedExecutor.sol";
import {SniperSearcher} from "../src/SniperSearcher.sol";
import {DeployRegistry} from "../src/DeployRegistry.sol";

/**
 * @title RegisterEoaDelegation
 * @notice On-chain registration for EIP-7702 EOA usage:
 *   - DelegatedExecutor.allowEOA(eoa) for external (non-self) calls
 *   - Logs intended 7702 designators (BEBE multi-target, DelegatedExecutor Uni-only)
 *
 * Type-4 SetCode (ef0100||delegatee) is sent off-chain via scripts/register-eoa-delegation.mjs
 * because forge scripts do not emit EIP-7702 auth lists.
 *
 * Usage:
 *   forge script script/RegisterEoaDelegation.s.sol --rpc-url $RPC --broadcast
 *
 * Env:
 *   PRIVATE_KEY / WALLET_PRIVATE_KEY — contract owner
 *   EOA_ADDRESS (optional) — defaults to owner / deployer
 *   DELEGATED_EXECUTOR_ADDRESS (optional)
 */
contract RegisterEoaDelegation is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address ownerKey = vm.addr(pk);

        address delegated = _envOr("DELEGATED_EXECUTOR_ADDRESS", DeployRegistry.DELEGATED_EXECUTOR);
        address sniper = _envOr("SNIPER_SEARCHER_ADDRESS", DeployRegistry.SNIPER_SEARCHER);
        address eoa = _envOr("EOA_ADDRESS", ownerKey);

        DelegatedExecutor de = DelegatedExecutor(payable(delegated));
        SniperSearcher ss = SniperSearcher(payable(sniper));

        require(de.owner() == ownerKey, "PRIVATE_KEY is not DelegatedExecutor owner");
        require(ss.owner() == ownerKey, "PRIVATE_KEY is not SniperSearcher owner");

        console.log("");
        console.log("========== REGISTER EOA DELEGATION ==========");
        console.log("chainId   ", block.chainid);
        console.log("owner key ", ownerKey);
        console.log("EOA       ", eoa);
        console.log("DelegatedExecutor", delegated);
        console.log("BEBE (7702 multi-target)", DeployRegistry.BEBE);
        console.log("DelegatedExecutor (7702 uni)", delegated);
        console.log("");

        bool already = de.allowedEOAs(eoa);
        console.log("allowedEOAs(EOA) before:", already);

        if (already) {
            console.log("[OK] EOA already registered on DelegatedExecutor");
        } else {
            console.log("-> allowEOA(EOA)");
            vm.startBroadcast(pk);
            de.allowEOA(eoa);
            vm.stopBroadcast();
            require(de.allowedEOAs(eoa), "allowEOA failed");
            console.log("[OK] EOA registered: allowedEOAs=true");
        }

        // Owner is always registered at DelegatedExecutor construction; re-assert.
        if (!de.allowedEOAs(ownerKey)) {
            console.log("-> allowEOA(owner)");
            vm.startBroadcast(pk);
            de.allowEOA(ownerKey);
            vm.stopBroadcast();
        }

        console.log("");
        console.log("On-chain registration:");
        console.log("  allowedEOAs(EOA)   =", de.allowedEOAs(eoa));
        console.log("  allowedEOAs(owner) =", de.allowedEOAs(ownerKey));
        console.log("");
        console.log("EIP-7702 designators (set via type-4 off-chain):");
        console.log("  Multi-target / flash type-4 -> BEBE:");
        console.log("    0xef0100 || ", DeployRegistry.BEBE);
        console.log("  Uni-only swaps -> DelegatedExecutor:");
        console.log("    0xef0100 || ", delegated);
        console.log("");
        console.log("Next: node scripts/register-eoa-delegation.mjs [--target bebe|delegated]");
        console.log("[PASS] RegisterEoaDelegation complete");
        console.log("");
    }

    function _envOr(string memory key, address fallbackAddr) internal view returns (address) {
        try vm.envAddress(key) returns (address a) {
            if (a != address(0)) return a;
        } catch {}
        return fallbackAddr;
    }
}
