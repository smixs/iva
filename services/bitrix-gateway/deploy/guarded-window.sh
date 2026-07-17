#!/usr/bin/env bash

# Source this file from one dedicated Bash SSH session after verifying the
# reviewed checkout's full commit and clean status. It deliberately uses fixed
# host binaries for the privileged boundary and never accepts a command string
# to evaluate.

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  printf '%s\n' 'guarded-window.sh must be sourced from a dedicated Bash session' >&2
  exit 2
fi
if [[ "${IVA_GUARD_ARMED:-0}" == 1 ]]; then
  printf '%s\n' 'cannot source guarded-window.sh while a guard is armed' >&2
  return 1
fi

IVA_GUARD_ARMED=0
IVA_GUARD_APP_MUTATED=0
IVA_GUARD_APP_READY=1
IVA_GUARD_SUDO_PROBE_CONFIRMED=0
IVA_GUARD_STATE=
IVA_GUARD_APP_STATE=
IVA_GUARD_EXPECTED_UNITS=

iva_guard__validate_state_path() {
  local state=${1:?state path required}
  local kind=${2:?state kind required}
  local runtime parent base

  [[ -n "${XDG_RUNTIME_DIR:-}" ]] || {
    printf '%s\n' 'XDG_RUNTIME_DIR is required' >&2
    return 1
  }
  runtime=$(/usr/bin/readlink -m -- "$XDG_RUNTIME_DIR") || return 1
  [[ "$runtime" == "$XDG_RUNTIME_DIR" && "$runtime" == /* ]] || {
    printf '%s\n' 'XDG_RUNTIME_DIR must be an absolute canonical path' >&2
    return 1
  }
  parent=$(/usr/bin/dirname -- "$state") || return 1
  base=${state##*/}
  [[ "$parent" == "$runtime" ]] || {
    printf '%s\n' 'recovery state must be directly inside XDG_RUNTIME_DIR' >&2
    return 1
  }
  case "$kind" in
    units) [[ "$base" =~ ^iva-sudo-[A-Za-z0-9][A-Za-z0-9._-]*-active-units$ ]] ;;
    app) [[ "$base" =~ ^iva-app-[A-Za-z0-9][A-Za-z0-9._-]*-recovery$ ]] ;;
    *) return 1 ;;
  esac || {
    printf '%s\n' 'recovery state basename is outside the allowlist' >&2
    return 1
  }
}

