# Changelog

## [0.1.6] - 2026-06-24

Patch: usage reports in English.

- 🌍 **English `/usage` output** — `/usage` and `iva usage` now report in English (`in` / `out` / `cached`, plus window and source labels), matching the project's English-first surface. The source label also normalizes the raw channel kind (e.g. `channel:telegram` → `chat`).

[0.1.6]: https://github.com/smixs/iva/releases/tag/v0.1.6

## [0.1.5] - 2026-06-24

Feature: local token-usage accounting (issue #7).

- 📊 **See where your tokens go** — every model call now logs its real usage (input/output/cache tokens, model, source) to a plain local `data/usage.jsonl`. No dashboard, no SaaS meter, no external billing — just a file you can grep, diff, and back up. A single agent hook captures everything that spends tokens through Iva: foreground chat, the morning digest, and the nightly memory rollups, plus the `planner` subagent — with no double counting.
- 💬 **`/usage` in Telegram** — `/usage last` (the last turn), `/usage today`, `/usage week`, `/usage month`, `/usage by-model`, `/usage by-source`. The command is handled out-of-band by the poll bridge, so it costs zero tokens and works even while the agent is busy. Source attribution separates interactive chat from background jobs.
- 🖥️ **`iva usage` in the terminal** — the same summaries over the same log (`iva usage today`, `iva usage by-model`, `iva usage tail` for raw lines), for watching a VPS from the shell.
- Tokens only for now — Ollama/OpenCode are flat-rate subscriptions, so a fabricated dollar figure would mislead. Budget guardrails and a large-context heads-up are deferred to a later release.

[0.1.5]: https://github.com/smixs/iva/releases/tag/v0.1.5

## [0.1.4] - 2026-06-24

Patch: model switching no longer mutes the bot, and a real reset for stuck background work.

- 🔇 **Reconfigure no longer mutes the bot** — running `iva config` while Iva is up used to see Iva's own port as "busy" and move it (`8723 → 8724`), but `ASSISTANT_HOST` stayed on the old port. The poll bridge then talked to a port nobody listened on and the bot went silent. Now the current port is kept (it's Iva itself), and `ASSISTANT_HOST` always follows `IVA_PORT` for local setups — the server and its clients can't drift apart.
- ♻️ **`iva reset` and a real `/restart`** — a stuck or bloated turn lived in `.workflow-data`, which eve re-enqueues on every startup, so `iva restart` (and even a reboot) brought it right back. New `iva reset` stops the services, clears `.workflow-data`, and restarts; the Telegram `/restart` `/new` `/clear` `/compact` commands now do the same. This is the "reset that finally sticks."
- 🧠 **Honest about reminders** — Iva no longer improvises background `nohup sleep`/`curl` timers (the thing that ballooned `.workflow-data` and pegged the CPU). It has no push/scheduler, says so plainly, and stores "remind me later" requests as tasks instead.
- 📝 **Correct way to switch models** — the model is read from `.env` at process start, so a chat-time change applies only after `iva restart`; Iva now explains this instead of silently self-restarting mid-turn.

[0.1.4]: https://github.com/smixs/iva/releases/tag/v0.1.4

## [0.1.3] - 2026-06-22

Patch: Telegram formatting, an English-first installer, low-end VPS support, and the OpenCode model fix.

- 💬 **Telegram formatting everywhere** — a single hardened markdown → Telegram-HTML converter now handles EVERY message: chat replies, nightly reports, the morning digest. Cron reports used to arrive as raw `**text**` with `---` and backticks. The converter never throws on any input and always emits valid HTML (balanced tags, escaping, rich formatting per the Telegram docs); on a Telegram rejection it self-heals without losing the message and without loops.
- 🌍 **Bilingual installer** — language is the very first question (English by default), and all of `install.sh` prints in the chosen language. The choice flows into the agent and the vault, so it's asked only once.
- 💾 **Auto-swap for low-end VPS** — on a box with <1.5 GB RAM and no swap, `eve build` was OOM-killed (exit 137, "Killed"). The installer now creates a 2 GB swapfile before building (idempotent, with a disk-space check). Iva installs even on a $4 DigitalOcean droplet (512 MB).
- 🤖 **OpenCode Go model fix** — Iva sent the model ID with the `opencode-go/` prefix and the endpoint replied "Model … is not supported". It now sends the bare ID (`deepseek-v4-pro`); existing `.env` files with the prefix are fixed automatically after `iva update`.
- 🌳 **Tree on update** — `iva update` shows the same ANSI willow as the install.

[0.1.3]: https://github.com/smixs/iva/releases/tag/v0.1.3

## [0.1.2] - 2026-06-21

Patch: reliable startup and web search.

- 🔌 **Your own port** — the server runs on a configurable `IVA_PORT` (default `8723`) instead of the commonly-taken `3000`. The bot no longer goes silent over a port conflict; old installs migrate automatically on `iva update`.
- 🔎 **Web search with a provider picker** — Tavily / Exa / Parallel / Brave, chosen at install (or `iva config`), one key per provider. DuckDuckGo was dropped — it served a captcha from server IPs.
- 🩺 **Diagnostics** — `iva doctor` checks the port and the active search key; a preflight port-availability check during setup.
- 🧹 **Green typecheck** — fixed `parse_mode` in the Telegram channel.

[0.1.2]: https://github.com/smixs/iva/releases/tag/v0.1.2

## [0.1.0] - 2026-06-20

First release. A personal AI agent with memory in Telegram, set up with a single command.

- 🎙️ Voice and video — transcribes speech in any language
- 🧠 Tree-shaped memory (day, week, month, year) — tidies itself up at night
- 🔎 Fast search over memory
- 🤖 Choice of model — which AI runs inside (OpenCode Go from $5/mo or Ollama Cloud, DeepSeek recommended)
- 🧩 Skills and connections via MCP
- 🎛️ Telegram commands: `/help` `/task` `/tasks` `/digest` `/new` `/restart`
- 🔒 Replies only to you, memory stays with you
- 🎭 Personality changes right in the conversation

[0.1.0]: https://github.com/smixs/iva/releases/tag/v0.1.0
