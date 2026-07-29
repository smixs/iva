import {
  mkdir,
  link,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { dirname } from "node:path";

export const TELEGRAM_QUEUE_VERSION = 1;
export const TELEGRAM_QUEUE_ITEM_VERSION = 1;
export const TELEGRAM_QUEUE_DURABILITY = "ETELEGRAM_QUEUE_DURABILITY";
export const TELEGRAM_QUEUE_ACK_ROLLED_BACK = "ETELEGRAM_QUEUE_ACK_ROLLED_BACK";
export const TELEGRAM_QUEUE_FATAL_DURABILITY = "ETELEGRAM_QUEUE_FATAL_DURABILITY";
export const TELEGRAM_QUEUE_ACK_PENDING_SUFFIX = ".ack-pending";

const MEDIA_KEYS = [
  "photo",
  "voice",
  "audio",
  "video",
  "video_note",
  "animation",
  "sticker",
  "document",
  "location",
  "contact",
  "poll",
];

export function emptyQueueDocument() {
  return { version: TELEGRAM_QUEUE_VERSION, queues: Object.fromEntries([]) };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function legacyUpdateId(chatKey, index, text) {
  const digest = createHash("sha256")
    .update(`${chatKey}\0${index}\0${text}`)
    .digest();
  return -(digest.readUInt32BE(0) || 1);
}

function normalizeItem(item, chatKey, index) {
  if (typeof item === "string") {
    return {
      version: TELEGRAM_QUEUE_ITEM_VERSION,
      updateId: legacyUpdateId(chatKey, index, item),
      legacyText: item,
      migratedFrom: "string",
    };
  }
  if (
    typeof item !== "object" ||
    item === null ||
    Array.isArray(item) ||
    item.version !== TELEGRAM_QUEUE_ITEM_VERSION ||
    !Number.isSafeInteger(item.updateId)
  ) {
    throw new Error(`invalid Telegram queue item for ${chatKey}[${index}]`);
  }
  const hasUpdate =
    typeof item.update === "object" &&
    item.update !== null &&
    !Array.isArray(item.update) &&
    item.update.update_id === item.updateId;
  const hasLegacyText = typeof item.legacyText === "string";
  if (!hasUpdate && !hasLegacyText) {
    throw new Error(`Telegram queue item ${chatKey}[${index}] has no replayable payload`);
  }
  return cloneJson(item);
}

function normalizeQueues(queues, { legacy = false } = {}) {
  if (typeof queues !== "object" || queues === null || Array.isArray(queues)) {
    throw new Error("Telegram queue does not contain a queues object");
  }
  const entries = [];
  for (const [chatKey, items] of Object.entries(queues)) {
    if (!Array.isArray(items)) throw new Error(`Telegram queue ${chatKey} is not an array`);
    const next = items.map((item, index) => normalizeItem(item, chatKey, index));
    if (next.length) entries.push([chatKey, next]);
  }
  return {
    // Object.fromEntries defines "__proto__" as an ordinary own data property.
    document: { version: TELEGRAM_QUEUE_VERSION, queues: Object.fromEntries(entries) },
    migrated: legacy,
  };
}

export function normalizeQueueDocument(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Telegram queue does not contain an object");
  }
  if (value.version === TELEGRAM_QUEUE_VERSION && Object.hasOwn(value, "queues")) {
    return normalizeQueues(value.queues);
  }
  // Pre-IVA-008 format: { "<chat>:<topic>": ["text", ...] }.
  // Convert every string to a versioned item with a stable synthetic update id.
  // The text stays byte-for-byte present until Eve accepts the migrated head.
  return normalizeQueues(value, { legacy: true });
}

export function createQueueItem(update, now = Date.now()) {
  if (
    typeof update !== "object" ||
    update === null ||
    Array.isArray(update) ||
    !Number.isSafeInteger(update.update_id)
  ) {
    throw new Error("queued Telegram update must have a safe integer update_id");
  }
  return {
    version: TELEGRAM_QUEUE_ITEM_VERSION,
    updateId: update.update_id,
    enqueuedAt: now,
    update: cloneJson(update),
  };
}

export function queueCount(document, chatKey) {
  if (chatKey !== undefined) {
    return Object.hasOwn(document.queues, chatKey) ? document.queues[chatKey].length : 0;
  }
  return Object.values(document.queues).reduce((sum, items) => sum + items.length, 0);
}

export function queueKeys(document) {
  return Object.keys(document.queues).filter((key) => document.queues[key]?.length);
}

export function queueHead(document, chatKey) {
  return Object.hasOwn(document.queues, chatKey) ? document.queues[chatKey][0] ?? null : null;
}

function cloneQueueMap(queues) {
  return Object.fromEntries(Object.entries(queues));
}

function defineQueue(queues, chatKey, items) {
  Object.defineProperty(queues, chatKey, {
    value: items,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

export function enqueueItem(document, chatKey, item) {
  const queues = cloneQueueMap(document.queues);
  const current = Object.hasOwn(queues, chatKey) ? queues[chatKey] : [];
  const duplicate = current.some((candidate) => candidate.updateId === item.updateId);
  if (duplicate) {
    return { document, added: false, count: current.length };
  }
  defineQueue(queues, chatKey, [...current, item]);
  return {
    document: { version: TELEGRAM_QUEUE_VERSION, queues },
    added: true,
    count: queues[chatKey].length,
  };
}

export function removeQueueHead(document, chatKey, updateId) {
  const current = Object.hasOwn(document.queues, chatKey) ? document.queues[chatKey] : [];
  if (!current.length || current[0].updateId !== updateId) {
    throw new Error(`Telegram queue head changed for ${chatKey}; expected update ${updateId}`);
  }
  const queues = cloneQueueMap(document.queues);
  if (current.length === 1) delete queues[chatKey];
  else defineQueue(queues, chatKey, current.slice(1));
  return { version: TELEGRAM_QUEUE_VERSION, queues };
}

export function clearQueueKey(document, chatKey) {
  if (!Object.hasOwn(document.queues, chatKey)) return { document, changed: false };
  const queues = cloneQueueMap(document.queues);
  delete queues[chatKey];
  return {
    document: { version: TELEGRAM_QUEUE_VERSION, queues },
    changed: true,
  };
}

function splitChatKey(chatKey) {
  const colon = chatKey.lastIndexOf(":");
  if (colon < 0) return null;
  const chat = chatKey.slice(0, colon);
  const thread = chatKey.slice(colon + 1);
  if (!chat.length) return null;
  const chatNumber = Number(chat);
  const threadNumber = thread === "" ? null : Number(thread);
  return {
    chatId: Number.isSafeInteger(chatNumber) ? chatNumber : chat,
    threadId: Number.isSafeInteger(threadNumber) ? threadNumber : null,
  };
}

export function materializeQueueItem(chatKey, item, { legacyAllowedUserIds } = {}) {
  if (item.update) return cloneJson(item.update);
  const route = splitChatKey(chatKey);
  const allowed =
    legacyAllowedUserIds instanceof Set
      ? legacyAllowedUserIds
      : new Set(legacyAllowedUserIds ?? []);
  // The old string[] format did not retain a sender. A private Telegram chat id
  // is also its participant's user id, so an allowlisted private route is the
  // only legacy item whose author can be reconstructed. A group/topic key says
  // nothing about which member wrote the text and must stay undelivered.
  if (
    !route ||
    typeof route.chatId !== "number" ||
    route.chatId <= 0 ||
    !allowed.has(String(route.chatId))
  ) {
    return null;
  }
  const ownerId = route.chatId;
  const messageId = Math.max(1, Math.abs(item.updateId));
  return {
    update_id: item.updateId,
    message: {
      message_id: messageId,
      date: 0,
      chat: {
        id: route.chatId,
        type: "private",
      },
      from: { id: ownerId, is_bot: false, first_name: "Owner" },
      text: item.legacyText,
      ...(route.threadId === null ? {} : { message_thread_id: route.threadId }),
    },
  };
}

const TELEGRAM_USERNAME = /^[A-Za-z0-9_]{5,32}$/u;
const TOKEN_NEIGHBOR = /[\p{L}\p{N}_]/u;

function normalizeBotUsername(botUsername) {
  if (typeof botUsername !== "string") return "";
  const username = botUsername.replace(/^@/, "");
  return TELEGRAM_USERNAME.test(username) ? username : "";
}

function validEntityRange(text, entity) {
  return (
    typeof entity === "object" &&
    entity !== null &&
    Number.isSafeInteger(entity.offset) &&
    Number.isSafeInteger(entity.length) &&
    entity.offset >= 0 &&
    entity.length > 0 &&
    entity.offset + entity.length <= text.length
  );
}

function codePointBefore(text, index) {
  return Array.from(text.slice(0, index)).at(-1) ?? "";
}

function codePointAfter(text, index) {
  return Array.from(text.slice(index))[0] ?? "";
}

function hasTokenBoundaries(text, start, end) {
  return (
    !TOKEN_NEIGHBOR.test(codePointBefore(text, start)) &&
    !TOKEN_NEIGHBOR.test(codePointAfter(text, end))
  );
}

function mentionAt(text, start, end, username) {
  return (
    text.slice(start, end).toLowerCase() === `@${username.toLowerCase()}` &&
    hasTokenBoundaries(text, start, end)
  );
}

function hasExactMention(text, entities, username) {
  if (!username) return false;
  if (entities !== undefined) {
    if (!Array.isArray(entities)) return false;
    return entities.some((entity) =>
      entity?.type === "mention" &&
      validEntityRange(text, entity) &&
      mentionAt(text, entity.offset, entity.offset + entity.length, username));
  }

  const needleLength = username.length + 1;
  let start = text.indexOf("@");
  while (start >= 0) {
    if (mentionAt(text, start, start + needleLength, username)) return true;
    start = text.indexOf("@", start + 1);
  }
  return false;
}

function commandTokenTargetsBot(token, botUsername) {
  const match = /^\/[A-Za-z0-9_]+(?:@(?<target>[A-Za-z0-9_]+))?$/u.exec(token);
  if (!match) return false;
  const target = match.groups?.target;
  return (
    target === undefined ||
    (botUsername && target.toLowerCase() === botUsername.toLowerCase())
  );
}

function isBotCommand(text, botUsername, entities) {
  if (entities !== undefined) {
    if (!Array.isArray(entities)) return false;
    return entities.some((entity) => {
      if (
        entity?.type !== "bot_command" ||
        entity.offset !== 0 ||
        !validEntityRange(text, entity)
      ) {
        return false;
      }
      const end = entity.offset + entity.length;
      return (
        commandTokenTargetsBot(text.slice(entity.offset, end), botUsername) &&
        (end === text.length || /\s/u.test(codePointAfter(text, end)))
      );
    });
  }
  const match = /^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?(?=\s|$)/u.exec(text);
  return Boolean(match && commandTokenTargetsBot(match[0], botUsername));
}

function messageTextAndEntities(message) {
  if (typeof message.text === "string") {
    return { text: message.text, entities: message.entities };
  }
  if (typeof message.caption === "string") {
    return { text: message.caption, entities: message.caption_entities };
  }
  return { text: "", entities: undefined };
}

function hasMessagePayload(message) {
  const { text } = messageTextAndEntities(message);
  return Boolean(
    text.trim() ||
    MEDIA_KEYS.some((key) => message[key] !== undefined),
  );
}

export function isReplyToBot(message) {
  return message.reply_to_message?.from?.is_bot === true;
}

export function shouldQueueBusyUpdate(
  update,
  {
    allowedUserIds,
    botUsername,
  },
) {
  const message = update?.message;
  const parts = Array.isArray(message?.iva_parts) ? message.iva_parts : [message];
  if (
    !message ||
    message.from?.is_bot === true ||
    !parts.some((part) => part && hasMessagePayload(part))
  ) {
    return false;
  }
  const allowed = allowedUserIds instanceof Set ? allowedUserIds : new Set(allowedUserIds ?? []);
  const from = String(message.from?.id ?? "");
  if (!allowed.size || !allowed.has(from)) return false;
  if (message.chat?.type === "private") return true;
  if (message.chat?.type === "channel") return false;
  const username = normalizeBotUsername(botUsername);
  return parts.some((part) => {
    if (!part || typeof part !== "object") return false;
    const { text, entities } = messageTextAndEntities(part);
    return (
      isBotCommand(text, username, entities) ||
      hasExactMention(text, entities, username)
    );
  });
}

export async function loadQueueFile(
  file,
  options = {},
) {
  const {
    strict = false,
    readFileImpl = readFile,
    renameImpl = rename,
  } = options;
  const quarantineNonce =
    typeof options.nonce === "function"
      ? options.nonce
      : () => randomBytes(8).toString("hex");
  const pendingFile = `${file}${TELEGRAM_QUEUE_ACK_PENDING_SUFFIX}`;
  let pendingRaw;
  try {
    pendingRaw = await readFileImpl(pendingFile, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (pendingRaw !== undefined) {
    // A pending document is the last fully durable pre-ack state. Restore it
    // before any caller can observe the possibly published removal.
    const recovered = normalizeQueueDocument(JSON.parse(pendingRaw)).document;
    const recoveryOptions = { ...options };
    if (typeof recoveryOptions.nonce === "function") delete recoveryOptions.nonce;
    await writeQueueFileAtomic(file, recovered, recoveryOptions);
    await removeFileDurable(pendingFile, options);
    return {
      document: recovered,
      migrated: false,
      quarantined: null,
      recoveredPendingAcknowledgement: true,
    };
  }

  let raw;
  try {
    raw = await readFileImpl(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { document: emptyQueueDocument(), migrated: false, quarantined: null };
    }
    throw error;
  }
  try {
    const normalized = normalizeQueueDocument(JSON.parse(raw));
    return { ...normalized, quarantined: null };
  } catch (error) {
    if (strict) throw error;
    const backup = `${file}.corrupt-${Date.now()}-${quarantineNonce()}`;
    await renameImpl(file, backup);
    return { document: emptyQueueDocument(), migrated: false, quarantined: backup, error };
  }
}

async function removeFileDurable(
  file,
  {
    rmImpl = rm,
    openImpl = open,
  } = {},
) {
  await rmImpl(file, { force: true });
  const directory = await openImpl(dirname(file), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function writeQueueFileAtomic(
  file,
  document,
  {
    mkdirImpl = mkdir,
    writeFileImpl = writeFile,
    renameImpl = rename,
    linkImpl = link,
    rmImpl = rm,
    openImpl = open,
    nonce = randomBytes(8).toString("hex"),
    replace = true,
  } = {},
) {
  const normalized = normalizeQueueDocument(document).document;
  const parent = dirname(file);
  await mkdirImpl(parent, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${nonce}`;
  let replaced = false;
  try {
    await writeFileImpl(tmp, JSON.stringify(normalized), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const staged = await openImpl(tmp, "r+");
    try {
      await staged.sync();
    } finally {
      await staged.close();
    }
    if (replace) await renameImpl(tmp, file);
    else await linkImpl(tmp, file);
    replaced = true;
    const directory = await openImpl(parent, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (cause) {
    if (replaced) {
      const error = new Error(
        `Telegram queue file was published, but durability could not be confirmed: ${cause.message}`,
        { cause },
      );
      error.code = TELEGRAM_QUEUE_DURABILITY;
      throw error;
    }
    throw cause;
  } finally {
    await rmImpl(tmp, { force: true }).catch(() => {});
  }
}

async function writeLegacyQuarantine(file, document, options) {
  const now = options.quarantineNow?.() ?? Date.now();
  const nonce = options.quarantineNonce?.() ?? randomBytes(8).toString("hex");
  const stem = `${file}.legacy-unattributed-${now}-${nonce}`;

  for (let attempt = 0; attempt < 1000; attempt++) {
    const path = attempt === 0 ? stem : `${stem}-${attempt}`;
    try {
      // A hard link publishes the fully fsynced staging inode and fails with
      // EEXIST instead of replacing an earlier migration's evidence.
      await writeQueueFileAtomic(path, document, { ...options, replace: false });
      return path;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`could not reserve a unique legacy Telegram quarantine path for ${file}`);
}

export async function migrateQueueFile(file, options = {}) {
  const loaded = await loadQueueFile(file, options);
  if (loaded.migrated) {
    const activeEntries = [];
    const unattributedEntries = [];
    for (const [chatKey, items] of Object.entries(loaded.document.queues)) {
      const route = splitChatKey(chatKey);
      const target =
        route && typeof route.chatId === "number" && route.chatId > 0
          ? activeEntries
          : unattributedEntries;
      target.push([chatKey, items]);
    }
    const active = {
      version: TELEGRAM_QUEUE_VERSION,
      queues: Object.fromEntries(activeEntries),
    };
    if (unattributedEntries.length) {
      // Preserve old group/topic text outside the active FIFO before removing it
      // from automatic replay. The old format has no sender identity, so those
      // entries cannot be delivered faithfully. Writing this sidecar first means
      // every crash order leaves either the original queue or its durable copy.
      const quarantine = await writeLegacyQuarantine(
        file,
        {
          version: TELEGRAM_QUEUE_VERSION,
          queues: Object.fromEntries(unattributedEntries),
        },
        options,
      );
      options.onLegacyQuarantine?.(quarantine);
    }
    await writeQueueFileAtomic(file, active, options);
    return active;
  }
  return loaded.document;
}

export async function enqueueQueueFile(file, chatKey, update, options = {}) {
  const loaded = await loadQueueFile(file, options);
  const result = enqueueItem(
    loaded.document,
    chatKey,
    createQueueItem(update, options.now?.() ?? Date.now()),
  );
  // A previous rename can be visible even when its parent-directory fsync failed.
  // Rewrite duplicate retries too, so offset advancement always follows a write
  // whose file and directory durability were both confirmed in this attempt.
  await writeQueueFileAtomic(file, result.document, options);
  return { ...result, document: result.document, quarantined: loaded.quarantined };
}

export async function acknowledgeQueueHead(file, chatKey, updateId, options = {}) {
  const loaded = await loadQueueFile(file, { ...options, strict: true });
  const document = removeQueueHead(loaded.document, chatKey, updateId);
  const pendingFile = `${file}${TELEGRAM_QUEUE_ACK_PENDING_SUFFIX}`;

  // Publish the original queue durably before making head removal visible.
  // If SIGKILL lands anywhere after this point, loadQueueFile restores it and
  // intentionally permits one at-least-once duplicate.
  await writeQueueFileAtomic(pendingFile, loaded.document, options);
  try {
    await writeQueueFileAtomic(file, document, options);
    await removeFileDurable(pendingFile, options);
  } catch (error) {
    try {
      await writeQueueFileAtomic(file, loaded.document, options);
      await removeFileDurable(pendingFile, options);
    } catch (rollbackError) {
      const fatal = new Error(
        `Telegram queue acknowledgement and rollback durability are unknown: ${rollbackError.message}`,
        { cause: rollbackError },
      );
      fatal.code = TELEGRAM_QUEUE_FATAL_DURABILITY;
      fatal.acknowledgementError = error;
      throw fatal;
    }
    const rolledBack = new Error(
      `Telegram queue acknowledgement was not durable; original head ${updateId} was restored`,
      { cause: error },
    );
    rolledBack.code = TELEGRAM_QUEUE_ACK_ROLLED_BACK;
    throw rolledBack;
  }
  return document;
}

export async function clearQueueFileKey(file, chatKey, options = {}) {
  const loaded = await loadQueueFile(file, { ...options, strict: true });
  const result = clearQueueKey(loaded.document, chatKey);
  if (result.changed || loaded.migrated) {
    await writeQueueFileAtomic(file, result.document, options);
  }
  return result.document;
}
