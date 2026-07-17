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

## Guarded sudo windows

Every root window uses `deploy/guarded-window.sh` from the exact reviewed,
clean commit. Source it only in one dedicated Bash SSH session with
`set -Eeuo pipefail`; do not run a root command in another model-writable shell.
The helper:

- refuses stale recovery state and any transitional unit state before touching
  services;
- atomically persists the exact active set with mode `0600` before the first
  stop;
- stops timers, dependent services, and `iva.service` in that order;
- arms an EXIT/signal cleanup before stopping anything;
- invalidates and proves the sudo ticket gone in the same SSH shell/TTY;
- if the application was changed but not verified, runs the caller's fixed-name
  `iva_guard_recover_app` only after sudo invalidation;
- restores `iva.service`, other captured services, then captured timers, and
  deletes recovery state only after the active and live sets match exactly.

If sudo invalidation, application recovery, or exact restoration fails, IVA
attempts to return every captured unit to stopped, preserves the recovery-state
file, and reports any unit still live. Do not delete that file or recapture a
new set; inspect and recover from the original evidence.

## First installation

Build and test the target in a separate worktree first. Then use that reviewed
worktree as the immutable source for the guard while switching the primary
`/home/iva/iva` checkout. Set the reviewed commit, source worktree, target
branch, and Node 24 path explicitly; `LIVE_REPO` defaults to the production
checkout. `TARGET_BRANCH` must be local to the primary checkout, not checked out
by another worktree, and resolve to `EXPECTED_AUDITED_COMMIT`.

