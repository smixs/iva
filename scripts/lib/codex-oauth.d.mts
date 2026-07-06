// Типы для codex-oauth.mjs (чистый ESM) — чтобы tsgo-потребители (agent/provider.ts,
// agent/vision.ts) не ловили TS7016. Формат хранилища data/codex-auth.json.
export interface CodexAuth {
  id_token?: string;
  access_token: string;
  refresh_token?: string;
  accountId: string | null;
  planType: string | null;
}

export interface LoginOptions {
  dataDir?: string;
  log?: (msg: string) => void;
  open?: boolean;
  lang?: string;
}

export const ISSUER: string;
export const CLIENT_ID: string;
export const CODEX_BASE_URL: string;

export function authFilePath(dataDir?: string): string;
export function readAuth(dataDir?: string): CodexAuth | null;
export function writeAuth(auth: CodexAuth, dataDir?: string): void;
export function parseJwt(jwt: string): Record<string, unknown>;
export function jwtExp(jwt: string): number;
export function accountFromIdToken(idToken: string): { accountId: string | null; planType: string | null };
export function getAccessToken(dataDir?: string): Promise<{ accessToken: string; accountId: string | null }>;
export function codexAuthHeaders(dataDir?: string): Promise<Record<string, string>>;
export function runDeviceCodeLogin(opts?: LoginOptions): Promise<CodexAuth>;
export function runBrowserLogin(opts?: LoginOptions): Promise<CodexAuth>;
export function login(mode?: "device" | "browser", opts?: LoginOptions): Promise<CodexAuth>;
export function listCodexModels(opts?: { dataDir?: string }): Promise<string[]>;
