#!/usr/bin/env node
// Preflight-проверка порта Iva — тонкая CLI-обёртка над scripts/lib/ports.mjs.
//
//   node scripts/check-port.mjs            # IVA_PORT из .env (или 8723)
//   node scripts/check-port.mjs 8723       # конкретный порт
//   node scripts/check-port.mjs --suggest  # подсказать ближайший свободный
//   node scripts/check-port.mjs --json
//
// Exit code: 0 — свободен, 1 — занят, 2 — ошибка использования.

import { defaultChecker, PortSelector, readIvaPort } from "./lib/ports.mjs";

// Reporter: форматирование вывода отделено от логики проверки (SRP).
const reporter = {
  human({ port, occupied, holders }, suggestion) {
    if (!occupied) return `✓ Порт ${port} свободен.`;
    const who = holders.length ? `\n  держит → ${holders.join("; ")}` : "";
    const sug = suggestion ? `\n  свободная альтернатива → ${suggestion}` : "";
    return `✗ Порт ${port} занят.${who}${sug}`;
  },
  json: (result, suggestion) => JSON.stringify({ ...result, suggestion }, null, 2),
};

async function main(argv) {
  const args = argv.slice(2);
  const asJson = args.includes("--json");
  const suggest = args.includes("--suggest");
  const portArg = args.find((a) => /^\d+$/.test(a));
  const port = portArg ? Number(portArg) : readIvaPort();
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Некорректный порт: ${port}`);
    process.exit(2);
  }

  const checker = defaultChecker();
  const result = await checker.check(port);

  let suggestion = null;
  if (suggest || result.occupied) {
    suggestion = await new PortSelector(checker).firstFree(result.occupied ? port + 1 : port);
  }

  console.log(asJson ? reporter.json(result, suggestion) : reporter.human(result, suggestion));
  process.exit(result.occupied ? 1 : 0);
}

main(process.argv).catch((e) => {
  console.error(e?.message || String(e));
  process.exit(2);
});
