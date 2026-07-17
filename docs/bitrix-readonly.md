# Bitrix24 read-only integration

IVA reads only tasks from workgroup `97` where the current webhook user is the
responsible person or an accomplice. The integration has no generic REST proxy
and exposes only fixed `GET` routes over a Unix socket.

## Security architecture

`iva.service` has host-native tools, so a webhook readable by the `iva` UID is
not a security boundary. The webhook is therefore available only to the
separate `iva-bitrix` system UID:

- root-owned code: `/usr/local/lib/iva-bitrix-gateway`;
- secret directory: `/etc/iva-bitrix`, owner `root:iva-bitrix`, mode `0750`;
- secret: `/etc/iva-bitrix/bitrix.env`, owner `iva-bitrix:iva-bitrix`, mode
  `0600`; the service keeps primary group `iva` for the socket and explicit
  supplementary group `iva-bitrix` to traverse the secret directory;
- socket: `/run/iva-bitrix/gateway.sock`, group `iva`, mode `0660`;
- fixed gateway operations: health, eligible task list, active task list, and
  one authorized task snapshot;
- policy checks for group `97` and responsible/accomplice membership happen
  again before discussion reads.

The incoming webhook needs `task` or `tasks`, plus the `im` scope. `profile`
itself does not require a named scope. Bitrix scopes are broader than individual
methods, so strict read-only behavior is enforced by the gateway method
allowlist, the separate UID, root-owned code, and the absence of the webhook
from IVA's environment and vault.

## First installation

Run these steps from the checked-out IVA repository on the VPS. Set
`EXPECTED_AUDITED_COMMIT` to the exact full commit hash that passed review.
Before opening a sudo authorization window, capture and stop every active
`iva.timer`, `iva.service`, `iva-*.timer`, and `iva-*.service`; prove none is
active, activating, reloading, or deactivating; then verify that the checkout
still matches that commit with no tracked, staged, or untracked changes. Never
execute a root command from an unverified working tree.

```sh
EXPECTED_AUDITED_COMMIT="${EXPECTED_AUDITED_COMMIT:?set the reviewed 40-character commit hash}"
printf '%s\n' "$EXPECTED_AUDITED_COMMIT" |
  /usr/bin/grep -Eq '^[0-9a-f]{40}$' || { echo 'invalid audited commit hash' >&2; exit 1; }

iva_list_active_units() {
  /usr/bin/systemctl --user list-units --state=active --no-legend --plain \
    'iva.timer' 'iva.service' 'iva-*.timer' 'iva-*.service' |
    /usr/bin/awk '{print $1}' | /usr/bin/sort -u
}
iva_list_live_units() {
  /usr/bin/systemctl --user list-units \
    --state=active,activating,reloading,deactivating --no-legend --plain \
    'iva.timer' 'iva.service' 'iva-*.timer' 'iva-*.service' |
    /usr/bin/awk '{print $1}' | /usr/bin/sort -u
}

IVA_ACTIVE_UNITS=$(iva_list_active_units)
for unit in $IVA_ACTIVE_UNITS; do
  case "$unit" in
    iva.timer|iva-*.timer) /usr/bin/systemctl --user stop "$unit" || exit 1 ;;
  esac
done
for unit in $IVA_ACTIVE_UNITS; do
  case "$unit" in
    iva.service|iva-*.service) /usr/bin/systemctl --user stop "$unit" || exit 1 ;;
  esac
done
IVA_REMAINING_UNITS=$(iva_list_live_units)
[ -z "$IVA_REMAINING_UNITS" ] || {
  echo "unsafe UID-iva units remain active: $IVA_REMAINING_UNITS" >&2
  exit 1
}
IVA_SUDO_STATE="${XDG_RUNTIME_DIR:?}/iva-sudo-first-install-active-units"
/usr/bin/rm -f -- "$IVA_SUDO_STATE"
(umask 077; printf '%s\n' "$IVA_ACTIVE_UNITS" > "$IVA_SUDO_STATE")

REPO_ROOT=$(/usr/bin/git rev-parse --show-toplevel)
ACTUAL_COMMIT=$(/usr/bin/git rev-parse --verify HEAD)
[ "$REPO_ROOT" = "$(pwd -P)" ] || { echo 'run from the audited repository root' >&2; exit 1; }
[ "$ACTUAL_COMMIT" = "$EXPECTED_AUDITED_COMMIT" ] || { echo 'audited commit mismatch' >&2; exit 1; }
[ -z "$(/usr/bin/git status --porcelain=v1 --untracked-files=all)" ] || {
  echo 'working tree is not fully clean; root installation refused' >&2
  exit 1
}

/usr/bin/sudo -v
/usr/bin/sudo -n /usr/bin/true
/usr/bin/getent passwd iva-bitrix >/dev/null ||
  /usr/bin/sudo /usr/sbin/useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin iva-bitrix
/usr/bin/sudo /usr/bin/install -d -o root -g iva-bitrix -m 0750 /etc/iva-bitrix
/usr/bin/sudo /usr/bin/install -o iva-bitrix -g iva-bitrix -m 0600 /dev/null /etc/iva-bitrix/bitrix.env
```

