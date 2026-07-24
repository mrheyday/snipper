// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {Script, console} from "forge-std/Script.sol";
import {SniperSearcher} from "../src/SniperSearcher.sol";
import {FlashLoanReceiver} from "../src/FlashLoanReceiver.sol";
import {DelegatedExecutor} from "../src/DelegatedExecutor.sol";
import {BasicEOABatchExecutor} from "../src/BasicEOABatchExecutor.sol";
import {DeployRegistry} from "../src/DeployRegistry.sol";

/**
 * @title Deploy
 * @notice Complete deployment script for Arbitrum Sniper Bot contracts
 * @dev Constructor args from DeployRegistry. Deploys SniperSearcher, FlashLoanReceiver,
 *      DelegatedExecutor; prefers canonical BEBE.
 *
 * Usage:
 *   forge script script/Deploy.s.sol --rpc-url $RPC
 *   forge script script/Deploy.s.sol --rpc-url $RPC --broadcast --verify
 */
contract Deploy is Script {
    struct DeploymentAddresses {
        address sniperSearcher;
        address flashLoanReceiver;
        address delegatedExecutor;
        address basicEoaBatchExecutor;
        address aavePool;
    }

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        // Verify environment
        require(deployerKey != 0, "PRIVATE_KEY not set");
        require(deployer != address(0), "Invalid deployer address");

        (address[] memory routerAddrs, bool[] memory routerLegacyFlags, uint256 minAmountBitLength) =
            DeployRegistry.sniperConstructorArgs();
        SniperSearcher.RouterConfig[] memory routerConfigs =
            new SniperSearcher.RouterConfig[](routerAddrs.length);
        for (uint256 i = 0; i < routerAddrs.length; ++i) {
            routerConfigs[i] =
                SniperSearcher.RouterConfig({router: routerAddrs[i], legacyAbi: routerLegacyFlags[i]});
        }
        address aavePool = DeployRegistry.aavePoolForChain(block.chainid);
        address canonicalBebe = DeployRegistry.BEBE;

        console.log("");
        console.log("========== ARBITRUM SNIPER BOT - DEPLOYMENT SCRIPT ==========");
        console.log("");
        console.log("Network Configuration:");
        console.log("  Chain ID:", block.chainid);
        console.log("  Deployer:", deployer);
        for (uint256 i = 0; i < routerAddrs.length; ++i) {
            console.log("  Router[%s]:", i, routerAddrs[i]);
            console.log("    legacyAbi:", routerLegacyFlags[i]);
        }
        console.log("  Aave Pool:", aavePool);
        console.log("  minAmountBitLength:", minAmountBitLength);
        console.log("  Canonical BEBE:", canonicalBebe);
        console.log("");

        // Start deployment
        console.log("Deploying contracts...");
        console.log("");

        vm.startBroadcast(deployerKey);

        // 1. Deploy SniperSearcher(routerConfigs[], minAmountBitLength)
        console.log("[1] Deploying SniperSearcher...");
        console.logBytes(DeployRegistry.sniperConstructorArgsEncoded());
        SniperSearcher sniperSearcher = new SniperSearcher(routerConfigs, minAmountBitLength);
        console.log("    [OK] SniperSearcher deployed to:", address(sniperSearcher));

        // 2. Deploy DelegatedExecutor(routerConfigs[], minAmountBitLength)
        console.log("[2] Deploying DelegatedExecutor...");
        console.logBytes(DeployRegistry.delegatedConstructorArgsEncoded());
        (
            address[] memory delegatedRouterAddrs,
            bool[] memory delegatedRouterLegacyFlags,
            uint256 delegatedMinBits
        ) = DeployRegistry.delegatedConstructorArgs();
        DelegatedExecutor.RouterConfig[] memory delegatedRouterConfigs =
            new DelegatedExecutor.RouterConfig[](delegatedRouterAddrs.length);
        for (uint256 i = 0; i < delegatedRouterAddrs.length; ++i) {
            delegatedRouterConfigs[i] = DelegatedExecutor.RouterConfig({
                router: delegatedRouterAddrs[i],
                legacyAbi: delegatedRouterLegacyFlags[i]
            });
        }
        DelegatedExecutor delegatedExecutor = new DelegatedExecutor(delegatedRouterConfigs, delegatedMinBits);
        console.log("    [OK] DelegatedExecutor deployed to:", address(delegatedExecutor));

        // 3. Deploy FlashLoanReceiver(sniper, aavePool)
        console.log("[3] Deploying FlashLoanReceiver...");
        FlashLoanReceiver flashLoanReceiver = new FlashLoanReceiver(address(sniperSearcher), aavePool);
        console.log("    [OK] FlashLoanReceiver deployed to:", address(flashLoanReceiver));

        // 4. Prefer Vectorized canonical BEBE when present; only deploy a local copy
        //    if the CREATE2 address has no code on this chain.
        address basicEoaBatchExecutor = canonicalBebe;
        if (canonicalBebe.code.length == 0) {
            console.log("[4] Canonical BEBE missing - deploying local BasicEOABatchExecutor...");
            basicEoaBatchExecutor = address(new BasicEOABatchExecutor());
            console.log("    [OK] BasicEOABatchExecutor deployed to:", basicEoaBatchExecutor);
        } else {
            console.log("[4] Using canonical BEBE (skip deploy):", canonicalBebe);
        }

        // 5. Whitelist FlashLoanReceiver on SniperSearcher so executeOperation can call
        //    executeSwap (onlyOwnerOrAllowedExecutor). Without this, flash callbacks revert
        //    Unauthorized even with correct ERC20 approvals.
        console.log("[5] Allowing FlashLoanReceiver as SniperSearcher executor...");
        sniperSearcher.allowExecutor(address(flashLoanReceiver));
        console.log("    [OK] allowedExecutors[FlashLoanReceiver] = true");

        vm.stopBroadcast();

        // Print summary
        console.log("");
        console.log("================== DEPLOYMENT SUMMARY ==================");
        console.log("");
        console.log("[OK] All contracts deployed successfully!");
        console.log("");
        console.log("Contract Addresses:");
        console.log("  SniperSearcher:         ", address(sniperSearcher));
        console.log("  FlashLoanReceiver:      ", address(flashLoanReceiver));
        console.log("  DelegatedExecutor:      ", address(delegatedExecutor));
        console.log("  BasicEOABatchExecutor:  ", basicEoaBatchExecutor);
        console.log("");
        console.log("Configuration:");
        for (uint256 i = 0; i < routerAddrs.length; ++i) {
            console.log("  Router[%s]:             ", i, routerAddrs[i]);
            console.log("    legacyAbi:            ", routerLegacyFlags[i]);
        }
        console.log("  AavePool:               ", aavePool);
        console.log("  minAmountBitLength:     ", minAmountBitLength);
        console.log("  Owner:                  ", deployer);
        console.log("");
        console.log("EIP-7702 roles:");
        console.log("  DelegatedExecutor       = single-target swaps via allowlisted router");
        console.log("  BasicEOABatchExecutor   = multi-target CALL batch (any contract)");
        console.log("");
        console.log("Permissions wired:");
        console.log("  SniperSearcher.allowExecutor(FlashLoanReceiver) = true");
        console.log("  FlashLoanReceiver approves SniperSearcher + Aave pool at runtime");
        console.log("  SniperSearcher approves the caller-selected allowlisted router per-swap then revokes");
        console.log("  Router ABI variant (SwapRouter02 vs legacy ISwapRouter) selected per-router on-chain");
        console.log("");
        console.log("Next Steps:");
        console.log("  1. Save these addresses to your .env file");
        console.log("  2. Update SNIPER_SEARCHER_ADDRESS=", address(sniperSearcher));
        console.log("  3. Update FLASH_LOAN_RECEIVER_ADDRESS=", address(flashLoanReceiver));
        console.log("  4. Update DELEGATED_EXECUTOR_ADDRESS=", address(delegatedExecutor));
        console.log("  5. Update BATCH_EXECUTOR_ADDRESS=", basicEoaBatchExecutor);
        console.log("  6. On already-deployed stacks: cast send $SNIPER allowExecutor(address) $FLASH");
        console.log("  7. Run forge script script/Verify.s.sol --rpc-url arbitrum");
        console.log("  8. Monitor initial transactions carefully");
        console.log("");

        // Store addresses for later use
        _saveDeploymentAddresses(
            DeploymentAddresses({
                sniperSearcher: address(sniperSearcher),
                flashLoanReceiver: address(flashLoanReceiver),
                delegatedExecutor: address(delegatedExecutor),
                basicEoaBatchExecutor: basicEoaBatchExecutor,
                aavePool: aavePool
            })
        );
    }

    /**
     * Internal: Log deployment addresses to console
     */
    function _saveDeploymentAddresses(DeploymentAddresses memory addresses) internal pure {
        // Addresses are logged above; kept for future file persistence.
        addresses;
    }
}
