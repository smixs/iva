/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises */
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readCustomSkills } from "../agent/lib/custom-skills.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Stands in for `eve build`: names the tree the bundle was built from. */
const CORE = `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
mkdirSync(join(process.cwd(), ".output"), { recursive: true });
mkdirSync(join(process.cwd(), ".eve"), { recursive: true });
writeFileSync(
  join(process.cwd(), ".output/app.mjs"),
  "import " + JSON.stringify(join(process.cwd(), "agent/agent.ts")) + ";\\n",
);
writeFileSync(
  join(process.cwd(), ".output/data-dir.txt"),
  process.env.ASSISTANT_DATA_DIR ?? "",
);
writeFileSync(
  join(process.cwd(), ".eve/agent-summary.json"),
  JSON.stringify({ skills: [{ name: "mine", description: "stock" }] }),
);
`;

const worlds: string[] = [];

after(() => {
  for (const dir of worlds) rmSync(dir, { recursive: true, force: true });
});

function world(): string {
  // Resolved: a temporary directory is behind a symlink on macOS, and the paths
  // the build writes into its output are the resolved ones.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "iva-build-")));
  worlds.push(dir);
  return dir;
}

/** Enough of an Iva tree for the real `scripts/build.ts` to run over it. */
function plantTree(root: string): void {
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(join(REPO, "scripts/build.ts"), join(root, "scripts/build.ts"));
  cpSync(join(REPO, "scripts/lib"), join(root, "scripts/lib"), {
    recursive: true,
    filter: (source) => !source.endsWith(".test.ts"),
  });
  cpSync(join(REPO, "packages/data-dir"), join(root, "packages/data-dir"), {
    recursive: true,
  });
  writeFileSync(join(root, "scripts/core-build.mjs"), CORE);
  mkdirSync(join(root, "agent/skills/mine"), { recursive: true });
  writeFileSync(join(root, "agent/agent.ts"), "export const agent = 1;\n");
  writeFileSync(join(root, "agent/skills/mine/SKILL.md"), "stock\n");
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "iva",
        version: "0.3.15",
        private: true,
        type: "module",
        scripts: {
          build: "node scripts/build.ts",
          "build:core": "node scripts/core-build.mjs",
        },
      },
      null,
      2,
    )}\n`,
  );
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
}

/** A customization as PR #169 leaves it: a canonical file under data/custom. */
function plantCustomization(dataDir: string): void {
  mkdirSync(join(dataDir, "custom/agent/skills/mine"), { recursive: true });
  writeFileSync(join(dataDir, "custom/agent/skills/mine/SKILL.md"), "mine\n");
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "iva",
      GIT_AUTHOR_EMAIL: "iva@example.com",
      GIT_COMMITTER_NAME: "iva",
      GIT_COMMITTER_EMAIL: "iva@example.com",
    },
  }).trim();
}

function build(
  root: string,
  configuredDataDir?: string,
  nodeImport?: string,
): { status: number | null; output: string } {
  const result = spawnSync(
    process.execPath,
    [
      ...(nodeImport ? ["--import", nodeImport] : []),
      join(root, "scripts/build.ts"),
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        NO_COLOR: "1",
        ...(configuredDataDir === undefined
          ? {}
          : { ASSISTANT_DATA_DIR: configuredDataDir }),
      },
    },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test("the staging build receives the installation's canonical data directory", () => {
  const home = join(world(), "iva");
  const version = join(home, "versions/0.3.15-0123456789ab");
  mkdirSync(version, { recursive: true });
  plantTree(version);

  const built = build(version, " runtime ");
  assert.equal(built.status, 0, built.output);
  assert.equal(
    readFileSync(join(version, ".output/data-dir.txt"), "utf8"),
    join(home, "runtime"),
  );
});

test("the staging build promotes eve's agent summary", () => {
  const home = join(world(), "iva");
  const version = join(home, "versions/0.3.15-0123456789ab");
  mkdirSync(version, { recursive: true });
  plantTree(version);

  const built = build(version);
  assert.equal(built.status, 0, built.output);
  assert.deepEqual(
    JSON.parse(readFileSync(join(version, ".eve/agent-summary.json"), "utf8")),
    { skills: [{ name: "mine", description: "stock" }] },
  );
});

test("backup cleanup cannot roll back the promoted build", () => {
  const home = join(world(), "iva");
  const version = join(home, "versions/0.3.15-0123456789ab");
  mkdirSync(version, { recursive: true });
  plantTree(version);
  mkdirSync(join(version, ".output"), { recursive: true });
  mkdirSync(join(version, ".eve"), { recursive: true });
  writeFileSync(join(version, ".output/app.mjs"), "old output\n");
  writeFileSync(
    join(version, ".eve/agent-summary.json"),
    JSON.stringify({ skills: [{ name: "old", description: "old" }] }),
  );
  const failCleanup = join(version, "fail-cleanup.mjs");
  writeFileSync(
    failCleanup,
    `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const rmSync = fs.rmSync;
