#!/usr/bin/bash

set -Eeuo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077

LIVE_REPO=/home/iva/iva
ROOT_COPY=/usr/local/lib/iva-bitrix-admin/install
IVA_USER=iva
IVA_HOME=/home/iva
STATE_FILE=/run/iva-bitrix-admin-active-units
SECRET_DIR=/etc/iva-bitrix
SECRET_FILE=/etc/iva-bitrix/bitrix.env
INSTALLER_REL=services/bitrix-gateway/deploy/install-and-start.sh

EXPECTED_COMMIT=${1:-}
EXPECTED_UNITS=
STATE_PUBLISHED=0
SECRET_TMP=
SUDO_CALLER=
SUDO_CALLER_HOME=
TTY_ECHO_DISABLED=0
TTY_PATH=
INSTALL_SUCCESS=0

fail() {
  printf '%s\n' "$1" >&2
  exit "${2:-1}"
}

[[ $# -eq 1 && "$EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]] ||
  fail 'Usage: sudo /usr/local/lib/iva-bitrix-admin/install <reviewed-40-character-commit>' 2
[[ $(/usr/bin/id -u) -eq 0 ]] || fail 'Run this helper through sudo as the admin account.' 2
[[ -t 0 && -r /dev/tty && -w /dev/tty ]] || fail 'A dedicated interactive TTY is required.' 2
SELF_REAL=$(/usr/bin/readlink -f -- "$0")
[[ "$SELF_REAL" == "$ROOT_COPY" && -f "$ROOT_COPY" && ! -L "$ROOT_COPY" ]] ||
  fail 'Run only the fixed root-owned copy from /usr/local/lib/iva-bitrix-admin.' 2
[[ $(/usr/bin/stat -c '%U:%G %a' "$ROOT_COPY") == 'root:root 700' ]] ||
  fail 'The fixed admin helper copy must be root:root mode 700.' 2
[[ -n ${SUDO_USER:-} && ${SUDO_USER} != root ]] || fail 'A non-root SUDO_USER is required.' 2
[[ ${SUDO_UID:-} =~ ^[0-9]+$ && ${SUDO_UID} != 0 ]] || fail 'A non-root SUDO_UID is required.' 2
[[ $(/usr/bin/id -u "$SUDO_USER") == "$SUDO_UID" ]] || fail 'SUDO_USER and SUDO_UID do not match.' 2

SUDO_CALLER=$SUDO_USER
SUDO_CALLER_HOME=$(/usr/bin/getent passwd "$SUDO_CALLER" | /usr/bin/cut -d: -f6)
[[ "$SUDO_CALLER_HOME" == /* && -d "$SUDO_CALLER_HOME" ]] || fail 'Invalid sudo caller home.' 2

IVA_UID=$(/usr/bin/id -u "$IVA_USER")
IVA_RUNTIME=/run/user/$IVA_UID
IVA_BUS=unix:path=$IVA_RUNTIME/bus
[[ -d "$IVA_RUNTIME" && -S "$IVA_RUNTIME/bus" ]] || fail 'IVA user manager bus is unavailable.'
[[ $(/usr/bin/stat -c '%U:%G' "$IVA_RUNTIME") == "$IVA_USER:$IVA_USER" ]] ||
  fail 'IVA runtime directory ownership is unsafe.'

run_as_iva() {
  /usr/sbin/runuser -u "$IVA_USER" -- /usr/bin/env -i \
    HOME="$IVA_HOME" USER="$IVA_USER" LOGNAME="$IVA_USER" \
    PATH=/usr/bin:/bin XDG_RUNTIME_DIR="$IVA_RUNTIME" \
    DBUS_SESSION_BUS_ADDRESS="$IVA_BUS" "$@"
}

run_git_as_iva() {
  run_as_iva /usr/bin/env GIT_OPTIONAL_LOCKS=0 /usr/bin/git -C "$LIVE_REPO" "$@"
}

run_as_sudo_caller() {
  /usr/sbin/runuser -u "$SUDO_CALLER" -- /usr/bin/env -i \
    HOME="$SUDO_CALLER_HOME" USER="$SUDO_CALLER" LOGNAME="$SUDO_CALLER" \
    PATH=/usr/sbin:/usr/bin:/sbin:/bin "$@"
}

list_active_units() {
  local raw
  raw=$(run_as_iva /usr/bin/systemctl --user list-units --state=active \
    --no-legend --plain 'iva.timer' 'iva.service' 'iva-*.timer' 'iva-*.service') || return 1
  printf '%s\n' "$raw" | /usr/bin/awk '{print $1}' | /usr/bin/sort -u
}

list_live_units() {
  local raw
  raw=$(run_as_iva /usr/bin/systemctl --user list-units \
    --state=active,activating,reloading,deactivating --no-legend --plain \
    'iva.timer' 'iva.service' 'iva-*.timer' 'iva-*.service') || return 1
  printf '%s\n' "$raw" | /usr/bin/awk '{print $1}' | /usr/bin/sort -u
}

stop_unit_set() {
  local units=${1-} unit failed=0 remaining

  while IFS= read -r unit; do
    case "$unit" in
      iva.timer|iva-*.timer) run_as_iva /usr/bin/systemctl --user stop "$unit" || failed=1 ;;
    esac
  done <<< "$units"
  while IFS= read -r unit; do
    case "$unit" in
      iva.service|'') ;;
      iva-*.service) run_as_iva /usr/bin/systemctl --user stop "$unit" || failed=1 ;;
    esac
  done <<< "$units"
  if /usr/bin/grep -Fxq 'iva.service' <<< "$units"; then
    run_as_iva /usr/bin/systemctl --user stop iva.service || failed=1
  fi

  remaining=$(list_live_units) || return 1
  if [[ $failed != 0 || -n "$remaining" ]]; then
    printf 'unsafe IVA units remain live:\n%s\n' "$remaining" >&2
    return 1
  fi
}

stop_all_live_units() {
  local live
  live=$(list_live_units 2>/dev/null || true)
  stop_unit_set "$live" || true
}

restore_expected_units() {
  local unit active live failed=0

  [[ -f "$STATE_FILE" && ! -L "$STATE_FILE" && $(/usr/bin/stat -c '%U:%G %a' "$STATE_FILE") == 'root:root 600' ]] || {
    printf '%s\n' 'missing or unsafe admin recovery state' >&2
    return 1
  }
  [[ $(/usr/bin/sort -u "$STATE_FILE") == "$EXPECTED_UNITS" ]] || {
    printf '%s\n' 'admin recovery state changed after capture' >&2
    return 1
  }
  [[ -z $(list_live_units) ]] || {
    printf '%s\n' 'unexpected IVA units became live before restore' >&2
    return 1
  }

  if /usr/bin/grep -Fxq 'iva.service' <<< "$EXPECTED_UNITS"; then
    run_as_iva /usr/bin/systemctl --user start iva.service || failed=1
  fi
  while IFS= read -r unit; do
    case "$unit" in
      iva.service|'') ;;
      iva-*.service) run_as_iva /usr/bin/systemctl --user start "$unit" || failed=1 ;;
    esac
  done <<< "$EXPECTED_UNITS"
  while IFS= read -r unit; do
    case "$unit" in
      iva.timer|iva-*.timer) run_as_iva /usr/bin/systemctl --user start "$unit" || failed=1 ;;
    esac
  done <<< "$EXPECTED_UNITS"

  active=$(list_active_units) || return 1
  live=$(list_live_units) || return 1
  if [[ $failed != 0 || "$active" != "$EXPECTED_UNITS" || "$live" != "$EXPECTED_UNITS" ]]; then
    printf '%s\n' 'IVA restore mismatch; recovery state preserved' >&2
    printf 'expected:\n%s\nactive:\n%s\nlive:\n%s\n' "$EXPECTED_UNITS" "$active" "$live" >&2
    return 1
  fi
}

invalidate_sudo_ticket() {
  run_as_sudo_caller /usr/bin/sudo -k || true
  if run_as_sudo_caller /usr/bin/sudo -n /usr/bin/true 2>/dev/null; then
    run_as_sudo_caller /usr/bin/sudo -K || true
  fi
  if run_as_sudo_caller /usr/bin/sudo -n /usr/bin/true 2>/dev/null; then
    printf '%s\n' 'unsafe sudo authorization remains active' >&2
    return 1
  fi
}

cleanup() {
  local requested_rc=$? final_rc live
  trap '' HUP INT TERM
  trap - EXIT
  final_rc=$requested_rc

  if [[ $TTY_ECHO_DISABLED == 1 && -n "$TTY_PATH" ]]; then
    /usr/bin/stty echo < "$TTY_PATH" || final_rc=121
    TTY_ECHO_DISABLED=0
  fi

  if [[ -n "$SECRET_TMP" ]]; then
    /usr/bin/rm -f -- "$SECRET_TMP" || final_rc=121
    SECRET_TMP=
  fi

  if ! invalidate_sudo_ticket; then
    stop_all_live_units
    live=$(list_live_units 2>/dev/null || printf '%s' '<unknown>')
    printf 'sudo invalidation failed; IVA left contained; live set:\n%s\n' "$live" >&2
    exit 125
  fi

  if [[ $STATE_PUBLISHED == 1 ]]; then
    if ! restore_expected_units; then
      stop_all_live_units
      live=$(list_live_units 2>/dev/null || printf '%s' '<unknown>')
      printf 'IVA restore failed; recovery state preserved; live set:\n%s\n' "$live" >&2
      exit 123
    fi
    /usr/bin/rm -- "$STATE_FILE" || {
      printf '%s\n' 'could not remove completed admin recovery state' >&2
      exit 122
    }
    STATE_PUBLISHED=0
  fi

  if [[ $final_rc == 0 && $INSTALL_SUCCESS == 1 ]]; then
    printf '%s\n' 'ADMIN_INSTALL_COMPLETE'
  fi

  exit "$final_rc"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

[[ ! -e "$STATE_FILE" && ! -L "$STATE_FILE" ]] ||
  fail 'stale admin recovery state exists; inspect it before retrying'

[[ $(run_git_as_iva rev-parse --show-toplevel) == "$LIVE_REPO" ]] ||
  fail 'invalid live repository root'
[[ $(run_git_as_iva rev-parse HEAD) == "$EXPECTED_COMMIT" ]] ||
  fail 'live checkout commit does not match the reviewed commit'
[[ -z $(run_git_as_iva status --porcelain=v1 --untracked-files=all) ]] ||
  fail 'live checkout is not fully clean'

(
  cd "$LIVE_REPO"
  /usr/bin/sha256sum -c --strict <<'MANIFEST'
04794f61beefaed1c71fe8690c1e762df28846c863e59c3ef94815760295251c  services/bitrix-gateway/errors.mjs
79907139610a5ddc3645f4969c6741801afcf426edfd2c6c9ddd1ceb6b670c09  services/bitrix-gateway/normalize.mjs
3dfa764235f3c7cd670337d5ebb85278d80de098d67bcefdecf67d54fe299dcf  services/bitrix-gateway/policy.mjs
1a8ae1d30bfddd0121d0544f232d9c0ba914d8f3eddbbd50708353a30cf1988e  services/bitrix-gateway/client.mjs
c67c532fc9ee08e7c2e0b1eea9af62413d1a2a8cfb0b9d54bde25f90e3477380  services/bitrix-gateway/gateway.mjs
6a4fdc6ea06f155b67e35e67949f78ea250c8078543ef9f178bdb75789d2ffac  services/bitrix-gateway/server.mjs
d93c7c247c66b7dc1257def62363197fd1a6b9fafa5c6f2dd2346d9b9644b753  services/bitrix-gateway/index.mjs
9731bb11e6eb88dade7a4266e95767932661c29bced54cc7dc88b5206f585757  services/bitrix-gateway/preflight-read-state.mjs
4ff3a1b5b01dfc0bae4335a2fec72060d9f00d86c3db3fc1534cf2f60075a33b  services/bitrix-gateway/deploy/audit-secret.py
60b1784f58f085a33643dbd04a300dca6491cc36cfcae220efd74d0f00c58b13  services/bitrix-gateway/deploy/iva-bitrix-gateway.service
de94a15b50adc351e2106d6c9b1ece412c55402238231a7ba5fa46ccbb24e3e3  services/bitrix-gateway/deploy/install.sh
beed237dcd71aeb9d7e2859d5e6d0d405bdcdcc86f37337406dadcd00761060c  services/bitrix-gateway/deploy/install-and-start.sh
MANIFEST
)

active=$(list_active_units)
live=$(list_live_units)
[[ "$active" == "$live" ]] || fail 'transitional IVA unit state; nothing was stopped'
EXPECTED_UNITS=$active

tmp_state=$(/usr/bin/mktemp /run/.iva-bitrix-admin-active-units.XXXXXX)
/usr/bin/chown root:root "$tmp_state"
/usr/bin/chmod 0600 "$tmp_state"
printf '%s\n' "$EXPECTED_UNITS" > "$tmp_state"
/usr/bin/ln -T -- "$tmp_state" "$STATE_FILE"
/usr/bin/rm -- "$tmp_state"
[[ -f "$STATE_FILE" && ! -L "$STATE_FILE" && $(/usr/bin/stat -c '%U:%G %a' "$STATE_FILE") == 'root:root 600' ]] ||
  fail 'could not publish safe admin recovery state'
[[ $(/usr/bin/sort -u "$STATE_FILE") == "$EXPECTED_UNITS" ]] || fail 'admin recovery state verification failed'
STATE_PUBLISHED=1

stop_unit_set "$EXPECTED_UNITS"

for path in "$SECRET_DIR" /usr/local/lib/iva-bitrix-gateway /etc/systemd/system/iva-bitrix-gateway.service; do
  [[ ! -L "$path" ]] || fail "unsafe partial-install symlink: $path"
done

/usr/bin/getent passwd iva-bitrix >/dev/null ||
  /usr/sbin/useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin iva-bitrix
/usr/bin/install -d -o root -g iva-bitrix -m 0750 "$SECRET_DIR"

secret_is_valid=0
if [[ -f "$SECRET_FILE" && ! -L "$SECRET_FILE" && $(/usr/bin/stat -c '%U:%G %a' "$SECRET_FILE") == 'iva-bitrix:iva-bitrix 600' ]]; then
  if /bin/sh -c '
    f=/etc/iva-bitrix/bitrix.env
    [ "$(grep -c "^BITRIX_WEBHOOK_URL=" "$f" || true)" -eq 1 ] &&
    grep -Eq "^BITRIX_WEBHOOK_URL=https://[^[:space:]]+$" "$f" &&
    [ "$(grep -c "^BITRIX_CHAT_READ_VERIFIED=" "$f" || true)" -le 1 ] &&
    ! grep -Eqv "^[[:space:]]*(#|$)|^BITRIX_WEBHOOK_URL=|^BITRIX_CHAT_READ_VERIFIED=(true|false)$" "$f"
  ' >/dev/null; then
    secret_is_valid=1
  fi
fi

if [[ $secret_is_valid != 1 ]]; then
  SECRET_TMP=$(/usr/bin/mktemp "$SECRET_DIR/.bitrix.env.XXXXXX")
  /usr/bin/chown root:root "$SECRET_TMP"
  /usr/bin/chmod 0600 "$SECRET_TMP"
  TTY_PATH=/dev/tty
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  /usr/bin/stty -echo < "$TTY_PATH"
  TTY_ECHO_DISABLED=1
  printf '%s\n' 'Paste exactly these two lines, then press Ctrl-D:' > "$TTY_PATH"
  printf '%s\n' 'BITRIX_WEBHOOK_URL=<the HTTPS webhook from BitrixConnect config>' > "$TTY_PATH"
  printf '%s\n' 'BITRIX_CHAT_READ_VERIFIED=false' > "$TTY_PATH"
  printf '%s' 'Secret input (hidden): ' > "$TTY_PATH"
  /usr/bin/cat < "$TTY_PATH" > "$SECRET_TMP"
  /usr/bin/stty echo < "$TTY_PATH"
  TTY_ECHO_DISABLED=0
  printf '\n' > "$TTY_PATH"

  /bin/sh -ceu '
    f=$1
    [ "$(grep -c "^BITRIX_WEBHOOK_URL=" "$f" || true)" -eq 1 ]
    grep -Eq "^BITRIX_WEBHOOK_URL=https://[^[:space:]]+$" "$f"
    [ "$(grep -c "^BITRIX_CHAT_READ_VERIFIED=" "$f" || true)" -eq 1 ]
    grep -Eq "^BITRIX_CHAT_READ_VERIFIED=false$" "$f"
    ! grep -Eqv "^BITRIX_WEBHOOK_URL=|^BITRIX_CHAT_READ_VERIFIED=false$" "$f"
  ' sh "$SECRET_TMP" || fail 'secret input was invalid; no secret was installed'
  /usr/bin/chown iva-bitrix:iva-bitrix "$SECRET_TMP"
  /usr/bin/chmod 0600 "$SECRET_TMP"
  /usr/bin/mv -T -- "$SECRET_TMP" "$SECRET_FILE"
  SECRET_TMP=
fi

"$LIVE_REPO/$INSTALLER_REL"
INSTALL_SUCCESS=1
