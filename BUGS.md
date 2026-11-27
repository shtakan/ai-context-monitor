# BUGS — журнал дефектов

Правило: один дефект = один раздел `BUG-N` с полями «симптом / воспроизведение /
локализация / не виновен / влияние / следующие шаги». Дефект закрывается только
тестом или записью в приёмке, а не словами «починили».

---

## BUG-25 (OPEN, P2) — Qwen: финальный assistant не попадает в экспорт после F5 (`done=false`)

**Обнаружено:** 2026-11-27, live smoke 2.4 / PDF Firefox, чат
`https://chat.qwen.ai/c/ab45dc99-cbab-435e-b0d3-f0440f6422df`.

**Симптом.** Два экспорта одного чата расходятся:
- pre-F5 JSON: 56 сообщений, финальный ответ `Маркер: MARKER-7F3A9C` есть,
  но PDF-вложения (`[FILE:]`/`files[]`) нет;
- post-F5 JSON: 55 сообщений, PDF-вложение и `[FILE:]` есть, финального
  assistant нет;
- родной `chat-export-1795778412430.json` Qwen в 16:20 тоже содержит
  последний assistant с `content=""`, `content_list=null`, `done=false`.

**Воспроизведение.** Qwen-чат → получить ответ → экспорт JSON/MD → F5 →
дождаться виджета → повторный экспорт. Сравнить последние сообщения.
Симптом не зависит от Firefox: это состояние истории Qwen на момент экспорта.

**Локализация.** История Qwen/её персистенция: узел assistant ещё не финализирован
(`done=false`). Наш экспорт читает историю как есть; Stage 9 и PDF-мост не виновны
(в post-F5 прогоне pdf.js-fallback отработал корректно).

**Не виновен.** `content.ts` Stage 9, `core/qwen-files.js`, Firefox
`AiCmPdf.fromUrl`, Qwen JSON sanitization.

**Влияние.** P2: экспорт сразу после ответа + F5 теряет финальный ответ; экспорт
только до F5 теряет текст вложения. Обход: экспортировать после финализации
истории или объединять pre/post-F5 артефакты.

**Следующие шаги.** Проверять `done`/`content_list` перед экспортом; при
`done=false` — короткий retry/ожидание; рассмотреть merge последнего живого
assistant с post-F5 вложением; добавить диагностическую строку
`qwen-history done=false` и live-пин.

---

## BUG-12 (CLOSED, P1 — роли fixed, счёт закрыт через BUG-13) — AI Studio: экспортная проекция теряет ходы и путает роли после `[FILE:]`

**Обнаружено:** 2026-11-20, живая приёмка 2.2 (`acceptance/BIG-2026-11/2.2/`), тред
`1gHphBl1b-Km9KknOAD5t2fJ3mfec8T3g`.

**Симптом.** JSON-экспорт содержит 31 сообщение (17u/14a, `roleHash=6b78c64a`), тогда как
dual-run в тот же момент на том же треде видит 33 (17u/16a). Роли разъезжаются после
файлового узла:

```text
23 assistant  «Пожалуйста, файл экспорта во вложении. [FILE: [LOG]…»   ← писал пользователь
27 assistant  «Продолжай»                                              ← ход пользователя
28 user       «Если вы планируете довести до идеала обработку вложений…» ← ответ модели
29 user       «Давайте добьём до совершенства…»                         ← ответ модели
30 user       «Развивая тему архитектурной надежности…»                 ← ответ модели
```

В DOM эти же ходы подписаны «Model» (11:31/11:34/11:43), т.е. подпись в файле неверна.

**Воспроизведение.** Тред с файловым узлом `[FILE: …]`; попап → «Экспорт JSON» дважды
(флаг v2 включён и выключен) — оба файла совпадают канонически (`K1 equal`,
`K2 equal`, 31 msg), т.е. дефект стабилен и от флага не зависит.

**Локализация.** Экспорт не идёт через `adapter.extractMessages`:
`core/content.ts:3537` (`message.type === 'aiCmExportCurrent'`) → `buildHistoryMessages()`
поверх live-состояния (`lastBaseTexts`/`turnsMap`, наполняется из перехвата и
`aiCmFlushLiveStreamForExport`). Dual-run сравнивает адаптер-DOM с v2-каноном, поэтому
дефект проекции он принципиально не видит.

**Не виновен.** Канон `utils/messages` (dual-run на том же треде: `oldHash === newHash`,
`oldRoleHash === newRoleHash`); флаг `aiCmV2Messages` (flagoff/after2 канонически равны).

**Влияние.** Пользовательский экспорт (JSON/MD/TXT) отдаёт неверные роли и теряет 2 хода —
ломает внешний разбор истории и сверку токенов. Включение `messages` по умолчанию для
AI Studio заблокировано до триажа этого дефекта.

**Фикс-кандидат (2.2, `4685c57`).** `aiCmApplyAistudioNetBase` теперь заполняет
`lastDetailMessages` ролями того же снимка (`aistudioDetailMessages(snap)`), поэтому
`aiCmCollectExportSource` не падает в чётностный фолбэк. Регресс:
`tests/aistudio-export-roles.test.js` (3). Вызов — в одну строку, line-based
`catch-whitelist` не сдвинут. Нужен live K6 retest: ожидается 31 сообщение с ролями
источника после схлопывания дубля #19/#20.

