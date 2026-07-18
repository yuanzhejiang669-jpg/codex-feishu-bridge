#!/bin/sh
set -eu

USER_HOME=${HOME:?HOME is required}
CODEX_ROOT="$USER_HOME/Documents/Codex"
REPO_ROOT="$CODEX_ROOT/tools/codex-feishu-bridge"
GLOBAL_HOME="$USER_HOME/.codex"
WRITING_HOME="$CODEX_ROOT/codex-homes/codex-space-writing"
SECRETS_FILE="$USER_HOME/.config/codex-feishu-bridge/secrets.env"
PYTHON_EXE="$CODEX_ROOT/tools/python-venv/bin/python"
NODE_EXE=""
SYNC_GIT=1
KEEP_AWAKE=0
INSTALL_CHROME=0

usage() {
  cat <<'EOF'
Usage: install-macos-personal-environment.sh [options]

Options:
  --repo-root PATH       Bridge repository root
  --secrets-file PATH    Existing local env file; the script never creates keys
  --python PATH          Python executable for Python MCP servers
  --node PATH            Node executable for Browser Control
  --no-git-sync          Do not clone or fast-forward skill source repositories
  --keep-awake           Keep the Mac and display awake through a user LaunchAgent
  --install-chrome       Install or verify Google Chrome from Google's official DMG
  --help                 Show this help

The script is idempotent and refuses to overwrite existing configuration files
or non-symlink skill directories. It never creates or authorizes Feishu Bots.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo-root) REPO_ROOT=$2; shift 2 ;;
    --secrets-file) SECRETS_FILE=$2; shift 2 ;;
    --python) PYTHON_EXE=$2; shift 2 ;;
    --node) NODE_EXE=$2; shift 2 ;;
    --no-git-sync) SYNC_GIT=0; shift ;;
    --keep-awake) KEEP_AWAKE=1; shift ;;
    --install-chrome) INSTALL_CHROME=1; shift ;;
    --help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This installer only supports macOS." >&2
  exit 1
fi
if [ "$(uname -m)" != "arm64" ]; then
  echo "This profile currently targets Apple Silicon (arm64)." >&2
  exit 1
fi

verify_chrome() {
  verify_target=$1
  chrome_exe="$verify_target/Contents/MacOS/Google Chrome"
  [ -x "$chrome_exe" ] || { echo "Google Chrome executable is missing: $chrome_exe" >&2; return 1; }
  [ "$(defaults read "$verify_target/Contents/Info" CFBundleIdentifier)" = "com.google.Chrome" ] || {
    echo "Google Chrome bundle identifier is invalid: $verify_target" >&2; return 1;
  }
  codesign --verify --deep --strict --verbose=2 "$verify_target"
  spctl --assess --type execute --verbose=2 "$verify_target"
  lipo -archs "$chrome_exe" | tr ' ' '\n' | grep -qx arm64 || {
    echo "Google Chrome does not contain an arm64 executable" >&2; return 1;
  }
}

install_chrome() (
  chrome_app="/Applications/Google Chrome.app"
  if [ -d "$chrome_app" ]; then
    verify_chrome "$chrome_app"
    echo "Keeping verified Google Chrome: $chrome_app"
    return
  fi
  temp_root=$(mktemp -d "${TMPDIR:-/tmp}/codex-chrome.XXXXXX")
  mount_point="$temp_root/mount"
  dmg="$temp_root/googlechrome.dmg"
  mkdir -p "$mount_point"
  mounted=0
  cleanup() {
    if [ "$mounted" -eq 1 ]; then hdiutil detach "$mount_point" -quiet >/dev/null 2>&1 || true; fi
    rm -rf "$temp_root"
  }
  trap cleanup EXIT HUP INT TERM
  curl --fail --location --retry 3 --output "$dmg" \
    "https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg"
  hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mount_point" -quiet
  mounted=1
  source_app="$mount_point/Google Chrome.app"
  verify_chrome "$source_app"
  cp -R "$source_app" /Applications/
  verify_chrome "$chrome_app"
  echo "Installed verified Google Chrome: $chrome_app"
)

if [ "$INSTALL_CHROME" -eq 1 ]; then install_chrome; fi

CODEX_EXE="/Applications/ChatGPT.app/Contents/Resources/codex"
if [ ! -x "$CODEX_EXE" ]; then
  echo "Official Codex runtime not found at $CODEX_EXE" >&2
  exit 1
fi
if [ ! -d "$REPO_ROOT/.git" ]; then
  echo "Bridge repository not found at $REPO_ROOT" >&2
  exit 1
fi

