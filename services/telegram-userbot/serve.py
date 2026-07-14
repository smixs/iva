#!/usr/bin/env python3
"""
Persistent HTTP proxy that owns ONE Telethon userbot session and exposes the
upstream chigwell/telegram-mcp tools over MCP streamable-HTTP for the iva agent.

Why this exists (hard-won lesson, do not "simplify" away):
- Exactly ONE process may own a given Telethon session. A second opener desyncs
  the MTProto session and crashes Telethon with TypeNotFoundError. So this proxy
  is the sole session owner; iva reaches it on demand over HTTP.

Design:
- Session-less boot. If no saved session exists yet, we seed an EMPTY StringSession
  so upstream's `_discover_accounts()` builds an unauthorized-but-connectable client
  instead of `sys.exit(1)`. The QR-login tools (Phase 1, onboarding.py) authorize
  that SAME live client in place, then persist the real session — no restart, no
  hot-swap of a different client.
- Bearer auth + bind 127.0.0.1 (single box; defense-in-depth on top of localhost).
- receive_updates defaults to True upstream, so Telethon's own loop auto-reconnects;
  we add a cheap EnsureConnected middleware as belt-and-suspenders.

Env:
  TELEGRAM_MCP_HOST   bind address        (default 127.0.0.1)
  TELEGRAM_MCP_PORT   bind port           (default 8724)
  TELEGRAM_MCP_TOKEN  bearer secret; every request must send `Authorization: Bearer <token>`
  TELEGRAM_API_ID / TELEGRAM_API_HASH     from my.telegram.org (required)
  TELEGRAM_SESSION_FILE  path to the SQLite session file
                         (default $ASSISTANT_DATA_DIR/telegram-userbot.session, else ./telegram-userbot.session)
"""
import os
import sys
from pathlib import Path


def _fail(msg: str) -> None:
    print(f"telegram-userbot: {msg}", file=sys.stderr)
    sys.exit(1)


def _session_file() -> Path:
    explicit = os.getenv("TELEGRAM_SESSION_FILE")
    if explicit:
        return Path(explicit)
    data_dir = os.getenv("ASSISTANT_DATA_DIR")
    base = Path(data_dir) if data_dir else Path.cwd()
    return base / "telegram-userbot.session"


def _token_file() -> Path:
    # Anchored at <iva_root>/data so iva's connection (cwd = iva root) and this proxy
    # (cwd = services/telegram-userbot) resolve the SAME file: services/telegram-userbot/
    # serve.py → parents[2] = iva root. `iva userbot setup` writes it (0600).
    return Path(__file__).resolve().parents[2] / "data" / "telegram-userbot.token"


def _resolve_token() -> str:
    env = os.getenv("TELEGRAM_MCP_TOKEN")
    if env:
        return env.strip()
    f = _token_file()
    return f.read_text().strip() if f.exists() else ""


def _seed_session_env() -> Path:
    """Point upstream at our SQLite session file (created empty if absent = onboarding).

    Must run BEFORE importing telegram_mcp.runtime, whose module-level
    `_discover_accounts()` reads the session env and `sys.exit(1)`s if unset.

    We use a FILE session (not a string): an unauthorized session can't be
    serialized to a non-empty StringSession, but a missing SQLite file is a valid
    empty unauthorized session, and Telethon persists the auth to it automatically
    on QR login — no manual save. Single owner ⇒ no "database is locked".
    """
    path = _session_file()
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    # Telethon appends ".session" to the name; strip it so we don't get ".session.session".
    name = str(path)
    if name.endswith(".session"):
        name = name[: -len(".session")]
    os.environ["TELEGRAM_SESSION_NAME"] = name
    return path


def main() -> None:
    import asyncio

    # The SQLite session file holds the MTProto auth key (= full account access). Force
    # private perms on everything we create (0600 files / 0700 dirs) so a co-tenant on
    # the host can't read it — systemd's default umask is 022 (world-readable 0644).
    os.umask(0o077)

    host = os.getenv("TELEGRAM_MCP_HOST", "127.0.0.1")
    port = int(os.getenv("TELEGRAM_MCP_PORT", "8724"))
    token = _resolve_token()
    if not token:
        _fail("no proxy token — run `iva userbot setup` (writes data/telegram-userbot.token)")
    if not os.getenv("TELEGRAM_API_ID") or not os.getenv("TELEGRAM_API_HASH"):
        _fail("TELEGRAM_API_ID and TELEGRAM_API_HASH are required (create an app at my.telegram.org)")

    session_path = _seed_session_env()

    # Import AFTER seeding the session env — runtime builds `mcp` + the single
    # Telethon client; importing the tools package fires every @mcp.tool decorator.
    from telegram_mcp.runtime import mcp, get_client, _apply_exposed_tools_mode
    import telegram_mcp.tools  # noqa: F401 — registers all tools with `mcp`

    # Honor TELEGRAM_EXPOSED_TOOLS (e.g. "read-only"); upstream normally does this in
    # its runner, which we bypass. Default "all".
    removed = _apply_exposed_tools_mode(mcp)
    if removed:
        print(f"telegram-userbot: read-only mode, pruned {len(removed)} write tools", file=sys.stderr)

    client = get_client()

    # Register onboarding tools AFTER pruning so QR login always works — you must be
    # able to connect the account even under read-only exposure.
    from onboarding import register_onboarding_tools

    register_onboarding_tools(mcp, client)

    # Enforce the anti-ban safety guide as server behavior (FloodWait compliance,
    # pacing, circuit-breaker) by wrapping the client's outbound methods in place.
    from guardrails import install_guardrails

    install_guardrails(client)

    import uvicorn
    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.responses import JSONResponse

    expected = f"Bearer {token}"

    class BearerAuthMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            if request.headers.get("authorization") != expected:
                return JSONResponse({"error": "unauthorized"}, status_code=401)
            return await call_next(request)

    class EnsureConnectedMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            try:
                if not client.is_connected():
                    await client.connect()
            except Exception as exc:  # noqa: BLE001
                print(f"telegram-userbot: reconnect failed: {exc}", file=sys.stderr)
            return await call_next(request)

    async def amain() -> None:
        await client.connect()  # NOT .start() — that would prompt for interactive login
        authorized = await client.is_user_authorized()
        print(
            f"telegram-userbot: session {'authorized' if authorized else 'NOT authorized (onboarding mode)'}"
            f" [{session_path}]",
            file=sys.stderr,
        )

        mcp.settings.host = host
        mcp.settings.port = port
        # Bound to localhost + bearer-gated; the DNS-rebinding validator only adds
        # 421s for the loopback/host aliases iva uses, so disable it here.
        from mcp.server.transport_security import TransportSecuritySettings

        mcp.settings.transport_security = TransportSecuritySettings(
            enable_dns_rebinding_protection=False
        )

        app = mcp.streamable_http_app()
        # add_middleware stacks outermost-last: BearerAuth runs first (reject before
        # we bother reconnecting), then EnsureConnected.
        app.add_middleware(EnsureConnectedMiddleware)
        app.add_middleware(BearerAuthMiddleware)

        print(f"telegram-userbot: listening on http://{host}:{port}/mcp", file=sys.stderr)
        config = uvicorn.Config(app, host=host, port=port, log_level="warning", lifespan="on")
        await uvicorn.Server(config).serve()

    import nest_asyncio

    nest_asyncio.apply()
    asyncio.run(amain())


if __name__ == "__main__":
    main()
