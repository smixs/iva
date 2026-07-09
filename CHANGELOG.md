# Changelog

## [0.3.0] - 2026-07-09

Feature: Iva now works with Google Workspace out of the box, and picking a model on OpenRouter tells you what actually went wrong.

- 📮 **Google Workspace from chat** — Gmail, Calendar, Drive, Sheets and Docs are now first-class. The installer sets up the [`gws`](https://github.com/googleworkspace/cli) CLI for you (idempotently — a re-run or `iva update` keeps it current), the agent routes any Google task through it with structured JSON, and when it isn't connected yet Iva walks you through registering the key step by step, right in the conversation — no console spelunking on your own.
- 🩹 **OpenRouter errors that tell the truth** — the setup wizard used to reject a perfectly good model with a misleading "needs tool/function calling". It now unwraps the real upstream reason (e.g. "this model isn't available in your region") from OpenRouter's error envelope — handling both string and nested-object shapes — and only mentions function calling when that's genuinely the problem.

[0.3.0]: https://github.com/smixs/iva/releases/tag/v0.3.0

## [0.2.0] - 2026-07-04

Feature: memory that finds things by meaning and keeps facts current, plus deterministic hardening against prompt injection and secret leaks.

- 🧠 **Search by meaning, not the exact word** — recall used to be a raw `grep`: type the wrong synonym or a different word-form and the fact stayed hidden. Memory is now a ranked search — BM25 over your cards and summaries (built in on `node:sqlite`, no dependency, no index to babysit) plus a rerank by the **links between cards**, so asking about a person surfaces the people and projects connected to them. It's language-agnostic by design: term weight comes from your own vault, so it works the same in Russian, English, Chinese, or a mix — no hardcoded word lists.
- ♻️ **Facts that change get rewritten, not stacked** — when today contradicts an old card (you changed jobs, moved city, a decision was reverted), the nightly rollup now **rewrites the current value** and files the old one under a dated `## History`, instead of leaving two contradictory facts for search to trip over. A deterministic nightly pass flags same-entity conflicts; each fact is tagged `EXTRACTED` (you said it) or `INFERRED` (deduced) so Iva can hedge when it's guessing. The longer you use it, the fewer stale contradictions it carries.
- 🔒 **Strictly typed cards** — a new `write_card` path validates type and schema at write time, so the model can't invent a card type or smuggle in stray fields; the nightly maintenance coerces anything written the old way back into schema.
- 🛡️ **Untrusted content is gated** — forwarded messages, attachments, voice transcripts and web pages now pass through deterministic gates before and after the model: hidden prompt-injection (invisible characters, homoglyph tricks, override phrases) is defused on the way in, and API keys, tokens and exfiltration URLs are scrubbed from replies on the way out. Legitimate non-Latin text is never mangled — normalization is used only to detect, never to rewrite what you wrote.
- 🔌 **Optional semantic search** — for a large vault or genuinely fuzzy/cross-language queries, an opt-in hybrid mode adds vector search fused with the keyword ranking (RRF). One external key (Jina — no-train/EU, or DeepInfra — cheapest), or point it at a local Ollama endpoint and use no external key at all. Off by default; the installer asks once. Base memory needs nothing.

[0.2.0]: https://github.com/smixs/iva/releases/tag/v0.2.0

## [0.1.7] - 2026-06-29

Feature: Iva sees images, takes any attachment, and learns your corrections — plus the stability fixes that make all of it reliable.

- 👁️ **Iva sees images** — the main model (DeepSeek) is text-only, so an incoming picture used to be saved but never understood. Now every still image (photo, sticker, image document) is described by the provider's own vision model on the **same key** — `gemma3:12b` on Ollama, `gemini-3-flash` on OpenCode — with OCR of any text in the frame. The description is written into the day's memory and handed to the main model, so Iva answers by what's actually in the image. No extra subscription, no config; without a key the turn just continues without vision.
- 📎 **Any attachment, never a crash** — forwarding a photo or file used to kill the whole turn (Telegram serves files as `application/octet-stream`, which failed the upload policy with a fatal throw). Now every attachment type — photos, stickers, voice, video, and documents of any format — reaches the handler, and the model is always handed a **file path** rather than an inlined blob. Provider-agnostic and crash-proof: a bad media type can no longer take down the conversation.
- 🧠 **Learns your corrections** — the nightly rollup now scans the day for repeatable "do it this way" lessons and records them into CORE, which is read on every turn. A correction you make today is followed tomorrow — a procedural-memory loop with no new moving parts.
- 🌍 **English-first terminal** — the CLI (`iva update/doctor/status/config`) and every background job (poll bridge, memory rollup/doctor, daily digest) now print in English instead of mixed Russian. The installer stays bilingual and asks your language once.
- 🌳 **A new tree** — the ANSI willow is now a compact relay tree that shimmers in place while idle.

Stability — the fixes that make images and attachments dependable:

- 🩹 **A poisoned chat can't go silent anymore** — a malformed reasoning part from the provider could fail the model-message schema and wedge a whole thread until a manual restart. Reasoning is now stripped from the model's output before it's stored, so it can't poison the history; and deterministic errors (bad prompt, unknown tool) park the turn cleanly instead of burning three pointless retries.
- 🩹 **Attachments stop crashing the sandbox** — Iva now pins the lightweight `just-bash` sandbox (eve used to auto-pick Docker on any host with a daemon and then fail to provision it) and starts via `eve start`, so the sandbox template is actually built on every boot. Staging an image or file no longer throws.
- 🩹 **Updates survive a rewritten history** — `iva update` and the installer used `git pull --ff-only`, which aborted whenever `main` was force-pushed. They now fast-forward when possible and hard-reset to the remote on divergence, preserving your `.env` and vault.
- 🩹 **Vault wires itself** — `iva doctor` now creates the private `iva-vault` repo over `gh` itself instead of nagging every night, and only warns when `gh` is genuinely unavailable.

[0.1.7]: https://github.com/smixs/iva/releases/tag/v0.1.7

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
