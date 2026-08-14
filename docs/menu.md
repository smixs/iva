# The settings menu (`/menu`)

`/menu` opens one Telegram message with a nested inline keyboard that gathers **every** Iva setting in one place — model, web search, language, a character test, a memory interview, the personal userbot, Google Workspace, timers, skills and a live status card. It exists because configuring an agent by hand — editing `.env`, running CLI wizards, pasting keys over SSH — is exactly where people get stuck.

The menu lives in the long-poll bridge, not the agent. That has three consequences: it **works while Iva is mid-turn** (out-of-band — nothing is queued behind a running reply), it **costs zero model tokens** (the one exception is the memory interview, which hands your answers to Iva to distill), and deploying a change to it is a bridge restart, not a rebuild. Only user IDs on the allowlist can open it; taps from anyone else are silently dropped. Everything is bilingual (ru/en) and follows the **🌐 Language** button live.

## The map

```
⚙️ Settings
[🧠 Model]     [🤔 Thinking]
[🔍 Search]    [🌐 Language]
[🎭 Character] [💾 Memory]
[📡 Userbot]   [🔗 Google]
[⏰ Timers]    [🔔 Notices]
[🧩 Skills]    [📊 Status]
[🛠 Maintenance]
[✖ Close]
```

**🧠 Model** and **🤔 Thinking** hand off to the existing `/model` and `/think` wizards, rendered into the same message; a **‹ Menu** button walks you back. Every other sub-screen has a **‹ Back** button; **✖ Close** drops the menu and strips the keyboard.

## What applies when

Most changes take effect the moment you tap. A few reach into the running agent and need a restart, which the menu offers you on the spot — a plain `iva.service` restart that leaves parked conversations intact (never the full agent reset).

| Screen                      | When it applies                                                             |
| --------------------------- | --------------------------------------------------------------------------- |
| 🌐 Language                 | Instantly — both processes re-read `data/settings.json` every turn          |
| 🔔 Notices                  | From the next scheduled run — the switch is read as that run starts or ends |
| 🎭 Character                | From Iva's next message — the persona file is read each turn                |
| 💾 Memory                   | From Iva's next message — she distills your answers into `CORE.md`          |
| 🧠 Model / 🤔 Thinking      | On restart — the wizard offers it                                           |
| 🔍 Search (provider or key) | On restart — the tool reads keys from the environment                       |

## Language

[Русский] / [English] writes your choice to `data/settings.json` **and** mirrors it into `AGENT_LANGUAGE` in `.env` (so cron scripts stay consistent), then re-renders the menu immediately in the new language. Both the bridge's service messages and Iva's own replies switch on the fly — the model's reply language and date locale are read fresh every turn, no restart. Details of the variable: [configuration.md](configuration.md#system).

## Character

A short, button-only test that shapes **how Iva talks** — not what she knows. It opens with a warning that this configures Iva's character, then asks 10 statements about the assistant you want ("support me, not just solve the task", "jokes and emojis are welcome", "may write first and remind me", "answers in clear lists"), each answered **yes / rather yes / rather no / no**.

Scoring is deterministic — pure arithmetic, no model call. The answers resolve four axes:

- **Tone** — warm ↔ businesslike
- **Expression** — lively ↔ restrained
- **Initiative** — proactive ↔ on-request
- **Thinking** — structured ↔ figurative

The four letters pick one of **16 fixed, bilingual archetypes** (Big Sister, Muse, Strategist, Analyst, Minimalist Assistant…), shown as a portrait you can **Accept** or **Retake**. Accept writes a compact behaviour profile (≤800 chars, in your current language) to `vault/PERSONA.md`; a dynamic instruction reads that file every turn, so the new character is live from the very next message — no rebuild, no restart.

## Memory (core)