Never put a webhook in shell history, a command argument, chat, the IVA `.env`,
or an `iva`-readable staging file. After `sudo -v`, verify from the protected
workstation that a non-interactive command uses the already-approved sudo
ticket:

```powershell
ssh <vps-ssh-alias> '/usr/bin/sudo -n /usr/bin/true'
```

If that succeeds, stream the protected local config directly into root-owned
stdin. `tee` output is discarded, and the webhook is not in an argument or
stdout:

```powershell
$configPath = Join-Path $env:APPDATA 'BitrixConnect\config.json'
$webhook = [string]((Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 |
  ConvertFrom-Json).webhook)
if ($webhook -notmatch '^https://\S+/$' -or $webhook -match "[`r`n]") {
  throw 'Protected Bitrix webhook is not one line of HTTPS.'
}
$payload = "BITRIX_WEBHOOK_URL=$webhook`nBITRIX_CHAT_READ_VERIFIED=false`n"
$sshStartInfo = [System.Diagnostics.ProcessStartInfo]::new()
$sshStartInfo.FileName = 'ssh'
$sshStartInfo.UseShellExecute = $false
$sshStartInfo.RedirectStandardInput = $true
$sshStartInfo.StandardInputEncoding = [System.Text.UTF8Encoding]::new($false)
[void]$sshStartInfo.ArgumentList.Add('<vps-ssh-alias>')
[void]$sshStartInfo.ArgumentList.Add('/usr/bin/sudo -n /usr/bin/tee /etc/iva-bitrix/bitrix.env >/dev/null')
$sshProcess = [System.Diagnostics.Process]::Start($sshStartInfo)
try {
  $sshProcess.StandardInput.Write($payload)
  $sshProcess.StandardInput.Close()
  $sshProcess.WaitForExit()
  if ($sshProcess.ExitCode -ne 0) {
    throw "Protected webhook transfer failed with exit code $($sshProcess.ExitCode)."
  }
} finally {
  $sshProcess.Dispose()
  Remove-Variable webhook, payload
}
```

If the server uses per-TTY sudo tickets and that check fails, use this manual
fallback in the original stopped-IVA SSH session. Terminal echo is disabled
before the two lines are read, and a trap restores it:

```sh
/usr/bin/sudo /bin/sh -c 'trap "/usr/bin/stty echo" EXIT HUP INT TERM; /usr/bin/stty -echo; printf "Paste two env lines, then Ctrl-D: " >/dev/tty; /usr/bin/cat > /etc/iva-bitrix/bitrix.env'
printf '\n'
```

Supply exactly these keys, using the webhook from the protected workstation
config; do not copy the placeholder value:

```text
BITRIX_WEBHOOK_URL=<protected HTTPS incoming webhook>
BITRIX_CHAT_READ_VERIFIED=false
```

Validate ownership, run the root installer, and start only the gateway:

