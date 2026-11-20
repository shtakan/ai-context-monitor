# ADR-002: архитектурный AST-линтер вместо line-based пинов

**Статус:** принято, 2.2 фаза 0 (2026-11-20).
**База:** `main` @ `4e2916a` (2.1.5), ветка `feature/2.2`.
**Связанные документы:** `acceptance/BIG-2026-11/ARCHITECTURE-2.2.md` §7/§11,
`ARCHITECTURE_STANDARDS.md` (ESM в content scripts), `docs/TESTS.md`.

## 1. Контекст

Пины в Jest привязаны к номерам строк: `tests/fixtures/catch-whitelist.json`
(416 записей), счётчик `baseSeen = true;` в `badge-suppress-adapter-base-v54`,
`messages-contract` с `toContain` по исходникам. Любая вставка выше сдвигает
строки, и «зелёный» прогон требует механического пересчёта, а не проверки
смысла. Правило проекта «новые хелперы в `core/*` — в конец файла» существует
именно из-за этого.

Цель 2.2 — привязать проверку к **факту в AST** (пустой catch, `chrome.*` в
MAIN, динамический `import()`), а не к позиции в файле. Тогда сдвиг строк
перестаёт быть событием.

## 2. Решение

1. Добавлен `tools/architecture-lint.mjs` — Node ESM-скрипт на TypeScript
   compiler API (`typescript` уже в devDependencies; новых зависимостей нет).
2. Запуск — `npm run lint:arch`, отдельный блокирующий шаг CI
   (`.github/workflows/lint.yml`) **вне Jest**: `behavior-gate-whitelist.json`
   не растёт, тесты не читают исходники продукта.
3. Линтер не исполняет проверяемый код и не делает type-checking: типы —
   `npx tsc`, стиль — ESLint. Пересечения ответственности нет.
4. Нарушение печатается как `file:line:col [rule] NodeKind` + сообщение и
   фрагмент узла; exit 1. Номер строки — диагностика для человека, не ключ
   пина: проверка уже выполнена по узлу.

## 3. Правила v0 (все — 0 нарушений на `feature/2.2`)

| Правило | Область | Что запрещает | Почему сейчас 0 |
|---|---|---|---|
| `seam-no-silent-catch` | `utils/messages`, `utils/metrics`, `utils/export` | пустой catch и ровно один no-op (`void 0;`/`return;`/`continue;`/`break;`) | каталоги швов ещё не созданы; правило ждёт первый модуль фазы 1 |
| `seam-no-host-globals` | те же швы | идентификаторы `document`/`chrome` | швы — чистые функции (вход/выход — данные), побочные эффекты в `core/content.ts` |
| `main-no-chrome` | `core/*-intercept.js`, `core/page-intercept.js` | идентификатор `chrome` | MAIN-мир не имеет `chrome.*`; мост — CustomEvent в ISOLATED |
| `main-no-dynamic-import` | те же MAIN-файлы | `import(...)` | рантайм-ESM в MAIN требует `web_accessible_resources`; статические import собираются в IIFE |
| `baseSeen-single-bare-write` | `core/**` | вторая запись `baseSeen = true;` без скобок | в `core/content.ts` ровно одна голая запись; новая точка — `baseSeen = (true);` |

Семантика «молчаливого catch» совпадает с `tests/catch-hygiene.test.js`
(комментарии не считаются телом; строковые литералы не маскируют no-op),
поэтому будущий перенос пина не меняет определение.

## 4. Отклонения от ARCHITECTURE-2.2 (осознанные)

### 4.1. Статический `import` в MAIN разрешён

§7 предлагает «запрещает `import` в MAIN-файлах». На `4e2916a` пять MAIN-
перехватчиков (`page`, `claude`, `perplexity`, `google-search`, `qwen`) уже
импортируют `utils/intercept-common.ts` / `stream-frames.ts` /
`perplexity-parser.ts`. Это не нарушение: `build.mjs` собирает каждый
перехватчик отдельным IIFE (`MAIN_INTERCEPTS`), и в рантайм ESM не попадает.
Запрет статических import сломал бы сборку и `ARCHITECTURE_STANDARDS.md`
(раздел «ES modules в content scripts»).

Поэтому правило проверяет реальную границу — **динамический** `import()` и
`chrome.*` — и пропускает статические import как build-time конструкцию.

### 4.2. Полный перенос `empty catch` — фаза 6, не фаза 0

§11 предлагает начать с правила «пустой catch». Полное дерево дало бы 416
существующих записей и потребовало бы baseline, дублирующий
`catch-whitelist.json`: два владельца одного факта на фазах 1–5. Это
противоречит §0 («каждый факт рождается один раз»).

Решение: в фазе 0 правило действует только на **новые швы** (там 0 записей,
baseline не нужен). Полный перенос с content-addressed baseline — фаза 6,
одновременно с удалением `catch-whitelist.json`. До этого Jest-страж остаётся
единственным владельцем старого дерева.

## 5. Baseline

Сейчас baseline отсутствует — это условие входа: каждое правило v0 либо
истинно, либо не включено.

Если правило понадобит исключение, baseline обязан быть:
- ключ — `file` + хэш нормализованного текста узла + порядковый номер
  дубликата, **не** номер строки;
- мёртвая запись (узел исчез) — падение, как в `catch-whitelist` (ratchet);
- обновление — отдельным ревьюируемым diff, без авто-принятия в CI.

`--update-baseline` намеренно не реализован до фазы 6: baseline — это
исключение, а не автогенерация.

## 6. Что линтер не делает

- Не заменяет `tsc` (типы) и ESLint (стиль/гигиена).
- Не проверяет бизнес-инварианты I1–I10 — они остаются поведенческими тестами.
- Не сканирует `tests/`, `docs/`, `dist/`, `artifacts/`, `tools/_*`.
- Не читает `catch-whitelist.json`: старый пин живёт до фазы 6.

## 7. План burn-down (фаза 6)

| Сейчас | Замена |
|---|---|
| `catch-whitelist.json` (416) | `seam-no-silent-catch` на всё дерево + baseline, затем baseline → 0 |
| счётчик `baseSeen = true;` в `badge-suppress-v54` | `baseSeen-single-bare-write` + поведенческий тест серии снимков |
| `messages-contract.test.js` (`toContain` по исходникам) | `tsc --noEmit` + контрактные тесты форм |
| `behavior-gate-whitelist.json` | цель — пусто; архитектурные проверки уже вне Jest |

## 8. Откат

Удалить `tools/architecture-lint.mjs`, строку `lint:arch` из `package.json`,
шаг из `lint.yml` и негацию в `.gitignore`. Код продукта не затронут — откат
не требует пересборки и не меняет `dist`.

## 9. Проверка

| Гейт | Результат |
|---|---|
| `node tools/architecture-lint.mjs` | exit 0, 5 rules / 308 files / 0 violations |
| `npx tsc --noEmit` | exit 0 |
| `npx tsc -p tsconfig.strict.json` | exit 0 |
| `npx jest` | зелёный (без изменений в тестах) |
| `npm run build:prod` | exit 0, `dist` без изменений по смыслу |
