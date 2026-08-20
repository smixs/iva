import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { resolve, sep } from "node:path";
import {
  planIgnoredCollisions,
  removeIgnoredCollisionPaths,
  verifyIgnoredCollisionSet,
} from "./update-ignored-collisions.ts";
import { OriginalUntrackedOwner } from "./update-recovery-ownership.ts";
import type { RecoveryContentEntry } from "./update-recovery-io.ts";
import {
  RawTrackedOwner,
  type RawTrackedHooks,
} from "./update-recovery-tracked-owner.ts";
import {
  type IndexFlags,
  metadataFor,
  permissionOverrides,
  type RecoverySnapshot,
  type SnapshotTreeEntry,
} from "./update-recovery-manifest.ts";
import { IgnoredCollisionOwner } from "./update-recovery-collision-owner.ts";
import { AppliedRecoveryVerifier } from "./update-recovery-applied.ts";
import { RecoveryObjectStore } from "./update-recovery-objects.ts";
import {
  RECOVERY_METADATA_PREFIX,
  RecoverySnapshotVerifier,
} from "./update-recovery-snapshot-verifier.ts";

type CommandResult = { code: number; stdout: string; stderr: string };

export type RecoveryGit = {
  run(
    args: string[],
    options?: { env?: NodeJS.ProcessEnv; input?: Buffer; rawOutput?: boolean },
  ): Promise<CommandResult>;
  runBuffer(args: string[]): Promise<{
    code: number;
    stdout: Buffer;
    stderr: string;
  }>;
};

export type RecoveryFileOps = RawTrackedHooks & {
  remove(path: string): void;
  removeCollisionLeaf?(path: string): void;
  removeEmptyDirectory?(path: string): void;
};

const DEFAULT_FILE_OPS: RecoveryFileOps = {
  remove(path) {
    rmSync(path, { recursive: true, force: true });
  },
};

type GuardState = {
  phase: "guard";
};

type CleanState = {
  phase: "clean";
  indexEntries: SnapshotTreeEntry[];
  indexTree: string;
  indexFlags: IndexFlags;
  worktreeEntries: SnapshotTreeEntry[];
  worktreeTree: string;
};

type SnapshotState = {
  phase: "snapshot";
  snapshot: RecoverySnapshot;
  restoreStashOid: string;
  cleanup:
    | { kind: "pending" }
    | { kind: "release"; excludedUntrackedPaths: readonly string[] }
    | { kind: "retain" }
    | { kind: "prune-stashes" };
};

type OwnerState = GuardState | CleanState | SnapshotState;

export class UpdateRecoveryOwner {
  readonly #root: string;
  readonly #headOid: string;
  readonly #ref: string;
  readonly #retentionRoot: string;
  readonly #git: RecoveryGit;
  readonly #files: RecoveryFileOps;
  readonly #objects: RecoveryObjectStore;
  readonly #collisions: IgnoredCollisionOwner;
  readonly #untracked: OriginalUntrackedOwner;
  readonly #applied: AppliedRecoveryVerifier;
  readonly #snapshotVerifier: RecoverySnapshotVerifier;
  #state: OwnerState = { phase: "guard" };