if [ -z "$NODE_EXE" ]; then
  for candidate in \
    "/Applications/Codex Feishu Bridge.app/Contents/Resources/tools/node/bin/node" \
    "/Applications/Codex Feishu Bridge.app/Contents/Resources/tools/node" \
    "$USER_HOME/Applications/Codex Feishu Bridge.app/Contents/Resources/tools/node/bin/node" \
    "$USER_HOME/Applications/Codex Feishu Bridge.app/Contents/Resources/tools/node"; do
    if [ -x "$candidate" ]; then NODE_EXE=$candidate; break; fi
  done
fi
if [ -z "$NODE_EXE" ] || [ ! -x "$NODE_EXE" ]; then
  echo "Bundled Node runtime was not found. Install the Bridge client or pass --node." >&2
  exit 1
fi
if [ ! -x "$PYTHON_EXE" ]; then
  echo "Python MCP environment not found at $PYTHON_EXE; pass --python after provisioning it." >&2
  exit 1
fi

umask 077
mkdir -p \
  "$GLOBAL_HOME" \
  "$GLOBAL_HOME/skills" \
  "$GLOBAL_HOME/tmp/browser-control" \
  "$WRITING_HOME" \
  "$WRITING_HOME/skills" \
  "$WRITING_HOME/tmp/browser-control" \
  "$CODEX_ROOT/workspaces" \
  "$CODEX_ROOT/tools" \
  "$CODEX_ROOT/skill-sources" \
  "$CODEX_ROOT/skill-sources/local" \
  "$CODEX_ROOT/mcp-data/key-pools" \
  "$CODEX_ROOT/mcp-data/state" \
  "$CODEX_ROOT/codex-homes" \
  "$CODEX_ROOT/bootstrap"

if [ -f "$SECRETS_FILE" ]; then
  chmod 600 "$SECRETS_FILE"
else
  echo "Secrets file is absent: $SECRETS_FILE" >&2
  echo "Provider and MCP validation will remain incomplete until it is transferred securely." >&2
fi

BROWSER_TOKEN_FILE="$USER_HOME/.config/codex-feishu-bridge/browser-control-token"
if [ ! -e "$BROWSER_TOKEN_FILE" ]; then
  if [ -e "$GLOBAL_HOME/config.toml" ]; then
    echo "Browser token file is absent while an existing config is present: $BROWSER_TOKEN_FILE" >&2
    echo "Refusing to generate a token that would not match the existing config." >&2
    exit 1
  fi
  openssl rand -hex 24 >"$BROWSER_TOKEN_FILE"
  chmod 600 "$BROWSER_TOKEN_FILE"
fi
BROWSER_TOKEN=$(cat "$BROWSER_TOKEN_FILE")

if [ "$KEEP_AWAKE" -eq 1 ]; then
  KEEP_AWAKE_AGENT="$USER_HOME/Library/LaunchAgents/com.codex-feishu-bridge.keep-awake.plist"
  if [ ! -e "$KEEP_AWAKE_AGENT" ]; then
    mkdir -p "$(dirname "$KEEP_AWAKE_AGENT")"
    cat >"$KEEP_AWAKE_AGENT" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.codex-feishu-bridge.keep-awake</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/caffeinate</string><string>-dimsu</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF
    chmod 600 "$KEEP_AWAKE_AGENT"
  fi
  if ! launchctl print "gui/$(id -u)/com.codex-feishu-bridge.keep-awake" >/dev/null 2>&1; then
    launchctl bootstrap "gui/$(id -u)" "$KEEP_AWAKE_AGENT"
  fi
fi

SECRET_LOADER="$USER_HOME/.config/codex-feishu-bridge/load-provider-env.sh"
LAUNCH_AGENT="$USER_HOME/Library/LaunchAgents/com.codex-feishu-bridge.provider-env.plist"
if [ ! -e "$SECRET_LOADER" ]; then
  mkdir -p "$(dirname "$SECRET_LOADER")"
  cat >"$SECRET_LOADER" <<EOF
#!/bin/sh
set -eu
. "$SECRETS_FILE"
SUB2API_API_KEY=\$(printf '%s' "\$SUB2API_API_KEY_B64" | base64 -D)
LTHOME_API_KEY=\$(printf '%s' "\$LTHOME_API_KEY_B64" | base64 -D)
launchctl setenv SUB2API_API_KEY "\$SUB2API_API_KEY"
launchctl setenv LTHOME_API_KEY "\$LTHOME_API_KEY"
EOF
  chmod 700 "$SECRET_LOADER"
