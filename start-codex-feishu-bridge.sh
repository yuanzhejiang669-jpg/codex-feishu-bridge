#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$ROOT/codex-feishu-bridge.mjs"

NAME=""
LARK_PROFILE=""
WORKSPACE=""
SANDBOX="danger-full-access"
RUN_MODE="app-server"
REASONING="xhigh"
CODEX_TIMEOUT_SECONDS="0"
CODEX_IDLE_TIMEOUT_SECONDS="3600"
MAX_CONCURRENT="1"
CARD_THROTTLE_MS="400"
CARD_MODE="1"
CARD_DEBUG="0"
SHOW_FINAL_STEPS="1"
REPLY_TO_MESSAGE="0"
REPLY_IN_THREAD="0"
DISABLE_MCP="0"
FOREGROUND="0"

usage() {
  cat <<'EOF'
Usage:
  ./start-codex-feishu-bridge.sh --name codex-assistant-1 [options]

Options:
  --name <name>                    Instance name.
  --lark-profile <name>            lark-cli profile name.
  --workspace <path>               Defaults to ~/Documents/Codex/workspaces/feishu-bridge-<name>.
  --sandbox <value>                Defaults to danger-full-access.
  --run-mode <app-server|auto|exec>
  --reasoning <value>              Defaults to xhigh.
  --codex-timeout-seconds <n>      Defaults to 0 (disabled).
  --codex-idle-timeout-seconds <n> Defaults to 3600.
  --max-concurrent <n>             Defaults to 1.
  --card-throttle-ms <n>           Defaults to 400.
  --no-card
  --debug-cards
  --hide-final-steps
  --reply-to-message
  --thread-reply
  --no-thread-reply
  --disable-mcp
  --enable-mcp
  --foreground                     Run in the foreground.
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
    --lark-profile|-LarkProfile)
      LARK_PROFILE="${2:-}"; shift 2 ;;
    --workspace|-Workspace)
      WORKSPACE="${2:-}"; shift 2 ;;
    --sandbox|-Sandbox)
      SANDBOX="${2:-}"; shift 2 ;;
    --run-mode|-RunMode)
      RUN_MODE="${2:-}"; shift 2 ;;
    --reasoning|-Reasoning)
      REASONING="${2:-}"; shift 2 ;;
    --codex-timeout-seconds|-CodexTimeoutSeconds)
      CODEX_TIMEOUT_SECONDS="${2:-}"; shift 2 ;;
    --codex-idle-timeout-seconds|-CodexIdleTimeoutSeconds)
      CODEX_IDLE_TIMEOUT_SECONDS="${2:-}"; shift 2 ;;
    --max-concurrent|-MaxConcurrent)
      MAX_CONCURRENT="${2:-}"; shift 2 ;;
    --card-throttle-ms|-CardThrottleMs)
      CARD_THROTTLE_MS="${2:-}"; shift 2 ;;
    --no-card)
      CARD_MODE="0"; shift ;;
    --debug-cards)
      CARD_DEBUG="1"; shift ;;
    --show-final-steps)
      SHOW_FINAL_STEPS="1"; shift ;;
    --hide-final-steps)
      SHOW_FINAL_STEPS="0"; shift ;;
    --reply-to-message)
      REPLY_TO_MESSAGE="1"; shift ;;
    --thread-reply)
      REPLY_IN_THREAD="1"; shift ;;
    --no-thread-reply)
      REPLY_IN_THREAD="0"; shift ;;
    --disable-mcp)
      DISABLE_MCP="1"; shift ;;
    --enable-mcp)
      DISABLE_MCP="0"; shift ;;
    --foreground)
      FOREGROUND="1"; shift ;;
    --help|-h)
      usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1 ;;
  esac
done

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"

BASE_DATA_ROOT="$(data_root_base)"
if [[ -n "$NAME" ]]; then
  SAFE_NAME="$(safe_name "$NAME")"
  DATA_ROOT="$BASE_DATA_ROOT/instances/$SAFE_NAME"
  if [[ -z "$WORKSPACE" ]]; then
    WORKSPACE="$HOME/Documents/Codex/workspaces/feishu-bridge-$SAFE_NAME"
  fi
else
  SAFE_NAME=""
  DATA_ROOT="$BASE_DATA_ROOT"
  if [[ -z "$WORKSPACE" ]]; then
    WORKSPACE="$HOME/Documents/Codex/workspaces/feishu-bridge"
  fi
fi

STATE_DIR="$DATA_ROOT/state"
LOG_DIR="$DATA_ROOT/logs"
PID_FILE="$STATE_DIR/bridge.pid"
STDOUT_LOG="$LOG_DIR/bridge.stdout.log"
STDERR_LOG="$LOG_DIR/bridge.stderr.log"

mkdir -p "$STATE_DIR" "$LOG_DIR" "$WORKSPACE"

