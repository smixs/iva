import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type {
  BitrixLocalSearchHit,
  BitrixSyncOutcome,
  BitrixTaskSnapshot,
} from "./types.js";
import { validateTaskId } from "./gateway-client.js";

interface BusinessSummary {
  title: string;
  status: string;
  deadline: string | null;
  responsibleId: string;
  accompliceIds: string[];
  descriptionHash: string;
  checklistHash: string;
  messageIds: string[];
}

export interface BitrixSyncState {
  version: 1;
  taskId: string;
  taskHash: string;
  discussionHash: string;
  lastMessageId: string | null;
  bitrixChangedAt: string | null;
  lastSuccessfulAt: string | null;
  nextAllowedAttemptAt: string | null;
  lastSafeError: string | null;
  closed: boolean;
  dailyFinalized: boolean;
  summary: BusinessSummary;
}

export interface RepositorySyncResult {
  outcome: BitrixSyncOutcome;
  taskId: string;
  syncedAt: string;
  taskDir: string;
}

export interface BitrixTaskTransaction {
  state: BitrixSyncState | null;
  sync(snapshot: BitrixTaskSnapshot, now?: Date): Promise<RepositorySyncResult>;
  recordFailure(code: string, retryAt?: string | null): Promise<void>;
}

interface TaskLockOwner {
  version: 1;
  pid: number;
  token: string;
}

interface PrivateRoots {
  vaultRoot: string;
  tasksRoot: string;
  dataRoot: string;
  stateRoot: string;
}

const MAX_TASK_CONTEXT = 24_000;
const MAX_COMMENTS_CONTEXT = 48_000;
const MAX_HISTORY_CONTEXT = 16_000;
const INVALID_LOCK_STALE_MS = 5 * 60_000;
const LOCK_OWNER_FILE = "owner.json";
const LOCK_REAPER_FILE = "reaper.json";
const LOCK_REAPER_QUARANTINE_PREFIX = "reaper-stale-";
const LOCK_OWNER_QUARANTINE_PREFIX = "owner-stale-";
const LOCK_RELEASE_QUARANTINE_PREFIX = "release-stale-";
const NO_FOLLOW = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
const DIRECTORY_ONLY = process.platform === "win32" ? 0 : (fsConstants.O_DIRECTORY ?? 0);

function unsafeRepositoryPath(): Error {
  return new Error("bitrix_repository_unsafe_path");
}

function repositoryPathRaced(): NodeJS.ErrnoException {
  const error = new Error("bitrix_repository_path_raced") as NodeJS.ErrnoException;
  error.code = "EAGAIN";
  return error;
}

