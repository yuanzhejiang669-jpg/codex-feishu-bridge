#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WATCHDOG_SCRIPT="$ROOT/watch-codex-feishu-bridge.sh"

NAME=""
LARK_PROFILE=""
WORKSPACE=""
LABEL=""
EVENT_KEYS="im.message.receive_v1"
CODEX_TIMEOUT_SECONDS="0"
CODEX_IDLE_TIMEOUT_SECONDS="3600"
WATCHDOG_TIMEOUT_SECONDS="180"
UNINSTALL="0"

usage() {
  cat <<'EOF'
Usage:
  ./install-codex-feishu-launchd.sh --name codex-assistant-1 [options]

Options:
  --name <name>
  --lark-profile <name>
  --workspace <path>
  --label <launchd-label>
  --event-keys <keys>
  --codex-timeout-seconds <n>
  --codex-idle-timeout-seconds <n>
  --watchdog-timeout-seconds <n>
  --uninstall
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

xml_escape() {
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g"
}

string_item() {
  printf '    <string>%s</string>\n' "$(xml_escape "$1")"
}

env_item() {
  printf '    <key>%s</key>\n    <string>%s</string>\n' "$(xml_escape "$1")" "$(xml_escape "$2")"
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
    --label)
      LABEL="${2:-}"; shift 2 ;;
    --event-keys|-EventKeys)
      EVENT_KEYS="${2:-}"; shift 2 ;;
    --codex-timeout-seconds|-CodexTimeoutSeconds)
      CODEX_TIMEOUT_SECONDS="${2:-}"; shift 2 ;;
    --codex-idle-timeout-seconds|-CodexIdleTimeoutSeconds)
      CODEX_IDLE_TIMEOUT_SECONDS="${2:-}"; shift 2 ;;
    --watchdog-timeout-seconds)
      WATCHDOG_TIMEOUT_SECONDS="${2:-}"; shift 2 ;;
    --uninstall|-Uninstall)
      UNINSTALL="1"; shift ;;
    --help|-h)
      usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1 ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "launchd startup is only supported on macOS." >&2
  exit 1
fi

BASE_DATA_ROOT="$(data_root_base)"
if [[ -n "$NAME" ]]; then
  SAFE_NAME="$(safe_name "$NAME")"
  DATA_ROOT="$BASE_DATA_ROOT/instances/$SAFE_NAME"
  if [[ -z "$WORKSPACE" ]]; then
    WORKSPACE="$HOME/Documents/Codex/workspaces/feishu-bridge-$SAFE_NAME"
  fi
  if [[ -z "$LABEL" ]]; then
    LABEL="com.codex.feishu-bridge.$SAFE_NAME"
  fi
else
  SAFE_NAME=""
  DATA_ROOT="$BASE_DATA_ROOT"
  if [[ -z "$WORKSPACE" ]]; then
    WORKSPACE="$HOME/Documents/Codex/workspaces/feishu-bridge"
  fi
  if [[ -z "$LABEL" ]]; then
    LABEL="com.codex.feishu-bridge"
  fi
fi

STATE_DIR="$DATA_ROOT/state"
LOG_DIR="$DATA_ROOT/logs"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST="$LAUNCH_AGENTS_DIR/$LABEL.plist"

if [[ "$UNINSTALL" == "1" ]]; then
  launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
  launchctl remove "$LABEL" >/dev/null 2>&1 || true
  rm -f "$PLIST"
  echo "Removed launchd agent if it existed: $LABEL"
  exit 0
fi

mkdir -p "$STATE_DIR" "$LOG_DIR" "$WORKSPACE" "$LAUNCH_AGENTS_DIR"

PROGRAM_ARGS=""
PROGRAM_ARGS+="$(string_item "/bin/bash")"
PROGRAM_ARGS+="$(string_item "$WATCHDOG_SCRIPT")"
if [[ -n "$SAFE_NAME" ]]; then
  PROGRAM_ARGS+="$(string_item "--name")"
  PROGRAM_ARGS+="$(string_item "$SAFE_NAME")"
fi
if [[ -n "$LARK_PROFILE" ]]; then
  PROGRAM_ARGS+="$(string_item "--lark-profile")"
  PROGRAM_ARGS+="$(string_item "$LARK_PROFILE")"
fi
PROGRAM_ARGS+="$(string_item "--workspace")"
PROGRAM_ARGS+="$(string_item "$WORKSPACE")"
PROGRAM_ARGS+="$(string_item "--event-keys")"
PROGRAM_ARGS+="$(string_item "$EVENT_KEYS")"
PROGRAM_ARGS+="$(string_item "--codex-timeout-seconds")"
PROGRAM_ARGS+="$(string_item "$CODEX_TIMEOUT_SECONDS")"
PROGRAM_ARGS+="$(string_item "--codex-idle-timeout-seconds")"
PROGRAM_ARGS+="$(string_item "$CODEX_IDLE_TIMEOUT_SECONDS")"
PROGRAM_ARGS+="$(string_item "--watchdog-timeout-seconds")"
PROGRAM_ARGS+="$(string_item "$WATCHDOG_TIMEOUT_SECONDS")"

LAUNCHD_PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
ENV_ITEMS=""
ENV_ITEMS+="$(env_item "PATH" "$LAUNCHD_PATH")"
if [[ -n "${CODEX_CLI_BIN:-}" ]]; then
  ENV_ITEMS+="$(env_item "CODEX_CLI_BIN" "$CODEX_CLI_BIN")"
elif command -v codex >/dev/null 2>&1; then
  ENV_ITEMS+="$(env_item "CODEX_CLI_BIN" "$(command -v codex)")"
fi
if [[ -n "${LARK_CLI_BIN:-}" ]]; then
  ENV_ITEMS+="$(env_item "LARK_CLI_BIN" "$LARK_CLI_BIN")"
elif command -v lark-cli >/dev/null 2>&1; then
  ENV_ITEMS+="$(env_item "LARK_CLI_BIN" "$(command -v lark-cli)")"
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$LABEL")</string>
  <key>ProgramArguments</key>
  <array>
$PROGRAM_ARGS  </array>
  <key>EnvironmentVariables</key>
  <dict>
$ENV_ITEMS  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$ROOT")</string>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$LOG_DIR/launchd.stdout.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$LOG_DIR/launchd.stderr.log")</string>
</dict>
</plist>
EOF

plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true

echo "Installed launchd agent: $LABEL"
echo "Plist: $PLIST"
echo "Instance: ${SAFE_NAME:-default}"
echo "Lark profile: ${LARK_PROFILE:-default/current}"
echo "Workspace: $WORKSPACE"
echo "Event keys: $EVENT_KEYS"
echo "Codex total timeout: $([[ "$CODEX_TIMEOUT_SECONDS" -gt 0 ]] && echo "${CODEX_TIMEOUT_SECONDS} seconds" || echo disabled)"
echo "Codex idle timeout: $([[ "$CODEX_IDLE_TIMEOUT_SECONDS" -gt 0 ]] && echo "${CODEX_IDLE_TIMEOUT_SECONDS} seconds" || echo disabled)"
echo "Watchdog timeout: $([[ "$WATCHDOG_TIMEOUT_SECONDS" -gt 0 ]] && echo "${WATCHDOG_TIMEOUT_SECONDS} seconds" || echo disabled)"
echo "Log: $LOG_DIR/watchdog.log"
