# BSK-CHEATSHEET.md

**Назначение:** короткий справочник по BrowserSkill (bsk): подключение, команды, жёсткие лимиты перехвата, известные тупики и специфика сайтов, на которых проект уже работал.

**Область:** Chrome + расширение bsk 0.3.3, Windows-хост. Читается до первого вызова bsk в задаче; протокол выполнения — `docs/BROWSER-TASK-PROTOCOL.md`; выбор bsk vs CDP и ограничения CDP — `docs/BROWSER-MEDIATORS.md`.

**В релизный ZIP не входит** (фильтр `\.md$` в `.github/workflows/release.yml:110`).

**Версия:** 1.2 (2026-11-27: команды приведены к текущему CLI `bsk session/tab/debug`, добавлена ссылка на `docs/BROWSER-MEDIATORS.md`; 1.1 — 2026-11-20: границы `chrome://`/`chrome-extension://`, кодировка, смерть сессии).

---

## §1. Подключение за 60 секунд

```bash
bsk status                  # демон + браузеры + версии
bsk browsers                # instance id: например c6aa1491
bsk doctor                  # если 0 браузеров — подсказка про расширение
bsk daemon start --foreground --port <PORT> --daemon-idle 240m --session-idle 120m
bsk session start --browser <id> --no-focus
bsk tabs list --scope user
```

- Демон может автообновиться (0.3.2 → 0.3.3) и перезапуститься на **другом** WS-порту; после этого CLI может навсегда показывать `browsers connected 0`.
- Автозапуск демона из CLI на Windows иногда падает: `cannot start an independent Windows daemon; the host may prohibit Job Object breakaway; use 'bsk daemon start --foreground' …: Отказано в доступе. (os error 5)`. Рабочий обход — запуск в фоне:

```bash
export BSK_AUTO_START=0
nohup bsk daemon start --foreground --port 53711 --daemon-idle 240m --session-idle 120m \
  > /tmp/bsk-daemon-53711.log 2>&1 &
```

- `bsk` не умеет запускать браузер: `session start --help` содержит только `--browser/--name/--request-id/--width/--height/--focus/--no-focus/--unattended`. Chrome должен быть уже запущен с установленным расширением.

---

## §2. Симптом «browsers connected 0» (главный тупик)

Расширение хранит порт демона в `chrome.storage.local` под ключом **`bsk_daemon_port`** и держит keepalive-будильник `bh-keepalive` (каждые 0,5 мин `requestConnect()`). После перезапуска демона на другом порту расширение продолжает стучаться на **старый** порт: TCP-соединения нет вообще, в логе демона нет ни одной попытки подключения.

Проверка (Windows, PowerShell, читает файл, заблокированный Chrome):

```powershell
$p = "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Local Extension Settings\hhcmgoofomhgciiibhipgmgkgnoenaoi\000003.log"
$fs = [IO.File]::Open($p,'Open','Read','ReadWrite'); $ms = New-Object IO.MemoryStream
$fs.CopyTo($ms); $fs.Close(); $txt = [Text.Encoding]::UTF8.GetString($ms.ToArray())
([regex]::Matches($txt,'bsk_daemon_port.{0,40}')) | % { $_.Value }
```

Сверьте найденное число с портом живого демона (`~/.bsk/daemon.json`, поле `ws_port`; `Get-NetTCPConnection -LocalPort <port>`). Если они разные — поднимите демон на порту из storage: `--port <старый порт>`. Занимает одну минуту вместо часа исследования.

Дополнительно: `bsk_daemon_port` — второй по важности ключ; первый — `bh_connection_enabled` (должен быть `true`).

---

## §3. Сессии и вкладки

| Команда | Смысл |
|---|---|
| `bsk session start --browser <id> --no-focus` | новая сессия, окно Agent Window |
| `bsk session list` / `bsk session stop <id>` | список / закрытие |
| `bsk tab list --session <s> --scope user` | вкладки пользователя (id, url, title) |
| `bsk tab borrow <tabId> --session <s>` | вкладка пользователя → в Agent Window |
| `bsk tab create --url <url>` / `select` / `close` | своя вкладка |
| `bsk tab return <tabId> --session <s>` | вернуть вкладку пользователю |