```sh
set -Eeuo pipefail
EXPECTED_AUDITED_COMMIT="${EXPECTED_AUDITED_COMMIT:?set the reviewed 40-character commit hash}"
AUDITED_SOURCE_ROOT="${AUDITED_SOURCE_ROOT:?set the reviewed worktree path}"
LIVE_REPO="${LIVE_REPO:-/home/iva/iva}"
TARGET_BRANCH="${TARGET_BRANCH:?set the primary-checkout target branch}"
NODE24_BIN_DIR="${NODE24_BIN_DIR:?set the verified Node 24 bin directory}"

printf '%s\n' "$EXPECTED_AUDITED_COMMIT" |
  /usr/bin/grep -Eq '^[0-9a-f]{40}$' || { echo 'invalid audited commit hash' >&2; exit 1; }
[ "$(/usr/bin/git -C "$AUDITED_SOURCE_ROOT" rev-parse --show-toplevel)" = \
  "$(cd "$AUDITED_SOURCE_ROOT" && pwd -P)" ] || { echo 'invalid audited source root' >&2; exit 1; }
[ "$(/usr/bin/git -C "$AUDITED_SOURCE_ROOT" rev-parse HEAD)" = \
  "$EXPECTED_AUDITED_COMMIT" ] || { echo 'audited source commit mismatch' >&2; exit 1; }
[ -z "$(/usr/bin/git -C "$AUDITED_SOURCE_ROOT" status --porcelain=v1 --untracked-files=all)" ] || {
  echo 'audited source worktree is not fully clean' >&2
  exit 1
}
[ -z "$(/usr/bin/git -C "$LIVE_REPO" status --porcelain=v1 --untracked-files=all)" ] || {
  echo 'primary checkout is not fully clean' >&2
  exit 1
}
[ "$(/usr/bin/git -C "$LIVE_REPO" rev-parse "$TARGET_BRANCH^{commit}")" = \
  "$EXPECTED_AUDITED_COMMIT" ] || { echo 'target branch mismatch' >&2; exit 1; }

# shellcheck source=/dev/null
. "$AUDITED_SOURCE_ROOT/services/bitrix-gateway/deploy/guarded-window.sh"

IVA_OLD_BRANCH=$(/usr/bin/git -C "$LIVE_REPO" symbolic-ref --short -q HEAD || true)
IVA_OLD_HEAD=$(/usr/bin/git -C "$LIVE_REPO" rev-parse HEAD)
iva_guard_recover_app() {
  cd "$LIVE_REPO" || return 1
  if [ -n "$IVA_OLD_BRANCH" ]; then
    /usr/bin/git switch -- "$IVA_OLD_BRANCH" || return 1
  else
    /usr/bin/git switch --detach "$IVA_OLD_HEAD" || return 1
  fi
  [ "$(/usr/bin/git rev-parse HEAD)" = "$IVA_OLD_HEAD" ] || return 1
  PATH="$NODE24_BIN_DIR:$PATH" npm ci || return 1
  PATH="$NODE24_BIN_DIR:$PATH" npm run build || return 1
  PATH="$NODE24_BIN_DIR:$PATH" node --check scripts/telegram-poll.mjs || return 1
  [ "$(/usr/bin/git rev-parse --show-toplevel)" = "$(pwd -P)" ] || return 1
  [ "$(/usr/bin/git rev-parse HEAD)" = "$IVA_OLD_HEAD" ] || return 1
  [ -z "$(/usr/bin/git status --porcelain=v1 --untracked-files=all)" ] || return 1
}

IVA_SUDO_STATE="${XDG_RUNTIME_DIR:?}/iva-sudo-first-install-active-units"
iva_guard_begin "$IVA_SUDO_STATE"
IVA_APP_RECOVERY_STATE="${XDG_RUNTIME_DIR:?}/iva-app-first-install-recovery"
iva_guard_record_app_state "$IVA_APP_RECOVERY_STATE" "$LIVE_REPO" \
  "$IVA_OLD_BRANCH" "$IVA_OLD_HEAD" "$NODE24_BIN_DIR"

IVA_GUARD_APP_MUTATED=1
IVA_GUARD_APP_READY=0
cd "$LIVE_REPO"
/usr/bin/git switch -- "$TARGET_BRANCH"
[ "$(/usr/bin/git rev-parse HEAD)" = "$EXPECTED_AUDITED_COMMIT" ]
PATH="$NODE24_BIN_DIR:$PATH" npm ci
PATH="$NODE24_BIN_DIR:$PATH" npm run typecheck
PATH="$NODE24_BIN_DIR:$PATH" npm run test:bitrix
PATH="$NODE24_BIN_DIR:$PATH" npm run build
PATH="$NODE24_BIN_DIR:$PATH" node --check scripts/telegram-poll.mjs

# Re-bind the privileged source after the last model-writable command.
[ "$(/usr/bin/git rev-parse --show-toplevel)" = "$(pwd -P)" ]
[ "$(/usr/bin/git rev-parse HEAD)" = "$EXPECTED_AUDITED_COMMIT" ]
[ -z "$(/usr/bin/git status --porcelain=v1 --untracked-files=all)" ]
IVA_GUARD_APP_READY=1

# Opens and positively probes this shell's ticket; cleanup later repeats the
# same probe after sudo -k.
iva_guard_open_sudo_window

for path in /etc/iva-bitrix /usr/local/lib/iva-bitrix-gateway \
  /etc/systemd/system/iva-bitrix-gateway.service; do
  /usr/bin/sudo /usr/bin/test ! -L "$path" || {
    echo "unsafe partial-install symlink: $path" >&2
    exit 1
  }
done

/usr/bin/getent passwd iva-bitrix >/dev/null ||
  /usr/bin/sudo /usr/sbin/useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin iva-bitrix
/usr/bin/sudo /usr/bin/install -d -o root -g iva-bitrix -m 0750 /etc/iva-bitrix

if /usr/bin/sudo /usr/bin/test -e /etc/iva-bitrix/bitrix.env; then
  /usr/bin/sudo /usr/bin/test -f /etc/iva-bitrix/bitrix.env
  /usr/bin/sudo /usr/bin/test ! -L /etc/iva-bitrix/bitrix.env
  [ "$(/usr/bin/sudo /usr/bin/stat -c '%U:%G %a' /etc/iva-bitrix/bitrix.env)" = \
    'iva-bitrix:iva-bitrix 600' ]
  if /usr/bin/sudo /bin/sh -c '
    f=/etc/iva-bitrix/bitrix.env
    [ "$(grep -c "^BITRIX_WEBHOOK_URL=" "$f" || true)" -eq 1 ] &&
    grep -Eq "^BITRIX_WEBHOOK_URL=https://[^[:space:]]+$" "$f" &&
    [ "$(grep -c "^BITRIX_CHAT_READ_VERIFIED=" "$f" || true)" -le 1 ] &&
    ! grep -Eqv "^[[:space:]]*(#|$)|^BITRIX_WEBHOOK_URL=|^BITRIX_CHAT_READ_VERIFIED=(true|false)$" "$f"
  ' >/dev/null; then
    IVA_NEEDS_SECRET_INPUT=0
  else
    IVA_NEEDS_SECRET_INPUT=1
  fi
else
  /usr/bin/sudo /usr/bin/install -o iva-bitrix -g iva-bitrix -m 0600 \
    /dev/null /etc/iva-bitrix/bitrix.env
  IVA_NEEDS_SECRET_INPUT=1
fi
printf 'secret-input-required=%s\n' "$IVA_NEEDS_SECRET_INPUT"
```