**K6 retest (2026-11-20, DSH): ROLES-FIXED.** Источник 33 (17u/16a,
`roleHash 04cb5718`); экспорт 29 (15u/14a, `bbfb5fc4`), роли —
**строгий префикс** источника, `uuu` нет: #20 user, #28 «Продолжай» user,
#29 assistant (три раздробленных узла склеены в один, текст 9 936 сохранён).
Роли закрыты. Счёт 29 vs 33 **не приписан проекции**: экспорт снят в
08:47:56Z, источник — после F5 в 08:49:55Z (console: `history loaded msgs=33`);
в файле `partial` отсутствует. Нужен K6c: F5 → дождаться `history loaded
msgs=33` → экспорт **после** этого → сравнить 33/33. Если снова 29/33 —
отдельный дефект неполного снимка/хвоста (кандидат BUG-13), не BUG-12.

**Триаж K6 (DSH, 2026-11-20).** PROJECTION-ROLES: источник 33 (17u/16a,
`roleHash 04cb5718`), экспорт 31 (17u/14a, `6b78c64a`), первый сдвиг #20.
Артефакты: `acceptance/BIG-2026-11/2.2/BUG12-TRIAGE.md`,
`.../raw/bug12-k6.json`.

**Следующие шаги.**
1. BUG-12 роли закрыты живым K6 (ROLES-FIXED); регресс `aistudio-export-roles`.
2. Хвост 29/33 — отдельный BUG-13 (ниже): подтвердить «duplicate vs unique»,
   затем либо закрыть как работу дедупа, либо чинить базу/`turnsMap`.

**Закрыт (2026-11-25):** роли — K6 ROLES-FIXED; счёт закрыт в BUG-13
(K6e BOUNDARIES-FIXED + файловый дубль, live R2). Открытых пунктов нет.

---

## BUG-13 (CLOSED, P2 — границы ответов + файловый дубль) — AI Studio: экспорт 29 при источнике 33 после F5

