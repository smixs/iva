# Phase 4: SUMMARIZE

Write the daily-summary card — the day's node in the DAG. Then run the mechanical
autograph pass and mark the transcript processed.

Full template + MOC contract: `references/daily-summary.md` and
`.claude/rules/daily-format.md`.

## 1. Write `summaries/daily/YYYY-MM-DD.md`

```markdown
---
type: daily-summary
date: YYYY-MM-DD
description: >-
  One-line gist of the day — what happened and why it mattered.
tags: [daily, <topic-tag>, <topic-tag>]
status: active
topics: [topic-a, topic-b, topic-c]
source: daily/YYYY-MM-DD.md
---

# YYYY-MM-DD

## Topics
- **Topic A** — one line.
- **Topic B** — one line.

## Highlights
- What actually happened / was decided / was learned.

## Cards created today
<!-- MOC down → the cards from Phase 2/3 -->
- [[cards/decisions/2026-06-20-systemd-timers|Use systemd timers for rollups]]
- [[cards/ideas/layered-memory-with-decay|Layered memory with decay]]

## Navigation
<!-- DAG: down to the raw transcript, up to the week -->
- Raw transcript: [[daily/YYYY-MM-DD|Full transcript]]
- Up: [[weekly/YYYY-Www|Week WW]]
```

### MOC contract (must hold)

- **Down to cards** — every card created/updated today is linked under
  `## Cards created today`.
- **Down to raw** — `## Navigation` links the raw transcript `daily/YYYY-MM-DD.md`.
- **Up to week** — `## Navigation` links the parent `weekly/YYYY-Www.md` (the file the
  weekly rollup will create/maintain). Link it even if it does not exist yet.
- `topics:` frontmatter holds the day's topic labels (also surfaced under `## Topics`).

Quiet day → keep `## Topics` and `## Navigation`; `## Cards created today` may say
`- (none)`.

## 2. Mark the transcript processed

Append to the **end** of `daily/YYYY-MM-DD.md` (never edit existing entries):

```markdown
<!-- processed: YYYY-MM-DDTHH:MM -->
---
processed: YYYY-MM-DDTHH:MM
cards: <N>
summary: summaries/daily/YYYY-MM-DD.md
---
```

## 3. Mechanical autograph pass

From the vault root (dry-run, then `--apply`):

```bash
uv run .claude/skills/autograph/scripts/enforce.py . --apply
uv run .claude/skills/autograph/scripts/graph.py fix . --apply
uv run .claude/skills/autograph/scripts/engine.py touch summaries/daily/YYYY-MM-DD.md
uv run .claude/skills/autograph/scripts/moc.py generate .
uv run .claude/skills/autograph/scripts/engine.py decay .
uv run .claude/skills/autograph/scripts/graph.py health .
```

## 4. Hand back

Return a compact result for the rollup script to report to Telegram: date, topics,
count of cards created/updated, and the health score. The rollup script formats the
Telegram message — this skill only needs to surface the facts.