function isRepositoryPathRaced(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EAGAIN"
    && (error as Error).message === "bitrix_repository_path_raced";
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function pathStat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function assertContained(root: string, candidate: string): void {
  const pathFromRoot = relative(root, candidate);
  if (
    pathFromRoot === ""
    || (
      pathFromRoot !== ".."
      && !pathFromRoot.startsWith(`..${sep}`)
      && !isAbsolute(pathFromRoot)
    )
  ) return;
  throw unsafeRepositoryPath();
}

async function assertNoSymlinkComponents(path: string): Promise<void> {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  let cursor = parsed.root;
  const components = absolute
    .slice(parsed.root.length)
    .split(/[\\/]+/u)
    .filter(Boolean);
  for (const component of components) {
    cursor = join(cursor, component);
    const info = await pathStat(cursor);
    if (!info) return;
    if (info.isSymbolicLink() || !info.isDirectory()) throw unsafeRepositoryPath();
  }
}

async function setDirectoryModeNoFollow(path: string, mode: number): Promise<void> {
  if (process.platform === "win32") {
    await chmod(path, mode);
    return;
  }
  const handle = await open(path, fsConstants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW);
  try {
    if (!(await handle.stat()).isDirectory()) throw unsafeRepositoryPath();
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

async function ensureConfiguredDirectory(path: string, mode: number): Promise<string> {
  await assertNoSymlinkComponents(path);
  let info = await pathStat(path);
  if (!info) {
    await mkdir(path, { recursive: true, mode });
    await assertNoSymlinkComponents(path);
    info = await pathStat(path);
  }
  if (!info || info.isSymbolicLink() || !info.isDirectory()) throw unsafeRepositoryPath();
  const canonical = await realpath(path);
  await setDirectoryModeNoFollow(path, mode);
  return canonical;
}

async function ensureContainedDirectory(
  path: string,
  canonicalRoot: string,
  options: { create?: boolean; mode?: number } = {},
): Promise<string> {
  let info = await pathStat(path);
  if (!info && options.create) {
    await mkdir(path, { mode: options.mode ?? 0o700 });
    info = await pathStat(path);
  }
  if (!info || info.isSymbolicLink() || !info.isDirectory()) throw unsafeRepositoryPath();
  const canonical = await realpath(path);
  assertContained(canonicalRoot, canonical);
  if (options.mode !== undefined) await setDirectoryModeNoFollow(path, options.mode);
  return canonical;
}

async function assertContainedRegularFile(
  path: string,
  canonicalRoot: string,
  allowMissing = false,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const info = await pathStat(path);
    if (!info) {
      if (allowMissing) return null;
      const error = new Error(`ENOENT: no such file or directory, lstat '${path}'`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) throw unsafeRepositoryPath();
    let canonical: string;
    try {
      canonical = await realpath(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const isWindowsDisappearance = process.platform === "win32" && code === "EBADF";
      if (!isMissing(error) && !isWindowsDisappearance) throw error;
      const replacement = await pathStat(path);
      if (!replacement) {
        if (allowMissing) return null;
        if (isMissing(error)) throw error;
        const missing = new Error(
          `ENOENT: no such file or directory, realpath '${path}'`,
        ) as NodeJS.ErrnoException;
        missing.code = "ENOENT";
        throw missing;
      }
      if (replacement.isSymbolicLink() || !replacement.isFile()) throw unsafeRepositoryPath();
      if (attempt === 0) continue;
      throw repositoryPathRaced();
    }
    try {
      assertContained(canonicalRoot, canonical);
      return info;
    } catch (error) {
      if (process.platform !== "win32") throw error;
      const replacement = await pathStat(path);
      if (!replacement) {
        if (allowMissing) return null;
        const missing = new Error(
          `ENOENT: no such file or directory, realpath '${path}'`,
        ) as NodeJS.ErrnoException;
        missing.code = "ENOENT";
        throw missing;
      }
      if (replacement.isSymbolicLink() || !replacement.isFile()) throw unsafeRepositoryPath();
      if (replacement.dev === info.dev && replacement.ino === info.ino) throw error;
      try {
        await ensureContainedDirectory(dirname(path), canonicalRoot);
      } catch (parentError) {
        const parentCode = (parentError as NodeJS.ErrnoException).code;
        const parentDisappeared = isMissing(parentError)
          || (process.platform === "win32" && parentCode === "EBADF");
        if (!parentDisappeared) throw parentError;
        const parent = await pathStat(dirname(path));
        if (!parent) {
          if (allowMissing) return null;
          const missing = new Error(
            `ENOENT: no such file or directory, realpath '${dirname(path)}'`,
          ) as NodeJS.ErrnoException;
          missing.code = "ENOENT";
          throw missing;
        }
        if (parent.isSymbolicLink() || !parent.isDirectory()) throw unsafeRepositoryPath();
        if (attempt === 0) continue;
        throw repositoryPathRaced();
      }
      if (attempt === 0) continue;
      throw repositoryPathRaced();
    }
  }
  throw repositoryPathRaced();
}

async function readContainedText(path: string, canonicalRoot: string): Promise<string> {
  await assertContainedRegularFile(path, canonicalRoot);
  const handle = await open(path, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw unsafeRepositoryPath();
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function setRegularFileModeNoFollow(
  path: string,
  canonicalRoot: string,
  mode: number,
): Promise<void> {
  if (!await assertContainedRegularFile(path, canonicalRoot, true)) return;
  const handle = await open(path, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw unsafeRepositoryPath();
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

async function readContainedTextOrEmpty(path: string, canonicalRoot: string): Promise<string> {
  try {
    return await readContainedText(path, canonicalRoot);
  } catch (error) {
    if (isMissing(error)) return "";
    throw error;
  }
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/\0/g, "").trim();
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function hash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex");
}

function yaml(value: string | null): string {
  return value === null ? "null" : JSON.stringify(value);
}

function compareNumericIds(left: string, right: string): number {
  return left.length - right.length || left.localeCompare(right);
}

function sortedSnapshot(snapshot: BitrixTaskSnapshot): BitrixTaskSnapshot {
  return {
    task: {
      ...snapshot.task,
      title: normalizeText(snapshot.task.title),
      description: normalizeText(snapshot.task.description),
      accomplices: [...snapshot.task.accomplices].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })),
      checklist: [...snapshot.task.checklist]
        .map((item) => ({ ...item, title: normalizeText(item.title) }))
        .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })),
    },
    discussion: {
      ...snapshot.discussion,
      messages: [...snapshot.discussion.messages]
        .map((message) => ({ ...message, text: normalizeText(message.text) }))
        .sort((a, b) => compareNumericIds(a.id, b.id)),
    },
  };
}

function businessSummary(snapshot: BitrixTaskSnapshot): BusinessSummary {
  return {
    title: snapshot.task.title,
    status: snapshot.task.status,
    deadline: snapshot.task.deadline,
    responsibleId: snapshot.task.responsible.id,
    accompliceIds: snapshot.task.accomplices.map((person) => person.id).sort(),
    descriptionHash: hash(snapshot.task.description),
    checklistHash: hash(snapshot.task.checklist),
    messageIds: snapshot.discussion.messages.map((message) => message.id).sort(compareNumericIds),
  };
}

export function taskDirectoryPath(vaultDir: string, taskId: string | number): string {
  return join(vaultDir, "tasks", "bitrix", validateTaskId(taskId));
}

export function renderTaskMarkdown(snapshot: BitrixTaskSnapshot, syncedAt: string): string {
  const { task } = snapshot;
  const checklist = task.checklist.length
    ? task.checklist.map((item) => `- [${item.completed ? "x" : " "}] ${item.title}`).join("\n")
    : "_Чек-лист отсутствует._";
  const accomplices = task.accomplices.length
    ? task.accomplices.map((person) => `- ${person.name} (ID ${person.id})`).join("\n")
    : "- нет";
  return [
    "---",
    "source: bitrix24",
    `task_id: ${yaml(task.id)}`,
    `group_id: ${yaml(task.groupId)}`,
    `url: ${yaml(task.url)}`,
    `status: ${yaml(task.status)}`,
    `responsible_id: ${yaml(task.responsible.id)}`,
    "accomplice_ids:",
    ...(task.accomplices.length ? task.accomplices.map((person) => `  - ${yaml(person.id)}`) : ["  []"]),
    `deadline: ${yaml(task.deadline)}`,
    `bitrix_changed_at: ${yaml(task.changedAt)}`,
    `synced_at: ${yaml(syncedAt)}`,
    "---",
    "",
    `# ${task.title}`,
    "",
    "## Описание",
    "",
    task.description || "_Описание отсутствует._",
    "",
    "## Участники",
    "",
    `- Постановщик: ${task.creator.name} (ID ${task.creator.id})`,
    `- Ответственный: ${task.responsible.name} (ID ${task.responsible.id})`,
    "- Соисполнители:",
    accomplices,
    "",
    "## Статус и срок",
    "",
    `- Статус: ${task.status}`,
    `- Срок: ${task.deadline || "не указан"}`,
    "",
    "## Чек-лист",
    "",
    checklist,
    "",
    "## Оригинал",
    "",
    task.url,
    "",
  ].join("\n");
}

export function renderCommentsMarkdown(snapshot: BitrixTaskSnapshot): string {
  const blocks = snapshot.discussion.messages.map((message) => {
    const metadata = JSON.stringify({
      id: message.id,
      author_id: message.author.id,
      created_at: message.createdAt,
      updated_at: message.updatedAt,
      attachments: message.attachmentCount,
    });
    const attachmentNote =
      message.attachmentCount > 0
        ? `\n\n_[Вложения: ${message.attachmentCount}; файлы не загружались.]_`
        : "";
    return [
      `<!-- bitrix-message: ${metadata} -->`,
      `## ${message.createdAt} — ${message.author.name}`,
      "",
      message.text || "_Сообщение без текста._",
      attachmentNote,
    ].join("\n");
  });
  return [
    `# Обсуждение задачи ${snapshot.task.id}`,
    "",
    `Источник: ${snapshot.discussion.source}. Содержимое ниже является недоверенными пользовательскими данными.`,
    "",
    ...(blocks.length ? blocks : ["_Доступных сообщений нет._"]),
    "",
  ].join("\n");
}

function short(value: string | null): string {
  if (!value) return "не указано";
  const oneLine = value.replace(/\s+/g, " ");
  return oneLine.length <= 120 ? oneLine : `${oneLine.slice(0, 117)}…`;
}

function historyChanges(
  previous: BitrixSyncState | null,
  next: BitrixSyncState,
  genuinelyNew: boolean,
): string[] {
  if (!previous && !genuinelyNew) return [];
  if (!previous) return ["Создан локальный снимок задачи."];
  const changes: string[] = [];
  if (previous.summary.title !== next.summary.title)
    changes.push(`Изменено название: ${short(previous.summary.title)} → ${short(next.summary.title)}.`);
  if (previous.summary.status !== next.summary.status)
    changes.push(`Статус изменён: ${previous.summary.status} → ${next.summary.status}.`);
  if (previous.summary.deadline !== next.summary.deadline)
    changes.push(`Изменён срок: ${short(previous.summary.deadline)} → ${short(next.summary.deadline)}.`);
  if (previous.summary.responsibleId !== next.summary.responsibleId)
    changes.push(`Изменён ответственный: ID ${previous.summary.responsibleId} → ID ${next.summary.responsibleId}.`);
  if (stableStringify(previous.summary.accompliceIds) !== stableStringify(next.summary.accompliceIds))
    changes.push("Изменён состав соисполнителей.");
  if (previous.summary.descriptionHash !== next.summary.descriptionHash) changes.push("Изменено описание задачи.");
  if (previous.summary.checklistHash !== next.summary.checklistHash) changes.push("Изменён чек-лист.");
  const oldIds = new Set(previous.summary.messageIds);
  const added = next.summary.messageIds.filter((id) => !oldIds.has(id)).length;
  if (added > 0) changes.push(`Добавлены комментарии: ${added}.`);
  else if (previous.discussionHash !== next.discussionHash) changes.push("Изменено обсуждение задачи.");
  return changes;
}

function historyEventMarker(previous: BitrixSyncState | null, next: BitrixSyncState): string {
  const eventId = hash({
    previousTaskHash: previous?.taskHash ?? null,
    previousDiscussionHash: previous?.discussionHash ?? null,
    nextTaskHash: next.taskHash,
    nextDiscussionHash: next.discussionHash,
  });
  return `<!-- bitrix-history-event: ${eventId} -->`;
}

function appendHistory(existing: string, at: string, changes: string[], marker: string): string {
  const head = existing.trim() || "# История изменений";
  const block = [marker, `## ${at}`, "", ...changes.map((change) => `- ${change}`)].join("\n");
  return `${head}\n\n${block}\n`;
}

async function containedFileExists(path: string, canonicalRoot: string): Promise<boolean> {
  return Boolean(await assertContainedRegularFile(path, canonicalRoot, true));
}

async function atomicWrite(
  path: string,
  content: string,
  canonicalRoot: string,
  mode = 0o600,
): Promise<void> {
  await ensureContainedDirectory(dirname(path), canonicalRoot);
  await assertContainedRegularFile(path, canonicalRoot, true);
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(
      temp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
      mode,
    );
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temp, path);
    await assertContainedRegularFile(path, canonicalRoot);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function cap(text: string, max: number): { content: string; truncated: boolean } {
  if (text.length <= max) return { content: text, truncated: false };
  return { content: `${text.slice(0, max)}\n…(контекст усечён)`, truncated: true };
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isBusinessSummary(value: unknown): value is BusinessSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const summary = value as Record<string, unknown>;
  return (
    typeof summary.title === "string"
    && typeof summary.status === "string"
    && isNullableString(summary.deadline)
    && typeof summary.responsibleId === "string"
    && isStringArray(summary.accompliceIds)
    && isHash(summary.descriptionHash)
    && isHash(summary.checklistHash)
    && isStringArray(summary.messageIds)
  );
}

function normalizeBitrixSyncState(value: unknown, taskId: string): BitrixSyncState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (
    state.version !== 1
    || state.taskId !== taskId
    || !isHash(state.taskHash)
    || !isHash(state.discussionHash)
    || !isNullableString(state.lastMessageId)
    || !isNullableString(state.bitrixChangedAt)
    || !isNullableString(state.lastSuccessfulAt)
    || !isNullableString(state.nextAllowedAttemptAt)
    || !isNullableString(state.lastSafeError)
    || typeof state.closed !== "boolean"
    || (state.dailyFinalized !== undefined && typeof state.dailyFinalized !== "boolean")
    || !isBusinessSummary(state.summary)
  ) return null;
  return { ...state, dailyFinalized: state.dailyFinalized ?? false } as BitrixSyncState;
}

