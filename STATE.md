# STATE — ai-context-monitor

Правило: только проверяемые значения. Неизвестно → `?`. Историю не пересказывать.
Обновляется коммитом `chore(state)` в конце задачи. Объём — до 120 строк.

## 1. Репозиторий

- workspace: ai-context-monitor-clean
- branch: main; HEAD: `9a96e7e`; origin/main: `9a96e7e`; ahead: 0
- version: `2.1.1` (manifest.json, package.json); дата: 2026-11-12

## 2. Метрики (сняты после прогона 2026-11-12, после `9a96e7e`)

- build: exit 0 (`node build.mjs --clean`, затем `node build.mjs`); `dist/content.js` 704 549 B
- tests: 244 suites / 4094 passed / 7 skipped / 0 failed (полный `npm test`)
- tsc: exit 0, вывод пуст (`npx tsc --noEmit`)
- lint: зелёный (Lint на `9a96e7e` подтверждён владельцем 2026-11-12)

## 3. Текущая задача

- ID: `ADR-001 / S2.2` — slug `snapshot-consumers` — потребители читают снимок через reader
- суть: чистые мапперы `aiCmWidgetDataFromSnapshot` / `aiCmStatePatchFromSnapshot`; бейдж, панель и попап берут `tokens`/`percent` из `aiCmReadContextSnapshot()`, а не из `aiCmTokenSnapshot`; `GET_STATS` больше не отдаёт `aiCmTokenSnapshot`
- критерий: при `null`-снимке потребители не рисуют числа (никаких `0/0` в бейдже и файле); `messageCount` остаётся живым — I1 покрывает только `tokens`/`percent`; числа бейджа, попапа и панели совпадают с последней строкой `[ctx-snap]`
- тест: `inv-i1` + пины потребителей (`o14:136`, `qwen-gate-diag-o35:546–547`, `badge-suppress:323`, `step3:315`, `ring-color:47/63`, `gemini:220/229/231`) переписаны осознанно, с таблицей «было → стало → что доказывает»
- следующий шаг: S2.3 — экспорт читает снимок; удалить пересчёт `percent` (`export-manager.ts:632,727-729,1871-1874`, `export-text-builders.ts:391-401`)

## 4. Открытые задачи (≤5)

| ID | что | статус | следующий шаг |
|---|---|---|---|
| `ADR-001 / S2–S3` | один снимок и читатель; `src`; барьер `partial` | S2.1a принят; следующий S2.2 | S2.2 |
| `ADR-001 / S4–S6` | `convId`-гард; фикстуры, пины, mutation-check | ждёт S2 | — |
| `BUG-02` | Qwen: нераспознанная модель подменяется `siteDefaults.qwen` → в файле «Qwen3.7-Plus» вместо выбранной | наблюдение 2026-11-12 | решить в S3: не подставлять дефолт молча |
| `BUG-C` | Gemini: в экспорте дублируются последние ходы. Первая копия — с `[IMAGE: ...]` и markdown (`gemini-e1020dba-2026-11-12_20-06.md:2488-2535`), вторая — без `[IMAGE:]`, без разметки, с артефактами «Ещё 2»/«Ещё 1» (`2550-2589`). Дедуп live-tail не срабатывает, т.к. тексты копий различаются; зона — слияние live-capture хвоста и `dedupeMessages` (`utils/export-emit-pipeline.ts:585-598`, `core/export-manager.ts`). К S2.3 не относится. | открыт 2026-11-12 при приёмке S2.1; вне скоупа S2 | отдельная задача после S2 |
| `REL-01` | CHANGELOG для S1.x отложен до выпуска 2.1.2: гейты не пропускают `## [Unreleased]` | черновик: `C:\Users\oleg\Desktop\s13-changelog-draft.md` | релизный шаг: bump + перенос текста |

## 5. Последние решения (≤3)

| дата | решение | причина | чем закрыто |
|---|---|---|---|
| 2026-11-12 | S2.1a принят: снимок GSA получил canonical `threadId` | GSA `convId=8bTpaveuJtWckdUP46iumAo` (было `''`); `[ctx-snap] 8bTpaveuJtWckdUP46iumAo\|max\|12288\|40097\|32\|0\|71210c76:40097\|0`; Gemini без изменений | `9a96e7e` |
| 2026-11-12 | CHANGELOG-коммит откачен | `## [Unreleased]` валит 4 suites (6 тестов): гейты требуют `## [x.y.z] - YYYY-MM-DD` в шапке | revert `be9a9e7` |
| 2026-11-12 | Claude Haiku 5.5 внесён в каталог с `capExempt` | slug отсутствовал → чужое имя и окно 500K; без флага порог был бы 128 000 | коммит `c0a7918` |

## 6. Риски и наблюдения (≤5)

- `CHANGELOG.md` меняется только вместе с bump версии; `## [Unreleased]` запрещён. Правило записано в `protocol-v2/05-CODER-ACT.md`.
- Живая приёмка: S1.3 — шапка `metric-src: net`, снимок в тот же момент — `src=max`; тело и числа совпали, `src` — нет (I5, S2). Риск «снимок и латч на разных ключах» закрыт S2.1a; остаётся риск, что `partial=false` на GSA при `historyComplete=1` не доказан — доказательство отложено до S3.
- Claude Haiku 5.5: окно 1M подтверждено docs Anthropic (2026-11-12); окно тарифа Free не проверено — проверить при живой приёмке.
- Живая приёмка 2026-11-12 фиксировала сжатие тела при повторном разборе (57 → 50 → 51 → 52 сообщения) без действий пользователя. Причина `?`; закрывается метком `partialReason: 'shrank'` (S3).
- `tsc --noEmit` вне CI-гейтов (`PROJECT_HANDOFF.md:930`) — регрессии не ловятся автоматически.

## 7. Что смотреть (не читать целиком)

- `PROJECT_HANDOFF.md` → только `Select-String -Pattern '<ID>'`; роадмап — строки 735–765
- `docs/decisions/context-snapshot.md` (362 строки) — читать целиком при работе над ADR-001
- `docs/COORDINATION-RULES.md` (13.7 КБ) — читать адресатом
- `CLINE_PROMPT_RULES.md`, `DHS_RULES.md` — читать адресатом
- `CHANGELOG.md` — только в релизной задаче
