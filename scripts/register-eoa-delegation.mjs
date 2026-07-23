#!/usr/bin/env node
/**
 * Register EOA for EIP-7702 delegation (type-4 SetCode).
 *
 *   node scripts/register-eoa-delegation.mjs              # -> BEBE (default)
 *   node scripts/register-eoa-delegation.mjs --target delegated
 *   node scripts/register-eoa-delegation.mjs --status
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

// Load TS sources
require('dotenv').config({ path: path.join(root, '.env') });
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'commonjs', esModuleInterop: true },
});

const { Wallet } = require('ethers');
const {
  provider,
  signer,
  CHAIN_ID,
  BATCH_EXECUTOR_ADDRESS,
  DELEGATED_EXECUTOR_ADDRESS,
  BEBE_CANONICAL_ADDRESS,
  ARBITRUM_DEPLOY,
} = require(path.join(root, 'src/config.ts'));
const eip = require(path.join(root, 'src/eip7702.ts'));

const BEBE = BATCH_EXECUTOR_ADDRESS || BEBE_CANONICAL_ADDRESS || ARBITRUM_DEPLOY.bebe;
const DELEGATED = DELEGATED_EXECUTOR_ADDRESS || ARBITRUM_DEPLOY.delegatedExecutor;

function parseArgs(argv) {
  const out = { target: 'bebe', statusOnly: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--status') out.statusOnly = true;
    if (argv[i] === '--target' && argv[i + 1]) out.target = String(argv[++i]).toLowerCase();
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const authority = signer;
  if (!(authority instanceof Wallet)) {
    throw new Error('signer must be ethers Wallet (WALLET_PRIVATE_KEY)');
  }

  const eoa = await authority.getAddress();
  const targetAddr =
    args.target === 'delegated' || args.target === 'delegatedexecutor' ? DELEGATED : BEBE;

  console.log('');
  console.log('========== REGISTER EOA DELEGATION (type-4) ==========');
  console.log('chainId ', CHAIN_ID);
  console.log('EOA     ', eoa);
  console.log(
    'target  ',
    targetAddr,
    args.target === 'delegated' ? '(DelegatedExecutor)' : '(BEBE)'
  );
  console.log('');

  const before = await eip.getDelegationStatus(eoa);
  console.log('before:');
  console.log('  hasCode     ', before.hasCode);
  console.log('  isDelegated ', before.isDelegated);
  console.log('  delegate    ', before.delegate);
  console.log('  nonce       ', before.nonce);

  if (args.statusOnly) {
    console.log('');
    console.log('[status-only] no type-4 sent');
    if (before.delegate) {
      console.log(
        '  designator  0xef0100' + String(before.delegate).slice(2).toLowerCase()
      );
    }
    return;
  }

  if (
    before.isDelegated &&
    before.delegate &&
    before.delegate.toLowerCase() === targetAddr.toLowerCase()
  ) {
    console.log('');
    console.log('[OK] EOA already delegated to target');
    return;
  }

  const authorizer = new eip.EIP7702Authorizer(targetAddr, CHAIN_ID, authority);
  // Self-sponsored: auth.nonce = accountNonce + 1 (EIP-7702)
  const auth = await authorizer.createAuthorization(before.nonce, { selfSponsored: true });
  console.log('');
  console.log(
    'signing auth ->',
    auth.address,
    'account.nonce=',
    before.nonce,
    'auth.nonce=',
    auth.nonce,
    '(self-sponsored +1)'
  );

  const fee = await provider.getFeeData();
  const tip = fee.maxPriorityFeePerGas ?? 10_000_000n;
  let maxFee = fee.maxFeePerGas ?? (fee.gasPrice ?? tip) * 2n;
  if (maxFee < tip) maxFee = tip * 2n;

  const sent = await eip.sendType4Transaction(authority, {
    chainId: CHAIN_ID,
    maxPriorityFeePerGas: tip,
    maxFeePerGas: maxFee,
    gasLimit: 120_000n,
    to: eoa,
    value: 0n,
    data: '0x',
    authorizationList: [auth],
  });

  console.log('type-4 sent:', sent.hash);
  const receipt = await provider.waitForTransaction(sent.hash, 1, 90_000);
  if (!receipt || receipt.status !== 1) {
    console.error('[FAIL] type-4 failed or timed out');
    process.exit(1);
  }

  const after = await eip.getDelegationStatus(eoa);
  console.log('');
  console.log('after:');
  console.log('  isDelegated ', after.isDelegated);
  console.log('  delegate    ', after.delegate);
  console.log('  gasUsed     ', receipt.gasUsed?.toString());

  if (
    !after.isDelegated ||
    !after.delegate ||
    after.delegate.toLowerCase() !== targetAddr.toLowerCase()
  ) {
    console.error('[FAIL] expected', targetAddr, 'got', after.delegate);
    process.exit(1);
  }

  console.log('');
  console.log('[PASS] EOA registered: 0xef0100 ||', after.delegate);
  console.log('  tx:', sent.hash);
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