if [[ -f "$PID_FILE" ]]; then
  EXISTING_PID="$(tr -d '[:space:]' < "$PID_FILE" || true)"
  if [[ "$EXISTING_PID" =~ ^[0-9]+$ ]] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "Codex Feishu Bridge is already running. PID: $EXISTING_PID"
    echo "Log: $STDOUT_LOG"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

if [[ -n "${CODEX_CLI_BIN:-}" ]]; then
  if [[ ! -x "$CODEX_CLI_BIN" && ! -f "$CODEX_CLI_BIN" ]]; then
    echo "Warning: CODEX_CLI_BIN is set but not found: $CODEX_CLI_BIN" >&2
  fi
elif command -v codex >/dev/null 2>&1; then
  export CODEX_CLI_BIN="$(command -v codex)"
fi

if [[ -z "${LARK_CLI_BIN:-}" ]] && command -v lark-cli >/dev/null 2>&1; then
  export LARK_CLI_BIN="$(command -v lark-cli)"
fi

export CODEX_FEISHU_WORKSPACE="$(cd "$WORKSPACE" && pwd)"
export CODEX_FEISHU_INSTANCE_NAME="${SAFE_NAME:-default}"
if [[ -n "$LARK_PROFILE" ]]; then
  export CODEX_FEISHU_LARK_PROFILE="$LARK_PROFILE"
else
  unset CODEX_FEISHU_LARK_PROFILE || true
fi
export CODEX_FEISHU_SANDBOX="$SANDBOX"
export CODEX_FEISHU_RUN_MODE="$RUN_MODE"
if [[ -n "$REASONING" ]]; then
  export CODEX_FEISHU_REASONING="$REASONING"
else
  unset CODEX_FEISHU_REASONING || true
fi
export CODEX_FEISHU_CODEX_TIMEOUT_MS="$((CODEX_TIMEOUT_SECONDS * 1000))"
export CODEX_FEISHU_CODEX_IDLE_TIMEOUT_MS="$((CODEX_IDLE_TIMEOUT_SECONDS * 1000))"
export CODEX_FEISHU_DISABLE_MCP="$DISABLE_MCP"
export CODEX_FEISHU_MAX_CONCURRENT="$MAX_CONCURRENT"
export CODEX_FEISHU_CARD_MODE="$CARD_MODE"
export CODEX_FEISHU_CARD_THROTTLE_MS="$CARD_THROTTLE_MS"
export CODEX_FEISHU_CARD_DEBUG="$CARD_DEBUG"
export CODEX_FEISHU_SHOW_FINAL_STEPS="$SHOW_FINAL_STEPS"
export CODEX_FEISHU_REPLY_TO_MESSAGE="$REPLY_TO_MESSAGE"
export CODEX_FEISHU_REPLY_IN_THREAD="$REPLY_IN_THREAD"
export CODEX_FEISHU_STATE_DIR="$STATE_DIR"
export CODEX_FEISHU_LOG_DIR="$LOG_DIR"

if [[ "$FOREGROUND" == "1" ]]; then
  exec node "$SCRIPT"
fi

(
  cd "$ROOT"
  nohup node "$SCRIPT" >>"$STDOUT_LOG" 2>>"$STDERR_LOG" &
)

sleep 2
BRIDGE_PID=""
if [[ -f "$PID_FILE" ]]; then
  BRIDGE_PID="$(tr -d '[:space:]' < "$PID_FILE" || true)"
fi
if [[ -z "$BRIDGE_PID" ]]; then
  echo "Bridge started, but PID file has not appeared yet. Check: $STDERR_LOG"
else
  echo "Codex Feishu Bridge started. PID: $BRIDGE_PID"
fi
echo "Instance: ${CODEX_FEISHU_INSTANCE_NAME}"
echo "Lark profile: ${CODEX_FEISHU_LARK_PROFILE:-default/current}"
echo "Workspace: $CODEX_FEISHU_WORKSPACE"
echo "Codex CLI: ${CODEX_CLI_BIN:-codex}"
echo "Run mode: $CODEX_FEISHU_RUN_MODE"
echo "Sandbox: $CODEX_FEISHU_SANDBOX"
echo "Reasoning: ${CODEX_FEISHU_REASONING:-config}"
if [[ "$CODEX_TIMEOUT_SECONDS" -gt 0 ]]; then
  echo "Codex total timeout: ${CODEX_TIMEOUT_SECONDS} seconds"
else
  echo "Codex total timeout: disabled"
fi
if [[ "$CODEX_IDLE_TIMEOUT_SECONDS" -gt 0 ]]; then
  echo "Codex idle timeout: ${CODEX_IDLE_TIMEOUT_SECONDS} seconds"
else
  echo "Codex idle timeout: disabled"
fi
echo "MCP: $([[ "$CODEX_FEISHU_DISABLE_MCP" == "0" ]] && echo enabled || echo disabled)"
echo "Main log: $LOG_DIR/codex-feishu-bridge.log"
echo "Stdout log: $STDOUT_LOG"
echo "Stderr log: $STDERR_LOG"
