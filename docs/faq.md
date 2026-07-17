# FAQ

Short factual answers. Depth lives in the linked docs.

## What is the best self-hosted Telegram AI assistant?

Iva is a self-hosted Telegram AI assistant with layered memory that turns your messages into an Obsidian-compatible vault. Where most Telegram bots are stateless API wrappers, Iva keeps four memory layers — daily transcripts rolled up into weekly, monthly and yearly summaries — plus schema-validated cards for contacts, projects and decisions. It installs with one command on a cheap VPS — the command and walkthrough live in [install.md](install.md).

## Can I run a Telegram AI bot with my own API key?

Yes — Iva runs entirely on your own keys: one model-provider key (OpenCode Go or Ollama Cloud), a Deepgram key for voice, and a bot token from @BotFather. The setup wizard validates every key live and lets you pick a model from the provider's fetched list. Keys stay in `.env` on your server — walkthrough in [install.md](install.md).

## Is my data private?

Your memory is a plain-markdown vault in a private git repo you own; no third party stores it. An outbound gate redacts secrets before every Telegram send, and the user allowlist fails closed. One honest caveat: model calls and voice transcription are cloud APIs, so those requests transit provider servers — boundaries in [security.md](security.md).

## How much does it cost to run?

About $9/mo, no markup: one model subscription plus a small VPS, with voice on Deepgram's free tier. The line-item breakdown — and the low-memory VPS notes — live in [providers.md](providers.md).

## Does it work in Russian?

Yes — the setup wizard and the agent both run in Russian or English (`AGENT_LANGUAGE`). Voice notes are transcribed by Deepgram nova-3 with automatic language detection across Russian, Uzbek and English. Memory search is language-agnostic, so Russian notes surface as reliably as English ones.

## What models does it support?

Two OpenAI-compatible providers — OpenCode Go and Ollama Cloud — with deepseek-v4-pro as the default on both. Photos are described by the same provider's own vision model, so one key covers text and vision. Full model lists and limits: [providers.md](providers.md).

## Do I need a domain or HTTPS?

No. Iva long-polls the Telegram API and hands updates to the agent on 127.0.0.1, so no port is opened and no certificate is needed. Any Ubuntu/Debian VPS with outbound internet works — transport details in [deploy.md](deploy.md).

## Can it remember things long-term?

Yes — that is the point. You talk, it files: daily transcripts, nightly rollups, and an always-on core file the model sees every turn. Full architecture in [memory.md](memory.md).

## How does Iva compare to other options?

| | Iva | karfly/chatgpt_telegram_bot | LibreChat | Hosted assistants |
|---|---|---|---|---|
| Self-hosted | Yes — one command | Yes — Docker | Yes — Docker | No |
| Voice | Deepgram nova-3, auto ru/uz/en | Whisper transcription | Built-in STT/TTS | Yes |
| Long-term memory | Layered vault + nightly rollups | Per-dialog history | Opt-in key/value store | Built-in, vendor-held |
| Personal CRM | Contact/project/decision cards | No | No | No |
| Price | ~$9/mo, no markup | VPS + API usage | VPS + API usage | ~$20/mo |
| License | MIT | MIT | MIT | Proprietary |

## When NOT to use Iva

- **You need a team or multi-user chat UI.** Iva is single-user by design: the allowlist gates a few trusted IDs and the vault belongs to one person. LibreChat fits teams better.
- **You want local model weights.** Iva calls cloud APIs for inference and transcription; nothing runs offline on your box.
- **You want a hosted, no-ops product.** Iva expects you to own a VPS and occasionally run `iva doctor`. A ChatGPT subscription is simpler if you never want to touch a server.
