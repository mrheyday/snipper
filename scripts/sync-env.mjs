#!/usr/bin/env node
/**
 * Sync .env with .env.example:
 * - Add any keys present in example but missing from .env
 * - Expand .env.example with code-used keys + sensible defaults
 * - Never overwrite non-empty .env values
 * - Print masked status report
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = path.join(root, '.env');
const EX = path.join(root, '.env.example');

function parse(file) {
  const keys = new Map();
  const order = [];
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (!v.startsWith('"') && !v.startsWith("'")) {
      const i = v.indexOf(' #');
      if (i >= 0) v = v.slice(0, i).trim();
    }
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!keys.has(m[1])) order.push(m[1]);
    keys.set(m[1], v);
  }
  return { keys, order, raw: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '' };
}

function isEmpty(v) {
  if (v == null) return true;
  const s = String(v).trim();
  if (!s) return true;
  const low = s.toLowerCase();
  return (
    low.startsWith('your_') ||
    low === 'changeme' ||
    low === 'xxx' ||
    low === 'todo' ||
    low === 'tbd' ||
    low === '<fill>' ||
    low === '0x' ||
    low.includes('replace_me') ||
    low.includes('insert_')
  );
}

function mask(v) {
  if (v == null) return '-';
  if (isEmpty(v)) return '(empty)';
  const s = String(v);
  if (/^0x[a-fA-F0-9]{40}$/i.test(s)) return s.slice(0, 6) + '...' + s.slice(-4);
  if (/^0x[a-fA-F0-9]{64}$/i.test(s)) return s.slice(0, 6) + '...' + s.slice(-4) + ' (key)';
  if (/^https?:|^wss?:/i.test(s)) return s.length > 50 ? s.slice(0, 50) + '...' : s;
  if (s.length > 16) return s.slice(0, 4) + '...' + s.slice(-4) + ' (len=' + s.length + ')';
  return s;
}

// Canonical template with comments + defaults (production Arbitrum)
const TEMPLATE = `# Arbitrum MAINNET
RPC=https://arb1.arbitrum.io/rpc
# Prefer a private RPC (Alchemy/Infura/QuickNode) in production for reliability.
# ALCHEMY_API_KEY=
WALLET_PRIVATE_KEY=your_private_key_here
# Foundry deploy scripts read PRIVATE_KEY (can mirror WALLET_PRIVATE_KEY).
PRIVATE_KEY=
CHAIN_ID=42161

# Uniswap V3 periphery (Arbitrum)
SWAP_ROUTER_ADDRESS=0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45
QUOTER_ADDRESS=0x61fFE014bA17989E743c5F6cB21bF9697530B21e
PERMIT2_ADDRESS=0x000000000022D473030F116dDEE9F6B43aC78BA3

# Trade knobs
# SLIPPAGE_TOLERANCE is in basis points (50 = 0.50%). Older configs used "5" as 0.05% — verify.
SLIPPAGE_TOLERANCE=50
DEADLINE_IN_MINUTES=30

# Bitquery OAuth token (Bearer). HTTP: Authorization header.
# WS: wss://streaming.bitquery.io/graphql?token=... + graphql-ws protocol.
BITQUERY_TOKEN=your_bitquery_oauth_token_here

# Deployed contract addresses (fill after: forge script script/Deploy.s.sol --rpc-url arbitrum --broadcast)
SNIPER_SEARCHER_ADDRESS=
FLASH_LOAN_RECEIVER_ADDRESS=
DELEGATED_EXECUTOR_ADDRESS=
# Optional EIP-7702 multi-target batch executor (BasicEOABatchExecutor / BEBE)
BATCH_EXECUTOR_ADDRESS=

# Optional RPCs used by Foundry / scripts
# ARBITRUM_RPC_URL=
# ARBITRUM_SEPOLIA_RPC_URL=
# ARBISCAN_API_KEY=
# ETHERSCAN_API_KEY=
`;

function templateKeys() {
  const keys = new Map();
  const order = [];
  for (const line of TEMPLATE.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    if (!keys.has(m[1])) order.push(m[1]);
    keys.set(m[1], m[2]);
  }
  return { keys, order };
}

const tpl = templateKeys();
const env = parse(ENV);
const ex = parse(EX);

// 1) Write expanded .env.example from template
fs.writeFileSync(EX, TEMPLATE.endsWith('\n') ? TEMPLATE : TEMPLATE + '\n');
console.log('Updated .env.example');

// 2) Merge into .env: keep existing non-empty values; add missing keys
const merged = new Map(env.keys);
const added = [];
const keptEmpty = [];
for (const k of tpl.order) {
  const cur = merged.get(k);
  if (cur === undefined) {
    merged.set(k, tpl.keys.get(k) ?? '');
    added.push(k);
  } else if (isEmpty(cur)) {
    keptEmpty.push(k);
  }
}

// Preserve extra user keys not in template
const extras = env.order.filter((k) => !tpl.keys.has(k));

// Rebuild .env: template structure with values from merged, then extras block
const outLines = [];
for (const line of TEMPLATE.split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) {
    outLines.push(line);
    continue;
  }
  const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  if (!m) {
    outLines.push(line);
    continue;
  }
  const k = m[1];
  const v = merged.get(k) ?? '';
  outLines.push(k + '=' + v);
}
if (extras.length) {
  outLines.push('');
  outLines.push('# --- keys present only in previous .env (preserved) ---');
  for (const k of extras) {
    outLines.push(k + '=' + (env.keys.get(k) ?? ''));
  }
}
// Ensure trailing newline
let body = outLines.join('\n');
if (!body.endsWith('\n')) body += '\n';

// Backup once
if (fs.existsSync(ENV)) {
  const bak = ENV + '.bak.' + Date.now();
  fs.copyFileSync(ENV, bak);
  console.log('Backup:', path.basename(bak));
}
fs.writeFileSync(ENV, body);
console.log('Updated .env');
console.log('Added keys:', added.length ? added.join(', ') : '(none)');
console.log('');

// 3) Report
console.log('=== CONFIG STATUS (values masked) ===');
const mustHave = [
  'RPC',
  'WALLET_PRIVATE_KEY',
  'SWAP_ROUTER_ADDRESS',
  'SNIPER_SEARCHER_ADDRESS',
  'FLASH_LOAN_RECEIVER_ADDRESS',
  'DELEGATED_EXECUTOR_ADDRESS',
];
const shouldHave = [
  'CHAIN_ID',
  'QUOTER_ADDRESS',
  'PERMIT2_ADDRESS',
  'SLIPPAGE_TOLERANCE',
  'DEADLINE_IN_MINUTES',
  'BITQUERY_TOKEN',
  'BATCH_EXECUTOR_ADDRESS',
  'PRIVATE_KEY',
];
const final = parse(ENV);
let blockers = [];
for (const k of mustHave) {
  const v = final.keys.get(k);
  const st = v === undefined ? 'MISSING' : isEmpty(v) ? 'EMPTY' : 'SET';
  if (st !== 'SET') blockers.push(k);
  console.log('  [REQ ' + st.padEnd(7) + '] ' + k + ' = ' + mask(v));
}
for (const k of shouldHave) {
  const v = final.keys.get(k);
  const st = v === undefined ? 'MISSING' : isEmpty(v) ? 'EMPTY' : 'SET';
  console.log('  [OPT ' + st.padEnd(7) + '] ' + k + ' = ' + mask(v));
}
for (const k of extras) {
  const v = final.keys.get(k);
  const st = isEmpty(v) ? 'EMPTY' : 'SET';
  console.log('  [XTR ' + st.padEnd(7) + '] ' + k + ' = ' + mask(v));
}

console.log('');
if (blockers.length) {
  console.log('NOT READY — fill required empty keys:');
  for (const k of blockers) console.log('  - ' + k);
  if (
    blockers.includes('SNIPER_SEARCHER_ADDRESS') ||
    blockers.includes('FLASH_LOAN_RECEIVER_ADDRESS') ||
    blockers.includes('DELEGATED_EXECUTOR_ADDRESS')
  ) {
    console.log('');
    console.log('Deploy contracts first, then paste addresses:');
    console.log('  forge script script/Deploy.s.sol --rpc-url arbitrum --broadcast --verify');
  }
  process.exitCode = 2;
} else {
  console.log('All required keys are SET.');
}
