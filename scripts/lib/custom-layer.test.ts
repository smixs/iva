/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  captureCustomLayer,
  commitCustomLayer,
  ensureCustomRecoveryBundle,
  isAuthoredPath,
  materializeCustomLayer,
  readCustomManifest,
  rebaseBuildOutput,
  resolveCustomConflict,
} from "./custom-layer.ts";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function write(root: string, relative: string, contents: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function fixture(t: TestContext): {
  root: string;
  dataDir: string;
  base: string;
  stash: string;
} {
  const root = mkdtempSync(join(tmpdir(), "iva-custom-layer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Iva Test");
  write(root, ".gitignore", "data\n");
  write(
    root,
    "agent/instructions.md",
    "tone: stock\nkeep-a\nkeep-b\ncore: stock\n",
  );
  write(root, "agent/skills/stock/SKILL.md", "stock skill\n");
  write(root, "agent/tools/stock.ts", "export default 'stock';\n");
  write(
    root,
    "agent/provider.ts",
    'import { runtimeValue } from "../scripts/lib/runtime-dependency.ts";\n' +
      "export default runtimeValue;\n",
  );
  write(
    root,
    "scripts/lib/runtime-dependency.ts",
    'export const runtimeValue = "ready";\n',
  );
  write(root, "scripts/core.ts", "export {};\n");
  write(
    root,
    "packages/data-dir/index.ts",
    'export const resolveDataDir = () => "data";\n',
  );
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  const base = git(root, "rev-parse", "HEAD");

  write(
    root,
    "agent/instructions.md",
    "tone: mine\nkeep-a\nkeep-b\ncore: stock\n",
  );
  // Слот скиллов слой больше не забирает (их читает резолвер), поэтому «удалённое» и
  // «неотслеживаемое» показываем на инструментах — слоте, который в сборку идёт.
  rmSync(join(root, "agent/tools/stock.ts"));
  write(root, "agent/tools/local.ts", "export default 'local';\n");
  write(root, "scripts/core.ts", "export const local = true;\n");
  git(
    root,
    "stash",
    "push",
    "--include-untracked",
    "--message",
    "custom-layer-test",
  );
  const stash = git(root, "rev-parse", "refs/stash");
  return { root, dataDir, base, stash };
}

test("authored path policy is narrow and traversal-safe", () => {
  for (const path of [
    "agent/instructions.md",
    "agent/skills/my-skill/SKILL.md",
    "agent/connections/calendar.ts",
    "agent/tools/my-tool.ts",
    "agent/subagents/researcher/agent.ts",
  ])
    assert.equal(isAuthoredPath(path), true, path);

  for (const path of [
    "agent/instructions/20-core.ts",
    "agent/schedules/digest.ts",
    "agent/agent.ts",
    "package.json",
    "agent/skills/../agent.ts",
    "/agent/skills/absolute.md",
  ])
    assert.equal(isAuthoredPath(path), false, path);
});

test("conflict resolution rejects paths outside the authored layer", () => {
  for (const path of ["../agent/instructions.md", "/agent/instructions.md"])
    assert.throws(
      () =>
        resolveCustomConflict({ dataDir: "/tmp/unused", path, side: "local" }),
      /not an authored path/u,
    );
});

test("first capture migrates modified, deleted, and untracked authored files only", (t) => {
  const { root, dataDir, base, stash } = fixture(t);
  const captured = captureCustomLayer({
    root,
    dataDir,
    baseRevision: base,
    stashRevision: stash,
  });

  assert.deepEqual(captured.paths, [
    "agent/instructions.md",
    "agent/tools/local.ts",
    "agent/tools/stock.ts",
  ]);
  assert.equal(
    readFileSync(join(dataDir, "custom/agent/instructions.md"), "utf8"),
    "tone: mine\nkeep-a\nkeep-b\ncore: stock\n",
  );
  assert.equal(
    readFileSync(join(dataDir, "custom/agent/tools/local.ts"), "utf8"),
    "export default 'local';\n",
  );
  assert.equal(
    existsSync(join(dataDir, "custom/scripts/core.ts")),
    false,
    "core edits stay in the ordinary git recovery path",
  );

  const manifest = readCustomManifest(dataDir);
  assert.equal(manifest.schema, "iva-custom/v1");
  assert.equal(manifest.entries["agent/instructions.md"]?.tombstone, false);
  assert.equal(manifest.entries["agent/tools/stock.ts"]?.tombstone, true);
  assert.equal(manifest.entries["agent/tools/local.ts"]?.originSha256, null);
  assert.equal(
    manifest.entries["agent/skills/stock/SKILL.md"],
    undefined,
    "skills are read from data/custom at run time, not captured into the build",
  );
  assert.match(
    manifest.entries["agent/instructions.md"]?.originSha256 ?? "",
    /^[0-9a-f]{64}$/,
  );
  assert.match(
    manifest.entries["agent/instructions.md"]?.baseBlob ?? "",
    /^[0-9a-f]{64}$/,
  );

  write(dataDir, "custom/agent/tools/direct.ts", "export default 'direct';\n");
  captureCustomLayer({ root, dataDir, baseRevision: base });
  const refreshed = readCustomManifest(dataDir);
  assert.equal(
    refreshed.entries["agent/tools/direct.ts"]?.localSha256?.length,
    64,
  );
  assert.equal(refreshed.entries["agent/tools/direct.ts"]?.originSha256, null);
});

test("materialization applies clean three-way merges and advances the manifest atomically", (t) => {
  const { root, dataDir, base, stash } = fixture(t);
  captureCustomLayer({
    root,
    dataDir,
    baseRevision: base,
    stashRevision: stash,
  });
  write(
    root,
    "agent/instructions.md",
    "tone: stock\nkeep-a\nkeep-b\ncore: upstream\n",
  );
  write(root, "agent/tools/stock.ts", "export default 'stock';\n");

  const result = materializeCustomLayer({
    root,
    dataDir,
    targetRevision: "1".repeat(40),
    now: new Date("2026-08-07T01:02:03.000Z"),
  });

  assert.deepEqual(result.conflicts, []);
  assert.equal(
    readFileSync(join(root, "agent/instructions.md"), "utf8"),
    "tone: mine\nkeep-a\nkeep-b\ncore: upstream\n",
  );
  assert.equal(
    existsSync(join(root, "agent/tools/stock.ts")),
    false,
    "a user tombstone stays active while upstream is unchanged",
  );
  const beforeCommit = readCustomManifest(dataDir);
  assert.notEqual(
    beforeCommit.entries["agent/instructions.md"]?.originSha256,
    result.manifest.entries["agent/instructions.md"]?.originSha256,
  );

  commitCustomLayer(result);
  const committed = readCustomManifest(dataDir);
  assert.equal(
    committed.entries["agent/instructions.md"]?.originSha256,
    result.manifest.entries["agent/instructions.md"]?.originSha256,
  );
  assert.equal(existsSync(result.pendingDir), false);
  assert.equal(
    readFileSync(join(result.runtimeRoot, "agent/instructions.md"), "utf8"),
    "tone: mine\nkeep-a\nkeep-b\ncore: upstream\n",
  );
  assert.equal(
    readFileSync(
      join(result.runtimeRoot, "scripts/lib/runtime-dependency.ts"),
      "utf8",
    ),
    'export const runtimeValue = "ready";\n',
    "stable runtime keeps the external source dependency imported by agent/provider.ts",
  );
  assert.equal(
    readFileSync(
      join(result.runtimeRoot, "packages/data-dir/index.ts"),
      "utf8",
    ),
    'export const resolveDataDir = () => "data";\n',
    "stable runtime keeps packages/ imported by agent/lib/data-dir.ts",
  );
});

test("build output paths are rebound from disposable staging to stable roots", (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-build-rebase-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const buildRoot = join(root, "staging");
  const outputDir = join(buildRoot, ".output/server");
  const appRoot = join(root, "live");
  const runtimeRoot = join(root, "data/custom/runtimes/revision");
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    join(outputDir, "index.mjs"),
    JSON.stringify({
      appRoot: buildRoot,
      agentRoot: join(buildRoot, "agent"),
      scriptsPath: join(buildRoot, "agent/skills/local/scripts"),
    }),
  );

  rebaseBuildOutput({ outputDir, buildRoot, appRoot, agentRoot: runtimeRoot });

  const built = readFileSync(join(outputDir, "index.mjs"), "utf8");
  assert.equal(built.includes(buildRoot), false);
  assert.equal(built.includes(appRoot), true);
  assert.equal(
    built.includes(join(runtimeRoot, "agent/skills/local/scripts")),
    true,
  );
});

test("a conflicting customization keeps new core active and creates a recoverable bundle", (t) => {
  const { root, dataDir, base, stash } = fixture(t);
  captureCustomLayer({
    root,
    dataDir,
    baseRevision: base,
    stashRevision: stash,
  });
  write(
    root,
    "agent/instructions.md",
    "tone: upstream\nkeep-a\nkeep-b\ncore: stock\n",
  );

  const result = materializeCustomLayer({
    root,
    dataDir,
    targetRevision: "2".repeat(40),
    now: new Date("2026-08-07T02:03:04.000Z"),
  });

  assert.deepEqual(result.conflicts, ["agent/instructions.md"]);
  assert.equal(
    readFileSync(join(root, "agent/instructions.md"), "utf8"),
    "tone: upstream\nkeep-a\nkeep-b\ncore: stock\n",
  );
  assert.ok(result.recoveryDir);
  assert.equal(
    readFileSync(
      join(result.recoveryDir, "local/agent/instructions.md"),
      "utf8",
    ),
    "tone: mine\nkeep-a\nkeep-b\ncore: stock\n",
  );
  assert.equal(
    readFileSync(
      join(result.recoveryDir, "upstream/agent/instructions.md"),
      "utf8",
    ),
    "tone: upstream\nkeep-a\nkeep-b\ncore: stock\n",
  );
  assert.equal(
    result.manifest.entries["agent/instructions.md"]?.conflict?.recoveryDir,
    result.recoveryDir,
  );

  commitCustomLayer(result);
  const repeated = materializeCustomLayer({
    root,
    dataDir,
    targetRevision: "2".repeat(40),
    now: new Date("2026-08-07T02:04:05.000Z"),
  });
  assert.deepEqual(repeated.conflicts, ["agent/instructions.md"]);
  commitCustomLayer(repeated);
  assert.equal(
    readFileSync(join(dataDir, "custom/agent/instructions.md"), "utf8"),
    "tone: mine\nkeep-a\nkeep-b\ncore: stock\n",
    "an unresolved follow-up build must not overwrite the local side",
  );
  const resolved = resolveCustomConflict({
    dataDir,
    path: "agent/instructions.md",
    side: "local",
  });
  assert.equal(resolved.path, "agent/instructions.md");
  assert.equal(
    readFileSync(join(dataDir, "custom/agent/instructions.md"), "utf8"),
    "tone: mine\nkeep-a\nkeep-b\ncore: stock\n",
  );
  assert.equal(
    readCustomManifest(dataDir).entries["agent/instructions.md"]?.conflict,
    undefined,
  );
});

test("an upstream conflict resolution replaces the canonical local copy", (t) => {
  const { root, dataDir, base, stash } = fixture(t);
  captureCustomLayer({
    root,
    dataDir,
    baseRevision: base,
    stashRevision: stash,
  });
  write(
    root,
    "agent/instructions.md",
    "tone: upstream\nkeep-a\nkeep-b\ncore: stock\n",
  );
  const result = materializeCustomLayer({
    root,
    dataDir,
    targetRevision: "4".repeat(40),
    now: new Date("2026-08-07T04:05:06.000Z"),
  });
  commitCustomLayer(result);

  resolveCustomConflict({
    dataDir,
    path: "agent/instructions.md",
    side: "upstream",
  });

  assert.equal(
    readFileSync(join(dataDir, "custom/agent/instructions.md"), "utf8"),
    "tone: upstream\nkeep-a\nkeep-b\ncore: stock\n",
  );
  assert.equal(
    readCustomManifest(dataDir).entries["agent/instructions.md"]?.conflict,
    undefined,
  );
});

test("a failed custom build keeps the canonical local side intact", (t) => {
  const { root, dataDir, base, stash } = fixture(t);
  captureCustomLayer({
    root,
    dataDir,
    baseRevision: base,
    stashRevision: stash,
  });
  write(
    root,
    "agent/instructions.md",
    "tone: stock\nkeep-a\nkeep-b\ncore: upstream\n",
  );
  const result = materializeCustomLayer({
    root,
    dataDir,
    targetRevision: "5".repeat(40),
  });

  ensureCustomRecoveryBundle({
    result,
    root,
    targetRevision: "5".repeat(40),
    reason: "custom-build-failed",
  });
  commitCustomLayer(result);

  assert.equal(
    readFileSync(join(dataDir, "custom/agent/instructions.md"), "utf8"),
    "tone: mine\nkeep-a\nkeep-b\ncore: stock\n",
  );
  assert.throws(
    () =>
      resolveCustomConflict({
        dataDir,
        path: "agent/instructions.md",
        side: "edited",
      }),
    /edit the canonical customization/u,
  );
});

test("a tombstone conflicts safely when upstream changes the deleted file", (t) => {
  const { root, dataDir, base, stash } = fixture(t);
  captureCustomLayer({
    root,
    dataDir,
    baseRevision: base,
    stashRevision: stash,
  });
  write(root, "agent/tools/stock.ts", "export default 'upstream changed';\n");

  const result = materializeCustomLayer({
    root,
    dataDir,
    targetRevision: "3".repeat(40),
    now: new Date("2026-08-07T03:04:05.000Z"),
  });

  assert.deepEqual(result.conflicts, ["agent/tools/stock.ts"]);
  assert.equal(
    readFileSync(join(root, "agent/tools/stock.ts"), "utf8"),
    "export default 'upstream changed';\n",
  );
  assert.ok(result.recoveryDir);
  assert.equal(
    existsSync(join(result.recoveryDir, "local/agent/tools/stock.ts")),
    false,
  );
});

test("a custom skill stays in data/custom and never reaches the build tree", (t) => {
  const { root, dataDir, base } = fixture(t);
  write(dataDir, "custom/agent/skills/local/SKILL.md", "local skill\n");
  captureCustomLayer({ root, dataDir, baseRevision: base });

  const result = materializeCustomLayer({
    root,
    dataDir,
    targetRevision: "4".repeat(40),
    now: new Date("2026-08-07T04:05:06.000Z"),
  });

  assert.deepEqual(result.conflicts, []);
  assert.equal(
    existsSync(join(root, "agent/skills/local/SKILL.md")),
    false,
    "the resolver reads it from data/custom; a copy in the tree would be the second path",
  );
  assert.equal(
    existsSync(join(result.runtimeRoot, "agent/skills/local/SKILL.md")),
    false,
  );
  assert.equal(
    readFileSync(join(dataDir, "custom/agent/skills/local/SKILL.md"), "utf8"),
    "local skill\n",
    "nothing is removed from the user's disk",
  );
});

test("removing a bundled skill still reaches the build tree", (t) => {
  const { root, dataDir, base } = fixture(t);
  // Своя копия встроенного скилла, потом снятая: динамика умеет перекрыть одноимённый
  // скилл, но не убрать его, поэтому удаление остаётся за слоем.
  write(dataDir, "custom/agent/skills/stock/SKILL.md", "mine\n");
  captureCustomLayer({ root, dataDir, baseRevision: base });
  rmSync(join(dataDir, "custom/agent/skills/stock/SKILL.md"));
  captureCustomLayer({ root, dataDir, baseRevision: base });
  assert.equal(
    readCustomManifest(dataDir).entries["agent/skills/stock/SKILL.md"]
      ?.tombstone,
    true,
  );

  materializeCustomLayer({
    root,
    dataDir,
    targetRevision: "5".repeat(40),
    now: new Date("2026-08-07T05:06:07.000Z"),
  });

  assert.equal(existsSync(join(root, "agent/skills/stock/SKILL.md")), false);
});

test("the public build falls back to core when Git metadata is unavailable", (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-build-no-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(
    join(PROJECT_ROOT, "scripts/build.ts"),
    join(root, "scripts/build.ts"),
  );
  // The whole lib tree, so a new import inside build.ts cannot silently break the fixture.
  cpSync(join(PROJECT_ROOT, "scripts/lib"), join(root, "scripts/lib"), {
    recursive: true,
  });
  cpSync(
    join(PROJECT_ROOT, "packages/data-dir"),
    join(root, "packages/data-dir"),
    { recursive: true },
  );
  symlinkSync(
    join(PROJECT_ROOT, "node_modules"),
    join(root, "node_modules"),
    "dir",
  );
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "build-no-git-fixture",
      scripts: {
        "build:core":
          "node -e \"const f=require('node:fs');f.mkdirSync('.output/server',{recursive:true});f.writeFileSync('.output/server/marker.txt','core')\"",
      },
    }),
  );
  const bin = join(root, ".test-bin");
  mkdirSync(bin);
  const fakeGit = join(bin, "git");
  writeFileSync(fakeGit, "#!/bin/sh\nexit 127\n");
  chmodSync(fakeGit, 0o755);

  const built = spawnSync(process.execPath, [join(root, "scripts/build.ts")], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    encoding: "utf8",
  });

  assert.equal(built.status, 0, built.stderr);
  assert.equal(
    readFileSync(join(root, ".output/server/marker.txt"), "utf8"),
    "core",
  );
});

test("the recovery CLI reports resolve failures as JSON", (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "iva-recovery-cli-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [
      join(PROJECT_ROOT, "scripts/custom-recovery.ts"),
      "resolve",
      "../outside",
      "local",
    ],
    {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ASSISTANT_DATA_DIR: dataDir },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    error: "not an authored path: ../outside",
  });
  assert.equal(result.stderr, "");
});
