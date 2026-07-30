# Implementation notes

## Telegram stale-run reaper (#85 / #87 / #91)

- Each polling pass scans only per-chat records in `data/run-status.d`; the legacy
  whole-map remains read-only compatibility state.
- A stale `running` record is retired with a generation and timestamp CAS. A refresh
  or terminal event that wins the per-chat lock makes the reaper skip all side effects.
- The reaper calls Eve's scoped Telegram reset route only to release the recorded
  continuation token. It preserves the durable queue and all vault and daily state.
- Any chat present in the queue drain's in-memory gate is skipped for that pass. After
  a successful CAS, reset, notification, and working-message cleanup are isolated so
  one failed best-effort operation cannot stop the polling loop.

## Explicit inbound truncation (IVA-013 / #59)

- `sanitizeInbound()` keeps the 50,000-character safety cap, applies it on
  Unicode code-point boundaries, and reports the exact number of omitted code
  points as `truncatedChars`.
- Telegram model context adds a clear truncation notice for sanitized queued
  messages, media transcripts, captions, and security-flagged ordinary text.
  The notice includes the full daily-record path only after that complete source
  has been appended successfully.
- Queued compatibility input is appended verbatim before its model copy is
  sanitized. Media bytes, full transcripts/captions, and ordinary messages keep
  their existing append-only storage behavior.
- Clean ordinary Telegram text retains Eve's original pass-through path, so a
  harmless long message does not gain a synthetic context marker.

## Strict live model validation (IVA-005 / #55)

- Ollama Cloud, OpenCode Go and Codex selections come only from a successful, non-empty
  live catalog. Static IDs remain suggestions and cannot resurrect a retired model.
- OpenRouter uses the same shared validator with a minimal chat request carrying a
  `ping` function definition. Any HTTP 200 accepts the key, slug and tools request even
  when a reasoning model exhausts the small probe budget before visible output.
- Telegram shows a stale configured model for reference but never as a button, rejects
  forged indices, and validates again before one atomic provider/model/effort/key update.
- A newly entered key stays in wizard memory until the model passes validation. Network,
  authentication, empty/malformed catalog and changed-catalog failures leave `.env`
  untouched and render Retry/Back controls, including the `/think` catalog path.
- Interactive setup calls the same validator immediately before its atomic full-file
  write, so a provider change during later setup steps cannot persist a stale selection.
  Keeping byte-equivalent existing settings skips that rewrite; any changed keep-path
  value validates the configured model first.

## Real userbot health (IVA-010 / #58)

- The runtime probe will query a read-only health route on the already-running proxy.
  It must never import or open another Telethon client or session.
- The public states are limited to `off`, `starting`, `unreachable`, `unauthorized`,
  and `ready`. A rejected local bearer maps to `unreachable` with a fixed reason,
  while `unauthorized` is reserved for the Telegram account login state.
- The whole probe, including systemd and HTTP checks, shares one 1.5-second deadline.
  Results contain only fixed state and reason values, so command output cannot echo
  bearer tokens, subprocess output, URLs, or transport exceptions.
- Telegram setup remains asynchronous to keep the polling loop responsive. A non-zero
  child exit now becomes a bounded, redacted error and is rendered back into the menu.

## Structured Telegram reply context (IVA-009 / #53)

- Eve keeps quoted text and media only in `raw.reply_to_message`; IVA now adds one
  bounded JSON item to model context after the normal allowlist gate.
- The item marks the quote as untrusted and uses JSON escaping rather than
  prompt-like delimiters. Quotes, Unicode and newlines remain data.
- Quoted media exposes only its type, bounded filename and caption. Telegram file
  IDs, unique IDs, MIME metadata and bytes are excluded, and quoted files are
  never downloaded again.
- Empty or malformed replies add no context. Oversized content is truncated by
  Unicode code point and reports that fact through the item's `truncated` field.
- Reply text and captions pass through the existing inbound security gate.
  Informational sanitizer signals (for example, Cyrillic lookalikes) preserve
  normal UX; blocked content, role markers and override attempts get an adjacent
  untrusted-data warning.
