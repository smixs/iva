// Pick the dedicated service account for a hardened install. If the preferred name is taken by
// an unrelated account we don't reuse it — we fall back to a numbered variant (iva_001, iva_002…)
// so the migration never collides with an existing user. The system UID is left to
// `useradd --system`, which allocates a free one from the system range.
import { spawnSync } from "node:child_process";

// Pure: given a base name and a predicate, return the first free `base` / `base_NNN`.
// `exists(name)` -> boolean. Throws if the numbered space is exhausted (should never happen).
export function pickServiceUserName(base, exists, { max = 999 } = {}) {
  if (!exists(base)) return base;
  for (let n = 1; n <= max; n++) {
    const name = `${base}_${String(n).padStart(3, "0")}`;
    if (!exists(name)) return name;
  }
  throw new Error(`No free ${base}_NNN account name available (checked 1..${max})`);
}

// Impure: does a system account with this name exist? Uses getent (falls back to id).
export function userExists(name, run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" })) {
  const g = run("getent", ["passwd", name]);
  if (typeof g.status === "number") return g.status === 0;
  // getent unavailable → id returns 0 only when the user exists.
  return (run("id", ["-u", name]).status ?? 1) === 0;
}

// Convenience: resolve the account to use now, probing the live system.
export function resolveServiceUser(base = "iva") {
  return pickServiceUserName(base, (name) => userExists(name));
}
