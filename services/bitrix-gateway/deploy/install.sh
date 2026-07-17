#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH


SERVICE_USER=iva-bitrix
SOCKET_GROUP=iva
SECRET_DIR=/etc/iva-bitrix
SECRET_FILE=/etc/iva-bitrix/bitrix.env
INSTALL_DIR=/usr/local/lib/iva-bitrix-gateway
UNIT_NAME=iva-bitrix-gateway.service
UNIT_DIR=/etc/systemd/system

fail() {
  printf '%s\n' "$1" >&2
  exit "${2:-1}"
}

[ "$#" -eq 0 ] || fail 'Usage: sudo ./install.sh (this installer never accepts secrets on argv)'
[ "$(id -u)" -eq 0 ] || fail 'Run this installer as root.'
command -v getent >/dev/null 2>&1 || fail 'getent is required.'
command -v useradd >/dev/null 2>&1 || fail 'useradd is required.'
command -v systemctl >/dev/null 2>&1 || fail 'systemctl is required.'
[ -x /usr/bin/node ] || fail '/usr/bin/node is required.'

NODE_MAJOR=$(/usr/bin/node -p 'Number(process.versions.node.split(".")[0])')
[ "$NODE_MAJOR" -ge 20 ] || fail 'Node.js 20 or newer is required.'
getent group "$SOCKET_GROUP" >/dev/null 2>&1 || fail 'The iva group must exist before installing the gateway.'
getent passwd iva >/dev/null 2>&1 || fail 'The iva service user must exist before installing the gateway.'

if ! getent passwd "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin "$SERVICE_USER"
fi

[ "$(id -u "$SERVICE_USER")" != "$(id -u iva)" ] || fail 'iva-bitrix must have a UID separate from iva.'
install -d -o root -g "$SERVICE_USER" -m 0750 "$SECRET_DIR"

if [ ! -f "$SECRET_FILE" ] || [ -L "$SECRET_FILE" ]; then
  fail 'Create /etc/iva-bitrix/bitrix.env as a regular file using a root-only editor or stdin, then rerun. The installer will not collect or print the webhook.' 2
fi

[ "$(stat -c '%U:%G' "$SECRET_FILE")" = "$SERVICE_USER:$SERVICE_USER" ] \
  || fail 'The secret file must be owned by iva-bitrix:iva-bitrix.'
[ "$(stat -c '%a' "$SECRET_FILE")" = '600' ] \
  || fail 'The secret file must have mode 600.'
[ "$(grep -c '^BITRIX_WEBHOOK_URL=' "$SECRET_FILE" || true)" -eq 1 ] \
  || fail 'The secret file must contain exactly one BITRIX_WEBHOOK_URL entry.'
grep -Eq '^BITRIX_WEBHOOK_URL=https://[^[:space:]]+$' "$SECRET_FILE" \
  || fail 'BITRIX_WEBHOOK_URL must be a non-empty HTTPS URL on one line.'
[ "$(grep -c '^BITRIX_CHAT_READ_VERIFIED=' "$SECRET_FILE" || true)" -le 1 ] \
  || fail 'The secret file may contain at most one BITRIX_CHAT_READ_VERIFIED entry.'
if grep -q '^BITRIX_CHAT_READ_VERIFIED=' "$SECRET_FILE"; then
  grep -Eq '^BITRIX_CHAT_READ_VERIFIED=(true|false)$' "$SECRET_FILE" \
    || fail 'BITRIX_CHAT_READ_VERIFIED must be exactly true or false.'
fi
[ "$(grep -Ev '^[[:space:]]*(#|$)|^BITRIX_WEBHOOK_URL=|^BITRIX_CHAT_READ_VERIFIED=' "$SECRET_FILE" | wc -l)" -eq 0 ] \
  || fail 'The secret file may contain only the webhook, chat-read gate, comments, and blank lines.'

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SOURCE_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
install -d -o root -g root -m 0755 "$INSTALL_DIR"

for source in errors.mjs normalize.mjs policy.mjs client.mjs gateway.mjs server.mjs index.mjs; do
  [ -f "$SOURCE_DIR/$source" ] && [ ! -L "$SOURCE_DIR/$source" ] \
    || fail "Required gateway source is missing or is a symlink: $source"
  install -o root -g root -m 0644 "$SOURCE_DIR/$source" "$INSTALL_DIR/$source"
done

[ -f "$SOURCE_DIR/preflight-read-state.mjs" ] && [ ! -L "$SOURCE_DIR/preflight-read-state.mjs" ] \
  || fail 'Required read-state preflight source is missing or is a symlink.'
install -o root -g root -m 0755 \
  "$SOURCE_DIR/preflight-read-state.mjs" "$INSTALL_DIR/preflight-read-state.mjs"

[ -f "$SCRIPT_DIR/audit-secret.py" ] && [ ! -L "$SCRIPT_DIR/audit-secret.py" ] \
  || fail 'Required secret audit helper is missing or is a symlink.'
install -o root -g root -m 0755 \
  "$SCRIPT_DIR/audit-secret.py" "$INSTALL_DIR/audit-secret.py"

install -o root -g root -m 0644 "$SCRIPT_DIR/$UNIT_NAME" "$UNIT_DIR/$UNIT_NAME"
systemctl daemon-reload

printf '%s\n' 'Installed the root-owned IVA Bitrix gateway and validated the pre-existing secret.'
printf '%s\n' 'Source installation complete; use the audited install-and-start.sh transaction.'
printf '%s\n' 'Read-state preflight (positive task ID only):'
printf '%s\n' 'sudo -u iva-bitrix /usr/bin/node --env-file=/etc/iva-bitrix/bitrix.env /usr/local/lib/iva-bitrix-gateway/preflight-read-state.mjs <task-id>'
