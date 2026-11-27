# BROWSER-MEDIATORS.md

**Назначение:** два посредника для браузерных задач — `bsk` по умолчанию и
CDP-скрипты для узкой ниши. Документ фиксирует разделение труда, проверенные
команды и ограничения, чтобы новая сессия (в т.ч. после контекст-переноса) не
изобретала третий способ.

**Статус:** принято в рутину 2026-11-27 после проверки на живой машине.
**Расположение CDP-посредников:** `C:\Users\oleg\browser-mediators`.

---

## §1. Разделение труда

| Задача | Инструмент |
|---|---|
| Авторизация, логины, формы, клики, ожидания, сложные SPA | **`bsk`** |
| Снимок/скриншот конкретного элемента по `@eN` | **`bsk screenshot --ref`** |
| Прочитать DOM без JS (`read`/`extract`) | **`bsk`** |
| Произвольный JS **с возвратом значения** (DOM → строка/массив/объект) | **`cdp-eval.mjs`** |
| Full-page PNG или точный crop элемента по CSS-селектору | **`cdp-shot.mjs`** |
| `bsk` недоступен (аварийный путь) | **`cdp-*`**, если задача не требует логина |

`bsk` — основной путь. CDP не заменяет его и не используется против Agent
Window, которым управляет `bsk`.

---

## §2. bsk: рабочий цикл

```powershell
bsk status
bsk browsers
bsk open https://example.com
bsk observe
bsk click @e3
bsk fill @e7 --value "текст"
bsk press Enter
bsk wait-for-element --selector "#result" --state visible --timeout 10s
bsk screenshot --ref @e5 --out element.png
bsk close
```

Правила: refs `@eN` живут до следующего `observe`; для данных — `read`/`extract`,
не `evaluate`; капчу/логин — `request-help`; сессию закрывать `bsk close`.
Подробности — `docs/BSK-CHEATSHEET.md`.

---

## §3. CDP: быстрый старт

```powershell
# 1. Браузер с отдельным профилем (НЕ профиль по умолчанию)
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\oleg\browser-mediators\start-chrome.ps1 -Port 9222

# 2. JS на странице
node C:\Users\oleg\browser-mediators\cdp-eval.mjs --port 9222 --expr "document.title"
node C:\Users\oleg\browser-mediators\cdp-eval.mjs --port 9222 --url example.com --expr "JSON.stringify([...document.querySelectorAll('h2')].map(h=>h.textContent))"
node C:\Users\oleg\browser-mediators\cdp-eval.mjs --port 9222 --url example.com --file task.js --json

# 3. Скриншоты
node C:\Users\oleg\browser-mediators\cdp-shot.mjs --port 9222 --out shot.png
node C:\Users\oleg\browser-mediators\cdp-shot.mjs --port 9222 --out full.png --full-page
node C:\Users\oleg\browser-mediators\cdp-shot.mjs --port 9222 --out card.png --selector "article:first-child"

# 4. Остановка
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\oleg\browser-mediators\start-chrome.ps1 -Stop
```

Параметры `start-chrome.ps1`: `-Port` (явно), `-StartUrl`, `-Restart`, `-Stop`,
`-ProfileDir`. Порт всегда передаётся явно.

---

## §4. Ограничения (обязательные)

1. Не писать новых посредников, пока не использованы готовые.
2. Не запускать `chrome.exe` вручную — только `start-chrome.ps1`.
3. Не убивать все `chrome.exe` — скрипт останавливает только свой профиль/порт.
4. Не использовать профиль по умолчанию для CDP (Chrome/Edge 136+ игнорируют
   порт для default-профиля).
5. Не запускать CDP против Agent Window, которым управляет `bsk`.
6. Не включать DevTools-порт в сеть; только `127.0.0.1`.
7. Не логировать cookies/токены; не выполнять JS, который их печатает.
8. `process.exit()` в CDP-скриптах запрещён — только `process.exitCode`
   (иначе libuv assertion на Windows при закрытии WebSocket).

Коды выхода `cdp-eval`/`cdp-shot`: 1 — аргументы, 2 — браузер недоступен,
3 — вкладка/селектор не найдены, 4 — ошибка JS, 5 — таймаут, 6 — ошибка
WebSocket (→ `-Restart`).

---

## §5. Что проверено на живой машине (2026-11-27)

- `start-chrome.ps1 -Port 9222`, `-Restart -StartUrl https://example.com`,
  `-Stop`; после остановки порт закрыт.
- `cdp-eval`: `--expr`, `--file`, `--json`, выбор вкладки `--url`;
  возврат строки/JSON.
- `cdp-shot`: viewport, `--full-page`, `--selector body` (crop).
- Коды ошибок: 3 (нет вкладки), 4 (исключение JS) — совпадают с документацией.
- CDP-браузер использует отдельный профиль
  `%LOCALAPPDATA%\browser-mediators\profile`; логины пользователя остаются
  в обычном браузере и доступны через `bsk`.

---

## §6. Связь с протоколом

`docs/BROWSER-TASK-PROTOCOL.md` задаёт бюджет и порядок сбора данных; этот
документ — выбор посредника. При конфликте: бюджет и стоп-условия — из
протокола, способ выполнения — отсюда.

**Глобальная инструкция — включена 2026-11-27.** В
`~/.config/opencode/opencode.jsonc` добавлено:

```jsonc
"instructions": ["C:\\Users\\oleg\\browser-mediators\\GLOBAL.md"]
```

`GLOBAL.md` — короткая переносимая версия (bsk по умолчанию, публичный поиск —
`websearch`/`webfetch`, CDP — ниша, safety-правила). Полная версия —
`AGENTS.md` в той же папке. Глобальная инструкция аддитивна: она не меняет
инструменты, права и не блокирует парсинг/поиск.
