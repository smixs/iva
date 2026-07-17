import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const deployRoot = new URL('../../services/bitrix-gateway/deploy/', import.meta.url);

test('systemd unit runs a root-owned installed copy under a separate UID and group-readable socket', async () => {
  const unit = await readFile(new URL('iva-bitrix-gateway.service', deployRoot), 'utf8');
  assert.match(unit, /^User=iva-bitrix$/mu);
  assert.match(unit, /^Group=iva$/mu);
  assert.match(unit, /^SupplementaryGroups=iva-bitrix$/mu);
  assert.match(unit, /^ExecStart=\/usr\/bin\/node \/usr\/local\/lib\/iva-bitrix-gateway\/server\.mjs$/mu);
  assert.doesNotMatch(unit, /\/home\/iva\/iva/iu);
  assert.match(unit, /^EnvironmentFile=\/etc\/iva-bitrix\/bitrix\.env$/mu);
  assert.match(unit, /^UMask=0007$/mu);
  assert.match(unit, /^LimitCORE=0$/mu);
  assert.match(unit, /^ProtectSystem=strict$/mu);
  assert.match(unit, /^ProtectHome=yes$/mu);
  assert.match(unit, /^NoNewPrivileges=yes$/mu);
  assert.match(unit, /^CapabilityBoundingSet=$/mu);
});

test('installer rejects argv secrets, validates a pre-existing 0600 secret, and copies immutable root-owned sources', async () => {
  const installer = await readFile(new URL('install.sh', deployRoot), 'utf8');
  assert.match(installer, /^PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin$/mu);
  assert.match(installer, /^export PATH$/mu);
  assert.ok(installer.indexOf('PATH=/usr/sbin:/usr/bin:/sbin:/bin') < installer.indexOf('$(id -u)'));
  assert.match(installer, /\[ "\$#" -eq 0 \]/u);
  assert.match(installer, /never accepts secrets on argv/u);
  assert.match(installer, /SECRET_FILE=\/etc\/iva-bitrix\/bitrix\.env/u);
  assert.match(installer, /must be owned by iva-bitrix:iva-bitrix/u);
  assert.match(installer, /must have mode 600/u);
  assert.match(installer, /INSTALL_DIR=\/usr\/local\/lib\/iva-bitrix-gateway/u);
  assert.match(installer, /install -o root -g root -m 0644/u);
  assert.doesNotMatch(installer, /read .*BITRIX_WEBHOOK|echo .*BITRIX_WEBHOOK|printf .*BITRIX_WEBHOOK_URL=https/iu);
});

