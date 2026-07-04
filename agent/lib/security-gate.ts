// Детерминированные security-гейты в hot path (порт из agent/skills/security-defense/scripts/
// sanitizer.py + outbound_gate.py). Ноль python в рантайме, ноль latency-процессов.
//   - sanitizeInbound: чистит недоверенный текст (Telegram/web) ДО модели, флагует инъекции.
//   - scanOutbound: ловит утечку секретов/эксфильтрацию в ответе ДО отправки, редактит.
// spend_governor и bash-паттерны (blocked-patterns.json) остаются на Python (nightly/on-demand).

// --- INBOUND: очистка недоверенного ввода ---------------------------------------------------

// Невидимые (Cf формат, Cc контрол кроме \n\r\t) + явные zero-width. \p{..} требует флаг u.
const INVISIBLE_RE = /[\p{Cf}\p{Cc}​‌‍⁠﻿­͏᠎]/gu;
const KEEP_CONTROL = new Set(["\n", "\r", "\t"]);

// Wallet-drain: символы, которые токенизируются в 3-10 токенов (Tibetan/Yi/Braille/Math…).
const WALLET_DRAIN_RE =
  /[ༀ-࿿ꀀ-꓏⠀-⣿]|[\u{1D400}-\u{1D7FF}\u{10000}-\u{1034F}]/gu;

// Гомоглифы: кириллица/греческий/fullwidth, визуально = латиница (обход regex).
const LOOKALIKES: Record<string, string> = {
  А: "A", В: "B", С: "C", Е: "E", Н: "H", К: "K", М: "M", О: "O", Р: "P", Т: "T", Х: "X",
  а: "a", с: "c", е: "e", о: "o", р: "p", х: "x", у: "y",
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O",
  Ρ: "P", Τ: "T", Υ: "Y", Χ: "X", ο: "o", ν: "v",
};

const ROLE_MARKER_RE =
  /(?:^|\n)\s*(?:system|assistant|user|human|AI|claude|instruction|admin|root)\s*[:\-]\s/gim;

const OVERRIDE_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+)?previous\s+instructions?/i,
  /forget\s+(?:all\s+)?(?:your\s+)?(?:previous\s+)?instructions?/i,
  /you\s+are\s+now\s+(?:in\s+)?(?:\w+\s+)?mode/i,
  /new\s+(?:system\s+)?instructions?\s*:/i,
  /override\s+(?:all\s+)?(?:safety|security|rules|guidelines)/i,
  /act\s+as\s+(?:if\s+)?(?:you\s+are\s+)?(?:a\s+)?(?:different|new|unrestricted)/i,
  /(?:DAN|STAN|DUDE|KEVIN)\s+mode/i,
  /jailbreak|do\s+anything\s+now/i,
  /pretend\s+(?:you\s+)?(?:are|have)\s+no\s+(?:rules|restrictions|limits)/i,
  /(?:reveal|show|display|print|output)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions)/i,
  /(?:send|forward|email|post)\s+(?:all\s+)?(?:data|files|secrets|keys|tokens)/i,
];

export interface SanitizeResult {
  text: string;
  blocked: boolean;
  reason: string;
  flags: string[]; // мягкие сигналы (не блок): invisible/lookalikes/role/override
}

export function sanitizeInbound(input: string, maxChars = 50000): SanitizeResult {
  const originalLen = input.length;
  const flags: string[] = [];

  // 1. Strip invisible (сохраняя \n\r\t).
  let invisibleRemoved = 0;
  let text = input.replace(INVISIBLE_RE, (c) => {
    if (KEEP_CONTROL.has(c)) return c;
    invisibleRemoved++;
    return "";
  });
  if (originalLen > 100 && invisibleRemoved > originalLen * 0.05) {
    return {
      text: "",
      blocked: true,
      reason: `Excessive invisible characters: ${invisibleRemoved} (${Math.floor((invisibleRemoved * 100) / originalLen)}%)`,
      flags: ["invisible-flood"],
    };
  }
  if (invisibleRemoved) flags.push(`invisible=${invisibleRemoved}`);

  // 2. Wallet-drain.
  let walletRemoved = 0;
  text = text.replace(WALLET_DRAIN_RE, () => {
    walletRemoved++;
    return "";
  });
  if (walletRemoved > 50) {
    return {
      text: "",
      blocked: true,
      reason: `Wallet drain attempt: ${walletRemoved} expensive Unicode chars`,
      flags: ["wallet-drain"],
    };
  }

  // 3. Гомоглифы — нормализуем ТОЛЬКО в копии-зонде для детекта (кирилл. «systеm:» → латиница).
  //    Сам text НЕ трогаем: иначе легитимный не-латинский текст («она», греческий, и т.д.) исказится.
  //    Мультиязычность важнее — модели уходит оригинал, детект видит нормализованное.
  let normalized = 0;
  const probe = Array.from(text)
    .map((c) => {
      if (LOOKALIKES[c]) {
        normalized++;
        return LOOKALIKES[c];
      }
      return c;
    })
    .join("");
  if (normalized) flags.push(`lookalikes=${normalized}`);

  // 4. Detect role markers + override attempts (на зонде — ловит гомоглиф-обход, текст цел).
  const roleMarkers = (probe.match(ROLE_MARKER_RE) || []).length;
  const overrides = OVERRIDE_PATTERNS.filter((re) => re.test(probe)).length;
  if (roleMarkers) flags.push(`role-markers=${roleMarkers}`);
  if (overrides) flags.push(`overrides=${overrides}`);

  // 5. Hard char cap.
  if (text.length > maxChars) text = text.slice(0, maxChars);

  // Блок только при явной инъекции: (роли≥2 И override≥1) ИЛИ override≥3.
  if ((roleMarkers >= 2 && overrides >= 1) || overrides >= 3) {
    return {
      text,
      blocked: true,
      reason: `Prompt injection: ${roleMarkers} role markers, ${overrides} override attempts`,
      flags,
    };
  }
  return { text, blocked: false, reason: "clean", flags };
}

