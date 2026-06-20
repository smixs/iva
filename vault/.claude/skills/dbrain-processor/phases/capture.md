# Phase 1: CAPTURE

Read the day's transcript and decide what is worth keeping. Output is a plan, not
files yet.

## Input

- `daily/YYYY-MM-DD.md` — the two-sided transcript for the day.
- `.claude/skills/autograph/schema.json` — types and statuses.

## Steps

1. Read the whole transcript top to bottom. Entries are
   `## HH:MM [type]` blocks: user side `[text] [voice] [video] [photo] [forward from: …]`,
   Eva side `[eva]`. Read both sides — Eva's replies often carry the conclusion.
2. Skip any entry already past a `<!-- processed -->` marker.
3. Identify **noteworthy items** (see `references/classification.md`):
   - **entities** — a person, organization, or project that matters beyond today.
   - **decisions** — a choice made, with a reason.
   - **ideas** — a proposal/hypothesis worth revisiting.
   - **notes** — a durable fact, learning, or reference.
4. Identify the day's **topics** — 2–6 short topic labels that describe what the day
   was about (these drive the daily-summary).
5. For each noteworthy item, draft (in your head / scratch):
   - candidate `type` (from schema `node_types`)
   - a one-line description snippet (what/why, not the title)
   - 2–5 kebab-case tags
   - a `status` from that type's enum
   - which existing card it might be (for dedup / update vs. create)

## What is NOT noteworthy

- Small talk, logistics, transient status ("ok", "done", "sending now").
- Anything that is purely a transcript artifact (file-too-large notes, system pings).
- Restating something already captured in an existing card — prefer **update** over a
  new card.

## Output of this phase

A short internal list:

```
topics: [topic-a, topic-b, ...]
items:
  - kind: decision  type: decision  status: active
    desc: "Chose systemd timers over eve cron for rollups — self-host cron unreliable"
    tags: [memory, infra, scheduling]
    existing: cards/decisions/... | none
  - kind: contact   type: contact   status: active
    desc: "..."
    ...
```

Pass this to Phase 2 (PROCESS). Quiet day → empty `items`, but still capture `topics`.
