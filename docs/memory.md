# Memory

Memory is the part that compounds. Most agents forget you the moment the context window fills — 131k tokens goes fast. Iva files everything into a plain-markdown vault, reorganizes it while you sleep, and pulls back only what each question needs. You talk, it files.

![Iva's memory tree: daily transcripts as leaves, rolled-up summaries as branches, CORE.md and typed cards as the trunk](../assets/iva-memory-tree.webp)

## The memory tree

*Iva* means *willow*, and the memory is shaped like one:

| Layer | What lives there | Path |
|---|---|---|
| 🍃 Leaves | the word-for-word transcript of each day, Iva's replies included | `daily/YYYY-MM-DD.md` |
| 🌿 Branches | summaries folded upward: day → week → month → year | `summaries/daily/`, `weekly/`, `monthly/`, `yearly/` |
| 🪵 Trunk | `CORE.md` (≤1200 chars, in every prompt) + typed cards: contacts, projects, decisions, ideas, notes | `CORE.md`, `cards/` |

CORE.md rides in every system prompt; everything else comes in per question through ranked search. A weekly summary costs about 1/35th of its seven raw days, so recall stays cheap as the vault grows.

## Nightly rollup

One script, four timers, server-local time. `scripts/memory/rollup.ts` drives the running agent through `eve/client`:

| Timer | When | Reads | Writes |
|---|---|---|---|
| daily | 04:00 | yesterday's raw transcript | cards, daily summary, CORE.md |
| weekly | Sun 04:15 | 7 daily summaries | weekly summary |
| monthly | 1st, 04:20 | the month's weeklies | monthly summary |
| yearly | Jan 1, 04:25 | the year's monthlies | yearly summary |

Daily and weekly runs post a report to Telegram; monthly and yearly run silent.

The daily pass extracts entities through `write_card` — a tool whose type and status enums come from the vault's `schema.json`, so the model cannot invent card types. Every fact gets one operation:

- ➕ **ADD** — a new card, or a new line on an existing one.
- 🔁 **SUPERSEDE** — the card is rewritten to the new truth; the old value moves to an append-only `## History` as a dated line (`- 2026-03→06: TDI Group`).
- ⏭️ **NOOP** — already known, nothing written.

Facts carry a `confidence:` tag — `EXTRACTED` (you said it) or `INFERRED` (Iva deduced it) — so later answers assert the first and hedge the second. Decisions are the payoff: a decision card holds what you chose, when and why, and its History records every reversal with dates. You always see what is true now, plus the trail of how it got there.

The same pass resolves conflicts flagged in `.graph/supersede-candidates.json` and rewrites CORE.md: durable facts, standing preferences, at most 3 active goals — plus dated behavioral lessons from exchanges you corrected, so a mistake made twice doesn't become a habit.

## Search

`memory_search` runs on Node 24's built-in `node:sqlite`: BM25 over an FTS5 full-text index. Zero external dependencies — no vector database, no search server, nothing extra on a $5 VPS. Hits are reranked by link distance in `.graph/vault-graph.json` — cards that reference each other surface together — and weighted by IDF coverage, so ranking stays language-agnostic: Russian, Uzbek and English all work.

For fuzzy or cross-language semantics, switch on hybrid mode (`MEMORY_SEARCH_MODE=hybrid` plus one embedding key — every variable in [configuration.md](configuration.md)). Dense results are fused with BM25 via reciprocal rank fusion; the nightly doctor rebuilds the embedding sidecar.

## Doctor

At 05:00 `scripts/memory/doctor.ts` runs mechanical maintenance — no LLM, all deterministic — executing the vendored [autograph](https://github.com/smixs/autograph) scripts via `uv`:

1. `enforce` — schema backstop: coerces type aliases, fixes invalid statuses, backfills system fields on cards written outside `write_card`
2. `graph.health` — rebuilds the link graph, appends a 0–100 health score to history
3. `decay` — updates relevance tiers so stale cards sink
4. `moc.generate` — regenerates the MOC topic indexes
5. `supersede`, `dedup`, `link_cleanup` — dry-run scans; findings queue for the next rollup, never auto-applied

Then it commits and pushes the vault. No remote yet? It creates a private `iva-vault` GitHub repo through `gh`. It pings you on Telegram only when a human is needed: a failed maintenance step, a health-score drop, CORE.md past its 1200-char cap, or a failed push (including when there's no remote and `gh` isn't logged in).

## Vault layout

The vault is initialized from `vault-template/` as its own private git repo, separate from the Iva checkout:

```text
vault/
├── CORE.md          # always-on core
├── MOC.md           # topic index, regenerated nightly
├── cards/           # contacts/ projects/ decisions/ ideas/ notes/
├── daily/           # raw transcripts, one per day
├── summaries/daily/ # day summaries
├── weekly/ monthly/ yearly/
├── attachments/     # originals, by date
├── .graph/          # machine-owned graph + scan results
└── .claude/         # format rules + vendored skills
```

Everything is plain markdown. Cards, summaries and CORE.md are safe to edit by hand — `enforce` re-canonicalizes the frontmatter the next night. Leave `MOC.md` and `.graph/` alone (both are regenerated) and treat `daily/` as an append-only log. To browse, open the vault folder in [Obsidian](https://obsidian.md): wikilinks, backlinks and the graph view work as-is.

## Background & prior art

Memory is the part I've worked on longest: first [agent-second-brain](https://github.com/smixs/agent-second-brain), a Telegram-to-Obsidian pipeline; then [autograph](https://github.com/smixs/autograph), the typed-graph schema engine now vendored inside the vault; Iva gathers both. The core idea — keep the verbatim record, compress upward, never lose the trail — follows the [LCM: Lossless Context Management](https://arxiv.org/abs/2605.04050) paper (Ehrlich & Blackman, 2026), with the card graph, SUPERSEDE semantics and doctor loop on top.
