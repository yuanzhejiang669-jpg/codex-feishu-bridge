#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi
if [[ "$#" -lt 2 || "$#" -gt 3 ]]; then
  echo "Usage: $0 <ydotool-binary> <ydotoold-binary> [desktop-user]" >&2
  exit 2
fi

desktop_user="${3:-${SUDO_USER:-}}"
if [[ -z "$desktop_user" || "$desktop_user" == "root" ]] || ! id "$desktop_user" >/dev/null 2>&1; then
  echo "A valid non-root desktop user is required." >&2
  exit 2
fi
desktop_uid="$(id -u "$desktop_user")"
desktop_gid="$(id -g "$desktop_user")"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
service_source="${script_dir}/../linux/codex-ydotoold.service"
install -o root -g root -m 0755 "$1" /usr/local/bin/ydotool
install -o root -g root -m 0755 "$2" /usr/local/sbin/ydotoold
install -o root -g root -m 0644 "$service_source" /etc/systemd/system/codex-ydotoold.service
printf 'CODEX_DESKTOP_UID=%s\nCODEX_DESKTOP_GID=%s\n' "$desktop_uid" "$desktop_gid" \
  >/etc/default/codex-desktop-control
chmod 0644 /etc/default/codex-desktop-control
systemctl daemon-reload
systemctl enable codex-ydotoold.service
systemctl restart codex-ydotoold.service
systemctl --no-pager --full status codex-ydotoold.service
