import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { classifyAgentListeners } from "../lib/listener-security.ts";
import { readMemoryMaintenanceReport } from "../lib/memory-maintenance.ts";
import type { createCliRuntime } from "./runtime.ts";
import type { createCliSystemd } from "./systemd.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;
type SystemdLifecycle = ReturnType<typeof createCliSystemd>;

type DoctorDependencies = {
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly exit?: (code: number) => unknown;
  readonly log?: (...args: unknown[]) => void;
  readonly nodeVersion?: string;
};

type RollupEntry = {
  readonly lastSuccessAt?: unknown;
  readonly lastExitCode?: unknown;
};

type RollupStatus = Record<string, RollupEntry | null | undefined>;

export function createDoctorCommand(
  runtime: CliRuntime,
  systemdLifecycle: SystemdLifecycle,
  dependencies: DoctorDependencies = {},
) {
  const {
    ROOT,
    ENV_PATH,
    UNIT_DIR,
    NPM,
    SERVICES,
    MEMORY_SERVICES,
    MEMORY_TIMERS,
    TIMERS,
    DEFAULT_PORT,
    C,
    ok,
    warn,
    bad,
    run,
    cap,
    hasSystemd,
    systemd,
    readEnv,
    dataDirAbs,
  } = runtime;
  const { ensureAssistantBearer, writeUnits, activateUnits, migrateEnv } =
    systemdLifecycle;
  const now = dependencies.now ?? Date.now;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const exit = dependencies.exit ?? ((code: number) => process.exit(code));
  const log =
    dependencies.log ?? ((...args: unknown[]) => console.log(...args));
  const nodeVersion = dependencies.nodeVersion ?? process.versions.node;

  return async function cmdDoctor(): Promise<void> {
    let okN = 0;
    let warnN = 0;
    let fixN = 0;
    let badN = 0;
    const bearerChanged = ensureAssistantBearer();
    if (bearerChanged) fixN++;
    const env = readEnv();

    // 1. Node ≥24
    const major = parseInt(nodeVersion.split(".")[0], 10);
    if (major >= 24) {
      ok(`Node ${nodeVersion}`);
      okN++;
    } else {
      bad(`Node ${nodeVersion} < 24 — upgrade: nvm install 24`);
      badN++;
    }

    // 2. .env + required keys (the same REQUIRED logic as in scripts/setup/main.ts)
    if (!existsSync(ENV_PATH)) {
      bad(".env missing — run: iva config");
      badN++;
    } else {
      // codex — доступ по OAuth-токену (data/codex-auth.json), у ollama/opencode — API-ключ в .env.
      const providerKeys = {
        ollama: ["OLLAMA_API_KEY", "OLLAMA_MODEL"],
        opencode: ["OPENCODE_API_KEY", "OPENCODE_MODEL"],
        openrouter: ["OPENROUTER_API_KEY", "OPENROUTER_MODEL"],
        codex: ["CODEX_MODEL"],
      } as const;
      const rawProvider = env.MODEL_PROVIDER ?? "ollama";
      const provider = Object.hasOwn(providerKeys, rawProvider)
        ? (rawProvider as keyof typeof providerKeys)
        : undefined;
      if (!provider) {
        bad(
          `Invalid MODEL_PROVIDER ${JSON.stringify(rawProvider)}; expected one of: ${Object.keys(providerKeys).join(", ")} — run: iva config`,
        );
        badN++;
      } else {
        const required = [
          ...providerKeys[provider],
          "DEEPGRAM_API_KEY",
          "TELEGRAM_BOT_TOKEN",
          "TELEGRAM_ALLOWED_USER_IDS",
          "ASSISTANT_BEARER",
        ];
        const missing = required.filter((key) => !(env[key] || "").trim());
        if (
          provider === "codex" &&
          !existsSync(join(dataDirAbs(env), "codex-auth.json"))
        )
          missing.push("OpenAI sign-in (iva login)");
        if (!missing.length) {
          ok(`.env filled in (provider: ${provider})`);
          okN++;
        } else {
          bad(
            `.env incomplete, missing: ${missing.join(", ")} — run: iva config`,
          );
          badN++;
        }
      }
      // old .env without IVA_PORT (or with :3000) — migrate right here
      if (migrateEnv()) fixN++;
      // web search is optional; check the key of the SELECTED provider (SEARCH_PROVIDER)
      const searchKey: Record<string, string> = {
        tavily: "TAVILY_API_KEY",
        brave: "BRAVE_API_KEY",
        exa: "EXA_API_KEY",
        parallel: "PARALLEL_API_KEY",
      };
      const searchProvider = (env.SEARCH_PROVIDER || "tavily")
        .trim()
        .toLowerCase();
      const selectedSearchKey = searchKey[searchProvider] || searchKey.tavily;
      if (!(env[selectedSearchKey] || "").trim()) {
        warn(
          `web_search: SEARCH_PROVIDER=${searchProvider}, but ${selectedSearchKey} is not set — search won't work (iva config)`,
        );
        warnN++;
      } else {
        ok(`web_search: ${searchProvider}`);
        okN++;
      }
      // memory_search: hybrid mode needs one embedding key; base (grep) needs nothing.
      const memoryMode = (env.MEMORY_SEARCH_MODE || "grep")
        .trim()
        .toLowerCase();
      if (
        memoryMode === "hybrid" &&
        !(env.JINA_API_KEY || env.DEEPINFRA_API_KEY || "").trim()
      ) {
        warn(
          "memory_search: MEMORY_SEARCH_MODE=hybrid but no JINA_API_KEY/DEEPINFRA_API_KEY — falls back to BM25",
        );
        warnN++;
      } else {
        ok(`memory_search: ${memoryMode}`);
        okN++;
      }
    }

    // 3. Build
    if (existsSync(join(ROOT, ".output/server/index.mjs"))) {
      ok("Build in place (.output)");
      okN++;
    } else {
      warn(".output missing — building…");
      if (run(NPM, ["run", "build"]).status === 0) {
        ok("Built");
        fixN++;
      } else {
        bad("Build failed");
        badN++;
      }
    }

    if (!hasSystemd()) {
      warn(
        "systemd unavailable (not Linux) — skipping service and timer checks",
      );
      return summary();
    }

    // 4. Units installed
    const present =
      existsSync(UNIT_DIR) &&
      readdirSync(UNIT_DIR).some((file) =>
        /^iva.*\.(service|timer)$/.test(file),
      );
    if (!present) {
      warn("systemd units not installed — installing…");
      try {
        writeUnits();
        activateUnits();
        ok("Units installed, enabled and active");
        fixN++;
      } catch (error) {
        bad((error as { message: string }).message);
        badN++;
      }
    } else {
      try {
        writeUnits(); // refresh: Environment=PORT syncs with the current IVA_PORT (eliminates drift)
        ok("systemd units installed (refreshed)");
        okN++;
      } catch (error) {
        bad((error as { message: string }).message);
        badN++;
      }
    }

    // 5. Services active
    for (const service of SERVICES) {
      if (systemd.isEnabled(service) && systemd.isActive(service)) {
        ok(`${service} enabled and active`);
        okN++;
      } else {
        warn(`${service} disabled or inactive — activating…`);
        try {
          systemd.resetFailed([service]);
          systemd.activate([service]);
          ok(`${service} enabled and active`);
          fixN++;
        } catch (error) {
          bad((error as { message: string }).message);
          badN++;
        }
      }
    }
    // A newly generated bearer is read only at process start. Without this restart,
    // doctor would fix the file while leaving the live Eve process unable to accept it.
    if (bearerChanged) {
      warn("iva.service needs one restart to load the new internal bearer");
      try {
        systemd.restart(["iva.service"]);
        ok("iva.service loaded the internal bearer");
        fixN++;
      } catch (error) {
        bad((error as { message: string }).message);
        badN++;
      }
    }
    // A refreshed unit does not move an already-running old process off 0.0.0.0.
    // Detect the actual socket and restart once so doctor repairs that upgrade state too.
    const port = Number((readEnv().IVA_PORT || DEFAULT_PORT).trim());
    const inspectListener = () => {
      const result = cap("ss", ["-H", "-ltn", "sport", "=", `:${port}`]);
      return result.code === 0
        ? classifyAgentListeners(result.out, port)
        : "unknown";
    };
    let listener = inspectListener();
    if (listener === "exposed") {
      warn(
        `iva.service is exposed beyond loopback on port ${port} - restarting securely`,
      );
      try {
        systemd.restart(["iva.service"]);
        for (let attempt = 0; attempt < 30; attempt++) {
          await sleep(500);
          listener = inspectListener();
          if (listener === "loopback") break;
        }
        if (listener === "loopback") {
          ok(`iva.service bound to loopback:${port}`);
          fixN++;
        } else {
          bad(`iva.service still exposed on port ${port}`);
          badN++;
        }
      } catch (error) {
        bad((error as { message: string }).message);
        badN++;
      }
    } else if (listener === "loopback") {
      ok(`iva.service bound to loopback:${port}`);
      okN++;
    } else if (listener === "absent") {
      warn(`no listener found on port ${port}`);
      warnN++;
    } else {
      warn("could not inspect listener addresses (ss unavailable)");
      warnN++;
    }

    // Background timers enabled
    let timerFailed = false;
    for (const timer of TIMERS) {
      if (systemd.isEnabled(timer) && systemd.isActive(timer)) okN++;
      else {
        warn(`${timer} disabled or inactive — enabling…`);
        try {
          systemd.activate([timer]);
          fixN++;
        } catch (error) {
          timerFailed = true;
          bad((error as { message: string }).message);
          badN++;
        }
      }
    }
    if (!timerFailed)
      ok(
        `Background timers enabled and active (${TIMERS.length}: ${MEMORY_TIMERS.length} memory + update check)`,
      );

    // A oneshot service can be inactive and still healthy; its persistent failed state is the
    // signal that the last nightly run broke. Query only units actually installed on this host.
    const installedMemoryServices = MEMORY_SERVICES.filter((unit) =>
      existsSync(join(UNIT_DIR, unit)),
    );
    let failedMemoryServices = 0;
    for (const unit of installedMemoryServices) {
      const state = systemd.query("is-failed", unit);
      if (state.code === 0 && state.out === "failed") {
        bad(
          `${unit} failed — check: journalctl --user -u ${unit} -n 100 --no-pager`,
        );
        badN++;
        failedMemoryServices++;
      }
    }
    if (installedMemoryServices.length && failedMemoryServices === 0) {
      ok(
        `Memory units have no failed state (${installedMemoryServices.length})`,
      );
      okN++;
    }

    // daily/weekly/monthly/yearly now run as in-process eve schedules (no systemd unit of
    // their own to query for a failed state, unlike doctor above) — data/rollup-status.json
    // (scripts/lib/schedule-runner.ts) is the only record of whether they're actually firing.
    // Threshold gives each cadence a full extra cycle of slack before doctor complains:
    // 26h for the 04:00 daily slot, 8d/32d/370d for weekly/monthly/yearly respectively.
    let rollupStatus: unknown = null;
    try {
      rollupStatus = JSON.parse(
        readFileSync(join(dataDirAbs(env), "rollup-status.json"), "utf8"),
      );
    } catch {
      // No rollup-status.json yet (fresh install, or nothing has fired yet) — not an error.
    }
    if (rollupStatus) {
      const staleAfterHours = {
        daily: 26,
        weekly: 8 * 24,
        monthly: 32 * 24,
        yearly: 370 * 24,
      };
      for (const period of ["daily", "weekly", "monthly", "yearly"] as const) {
        // "memory-<period>" — the `name` each agent/schedules/memory-*.ts passes to
        // runScheduledJob, not the bare period (see scripts/lib/schedule-runner.ts).
        const entry = (rollupStatus as RollupStatus)[`memory-${period}`];
        if (!entry) continue; // hasn't fired yet on this install (e.g. yearly, on most installs)
        if (typeof entry.lastSuccessAt === "number") {
          const ageHours = (now() - entry.lastSuccessAt) / (60 * 60 * 1000);
          const thresholdHours = staleAfterHours[period];
          if (ageHours > thresholdHours) {
            warn(
              `memory-${period} schedule hasn't succeeded in ${Math.round(ageHours)}h (> ${thresholdHours}h) — check: journalctl --user -u iva.service | grep schedule-runner`,
            );
            warnN++;
          } else {
            ok(
              `memory-${period} schedule last succeeded ${Math.round(ageHours)}h ago`,
            );
            okN++;
          }
        } else {
          warn(
            `memory-${period} schedule has never succeeded — check: journalctl --user -u iva.service | grep schedule-runner`,
          );
          warnN++;
        }
        // A recent success doesn't mean the MOST RECENT attempt was clean — e.g. it
        // succeeded, then a later catch-up retry failed and hasn't run again since.
        // Surface that even when the staleness check above is satisfied.
        if (
          typeof entry.lastExitCode === "number" &&
          entry.lastExitCode !== 0
        ) {
          warn(
            `memory-${period} schedule's last run exited ${entry.lastExitCode} — check: journalctl --user -u iva.service | grep schedule-runner`,
          );
          warnN++;
        }
      }
    }

    // 6. Vault + git origin (report only — we don't initiate git operations)
    const vaultRel = env.ASSISTANT_VAULT_DIR || "vault";
    const vaultPath = vaultRel.startsWith("/")
      ? vaultRel
      : join(ROOT, vaultRel);
    if (!existsSync(vaultPath)) {
      warn(
        `vault not found (${vaultPath}) — created on first memory or: npm run init-vault`,
      );
      warnN++;
    } else if (
      cap("git", ["-C", vaultPath, "remote", "get-url", "origin"]).out
    ) {
      ok("vault + git origin");
      okN++;
    } else {
      warn(
        `vault without git origin — memory backup not configured:\n    gh repo create <user>/iva-vault --private --source="${vaultPath}" --remote=origin --push`,
      );
      warnN++;
    }

    // enforce-report.json is produced by iva-memory-doctor.service, so only complain about
    // missing/stale output when that timer is enabled. A fresh report is still useful either way.
    const maintenanceTimerEnabled = systemd.isEnabled(
      "iva-memory-doctor.timer",
    );
    const maintenanceReport = readMemoryMaintenanceReport(
      join(vaultPath, ".graph/enforce-report.json"),
    );
    if (maintenanceReport.status === "fresh") {
      if (maintenanceReport.problems.length) {
        warn(
          `ночной maintenance сообщает о проблемах: ${maintenanceReport.problems
            .map(({ key, count }) => `${key}=${count}`)
            .join(", ")}`,
        );
        warnN++;
      } else {
        ok("Ночной maintenance-отчёт свежий, проблем нет");
        okN++;
      }
    } else if (maintenanceTimerEnabled) {
      if (maintenanceReport.status === "invalid")
        warn("ночной maintenance оставил нечитаемый отчёт");
      else warn("ночной maintenance давно не отчитывался");
      warnN++;
    }

    return summary();

    function summary(): void {
      log();
      log(
        `${C.b}Summary:${C.x} ${C.g}${okN} ok${C.x} · ${C.y}${warnN} warn${C.x} · ${C.c}${fixN} fixed${C.x} · ${C.r}${badN} fail${C.x}`,
      );
      exit(badN > 0 ? 1 : 0);
    }
  };
}