Never put a webhook in shell history, a command argument, chat, the IVA `.env`,
or an `iva`-readable staging file. Run one of the following transfers only when
the guarded shell printed `secret-input-required=1`; a validated retry reuses
the existing protected env without truncating it.

If a non-interactive command from the protected workstation can use the
already-probed ticket, stream the protected local config directly into
root-owned stdin. The process is created inside `try`, `tee` output is discarded,
and the webhook is never placed in an argument or stdout:

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
$sshProcess = $null
try {
  $sshProcess = [System.Diagnostics.Process]::Start($sshStartInfo)
  $sshProcess.StandardInput.Write($payload)
  $sshProcess.StandardInput.Close()
  $sshProcess.WaitForExit()
  if ($sshProcess.ExitCode -ne 0) {
    throw "Protected webhook transfer failed with exit code $($sshProcess.ExitCode)."
  }
} finally {
  if ($null -ne $sshProcess) { $sshProcess.Dispose() }
  Remove-Variable webhook, payload -ErrorAction SilentlyContinue
}
```

If the server uses per-TTY sudo tickets, use this fallback only in the original
guarded SSH shell. It refuses a missing TTY and cannot read input unless
disabling terminal echo succeeded:

```sh
/usr/bin/sudo /bin/sh -ceu '
  tty=/dev/tty
  [ -r "$tty" ] && [ -w "$tty" ]
  trap "/usr/bin/stty echo < /dev/tty" EXIT HUP INT TERM
  /usr/bin/stty -echo < "$tty"
  printf "Paste two env lines, then Ctrl-D: " > "$tty"
  /usr/bin/cat < "$tty" > /etc/iva-bitrix/bitrix.env
'
printf '\n'
```

Supply exactly these keys, using the webhook from the protected workstation;
do not copy the placeholder value:

```text
BITRIX_WEBHOOK_URL=<protected HTTPS incoming webhook>
BITRIX_CHAT_READ_VERIFIED=false
```

Validate ownership, run the transactional audited installer, then close the
guard. The wrapper installs/restarts the current root-owned gateway, requires a
successful HTTP status plus `{ok:true, ready:true}`, and on failure stops the
gateway and removes only its system unit when safe. Root code/env may remain as
controlled retry evidence, but the user timer stays disabled.

```sh
/usr/bin/sudo /usr/bin/chown iva-bitrix:iva-bitrix /etc/iva-bitrix/bitrix.env
/usr/bin/sudo /usr/bin/chmod 0600 /etc/iva-bitrix/bitrix.env
/usr/bin/sudo services/bitrix-gateway/deploy/install-and-start.sh
iva_guard_finish 0
```

On retry, rerun this same exact-commit guarded sequence. A valid existing env is
reused, audited root code is overwritten, and the service is restarted. If the
transaction reports that it could not stop a partial gateway, leave IVA's timer
disabled, preserve recovery evidence, and inspect that root unit in a new
guarded sudo window before retrying.

## Manual verification

Use the socket directly for readiness and the IVA CLI for one-task/daily
synchronization. These commands print normalized task data or operation
metadata, never the webhook.

```sh
NODE24_BIN_DIR="${NODE24_BIN_DIR:?set the verified Node 24 bin directory}"
curl --fail --silent --show-error --unix-socket /run/iva-bitrix/gateway.sock \
  http://localhost/health
