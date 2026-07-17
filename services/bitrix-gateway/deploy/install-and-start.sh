#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

UNIT=iva-bitrix-gateway.service
UNIT_FILE=/etc/systemd/system/iva-bitrix-gateway.service
SOCKET=/run/iva-bitrix/gateway.sock
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CLEANUP_NEEDED=1

fail() {
  printf '%s\n' "$1" >&2
  exit "${2:-1}"
}

cleanup() {
  rc=$?
  active_state=unknown
  job_state=unknown
  disable_ok=0
  trap '' HUP INT TERM
  trap - EXIT
  if [ "$CLEANUP_NEEDED" -eq 1 ]; then
    if systemctl disable "$UNIT" >/dev/null 2>&1; then
      disable_ok=1
    fi
    systemctl stop "$UNIT" >/dev/null 2>&1 || true
    active_state=$(systemctl show "$UNIT" --property=ActiveState --value 2>/dev/null || printf '%s' unknown)
    job_state=$(systemctl show "$UNIT" --property=Job --value 2>/dev/null || printf '%s' unknown)
    case "$disable_ok:$active_state:$job_state" in
      1:inactive:|1:failed:)
        if ! rm -f -- "$UNIT_FILE"; then
          rc=121
          printf '%s\n' 'gateway cleanup could not remove the stopped unit file' >&2
        elif ! systemctl daemon-reload; then
          rc=121
          printf '%s\n' 'gateway cleanup removed the unit but daemon-reload failed' >&2
        fi
        ;;
      *)
        printf '%s\n' 'gateway cleanup incomplete; unit file preserved for recovery' >&2
        ;;
    esac
  fi
  exit "$rc"
}

[ "$#" -eq 0 ] || fail 'Usage: sudo ./install-and-start.sh (no arguments or secrets)'
[ "$(id -u)" -eq 0 ] || fail 'Run this installer as root.'
[ -x /usr/bin/curl ] || fail '/usr/bin/curl is required.'
[ -x /usr/bin/python3 ] || fail '/usr/bin/python3 is required.'

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

"$SCRIPT_DIR/install.sh"
systemctl cat --no-pager "$UNIT"
systemctl enable "$UNIT"
systemctl restart "$UNIT"

socket_attempts=0
while [ ! -S "$SOCKET" ]; do
  systemctl is-active --quiet "$UNIT" || {
    systemctl status --no-pager --full "$UNIT" >&2 || true
    fail 'gateway service stopped before creating its socket'
  }
  socket_attempts=$((socket_attempts + 1))
  [ "$socket_attempts" -lt 40 ] || fail 'gateway socket did not appear within 10 seconds'
  sleep 0.25
done
unset socket_attempts

health_json=$(/usr/bin/curl --fail --silent --show-error --connect-timeout 2 --max-time 30 \
  --unix-socket "$SOCKET" http://localhost/health) ||
  fail 'gateway health request failed'
printf '%s' "$health_json" |
  /usr/bin/python3 -c \
    'import json,sys; data=json.load(sys.stdin); assert data.get("ok") is True and data.get("ready") is True'
unset health_json

CLEANUP_NEEDED=0
trap - EXIT HUP INT TERM
printf '%s\n' 'Installed, started, and verified the root-owned IVA Bitrix gateway.'
