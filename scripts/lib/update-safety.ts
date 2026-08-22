import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  archiveInvalidCustomLayer,
  captureCustomLayer,
} from "./custom-layer.ts";
import {
  type UpdateCandidate,
  UpdateCandidateOwner,
} from "./update-candidate.ts";
import { persistUpdateBranch, resolveUpdateTarget } from "./update-channel.ts";
import {
  type CommandResult,
  runCommand,
  runCommandBuffer,
} from "./update-command.ts";
import {
  UpdateRecoveryOwner,
  type RecoveryFileOps,
  type RecoveryGit,
} from "./update-recovery.ts";
import { UpdateResourceOwners } from "./update-resource-owners.ts";

const LOCK_TTL_MS = 6 * 60 * 60 * 1000;

type UpdateLock = { ok: boolean; path: string; owner: string | null };
type UpdateTarget = Awaited<ReturnType<typeof resolveUpdateTarget>> & {
  remote: string;
  plan: "none" | "fast-forward" | "rebase";
  changed: boolean;
};
export type RestoreConflict = {
  path: string;
  baseMode: string | null;
  localMode: string | null;
  upstreamMode: string | null;
};
export type RestoreReport =
  | { status: "none" | "applied"; conflicts: readonly [] }
  | {
      status: "conflicted" | "preserved";
      conflicts: RestoreConflict[];
      recoveryDir: string;
      stashOid: string;
    };
type UpdateTransactionOptions = {
  root: string;
  dataDir: string;
  envPath: string;
  verbose?: boolean;
  logFile?: string;
  env?: NodeJS.ProcessEnv;
  recoveryFileOps?: RecoveryFileOps;
};
function readJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export { runCommand } from "./update-command.ts";

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function createUpdateLog(dataDir: string, now = new Date()): string {
  const dir = join(dataDir, "logs");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `update-${safeTimestamp(now)}.log`);
  writeFileSync(file, "", { mode: 0o600 });
  const old = readdirSync(dir)
    .filter((name) => /^update-.*\.log$/.test(name))
    .sort()
    .reverse()
    .slice(10);
  for (const name of old) rmSync(join(dir, name), { force: true });
  return file;
}

export function acquireUpdateLock(dataDir: string, owner: string): UpdateLock {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "update.lock");
  const claim = () => {
    mkdirSync(path);
    writeFileSync(
      join(path, "owner.json"),
      JSON.stringify({
        owner,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }),
      {
        mode: 0o600,
      },
    );
    return { ok: true, path, owner };
  };
  try {
    return claim();
  } catch (caught) {
    const error = caught as NodeJS.ErrnoException;
    if (error.code !== "EEXIST") throw error;
  }
  try {
    const current = readJsonObject(
      readFileSync(join(path, "owner.json"), "utf8"),
    );
    if (current?.owner === owner) return { ok: true, path, owner };
    const age = Date.now() - statSync(path).mtimeMs;
    if (age > LOCK_TTL_MS) {
      rmSync(path, { recursive: true, force: true });
      return claim();
    }
    return {
      ok: false,
      path,
      owner: typeof current?.owner === "string" ? current.owner : null,
    };
  } catch {
    const age = Date.now() - statSync(path).mtimeMs;
    if (age <= LOCK_TTL_MS) return { ok: false, path, owner: null };
    rmSync(path, { recursive: true, force: true });
    return claim();
  }
}

export function releaseUpdateLock(lock: UpdateLock | null | undefined): void {
  if (!lock?.ok || !lock.path) return;
  try {
    const current = readJsonObject(
      readFileSync(join(lock.path, "owner.json"), "utf8"),
    );
    if (current?.owner !== lock.owner) return;
  } catch {
    return;
  }
  rmSync(lock.path, { recursive: true, force: true });
}