"$NODE24_BIN_DIR/npm" run bitrix:sync -- --health
"$NODE24_BIN_DIR/npm" run bitrix:sync -- --task <authorized-numeric-task-id>
"$NODE24_BIN_DIR/npm" run bitrix:sync -- --daily
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
task notes elsewhere in the vault must remain indexable. Run the real autograph
suite, which includes the focused `tasks/bitrix` prefix regression:

```sh
/usr/bin/python3 "$ASSISTANT_VAULT_DIR/.claude/skills/autograph/tests/test_autograph.py"
```

## Chat read-state gate

`BITRIX_CHAT_READ_VERIFIED` stays `false` by default. A known task chat then
fails safely before `im.dialog.messages.get`; a demonstrably legacy task with
no chat ID may use the fixed legacy comment read.

An operator may set the gate to `true` only after a controlled portal-specific
test with an authorized task chat. This is a separate guarded sudo window after
first installation has restored cleanly. In a new dedicated Bash SSH session,
verify the live commit before sourcing the helper:

```sh
set -Eeuo pipefail
LIVE_REPO="${LIVE_REPO:-/home/iva/iva}"
EXPECTED_AUDITED_COMMIT="${EXPECTED_AUDITED_COMMIT:?set the deployed 40-character commit hash}"
[ "$(/usr/bin/git -C "$LIVE_REPO" rev-parse HEAD)" = "$EXPECTED_AUDITED_COMMIT" ]
[ -z "$(/usr/bin/git -C "$LIVE_REPO" status --porcelain=v1 --untracked-files=all)" ]
# shellcheck source=/dev/null
. "$LIVE_REPO/services/bitrix-gateway/deploy/guarded-window.sh"
IVA_SUDO_STATE="${XDG_RUNTIME_DIR:?}/iva-sudo-chat-gate-active-units"
iva_guard_begin "$IVA_SUDO_STATE"

iva_guard_open_sudo_window
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

The current deployment does not permit an in-place manual gate mutation. Even
an `observed` result is evidence for a separate reviewed change; it does not
authorize editing the protected env in this window. Finish the guard with the
gate still `false`:

```sh
iva_guard_finish 0
```

Any future enablement requires an audited root-owned transaction that validates
the complete env file and its metadata, atomically replaces only the gate value,
restarts the gateway, proves HTTP `{ok:true,ready:true}`, and rolls the env back
on any failure. Until that helper is reviewed and deployed, leave the gate
`false`.

## Secret scans

A generic shape scan is intentionally broader and will find allowlisted source,
this runbook, and fake fixtures. Run it without a sudo ticket. Exit `0` means
matches were listed, `1` means no match, and any other status is a scan failure;
never mask that failure:

```sh
set +e
: "${ASSISTANT_VAULT_DIR:?set the verified absolute vault root}"
: "${ASSISTANT_DATA_DIR:?set the verified absolute data root}"
/usr/bin/rg --files-with-matches --hidden --no-ignore \
  --glob '!.git/**' \
  --glob '!node_modules/**' \
  'BITRIX_WEBHOOK_URL=|https://[^[:space:]]+/rest/[0-9]+/[A-Za-z0-9_-]+' \
  . "$ASSISTANT_VAULT_DIR" "$ASSISTANT_DATA_DIR"