Правило: одна задача — одна вкладка; действия идут с `--session <s>` (и
`--tab-id`, если вкладка не активна).

---

## §4. Инспекция: что чем смотреть

| Действие | Зачем | Ловушка |
|---|---|---|
| `observe` (`maxTokens` 2 000–4 000) | AX-дерево, ref-ы `@e61`, текст сообщений | 4 тыс. токенов на большой чат |
| `snapshot` | компактнее observe, те же ref-ы | меньше деталей |
| `screenshot` | визуальное доказательство (чип вложения, панель превью) | — |
| `html` (`ref`/`selector`, `maxBytes`) | фрагмент разметки | **промах селектора → возвращается весь документ** (500+ KB) |
| `extract discover` | таблицы/списки | на SPA находит только `ol`/`ul` |
| `console` | JS-логи страницы (наши `[AI CM][diag]`) | по умолчанию пусто |
| `network` / `debug requests` | список запросов без тел | тела — отдельным шагом |
| `debug request id part=response` | тело одного запроса | ограничено §5 |

---

## §5. Жёсткие лимиты (0.3.3)

- Текст тела: **`slice(0, 65536)`** — больше 65 536 символов не отдаётся никогда, настройки нет (константа в `background.js`).
- Уже на уровне webRequest: `decoded_bytes > 65536*4 (262 144)` → `response_body = {state:"omitted", reason:"body_limit"}`.
- CDP-путь: base64 длиннее `65536*6` → тоже `omitted/body_limit`.
- Флаг `redacted:true` ставится, если санитайзер переписал текст; из-за него **`debug replay` не работает**: `provide or remove redacted header: authorization`.
- `--budget` в `bsk debug` — 4 096…262 144 байт JSON на ответ; `--max-chars` ≤ 16 384.
- Следствие: тела `history_messages` (>80 KB) через перехват **не читаются**. Доказательства строятся по метаданным: `decoded_bytes`, `initiator`, имена запросов, `debug export` в файл (там тела тоже `truncated`, но структура и заголовки доступны).

---

## §6. Рабочий цикл перехвата

```text
bsk debug start --session <s> --name <run>        (вкладка задачи)
→ действие: bsk click @e61 --session <s> / bsk reload --session <s>
→ bsk debug requests --session <s> --kind business
→ bsk debug export --session <s> --json > <файл вне репозитория>
→ анализ в shell: python/jq/grep, в контекст ≤20 строк
→ bsk debug stop --session <s>
```

Экспорт — один JSON: `{version, saved_at, run, requests, operations, console, pages, rules, replays, performance}`; у запроса: `request_headers`, `response_body{state, reason, text, chars, redacted}`. Второй `debug start` без `stop` падает: `stop the task's current capture before selecting another tab`.

---

## §7. Специфика DeepSeek (`chat.deepseek.com`) — проверено

**История.** `GET /api/v0/chat/history_messages?chat_session_id=<uuid>` — полный ответ; сайт сам ходит с `&cache_version=<N>&cache_reset_at=<ts>` и получает дельту (`cache_control: MERGE`, `chat_messages: []`). Наше расширение делает полный refetch: `core/deepseek-refetch.js:162` (`refetchFullHistory`), пагинации нет.

**Вложения.** В JSON — фрагмент `type: "FILE"` с `files: [...]`, самого текста там нет:

```json
{"type":"FILE","files":[{"id":"…","signed_path":"…","file_name":"….txt",
 "file_size":14088,"token_usage":…,"status":…,"is_image":false}]}
```

Текст скачивается отдельно:

```text
GET https://files.deepseeksvc.com/api/file?file_id=<id>&state=<signed_path>&ty=r
```

