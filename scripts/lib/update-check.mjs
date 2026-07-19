import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

function git(root, args) {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", root, ...args], { maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      if (error) return reject(new Error((stderr || error.message).trim()));
      resolve((stdout || "").trim());
    });
  });
}

function packageVersion(jsonText) {
  try {
    const version = JSON.parse(jsonText).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

function stableParts(version) {
  const match = String(version ?? "").match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  return match ? match.slice(1).map(Number) : null;
}

export function compareStableVersions(localVersion, remoteVersion) {
  const local = stableParts(localVersion);
  const remote = stableParts(remoteVersion);
  if (!local || !remote) return null;
  for (let i = 0; i < 3; i++) {
    if (remote[i] > local[i]) return 1;
    if (remote[i] < local[i]) return -1;
  }
  return 0;
}

export async function inspectUpstream({ root, remote = "origin", gitImpl = git } = {}) {
  if (!root) throw new Error("update check requires a repository root");
  const branch = (await gitImpl(root, ["rev-parse", "--abbrev-ref", "HEAD"])) || "main";
  if (branch === "HEAD") throw new Error("cannot check updates from a detached HEAD");
  await gitImpl(root, ["fetch", "--prune", remote, branch]);
  const local = await gitImpl(root, ["rev-parse", "HEAD"]);
  const remoteRef = `${remote}/${branch}`;
  const remoteHead = await gitImpl(root, ["rev-parse", remoteRef]);
  const behind = Number(await gitImpl(root, ["rev-list", "--count", `HEAD..${remoteRef}`])) || 0;
  const localVersion = packageVersion(await gitImpl(root, ["show", "HEAD:package.json"]));
  const remoteVersion = packageVersion(await gitImpl(root, ["show", `${remoteRef}:package.json`]));
  const versionComparison = compareStableVersions(localVersion, remoteVersion);
  const hasCommitUpdate = behind > 0 && local !== remoteHead;
  return {
    branch,
    local,
    remote: remoteHead,
    behind,
    localVersion,
    remoteVersion,
    hasCommitUpdate,
    hasVersionUpdate: hasCommitUpdate && versionComparison === 1,
  };
}

export function updateOffer(localVersion, remoteVersion, locale = "en") {
  const ru = locale === "ru";
  return {
    text: ru
      ? `⬆️ Доступна новая версия Iva\n\nv${localVersion} → v${remoteVersion}\nНастройки и локальные изменения будут сохранены.`
      : `⬆️ A new Iva version is available\n\nv${localVersion} → v${remoteVersion}\nSettings and local changes will be preserved.`,
    replyMarkup: {
      inline_keyboard: [[
        { text: ru ? "⬆️ Обновить" : "⬆️ Update", callback_data: "iva_update:do" },
        { text: ru ? "Позже" : "Later", callback_data: "iva_update:skip" },
      ]],
    },
  };
}

export function notificationChat(env = process.env) {
  const digest = String(env.TELEGRAM_DIGEST_CHAT_ID ?? "").trim();
  if (digest) return digest;
  return String(env.TELEGRAM_ALLOWED_USER_IDS ?? "").split(/[,\s]+/).map((id) => id.trim()).find(Boolean) ?? "";
}

export async function sendUpdateOffer({ token, chatId, offer, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: offer.text, reply_markup: offer.replyMarkup }),
  });
  const data = await response.json().catch(() => ({ ok: false, description: `HTTP ${response.status}` }));
  if (!response.ok || !data.ok) throw new Error(data.description || `Telegram ${response.status}`);
  return data.result;
}

export function updateCheckStatePath(dataDir) {
  return join(dataDir, "update-check.json");
}

export async function readNotifiedVersion(dataDir) {
  try {
    const state = JSON.parse(await readFile(updateCheckStatePath(dataDir), "utf8"));
    return typeof state.lastNotifiedVersion === "string" ? state.lastNotifiedVersion : null;
  } catch {
    return null;
  }
}

export async function markVersionNotified(dataDir, version) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = updateCheckStatePath(dataDir);
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify({ lastNotifiedVersion: version, notifiedAt: new Date().toISOString() })}\n`, {
      mode: 0o600,
    });
    await rename(temp, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}