- User names, usernames, channel titles and media filenames use the same bounded
  sanitizer path. Invalid IDs and unknown sender-chat types are omitted. Replies
  from channels and anonymous admins use bounded `sender_chat` metadata, including
  when Telegram also supplies its `GroupAnonymousBot` placeholder. A malformed
  sender-chat identity falls back to the validated `from` author.
- Telegram reply message IDs must be positive safe integers; malformed or
  oversized values are rejected before serialization.
- Private/group/topic routing and Eve's existing HITL reply path remain unchanged;
  the reply item is only additional context for messages that already dispatch.
  In particular, a quote does not wake a silent sticker or animation.

## Checked systemd activation (IVA-003 / #54)

- All CLI systemd mutations now go through `scripts/lib/systemd-control.mjs`. A non-zero
  command raises a sanitized error with a fixed per-unit journal hint; captured command
  output and process environment are never copied into diagnostics.
- Activation is idempotent and succeeds only after every requested unit reports both
  `enabled` and `active`. Restart also verifies the final active state.
- `install.sh` keeps unit rendering in `_install-units` and delegates activation to the
  same checked `_activate-units` seam used by `iva start` and doctor.
- Doctor records individual activation failures and keeps checking neighboring units.
  Destructive reset still stops fail-closed and attempts to restart services after a
  partial quarantine failure.
- Uninstall cleanup attempts every unit disable and file removal, then daemon reload and
  failed-state reset. It reports a bounded aggregate error only after all steps run.
- A verified update commits its transaction before activating the automatic update timer.
  Timer activation failure keeps the verified build, exits non-zero, and uses a dedicated
  diagnostic in terminal and Telegram instead of entering the build rollback path.
- No activation polling was added. The activated long-running services use systemd's
  synchronous `Type=simple` start semantics, and timer start jobs return in their active
  waiting state, so a synthetic `activating` transition would not model these units.

## IVA-001 bash process lifecycle

- Host bash runs in its own POSIX process group with stdin closed. Timeout sends `SIGTERM`,
  waits 400 ms, then sends `SIGKILL` and waits another bounded 400 ms. Timeout classification
  checks the root process state, so a delayed Node exit event does not produce a false timeout.
  A per-call worker observes the monotonic deadline and enforces it even while the main Node
  event loop is blocked. Linux uses `/proc` for root state; macOS uses the POSIX `ps` state
  so an exited zombie is not reported as timed out. If neither probe can establish state,
  cleanup fails closed with an explicit error.
- The schema and runtime accept deadlines from 100 through 2,147,483,647 ms. The lower bound
  gives a newly started worker time to observe the process; the upper bound matches Node's
  maximum timer delay and prevents overflow warnings and a hot rescheduling loop.
- Spawn resource failures are handled before PID, stream, worker or timer setup and return a
  bounded structured error; an `EMFILE` condition cannot crash the host process.
- Lifecycle handlers and the main-thread deadline are armed before the optional deadline
  worker. If worker initialization fails under resource pressure, execution continues with
  the main-thread deadline fallback and cannot orphan the spawned process group.
- The same group cleanup runs after a normal shell exit, so background descendants cannot
  outlive the tool call while they remain in that group. A process which deliberately creates
  a new session with `setsid`, or a manager-owned job such as `systemd-run`, has its own
  lifecycle outside this process-group contract.
- Stdout and stderr are consumed as streams while retaining the existing last-30,000-character
  result contract, cwd reporting and truncation marker. After bounded group cleanup, inherited
  output pipes are closed so a process outside the owned group cannot hold the tool call open.

## IVA-008 durable Telegram follow-up FIFO

- Busy-time follow-ups are stored in `data/telegram-queue.json` as schema version 1.
  Every FIFO item has its own version, the Telegram `update_id`, enqueue time, and the
  untouched raw update. The bridge does not download files or reconstruct quoted data
  while queueing.
- A queue write stages a unique 0600 file, fsyncs it, renames it atomically, and fsyncs
  the parent directory. Write, rename, and durability failures propagate to the polling
  loop. The Telegram offset advances only after enqueue succeeds. A duplicate retry also
  repeats the atomic write, closing the window where rename was visible but directory
  durability was not yet confirmed.