export async function commitThenRunPostCommit({
  commit,
  postCommit,
}: {
  commit: () => Promise<void>;
  postCommit: () => Promise<void>;
}): Promise<{ ok: true } | { ok: false; error: unknown }> {
  await commit();
  try {
    await postCommit();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function parseVersion(text: string): string | null {
  try {
    const value = readJsonObject(text)?.version;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

export function createUpdateTransaction({
  root,
  dataDir,
  envPath,
  verbose = false,
  logFile,
  env = process.env,
  recoveryFileOps,
}: UpdateTransactionOptions) {
  const commandEnv = { ...env, ASSISTANT_DATA_DIR: dataDir };
  let originalHead = "";
  let branch = "";
  let updateBranch = "";
  let recoveryOwner: UpdateRecoveryOwner | null = null;
  let hadLocalChanges = false;
  let stashApplied = false;
  let changed = false;
  let cachedTarget: UpdateTarget | null = null;
  let capturedCustomPaths: string[] = [];
  const resources = new UpdateResourceOwners({
    root,
    dataDir,
    envPath,
    logFile,
    timestamp: safeTimestamp,
  });

  const run = (command: string, args: string[]): Promise<CommandResult> =>
    runCommand(command, args, { cwd: root, env: commandEnv, logFile, verbose });
  const git = (...args: string[]): Promise<CommandResult> => run("git", args);
  const mustGit = async (...args: string[]): Promise<string> => {
    const result = await git(...args);
    if (result.code !== 0)
      throw new Error(
        result.stderr || result.stdout || `git ${args[0]} failed`,
      );
    return result.stdout ?? "";
  };
  const recoveryGit: RecoveryGit = {
    run: (args, options = {}) =>
      runCommand("git", args, {
        cwd: root,
        env: { ...commandEnv, ...options.env },
        logFile,
        verbose,
        input: options.input,
        trimOutput: !options.rawOutput,
      }),
    runBuffer: (args) =>
      runCommandBuffer("git", args, { cwd: root, env: commandEnv }),
  };

  const requireRecoveryOwner = (): UpdateRecoveryOwner => {
    if (!recoveryOwner) throw new Error("a durable recovery owner is required");
    return recoveryOwner;
  };

  const safeChild = (base: string, ...parts: string[]): string => {
    const basePath = resolve(base);
    const target = resolve(base, ...parts);
    if (target !== basePath && !target.startsWith(`${basePath}${sep}`))
      throw new Error("unsafe path in update recovery data");
    return target;
  };

  const originalUntracked = (): readonly string[] =>
    recoveryOwner?.originalUntracked ?? [];

  const resolveNewStashOid = async (
    previousStashOid: string,
  ): Promise<{ oid: string; lookupError: string | null }> => {
    const primary = await git("rev-parse", "--verify", "refs/stash");
    if (primary.code === 0) {
      if (!primary.stdout || primary.stdout === previousStashOid)
        throw new Error("git stash did not create a new recovery snapshot");
      return {
        oid: primary.stdout,
        lookupError: null,
      };
    }
    const lookupError =
      primary.stderr || primary.stdout || "couldn't resolve the recovery stash";
    const fallback = await git(
      "for-each-ref",
      "--format=%(objectname)",
      "refs/stash",
    );
    if (fallback.code !== 0)
      throw new Error(lookupError, {
        cause: new Error(
          fallback.stderr || fallback.stdout || "stash ref lookup failed",
        ),
      });
    if (!fallback.stdout || fallback.stdout === previousStashOid)
      throw new Error("git stash did not create a new recovery snapshot");
    return { oid: fallback.stdout, lookupError };
  };

  const unmergedPaths = async (cwd = root): Promise<string[]> => {
    const result = await runCommand(
      "git",
      ["diff", "--name-only", "--diff-filter=U", "-z"],
      { cwd, env: commandEnv },
    );
    if (result.code !== 0)
      throw new Error(result.stderr || "couldn't inspect update conflicts");
    return result.stdout.split("\0").filter(Boolean).sort();
  };

  const resolveConflictsToHead = async (
    paths: readonly string[],
    cwd = root,
  ): Promise<void> => {
    for (const path of paths) {
      const existsAtHead = await runCommand(
        "git",
        ["cat-file", "-e", `HEAD:${path}`],
        { cwd, env: commandEnv },
      );
      const resolved =
        existsAtHead.code === 0
          ? await runCommand(
              "git",
              [
                "--literal-pathspecs",
                "restore",
                "--source=HEAD",
                "--staged",
                "--worktree",
                "--",
                path,
              ],
              { cwd, env: commandEnv },
            )
          : await runCommand(
              "git",
              [
                "--literal-pathspecs",
                "rm",
                "-f",
                "--ignore-unmatch",
                "--",
                path,
              ],
              { cwd, env: commandEnv },
            );
      if (resolved.code !== 0)
        throw new Error(resolved.stderr || `couldn't resolve ${path}`);
      if (existsAtHead.code !== 0)
        rmSync(safeChild(cwd, path), { recursive: true, force: true });
    }
  };

  const candidates = new UpdateCandidateOwner({
    root,
    dataDir,
    envPath,
    commandEnv,
    logFile,
    verbose,
    git,
    mustGit,
    unmergedPaths,
    resolveConflictsToHead,
    resources,
  });

  const gitBlob = async (
    revision: string,
    path: string,
  ): Promise<Buffer | null> => {
    const result = await runCommandBuffer(
      "git",
      ["show", `${revision}:${path}`],
      { cwd: root, env: commandEnv },
    );
    return result.code === 0 ? result.stdout : null;
  };

  const gitMode = async (
    revision: string,
    path: string,
  ): Promise<string | null> => {
    const result = await git(
      "--literal-pathspecs",
      "ls-tree",
      revision,
      "--",
      path,
    );
    if (result.code !== 0 || !result.stdout) return null;
    return result.stdout.split(/\s+/, 1)[0] || null;
  };

  const writeRecoveryBlob = (
    recoveryDir: string,
    side: "base" | "local" | "upstream",
    path: string,
    contents: Buffer | null,
  ): void => {
    if (!contents) return;
    const target = safeChild(recoveryDir, side, path);
    mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(target, contents, { mode: 0o600 });
    chmodSync(target, 0o600);
  };

  const archiveLocalChanges = async ({
    conflicts,
    reason,
  }: {
    conflicts: readonly string[];
    reason:
      | "conflict"
      | "stash-apply-failed"
      | "custom-build-failed"
      | "custom-layer-invalid";
  }): Promise<{
    recoveryDir: string;
    conflictReports: RestoreConflict[];
  }> => {
    const owner = requireRecoveryOwner();
    const protectedStash = owner.snapshotOid || owner.restoreStashOid;
    if (!protectedStash)
      throw new Error("no protected stash is available for recovery");
    const shortTarget = (cachedTarget?.remote || "unknown").slice(0, 12);
    const recoveryDir = join(
      dataDir,
      "update-conflicts",
      `${safeTimestamp()}-${shortTarget}`,
    );
    mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
    chmodSync(recoveryDir, 0o700);
    const conflictReports: RestoreConflict[] = [];
    for (const path of conflicts) {
      const stashBlob = await gitBlob(protectedStash, path);
      const localRevision =
        stashBlob !== null ? protectedStash : `${protectedStash}^3`;
      const [base, local, upstream, baseMode, localMode, upstreamMode] =
        await Promise.all([
          gitBlob(originalHead, path),
          stashBlob !== null
            ? Promise.resolve(stashBlob)
            : gitBlob(localRevision, path),
          gitBlob("HEAD", path),
          gitMode(originalHead, path),
          gitMode(localRevision, path),
          gitMode("HEAD", path),
        ]);
      writeRecoveryBlob(recoveryDir, "base", path, base);
      writeRecoveryBlob(recoveryDir, "local", path, local);
      writeRecoveryBlob(recoveryDir, "upstream", path, upstream);
      conflictReports.push({
        path,
        baseMode,
        localMode,
        upstreamMode,
      });
    }
    const patch = await runCommandBuffer(
      "git",
      ["diff", "--binary", "--full-index", originalHead, protectedStash],
      { cwd: root, env: commandEnv },
    );
    if (patch.code !== 0)
      throw new Error(patch.stderr || "couldn't archive local update patch");
    const patchPath = join(recoveryDir, "changes.patch");
    writeFileSync(patchPath, patch.stdout, { mode: 0o600 });
    chmodSync(patchPath, 0o600);
    const reportPath = join(recoveryDir, "report.json");
    writeFileSync(
      reportPath,
      `${JSON.stringify(
        {
          schema: "iva-update-conflicts/v1",
          createdAt: new Date().toISOString(),
          reason,
          beforeHead: originalHead,
          afterHead: cachedTarget?.remote || null,
          stashOid: protectedStash,
          originalUntracked: [...originalUntracked()],
          conflicts: conflictReports,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    chmodSync(reportPath, 0o600);
    return { recoveryDir, conflictReports };
  };

  async function protect() {
    originalHead = await mustGit("rev-parse", "HEAD");
    branch = await mustGit("rev-parse", "--abbrev-ref", "HEAD");
    if (!branch || branch === "HEAD")
      throw new Error("detached HEAD: switch to the update branch first");
    cachedTarget = await inspectTarget();
    const [stableHead, stableBranch] = await Promise.all([
      mustGit("rev-parse", "HEAD"),
      mustGit("rev-parse", "--abbrev-ref", "HEAD"),
    ]);
    if (stableHead !== originalHead || stableBranch !== branch)
      throw new Error("repository changed while resolving the update target");
    recoveryOwner = await UpdateRecoveryOwner.create({
      root,
      headOid: originalHead,
      retentionRoot: join(dataDir, "update-recovery-debt"),
      git: recoveryGit,
      ...(recoveryFileOps ? { files: recoveryFileOps } : {}),
    });

    resources.protectEnvironment();

    const message = `iva-update-${safeTimestamp()}`;
    const capturedState = await recoveryOwner.capture(message, {
      ...(cachedTarget.plan === "none"
        ? {}
        : { collisionTarget: cachedTarget.remote }),
      excludedIgnoredRoots: [".env", ".output", "node_modules"],
    });
    hadLocalChanges = capturedState.dirty;
    if (hadLocalChanges) {
      await recoveryOwner.storeSnapshot(message);
      await recoveryOwner.prepareLiveTree();
      try {
        const captured = captureCustomLayer({
          root,
          dataDir,
          baseRevision: originalHead,
          stashRevision: recoveryOwner.snapshotOid,
        });
        capturedCustomPaths = captured.paths;
      } catch (error) {
        candidates.setInvalidRecoveryDir(
          archiveInvalidCustomLayer({
            dataDir,
            targetRevision: originalHead,
            error,
          }),
        );
      }

      // Remove only authored paths, then create the smaller restore stash. The exact full
      // stash remains the rollback source until commit, while authored files live in data.
      if (capturedCustomPaths.length > 0)
        await resolveConflictsToHead(capturedCustomPaths);
      const remaining = await mustGit("status", "--porcelain=v1");
      if (remaining.trim()) {
        const previousRestoreStash = await git(
          "rev-parse",
          "--verify",
          "--quiet",
          "refs/stash",
        );
        if (previousRestoreStash.code !== 0 && previousRestoreStash.stderr)
          throw new Error(previousRestoreStash.stderr);
        const previousRestoreStashOid =
          previousRestoreStash.code === 0 ? previousRestoreStash.stdout : "";
        const stashed = await git(
          "stash",
          "push",
          "--include-untracked",
          "--message",
          `${message}-core-patch`,
        );
        if (stashed.code !== 0)
          throw new Error(
            stashed.stderr || stashed.stdout || "git stash push failed",
          );
        const restoreStash = await resolveNewStashOid(previousRestoreStashOid);
        if (restoreStash.lookupError) throw new Error(restoreStash.lookupError);
        recoveryOwner.setRestoreStashOid(restoreStash.oid);
      }
      await recoveryOwner.removeIgnoredCollisions();
    } else {
      try {
        captureCustomLayer({ root, dataDir, baseRevision: originalHead });
      } catch (error) {
        candidates.setInvalidRecoveryDir(
          archiveInvalidCustomLayer({
            dataDir,
            targetRevision: originalHead,
            error,
          }),
        );
      }
    }
    return {
      originalHead,
      branch,
      hadLocalChanges,
      stashOid: recoveryOwner.snapshotOid || recoveryOwner.restoreStashOid,
    };
  }

  // Fetch + классификация плана интеграции БЕЗ движения HEAD. Отдельный шаг, чтобы
  // buildCandidate() мог собрать target в worktree до любых изменений живого дерева.
  async function inspectTarget(): Promise<UpdateTarget> {
    const target = await resolveUpdateTarget({ git });
    updateBranch = target.branch;
    const remote = target.targetHead;
    let plan: UpdateTarget["plan"] = "none";
    if (remote !== originalHead) {
      if (
        (await git("merge-base", "--is-ancestor", originalHead, remote))
          .code === 0
      )
        plan = "fast-forward";
      else if (
        (await git("merge-base", "--is-ancestor", remote, originalHead))
          .code === 0
      )
        plan = "none";
      else plan = "rebase";
    }
    return { ...target, remote, plan, changed: plan !== "none" };
  }

  async function resolveTarget() {
    cachedTarget ??= await inspectTarget();
    return cachedTarget;
  }

  async function fetchAndIntegrate() {
    const target = cachedTarget ?? (await resolveTarget());
    if (!target) throw new Error("update target could not be resolved");
    if (target.plan === "none") return { ...target, changed: false };
    if (target.plan === "fast-forward") {
      await mustGit("merge", "--ff-only", target.remote);
    } else {
      const rebase = await git("rebase", target.remote);
      if (rebase.code !== 0) {
        await git("rebase", "--abort");
        throw new Error("local commits conflict with the update");
      }
    }
    changed = true;
    return { ...target, changed };
  }

  async function restoreLocalChanges(): Promise<RestoreReport> {
    const owner = requireRecoveryOwner();
    const ignoredCollisions = [...owner.ignoredCollisionPaths];
    const candidate = candidates.candidate;
    const customConflicts = candidate?.customConflicts ?? [];
    const customRecoveryDir = candidate?.customRecoveryDir;
    const fallbackReason = candidate?.fallbackReason;
    const customConflictReport = (): RestoreReport | null => {
      if (!customRecoveryDir || customConflicts.length === 0) return null;
      if (owner.snapshotOid) owner.retain();
      return {
        status: fallbackReason ? "preserved" : "conflicted",
        conflicts: customConflicts.map((path) => ({
          path,
          baseMode: null,
          localMode: null,
          upstreamMode: null,
        })),
        recoveryDir: customRecoveryDir,
        stashOid: owner.snapshotOid,
      };
    };
    const finish = async (report: RestoreReport): Promise<RestoreReport> => {
      await owner.restoreFlagsForCurrentIndex();
      if (
        owner.snapshotOid &&
        (report.status === "applied" || report.status === "none")
      )
        await owner.confirmApplied(capturedCustomPaths);
      return report;
    };
    const preserveIgnoredCollisions =
      async (): Promise<RestoreReport | null> => {
        if (!owner.hasIgnoredCollisions) return null;
        const archived = await archiveLocalChanges({
          conflicts: ignoredCollisions,
          reason: "conflict",
        });
        owner.retain();
        return {
          status: "preserved",
          conflicts: archived.conflictReports,
          recoveryDir: archived.recoveryDir,
          stashOid: owner.snapshotOid,
        };
      };
    if (!owner.restoreStashOid) {
      const ignoredReport = await preserveIgnoredCollisions();
      if (ignoredReport) return finish(ignoredReport);
      const customReport = customConflictReport();
      if (customReport) return finish(customReport);
      if (capturedCustomPaths.length > 0 && !fallbackReason) {
        stashApplied = true;
        return finish({ status: "applied", conflicts: [] });
      }
      return finish({ status: "none", conflicts: [] });
    }
    const result = await git(
      "stash",
      "apply",
      "--index",
      owner.restoreStashOid,
    );
    const conflicts = result.code === 0 ? [] : await unmergedPaths();
    if (result.code === 0 || conflicts.length > 0)
      await owner.rebindOriginalUntracked();
    if (result.code === 0 && !fallbackReason) {
      stashApplied = true;
      const ignoredReport = await preserveIgnoredCollisions();
      if (ignoredReport) return finish(ignoredReport);
      return finish(
        customConflictReport() ?? { status: "applied", conflicts: [] },
      );
    }
    if (result.code !== 0 && conflicts.length === 0 && !fallbackReason)
      throw new Error(
        result.stderr || "local changes could not be restored safely",
      );

    const recoveryConflicts = [
      ...new Set([...conflicts, ...ignoredCollisions]),
    ].sort();
    const archived = await archiveLocalChanges({
      conflicts: recoveryConflicts,
      reason: fallbackReason || "conflict",
    });
    owner.retain();
    if (fallbackReason) {
      await mustGit("reset", "--hard", "HEAD");
      return finish({
        status: "preserved",
        conflicts: archived.conflictReports,
        recoveryDir: archived.recoveryDir,
        stashOid: owner.snapshotOid || owner.restoreStashOid,
      });
    }
    await resolveConflictsToHead(conflicts);
    return finish({
      status: "conflicted",
      conflicts: archived.conflictReports,
      recoveryDir: archived.recoveryDir,
      stashOid: owner.snapshotOid || owner.restoreStashOid,
    });
  }

  async function buildCandidate({
    npm = "npm",
  }: { npm?: string } = {}): Promise<UpdateCandidate | null> {
    return candidates.build({
      target: cachedTarget,
      originalHead,
      recovery: requireRecoveryOwner(),
      originalUntracked: originalUntracked(),
      npm,
    });
  }

  async function promoteCandidate(): Promise<boolean> {
    return candidates.promote();
  }

  async function teardownCandidate(): Promise<void> {
    await candidates.teardown();
  }

  async function rollback() {
    const errors: Error[] = [];
    const capture = (error: unknown): void => {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    };
    try {
      candidates.discardCustomLayer();
    } catch (error) {
      capture(error);
    }
    errors.push(...resources.rollback());
    try {
      if (recoveryOwner) {
        const gitDirResult = await git("rev-parse", "--git-dir");
        if (gitDirResult.code === 0) {
          const gitDir = resolve(root, gitDirResult.stdout.trim());
          const rebaseApply = join(gitDir, "rebase-apply");
          if (
            existsSync(join(gitDir, "rebase-merge")) ||
            (existsSync(rebaseApply) &&
              !existsSync(join(rebaseApply, "applying")))
          ) {
            const aborted = await git("rebase", "--abort");
            if (aborted.code !== 0)
              throw new Error(
                aborted.stderr || aborted.stdout || "git rebase --abort failed",
              );
          }
        }
        await recoveryOwner.rollback();
        stashApplied = hadLocalChanges;
        // Without this the recovery stash from protect() survives a failed
        // /update and accumulates in `git stash list`. commit() (the success
        // path) already drops it through the same dropExactStash — rollback()
        // did not keep that symmetry.
        await recoveryOwner.cleanup(
          dropExactStash,
          resources.recoveryExcludedPaths,
        );
      }
    } catch (error) {
      capture(error);
    }
    if (errors.length > 0)
      throw new AggregateError(
        errors,
        `update rollback incomplete: ${errors.map(({ message }) => message).join("; ")}`,
      );
  }

  async function dropExactStash(oid: string) {
    if (!oid) return;
    const list = await git("stash", "list", "--format=%H %gd");
    if (list.code !== 0)
      throw new Error(
        list.stderr || list.stdout || "could not list recovery stashes",
      );
    const match = (list.stdout ?? "")
      .split("\n")
      .map((line) => line.trim().split(/\s+/, 2))
      .find(([candidateOid]) => candidateOid === oid);
    if (match?.[1]) {
      const selected = await git("rev-parse", "--verify", match[1]);
      if (selected.code !== 0 || selected.stdout !== oid)
        throw new Error(
          selected.stderr || "recovery stash selector changed before cleanup",
        );
      const dropped = await git("stash", "drop", match[1]);
      if (dropped.code !== 0)
        throw new Error(
          dropped.stderr || dropped.stdout || "recovery stash cleanup failed",
        );
    } else if (logFile)
      appendFileSync(logFile, `recovery stash not found for cleanup: ${oid}\n`);
  }

  async function commit() {
    candidates.commitCustomLayer();
    if (updateBranch) await persistUpdateBranch(git, updateBranch);
    if (recoveryOwner)
      await recoveryOwner.cleanup(
        dropExactStash,
        resources.recoveryExcludedPaths,
      );
    resources.cleanup();
  }

  async function versions() {
    const beforeText = await git("show", `${originalHead}:package.json`);
    const afterHead = (await mustGit("rev-parse", "HEAD")).trim();
    const afterText = await git("show", `${afterHead}:package.json`);
    return {
      beforeHead: originalHead,
      afterHead,
      beforeVersion: parseVersion(beforeText.stdout ?? "")
        ? `v${parseVersion(beforeText.stdout ?? "")}`
        : "previous build",
      afterVersion: parseVersion(afterText.stdout ?? "")
        ? `v${parseVersion(afterText.stdout ?? "")}`
        : "new build",
    };
  }

  return {
    protect,
    resolveTarget,
    fetchAndIntegrate,
    restoreLocalChanges,
    buildCandidate,
    promoteCandidate,
    teardownCandidate,
    backupOutput: () => resources.backupOutput(),
    adoptOutput: () => resources.adoptOutput(),
    rollback,
    commit,
    versions,
    run,
    git,
    get changed() {
      return changed;
    },
    get hadLocalChanges() {
      return hadLocalChanges;
    },
    get stashApplied() {
      return stashApplied;
    },
    get outputTouched() {
      return resources.outputTouched;
    },
  };
}