function parseTaskLockOwner(value: string): TaskLockOwner | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      parsed.version !== 1
      || !Number.isSafeInteger(parsed.pid)
      || (parsed.pid as number) <= 0
      || typeof parsed.token !== "string"
      || !/^[0-9a-f-]{36}$/.test(parsed.token)
    ) return null;
    return parsed as unknown as TaskLockOwner;
  } catch {
    return null;
  }
}

function sameLockOwner(left: TaskLockOwner | null, right: TaskLockOwner): boolean {
  return Boolean(left && left.pid === right.pid && left.token === right.token);
}

async function readTaskLockOwner(path: string, canonicalRoot: string): Promise<TaskLockOwner | null> {
  return parseTaskLockOwner(await readContainedTextOrEmpty(path, canonicalRoot));
}

async function writeExclusiveLockMarker(
  path: string,
  owner: TaskLockOwner,
  canonicalRoot: string,
): Promise<void> {
  if (!await validateTaskLockDirectory(dirname(path), canonicalRoot)) {
    throw repositoryPathRaced();
  }
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    const current = await readTaskLockOwner(path, canonicalRoot);
    if (!sameLockOwner(current, owner)) throw new Error("bitrix_lock_marker_lost");
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  }
}

function isProcessProvablyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM means that the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function removeLockMarkerOwnedBy(
  path: string,
  owner: TaskLockOwner,
  canonicalRoot: string,
): Promise<boolean> {
  const expectedState = await lockMarkerIsReapable(path, canonicalRoot);
  if (!sameLockOwner(expectedState.owner, owner)) return false;
  const quarantinePath = join(
    dirname(path),
    `${LOCK_RELEASE_QUARANTINE_PREFIX}${process.pid}-${randomUUID()}.json`,
  );
  try {
    await rename(path, quarantinePath);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  const quarantinedState = await lockMarkerIsReapable(quarantinePath, canonicalRoot);
  if (
    !sameLockMarkerState(expectedState, quarantinedState)
    || !sameLockOwner(quarantinedState.owner, owner)
  ) {
    await restoreQuarantinedLockMarker(quarantinePath, path, canonicalRoot);
    return false;
  }
  await rm(quarantinePath);
  return true;
}

interface LockMarkerState {
  exists: boolean;
  reapable: boolean;
  owner: TaskLockOwner | null;
  device: string | null;
  inode: string | null;
  fingerprint: string | null;
}

const MISSING_LOCK_MARKER: LockMarkerState = {
  exists: false,
  reapable: false,
  owner: null,
  device: null,
  inode: null,
  fingerprint: null,
};

const UNSTABLE_LOCK_MARKER: LockMarkerState = {
  ...MISSING_LOCK_MARKER,
  exists: true,
};

async function lockMarkerIsReapable(path: string, canonicalRoot: string): Promise<{
  exists: boolean;
  reapable: boolean;
  owner: TaskLockOwner | null;
  device: string | null;
  inode: string | null;
  fingerprint: string | null;
}> {
  let info: Awaited<ReturnType<typeof lstat>> | null;
  try {
    info = await assertContainedRegularFile(path, canonicalRoot, true);
  } catch (error) {
    if (isRepositoryPathRaced(error)) return UNSTABLE_LOCK_MARKER;
    throw error;
  }
  if (!info) return MISSING_LOCK_MARKER;
  let content: string;
  try {
    content = await readContainedText(path, canonicalRoot);
  } catch (error) {
    if (isMissing(error)) return MISSING_LOCK_MARKER;
    if (isRepositoryPathRaced(error)) return UNSTABLE_LOCK_MARKER;
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EBADF") {
      let replacement: Awaited<ReturnType<typeof lstat>> | null;
      try {
        replacement = await assertContainedRegularFile(path, canonicalRoot, true);
      } catch (probeError) {
        if (isRepositoryPathRaced(probeError)) return UNSTABLE_LOCK_MARKER;
        throw probeError;
      }
      if (!replacement) return MISSING_LOCK_MARKER;
      if (replacement.dev !== info.dev || replacement.ino !== info.ino) {
        return UNSTABLE_LOCK_MARKER;
      }
    }
    throw error;
  }
  const owner = parseTaskLockOwner(content);
  return {
    exists: true,
    reapable: owner
      ? isProcessProvablyDead(owner.pid)
      : Date.now() - Number(info.mtimeMs) > INVALID_LOCK_STALE_MS,
    owner,
    device: String(info.dev),
    inode: String(info.ino),
    fingerprint: hash(content),
  };
}