```sh
/usr/bin/sudo /usr/bin/chown iva-bitrix:iva-bitrix /etc/iva-bitrix/bitrix.env
/usr/bin/sudo /usr/bin/chmod 0600 /etc/iva-bitrix/bitrix.env
/usr/bin/sudo services/bitrix-gateway/deploy/install.sh
/usr/bin/sudo /usr/bin/systemctl cat iva-bitrix-gateway.service
/usr/bin/sudo /usr/bin/systemctl enable --now iva-bitrix-gateway.service

/usr/bin/sudo -k
if /usr/bin/sudo -n /usr/bin/true 2>/dev/null; then
  echo 'unsafe: sudo ticket still active'
  exit 1
fi
[ -f "$IVA_SUDO_STATE" ] || { echo 'missing IVA unit restore state' >&2; exit 1; }
while IFS= read -r unit; do
  case "$unit" in
    iva.service|iva-*.service) /usr/bin/systemctl --user start "$unit" || exit 1 ;;
  esac
done < "$IVA_SUDO_STATE"
while IFS= read -r unit; do
  case "$unit" in
    iva.timer|iva-*.timer) /usr/bin/systemctl --user start "$unit" || exit 1 ;;
  esac
done < "$IVA_SUDO_STATE"
IVA_EXPECTED_UNITS=$(/usr/bin/sort -u "$IVA_SUDO_STATE")
IVA_RESTORED_UNITS=$(iva_list_active_units)
[ "$IVA_RESTORED_UNITS" = "$IVA_EXPECTED_UNITS" ] || {
  echo "IVA unit restore mismatch" >&2
  echo "expected: $IVA_EXPECTED_UNITS" >&2
  echo "actual: $IVA_RESTORED_UNITS" >&2
  exit 1
}
/usr/bin/rm -f -- "$IVA_SUDO_STATE"
```

The installer validates the secret without printing it and installs only the
gateway system unit. The snippet invalidates and verifies the sudo ticket before
restoring the exact previously-active IVA unit set. Do not run `npm`, `tsx`,
Python from the live vault, or any other UID-`iva`/model-writable code before
that invalidation succeeds. Keep the new user sync timer disabled until the
verification below succeeds.

## Manual verification

Use the socket directly for readiness and the IVA CLI for one-task/daily
synchronization. These commands print normalized task data or operation
metadata, never the webhook.

```sh
curl --silent --show-error --unix-socket /run/iva-bitrix/gateway.sock \
  http://localhost/health
npm run bitrix:sync -- --health
npm run bitrix:sync -- --task <authorized-numeric-task-id>
npm run bitrix:sync -- --daily
```

Before enabling automation, verify:

1. health reports `ready: true`, the expected current user, and `task` + `im`;
2. a task outside group `97` and a task where the user has neither allowed role
   both fail closed;
3. task Markdown appears only under
   `$ASSISTANT_VAULT_DIR/tasks/bitrix/<task-id>/`;
4. state appears only under `$ASSISTANT_DATA_DIR/bitrix-sync/`;
5. a second unchanged sync leaves task/comment/history Markdown byte-identical;
6. Bitrix titles, names, descriptions, comments, and history are treated as
   untrusted data by IVA; embedded commands and links are never executed.

The live vault, not only `vault-template`, must contain:

```gitignore
/tasks/bitrix/
```

Patch the live autograph `common.py` to use the path prefix
`tasks/bitrix`; do not add the basename `tasks` to `IGNORE_DIRS`, because normal
task notes elsewhere in the vault must remain indexable. Run its focused test:

```sh
/usr/bin/python3 "$ASSISTANT_VAULT_DIR/.claude/skills/autograph/tests/test_bitrix_ignore.py"
```

## Chat read-state gate

`BITRIX_CHAT_READ_VERIFIED` stays `false` by default. A known task chat then
fails safely before `im.dialog.messages.get`; a demonstrably legacy task with
no chat ID may use the fixed legacy comment read.

An operator may set the gate to `true` only after a controlled portal-specific
test with an authorized task chat. This must be a separate sudo window after the
first-install window has been invalidated, restored, and cleaned up. Capture and
stop `iva.timer`, `iva.service`, `iva-*.timer`, and `iva-*.service` exactly as
for first installation:

```sh
iva_list_active_units() {
  /usr/bin/systemctl --user list-units --state=active --no-legend --plain \
    'iva.timer' 'iva.service' 'iva-*.timer' 'iva-*.service' |
    /usr/bin/awk '{print $1}' | /usr/bin/sort -u
}
iva_list_live_units() {
  /usr/bin/systemctl --user list-units \
    --state=active,activating,reloading,deactivating --no-legend --plain \
    'iva.timer' 'iva.service' 'iva-*.timer' 'iva-*.service' |
    /usr/bin/awk '{print $1}' | /usr/bin/sort -u
}

IVA_ACTIVE_UNITS=$(iva_list_active_units)
for unit in $IVA_ACTIVE_UNITS; do
  case "$unit" in
    iva.timer|iva-*.timer) /usr/bin/systemctl --user stop "$unit" || exit 1 ;;
  esac
done
for unit in $IVA_ACTIVE_UNITS; do
  case "$unit" in
    iva.service|iva-*.service) /usr/bin/systemctl --user stop "$unit" || exit 1 ;;
  esac
done
IVA_REMAINING_UNITS=$(iva_list_live_units)
[ -z "$IVA_REMAINING_UNITS" ] || {
  echo "unsafe UID-iva units remain active: $IVA_REMAINING_UNITS" >&2
  exit 1
}
IVA_SUDO_STATE="${XDG_RUNTIME_DIR:?}/iva-sudo-chat-gate-active-units"
/usr/bin/rm -f -- "$IVA_SUDO_STATE"
(umask 077; printf '%s\n' "$IVA_ACTIVE_UNITS" > "$IVA_SUDO_STATE")

/usr/bin/sudo -v
/usr/bin/sudo -u iva-bitrix /usr/bin/node --env-file=/etc/iva-bitrix/bitrix.env \
  /usr/local/lib/iva-bitrix-gateway/preflight-read-state.mjs \
  <authorized-task-id-with-chat>
```

The gate may be approved only when all of these are true:

- `result` is `observed`;
- `evidence_complete` is `true`;
- `probe_discriminating` is `true`;
- `before.counter` is a positive integer and `before.unread_id` is a positive
  numeric ID, proving that unread state existed before the probe;
- `read_state_changed` is `false`.

The preflight does not call `im.dialog.messages.get` when the baseline is zero,
null, or incomplete; it returns `baseline_not_discriminating` instead. Record
the task/chat IDs, before/after counter evidence, portal version, date, and
observer. `baseline_not_discriminating`, `no_task_chat`, incomplete evidence,
or any changed field leaves the gate `false`; this is the expected outcome on a
legacy portal without task chats.

Only after an approved test, edit the root-only env file with no echo, enforce
its ownership and mode again, and restart only the gateway:

```sh
/usr/bin/sudo /usr/bin/chown iva-bitrix:iva-bitrix /etc/iva-bitrix/bitrix.env
/usr/bin/sudo /usr/bin/chmod 0600 /etc/iva-bitrix/bitrix.env
/usr/bin/sudo /usr/bin/systemctl restart iva-bitrix-gateway.service
```

Whether the test is approved or rejected, finish every root operation, then
invalidate sudo and prove it is gone before restoring exactly the IVA units
that were active before the window. Restore services before timers and delete
the non-secret state file before model-facing code runs:

