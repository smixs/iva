---
description: Браузерная автоматизация для интерактивных веб-задач. Используй, когда нужно открыть сайт, заполнить форму, кликнуть, сделать скриншот, залогиниться, спарсить JS-страницу или протестировать веб-приложение. Триггеры — «зайди на сайт», «заполни форму», «нажми кнопку», «скриншот страницы», «войди в аккаунт», «спарси данные», «протестируй сайт».
---

# agent-browser

У тебя есть браузер через CLI `agent-browser` (запускай через bash). Headless, работает на сервере.

## ВАЖНО — начни отсюда
ПЕРЕД любой работой с браузером загрузи актуальные воркфлоу (всегда под версию CLI):
```
agent-browser skills get core
```
Для задач вне обычных веб-страниц:
```
agent-browser skills get electron   # десктоп-приложения (VS Code, Slack, Discord…)
agent-browser skills get slack       # Slack
agent-browser skills get dogfood     # тестирование / QA / багхант
agent-browser skills list            # всё доступное на установленной версии
```

## Базовый цикл
```
agent-browser open https://example.com
agent-browser snapshot -i            # интерактивные элементы с refs @eN
agent-browser click @e2
agent-browser fill @e3 "текст"
agent-browser screenshot page.png
agent-browser close
```

## Сессии и логины
Сохраняй вход между запусками через имя сессии (персист в ~/.agent-browser/sessions/, vault шифрован):
```
agent-browser --session-name <имя> open https://site.com
```
Тот же `--session-name` переиспользует уже залогиненную сессию — не логинься заново.

## Если сломалось
```
agent-browser doctor --fix
```

Разграничение тулзов: быстрый текстовый поиск — `web_search`; прочитать один URL — `web_fetch`;
интерактив/логин/JS/скриншот/тест веб-приложения — `agent-browser`.
