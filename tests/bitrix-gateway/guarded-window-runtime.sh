#!/usr/bin/env bash

set -euo pipefail

PATH=/usr/bin:/bin
export PATH
LC_ALL=C
export LC_ALL

die() {
  printf 'guarded-window runtime test: %s\n' "$*" >&2
  exit 1
}

assert_file_empty() {
  local file=${1:?file required}
  [[ ! -s "$file" ]] || die "expected empty file: $file"
}

assert_file_equals() {
  local file=${1:?file required}
  local expected=${2-}
  local actual

  actual=$(/usr/bin/cat -- "$file")
  [[ "$actual" == "$expected" ]] || {
    printf 'guarded-window runtime test: unexpected content in %s\n' "$file" >&2
    printf 'expected:\n%s\nactual:\n%s\n' "$expected" "$actual" >&2
    exit 1
  }
}

run_inside_namespace() {
  local scenario=${1:?scenario required}
  local case_dir=${2:?case directory required}
  local guard=${3:?guard path required}
  local state expected command_rc finish_rc

  export IVA_TEST_NAMESPACE=1
  export IVA_TEST_ACTIVE="$case_dir/active"
  export IVA_TEST_LIVE="$case_dir/live"
  export IVA_TEST_ACTIONS="$case_dir/actions"
  export IVA_TEST_SUDO_TICKET="$case_dir/sudo-ticket"
  export IVA_TEST_SUDO_MODE=normal
  export XDG_RUNTIME_DIR="$case_dir/runtime"

  /usr/bin/mount --bind "$case_dir/fake-systemctl" /usr/bin/systemctl
  /usr/bin/mount --bind "$case_dir/fake-sudo" /usr/bin/sudo

  # shellcheck disable=SC1090
  source "$guard"

  state="$XDG_RUNTIME_DIR/iva-sudo-runtime-active-units"
  expected=$'iva-bitrix-sync.timer\niva-telegram-poll.service\niva.service'

  iva_guard_begin "$state"
  assert_file_empty "$IVA_TEST_ACTIVE"
  assert_file_empty "$IVA_TEST_LIVE"
  iva_guard_open_sudo_window

  case "$scenario" in
    normal)
      set +e
      iva_guard_finish 0 2>"$case_dir/finish.stderr"
      finish_rc=$?
      set -e

      [[ "$finish_rc" == 0 ]] || die "normal finish returned $finish_rc"
      [[ ! -e "$state" && ! -L "$state" ]] ||
        die 'normal finish preserved unit recovery state'
      assert_file_equals "$IVA_TEST_ACTIVE" "$expected"
      assert_file_equals "$IVA_TEST_LIVE" "$expected"
      assert_file_equals "$IVA_TEST_ACTIONS" \
        $'stop iva-bitrix-sync.timer\nstop iva-telegram-poll.service\nstop iva.service\nsudo -v\nsudo -n /usr/bin/true\nsudo -k\nsudo -n /usr/bin/true\nstart iva.service\nstart iva-telegram-poll.service\nstart iva-bitrix-sync.timer'
      ;;

    command-failure)
      set +e
      /bin/sh -c 'exit 37'
      command_rc=$?
      iva_guard_finish "$command_rc" 2>"$case_dir/finish.stderr"
      finish_rc=$?
      set -e

      [[ "$command_rc" == 37 ]] || die "test command returned $command_rc"
      [[ "$finish_rc" == 37 ]] ||
        die "command failure finish returned $finish_rc"
      [[ ! -e "$state" && ! -L "$state" ]] ||
        die 'command failure preserved unit recovery state after successful restore'
      assert_file_equals "$IVA_TEST_ACTIVE" "$expected"
      assert_file_equals "$IVA_TEST_LIVE" "$expected"
      assert_file_equals "$IVA_TEST_ACTIONS" \
        $'stop iva-bitrix-sync.timer\nstop iva-telegram-poll.service\nstop iva.service\nsudo -v\nsudo -n /usr/bin/true\nsudo -k\nsudo -n /usr/bin/true\nstart iva.service\nstart iva-telegram-poll.service\nstart iva-bitrix-sync.timer'
      ;;

    sudo-sticky)
      export IVA_TEST_SUDO_MODE=sticky

      set +e
      iva_guard_finish 0 2>"$case_dir/finish.stderr"
      finish_rc=$?
      set -e
      # A failed finish deliberately re-arms production recovery traps. Disable
      # them only in this disposable namespace so assertions see the first RC.
      trap - EXIT HUP INT TERM

      [[ "$finish_rc" == 125 ]] ||
        die "sticky sudo finish returned $finish_rc"
      [[ -f "$state" && ! -L "$state" ]] ||
        die 'sticky sudo did not preserve unit recovery state'
      assert_file_empty "$IVA_TEST_ACTIVE"
      assert_file_empty "$IVA_TEST_LIVE"
      assert_file_equals "$IVA_TEST_ACTIONS" \
        $'stop iva-bitrix-sync.timer\nstop iva-telegram-poll.service\nstop iva.service\nsudo -v\nsudo -n /usr/bin/true\nsudo -k\nsudo -n /usr/bin/true\nstop iva-bitrix-sync.timer\nstop iva-telegram-poll.service\nstop iva.service'
      /usr/bin/grep -Fq \
        'unsafe sudo ticket remains active' "$case_dir/finish.stderr" ||
        die 'sticky sudo failure was not reported'
      ;;

    restore-failure)
      export IVA_TEST_FAIL_START=iva-telegram-poll.service

      set +e
      iva_guard_finish 0 2>"$case_dir/finish.stderr"
      finish_rc=$?
      set -e
      # See the sudo-sticky case above: prevent a second automatic cleanup.
      trap - EXIT HUP INT TERM

      [[ "$finish_rc" == 123 ]] ||
        die "restore failure finish returned $finish_rc"
      [[ -f "$state" && ! -L "$state" ]] ||
        die 'restore failure did not preserve unit recovery state'
      assert_file_empty "$IVA_TEST_ACTIVE"
      assert_file_empty "$IVA_TEST_LIVE"
      assert_file_equals "$IVA_TEST_ACTIONS" \
        $'stop iva-bitrix-sync.timer\nstop iva-telegram-poll.service\nstop iva.service\nsudo -v\nsudo -n /usr/bin/true\nsudo -k\nsudo -n /usr/bin/true\nstart iva.service\nstart-failed iva-telegram-poll.service\nstart iva-bitrix-sync.timer\nstop iva-bitrix-sync.timer\nstop iva-telegram-poll.service\nstop iva.service'
      /usr/bin/grep -Fq \
        'IVA restore failed; recovery state preserved' "$case_dir/finish.stderr" ||
        die 'restore failure was not reported'
      ;;

    *)
      die "unknown scenario: $scenario"
      ;;
  esac

  printf 'ok %s\n' "$scenario"
}

