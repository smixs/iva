/* eslint-disable @typescript-eslint/no-floating-promises -- Node registers top-level tests synchronously. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createUpdateTransaction } from "./update-safety.ts";
import {
  git,
  recoveryFixture as fixture,
  recoveryTransaction as transaction,
  wrappedRecoveryTransaction as wrappedTransaction,
} from "../fixtures/update-recovery.ts";

function gitHex(cwd: string, ...args: string[]): string {
  return Buffer.from(execFileSync("git", args, { cwd })).toString("hex");
}

function rawState(local: string) {
  return {
    status: gitHex(
      local,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ),
    staged: gitHex(local, "diff", "--binary", "--cached"),
    tracked: readFileSync(join(local, "tracked.txt")).toString("hex"),
    untracked: readFileSync(join(local, "raw.bin")).toString("hex"),
  };
}

function prepareRawState(local: string) {
  writeFileSync(join(local, "tracked.txt"), "staged\n");
  git(local, "add", "tracked.txt");
  writeFileSync(join(local, "tracked.txt"), "unstaged\r\n");
  writeFileSync(join(local, "raw.bin"), Buffer.from([0, 65, 10, 255]));
  return rawState(local);
}

function rawDebtCopies(data: string, expected: Buffer): string[] {
  const debt = join(data, "update-recovery-debt");
  try {
    return readdirSync(debt).filter((name) => {
      try {
        return readFileSync(join(debt, name, "owned")).equals(expected);
      } catch {
        return false;
      }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

test("rollback restores raw bytes without clean, smudge or eol filters", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  git(fx.local, "config", "filter.lossy.clean", "LC_ALL=C tr A B");
  git(fx.local, "config", "filter.lossy.smudge", "cat");
  git(fx.local, "config", "filter.lossy.required", "true");
  writeFileSync(
    join(fx.local, ".gitattributes"),
    [
      "filtered.txt filter=lossy -text",
      "filtered.bin filter=lossy -text",
      "eol.txt text eol=crlf",
      "",
    ].join("\n"),
  );
  writeFileSync(join(fx.local, "filtered.txt"), "base\n");
  writeFileSync(join(fx.local, "filtered.bin"), Buffer.from([0, 1, 255]));
  writeFileSync(join(fx.local, "eol.txt"), "base\n");
  git(
    fx.local,
    "add",
    ".gitattributes",
    "filtered.txt",
    "filtered.bin",
    "eol.txt",
  );
  git(fx.local, "commit", "-m", "add filtered files");

  writeFileSync(join(fx.local, "filtered.txt"), "A-staged\n");
  git(fx.local, "add", "filtered.txt");
  writeFileSync(join(fx.local, "filtered.txt"), "A-unstaged\r\n");
  writeFileSync(join(fx.local, "filtered.bin"), Buffer.from([0, 65, 10, 255]));
  writeFileSync(join(fx.local, "eol.txt"), "raw-eol\r\n");
  const leadingPath = " leading\nname ";
  writeFileSync(join(fx.local, leadingPath), Buffer.from([32, 0, 10, 255]));
  const state = () => ({
    status: gitHex(
      fx.local,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ),
    staged: gitHex(fx.local, "diff", "--binary", "--cached"),
    filtered: readFileSync(join(fx.local, "filtered.txt")).toString("hex"),
    binary: readFileSync(join(fx.local, "filtered.bin")).toString("hex"),
    eol: readFileSync(join(fx.local, "eol.txt")).toString("hex"),
    leading: readFileSync(join(fx.local, leadingPath)).toString("hex"),
  });
  const before = state();
  const tx = transaction(fx);

  await tx.protect();
  const recoveryOid = git(
    fx.local,
    "for-each-ref",
    "--format=%(objectname)",
    "refs/iva/update-recovery",
  );
  assert.equal(
    execFileSync("git", ["show", `${recoveryOid}:filtered.txt`], {
      cwd: fx.local,
    }).toString("hex"),
    before.filtered,
  );
  assert.equal(
    execFileSync("git", ["show", `${recoveryOid}:filtered.bin`], {
      cwd: fx.local,
    }).toString("hex"),
    before.binary,
  );

  await tx.rollback();

  assert.deepEqual(state(), before);
});

test("rollback restores assume-unchanged and skip-worktree flags with hidden bytes", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  writeFileSync(join(fx.local, "skip.txt"), "skip base\n");
  git(fx.local, "add", "skip.txt");
  git(fx.local, "commit", "-m", "add index flag fixture");
  git(fx.local, "update-index", "--assume-unchanged", "tracked.txt");
  git(fx.local, "update-index", "--skip-worktree", "skip.txt");
  writeFileSync(join(fx.local, "tracked.txt"), "assume hidden\n");
  writeFileSync(join(fx.local, "skip.txt"), "skip hidden\n");
  const state = () => ({
    flags: git(fx.local, "ls-files", "-v", "--", "tracked.txt", "skip.txt"),
    tracked: readFileSync(join(fx.local, "tracked.txt"), "utf8"),
    skip: readFileSync(join(fx.local, "skip.txt"), "utf8"),
  });
  const before = state();
  const tx = transaction(fx);

  await tx.protect();
  await tx.rollback();

  assert.deepEqual(state(), before);
});

test("intent-to-add fails closed without changing its index metadata", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  writeFileSync(join(fx.local, "intent.txt"), "intent bytes\n");
  git(fx.local, "add", "--intent-to-add", "intent.txt");
  const state = () => ({
    status: gitHex(fx.local, "status", "--porcelain=v2", "-z"),
    debug: git(fx.local, "ls-files", "--debug", "--", "intent.txt"),
    bytes: readFileSync(join(fx.local, "intent.txt")).toString("hex"),
  });
  const before = state();
  const tx = transaction(fx);

  await assert.rejects(
    () => tx.protect(),
    /intent-to-add index entries cannot be snapshotted safely/u,
  );
  await tx.rollback();

  assert.deepEqual(state(), before);
});

test("partial raw materialization failure retains recovery and a retry restores exactly", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  const before = prepareRawState(fx.local);
  const fail = join(fx.temp, "fail-materialization");
  const count = join(fx.temp, "cat-file-count");
  const tx = wrappedTransaction(
    fx,
    `if [ -f ${JSON.stringify(fail)} ] && [ "$1" = cat-file ] && [ "$2" = blob ]; then\n` +
      `  n=0; [ ! -f ${JSON.stringify(count)} ] || n=$(cat ${JSON.stringify(count)})\n` +
      "  n=$((n + 1))\n" +
      `  printf '%s' "$n" > ${JSON.stringify(count)}\n` +
      '  if [ "$n" -eq 2 ]; then\n' +
      "    printf '%s\\n' 'injected raw materialization failure' >&2\n" +
      "    exit 92\n" +
      "  fi\n" +
      "fi\n",
  );
  await tx.protect();
  const recoveryOid = git(
    fx.local,
    "for-each-ref",
    "--format=%(objectname)",
    "refs/iva/update-recovery",
  );
  writeFileSync(fail, "fail\n");

  await assert.rejects(
    () => tx.rollback(),
    /update rollback incomplete: injected raw materialization failure/u,
  );

  assert.equal(
    git(
      fx.local,
      "for-each-ref",
      "--format=%(objectname)",
      "refs/iva/update-recovery",
    ),
    recoveryOid,
  );
  assert.match(
    git(fx.local, "stash", "list", "--format=%H"),
    new RegExp(recoveryOid, "u"),
  );
  rmSync(fail);
  rmSync(count, { force: true });

  await tx.rollback();

  assert.deepEqual(rawState(fx.local), before);
});

for (const boundary of ["index", "entry"] as const) {
  test(`raw ${boundary} removal preserves a foreign tracked-path replacement`, async (t) => {
    const fx = fixture();
    t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
    prepareRawState(fx.local);
    const tracked = join(fx.local, "tracked.txt");
    const displaced = join(fx.temp, `tracked-${boundary}-owned`);
    const foreignBytes = Buffer.from([0, 255, 7, 10]);
    let armed = false;
    let triggered = false;
    const tx = createUpdateTransaction({
      root: fx.local,
      dataDir: fx.data,
      envPath: join(fx.local, ".env"),
      recoveryFileOps: {
        beforeRawTrackedRemoval(path, actualBoundary) {
          if (!armed || path !== tracked || actualBoundary !== boundary) return;
          armed = false;
          triggered = true;
          try {
            renameSync(tracked, displaced);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          mkdirSync(tracked);
          writeFileSync(join(tracked, "foreign.bin"), foreignBytes);
        },
        remove(path) {
          rmSync(path, { recursive: true, force: true });
        },
      },
    });
    await tx.protect();
    armed = true;
    const recoveryOid = git(
      fx.local,
      "for-each-ref",
      "--format=%(objectname)",
      "refs/iva/update-recovery",
    );

    await assert.rejects(() => tx.rollback(), /update rollback incomplete/u);

    assert.equal(triggered, true);
    assert.deepEqual(readFileSync(join(tracked, "foreign.bin")), foreignBytes);
    assert.equal(
      git(
        fx.local,
        "for-each-ref",
        "--format=%(objectname)",
        "refs/iva/update-recovery",
      ),
      recoveryOid,
    );
  });
}

test("a same-inode writer cannot lose bytes at the raw tracked replacement boundary", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  prepareRawState(fx.local);
  const tracked = join(fx.local, "tracked.txt");
  const foreignBytes = Buffer.from([7, 0, 255, 10, 8]);
  let armed = false;
  let triggered = false;
  const tx = createUpdateTransaction({
    root: fx.local,
    dataDir: fx.data,
    envPath: join(fx.local, ".env"),
    recoveryFileOps: {
      beforeRawTrackedReplace(path) {
        if (!armed || path !== tracked) return;
        armed = false;
        triggered = true;
        writeFileSync(path, foreignBytes);
      },
      remove(path) {
        rmSync(path, { recursive: true, force: true });
      },
    },
  });
  await tx.protect();
  armed = true;
  const recoveryOid = git(
    fx.local,
    "for-each-ref",
    "--format=%(objectname)",
    "refs/iva/update-recovery",
  );
  let restoreError: unknown = null;

  try {
    await tx.rollback();
  } catch (error) {
    restoreError = error;
  }

  assert.equal(triggered, true);
  assert.ok(restoreError instanceof Error);
  assert.equal(rawDebtCopies(fx.data, foreignBytes).length, 1);
  assert.equal(
    git(
      fx.local,
      "for-each-ref",
      "--format=%(objectname)",
      "refs/iva/update-recovery",
    ),
    recoveryOid,
  );
});

test("an afterCreate same-inode writer cannot lose raw tracked bytes", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  prepareRawState(fx.local);
  const tracked = join(fx.local, "tracked.txt");
  const foreignBytes = Buffer.from([5, 0, 253, 10, 4]);
  let armed = false;
  let triggered = false;
  const tx = createUpdateTransaction({
    root: fx.local,
    dataDir: fx.data,
    envPath: join(fx.local, ".env"),
    recoveryFileOps: {
      afterCreate(kind, path) {
        if (!armed || kind !== "file" || path !== "tracked.txt") return;
        armed = false;
        triggered = true;
        const inode = statSync(tracked, { bigint: true }).ino;
        writeFileSync(tracked, foreignBytes);
        assert.equal(statSync(tracked, { bigint: true }).ino, inode);
      },
      remove(path) {
        rmSync(path, { recursive: true, force: true });
      },
    },
  });
  await tx.protect();
  armed = true;
  const recoveryOid = git(
    fx.local,
    "for-each-ref",
    "--format=%(objectname)",
    "refs/iva/update-recovery",
  );
  let restoreError: unknown = null;

  try {
    await tx.rollback();
  } catch (error) {
    restoreError = error;
  }

  assert.equal(triggered, true);
  assert.ok(restoreError instanceof Error);
  assert.deepEqual(readFileSync(tracked), foreignBytes);
  assert.equal(rawDebtCopies(fx.data, foreignBytes).length, 1);
  assert.equal(
    git(
      fx.local,
      "for-each-ref",
      "--format=%(objectname)",
      "refs/iva/update-recovery",
    ),
    recoveryOid,
  );
});

test("a raw tracked publish collision preserves the target and retries exactly", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  const before = prepareRawState(fx.local);
  const tracked = join(fx.local, "tracked.txt");
  const survivor = join(fx.temp, "foreign-tracked-survivor");
  const foreignBytes = Buffer.from([3, 0, 252, 10, 2]);
  const desiredBytes = Buffer.from("unstaged\r\n");
  let armed = false;
  let triggered = false;
  const tx = createUpdateTransaction({
    root: fx.local,
    dataDir: fx.data,
    envPath: join(fx.local, ".env"),
    recoveryFileOps: {
      afterRawTrackedPrepare() {
        if (!armed) return;
        armed = false;
        triggered = true;
        writeFileSync(tracked, foreignBytes, { flag: "wx" });
      },
      remove(path) {
        rmSync(path, { recursive: true, force: true });
      },
    },
  });
  await tx.protect();
  const preparedBefore = rawDebtCopies(fx.data, desiredBytes).length;
  armed = true;
  const recoveryOid = git(
    fx.local,
    "for-each-ref",
    "--format=%(objectname)",
    "refs/iva/update-recovery",
  );

  await assert.rejects(() => tx.rollback(), /update rollback incomplete/u);

  assert.equal(triggered, true);
  assert.deepEqual(readFileSync(tracked), foreignBytes);
  assert.equal(rawDebtCopies(fx.data, desiredBytes).length, preparedBefore + 1);
  assert.equal(
    git(
      fx.local,
      "for-each-ref",
      "--format=%(objectname)",
      "refs/iva/update-recovery",
    ),
    recoveryOid,
  );

  renameSync(tracked, survivor);
  await tx.rollback();

  assert.deepEqual(rawState(fx.local), before);
  assert.deepEqual(readFileSync(survivor), foreignBytes);
});

for (const phase of ["prepared", "linked"] as const) {
  test(`a fault after raw tracked ${phase} state retains recovery and retries`, async (t) => {
    const fx = fixture();
    t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
    const before = prepareRawState(fx.local);
    const desiredBytes = Buffer.from("unstaged\r\n");
    let armed = false;
    let triggered = false;
    const fail = (): void => {
      if (!armed || triggered) return;
      triggered = true;
      throw new Error(`injected raw tracked ${phase} fault`);
    };
    const tx = createUpdateTransaction({
      root: fx.local,
      dataDir: fx.data,
      envPath: join(fx.local, ".env"),
      recoveryFileOps: {
        afterRawTrackedPrepare() {
          if (phase === "prepared") fail();
        },
        afterCreate(kind, path) {
          if (phase === "linked" && kind === "file" && path === "tracked.txt")
            fail();
        },
        remove(path) {
          rmSync(path, { recursive: true, force: true });
        },
      },
    });
    await tx.protect();
    const preparedBefore = rawDebtCopies(fx.data, desiredBytes).length;
    armed = true;
    const recoveryOid = git(
      fx.local,
      "for-each-ref",
      "--format=%(objectname)",
      "refs/iva/update-recovery",
    );

    await assert.rejects(
      () => tx.rollback(),
      new RegExp(
        `update rollback incomplete: injected raw tracked ${phase} fault`,
        "u",
      ),
    );

    assert.equal(triggered, true);
    assert.equal(
      rawDebtCopies(fx.data, desiredBytes).length,
      preparedBefore + 1,
    );
    assert.equal(
      git(
        fx.local,
        "for-each-ref",
        "--format=%(objectname)",
        "refs/iva/update-recovery",
      ),
      recoveryOid,
    );

    await tx.rollback();

    assert.deepEqual(rawState(fx.local), before);
  });
}

test("a post-rename same-inode writer remains in raw retention debt", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  prepareRawState(fx.local);
  const foreignBytes = Buffer.from([9, 0, 254, 10, 6]);
  let armed = false;
  let triggered = false;
  const tx = createUpdateTransaction({
    root: fx.local,
    dataDir: fx.data,
    envPath: join(fx.local, ".env"),
    recoveryFileOps: {
      afterRawTrackedQuarantine(path) {
        if (!armed) return;
        armed = false;
        triggered = true;
        const inode = statSync(path, { bigint: true }).ino;
        writeFileSync(path, foreignBytes);
        assert.equal(statSync(path, { bigint: true }).ino, inode);
      },
      remove(path) {
        rmSync(path, { recursive: true, force: true });
      },
    },
  });
  await tx.protect();
  armed = true;
  const recoveryOid = git(
    fx.local,
    "for-each-ref",
    "--format=%(objectname)",
    "refs/iva/update-recovery",
  );

  await assert.rejects(() => tx.rollback(), /update rollback incomplete/u);

  assert.equal(triggered, true);
  assert.equal(rawDebtCopies(fx.data, foreignBytes).length, 1);
  assert.equal(
    git(
      fx.local,
      "for-each-ref",
      "--format=%(objectname)",
      "refs/iva/update-recovery",
    ),
    recoveryOid,
  );
});

test("a partial raw tracked create failure retains debt and retries exactly", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  const before = prepareRawState(fx.local);
  let armed = false;
  let failed = false;
  const tx = createUpdateTransaction({
    root: fx.local,
    dataDir: fx.data,
    envPath: join(fx.local, ".env"),
    recoveryFileOps: {
      beforeCreate(kind, path) {
        if (!armed || failed || kind !== "file" || path !== "tracked.txt")
          return;
        failed = true;
        throw new Error("injected raw tracked create failure");
      },
      remove(path) {
        rmSync(path, { recursive: true, force: true });
      },
    },
  });
  await tx.protect();
  armed = true;
  const recoveryOid = git(
    fx.local,
    "for-each-ref",
    "--format=%(objectname)",
    "refs/iva/update-recovery",
  );

  await assert.rejects(
    () => tx.rollback(),
    /update rollback incomplete: injected raw tracked create failure/u,
  );

  assert.equal(failed, true);
  assert.ok(rawDebtCopies(fx.data, Buffer.from("base\n")).length > 0);
  assert.equal(
    git(
      fx.local,
      "for-each-ref",
      "--format=%(objectname)",
      "refs/iva/update-recovery",
    ),
    recoveryOid,
  );

  await tx.rollback();

  assert.deepEqual(rawState(fx.local), before);
});

test("persistent restore apply failure keeps exact recovery and rolls back without apply", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  const originalHead = git(fx.local, "rev-parse", "HEAD");
  const before = prepareRawState(fx.local);
  writeFileSync(join(fx.seed, "upstream.txt"), "upstream\n");
  git(fx.seed, "add", "upstream.txt");
  git(fx.seed, "commit", "-m", "upstream");
  git(fx.seed, "push", "origin", "main");
  const fail = join(fx.temp, "fail-restore-apply");
  const tx = wrappedTransaction(
    fx,
    `if [ -f ${JSON.stringify(fail)} ] && [ "$1" = stash ] && [ "$2" = apply ]; then\n` +
      "  printf '%s\\n' 'injected persistent restore apply failure' >&2\n" +
      "  exit 94\n" +
      "fi\n",
  );
  await tx.protect();
  await tx.resolveTarget();
  await tx.fetchAndIntegrate();
  writeFileSync(fail, "fail\n");

  await assert.rejects(
    () => tx.restoreLocalChanges(),
    /injected persistent restore apply failure/u,
  );

  const recoveryOid = git(
    fx.local,
    "for-each-ref",
    "--format=%(objectname)",
    "refs/iva/update-recovery",
  );
  assert.notEqual(recoveryOid, "");
  assert.match(
    git(fx.local, "stash", "list", "--format=%H"),
    new RegExp(recoveryOid, "u"),
  );
  rmSync(fail);
  await tx.rollback();

  assert.equal(git(fx.local, "rev-parse", "HEAD"), originalHead);
  assert.deepEqual(rawState(fx.local), before);
});

test("protect-time raw materialization failure rolls back from the durable OID", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  const before = prepareRawState(fx.local);
  const armed = join(fx.temp, "arm-materialization");
  const tx = wrappedTransaction(
    fx,
    `if [ "$1" = update-ref ] && [ "$#" -eq 4 ] && printf '%s' "$2" | grep -q '^refs/iva/update-recovery/'; then\n` +
      '  __REAL_GIT__ "$@"\n' +
      "  code=$?\n" +
      `  [ "$code" -ne 0 ] || : > ${JSON.stringify(armed)}\n` +
      '  exit "$code"\n' +
      "fi\n" +
      `if [ -f ${JSON.stringify(armed)} ] && [ "$1" = cat-file ] && [ "$2" = blob ]; then\n` +
      "  printf '%s\\n' 'injected protect materialization failure' >&2\n" +
      "  exit 93\n" +
      "fi\n",
  );

  await assert.rejects(
    () => tx.protect(),
    /injected protect materialization failure/u,
  );
  const recoveryOid = git(
    fx.local,
    "for-each-ref",
    "--format=%(objectname)",
    "refs/iva/update-recovery",
  );
  assert.notEqual(recoveryOid, "");
  rmSync(armed);

  await tx.rollback();

  assert.deepEqual(rawState(fx.local), before);
});

test("rollback preserves a post-snapshot untracked file and reports incomplete recovery", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  const before = prepareRawState(fx.local);
  const tx = transaction(fx);
  await tx.protect();
  const late = join(fx.local, "late-user.bin");
  const lateBytes = Buffer.from([9, 0, 255, 10]);
  writeFileSync(late, lateBytes);

  await assert.rejects(
    () => tx.rollback(),
    /update rollback incomplete: untracked recovery ownership changed: unexpected path late-user\.bin/u,
  );

  assert.deepEqual(readFileSync(late), lateBytes);
  assert.notEqual(
    git(
      fx.local,
      "for-each-ref",
      "--format=%(objectname)",
      "refs/iva/update-recovery",
    ),
    "",
  );
  rmSync(late);
  await tx.rollback();
  assert.deepEqual(rawState(fx.local), before);
});

test("a false-success clean reset is detected and remains retryable", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  const fail = join(fx.temp, "false-reset-success");
  const tx = wrappedTransaction(
    fx,
    `if [ -f ${JSON.stringify(fail)} ] && [ "$1" = reset ] && [ "$2" = --hard ]; then\n` +
      "  exit 0\n" +
      "fi\n",
  );
  const originalHead = git(fx.local, "rev-parse", "HEAD");
  await tx.protect();
  writeFileSync(join(fx.local, "tracked.txt"), "new commit\n");
  git(fx.local, "add", "tracked.txt");
  git(fx.local, "commit", "-m", "simulate integrated update");
  writeFileSync(fail, "fail\n");

  await assert.rejects(
    () => tx.rollback(),
    /update rollback incomplete: clean recovery rollback is incomplete/u,
  );

  rmSync(fail);
  await tx.rollback();
  assert.equal(git(fx.local, "rev-parse", "HEAD"), originalHead);
  assert.equal(readFileSync(join(fx.local, "tracked.txt"), "utf8"), "base\n");
});

test("one recovery cleanup failure cannot skip env, output or node_modules rollback", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  writeFileSync(join(fx.local, ".env"), "SECRET=before\n", { mode: 0o640 });
  mkdirSync(join(fx.local, ".output/server"), { recursive: true });
  writeFileSync(join(fx.local, ".output/server/marker.txt"), "old-output\n");
  mkdirSync(join(fx.local, "node_modules"), { recursive: true });
  writeFileSync(join(fx.local, "node_modules/marker.txt"), "old-modules\n");
  mkdirSync(join(fx.local, "locked"), { recursive: true });
  writeFileSync(
    join(fx.local, "locked/original.bin"),
    Buffer.from([0, 255, 7]),
  );

  writeFileSync(join(fx.seed, "package-lock.json"), '{"lockfileVersion":3}\n');
  writeFileSync(join(fx.seed, "tracked.txt"), "upstream\n");
  git(fx.seed, "add", ".");
  git(fx.seed, "commit", "-m", "upstream dependency update");
  git(fx.seed, "push", "origin", "main");

  const fakeNpm = join(fx.temp, "fake-npm");
  writeFileSync(
    fakeNpm,
    "#!/bin/sh\n" +
      'if [ "$1" = run ]; then\n' +
      "  mkdir -p .output/server\n" +
      "  printf '%s\\n' new-output > .output/server/marker.txt\n" +
      "else\n" +
      "  mkdir -p node_modules\n" +
      "  printf '%s\\n' new-modules > node_modules/marker.txt\n" +
      "fi\n",
  );
  chmodSync(fakeNpm, 0o755);
  const tx = createUpdateTransaction({
    root: fx.local,
    dataDir: fx.data,
    envPath: join(fx.local, ".env"),
  });

  await tx.protect();
  await tx.resolveTarget();
  const candidate = await tx.buildCandidate({ npm: fakeNpm });
  assert.ok(candidate);
  await tx.fetchAndIntegrate();
  await tx.restoreLocalChanges();
  assert.equal(await tx.promoteCandidate(), true);
  const locked = join(fx.local, "locked/original.bin");
  const ownedInode = statSync(locked).ino;
  const foreignBytes = Buffer.from([8, 0, 254, 6]);
  writeFileSync(locked, foreignBytes);
  chmodSync(locked, 0o640);
  assert.equal(statSync(locked).ino, ownedInode);

  await assert.rejects(
    () => tx.rollback(),
    /update rollback incomplete: untracked recovery ownership changed: locked\/original\.bin/u,
  );

  assert.equal(readFileSync(join(fx.local, ".env"), "utf8"), "SECRET=before\n");
  assert.equal(statSync(join(fx.local, ".env")).mode & 0o777, 0o640);
  assert.equal(
    readFileSync(join(fx.local, ".output/server/marker.txt"), "utf8"),
    "old-output\n",
  );
  assert.equal(
    readFileSync(join(fx.local, "node_modules/marker.txt"), "utf8"),
    "old-modules\n",
  );
  assert.deepEqual(readFileSync(locked), foreignBytes);
  assert.equal(statSync(locked).mode & 0o777, 0o640);
  assert.notEqual(
    git(
      fx.local,
      "for-each-ref",
      "--format=%(objectname)",
      "refs/iva/update-recovery",
    ),
    "",
  );
  assert.notEqual(git(fx.local, "stash", "list", "--format=%H"), "");
  assert.deepEqual(
    readdirSync(fx.local).filter((name) =>
      name.startsWith(".output.iva-backup-"),
    ),
    [],
  );
  assert.deepEqual(
    readdirSync(fx.local).filter((name) =>
      name.startsWith("node_modules.iva-backup-"),
    ),
    [],
  );
  await tx.teardownCandidate();
});

test("protect and rollback keep a group-writable tracked file at its own permissions", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  // Only the permission differs from HEAD — the bytes and the index are untouched — so
  // this is the whole reason the snapshot is taken, and the restore must not flatten it.
  chmodSync(join(fx.local, "tracked.txt"), 0o664);
  const mode = () => statSync(join(fx.local, "tracked.txt")).mode & 0o777;
  const tx = transaction(fx);

  await tx.protect();

  assert.equal(mode(), 0o664);
  assert.equal(readFileSync(join(fx.local, "tracked.txt"), "utf8"), "base\n");

  await tx.rollback();

  assert.equal(mode(), 0o664);
  assert.equal(readFileSync(join(fx.local, "tracked.txt"), "utf8"), "base\n");
});

test("a clean rollback puts back the permissions git reset wrote through the umask", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  const tracked = join(fx.local, "tracked.txt");
  const tx = transaction(fx);

  await tx.protect();
  writeFileSync(tracked, "new commit\n");
  git(fx.local, "add", "tracked.txt");
  git(fx.local, "commit", "-m", "simulate integrated update");
  // The reset inside the rollback rewrites the file as a child of this process, so a
  // group-writable umask here is exactly the installation the updater kept failing on.
  const previous = process.umask(0o002);
  t.after(() => process.umask(previous));

  await tx.rollback();

  assert.equal(statSync(tracked).mode & 0o777, 0o644);
  assert.equal(readFileSync(tracked, "utf8"), "base\n");
});
