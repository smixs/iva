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
[⏰ Timers]    [🧩 Skills]
[📊 Status]    [✖ Close]
```

**🧠 Model** and **🤔 Thinking** hand off to the existing `/model` and `/think` wizards, rendered into the same message; a **‹ Menu** button walks you back. Every other sub-screen has a **‹ Back** button; **✖ Close** drops the menu and strips the keyboard.

## What applies when

Most changes take effect the moment you tap. A few reach into the running agent and need a restart, which the menu offers you on the spot — a plain `iva.service` restart that leaves parked conversations intact (never the full agent reset).

| Screen | When it applies |
|---|---|
| 🌐 Language | Instantly — both processes re-read `data/settings.json` every turn |
| 🎭 Character | From Iva's next message — the persona file is read each turn |
| 💾 Memory | From Iva's next message — she distills your answers into `CORE.md` |
| 🧠 Model / 🤔 Thinking | On restart — the wizard offers it |
| 🔍 Search (provider or key) | On restart — the tool reads keys from the environment |

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

## API keys and secrets

Search keys, the userbot's `api_id`/`api_hash`, and the Google OAuth client JSON are all entered **in the chat**, and the intake is built to keep them out of harm's way:

- **Private chat only.** Secret intake is refused in groups — bystanders would see the key and the bot may lack the rights to delete it.
- **Delete first.** The message carrying your key is deleted before anything else happens; if Telegram won't let the bot delete it, you get a warning to remove it yourself.
- **Never leaves the bridge.** The value never reaches the model, the logs, or any error text.
- **Soft validation.** Keys are probed against the provider with a one-result request. A hard rejection (401/403) is refused; a network hiccup is accepted — a real flake shouldn't block you, and a wrong-but-shaped key surfaces later in the tool's own error.

A photo of a key is *not* intercepted — only text. Send secrets as text, in your DM with the bot.

## Search

The **🔍 Search** screen lists the four providers — Tavily, Brave, Exa, Parallel — with a ✓ on the active `SEARCH_PROVIDER` and a 🔑/🔒 badge showing whether its key is present (a boolean; the key itself is never shown). Tap a provider that already has a key and the menu switches `SEARCH_PROVIDER` and offers a restart. Tap one without a key and you drop into key intake, with a link to where the key lives; on success the key and the provider are written together. **🔁 Change key** re-enters the current provider's key. Because `web_search` reads the environment, a provider or key change takes effect on the next `iva.service` restart — which the screen offers. Free tiers and the comparison table: [providers.md](providers.md).

## Userbot

A status card built from `systemctl --user` plus the presence of your Telegram API credentials, then the next step in context:

- **No credentials** → instructions for my.telegram.org and a button to enter `api_id` / `api_hash`.
- **Credentials, not running** → **Enable**, which launches `iva userbot setup` detached (the venv build is slow, so the screen shows a spinner and refreshes when it's done).
- **Running** → a hint to connect by QR — just tell the bot "connect my telegram" — plus **Disable** and **Refresh**.

The userbot is opt-in beta; the full picture, including the anti-ban guardrail: [userbot.md](userbot.md).

## Google Workspace

The **🔗 Google** screen checks for `~/.config/gws/client_secret.json`. Missing, it walks you through console.cloud.google.com — create an OAuth client of type *Desktop app*, download the JSON, paste it into the chat (it's shape-checked and written `0600`). Present, it probes authorization; if you're not signed in yet it shows the exact command to run over SSH — `gws auth login -s gmail,calendar,drive` — with a **Check** button. The headless OAuth sign-in itself is deliberately not automated in this version. What `gws` reaches: Gmail, Calendar, Drive, Sheets, Docs.

## Timers, Skills, Status

Three read-only screens.

- **⏰ Timers** — the `iva-*` (and `xfeed-daily`) systemd timers with their next run, plus the open-task count from `data/tasks.json`.
- **🧩 Skills** — every installed skill with a one-line description, paged.
- **📊 Status** — one card: version, provider · model · thinking, search provider and key badge, language, userbot state, Google, and today's token usage (the same figure as `/usage`). **🔄 Refresh** re-reads everything.

## When it expires

The menu is in-memory state, keyed per user, with a 15-minute idle timeout — an active quiz or interview never expires mid-flight, but an abandoned menu dies. A bridge restart (including a self-`/update`) clears it too. Navigation taps **self-heal**: pressing Back, a page arrow or Refresh on a stale menu re-renders from disk. Taps that carry data (a quiz answer, a provider switch mid-intake) after the state is gone tell you to send `/menu` again. Opening `/menu` a second time replaces the old menu and strips its keyboard, so a dead menu doesn't invite stale taps.
