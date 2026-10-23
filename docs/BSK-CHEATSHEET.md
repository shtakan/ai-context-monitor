# BSK-CHEATSHEET.md

**Назначение:** короткий справочник по BrowserSkill (bsk): подключение, команды, жёсткие лимиты перехвата, известные тупики и специфика сайтов, на которых проект уже работал.

**Область:** Chrome + расширение bsk 0.3.3, Windows-хост. Читается до первого вызова bsk в задаче; протокол выполнения — `docs/BROWSER-TASK-PROTOCOL.md`.

**В релизный ZIP не входит** (фильтр `\.md$` в `.github/workflows/release.yml:110`).

**Версия:** 1.0 (сформирован 2026-10-23 по итогам задачи m00001).

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
| `bsk_session start --browser <id> --no-focus` | новая сессия (`mnkk`), окно Agent Window |
| `bsk_session list` / `stop` | список / закрытие |
| `bsk_tabs list --scope user` | вкладки пользователя (id, url, active) |
| `bsk_tabs borrow <tabId>` | вкладка пользователя → в Agent Window |
| `bsk_tabs create url=…` / `select` / `close` | своя вкладка |
| `bsk_tabs return <tabId>` | вернуть вкладку пользователю |

Правило: одна задача — одна вкладка; все `bsk_*` вызовы идут с `tabId` этой вкладки.

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
- `budget` в `bsk_inspect` — до 262 144 байт JSON на ответ; `max_chars.max = 16384`.
- Следствие: тела `history_messages` (>80 KB) через перехват **не читаются**. Доказательства строятся по метаданным: `decoded_bytes`, `initiator`, имена запросов, `debug export` в файл (там тела тоже `truncated`, но структура и заголовки доступны).

---

## §6. Рабочий цикл перехвата

```text
bsk_inspect debug debugAction=start  (вкладка задачи, имя run-а)
→ действие: bsk_interact click target=@e61 / bsk_page reload
→ bsk_inspect debug debugAction=requests  (kind=business)
→ bsk_inspect debug debugAction=export output=<файл вне репозитория>
→ анализ в shell: python/jq/grep, в контекст ≤20 строк
→ bsk_inspect debug debugAction=stop
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