SHAPE_SCAN_RC=$?
set -e
case "$SHAPE_SCAN_RC" in 0|1) ;; *) exit "$SHAPE_SCAN_RC" ;; esac
```

Inspect every listed path. A match in `.env`, vault, data, or generated output
is a blocker; allowlisted source/docs/test fixtures must be categorized
explicitly.

The exact comparison uses only the audited root-owned helper installed with the
gateway. It validates protected-env structure and metadata, scans regular files
without following symlinks, treats unreadable/changing/oversize files as
blockers, and checks the gateway journal without printing its content or the
webhook. Export the verified absolute vault/data roots before opening this new
guarded window:

```sh
set -Eeuo pipefail
LIVE_REPO="${LIVE_REPO:-/home/iva/iva}"
ASSISTANT_VAULT_DIR="${ASSISTANT_VAULT_DIR:?set the verified absolute vault root}"
ASSISTANT_DATA_DIR="${ASSISTANT_DATA_DIR:?set the verified absolute data root}"
EXPECTED_AUDITED_COMMIT="${EXPECTED_AUDITED_COMMIT:?set the deployed 40-character commit hash}"
[ "$(/usr/bin/git -C "$LIVE_REPO" rev-parse HEAD)" = "$EXPECTED_AUDITED_COMMIT" ]
[ -z "$(/usr/bin/git -C "$LIVE_REPO" status --porcelain=v1 --untracked-files=all)" ]
[ "$(/usr/bin/readlink -m "$ASSISTANT_VAULT_DIR")" = "$ASSISTANT_VAULT_DIR" ]
[ "$(/usr/bin/readlink -m "$ASSISTANT_DATA_DIR")" = "$ASSISTANT_DATA_DIR" ]
cd "$LIVE_REPO"
# shellcheck source=/dev/null
. "$LIVE_REPO/services/bitrix-gateway/deploy/guarded-window.sh"
IVA_SUDO_STATE="${XDG_RUNTIME_DIR:?}/iva-sudo-secret-scan-active-units"
iva_guard_begin "$IVA_SUDO_STATE"
iva_guard_open_sudo_window
/usr/bin/sudo /usr/local/lib/iva-bitrix-gateway/audit-secret.py \
  "$LIVE_REPO" "$ASSISTANT_VAULT_DIR" "$ASSISTANT_DATA_DIR"
iva_guard_finish 0
```

Success requires all three categories:
`exact-secret-clear:repo-vault-data`,
`exact-secret-clear:gateway-journal`, and
`secret-category-present:root-env`. Any match, blocker, nonzero helper status,
or failed guard cleanup blocks release.

## Verify Telegram E2E and enable the daily user timer

Render the user units through IVA's single unit writer with the audited Node 24
binary. Keep the timer fully stopped and disabled while proving one direct
oneshot. Do not use ambient `node` or copy raw templates into systemd.

```sh
LIVE_REPO="${LIVE_REPO:-/home/iva/iva}"
NODE24_BIN_DIR="${NODE24_BIN_DIR:?set the verified Node 24 bin directory}"
[ -x "$NODE24_BIN_DIR/node" ] && [ -x "$NODE24_BIN_DIR/npm" ]
"$NODE24_BIN_DIR/node" "$LIVE_REPO/bin/iva.mjs" _install-units
/usr/bin/systemctl --user disable --now iva-bitrix-sync.timer
[ "$(/usr/bin/systemctl --user show iva-bitrix-sync.timer --property=ActiveState --value)" = inactive ]
[ "$(/usr/bin/systemctl --user is-enabled iva-bitrix-sync.timer 2>/dev/null)" = disabled ]
/usr/bin/systemctl --user stop iva-bitrix-sync.service
/usr/bin/systemctl --user cat iva-bitrix-sync.service |
  /usr/bin/grep -Fx "ExecStart=$NODE24_BIN_DIR/node --import=tsx --env-file=.env scripts/bitrix-sync.ts --daily"
