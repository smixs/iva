// Markdown → Telegram HTML (parse_mode=HTML) — HARDENED, standalone, zero imports.
//
// Bulletproof contract:
//   • NEVER throws on ANY string input.
//   • ALWAYS emits HTML that Telegram parse_mode=HTML accepts: only & < > escaped,
//     only whitelisted tags, every tag balanced (LIFO), no crossing, no illegal
//     nesting inside <pre>/<code>, attribute values safe.
//   • Length-safe: chunk on a tag-safe boundary to <=4096 (text) / caption limit.
//
// ЕДИНЫЙ ИСТОЧНИК ПРАВДЫ для разметки Telegram. Импортируется и из eve-бандла
// (agent/channels/telegram.ts), и из plain-node cron-скриптов (scripts/*). Pure
// string ops, ноль импортов — поэтому одинаково и бандлится rolldown'ом, и
// исполняется голым node. (Проверено: `eve build`/`eve dev` импорт из scripts/lib
// резолвят без проблем — старое поверье про «ломает eve dev 0.11.4» опровергнуто.)

// ── escaping ──────────────────────────────────────────────────────────────────
const HTML_ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
export const escHtml = (s) => String(s).replace(/[&<>]/g, (c) => HTML_ESC[c]);

// Attribute escaping, IDEMPOTENT: never double-escapes an existing entity.
const ENTITY = "#[0-9]+|#x[0-9a-fA-F]+|amp|lt|gt|quot";
const escAttr = (s) =>
  String(s)
    .replace(new RegExp(`&(?!(?:${ENTITY});)`, "g"), "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// HTML → читаемый plain-текст для send-фолбэков. Шлётся БЕЗ parse_mode, поэтому
// сущности ДЕКОДИРУЕМ обратно (&amp;→&, &lt;→< и т.д.) — иначе в чат уйдут литеральные
// &amp;/&lt;. amp декодируем ПОСЛЕДНИМ, чтобы не разэкранировать дважды (&amp;lt; → &lt;).
// NB: это НЕ sanitizeTelegramHtml — тот отдаёт безопасный HTML; здесь голый текст.
export function htmlToPlain(html) {
  return String(html)
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

// ── inline markdown → html ──────────────────────────────────────────────────────
// Protect inline code first (placeholders), escape the rest, then overlay tags.
function inlineHtml(text) {
  const spans = [];
  let s = String(text).replace(/`([^`]+)`/g, (_m, c) => {
    spans.push(`<code>${escHtml(c)}</code>`);
    return `  ${spans.length - 1}  `;
  });
  s = escHtml(s);
  // links [t](http(s)://url)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t, u) => `<a href="${escAttr(u)}">${t}</a>`);
  // bold
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/__([^_]+)__/g, "<b>$1</b>");
  // strikethrough
  s = s.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  // spoiler ||text||
  s = s.replace(/\|\|([^|]+(?:\|(?!\|)[^|]*)*)\|\|/g, "<tg-spoiler>$1</tg-spoiler>");
  // italic (single * or _), not touching the ** / __ already consumed
  s = s
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<i>$1</i>")
    .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "<i>$1</i>");
  // restore inline code
  return s.replace(/  (\d+)  /g, (_m, i) => spans[Number(i)] ?? "");
}

// GFM table separator: |---|:--:|---|
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/;
const tableCells = (l) =>
  l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());

// ── block + inline converter ────────────────────────────────────────────────────
function convert(md) {
  const lines = String(md).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // fenced code, optionally with language → <pre><code class="language-x">
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // closing ``` (no-op if half-open / EOF)
      const inner = escHtml(body.join("\n"));
      out.push(lang ? `<pre><code class="language-${lang}">${inner}</code></pre>` : `<pre>${inner}</pre>`);
      continue;
    }
    // table: header row + separator → header bold, body rows joined with ·
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      out.push(`<b>${tableCells(line).map(inlineHtml).join("  ·  ")}</b>`);
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        out.push(tableCells(lines[i]).map(inlineHtml).join("  ·  "));
        i++;
      }
      continue;
    }
    // ATX heading → bold
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) { out.push(`<b>${inlineHtml(h[1].trim())}</b>`); i++; continue; }
    // blockquote (grouped, multi-line); leading "!" on first line → expandable
    if (/^>\s?/.test(line)) {
      const ql = [];
      while (i < lines.length) {
        const mm = /^>\s?(.*)$/.exec(lines[i]);
        if (!mm) break;
        ql.push(mm[1]);
        i++;
      }
      let expandable = false;
      if (ql[0] && /^!\s?/.test(ql[0])) { expandable = true; ql[0] = ql[0].replace(/^!\s?/, ""); }
      const inner = ql.map(inlineHtml).join("\n");
      out.push(expandable ? `<blockquote expandable>${inner}</blockquote>` : `<blockquote>${inner}</blockquote>`);
      continue;
    }
    // unordered list
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul) { out.push(`• ${inlineHtml(ul[1])}`); i++; continue; }
    // ordered list
    const ol = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (ol) { out.push(`${ol[1]}. ${inlineHtml(ol[2])}`); i++; continue; }
    // horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push("—"); i++; continue; }
    out.push(line.trim() === "" ? "" : inlineHtml(line));
    i++;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ── tag whitelist / tokenizer for the safety pass ───────────────────────────────