if [[ "${1-}" == --inside ]]; then
  [[ "$#" == 4 ]] || die 'inside mode expects scenario, case directory, and guard'
  run_inside_namespace "$2" "$3" "$4"
  exit 0
fi

[[ "$#" == 0 ]] || die 'this test does not accept arguments'

for required in \
  /bin/bash \
  /usr/bin/awk \
  /usr/bin/mount \
  /usr/bin/sudo \
  /usr/bin/systemctl \
  /usr/bin/unshare; do
  [[ -x "$required" ]] || die "required executable is unavailable: $required"
done

self=$(/usr/bin/readlink -f -- "$0")
guard=$(/usr/bin/readlink -f -- \
  "$(/usr/bin/dirname -- "$self")/../../services/bitrix-gateway/deploy/guarded-window.sh")
[[ -f "$guard" ]] || die "guarded window helper is unavailable: $guard"

root=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/iva-guard-runtime.XXXXXX")
root=$(/usr/bin/readlink -f -- "$root")
cleanup_root() {
  local rc=$?

  trap - EXIT
  if [[ -n "${root:-}" && -d "$root" ]]; then
    /usr/bin/rm -rf -- "$root"
  fi
  exit "$rc"
}
trap cleanup_root EXIT

create_fake_systemctl() {
  local destination=${1:?destination required}

  /usr/bin/cat >"$destination" <<'FAKE_SYSTEMCTL'
#!/usr/bin/env bash
set -euo pipefail

[[ "${IVA_TEST_NAMESPACE:-0}" == 1 ]] || exit 99
: "${IVA_TEST_ACTIVE:?}"
: "${IVA_TEST_LIVE:?}"
: "${IVA_TEST_ACTIONS:?}"

remove_unit() {
  local file=${1:?file required}
  local unit=${2:?unit required}
  local tmp="${file}.tmp.$$"

  /usr/bin/awk -v unit="$unit" '$0 != unit' "$file" >"$tmp"
  /usr/bin/mv -f -- "$tmp" "$file"
}

add_unit() {
  local file=${1:?file required}
  local unit=${2:?unit required}

  printf '%s\n' "$unit" >>"$file"
  /usr/bin/sort -u -o "$file" "$file"
}

[[ "${1-}" == --user ]] || exit 98
shift
command_name=${1-}
[[ -n "$command_name" ]] || exit 97
shift

case "$command_name" in
  list-units)
    selected=
    for argument in "$@"; do
      case "$argument" in
        --state=active)
          selected=$IVA_TEST_ACTIVE
          ;;
        --state=active,activating,reloading,deactivating)
          selected=$IVA_TEST_LIVE
          ;;
      esac
    done
    [[ -n "$selected" ]] || exit 96
    while IFS= read -r unit; do
      [[ -n "$unit" ]] || continue
      printf '%s loaded active running guarded-window-runtime\n' "$unit"
    done <"$selected"
    ;;

  stop)
    [[ "$#" == 1 && -n "${1-}" ]] || exit 95
    unit=$1
    printf 'stop %s\n' "$unit" >>"$IVA_TEST_ACTIONS"
    remove_unit "$IVA_TEST_ACTIVE" "$unit"
    remove_unit "$IVA_TEST_LIVE" "$unit"
    ;;

  start)
    [[ "$#" == 1 && -n "${1-}" ]] || exit 94
    unit=$1
    if [[ "${IVA_TEST_FAIL_START:-}" == "$unit" ]]; then
      printf 'start-failed %s\n' "$unit" >>"$IVA_TEST_ACTIONS"
      exit 1
    fi
    printf 'start %s\n' "$unit" >>"$IVA_TEST_ACTIONS"
    add_unit "$IVA_TEST_ACTIVE" "$unit"
    add_unit "$IVA_TEST_LIVE" "$unit"
    ;;

  *)
    exit 93
    ;;
