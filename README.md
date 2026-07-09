**English** · [Русский](./README.ru.md)

<div align="center">

<img src="assets/iva-header.webp" alt="Iva — self-hosted Telegram AI assistant with layered memory" width="100%">

**Your assistant. Your server. Your memory.**

[![Release](https://img.shields.io/github/v/release/smixs/iva?color=brightgreen)](https://github.com/smixs/iva/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/smixs/iva?style=social)](https://github.com/smixs/iva/stargazers)
[![built on eve](https://img.shields.io/badge/built%20on-eve-000000?logo=vercel&logoColor=white)](https://eve.dev/docs/introduction)
[![Node 24](https://img.shields.io/badge/node-24.x-339933?logo=node.js&logoColor=white)](https://nodejs.org)

[Features](#features) · [Quick start](#quick-start) · [Memory](#memory--the-part-that-compounds) · [Docs](#documentation)

</div>

---

Iva is a self-hosted Telegram AI assistant with layered memory that turns your messages into an Obsidian-compatible vault. You talk, it files: voice notes, photos, forwarded posts and decisions become plain-markdown cards it actually remembers. Everything runs on your own server, with your keys and your data. One command installs it:

```bash
curl -fsSL https://raw.githubusercontent.com/smixs/iva/main/install.sh | bash
```

## Features

- 🎙️ **Voice** — voice, audio and video notes transcribed with Deepgram nova-3; auto-detects ru/uz/en.
- 👁️ **Vision** — photos described by your provider's own vision model; no extra key, no extra bill.
- 🧠 **Layered memory** — remembers across months, not just the current chat window.
- 📇 **Personal CRM** — who your people are, what you agreed, when to follow up.
- 🔎 **Search by meaning** — BM25 plus link-graph rerank, any language; optional vector mode with one key.
- 🧭 **Decision cards** — what you chose, when and why; old versions stay in a dated History.
- ⏰ **Tasks & reminders** — priorities, due dates and a morning digest.
- 🌐 **Web search** — four pluggable providers: Tavily, Exa, Parallel or Brave.
- 📮 **Google Workspace** — Gmail, Calendar, Drive, Sheets and Docs from chat via the `gws` CLI; installed for you, with a guided key setup right in the conversation.
- 🧩 **Skills & MCP** — drop one file to add a procedure or connect an MCP server; keys stay in `.env`.
- 🛡️ **Safe to forward** — links, PDFs and other people's messages are screened before the model reads them.
- 📊 **Token accounting** — every model step is logged; `/usage` reports it for free.

## Memory — the part that compounds

<img src="assets/iva-memory-tree.webp" alt="Iva's memory tree: daily transcripts fold into weekly, monthly and yearly summaries around a CORE.md trunk" width="100%">

- Every message lands verbatim in a daily markdown log — nothing is paraphrased on arrival.
- A nightly rollup at 04:00 distills day → week → month → year into schema-validated cards; facts that change get rewritten, not piled up.
- One core file, `CORE.md` (≤1,200 chars), rides in every prompt — Iva knows you before it searches anything.

Full architecture and search internals: [docs/memory.md](docs/memory.md).

## Quick start

1. Get a bot token from [@BotFather](https://t.me/BotFather).
2. Run the one-line installer above on any Ubuntu/Debian box — a fresh VPS or your own machine.
3. Message your bot. The wizard picks your Telegram ID out of that message, finishes setup, and Iva confirms right in the chat that it's live.

Headless installs take `--skip-setup` or `--non-interactive`. Wizard walkthrough and an SSH primer for first-time VPS owners: [docs/install.md](docs/install.md).

## How it works

<img src="assets/iva-flow.webp" alt="Dataflow: Telegram to long-poll bridge to security gate to agent to vault, with a nightly rollup and doctor loop" width="100%">

The bridge long-polls Telegram, so no public HTTPS, domain or webhook is needed. The agent, the bridge and five memory timers run as systemd user units on your box — operations live in [docs/deploy.md](docs/deploy.md).

## Providers & cost

Four model providers. Pick one and fill its block in `.env`:

| Provider | How you pay |
|---|---|
| OpenCode Zen | API key, ~$5/mo |
| Ollama Cloud | API key, ~$20/mo |
| OpenRouter | API key, pay-as-you-go, 300+ models |
| OpenAI (ChatGPT) | your Plus/Pro subscription, no API key |

Default model is deepseek-v4-pro, 131k context. On Zen it runs about $9/mo all-in ($5 model + $4–5 VPS), no markup; voice rides Deepgram's free starter credit. Model lists, limits and the search matrix: [docs/providers.md](docs/providers.md).

## Security & privacy

<img src="assets/iva-security-gate.webp" alt="Inbound sanitizer and outbound redaction gates around the agent" width="100%">

Inbound content passes a prompt-injection sanitizer, every reply passes a secret-redaction gate, and the user allowlist fails closed — an empty list answers nobody. Your memory is a private git repo you own; the honest boundary is that the model and transcription are cloud APIs you choose and pay for. Gate internals: [docs/security.md](docs/security.md).

## Commands

| In Telegram | On the server |
|---|---|
| `/help` · `/task` · `/digest` · `/new` · `/usage` | `iva status` · `iva update` · `iva doctor` · `iva logs` |

Full reference, including `/usage` breakdowns by model and by source: [docs/cli.md](docs/cli.md).

## Documentation

[Install](docs/install.md) · [Configuration](docs/configuration.md) · [Memory](docs/memory.md) · [Providers](docs/providers.md) · [Security](docs/security.md) · [Deploy](docs/deploy.md) · [CLI](docs/cli.md) · [Extending](docs/extending.md) · [FAQ](docs/faq.md) · [Troubleshooting](docs/troubleshooting.md)

Документация на русском → [docs/ru/](docs/ru/)

## Built on

[eve](https://eve.dev/docs/introduction), Vercel's agent framework, runs the agent; Node 24's built-in SQLite runs the search index — no separate database. Iva grew out of [agent-second-brain](https://github.com/smixs/agent-second-brain) and [autograph](https://github.com/smixs/autograph) — that story is in [docs/memory.md](docs/memory.md).

## License

[MIT](LICENSE) — take it, change it, run it on a hundred servers; just don't blame anyone if something breaks.