const CLOSE_RE = /^<\/(b|strong|i|em|u|ins|s|strike|del|code|pre|blockquote|span|a|tg-spoiler|tg-emoji|tg-time)>/;
const ENTITY_RE = new RegExp(`^&(?:${ENTITY});`);

// Returns { kind:'open'|'close', len, name, html } or null if not a valid tag.
function matchTagAt(s) {
  let m = CLOSE_RE.exec(s);
  if (m) return { kind: "close", len: m[0].length, name: m[1] };
  m = /^<(b|strong|i|em|u|ins|s|strike|del|code|pre|blockquote|tg-spoiler)>/.exec(s);
  if (m) return { kind: "open", len: m[0].length, name: m[1], html: m[0] };
  m = /^<blockquote expandable>/.exec(s);
  if (m) return { kind: "open", len: m[0].length, name: "blockquote", html: "<blockquote expandable>" };
  m = /^<a\s+href="([^"<>]*)">/.exec(s);
  if (m) return { kind: "open", len: m[0].length, name: "a", html: `<a href="${escAttr(m[1])}">` };
  m = /^<span class="tg-spoiler">/.exec(s);
  if (m) return { kind: "open", len: m[0].length, name: "span", html: m[0] };
  m = /^<code class="language-([A-Za-z0-9+#._-]*)">/.exec(s);
  if (m) return { kind: "open", len: m[0].length, name: "code", html: `<code class="language-${m[1]}">` };
  m = /^<tg-emoji emoji-id="([0-9]+)">/.exec(s);
  if (m) return { kind: "open", len: m[0].length, name: "tg-emoji", html: `<tg-emoji emoji-id="${m[1]}">` };
  m = /^<tg-time unix="([0-9]+)"(?:\s+format="([a-zA-Z]*)")?>/.exec(s);
  if (m)
    return {
      kind: "open",
      len: m[0].length,
      name: "tg-time",
      html: m[2] != null ? `<tg-time unix="${m[1]}" format="${m[2]}">` : `<tg-time unix="${m[1]}">`,
    };
  return null;
}

// ── FINAL SAFETY PASS ────────────────────────────────────────────────────────────
// Walks the string; emits only whitelisted/balanced tags; neutralizes every stray
// < > & so Telegram's parser can never 400. Repairs crossing via close+reopen,
// forbids tags inside <code> and any non-<code> tag inside <pre>, balances at EOF.
// NEVER throws.
export function sanitizeTelegramHtml(input) {
  try {
    const s = String(input);
    const out = [];
    const stack = []; // [{ name, html }]
    const n = s.length;
    let i = 0;
    while (i < n) {
      const ch = s[i];
      if (ch === "&") {
        const m = ENTITY_RE.exec(s.slice(i));
        if (m) { out.push(m[0]); i += m[0].length; } else { out.push("&amp;"); i++; }
        continue;
      }
      if (ch === ">") { out.push("&gt;"); i++; continue; }
      if (ch !== "<") { out.push(ch); i++; continue; }

      const t = matchTagAt(s.slice(i));
      const top = stack[stack.length - 1];

      // verbatim contexts: nothing may nest inside <code>; only a <code> child or
      // </pre> may appear directly inside <pre>.
      if (top && top.name === "code") {
        if (t && t.kind === "close" && t.name === "code") {
          out.push("</code>"); stack.pop(); i += t.len;
        } else { out.push("&lt;"); i++; }
        continue;
      }
      if (top && top.name === "pre") {
        if (t && t.kind === "close" && t.name === "pre") {
          out.push("</pre>"); stack.pop(); i += t.len;
        } else if (t && t.kind === "open" && t.name === "code") {
          out.push(t.html); stack.push({ name: "code", html: t.html }); i += t.len;
        } else { out.push("&lt;"); i++; }
        continue;
      }

      if (!t) { out.push("&lt;"); i++; continue; }

      if (t.kind === "open") {
        // blockquote cannot nest inside blockquote → drop the redundant tag (keep text).
        if (t.name === "blockquote" && stack.some((e) => e.name === "blockquote")) { i += t.len; continue; }
        out.push(t.html);
        stack.push({ name: t.name, html: t.html });
        i += t.len;
        continue;
      }

      // close tag
      let idx = -1;
      for (let k = stack.length - 1; k >= 0; k--) if (stack[k].name === t.name) { idx = k; break; }
      if (idx === -1) { i += t.len; continue; } // stray close → drop
      const reopened = [];
      for (let k = stack.length - 1; k > idx; k--) { out.push(`</${stack[k].name}>`); reopened.push(stack[k]); }
      out.push(`</${t.name}>`);
      stack.length = idx;
      for (let k = reopened.length - 1; k >= 0; k--) { out.push(reopened[k].html); stack.push(reopened[k]); }
      i += t.len;
    }
    for (let k = stack.length - 1; k >= 0; k--) out.push(`</${stack[k].name}>`);
    return out.join("");
  } catch {
    // Absolute last resort: strip everything to plain escaped text.
    try { return String(input).replace(/<[^>]*>/g, "").replace(/[&<>]/g, (c) => HTML_ESC[c]); }
    catch { return ""; }
  }
}

