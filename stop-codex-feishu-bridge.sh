#!/usr/bin/env bash
set -euo pipefail

NAME=""

usage() {
  cat <<'EOF'
Usage:
  ./stop-codex-feishu-bridge.sh [--name codex-assistant-1]
EOF
}

safe_name() {
  local raw="$1"
  local safe
  safe="$(printf '%s' "$raw" | sed -E 's/[^A-Za-z0-9_.-]+/-/g; s/^-+//; s/-+$//')"
  if [[ -z "$safe" ]]; then
    echo "Instance name contains no usable characters: $raw" >&2
    exit 1
  fi
  printf '%s' "$safe"
}

data_root_base() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    printf '%s\n' "$HOME/Library/Application Support/CodexFeishuBridge"
  else
    printf '%s\n' "${XDG_STATE_HOME:-$HOME/.local/state}/codex-feishu-bridge"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name|-Name)
      NAME="${2:-}"; shift 2 ;;
    --help|-h)
      usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1 ;;
  esac
done

BASE_DATA_ROOT="$(data_root_base)"
if [[ -n "$NAME" ]]; then
  SAFE_NAME="$(safe_name "$NAME")"
  DATA_ROOT="$BASE_DATA_ROOT/instances/$SAFE_NAME"
else
  SAFE_NAME=""
  DATA_ROOT="$BASE_DATA_ROOT"
fi

STATE_DIR="$DATA_ROOT/state"
PID_FILE="$STATE_DIR/bridge.pid"
STOP_FILE="$STATE_DIR/bridge.stop"

if [[ ! -f "$PID_FILE" ]]; then
  echo "Codex Feishu Bridge is not running: no PID file found. Instance: ${SAFE_NAME:-default}"
  exit 0
fi

PID_TEXT="$(tr -d '[:space:]' < "$PID_FILE" || true)"
if [[ ! "$PID_TEXT" =~ ^[0-9]+$ ]]; then
  rm -f "$PID_FILE"
  echo "Removed invalid PID file."
  exit 0
fi

if ! kill -0 "$PID_TEXT" 2>/dev/null; then
  rm -f "$PID_FILE"
  echo "Bridge process was not running. Removed stale PID file."
  exit 0
fi

date -u +"%Y-%m-%dT%H:%M:%SZ" > "$STOP_FILE"

for _ in {1..10}; do
  sleep 1
  if ! kill -0 "$PID_TEXT" 2>/dev/null; then
    rm -f "$PID_FILE" "$STOP_FILE"
    echo "Codex Feishu Bridge stopped. Instance: ${SAFE_NAME:-default}; PID: $PID_TEXT"
    exit 0
  fi
done

echo "Bridge did not stop gracefully in 10 seconds; terminating process $PID_TEXT." >&2
kill -TERM "$PID_TEXT" 2>/dev/null || true
sleep 2
kill -KILL "$PID_TEXT" 2>/dev/null || true
rm -f "$PID_FILE" "$STOP_FILE"
echo "Codex Feishu Bridge force-stopped. Instance: ${SAFE_NAME:-default}; PID: $PID_TEXT"
