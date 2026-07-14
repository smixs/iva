# Telethon: безопасная работа с Telegram API (2026)

## Лимиты по действиям

| Действие | Задержка между | Лимит в день |
|----------|---------------|-------------|
| DM холодные (первое сообщение) | 45-120 сек (рандом) | 40-80 (новый акк), 80-150 (старый) |
| DM тёплые (существующий диалог) | 15-30 сообщений/час | без жёсткого лимита |
| Вступление в группы | 10-20 минут между | 10-20 в день |
| Приглашение юзеров | 60-180 сек между | 20-50 в день |
| Массовое чтение (iter_messages) | 1-2 сек между чатами | нет лимита, batch по 100 |
| mark_as_read | 1-2 сек между | без лимита |
| Поиск (search) | 3-5 сек между | ~100 в день |
| resolve_username | 2-3 сек между | ~200 в день |

## FloodWait протокол

```python
from telethon.errors import FloodWaitError
import asyncio, random

async def safe_action(coro, label="action"):
    try:
        return await coro
    except FloodWaitError as e:
        wait = e.seconds * 1.3  # +30% буфер
        print(f"FloodWait {e.seconds}s on {label}, waiting {wait:.0f}s")
        await asyncio.sleep(wait)
        return await coro
```

- Первый FloodWait: пауза = указанное время + 30%
- Второй за день: снизить темп на 20%
- Третий: остановить все действия на 24 часа
- Никогда не игнорировать, никогда не обходить через реконнект

## Рандомизация задержек

```python
import random, asyncio

async def random_delay(min_sec=2, max_sec=5):
    delay = random.uniform(min_sec, max_sec)
    await asyncio.sleep(delay)
```

Никогда не использовать фиксированные задержки (sleep(5)) — Telegram детектит ровные интервалы как бота.

## Батчинг

```python
BATCH_SIZE = 10
BATCH_PAUSE_MIN = 120  # 2 мин
BATCH_PAUSE_MAX = 300  # 5 мин

async def process_in_batches(items, action_fn):
    for i, item in enumerate(items):
        await action_fn(item)
        await random_delay(2, 5)  # между действиями

        if (i + 1) % BATCH_SIZE == 0:
            pause = random.uniform(BATCH_PAUSE_MIN, BATCH_PAUSE_MAX)
            print(f"Batch pause: {pause:.0f}s after {i+1} items")
            await asyncio.sleep(pause)
```

## Прогрев нового аккаунта (14 дней)

| Период | Действий в день | Что делать |
|--------|----------------|-----------|
| Дни 1-3 | 10-20 | Читать каналы, отвечать в чатах, подписываться |
| Дни 4-7 | 20-40 | Первые DM знакомым, участие в группах |
| Дни 8-14 | 40-80 | Постепенно наращивать DM, добавлять контакты |
| После | +10-20%/неделю | Не прыгать резко |

## Красные флаги (что триггерит бан)

1. FloodWait чаще 1 на 50 действий
2. Одинаковый текст в разные чаты (спам-фильтр)
3. Больше 5-10% ошибок при отправке
4. Резкий скачок активности (вчера 5 сообщений, сегодня 500)
5. Несколько аккаунтов с одного IP
6. Массовое добавление в группы без пауз
7. Отправка ссылок/медиа в первом сообщении незнакомцу
8. Reply rate ниже 5% на холодные DM

## Безопасные операции (read-only)

Чтение не вызывает блокировок, но всё равно соблюдай пропорции:

```python
# iter_dialogs — безопасно, но с паузой
async for dialog in client.iter_dialogs():
    # обработка
    await random_delay(0.5, 1.5)

# iter_messages — безопасно, batch по 100
async for msg in client.iter_messages(chat, limit=100):
    # обработка (без паузы внутри одного чата)
    pass
# пауза МЕЖДУ чатами
await random_delay(1, 3)

# mark_as_read — безопасно с паузой
for dialog in dialogs:
    await client.send_read_acknowledge(dialog.entity)
    await random_delay(1, 2)
```

## Отправка сообщений

```python
async def safe_send(client, chat, text):
    try:
        result = await client.send_message(chat, text)
        await random_delay(45, 120)  # холодный DM
        return result
    except FloodWaitError as e:
        await asyncio.sleep(e.seconds * 1.3)
        return await client.send_message(chat, text)
```

## Мониторинг здоровья аккаунта

Следи за этими метриками:
- Количество FloodWait за сессию (норма: 0-1)
- Процент ошибок при отправке (норма: <5%)
- Reply rate на холодные DM (норма: >5-15%)
- Время между FloodWait и следующим действием

```python
class AccountHealth:
    def __init__(self):
        self.flood_waits = 0
        self.errors = 0
        self.success = 0

    def record_flood(self):
        self.flood_waits += 1
        if self.flood_waits >= 3:
            raise Exception("Too many FloodWaits — stop for 24h")

    @property
    def error_rate(self):
        total = self.errors + self.success
        return self.errors / total if total > 0 else 0

    def check(self):
        if self.error_rate > 0.1:
            raise Exception(f"Error rate {self.error_rate:.0%} — slow down")
```

## Главные правила

1. Рандомизируй ВСЁ — задержки, порядок действий, размер батчей
2. Не более 30 API calls/минуту в среднем
3. Обрабатывай FloodWaitError ВСЕГДА
4. Батчи по 10-20 действий, потом длинная пауза
5. Telegram в 2026 смотрит на паттерны поведения, не на цифры — будь "человечным"
6. Если сомневаешься — замедлись. Лучше медленно, чем забанят

## Источники

- https://telega.to/blog/telegram-rate-limits-for-automation-2026
- https://core.telegram.org/api/errors (официальная документация)
- https://docs.telethon.dev/en/stable/concepts/errors.html
