#!/usr/bin/env bash
#
# deploy.sh — full production deploy runbook for the multi-venue / dual-ABI contracts.
#
# Runs, in order, with a typed confirmation gate before anything is broadcast:
#   1. Deploy.s.sol      (--broadcast)   -> SniperSearcher, DelegatedExecutor, FlashLoanReceiver
#   2. reads the 3 new addresses from the broadcast artifact
#   3. Configure.s.sol   (--broadcast)   -> allowExecutor / allowEOA / router-flag wiring
#   4. Verify.s.sol      (read-only)     -> hard-fails on any wiring/constructor mismatch
#   5. propagates the new addresses into .env and (mainnet only) DeployRegistry.sol
#
# Reads PRIVATE_KEY / <chain>_RPC_URL from the environment. forge reads the key itself;
# this script never references, echoes, or logs the key value.
#
# Usage:
#   ./scripts/deploy.sh              # arbitrum one (default) — REAL funds
#   ./scripts/deploy.sh sepolia      # arbitrum sepolia testnet
#
# Recommended: run ./scripts/simulate-deploy.sh first (no broadcast).
#
set -euo pipefail
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

NETWORK="${1:-arbitrum}"
case "$NETWORK" in
  arbitrum) RPC_ALIAS=arbitrum;         CHAIN_ID=42161;  RPC_VAR=ARBITRUM_RPC_URL;;
  sepolia)  RPC_ALIAS=arbitrum_sepolia; CHAIN_ID=421614; RPC_VAR=ARBITRUM_SEPOLIA_RPC_URL;;
  *) echo "usage: $0 [arbitrum|sepolia]" >&2; exit 2;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENVFILE="$ROOT/.env"

if [ -f "$ENVFILE" ]; then set +e; set -a; . "$ENVFILE" >/dev/null 2>&1; set +a; set -e; fi

# ---- preflight ----------------------------------------------------------------
command -v forge >/dev/null || { echo "forge not found (install foundry)" >&2; exit 1; }
command -v cast  >/dev/null || { echo "cast not found (install foundry)"  >&2; exit 1; }
command -v node  >/dev/null || { echo "node not found" >&2; exit 1; }
[ -n "${PRIVATE_KEY:-}" ] || { echo "PRIVATE_KEY not set in env/.env" >&2; exit 1; }
RPC_URL="$(eval printf '%s' "\${$RPC_VAR:-}")"
[ -n "$RPC_URL" ] || { echo "$RPC_VAR not set in env/.env" >&2; exit 1; }

cd "$ROOT/contracts"

echo "=============================================================="
echo " DEPLOY  ($NETWORK / expected chain $CHAIN_ID)"
echo "=============================================================="
LIVE_CHAIN="$(cast chain-id --rpc-url "$RPC_ALIAS")"
[ "$LIVE_CHAIN" = "$CHAIN_ID" ] || { echo "RPC chain-id $LIVE_CHAIN != expected $CHAIN_ID — check $RPC_VAR. Aborting." >&2; exit 1; }
echo "  chain-id OK: $LIVE_CHAIN"
if [ "$NETWORK" = arbitrum ]; then
  echo "  *** THIS IS ARBITRUM MAINNET — REAL FUNDS, IRREVERSIBLE ***"
fi
echo "  Ensure: (a) the deployer key is the intended contract OWNER, and"
echo "          (b) any running bot is STOPPED so it can't act mid-migration."
echo

read -r -p "Type 'deploy $NETWORK' to broadcast: " CONFIRM
[ "$CONFIRM" = "deploy $NETWORK" ] || { echo "Aborted — no transactions sent." >&2; exit 1; }

# ---- 1. deploy ----------------------------------------------------------------
echo
echo "== [1/5] Deploy =="
forge script script/Deploy.s.sol --rpc-url "$RPC_ALIAS" --broadcast

# ---- 2. read addresses from broadcast artifact --------------------------------
BC="broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json"
[ -f "$BC" ] || { echo "broadcast artifact not found at $BC — cannot read addresses" >&2; exit 1; }

