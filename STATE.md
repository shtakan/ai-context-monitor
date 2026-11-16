# STATE — ai-context-monitor

Правило: только проверяемые значения. Неизвестно → `?`. Историю не пересказывать.
Обновляется коммитом `chore(state)` в конце задачи. Объём — до 120 строк.

## 1. Репозиторий

- workspace: ai-context-monitor-clean
- branch: main; HEAD: `ded7127` (chore(state): синк HEAD/ahead), сверху `docs(handoff)` аппендикс v136 + `chore(state)` синк; origin/main: `ded7127`; ahead: 2; behind: 0; тег `v2.1.2` → `b36b3c0`
- version: `2.1.2` (manifest.json, package.json, package-lock.json, футер docs/index.html); дата: 2026-11-16; опубликовано: GitHub Release `v2.1.2` (ZIP собран CI, `Release ZIP #51`) и AMO 2.1.2 (одобрено 2026-11-16, 0 ошибок / 7 предупреждений)

## 2. Метрики (финальный прогон 2026-11-16, после последнего коммита)

- build: exit 0 (`node build.mjs --clean` + `node build.mjs`); `dist/content.js` 725 785 B, sha256 `f8963afb19c0d29ac0c6d2c087a589fe10fac4ed1b2f99d562f3b7d440d3ac49`
- tests: 255 suites / 4204 passed / 7 skipped / 0 failed (полный `npm test`) — `255/4204/7/0`
- tsc: exit 0, вывод пуст (`npx tsc --noEmit`); lint: 0 errors / 0 warnings (`npx eslint .`)
- mutation: 8 KILLED / 0 SURVIVED / 0 ERROR (`npm run test:mutation`, exit 0, 2026-11-16)

## 3. Текущая задача

- ID: `REL-01` — закрыт 2026-11-16: CHANGELOG 2.1.2, 15 точек версии, тег `v2.1.2`, GitHub Release, AMO 2.1.2
- живая приёмка 2.1.2 (тред `e1020dba`): 165 сообщений, 99 229 / 77.5 %, «Ещё N» — 0, карточек файла нет
- решение по `RELEASE_CHECKLIST.md` принято 2026-11-16: архив + перенос P0/P1-гейта
- следующий шаг: `BUG-J` (порядок GSA после холодной загрузки) → `BUG-I` (замерший бейдж) → `BUG-02` → `BUG-H` → архив `RELEASE_CHECKLIST.md`; handoff v136 закрыт 2026-11-16

## 4. Открытые задачи (≤5)

| ID | что | статус | следующий шаг |
|---|---|---|---|
| `ADR-001 / S2–S6` | один снимок и читатель; `src`; барьер `partial`; проекция файла; S6 — пины, фикстуры, mutation-check | S6 принят 2026-11-15; цикл S1–S6 закрыт | — |
| `BUG-02` | Qwen: нераспознанная модель подменяется `siteDefaults.qwen` → в файле «Qwen3.7-Plus» вместо выбранной | наблюдение 2026-11-12 | решить в S3: не подставлять дефолт молча |
| `BUG-C` | Gemini дублирует последние ходы — первая копия с `[IMAGE: ...]` и markdown (`gemini-e1020dba-2026-11-12_20-06.md:2488-2535`), вторая без `[IMAGE:]`, без разметки, с артефактами «Ещё 2»/«Ещё 1» (`2550-2589`); дедуп live-tail не срабатывает, т.к. тексты копий различаются. Класс: нет общего инварианта порядка/роли для 5 адаптеров | закрыт 2026-11-15: bdfbdc3 + 3e48b1a, ADR §9 | — |
| `BUG-H` | GSA: вопрос хода 17 «API DeepSeek полностью восстановлен» (35 B) отсутствует и в сети, и в DOM (ни `h2.iMqumd`, ни пузыря) — только в эхе ответа; рядом пара «неудачная перегенерация (`Что-то пошло не так`, 72 B) → повтор» с дублем вопроса 103 B. Тред `8bTpaveuJtWckdUP46iumAo`. Повторено 2026-11-16 на чистом треде `nOX6apueFdSqxc8P2ZzpkQY` (5 ходов): у ходов 3 и 5 `userLen=0`, вопрос только в эхе («…, исходный запрос: "хочу."»), `msgs=8` вместо 10 | наблюдение 2026-11-14, чистое воспроизведение 2026-11-16 | решить: эхо как источник либо зафиксировать как ограничение GSA |
| `BUG-I` | GSA: бейдж замирает на первом снимке после SPA-переключения треда. «Окно сбора» (`aiCmCommitContextSnapshot`, core/state.ts:852-862) держится на липком `aiCmGsaProbeRunning`: глобальный флаг не сбрасывается при смене треда, а `aiCmGsaProbeRunningFor` для непустого неизвестного `cid` падает в глобальный (core/export-manager.ts:1038-1043). Лог 16-18: `badge-update 0.6 % / 753` при `[ctx-snap]` 753→5427; после F5 — 4.3 % / 5532. Второй путь залипания — `step()` возвращает без `finish()` при `activeFolwrInFlight` (core/google-search-intercept.js:1456) | наблюдение 2026-11-16 | сброс probe на смене треда + не использовать глобальный флаг для непустого `cid` + `finish()` вместо `return` + TTL окна сбора |
| `BUG-J` | GSA: после холодной загрузки (`folwr-open`) экспорт идёт new→old — `messages[0]` = последний ход (тред `nOX6apueFdSqxc8P2ZzpkQY`, F5: `parsed=5 folwrContainers=5 domContainers=5 dopasbor=0`, JSON 10 сообщений задом наперёд; подтверждено владельцем). До F5 пассивный `passive-folif` путь даёт верный old→new. Причина — безусловный `turns.reverse()` (`utils/google-search-folwr-parser.ts:826-829`) при фактическом old→new документе; `msgOrder:2` ставится без проверки (`core/content.ts:3170`, `core/export-manager.ts:760`), поэтому гейт options.js не ловит. Туда же: имя файла `[LOW CONFIDENCE]_` при полном теле — префикс из живого `baseComplete`, тело из латча (`core/content.ts:3546`) | наблюдение 2026-11-16 | нормализовать порядок по живому DOM (`orderTurnsByDom`, id → canonical key → answer body), `gsa-order` в диагностику; префикс — из `snapPartMan.partial` |
| `REL-01` | CHANGELOG 2.1.2 и версия во всех 15 точках; релиз опубликован | закрыт 2026-11-16: тег/Release/AMO, приёмка 165 / 99 229 / 77.5 % | — |

