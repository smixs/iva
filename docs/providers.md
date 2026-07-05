# Providers & cost

Iva runs on your server with your keys. Here is every external service it talks to, with real prices: one paid model subscription, one paid box — everything else fits a free tier. Total: about $9/mo.

## Model providers

| Provider | Price | Text models | Vision |
|---|---|---|---|
| **OpenCode Zen Go** | ~$5/mo | `deepseek-v4-pro` (default), `deepseek-v4-flash`, `kimi-k2.7-code`, `glm-5.2`, `qwen3.7` | `gemini-3-flash` |
| **Ollama Cloud** | ~$20/mo | `deepseek-v4-pro` (default) | `gemma3:12b` |

From Iva's side the two are interchangeable:

- 🔌 **OpenAI-compatible** — same wire format on both, so switching is one line in `.env`
- 🌍 **Any IP** — both endpoints answer from any server location, no region blocks
- 💸 **No markup** — you pay the provider directly; Iva adds nothing on top

```bash
MODEL_PROVIDER=opencode   # or ollama, then `iva restart`
```

Start with Zen: a quarter of the price, five models to switch between. Keys, model pick and context-window settings live in [configuration.md](configuration.md).

## Vision

Attachments are never inlined into the model request. A photo lands in the vault, the agent gets its file path, and the provider's own vision model writes the description — OCR plus visual detail — into the daily transcript. Same key as the text model, no extra subscription.

## VPS sizing

Any Ubuntu/Debian box for $4–5/mo. 512MB RAM works — the installer handles low-memory boxes ([install.md](install.md)). More than 1–2GB buys you little: the model runs in the cloud, not on your box.

## Voice — Deepgram

Transcription runs on Deepgram `nova-3` with `language=multi`: Russian, Uzbek and English are detected automatically, even mixed inside one voice note. A new account comes with a free starter credit — no card — that covers months of personal use. The one hard limit is Telegram's, not Deepgram's: the Bot API refuses downloads over 20MB, so a long video won't transcribe.

## Web search

| Provider | Free tier | Card |
|---|---|---|
| **tavily** (recommended) | ~1,000 searches/mo | not required |
| **exa** | ~20,000/mo | not required |
| **parallel** | starter credits | not required |
| **brave** | ~$5/mo credit | required |

Pick one, set `SEARCH_PROVIDER` and its key. No key means no web search — Iva says so instead of guessing. DuckDuckGo scraping was removed on purpose: server IPs get captchas, and a search tool that randomly hits a wall is worse than none.

Optional hybrid memory search adds one more key (Jina or DeepInfra embeddings) — covered in [memory.md](memory.md).

## Total cost

| Service | Monthly |
|---|---|
| VPS | $4–5 |
| OpenCode Zen Go | ~$5 |
| Deepgram voice | $0 — starter credit |
| Web search (tavily) | $0 — free tier |
| **Total** | **~$9/mo** |

Prefer Ollama Cloud and the same stack lands around $25/mo. Either way the bill is flat, predictable, and paid straight to the providers.
