// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {Script, console} from "forge-std/Script.sol";
import {BasicEOABatchExecutor} from "../src/BasicEOABatchExecutor.sol";

/**
 * @title DeployBatchExecutor
 * @notice Deploy only BasicEOABatchExecutor (BEBE / ERC-7821) for EIP-7702 multi-target.
 * @dev Prefer the canonical Vectorized CREATE2 deployment when available:
 *      0x00000000BEBEDB7C30ee418158e26E31a5A8f3E2
 *      Use this script only when you need a self-deployed instance
 *      (e.g. custom chain without the CREATE2 factory, or bytecode experiments).
 *
 *   forge script script/DeployBatchExecutor.s.sol --rpc-url arbitrum --broadcast --verify
 */
contract DeployBatchExecutor is Script {
    /// @dev Canonical BEBE address (Vectorized/bebe CREATE2). Prefer this in production.
    address public constant CANONICAL_BEBE = 0x00000000BEBEDB7C30ee418158e26E31a5A8f3E2;

    function run() external returns (address deployed) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        require(deployerKey != 0 && deployer != address(0), "PRIVATE_KEY");

        console.log("Deploying BasicEOABatchExecutor (BEBE)");
        console.log("  chainId ", block.chainid);
        console.log("  deployer", deployer);
        console.log("  canonical", CANONICAL_BEBE);
        if (CANONICAL_BEBE.code.length > 0) {
            console.log("  note: canonical already has code on this chain; prefer it unless you need a custom deploy");
        }

        vm.startBroadcast(deployerKey);
        BasicEOABatchExecutor bebe = new BasicEOABatchExecutor();
        vm.stopBroadcast();

        deployed = address(bebe);
        console.log("BasicEOABatchExecutor:", deployed);
        console.log("Set in .env:");
        console.log("  BATCH_EXECUTOR_ADDRESS=%s", deployed);
    }
}
