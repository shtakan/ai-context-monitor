# STATE — ai-context-monitor

Правило: только проверяемые значения. Неизвестно → `?`. Историю не пересказывать.
Обновляется коммитом `chore(state)` в конце задачи. Объём — до 120 строк.

## 1. Репозиторий

- workspace: ai-context-monitor-clean
- branch: main; HEAD: `c0a7918`; origin/main: `98949a8`; ahead: 3 (revert CHANGELOG + state + fix Haiku)
- version: `2.1.1` (manifest.json, package.json); дата: 2026-11-12

## 2. Гейты (последний прогон 2026-11-12, после `c0a7918`)

- build: exit 0 (`node build.mjs --clean`, затем `node build.mjs`); `dist/content.js` 702 879 B
- tests: 243 suites / 4086 passed / 7 skipped / 0 failed (полный `npm test`)
- tsc: exit 0, вывод пуст (`npx tsc --noEmit`)
- lint: `?` (в этом прогоне не запускался)

## 3. Текущая задача

- ID: `BUG-01` — slug `claude-haiku-5-5` отсутствовал в каталоге → подстановка «Claude Sonnet 4.6 / 500 000»
- статус: закрыт 2026-11-12; каталог дополнен, новый тест зелёный (3/3); коммит `c0a7918`
- правка: запись `'claude-haiku-5-5'` в `utils/model-config.ts` — `contextLimit: 1000000, capExempt: true`; `capExempt` обязателен, иначе `getEffectiveLimit` вернул бы 128 000
- инвариант: для известной модели имя и лимит берутся из каталога; ни одно прежнее число не меняется
- тест: `tests/model-config-claude-haiku-5-5.test.js` — resolve/getModel/getEffectiveLimit = 1 000 000, `claude-haiku-9-9` → null (класс BUG-02)
- следующий шаг: S2 (ADR-001) — один снимок и читатель; `src`; барьер `partial`

## 4. Открытые задачи (≤5)

| ID | что | статус | следующий шаг |
|---|---|---|---|
| `ADR-001 / S2–S3` | один снимок и читатель; `src`; барьер `partial` | готово к старту | S2 |
| `ADR-001 / S4–S6` | `convId`-гард; фикстуры, пины, mutation-check | ждёт S2 | — |
| `BUG-02` | Qwen: нераспознанная модель подменяется `siteDefaults.qwen` → в файле «Qwen3.7-Plus» вместо выбранной | наблюдение 2026-11-12 | решить в S3: не подставлять дефолт молча |
| `REL-01` | CHANGELOG для S1.x отложен до выпуска 2.1.2: гейты не пропускают `## [Unreleased]` | черновик: `C:\Users\oleg\Desktop\s13-changelog-draft.md` | релизный шаг: bump + перенос текста |

## 5. Последние решения (≤3)

| дата | решение | причина | чем закрыто |
|---|---|---|---|
| 2026-11-12 | S1.3 принят: тело файла = каноническое | Qwen `1bfcdd77`: `[ctx-snap] max|514364|1586589|204|54dfa514`; MD-тело = JSON join = 1 586 589, хеш сошёлся | коммиты `77cead5`, `2ecb657` |
| 2026-11-12 | CHANGELOG-коммит откачен | `## [Unreleased]` валит 4 suites (6 тестов): гейты требуют `## [x.y.z] - YYYY-MM-DD` в шапке | revert `be9a9e7` |
| 2026-11-12 | Claude Haiku 5.5 внесён в каталог с `capExempt` | slug отсутствовал → чужое имя и окно 500K; без флага порог был бы 128 000 | коммит `c0a7918` |

## 6. Риски и наблюдения (≤5)

- `CHANGELOG.md` меняется только вместе с bump версии; `## [Unreleased]` запрещён. Правило записано в `protocol-v2/05-CODER-ACT.md`.
- Живая приёмка S1.3: шапка файла печатает `metric-src: net`, а снимок в тот же момент — `src=max`. Тело и числа совпали, `src` — нет; это I5, закрывается в S2.
- Claude Haiku 5.5: окно 1M подтверждено docs Anthropic (2026-11-12); окно тарифа Free не проверено — проверить при живой приёмке.
- Живая приёмка 2026-11-12 фиксировала сжатие тела при повторном разборе (57 → 50 → 51 → 52 сообщения) без действий пользователя. Причина `?`; закрывается метком `partialReason: 'shrank'` (S3).
- `tsc --noEmit` вне CI-гейтов (`PROJECT_HANDOFF.md:930`) — регрессии не ловятся автоматически.

## 7. Что смотреть (не читать целиком)

- `PROJECT_HANDOFF.md` → только `Select-String -Pattern '<ID>'`; роадмап — строки 735–765
- `docs/decisions/context-snapshot.md` (325 строк) — читать целиком при работе над ADR-001
- `docs/COORDINATION-RULES.md` (13.7 КБ) — читать адресатом
- `CLINE_PROMPT_RULES.md`, `DHS_RULES.md` — читать адресатом
- `CHANGELOG.md` — только в релизной задаче
