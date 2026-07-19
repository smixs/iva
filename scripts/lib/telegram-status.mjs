import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { modelSummary } from "./model-summary.mjs";
import { SPINNER_FRAMES } from "./progress.mjs";

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

export function createTelegramUpdateReporter({ token, job, env, fetchImpl = fetch, intervalMs = 1500, sleepImpl } = {}) {
  if (!token || !job?.chatId || !job?.messageId) return null;
  const lang = job.locale === "ru" ? "ru" : "en";
  const copy = COPY[lang];
  const api = `https://api.telegram.org/bot${token}`;
  let currentMessageId = job.messageId;
  let currentPhase = null;
  let timer = null;
  let frame = 0;
  let lastText = "";
  let uiLost = false;
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
      if (!transient || attempt === 3) throw new Error(data.description || `Telegram ${res.status}`);
      const retryMs = Math.min(5000, Math.max(250, Number(data.parameters?.retry_after || 1) * 1000));
      await wait(retryMs);
    }
    throw new Error("Telegram request failed");
  }

  async function edit(text) {
    if (!currentMessageId || text === lastText) return;
    lastText = text;
    try {
      await call("editMessageText", { chat_id: job.chatId, message_id: currentMessageId, text });
    } catch (error) {
      if (/message is not modified/i.test(error.message)) return;
      if (/message to edit not found|message can't be edited/i.test(error.message)) {
        currentMessageId = null;
        uiLost = true;
      }
    }
  }

  async function animate() {
    if (!currentPhase || !currentMessageId || animate.running) return;
    animate.running = true;
    try {
      await edit(`${SPINNER_FRAMES[frame++ % SPINNER_FRAMES.length]} ${copy[currentPhase][0]}`);
    } finally {
      animate.running = false;
    }
  }
  animate.running = false;

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    async start(phase) {
      stop();
      currentPhase = phase;
      frame = 0;
      lastText = "";
      if (phase !== "protect" && !uiLost) {
        try {
          const msg = await call("sendMessage", { chat_id: job.chatId, text: `${SPINNER_FRAMES[0]} ${copy[phase][0]}` });
          currentMessageId = msg.message_id;
          frame = 1;
        } catch {
          currentMessageId = null;
          uiLost = true;
        }
      } else if (!uiLost) {
        await animate();
      }
      timer = setInterval(() => void animate(), intervalMs);
    },
    async done(phase) {
      stop();
      if (currentPhase === phase) await edit(`✓ ${copy[phase][1]}`);
      currentPhase = null;
    },
    async fail(phase, beforeVersion) {
      stop();
      if (currentPhase === phase) await edit(`⚠️ ${copy[phase][2]}`);
      currentPhase = null;
      try {
        await call("sendMessage", { chat_id: job.chatId, text: copy.failure(beforeVersion) });
      } catch {}
    },
    async complete({ beforeVersion, afterVersion }) {
      stop();
      const model = modelSummary(env);
      const lines = [
        copy.final,
        "",
        `${beforeVersion} → ${afterVersion}`,
        `${lang === "ru" ? "Модель" : "Model"}: ${model.line}`,
      ];
      lines.push(copy.preserved);
      try {
        await call("sendMessage", { chat_id: job.chatId, text: lines.join("\n") });
      } catch {}
    },
    dispose() {
      stop();
    },
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
