# eve Agent App (Ева, v2)

This project uses the eve framework. Before writing code, always read the relevant guide in `node_modules/eve/docs/`.

## Архитектура (self-host bare-VPS)
- **Без sandbox.** Тулзы `bash`/`read_file`/`write_file`/`glob`/`grep` host-native (Node `fs`/`child_process`),
  полный доступ к VPS. Защита периметра — allowlist Telegram (fail-closed).
- **Deepgram.** Голос/видео/аудио из Telegram транскрибируются (nova-3, `DEEPGRAM_LANGUAGE=multi`) и пишутся
  в дневной транскрипт vault до попадания к Еве.
- **Vault** (`ASSISTANT_VAULT_DIR`) — приватный git-репо (память + Obsidian). `install.sh` делает `git init`;
  пользователь при первом запуске проходит `gh auth login` и привязывает приватный remote.
- **Память — systemd-таймеры** (`deploy/eve-memory-*.{service,timer}`): daily/weekly/monthly/yearly + doctor,
  драйвят Еву через `eve/client`. eve-расписания (`defineSchedule`) на self-host НЕ срабатывают (только Vercel Cron).
- **Время** — `ASSISTANT_TIMEZONE` (→ `TZ`) + динамическая инструкция `now`.

## Гочи eve (0.11.4)
- `eve dev` падает на cross-authored относительном `.js`-импорте. Каждая новая тулза/хук/инструкция
  **самодостаточна**: импортирует только `eve/*`, `zod`, `ai`, node-builtins. Общий код НЕ выносить в `lib/`
  с относительным импортом — дублируй мелкие хелперы инлайном (напр. Deepgram-fetch).
- **Не** добавляй handler-schedules в `agent/`. Стиль: ESM, TypeScript, `.js`-расширения в относительных импортах.
