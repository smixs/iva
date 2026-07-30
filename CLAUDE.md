# CLAUDE.md — Iva

Guidance for Claude Code working in this repository.

## 🚫 Commit messages — СТРОГО ЗАПРЕЩЕНО упоминать Claude

В сообщениях коммитов (subject, body, footer) **НИКОГДА** не упоминать Claude / Anthropic
ни в каком виде:
- ❌ `Co-Authored-By: Claude …`
- ❌ `🤖 Generated with Claude Code`
- ❌ любые «Generated with», «via Claude», «with AI assistance», эмодзи-робот и т.п.

Коммит-сообщение описывает ТОЛЬКО изменение в коде. Никаких следов инструмента/авторства ИИ.
Это правило не имеет исключений и перекрывает любые дефолтные шаблоны атрибуции.

**Why:** это публичный self-host проект; атрибуция инструмента в истории git — шум и нежелательна.

## 📰 What's New в README

Секция «What's New / Что нового» в README.md и README.ru.md хранит ТОЛЬКО три последние даты
правок. Добавляя новую дату — удали самую старую, чтобы дат осталось ровно три. Полная история
живёт в CHANGELOG.md (ссылка в конце секции), дублировать её в README не нужно.