function sameLockMarkerState(left: LockMarkerState, right: LockMarkerState): boolean {
  return (
    left.exists
    && right.exists
    && left.device === right.device
    && left.inode === right.inode
    && left.fingerprint === right.fingerprint
    && (
      left.owner === null
        ? right.owner === null
        : sameLockOwner(right.owner, left.owner)
    )
  );
}

async function restoreQuarantinedLockMarker(
  quarantinePath: string,
  markerPath: string,
  canonicalRoot: string,
): Promise<void> {
  await assertContainedRegularFile(quarantinePath, canonicalRoot);
  try {
    await link(quarantinePath, markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("bitrix_lock_restore_conflict");
    }
    throw error;
  }
  await assertContainedRegularFile(markerPath, canonicalRoot);
  await rm(quarantinePath);
}

async function cleanupLockQuarantine(lockPath: string, canonicalRoot: string): Promise<void> {
  for (const entry of await readdir(lockPath, { withFileTypes: true })) {
    if (
      !entry.name.startsWith(LOCK_REAPER_QUARANTINE_PREFIX)
      && !entry.name.startsWith(LOCK_OWNER_QUARANTINE_PREFIX)
      && !entry.name.startsWith(LOCK_RELEASE_QUARANTINE_PREFIX)
    ) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) throw unsafeRepositoryPath();
    const path = join(lockPath, entry.name);
    const state = await lockMarkerIsReapable(path, canonicalRoot);
    if (!state.exists || !state.reapable) continue;
    await rm(path);
  }
}