- Delivery is at-least-once. Queued replay uses an authenticated authored route which
  runs Eve's production Telegram handler and returns HTTP 204 only after its deferred
  `send()` has resolved, or after the authored `onMessage` explicitly resolves to `null`
  for a marked queue replay (for example a location saved to the daily log or a silent
  sticker). The random replay marker exists only in the outbound copy and is removed
  before authored message handling. Throws, malformed input, unmarked no-send paths and
  rejected `send()` calls do not produce a receipt. The durable head stays present until
  that receipt; an ordinary webhook HTTP 200 is not acceptance. A crash after acceptance
  and before the removal write can replay that one head; later items cannot pass it. If
  Before publishing an acknowledgement removal, the bridge fsyncs the original document
  as a pending-ack backup beside the queue. Successful acknowledgement durably removes
  that backup. Startup and every queue load restore any surviving backup first, closing
  the SIGKILL window between removal rename and directory fsync. A failed rollback raises
  a fatal durability error and stops polling.
- The bridge drains one eligible head per idle private chat, group, or forum topic per
  pass. One five-second budget covers the whole pass, and the next pass rotates past the
  last attempted key, so many stalled heads cannot multiply polling latency or starve a
  later chat. A failing head stays durable for a later pass. A short long-poll while
  queues exist observes terminal events quickly. A stale run-status also becomes
  drainable through the existing `isRunning()` TTL.
- `turn.started` publishes `running` before the Bot API working-status request. After an
  accepted queued turn, an in-memory per-key gate must observe that `running` state and
  its later idle transition before the next FIFO head can start. Every per-chat status
  write advances a generation, so a running-to-idle cycle completed between bridge polls
  also releases the gate. If no status write is observable, the gate uses the same bounded
  stale-run horizon as `isRunning()` and still refuses release while a run is visible.
  Intentionally handled no-send updates are identified by the authored acceptance route
  and bypass this turn gate.
- Private `/new` and `/restart` write and fsync a per-chat reset intent before asking Eve
  to reset. Queue cleanup and the idle tombstone happen after remote success, then the
  intent is durably removed. Startup reconciles every remaining intent before polling or
  queue draining, so a crash or ambiguous response after remote success cannot release
  messages from the retired private session.
- New updates join an existing FIFO even during the idle transition, preserving arrival
  order. Replies to bot messages and callbacks retain their immediate HITL path.
- Queue admission is fail-closed on `TELEGRAM_ALLOWED_USER_IDS`. Private owner messages
  are eligible; group/topic messages additionally need a bot command or mention.
  Mentions match the exact Telegram username with Unicode-aware token boundaries and
  validated UTF-16 Telegram entities. Unaddressed group traffic is consumed without
  entering later model context.
- Each successful enqueue gets a reaction plus an explicit per-chat/topic queue count.
  The count is sent after the durable write and offset update.
- Legacy `{chatKey: string[]}` files migrate atomically. Each string becomes a versioned
  item with a stable synthetic update id and remains present until accepted by Eve.
  Group/topic text whose sender was not recorded is published to a unique, fsynced
  `.legacy-unattributed-*` sidecar through a no-clobber hard link; the exact path is
  logged and a later migration cannot overwrite an earlier archive.
- Queue maps use own data properties for every chat key, including `__proto__`, so JSON
  migration, enqueue, reload, and acknowledgement cannot silently lose that key.

## Aimasters.Me user-feedback backlog (2026-07-28)

- Source evidence, issue triage, source-message links and links to attached screenshots/video are in
  [`notes/backlog/2026-07-28-aimasters-iva-feedback.md`](notes/backlog/2026-07-28-aimasters-iva-feedback.md).

## Release 0.3.4

- Patch version only: no dependency or runtime change is introduced by the release commit.
- The existing Unreleased contributor-audit notes become the dated 0.3.4 changelog.
- Both root README files summarize the same three user-facing themes: model-aware thinking controls, scoped Telegram recovery on Eve 0.27.8, and data/security hardening.
- The Russian README's stale Eve 0.24.4 reference is synchronized to 0.27.8.

## Model-specific reasoning buttons

