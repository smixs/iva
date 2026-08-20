import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUpdateTransaction } from "../lib/update-safety.ts";

export type RecoveryFixture = {
  temp: string;
  remote: string;
  seed: string;
  local: string;
  data: string;
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function recoveryFixture(): RecoveryFixture {
  const temp = mkdtempSync(join(tmpdir(), "iva-recovery-"));
  const remote = join(temp, "remote.git");
  const seed = join(temp, "seed");
  const local = join(temp, "local");
  const data = join(temp, "data");
  git(temp, "init", "--bare", remote);
  git(temp, "init", "-b", "main", seed);
  git(seed, "config", "user.email", "test@example.com");
  git(seed, "config", "user.name", "Iva Test");
  writeFileSync(
    join(seed, ".gitignore"),
    ".env\n.output\n/.iva-update/\nnode_modules\n",
  );
  writeFileSync(
    join(seed, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0" }),
  );
  writeFileSync(join(seed, "tracked.txt"), "base\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "base");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  git(temp, "clone", "--branch", "main", remote, local);
  git(local, "config", "user.email", "test@example.com");
  git(local, "config", "user.name", "Iva Test");
  normalizePermissions(local);
  mkdirSync(data, { recursive: true });
  return { temp, remote, seed, local, data };
}

/**
 * Git checks a clone out through the runner's umask, so a group-writable umask hands every
 * test a tree the snapshot already calls dirty on permissions alone. Pin the checkout to
 * 644 so each test decides for itself what is dirty about its tree.
 */
export function normalizePermissions(root: string): void {
  for (const path of git(root, "ls-files").split("\n").filter(Boolean))
    chmodSync(join(root, path), 0o644);
}

export function recoveryTransaction(fx: RecoveryFixture) {
  return createUpdateTransaction({
    root: fx.local,
    dataDir: fx.data,
    envPath: join(fx.local, ".env"),
  });
}

export function addIgnoreRule(fx: RecoveryFixture, pattern: string): void {
  writeFileSync(
    join(fx.seed, ".gitignore"),
    `${readFileSync(join(fx.seed, ".gitignore"), "utf8")}${pattern}\n`,
  );
  git(fx.seed, "add", ".gitignore");
  git(fx.seed, "commit", "-m", `ignore ${pattern}`);
  git(fx.seed, "push", "origin", "main");
  git(fx.local, "pull", "--ff-only");
  normalizePermissions(fx.local);
}

export function wrappedRecoveryTransaction(fx: RecoveryFixture, body: string) {
  const bin = join(fx.temp, "wrapped-git");
  const wrapper = join(bin, "git");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  mkdirSync(bin);
  writeFileSync(
    wrapper,
    "#!/bin/sh\n" +
      body.replaceAll("__REAL_GIT__", JSON.stringify(realGit)) +
      `\nexec ${JSON.stringify(realGit)} "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  return createUpdateTransaction({
    root: fx.local,
    dataDir: fx.data,
    envPath: join(fx.local, ".env"),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
}
