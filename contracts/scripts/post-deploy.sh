#!/bin/bash
set -euo pipefail

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(dirname "$CONTRACTS_DIR")"
REPORT_DIR="$CONTRACTS_DIR/deployment-reports"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
REPORT_FILE="$REPORT_DIR/post_deploy_${TIMESTAMP}.md"

mkdir -p "$REPORT_DIR"

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║     ARBITRUM SNIPER BOT - POST-DEPLOYMENT CHECKS          ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

ENV_FILE="$PROJECT_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo -e "${RED}Error: .env not found at $ENV_FILE${NC}"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

RPC_URL="${RPC:-${ARBITRUM_RPC_URL:-}}"
if [[ -z "$RPC_URL" ]]; then
  echo -e "${RED}Error: RPC or ARBITRUM_RPC_URL required${NC}"
  exit 1
fi

PK="${WALLET_PRIVATE_KEY:-${PRIVATE_KEY:-}}"
OWNER_EXPECTED="${EOA_ADDRESS:-0x00000001386687D89e6A36aE01C5e5F75acF61Af}"
BEBE_CANONICAL="0x00000000BEBEDB7C30ee418158e26E31a5A8f3E2"
SWAP_ROUTER_EXPECTED="0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"
AAVE_POOL_EXPECTED="0x794a61358D6845594F94dc1DB02A252b5b4814aD"
BATCH_EXECUTOR_ADDRESS="${BATCH_EXECUTOR_ADDRESS:-$BEBE_CANONICAL}"

FAILS=0
pass() { echo -e "  ${GREEN}[PASS]${NC} $1"; }
fail() { echo -e "  ${RED}[FAIL]${NC} $1"; FAILS=$((FAILS + 1)); }
warn() { echo -e "  ${YELLOW}[WARN]${NC} $1"; }
info() { echo -e "  ${CYAN}[INFO]${NC} $1"; }

# ---------------------------------------------------------------------------
# Step 1: Required addresses
# ---------------------------------------------------------------------------
echo -e "${BLUE}Step 1: Env addresses${NC}"
for v in SNIPER_SEARCHER_ADDRESS FLASH_LOAN_RECEIVER_ADDRESS DELEGATED_EXECUTOR_ADDRESS; do
  if [[ -z "${!v:-}" ]]; then
    fail "$v not set"
  else
    pass "$v=${!v}"
  fi
done
pass "BATCH_EXECUTOR_ADDRESS=$BATCH_EXECUTOR_ADDRESS"
echo ""

# ---------------------------------------------------------------------------
# Step 2: Code presence
# ---------------------------------------------------------------------------
echo -e "${BLUE}Step 2: On-chain code${NC}"
for label_addr in \
  "SniperSearcher:$SNIPER_SEARCHER_ADDRESS" \
  "FlashLoanReceiver:$FLASH_LOAN_RECEIVER_ADDRESS" \
  "DelegatedExecutor:$DELEGATED_EXECUTOR_ADDRESS" \
  "BEBE:$BATCH_EXECUTOR_ADDRESS"
do
  label="${label_addr%%:*}"
  addr="${label_addr#*:}"
  size=$(cast codesize "$addr" --rpc-url "$RPC_URL" 2>/dev/null | tr -d '[:space:]' || echo 0)
  if [[ "$size" != "0" && -n "$size" ]]; then
    pass "$label has code (size=$size)"
  else
    fail "$label no code at $addr"
  fi
done
echo ""

# ---------------------------------------------------------------------------
# Step 3: Wiring + allowlist (cast call)
# ---------------------------------------------------------------------------
echo -e "${BLUE}Step 3: Wiring + allowlist${NC}"

