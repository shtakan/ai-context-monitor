# STATE — ai-context-monitor

Правило: только проверяемые значения. Неизвестно → `?`. Историю не пересказывать.
Обновляется коммитом `chore(state)` в конце задачи. Объём — до 120 строк.

## 1. Репозиторий

- workspace: ai-context-monitor-clean
- branch: main; HEAD: `a6343e3` (chore(ts): strict utils B2); origin/main: `a6343e3`; ahead: 0; behind: 0; тег `v2.1.2` → `b36b3c0`
- version: `2.1.2` (manifest.json, package.json, package-lock.json, футер docs/index.html); дата: 2026-11-16; опубликовано: GitHub Release `v2.1.2` (ZIP собран CI, `Release ZIP #51`) и AMO 2.1.2 (одобрено 2026-11-16, 0 ошибок / 7 предупреждений)

## 2. Метрики (финальный прогон 2026-11-16, после последнего коммита)

- build: exit 0 (`node build.mjs`); `dist/content.js` 730 348 B, sha256 `bc4aca30857f18cfcf15d762da3f4010b35147a1e6cc337ebdffe2e21c2dc32b`
- tests: 262 suites / 4280 passed / 7 skipped / 0 failed (полный `npm test`) — `262/4280/7/0`
- tsc: exit 0, вывод пуст (`npx tsc --noEmit`); lint: 0 errors / 0 warnings (`npx eslint .`)
- mutation: 8 KILLED / 0 SURVIVED / 0 ERROR (`npm run test:mutation`, exit 0, 2026-11-16)

## 3. Текущая задача