**Симптом.** После F5 и `history loaded msgs=33` ручной JSON-экспорт даёт
**29** сообщений (15u/14a), роли — строгий префикс источника, `partial` в файле
отсутствует. Источник dual-run: 33 (17u/16a), `bodyHash 04fe16db:127080`;
экспорт 109 180 симв. Разница 17 900 симв. (4 сообщения #30–#33).

**Улики.** `[AI CM][turnsMap] snapshot-at-manual msgs=29 … baseComplete=0
reachedStart=false scrollEngaged=false`; `o40-emit-entry msgsIn=29 msgsOut=29`
при net-каноне 33 за 34 с до этого. `K1` fix.json vs fix-after-f5.json equal —
F5 не меняет экспорт.

**Триаж (DSH, 2026-11-20): DUPLICATE-DEDUPE.** 4/4 отсутствующих текста
MATCH в export #29 (смещения 0/2657/5923; хвост #29 = хвост #4). #29 —
три ответа, склеенные в один (9 936 = 2 739+3 394+3 308); два дубля
user-файлов (#30/#32) убраны дедупом. Потери уникального текста нет;
дефект — границы ответов + политика dedupe. DOM: user-узлы не
отрендерены (`user-chunk=0`), потому дубльность #30/#32 — вывод из
арифметики (средняя уверенность).

**Фикс (2.2).** `aiCmDedupeExportSource`: `aiCmMergeAssistantRuns` теперь
выполняется **до** `prepareExportMessages`, а не после. Дубли user
удаляются уже после склейки сегментов, поэтому три разных ответа,
разделённые дублями user, не превращаются в один. Регресс:
`tests/aistudio-export-boundaries.test.js` (2). Source-пины Gemini/O41
обновлены на новый вызов (порядок `prepareExportMessages` → `dedupeMessages`
сохранён).

**K6e (2026-11-20, DSH): BOUNDARIES-FIXED.** Экспорт 31 (15u/16a),
`roleHash 41f90d7a`, roles `…auuu`→ хвост `aaa`: #29/#30/#31 — три
assistant (2 885/3 553/3 494), сумма 109 176; `#29_old === #29+#30+#31.join("\n\n")`.
K1/K2 против 29 — DIFF ожидаемо (29→31).

**Dedupe-маркер.** `manualSnapshot.dedupe` и `buildJsonFromHistory` теперь
пишут `{input, output, removedUsers, foldedAssistants}` только при изменении
счёта (33→31: removedUsers=2, foldedAssistants=0); иначе ключ не появляется.
`partial` не ставится: текст полный, удалены дубли. Регресс:
`tests/aistudio-export-dedupe.test.js` (4).

**Остаток закрыт (2026-11-21):** #19/#20 (17 540 + 88, файловый user-дубль)
схлопывается узким правилом `prepareExportMessages`:
`collapseFileUserDuplicates` включён только для `aistudio`; короткий user
удаляется, если он точно равен тексту перед `\n\n[FILE: ` в rich-ходе и не
несёт своих секций. На живом `fix-boundaries.json` — 30 (14u/16a), `#19`
сохранён, `#20` снят; маркер `dedupe {33→30, removedUsers:3}`. Регресс
`tests/aistudio-export-dedupe.test.js` (+5). **Live R2
(`AISTUDIO-REATTACH-OK`):** после пере(вставки) файла
`aistudio-…19-03.md` тело доехало побайтово (36 952 B, sha
`a595e8e8…`), старые 30 сообщений целы, новый ход +2 → 32 (15u/17a),
`dedupe {35→32, removedUsers:3}`, tokens 47 412 / 37 %, `partial` нет.
Ранее наблюдавшийся `AISTUDIO-FILEDUP-LOSS` (тело 22 817) — внешняя
потеря контента Google, не коллапс и не фильтр экспорта.

---

## BUG-14 (FIXED, P2) — AI Studio: автоэкспорт не планировался ни на одном чате

**Симптом.** 2026-11-20 ~18:34, тред `1gHphBl1b-Km9KknOAD5t2fJ3mfec8T3g`:
виджет 39 404 / 128 000 (30.9 %), автоэкспорт включён, порог 10 %, формат md;
файла автоэкспорта нет. JSON скачан вручную
(`raw/ai-context-monitor-aistudio-…-18-34.json`, 31 сообщение, dedupe 33→31).

**Триаж (DSH): GATE-BUG, подвид `not-scheduled`.** В консоли нет ни одной
строки `[AI CM][auto-export]` ни на старом треде (30.9 % > 10 %), ни на
свежем чате (1.4 %): даже `skip reason=below-threshold` не печатался.
Латч-ключей нет (файла не было ни разу), конфиг корректен, сборка эталонная.

**Корень.** Обе точки планирования недостижимы на AI Studio:
`ai-cm-full-history` платформа не диспатчит (эмитят только perplexity/
claude/google-search), а adapter-ветка в `processAndSend` закрыта флагом
`!baseSeen`. Сеть принимает базу раньше через `aiCmApplyAistudioNetBase()`
(`baseSeen=true`, `baseComplete`), но планировщик оттуда не звался.

**Фикс (2.2).** `aiCmAfterAistudioNetKick()` после `processAndSend()` (когда
`lastPercentage` уже пересчитан по сетевой базе) вызывает
`aiCmScheduleAutoExport(lastPercentage)`. Дебаунс 500 мс и все гейты
порога/полноты/латча остаются в `maybeAutoExport`. Регресс:
`tests/aistudio-autoexport-schedule.test.js` (3: порядок process→schedule,
достижимость из ingest, base-before-kick).

**Не виновны:** one-shot латч (ключей не было), `below-threshold`
(30.9 % > 10 %), dedupe-маркер (manual JSON 33→31, роли `…aaa`), BUG-12.
Артефакты: `acceptance/BIG-2026-11/2.2/BUG14-TRIAGE.md`,
`raw/autoexport-old-thread.log`, `raw/autoexport-fresh-thread.log`.

**Ретест (DSH, 2026-11-20 19:06): `AUTOEXPORT-FIRED`.** Сборка 329 541 B,
sha256 `efca1631…`. `auto-export-decision verdict=fire reason=threshold pct=30.9`
(`baseSeen=1 baseComplete=1 msgs=33`), `[AI CM][auto-export] fired … file=…md`,
0 строк `skip reason=`; `o40-emit-entry msgsIn=31 msgsOut=31`, хвост `aaa`,
31 (15u/16a). BUG-14 закрыт.

**Паритет dedupe (2.2).** Авто-путь теперь пишет тот же
`dedupe:{input,output,removedUsers,foldedAssistants}` в JSON-`hist`
(источник — `lastDetailMessages`, гейт платформы живёт в `content.ts`,
`export-manager` по-прежнему не знает имён площадок). MD/TXT байтово
не меняются: маркер печатает только JSON-сборщик. Регресс:
`tests/aistudio-export-dedupe.test.js` (+3).

## BUG-15 (CLOSED-ENV, P3) — авто-файл не финализировался в Downloads (CDP)

**Симптом (DSH, 2026-11-20 19:06).** После `fired` в Downloads остался только
Chrome-temp `f2a294ac-….tmp` (138 955 B, полный md-payload, H1 на месте);
финального `.md` нет, `chrome://downloads`/History за 19:06 пусты.

**Уточнение по коду.** «Два триггера на одно имя» — это ДВЕ диагностические
строки одного скачивания, не два старта: `export-manager` печатает
`trigger=autoexport mime=md` перед стартом, `downloadBlob` — ту же строку с
`mime=text/markdown`. Фактический старт один (`aiCmAutoExportStartDownload`
→ `downloadBlob` → один `a.click()`), реестр имён резервирует имя один раз.

**Вероятная причина (сильная).** Имя temp-файла — UUID + `.tmp`, а не Chrome
`.crdownload`. Это подпись CDP-перехвата загрузок (`Browser.setDownloadBehavior`
с `allowAndName`/`eventsEnabled`): браузерный automation-слой сохраняет payload
под GUID и НЕ переименовывает в исходное имя. Payload полный (138 955 B ≈
87 070 симв. UTF-8), т.е. расширение отдало корректный файл; финального `.md`
в такой среде не будет по дизайну стенда.
**Ретест (2026-11-21, обычный Chrome): DOWNLOAD-OK.** Ручной JSON
`ai-context-monitor-aistudio-Gemini-3.8-Flash-2026-11-21-09-27.json` и
авто-MD `aistudio-1fXwxER1-2026-11-21_09-33.md` появились финальными
файлами; `chrome://downloads` — Complete. Лог:
`[AI CM][auto-export] fired convId=1fXwxER1… pct=1 file=…09-33.md
textLen=300 histSource=memory baseComplete=1`, затем `skip reason=already-fired`.
**Вывод:** причина — CDP `allowAndName`, не расширение. BUG-15 закрыт как
ENV; код не менялся. **Не виновны:** BUG-14 и dedupe-маркер.

---

## BUG-16 (FIXED, 2.2 phase 2 dual-run) — readiness: derived подан как факт

**Симптом (F1 живого dual-run, 2/2 reload):** base-чтение, посчитанное по
символам, при `quality=derived` получало `readiness=settled`. На раннем
reload — 627 токенов при фактических 3 228 (badge 0.5 % вместо 2.7 %), 683
при 3 484; `msgs=24 textLen=1977 baseTextLen=1977 baseComplete=1` совпадали,
различалось только число.

**Корень.** `utils/metrics/readiness.ts:readinessForReading` давал `settled`
по `coverage='full' + complete=true` без проверки точности чтения: derived
(оценка по символам) и floor неотличимы от exact/reported.

**Фикс.** `derived` и `floor` → всегда `provisional`; `settled` — только
`exact` (native) или `reported` (server) при полном покрытии и complete=true.
`quality=derived` остаётся честным (это не exact). Регресс:
`tests/metrics-seam.test.js` (+ F1-кейс 683/complete → provisional).
**Живой путь не менялся** (флаг `aiCmV2Metrics` off): это готовность нового
шва, не поведение 2.1.5. Ретест: T1/T10-ранний → `derived/provisional`.

---

## BUG-17 (ЗАКРЫТ: THREAD-STATE, наблюдение) — AI Studio: тело файла не в текущей базе

**Симптом (live 2026-11-21):** в экспорте 31/15u16a/`aaa` user #26 — 60
символов (`[FILE: aistudio-…-11-08_19-03.md]`) вместо 22 882; сумма текста
86 354 вместо 109 176, токены 39 604 (30.9 %) вместо 46 459 (36.3 %).

**Не шов messages:** ON и OFF дают идентичный документ; тот же 86 354 был в
legacy-экспорте 18:34 (до default-коммита) и в md 09:03. Значит, тела файла
нет уже в текущем снимке базы/сети, а не потеряно при канонизации.

**Триаж (следующий, отдельно):** открыть тред, заново прикрепить файл,
дождаться дренажа вложений (`[AI CM][aistudio] files…`), F5 → экспорт:
ожидание 22 882 + сумма 109 176. Если тело снова 60 — дефект file-drain
AI Studio, не messages. **Не виновны:** messages default, BUG-13/14,
dedupe-маркер.

**Ретест (live 2026-11-21, dist 2.1.5/2.2).** Свежий чат
`1PouheUR5Lw6BdCtYkv5SFz9HWg2ZqsBy`, файл `bug17-marker.txt` (2731 B / 1916 симв.),
ответ `OK`, 560 tokens. Дренаж: `aistudio-files-fetch-done … len=1916`,
`textLen 41 → 1984`, `DRAW effectiveLen=1984`, `histKey=2|1984 verdict=write`;
после F5 тело восстанавливается повторным drain. Экспорт
`acceptance/BIG-2026-11/2.2/raw/bug17-body.json` (3145 B): user #0 = 1981 симв.,
`[FILE: bug17-marker.txt]` + `BUG17-MARKER-2026-11-21` (поз. 65) + тело 1916 симв.
целиком. **Вердикт: THREAD-STATE** — file-drain на свежем вложении работает;
60-символьный случай 31/15u16a/`aaa` — состояние старого треда (вложение в снимке
без тела), не дефект дренажа/messages. Отчёт: `BUG17-RETEST.md`.

---

## BUG-18 (FIXED, P3) — AI Studio: бейдж держал значение прошлого треда

**Симптом (live 2026-11-21, скрины):** переход в новый чат
`/prompts/new_chat` — бейдж показывает **30.9 %** от предыдущего треда;
после первого ответа/второй реплики — 2.4 % (3 080 / 128 000). То есть до
первого замера нового чата на экране живёт старое число.

**Вероятный корень.** `resetConversationState()` очищает бейдж в `—`, но на
AI Studio событие `ai-cm-conversation-changed` не диспатчится (его шлют
deepseek/perplexity/claude/page-intercept, не aistudio-intercept), а
content-side проверки URL нет. Пока не пришёл первый `ai-cm-aistudio-net`
с новым convId, `processAndSend` не вызывается — старый DOM-текст остаётся.

**Фикс (2.2).** `core/aistudio-intercept.js` (MAIN) патчит
`history.pushState/replaceState` и слушает `popstate`: при смене
`location.pathname` шлёт `ai-cm-conversation-changed`. Content-слушатель уже
существует — он вызывает `resetConversationState()`, который рисует `—`,
гасит снимок/базу/латчи прошлого треда. Событие только на реальную смену
пути (query-шум и повтор того же path — ноль событий). Регресс:
`tests/adapters/aistudio-network.test.js` (2: pushState/replaceState/popstate,
дедуп пути). **Не виновны:** messages default, metrics (числа после замера
верные), BUG-14.

**BUG-19 (FIXED, a11y).** После сброса текст бейджа был `—`, но `aria-label`
держал процент прошлого треда. `resetConversationState()` теперь вызывает
`aiCmResetWidgetA11yLabel`: исходное доступное имя
`content_a11y_circle_initial` («Открыть панель порога контекста»). Регресс:
`tests/widget-reset-a11y.test.js` (3).

**Live-подтверждение (2026-11-21): BUG19-A11Y-OK.** До первого замера label
«Открыть панель порога контекста»; переход из чата 0.4 % в `/prompts/new_chat`
сбрасывает label в исходный (до reload расширения держался «0.4 %» — несвежая
сборка); после первого ответа нового треда (43 токена) label несёт его процент:
«AI Context Monitor: 0.0 % контекста использовано, норма». Отчёт: `BUG17-RETEST.md`.

---

## BUG-20 (FIXED, P3) — AI Studio: модель в JSON ≠ модель на бейдже

**Симптом (live 2026-11-21, `bug17-body.json`):** в шапке JSON
`"model": "Gemini 3.1 Pro"`, а виджет того же хода показывает
`Gemini 4 Hydrogen` (тред `1PouheUR5…`, файл-маркер, 560 tokens).

**Вероятный корень.** Ручной снимок берёт
`lastSnapshotModelName || lastResolvedModelId`, авто-путь —
`ModelConfig.getModel(lastResolvedModelId)?.name`, а бейдж — `modelName`
зафиксированного `lastTokensSnapshot`. Это три разных источника: если
`resolveCurrentModel()` прошёл до прихода network-слага (`gemini-4-hydrogen`),
`lastSnapshotModelName` остаётся старым (`Gemini 3.1 Pro`), хотя следующий
проход уже обновил бейдж.

**Фикс.** Ручной снимок и авто-`hist` берут `modelName` из ТОГО ЖЕ
зафиксированного снимка, что у бейджа:
`(snapPartMan && snapPartMan.modelName)` / `(snapR1Auto && snapR1Auto.modelName)`;
прежние `lastSnapshotModelName`/каталог остаются фолбэком. Регресс:
`tests/export-model-name-snapshot.test.js` (3: ручной source-пин, авто
source-пин, JSON-сборщик печатает переданную модель).
**Не виновны:** BUG-17 (THREAD-STATE) и file-drain. `site`/`convId` в JSON
не печатаются схемой `buildJsonFromHistory` — это не дефект модели.

**Live (2026-11-21): MODEL-PARITY-OK.** Manual: тред `1gHphBl1b…`, бейдж
`Gemini 3.8 Flash` → JSON `.model="Gemini 3.8 Flash"` (39 604 / 30.9 %).
Auto: чат `1fFVoDy9…`, бейдж `Gemini 4 Hydrogen` → JSON
`.model="Gemini 4 Hydrogen"` (1 545 / 1.2 %, src=server). `[model-detect]`:
`raw="gemini-4-hydrogen" → id=gemini-4-hydrogen, имя=Gemini 4 Hydrogen`;
слаги `gemini-3.8-flash` / `gemini-4-hydrogen`. Ни один путь не отдал
«Gemini 3.1 Pro». BUG-20 закрыт.

---

## BUG-21 (CLOSED-ACCEPTED, P3 — кандидат на 2.3) — ChatGPT: транзиентный GPT-5.5 до сетевого снимка

**Обнаружено:** 2026-11-24, приёмка 2.2.0
(`acceptance/BIG-2026-11/2.2/HANDOFF-2.2.0-FINAL.md` §5.3), ChatGPT 2026-11.

**Симптом.** До прихода сетевого снимка детектор читает заголовок чата
`"DeepSeek Harness "` как ярлык модели. Строка не распознаётся, и
`resolveCurrentModel` уходит в дефолт сайта — `gpt-5.5`; бейдж/попап на это
время показывают GPT-5.5. Сетевой снимок затем исправляет модель на `gpt-6`,
проценты пересчитываются.

**Воспроизведение.** Открыть чат, заголовок которого начинается с
«DeepSeek Harness», и смотреть `[model-detect]` до сетевого снимка: ожидается
`raw="DeepSeek Harness " → id=gpt-5.5` (путь `DOM→дефолт(не распознан)`),
затем `raw="gpt-6" → id=gpt-6`.

**Локализация (вероятная).** `adapters/chatgpt-adapter.ts:378` (`detectModel`):
регэксп `:381` содержит ветку `DeepSeek[\s\-A-Za-z0-9]*`, а селекторы
`nav button` / `header button` (`:387-388`) захватывают заголовок чата;
`core/content.ts:1901` при нераспознанном DOM-сырье берёт
`ModelConfig.getDefaultModel('chatgpt')` → `gpt-5.5`
(`utils/model-config.ts:578`).

**Не виновен.** Сетевой детектор (приносит `gpt-6` и перекрывает дефолт),
каталог лимитов, экспорт сообщений.

**Влияние.** Кратковременное: до сети бейдж/попап могут показать чужую модель.
Если снимок/экспорт случится в это окно, в файл может попасть `gpt-5.5`;
живого файла с таким значением не зафиксировано.

**Следующие шаги.** Кандидат на фикс: не считать заголовок чата моделью —
искать только в контроле выбора модели (`data-testid="model-switcher*"` /
aria-label модели) либо не подставлять `siteDefaults` при нераспознанном
DOM-сырье, дожидаясь сети. Нужен живой ретест с логом и решение владельца;
на 2.2.0 не блокер.

**Решение (2026-11-25): CLOSED-ACCEPTED, в 2.2.x не чиним.** У `gpt-5.5` и
`gpt-6` одинаковые окно (1 050 000) и действующий порог ChatGPT (128 000),
поэтому транзиент меняет только имя модели и самоисправляется сетевым снимком.
Кандидат на 2.3; переоткрыть только при причине: разные лимиты, жалоба или
экспорт, попавший в окно транзиента.

---

## BUG-22 (CLOSED, P1) — Qwen: бейдж застревает на 0.4 % при полной базе 118.6 %

**Обнаружено:** 2026-11-26, живая приёмка 2.3, тред
`chat.qwen.ai/c/56131c00-7acb-4314-9223-47ba1b9b4ed0` (278 узлов, 269 сообщений).

**Симптом.** После догрузки полной истории бейдж/тултип показывают
`0.4 % / 3 761`, тогда как метрика в той же отрисовке — `118.6 % / 1 186 448`.
Экспорт JSON/MD/TXT при этом содержит правильные `1186448 / 1000000 (118.6%)`
и 267 сообщений после дедупа, то есть расходятся именно бейдж и файл.

**Воспроизведение.** Открыть длинный Qwen-тред, дождаться `event=full-history`
(сеть отдаёт 269 сообщений), затем F5. В консоли на одной отрисовке:

```text
14:16:08.481 gsa-metric-src site=qwen src=base-complete ... tokens=1186448 baseComplete=1
14:16:08.481 [ctx-snap] skip reason=no-canonical-body
14:16:08.482 [AI CM][trace] badge-update pct=0.4% tokens=3761 model=Qwen3.7-Plus
14:16:08.483 qwen-badge event=badge-update reason=draw pct=118.6 tokens=1186448
             baseComplete=1 netBaseMsgs=269 baseCount=269
```

**Локализация.** `core/content.ts:2594`: аддитивные поля снимка
(`chars/msgs/bodyHash/baseComplete`) писались только при `body.text === effective`
или для `aistudio`. У Qwen DOM-тело не совпадает с сетевым `effective`,
поэтому `bodyHash` не выставлялся, и `core/state.ts:911`
(`collecting = … || !next.bodyHash`) считал коммит «окном сбора»: возвращалась
копия прежнего снимка (21 сообщение, 3 761 токен), а `updateWidget` рисовал её.
Живые `maxTokenCount`/`snapshotPercentage` при этом уже были 1 186 448 / 118.6 %.

**Не виновен.** Сетевой перехват Qwen (269 сообщений, `serverTokens=0`),
экспорт (файл верный), commit-хелпер (его поведение по контракту), дедуп.

**Влияние.** P1 для доверия к бейджу: на длинных Qwen-тредах пользователь видит
заниженный процент (0.4 % вместо 118.6 %) и не получает предупреждения о
переполнении; попап/файл при этом показывают правильные числа.

**Фикс (2026-11-26, `core/content.ts:2594`).** Условие публикации аддитивных
полей расширено на `qwen` при `baseSeen && baseComplete && fullText`;
`bodyHash` для Qwen — `qw` + `aiCmDiagHash6('qwen', fullText)`, для AI Studio
поведение прежнее (`ai` + hash6). Коммит перестаёт быть «окном сбора», бейдж
получает тот же снимок, что попап и файл.

**Проверка.** Нужен live retest: `npm run build:prod` → reload unpacked `dist` →
открыть тред → F5 → ожидается бейдж `118.6 %` и тултип `Токены: 1 186 448`,
попап/файл без изменений. До ретеста статус FIXED, не CLOSED.

**Live retest (2026-11-26, Chrome 158, `dist` после `build:prod`): CLOSED.**
После reload расширения и F5:

```text
15:28:15.359 qwen-history event=full-history chat=56131c00
15:28:16.393 badge-update pct=118.6% tokens=1186448 model=Qwen3.7-Plus
15:28:16.393 qwen-badge event=badge-update reason=draw pct=118.6 tokens=1186448
             baseComplete=1 netBaseMsgs=269 baseCount=269
```

Бейдж/тултип: `118.6 %`, `Токены: 1 186 448`, зона «критично»; совпадает с
`badge-update` и с экспортом JSON/MD/TXT (`1186448 / 1000000 (118.6%)`).
Повторная отрисовка через 25 с — те же значения. Наблюдение на 2.4:
строка `[ctx-snap] skip reason=no-canonical-body` всё ещё печатается, хотя
коммит теперь принимается через net-fallback — ярлык в логе вводит в заблуждение.

---

## BUG-23 (CLOSED, P1) — Qwen: в экспорт попадает синтетический ход, порядок сообщений не совпадает с чатом

**Обнаружено:** 2026-11-26, живая приёмка 2.3, тот же тред
`chat.qwen.ai/c/56131c00-7acb-4314-9223-47ba1b9b4ed0`.

**Симптом.** В экспорте (`qwen-56131c00-2026-11-26_15-10.md`, JSON 14-56) две
assistant-реплики подряд в конце:

```text
idx 265 assistant «Коммит принят. Текущий статус проекта: … Жду команду.»
idx 266 assistant «Мы в корне проекта, а Cargo.toml лежит в src-tauri.
                   Переходим в правильную директорию: …»
```

В чате последняя реплика — только idx 265 («…Жду команду.»), сообщения idx 266
в ленте нет (проверено снимком VOM внизу треда). То есть в файле лишний ход
в конце; порядок не соответствует UI.

**Воспроизведение.** Открыть тред, дождаться `event=full-history` (269
сообщений), сделать экспорт. В файле после «Коммит принят…» появляется
«Мы в корне проекта… Переходим…».

**Собранные факты.**

- `window.__aiCmQwenBridge.turns()`: 135 ходов, `order` 0…134 без пропусков.
  - order 133 = `key 18ff9889`, text «Коммит принят…»;
  - order 134 = `key b517de75`, `userKey = "h:b517de"` (синтетический ключ),
    text «Мы в корне проекта… Переходим…».
- В логе владельца `responseId=b517de75` встречается ещё в раннем снимке
  `14:15:43 qwen-emit conv=56131c00 count=21` — тот же id, но другой момент.
- `core/qwen-intercept.js:923`:
  `userKey: pendingUserKey || (msg.key ? ('h:' + msg.key) : …)` — assistant без
  пары user получает ключ `h:` и становится отдельным ходом в конце.
- `core/qwen-intercept.js:777` режет `offChain`-узлы, но этот узел off-chain
  не помечен; `qwenParseFullChain` (2054–2059) дописывает узлы вне цепочки в
  конец и помечает их только при непустом `truncated === false`.

**Локализация (гипотеза).** Либо `history.currentId` указывает на
неактуальный лист (`b517de75`), либо цепочка собрана с `truncated`, поэтому
off-chain не проставлен, и «хвостовой» узел уходит в конец. Нужен дамп
payload: `history.currentId`, длина цепочки, `truncated`, число `offChain`,
последние 3 id цепочки.

**Не виновен (предварительно).** Бейдж/метрики (BUG-22 закрыт, 118.6 %
совпадает), дедуп пользовательских сообщений (он удалил 2 user-реплики, но
лишний ход — assistant), сетевой счётчик сообщений (269).

**Влияние.** P1 для экспорта: файл содержит несуществующий в UI ход и
ломает соответствие «чат ↔ файл»; при разборе истории появляется ответ,
которого пользователь не видел.

**Следующие шаги.** Добавить диагностическую строку в `qwenParseFullChain`
(currentId/chain/truncated/offChain/last ids), снять payload на этом треде,
затем: не включать в `turns` assistant без user-пары, если его узел не в
активной цепочке; при `truncated` не дописывать extras в конец, а помечать
`offChain` и резать. После фикса — live retest: экспорт должен заканчиваться
на «Коммит принят…», 267 сообщений без лишнего хвоста.

**Диагностика (2026-11-26).** Добавлена строка `qwen-chain`. На треде:

```text
# первая страница: cur=18ff9889 chain=20 total=21 extra=1 truncated=1 off=0
#                  tail=6cfd63e3,18ff9889,b517de75
# полная история:   cur=18ff9889 chain=268 total=278 extra=10 truncated=0 off=10
#                  tail=e064c36a,ef7fd908,b517de75
```

Причина: усечённая первая страница (`truncated=1`) дописывает `b517de75`
в конец **без** off-chain, из него создаётся ход `h:b517de`; при приёме полной
истории (`truncated=0`, `off=10`) старый ход не удалялся — `reindexByChain`
только перенумеровывает.

**Фикс (2026-11-26, `core/qwen-intercept.js`).**

- `qwenParseFullChain`/`parseQwenHistory` возвращают `truncated`;
- history-ходы помечаются `fromHistory = true`;
- при полной истории (`chain=1`, `truncated=0`) удаляются history-ходы, которых
  нет в активной цепочке; живой SSE-ход и `file-only` заглушки не трогаются.

**Live retest (2026-11-26 15:34, Chrome 158, reload + F5 + scroll to top):
CLOSED.** `qwen-chain` — `chain=268 truncated=0 off=10`; `turns()` — 134 хода
(было 135), `b517de75` отсутствует, последний ход `18ff9889` «Коммит принят…».
Свежий экспорт `ai-context-monitor-qwen-Qwen3.7-Plus-2026-11-26-15-34.md`:
266 сообщений, последнее — «Коммит принят… Жду команду.», вхождений
«Переходим в правильную директорию» — 0, токены `1186363` совпадают с бейджем.

**Остаток (BUG-24, кандидат).** В файле ещё две пары `ASSISTANT → ASSISTANT`
(индексы 90 и 109): похоже, глобальный дедуп (`removedUsers=2`) снял реальные
повторные user-реплики, потому что в чате есть подряд идущие user-сообщения
(`hasAdjacentUserCopy`) и дедуп включается на весь диалог. Требует отдельного
разбора: удалять только соседние копии, а не любые повторы.

---

## BUG-24 (CLOSED, P1) — Qwen: в экспорте теряются два user-сообщения (сверка с нативным экспортом)

**Обнаружено:** 2026-11-26, живая приёмка 2.3, тред
`chat.qwen.ai/c/56131c00-7acb-4314-9223-47ba1b9b4ed0`.

**Эталон.** Нативный экспорт Qwen (`chat-export-1795690751361.json`, кнопка
«Экспорт чата (.json)») содержит **268 сообщений, строго U/A, 134 user +
134 assistant**, `currentId=18ff9889…`, последнее — «Коммит принят…».

**Симптом.** Наш MD (`ai-context-monitor-qwen-…-15-34.md`) — **266 сообщений
(132 user + 134 assistant)**, две пары `ASSISTANT → ASSISTANT`. Сопоставление
всех 134 assistant по порядку — **0 расхождений**, то есть порядок верный,
потеряны ровно два user-хода:

1. gap 45 — `Cargo.toml:20:tauri-plugin-window-state…` (в нативном это
   сообщение есть дважды: gap 45 и gap 58; у нас остался только gap 58);
2. gap 55 — `Индекс находился вне границ массива…` (в нативном одно, у нас нет).

**Что уже проверено (2026-11-26, live F5 + полная история):**

- `lastParsed()`: 268 сообщений, 134 user + 134 assistant; оба ключа
  (`3503b27c…`, `cafa7faa…`) присутствуют с длинами 147 и 417;
- `userTurns()`: 134 записи, оба ключа присутствуют с теми же текстами;
- `turns()`: 134 хода;
- прогон `prepareExportMessages` на **нативном** массиве (Node, реальный
  пайплайн): 268 сообщений, 134 user, `removed=1`, цель не теряется;
- `aiCmDedupeExportSource` для qwen вообще не вызывает пайплайн (не gemini/
  aistudio) — возвращает сообщения как есть.

**Вывод.** Парсер, `userTurns` и дедуп не виновны. Потеря происходит в
`aiCmCollectExportSource()` / сборке `lastBaseTexts` для Qwen — до дедупа.
Нужен дамп выхода `aiCmCollectExportSource()` (сколько сообщений, какие роли,
есть ли оба текста) и правка сборки: для Qwen собирать файл из `turns` +
`userTurns` (они полны), а не из снимка базы.

**План (согласован с владельцем).**

1. Сейчас (2.3): дамп `aiCmCollectExportSource()` → точечный фикс сборки →
   повторный экспорт, сверка: 268 сообщений, 134/134, strict U/A.
2. 2.4: «нативный режим экспорта» — общий интерфейс `nativeExport(adapter)`:
   активная цепочка от листа (`parentId`/`currentId`), общий сборщик порядка,
   поверх — наши обогащения (reasoning, вложения, метрики). Qwen — первый,
   затем ChatGPT (`mapping`/`current_node`), DeepSeek (`chat_messages`/
   `parent_id`), Claude/Perplexity/GSA. Эталон для приёмки — нативный JSON Qwen.

**Замечание владельца.** Нативный экспорт длинного треда формируется ~30+ с;
при следующем прогоне можно снять network/console в момент генерации, чтобы
уточнить механизм (какие запросы/пагинация используются).

**Диагностика и защита (2026-11-26, в работе).**

- `core/export-manager.ts`: добавлена строка `qwen-export-source` — на выходе
  точки сбора печатаются `msgs/users/assistants/runs` и наличие обеих спорных
  реплик (`hasCargo20`, `hasIndexError` по ASCII-маркеру `$lines[20]`).
  Та же строка печатается для ручного источника (`canonical`).
- `core/qwen-intercept.js`: снимок теперь считает `missingUserBlocks` — ходы с
  `userKey`, но без user-блока (нет текста и нет секций вложений). При >0
  снимок принудительно `historyComplete=false`, `partial.reason=
  'missing-user-text'`, в detail добавлено `missingUserTurns`. Это не даёт
  молча объявить полной базу с разрывом пары; легитимные пустые user-ходы
  с вложениями не затронуты (у них есть `fileSec`).
- Тесты: `tests/qwen-pagination.test.js` — разрыв пары отменяет полноту,
  полные пары вердикт не трогают.
- Гейты: Jest 301/4658 (7 skipped), eslint 0, catch-hygiene 13/13,
  `build:prod` зелёный.

**Живой статус на момент диагностики:** `lastParsed` 268 (134/134),
`turns` 134, `userTurns` 134, `orphanUt=[]`, `missingUt=[]` — текущая база
спарена полностью. Ручные MD 15:50 и 17:54 после полной истории снова дали
**266 (132/134)**: те же gap 45 (`Cargo.toml:20…`) и gap 55 (`$lines[20]`),
0 расхождений по assistant. Живой мост `exportSnapshot()` при этом отдаёт
**268 (134/134)** — значит, потеря происходит ПОСЛЕ сбора, на канонизации.

**Корень (подтверждён прогоном реального кода на эталоне):**
`utils/export-text-builders.ts:dropContainerMessages` на нативном массиве
268 сообщений оставлял **266** и снимал ровно две user-реплики (147 и 417
знаков). Эвристика «контейнер-стена» (содержит ≥2 других реплик, покрытие
≥0.8, длина ≥2× самой длинной) ошибочно срабатывала на коротких сообщениях
пользователя, которые цитируют две предыдущие реплики. Реальные контейнеры
DOM-адаптера Qwen — это узлы с ролью **assistant** (склейка всего чата).

**Фикс (2026-11-26).**

- `utils/export-text-builders.ts`: `dropContainerMessages` больше не считает
  контейнером сообщение с ролью `user`/`human` — только assistant-узлы. Это
  сохраняет короткие user-реплики, которые цитируют другие сообщения.
- `core/qwen-intercept.js`: `buildSnapshotData()` — чистая сборка сообщений из
  текущих `turns/userTurns` (её же использует `emitSnapshot`); мост
  `exportSnapshot()` + событие `ai-cm-qwen-export-snapshot-request/response`.
- `core/base-handler.ts`: `aiCmQwenExportSnapshotSync()` — синхронный запрос
  этого снимка из ISOLATED-мира.
- `core/export-manager.ts`: `aiCmCollectExportSource()` и
  `aiCmBuildCanonicalBody()` для Qwen предпочитают живой снимок, если он строго
  полнее базы и совпадает по чату; иначе прежний путь (DOM-обогащения) 1:1.
- Тесты: контейнер-фикстура получила реальную assistant-роль; добавлен
  регресс «короткая user-реплика, цитирующая две другие, не контейнер».
- Гейты: Jest 301/4659 (7 skipped), eslint 0, catch-hygiene 13/13,
  `build:prod` зелёный.

**Live retest (2026-11-26 18:06, Chrome 158, reload + F5 + полная история):
CLOSED.** Новый ручной MD
`ai-context-monitor-qwen-Qwen3.7-Plus-2026-11-26-18-06.md`:

| Проверка | Результат |
|---|---|
| Сообщений | **268** (нативно 268) |
| user / assistant | **134 / 134** |
| Подряд идущие роли (`runs`) | **0** |
| Расхождений по assistant | **0** |
| Расхождений по gap-позициям | **0** |
| `Cargo.toml:20…` | **2** (как в нативном) |
| `$lines[20]` | **1** |
| Токены | `1 186 363 / 1 000 000 (118.6%)` — совпадает с бейджем/тултипом |
| `exportSnapshot()` до экспорта | 268, 134/134, `missingUserTurns=0` |

Файл лежит в `acceptance/BIG-2026-11/2.3/live/2026-11-25/08-qwen/exports/`.

Примечание: live-файл снят на промежуточной сборке контейнер-фикса
(min-length); финальное правило role-guard (контейнер — только assistant)
проверено unit-тестами и прогоном на нативном массиве (268/134/134), для
этого чата результат идентичен.