fs.rmSync = (path, options) => {
  if (String(path).includes("agent-summary.iva-build-backup-"))
    throw new Error("forced summary backup cleanup failure");
  return rmSync(path, options);
};
syncBuiltinESMExports();
`,
  );

  const built = build(version, undefined, failCleanup);
  assert.equal(built.status, 0, built.output);
  assert.match(built.output, /build artifact cleanup deferred/u);
  assert.deepEqual(
    JSON.parse(readFileSync(join(version, ".eve/agent-summary.json"), "utf8")),
    { skills: [{ name: "mine", description: "stock" }] },
  );
  assert.notEqual(
    readFileSync(join(version, ".output/app.mjs"), "utf8"),
    "old output\n",
  );
});

test("a checkout still builds through the custom layer it owns", () => {
  const home = join(world(), "iva");
  mkdirSync(home, { recursive: true });
  plantTree(home);
  git(home, ["init", "--initial-branch=main"]);
  git(home, ["add", "-A"]);
  git(home, ["commit", "-m", "initial"]);
  plantCustomization(join(home, "data"));

  const built = build(home);
  assert.equal(built.status, 0, built.output);

  // The control for the version case below: on a checkout the legacy machinery
  // is what applies the customization, and it does apply it.
  assert.ok(existsSync(join(home, "data/custom/manifest.json")));
  assert.match(
    readFileSync(join(home, ".output/app.mjs"), "utf8"),
    /data\/custom\/runtimes\//u,
  );
});

test("a custom skill is served from data/custom, not compiled into the build", async () => {
  const home = join(world(), "iva");
  mkdirSync(home, { recursive: true });
  plantTree(home);
  git(home, ["init", "--initial-branch=main"]);
  git(home, ["add", "-A"]);
  git(home, ["commit", "-m", "initial"]);
  // Так выглядит установка, у которой скилл был вкомпилен прошлой версией: файл лежит
  // в data/custom и остаётся там. Новая сборка его не копирует, а резолвер читает.
  plantCustomization(join(home, "data"));

  const built = build(home);
  assert.equal(built.status, 0, built.output);

  assert.equal(
    readFileSync(join(home, "agent/skills/mine/SKILL.md"), "utf8"),
    "stock\n",
    "the bundled skill is untouched: the customization is no longer overlaid",
  );
  const runtimes = join(home, "data/custom/runtimes");
  for (const runtime of readdirSync(runtimes))
    assert.equal(
      readFileSync(
        join(runtimes, runtime, "agent/skills/mine/SKILL.md"),
        "utf8",
      ),
      "stock\n",
      "the runtime the build points at carries the bundled skill, not the custom one",
    );

  const skills = await readCustomSkills(
    join(home, "data/custom/agent/skills"),
    () => {},
  );
  assert.deepEqual(Object.keys(skills), ["mine"]);
  assert.equal(skills.mine.markdown, "mine\n");
});

test("a version builds itself, never the checkout's custom layer", () => {
  const dir = world();
  const home = join(dir, "iva");
  const version = join(home, "versions/0.3.15-0123456789ab");
  mkdirSync(version, { recursive: true });
  plantTree(version);
  mkdirSync(join(home, "data"), { recursive: true });
  plantCustomization(join(home, "data"));
  symlinkSync(join(home, "data"), join(version, "data"));
  // The checkout the bridge has not retired yet. It is still there during the
  // very first build of the very first version - the update this release exists
  // for - and git discovery climbs out of the version straight into it.
  git(home, ["init", "--initial-branch=main"]);
  git(home, ["commit", "--allow-empty", "-m", "installed"]);
  assert.match(git(version, ["rev-parse", "HEAD"]), /^[0-9a-f]{40}$/u);

  const built = build(version);
  assert.equal(built.status, 0, built.output);

  const output = readFileSync(join(version, ".output/app.mjs"), "utf8");
  // What runs is inside the version, so rolling back to it is a symlink flip and
  // nothing else - not a directory shared with every other version.
  assert.ok(output.includes(`${version}/agent/agent.ts`), output);
  assert.doesNotMatch(output, /runtimes/u);
  assert.ok(!existsSync(join(home, "data/custom/runtimes")));
  // Untouched: no manifest written, no base blobs, no customization applied
  // behind the updater's back.
  assert.ok(!existsSync(join(home, "data/custom/manifest.json")));
  assert.equal(
    readFileSync(join(version, "agent/skills/mine/SKILL.md"), "utf8"),
    "stock\n",
  );
});
