import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const runtimeHarness = fileURLToPath(
  new URL('./guarded-window-runtime.sh', import.meta.url),
);

test(
  'guarded sudo window recovers correctly in an isolated Linux mount namespace',
  { skip: process.platform !== 'linux' },
  () => {
    const result = spawnSync('/bin/bash', [runtimeHarness], {
      encoding: 'utf8',
      env: {
        ...process.env,
        LANG: 'C',
        LC_ALL: 'C',
        PATH: '/usr/bin:/bin',
      },
      timeout: 30_000,
    });
    const diagnostic = [
      `error: ${result.error?.stack ?? '<none>'}`,
      `status: ${String(result.status)}`,
      `signal: ${String(result.signal)}`,
      'stdout:',
      result.stdout ?? '',
      'stderr:',
      result.stderr ?? '',
    ].join('\n');

    assert.equal(result.error, undefined, diagnostic);
    assert.equal(result.signal, null, diagnostic);
    assert.equal(result.status, 0, diagnostic);
    assert.match(result.stdout, /^ok normal$/mu, diagnostic);
    assert.match(result.stdout, /^ok command-failure$/mu, diagnostic);
    assert.match(result.stdout, /^ok sudo-sticky$/mu, diagnostic);
    assert.match(result.stdout, /^ok restore-failure$/mu, diagnostic);
  },
);
