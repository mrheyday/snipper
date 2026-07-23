// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {Script, console} from "forge-std/Script.sol";
import {SniperSearcher} from "../src/SniperSearcher.sol";
import {FlashLoanReceiver} from "../src/FlashLoanReceiver.sol";
import {DelegatedExecutor} from "../src/DelegatedExecutor.sol";
import {BasicEOABatchExecutor} from "../src/BasicEOABatchExecutor.sol";

/**
 * @title Deploy
 * @notice Complete deployment script for Arbitrum Sniper Bot contracts
 * @dev Deploys SniperSearcher, FlashLoanReceiver, DelegatedExecutor, BasicEOABatchExecutor
 *
 * Usage:
 *   Dry run on Arbitrum:
 *   forge script script/Deploy.s.sol --rpc-url arbitrum
 *
 *   Deploy to Arbitrum Sepolia (testnet):
 *   forge script script/Deploy.s.sol --rpc-url arbitrum-sepolia --broadcast
 *
 *   Deploy to Arbitrum Mainnet:
 *   forge script script/Deploy.s.sol --rpc-url arbitrum --broadcast --verify
 */
contract Deploy is Script {
    // Uniswap V3 SwapRouter02 - Same address on both mainnet and testnet
    address constant SWAP_ROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;

    // Aave V3 Lending Pool addresses
    address constant AAVE_POOL_ARBITRUM = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address constant AAVE_POOL_SEPOLIA = 0xB9C5a95a8f8D7ad8E64d64eF53e6aBaA40a5bF18;

    struct DeploymentAddresses {
        address sniperSearcher;
        address flashLoanReceiver;
        address delegatedExecutor;
        address basicEoaBatchExecutor;
        address swapRouter;
        address aavePool;
    }

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        // Verify environment
        require(deployerKey != 0, "PRIVATE_KEY not set");
        require(deployer != address(0), "Invalid deployer address");

        console.log("");
        console.log("========== ARBITRUM SNIPER BOT - DEPLOYMENT SCRIPT ==========");
        console.log("");
        console.log("Network Configuration:");
        console.log("  Chain ID:", block.chainid);
        console.log("  Deployer:", deployer);
        console.log("  SwapRouter:", SWAP_ROUTER);

        // Select Aave pool based on chain
        address aavePool = block.chainid == 42161 ? AAVE_POOL_ARBITRUM : AAVE_POOL_SEPOLIA;
        console.log("  Aave Pool:", aavePool);
        console.log("");

        // Start deployment
        console.log("Deploying contracts...");
        console.log("");

        vm.startBroadcast(deployerKey);

        // Dust guard: reject amountIn with bitLength < 50 (~5.6e14 wei floor). Our
        // configured 0.001 KERN swap amount has bitLength exactly 50, so it still passes
        // (check is strict <) while genuinely smaller dust gets rejected before any
        // transferFrom/approve/router call.
        uint256 minAmountBitLength = 50;

        // 1. Deploy SniperSearcher
        console.log("[1] Deploying SniperSearcher...");
        SniperSearcher sniperSearcher = new SniperSearcher(SWAP_ROUTER, minAmountBitLength);
        console.log("    [OK] SniperSearcher deployed to:", address(sniperSearcher));

        // 2. Deploy DelegatedExecutor (no dependencies)
        console.log("[2] Deploying DelegatedExecutor...");
        DelegatedExecutor delegatedExecutor = new DelegatedExecutor(minAmountBitLength);
        console.log("    [OK] DelegatedExecutor deployed to:", address(delegatedExecutor));

        // 3. Deploy FlashLoanReceiver (depends on SniperSearcher and AavePool)
        console.log("[3] Deploying FlashLoanReceiver...");
        FlashLoanReceiver flashLoanReceiver = new FlashLoanReceiver(address(sniperSearcher), aavePool);
        console.log("    [OK] FlashLoanReceiver deployed to:", address(flashLoanReceiver));

        // 4. Deploy BasicEOABatchExecutor (BEBE) — multi-target CALL batching for EIP-7702.
        //    When an EOA delegates here, `execute(mode, executionData)` can CALL any
        //    `(to, value, data)` list (router, Aave, tokens, etc.) under the EOA context.
        console.log("[4] Deploying BasicEOABatchExecutor (multi-target)...");
        BasicEOABatchExecutor basicEoaBatchExecutor = new BasicEOABatchExecutor();
        console.log("    [OK] BasicEOABatchExecutor deployed to:", address(basicEoaBatchExecutor));

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
        console.log("  BasicEOABatchExecutor:  ", address(basicEoaBatchExecutor));
        console.log("");
        console.log("Configuration:");
        console.log("  SwapRouter:             ", SWAP_ROUTER);
        console.log("  AavePool:               ", aavePool);
        console.log("  Owner:                  ", deployer);
        console.log("");
        console.log("EIP-7702 roles:");
        console.log("  DelegatedExecutor       = single-target Uniswap swaps (hardcoded router)");
        console.log("  BasicEOABatchExecutor   = multi-target CALL batch (any contract)");
        console.log("");
        console.log("Next Steps:");
        console.log("  1. Save these addresses to your .env file");
        console.log("  2. Update SNIPER_SEARCHER_ADDRESS=", address(sniperSearcher));
        console.log("  3. Update FLASH_LOAN_RECEIVER_ADDRESS=", address(flashLoanReceiver));
        console.log("  4. Update DELEGATED_EXECUTOR_ADDRESS=", address(delegatedExecutor));
        console.log("  5. Update BATCH_EXECUTOR_ADDRESS=", address(basicEoaBatchExecutor));
        console.log("  6. Run integration tests with deployed contracts");
        console.log("  7. Monitor initial transactions carefully");
        console.log("");

        // Store addresses for later use
        _saveDeploymentAddresses(
            DeploymentAddresses({
                sniperSearcher: address(sniperSearcher),
                flashLoanReceiver: address(flashLoanReceiver),
                delegatedExecutor: address(delegatedExecutor),
                basicEoaBatchExecutor: address(basicEoaBatchExecutor),
                swapRouter: SWAP_ROUTER,
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