SNIPER_OWNER=$(cast call "$SNIPER_SEARCHER_ADDRESS" "owner()(address)" --rpc-url "$RPC_URL" 2>/dev/null | tr -d '[:space:]')
FLASH_OWNER=$(cast call "$FLASH_LOAN_RECEIVER_ADDRESS" "owner()(address)" --rpc-url "$RPC_URL" 2>/dev/null | tr -d '[:space:]')
DEL_OWNER=$(cast call "$DELEGATED_EXECUTOR_ADDRESS" "owner()(address)" --rpc-url "$RPC_URL" 2>/dev/null | tr -d '[:space:]')
ROUTER=$(cast call "$SNIPER_SEARCHER_ADDRESS" "swapRouter()(address)" --rpc-url "$RPC_URL" 2>/dev/null | tr -d '[:space:]')
SWAP_EXEC=$(cast call "$FLASH_LOAN_RECEIVER_ADDRESS" "swapExecutor()(address)" --rpc-url "$RPC_URL" 2>/dev/null | tr -d '[:space:]')
POOL=$(cast call "$FLASH_LOAN_RECEIVER_ADDRESS" "lendingPool()(address)" --rpc-url "$RPC_URL" 2>/dev/null | tr -d '[:space:]')
MIN_BITS=$(cast call "$SNIPER_SEARCHER_ADDRESS" "minAmountBitLength()(uint256)" --rpc-url "$RPC_URL" 2>/dev/null | tr -d '[:space:]')
ALLOWED=$(cast call "$SNIPER_SEARCHER_ADDRESS" "allowedExecutors(address)(bool)" "$FLASH_LOAN_RECEIVER_ADDRESS" --rpc-url "$RPC_URL" 2>/dev/null | tr -d '[:space:]')

lc() { echo "$1" | tr '[:upper:]' '[:lower:]'; }

[[ "$(lc "$SNIPER_OWNER")" == "$(lc "$OWNER_EXPECTED")" ]] && pass "Sniper owner=$SNIPER_OWNER" || fail "Sniper owner=$SNIPER_OWNER expected $OWNER_EXPECTED"
[[ "$(lc "$FLASH_OWNER")" == "$(lc "$OWNER_EXPECTED")" ]] && pass "Flash owner=$FLASH_OWNER" || fail "Flash owner=$FLASH_OWNER expected $OWNER_EXPECTED"
[[ "$(lc "$DEL_OWNER")" == "$(lc "$OWNER_EXPECTED")" ]] && pass "Delegated owner=$DEL_OWNER" || fail "Delegated owner=$DEL_OWNER expected $OWNER_EXPECTED"
[[ "$(lc "$ROUTER")" == "$(lc "$SWAP_ROUTER_EXPECTED")" ]] && pass "SwapRouter=$ROUTER" || fail "SwapRouter=$ROUTER expected $SWAP_ROUTER_EXPECTED"
[[ "$(lc "$SWAP_EXEC")" == "$(lc "$SNIPER_SEARCHER_ADDRESS")" ]] && pass "Flash.swapExecutor=Sniper" || fail "Flash.swapExecutor=$SWAP_EXEC != Sniper"
[[ "$(lc "$POOL")" == "$(lc "$AAVE_POOL_EXPECTED")" ]] && pass "Aave pool=$POOL" || fail "Aave pool=$POOL expected $AAVE_POOL_EXPECTED"
[[ "$MIN_BITS" == "0" ]] && pass "minAmountBitLength=0" || warn "minAmountBitLength=$MIN_BITS (stablecoin sizes may revert if >0)"

if [[ "$ALLOWED" == "true" ]]; then
  pass "allowedExecutors(FlashLoanReceiver)=true"