The **💾 Memory** screen shows a short excerpt of your current `CORE.md` and offers a six-question interview: how to address you, what you do, your city/timezone/rhythm, the people and context that matter, your current priorities, and what you never want an assistant to do. Answers are free text; **Skip** and **Finish** are always available.

Your raw answers are archived verbatim to `vault/core-interview.md` (overwritten each run — nothing is ever lost). Then the bridge hands them to Iva as a message from you, asking her to distill them into `vault/CORE.md` (the ≤1,200-char file that rides in every prompt) with her own memory tools, and confirm. This is the one menu action that spends model tokens. How the core compounds: [memory.md](memory.md).

## Notices

Everything Iva sends **on her own** — with no message from you — is a Notice, and there are exactly two kinds. A **Report** is a scheduled summary: the nightly memory report and the morning digest. An **Alert** is trouble that needs your hand: memory that is not being backed up, a nightly pass that failed, a new version to install.

The **🔔 Notices** screen switches the two Reports — _Memory reports_ (nightly, 04:00 and Mon 04:15) and _Morning digest_ (08:00). Both are **off by default**, so a fresh installation says nothing in the morning; the vault is still written and `/digest` still works by hand. A tap writes `data/settings.json`: the report switch is read at the end of each nightly run, the digest switch when its schedule fires — no restart, and a switch flipped tonight applies tonight. Both scheduled turns hand their text to the code that delivers it, so a report arrives as exactly one message ([ADR-0007](adr/0007-notices-are-opt-in.md)).

Alerts — problems and new versions — cannot be switched off, and the screen says so. The price they pay for that: every Alert names what broke, what it costs and the exact command to fix it, and it repeats at most once a week for the same problem — sooner only if the problem changed or came back after a fix. The reasoning: [ADR-0007](adr/0007-notices-are-opt-in.md).

## API keys and secrets

Search keys, the userbot's `api_id`/`api_hash`, and the Google OAuth client JSON are all entered **in the chat**, and the intake is built to keep them out of harm's way:

- **Private chat only.** Secret intake is refused in groups — bystanders would see the key and the bot may lack the rights to delete it.
- **Delete first.** The message carrying your key is deleted before anything else happens; if Telegram won't let the bot delete it, you get a warning to remove it yourself.
- **Never leaves the bridge.** The value never reaches the model, the logs, or any error text.
- **Soft validation.** Keys are probed against the provider with a one-result request. A hard rejection (401/403) is refused; a network hiccup is accepted — a real flake shouldn't block you, and a wrong-but-shaped key surfaces later in the tool's own error.

While a prompt is waiting for a **secret**, nothing you send slips past to the model: a pasted key is captured, and a document or photo is intercepted too (deleted, with a short note on how to send it) — so a secret file like `client_secret.json` can't leak into the vault or the conversation. The Google client secret specifically may be sent as pasted text **or** as the `.json` file (downloaded in the bridge, size-capped, deleted before the download begins). Non-secret prompts (e.g. the memory interview) are unaffected — an attachment there reaches Iva as usual.

## Search

The **🔍 Search** screen lists the four providers — Tavily, Brave, Exa, Parallel — with a ✓ on the active `SEARCH_PROVIDER` and a 🔑/🔒 badge showing whether its key is present (a boolean; the key itself is never shown). Tap a provider that already has a key and the menu switches `SEARCH_PROVIDER` and offers a restart. Tap one without a key and you drop into key intake, with a link to where the key lives; on success the key and the provider are written together. **🔁 Change key** re-enters the current provider's key. Because `web_search` reads the environment, a provider or key change takes effect on the next `iva.service` restart — which the screen offers. Free tiers and the comparison table: [providers.md](providers.md).

## Userbot

A status card built from the shared CLI/Telegram health probe plus the presence of your Telegram API credentials, then the next step in context:

