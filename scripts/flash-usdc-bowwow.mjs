#!/usr/bin/env node
/**
 * Dedicated script to compute optimal dynamic loan size and execute
 * a USDC flash loan on Aave V3 for round-trip arbitrage on Arbitrum in continuous loops.
 *
 * Usage:
 *   node scripts/flash-usdc-bowwow.mjs [TARGET_TOKEN_ADDRESS] [--once]
 *
 * Default Target: WETH (0x82aF49447D8a07e3bd95BD0d56f35241523fBab1)
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

require('dotenv').config({ path: path.join(root, '.env') });
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'commonjs', esModuleInterop: true },
});

const { ethers } = require('ethers');
const { ExecutionBridge, ExecutionMode } = require(path.join(root, 'src/bridge.ts'));
const { encodePath } = require(path.join(root, 'src/uniswap.ts'));
const { ARBITRUM_DEPLOY, getDeadline } = require(path.join(root, 'src/config.ts'));

const USDC_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

const args = process.argv.slice(2);
const runOnce = args.includes('--once');
const targetArg = args.find((arg) => arg !== '--once' && ethers.isAddress(arg));

const TARGET_TOKEN_ADDRESS = targetArg
  ? ethers.getAddress(targetArg)
  : '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'; // WETH default

const FEE_TIER = 500; // 0.05% fee pool tier (common for WETH/USDC)
const LOOP_INTERVAL_MS = parseInt(process.env.LOOP_INTERVAL_MS || '3000', 10);

let running = true;
process.on('SIGINT', () => {
  console.log('\nReceived SIGINT — stopping loop...');
  running = false;
});
process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM — stopping loop...');
  running = false;
});

async function main() {
  console.log('===============================================================');
  console.log('⚡ FLASH LOAN ARBITRAGE: USDC -> TARGET -> USDC (Continuous Loop)');
  console.log('===============================================================');
  console.log(`USDC (Borrow/Repay):         ${USDC_ADDRESS}`);
  console.log(`Target Token:                ${TARGET_TOKEN_ADDRESS}`);
  console.log(`Flash Loan Receiver Address: ${process.env.FLASH_LOAN_RECEIVER_ADDRESS}`);
  console.log(`Pool Fee Tier:               ${FEE_TIER / 10000}% (${FEE_TIER})`);
  console.log(`Loop Mode:                   ${runOnce ? 'Single Run (--once)' : `Continuous (${LOOP_INTERVAL_MS}ms delay)`}`);
  console.log('');

  const bridge = new ExecutionBridge({
    sniperSearcherAddress: process.env.SNIPER_SEARCHER_ADDRESS || ARBITRUM_DEPLOY.sniperSearcher,
    flashLoanReceiverAddress: process.env.FLASH_LOAN_RECEIVER_ADDRESS || ARBITRUM_DEPLOY.flashLoanReceiver,
    delegatedExecutorAddress: process.env.DELEGATED_EXECUTOR_ADDRESS || ARBITRUM_DEPLOY.delegatedExecutor,
    preferredMode: ExecutionMode.FLASH_LOAN,
    dynamicFlashSize: true,
  });

  const pathBytes = encodePath(
    [USDC_ADDRESS, TARGET_TOKEN_ADDRESS, USDC_ADDRESS],
    [FEE_TIER, FEE_TIER]
  );

  let iteration = 0;
  while (running) {
    iteration++;
    console.log(`\n=================== LOOP ITERATION #${iteration} ===================`);
    const deadline = getDeadline(3);

    const opportunity = {
      tokenIn: USDC_ADDRESS,
      tokenOut: TARGET_TOKEN_ADDRESS,
      amountIn: ethers.parseUnits('100', 6),
      path: pathBytes,
      minAmountOut: 0n,
      deadline,
      estimatedProfit: 0n,
    };

    try {
      console.log('🔍 Executing bridge strategy with dynamic FlashSizer calculation...');
      const result = await bridge.executeOptimal(opportunity);

      console.log(`Success:  ${result.success ? '✅ YES' : '❌ NO'}`);
      console.log(`Mode:     ${result.mode}`);
      if (result.txHash) {
        console.log(`Tx Hash:  ${result.txHash}`);
        console.log(`Explorer: https://arbiscan.io/tx/${result.txHash}`);
      }
      if (result.error) {
        console.log(`Result:   ${result.error}`);
      }
    } catch (err) {
      console.error(`Iteration #${iteration} error:`, err instanceof Error ? err.message : String(err));
    }

    if (runOnce) break;

    if (running) {
      console.log(`Sleeping ${LOOP_INTERVAL_MS}ms before iteration #${iteration + 1}...`);
      await new Promise((r) => setTimeout(r, LOOP_INTERVAL_MS));
    }
  }

  console.log('Loop completed cleanly.');
}

main().catch((err) => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