```sh
/usr/bin/sudo -k
if /usr/bin/sudo -n /usr/bin/true 2>/dev/null; then
  echo 'unsafe: sudo ticket still active'
  exit 1
fi
[ -f "$IVA_SUDO_STATE" ] || { echo 'missing IVA unit restore state' >&2; exit 1; }
while IFS= read -r unit; do
  case "$unit" in
    iva.service|iva-*.service) /usr/bin/systemctl --user start "$unit" || exit 1 ;;
  esac
done < "$IVA_SUDO_STATE"
while IFS= read -r unit; do
  case "$unit" in
    iva.timer|iva-*.timer) /usr/bin/systemctl --user start "$unit" || exit 1 ;;
  esac
done < "$IVA_SUDO_STATE"
IVA_EXPECTED_UNITS=$(/usr/bin/sort -u "$IVA_SUDO_STATE")
IVA_RESTORED_UNITS=$(iva_list_active_units)
[ "$IVA_RESTORED_UNITS" = "$IVA_EXPECTED_UNITS" ] || {
  echo "IVA unit restore mismatch" >&2
  echo "expected: $IVA_EXPECTED_UNITS" >&2
  echo "actual: $IVA_RESTORED_UNITS" >&2
  exit 1
}
/usr/bin/rm -f -- "$IVA_SUDO_STATE"
```

Repeat the snapshot test and inspect audit categories after the restart.

## Secret scans

A generic shape scan is intentionally broader and will find allowlisted source
code, this runbook, and fake test fixtures. Run this user-level scan now, while
no sudo ticket exists. It prints paths only; any match in `.env`, vault, data,
or generated output is a release blocker:

```sh
/usr/bin/rg --files-with-matches --hidden \
  'BITRIX_WEBHOOK_URL=|https://[^[:space:]]+/rest/[0-9]+/[A-Za-z0-9_-]+' \
  . "$ASSISTANT_VAULT_DIR" "$ASSISTANT_DATA_DIR" || true
```

The exact-secret comparison and root-only journal/env category checks require a
new, isolated sudo window. Capture and stop the exact active IVA set again; do
not run `npm`, `tsx`, live-vault Python, or other model-writable code until this
window is invalidated and the exact set is restored.

```sh
iva_list_active_units() {
  /usr/bin/systemctl --user list-units --state=active --no-legend --plain \
    'iva.timer' 'iva.service' 'iva-*.timer' 'iva-*.service' |
    /usr/bin/awk '{print $1}' | /usr/bin/sort -u
}
iva_list_live_units() {
  /usr/bin/systemctl --user list-units \
    --state=active,activating,reloading,deactivating --no-legend --plain \
    'iva.timer' 'iva.service' 'iva-*.timer' 'iva-*.service' |
    /usr/bin/awk '{print $1}' | /usr/bin/sort -u
}

IVA_ACTIVE_UNITS=$(iva_list_active_units)
for unit in $IVA_ACTIVE_UNITS; do
  case "$unit" in
    iva.timer|iva-*.timer) /usr/bin/systemctl --user stop "$unit" || exit 1 ;;
  esac
done
for unit in $IVA_ACTIVE_UNITS; do
  case "$unit" in
    iva.service|iva-*.service) /usr/bin/systemctl --user stop "$unit" || exit 1 ;;
  esac
done
IVA_REMAINING_UNITS=$(iva_list_live_units)
[ -z "$IVA_REMAINING_UNITS" ] || {
  echo "unsafe UID-iva units remain active: $IVA_REMAINING_UNITS" >&2
  exit 1
}
IVA_SUDO_STATE="${XDG_RUNTIME_DIR:?}/iva-sudo-secret-scan-active-units"
/usr/bin/rm -f -- "$IVA_SUDO_STATE"
(umask 077; printf '%s\n' "$IVA_ACTIVE_UNITS" > "$IVA_SUDO_STATE")

/usr/bin/sudo -v
/usr/bin/sudo -n /usr/bin/true || { echo 'sudo ticket unavailable' >&2; exit 1; }
```
The exact-secret scan below reads the protected env and compares bytes entirely
inside one root process. It prints only matched paths or a clear category,
never the secret. The expected result outside `/etc/iva-bitrix/bitrix.env` is
`exact-secret-clear`.