- **No credentials** → instructions for my.telegram.org and a button to enter `api_id` / `api_hash`.
- **Credentials, not running** → **Enable**, which launches `iva userbot setup` detached (the venv build is slow, so the screen shows a spinner and refreshes when it's done).
- **Starting** → a bounded waiting state with **Disable** and **Refresh**.
- **Unreachable** → the service is active but the bearer-gated proxy health route did not answer.
- **Login required** → the existing proxy session is reachable but Telethon is not authorized yet.
- **Ready** → both the proxy and the personal Telegram account are healthy.

Setup failures are shown in the menu instead of collapsing back to an inactive card. The
userbot remains opt-in beta; the full picture, including the anti-ban guardrail:
[userbot.md](userbot.md).

## Google Workspace

The **🔗 Google** screen checks for `~/.config/gws/client_secret.json`. Missing, it walks you through console.cloud.google.com — create an OAuth client of type _Desktop app_, download the JSON, and send it into the chat — paste the contents or attach the `.json` file (it's shape-checked and written `0600`). Present, it probes authorization; if you're not signed in yet it shows a **Connect** button that runs the whole sign-in for you — no SSH. `gws auth login` only supports the loopback flow (it waits for the browser to hit `http://localhost:<port>` on the server), which can't complete from a browser on another machine. So Iva starts `gws` itself, sends you the Google consent link, and when you approve and paste the redirect URL back — the one that lands on a `http://localhost:…` page your browser can't load — it replays that callback against the loopback listener locally, finishing the exchange and storing the token. The pasted URL carries a one-time code, so Iva deletes that message and never logs it, then edits the screen to a final status (connected, or retry). What `gws` reaches: Gmail, Calendar, Tasks, Drive, Sheets, Docs.

## Timers, Skills, Status

Three read-only screens.

- **⏰ Timers** — the `iva-*` (and `xfeed-daily`) systemd timers with their next run, plus the open-task count from `data/tasks.json`.
- **🧩 Skills** — every installed skill with a one-line description, paged.
- **📊 Status** — one card: version, provider · model · thinking, search provider and key badge, language, userbot state, Google, and today's token usage (the same figure as `/usage`). **🔄 Refresh** re-reads everything. Thinking levels are selectable for OpenAI subscriptions and for the OpenAI-compatible Ollama Cloud and OpenCode Go APIs; the latter expose the common `low` / `medium` / `high` contract.

## Maintenance

**🛠 Maintenance** gathers the install's technical commands so none of them need SSH:

- **🩺 Doctor** — `iva doctor`: diagnoses and auto-repairs units, timers, port, `.env`, build.
- **🧹 Vault cleanup** — the streaming cleaner from 0.3.1 (`cleanup.py --apply`): collapses description bloat, never touches card bodies.
- **🌙 Brain (nightly care)** — starts the nightly `iva-brain.service` right now instead of 05:00; it runs as the same systemd unit, so it survives bridge restarts.
- **🔄 Update** — hands off to the existing `/update` flow (check → confirm buttons → an update that survives its own restart).

Every command asks for confirmation, then shows live progress in the same message — an animated loader from the same custom-emoji pack the update flow uses (a swirl for doctor, green for cleanup, an orange spinner for the brain; plain ◇ when the bot owner has no Premium), the current step and elapsed time, with a ✖ Cancel button. One command runs at a time, and doctor/cleanup refuse to start while an update is in progress. The final summary is a single line with numbers (files cleaned and MB freed, ok/warn counts) plus the output tail when something failed.

## When it expires

The menu is in-memory state, keyed per user, with a 15-minute idle timeout — an active quiz or interview never expires mid-flight, but an abandoned menu dies. A bridge restart (including a self-`/update`) clears it too. Navigation taps **self-heal**: pressing Back, a page arrow or Refresh on a stale menu re-renders from disk. Taps that carry data (a quiz answer, a provider switch mid-intake) after the state is gone tell you to send `/menu` again. Opening `/menu` a second time replaces the old menu and strips its keyboard, so a dead menu doesn't invite stale taps.
