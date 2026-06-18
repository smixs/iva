import { Client } from "eve/client";

const HOST = process.env.SMOKE_HOST ?? "http://127.0.0.1:2000";
const client = new Client({ host: HOST });

function summarize(label, result) {
  const types = {};
  const tools = new Set();
  for (const ev of result.events ?? []) {
    types[ev.type] = (types[ev.type] ?? 0) + 1;
    const name =
      ev?.data?.toolName ?? ev?.data?.name ?? ev?.data?.tool ?? ev?.data?.subagentId;
    if (name && /tool|action|subagent|skill/i.test(ev.type)) tools.add(`${ev.type}:${name}`);
  }
  console.log(`\n===== ${label} =====`);
  console.log("status:", result.status);
  console.log("message:", (result.message ?? "").slice(0, 600));
  console.log("event types:", JSON.stringify(types));
  if (tools.size) console.log("tool/subagent/skill events:", [...tools].join(", "));
  if (result.data) console.log("structured data:", JSON.stringify(result.data).slice(0, 400));
}

async function turn(session, label, message) {
  const res = await session.send(message);
  const result = await res.result();
  summarize(label, result);
  return result;
}

const h = await client.health();
console.log("health:", h.status);

const session = client.session();
await turn(session, "1. ADD task", "Добавь задачу: купить кофе, приоритет высокий.");
await turn(session, "2. ADD task 2", "Ещё добавь: позвонить врачу завтра.");
await turn(session, "3. LIST tasks", "Покажи мои задачи.");
await turn(session, "4. DIGEST (skill)", "Дай мне утренний дайджест по задачам.");
await turn(
  session,
  "5. PLANNER (subagent)",
  "У меня большая цель: организовать переезд в новую квартиру. Разбей её на шаги через планировщик.",
);

console.log("\nDONE");