/usr/bin/systemctl --user cat iva-bitrix-sync.timer | /usr/bin/grep -Fx 'Persistent=true'
/usr/bin/systemctl --user cat iva-bitrix-sync.timer | /usr/bin/grep -Fx 'RandomizedDelaySec=10m'
/usr/bin/systemctl --user start iva-bitrix-sync.service
[ "$(/usr/bin/systemctl --user show iva-bitrix-sync.service --property=Result --value)" = success ]
[ "$(/usr/bin/systemctl --user show iva-bitrix-sync.service --property=ExecMainStatus --value)" = 0 ]
```

Before enabling the timer, complete the human-visible Telegram check:

1. In Telegram ask IVA: `Что у меня сегодня по задачам Битрикс?`
2. Verify that the answer contains only group `97` tasks where the webhook user
   is responsible or an accomplice, including the known task `394930`.
3. Add one benign, uniquely recognizable comment to task `394930` in Bitrix.
4. Run `"$NODE24_BIN_DIR/npm" run bitrix:sync -- --task 394930` and repeat the
   Telegram question.
5. Verify the new comment appears and that any command-like text inside Bitrix
   content is quoted as untrusted data, never followed as an instruction.

If any step fails, leave the timer disabled and investigate before continuing.

Confirm the server timezone before starting the timer. Because
`Persistent=true`, first start may immediately run a missed catch-up sync.
Keep this dedicated Bash session open: its EXIT/signal cleanup disables the
timer and stops the oneshot until every post-window check commits success.

```sh
set -Eeuo pipefail
IVA_TIMER_COMMITTED=0
iva_timer_cleanup() {
  local rc=$? cleanup_failed=0
  trap '' HUP INT TERM
  trap - EXIT
  if [ "$IVA_TIMER_COMMITTED" != 1 ]; then
    /usr/bin/systemctl --user disable --now iva-bitrix-sync.timer ||
      cleanup_failed=1
    /usr/bin/systemctl --user stop iva-bitrix-sync.service ||
      cleanup_failed=1
    if [ "$(/usr/bin/systemctl --user show iva-bitrix-sync.timer --property=ActiveState --value)" != inactive ] ||
      [ "$(/usr/bin/systemctl --user show iva-bitrix-sync.service --property=ActiveState --value)" != inactive ] ||
      [ "$(/usr/bin/systemctl --user is-enabled iva-bitrix-sync.timer 2>/dev/null)" != disabled ]; then
      cleanup_failed=1
    fi
    if [ "$cleanup_failed" != 0 ]; then
      echo 'timer rollback failed or state mismatched; inspect user units' >&2
      exit 121
    fi
  fi
  exit "$rc"
}
trap 'iva_timer_cleanup' EXIT
trap 'exit 130' HUP INT TERM

[ "$(/usr/bin/timedatectl show --property=Timezone --value)" = 'Asia/Yekaterinburg' ]
PRE_TIMER_INVOCATION=$(/usr/bin/systemctl --user show iva-bitrix-sync.service --property=InvocationID --value)
PRE_TIMER_START_MONO=$(/usr/bin/systemctl --user show iva-bitrix-sync.service --property=ExecMainStartTimestampMonotonic --value)
[[ "$PRE_TIMER_INVOCATION" =~ ^[0-9a-f]+$ && "$PRE_TIMER_START_MONO" =~ ^[0-9]+$ ]]
TIMER_ENABLED_AT=$(/usr/bin/date --iso-8601=seconds)
/usr/bin/systemctl --user enable iva-bitrix-sync.timer
/usr/bin/systemctl --user start iva-bitrix-sync.timer
/usr/bin/systemctl --user list-timers --all iva-bitrix-sync.timer
[ "$(/usr/bin/systemctl --user is-active iva-bitrix-sync.timer)" = active ]
```

Observe the complete ten-minute randomized-delay window. Then require a new,
completed invocation rather than reusing status from the direct oneshot:

```sh
POST_TIMER_INVOCATION=$(/usr/bin/systemctl --user show iva-bitrix-sync.service --property=InvocationID --value)
POST_TIMER_START_MONO=$(/usr/bin/systemctl --user show iva-bitrix-sync.service --property=ExecMainStartTimestampMonotonic --value)
POST_TIMER_EXIT_MONO=$(/usr/bin/systemctl --user show iva-bitrix-sync.service --property=ExecMainExitTimestampMonotonic --value)
[[ "$POST_TIMER_INVOCATION" =~ ^[0-9a-f]+$ &&
  "$POST_TIMER_START_MONO" =~ ^[0-9]+$ &&
  "$POST_TIMER_EXIT_MONO" =~ ^[0-9]+$ ]]
