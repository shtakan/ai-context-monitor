# PROJECT_HANDOFF.md (для нового чата)

## Состояние проекта

**Версия:** 2.0.0-alpha.1 (рефакторинг в процессе)  
**Стабильная версия:** 1.19.3 (commit `1f12cbf`, тег `v1.19.3`)  
**Статус GitHub:** ✅ Опубликован Release v1.19.3 (23 коммита запушены, тег создан, ассет `ai-context-monitor-v1.19.3.zip` собран GitHub Actions)  
**Статус Edge Add-ons:** готов к подаче после v2.0  
**Тесты:** 75 suites, 1322 passed, 6 skipped, 0 failed  
**Платформы:** ChatGPT, Gemini (обычный + Deep Research), DeepSeek, Claude, Perplexity, Google Search AI

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

## Критические проблемы (требуют рефакторинга)

### God-objects (senior-аудит 2026-09-13)

| Файл | Размер | Проблема |
|---|---|---|
| `core/gemini-intercept.js` | 330 KB | Перегружен: перехват + парсинг batchexecute + пагинация + loader + hidden scroll + Deep Research dedup |
| `core/content.js` | 229 KB | 30+ глобальных переменных, смешение ответственностей (state/widget/base/hybrid-tail/export) |

### План декомпозиции v2.0

**content.js →** (ЭТАП 1/3, в процессе)
- `state.js` (глобальное состояние: base/baseComplete/baseSeen)
- `widget.js` (виджет: createWidget/updateWidget/resetWidget)
- `base-handler.js` (обработка базы из сети)
- `hybrid-tail.js` (гибридный хвост DOM)
- `export-manager.js` (авто/ручной экспорт)

**gemini-intercept.js →** (ЭТАП 2/3, планируется)
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
| O-7 | Экспорт DeepSeek без reasoning-цепочек | Процент честный; файл без невидимого текста (продуктовое решение) |
| O-9-подпись | `snapshot-at-manual` печатает `msgs=0` на Perplexity | Косметика диагностики; тело экспорта полное |
| O-11 | Две маски имён автоэкспорта + коллизия на GSA | Потеря копии за ту же минуту; данные целы |
| O-14 | Попап держит старый снимок после RESET в пустой чат | Косметика попапа |

**Платформенная заметка (не дефект):** GSA умеет урезать историю сервером (тред kk49: 59→6 сообщений). Расширение считает то, что сервер реально отдал.

## Технические детали

### Коммиты (последние 3)
```
1f12cbf (HEAD -> main, tag: v1.19.3) M-14: bootstrap Perplexity с полным набором параметров (шаблон из отклонённого снимка); версия 1.19.3
ef95ab0 M-12+M-13: гейт сниффинга по slug страницы и целостность настроек автоэкспорта; версия 1.19.2
6968849 M-11: автоэкспорт Perplexity — распознан живой URL /search/<id>; версия 1.19.1
```

### Структура проекта
```
ai-context-monitor-clean/
├── manifest.json (MV3, 3 permissions, 9 host_permissions)
├── core/
│   ├── content.js (229 KB) ⚠️ god-object (этап 1/3 в процессе)
│   ├── background.js (38 KB)
│   ├── gemini-intercept.js (330 KB) ⚠️ god-object (этап 2/3)
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
├── tests/ (75 suites)
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
- **Формат:** первая строка промпта после `Режим: act`

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

## Следующие шаги

### Этап 1/3: декомпозиция content.js (в процессе)
- **Промпт для DSH:** декомпозиция `content.js` → 5 модулей
- **Ожидание:** diff + отчёт от DSH
- **Регресс:** все 75 тестов зелёные

### Этап 2/3: декомпозиция gemini-intercept.js (планируется)
- **Промпт для DSH:** декомпозиция `gemini-intercept.js` → 5 модулей
- **Усилие рассуждений:** Max
- **Регресс:** все 75 тестов зелёные, живой прогон на Gemini

### Этап 3/3: переход на ES modules
- **Промпт для DSH:** миграция на `"type": "module"`
- **Усилие рассуждений:** Max
- **Регресс:** все тесты, живые прогоны на 3 платформах

### Пост-релизная очередь low (после v2.0)
- O-1: DOM-мисдетект ChatGPT (усилие: Medium)
- O-7: экспорт DeepSeek с reasoning (усилие: Medium)
- O-9-подпись: snapshot-at-manual (усилие: Medium)
- O-11: унификация масок имён (усилие: Medium)
- O-14: попап после RESET (усилие: Low)

### Финал: публикация в Edge Add-ons
- После стабилизации v2.0
- Использование `tools/edge-listing-metadata.txt`

---

## Контроль длины чата

Резюме актуально на момент завершения публикации v1.19.3 (13 сентября 2026, ~20:00 Екб).  
При переносе в новый чат — обновить состояние этапа 1/3 после получения результата от DSH.