async function validateTaskLockDirectory(
  lockPath: string,
  canonicalRoot: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const info = await pathStat(lockPath);
    if (!info) return null;
    if (info.isSymbolicLink() || !info.isDirectory()) throw unsafeRepositoryPath();
    let canonical: string;
    try {
      canonical = await realpath(lockPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = isMissing(error)
        || (process.platform === "win32" && (code === "EBADF" || code === "EPERM"));
      if (!retryable) throw error;
      const replacement = await pathStat(lockPath);
      if (!replacement) return null;
      if (replacement.isSymbolicLink() || !replacement.isDirectory()) throw unsafeRepositoryPath();
      await ensureContainedDirectory(dirname(lockPath), canonicalRoot);
      if (attempt === 0) continue;
      return null;
    }
    try {
      assertContained(canonicalRoot, canonical);
    } catch (error) {
      if (process.platform !== "win32") throw error;
      const replacement = await pathStat(lockPath);
      if (!replacement) return null;
      if (replacement.isSymbolicLink() || !replacement.isDirectory()) throw unsafeRepositoryPath();
      if (sameFileIdentity(replacement, info)) throw error;
      await ensureContainedDirectory(dirname(lockPath), canonicalRoot);
      if (attempt === 0) continue;
      return null;
    }
    const verified = await pathStat(lockPath);
    if (!verified) return null;
    if (verified.isSymbolicLink() || !verified.isDirectory()) throw unsafeRepositoryPath();
    if (verified.dev !== info.dev || verified.ino !== info.ino) {
      if (attempt === 0) continue;
      return null;
    }
    return verified;
  }
  return null;
}

function sameFileIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function taskLockDirectoryChanged(
  lockPath: string,
  canonicalRoot: string,
  expected: Awaited<ReturnType<typeof lstat>>,
): Promise<boolean> {
  const current = await validateTaskLockDirectory(lockPath, canonicalRoot);
  return !current || !sameFileIdentity(current, expected);
}