esac
FAKE_SYSTEMCTL
  /usr/bin/chmod 0755 "$destination"
}

create_fake_sudo() {
  local destination=${1:?destination required}

  /usr/bin/cat >"$destination" <<'FAKE_SUDO'
#!/usr/bin/env bash
set -euo pipefail

[[ "${IVA_TEST_NAMESPACE:-0}" == 1 ]] || exit 99
: "${IVA_TEST_ACTIONS:?}"
: "${IVA_TEST_SUDO_TICKET:?}"

printf 'sudo %s\n' "$*" >>"$IVA_TEST_ACTIONS"
case "$*" in
  '-v')
    printf '1\n' >"$IVA_TEST_SUDO_TICKET"
    ;;

  '-n /usr/bin/true')
    [[ "$(<"$IVA_TEST_SUDO_TICKET")" == 1 ]]
    ;;

  '-k')
    if [[ "${IVA_TEST_SUDO_MODE:-normal}" != sticky ]]; then
      printf '0\n' >"$IVA_TEST_SUDO_TICKET"
    fi
    ;;

  *)
    exit 98
    ;;
esac
FAKE_SUDO
  /usr/bin/chmod 0755 "$destination"
}

expected_units=$'iva-bitrix-sync.timer\niva-telegram-poll.service\niva.service'
for scenario in normal command-failure sudo-sticky restore-failure; do
  case_dir="$root/$scenario"
  /usr/bin/mkdir -p -- "$case_dir/runtime"
  /usr/bin/chmod 0700 "$case_dir/runtime"
  printf '%s\n' "$expected_units" >"$case_dir/active"
  /usr/bin/cp -- "$case_dir/active" "$case_dir/live"
  : >"$case_dir/actions"
  : >"$case_dir/finish.stderr"
  printf '0\n' >"$case_dir/sudo-ticket"
  create_fake_systemctl "$case_dir/fake-systemctl"
  create_fake_sudo "$case_dir/fake-sudo"

  /usr/bin/unshare \
    --user \
    --map-root-user \
    --mount \
    --propagation private \
    --fork \
    /bin/bash "$self" --inside "$scenario" "$case_dir" "$guard"
done
