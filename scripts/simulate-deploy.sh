#!/usr/bin/env bash
#
# simulate-deploy.sh — DRY RUN of the contract deployment (NO broadcast, no state change).
#
# Simulates Deploy.s.sol against live chain state so you can confirm it compiles, the
# constructor args resolve, and it would succeed — before spending any real gas.
# Reads PRIVATE_KEY / ARBITRUM_RPC_URL from the environment (forge reads the key itself;
# this script never references or prints it).
#
# Usage:
#   ./scripts/simulate-deploy.sh              # arbitrum one (default)
#   ./scripts/simulate-deploy.sh sepolia      # arbitrum sepolia
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

# Best-effort load .env into the environment for forge (tolerate odd lines).
if [ -f "$ENVFILE" ]; then set +e; set -a; . "$ENVFILE" >/dev/null 2>&1; set +a; set -e; fi

command -v forge >/dev/null || { echo "forge not found (install foundry)" >&2; exit 1; }
command -v cast  >/dev/null || { echo "cast not found (install foundry)"  >&2; exit 1; }
[ -n "${PRIVATE_KEY:-}" ] || { echo "PRIVATE_KEY not set in env/.env" >&2; exit 1; }
RPC_URL="$(eval printf '%s' "\${$RPC_VAR:-}")"
[ -n "$RPC_URL" ] || { echo "$RPC_VAR not set in env/.env" >&2; exit 1; }

cd "$ROOT/contracts"

echo "== Simulate deploy ($NETWORK / expected chain $CHAIN_ID) — NO broadcast =="
LIVE_CHAIN="$(cast chain-id --rpc-url "$RPC_ALIAS")"
[ "$LIVE_CHAIN" = "$CHAIN_ID" ] || { echo "RPC chain-id $LIVE_CHAIN != expected $CHAIN_ID — check $RPC_VAR" >&2; exit 1; }
echo "  chain-id OK: $LIVE_CHAIN"
echo

# No --broadcast: forge simulates only. Fails loudly if it would revert or underfund.
forge script script/Deploy.s.sol --rpc-url "$RPC_ALIAS"

echo
echo "[OK] Simulation complete — nothing was broadcast. If the above shows the 3 contract"
echo "     addresses and 'ONCHAIN EXECUTION COMPLETE' style summary, you're clear to run"
echo "     ./scripts/deploy.sh $NETWORK"
