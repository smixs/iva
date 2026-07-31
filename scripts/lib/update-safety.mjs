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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { persistUpdateBranch, resolveUpdateTarget } from "./update-channel.mjs";

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

export async function commitThenRunPostCommit({ commit, postCommit }) {
  await commit();
  try {
    await postCommit();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
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
  let updateBranch = "";
  let backupRef = "";
  let stashOid = "";
  let hadLocalChanges = false;
  let stashApplied = false;
  let envBackup = "";
  let outputBackup = "";
  let changed = false;
  let originalUntracked = [];
  let cachedTarget = null;
  let candidate = null;
  let nodeModulesBackup = "";
  let outputTouched = false;

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

  // Fetch + классификация плана интеграции БЕЗ движения HEAD. Отдельный шаг, чтобы
  // buildCandidate() мог собрать target в worktree до любых изменений живого дерева.
  async function resolveTarget() {
    const target = await resolveUpdateTarget({ git });
    updateBranch = target.branch;
    const remote = target.targetHead;
    let plan = "none";
    if (remote !== originalHead) {
      if ((await git("merge-base", "--is-ancestor", originalHead, remote)).code === 0) plan = "fast-forward";
      else if ((await git("merge-base", "--is-ancestor", remote, originalHead)).code === 0) plan = "none";
      else plan = "rebase";
    }
    cachedTarget = { ...target, remote, plan, changed: plan !== "none" };
    return cachedTarget;
  }

  async function fetchAndIntegrate() {
    const target = cachedTarget ?? (await resolveTarget());
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

  async function restoreLocalChanges() {
    if (!stashOid) return;
    const result = await git("stash", "apply", "--index", stashOid);
    if (result.code !== 0) throw new Error("local changes conflict with the updated source");
    stashApplied = true;
  }

  // Сборка кандидата обновления в detached worktree (ROOT/.iva-update/staging), не трогая
  // живую установку: пока кандидат не собрался, ни .output, ни node_modules, ни HEAD не
  // меняются — сломанный target приводит к раннему abort с нетронутой ивой.
  // Только для чистого fast-forward без локальных правок: тогда итоговый HEAD гарантированно
  // равен SHA кандидата. Rebase локальных коммитов / грязное дерево / force-пересборка идут
  // прежним in-place путём (не жжём лишний билд на слабом VPS).
  async function buildCandidate({ npm = "npm" } = {}) {
    if (!cachedTarget) throw new Error("resolveTarget must run before buildCandidate");
    if (cachedTarget.plan !== "fast-forward" || hadLocalChanges) return null;
    const staging = join(root, ".iva-update", "staging");
    await teardownCandidate();
    const added = await git("worktree", "add", "--detach", staging, cachedTarget.remote);
    if (added.code !== 0) throw new Error(added.stderr || "couldn't prepare the update candidate worktree");
    try {
      const depsDiff = await mustGit(
        "diff", "--name-only", `${originalHead}..${cachedTarget.remote}`, "--", "package.json", "package-lock.json",
      );
      // Отсутствие живых node_modules (битая/недоустановленная инсталляция) лечим так же,
      // как смену лока: полной установкой зависимостей в staging.
      const depsChanged = Boolean(depsDiff.trim()) || !existsSync(join(root, "node_modules"));
      if (depsChanged) {
        const install = await runCommand(
          npm,
          [existsSync(join(staging, "package-lock.json")) ? "ci" : "install"],
          { cwd: staging, env: commandEnv, logFile, verbose },
        );
        if (install.code !== 0) throw new Error("candidate dependency installation failed — live installation untouched");
      } else {
        // Лок не менялся — живые node_modules (уже пропатченные patch-package) валидны для target.
        symlinkSync(join(root, "node_modules"), join(staging, "node_modules"), "dir");
      }
      // Паритет с in-place сборкой: она идёт в cwd, где лежит .env.
      if (existsSync(envPath)) symlinkSync(envPath, join(staging, ".env"));
      const build = await runCommand(npm, ["run", "build"], { cwd: staging, env: commandEnv, logFile, verbose });
      if (build.code !== 0) throw new Error("candidate build failed — live installation untouched");
      candidate = { staging, targetSha: cachedTarget.remote, depsChanged };
      return candidate;
    } catch (error) {
      await teardownCandidate();
      throw error;
    }
  }

  // Перенос артефактов кандидата в живой корень. Только rename внутри root (одна ФС, атомарно).
  // false — вызывающий обязан собрать in-place, как раньше.
  async function promoteCandidate() {
    if (!candidate) return false;
    if (!existsSync(join(candidate.staging, ".output"))) return false;
    const head = await mustGit("rev-parse", "HEAD");
    if (head !== candidate.targetSha) return false;
    if (candidate.depsChanged) {
      // Свежие node_modules обязаны существовать в staging; иначе безопаснее пересобрать in-place.
      if (!existsSync(join(candidate.staging, "node_modules"))) return false;
      nodeModulesBackup = join(root, `node_modules.iva-backup-${Date.now()}`);
      renameSync(join(root, "node_modules"), nodeModulesBackup);
      renameSync(join(candidate.staging, "node_modules"), join(root, "node_modules"));
    }
    backupOutput();
    renameSync(join(candidate.staging, ".output"), join(root, ".output"));
    return true;
  }

  // Идемпотентный teardown: безопасен до создания worktree, после переноса артефактов и
  // при остатках от упавшего прошлого апдейта.
  async function teardownCandidate() {
    const stagingRoot = join(root, ".iva-update");
    await git("worktree", "remove", "--force", join(stagingRoot, "staging"));
    await git("worktree", "prune");
    rmSync(stagingRoot, { recursive: true, force: true });
    candidate = null;
  }

  function backupOutput() {
    outputTouched = true;
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
    if (nodeModulesBackup && existsSync(nodeModulesBackup)) {
      rmSync(join(root, "node_modules"), { recursive: true, force: true });
      renameSync(nodeModulesBackup, join(root, "node_modules"));
      nodeModulesBackup = "";
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
    if (nodeModulesBackup) {
      rmSync(nodeModulesBackup, { recursive: true, force: true });
      nodeModulesBackup = "";
    }
    await dropExactStash();
    if (updateBranch) await persistUpdateBranch(git, updateBranch);
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
    resolveTarget,
    fetchAndIntegrate,
    restoreLocalChanges,
    buildCandidate,
    promoteCandidate,
    teardownCandidate,
    backupOutput,
    rollback,
    commit,
    versions,
    run,
    git,
    get changed() { return changed; },
    get hadLocalChanges() { return hadLocalChanges; },
    get stashApplied() { return stashApplied; },
    get outputTouched() { return outputTouched; },
  };
}
