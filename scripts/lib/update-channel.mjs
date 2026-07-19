export const DEFAULT_UPDATE_BRANCH = "main";
export const UPDATE_BRANCH_CONFIG = "iva.updateBranch";

function output(result) {
  return String(result?.stdout ?? "").trim();
}

async function requireGit(git, ...args) {
  const result = await git(...args);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || `git ${args[0]} failed`);
  return output(result);
}

async function fetchBranch(git, remote, branch) {
  const valid = await git("check-ref-format", "--branch", branch);
  if (valid.code !== 0) throw new Error(`invalid update branch: ${branch}`);
  const fetched = await git("fetch", "--prune", remote, `refs/heads/${branch}`);
  if (fetched.code !== 0) throw new Error(fetched.stderr || `couldn't fetch ${remote}/${branch}`);
  return requireGit(git, "rev-parse", "FETCH_HEAD");
}

export async function resolveUpdateTarget({
  git,
  remote = "origin",
  defaultBranch = DEFAULT_UPDATE_BRANCH,
} = {}) {
  if (typeof git !== "function") throw new Error("update target resolver requires git");
  const currentBranch = await requireGit(git, "rev-parse", "--abbrev-ref", "HEAD");
  if (!currentBranch || currentBranch === "HEAD") throw new Error("detached HEAD: switch to the update branch first");

  const configured = await git("config", "--local", "--get", UPDATE_BRANCH_CONFIG);
  const configuredBranch = configured.code === 0 ? output(configured) : "";
  if (configuredBranch) {
    return {
      branch: configuredBranch,
      currentBranch,
      configured: true,
      legacyMigration: false,
      targetHead: await fetchBranch(git, remote, configuredBranch),
    };
  }

  if (currentBranch !== defaultBranch) {
    const defaultHead = await fetchBranch(git, remote, defaultBranch);
    const merged = await git("merge-base", "--is-ancestor", "HEAD", defaultHead);
    if (merged.code === 0) {
      return {
        branch: defaultBranch,
        currentBranch,
        configured: false,
        legacyMigration: true,
        targetHead: defaultHead,
      };
    }
  }

  return {
    branch: currentBranch,
    currentBranch,
    configured: false,
    legacyMigration: false,
    targetHead: await fetchBranch(git, remote, currentBranch),
  };
}

export async function persistUpdateBranch(git, branch) {
  await requireGit(git, "config", "--local", UPDATE_BRANCH_CONFIG, branch);
}
