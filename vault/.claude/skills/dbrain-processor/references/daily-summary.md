# Daily-summary card spec

The daily-summary is the day's node in the DAG. It is the bridge between the durable
graph (cards) and the raw record (transcript), and the parent-hook for the weekly rollup.

Location: `summaries/daily/YYYY-MM-DD.md` · type: `daily-summary`.

## Required structure

```markdown
---
type: daily-summary
date: YYYY-MM-DD
description: >-
  One-line gist of the day.
tags: [daily, <topic>, <topic>]
status: active
topics: [topic-a, topic-b, topic-c]
source: daily/YYYY-MM-DD.md
---

# YYYY-MM-DD

## Topics
- **Topic A** — one line.
- **Topic B** — one line.

## Highlights
- The few things that actually mattered.

## Cards created today
- [[cards/decisions/2026-06-20-systemd-timers|Use systemd timers for rollups]]
- [[cards/ideas/layered-memory-with-decay|Layered memory with decay]]
- (none)   <!-- if a quiet day -->

## Navigation
- Raw transcript: [[daily/YYYY-MM-DD|Full transcript]]
- Up: [[weekly/YYYY-Www|Week WW]]
```

## MOC contract

The daily-summary must satisfy all four edges so navigation flows
`yearly → monthly → weekly → daily-summary → raw transcript`:

1. **topics** — captured in both `topics:` frontmatter and `## Topics`. These are what
   the weekly/monthly/yearly rollups read to understand the period.
2. **down → cards** — `## Cards created today` links every card created/updated today.
3. **down → raw** — `## Navigation` links `daily/YYYY-MM-DD.md` (the raw transcript).
4. **up → week** — `## Navigation` links `weekly/YYYY-Www.md`. Link it even before the
   weekly file exists; the weekly rollup will add the reciprocal down-link.

## ISO week numbering

`YYYY-Www` uses the ISO-8601 week of `date` (e.g. `2026-W25`). The weekly rollup owns the
weekly file; the daily-summary only needs the correct name to point up.

## Idempotency

If `summaries/daily/YYYY-MM-DD.md` already exists, reconcile: refresh `## Topics`, add any
newly created cards under `## Cards created today`, and leave `## Navigation` intact. Do
not duplicate the file.
