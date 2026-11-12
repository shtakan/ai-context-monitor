# STATE — ai-context-monitor

Правило: только проверяемые значения. Неизвестно → `?`. Историю не пересказывать.
Обновляется коммитом `chore(state)` в конце задачи. Объём — до 120 строк.

## 1. Репозиторий

- workspace: ai-context-monitor-clean
- branch: main; HEAD: `be9a9e7`; origin/main: `98949a8`; ahead: 2 (revert CHANGELOG + этот state)
- version: `2.1.1` (manifest.json, package.json); дата: 2026-11-12

## 2. Гейты (последний прогон 2026-11-12, после revert `be9a9e7`)

- build: exit 0 (`node build.mjs --clean`, затем `node build.mjs`); `dist/content.js` 702 438 B
- tests: 242 suites / 4083 passed / 7 skipped / 0 failed (полный `npx jest`)
- tsc: exit 0, вывод пуст (`npx tsc --noEmit`)
- lint: `?` (в этом прогоне не запускался)

## 3. Текущая задача

- ID: `BUG-01` — slug `claude-haiku-5-5` отсутствует в каталоге → подстановка «Claude Sonnet 4.6 / 500 000»
- статус: Act выдан архитектором (`Расхождение STATE.md` §5); цифра лимита подтверждена владельцем: 1 000 000
- правка: запись `'claude-haiku-5-5'` в `utils/model-config.ts` — `contextLimit: 1000000, capExempt: true`, в `description` источник и дата; `capExempt` обязателен, иначе `getEffectiveLimit` вернёт 128 000
- инвариант: для известной модели имя и лимит берутся из каталога; ни одно прежнее число не меняется
- критерий приёмки: новый `tests/model-config-claude-haiku-5-5.test.js` красный на `be9a9e7` (`resolveModelId('claude-haiku-5-5')` → null) и зелёный после; `git show --stat` — 2 файла; `npx tsc --noEmit` → 0; `node build.mjs --clean` → 0; `npm test` → 242 suites / 0 failed
- следующий шаг: Act BUG-01 в сессию `act`; после приёмки — S2

## 4. Открытые задачи (≤5)

| ID | что | статус | следующий шаг |
|---|---|---|---|
| `BUG-01` | Claude: неизвестный slug → чужое имя и лимит 500K | Act выдан, цифра есть | кодер `act` |
| `ADR-001 / S2–S3` | один снимок и читатель; `src`; барьер `partial` | ждёт BUG-01 | — |
| `ADR-001 / S4–S6` | `convId`-гард; фикстуры, пины, mutation-check | ждёт S2 | — |
| `BUG-02` | Qwen: нераспознанная модель подменяется `siteDefaults.qwen` → в файле «Qwen3.7-Plus» вместо выбранной | наблюдение 2026-11-12 | решить в S3: не подставлять дефолт молча |
| `REL-01` | CHANGELOG для S1.x отложен до выпуска 2.1.2: гейты не пропускают `## [Unreleased]` | черновик: `C:\Users\oleg\Desktop\s13-changelog-draft.md` | релизный шаг: bump + перенос текста |

## 5. Последние решения (≤3)

| дата | решение | причина | чем закрыто |
|---|---|---|---|
| 2026-11-12 | S1.2 принят живой приёмкой | `[ctx-snap]` дал `45168|25960|62`; файл напечатал те же числа | коммит `670601a` |
| 2026-11-12 | S1.3 принят: тело файла = каноническое | Qwen `1bfcdd77`: `[ctx-snap] max|514364|1586589|204|54dfa514`; MD-тело = JSON join = 1 586 589, хеш сошёлся | коммиты `77cead5`, `2ecb657` |
| 2026-11-12 | CHANGELOG-коммит откачен | `## [Unreleased]` валит 4 suites (6 тестов): гейты требуют `## [x.y.z] - YYYY-MM-DD` в шапке | revert `be9a9e7` |

## 6. Риски и наблюдения (≤5)

- `CHANGELOG.md` меняется только вместе с bump версии; `## [Unreleased]` запрещён. Правило записано в `protocol-v2/05-CODER-ACT.md`.
- Живая приёмка S1.3: шапка файла печатает `metric-src: net`, а снимок в тот же момент — `src=max`. Тело и числа совпали, `src` — нет; это I5, закрывается в S2.
- `getEffectiveLimit` = `min(contextLimit, 128000)` без `capExempt` (`utils/model-config.ts:626–631`): для Haiku 5.5 флаг обязателен, иначе в бейдже будет 128 000.
- Живая приёмка 2026-11-12 фиксировала сжатие тела при повторном разборе (57 → 50 → 51 → 52 сообщения) без действий пользователя. Причина `?`; закрывается метком `partialReason: 'shrank'` (S3).
- `tsc --noEmit` вне CI-гейтов (`PROJECT_HANDOFF.md:930`) — регрессии не ловятся автоматически.

## 7. Что смотреть (не читать целиком)

- `PROJECT_HANDOFF.md` → только `Select-String -Pattern '<ID>'`; роадмап — строки 735–765
- `docs/decisions/context-snapshot.md` (325 строк) — читать целиком при работе над ADR-001
- `docs/COORDINATION-RULES.md` (13.7 КБ) — читать адресатом
- `CLINE_PROMPT_RULES.md`, `DHS_RULES.md` — читать адресатом
- `CHANGELOG.md` — только в релизной задаче
