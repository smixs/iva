import assert from 'node:assert/strict';
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
