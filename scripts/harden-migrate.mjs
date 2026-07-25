#!/usr/bin/env node
// Opt-in hardening migration: move a plain install (running under the invoking/admin account with
// .env inside the code checkout) onto a dedicated non-login service user with config relocated to
// /etc/iva. This shrinks the blast radius of a hijacked agent (a dedicated user with no login and
// no sudo) and keeps secrets out of the repo. It does NOT add systemd namespace/capability
// sandboxing to the main service: eve's headless-browser sandbox is incompatible with it (proven —
// the unit fails at the CAPABILITIES step). Resource caps and the dedicated user are the hardening.
//
// Runs staged and idempotent, records what it changed, and rolls back on failure. Every privileged
// step goes through sudo; the caller (bin/iva.mjs) guarantees sudo is usable before we start.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolveServiceUser } from "./lib/service-user.mjs";

const HARDENED_ENV_PATH = "/etc/iva/iva.env";
const HARDENED_ENV_DIR = "/etc/iva";

function sh(cmd, args, { dry, sudo = false } = {}) {
  const argv = sudo ? ["sudo", "-n", cmd, ...args] : [cmd, ...args];
  if (dry) {
    process.stdout.write(`  [dry-run] ${argv.join(" ")}\n`);
    return { status: 0, stdout: "", stderr: "" };
  }
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
  return { status: r.status ?? (r.error ? 1 : 0), stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// Stage 0 — detect current layout and decide the target.
export function detectSchema({ envPath, serviceUser, hardenedEnvPath = HARDENED_ENV_PATH } = {}) {
  return {
    envRelocated: envPath === hardenedEnvPath,
    // "dedicated" = a non-login system account, not the human/admin user that ran the install.
    onDedicatedUser: /^iva(_\d{3})?$/.test(serviceUser || ""),
  };
}

// Stage 1 — provision the dedicated non-login service user (idempotent).
function provisionUser(user, { dry }) {
  const exists = sh("getent", ["passwd", user]).status === 0;
  if (exists) {
    process.stdout.write(`  user ${user} already exists — reusing\n`);
    return { created: false };
  }
  const r = sh("useradd", ["--system", "--create-home", "--shell", "/usr/sbin/nologin", user], { dry, sudo: true });
  if (r.status !== 0) throw new Error(`useradd ${user} failed: ${r.stderr.trim()}`);
  sh("loginctl", ["enable-linger", user], { dry, sudo: true }); // user units must survive logout
  process.stdout.write(`  created dedicated user ${user} (nologin) + linger\n`);
  return { created: true };
}

// Stage 2 — relocate config out of the code checkout into /etc/iva (0600, owned by the service user).
function relocateConfig(oldEnvPath, user, { dry }) {
  if (!existsSync(oldEnvPath)) throw new Error(`no .env to relocate at ${oldEnvPath}`);
  sh("install", ["-d", "-m", "0750", "-o", "root", "-g", user, HARDENED_ENV_DIR], { dry, sudo: true });
  const r = sh("install", ["-m", "0600", "-o", user, "-g", user, oldEnvPath, HARDENED_ENV_PATH], { dry, sudo: true });
  if (r.status !== 0) throw new Error(`relocate config failed: ${r.stderr.trim()}`);
  process.stdout.write(`  config relocated ${oldEnvPath} → ${HARDENED_ENV_PATH} (0600, ${user})\n`);
  return { from: oldEnvPath, to: HARDENED_ENV_PATH };
}

function userInfo(user) {
  const r = sh("getent", ["passwd", user]);
  if (r.status !== 0) throw new Error(`user ${user} not found`);
  const [, , uid, , , home] = r.stdout.trim().split(":");
  return { uid, home };
}

// Run a command as the service user with a working user-systemd session (linger provides the
// runtime dir). Used to regenerate/enable the units under the dedicated account.
function asUser(user, uid, cmd, args, { dry, env = {} } = {}) {
  const rt = `/run/user/${uid}`;
  const base = ["-u", user, "env", `XDG_RUNTIME_DIR=${rt}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=${rt}/bus`,
    ...Object.entries(env).map(([k, v]) => `${k}=${v}`), cmd, ...args];
  return sh("sudo", ["-n", ...base], { dry });
}

// Stage 3 — re-home the install + node + browser under the dedicated user (preserving the current
// code version and vault/data, which live inside the install dir). node is copied from the
// invoking user's nvm; the browser (Chromium) is reinstalled under the service user so no absolute
// path points back into the old home.
function rehome(installDir, user, invokingHome, done, { dry }) {
  const { uid, home: userHome } = userInfo(user);
  const targetInstall = `${userHome}/iva`;
  // 3a. move code + state (vault/data live inside installDir) and hand it to the service user.
  // Record the intent BEFORE the destructive move so rollback can undo a partway failure.
  done.push(["rehome-move", { targetInstall, installDir }]);
  must(sh("mv", [installDir, targetInstall], { dry, sudo: true }), "move install");
  sh("chown", ["-R", `${user}:${user}`, targetInstall], { dry, sudo: true });
  // 3b. node: copy the invoking user's nvm wholesale (self-contained, same version).
  must(sh("cp", ["-a", `${invokingHome}/.nvm`, `${userHome}/.nvm`], { dry, sudo: true }), "copy nvm");
  sh("chown", ["-R", `${user}:${user}`, `${userHome}/.nvm`], { dry, sudo: true });
  const node = firstNodeBin(`${userHome}/.nvm/versions/node`, dry);
  const bin = node.replace(/\/node$/, "");
  // 3c. iva CLI on the service user's PATH (absolute node — the account is nologin, PATH is bare).
  sh("install", ["-d", "-o", user, "-g", user, `${userHome}/.local/bin`], { dry, sudo: true });
  const wrap = `printf '#!/bin/sh\\nexec "%s" "%s/bin/iva.mjs" "$@"\\n' '${node}' '${targetInstall}' ` +
    `| sudo -n tee ${userHome}/.local/bin/iva >/dev/null && sudo -n chmod 755 ${userHome}/.local/bin/iva ` +
    `&& sudo -n chown ${user}:${user} ${userHome}/.local/bin/iva`;
  sh("sh", ["-c", wrap], { dry });
  // 3d. Chromium under the service user. agent-browser (the npm package) already came with the
  // copied nvm; only the Chromium binary is per-home, so just fetch it. System libs are already
  // present from the original install. Best-effort — browser tasks degrade, the bot still runs.
  asUser(user, uid, `${bin}/agent-browser`, ["install"], { dry });
  process.stdout.write(`  re-homed install → ${targetInstall}, node + browser under ${user}\n`);
  return { targetInstall, node };
}

function must(r, what) {
  if ((r.status ?? 1) !== 0) throw new Error(`${what} failed: ${(r.stderr || "").trim()}`);
  return r;
}

function firstNodeBin(nodeVersionsDir, dry) {
  if (dry) return `${nodeVersionsDir}/vXX/bin/node`;
  // The service user's home is 0700 after chown, so read the path as root.
  const r = sh("sudo", ["-n", "sh", "-c", `ls -d ${nodeVersionsDir}/*/bin/node 2>/dev/null | head -1`]);
  const p = r.stdout.trim();
  if (!p) throw new Error(`no node under ${nodeVersionsDir}`);
  return p;
}

// Stage 3d.1 — rewrite absolute paths in the relocated config that pointed into the old install
// location (e.g. ASSISTANT_VAULT_DIR / ASSISTANT_DATA_DIR), so the agent doesn't write to a path
// that no longer exists after the move.
function rewriteConfigPaths(oldInstall, newInstall, { dry }) {
  if (oldInstall === newInstall) return;
  sh("sed", ["-i", `s|${oldInstall}|${newInstall}|g`, HARDENED_ENV_PATH], { dry, sudo: true });
  process.stdout.write(`  rewrote config paths ${oldInstall} → ${newInstall}\n`);
}

// Stage 3e — rebuild eve for the new home. eve's build (.output) bakes the absolute path of the
// install it was built in, so after re-homing it fails with "Failed to resolve the authored
// package root"; a rebuild under the service user regenerates it for the new location.
function rebuild(user, targetInstall, node, { dry }) {
  const { uid, home } = userInfo(user);
  const bin = node.replace(/\/node$/, "");
  const r = asUser(user, uid, "sh", ["-c", `cd ${targetInstall} && ${bin}/npm run build`],
    { dry, env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } });
  must(r, "eve build");
  process.stdout.write(`  rebuilt eve for ${targetInstall}\n`);
}

// Stage 4 — regenerate + enable the units under the service user; stop the old invoking-user units.
// Run the CLI with the service user's own node explicitly — invoking bin/iva.mjs via its
// `#!/usr/bin/env node` shebang would pick up the system node (often too old), and process.execPath
// then bakes that wrong path into the generated units. eve requires Node >=24.
function switchUnits(user, targetInstall, node, { dry }) {
  const { uid } = userInfo(user);
  const bin = node.replace(/\/node$/, "");
  asUser(user, uid, node, [`${targetInstall}/bin/iva.mjs`, "restart"], { dry, env: { PATH: `${bin}:/usr/bin:/bin` } });
  process.stdout.write(`  units regenerated + started under ${user} (node ${node})\n`);
}

export async function migrate({ installDir, envPath, base = "iva", invokingHome = process.env.HOME, dry = false } = {}) {
  const user = resolveServiceUser(base);
  process.stdout.write(`hardening migration → dedicated user "${user}"${dry ? " (dry-run)" : ""}\n`);
  const done = [];
  try {
    done.push(["provision-user", provisionUser(user, { dry })]);
    done.push(["relocate-config", relocateConfig(envPath, user, { dry })]);
    const { targetInstall, node } = rehome(installDir, user, invokingHome, done, { dry });
    rewriteConfigPaths(installDir, targetInstall, { dry }); // config vars that pointed into the old install must follow the move
    rebuild(user, targetInstall, node, { dry }); // eve build bakes absolute paths → rebuild for the new home
    done.push(["switch-units", {}]);
    switchUnits(user, targetInstall, node, { dry });
    process.stdout.write(`staged: ${done.map((d) => d[0]).join(", ")}\n`);
    return { ok: true, user, targetInstall, done };
  } catch (error) {
    process.stderr.write(`hardening failed: ${error.message} — rolling back\n`);
    rollback(done, { installDir, user, invokingHome, dry });
    return { ok: false, user, error: error.message, done };
  }
}

// Reverse the recorded stages, most-recent first. Restores the original install so a failed
// migration never leaves the user without a working (if un-hardened) bot.
function rollback(done, { installDir, user, invokingHome, dry }) {
  const { uid } = safe(() => userInfo(user)) || {};
  for (const [stage, info] of [...done].reverse()) {
    try {
      if (stage === "switch-units" && uid) {
        asUser(user, uid, "systemctl", ["--user", "disable", "--now", "iva.service", "iva-telegram-poll.service"], { dry });
      }
      if (stage === "rehome-move" && info?.targetInstall) {
        // move the code back only if the move actually happened, and hand it to the invoking user
        // so the old units work again. Existence checked as root (the target is 0700 by then).
        const moved = sh("sudo", ["-n", "test", "-e", info.targetInstall]).status === 0;
        const back = sh("sudo", ["-n", "test", "-e", installDir]).status !== 0;
        if (moved && back) {
          sh("mv", [info.targetInstall, installDir], { dry, sudo: true });
          const owner = safe(() => sh("stat", ["-c", "%U", invokingHome]).stdout.trim()) || "root";
          sh("chown", ["-R", `${owner}:${owner}`, installDir], { dry, sudo: true });
        }
      }
      if (stage === "relocate-config") sh("rm", ["-rf", HARDENED_ENV_DIR], { dry, sudo: true });
      if (stage === "provision-user" && info?.created) {
        // free the account before deleting it: linger + the user manager + any stray processes
        // otherwise pin userdel.
        sh("loginctl", ["disable-linger", user], { dry, sudo: true });
        const u = safe(() => userInfo(user).uid);
        if (u) sh("systemctl", ["stop", `user@${u}.service`], { dry, sudo: true });
        sh("pkill", ["-9", "-u", user], { dry, sudo: true });
        sh("userdel", ["-r", user], { dry, sudo: true });
      }
    } catch (e) {
      process.stderr.write(`  rollback step ${stage} failed: ${e.message}\n`);
    }
  }
  process.stderr.write("rollback complete\n");
}

function safe(fn) {
  try { return fn(); } catch { return undefined; }
}
