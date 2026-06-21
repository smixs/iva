// SOLID-ядро проверки портов Iva. Переиспользуется CLI (scripts/check-port.mjs) и setup.mjs.
//
//   • Probe (SRP/ISP)   — один способ детекта «занят ли порт»: bind / /proc / docker.
//   • PortChecker (DIP) — агрегирует инъецированные Probe, не зная их реализации.
//   • PortSelector      — выбор свободного порта поверх PortChecker.
//   • OCP: новый способ детекта = новый Probe в массиве, без правок PortChecker/PortSelector.

import net from "node:net";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const DEFAULT_PORT = 8723;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── Probe-контракт (LSP): { name, check(port) -> Promise<{ occupied, holder? }> } ──

// Источник правды: пытаемся сами занять порт — ровно то, что делает eve-сервер на старте.
export const bindProbe = {
  name: "bind",
  check(port) {
    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", (e) =>
        resolve({ occupied: e.code === "EADDRINUSE", holder: e.code === "EADDRINUSE" ? "порт занят" : undefined }),
      );
      srv.once("listening", () => srv.close(() => resolve({ occupied: false })));
      srv.listen(port, "0.0.0.0"); // 0.0.0.0 перекрывает и 127.0.0.1, и чужой wildcard-биндинг
    });
  },
};

// Атрибуция (Linux): кто слушает порт — из /proc/net/tcp{,6}. uid=0 → root/docker.
export const procProbe = {
  name: "proc",
  async check(port) {
    const hex = port.toString(16).toUpperCase().padStart(4, "0");
    for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      if (!existsSync(f)) continue;
      for (const line of readFileSync(f, "utf8").split("\n").slice(1)) {
        const c = line.trim().split(/\s+/);
        if (!c[1] || c[3] !== "0A") continue; // 0A = LISTEN
        if (c[1].endsWith(":" + hex)) return { occupied: true, holder: `uid=${c[7]} inode=${c[9]}` };
      }
    }
    return { occupied: false };
  },
};

// Атрибуция: опубликованные docker-порты (именно это сломало :3000 на VPS).
export const dockerProbe = {
  name: "docker",
  async check(port) {
    try {
      const out = execFileSync("docker", ["ps", "--format", "{{.Names}}\t{{.Ports}}"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      for (const line of out.split("\n")) {
        const [name, ports] = line.split("\t");
        if (ports && new RegExp(`[:.]${port}->`).test(ports)) return { occupied: true, holder: `docker:${name}` };
      }
    } catch {
      /* docker нет/недоступен — мягко пропускаем (Probe деградирует, а не падает) */
    }
    return { occupied: false };
  },
};

// ── PortChecker (DIP): зависит от абстракции Probe[], а не от их реализаций ──
export class PortChecker {
  constructor(probes) {
    this.probes = probes;
  }
  async check(port) {
    const holders = [];
    let occupied = false;
    for (const p of this.probes) {
      const r = await p.check(port);
      if (r.occupied) {
        occupied = true;
        if (r.holder) holders.push(`${p.name}: ${r.holder}`);
      }
    }
    return { port, occupied, holders };
  }
}

// ── PortSelector: ближайший свободный порт поверх checker ──
export class PortSelector {
  constructor(checker) {
    this.checker = checker;
  }
  async firstFree(start, span = 50) {
    for (let p = start; p < start + span && p <= 65535; p++) {
      if (!(await this.checker.check(p)).occupied) return p;
    }
    return null;
  }
}

// Готовый чекер со всеми доступными способами детекта.
export function defaultChecker() {
  return new PortChecker([bindProbe, procProbe, dockerProbe]);
}

// Читает IVA_PORT из .env (приоритет), затем process.env, иначе дефолт.
export function readIvaPort() {
  const env = join(ROOT, ".env");
  if (existsSync(env)) {
    const m = readFileSync(env, "utf8").match(/^\s*IVA_PORT\s*=\s*(\d+)/m);
    if (m) return Number(m[1]);
  }
  return Number(process.env.IVA_PORT) || DEFAULT_PORT;
}