## 5. Последние решения (≤3)

| дата | решение | причина | чем закрыто |
|---|---|---|---|
| 2026-11-14 | S4: снимок принадлежит чату (канонический `convId` на запись и чтение); монотонность снята; окно сбора — только флаги loader/probe/net-pending | чужой снимок не читается; high-water давал число от другого текста; шаговая досборка qwen/Gemini вне окна сбора — принятый риск с критерием эскалации | `3e452ec` |
| 2026-11-14 | S2.3: барьер partial — автоэкспорт не стартует, пока снимок partial; метки в теле MD/JSON и в payload всех писателей истории | снимок — единственный владелец partial/partialReason (без пересчётов); pre-trim и ручной экспорт — отдельные пути, их блокировка сломала бы восстановление; fail-open сохраняет прочие сценарии | `2b62aee` |
| 2026-11-14 | S5: ручной JSON собирает общий сборщик; `platform` — сырой ключ сайта; union-путь канонизируется один раз (I3c′) | один канонический массив и одна схема у ручного и авто-пути; метка siteLabels остаётся только в MD-шапке; platform берётся из того же `hist || cachedHistory`, что и данные | `e22c894` |

## 6. Риски и наблюдения (≤5)

- Процесс: `CHANGELOG.md` меняется только вместе с bump (`## [Unreleased]` запрещён); `tsc --noEmit` вне CI-гейтов (`PROJECT_HANDOFF.md:930`) — регрессии не ловятся автоматически.
- `partial=false` на GSA доказан 2026-11-16 (тред `nOX6apueFdSqxc8P2ZzpkQY`, 5 ходов): `folwr-open` 5/5 → probe `cursor-repeat` → `historyComplete=1`; JSON без `partial`/`partialReason`, `messages=10` (5u/5a), бейдж 4.3 % совпал с файлом. Остаток: имя файла всё равно получило `[LOW CONFIDENCE]_` — поздний handshake дал `complete=0` при уже полном теле (латч O-43 удержал `partial=false`), префикс и тело расходятся.
- Пустой чат (GSA и Gemini): кнопка экспорта выключена, попап пишет «Откройте поддерживаемый сайт» (`showNoData`) — косметика; проверено 2026-11-16 на Gemini: прочерки + «Загрузка контекста…» до первого замера.
- `stripReasoningSections` режет только пары `[REASONING]`/`[ANSWER]`; структурный блок без `[ANSWER]` в OFF уцелевает и даёт `mode=''` без метки (пин 14f; ADR §9, принято 2026-11-15).
- O-20/O-40/O-42 живьём не проверяются (DeepSeek++ удалён, ToS-риск блокировки чата); принятый риск, покрытие — только unit/fixture (`deepseek-o40-*`, `deepseek-o42-*`, O-20 в `tests/inv-i3-export-projection.test.js`).

## 7. Что смотреть (не читать целиком)

- `PROJECT_HANDOFF.md` → только `Select-String -Pattern '<ID>'`; роадмап — строки 735–765
- `docs/decisions/context-snapshot.md` (365 строки) — читать целиком при работе над ADR-001
- `docs/COORDINATION-RULES.md` (13.7 КБ) — читать адресатом
- `CLINE_PROMPT_RULES.md`, `DHS_RULES.md` — читать адресатом
- `CHANGELOG.md` — только в релизной задаче
