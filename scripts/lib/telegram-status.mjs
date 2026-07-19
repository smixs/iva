import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { modelSummary } from "./model-summary.mjs";

// Small teal loader from https://t.me/addemoji/LoadingStatusByTimDesign.
// Bots whose owner doesn't have Telegram Premium transparently fall back to ◇.
export const UPDATE_LOADER = {
  alt: "🟩",
  customEmojiId: "5256127530271786963",
  fallback: "◇",
};

const COPY = {
  en: {
    protect: ["Saving your changes", "Changes saved", "Couldn't save your changes"],
    fetch: ["Getting the update", "Update received", "Couldn't get the update"],
    build: ["Building Iva", "Iva built", "Couldn't build Iva"],
    final: "✅ Iva updated",
    preserved: "Local changes: preserved",
    failure: (version) => `Iva is still running ${version}.\nYour settings and changes are preserved.\nRetry: /update`,
  },
  ru: {
    protect: ["Сохраняю ваши изменения", "Изменения сохранены", "Не удалось сохранить изменения"],
    fetch: ["Получаю обновление", "Обновление получено", "Не удалось получить обновление"],
    build: ["Собираю Iva", "Iva собрана", "Не удалось собрать Iva"],
    final: "✅ Iva обновлена",
    preserved: "Локальные изменения: сохранены",
    failure: (version) => `Iva продолжает работать на ${version}.\nВаши настройки и изменения сохранены.\nПовторить: /update`,
  },
};

export function createTelegramUpdateReporter({ token, job, env, fetchImpl = fetch, sleepImpl } = {}) {
  if (!token || !job?.chatId || !job?.messageId) return null;
  const lang = job.locale === "ru" ? "ru" : "en";
  const copy = COPY[lang];
  const api = `https://api.telegram.org/bot${token}`;
  let currentMessageId = job.messageId;
  let currentPhase = null;
  let lastPayload = "";
  let uiLost = false;
  let customEmojiSupported = true;
  const wait = sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  async function call(method, body) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${api}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (error) {
        if (attempt === 3) throw error;
        await wait(250 * attempt);
        continue;
      }
      const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
      if (res.ok && data.ok) return data.result;
      const transient = res.status === 429 || res.status >= 500;
      if (!transient || attempt === 3) {
        const error = new Error(data.description || `Telegram ${res.status}`);
        error.status = res.status;
        throw error;
      }
      const retryMs = Math.min(5000, Math.max(250, Number(data.parameters?.retry_after || 1) * 1000));
      await wait(retryMs);
    }
    throw new Error("Telegram request failed");
  }

  async function edit(body) {
    if (!currentMessageId) return { ok: false };
    const payload = JSON.stringify(body);
    if (payload === lastPayload) return { ok: true };
    try {
      await call("editMessageText", { chat_id: job.chatId, message_id: currentMessageId, ...body });
      lastPayload = payload;
      return { ok: true };
    } catch (error) {
      if (/message is not modified/i.test(error.message)) {
        lastPayload = payload;
        return { ok: true };
      }
      if (/message to edit not found|message can't be edited/i.test(error.message)) {
        currentMessageId = null;
        uiLost = true;
      }
      return { ok: false, error };
    }
  }

  async function editActive(text) {
    if (customEmojiSupported) {
      const rich = {
        text: `${UPDATE_LOADER.alt} ${text}`,
        entities: [{
          type: "custom_emoji",
          offset: 0,
          length: UPDATE_LOADER.alt.length,
          custom_emoji_id: UPDATE_LOADER.customEmojiId,
        }],
      };
      const result = await edit(rich);
      if (result.ok) return;
      if (!currentMessageId) return;
      if (result.error?.status !== 400) return;
      customEmojiSupported = false;
    }
    await edit({ text: `${UPDATE_LOADER.fallback} ${text}` });
  }

  async function finish(text) {
    if ((await edit({ text })).ok) return;
    if (!uiLost) return;
    try {
      await call("sendMessage", { chat_id: job.chatId, text });
    } catch {}
  }

  return {
    async start(phase) {
      currentPhase = phase;
      if (!uiLost) await editActive(copy[phase][0]);
    },
    async done(phase) {
      // The next phase replaces this one in the same message. A transient
      // "done" edit would only add API traffic and flicker without preserving history.
      if (currentPhase !== phase) return;
      currentPhase = null;
    },
    async fail(phase, beforeVersion) {
      const reason = copy[phase][2];
      currentPhase = null;
      await finish(`⚠️ ${reason}\n\n${copy.failure(beforeVersion)}`);
    },
    async complete({ beforeVersion, afterVersion }) {
      const model = modelSummary(env);
      const lines = [
        copy.final,
        "",
        `${beforeVersion} → ${afterVersion}`,
        `${lang === "ru" ? "Модель" : "Model"}: ${model.line}`,
      ];
      lines.push(copy.preserved);
      await finish(lines.join("\n"));
    },
    dispose() {},
  };
}

export async function loadTelegramJob(dataDir, jobId) {
  if (!jobId || !/^[a-zA-Z0-9_-]+$/.test(jobId)) return null;
  const path = join(dataDir, "update-jobs", `${jobId}.json`);
  try {
    return { path, job: JSON.parse(await readFile(path, "utf8")) };
  } catch {
    return null;
  }
}

export async function removeTelegramJob(path) {
  if (path) await rm(path, { force: true }).catch(() => {});
}
