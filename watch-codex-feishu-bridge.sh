#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
START_SCRIPT="$ROOT/start-codex-feishu-bridge.sh"
STOP_SCRIPT="$ROOT/stop-codex-feishu-bridge.sh"

NAME=""
LARK_PROFILE=""
WORKSPACE=""
SANDBOX="danger-full-access"
RUN_MODE="app-server"
REASONING="xhigh"
EVENT_KEYS="im.message.receive_v1"
CODEX_TIMEOUT_SECONDS="0"
CODEX_IDLE_TIMEOUT_SECONDS="3600"
RESTART_COOLDOWN_SECONDS="60"
WATCHDOG_TIMEOUT_SECONDS="180"
DISABLE_MCP="0"

usage() {
  cat <<'EOF'
Usage:
  ./watch-codex-feishu-bridge.sh --name codex-assistant-1 [options]

Options:
  --name <name>
  --lark-profile <name>
  --workspace <path>
  --sandbox <value>
  --run-mode <app-server|auto|exec>
  --reasoning <value>
  --event-keys <keys>
  --codex-timeout-seconds <n>
  --codex-idle-timeout-seconds <n>
  --restart-cooldown-seconds <n>
  --watchdog-timeout-seconds <n>
  --disable-mcp
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
    --event-keys|-EventKeys)
      EVENT_KEYS="${2:-}"; shift 2 ;;
    --codex-timeout-seconds|-CodexTimeoutSeconds)
      CODEX_TIMEOUT_SECONDS="${2:-}"; shift 2 ;;
    --codex-idle-timeout-seconds|-CodexIdleTimeoutSeconds)
      CODEX_IDLE_TIMEOUT_SECONDS="${2:-}"; shift 2 ;;
    --restart-cooldown-seconds)
      RESTART_COOLDOWN_SECONDS="${2:-}"; shift 2 ;;
    --watchdog-timeout-seconds)
      WATCHDOG_TIMEOUT_SECONDS="${2:-}"; shift 2 ;;
    --disable-mcp)
      DISABLE_MCP="1"; shift ;;
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
LOCK_DIR="$STATE_DIR/watchdog.lock"
LOG_FILE="$LOG_DIR/watchdog.log"
LAST_RESTART_FILE="$STATE_DIR/watchdog-last-restart.txt"

mkdir -p "$STATE_DIR" "$LOG_DIR"

log_line() {
  printf '%s %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$*" >> "$LOG_FILE"
}

lock_age_seconds() {
  local modified now
  if modified="$(stat -f %m "$LOCK_DIR" 2>/dev/null)"; then
    :
  elif modified="$(stat -c %Y "$LOCK_DIR" 2>/dev/null)"; then
    :
  else
    return 1
  fi
  now="$(date +%s)"
  printf '%s\n' "$((now - modified))"
}

