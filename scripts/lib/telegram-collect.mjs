export const COLLECT_QUIET_MS = 800;
export const COLLECT_MEDIA_QUIET_MS = 1500;
export const COLLECT_MAX_PARTS = 20;
export const COLLECT_MAX_CHARS = 50_000;
export const COLLECT_MAX_AGE_MS = 10_000;

function finiteNonNegative(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function finitePositiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function createCollector(options = {}) {
  return {
    entries: new Map(),
    quietMs: finiteNonNegative(options.quietMs, COLLECT_QUIET_MS),
    mediaQuietMs: finiteNonNegative(options.mediaQuietMs, COLLECT_MEDIA_QUIET_MS),
    maxParts: finitePositiveInteger(options.maxParts, COLLECT_MAX_PARTS),
    maxChars: finitePositiveInteger(options.maxChars, COLLECT_MAX_CHARS),
    maxAgeMs: finiteNonNegative(options.maxAgeMs, COLLECT_MAX_AGE_MS),
  };
}

export function collectorKeyFor(update) {
  const message = update?.message;
  const chatId = message?.chat?.id;
  const fromId = message?.from?.id;
  if (chatId === undefined || fromId === undefined) return null;
  return `${chatId}:${message.message_thread_id ?? ""}:${fromId}`;
}

function messageChars(message) {
  return (
    (typeof message?.text === "string" ? message.text.length : 0) +
    (typeof message?.caption === "string" ? message.caption.length : 0)
  );
}

function mergeParts(updates) {
  if (updates.length === 1) return updates[0];

  const ordered = updates
    .map((update, index) => ({ update, index }))
    .sort((a, b) => {
      const aId = a.update.message?.message_id;
      const bId = b.update.message?.message_id;
      if (Number.isSafeInteger(aId) && Number.isSafeInteger(bId) && aId !== bId) {
        return aId - bId;
      }
      return a.index - b.index;
    })
    .map(({ update }) => update);
  const first = ordered[0];
  const updateId = ordered.reduce(
    (max, update) =>
      Number.isSafeInteger(update.update_id) ? Math.max(max, update.update_id) : max,
    Number.MIN_SAFE_INTEGER,
  );

  return {
    ...first,
    update_id: updateId,
    message: {
      ...first.message,
      iva_parts: ordered.map((update) => update.message),
    },
  };
}

function entryQuietMs(collector, entry) {
  const last = entry.updates.at(-1)?.message;
  return last?.media_group_id === undefined
    ? collector.quietMs
    : collector.mediaQuietMs;
}

export function collectorOffer(collector, update, now) {
  const key = collectorKeyFor(update);
  if (collector.quietMs === 0 || key === null) {
    return { status: "passthrough", update };
  }

  const existing = collector.entries.get(key);
  const entry = existing ?? {
    updates: [],
    chars: 0,
    firstAt: now,
    lastAt: now,
    forced: false,
  };
  entry.updates.push(update);
  entry.chars += messageChars(update.message);
  entry.lastAt = now;
  collector.entries.set(key, entry);

  const capped =
    entry.updates.length >= collector.maxParts ||
    entry.chars >= collector.maxChars ||
    now - entry.firstAt >= collector.maxAgeMs;
  if (!capped) return { status: "buffered" };

  collector.entries.delete(key);
  return { status: "ready", update: mergeParts(entry.updates) };
}

export function collectorTakeExpired(collector, now) {
  const ready = [];
  for (const [key, entry] of collector.entries) {
    if (
      !entry.forced &&
      now - entry.lastAt < entryQuietMs(collector, entry) &&
      now - entry.firstAt < collector.maxAgeMs
    ) {
      continue;
    }
    collector.entries.delete(key);
    ready.push(mergeParts(entry.updates));
  }
  return ready;
}

export function collectorRestore(collector, update) {
  const key = collectorKeyFor(update);
  if (key === null) return false;
  collector.entries.set(key, {
    updates: [update],
    chars: messageChars(update.message),
    firstAt: 0,
    lastAt: 0,
    forced: true,
  });
  return true;
}

export function collectorPending(collector) {
  return collector.entries.size;
}
