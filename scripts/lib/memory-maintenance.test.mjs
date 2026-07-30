import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GITHUB_BLOB_GUARD_BYTES,
  classifyGitPushError,
  memoryReportProblems,
  readMemoryMaintenanceReport,
  recordSkippedOversize,
  scanOversizeWorkingTreeFiles,
} from "./memory-maintenance.mjs";

test("oversize scan checks modified and untracked non-ignored files before staging", () => {
  let args;
  const sizes = new Map([
    ["/vault/cards/large.md", GITHUB_BLOB_GUARD_BYTES + 1],
    ["/vault/cards/small.md", GITHUB_BLOB_GUARD_BYTES],
  ]);
  const files = scanOversizeWorkingTreeFiles({
    vaultPath: "/vault",
    runGit(nextArgs) {
      args = nextArgs;
      return { status: 0, stdout: "cards/large.md\0cards/small.md\0cards/large.md\0" };
    },
    stat(path) {
      return {
        isFile: () => true,
        isSymbolicLink: () => false,
        size: sizes.get(path),
      };
    },
  });

  assert.deepEqual(args, ["ls-files", "--others", "--modified", "--exclude-standard", "-z"]);
  assert.deepEqual(files, [{ path: "cards/large.md", size: GITHUB_BLOB_GUARD_BYTES + 1 }]);
});

test("oversize scan fails closed when git cannot enumerate the working tree", () => {
  assert.throws(
    () =>
      scanOversizeWorkingTreeFiles({
        vaultPath: "/vault",
        runGit: () => ({ status: 128, stderr: "fatal: not a git repository\n" }),
      }),
    /git ls-files failed: fatal: not a git repository/,
  );
});

test("git push errors distinguish oversize history, credentials, and other failures", () => {
  assert.equal(
    classifyGitPushError("remote: error: GH001: Large files detected.").kind,
    "oversize",
  );
  assert.equal(
    classifyGitPushError("remote: error: File cards/x.md exceeds GitHub's file size limit").kind,
    "oversize",
  );
  for (const stderr of [
    "fatal: Authentication failed for 'https://github.com/x/y.git/'",
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "git@github.com: Permission denied (publickey).",
  ]) {
    assert.equal(classifyGitPushError(stderr).kind, "auth");
  }
  assert.deepEqual(classifyGitPushError("\nerror: failed to push some refs\nmore detail"), {
    kind: "other",
    firstLine: "error: failed to push some refs",
  });
});

test("memory report surfaces known non-zero problem counters and tolerates other shapes", () => {
  assert.deepEqual(
    memoryReportProblems({
      score: 90,
      total: 12,
      valid: 8,
      fixed: 2,
      review: 1,
      duplicates: 0,
      skipped_oversize: 3,
      future_field: { count: 99 },
    }),
    [
      { key: "fixed", count: 2 },
      { key: "review", count: 1 },
      { key: "skipped_oversize", count: 3 },
    ],
  );
  assert.deepEqual(memoryReportProblems({}), []);
  assert.deepEqual(memoryReportProblems(null), []);
});

test("memory report freshness and oversize marker are durable", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "iva-memory-report-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const reportPath = join(dir, "enforce-report.json");
  const now = Date.now();

  assert.deepEqual(readMemoryMaintenanceReport(reportPath, { now }), {
    status: "missing",
    problems: [],
  });

  await writeFile(reportPath, '{"review": 2}\n');
  assert.deepEqual(readMemoryMaintenanceReport(reportPath, { now }), {
    status: "fresh",
    problems: [{ key: "review", count: 2 }],
  });

  assert.equal(recordSkippedOversize(reportPath, 4), true);
  assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), {
    review: 2,
    skipped_oversize: 4,
  });

  const stale = new Date(now - 48 * 60 * 60 * 1000);
  await utimes(reportPath, stale, stale);
  assert.deepEqual(readMemoryMaintenanceReport(reportPath, { now }), {
    status: "stale",
    problems: [],
  });
});
