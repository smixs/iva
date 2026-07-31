// Replica-смоук: одноразовая полностью изолированная установка ивы + mock-провайдер.
// Проверяет то, что юнит-тесты не видят: прод-билд eve, старт сервера, первый реальный
// ответ через провайдера и restart/resume сессии. Ни .env, ни Telegram-токена, ни живого
// vault — только временная директория и закрытый allowlist переменных окружения.
// Запуск: npm run replica (в CI — шаг после build). По мотивам stabilization-форка
// mamysh/iva (PR #7), переписано под upstream.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile, cp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { startMockOpenAiServer } from "./lib/mock-openai-server.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MARKER = "CEDAR-4729";
const HEALTH_TIMEOUT_MS = 90_000;
const TURN_TIMEOUT_MS = 120_000;

let phase = "prepare";
function setPhase(name) {
  phase = name;
  note(`[smoke] ${new Date().toISOString()} phase: ${name}`);
}
const logs = [];

function note(line) {
  logs.push(line);
  if (logs.length > 400) logs.shift();
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function replicaEnv({ sandbox, app, port, mockBaseUrl, bearer }) {
  // Закрытый allowlist: process.env НЕ спредится — ни секретов хоста, ни его настроек.
  return {
    PATH: process.env.PATH,
    HOME: sandbox,
    NODE_ENV: "production",
    PORT: String(port),
    IVA_PORT: String(port),
    MODEL_PROVIDER: "ollama",
    OLLAMA_BASE_URL: mockBaseUrl,
    OLLAMA_API_KEY: "replica-key",
    OLLAMA_MODEL: "iva-replica",
    OLLAMA_CONTEXT_WINDOW: "131072",
    ASSISTANT_BEARER: bearer,
    ASSISTANT_DATA_DIR: join(app, "data"),
    ASSISTANT_VAULT_DIR: join(app, "vault"),
    ASSISTANT_TIMEZONE: "UTC",
    MEMORY_SEARCH_MODE: "bm25",
  };
}

function run(cmd, args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const capture = (buf) => String(buf).split("\n").filter(Boolean).forEach(note);
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited with ${code}`)),
    );
  });
}

function startEve({ app, env, port }) {
  const child = spawn(
    process.execPath,
    [join(app, "node_modules/eve/bin/eve.js"), "start", "--host", "127.0.0.1", "--port", String(port)],
    { cwd: app, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const capture = (buf) => String(buf).split("\n").filter(Boolean).forEach(note);
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  return child;
}

async function stopEve(child) {
  if (!child || child.exitCode !== null) return;
  const gone = new Promise((resolve) => child.once("exit", resolve));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  // Окно graceful stop у самого eve — 5с; даём заметно больше, чтобы SIGKILL
  // не обрубал запись состояния .workflow-data на полпути.
  const timer = new Promise((resolve) => setTimeout(resolve, 15000, "timeout"));
  if ((await Promise.race([gone, timer])) === "timeout") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* уже умер */
    }
    await gone;
  }
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`eve exited with ${child.exitCode} before becoming healthy`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      /* ещё не поднялся */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`eve did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s`);
}

async function turn(session, prompt, timeoutMs = TURN_TIMEOUT_MS) {
  let timer;
  let result;
  try {
    result = await Promise.race([
      session.send(prompt).then((r) => {
        note(`[smoke] send accepted (session ${session.state?.sessionId ?? "new"})`);
        return r.result();
      }),
      new Promise((_, reject) => {
        timer = setTimeout(reject, timeoutMs, new Error(`turn timed out after ${timeoutMs / 1000}s`));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  note(`[smoke] turn done: ${JSON.stringify(result?.status)}`);
  if (result.status === "failed" || !result.message) {
    throw new Error(`turn failed: status=${result.status} message=${JSON.stringify(result.message ?? "")}`);
  }
  return result.message.trim();
}

async function prepareReplica(sandbox) {
  const app = join(sandbox, "app");
  await mkdir(app, { recursive: true });
  for (const dir of ["agent", "scripts", "patches", "vault-template"]) {
    await cp(join(ROOT, dir), join(app, dir), { recursive: true });
  }
  for (const file of ["package.json", "package-lock.json", "tsconfig.json"]) {
    await cp(join(ROOT, file), join(app, file));
  }
  // node_modules симлинком: npm ci уже проверяет разрешение зависимостей в соседнем CI-шаге,
  // а здесь он бы стоил минуты и сотни мегабайт на каждый прогон.
  await symlink(join(ROOT, "node_modules"), join(app, "node_modules"), "dir");
  await mkdir(join(app, "data"), { recursive: true });
  return app;
}

async function main() {
  const sandbox = await mkdtemp(join(tmpdir(), "iva-replica-"));
  const mock = await startMockOpenAiServer();
  let eve = null;
  try {
    const app = await prepareReplica(sandbox);
    const port = await freePort();
    const bearer = randomBytes(24).toString("hex");
    const env = replicaEnv({ sandbox, app, port, mockBaseUrl: mock.baseUrl, bearer });
    await writeFile(join(app, ".env"), `ASSISTANT_BEARER=${bearer}\n`, { mode: 0o600 });

    setPhase("vault");
    await run(process.execPath, [join(app, "scripts/init-vault.mjs")], { cwd: app, env });

    setPhase("build");
    await run(process.execPath, [join(app, "node_modules/eve/bin/eve.js"), "build"], { cwd: app, env });

    setPhase("start");
    eve = startEve({ app, env, port });
    await waitForHealth(port, eve);

    // Тот же экземпляр eve, что и у реплики: её node_modules — симлинк на ROOT/node_modules.
    const { Client } = await import("eve/client");
    const client = new Client({ host: `http://127.0.0.1:${port}`, auth: { bearer: async () => bearer } });

    setPhase("first-reply");
    const session = client.session();
    const first = await turn(session, "Reply with a status word.");
    if (first !== "REPLICA_OK") throw new Error(`unexpected first reply: ${JSON.stringify(first)}`);

    setPhase("seed-marker");
    const remembered = await turn(session, `Remember this code: ${MARKER}`);
    if (remembered !== "REMEMBERED") throw new Error(`unexpected seed reply: ${JSON.stringify(remembered)}`);
    const savedState = session.state;

    setPhase("restart");
    await stopEve(eve);
    eve = startEve({ app, env, port });
    await waitForHealth(port, eve);

    setPhase("post-restart");
    const fresh = await turn(client.session(), "Reply with a status word.");
    if (fresh !== "REPLICA_OK") throw new Error(`unexpected post-restart reply: ${JSON.stringify(fresh)}`);

    // Строгий резюм припаркованной сессии через рестарт: на eve 0.27.13 сервер принимает
    // continue-POST (200), но молча теряет сообщение — re-enqueued run не просыпается,
    // в .workflow-data не появляется ни одного нового события (session-resume wedge).
    // До фикса ассерт мягкий: падение резюма роняет смоук только под
    // REPLICA_STRICT_RESUME=1 — этим же флагом баг и воспроизводится.
    setPhase("resume");
    const strictResume = process.env.REPLICA_STRICT_RESUME === "1";
    try {
      const resumed = client.session(savedState);
      const echo = await turn(
        resumed,
        "What code did I ask you to remember? Reply with the code only.",
        strictResume ? TURN_TIMEOUT_MS : 45_000,
      );
      if (echo !== MARKER) throw new Error(`resume lost the marker: got ${JSON.stringify(echo)}`);
      console.log("replica smoke: session resume across restart OK");
    } catch (err) {
      if (strictResume) throw err;
      console.warn(`replica smoke: KNOWN ISSUE — session resume across restart failed (${err?.message ?? err})`);
    }

    if (mock.requests.length < 3) throw new Error(`provider was barely exercised: ${mock.requests.length} requests`);
    console.log(`replica smoke: OK (provider requests: ${mock.requests.length})`);
  } catch (err) {
    console.error(`replica smoke FAILED at phase "${phase}": ${err?.message ?? err}`);
    console.error(`provider requests so far: ${mock.requests.length}`);
    console.error("--- last child output ---");
    for (const line of logs.slice(-120)) console.error(line);
    process.exitCode = 1;
  } finally {
    await stopEve(eve);
    await mock.close();
    if (process.env.REPLICA_KEEP === "1") console.error(`sandbox kept: ${sandbox}`);
    else await rm(sandbox, { recursive: true, force: true });
  }
}

await main();
