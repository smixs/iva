import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

// Keep headroom below GitHub's hard 100 MB blob limit so the nightly backup
// cannot create history that the remote will reject.
export const GITHUB_BLOB_GUARD_BYTES = 90 * 1024 * 1024;
export const MEMORY_REPORT_MAX_AGE_MS = 48 * 60 * 60 * 1000;

function commandStatus(result) {
  return result?.status ?? result?.code ?? 1;
}

function firstNonEmptyLine(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}

export function scanOversizeWorkingTreeFiles({
  vaultPath,
  runGit,
  stat = lstatSync,
  limitBytes = GITHUB_BLOB_GUARD_BYTES,
}) {
  const listed = runGit(["ls-files", "--others", "--modified", "--exclude-standard", "-z"]);
  if (commandStatus(listed) !== 0) {
    const detail = firstNonEmptyLine(listed?.stderr);
    throw new Error(`git ls-files failed${detail ? `: ${detail}` : ""}`);
  }

  const paths = [...new Set(String(listed.stdout ?? "").split("\0").filter(Boolean))];
  const oversized = [];
  for (const path of paths) {
    let info;
    try {
      info = stat(resolve(vaultPath, path));
    } catch (error) {
      if (error?.code === "ENOENT") continue; // deleted between git listing and stat
      throw error;
    }
    // lstat measures the blob stored for a symlink, not the file it points outside the vault to.
    if (!info.isFile() && !info.isSymbolicLink()) continue;
    if (info.size > limitBytes) oversized.push({ path, size: info.size });
  }
  return oversized;
}

export function formatMegabytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function classifyGitPushError(stderr) {
  const text = String(stderr ?? "");
  const firstLine = firstNonEmptyLine(text) || "unknown git error";
  if (/GH001|exceeds\s+GitHub(?:\.com)?['’]s\s+file size limit/i.test(text)) {
    return { kind: "oversize", firstLine };
  }
  if (/Authentication failed|could not read (?:Username|Password)|Permission denied/i.test(text)) {
    return { kind: "auth", firstLine };
  }
  return { kind: "other", firstLine };
}

export function memoryReportProblems(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return [];
  return ["fixed", "review", "duplicates", "skipped_oversize"]
    .filter((key) => Number.isFinite(report[key]) && report[key] !== 0)
    .map((key) => ({ key, count: report[key] }));
}

export function readMemoryMaintenanceReport(
  reportPath,
  { now = Date.now(), maxAgeMs = MEMORY_REPORT_MAX_AGE_MS } = {},
) {
  if (!existsSync(reportPath)) return { status: "missing", problems: [] };
  try {
    const ageMs = now - statSync(reportPath).mtimeMs;
    if (ageMs >= maxAgeMs) return { status: "stale", problems: [] };
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    if (!report || typeof report !== "object" || Array.isArray(report)) {
      return { status: "invalid", problems: [] };
    }
    return { status: "fresh", problems: memoryReportProblems(report) };
  } catch {
    return { status: "invalid", problems: [] };
  }
}

export function recordSkippedOversize(reportPath, count) {
  if (!existsSync(reportPath)) return false;
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    return false;
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) return false;

  const tmp = `${reportPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ ...report, skipped_oversize: count }, null, 2)}\n`, "utf8");
    chmodSync(tmp, statSync(reportPath).mode & 0o777);
    renameSync(tmp, reportPath);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort: preserve the report update failure */
    }
    return false;
  }
}
