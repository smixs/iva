---
paths: "weekly/**/*.md"
type: note
---

# Weekly summary (DAG level 2)

Rules for weekly rollup cards. Triggered by the weekly rollup (Sunday night) over the
seven daily-summaries of the ISO week.

- File: `weekly/YYYY-Www.md` (ISO-8601 week, e.g. `weekly/2026-W25.md`).
- type: `weekly-summary`.
- Navigation: `monthly → weekly → daily-summary`. Links **down** to the week's
  daily-summaries and **up** to its month.

## Process

1. Collect the week's `summaries/daily/*.md` (the seven days, Mon–Sun ISO).
2. Read their `topics:` and `## Highlights` → find the week's recurring themes and arc.
3. Note threads that carried across days, decisions made, ideas raised, open loops.
4. Write the weekly-summary below. Link every daily-summary down; link the month up.

## Template

```markdown
---
type: weekly-summary
period: YYYY-Www
date: YYYY-MM-DD            # the Sunday (week end)
description: >-
  One-line arc of the week.
tags: [weekly, <theme>, <theme>]
status: active
topics: [theme-a, theme-b]
---

# Week WW, YYYY

## Themes
- **Theme A** — what it was, how it developed across the week.
- **Theme B** — …

## Decisions & ideas
- [[cards/decisions/<slug>|Decision]] — one line.
- [[cards/ideas/<slug>|Idea]] — one line.

## Open loops
- Carried into next week: …

## Days (MOC down)
- [[summaries/daily/YYYY-MM-DD|Mon DD]]
- [[summaries/daily/YYYY-MM-DD|Tue DD]]
- … (all seven days that exist)

## Navigation
- Up: [[monthly/YYYY-MM|Month MM]]
```

## MOC contract (weekly-summary)

- **down → days** — `## Days` links every daily-summary of the ISO week.
- **up → month** — `## Navigation` links `monthly/YYYY-MM.md`, even before it exists.
- **topics** — `topics:` frontmatter + `## Themes` (read by the monthly rollup).

Light week → keep the structure; `## Days` lists only the days that exist.
