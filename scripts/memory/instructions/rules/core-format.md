---
paths: "CORE.md"
---

# CORE format — always-on memory core (`vault/CORE.md`)

`CORE.md` is the agent's **always-on RAM**: it is injected into the system prompt every single
turn (by `agent/instructions/20-core.ts`). Keep it tiny and high-signal — it is the one memory
file the model never has to search for.

## Hard rules

1. **Char cap ≈ 1200** (~300 tokens). On overflow → **consolidate, never grow**: merge, shorten,
   drop the least useful line. The nightly rollup verifies the resulting file; `doctor.ts`
   deterministically clamps any remaining overflow without touching pointers.
2. **Only durable facts.** Identity, standing preferences, and ≤3 active goals. Anything a web
   search would surface, anything stale within ~7 days, any task state → does NOT belong here.
3. **Who writes it:** the nightly `rollup.ts daily` job (full rewrite from the day + existing CORE),
   plus the live agent on an explicit "remember …" about a durable user fact/preference/goal.
   Never let routine chat edit it.

## MECE routing (what goes where)

| Belongs in CORE.md | Belongs elsewhere |
|--------------------|-------------------|
| Who the user is (name, role, language, how to address them) | A specific event/decision → `cards/decisions/` |
| Standing preferences (tone, format, channels) | Project details/architecture → `cards/projects/` |
| ≤3 active goals (one line each) | A person's details → `cards/contacts/` |
| Pointers (latest daily-summary date, `MOC.md`) | Task to do → `tasks` tool, not the vault |
| — | What happened on a day → `summaries/daily/` |

## Shape

```markdown
# CORE — ядро памяти

## Пользователь
- <name> — <role>, язык <ru/…>, обращаться <как>.

## Предпочтения
- <durable preference, one line>

## Активные цели (≤3)
- <goal>

## Указатели
- Последний день: vault/summaries/daily/YYYY-MM-DD · Оглавление: vault/MOC.md
```

Empty/unknown fields stay as short placeholders until the relationship fills them in. Do not pad.