async function removeTaskLockDirectoryIfSameAndEmpty(
  lockPath: string,
  expected: Awaited<ReturnType<typeof lstat>>,
): Promise<void> {
  const current = await pathStat(lockPath);
  if (!current || !sameFileIdentity(current, expected)) return;
  if (current.isSymbolicLink() || !current.isDirectory()) throw unsafeRepositoryPath();
  await rmdir(lockPath).catch((error) => {
    if (!isMissing(error) && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
  });
}

async function tryReapTaskLockOnce(lockPath: string, canonicalRoot: string): Promise<boolean> {
  let recoveredStaleReaper = false;
  const reaperPath = join(lockPath, LOCK_REAPER_FILE);
  const reaperState = await lockMarkerIsReapable(reaperPath, canonicalRoot);
  if (reaperState.exists) {
    if (!reaperState.reapable) return false;
    const quarantinePath = join(
      lockPath,
      `${LOCK_REAPER_QUARANTINE_PREFIX}${process.pid}-${randomUUID()}.json`,
    );
    try {
      await rename(reaperPath, quarantinePath);
      const quarantinedState = await lockMarkerIsReapable(quarantinePath, canonicalRoot);
      if (!sameLockMarkerState(reaperState, quarantinedState) || !quarantinedState.reapable) {
        await restoreQuarantinedLockMarker(quarantinePath, reaperPath, canonicalRoot);
        return false;
      }
      await rm(quarantinePath);
      recoveredStaleReaper = true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  const ownerPath = join(lockPath, LOCK_OWNER_FILE);
  const ownerState = await lockMarkerIsReapable(ownerPath, canonicalRoot);
  const lockInfo = await pathStat(lockPath);
  if (!lockInfo) return true;
  if (lockInfo.isSymbolicLink() || !lockInfo.isDirectory()) throw unsafeRepositoryPath();
  const reapable = ownerState.exists
    ? ownerState.reapable
    : recoveredStaleReaper
      || Date.now() - Number(lockInfo.mtimeMs) > INVALID_LOCK_STALE_MS;
  if (!reapable) return false;

  const reaperOwner: TaskLockOwner = { version: 1, pid: process.pid, token: randomUUID() };
  try {
    await writeExclusiveLockMarker(reaperPath, reaperOwner, canonicalRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    await removeLockMarkerOwnedBy(reaperPath, reaperOwner, canonicalRoot).catch(() => false);
    throw error;
  }

  try {
    const currentOwnerState = await lockMarkerIsReapable(ownerPath, canonicalRoot);
    const stillReapable = currentOwnerState.exists
      ? currentOwnerState.reapable
      : true;
    if (!stillReapable) {
      await removeLockMarkerOwnedBy(reaperPath, reaperOwner, canonicalRoot);
      return false;
    }

    if (currentOwnerState.exists) {
      const quarantinePath = join(
        lockPath,
        `${LOCK_OWNER_QUARANTINE_PREFIX}${process.pid}-${randomUUID()}.json`,
      );
      let claimed = false;
      try {
        await rename(ownerPath, quarantinePath);
        claimed = true;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      if (!claimed) {
        await removeLockMarkerOwnedBy(reaperPath, reaperOwner, canonicalRoot);
        return false;
      }
      const quarantinedState = await lockMarkerIsReapable(quarantinePath, canonicalRoot);
      if (!sameLockMarkerState(currentOwnerState, quarantinedState) || !quarantinedState.reapable) {
        await restoreQuarantinedLockMarker(quarantinePath, ownerPath, canonicalRoot);
        await removeLockMarkerOwnedBy(reaperPath, reaperOwner, canonicalRoot);
        return false;
      }
      await rm(quarantinePath);
    }
    await cleanupLockQuarantine(lockPath, canonicalRoot);
    if (!await removeLockMarkerOwnedBy(reaperPath, reaperOwner, canonicalRoot)) return false;
    try {
      await rmdir(lockPath);
      return true;
    } catch (error) {
      if (isMissing(error) || (error as NodeJS.ErrnoException).code === "ENOTEMPTY") return false;
      throw error;
    }
  } catch (error) {
    await removeLockMarkerOwnedBy(reaperPath, reaperOwner, canonicalRoot).catch(() => false);
    throw error;
  }
}

async function tryReapTaskLock(lockPath: string, canonicalRoot: string): Promise<boolean> {
  const expected = await validateTaskLockDirectory(lockPath, canonicalRoot);
  if (!expected) return true;
  try {
    return await tryReapTaskLockOnce(lockPath, canonicalRoot);
  } catch (error) {
    if (isRepositoryPathRaced(error)) return true;
    const message = (error as Error).message;
    if (
      message === "bitrix_repository_unsafe_path"
      || message.startsWith("bitrix_lock_")
    ) throw error;
    if (await taskLockDirectoryChanged(lockPath, canonicalRoot, expected)) {
      return true;
    }
    throw error;
  }
}

async function releaseTaskLock(
  lockPath: string,
  owner: TaskLockOwner,
  canonicalRoot: string,
): Promise<void> {
  const ownerPath = join(lockPath, LOCK_OWNER_FILE);
  if (!await removeLockMarkerOwnedBy(ownerPath, owner, canonicalRoot)) return;
  const reaperPath = join(lockPath, LOCK_REAPER_FILE);
  if (await assertContainedRegularFile(reaperPath, canonicalRoot, true)) return;
  await cleanupLockQuarantine(lockPath, canonicalRoot);
  try {
    await rmdir(lockPath);
  } catch (error) {
    if (!isMissing(error) && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
  }
}

export class BitrixTaskRepository {
  readonly tasksRoot: string;
  readonly stateRoot: string;

  constructor(
    private readonly vaultDir = process.env.ASSISTANT_VAULT_DIR || "vault",
    private readonly dataDir = process.env.ASSISTANT_DATA_DIR || "data",
  ) {
    this.tasksRoot = join(vaultDir, "tasks", "bitrix");
    this.stateRoot = join(dataDir, "bitrix-sync");
  }

  async sync(rawSnapshot: BitrixTaskSnapshot, now = new Date()): Promise<RepositorySyncResult> {
    const taskId = validateTaskId(rawSnapshot.task.id);
    return await this.runExclusiveTask(taskId, (transaction) => transaction.sync(rawSnapshot, now));
  }

  async runExclusiveTask<T>(
    taskIdValue: string | number,
    operation: (transaction: BitrixTaskTransaction) => Promise<T>,
  ): Promise<T> {
    const taskId = validateTaskId(taskIdValue);
    return await this.withTaskLock(taskId, async () => {
      const state = await this.readState(taskId);
      return await operation({
        state,
        sync: async (rawSnapshot, now = new Date()) => {
          const snapshot = sortedSnapshot(rawSnapshot);
          if (validateTaskId(snapshot.task.id) !== taskId) throw new Error("bitrix_task_id_mismatch");
          return await this.syncUnlocked(snapshot, now);
        },
        recordFailure: async (code, retryAt) => {
          await this.recordFailureUnlocked(taskId, code, retryAt);
        },
      });
    });
  }

  private async syncUnlocked(snapshot: BitrixTaskSnapshot, now: Date): Promise<RepositorySyncResult> {
    const taskId = validateTaskId(snapshot.task.id);
    const taskDir = taskDirectoryPath(this.vaultDir, taskId);
    const taskPath = join(taskDir, "task.md");
    const commentsPath = join(taskDir, "comments.md");
    const historyPath = join(taskDir, "history.md");
    const previous = await this.readState(taskId);
    const taskHash = hash(snapshot.task);
    const discussionHash = hash(snapshot.discussion);
    const syncedAt = now.toISOString();
    const state: BitrixSyncState = {
      version: 1,
      taskId,
      taskHash,
      discussionHash,
      lastMessageId: snapshot.discussion.messages.map((message) => message.id).sort(compareNumericIds).at(-1) ?? null,
      bitrixChangedAt: snapshot.task.changedAt,
      lastSuccessfulAt: syncedAt,
      nextAllowedAttemptAt: null,
      lastSafeError: null,
      closed: snapshot.task.closed,
      dailyFinalized: false,
      summary: businessSummary(snapshot),
    };
    const roots = await this.ensurePrivateRoots();
    await ensureContainedDirectory(taskDir, roots.tasksRoot, { create: true, mode: 0o700 });
    const [taskExists, commentsExist, historyExists] = await Promise.all([
      containedFileExists(taskPath, roots.tasksRoot),
      containedFileExists(commentsPath, roots.tasksRoot),
      containedFileExists(historyPath, roots.tasksRoot),
    ]);
    const markdownExists = taskExists && commentsExist;
    const localArtifactsExist = taskExists || commentsExist || historyExists;
    await Promise.all(
      [taskPath, commentsPath, historyPath].map((path) => setRegularFileModeNoFollow(path, roots.tasksRoot, 0o600)),
    );
    const unchanged =
      markdownExists && historyExists && previous?.taskHash === taskHash && previous.discussionHash === discussionHash;
    if (unchanged) {
      await this.writeState(state);
      return { outcome: "unchanged", taskId, syncedAt, taskDir };
    }

    await atomicWrite(taskPath, renderTaskMarkdown(snapshot, syncedAt), roots.tasksRoot);
    await atomicWrite(commentsPath, renderCommentsMarkdown(snapshot), roots.tasksRoot);
    const changes = historyChanges(previous, state, !localArtifactsExist);
    if (changes.length > 0) {
      const existingHistory = await readContainedTextOrEmpty(historyPath, roots.tasksRoot);
      const marker = historyEventMarker(previous, state);
      if (!existingHistory.includes(marker)) {
        await atomicWrite(historyPath, appendHistory(existingHistory, syncedAt, changes, marker), roots.tasksRoot);
      }
    } else if (!historyExists) {
      await atomicWrite(historyPath, "# История изменений\n", roots.tasksRoot);
    }
    await this.writeState(state);
    return { outcome: previous || localArtifactsExist ? "updated" : "created", taskId, syncedAt, taskDir };
  }

  async recordFailure(taskIdValue: string | number, code: string, retryAt?: string | null): Promise<void> {
    const taskId = validateTaskId(taskIdValue);
    await this.runExclusiveTask(taskId, (transaction) => transaction.recordFailure(code, retryAt));
  }

  private async recordFailureUnlocked(taskId: string, code: string, retryAt?: string | null): Promise<void> {
    const previous = await this.readState(taskId);
    if (!previous) return;
    await this.writeState({
      ...previous,
      nextAllowedAttemptAt: retryAt ?? null,
      lastSafeError: code.replace(/[^a-z0-9_.-]/gi, "_").slice(0, 80),
    });
  }

  async markDailyFinalized(taskIdValue: string | number): Promise<void> {
    const taskId = validateTaskId(taskIdValue);
    await this.withTaskLock(taskId, async () => {
      const previous = await this.readState(taskId);
      if (!previous || previous.dailyFinalized) return;
      await this.writeState({ ...previous, dailyFinalized: true });
    });
  }

  async read(taskIdValue: string | number): Promise<{
    taskId: string;
    task: string;
    comments: string;
    history: string;
    truncated: boolean;
    lastSuccessfulAt: string | null;
  }> {
    const taskId = validateTaskId(taskIdValue);
    const dir = taskDirectoryPath(this.vaultDir, taskId);
    const roots = await this.ensurePrivateRoots();
    await ensureContainedDirectory(dir, roots.tasksRoot);
    const [taskRaw, commentsRaw, historyRaw, state] = await Promise.all([
      readContainedText(join(dir, "task.md"), roots.tasksRoot),
      readContainedText(join(dir, "comments.md"), roots.tasksRoot),
      readContainedText(join(dir, "history.md"), roots.tasksRoot),
      this.readState(taskId),
    ]);
    const task = cap(taskRaw, MAX_TASK_CONTEXT);
    const comments = cap(commentsRaw, MAX_COMMENTS_CONTEXT);
    const history = cap(historyRaw, MAX_HISTORY_CONTEXT);
    return {
      taskId,
      task: task.content,
      comments: comments.content,
      history: history.content,
      truncated: task.truncated || comments.truncated || history.truncated,
      lastSuccessfulAt: state?.lastSuccessfulAt ?? null,
    };
  }

  async search(query: string, limit = 20): Promise<BitrixLocalSearchHit[]> {
    const needle = query.trim().toLocaleLowerCase("ru-RU");
    if (!needle) return [];
    const roots = await this.ensurePrivateRoots();
    const entries = await readdir(this.tasksRoot, { withFileTypes: true });
    const hits: BitrixLocalSearchHit[] = [];
    for (const entry of entries) {
      if (hits.length >= Math.min(20, Math.max(1, limit))) break;
      if (!/^[1-9]\d*$/.test(entry.name)) continue;
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw unsafeRepositoryPath();
      const taskDir = join(this.tasksRoot, entry.name);
      await ensureContainedDirectory(taskDir, roots.tasksRoot);
      const files = await Promise.all(
        ["task.md", "comments.md", "history.md"].map((name) =>
          readContainedTextOrEmpty(join(taskDir, name), roots.tasksRoot),
        ),
      );
      const text = files.join("\n");
      const lower = text.toLocaleLowerCase("ru-RU");
      const at = lower.indexOf(needle);
      if (at === -1) continue;
      const start = Math.max(0, at - 100);
      const snippet = text.slice(start, at + needle.length + 140).replace(/\s+/g, " ").trim();
      hits.push({ taskId: entry.name, snippet });
    }
    return hits;
  }

  async readState(taskIdValue: string | number): Promise<BitrixSyncState | null> {
    const taskId = validateTaskId(taskIdValue);
    const roots = await this.ensurePrivateRoots();
    try {
      const parsed = JSON.parse(
        await readContainedText(join(this.stateRoot, `${taskId}.json`), roots.stateRoot),
      ) as unknown;
      return normalizeBitrixSyncState(parsed, taskId);
    } catch (error) {
      if (isMissing(error) || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async listStates(): Promise<BitrixSyncState[]> {
    await this.ensurePrivateRoots();
    const entries = await readdir(this.stateRoot, { withFileTypes: true });
    const states: BitrixSyncState[] = [];
    for (const entry of entries) {
      const match = /^([1-9]\d*)\.json$/.exec(entry.name);
      if (!match) continue;
      if (entry.isSymbolicLink() || !entry.isFile()) throw unsafeRepositoryPath();
      const state = await this.readState(match[1]);
      if (state) states.push(state);
    }
    return states;
  }

  private async ensurePrivateRoots(): Promise<PrivateRoots> {
    const vaultRoot = await ensureConfiguredDirectory(this.vaultDir, 0o700);
    const tasksDir = join(this.vaultDir, "tasks");
    await ensureContainedDirectory(tasksDir, vaultRoot, { create: true, mode: 0o700 });
    const tasksRoot = await ensureContainedDirectory(
      this.tasksRoot,
      vaultRoot,
      { create: true, mode: 0o700 },
    );
    const dataRoot = await ensureConfiguredDirectory(this.dataDir, 0o700);
    const stateRoot = await ensureContainedDirectory(
      this.stateRoot,
      dataRoot,
      { create: true, mode: 0o700 },
    );
    return { vaultRoot, tasksRoot, dataRoot, stateRoot };
  }

  private async writeState(state: BitrixSyncState): Promise<void> {
    const roots = await this.ensurePrivateRoots();
    await atomicWrite(
      join(this.stateRoot, `${validateTaskId(state.taskId)}.json`),
      `${JSON.stringify(state, null, 2)}\n`,
      roots.stateRoot,
      0o600,
    );
  }

  private async withTaskLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const roots = await this.ensurePrivateRoots();
    const lockPath = join(this.stateRoot, `${taskId}.lock`);
    const deadline = Date.now() + 15_000;
    let acquired: TaskLockOwner | null = null;
    while (!acquired) {
      if (Date.now() >= deadline) throw new Error("bitrix_sync_busy");
      try {
        await mkdir(lockPath, { mode: 0o700 });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        if (!await validateTaskLockDirectory(lockPath, roots.stateRoot)) continue;
        if (await tryReapTaskLock(lockPath, roots.stateRoot)) continue;
        if (Date.now() >= deadline) throw new Error("bitrix_sync_busy");
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }

      const createdInfo = await pathStat(lockPath);
      if (!createdInfo) continue;
      if (createdInfo.isSymbolicLink() || !createdInfo.isDirectory()) throw unsafeRepositoryPath();
      const validatedInfo = await validateTaskLockDirectory(lockPath, roots.stateRoot);
      if (!validatedInfo || !sameFileIdentity(createdInfo, validatedInfo)) {
        await removeTaskLockDirectoryIfSameAndEmpty(lockPath, createdInfo);
        continue;
      }
      try {
        await setDirectoryModeNoFollow(lockPath, 0o700);
      } catch (error) {
        if (await taskLockDirectoryChanged(lockPath, roots.stateRoot, validatedInfo)) {
          await removeTaskLockDirectoryIfSameAndEmpty(lockPath, validatedInfo);
          continue;
        }
        throw error;
      }
      const owner: TaskLockOwner = { version: 1, pid: process.pid, token: randomUUID() };
      const ownerPath = join(lockPath, LOCK_OWNER_FILE);
      try {
        await writeExclusiveLockMarker(ownerPath, owner, roots.stateRoot);
        acquired = owner;
      } catch (error) {
        const removedOwnedMarker = await removeLockMarkerOwnedBy(
          ownerPath,
          owner,
          roots.stateRoot,
        ).catch(() => false);
        if (removedOwnedMarker) await rmdir(lockPath).catch(() => undefined);
        if (isRepositoryPathRaced(error)) {
          await removeTaskLockDirectoryIfSameAndEmpty(lockPath, validatedInfo);
          continue;
        }
        const message = (error as Error).message;
        if (
          message !== "bitrix_repository_unsafe_path"
          && !message.startsWith("bitrix_lock_")
          && await taskLockDirectoryChanged(lockPath, roots.stateRoot, validatedInfo)
        ) continue;
        throw error;
      }
    }
    try {
      return await operation();
    } finally {
      await releaseTaskLock(lockPath, acquired, roots.stateRoot).catch(() => undefined);
    }
  }
}