read_addr() {
  # prints the CREATE address for a given contractName, or exits non-zero
  node -e '
    const j = require(process.argv[1]);
    const n = process.argv[2];
    const t = (j.transactions || []).find(x => x.contractName === n && x.contractAddress);
    if (!t) { process.stderr.write("no CREATE for " + n + " in broadcast\n"); process.exit(1); }
    process.stdout.write(t.contractAddress);
  ' "$BC" "$1"
}

SNIPER="$(read_addr SniperSearcher)"       || exit 1
DELEGATED="$(read_addr DelegatedExecutor)" || exit 1
FLASH="$(read_addr FlashLoanReceiver)"     || exit 1
# checksum
SNIPER="$(cast to-check-sum-address "$SNIPER")"
DELEGATED="$(cast to-check-sum-address "$DELEGATED")"
FLASH="$(cast to-check-sum-address "$FLASH")"

echo
echo "  Deployed:"
echo "    SniperSearcher   = $SNIPER"
echo "    FlashLoanReceiver= $FLASH"
echo "    DelegatedExecutor= $DELEGATED"

export SNIPER_SEARCHER_ADDRESS="$SNIPER"
export FLASH_LOAN_RECEIVER_ADDRESS="$FLASH"
export DELEGATED_EXECUTOR_ADDRESS="$DELEGATED"

# ---- 3. configure -------------------------------------------------------------
echo
echo "== [2/5] Configure =="
forge script script/Configure.s.sol --rpc-url "$RPC_ALIAS" --broadcast

# ---- 4. verify ----------------------------------------------------------------
echo
echo "== [3/5] Verify =="
forge script script/Verify.s.sol --rpc-url "$RPC_ALIAS"

# ---- 5. propagate addresses ---------------------------------------------------
echo
echo "== [4/5] Update .env =="
set_env() {
  local k="$1" v="$2"
  if grep -qE "^${k}=" "$ENVFILE" 2>/dev/null; then
    sed -i.bak -E "s#^${k}=.*#${k}=${v}#" "$ENVFILE" && rm -f "$ENVFILE.bak"
  else
    printf '%s=%s\n' "$k" "$v" >> "$ENVFILE"
  fi
  echo "    $k=$v"
}
set_env SNIPER_SEARCHER_ADDRESS   "$SNIPER"
set_env FLASH_LOAN_RECEIVER_ADDRESS "$FLASH"
set_env DELEGATED_EXECUTOR_ADDRESS  "$DELEGATED"

if [ "$NETWORK" = arbitrum ]; then
  echo
  echo "== [5/5] Update DeployRegistry.sol production constants =="
  REG="src/DeployRegistry.sol"
  sed -i.bak -E "s#(address internal constant SNIPER_SEARCHER = )0x[a-fA-F0-9]{40};#\1${SNIPER};#"       "$REG"
  sed -i.bak -E "s#(address internal constant FLASH_LOAN_RECEIVER = )0x[a-fA-F0-9]{40};#\1${FLASH};#"     "$REG"
  sed -i.bak -E "s#(address internal constant DELEGATED_EXECUTOR = )0x[a-fA-F0-9]{40};#\1${DELEGATED};#"  "$REG"
  rm -f "$REG.bak"
  echo "    SNIPER_SEARCHER / FLASH_LOAN_RECEIVER / DELEGATED_EXECUTOR updated in $REG"
else
  echo
  echo "== [5/5] Skipping DeployRegistry.sol update (testnet run) =="
fi

echo
echo "=============================================================="
echo " DONE — deployed, configured, verified, addresses propagated."
echo "=============================================================="
echo " Next:"
echo "   - git add .env contracts/src/DeployRegistry.sol && git commit && git push"
echo "     (note: .env is usually gitignored — commit DeployRegistry.sol; keep .env local)"
echo "   - restart the bot so it picks up the new *_ADDRESS values"
echo "   - (optional) verify sources on Arbiscan: set ARBISCAN_API_KEY and re-run Deploy"
echo "     with --verify, or use 'forge verify-contract' per contract."
