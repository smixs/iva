# Telegram userbot (opt-in)

Iva can read and send from your **personal Telegram account** (a userbot), not just
the bot. It talks to a small proxy — `services/telegram-userbot/serve.py` — that owns
one Telethon session and exposes Telegram over MCP on `127.0.0.1`. Iva connects to it
natively (`agent/connections/telegram-userbot.ts`).

> ⚠️ **At your own risk.** Automating a personal account violates Telegram's ToS and can
> get the account **banned** — especially for sending. Reading is far safer. Iva warns you
> before connecting and enforces anti-ban pacing, but the limits are per-account. Behave
> like a human. See the enforced rules in `agent/skills/telegram-userbot/safety.md`.

## Connect — just chat with the bot

You never touch a terminal. Tell the bot **«подключи мой телеграм»** and it does everything
for you, in chat:

1. It warns you (at your own risk) and, the first time, walks you through creating an app at
   <https://my.telegram.org> → **API development tools** — you paste the `api_id` / `api_hash`
   back into the chat. The agent provisions the proxy for you (builds its venv, starts the
   service) via its host shell — no restart of iva needed.
2. It renders a QR and sends it as an image into your chat. Scan it in the Telegram app of the
   account you're connecting: **Settings → Devices → Link Desktop Device**.
3. If you have 2FA, it asks for your password (change it afterward if you'd rather it not pass
   through chat). Done — the session persists on the server, so this is one-time.

## Manual commands (optional — the agent runs these for you)

```bash
iva userbot creds    # read api_id + api_hash from stdin → .env (two lines)
iva userbot setup    # build venv, generate the token, enable + start the proxy (idempotent)
iva userbot status   # service running? venv built? token present?
iva userbot off      # stop and disable the proxy
```

## Safety knobs

- `TELEGRAM_EXPOSED_TOOLS=read-only` in `.env` — the agent can read/search but physically
  cannot send or mutate (the proxy prunes all write tools). Onboarding still works.
- `TELEGRAM_MCP_PORT` (default `8724`), `TELEGRAM_USERBOT_QR_CHAT_ID` (defaults to the first
  of `TELEGRAM_ALLOWED_USER_IDS`). The default needs no config. If you set a custom port,
  run `iva userbot setup` (restarts the proxy) **and** `iva restart` (iva reads the port from
  its env at start) so both agree.
- The proxy bearer lives in `data/telegram-userbot.token` (0600), read at runtime by both the
  proxy and iva — so the agent can provision the proxy mid-chat without restarting iva.

## How it works

- **One session owner.** Exactly one process may own a Telethon session; a second opener
  desyncs MTProto. The proxy is that owner; iva calls it over HTTP.
- **Session-less boot.** With no session yet, the proxy comes up unauthorized (onboarding
  mode) and serves only login tools until you scan the QR — then the same live client
  becomes authorized in place, no restart.
- **Enforced anti-ban.** `guardrails.py` wraps the outbound methods (`send_message`,
  `send_file`, `forward_messages`) with FloodWait compliance, randomized pacing, and a
  circuit-breaker (3 FloodWaits in 24h → sending pauses).
- Built on [chigwell/telegram-mcp](https://github.com/chigwell/telegram-mcp) `v3.2.0`
  (116 tools), pinned in `services/telegram-userbot/requirements.txt`.