- Reimplemented the useful part of PR #34 on current `main`, while keeping its author credited in the new draft PR.
- The Telegram wizard remains the only configuration UI. A selected Codex model carries its own live reasoning levels in the in-memory flow state.
- `/models` is fetched once per screen load. No cross-process cache or generated reasoning-level file is introduced.
- Network, empty and malformed Codex catalogs fall back to `low`, `medium`, `high`. Runtime validation accepts the stable protocol set through `max`; `ultra` stays unsupported.
- Non-Codex providers skip the reasoning screen and clear the inactive global effort value when their model is saved.
- Old callbacks are rejected by both Telegram message ID and wizard step, so an earlier screen cannot mutate a later screen in the same edited message.
- Every wizard-owned network result checks object identity on both success and error; a cancelled/replaced flow cannot resurrect itself with a late response.

## Transactional configuration apply

- `iva config` writes the interactive result to a private temporary candidate. The live
  `.env` remains untouched until the user confirms apply and the shared live model
  validator accepts the final provider/model selection again.
- Apply persists a versioned 0600 rollback snapshot, atomically replaces `.env`,
  regenerates the port-bearing units, restarts both the agent and Telegram poller through
  the checked systemd adapter, and waits for local `GET /eve/v1/health`.
- Any write, restart, health, or commit failure restores the exact previous bytes and
  restarts the old setup. A failed rollback keeps the durable snapshot and reports
  `iva config --recover`; the next `iva config` also reconciles it before showing setup.
- Snapshot and provider errors are redacted using secret-bearing env keys. Temporary
  candidate data is mode-protected and removed when the config command returns.
- An occupied unchanged port is no longer attributed to Iva heuristically. The setup
  requires an explicit negative-default confirmation before reusing it, otherwise it
  offers the nearest free port.

## Eve 0.27.8 scoped reset

- Scope: upgrade Eve to 0.27.8, preserve deterministic prompt-error terminal classification,
  and replace Telegram-wide workflow quarantine for `/new` with a reset of the exact
  Telegram continuation token.
- `/restart` must first reset the same Telegram session, then restart only `iva.service`.
  `iva reset` remains the explicit global recovery operation.
- The reset endpoint is internal to the Telegram channel and authenticates with
  `TELEGRAM_WEBHOOK_SECRET_TOKEN`; it must not use the generic `eveChannel` reset endpoint.
- The bridge already serializes Telegram updates and persists delivered update IDs. A reset
  request must not mutate run-status or queues until Eve confirms success.
- `/clear` and `/compact` are removed from bridge aliases and public docs because they have
  no distinct semantics.
- Eve 0.27.8 requires `ai ^7.0.34`; the previous 7.0.29 override was upgraded to 7.0.39
  so the framework does not run outside its declared peer contract.
- Successful resets keep an idle token tombstone. This makes a replayed group `/new`
  idempotent after a bridge crash while removing the old session id so late terminal events
  cannot mutate the new conversation state.
- In a group/topic, an explicit reply to Iva's own numeric bot id selects that reply anchor
  ahead of the last stored topic token. Replies to other bots are rejected.
- Telegram queues are keyed by chat/topic, while Eve group sessions also include a reply
  `conversationId`. Private reset clears its queue before publishing idle state; group/forum
  reset preserves the shared queue so messages for other anchors are not lost.
- Queue rewrites use a unique same-directory temp file plus atomic rename. A failed reset
  queue write is reported and leaves the old running status in place; malformed queue JSON
  is strict during reset and quarantined during ordinary polling so the bridge stays live
  without silently overwriting the damaged bytes.
- Run status is stored per chat under `data/run-status.d/`. The old whole-map
  `data/run-status.json` remains a read fallback and each touched key migrates lazily.
  Per-chat O_EXCL locks have bounded waiting and stale-owner recovery; atomic conditional
  updates keep late Eve terminal events from overwriting a reset or a fresh session.
  A malformed per-chat file is quarantined alone, so neighboring chats keep working.
- Global `iva reset` uses one collision-safe quarantine operation stamp for both Eve
  workflow locations, `run-status.d`, legacy `run-status.json`, and
  `telegram-queue.json`. Services are already stopped, every file/directory keeps private
  permissions, and any target failure participates in the existing incomplete reset report.
- Legacy private chats can reconstruct their stable token immediately. A legacy group with
  no stored event token must send `/new` as a reply to Iva's latest message once; future
  events persist the exact token automatically.