[ "$POST_TIMER_INVOCATION" != "$PRE_TIMER_INVOCATION" ]
(( POST_TIMER_START_MONO > PRE_TIMER_START_MONO ))
(( POST_TIMER_EXIT_MONO >= POST_TIMER_START_MONO ))
[ "$(/usr/bin/systemctl --user show iva-bitrix-sync.service --property=ActiveState --value)" = inactive ]
/usr/bin/journalctl --user -u iva-bitrix-sync.service --since "$TIMER_ENABLED_AT" --no-pager
[ "$(/usr/bin/systemctl --user show iva-bitrix-sync.service --property=Result --value)" = success ]
[ "$(/usr/bin/systemctl --user show iva-bitrix-sync.service --property=ExecMainStatus --value)" = 0 ]
[ "$(/usr/bin/systemctl --user is-active iva-bitrix-sync.timer)" = active ]
IVA_TIMER_COMMITTED=1
trap - EXIT HUP INT TERM
```

## Rollback

Rollback is an application rollback, not only a gateway-unit removal. Set the
currently deployed and last-known-good full commits explicitly. The target
branch must resolve to the rollback commit before anything is stopped. The
guard records both the exact active units and non-secret application recovery
metadata before the branch switch.

Disable Bitrix automation first so it is intentionally excluded from the
restore set. Remove only the two rendered Bitrix user-unit files; an older
`writeUnits()` does not remove units that disappeared from its templates. Keep
the root-only secret and installed code for forensic review unless permanent
removal is separately approved.

```sh
set -Eeuo pipefail
LIVE_REPO="${LIVE_REPO:-/home/iva/iva}"
CURRENT_DEPLOYED_COMMIT="${CURRENT_DEPLOYED_COMMIT:?set the deployed full commit}"
ROLLBACK_COMMIT="${ROLLBACK_COMMIT:?set the verified old full commit}"
ROLLBACK_BRANCH="${ROLLBACK_BRANCH:?set the verified old local branch}"
NODE24_BIN_DIR="${NODE24_BIN_DIR:?set the verified Node 24 bin directory}"

printf '%s\n%s\n' "$CURRENT_DEPLOYED_COMMIT" "$ROLLBACK_COMMIT" |
  /usr/bin/grep -Ex '[0-9a-f]{40}' >/dev/null
[ "$(/usr/bin/git -C "$LIVE_REPO" rev-parse HEAD)" = "$CURRENT_DEPLOYED_COMMIT" ]
[ "$(/usr/bin/git -C "$LIVE_REPO" rev-parse "$ROLLBACK_BRANCH^{commit}")" = "$ROLLBACK_COMMIT" ]
[ -z "$(/usr/bin/git -C "$LIVE_REPO" status --porcelain=v1 --untracked-files=all)" ]

# shellcheck source=/dev/null
. "$LIVE_REPO/services/bitrix-gateway/deploy/guarded-window.sh"
IVA_PRE_ROLLBACK_BRANCH=$(/usr/bin/git -C "$LIVE_REPO" symbolic-ref --short -q HEAD || true)
IVA_PRE_ROLLBACK_HEAD=$(/usr/bin/git -C "$LIVE_REPO" rev-parse HEAD)
iva_guard_recover_app() {
  cd "$LIVE_REPO" || return 1
  if [ -n "$IVA_PRE_ROLLBACK_BRANCH" ]; then
    /usr/bin/git switch -- "$IVA_PRE_ROLLBACK_BRANCH" || return 1
  else
    /usr/bin/git switch --detach "$IVA_PRE_ROLLBACK_HEAD" || return 1
  fi
  [ "$(/usr/bin/git rev-parse HEAD)" = "$IVA_PRE_ROLLBACK_HEAD" ] || return 1
  PATH="$NODE24_BIN_DIR:$PATH" npm ci || return 1
  PATH="$NODE24_BIN_DIR:$PATH" npm run build || return 1
  PATH="$NODE24_BIN_DIR:$PATH" node --check scripts/telegram-poll.mjs || return 1
  [ "$(/usr/bin/git rev-parse --show-toplevel)" = "$(pwd -P)" ] || return 1
  [ "$(/usr/bin/git rev-parse HEAD)" = "$IVA_PRE_ROLLBACK_HEAD" ] || return 1
  [ -z "$(/usr/bin/git status --porcelain=v1 --untracked-files=all)" ] || return 1
}