`ty=r` — текст/файл, `ty=p` — картинка. URL строит `dp({signedPath, type})` из бандла (`dr="files.deepseeksvc.com"`, `ds="/api"`). Метаданные пачкой: `GET /api/v0/file/fetch_files?file_ids=<ids>` → `biz_data.files[]`.

Поля файла: `id`, `signed_path`, `file_name`, `status`, `retryable`, `file_size`, `audit_result`, `inserted_at`, `updated_at`, `token_usage`, `is_image`, `width`, `height`. Отправка сообщения: `push({type:"FILE", id:-2, files})` + `push({type:"REQUEST", content, id:-1})`, в запросе — `ref_file_ids`.

**DOM.** В транскрипте только чип (`# <ИМЯ>.txt` + `TXT 13.76KB`); тело появляется лишь после клика — ленивый оверлей превью, чанк `previewAll.<hash>.js` + `previewAll.<hash>.css`. Класса `.ds-collapsible-text` в текущем фронте **нет** (`ds-collapsible` = 0 вхождений в `main.*.js` и `previewAll.*.js`); текст рендерится в блоке с `white-space:pre-wrap` (класс вида `.d1d2eae1`, хэши меняются от сборки).

**Наши хуки в репозитории.** `core/deepseek-net.js:123` — обёртка `window.fetch` (ветка `isHistory`); `core/deepseek-parse.js:111-122 collectTurnText` берёт у USER только `type === "REQUEST"`; `core/deepseek-intercept.js:411` `SSE_FRAGMENT_TYPES = {THINK, RESPONSE, REQUEST, TIP, SEARCH, TEMPLATE_RESPONSE}` — `FILE` отсутствует; `core/deepseek-diag.js:102` читает `msg.attachments` (поле Claude, для DeepSeek мёртвое), `DIAG_HIST_RAW_CAP = 200000` (`:195`), `diagHistRecord` (`:719`). Диагностика включается `sessionStorage.aiCmDebug = '1'` (или `window.__aiCmDebug.dumpDeepSeekO18()`).

---

## §8. Окружение Windows

- `ops_bash` (git-bash) — для `&&`, пайпов, forward-slash путей; `pwsh` — для Windows-native cmdlets (`Get-NetTCPConnection`, реестр, `[IO.File]`).
- Git-bash ломает аргументы вида `/FI` и Windows-пути в `tasklist` — такие команды только через `pwsh`.
- Chrome-профиль пользователя здесь — `Default`; расширение bsk: `…\Default\Extensions\hhcmgoofomhgciiibhipgmgkgnoenaoi\0.3.3_0\`, storage — `…\Default\Local Extension Settings\hhcmgoofomhgciiibhipgmgkgnoenaoi\`.
- `Local Storage\leveldb\*.ldb` заблокирован Chrome; значения сжаты snappy — штатного декодера в окружении нет, попытки вытащить `userToken` из storage — тупик (API на `Authorization: Bearer`).
- Артефакты складывать вне репозитория: `%TEMP%\aicm-artifacts\<тема>\`.

---

## §9. Чек-лист перед первым вызовом

1. `bsk status` → `browsers connected 1`? Нет — §2 (порт), один цикл.
2. `bsk browsers` → запомнить instance id; `bsk session start --browser <id> --no-focus`.
3. `bsk tabs list --scope user` → `borrow` нужную вкладку; далее все вызовы с её `tabId`.
4. Артефакты — в `%TEMP%\aicm-artifacts\…`, репозиторий не трогать.
5. Тяжёлые ответы — в файл; в контекст ≤2 тыс. токенов.
6. В конце: `git status --short` пуст, отчёт ≤20 строк по `docs/BROWSER-TASK-PROTOCOL.md` §7.

---

## §10. Границы bsk и типовые тупики (2026-11-20)

- **`chrome://` и `chrome-extension://` не наблюдаются bsk.** Reload расширения,
  экспорт из попапа, `chrome://extensions` — только human-шаг. Не тратить вызовы
  на попытки их открыть/скриптовать.