iva_guard__publish_content() {
  local state=${1:?state path required}
  local content=${2-}
  local dir base tmp= attempt created=0

  dir=$(/usr/bin/dirname -- "$state") || return 1
  base=${state##*/}
  [[ ! -e "$state" && ! -L "$state" ]] || {
    printf '%s\n' 'stale recovery state exists; inspect it before retrying' >&2
    return 1
  }

  for ((attempt = 0; attempt < 64; attempt += 1)); do
    tmp="$dir/.${base}.${BASHPID}.${RANDOM}.${RANDOM}"
    if (umask 077; set -o noclobber; printf '%s' "$content" > "$tmp") 2>/dev/null; then
      created=1
      break
    fi
  done
  [[ "$created" == 1 && -f "$tmp" && ! -L "$tmp" ]] || {
    printf '%s\n' 'could not create private recovery state' >&2
    return 1
  }
  [[ "$(/usr/bin/stat -c '%a' "$tmp")" == 600 ]] || {
    /usr/bin/rm -f -- "$tmp"
    return 1
  }
  if ! /usr/bin/ln -T -- "$tmp" "$state"; then
    /usr/bin/rm -f -- "$tmp"
    printf '%s\n' 'could not atomically publish recovery state' >&2
    return 1
  fi
  /usr/bin/rm -- "$tmp" || return 1
  [[ -f "$state" && ! -L "$state" && "$(/usr/bin/stat -c '%a' "$state")" == 600 ]] || return 1
}

iva_guard_list_active_units() {
  local raw
  raw=$(/usr/bin/systemctl --user list-units --state=active --no-legend --plain \
    'iva.timer' 'iva.service' 'iva-*.timer' 'iva-*.service') || return 1
  printf '%s\n' "$raw" | /usr/bin/awk '{print $1}' | /usr/bin/sort -u
}

iva_guard_list_live_units() {
  local raw
  raw=$(/usr/bin/systemctl --user list-units \
    --state=active,activating,reloading,deactivating --no-legend --plain \
    'iva.timer' 'iva.service' 'iva-*.timer' 'iva-*.service') || return 1
  printf '%s\n' "$raw" | /usr/bin/awk '{print $1}' | /usr/bin/sort -u
}

iva_guard_record_app_state() {
  local state=${1:?application recovery state path required}
  local repo=${2:?live repository path required}
  local branch=${3-}
  local head=${4:?old full commit required}
  local node_bin_dir=${5:?Node bin directory required}
  local content

  [[ "$IVA_GUARD_ARMED" == 1 && -z "$IVA_GUARD_APP_STATE" ]] || {
    printf '%s\n' 'application state requires one armed guard and cannot be replaced' >&2
    return 1
  }
  iva_guard__validate_state_path "$state" app || return 1
  [[ "$repo" == /* && "$node_bin_dir" == /* && "$head" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ "$repo$branch$node_bin_dir" != *$'\n'* ]] || return 1
  printf -v content 'repo=%s\nbranch=%s\nhead=%s\nnode_bin_dir=%s\n' \
    "$repo" "$branch" "$head" "$node_bin_dir"
  iva_guard__publish_content "$state" "$content" || return 1
  IVA_GUARD_APP_STATE=$state
}

iva_guard__stop_expected_units() {
  local unit remaining failed=0

  while IFS= read -r unit; do
    case "$unit" in
      iva.timer|iva-*.timer)
        /usr/bin/systemctl --user stop "$unit" || failed=1
        ;;
    esac
  done <<< "$IVA_GUARD_EXPECTED_UNITS"

  while IFS= read -r unit; do
    case "$unit" in
      iva.service) ;;
      iva-*.service)
        /usr/bin/systemctl --user stop "$unit" || failed=1
        ;;
    esac
  done <<< "$IVA_GUARD_EXPECTED_UNITS"

  if /usr/bin/grep -Fxq 'iva.service' <<< "$IVA_GUARD_EXPECTED_UNITS"; then
    /usr/bin/systemctl --user stop iva.service || failed=1
  fi

  remaining=$(iva_guard_list_live_units) || return 1
  if [[ "$failed" != 0 || -n "$remaining" ]]; then
    printf 'unsafe UID-iva units remain live:\n%s\n' "$remaining" >&2
    return 1
  fi
}

iva_guard__restore_units() {
  local state=$1 unit active live failed=0 file_units

  [[ -f "$state" && ! -L "$state" && "$(/usr/bin/stat -c '%a' "$state")" == 600 ]] || {
    printf '%s\n' 'missing or unsafe IVA unit recovery state' >&2
    return 1
  }
  file_units=$(/usr/bin/sort -u "$state") || return 1
  [[ "$file_units" == "$IVA_GUARD_EXPECTED_UNITS" ]] || {
    printf '%s\n' 'IVA unit recovery state changed after capture' >&2
    return 1
  }

  if /usr/bin/grep -Fxq 'iva.service' <<< "$IVA_GUARD_EXPECTED_UNITS"; then
    /usr/bin/systemctl --user start iva.service || failed=1
  fi

  while IFS= read -r unit; do
    case "$unit" in
      iva.service) ;;
      iva-*.service)
        /usr/bin/systemctl --user start "$unit" || failed=1
        ;;
    esac
  done <<< "$IVA_GUARD_EXPECTED_UNITS"

  while IFS= read -r unit; do
    case "$unit" in
      iva.timer|iva-*.timer)
        /usr/bin/systemctl --user start "$unit" || failed=1
        ;;
    esac
  done <<< "$IVA_GUARD_EXPECTED_UNITS"

  active=$(iva_guard_list_active_units) || return 1
  live=$(iva_guard_list_live_units) || return 1
  if [[ "$failed" != 0 || "$active" != "$IVA_GUARD_EXPECTED_UNITS" || \
    "$live" != "$IVA_GUARD_EXPECTED_UNITS" ]]; then
    printf '%s\n' 'IVA unit restore mismatch; recovery state preserved' >&2
    printf 'expected:\n%s\nactive:\n%s\nlive:\n%s\n' \
      "$IVA_GUARD_EXPECTED_UNITS" "$active" "$live" >&2
    return 1
  fi
}

iva_guard_open_sudo_window() {
  [[ "$IVA_GUARD_ARMED" == 1 && "$IVA_GUARD_SUDO_PROBE_CONFIRMED" == 0 ]] || return 1
  /usr/bin/sudo -v || return 1
  if ! /usr/bin/sudo -n /usr/bin/true; then
    /usr/bin/sudo -k || true
    printf '%s\n' 'sudo positive ticket probe failed' >&2
    return 1
  fi
  IVA_GUARD_SUDO_PROBE_CONFIRMED=1
}

iva_guard__cleanup() {
  local requested_rc=${1:-0} live=

  trap '' HUP INT TERM
  trap - EXIT
  [[ "$IVA_GUARD_ARMED" == 1 ]] || return "$requested_rc"

  # This proof runs in the same SSH shell/TTY as the positive probe.
  /usr/bin/sudo -k || true
  if /usr/bin/sudo -n /usr/bin/true 2>/dev/null; then
    iva_guard__stop_expected_units || true
    live=$(iva_guard_list_live_units 2>/dev/null || printf '%s' '<unknown>')
    printf 'unsafe sudo ticket remains active; recovery state preserved; live set:\n%s\n' \
      "$live" >&2
    return 125
  fi

  # A caller that changed the application provides this fixed-name function.
  # It runs only after sudo invalidation. Failure leaves IVA stopped.
  if [[ "$IVA_GUARD_APP_MUTATED" == 1 && "$IVA_GUARD_APP_READY" != 1 ]]; then
    if ! declare -F iva_guard_recover_app >/dev/null || ! iva_guard_recover_app; then
      iva_guard__stop_expected_units || true
      live=$(iva_guard_list_live_units 2>/dev/null || printf '%s' '<unknown>')
      printf 'application rollback failed; recovery state preserved; live set:\n%s\n' \
        "$live" >&2
      return 124
    fi
    IVA_GUARD_APP_READY=1
  fi

  if ! iva_guard__restore_units "$IVA_GUARD_STATE"; then
    iva_guard__stop_expected_units || true
    live=$(iva_guard_list_live_units 2>/dev/null || printf '%s' '<unknown>')
    printf 'IVA restore failed; recovery state preserved; live set:\n%s\n' "$live" >&2
    return 123
  fi

  if [[ -n "$IVA_GUARD_APP_STATE" ]]; then
    /usr/bin/rm -- "$IVA_GUARD_APP_STATE" || {
      printf '%s\n' 'could not remove completed application recovery state' >&2
      return 122
    }
    IVA_GUARD_APP_STATE=
  fi
  /usr/bin/rm -- "$IVA_GUARD_STATE" || {
    printf '%s\n' 'could not remove completed IVA recovery state' >&2
    return 122
  }

  IVA_GUARD_ARMED=0
  IVA_GUARD_APP_MUTATED=0
  IVA_GUARD_APP_READY=1
  IVA_GUARD_SUDO_PROBE_CONFIRMED=0
  IVA_GUARD_STATE=
  IVA_GUARD_EXPECTED_UNITS=
  return "$requested_rc"
}

iva_guard__on_exit() {
  local requested_rc=$1 final_rc
  trap '' HUP INT TERM
  trap - EXIT
  if iva_guard__cleanup "$requested_rc"; then
    final_rc=0
  else
    final_rc=$?
  fi
  exit "$final_rc"
}

iva_guard_begin() {
  local state=${1:?recovery state path required} active live content

  [[ "$IVA_GUARD_ARMED" == 0 ]] || {
    printf '%s\n' 'a guarded window is already armed' >&2
    return 1
  }
  iva_guard__validate_state_path "$state" units || return 1
  [[ ! -e "$state" && ! -L "$state" ]] || {
    printf '%s\n' 'stale recovery state exists; inspect it before retrying' >&2
    return 1
  }

  active=$(iva_guard_list_active_units) || return 1
  live=$(iva_guard_list_live_units) || return 1
  [[ "$live" == "$active" ]] || {
    printf '%s\n' 'transitional IVA unit state; nothing was stopped' >&2
    return 1
  }

  IVA_GUARD_EXPECTED_UNITS=$active
  content="${active}"$'\n'
  iva_guard__publish_content "$state" "$content" || return 1
  [[ "$(/usr/bin/sort -u "$state")" == "$IVA_GUARD_EXPECTED_UNITS" ]] || return 1

  IVA_GUARD_STATE=$state
  IVA_GUARD_ARMED=1
  IVA_GUARD_APP_MUTATED=0
  IVA_GUARD_APP_READY=1
  IVA_GUARD_SUDO_PROBE_CONFIRMED=0
  trap 'iva_guard__on_exit $?' EXIT
  trap 'exit 130' HUP INT TERM

  iva_guard__stop_expected_units
}

iva_guard_finish() {
  local requested_rc=${1:-0} final_rc

  trap '' HUP INT TERM
  trap - EXIT
  if iva_guard__cleanup "$requested_rc"; then
    final_rc=0
  else
    final_rc=$?
  fi
  if [[ "$IVA_GUARD_ARMED" == 1 ]]; then
    trap 'iva_guard__on_exit $?' EXIT
    trap 'exit 130' HUP INT TERM
  else
    trap - HUP INT TERM
  fi
  return "$final_rc"
}