```sh
/usr/bin/sudo /usr/bin/python3 -I - <<'PY'
from pathlib import Path

project = Path.cwd().resolve()
env_lines = Path("/etc/iva-bitrix/bitrix.env").read_text().splitlines()
secret = next(line.split("=", 1)[1] for line in env_lines
              if line.startswith("BITRIX_WEBHOOK_URL=")).encode()
local_env = {}
for line in (project / ".env").read_text(errors="replace").splitlines():
    if "=" in line and not line.lstrip().startswith("#"):
        key, value = line.split("=", 1)
        local_env[key.strip()] = value.strip().strip("'\"")
roots = [
    project,
    Path(local_env.get("ASSISTANT_VAULT_DIR", "vault")),
    Path(local_env.get("ASSISTANT_DATA_DIR", "data")),
]
roots = [path if path.is_absolute() else project / path for path in roots]
matches = set()
for root in roots:
    if not root.exists():
        continue
    for path in root.rglob("*"):
        try:
            if path.is_symlink() or not path.is_file() or path.stat().st_size > 16_000_000:
                continue
            if secret in path.read_bytes():
                matches.add(str(path))
        except (OSError, PermissionError):
            continue
if matches:
    for path in sorted(matches):
        print("exact-secret-match:", path)
else:
    print("exact-secret-clear: repo-vault-data")
PY
```

Keep the gateway-journal category check inside the same isolated sudo window;
it runs only root-owned binaries and never prints matching log content:

```sh
/usr/bin/sudo /bin/sh -c 'if /usr/bin/journalctl -u iva-bitrix-gateway.service --no-pager | /usr/bin/grep -Eq "BITRIX_WEBHOOK_URL=|/rest/[0-9]+/[A-Za-z0-9_-]+"; then echo "secret-category-match: gateway-journal"; else echo "secret-category-clear: gateway-journal"; fi'
```

The only expected live secret at rest is the protected root env. Confirm its
category without printing content:

```sh
/usr/bin/sudo /bin/sh -c 'if /usr/bin/grep -Eq "BITRIX_WEBHOOK_URL=|/rest/[0-9]+/[A-Za-z0-9_-]+" /etc/iva-bitrix/bitrix.env; then echo "secret-category-present: root-env"; else echo "secret-category-missing: root-env"; fi'
```

After every root operation and scan is finished, invalidate sudo, prove
non-interactive elevation fails, and only then restore exactly the IVA services
and timers recorded before the window. Restore services before timers and
remove the non-secret state file when restoration is complete:

```sh
/usr/bin/sudo -k
if /usr/bin/sudo -n /usr/bin/true 2>/dev/null; then
  echo 'unsafe: sudo ticket still active'
  exit 1
else
  echo 'safe: sudo ticket invalidated'
fi
[ -f "$IVA_SUDO_STATE" ] || { echo 'missing IVA unit restore state' >&2; exit 1; }
while IFS= read -r unit; do
  case "$unit" in
    iva.service|iva-*.service) /usr/bin/systemctl --user start "$unit" || exit 1 ;;
  esac
done < "$IVA_SUDO_STATE"
while IFS= read -r unit; do
  case "$unit" in
    iva.timer|iva-*.timer) /usr/bin/systemctl --user start "$unit" || exit 1 ;;
  esac
done < "$IVA_SUDO_STATE"
IVA_EXPECTED_UNITS=$(/usr/bin/sort -u "$IVA_SUDO_STATE")
IVA_RESTORED_UNITS=$(iva_list_active_units)
[ "$IVA_RESTORED_UNITS" = "$IVA_EXPECTED_UNITS" ] || {
  echo "IVA unit restore mismatch" >&2
  echo "expected: $IVA_EXPECTED_UNITS" >&2
  echo "actual: $IVA_RESTORED_UNITS" >&2
  exit 1
}
/usr/bin/rm -f -- "$IVA_SUDO_STATE"
```

## Enable the daily user timer

Render the user units through IVA's single unit writer only after every manual,
secret-scan, sudo-invalidation, regression, and Telegram end-to-end check has
passed. It substitutes the absolute project path and active Node 24 binary. Do
not copy the raw templates into systemd.

```sh
node bin/iva.mjs _install-units
/usr/bin/systemctl --user enable --now iva-bitrix-sync.timer
/usr/bin/systemctl --user list-timers iva-bitrix-sync.timer
```

## Rollback

