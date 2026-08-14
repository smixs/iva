import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import {
  generateAssistantBearer,
  isAssistantBearer,
} from "../lib/assistant-auth.ts";
import { writeEnvAtomicSync } from "../lib/env-file.ts";
import {
  BRAIN_ENTRYPOINT,
  LEGACY_BRAIN_ENTRYPOINT,
  LEGACY_BRAIN_UNITS,
  LEGACY_MEMORY_UNITS,
} from "../lib/legacy-memory-units.ts";
import { cleanupSystemdUnits } from "../lib/systemd-control.ts";
import { validateTimeZone } from "../lib/timezone.ts";
import type { createCliRuntime } from "./runtime.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;

type QuietOptions = {
  readonly quiet?: boolean;
};

type WriteUnitsOptions = {
  readonly ensureBearer?: boolean;
};

export function createCliSystemd(runtime: CliRuntime) {
  const {
    ROOT,
    ENV_PATH,
    UNIT_DIR,
    NODE,
    NODE_BIN_DIR,
    VENV_PY,
    DEFAULT_PORT,
    OLD_DEFAULT_HOST,
    SERVICES,
    TIMERS,
    BRAIN_SERVICE,
    BRAIN_TIMER,
    ok,
    warn,
    hasSystemd,
    systemd,
    readEnv,
    dataDirAbs,
    writeEnvVars,
  } = runtime;

  // Existing installs gain the server-side bearer on their next unit refresh/update.
  // The same migration also repairs .env permissions because it contains every runtime secret.
  function ensureAssistantBearer({
    quiet = false,
  }: QuietOptions = {}): boolean {
    if (!existsSync(ENV_PATH)) return false;
    let changed = false;
    const bearer = (readEnv().ASSISTANT_BEARER || "").trim();
    const bearerLines =
      readFileSync(ENV_PATH, "utf8").match(/^\s*ASSISTANT_BEARER\s*=/gm)
        ?.length || 0;
    if (!isAssistantBearer(bearer)) {
      writeEnvVars({ ASSISTANT_BEARER: generateAssistantBearer() });
      changed = true;
    } else if (bearerLines !== 1) {
      writeEnvVars({ ASSISTANT_BEARER: bearer });
      changed = true;
    }
    if ((statSync(ENV_PATH).mode & 0o777) !== 0o600) {
      chmodSync(ENV_PATH, 0o600);
      changed = true;
    }
    if (changed && !quiet) ok(".env protected and internal bearer configured");
    return changed;
  }

  // Same regex-validated timezone both writeUnits() (substituted into the deploy/ timer
  // templates' __TIMEZONE__) and ivaServiceBody() (Environment=TZ=, since the eve schedules
  // in agent/schedules/memory-*.ts carry no timezone of their own and fire in the process's
  // local time) need — one place so the fallback/validation rule can't drift between them.
  function configuredTimezone(): string {
    const raw = (readEnv().ASSISTANT_TIMEZONE || "UTC").trim();
    if (/^[A-Za-z0-9_+/-]+$/.test(raw)) {
      const timezone = validateTimeZone(raw);
      if (timezone) return timezone;
    }
    warn(`invalid ASSISTANT_TIMEZONE=${JSON.stringify(raw)}; using UTC`);
    return "UTC";
  }

  // ── systemd units: single source of truth ───────────────────────────────
  function ivaServiceBody(): string {
    // PATH with the node directory (= npm global bin under nvm), Restart=always.
    const port = (readEnv().IVA_PORT || DEFAULT_PORT).trim();
    const timezone = configuredTimezone();
    return [
      "[Unit]",
      "Description=Iva",
      "After=network-online.target",
      "",
      "[Service]",
      // Everything eve creates (vault, transcripts, data/) must not be world-readable:
      // the system umask (022 on Ubuntu) would expose it to every user on the box.
      "UMask=0077",
      `WorkingDirectory=${ROOT}`,
      `EnvironmentFile=${ROOT}/.env`,
      // Стартуем через `eve start`, а НЕ напрямую `node .output/server/index.mjs`: eve start
      // вызывает prewarmBuiltAppSandboxes() и собирает шаблон песочницы ДО приёма трафика. Сырой
      // index.mjs prewarm не делает → первое же вложение падает SandboxTemplateNotProvisionedError
      // (шаблона нет в .eve/sandbox-cache). Ключ шаблона — контент-хеш, после iva update он меняется,
      // поэтому provision обязан идти на каждом старте, а не разово. eve start остаётся foreground.
      // --host: bind to loopback only. eve's auth strategy localDev() treats a request as local
      // by the hostname of request.url — i.e. by the client's own Host header — so a server bound
      // to 0.0.0.0 hands local-dev rights (and with them a sandbox-free `bash` on the host) to
      // anyone who can reach the port and sends `Host: 127.0.0.1`. The port is only ever consumed
      // locally: telegram-poll, the sweep and the memory scripts all talk to 127.0.0.1.
      // Env is not enough here — `eve start` takes options.host ?? "0.0.0.0" and overwrites
      // HOST/NITRO_HOST for the spawned .output/server/index.mjs, so the flag is what binds.
      `ExecStart=${NODE} ${ROOT}/node_modules/eve/bin/eve.js start --host 127.0.0.1`,
      `Environment=PORT=${port}`,
      `Environment=TZ=${timezone}`,
      `Environment=PATH=${NODE_BIN_DIR}:%h/.local/bin:/usr/local/bin:/usr/bin:/bin`,
      "Environment=AGENT_BROWSER_MAX_OUTPUT=24000",
      // world-local queue delivers turnWorkflow messages via an HTTP self-call guarded by
      // undici headers/body timeouts that default to 30 seconds; any agent turn longer than
      // that gets falsely marked undelivered and redelivered while the original handler is
      // still running — two concurrent turns, two slightly different Telegram replies.
      // One hour matches the longest tool-heavy turns.
      "Environment=WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS=3600000",
      "Environment=WORKFLOW_LOCAL_BODY_TIMEOUT_MS=3600000",
      "Restart=always",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");
  }

  // One-time (idempotent) perms migration for installs created before UMask=0077: the
  // secrets file and the data dir were world-readable under the default umask 022.
  // Runs from writeUnits — i.e. on every install/update — so old installs self-heal.
  function hardenPerms(): void {
    // Каждая цель — независимо: сбой на .env не должен отменять миграцию data/ (и наоборот).
    // Предупреждаем, но установку юнитов не срываем: юниты сами несут UMask=0077, а сорванный
    // writeUnits оставил бы систему вовсе без юнитов — хуже, чем старые права.
    try {
      if (existsSync(ENV_PATH)) chmodSync(ENV_PATH, 0o600);
    } catch (error) {
      warn(
        `perms migration (.env) failed: ${(error as { message: string }).message}`,
      );
    }
    try {
      const data = dataDirAbs();
      if (existsSync(data)) chmodSync(data, 0o700);
    } catch (error) {
      warn(
        `perms migration (data/) failed: ${(error as { message: string }).message}`,
      );
    }
    // Стор воркфлоу несёт транскрипты диалогов, vault — саму память; оба старше UMask-фикса
    // могли быть созданы world-readable. chmod только верхнего уровня (закрывает traversal).
    const vaultRel = readEnv().ASSISTANT_VAULT_DIR || "vault";
    const vaultDir = vaultRel.startsWith("/") ? vaultRel : join(ROOT, vaultRel);
    for (const path of [
      join(ROOT, ".eve"),
      join(ROOT, ".workflow-data"),
      vaultDir,
    ]) {
      try {
        if (existsSync(path)) chmodSync(path, 0o700);
      } catch (error) {
        warn(
          `perms migration (${relative(ROOT, path)}) failed: ${(error as { message: string }).message}`,
        );
      }
    }
  }

  // Writes iva.service + all deploy/iva-*.{service,timer} with placeholder substitution. daemon-reload.
  function writeUnits({
    ensureBearer = true,
  }: WriteUnitsOptions = {}): string[] {
    hardenPerms();
    if (ensureBearer) ensureAssistantBearer({ quiet: true });
    mkdirSync(UNIT_DIR, { recursive: true });
    writeFileSync(join(UNIT_DIR, "iva.service"), ivaServiceBody());
    const written = ["iva.service"];
    const deploy = join(ROOT, "deploy");
    const timezone = configuredTimezone();
    for (const file of readdirSync(deploy)) {
      if (!/^iva-.*\.(service|timer)$/.test(file)) continue;
      const template = readFileSync(join(deploy, file), "utf8")
        .replaceAll("__PROJECT_DIR__", ROOT)
        .replaceAll("__NODE_BIN__", NODE)
        .replaceAll("__PYTHON_BIN__", VENV_PY)
        .replaceAll("__TIMEZONE__", timezone);
      writeFileSync(join(UNIT_DIR, file), template);
      written.push(file);
    }
    if (hasSystemd()) systemd.daemonReload();
    removeLegacyMemoryUnits();
    removeLegacyBrainUnits(written);
    return written;
  }

  // The Brain rename: iva-memory-doctor.{service,timer} → iva-brain.{service,timer}. deploy/
  // ships only the new pair, so the copy loop above never overwrites or removes the old one —
  // this retires it by exact name, off every writeUnits() call (update/doctor/config/restart/
  // install.sh), so every install migrates without a dedicated command.
  //
  // Order is the whole point. The nightly vault care must never be absent, not even for the
  // window between two steps of an update that dies halfway:
  //   1. BOTH new units must be written to UNIT_DIR by THIS run (daemon-reload already done).
  //      The timer alone is not a nightly job: a half-unpacked deploy/ can carry either file
  //      without the other, and a timer whose iva-brain.service is missing fires at 05:00 into
  //      nothing — while looking migrated. A service without its timer never fires at all.
  //   2. and the timer enabled+active — `iva update` calls writeUnits() but not
  //      activateUnits(), so a merely-written unit would still never fire,
  //   3. only then may the old pair be disabled and deleted.
  // Any failure in 1–2 keeps the old units: a duplicated nightly run is harmless (both take
  // the same .memory.lock), a missing one costs the user a night of memory care.
  // The kept-unit half of the same guarantee. The legacy pair was written by an install made
  // before the rename, so its ExecStart names scripts/memory/doctor.ts — a file THIS tree no
  // longer ships (it is scripts/memory/brain.ts now), and writeUnits() runs on the already
  // updated tree (update.ts calls it from postCommit). So every path that keeps the old unit
  // as the safety net would otherwise keep a unit that fails at 05:00 with "Cannot find
  // module" — the lost night the ordering above exists to prevent. Repoint it in place, by
  // the exact old path only, so an operator-edited unit keeps everything else it says.
  // Silent on its own: the callers that keep the pair report it, the one that retires the
  // pair right after has nothing to report.
  function repointLegacyBrainUnits(stale: readonly string[]): string[] {
    const repointed: string[] = [];
    for (const unit of stale) {
      const path = join(UNIT_DIR, unit);
      let body: string;
      try {
        body = readFileSync(path, "utf8");
      } catch {
        continue; // unreadable — nothing safe to rewrite, and cleanup below still tries
      }
      if (!body.includes(LEGACY_BRAIN_ENTRYPOINT)) continue;
      try {
        writeFileSync(
          path,
          body.replaceAll(LEGACY_BRAIN_ENTRYPOINT, BRAIN_ENTRYPOINT),
        );
        repointed.push(unit);
      } catch (error) {
        warn(
          `could not repoint ${unit} at ${BRAIN_ENTRYPOINT}: ${(error as { message: string }).message}`,
        );
      }
    }
    if (repointed.length) systemd.daemonReload();
    return repointed;
  }

  function removeLegacyBrainUnits(written: readonly string[]): string[] {
    if (!hasSystemd()) return [];
    const stale = LEGACY_BRAIN_UNITS.filter((unit) =>
      existsSync(join(UNIT_DIR, unit)),
    );
    if (!stale.length) return [];
    // Before anything else: whatever the steps below decide, a kept unit must be able to run.
    const repointed = repointLegacyBrainUnits(stale);
    const keeping = (): void => {
      if (repointed.length)
        ok(
          `kept ${repointed.join(", ")} — repointed at ${BRAIN_ENTRYPOINT}, so tonight's vault care still runs`,
        );
    };
    const missing = [BRAIN_SERVICE, BRAIN_TIMER].filter(
      (unit) => !written.includes(unit) || !existsSync(join(UNIT_DIR, unit)),
    );
    if (missing.length) {
      warn(
        `skipping legacy brain-unit cleanup — ${missing.join(" and ")} not installed yet (run \`iva doctor\`, then it will run automatically)`,
      );
      keeping();
      return [];
    }
    try {
      systemd.activate([BRAIN_TIMER]);
    } catch (error) {
      warn(
        `skipping legacy brain-unit cleanup — ${BRAIN_TIMER} did not come up: ${(error as { message: string }).message}`,
      );
      keeping();
      return [];
    }
    try {
      return cleanupSystemdUnits({
        units: stale,
        disable: (unit) => systemd.disableNow([unit]),
        remove: (unit) => rmSync(join(UNIT_DIR, unit)),
        reload: () => systemd.daemonReload(),
        reset: () => systemd.resetFailed(),
      });
    } catch (error) {
      warn(
        `legacy brain-unit cleanup incomplete: ${(error as { message: string }).message}`,
      );
      keeping();
      return stale;
    }
  }

  // Existing installs may still carry the 8 retired iva-memory-{daily,weekly,monthly,yearly}
  // unit files (deploy/ no longer ships them, so the copy loop above never overwrites or
  // removes them on its own). `iva update`/`iva doctor` both call writeUnits() on every run,
  // so this self-heals every existing install onto eve schedules without a dedicated
  // migration command — by exact name only, so an unrelated self-host timer is never touched.
  // Guards against tearing down the old systemd safety net while running a BUILD that
  // predates the eve-schedules migration — e.g. .output/ wasn't rebuilt yet after an
  // `iva update` pulled this change (writeUnits() runs before the build step in some
  // call paths). Without this check, a stale build would lose its memory rollups
  // entirely (old timers gone, new eve schedules not actually in the bundle) until the
  // next successful build. A shallow recursive text scan for markers unique to the
  // COMPILED schedules is enough — bare "memory-daily" is NOT unique enough: instrumentation.ts
  // always imports agent/lib/schedule-migration.ts, whose LEGACY_MEMORY_UNITS array contains
  // the string "iva-memory-daily.service", which itself contains "memory-daily" as a substring
  // — that would make the marker match on every build regardless of whether the schedules
  // themselves actually compiled. Nitro's schedule-task wrapper embeds each schedule's own
  // source path ("schedules/memory-daily.ts") in its description string, which cannot
  // appear anywhere else.
  //
  // ALL FOUR memory-* markers are required, not just one: a partial build (e.g. one
  // schedule file failed to compile, or a build got interrupted mid-write) could contain
  // memory-daily.ts's marker while missing weekly/monthly/yearly — a single-marker check
  // would then let removeLegacyMemoryUnits() tear down the OLD systemd timers for periods
  // that have no working in-process replacement in THIS build, losing those rollups
  // entirely rather than just delaying the migration one more boot.
  const BUILD_SCHEDULE_MARKERS = [
    "schedules/memory-daily.ts",
    "schedules/memory-weekly.ts",
    "schedules/memory-monthly.ts",
    "schedules/memory-yearly.ts",
  ];
  const BUILD_SCAN_MAX_FILE_BYTES = 15_000_000;
  function buildHasSchedules(): boolean {
    const outputServer = join(ROOT, ".output/server");
    if (!existsSync(outputServer)) return false;
    const remaining = new Set(BUILD_SCHEDULE_MARKERS);
    try {
      for (const path of readdirSync(outputServer, {
        recursive: true,
      }) as string[]) {
        if (remaining.size === 0) break;
        const full = join(outputServer, path);
        let stat: ReturnType<typeof statSync>;
        try {
          stat = statSync(full);
        } catch {
          continue;
        }
        if (!stat.isFile() || stat.size > BUILD_SCAN_MAX_FILE_BYTES) continue;
        // .output/server is the WHOLE server bundle plus every vendored dependency — a
        // miss (the common case: doctor/writeUnits runs on every `iva update`) would
        // otherwise mean synchronously reading tens to hundreds of MB. The markers can only
        // ever land in Nitro's own compiled JS/JSON output, never in a vendored asset.
        if (!/\.(mjs|cjs|js|json)$/.test(path)) continue;
        let content: Buffer;
        try {
          content = readFileSync(full); // Buffer — no need to decode as UTF-8 just to substring-search
        } catch {
          continue; // unreadable — not where a schedule name would live anyway
        }
        // Markers can land in different files (each schedule may compile to its own
        // _virtual/*.schedule.mjs, or all get inlined into one bundle) — check every
        // still-missing marker against every file rather than stopping at the first hit.
        for (const marker of remaining) {
          if (content.includes(marker)) remaining.delete(marker);
        }
      }
    } catch {
      return false;
    }
    return remaining.size === 0;
  }

  function removeLegacyMemoryUnits(): string[] {
    if (!hasSystemd()) return [];
    const units = LEGACY_MEMORY_UNITS.filter((unit) =>
      existsSync(join(UNIT_DIR, unit)),
    );
    if (!units.length) return [];
    if (!buildHasSchedules()) {
      warn(
        "skipping legacy memory-timer cleanup — the current build doesn't contain the eve schedules yet (rebuild with `iva doctor` or `npm run build`, then it will run automatically)",
      );
      return [];
    }
    try {
      return cleanupSystemdUnits({
        units,
        disable: (unit) => systemd.disableNow([unit]),
        remove: (unit) => rmSync(join(UNIT_DIR, unit)),
        reload: () => systemd.daemonReload(),
        reset: () => systemd.resetFailed(),
      });
    } catch (error) {
      warn(
        `legacy memory-timer cleanup incomplete: ${(error as { message: string }).message}`,
      );
      return units;
    }
  }

  function activateUnits(): void {
    systemd.activate([...SERVICES, ...TIMERS]);
  }

  function removeUnits(): string[] {
    if (!existsSync(UNIT_DIR)) return [];
    const units = readdirSync(UNIT_DIR).filter((file) =>
      /^iva.*\.(service|timer)$/.test(file),
    );
    return cleanupSystemdUnits({
      units,
      disable: (unit) => systemd.disableNow([unit]),
      remove: (unit) => rmSync(join(UNIT_DIR, unit)),
      reload: () => systemd.daemonReload(),
      reset: () => systemd.resetFailed(),
    });
  }

  // Migrate old installs to IVA_PORT. Idempotent: on the first `iva update`
  // after switching to the new scheme it guarantees the variable and keeps the server
  // (Environment=PORT=$IVA_PORT) from drifting away from clients (whose default is ASSISTANT_HOST).
  function migrateEnv({ quiet = false }: QuietOptions = {}): boolean {
    if (!existsSync(ENV_PATH)) return false;
    const env = readEnv();
    if (env.IVA_PORT) return false; // already on the new scheme — leave it alone
    const host = env.ASSISTANT_HOST || "";
    const local = host.match(
      /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/?$/i,
    );
    const isOldDefault = host === OLD_DEFAULT_HOST;
    // old default :3000 → new default 8723; custom local host → its port; otherwise the default
    const port = isOldDefault ? DEFAULT_PORT : local ? local[1] : DEFAULT_PORT;
    let raw =
      readFileSync(ENV_PATH, "utf8").replace(/\n*$/, "\n") +
      `IVA_PORT=${port}\n`;
    // don't leave a stale :3000 in ASSISTANT_HOST — otherwise clients get stuck on the taken port
    if (isOldDefault)
      raw = raw.replace(
        /^(\s*ASSISTANT_HOST\s*=).*$/m,
        `$1http://127.0.0.1:${port}`,
      );
    writeEnvAtomicSync(ENV_PATH, raw);
    if (!quiet)
      ok(
        `.env migrated → IVA_PORT=${port}${isOldDefault ? ", ASSISTANT_HOST moved off :3000" : ""}`,
      );
    return true;
  }

  // Any restart via `iva` first regenerates the unit → Environment=PORT always equals
  // the current IVA_PORT from .env. Without this, editing IVA_PORT + restart would leave the server
  // on the old port (the unit was already baked) while clients read the new one — the same desync.
  function restartServices(): void {
    writeUnits();
    systemd.restart(SERVICES);
  }

  return {
    ensureAssistantBearer,
    writeUnits,
    activateUnits,
    removeUnits,
    migrateEnv,
    restartServices,
  };
}
