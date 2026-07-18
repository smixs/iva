// Self-check for env-file — run: node scripts/lib/env-file.test.mjs
import { strict as assert } from "node:assert";
import { chmod, mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvText, readEnvValues, upsertEnv } from "./env-file.mjs";

const dir = await mkdtemp(join(tmpdir(), "env-file-test-"));
const p = join(dir, ".env");

// parse: values, quote stripping, comments ignored.
assert.deepEqual(parseEnvText('A=1\n# comment\nB="two"\nC=\'three\'\nnot a line'), { A: "1", B: "two", C: "three" });
assert.deepEqual(await readEnvValues(join(dir, "missing")), {}, "missing file → {}");

// create from scratch → 0600 + trailing newline.
await upsertEnv(p, { MODEL_PROVIDER: "codex", CODEX_MODEL: "gpt-5.5" });
assert.equal(await readFile(p, "utf8"), "MODEL_PROVIDER=codex\nCODEX_MODEL=gpt-5.5\n");
assert.equal((await stat(p)).mode & 0o777, 0o600, "new file is 0600");

// in-place replace preserves comments, order, unknown keys and file mode.
await writeFile(p, "# top comment\nA=1\n\nMODEL_PROVIDER=ollama\nB=2 # keep me\n");
await chmod(p, 0o640);
await upsertEnv(p, { MODEL_PROVIDER: "openrouter", THINKING_EFFORT: "high" });
assert.equal(
  await readFile(p, "utf8"),
  "# top comment\nA=1\n\nMODEL_PROVIDER=openrouter\nB=2 # keep me\nTHINKING_EFFORT=high\n",
);
assert.equal((await stat(p)).mode & 0o777, 0o640, "existing mode preserved");

// null deletes the line (all duplicates), value trims, idempotent double-upsert.
await writeFile(p, "A=1\nTHINKING_EFFORT=low\nB=2\nTHINKING_EFFORT=high\n");
await upsertEnv(p, { THINKING_EFFORT: null, A: "  x  " });
await upsertEnv(p, { THINKING_EFFORT: null, A: "x" });
assert.equal(await readFile(p, "utf8"), "A=x\nB=2\n");

// multiline value must throw, not corrupt the file.
await assert.rejects(() => upsertEnv(p, { KEY: "line1\nline2" }), /newline/);
assert.equal(await readFile(p, "utf8"), "A=x\nB=2\n", "file untouched after reject");

await rm(dir, { recursive: true, force: true });
console.log("env-file: all assertions passed");
