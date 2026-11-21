# BUGS — журнал дефектов

Правило: один дефект = один раздел `BUG-N` с полями «симптом / воспроизведение /
локализация / не виновен / влияние / следующие шаги». Дефект закрывается только
тестом или записью в приёмке, а не словами «починили».

---

## BUG-12 (P1, роли — fixed; счёт — открыт) — AI Studio: экспортная проекция теряет ходы и путает роли после `[FILE:]`

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

---

## BUG-13 (кандидат, P2) — AI Studio: экспорт 29 при источнике 33 после F5

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
`tests/aistudio-export-dedupe.test.js` (+5). **Live STOP
(`AISTUDIO-FILEDUP-LOSS`):** коллапс корректен, но живой тред больше не
отдаёт тело 22 817 симв. файла `aistudio-…19-03.md` (у `u60` нет
s-секции даже после fetch) — внешняя потеря контента Google, не коллапс
и не фильтр экспорта. Нужна пере(вставка) файла в тред для чистого
live-гейта или решение владельца.

---

## BUG-14 (P2) — AI Studio: автоэкспорт не планировался ни на одном чате

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

## BUG-16 (2.2, phase 2 dual-run) — readiness: derived подан как факт

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