fi
if [ ! -e "$LAUNCH_AGENT" ]; then
  mkdir -p "$(dirname "$LAUNCH_AGENT")"
  cat >"$LAUNCH_AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.codex-feishu-bridge.provider-env</string>
  <key>ProgramArguments</key><array><string>$SECRET_LOADER</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
EOF
  chmod 600 "$LAUNCH_AGENT"
fi
if [ -f "$SECRETS_FILE" ]; then
  "$SECRET_LOADER"
  if ! launchctl print "gui/$(id -u)/com.codex-feishu-bridge.provider-env" >/dev/null 2>&1; then
    launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT"
  fi
fi

sync_repo() {
  url=$1
  destination=$2
  if [ ! -e "$destination" ]; then
    git clone --filter=blob:none "$url" "$destination"
    return
  fi
  if [ ! -d "$destination/.git" ]; then
    echo "Refusing to replace non-Git path: $destination" >&2
    exit 1
  fi
  if [ -n "$(git -C "$destination" status --porcelain)" ]; then
    echo "Leaving dirty skill source unchanged: $destination" >&2
    return
  fi
  git -C "$destination" pull --ff-only
}

if [ "$SYNC_GIT" -eq 1 ]; then
  sync_repo "https://github.com/Imbad0202/academic-research-skills-codex.git" \
    "$CODEX_ROOT/skill-sources/academic-research-skills-codex"
  sync_repo "https://github.com/Master-cai/Research-Paper-Writing-Skills.git" \
    "$CODEX_ROOT/skill-sources/Research-Paper-Writing-Skills"
fi

ensure_link() {
  source_path=$1
  link_path=$2
  if [ ! -e "$source_path" ]; then
    echo "Skill source is absent, skipping: $source_path" >&2
    return
  fi
  if [ -L "$link_path" ]; then
    current=$(readlink "$link_path")
    if [ "$current" = "$source_path" ]; then return; fi
    echo "Refusing to replace symlink with another target: $link_path" >&2
    exit 1
  fi
  if [ -e "$link_path" ]; then
    echo "Refusing to replace existing skill path: $link_path" >&2
    exit 1
  fi
  ln -s "$source_path" "$link_path"
}

ensure_link "$CODEX_ROOT/skill-sources/academic-research-skills-codex/skills/academic-research-suite" \
  "$WRITING_HOME/skills/academic-research-suite"
ensure_link "$CODEX_ROOT/skill-sources/Research-Paper-Writing-Skills/research-paper-writing" \
  "$WRITING_HOME/skills/research-paper-writing"
ensure_link "$REPO_ROOT/skills/imagegen-router" "$WRITING_HOME/skills/imagegen-router"
ensure_link "$REPO_ROOT/skills/powershell-safe-invocation" "$WRITING_HOME/skills/powershell-safe-invocation"
ensure_link "$CODEX_ROOT/skill-sources/local/mineru-document-parser" "$WRITING_HOME/skills/mineru-document-parser"
ensure_link "$CODEX_ROOT/skill-sources/local/ppt-master" "$WRITING_HOME/skills/ppt-master"

FIRECRAWL_PACKAGE="$CODEX_ROOT/tools/node-packages/firecrawl-cli/dist/index.js"
FIRECRAWL_WRAPPER="$CODEX_ROOT/tools/bin/firecrawl"
if [ -f "$FIRECRAWL_PACKAGE" ] && [ ! -e "$FIRECRAWL_WRAPPER" ]; then
  mkdir -p "$(dirname "$FIRECRAWL_WRAPPER")"
  cat >"$FIRECRAWL_WRAPPER" <<EOF
#!/bin/sh
exec "$NODE_EXE" "$FIRECRAWL_PACKAGE" "\$@"
EOF
  chmod 700 "$FIRECRAWL_WRAPPER"
fi

