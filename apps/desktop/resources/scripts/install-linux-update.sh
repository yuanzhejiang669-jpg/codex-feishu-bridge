#!/usr/bin/env bash
set -u

deb_path="$1"
expected_sha="$2"
app_path="$3"
parent_pid="$4"
log_path="$5"

mkdir -p "$(dirname "$log_path")"
exec >>"$log_path" 2>&1
printf '\n[%s] Starting Ubuntu update\n' "$(date --iso-8601=seconds)"

relaunch_client() {
  for _ in $(seq 1 300); do
    if ! /bin/kill -0 "$parent_pid" 2>/dev/null; then
      if [[ -x "$app_path" ]]; then
        /usr/bin/nohup "$app_path" >/dev/null 2>&1 &
      fi
      return
    fi
    /bin/sleep 0.1
  done
}
trap relaunch_client EXIT

actual_sha="$(/usr/bin/sha256sum "$deb_path" | /usr/bin/awk '{print $1}')"
if [[ "$actual_sha" != "$expected_sha" ]]; then
  printf 'SHA-256 mismatch; refusing installation\n'
  exit 20
fi

for _ in $(seq 1 300); do
  if ! /bin/kill -0 "$parent_pid" 2>/dev/null; then
    break
  fi
  /bin/sleep 0.1
done

install_status=0
/usr/bin/pkexec /usr/bin/apt-get install --reinstall --yes "$deb_path" || install_status=$?
printf '[%s] apt-get exited with status %s\n' "$(date --iso-8601=seconds)" "$install_status"
if [[ "$install_status" -eq 0 ]]; then /bin/rm -f "$deb_path"; fi

exit "$install_status"