- **Кириллица в `evaluate`** ломается в CLI (mojibake). Передавать `\uXXXX` или
  ASCII-маркеры; ответы сохранять в файл.
- **`/tmp` ≠ `C:\Temp`.** Windows-python не видит `/tmp` из git-bash; пути
  объявлять в винном виде (`C:\Temp\...`).
- **Сессия может умереть** (закрыт Agent Window): `bsk session stop` → новый
  `session start`; вкладку вернуть владельцу (`tabs return`).
- **Правило остановки:** механика шага не ясна после 3 вызовов → стоп, запись в
  `docs/SITE-RECIPES.md` («не проверено»), возврат к задаче.


---

## §11. Уроки 2.2: bsk 0.5.0 + Windows UIA (2026-11-24)

- **CLI 0.5.0:** команда `bsk tab ...`, не `bsk tabs ...`; `bsk press --ref @eN Enter` (без `--key`); `bsk wait-ms 12000` (без `--session`).
- **Сессия:** `bsk session start --browser <id> --no-focus --name <name>` создаёт Agent Window и возвращает id (у нас `tksw`). `--no-focus` не крадёт фокус, но для UIA-кликов окно потом нужно поднять.
- **`bsk navigate` в 0.5.0** требует `--observation <id>` из `bsk sync --json` (верхний `observation_id`), иначе `needs an explicit current observation`.
- **`chrome://` и `chrome-extension://` bsk не обслуживает.** Reload расширения и попап — только Windows UIA.
- Если активна `chrome://extensions`, bsk падает `page frames cannot be observed`; переключитесь на web-вкладку или закройте chrome-вкладку.
- **Окна Chrome могут быть свёрнуты/перекрыты.** Перед UIA — `ShowWindow(SW_RESTORE)` + `SetForegroundWindow`; проверять `GetForegroundWindow`.
- **Кнопка расширения на панели** может называться `AI Context Monitor\n<tooltip>`; искать `-like "AI Context Monitor*"`, а не точное имя.
- **Попап** — отдельное окно 268x614. UIA видит offscreen-контролы, но клик по ним требует прокрутки; клик за пределами окна закрывает попап.
- **Тариф Gemini в попапе:** `<select id="gemini-plan">`; надёжно — `SetFocus` + стрелки (`Home`, `Down`), не `ValuePattern.SetValue` (no-op).
- **Экспорт:** кнопки `export-md`/`export-json` поддерживают `InvokePattern`; после клика Chrome открывает Save As — принять `Enter`, файл появляется в последней папке (у нас `tokenizer-calibration/exports`).
- **UIA-хелперы** (вне репозитория): `C:\Temp\opencode\` — `open-aicm-popup.ps1`, `dump-popup.ps1`, `click-at.ps1`, `capture-popup.ps1`, `send-keys.ps1`, `invoke-popup-button.ps1`.
---

## §12. ChatGPT 2026-11: композер, сообщения, console

- **Композер:** `#prompt-textarea` больше нет. Рабочий селектор —
  `div.ProseMirror[contenteditable]`. `bsk fill --selector "div.ProseMirror"` и
  `bsk press --selector "div.ProseMirror" Enter` работают.
- **Сообщения:** `[data-message-author-role]` больше нет. Роль видна по
  `[data-content-search-unit-key$=":user"]` и `...=":assistant"`.
- **Разные ключи JSON:** `bsk read --json` кладёт элементы в `items`,
  а `bsk console --json` — в `entries`. Парсер, который ждёт только `items`,
  молча получает пустоту.
- **REST-история:** `/backend-api/conversation/<id>` может отдавать 404
  `conversation_inaccessible`. Сетевой slug надёжнее брать из console:
  `[model-detect] путь=сеть, raw="gpt-6"`.
- **Выбора модели в UI нет:** в композере только «Размышление», вложения,
  диктовка, голос. `picker available: false` — это факт билда, а не сбой bsk.