test('deployment example defaults the chat read-state gate to false and contains no webhook', async () => {
  const example = await readFile(new URL('bitrix.env.example', deployRoot), 'utf8');
  assert.match(example, /^BITRIX_CHAT_READ_VERIFIED=false$/mu);
  assert.match(example, /^BITRIX_WEBHOOK_URL=$/mu);
  assert.doesNotMatch(example, /https?:\/\//iu);
});

test('guarded sudo window persists state, orders stops/restores, and fails closed', async () => {
  const guard = await readFile(new URL('guarded-window.sh', deployRoot), 'utf8');
  const begin = guard.indexOf('iva_guard_begin()');
  const publishState = guard.indexOf('iva_guard__publish_content "$state" "$content"', begin);
  const armed = guard.indexOf('IVA_GUARD_ARMED=1', begin);
  const exitTrap = guard.indexOf("trap 'iva_guard__on_exit $?' EXIT", begin);
  const stopCall = guard.indexOf('iva_guard__stop_expected_units', exitTrap);
  const stopFunction = guard.indexOf('iva_guard__stop_expected_units()');
  const stopTimer = guard.indexOf('/usr/bin/systemctl --user stop "$unit"', stopFunction);
  const stopOther = guard.indexOf('/usr/bin/systemctl --user stop "$unit"', stopTimer + 1);
  const stopMain = guard.indexOf('/usr/bin/systemctl --user stop iva.service', stopOther);
  const restoreFunction = guard.indexOf('iva_guard__restore_units()');
  const restoreMain = guard.indexOf('/usr/bin/systemctl --user start iva.service', restoreFunction);
  const restoreOther = guard.indexOf('/usr/bin/systemctl --user start "$unit"', restoreMain);
  const restoreTimer = guard.indexOf('/usr/bin/systemctl --user start "$unit"', restoreOther + 1);
  const openSudo = guard.indexOf('iva_guard_open_sudo_window()');
  const positiveProbe = guard.indexOf('/usr/bin/sudo -n /usr/bin/true', openSudo);
  const cleanup = guard.indexOf('iva_guard__cleanup()');
  const ignoreSignals = guard.indexOf("trap '' HUP INT TERM", cleanup);
  const clearExit = guard.indexOf('trap - EXIT', cleanup);
  const invalidate = guard.indexOf('/usr/bin/sudo -k', cleanup);
  const proveGone = guard.indexOf('/usr/bin/sudo -n /usr/bin/true', cleanup);
  const stickyRestop = guard.indexOf('iva_guard__stop_expected_units || true', proveGone);
  const recoverCall = guard.indexOf('iva_guard_recover_app;', stickyRestop);
  const appRestop = guard.indexOf('iva_guard__stop_expected_units || true', recoverCall);
  const restoreCall = guard.indexOf('iva_guard__restore_units "$IVA_GUARD_STATE"', appRestop);
  const restoreRestop = guard.indexOf('iva_guard__stop_expected_units || true', restoreCall);

  assert.ok(begin >= 0 && publishState > begin && publishState < armed);
  assert.ok(armed < exitTrap && exitTrap < stopCall);
  assert.ok(stopFunction >= 0 && stopTimer < stopOther && stopOther < stopMain);
  assert.ok(restoreFunction >= 0 && restoreMain < restoreOther && restoreOther < restoreTimer);
  assert.ok(openSudo >= 0 && positiveProbe > openSudo);
  assert.ok(ignoreSignals > cleanup && ignoreSignals < clearExit && clearExit < invalidate);
  assert.ok(invalidate < proveGone && proveGone < stickyRestop && stickyRestop < recoverCall);
  assert.ok(recoverCall < appRestop && appRestop < restoreCall && restoreCall < restoreRestop);
  assert.match(guard, /cannot source guarded-window\.sh while a guard is armed/u);
  assert.match(guard, /application state requires one armed guard and cannot be replaced/u);
  assert.match(guard, /set -o noclobber/u);
  assert.match(guard, /\/usr\/bin\/ln -T -- "\$tmp" "\$state"/u);
  assert.match(guard, /IVA unit recovery state changed after capture/u);
  assert.match(guard, /stale recovery state exists; inspect it before retrying/u);
  assert.match(guard, /transitional IVA unit state; nothing was stopped/u);
  assert.match(guard, /application rollback failed; recovery state preserved; live set/u);
  assert.match(guard, /IVA restore failed; recovery state preserved; live set/u);
  assert.doesNotMatch(guard, /\beval\b|sudo\s+(?:bash|sh)\s+-c/iu);
});

test('transactional root wrapper restarts current code and removes only a proven-stopped failed unit', async () => {
  const wrapper = await readFile(new URL('install-and-start.sh', deployRoot), 'utf8');
  const cleanup = wrapper.indexOf('cleanup()');
  const ignoreSignals = wrapper.indexOf("trap '' HUP INT TERM", cleanup);
  const clearExit = wrapper.indexOf('trap - EXIT', cleanup);
  const stop = wrapper.indexOf('systemctl stop "$UNIT"', cleanup);
  const activeState = wrapper.indexOf('active_state=$(systemctl show "$UNIT" --property=ActiveState --value', stop);
  const jobState = wrapper.indexOf('job_state=$(systemctl show "$UNIT" --property=Job --value', activeState);
  const nonLiveCase = wrapper.indexOf('1:inactive:|1:failed:', jobState);
  const removeUnit = wrapper.indexOf('rm -f -- "$UNIT_FILE"', nonLiveCase);
  const daemonReload = wrapper.indexOf('systemctl daemon-reload', removeUnit);
  const installer = wrapper.indexOf('"$SCRIPT_DIR/install.sh"');
  const enable = wrapper.indexOf('systemctl enable "$UNIT"', installer);
  const restart = wrapper.indexOf('systemctl restart "$UNIT"', enable);
  const health = wrapper.indexOf('health_json=$(/usr/bin/curl --fail --silent --show-error', restart);
  const curlFailure = wrapper.indexOf("fail 'gateway health request failed'", health);
  const parseHealth = wrapper.indexOf('/usr/bin/python3 -c', curlFailure);
  const commit = wrapper.indexOf('CLEANUP_NEEDED=0', parseHealth);

  assert.match(wrapper, /^PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin$/mu);
  assert.match(wrapper, /\[ "\$#" -eq 0 \]/u);
  assert.match(wrapper, /\[ "\$\(id -u\)" -eq 0 \]/u);
  assert.ok(cleanup >= 0 && ignoreSignals < clearExit && clearExit < stop);
  assert.ok(stop < activeState && activeState < jobState && jobState < nonLiveCase);
  assert.ok(nonLiveCase < removeUnit && removeUnit < daemonReload);
  assert.match(wrapper, /if systemctl disable "\$UNIT"[\s\S]*disable_ok=1/u);
  assert.ok(installer >= 0 && enable < restart && restart < health);
  assert.ok(health < curlFailure && curlFailure < parseHealth && parseHealth < commit);
  assert.match(wrapper, /--unix-socket \/run\/iva-bitrix\/gateway\.sock http:\/\/localhost\/health/u);
  assert.match(wrapper, /data\.get\("ok"\) is True and data\.get\("ready"\) is True/u);
  assert.doesNotMatch(wrapper, /daemon-reload \|\| true|enable --now|BITRIX_WEBHOOK_URL|sudo\s+(?:bash|sh)\s+-c/iu);
});

test('admin installer uses a pinned root copy, guards IVA units, and invalidates the caller ticket', async () => {
  const admin = await readFile(new URL('admin-install.sh', deployRoot), 'utf8');
  const manifest = admin.indexOf('/usr/bin/sha256sum -c --strict');
  const capture = admin.indexOf('active=$(list_active_units)', manifest);
  const publish = admin.indexOf('/usr/bin/ln -T -- "$tmp_state" "$STATE_FILE"', capture);
  const stop = admin.indexOf('stop_unit_set "$EXPECTED_UNITS"', publish);
  const installer = admin.indexOf('"$LIVE_REPO/$INSTALLER_REL"', stop);
  const cleanup = admin.indexOf('cleanup()');
  const echoRestore = admin.indexOf('/usr/bin/stty echo < "$TTY_PATH"', cleanup);
  const invalidate = admin.indexOf('invalidate_sudo_ticket', echoRestore);
  const restore = admin.indexOf('restore_expected_units', invalidate);
  const removeState = admin.indexOf('/usr/bin/rm -- "$STATE_FILE"', restore);
  const complete = admin.indexOf("'ADMIN_INSTALL_COMPLETE'", removeState);
  const stopFunction = admin.indexOf('stop_unit_set()');
  const stopTimer = admin.indexOf('iva.timer|iva-*.timer', stopFunction);
  const stopOther = admin.indexOf('iva-*.service)', stopTimer);
  const stopMain = admin.indexOf('stop iva.service', stopOther);
  const restoreFunction = admin.indexOf('restore_expected_units()');
  const restoreMain = admin.indexOf('start iva.service', restoreFunction);
  const restoreOther = admin.indexOf('start "$unit"', restoreMain);
  const restoreTimer = admin.indexOf('iva.timer|iva-*.timer', restoreOther);

  assert.match(admin, /^#!\/usr\/bin\/bash$/mu);
  assert.match(admin, /^PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin$/mu);
  assert.match(admin, /\[\[ \$# -eq 1 && "\$EXPECTED_COMMIT" =~ \^\[0-9a-f\]\{40\}\$ \]\]/u);
  assert.match(admin, /\[\[ \$\(\/usr\/bin\/id -u\) -eq 0 \]\]/u);
  assert.match(admin, /A dedicated interactive TTY is required/u);
  assert.match(admin, /ROOT_COPY=\/usr\/local\/lib\/iva-bitrix-admin\/install/u);
  assert.match(admin, /fixed root-owned copy from \/usr\/local\/lib\/iva-bitrix-admin/u);
  assert.match(admin, /root:root 700/u);
  assert.match(admin, /A non-root SUDO_USER is required/u);
  assert.match(admin, /\/usr\/sbin\/runuser -u "\$IVA_USER"/u);
  assert.match(admin, /-c safe\.directory="\$LIVE_REPO"/u);
  assert.ok(manifest >= 0 && manifest < capture && capture < publish && publish < stop && stop < installer);
  assert.ok(cleanup >= 0 && echoRestore > cleanup && echoRestore < invalidate);
  assert.ok(invalidate < restore && restore < removeState && removeState < complete);
  assert.ok(stopFunction >= 0 && stopTimer < stopOther && stopOther < stopMain);
  assert.ok(restoreFunction >= 0 && restoreMain < restoreOther && restoreOther < restoreTimer);
  assert.match(admin, /run_as_sudo_caller \/usr\/bin\/sudo -k/u);
  assert.match(admin, /run_as_sudo_caller \/usr\/bin\/sudo -K/u);
  assert.match(admin, /run_as_sudo_caller \/usr\/bin\/sudo -n \/usr\/bin\/true/u);
  assert.match(admin, /\.bitrix\.env\.XXXXXX/u);
  assert.match(admin, /BITRIX_CHAT_READ_VERIFIED=false/u);
  assert.match(admin, /secret input was invalid; no secret was installed/u);
  assert.doesNotMatch(admin, /\beval\b|sudo\s+(?:bash|sh)\s+-c|https:\/\/b24\./iu);
});

test('root-owned secret audit fails closed without printing the webhook', async () => {
  const installer = await readFile(new URL('install.sh', deployRoot), 'utf8');
  const audit = await readFile(new URL('audit-secret.py', deployRoot), 'utf8');

  assert.match(installer, /install -o root -g root -m 0755[\s\S]*audit-secret\.py/u);
  assert.match(audit, /^#!\/usr\/bin\/python3$/mu);
  assert.match(audit, /O_NOFOLLOW/u);
  assert.match(audit, /followlinks=False/u);
  assert.match(audit, /scan-blocker:large-file/u);
  assert.match(audit, /scan-blocker:read-error/u);
  assert.match(audit, /\/usr\/bin\/journalctl/u);
  assert.match(audit, /exact-secret-clear:repo-vault-data/u);
  assert.doesNotMatch(audit, /print\(\s*(?:secret|secret_text|webhook_lines)\b|shell=True/iu);
});

test('admin manifest hashes match canonical LF source bytes', async () => {
  const admin = await readFile(new URL('admin-install.sh', deployRoot), 'utf8');
  const manifest = admin.match(/<<'MANIFEST'\n(?<body>[\s\S]+?)\nMANIFEST/u);
  assert.ok(manifest?.groups?.body);

  const repoRoot = new URL('../../', import.meta.url);
  for (const line of manifest.groups.body.split('\n')) {
    const match = line.match(/^(?<hash>[0-9a-f]{64})  (?<path>.+)$/u);
    assert.ok(match?.groups);
    const source = await readFile(new URL(match.groups.path, repoRoot), 'utf8');
    const canonical = source.replace(/\r\n/gu, '\n');
    const actual = createHash('sha256').update(canonical, 'utf8').digest('hex');
    assert.equal(actual, match.groups.hash, match.groups.path);
  }
});
