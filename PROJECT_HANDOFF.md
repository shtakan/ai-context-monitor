# PROJECT_HANDOFF.md (для нового чата)

## Состояние проекта

**Версия:** 2.0.1 (O-1 = `1bf630f`; релизный коммит v2.0.0 = `3191cba`, предыдущий релиз = `1f12cbf`); v2.0: этап 1/3 = `370a217`, этап 2/3 = `994ae26` (частичный), CI-хотфикс = `322fd7e`, этап 3/3 = `be1a4a6`  
**Статус:** Релиз v2.0.1 собран: O-1 (бейдж ChatGPT без моргания после F5), ручная установка без магазина, бамп версии и миграция 8 версионных сьютов; публикация в Edge Add-ons — следующий шаг  
**Тесты:** 75 suites, 1322 passed, 6 skipped, 0 failed   

## Ключевые достижения

### Функционал
- **6 адаптеров** с единым контрактом (`BaseAdapter`)
- **Автоэкспорт** при достижении порога (работает на всех 6 платформах)
- **Ручной экспорт** в 4 форматах (md/json/pdf/txt)
- **Проактивные пороги** 70/85/95% с Chrome-уведомлениями
- **Импорт архивов** (Gemini Takeout, ChatGPT conversations.json, Perplexity, Claude)
- **BYOK** (Google AI Studio API key) для точного подсчёта токенов