- ID: `REL-01` — закрыт 2026-11-16: CHANGELOG 2.1.2, 15 точек версии, тег `v2.1.2`, GitHub Release, AMO 2.1.2
- живая приёмка 2.1.2 (тред `e1020dba`): 165 сообщений, 99 229 / 77.5 %, «Ещё N» — 0, карточек файла нет
- `RELEASE_CHECKLIST.md` — архив с 2026-11-16; гейт P0/P1 — в STANDARDS-MATRIX
- `options/options.js` в checkJs + JSDoc: 21 аннотация DOM-элементов (20 const + `section`), 63 TS2339 закрыты; 3 присваивания `value` обёрнуты в `String()` (сеттер и так приводит к строке); пин `tests/options-checkjs.test.js`; `npx tsc --noEmit` exit 0
- `tsconfig.strict.json` (strict: `types/**` + `adapters/**/*.ts` + B1 `utils/{debug,model-config,perplexity-parser,archive-import}.ts` + B2 `utils/{chatgpt-conversation-parser,stream-frames}.ts` + B3 `utils/gemini-batchexecute-parser.ts` + B4 `utils/google-search-folwr-parser.ts` + B5 `utils/export-emit-pipeline.ts` + B6 `utils/gemini-intercept-logic.ts` + B7 `core/{content,widget,state,base-handler,hybrid-tail,export-manager,background,gemini-diag-dump}.ts`): adapters 11 → 0, B1 16 → 0, B2 38 → 0, B3 40 → 0, B4 99 → 0, B5 144 → 0, B6 176 → 0, B7 33 → 0, B8 38 → 0, B9 59 → 0 (в B7/B8/B9-файлах 0), B10 77 → 0 (`core/export-manager.ts`; strict 177 → 100); остаток core 100 (только `content.ts`, набор ошибок байт-в-байт прежний) — `npx tsc -p tsconfig.strict.json`, промежуточный гейт (не exit 0); пин `tests/strict-config.test.js` (B1–B10, все 8 core в `include`); основной `tsconfig.json` не ужесточён (`strict: false`)
- следующий шаг: **B10 закрыт (0)** — `core/export-manager.ts` 77 → 0, общий strict-счётчик 177 → 100: TS18047 ×31 (guard'ы `snap &&`, `const P`/`const B`/cast `Pbc` — новых исходов/веток нет), TS2538 ×12 (`String(cid)` — тот же ключ, `"null"` сохранён; в `fireDeferredTimeout` и `doAutoExportDownload` параметр `cid: any`, чтобы пины исходника не менялись), TS7006 ×17 (типы в сигнатурах: JSDoc в `.ts` не работает), TS2339 ×6 (`e instanceof Error && e.message`), TS7034/TS7005 ×7 (`var file: string`, типизированные memo-переменные S1.3), TS2345 ×2 + TS2322 ×1 + TS7053 ×1; `@ts-ignore` у `canonicalBody` убран — типы в EOF-блоке (`declare`, снимается stripTypes в песочницах). Дальше B11 `core/content.ts` (100 → 0, затем strict exit 0)
- релиз 2.1.3 — после quality-трека (CHANGELOG + 15 точек версии + tag + AMO), по решению владельца

## 4. Открытые задачи (≤5)

| ID | что | статус | следующий шаг |
|---|---|---|---|
| `ADR-001 / S2–S6` | один снимок и читатель; `src`; барьер `partial`; проекция файла; S6 — пины, фикстуры, mutation-check | S6 принят 2026-11-15; цикл S1–S6 закрыт | — |
| `BUG-02` | Qwen: нераспознанная модель подменяется `siteDefaults.qwen` → в файле «Qwen3.7-Plus» вместо выбранной | закрыт 2026-11-16: `7e8b64c` (слаг вне каталога в `model`/бейдже, лимит из `siteDefaults`, qwen-only) + живая приёмка 20:13 на `Qwen4-Max` — файл `model="qwen4-max"`, `limit=1000000`, бейдж/попап `qwen4-max` | — |
| `BUG-C` | Gemini дублирует последние ходы — первая копия с `[IMAGE: ...]` и markdown (`gemini-e1020dba-2026-11-12_20-06.md:2488-2535`), вторая без `[IMAGE:]`, без разметки, с артефактами «Ещё 2»/«Ещё 1» (`2550-2589`); дедуп live-tail не срабатывает, т.к. тексты копий различаются. Класс: нет общего инварианта порядка/роли для 5 адаптеров | закрыт 2026-11-15: bdfbdc3 + 3e48b1a, ADR §9 | — |
| `BUG-H` | GSA: вопрос хода 17 «API DeepSeek полностью восстановлен» (35 B) отсутствует и в сети, и в DOM (ни `h2.iMqumd`, ни пузыря) — только в эхе ответа; рядом пара «неудачная перегенерация (`Что-то пошло не так`, 72 B) → повтор» с дублем вопроса 103 B. Тред `8bTpaveuJtWckdUP46iumAo`. Повторено 2026-11-16 на чистом треде `nOX6apueFdSqxc8P2ZzpkQY` (5 ходов): у ходов 3 и 5 `userLen=0`, вопрос только в эхе («…, исходный запрос: "хочу."»), `msgs=8` вместо 10 | закрыт 2026-11-16: `205db12` (`byAnswer` по телу ответа, 37 целевых тестов). Живой A-only не проверен: тред `nOX6…` удалён владельцем, в доступных тредах A-only не возникает (20:57/21:14/21:31 — все вопросы отдельными репликами). Закрыт по тестам; при повторе A-only — проверить экспортом | — |
| `BUG-I` | GSA: бейдж замирает на первом снимке после SPA-переключения треда. «Окно сбора» (`aiCmCommitContextSnapshot`, core/state.ts:852-862) держится на липком `aiCmGsaProbeRunning`: глобальный флаг не сбрасывается при смене треда, а `aiCmGsaProbeRunningFor` для непустого неизвестного `cid` падает в глобальный (core/export-manager.ts:1038-1043). Лог 16-18: `badge-update 0.6 % / 753` при `[ctx-snap]` 753→5427; после F5 — 4.3 % / 5532. Второй путь залипания — `step()` возвращает без `finish()` при `activeFolwrInFlight` (core/google-search-intercept.js:1472). **Живое подтверждение 18:04:** probe `запущен`, но шага/финиша нет, `probe-running=1` на экспорте, снимок удержан (`partial=true/incomplete`) — без watchdog флаг живёт бесконечно | закрыт 2026-11-16: `0a2c4c2` — watchdog 5 с, busy-retry, `probedTids` сбрасывается, timestamp+TTL 15 с, неизвестный непустой cid → false. Приёмка 18:35: `probe завершён` (cursor-repeat), `gsa-latch point=set`, `probeRunning=0`, бейдж 4.3 % обновляется; SPA-переключение живьём не повторялось (покрыто пинами) | — |
| `BUG-J` | GSA: после холодной загрузки (`folwr-open`) экспорт идёт new→old — `messages[0]` = последний ход (тред `nOX6apueFdSqxc8P2ZzpkQY`, F5: `parsed=5 folwrContainers=5 domContainers=5 dopasbor=0`, JSON 10 сообщений задом наперёд; подтверждено владельцем). До F5 пассивный `passive-folif` путь даёт верный old→new. Причина — безусловный `turns.reverse()` (`utils/google-search-folwr-parser.ts:826-829`) при фактическом old→new документе; `msgOrder:2` ставится без проверки (`core/content.ts:3170`, `core/export-manager.ts:760`), поэтому гейт options.js не ловит. Туда же: имя файла `[LOW CONFIDENCE]_` при полном теле — префикс из живого `baseComplete`, тело из латча (`core/content.ts:3546`). **Приёмка 2026-11-16 17:33 (коммит `1418072`) не прошла:** `order=reversed orderMatched=5` (хелпер сработал), но JSON снова new→old — probe перезаписал базу: в `step` при `added=0` `merged` пересобирается из сырого порядка (`mergeTurnsById(parsed, merged)`), а `finish` делает `applyTurns(merged, …, true, 'prepend')` (`core/google-search-intercept.js:1482,1427`). Плюс `partial=true/incomplete` (латч O-43 не сработал — нужен лог Set/Reset). **Приёмка 18:04 (коммит `8661f8d`): порядок исправлен** — JSON `messages[0]` = первый вопрос, `[turnsMap] firstText` = первый; probe больше не перезаписывает. `partial` остался true/incomplete: probe запустился (`probe запущен` 18:04:06.498), но `probe шаг 1`/`probe завершён` отсутствуют, на экспорте `probe-running=1`; `gsa-latch` Set/Reset не печатались (complete=1 не было). Снимок удержан окном сбора (bodyHash не менялся → `incomplete`) — это BUG-I: зависший probe без watchdog/retry и липкий флаг | закрыт 2026-11-16: порядок принят 18:04 (`8661f8d`), полная приёмка 18:35 (`0a2c4c2`) — JSON без `partial`, `messages=10` (5u/5a), old→new, имя без `[LOW CONFIDENCE]_` | — |
| `BUG-K` | GSA после F5: цикл open/pagination **чужого** треда `8bTpaveuJtWckdUP46iumAo` (24 хода, ответы 3.9 МБ) при активном `vx_7apaCCcG-zMsPtPfd6A4`; `foreign-not-applied`/`pagination-empty`, ~30 с (20:30:51–20:31:24). База не портится, но GSA засыпается запросами; вероятная причина ответа 1835 B «Что-то пошло не так» на open активного треда (20:31:24) | закрыт 2026-11-16 20:57: `4374c11` — чужой tid: `gained=0`, `foreign=1`, `tail=skip`, хвост не стартует. Живая F5: в логе только активный `vx_7apa…`, foreign-цикла нет; probe → `gsa-latch point=set`, JSON без `partial`, 8 (4u/4a), 3.5 % | — |
| `BUG-L` | GSA: 20:31:35.832 content принял `baseComplete=true` (`content-trace EMIT … baseComplete=true`), но `gsa-latch point=set` не напечатался; поздний open с `complete=0` (35.890) оставил `[ctx-snap] …|0` и JSON `partial=true/incomplete`, хотя probe завершился `historyComplete=1` (35.828). В 18:35 латч взводился. Причина не доказана (скоуп/вызов `aiCmGsaNetworkCompleteSet` или билд) | закрыт 2026-11-16 21:31: `ab7bee9` — `emitSite` на мосту + `completedTids` в MAIN. F5: probe `historyComplete=1` → `gsa-latch point=set`; поздний open `complete=0` получил `historyComplete=1` (монотонность) → повторный `set`; JSON без `partial`, 16 (8u/8a), 5 %, имя без `[LOW CONFIDENCE]_` | — |
| `REL-01` | CHANGELOG 2.1.2 и версия во всех 15 точках; релиз опубликован | закрыт 2026-11-16: тег/Release/AMO, приёмка 165 / 99 229 / 77.5 % | — |

## 5. Последние решения (≤3)

| дата | решение | причина | чем закрыто |
|---|---|---|---|
| 2026-11-14 | S4: снимок принадлежит чату (канонический `convId` на запись и чтение); монотонность снята; окно сбора — только флаги loader/probe/net-pending | чужой снимок не читается; high-water давал число от другого текста; шаговая досборка qwen/Gemini вне окна сбора — принятый риск с критерием эскалации | `3e452ec` |
| 2026-11-14 | S2.3: барьер partial — автоэкспорт не стартует, пока снимок partial; метки в теле MD/JSON и в payload всех писателей истории | снимок — единственный владелец partial/partialReason (без пересчётов); pre-trim и ручной экспорт — отдельные пути, их блокировка сломала бы восстановление; fail-open сохраняет прочие сценарии | `2b62aee` |
| 2026-11-14 | S5: ручной JSON собирает общий сборщик; `platform` — сырой ключ сайта; union-путь канонизируется один раз (I3c′) | один канонический массив и одна схема у ручного и авто-пути; метка siteLabels остаётся только в MD-шапке; platform берётся из того же `hist || cachedHistory`, что и данные | `e22c894` |

## 6. Риски и наблюдения (≤5)

- Процесс: `CHANGELOG.md` меняется только вместе с bump (`## [Unreleased]` запрещён); `tsc --noEmit` вне CI-гейтов (`PROJECT_HANDOFF.md:930`) — регрессии не ловятся автоматически.
- `partial=false` на GSA доказан 2026-11-16 (тред `nOX6apueFdSqxc8P2ZzpkQY`, 5 ходов) и воспроизведён на фиксированном билде 18:35 (`0a2c4c2`): `folwr-open` 5/5 → probe `cursor-repeat` → `historyComplete=1` → `gsa-latch point=set`; поздний handshake с `complete=0` латч удержал; JSON без `partial`/`partialReason`, `messages=10` (5u/5a), порядок old→new, имя без `[LOW CONFIDENCE]_`, бейдж 4.3 % = файл.
- Пустой чат (GSA и Gemini): кнопка экспорта выключена, попап пишет «Откройте поддерживаемый сайт» (`showNoData`) — косметика; проверено 2026-11-16 на Gemini: прочерки + «Загрузка контекста…» до первого замера.
- `stripReasoningSections` режет только пары `[REASONING]`/`[ANSWER]`; структурный блок без `[ANSWER]` в OFF уцелевает и даёт `mode=''` без метки (пин 14f; ADR §9, принято 2026-11-15).
- O-20/O-40/O-42 живьём не проверяются (DeepSeek++ удалён, ToS-риск блокировки чата); принятый риск, покрытие — только unit/fixture (`deepseek-o40-*`, `deepseek-o42-*`, O-20 в `tests/inv-i3-export-projection.test.js`).

## 7. Что смотреть (не читать целиком)

- `PROJECT_HANDOFF.md` → только `Select-String -Pattern '<ID>'`; роадмап — строки 735–765
- `docs/decisions/context-snapshot.md` (365 строки) — читать целиком при работе над ADR-001
- `docs/COORDINATION-RULES.md` (13.7 КБ) — читать адресатом
- `CLINE_PROMPT_RULES.md`, `DHS_RULES.md` — читать адресатом
- `CHANGELOG.md` — только в релизной задаче
