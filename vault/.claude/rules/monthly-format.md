---
paths: "monthly/**/*.md"
type: note
---

# Monthly summary (DAG level 3)

Rules for monthly rollup cards. Triggered by the monthly rollup (1st of the month) over
the weekly-summaries of the previous month.

- File: `monthly/YYYY-MM.md` (e.g. `monthly/2026-06.md`).
- type: `monthly-summary`.
- Navigation: `yearly → monthly → weekly`. Links **down** to the month's
  weekly-summaries and **up** to its year.

## Process

1. Collect the month's `weekly/YYYY-Www.md` (the ~4–5 ISO weeks overlapping the month).
2. Read their `topics:` / `## Themes` → find the month's arc, milestones, shifts.
3. Surface decisions and ideas that proved durable across weeks (cite the cards).
4. Write the monthly-summary below. Link every weekly-summary down; link the year up.

## Template

```markdown
---
type: monthly-summary
period: YYYY-MM
date: YYYY-MM-DD            # last day of the month
description: >-
  One-line arc of the month.
tags: [monthly, <theme>, <theme>]
status: active
topics: [theme-a, theme-b]
---

# Month MM, YYYY

## Arc
- How the month developed; the throughline.

## Milestones & decisions
- [[cards/decisions/<slug>|Decision]] — impact.
- [[cards/projects/<slug>|Project]] — status change this month.

## Ideas worth keeping
- [[cards/ideas/<slug>|Idea]] — why it survived the month.

## Weeks (MOC down)
- [[weekly/YYYY-Www|Week WW]]
- [[weekly/YYYY-Www|Week WW]]
- … (all weeks that exist)

## Navigation
- Up: [[yearly/YYYY|Year YYYY]]
```

## MOC contract (monthly-summary)

- **down → weeks** — `## Weeks` links every weekly-summary overlapping the month.
- **up → year** — `## Navigation` links `yearly/YYYY.md`, even before it exists.
- **topics** — `topics:` frontmatter + `## Arc` (read by the yearly rollup).

A week may belong to two months (ISO boundary); link it under the month that contains
its Thursday. Be consistent so each week is the child of exactly one month.