### Архитектура
- **Strategy pattern** для адаптеров
- **Чистые функции** в `utils/` (export-emit-pipeline.js)
- **UMD-паттерн** (работает в браузере и Node.js тестах)
- **MV3-совместимость** (нет eval, нет удалённого кода, минимум permissions)
- **Traceability** (комментарии с версиями: v81, M-11, E-2, T1-fix#3)
- **Декомпозиция v2.0 (этап 1/3):**
  - `content.js` (1897 строк, было 3622) — 5 модулей:
    - `state.js` (416 строк) — глобальное состояние
    - `widget.js` (510 строк) — виджет
    - `base-handler.js` (218 строк) — обработка базы
    - `hybrid-tail.js` (162 строки) — гибридный хвост DOM
    - `export-manager.js` (945 строк) — экспорт
  - 153 элемента перенесены байтово, логика не изменена
  - Тесты обновлены только в строках резолва (23 файла)
- **Декомпозиция v2.0 (этап 2/3, частичная):**
  - `gemini-intercept.js` 5064 → 4800 строк; вынесен `core/gemini-hidden-scroll.js`
    (356 строк, 13 функций + 10 констант, своя IIFE + UMD `window.AiCmGeminiHiddenScroll`)
  - Интеграция: `__bind` с геттерами/сеттерами живых переменных (не копии);
    29 ссылок `D.<имя>` в телах модуля
  - Кластеры network/parser/pagination/loader НЕотделимы (AST-замыкание 84–95%,
    218/259 общих имён) — перенос на этап 3/3 (ES modules)
  - Регистрация перехватчика — программно в `background.js`
    (`world:'MAIN'`, `runAt:'document_start'`), НЕ через manifest.json  

## Критические проблемы (требуют рефакторинга)

### God-objects (senior-аудит 2026-09-13)

| Файл | Размер | Проблема |
|---|---|---|
| `core/gemini-intercept.js` | 330 KB | Перегружен: перехват + парсинг batchexecute + пагинация + loader + hidden scroll + Deep Research dedup |
| `core/content.js` | 229 KB | 30+ глобальных переменных, смешение ответственностей (state/widget/base/hybrid-tail/export) |

### План декомпозиции v2.0

**content.js →** (ЭТАП 1/3, ЗАВЕРШЁН, commit `370a217`)
- `state.js` (глобальное состояние: base/baseComplete/baseSeen)
- `widget.js` (виджет: createWidget/updateWidget/resetWidget)
- `base-handler.js` (обработка базы из сети)
- `hybrid-tail.js` (гибридный хвост DOM)
- `export-manager.js` (авто/ручной экспорт)

**gemini-intercept.js →** (ЭТАП 2/3, ЗАВЕРШЁН ЧАСТИЧНО, commit `994ae26`: только hidden-scroll; network/parser/pagination/loader перенесены на 3/3)
- `gemini-network.js` (перехват fetch/XHR)
- `gemini-batchexecute-parser.js` (парсинг protobuf + JSON)
- `gemini-pagination.js` (cursor, retries)
- `gemini-loader.js` (loader-detection)
- `gemini-hidden-scroll.js` (opacity=0, scrollTop=0)

**Переход на ES modules** (ЭТАП 3/3)
- `"type": "module"` в manifest
- Уменьшение глобального состояния (переход на классы/модули)

## Пост-релизная очередь low

| № | Проблема | Влияние |
|---|---|---|
| O-1 | DOM-мисдетект ChatGPT ~1 c после F5 | Мгновенный "морг" бейджа; итоговая цифра верная |
| O-7 | ✅ ЗАКРЫТО: экспорт DeepSeek с reasoning-цепочками (`[REASONING]`/`[ANSWER]`) | API reasoning ОТДАЁТ (фрагменты `THINK`); в v7 их выбрасывал `INCLUDE_THINKING=false` |
| O-9-подпись | `snapshot-at-manual` печатает `msgs=0` на Perplexity | Косметика диагностики; тело экспорта полное |
| O-15 | DeepSeek live-экспорт: потеря ходов и усечение 2 символов на границах фрагментов | Воспроизводится в чистом чате (без сторонних расширений); серверная история полная |
| O-11 | Две маски имён автоэкспорта + коллизия на GSA | Потеря копии за ту же минуту; данные целы |
| O-14 | Попап держит старый снимок после RESET в пустой чат | Косметика попапа |

**Платформенная заметка (не дефект):** GSA умеет урезать историю сервером (тред kk49: 59→6 сообщений). Расширение считает то, что сервер реально отдал.

## Технические детали

### Коммиты (последние 5)
```
2866474 feat(O-7): экспорт DeepSeek с reasoning-цепочками — core/deepseek-intercept.js v8: THINK-фрагменты → [REASONING]/[ANSWER]
be93f45 v2.0.1: O-1 бейдж ChatGPT без моргания после F5 + миграция 8 версионных сьютов
1bf630f docs: секция ручной установки (дистрибуция без магазина)
3191cba (tag: v2.0.0) v2.0.0: релизный коммит — бамп версии + миграция 8 версионных сьютов
322fd7e CI: зелёный Lint на чистом чекауте — .gitattributes eol=lf + условный skip версионных сьютов
```

### Структура проекта
```
ai-context-monitor-clean/
├── manifest.json (MV3, 3 permissions, 9 host_permissions)
├── core/
│   ├── content.js (1897 строк) ✅ декомпозирован (этап 1/3)
│   ├── state.js (416 строк) ✅
│   ├── widget.js (510 строк) ✅
│   ├── base-handler.js (218 строк) ✅
│   ├── hybrid-tail.js (162 строки) ✅
│   ├── export-manager.js (945 строк) ✅
│   ├── background.js (38 KB)
│   ├── gemini-intercept.js (4800 строк) — ядро связано (84–95%), остаток на 3/3
│   ├── gemini-hidden-scroll.js (356 строк) ✅ вынесен (этап 2/3)
│   ├── claude-intercept.js (88 KB)
│   ├── deepseek-intercept.js (54 KB)
│   ├── google-search-intercept.js (54 KB)
│   ├── perplexity-intercept.js (30 KB)
│   └── page-intercept.js (34 KB)
├── adapters/
│   ├── base-adapter.js (единый контракт)
│   ├── chatgpt-adapter.js
│   ├── gemini-adapter.js
│   ├── deepseek-adapter.js
│   ├── google-search-adapter.js
│   ├── claude-adapter.js
│   └── perplexity-adapter.js
├── utils/
│   ├── export-emit-pipeline.js (67 KB, чистые функции)
│   ├── gemini-intercept-logic.js (113 KB)
│   ├── gemini-batchexecute-parser.js (29 KB)
│   ├── google-search-folwr-parser.js (27 KB)
│   └── archive-import.js (36 KB)
├── options/options.js (57 KB)
├── tests/ (75 suites; helpers/content-source.js, helpers/gemini-intercept-source.js)
├── CHANGELOG.md
├── RELEASE_CHECKLIST.md
└── tools/edge-listing-metadata.txt (для Edge Add-ons)
```

### Конвенции

**Кодер:** DSH Desktop (DeepSeek Harness), workspace `ai-context-monitor-clean`  
**Модель:** deepseek-flash  
**Промпт кодеру:** режим act; контекст-перенос ≤3 строк; задача пунктами; список «не трогать»; ответ = diff + отчёт ≤10 строк  
**Сессии:** новая сессия для каждой задачи (не продолжать старую)

**Усилие рассуждений:** обязательный параметр в каждом промпте для DSH.  
- **Max** — архитектурные задачи (рефакторинг, декомпозиция, миграции)  
- **Medium** — мелкие фиксы (O-1, O-7, O-9-подпись, O-11, O-14)  
- **Low** — косметика (O-14 попап, комментарии)  
- **Формат:** первая строка промпта, перед `Режим: act`

**Тарификация DSH:** peak/off-peak (пик Пекин 09:00–12:00 и 14:00–18:00 = Екб 06:00–09:00 и 11:00–15:00; тяжёлые прогоны — вне пика)

### Приёмочная матрица (закрыта полностью для v1.19.3)

| Критерий | Статус |
|---|---|
| Ядро 6 адаптеров (виджет=бейдж=лог, модель из сети, полная база, сбросы/латчи) | ✅ |
| Автоэкспорт (ChatGPT, Gemini×2, DeepSeek, Claude, GSA, Perplexity) | ✅ |
| Четыре формата из одного чата (md/json/pdf/txt) | ✅ |
| Ru-локаль (options/privacy/docs, футер v1.19.0) | ✅ |
| Тесты 75/75, 1322 passed, 0 failed | ✅ |
| Версия 1.19.3 во всех точках вывода | ✅ |
| Публикация на GitHub (тег v1.19.3, Release, ассет 2.55 MB) | ✅ |

## Осознанные границы этапа 1/3

Эти элементы остались в `content.js` и кандидаты на этап 2/3:

1. **`aiCmLastSeenConvId`** — переменная оставлена в `content.js` из-за ReferenceError при инициализаторе (jsdom-прогон реального порядка загрузки выявил баг)
2. **Слушатель `ai-cm-full-history`** — source-level пин вместе с комментарием H23 (handshake самого `content.js`)

## Осознанные границы этапа 2/3 и решения

1. Chrome не перечитывает `js[]` под тем же `id` регистрации → смена id на
   `ai-cm-gemini-intercept-v2` + `unregisterContentScripts` старого:
   **решение B** — одним миграционным коммитом вместе с этапом 3/3.
2. Тулчейн выноса (build/verify/smoke) лежит в `tools/` (gitignored), воспроизводим.
3. Красный Lint на main (дефект чистого чекаута: gitignored-артефакты + CRLF)
   вылечен CI-хотфиксом (`322fd7e`); Lint на main теперь зелёный.

## CI-хотфикс v1.19.3 (commit `322fd7e`)

Проблема: Lint на main красный — 4 failed suites на чистом чекауте:
- `release-metadata.test.js` и `version-hygiene.test.js` читают gitignored-артефакт `tools/edge-listing-metadata.txt`
- `gemini-overlay-tape.test.js` и `gemini-floor-confirmed.test.js` — байтовые пины с `'\n'` падают на CRLF-чекауте (Windows + `core.autocrlf=true`)

Решение:
- `.gitattributes`: `*.js/.json/.html/.css/.md → text eol=lf`, `*.png → binary`
- `release.yml`: `.gitattributes` исключён из zip (не уезжает пользователю)
- Тесты: skip-логика точечная (гейт `describeListing` + `test.skip`), ассерты не ослаблены

Результат: workspace 75/1322/0, worktree 74 passed + 1 skipped / 0 failed


## Следующие шаги

1. ✅ Обновление GitHub (Release v1.19.3)
2. ✅ Этап 1/3: декомпозиция content.js → 5 модулей (`370a217`)
3. ✅ Этап 2/3: частичная декомпозиция gemini-intercept.js (`994ae26`) + живой прогон
4. ✅ CI-хотфикс (`322fd7e`) — Lint на main зелёный
5. ✅ Этап 3/3: миграция id регистрации `ai-cm-gemini-intercept-v2` (`be1a4a6`); ES modules для content scripts отложены до бандлера (решение — `ARCHITECTURE_STANDARDS.md`)
6. ✅ Релизный коммит v2.0.0: бамп версии + миграция 8 версионных сьютов + CHANGELOG/футер/listing + убран ключ-комментарий `//ESM`
7. ✅ O-1 (бейдж ChatGPT без моргания после F5) + ручная установка без магазина (`1bf630f`)
8. ✅ O-7: экспорт DeepSeek с reasoning-цепочками (`2866474`)
9. ⏳ Пост-релизная очередь low (O-9-подпись, O-11, O-14, O-15) → публикация Edge Add-ons
   
**История этапов 1/3–3/3** — см. секции «Декомпозиция v2.0» и «Следующие шаги» выше.

### Пост-релизная очередь low (после v2.0)
- O-1: DOM-мисдетект ChatGPT (усилие: Medium)
- O-7: ✅ экспорт DeepSeek с reasoning (`core/deepseek-intercept.js` v8: фрагменты `THINK` → секции `[REASONING]`/`[ANSWER]`; в detail добавлены `reasoningTexts`/`messages[].reasoning`)
- O-9-подпись: snapshot-at-manual (усилие: Medium)
- O-15: DeepSeek live-экспорт — парность ходов + целостность фрагментов reasoning/answer (усилие: Medium; воспроизводится в чистом чате)
- O-11: унификация масок имён (усилие: Medium)
- O-14: попап после RESET (усилие: Low)

### Финал: публикация в Edge Add-ons
- После стабилизации v2.0
- Использование `tools/edge-listing-metadata.txt`

---

## Контроль длины чата

Резюме актуально на 14 сентября 2026: этапы 1–3/3, CI-хотфикс, релизный коммит v2.0.0, v2.0.1 (O-1) и O-7 приняты; ES modules для content scripts отложены до бандлера (`ARCHITECTURE_STANDARDS.md`).  
Следующая синхронизация — после закрытия O-15 и публикации v2.0.2 в Edge Add-ons (листинг: `tools/edge-listing-metadata.txt`).