Disable Bitrix automation first so it is intentionally excluded from the
restore set. Then capture, stop, and verify every remaining active
`iva.timer`, `iva.service`, `iva-*.timer`, and `iva-*.service` before opening the
sudo window, and restore exactly that captured set afterward. Keep the root-only
secret and installed code for forensic review unless permanent removal is
separately approved.

```sh
/usr/bin/systemctl --user disable --now iva-bitrix-sync.timer
/usr/bin/systemctl --user stop iva-bitrix-sync.service 2>/dev/null || true

iva_list_active_units() {
  /usr/bin/systemctl --user list-units --state=active --no-legend --plain \
    'iva.timer' 'iva.service' 'iva-*.timer' 'iva-*.service' |
    /usr/bin/awk '{print $1}' | /usr/bin/sort -u
}
iva_list_live_units() {
  /usr/bin/systemctl --user list-units \
    --state=active,activating,reloading,deactivating --no-legend --plain \
    'iva.timer' 'iva.service' 'iva-*.timer' 'iva-*.service' |
    /usr/bin/awk '{print $1}' | /usr/bin/sort -u
}

IVA_ACTIVE_UNITS=$(iva_list_active_units)
for unit in $IVA_ACTIVE_UNITS; do
  case "$unit" in
    iva.timer|iva-*.timer) /usr/bin/systemctl --user stop "$unit" || exit 1 ;;
  esac
done
for unit in $IVA_ACTIVE_UNITS; do
  case "$unit" in
    iva.service|iva-*.service) /usr/bin/systemctl --user stop "$unit" || exit 1 ;;
  esac
done
IVA_REMAINING_UNITS=$(iva_list_live_units)
[ -z "$IVA_REMAINING_UNITS" ] || {
  echo "unsafe UID-iva units remain active: $IVA_REMAINING_UNITS" >&2
  exit 1
}
IVA_SUDO_STATE="${XDG_RUNTIME_DIR:?}/iva-sudo-rollback-active-units"
/usr/bin/rm -f -- "$IVA_SUDO_STATE"
(umask 077; printf '%s\n' "$IVA_ACTIVE_UNITS" > "$IVA_SUDO_STATE")

/usr/bin/sudo -v
/usr/bin/sudo /usr/bin/systemctl disable --now iva-bitrix-gateway.service
/usr/bin/sudo /usr/bin/rm -f /etc/systemd/system/iva-bitrix-gateway.service
/usr/bin/sudo /usr/bin/systemctl daemon-reload
/usr/bin/sudo -k
if /usr/bin/sudo -n /usr/bin/true 2>/dev/null; then
  echo 'unsafe: sudo ticket still active'
  exit 1
fi
[ -f "$IVA_SUDO_STATE" ] || { echo 'missing IVA unit restore state' >&2; exit 1; }
while IFS= read -r unit; do
  case "$unit" in
    iva.service|iva-*.service) /usr/bin/systemctl --user start "$unit" || exit 1 ;;
  esac
done < "$IVA_SUDO_STATE"
while IFS= read -r unit; do
  case "$unit" in
    iva.timer|iva-*.timer) /usr/bin/systemctl --user start "$unit" || exit 1 ;;
  esac
done < "$IVA_SUDO_STATE"
IVA_EXPECTED_UNITS=$(/usr/bin/sort -u "$IVA_SUDO_STATE")
IVA_RESTORED_UNITS=$(iva_list_active_units)
[ "$IVA_RESTORED_UNITS" = "$IVA_EXPECTED_UNITS" ] || {
  echo "IVA unit restore mismatch" >&2
  echo "expected: $IVA_EXPECTED_UNITS" >&2
  echo "actual: $IVA_RESTORED_UNITS" >&2
  exit 1
}
/usr/bin/rm -f -- "$IVA_SUDO_STATE"
```

For permanent removal, first revoke the incoming webhook in Bitrix. Verify each
resolved target path before deleting the root env, installed code, or system
account; do not use an unverified recursive delete. Local task snapshots are
private records and are archived or deleted only under the applicable retention
policy.
