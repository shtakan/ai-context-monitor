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

**Остаток:** #19/#20 (17 540 + 88, файловый user-дубль) не схлопнут —
отдельное наблюдение; `partial` для уникальной потери не подтверждён.

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

**Не виновен:** BUG-12 (роли закрыты: ROLES-FIXED, экспорт — префикс источника).


