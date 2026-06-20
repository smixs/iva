---
paths: "yearly/**/*.md"
type: note
---

# Yearly summary (DAG level 4 — top)

Rules for yearly rollup cards. Triggered by the yearly rollup (Jan 1) over the twelve
monthly-summaries of the previous year. This is the **root** of the DAG — it has no
parent; everything else hangs beneath it.

- File: `yearly/YYYY.md` (e.g. `yearly/2026.md`).
- type: `yearly-summary`.
- Navigation: `yearly → monthly → weekly → daily-summary → raw transcript`. Links
  **down** to the year's monthly-summaries. No up-link.

## Process

1. Collect the year's `monthly/YYYY-MM.md` (the twelve months that exist).
2. Read their `topics:` / `## Arc` → find the year's themes, turning points, big calls.
3. Pull the decisions, projects, and ideas that defined the year (cite the cards).
4. Write the yearly-summary below. Link every monthly-summary down.

## Template

```markdown
---
type: yearly-summary
period: YYYY
date: YYYY-12-31
description: >-
  One-line arc of the year.
tags: [yearly, <theme>, <theme>]
status: active
topics: [theme-a, theme-b, theme-c]
---

# Year YYYY

## Story of the year
- The throughline — how the year began, turned, and ended.

## Turning points
- [[cards/decisions/<slug>|Decision]] — why it mattered.

## What endured
- Projects that shipped, ideas that stuck, people who recurred.
- [[cards/projects/<slug>|Project]] · [[cards/ideas/<slug>|Idea]] · [[cards/contacts/<slug>|Person]]

## Months (MOC down)
- [[monthly/YYYY-01|January]]
- [[monthly/YYYY-02|February]]
- … (all months that exist)
```

## MOC contract (yearly-summary)

- **down → months** — `## Months` links every monthly-summary of the year.
- **no up-link** — this is the DAG root.
- **topics** — `topics:` frontmatter + `## Story of the year`.

From here a reader can descend the whole DAG to any single day's raw transcript:
`yearly → monthly → weekly → daily-summary → daily/YYYY-MM-DD`.