// ── public converter ──────────────────────────────────────────────────────────────
export function mdToTelegramHtml(md) {
  try {
    return sanitizeTelegramHtml(convert(md));
  } catch {
    try { return escHtml(md); } catch { return ""; }
  }
}

// ── chunking ────────────────────────────────────────────────────────────────────
// Split RAW markdown on blank lines so each chunk's markup stays self-contained.
// Long paragraphs/lines are hard-split so no source chunk exceeds `limit`
// (JS string .length already counts UTF-16 code units, matching Telegram).
export function chunkMarkdown(md, limit = 3500) {
  const text = String(md);
  if (text.length <= limit) return [text];
  const paras = [];
  for (const p of text.split(/\n{2,}/)) {
    if (p.length <= limit) { paras.push(p); continue; }
    for (const line of p.split("\n")) {
      if (line.length <= limit) { paras.push(line); continue; }
      for (let j = 0; j < line.length; j += limit) paras.push(line.slice(j, j + limit));
    }
  }
  const chunks = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > limit) { chunks.push(cur); cur = ""; }
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// Tokenize HTML into indivisible atoms (a whole tag, a whole entity, or one char)
// so a hard split never lands inside a tag or entity.
function htmlAtoms(s) {
  const atoms = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    if (s[i] === "<") {
      const t = matchTagAt(s.slice(i));
      if (t) { atoms.push(s.slice(i, i + t.len)); i += t.len; continue; }
    }
    if (s[i] === "&") {
      const m = ENTITY_RE.exec(s.slice(i));
      if (m) { atoms.push(m[0]); i += m[0].length; continue; }
    }
    atoms.push(s[i]); i++;
  }
  return atoms;
}

// Hard-split already-converted HTML to <=limit, on atom boundaries, re-balancing
// each piece via the safety pass. Reserve headroom for auto-inserted close tags.
function splitHtmlHard(html, limit) {
  if (html.length <= limit) return [sanitizeTelegramHtml(html)];
  const reserve = Math.min(200, Math.floor(limit / 4));
  const budget = Math.max(1, limit - reserve);
  const pieces = [];
  let buf = "";
  for (const a of htmlAtoms(html)) {
    if (buf && buf.length + a.length > budget) { pieces.push(sanitizeTelegramHtml(buf)); buf = ""; }
    buf += a;
  }
  if (buf) pieces.push(sanitizeTelegramHtml(buf));
  // Final guarantee: nothing exceeds the hard limit even after re-balancing.
  const safe = [];
  for (const p of pieces) {
    if (p.length <= limit) { safe.push(p); continue; }
    for (let j = 0; j < p.length; j += limit) safe.push(sanitizeTelegramHtml(p.slice(j, j + limit)));
  }
  return safe;
}

// One-call helper: markdown → array of send-ready, balanced HTML chunks, each
// guaranteed <= limit. (text=4096, caption=1024). NEVER throws.
export function toTelegramHtmlChunks(md, limit = 4096) {
  try {
    const cap = Math.max(1, limit);
    const srcLimit = Math.min(3500, Math.floor(cap * 0.85));
    const result = [];
    for (const src of chunkMarkdown(md, srcLimit)) {
      const html = mdToTelegramHtml(src);
      if (html.length <= cap) { if (html) result.push(html); else if (src) result.push(""); }
      else for (const piece of splitHtmlHard(html, cap)) result.push(piece);
    }
    return result.length ? result : [""];
  } catch {
    try { return [escHtml(md)]; } catch { return [""]; }
  }
}

// ── rich-message routing ────────────────────────────────────────────────────────
// True when the text has a construct that Telegram's rich messages
// (sendRichMessage, Bot API 10.1) render natively but parse_mode=HTML CANNOT:
// GFM tables, task lists, <details>, block math. Headings/quotes/bold/etc.
// render fine in HTML, so — like hermes-agent — we do NOT route on those: normal
// replies stay on the proven HTML path. Conservative by design: a false negative
// is just today's behavior; a false positive falls back on API rejection anyway.
export function needsRichMessage(md) {
  const s = String(md);
  // GFM table delimiter row: a line of only pipes/dashes/colons/space with a dash run.
  // Plain prose effectively never produces such a line, so this alone is a safe signal.
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (t.includes("|") && /-{2,}/.test(t) && /^[|\-: \t]+$/.test(t)) return true;
  }
  if (/^[ \t]*[-*][ \t]+\[[ xX]\][ \t]+/m.test(s)) return true; // task list
  if (/<details[\s>]/i.test(s)) return true;                    // collapsible
  if (/\$\$[\s\S]+?\$\$/.test(s)) return true;                  // block math
  return false;
}