  private constructor({
    root,
    headOid,
    ref,
    retentionRoot,
    git,
    files,
  }: {
    root: string;
    headOid: string;
    ref: string;
    retentionRoot: string;
    git: RecoveryGit;
    files: RecoveryFileOps;
  }) {
    this.#root = root;
    this.#headOid = headOid;
    this.#ref = ref;
    this.#retentionRoot = retentionRoot;
    this.#git = git;
    this.#files = files;
    this.#objects = new RecoveryObjectStore({
      git,
      liveBytes: (entry) => this.#liveBytes(entry),
      removeTemporary: (path) => files.remove(path),
    });
    this.#collisions = new IgnoredCollisionOwner({ root, git, hooks: files });
    this.#untracked = new OriginalUntrackedOwner({ root, git, hooks: files });
    this.#snapshotVerifier = new RecoverySnapshotVerifier({
      root,
      headOid,
      git,
      objects: this.#objects,
      liveTrackedEntries: (entries) => this.#liveTrackedEntries(entries),
      liveTreeEntry: (path) => this.#liveTreeEntry(path),
      liveBytes: (entry) => this.#liveBytes(entry),
      indexFlags: () => this.#indexFlags(),
      untrackedPaths: () => this.#untrackedPaths(),
    });
    this.#applied = new AppliedRecoveryVerifier({
      git,
      objects: this.#objects,
      originalHead: headOid,
      untracked: this.#untracked,
      liveTrackedEntries: (entries) => this.#liveTrackedEntries(entries),
      indexFlags: () => this.#indexFlags(),
      untrackedPaths: () => this.#untrackedPaths(),
    });
  }

  static async create({
    root,
    headOid,
    retentionRoot,
    git,
    files = DEFAULT_FILE_OPS,
  }: {
    root: string;
    headOid: string;
    retentionRoot: string;
    git: RecoveryGit;
    files?: RecoveryFileOps;
  }): Promise<UpdateRecoveryOwner> {
    const ref = `refs/iva/update-recovery/${Date.now()}-${process.pid}-${randomUUID()}`;
    const owner = new UpdateRecoveryOwner({
      root,
      headOid,
      ref,
      retentionRoot,
      git,
      files,
    });
    await owner.#mustGit(["update-ref", ref, headOid]);
    const durableOid = await owner.#mustGit([
      "rev-parse",
      "--verify",
      `${ref}^{commit}`,
    ]);
    if (durableOid !== headOid)
      throw new Error("durable recovery guard OID does not match");
    return owner;
  }

  get snapshotOid(): string {
    return this.#state.phase === "snapshot" ? this.#state.snapshot.oid : "";
  }

  get restoreStashOid(): string {
    return this.#state.phase === "snapshot" ? this.#state.restoreStashOid : "";
  }

  get recoveryOid(): string {
    return this.snapshotOid || this.#headOid;
  }

  get originalUntracked(): readonly string[] {
    return this.#state.phase === "snapshot"
      ? this.#state.snapshot.untrackedEntries.map(({ path }) => path)
      : [];
  }

  get ignoredCollisionPaths(): readonly string[] {
    if (this.#state.phase !== "snapshot") return [];
    return this.#state.snapshot.ignoredCollisionEntries.map(({ path }) => path);
  }

  get hasIgnoredCollisions(): boolean {
    return (
      this.#state.phase === "snapshot" &&
      (this.#state.snapshot.ignoredCollisionEntries.length > 0 ||
        this.#state.snapshot.ignoredCollisionDirectories.length > 0)
    );
  }

  async capture(
    message: string,
    {
      collisionTarget,
      excludedIgnoredRoots = [],
    }: {
      collisionTarget?: string;
      excludedIgnoredRoots?: readonly string[];
    } = {},
  ): Promise<{ dirty: boolean }> {
    if (this.#state.phase !== "guard")
      throw new Error("recovery owner already captured state");
    const indexEntries = this.#objects.parseIndexEntries(
      await this.#mustGit(["ls-files", "--cached", "--stage", "-z"], true),
    );
    const indexFlags = await this.#indexFlags();
    const intentToAdd = await this.#intentToAddPaths();
    if (intentToAdd.length > 0)
      throw new Error(
        "intent-to-add index entries cannot be snapshotted safely",
      );
    const untrackedPaths = await this.#untrackedPaths();
    const indexTree = await this.#mustGit(["write-tree"]);
    const worktreeEntries = this.#liveTrackedEntries(indexEntries);
    const worktree = await this.#objects.createRawTree(
      "worktree",
      worktreeEntries,
    );
    const ignoredCollisions = collisionTarget
      ? await planIgnoredCollisions({
          root: this.#root,
          targetOid: collisionTarget,
          indexPaths: indexEntries.map(({ path }) => path),
          untrackedPaths,
          excludedRoots: excludedIgnoredRoots,
          git: this.#git,
        })
      : { entries: [], directories: [], scopes: [] };
    this.#collisions.capture(
      ignoredCollisions.entries,
      ignoredCollisions.directories,
    );
    const originalTree = await this.#mustGit([
      "rev-parse",
      "--verify",
      `${this.#headOid}^{tree}`,
    ]);
    const dirty =
      untrackedPaths.length > 0 ||
      indexFlags.assumeUnchanged.length > 0 ||
      indexFlags.skipWorktree.length > 0 ||
      indexTree !== originalTree ||
      worktree.tree !== indexTree ||
      ignoredCollisions.entries.length > 0 ||
      ignoredCollisions.directories.length > 0 ||
      Object.keys(permissionOverrides(worktreeEntries)).length > 0;
    if (!dirty) {
      this.#state = {
        phase: "clean",
        indexEntries,
        indexTree,
        indexFlags,
        worktreeEntries,
        worktreeTree: worktree.tree,
      };
      return { dirty: false };
    }

    const untrackedEntries = untrackedPaths.map((path) => {
      const entry = this.#liveTreeEntry(path);
      if (!entry)
        throw new Error(`untracked recovery path disappeared: ${path}`);
      return entry;
    });
    const untrackedDirectories =
      this.#untracked.captureDirectories(untrackedEntries);
    const recoverableUntrackedEntries = [
      ...untrackedEntries,
      ...ignoredCollisions.entries,
    ];
    const untracked =
      recoverableUntrackedEntries.length > 0
        ? await this.#objects.createRawTree(
            "untracked",
            recoverableUntrackedEntries,
          )
        : null;
    const indexCommit = await this.#objects.snapshotGit([
      "commit-tree",
      indexTree,
      "-p",
      this.#headOid,
      "-m",
      `${message} index`,
    ]);
    const untrackedCommit = untracked
      ? await this.#objects.snapshotGit([
          "commit-tree",
          untracked.tree,
          "-m",
          `${message} untracked`,
        ])
      : null;
    const ignoredCollisionEntries = ignoredCollisions.entries.map((entry) => {
      const oid = untracked?.entries.find(
        ({ path }) => path === entry.path,
      )?.oid;
      if (!oid)
        throw new Error(`ignored recovery blob OID is missing: ${entry.path}`);
      return { ...entry, oid };
    });
    const capturedUntrackedEntries = untrackedEntries.map((entry) => {
      const oid = untracked?.entries.find(
        ({ path }) => path === entry.path,
      )?.oid;
      if (!oid)
        throw new Error(
          `untracked recovery blob OID is missing: ${entry.path}`,
        );
      return { ...entry, oid };
    });
    const provisional: RecoverySnapshot = {
      oid: "",
      indexTree,
      worktreeTree: worktree.tree,
      untrackedTree: untracked?.tree ?? null,
      indexEntries,
      worktreeEntries,
      untrackedEntries: capturedUntrackedEntries,
      untrackedDirectories,
      ignoredCollisionEntries,
      ignoredCollisionDirectories: ignoredCollisions.directories,
      ignoredCollisionScopes: ignoredCollisions.scopes,
      indexFlags,
    };
    const metadata = Buffer.from(
      JSON.stringify(metadataFor(provisional)),
    ).toString("base64url");
    const oid = await this.#objects.snapshotGit([
      "commit-tree",
      worktree.tree,
      "-p",
      this.#headOid,
      "-p",
      indexCommit,
      ...(untrackedCommit ? ["-p", untrackedCommit] : []),
      "-m",
      message,
      "-m",
      `${RECOVERY_METADATA_PREFIX}${metadata}`,
    ]);
    const snapshot = { ...provisional, oid };
    await this.#snapshotVerifier.verifySnapshot(snapshot, {
      verifyFlags: true,
    });
    await this.#mustGit(["update-ref", this.#ref, oid, this.#headOid]);
    const durableOid = await this.#mustGit([
      "rev-parse",
      "--verify",
      `${this.#ref}^{commit}`,
    ]);
    if (durableOid !== oid)
      throw new Error("durable recovery snapshot OID does not match");
    this.#state = {
      phase: "snapshot",
      snapshot,
      restoreStashOid: "",
      cleanup: { kind: "pending" },
    };
    this.#untracked.bindSnapshot(
      snapshot.untrackedEntries,
      snapshot.untrackedDirectories,
    );
    return { dirty: true };
  }

  async storeSnapshot(message: string): Promise<void> {
    const state = this.#snapshotState();
    const stored = await this.#git.run([
      "stash",
      "store",
      "--message",
      message,
      state.snapshot.oid,
    ]);
    if (stored.code !== 0)
      throw new Error(
        stored.stderr || stored.stdout || "git stash store failed",
      );
  }

  setRestoreStashOid(oid: string): void {
    const state = this.#snapshotState();
    this.#state = { ...state, restoreStashOid: oid };
  }

  retain(): void {
    const state = this.#snapshotState();
    this.#state = { ...state, cleanup: { kind: "retain" } };
  }

  async confirmApplied(
    excludedUntrackedPaths: readonly string[],
  ): Promise<void> {
    const state = this.#snapshotState();
    await this.#applied.verify({
      snapshot: state.snapshot,
      restoreStashOid: state.restoreStashOid,
      excludedUntrackedPaths,
    });
    this.#state = {
      ...state,
      cleanup: { kind: "release", excludedUntrackedPaths },
    };
  }

  async prepareLiveTree(): Promise<void> {
    const state = this.#snapshotState();
    await this.#snapshotVerifier.verifySnapshot(state.snapshot, {
      verifyFlags: true,
    });
    await this.#collisions.verify(
      state.snapshot.ignoredCollisionEntries,
      state.snapshot.ignoredCollisionDirectories,
    );
    await this.#restoreSnapshot(state.snapshot, {
      preserveCollisionOwnership: true,
      restoreFlags: false,
    });
  }

  async rollback(): Promise<void> {
    if (this.#state.phase === "guard") return;
    if (this.#state.phase === "clean") {
      await this.#clearIndexFlags(this.#state.indexFlags);
      await this.#mustGit(["reset", "--hard", this.#headOid]);
      this.#restorePermissions(this.#state.worktreeEntries);
      await this.#restoreIndexFlags(this.#state.indexFlags);
      await this.#snapshotVerifier.verifyClean(this.#state);
      return;
    }
    const state = this.#state;
    this.#state = {
      ...state,
      cleanup: { kind: "prune-stashes" },
    };
    await this.#restoreSnapshot(state.snapshot, {
      preserveCollisionOwnership: false,
      restoreFlags: true,
    });
  }

  async restoreFlagsForCurrentIndex(): Promise<void> {
    if (this.#state.phase === "guard") return;
    const flags =
      this.#state.phase === "clean"
        ? this.#state.indexFlags
        : this.#state.snapshot.indexFlags;
    await this.#restoreIndexFlags(flags);
  }

  async rebindOriginalUntracked(): Promise<void> {
    const state = this.#snapshotState();
    await this.#untracked.verify(
      state.snapshot.untrackedEntries,
      state.snapshot.untrackedDirectories,
      await this.#untrackedPaths(),
      { rebind: true },
    );
  }

  async removeIgnoredCollisions(): Promise<void> {
    const state = this.#snapshotState();
    await this.#collisions.verify(
      state.snapshot.ignoredCollisionEntries,
      state.snapshot.ignoredCollisionDirectories,
    );
    await verifyIgnoredCollisionSet({
      git: this.#git,
      scopes: state.snapshot.ignoredCollisionScopes,
      entries: state.snapshot.ignoredCollisionEntries,
    });
    const removableScopes = state.snapshot.ignoredCollisionScopes.filter(
      (scope) =>
        !state.snapshot.indexEntries.some(
          ({ path }) => path === scope || path.startsWith(`${scope}/`),
        ),
    );
    removeIgnoredCollisionPaths({
      root: this.#root,
      entries: state.snapshot.ignoredCollisionEntries,
      directories: state.snapshot.ignoredCollisionDirectories,
      scopes: removableScopes,
      ...(this.#files.removeCollisionLeaf
        ? { remove: (path: string) => this.#files.removeCollisionLeaf?.(path) }
        : {}),
      ...(this.#files.removeEmptyDirectory
        ? {
            removeDirectory: (path: string) =>
              this.#files.removeEmptyDirectory?.(path),
          }
        : {}),
    });
  }

  async cleanup(
    dropExactStash: (oid: string) => Promise<void>,
    transientPaths: readonly string[] = [],
  ): Promise<void> {
    const owned = await this.#git.run(["rev-parse", "--verify", this.#ref]);
    if (owned.code !== 0 || owned.stdout !== this.recoveryOid)
      throw new Error(
        owned.stderr || "recovery ref no longer points to the owned OID",
      );
    if (this.#state.phase === "snapshot") {
      if (
        this.#state.cleanup.kind === "pending" ||
        this.#state.cleanup.kind === "retain"
      )
        return;
      if (this.#state.cleanup.kind === "release")
        await this.#applied.verify({
          snapshot: this.#state.snapshot,
          restoreStashOid: this.#state.restoreStashOid,
          excludedUntrackedPaths: [
            ...this.#state.cleanup.excludedUntrackedPaths,
            ...transientPaths,
          ],
        });
      await dropExactStash(this.#state.restoreStashOid);
      await dropExactStash(this.#state.snapshot.oid);
      if (this.#state.cleanup.kind === "prune-stashes") return;
    }
    const deleted = await this.#git.run([
      "update-ref",
      "-d",
      this.#ref,
      this.recoveryOid,
    ]);
    if (deleted.code !== 0)
      throw new Error(
        deleted.stderr || deleted.stdout || "recovery ref cleanup failed",
      );
    const remaining = await this.#git.run([
      "rev-parse",
      "--verify",
      "--quiet",
      this.#ref,
    ]);
    if (remaining.code === 0)
      throw new Error("recovery ref cleanup did not remove the owned ref");
    if (remaining.stderr) throw new Error(remaining.stderr);
  }

  async #restoreSnapshot(
    snapshot: RecoverySnapshot,
    {
      preserveCollisionOwnership,
      restoreFlags,
    }: { preserveCollisionOwnership: boolean; restoreFlags: boolean },
  ): Promise<void> {
    const currentIndex = this.#objects.parseIndexEntries(
      await this.#mustGit(["ls-files", "--cached", "--stage", "-z"], true),
    );
    this.#untracked.assertResetSafe(
      snapshot.untrackedEntries,
      snapshot.untrackedDirectories,
      currentIndex.map(({ path }) => path),
    );
    await this.#untracked.verify(
      snapshot.untrackedEntries,
      snapshot.untrackedDirectories,
      await this.#untrackedPaths(),
    );
    await this.#clearIndexFlags(snapshot.indexFlags);
    await this.#mustGit(["reset", "--hard", this.#headOid]);
    await this.#mustGit(["read-tree", snapshot.indexTree]);
    await this.#materializeTree(
      snapshot.worktreeTree,
      snapshot.indexEntries.map(({ path }) => path),
      snapshot.worktreeEntries,
    );
    if (!preserveCollisionOwnership && snapshot.untrackedTree) {
      await this.#untracked.restore(
        snapshot.untrackedEntries,
        snapshot.untrackedDirectories,
      );
      await this.#collisions.restore(
        snapshot.ignoredCollisionEntries,
        snapshot.ignoredCollisionDirectories,
      );
    }
    if (restoreFlags) await this.#restoreIndexFlags(snapshot.indexFlags);
    await this.#snapshotVerifier.verifySnapshot(snapshot, {
      verifyFlags: restoreFlags,
    });
    if (!preserveCollisionOwnership) {
      await this.#untracked.verify(
        snapshot.untrackedEntries,
        snapshot.untrackedDirectories,
        await this.#untrackedPaths(),
        { requirePresent: true },
      );
      await this.#collisions.verify(
        snapshot.ignoredCollisionEntries,
        snapshot.ignoredCollisionDirectories,
        { rebind: true },
      );
    }
  }

  // A Git tree only records the executable bit, so the live permissions the snapshot
  // captured (664 under a group-writable umask, say) have to be carried in separately —
  // otherwise the restore republishes every file at 644/755 and the verifier that runs
  // right after rejects the tree it just wrote.
  async #materializeTree(
    tree: string,
    removePaths: readonly string[],
    liveEntries: readonly SnapshotTreeEntry[] = [],
    preserveCollisionOwnership = false,
  ) {
    const entries = this.#objects.parseTreeEntries(
      await this.#mustGit(["ls-tree", "-r", "-z", tree]),
    );
    const livePermissions = new Map(
      liveEntries.flatMap(({ path, permissions }) =>
        permissions === undefined ? [] : [[path, permissions] as const],
      ),
    );
    const contents: RecoveryContentEntry[] = [];
    for (const entry of entries) {
      if (!entry.oid)
        throw new Error(`recovery blob OID is missing: ${entry.path}`);
      const blob = await this.#git.runBuffer(["cat-file", "blob", entry.oid]);
      if (blob.code !== 0)
        throw new Error(
          blob.stderr || `couldn't read recovery blob: ${entry.path}`,
        );
      const permissions = livePermissions.get(entry.path);
      contents.push({
        ...entry,
        bytes: blob.stdout,
        ...(permissions === undefined ? {} : { permissions }),
      });
    }
    const owner = new RawTrackedOwner({
      root: this.#root,
      retentionRoot: this.#retentionRoot,
      hooks: this.#files,
    });
    try {
      const desired = new Map(contents.map((entry) => [entry.path, entry]));
      const handled = new Set<string>();
      for (const path of removePaths) {
        owner.captureIndex(path);
        const entry = desired.get(path);
        const collision = preserveCollisionOwnership
          ? this.#snapshotState().snapshot.ignoredCollisionEntries.find(
              (candidate) => candidate.path === path,
            )
          : undefined;
        if (entry && collision)
          this.#collisions.verifyContent({ ...collision, bytes: entry.bytes });
        else if (entry) owner.restore(entry);
        else owner.remove(path);
        owner.release(path);
        handled.add(path);
      }
      for (const entry of contents) {
        if (handled.has(entry.path)) continue;
        const collision = preserveCollisionOwnership
          ? this.#snapshotState().snapshot.ignoredCollisionEntries.find(
              ({ path }) => path === entry.path,
            )
          : undefined;
        if (collision) {
          this.#collisions.verifyContent({ ...collision, bytes: entry.bytes });
          continue;
        }
        owner.restore(entry);
        owner.release(entry.path);
      }
    } finally {
      owner.close();
    }
  }

  async #indexFlags(): Promise<IndexFlags> {
    return this.#objects.parseIndexFlags(
      await this.#mustGit(["ls-files", "-v", "-z"], true),
    );
  }

  async #intentToAddPaths(): Promise<string[]> {
    const [ordinary, visible] = await Promise.all([
      this.#mustGit(["diff", "--cached", "--name-only", "-z"], true),
      this.#mustGit(
        ["diff", "--cached", "--name-only", "-z", "--ita-visible-in-index"],
        true,
      ),
    ]);
    const ordinaryPaths = new Set(ordinary.split("\0").filter(Boolean));
    return visible
      .split("\0")
      .filter((path) => path && !ordinaryPaths.has(path));
  }

  async #untrackedPaths(): Promise<string[]> {
    return (
      await this.#mustGit(
        ["ls-files", "--others", "--exclude-standard", "-z"],
        true,
      )
    )
      .split("\0")
      .filter(Boolean);
  }

  #liveTrackedEntries(
    indexEntries: readonly SnapshotTreeEntry[],
  ): SnapshotTreeEntry[] {
    return indexEntries
      .map(({ mode, path }) => this.#liveTreeEntry(path, mode))
      .filter((entry): entry is SnapshotTreeEntry => entry !== null);
  }

  #liveTreeEntry(path: string, indexMode?: string): SnapshotTreeEntry | null {
    let stat;
    try {
      stat = lstatSync(this.#safeChild(this.#root, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (stat.isSymbolicLink())
      return {
        mode: "120000",
        path,
        device: stat.dev,
        inode: stat.ino,
      };
    if (stat.isFile())
      return {
        mode: stat.mode & 0o111 ? "100755" : "100644",
        path,
        permissions: stat.mode & 0o777,
        device: stat.dev,
        inode: stat.ino,
      };
    if (stat.isDirectory() && indexMode === "160000")
      throw new Error(`unsupported working-tree entry: ${path} (gitlink)`);
    throw new Error(`unsupported working-tree entry: ${path}`);
  }

  // `git reset --hard` rewrites every changed file through the process umask, so a tree
  // that was 664 comes back 644 under a stricter one. The captured modes are part of what
  // recovery promises to restore, and the verifier right after this compares them.
  #restorePermissions(entries: readonly SnapshotTreeEntry[]): void {
    for (const { path, permissions } of entries) {
      if (permissions === undefined) continue;
      const target = this.#safeChild(this.#root, path);
      const stat = lstatSync(target, { throwIfNoEntry: false });
      if (!stat || stat.isSymbolicLink() || (stat.mode & 0o777) === permissions)
        continue;
      chmodSync(target, permissions);
    }
  }

  #liveBytes(entry: SnapshotTreeEntry): Buffer {
    const path = this.#safeChild(this.#root, entry.path);
    if (entry.mode === "120000")
      return readlinkSync(path, { encoding: "buffer" });
    if (entry.mode === "100644" || entry.mode === "100755")
      return readFileSync(path);
    throw new Error(`unsupported working-tree mode: ${entry.mode}`);
  }

  async #clearIndexFlags(flags: IndexFlags): Promise<void> {
    for (const path of flags.assumeUnchanged)
      await this.#mustGit([
        "--literal-pathspecs",
        "update-index",
        "--no-assume-unchanged",
        "--",
        path,
      ]);
    for (const path of flags.skipWorktree)
      await this.#mustGit([
        "--literal-pathspecs",
        "update-index",
        "--no-skip-worktree",
        "--",
        path,
      ]);
  }

  async #restoreIndexFlags(flags: IndexFlags): Promise<void> {
    for (const path of flags.assumeUnchanged)
      await this.#mustGit([
        "--literal-pathspecs",
        "update-index",
        "--assume-unchanged",
        "--",
        path,
      ]);
    for (const path of flags.skipWorktree)
      await this.#mustGit([
        "--literal-pathspecs",
        "update-index",
        "--skip-worktree",
        "--",
        path,
      ]);
  }

  #safeChild(base: string, ...parts: string[]): string {
    const basePath = resolve(base);
    const target = resolve(base, ...parts);
    if (target !== basePath && !target.startsWith(`${basePath}${sep}`))
      throw new Error("unsafe path in update recovery data");
    return target;
  }

  #snapshotState(): SnapshotState {
    if (this.#state.phase !== "snapshot")
      throw new Error("a complete recovery snapshot is required");
    return this.#state;
  }

  async #mustGit(args: string[], rawOutput = false): Promise<string> {
    const result = await this.#git.run(args, { rawOutput });
    if (result.code !== 0)
      throw new Error(
        result.stderr || result.stdout || `git ${args[0]} failed`,
      );
    return result.stdout;
  }
}