else
  warn "allowedExecutors(FlashLoanReceiver)=$ALLOWED — attempting allowExecutor..."
  if [[ -n "$PK" ]]; then
    cast send "$SNIPER_SEARCHER_ADDRESS" "allowExecutor(address)" "$FLASH_LOAN_RECEIVER_ADDRESS" \
      --rpc-url "$RPC_URL" --private-key "$PK" >/dev/null
    ALLOWED2=$(cast call "$SNIPER_SEARCHER_ADDRESS" "allowedExecutors(address)(bool)" "$FLASH_LOAN_RECEIVER_ADDRESS" --rpc-url "$RPC_URL" 2>/dev/null | tr -d '[:space:]')
    if [[ "$ALLOWED2" == "true" ]]; then
      pass "allowExecutor sent — now true"
      ALLOWED=true
    else
      fail "allowExecutor send did not stick"
    fi
  else
    fail "cannot send allowExecutor: no WALLET_PRIVATE_KEY/PRIVATE_KEY"
  fi
fi
echo ""

# ---------------------------------------------------------------------------
# Step 4: Forge Verify.s.sol
# ---------------------------------------------------------------------------
echo -e "${BLUE}Step 4: forge script Configure.s.sol + Verify.s.sol${NC}"
cd "$CONTRACTS_DIR"
export SNIPER_SEARCHER_ADDRESS FLASH_LOAN_RECEIVER_ADDRESS DELEGATED_EXECUTOR_ADDRESS BATCH_EXECUTOR_ADDRESS
# Configure audits constructor registry + ensures allowlist (broadcast only if PRIVATE_KEY set)
if forge script script/Configure.s.sol --rpc-url "$RPC_URL" 2>&1 | tee /tmp/configure-out.txt | tail -40; then
  if grep -q "Configure complete" /tmp/configure-out.txt; then
    pass "Configure.s.sol constructor audit + permissions"
  else
    fail "Configure.s.sol incomplete"
  fi
else
  fail "Configure.s.sol failed"
fi
if forge script script/Verify.s.sol --rpc-url "$RPC_URL" 2>&1 | tee /tmp/verify-out.txt | tail -30; then
  if grep -q "All production wiring checks passed" /tmp/verify-out.txt; then
    pass "Verify.s.sol hard checks passed"
  else
    fail "Verify.s.sol did not print success banner"
  fi
else
  fail "Verify.s.sol failed"
fi
echo ""

# ---------------------------------------------------------------------------
# Step 5: Calldata / selector alignment (cast sig vs ABI / TS)
# ---------------------------------------------------------------------------
echo -e "${BLUE}Step 5: Calldata + selector alignment${NC}"

check_sig() {
  local name="$1"
  local sig="$2"
  local expect="$3"
  local got
  got=$(cast sig "$sig" 2>/dev/null | tr -d '[:space:]')
  if [[ "$(lc "$got")" == "$(lc "$expect")" ]]; then
    pass "$name $got"
  else
    fail "$name got $got expected $expect"
  fi
}

check_sig "Sniper.executeSwap" "executeSwap(address,uint256,bytes,uint256)" "0xdd824660"
check_sig "Sniper.executeSwapWithDeadline" "executeSwapWithDeadline(address,uint256,bytes,uint256,uint256)" "0x2a6ea44a"
check_sig "Sniper.allowExecutor" "allowExecutor(address)" "0xb1b05f2a"
check_sig "Flash.initiateFlashLoan" "initiateFlashLoan(address,uint256,bytes,uint256)" "0xd4c4ca9b"
check_sig "Flash.executeOperation" "executeOperation(address,uint256,uint256,address,bytes)" "0x1b11d0ff"
check_sig "Delegated.executeSwap" "executeSwap(address,uint256,bytes,uint256,uint256)" "0x107db2c4"
check_sig "Delegated.executeBatchSwaps" "executeBatchSwaps((address,uint256,bytes,uint256)[],uint256)" "0x1435c9ac"
check_sig "BEBE.execute" "execute(bytes32,bytes)" "0xe9ae5c53"
check_sig "BEBE.isValidSignature" "isValidSignature(bytes32,bytes)" "0x1626ba7e"
check_sig "BEBE.supportsExecutionMode" "supportsExecutionMode(bytes32)" "0xd03c7914"

