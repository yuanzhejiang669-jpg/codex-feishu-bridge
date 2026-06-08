#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$ROOT/register-codex-feishu-bot.mjs"
INSTALL_DEPS="1"
ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-install-dependencies)
      INSTALL_DEPS="0"; shift ;;
    *)
      ARGS+=("$1"); shift ;;
  esac
done

if [[ "$INSTALL_DEPS" == "1" ]]; then
  if [[ ! -d "$ROOT/node_modules/@larksuiteoapi/node-sdk" || ! -d "$ROOT/node_modules/qrcode" ]]; then
    (cd "$ROOT" && npm install --omit=dev)
  fi
fi

node "$SCRIPT" "${ARGS[@]}"