if [[ -d "$LOCK_DIR" ]]; then
  LOCK_AGE="$(lock_age_seconds || echo 0)"
  if [[ "$WATCHDOG_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] && (( WATCHDOG_TIMEOUT_SECONDS > 0 && LOCK_AGE >= WATCHDOG_TIMEOUT_SECONDS )); then
    rm -rf "$LOCK_DIR"
    log_line "removed stale watchdog lock age=${LOCK_AGE}s"
  else
    log_line "watchdog skipped because lock exists age=${LOCK_AGE}s"
    exit 0
  fi
fi
mkdir "$LOCK_DIR"
printf '%s\n' "$$" > "$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR" 2>/dev/null || true' EXIT

bridge_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid_text
  pid_text="$(tr -d '[:space:]' < "$PID_FILE" || true)"
  [[ "$pid_text" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid_text" 2>/dev/null || return 1
  local cmd
  cmd="$(ps -p "$pid_text" -o command= 2>/dev/null || true)"
  [[ "$cmd" == *codex-feishu-bridge* ]] || return 1
  printf '%s' "$pid_text"
}

lark_cli_bin() {
  if [[ -n "${LARK_CLI_BIN:-}" ]]; then
    printf '%s' "$LARK_CLI_BIN"
    return
  fi
  command -v lark-cli 2>/dev/null || true
}

run_with_timeout() {
  local timeout_seconds="$1"
  shift
  local tmp pid elapsed status
  tmp="$(mktemp)"
  "$@" >"$tmp" 2>&1 &
  pid="$!"
  elapsed=0
  while kill -0 "$pid" 2>/dev/null; do
    if [[ "$timeout_seconds" =~ ^[0-9]+$ ]] && (( timeout_seconds > 0 && elapsed >= timeout_seconds )); then
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      cat "$tmp"
      rm -f "$tmp"
      return 124
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  status=0
  wait "$pid" || status="$?"
  cat "$tmp"
  rm -f "$tmp"
  return "$status"
}

test_lark_consumer() {
  local lark_cli
  lark_cli="$(lark_cli_bin)"
  if [[ -z "$lark_cli" ]]; then
    printf '%s' "lark-cli not found"
    return 1
  fi

  local args=()
  if [[ -n "$LARK_PROFILE" ]]; then
    args+=(--profile "$LARK_PROFILE")
  fi
  args+=(event status)
  if [[ -n "$LARK_PROFILE" ]]; then
    args+=(--current)
  fi
  args+=(--json)

  local output
  local status_code
  set +e
  output="$(run_with_timeout 15 "$lark_cli" "${args[@]}")"
  status_code="$?"
  set -e

  if printf '%s' "$output" | EXPECTED_EVENT_KEYS="$EVENT_KEYS" node -e '
let input = "";
const expected = String(process.env.EXPECTED_EVENT_KEYS || "im.message.receive_v1")
  .split(/[,\s;]+/)
  .map((item) => item.trim())
  .filter(Boolean);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(input);
    const running = new Set();
    for (const app of parsed.apps || []) {
      if (!app.running) continue;
      for (const consumer of app.consumers || []) {
        if (consumer.event_key) running.add(String(consumer.event_key));
      }
    }
    if (expected.every((key) => running.has(key))) process.exit(0);
  } catch {}
  process.exit(1);
});
'; then
    printf '%s' "consumer ok"
    return 0
  fi

  if [[ "$status_code" == "124" ]]; then
    printf '%s' "lark-cli status timed out"
    return 1
  fi
  if [[ "$status_code" != "0" ]]; then
    printf 'lark-cli status failed: %s' "$output"
    return 1
  fi

  printf 'missing consumer for expected events: %s' "$EVENT_KEYS"
  return 1
}

recent_restart_cooldown() {
  [[ -f "$LAST_RESTART_FILE" ]] || return 1
  local last now
  last="$(cat "$LAST_RESTART_FILE" 2>/dev/null || echo 0)"
  now="$(date +%s)"
  [[ "$last" =~ ^[0-9]+$ ]] || return 1
  (( now - last < RESTART_COOLDOWN_SECONDS ))
}

restart_bridge() {
  local reason="$1"
  if recent_restart_cooldown; then
    log_line "restart skipped during cooldown; reason=$reason"
    return
  fi

  log_line "restart begin; reason=$reason"
  date +%s > "$LAST_RESTART_FILE"

  "$STOP_SCRIPT" --name "$SAFE_NAME" >> "$LOG_FILE" 2>&1 || true

  local args=(
    --name "$SAFE_NAME"
    --workspace "$WORKSPACE"
    --sandbox "$SANDBOX"
    --run-mode "$RUN_MODE"
    --reasoning "$REASONING"
    --event-keys "$EVENT_KEYS"
    --codex-timeout-seconds "$CODEX_TIMEOUT_SECONDS"
    --codex-idle-timeout-seconds "$CODEX_IDLE_TIMEOUT_SECONDS"
  )
  if [[ -n "$LARK_PROFILE" ]]; then
    args+=(--lark-profile "$LARK_PROFILE")
  fi
  if [[ "$DISABLE_MCP" == "1" ]]; then
    args+=(--disable-mcp)
  fi

  "$START_SCRIPT" "${args[@]}" >> "$LOG_FILE" 2>&1 || true

  local pid consumer deadline
  deadline=$(( $(date +%s) + 60 ))
  pid=""
  consumer="not checked yet"
  while (( $(date +%s) < deadline )); do
    pid="$(bridge_pid || true)"
    consumer="$(test_lark_consumer || true)"
    if [[ -n "$pid" && "$consumer" == "consumer ok" ]]; then
      break
    fi
    sleep 2
  done
  if [[ -n "$pid" && "$consumer" == "consumer ok" ]]; then
    log_line "restart ok; bridgePid=$pid; $consumer"
  else
    log_line "restart incomplete; bridgePid=${pid:-none}; consumer=$consumer"
  fi
}

BRIDGE_PID="$(bridge_pid || true)"
CONSUMER_STATUS="$(test_lark_consumer || true)"

if [[ -z "$BRIDGE_PID" ]]; then
  restart_bridge "bridge not running"
elif [[ "$CONSUMER_STATUS" != "consumer ok" ]]; then
  restart_bridge "$CONSUMER_STATUS"
else
  log_line "healthy; bridgePid=$BRIDGE_PID; $CONSUMER_STATUS"
fi