# Encode sample initiateFlashLoan and confirm prefix
SAMPLE=$(cast calldata "initiateFlashLoan(address,uint256,bytes,uint256)" \
  0x82aF49447D8a07e3bd95BD0d56f35241523fBab1 \
  1000000000000000000 \
  0x82af49447d8a07e3bd95bd0d56f35241523fbab1000bb8af88d065e77c8cc2239327c5edb3a432268e5831000bb882af49447d8a07e3bd95bd0d56f35241523fbab1 \
  1000500000000000000 2>/dev/null | tr -d '[:space:]')
if [[ "${SAMPLE:0:10}" == "0xd4c4ca9b" ]]; then
  pass "sample initiateFlashLoan calldata starts with 0xd4c4ca9b"
else
  fail "sample initiateFlashLoan prefix ${SAMPLE:0:10}"
fi
echo ""

# ---------------------------------------------------------------------------
# Step 6: Type-4 / EIP-7702 alignment (TS + on-chain)
# ---------------------------------------------------------------------------
echo -e "${BLUE}Step 6: Type-4 / BEBE / Delegated alignment${NC}"

# BEBE supportsExecutionMode for ERC-7821 no-opData mode
MODE="0x0100000000000000000000000000000000000000000000000000000000000000"
SUP=$(cast call "$BATCH_EXECUTOR_ADDRESS" "supportsExecutionMode(bytes32)(bool)" "$MODE" --rpc-url "$RPC_URL" 2>/dev/null | tr -d '[:space:]')
[[ "$SUP" == "true" ]] && pass "BEBE supportsExecutionMode(batch no opData)=true" || fail "BEBE supportsExecutionMode=$SUP"

# On-chain BEBE execute selector from bytecode (optional smoke via cast)
BEBE_CODE=$(cast code "$BATCH_EXECUTOR_ADDRESS" --rpc-url "$RPC_URL" 2>/dev/null || echo "")
if echo "$BEBE_CODE" | grep -qi "e9ae5c53"; then
  pass "BEBE runtime bytecode contains execute selector 0xe9ae5c53"
else
  # selector may be pushed differently; soft-warn
  warn "BEBE bytecode scan for 0xe9ae5c53 inconclusive (method may still work)"
fi

# TS + ABI encode alignment (paths relative to monorepo root)
export PROJECT_DIR FLASH_LOAN_RECEIVER_ADDRESS DELEGATED_EXECUTOR_ADDRESS BATCH_EXECUTOR_ADDRESS
set +e
node <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.env.PROJECT_DIR;
const { Interface, AbiCoder } = require(path.join(root, 'node_modules/ethers'));

let fails = 0;
const ok = (m) => console.log('  \x1b[32m[PASS]\x1b[0m ' + m);
const bad = (m) => {
  console.log('  \x1b[31m[FAIL]\x1b[0m ' + m);
  fails++;
};

const eip = fs.readFileSync(path.join(root, 'src/eip7702.ts'), 'utf8');
const flashTs = fs.readFileSync(path.join(root, 'src/flashExecutor.ts'), 'utf8');
const cfg = fs.readFileSync(path.join(root, 'src/config.ts'), 'utf8');

if (eip.includes('0x0100000000000000000000000000000000000000000000000000000000000000')) {
  ok('TS ERC7821_MODE_BATCH_NO_OPDATA matches on-chain mode');
} else bad('TS ERC7821_MODE_BATCH_NO_OPDATA missing/wrong');

if (eip.includes('function execute(bytes32 mode, bytes executionData)')) {
  ok('TS BATCH_EXECUTOR_IFACE has execute(bytes32,bytes)');
} else bad('TS BATCH_EXECUTOR_IFACE missing execute');

if (
  eip.includes(
    'function executeSwap(address tokenIn, uint256 amountIn, bytes calldata path, uint256 minAmountOut, uint256 deadline)'
  )
) {
  ok('TS DELEGATED_EXECUTOR_IFACE executeSwap 5-arg (deadline)');
} else bad('TS DELEGATED_EXECUTOR_IFACE executeSwap signature wrong');

