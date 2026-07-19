# Deploy

Iva runs on one VPS as two systemd user services and five timers. `install.sh` sets all of it up ([install](./install.md)); this page is what's actually running and how to operate it.

## Transport: long polling

Telegram never connects to your server. `scripts/telegram-poll.mjs` long-polls `getUpdates` and POSTs each update to the local eve webhook (`http://127.0.0.1:8723/eve/v1/telegram`) with the shared `X-Telegram-Bot-Api-Secret-Token` header. Telegram sees an ordinary bot; the channel code is unchanged. No public HTTPS, no domain, no reverse proxy.

The bridge also gives you:

- 📬 **Ordered delivery** — advances the offset (`data/telegram-offset.json`) only after eve replies 2xx, retrying with backoff up to 15s while the server boots.
- ⏱ **Per-chat pacing** — a 1.5s pause between updates to the same chat, so a burst can't start two runs on one session.
- 🛟 **Out-of-band recovery** — a handful of slash commands (`/restart` and friends) are handled by the bridge itself, so they work even when the agent is stuck. Which ones, and what they do: [cli.md](./cli.md).

### Webhook mode (alternative)

Polling and webhook are mutually exclusive — the bridge calls `deleteWebhook` on start. If you do have a public HTTPS endpoint, disable the bridge and register the webhook:

```bash
systemctl --user disable --now iva-telegram-poll
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<your-domain>/eve/v1/telegram",
       "secret_token":"'"$TELEGRAM_WEBHOOK_SECRET_TOKEN"'",
       "allowed_updates":["message","callback_query"]}'
```

Note: `getUpdates` — which the setup wizard uses to discover your user ID — stops working while a webhook is registered.

## systemd units

`bin/iva.mjs` is the single source of truth for every unit. Any restart through the `iva` CLI regenerates them first, so `Environment=PORT` always matches `IVA_PORT` in `.env`. Don't hand-edit `~/.config/systemd/user/iva-*` — edits get overwritten. If you write your own unit instead, bake the port literally (`Environment=PORT=8723`): systemd will not expand `$IVA_PORT` from an `EnvironmentFile`.

| Unit | When | Job |
|------|------|-----|
| `iva.service` | always | the agent (`eve start`), `Restart=always` |
| `iva-telegram-poll.service` | always | the long-polling bridge |
| `iva-telegram-userbot.service` | opt-in (`iva userbot setup`) | Telethon userbot MCP proxy — see [userbot.md](userbot.md) |
| `iva-memory-daily.timer` | 04:00 nightly | transcript → cards + daily summary, report to Telegram |
| `iva-memory-weekly.timer` | Sun 04:15 | 7 dailies → weekly summary, report to Telegram |
| `iva-memory-monthly.timer` | 1st, 04:20 | weeklies → monthly summary (silent) |
| `iva-memory-yearly.timer` | Jan 1, 04:25 | monthlies → yearly summary (silent) |
| `iva-memory-doctor.timer` | 05:00 nightly | schema/health/decay/MOC checks + vault `git push` |
| `iva-update-check.timer` | 10:00 daily | check for a newer stable Iva version; notify once per version |

Timers fire in the server's **local time** and carry `Persistent=true`, so a run missed during downtime fires after reboot. Set the server clock to match your `.env`:

```bash
sudo timedatectl set-timezone "$ASSISTANT_TIMEZONE"
```

Manual runs and status:

```bash
npm run memory -- daily   # or weekly | monthly | yearly
npm run doctor
systemctl --user list-timers
iva logs                  # agent; `iva logs poll` for the bridge
```

The update check fetches the configured Git upstream without calling the model. It stays silent when the installed stable version is current, when the same version was already offered, or when Telegram is not configured. A newer `MAJOR.MINOR.PATCH` release produces one message in `TELEGRAM_DIGEST_CHAT_ID` (falling back to the first trusted user) with **Update** and **Later** buttons. Errors are journal-only and retry on the next timer run.

Full CLI reference: [cli](./cli.md). What the rollups actually write: [memory](./memory.md).

One thing that trips people up: eve has a `defineSchedule` API, but on self-host it never fires — it only becomes a cron job on Vercel. That is the whole reason memory runs on systemd timers.

## nginx and TLS

You need neither for Telegram — polling is outbound-only. Add an nginx reverse proxy with Let's Encrypt only if you expose the eve HTTP channel (or webhook mode) to the internet.

## Moving servers

Your state is three things: the vault (its own git repo, pushed nightly by the doctor), `.env` (all keys), and `data/` (`tasks.json`, `usage.jsonl`).

1. Old box: `npm run doctor` to push the vault, then copy `.env` and `data/` off.
2. New box: run the installer ([install](./install.md)) with `--skip-setup`, drop in `.env`.
3. Clone the vault back — `gh repo clone <user>/iva-vault <vault-dir>` — restore `data/`, then `iva restart`.

If all you have left is the vault repo, you lose open tasks and token history. Memory survives intact.

## Vercel (advanced)

Iva is built on eve, which deploys to Vercel natively — but self-host is the intended path. If you go there anyway:

- **Schedules** — `defineSchedule` in `agent/schedules/*.ts` becomes a real Vercel Cron Job (cron times are UTC there).
- **Storage** — `./data` is ephemeral on Vercel; tasks and usage logs need a real DB or KV store.
- **Auth** — the scaffold eve channel ships `localDev()` + `placeholderAuth()`. In prod, `localDev` is ignored and `placeholderAuth` admits nobody. Wire a real auth provider, or for a single-user deployment issue a bearer token and pass it to your scripts as `ASSISTANT_BEARER`.
