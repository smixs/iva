import { spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";

const LOCK_TTL_MS = 6 * 60 * 60 * 1000;

export function runCommand(command, args, { cwd, env = process.env, logFile, verbose = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const collect = (kind, stream, target) => {
      stream.on("data", (chunk) => {
        const text = chunk.toString();
        if (kind === "out") stdout += text;
        else stderr += text;
        if (logFile) appendFileSync(logFile, text);
        if (verbose) target.write(text);
      });
    };
    collect("out", child.stdout, process.stdout);
    collect("err", child.stderr, process.stderr);
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function createUpdateLog(dataDir, now = new Date()) {
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

export function acquireUpdateLock(dataDir, owner) {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "update.lock");
  const claim = () => {
    mkdirSync(path);
    writeFileSync(join(path, "owner.json"), JSON.stringify({ owner, pid: process.pid, startedAt: new Date().toISOString() }), {
      mode: 0o600,
    });
    return { ok: true, path, owner };
  };
  try {
    return claim();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  try {
    const current = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
    if (current.owner === owner) return { ok: true, path, owner };
    const age = Date.now() - statSync(path).mtimeMs;
    if (age > LOCK_TTL_MS) {
      rmSync(path, { recursive: true, force: true });
      return claim();
    }
    return { ok: false, path, owner: current.owner || null };
  } catch {
    const age = Date.now() - statSync(path).mtimeMs;
    if (age <= LOCK_TTL_MS) return { ok: false, path, owner: null };
    rmSync(path, { recursive: true, force: true });
    return claim();
  }
}

export function releaseUpdateLock(lock) {
  if (!lock?.ok || !lock.path) return;
  try {
    const current = JSON.parse(readFileSync(join(lock.path, "owner.json"), "utf8"));
    if (current.owner !== lock.owner) return;
  } catch {
    return;
  }
  rmSync(lock.path, { recursive: true, force: true });
}

function parseVersion(text) {
  try {
    return JSON.parse(text).version || null;
  } catch {
    return null;
  }
}

export function createUpdateTransaction({ root, dataDir, envPath, verbose = false, logFile, env = process.env }) {
  const commandEnv = { ...env };
  let originalHead = "";
  let branch = "";
  let backupRef = "";
  let stashOid = "";
  let hadLocalChanges = false;
  let stashApplied = false;
  let envBackup = "";
  let outputBackup = "";
  let changed = false;
  let originalUntracked = [];

  const run = (command, args) => runCommand(command, args, { cwd: root, env: commandEnv, logFile, verbose });
  const git = (...args) => run("git", args);
  const mustGit = async (...args) => {
    const result = await git(...args);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || `git ${args[0]} failed`);
    return result.stdout;
  };

  async function protect() {
    originalHead = await mustGit("rev-parse", "HEAD");
    branch = await mustGit("rev-parse", "--abbrev-ref", "HEAD");
    if (!branch || branch === "HEAD") throw new Error("detached HEAD: switch to the update branch first");
    backupRef = `refs/iva/update-backups/${safeTimestamp()}`;
    await mustGit("update-ref", backupRef, originalHead);

    const backups = join(dataDir, "update-backups");
    mkdirSync(backups, { recursive: true });
    if (existsSync(envPath)) {
      envBackup = join(backups, `.env-${safeTimestamp()}`);
      copyFileSync(envPath, envBackup);
      chmodSync(envBackup, 0o600);
    }

    const status = await mustGit("status", "--porcelain=v1");
    hadLocalChanges = Boolean(status.trim());
    if (hadLocalChanges) {
      const untracked = await mustGit("ls-files", "--others", "--exclude-standard", "-z");
      originalUntracked = untracked.split("\0").filter(Boolean);
      const message = `iva-update-${safeTimestamp()}`;
      await mustGit("stash", "push", "--include-untracked", "--message", message);
      stashOid = await mustGit("rev-parse", "refs/stash");
    }
    return { originalHead, branch, hadLocalChanges, stashOid };
  }

  async function fetchAndIntegrate() {
    const fetchResult = await git("fetch", "--prune", "origin", branch);
    if (fetchResult.code !== 0) throw new Error(fetchResult.stderr || "git fetch failed");
    const remote = await mustGit("rev-parse", `origin/${branch}`);
    if (remote === originalHead) return { changed: false, remote };

    const ff = await git("merge-base", "--is-ancestor", originalHead, remote);
    if (ff.code === 0) {
      await mustGit("merge", "--ff-only", remote);
      changed = true;
      return { changed, remote };
    }

    const remoteBehind = await git("merge-base", "--is-ancestor", remote, originalHead);
    if (remoteBehind.code === 0) return { changed: false, remote };

    const rebase = await git("rebase", remote);
    if (rebase.code !== 0) {
      await git("rebase", "--abort");
      throw new Error("local commits conflict with the update");
    }
    changed = true;
    return { changed, remote };
  }

  async function restoreLocalChanges() {
    if (!stashOid) return;
    const result = await git("stash", "apply", "--index", stashOid);
    if (result.code !== 0) throw new Error("local changes conflict with the updated source");
    stashApplied = true;
  }

  function backupOutput() {
    const output = join(root, ".output");
    if (!existsSync(output)) return;
    outputBackup = join(root, `.output.iva-backup-${Date.now()}`);
    renameSync(output, outputBackup);
  }

  function restoreOutput() {
    if (!outputBackup || !existsSync(outputBackup)) return;
    rmSync(join(root, ".output"), { recursive: true, force: true });
    renameSync(outputBackup, join(root, ".output"));
    outputBackup = "";
  }

  async function rollback() {
    await git("rebase", "--abort");
    if (originalHead) await git("reset", "--hard", originalHead);
    if (envBackup && existsSync(envBackup)) {
      copyFileSync(envBackup, envPath);
      chmodSync(envPath, 0o600);
    }
    restoreOutput();
    if (stashOid) {
      // A failed stash apply can leave a subset of the original untracked files behind.
      // Remove only paths proven to be present in the still-retained stash, then re-apply
      // them on the exact original HEAD. Never use git clean or a broad directory target.
      const rootPath = `${resolve(root)}${sep}`;
      for (const relative of originalUntracked) {
        const target = resolve(root, relative);
        if (target.startsWith(rootPath)) rmSync(target, { recursive: true, force: true });
      }
      const reapplied = await git("stash", "apply", "--index", stashOid);
      stashApplied = reapplied.code === 0;
    }
  }

  async function dropExactStash() {
    if (!stashOid) return;
    const list = await git("stash", "list", "--format=%H %gd");
    const match = list.stdout.split("\n").map((line) => line.trim().split(/\s+/, 2)).find(([oid]) => oid === stashOid);
    if (match?.[1]) await git("stash", "drop", match[1]);
  }

  async function commit() {
    if (outputBackup) {
      rmSync(outputBackup, { recursive: true, force: true });
      outputBackup = "";
    }
    await dropExactStash();
    if (backupRef) await git("update-ref", "-d", backupRef);
    if (envBackup) rmSync(envBackup, { force: true });
  }

  async function versions() {
    const beforeText = await git("show", `${originalHead}:package.json`);
    const afterHead = (await mustGit("rev-parse", "HEAD")).trim();
    const afterText = await git("show", `${afterHead}:package.json`);
    return {
      beforeHead: originalHead,
      afterHead,
      beforeVersion: parseVersion(beforeText.stdout) ? `v${parseVersion(beforeText.stdout)}` : "previous build",
      afterVersion: parseVersion(afterText.stdout) ? `v${parseVersion(afterText.stdout)}` : "new build",
    };
  }

  return {
    protect,
    fetchAndIntegrate,
    restoreLocalChanges,
    backupOutput,
    rollback,
    commit,
    versions,
    run,
    git,
    get changed() { return changed; },
    get hadLocalChanges() { return hadLocalChanges; },
    get stashApplied() { return stashApplied; },
  };
}