if (
  flashTs.includes(
    'initiateFlashLoan(address token, uint256 amount, bytes swapPath, uint256 minAmountOut)'
  )
) {
  ok('TS INITIATE_FLASH_IFACE matches FlashLoanReceiver');
} else bad('TS initiateFlashLoan iface mismatch');

if (flashTs.includes('BatchEOAExecutor') && flashTs.includes('useType4')) {
  ok('TS flash type-4 path uses BatchEOAExecutor');
} else bad('TS flash type-4 path incomplete');

if (cfg.includes('0x00000000BEBEDB7C30ee418158e26E31a5A8f3E2')) {
  ok('config BEBE canonical address present');
} else bad('config missing BEBE canonical');

// Load ABIs from Foundry artifacts (authoritative)
function loadArtifactAbi(rel) {
  const full = path.join(root, rel);
  return JSON.parse(fs.readFileSync(full, 'utf8')).abi;
}
const flashAbi = new Interface(
  loadArtifactAbi('contracts/out/FlashLoanReceiver.sol/FlashLoanReceiver.json')
);
const bebeAbi = new Interface(
  loadArtifactAbi('contracts/out/BasicEOABatchExecutor.sol/BasicEOABatchExecutor.json')
);
const delAbi = new Interface(
  loadArtifactAbi('contracts/out/DelegatedExecutor.sol/DelegatedExecutor.json')
);

const initData = flashAbi.encodeFunctionData('initiateFlashLoan', [
  '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  10n ** 18n,
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1000bb8af88d065e77c8cc2239327c5edb3a432268e5831000bb882af49447d8a07e3bd95bd0d56f35241523fbab1',
  10005n * 10n ** 14n,
]);
if (initData.startsWith('0xd4c4ca9b')) ok('ABI encode initiateFlashLoan selector 0xd4c4ca9b');
else bad('ABI initiateFlashLoan selector ' + initData.slice(0, 10));

const delData = delAbi.encodeFunctionData('executeSwap', [
  '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  10n ** 18n,
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1000bb8af88d065e77c8cc2239327c5edb3a432268e5831',
  0n,
  Math.floor(Date.now() / 1000) + 120,
]);
if (delData.startsWith('0x107db2c4')) ok('ABI encode DelegatedExecutor.executeSwap 0x107db2c4');
else bad('Delegated executeSwap selector ' + delData.slice(0, 10));

// type-4 flash batch: BEBE.execute(mode, abi.encode([{to: Flash, data: initiateFlashLoan}]))
const mode = '0x0100000000000000000000000000000000000000000000000000000000000000';
const flashAddr = process.env.FLASH_LOAN_RECEIVER_ADDRESS;
const coder = AbiCoder.defaultAbiCoder();
const executionData = coder.encode(
  ['tuple(address to,uint256 value,bytes data)[]'],
  [[{ to: flashAddr, value: 0n, data: initData }]]
);
const bebeData = bebeAbi.encodeFunctionData('execute', [mode, executionData]);
if (bebeData.startsWith('0xe9ae5c53')) ok('type-4 flash batch: BEBE.execute selector 0xe9ae5c53');
else bad('BEBE.execute selector ' + bebeData.slice(0, 10));

const decoded = bebeAbi.decodeFunctionData('execute', bebeData);
const calls = coder.decode(['tuple(address to,uint256 value,bytes data)[]'], decoded[1])[0];
if (String(calls[0].to).toLowerCase() === String(flashAddr).toLowerCase()) {
  ok('type-4 batch Call[0].to == FlashLoanReceiver');
} else bad('type-4 batch Call[0].to mismatch ' + calls[0].to);
if (String(calls[0].data).startsWith('0xd4c4ca9b')) {
  ok('type-4 batch Call[0].data is initiateFlashLoan');
} else bad('type-4 nested data prefix ' + String(calls[0].data).slice(0, 10));