// --- OUTBOUND: утечка секретов / эксфильтрация -----------------------------------------------

const API_KEY_PATTERNS: Array<[string, RegExp]> = [
  ["openai", /sk-[A-Za-z0-9]{20,}/g],
  ["anthropic", /sk-ant-[A-Za-z0-9\-]{20,}/g],
  ["google_api", /AIza[A-Za-z0-9\-_]{35}/g],
  ["github_pat", /ghp_[A-Za-z0-9]{36}/g],
  ["github_fine", /github_pat_[A-Za-z0-9_]{82}/g],
  ["slack_bot", /xoxb-[0-9]{10,}-[A-Za-z0-9]+/g],
  ["slack_user", /xoxp-[0-9]{10,}-[A-Za-z0-9]+/g],
  ["telegram_bot", /\d{8,10}:[A-Za-z0-9_-]{35}/g],
  ["aws_access", /AKIA[A-Z0-9]{16}/g],
  ["stripe", /sk_(?:live|test)_[A-Za-z0-9]{20,}/g],
  ["sendgrid", /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g],
  ["vercel", /vercel_[A-Za-z0-9_]{20,}/g],
  ["supabase", /sbp_[A-Za-z0-9]{40,}/g],
  ["fal_key", /fal_[A-Za-z0-9_]{20,}/g],
  ["bearer_token", /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi],
  ["generic_key", /(?:api[_-]?key|apikey|api[_-]?token)\s*[=:]\s*["']?[A-Za-z0-9\-._]{20,}/gi],
  ["generic_secret", /(?:secret|password|passwd|pwd)\s*[=:]\s*["']?[^\s"']{8,}/gi],
];

const INTERNAL_PATH_PATTERNS: Array<[string, RegExp]> = [
  ["home_dotfiles", /(?:\/home\/\w+|~)\/\.(?:ssh|config|env|gnupg|aws|docker|kube)/g],
  ["etc_sensitive", /\/etc\/(?:shadow|passwd|sudoers|ssh)/g],
  ["run_secrets", /\/run\/secrets\/\w+/g],
  ["proc_environ", /\/proc\/\w+\/environ/g],
  ["dot_env_content", /^\w+_(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*.+$/gm],
];

const EXFIL_PATTERNS: Array<[string, RegExp]> = [
  ["markdown_image_exfil", /!\[.*?\]\(https?:\/\/[^)]*(?:token|key|secret|api|auth|password|env|data=)[^)]*\)/gi],
  ["html_img_exfil", /<img[^>]+src\s*=\s*["']https?:\/\/[^"']*(?:token|key|secret|api|auth)[^"']*["']/gi],
  ["url_with_secret_param", /https?:\/\/[^\s]*[?&](?:token|key|secret|api_key|password|auth)=[^\s&]{8,}/gi],
];

// Артефакты инъекции, «протёкшие» в вывод — предупреждаем, но НЕ редактим (это может быть цитата).
const INJECTION_ARTIFACTS: Array<[string, RegExp]> = [
  ["special_tokens", /<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>/g],
];

const REDACTED = "[REDACTED]";

export interface OutboundResult {
  clean: boolean; // нет утечек секретов/путей/эксфила (артефакты не считаются)
  text: string; // с редактированными секретами
  findings: Array<{ type: string; name: string; preview: string }>;
}

export function scanOutbound(input: string, redact = true): OutboundResult {
  let text = input;
  const findings: OutboundResult["findings"] = [];
  const groups: Array<[string, Array<[string, RegExp]>]> = [
    ["api_key", API_KEY_PATTERNS],
    ["internal_path", INTERNAL_PATH_PATTERNS],
    ["data_exfil", EXFIL_PATTERNS],
  ];
  for (const [type, patterns] of groups) {
    for (const [name, re] of patterns) {
      const matches = input.match(re);
      if (!matches) continue;
      for (const m of matches) {
        findings.push({ type, name, preview: m.slice(0, 12) + "…" });
        if (redact) text = text.split(m).join(REDACTED);
      }
    }
  }
  for (const [name, re] of INJECTION_ARTIFACTS) {
    const matches = input.match(re);
    if (matches) for (const m of matches) findings.push({ type: "injection_artifact", name, preview: m.slice(0, 20) });
  }
  const clean = findings.every((f) => f.type === "injection_artifact");
  return { clean, text, findings };
}