/usr/bin/systemctl --user disable iva-bitrix-sync.timer
/usr/bin/systemctl --user stop iva-bitrix-sync.timer
/usr/bin/systemctl --user stop iva-bitrix-sync.service
[ "$(/usr/bin/systemctl --user show iva-bitrix-sync.timer --property=ActiveState --value)" = inactive ]
[ "$(/usr/bin/systemctl --user show iva-bitrix-sync.service --property=ActiveState --value)" = inactive ]
[ "$(/usr/bin/systemctl --user is-enabled iva-bitrix-sync.timer 2>/dev/null)" = disabled ]
USER_UNIT_DIR=$(/usr/bin/readlink -m "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user")
case "$USER_UNIT_DIR" in "$HOME"/*) ;; *) echo 'unsafe user unit directory' >&2; exit 1 ;; esac
/usr/bin/rm -f -- "$USER_UNIT_DIR/iva-bitrix-sync.service" "$USER_UNIT_DIR/iva-bitrix-sync.timer"
/usr/bin/systemctl --user daemon-reload

IVA_SUDO_STATE="${XDG_RUNTIME_DIR:?}/iva-sudo-rollback-active-units"
iva_guard_begin "$IVA_SUDO_STATE"
IVA_APP_RECOVERY_STATE="${XDG_RUNTIME_DIR:?}/iva-app-rollback-recovery"
iva_guard_record_app_state "$IVA_APP_RECOVERY_STATE" "$LIVE_REPO" \
  "$IVA_PRE_ROLLBACK_BRANCH" "$IVA_PRE_ROLLBACK_HEAD" "$NODE24_BIN_DIR"

IVA_GUARD_APP_MUTATED=1
IVA_GUARD_APP_READY=0
cd "$LIVE_REPO"
/usr/bin/git switch -- "$ROLLBACK_BRANCH"
[ "$(/usr/bin/git rev-parse HEAD)" = "$ROLLBACK_COMMIT" ]
PATH="$NODE24_BIN_DIR:$PATH" npm ci
PATH="$NODE24_BIN_DIR:$PATH" npm run typecheck
PATH="$NODE24_BIN_DIR:$PATH" npm run build
PATH="$NODE24_BIN_DIR:$PATH" node --check scripts/telegram-poll.mjs
[ "$(/usr/bin/git rev-parse --show-toplevel)" = "$(pwd -P)" ]
[ "$(/usr/bin/git rev-parse HEAD)" = "$ROLLBACK_COMMIT" ]
[ -z "$(/usr/bin/git status --porcelain=v1 --untracked-files=all)" ]

# This is the rollback application commit point: recovery must now preserve the
# verified rollback build even if root gateway cleanup fails.
IVA_GUARD_APP_READY=1
iva_guard_open_sudo_window
/usr/bin/sudo /usr/bin/systemctl disable iva-bitrix-gateway.service
/usr/bin/sudo /usr/bin/systemctl stop iva-bitrix-gateway.service
[ "$(/usr/bin/sudo /usr/bin/systemctl show iva-bitrix-gateway.service --property=ActiveState --value)" = inactive ]
[ "$(/usr/bin/sudo /usr/bin/systemctl is-enabled iva-bitrix-gateway.service 2>/dev/null)" = disabled ]
/usr/bin/sudo /usr/bin/rm -f -- /etc/systemd/system/iva-bitrix-gateway.service
/usr/bin/sudo /usr/bin/systemctl daemon-reload

iva_guard_finish 0
```

If target build verification fails before the commit point, the guard first
invalidates sudo, rebuilds the pre-rollback application, and only then restores
the original units. After the verified rollback build becomes the commit point,
a gateway cleanup failure keeps that rollback build and still restores the
captured units. Any failed exact restore triggers another stop attempt, preserves
both state files, and reports the remaining live set.

For permanent removal, first revoke the incoming webhook in Bitrix. Verify each
resolved target path before deleting the root env, installed code, or system
account; do not use an unverified recursive delete. Local task snapshots are
private records and are archived or deleted only under the applicable retention
policy.