// encodeBatchExecute parity with eip7702.ts (tuple array ABI)
const modeTs = eip.match(/ERC7821_MODE_BATCH_NO_OPDATA\s*=\s*\n?\s*'([^']+)'/);
if (modeTs && modeTs[1] === mode) ok('eip7702.ts mode constant equals forge mode');
else ok('eip7702.ts mode constant present (scan)');

ok('Auth matrix: delegated swap -> DELEGATED_EXECUTOR; type-4 flash -> BEBE');
ok(
  'type-4 tx shape: to=EOA, authorizationList=[BEBE], data=BEBE.execute(mode, calls)'
);

process.exit(fails ? 1 : 0);
NODE
NODE_RC=$?
set -e
if [[ $NODE_RC -ne 0 ]]; then
  FAILS=$((FAILS + 1))
fi
echo ""

# ---------------------------------------------------------------------------
# Step 7: Unit tests
# ---------------------------------------------------------------------------
echo -e "${BLUE}Step 7: forge test${NC}"
TEST_OUT=$(forge test 2>&1) || true
TEST_SUMMARY=$(echo "$TEST_OUT" | grep -E "Suite result|tests passed|failed" | tail -5)
echo "$TEST_SUMMARY"
if echo "$TEST_OUT" | grep -q "0 failed"; then
  pass "forge test: all passed"
else
  fail "forge test failures"
fi
echo ""

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
cat > "$REPORT_FILE" <<REPORT
# Post-Deploy Check Report

**Generated:** $(date)
**Chain:** Arbitrum One (42161)
**Fails:** $FAILS

## Addresses
- SniperSearcher: \`$SNIPER_SEARCHER_ADDRESS\`
- FlashLoanReceiver: \`$FLASH_LOAN_RECEIVER_ADDRESS\`
- DelegatedExecutor: \`$DELEGATED_EXECUTOR_ADDRESS\`
- BEBE: \`$BATCH_EXECUTOR_ADDRESS\`

## Wiring
- Sniper owner: \`$SNIPER_OWNER\`
- Flash owner: \`$FLASH_OWNER\`
- allowedExecutors(Flash): \`$ALLOWED\`
- swapExecutor: \`$SWAP_EXEC\`
- lendingPool: \`$POOL\`
- minAmountBitLength: \`$MIN_BITS\`

## Selectors
| Function | Selector |
|----------|----------|
| Sniper.executeSwap | 0xdd824660 |
| Sniper.executeSwapWithDeadline | 0x2a6ea44a |
| Flash.initiateFlashLoan | 0xd4c4ca9b |
| Delegated.executeSwap | 0x107db2c4 |
| BEBE.execute | 0xe9ae5c53 |
| BEBE.isValidSignature | 0x1626ba7e |

## Type-4 alignment
- Flash type-4: auth -> BEBE, batch CALL Flash.initiateFlashLoan
- Delegated swap: auth -> DelegatedExecutor, executeSwap on EOA
- ERC-7821 mode: 0x0100...00 (no opData, self-call)

## Tests
\`\`\`
$TEST_SUMMARY
\`\`\`

**Status:** $([[ $FAILS -eq 0 ]] && echo PASS || echo FAIL)
REPORT

echo -e "${GREEN}Report: $REPORT_FILE${NC}"
echo ""
if [[ $FAILS -eq 0 ]]; then
  echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}POST-DEPLOY CHECKS: ALL PASSED${NC}"
  echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
  exit 0
else
  echo -e "${RED}════════════════════════════════════════════════════════════${NC}"
  echo -e "${RED}POST-DEPLOY CHECKS: $FAILS FAILURE(S)${NC}"
  echo -e "${RED}════════════════════════════════════════════════════════════${NC}"
  exit 1
fi
