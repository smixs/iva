import type { Stats } from "node:fs";

export const GITHUB_BLOB_GUARD_BYTES: number;
export const MEMORY_REPORT_MAX_AGE_MS: number;

export type OversizeWorkingTreeFile = {
  path: string;
  size: number;
};

export function scanOversizeWorkingTreeFiles(options: {
  vaultPath: string;
  runGit: (args: string[]) => {
    status?: number | null;
    code?: number | null;
    stdout?: string;
    stderr?: string;
  };
  stat?: (path: string) => Stats;
  limitBytes?: number;
}): OversizeWorkingTreeFile[];

export function formatMegabytes(bytes: number): string;

export function classifyGitPushError(stderr: string): {
  kind: "oversize" | "auth" | "other";
  firstLine: string;
};

export function memoryReportProblems(report: unknown): Array<{
  key: string;
  count: number;
}>;

export function readMemoryMaintenanceReport(
  reportPath: string,
  options?: { now?: number; maxAgeMs?: number },
):
  | { status: "missing" | "stale" | "invalid"; problems: [] }
  | { status: "fresh"; problems: Array<{ key: string; count: number }> };

export function recordSkippedOversize(reportPath: string, count: number): boolean;