write_config() {
  destination=$1
  browser_output=$2
  if [ -e "$destination" ]; then
    echo "Keeping existing config: $destination"
    return
  fi
  cat >"$destination" <<EOF
model = "gpt-5.6-sol"
model_provider = "lthome"
model_reasoning_effort = "medium"
web_search = "live"

[model_providers.sub2api]
name = "https://sub2api.douxuenong.xyz"
base_url = "https://sub2api.douxuenong.xyz/v1"
wire_api = "responses"
env_key = "SUB2API_API_KEY"

[model_providers.lthome]
name = "https://sub.lthome.tk"
base_url = "https://sub.lthome.tk/v1"
wire_api = "responses"
env_key = "LTHOME_API_KEY"

[mcp_servers.tavily]
type = "stdio"
command = "$PYTHON_EXE"
args = ["$REPO_ROOT/tools/tavily-router/server.py"]
env = { TAVILY_KEY_POOL_PATH = "$CODEX_ROOT/mcp-data/key-pools/tavily-key-pool.json", TAVILY_ROUTER_STATE_PATH = "$CODEX_ROOT/mcp-data/state/tavily-router-state.json" }

[mcp_servers.codex_browser_control]
type = "stdio"
command = "$NODE_EXE"
args = ["$REPO_ROOT/tools/codex-browser-control-mcp/src/server.mjs"]
env = { BROWSER_CONTROL_EXTENSION_PORT = "18795", BROWSER_CONTROL_EXTENSION_TOKEN = "$BROWSER_TOKEN", BROWSER_CONTROL_OUTPUT_DIR = "$browser_output" }

[mcp_servers.firecrawl]
type = "stdio"
command = "$PYTHON_EXE"
args = ["$REPO_ROOT/tools/firecrawl-router/server.py"]
env = { PATH = "$CODEX_ROOT/tools/bin:/usr/bin:/bin:/usr/sbin:/sbin", FIRECRAWL_KEY_POOL_PATH = "$CODEX_ROOT/mcp-data/key-pools/firecrawl-key-pool.json", FIRECRAWL_ROUTER_STATE_PATH = "$CODEX_ROOT/mcp-data/state/firecrawl-router-state.json", FIRECRAWL_RATE_LIMIT_COOLDOWN_SECONDS = "180", FIRECRAWL_TRANSIENT_ERROR_COOLDOWN_SECONDS = "30", FIRECRAWL_CREDITS_FALLBACK_COOLDOWN_SECONDS = "21600" }

# codex_desktop_control is intentionally omitted. The current implementation
# uses Windows UI Automation, pywin32, and Windows clipboard/window APIs.
EOF
  chmod 600 "$destination"
}

write_config "$GLOBAL_HOME/config.toml" "$GLOBAL_HOME/tmp/browser-control"
write_config "$WRITING_HOME/config.toml" "$WRITING_HOME/tmp/browser-control"

BROWSER_EXTENSION="$REPO_ROOT/tools/codex-browser-control-mcp/extension/codex_browser_bridge"
BROWSER_EXTENSION_TOKEN="$BROWSER_EXTENSION/bridge-token.local.js"
if [ -d "$BROWSER_EXTENSION" ] && [ ! -e "$BROWSER_EXTENSION_TOKEN" ]; then
  cat >"$BROWSER_EXTENSION_TOKEN" <<EOF
globalThis.CODEX_BROWSER_BRIDGE_TOKEN = '$BROWSER_TOKEN';
globalThis.CODEX_BROWSER_BRIDGE_PORT = 18795;
EOF
  chmod 600 "$BROWSER_EXTENSION_TOKEN"
fi

for agents_file in "$GLOBAL_HOME/AGENTS.md" "$WRITING_HOME/AGENTS.md"; do
  if [ ! -e "$agents_file" ]; then
    cat >"$agents_file" <<'EOF'
# Local Codex Instructions

- Keep user data and credentials private.
- Inspect existing files before editing and preserve unrelated changes.
- Use the configured workspace and Codex Home for the current Bot.
- Verify meaningful changes before reporting completion.
EOF
  fi
done

BOT_PLAN="$CODEX_ROOT/bootstrap/bot-plan.json"
if [ ! -e "$BOT_PLAN" ]; then
  cat >"$BOT_PLAN" <<EOF
{
  "schemaVersion": 1,
  "botsCreated": false,
  "ordinary": {
    "codexHome": "$GLOBAL_HOME",
    "bots": [
      {"name": "codex-assistant-1", "displayName": "Codex\u52a9\u624b1"},
      {"name": "codex-assistant-2", "displayName": "Codex\u52a9\u624b2"},
      {"name": "codex-assistant-3", "displayName": "Codex\u52a9\u624b3"}
    ]
  },
  "writing": {
    "codexHome": "$WRITING_HOME",
    "bots": [
      {"name": "codex-assistant-1-writing", "displayName": "Codex\u52a9\u624b1-\u5199\u4f5c"},
      {"name": "codex-assistant-2-writing", "displayName": "Codex\u52a9\u624b2-\u5199\u4f5c"},
      {"name": "codex-assistant-3-writing", "displayName": "Codex\u52a9\u624b3-\u5199\u4f5c"}
    ]
  }
}
EOF
fi

echo "macOS personal environment is ready."
echo "No Feishu Bot was created, registered, authorized, or started."
echo "Desktop Control remains unavailable until a native macOS implementation exists."
