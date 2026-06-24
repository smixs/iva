import { defineAgent } from "eve";
import { z } from "zod";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const ollama = createOpenAICompatible({
  name: "ollama-cloud",
  baseURL: "https://ollama.com/v1",
  apiKey: process.env.OLLAMA_API_KEY,
  includeUsage: true, // иначе step.completed приходит без usage — см. agent/agent.ts
});

const MODEL = process.env.OLLAMA_MODEL ?? "deepseek-v4-pro";
const CONTEXT_WINDOW = Number(process.env.OLLAMA_CONTEXT_WINDOW ?? 131072);

export default defineAgent({
  description:
    "Разбивает крупную цель пользователя на конкретные выполнимые шаги. " +
    "Делегируй сюда, когда задача большая и её нужно декомпозировать на план.",
  model: ollama(MODEL),
  modelContextWindowTokens: CONTEXT_WINDOW,
  // Task-mode: при делегировании возвращает структурированный план.
  outputSchema: z.object({
    goal: z.string(),
    steps: z.array(
      z.object({
        title: z.string(),
        detail: z.string(),
        priority: z.enum(["low", "med", "high"]),
      }),
    ),
  }),
});
