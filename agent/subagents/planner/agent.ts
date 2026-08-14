import { defineAgent } from "eve";
import { z } from "zod";
import {
  providerConfig as cfg,
  makeTextModel,
  withReasoningStripped,
} from "../../provider.js";

// Субагенты всегда работают на модели основного провайдера (MODEL_PROVIDER), а не на своей.
// Локальных провайдеров и собственных env в субагентах не заводим — источник один: provider.ts.

export default defineAgent({
  description:
    "Разбивает крупную цель пользователя на конкретные выполнимые шаги. " +
    "Делегируй сюда, когда задача большая и её нужно декомпозировать на план.",
  model: withReasoningStripped(makeTextModel()),
  modelContextWindowTokens: cfg.contextWindow,
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
