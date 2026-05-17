#!/usr/bin/env bash
# Aggregato — full demo in one command
#
# Default mode  (no env)  : runs against a local substrate-contracts-node, which
#                           is API-compatible with a modern Portaldot runtime.
# Remote mode (PORTALDOT_WS): points at a public Portaldot endpoint when one is
#                           published. CONTRACT_ADDRESS may be supplied to skip
#                           the deploy step.
#
# Note: the Portaldot dev binary at portaldotVolunteer/Portaldot-node ships a
# 2020-era pallet-contracts (schedule v4, pre-rent-removal) which cannot host
# ink! 4+ contracts. The dashboard surfaces a "local DEV node" banner whenever
# the active endpoint is not a remote Portaldot RPC, so the demo never claims
# something it isn't.
#
# Usage:
#   ./demo.sh            # 2 chunks (default), plain 1..N preimages
#   ./demo.sh 4          # 4 chunks
#   ./demo.sh 8          # 8 chunks
#   ./demo.sh 4 demo_data/txs_32.json   # use a real-looking rollup tx batch
#   PORTALDOT_WS=wss://... CONTRACT_ADDRESS=5xxx ./demo.sh   # remote testnet

set -euo pipefail

NUM_CHUNKS="${1:-2}"
DATASET="${2:-}"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Colors ────────────────────────────────────────────────────────────────────
G="\033[0;32m"; Y="\033[0;33m"; B="\033[0;34m"; R="\033[0m"

echo -e "${B}=== Aggregato Demo (${NUM_CHUNKS} chunks) ===${R}"

# ── 1. Local node ─────────────────────────────────────────────────────────────
if [ -z "${PORTALDOT_WS:-}" ]; then
  echo -e "${B}[mode] local — substrate-contracts-node (set PORTALDOT_WS for remote)${R}"
  if ! command -v substrate-contracts-node &>/dev/null; then
    echo -e "${Y}[node] substrate-contracts-node not found — install it first:${R}"
    echo "  curl -L https://github.com/paritytech/substrate-contracts-node/releases/download/v0.41.0/substrate-contracts-node-linux.tar.gz | tar -xz -C /tmp/"
    echo "  cp /tmp/artifacts/substrate-contracts-node-linux/substrate-contracts-node ~/.cargo/bin/"
    exit 1
  fi

  echo -e "${B}[node] Starting local substrate-contracts-node...${R}"
  pkill -f substrate-contracts-node 2>/dev/null || true
  sleep 1
  substrate-contracts-node --dev --tmp >/tmp/scn.log 2>&1 &
  SCN_PID=$!
  sleep 3
  echo -e "${G}[node] Running (ws://127.0.0.1:9944)${R}"

  PORTALDOT_WS="ws://127.0.0.1:9944"
else
  echo -e "${B}[mode] remote — using PORTALDOT_WS=${PORTALDOT_WS}${R}"
fi

cleanup() {
  [ -n "${DASH_PID:-}" ] && kill "$DASH_PID" 2>/dev/null || true
  [ -n "${SCN_PID:-}" ] && kill "$SCN_PID" 2>/dev/null || true
}
trap cleanup EXIT

# ── 2. Deploy contract (if no address given) ──────────────────────────────────
if [ -z "${CONTRACT_ADDRESS:-}" ]; then
  echo -e "${B}[deploy] Deploying Ink! contract...${R}"

  SALT="0x$(date +%s | xxd -p | head -c 16)"
  DEPLOY_OUT=$(cargo contract instantiate \
    --url "$PORTALDOT_WS" \
    --constructor new \
    --args 0x189dac29296d31814dc8c56cf3d36a0543372bba7538fa322a4aebfebc39e056 \
    --suri "//Alice" \
    --salt "$SALT" \
    --execute \
    --skip-confirm \
    "$REPO_DIR/contracts/aggregato_verifier/target/ink/aggregato_verifier.contract" 2>&1)

  CONTRACT_ADDRESS=$(echo "$DEPLOY_OUT" | grep -oP '(?<=Contract )\S+' | head -1)
  if [ -z "$CONTRACT_ADDRESS" ]; then
    echo -e "${Y}[deploy] Could not parse contract address from output:${R}"
    echo "$DEPLOY_OUT"
    exit 1
  fi
  echo -e "${G}[deploy] Contract: $CONTRACT_ADDRESS${R}"
fi

export PORTALDOT_WS CONTRACT_ADDRESS

# ── 3. Start dashboard ────────────────────────────────────────────────────────
echo -e "${B}[dashboard] Starting at http://localhost:3000 ...${R}"
cd "$REPO_DIR/frontend"
npm run dev &>/tmp/dashboard.log &
DASH_PID=$!
sleep 2
echo -e "${G}[dashboard] http://localhost:3000  (run: http://localhost:3000/run.html)${R}"

# ── 4. Run orchestrator ───────────────────────────────────────────────────────
if [ -n "$DATASET" ]; then
  # Resolve relative paths against the repo root so the orchestrator can find it.
  case "$DATASET" in
    /*) DATASET_ABS="$DATASET" ;;
    *)  DATASET_ABS="$REPO_DIR/$DATASET" ;;
  esac
  echo -e "${B}[orchestrator] Proving ${NUM_CHUNKS} chunks with dataset ${DATASET}...${R}"
  cd "$REPO_DIR/orchestrator"
  cargo run -- "$NUM_CHUNKS" --dataset "$DATASET_ABS"
else
  echo -e "${B}[orchestrator] Proving ${NUM_CHUNKS} chunks (default 1..N preimages)...${R}"
  cd "$REPO_DIR/orchestrator"
  cargo run -- "$NUM_CHUNKS"
fi

echo ""
echo -e "${G}=== Demo complete ===${R}"
echo -e "  Dashboard: http://localhost:3000"
echo -e "  Contract:  $CONTRACT_ADDRESS"
echo -e "${Y}Press Ctrl+C to stop node & dashboard${R}"
wait $DASH_PID
