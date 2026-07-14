# Telegram userbot (opt-in)

Iva can read and send from your **personal Telegram account** (a userbot), not just
the bot. It talks to a small proxy — `services/telegram-userbot/serve.py` — that owns
one Telethon session and exposes Telegram over MCP on `127.0.0.1`. Iva connects to it
natively (`agent/connections/telegram-userbot.ts`).

> ⚠️ **At your own risk.** Automating a personal account violates Telegram's ToS and can
> get the account **banned** — especially for sending. Reading is far safer. Iva warns you
> before connecting and enforces anti-ban pacing, but the limits are per-account. Behave
> like a human. See the enforced rules in `agent/skills/telegram-userbot/safety.md`.

## One-time setup

1. **Get API credentials.** Open <https://my.telegram.org> → **API development tools** →
   create an app (any name, platform Desktop). Copy `api_id` and `api_hash`.
2. **Put them in `.env`:**
   ```
   TELEGRAM_API_ID=1234567
   TELEGRAM_API_HASH=abcdef0123456789abcdef0123456789
   ```
3. **Enable the proxy:**
   ```bash
   iva userbot setup
   ```
   This builds the Python venv (`uv`, or `python3 -m venv` as fallback), generates
   `TELEGRAM_MCP_TOKEN`, writes + enables `iva-telegram-userbot.service`, and restarts iva.

## Connect the account (QR, through the bot chat)

Just tell the bot: **«подключи мой телеграм»**. Iva will:
1. Call `qr_login_start` — the proxy renders a QR and sends it as an image straight into
   your bot chat (the login token never leaves the box).
2. Ask you to scan it: in the Telegram app of the account you're connecting →
   **Settings → Devices → Link Desktop Device**.
3. Poll `qr_login_status`. If you have 2FA, it asks for your password (passed to
   `qr_login_password`) — change it afterward if you'd rather it not pass through chat.

The session persists on the server (SQLite file session), so you only do this once.

## Commands

```bash
iva userbot status   # is the proxy running? venv built?
iva userbot setup    # (re)build venv, enable + start the proxy (idempotent)
iva userbot off      # stop and disable the proxy
```

## Safety knobs

- `TELEGRAM_EXPOSED_TOOLS=read-only` in `.env` — the agent can read/search but physically
  cannot send or mutate (the proxy prunes all write tools). Onboarding still works.
- `TELEGRAM_MCP_PORT` (default `8724`), `TELEGRAM_USERBOT_QR_CHAT_ID` (defaults to the first
  of `TELEGRAM_ALLOWED_USER_IDS`).

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
