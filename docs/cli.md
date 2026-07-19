# Command reference

Iva has two control surfaces: slash commands in Telegram and the `iva` command on your server. This page is all of them.

## Telegram commands

| Command | What it does |
|---|---|
| `/help` | This list |
| `/task <text>` | Add a task; without text, Iva asks what to add |
| `/tasks` | Show the task list |
| `/digest` | Morning digest built by the morning-digest skill |
| `/new` | Start over — reset the current conversation |
| `/restart` | Restart the agent when it's stuck |
| `/clear` | Same reset as `/new` (`/compact` remains as a legacy alias) |
| `/update` | Check for a new version; if there is one, tap **Update** to install it |
| `/usage [window]` | Token spend — variants below |

Two kinds here. `/task`, `/tasks` and `/digest` route into the agent and need it running. `/help`, `/usage`, `/restart`, `/new`, `/clear`, the legacy `/compact` alias and `/update` never reach the agent — the long-poll bridge handles them itself, out-of-band. Reset commands leave one status message, stop `iva.service`, wipe `.workflow-data` (where eve re-enqueues stuck runs on every startup), and start fresh. So recovery works at the exact moment you need it: when the agent is wedged mid-turn. The bridge only obeys user IDs on the allowlist.

`/update` compares your install with the upstream repo. If a newer version exists, the same message gets **⬆️ Update** and **Later** buttons. After confirmation, four compact messages show preservation, fetch, build and the final result. The active message animates by editing in place; build logs, diffs and commit IDs stay on the server. The detached updater survives the bridge restart. Nothing happens until you tap.

Independently, `iva-update-check.timer` checks upstream every day at 10:00 local time. It calls no model and says nothing unless a higher stable version exists. Each version is offered once in the digest chat with the same buttons; **Later** closes that offer, while manual `/update` always remains available.

### /usage variants

| Variant | Window |
|---|---|
| `/usage` or `/usage last` | The last turn: tokens, steps, model, source |
| `/usage today` | Current day in your timezone |
| `/usage week` | Last 7 days |
| `/usage month` | Current calendar month |
| `/usage by-model` | Lifetime totals per model |
| `/usage by-source` | Lifetime, chat vs background (rollups, digest) |

`/usage` costs zero tokens — the bridge reads the log, no model call.

## Server CLI

The installer puts `iva` in `~/.local/bin`. Commands that touch systemd need a Linux server.

| Command | What it does |
|---|---|
| `iva update [--force] [--verbose]` | Preserve tracked and untracked changes, safely fast-forward or rebase local commits, build, restart and health-check. On failure Iva rolls back to the recorded HEAD and previous `.output`. `--force` rebuilds with no new commits; `--verbose` streams technical output otherwise kept in `data/logs/` |
| `iva config` | The 5-step setup wizard, then offers a restart to apply |
| `iva login [--browser]` | Sign in to an OpenAI (ChatGPT) subscription for `MODEL_PROVIDER=codex`. Default is device code (a link + one-time code, works on a headless VPS); `--browser` runs the local PKCE flow. Token → `data/codex-auth.json` (chmod 600) |
| `iva doctor` | Checks Node ≥ 24, `.env` keys, build, units, both services, 5 memory timers, vault git origin — auto-repairs what's safe |
| `iva status` | Status of both services + the memory-timer schedule |
| `iva restart` | Regenerates units (keeps the port in sync with `IVA_PORT`), restarts agent + bridge |
| `iva reset` | Stop, wipe `.workflow-data`, restart — cures stuck turns that a plain restart brings right back |
| `iva usage [window]` | Same windows as `/usage`, plus `tail [N]` — the last N raw log lines (default 10) |
| `iva start` / `iva stop` | Start both services and enable at boot / stop them |
| `iva logs [poll]` | Follow agent logs, last 50 lines; `poll` follows the Telegram bridge instead |
| `iva uninstall [--purge]` | Remove units and the `iva` command; `--purge` also deletes code and vault, after a second confirmation |
| `iva version` | Package version + git commit |
| `iva tree` | The willow, animated |

```bash
iva usage week      # 7-day totals, by source and model
iva usage tail 20   # last 20 raw log lines
```

## Token accounting

Every model step appends one JSON line to `data/usage.jsonl` — including tool-call rounds, which is where most tokens actually go. What each line carries:

- 📍 **Source** — `telegram` chat vs `http` background jobs, so rollups and digests don't hide inside your chat totals
- 🧮 **Five counters** — in, out, cache read, cache write, total — plus model, session, turn and step index
- 🤖 **Subagent steps** — planner tokens are tagged with the subagent name and counted, not lost

The log lives in `data/` next to `tasks.json`, gitignored and outside the vault — otherwise the nightly doctor would commit an ever-growing log into your memory repo.

No dollar figures, on purpose. Both providers are flat-rate subscriptions (see [providers.md](providers.md)), so there is no per-token price to multiply. Tokens are the number you can trust; a computed dollar estimate would be fiction.
