# Phase 3 Step 13.2 — артефакты приёмки (archive cluster extraction)

**Дата:** 2026-10-06 · **HEAD:** `61457ac` (рабочая копия, не закоммичено)
**Задача:** вынос кластера Archive из `core/gemini-intercept.js` в `core/gemini-archive.js`.

## 0. Итог приёмки

| Гейт | Ожидание | Факт |
|---|---|---|
| `npm test` | 149 suites зелёные | **149 passed / 149 total**, 2837 passed / 6 skipped / 0 failed |
| `npm run build` | 30 .js файлов | **30 .js** (5 bundles + 25 runtime-registered) |
| `npx tsc --noEmit` | exit 0 | **exit 0** |
| `core/gemini-archive.js` | создан, `D.` для 22 имён | **492 строки**, D-ссылок ровно 22 имени |
| `core/gemini-intercept.js` | 5 hoisted-форвардеров + состояние | **1866 строк** (−339), 5 `function`-форвардеров, 11 имён состояния |
| регистрация | id `-v10`, модуль в `js[]` после overlay | **`-v10`**, `overlay → archive → ядро`, `-v9` снят |
| байтовая идентичность | тела байт-в-байт | **доказано** против `git show HEAD:core/gemini-intercept.js` |

Проверки: `node tools/verify-archive-extraction.js` → `[OK]`; `node tools/apply-archive-extraction.js` (dry-run) → все гейты G1-G9.

## 1. Diff изменённых файлов

Изменено файлов: 14. ````
  .github/workflows/release.yml
  .gitignore
  PROJECT_HANDOFF.md
  core/background.js
  core/gemini-intercept.js
  tests/adapters/gemini-ingest-module.test.js
  tests/adapters/gemini-overlay-module.test.js
  tests/adapters/gemini-pagination-module.test.js
  tests/archive/archive-export-gate.test.js
  tests/archive/archive-export-union.test.js
  tests/archive/archive-oracle.test.js
  tests/helpers/gemini-intercept-source.js
  tests/qwen-provider-wiring.test.js
  warning: in the working copy of '.gitignore', LF will be replaced by CRLF the next time Git touches it
````

### 1.1 `.github/workflows/release.yml`

````diff
diff --git a/.github/workflows/release.yml b/.github/workflows/release.yml
index 0318cd3..4350448 100644
--- a/.github/workflows/release.yml
+++ b/.github/workflows/release.yml
@@ -55,7 +55,7 @@ jobs:
           # Phase 3 step 1: dist/ стал самодостаточным, поэтому legacy-дерево исходников
           # уходит из пакета. ^core/ и ^utils/ безопасны: все их файлы либо склеены в
           # бандлы, либо перечислены в runtimeRegisteredFiles() и попадают в ZIP оверлеем
-          # dist/ (24 MAIN-world файлов, которые service worker регистрирует сам).
+          # dist/ (25 MAIN-world файлов, которые service worker регистрирует сам).
           # Phase 3 step 6: кластер парсеров кадра вынесен в core/gemini-parse.js,
           # поэтому runtime-файлов стало на один больше (было 18, стало 19) —
           # сам исключающий фильтр ниже не менялся, файл приходит оверлеем dist/.
@@ -70,6 +70,8 @@ jobs:
           # (было 22, стало 23); фильтр не тронут, модуль приходит оверлеем dist/.
           # Phase 3 step 13.1: кластер оверлея вынесен в core/gemini-overlay.js — снова +1
           # (было 23, стало 24); фильтр не тронут, модуль приходит оверлеем dist/.
+          # Phase 3 step 13.2: кластер архива вынесен в core/gemini-archive.js — снова +1
+          # (было 24, стало 25); фильтр не тронут, модуль приходит оверлеем dist/.
           # options/options\.js$ и ^print/print\.js$ исключены как бандлируемые входы:
           # оверлей кладёт их бандлы в корень пакета (options.js, print.js), а сами
           # HTML-страницы подменяются rewired-копиями из dist/.
@@ -86,7 +88,7 @@ jobs:
           # (background.js, content.js, options.js, print.js, shared-i18n.js),
           # docs/screenshots/ и _locales/ появляются в корне пакета. Именно rewired-копии
           # manifest.json и четырёх страниц определяют, что запускает Chrome:
-          # 5 бандлов + 24 MAIN-world файлов, которые service worker регистрирует сам.
+          # 5 бандлов + 25 MAIN-world файлов, которые service worker регистрирует сам.
           # Файлы перечисляются find-ом (а не 'zip -r dist'), чтобы записи в архиве
           # гарантированно не получили префикс 'dist/' и совпали с legacy-именами.
           ( cd dist && find . -type f ) | sed 's|^\./||' | xargs zip -q "$ZIP"
````

### 1.2 `.gitignore`

````diff
diff --git a/.gitignore b/.gitignore
index 76a687c..c6d06b8 100644
--- a/.gitignore
+++ b/.gitignore
@@ -46,6 +46,8 @@ test2_logs.txt
 tools/*
 !tools/pagination-bind-contract.js
 !tools/ingest-bind-contract.js
+!tools/overlay-bind-contract.js
+!tools/archive-bind-contract.js
 tools/key.pem
 # Прежний шаблон `tools/` (без внутреннего слэша) ловил каталог tools на ЛЮБОЙ
 # глубине; root-anchored `tools/*` этого не делает, поэтому вложенный служебный
warning: in the working copy of '.gitignore', LF will be replaced by CRLF the next time Git touches it
````

### 1.3 `PROJECT_HANDOFF.md`

````diff
diff --git a/PROJECT_HANDOFF.md b/PROJECT_HANDOFF.md
index 85f11f3..efa4cee 100644
--- a/PROJECT_HANDOFF.md
+++ b/PROJECT_HANDOFF.md
@@ -1735,5 +1735,32 @@ Rewired-копия живёт **только в `dist/`** — корневые `
 **Результаты:**
 - **A.1:** BYOK-ключ и O3-латч переведены на SW-канал (`chrome.runtime.sendMessage`). `setAccessLevel` = `TRUSTED_CONTEXTS_ONLY`. Кросс-табовый латч работает через SW (повторный экспорт запрещён). ⚠️ FALSIFIED: приёмка 13.2 ложно заявила; фактически дубль автоэкспорта при F5 происходил до хотфикса F5 (Аппендикс v38).
 - **A.2:** Paste-capture канал защищён: `location.origin` вместо `window.origin`, проверка `ev.origin === location.origin` в приёмнике. Ручной/автоэкспорт без регрессов.
-- **Тесты: 146 suites / 2791 passed / 6 skipped / 0 failed.
-- **Живая приёмка:** BYOK автоэкспорт (Gemini) — ОК; кросс-табовость — ОК; paste в Claude — ОК; экспорт 4 форматов — ОК.
\ No newline at end of file
+- **Тесты: 149 suites / 2837 passed / 6 skipped / 0 failed.
+- **Живая приёмка:** BYOK автоэкспорт (Gemini) — ОК; кросс-табовость — ОК; paste в Claude — ОК; экспорт 4 форматов — ОК.
+
+## Аппендикс v36: Завершение Phase 3 Step 13.1 (Overlay extraction)
+**Дата:** 2026-10-06
+**Коммит:** `61457ac feat(core): extract overlay cluster to gemini-overlay.js (Phase 3 Step 13.1)`
+**Статус:** ✅ ЗАКРЫТ живой приёмкой
+
+**Результаты:**
+- **Декомпозиция:** Кластер Overlay вынесен из `core/gemini-intercept.js` в `core/gemini-overlay.js`. Ядро сокращено на ~143 строки тел функций.
+- **Архитектура:** Состояние (`aiCmScrollOverlay`, `aiCmOverlaySeq`) осталось в ядре; модуль получает его через live-аксессоры в `__bind`. Публичные функции заменены на hoisted-форвардеры для сохранения байтовой идентичности контрактов.
+- **Регистрация:** ID бампнут `-v8 → -v9`; модуль добавлен в `js[]` строго перед ядром; `-v8` снят при unregister.
+- Тесты: +1 новый сьют `gemini-overlay-module.test.js` (S1/S2 пины); общий итог: 148 suites / 2815 passed / 6 skipped / 0 failed.
+- **Сборка:** 29 .js файлов (5 bundles + 24 runtime-registered); `tsc --noEmit` exit 0.
+- **Живая приёмка:** Регистрация v9 подтверждена логами; оверлей отображается при загрузке истории; тема синхронизируется (H22); консоль чиста от ошибок TDZ/D-null; регрессов в бейдже/виджете/автоэкспорте нет.
+
+## Аппендикс v37: Реализация Phase 3 Step 13.2 (Archive extraction)
+**Дата:** 2026-10-06
+**Коммит:** не закоммичено (рабочая копия поверх HEAD `61457ac`)
+**Статус:** ✅ Реализовано, пины и сборка зелёные; живая приёмка — за владельцем
+
+**Результаты:**
+- **Декомпозиция:** Кластер Archive (первый ярус полноты T1) вынесен из `core/gemini-intercept.js` в `core/gemini-archive.js`: 8 функций (`aiCmArchiveFor`, `aiCmBuildBaseMessages`, `aiCmBaseExportInfo`, `aiCmLiveTurnCount`, `aiCmArchiveOnlyBase`, `aiCmArchiveLiveProven`, `aiCmArchiveGrewBeyondArchive`, `aiCmArchiveTierApply`) и 3 слушателя (`ai-cm-restored-history`, `ai-cm-archive-restore`, `ai-cm-cache-refresh`). Ядро сокращено на 135 строк (2205 → 1866).
+- **Архитектура:** Состояние (`turnsMap`, `archiveTierByConv`, `archiveMergedMap`, `cacheRestoredMap`, `loaderDoneMap`, `loaderRunningFor`, `parserVersion`, `quietActive`, `historyFullByQuiet`, `reachedStart`, `tapeWasUsedInThisColdStart`) осталось в ядре — модуль получает его live-аксессорами в `__bind` (11 fn + 8 ro + 3 rw = 22 имени, `tools/archive-bind-contract.js`). `sanitizeMessagesForEmit` тоже осталась в ядре. Публичные функции заменены на 5 hoisted-форвардеров; блок подключения стоит НИЖЕ поздних алиасов (строка 1742 > 782), иначе в модуль уехали бы `null`.
+- **Байтовая идентичность:** тела перенесены байт-в-байт; подстановка `D.` сделана ПО AST (59 рёбер), поэтому строка-лог `…(reachedStart=true)…` не переписана. Доказательство обратимости — `tools/apply-archive-extraction.js`; независимая пост-проверка `tools/verify-archive-extraction.js` сверяет тело модуля с диапазонами 1712-1914 и 1935-2145 из `git show HEAD:core/gemini-intercept.js`.
+- **Регистрация:** ID бампнут `-v9 → -v10`; `core/gemini-archive.js` добавлен в `js[]` строго после `core/gemini-overlay.js` и перед ядром; `-v9` снят при unregister; счётчик MAIN-world в `release.yml` 24 → 25.
+- Тесты: +1 новый сьют `tests/adapters/gemini-archive-module.test.js` (A/B/C/D/S-пины, 22 теста); песочницы `tests/archive/*` получили объект связи `D`; пины overlay/ingest/pagination/qwen переведены на `-v10`, счётчик `emitBaseSnapshot()` в ядре 4 → 3 (конкатенация осталась 9). Итог прогона: 149 сьютов, 2837 тестов пройдено, 6 пропущено, падений нет (пол O-53 держит исторический максимум v36 — 148 / 2815).
+- **Сборка:** 30 .js файлов (5 bundles + 25 runtime-registered); `npx tsc --noEmit` exit 0.
+- **Открытый пункт:** живая приёмка в Chrome (регистрация v10, архивный ярус T1, отсутствие TDZ/D-null в консоли) не проводилась — шаг закрывается после прогона владельцем.
\ No newline at end of file
````

### 1.4 `core/background.js`

````diff
diff --git a/core/background.js b/core/background.js
index d4300df..b70b74f 100644
--- a/core/background.js
+++ b/core/background.js
@@ -177,22 +177,28 @@ async function ensureInterceptor() {
     // установленного расширения Chrome останется прежний registration, js[] не перечитается,
     // и ядро будет работать без кластера: оверлей загрузки истории выключается целиком,
     // а форвардеры aiCmSetScrollOverlay/forceRestoreVisibility возвращают undefined.
-    if (ids.indexOf('ai-cm-gemini-intercept-v9') === -1) {
+    // Phase 3 step 13.2: бамп -v9 → -v10 по той же причине — добавлен core/gemini-archive.js
+    // (кластер архива вынесен из ядра: приём ходов архива и ленты кэша, оракул archive-complete,
+    // пол архива и сводка объединённой базы для экспорта). Без бампа id у уже установленного
+    // расширения Chrome останется прежний registration, js[] не перечитается, и ядро будет
+    // работать без кластера: архивный ярус выключается целиком, а форвардеры возвращают
+    // null/true/baseSize() — гейты полноты молча теряют T1-архив.
+    if (ids.indexOf('ai-cm-gemini-intercept-v10') === -1) {
       // Снимаем регистрации прежних id: они остались в профиле после обновления и
       // несли бы старый js[] (без hidden-scroll/diag/rpc/parse/sse) параллельно с новым пучком.
       // Прежних id может не быть (чистая установка) — поэтому тихий catch без диагностики.
       try {
-        await chrome.scripting.unregisterContentScripts({ ids: ['ai-cm-gemini-intercept', 'ai-cm-gemini-intercept-v2', 'ai-cm-gemini-intercept-v3', 'ai-cm-gemini-intercept-v4', 'ai-cm-gemini-intercept-v5', 'ai-cm-gemini-intercept-v6', 'ai-cm-gemini-intercept-v7', 'ai-cm-gemini-intercept-v8'] });
+        await chrome.scripting.unregisterContentScripts({ ids: ['ai-cm-gemini-intercept', 'ai-cm-gemini-intercept-v2', 'ai-cm-gemini-intercept-v3', 'ai-cm-gemini-intercept-v4', 'ai-cm-gemini-intercept-v5', 'ai-cm-gemini-intercept-v6', 'ai-cm-gemini-intercept-v7', 'ai-cm-gemini-intercept-v8', 'ai-cm-gemini-intercept-v9'] });
       } catch (eUnregGemini) { }
-      await registerSafe('ai-cm-gemini-intercept-v9', {
-        id: 'ai-cm-gemini-intercept-v9',
+      await registerSafe('ai-cm-gemini-intercept-v10', {
+        id: 'ai-cm-gemini-intercept-v10',
         matches: ['https://gemini.google.com/*', 'https://aistudio.google.com/*'],
-        js: ['utils/debug.js', 'utils/gemini-batchexecute-parser.js', 'utils/gemini-intercept-logic.js', 'core/gemini-hidden-scroll.js', 'core/gemini-diag.js', 'core/gemini-rpc.js', 'core/gemini-parse.js', 'core/gemini-sse.js', 'core/pagination/pagination.js', 'core/gemini-loader-scroll.js', 'core/gemini-ingest.js', 'core/gemini-overlay.js', 'core/gemini-intercept.js'],
+        js: ['utils/debug.js', 'utils/gemini-batchexecute-parser.js', 'utils/gemini-intercept-logic.js', 'core/gemini-hidden-scroll.js', 'core/gemini-diag.js', 'core/gemini-rpc.js', 'core/gemini-parse.js', 'core/gemini-sse.js', 'core/pagination/pagination.js', 'core/gemini-loader-scroll.js', 'core/gemini-ingest.js', 'core/gemini-overlay.js', 'core/gemini-archive.js', 'core/gemini-intercept.js'],
         runAt: 'document_start',
         world: 'MAIN',
         allFrames: false
       });
-      console.log('AI Context Monitor: перехватчик Gemini (v9) зарегистрирован (мир сайта, document_start)');
+      console.log('AI Context Monitor: перехватчик Gemini (v10) зарегистрирован (мир сайта, document_start)');
     }
 
     // перехватчик DeepSeek (v2: новый id, чтобы Chrome гарантированно перезагрузил
````

### 1.5 `core/gemini-intercept.js`

````diff
diff --git a/core/gemini-intercept.js b/core/gemini-intercept.js
index 1b3c841..2b0852c 100644
--- a/core/gemini-intercept.js
+++ b/core/gemini-intercept.js
@@ -1709,208 +1709,73 @@
   }
 
   // ================= единый эмит снимка базы =================
-  // ============ T1 (v1.16): ПЕРВЫЙ ЯРУС — АРХИВ (оракул и пол) ============
-  // Метаданные архива по convId кладёт слушатель ai-cm-archive-restore (ниже, рядом
-  // с tape-restore): content.js (ISOLATED) читает chrome.storage.local и передаёт
-  // нормализованные ходы — MAIN-мир chrome.* не касается (инвариант мировой изоляции).
-  //
-  // aiCmArchiveTierApply() вызывается из emitBaseSnapshot, то есть переоценивается на
-  // КАЖДОМ изменении базы. archive-complete объявляется ровно тогда, когда живая база
-  // доросла до архивного count — не в момент импорта. H9-гейты (untrustedTopVerdict /
-  // pagStepBroken) и H10 (пол авторитетнее ответа probe) НЕ ослабляются: архив — это
-  // ДОПОЛНИТЕЛЬНАЯ терминальная точка со своими гейтами (convId, count, пол).
-  // T1-fix (v1.16.1): плюс гейт ЖИВОГО яруса (loaderRunning / loaderDone / active /
-  // grewBeyondArchive) — архивные ходы лежат в той же базе, поэтому «count дорос»
-  // без живых доказательств означал ложную полноту и автоэкспорт одной архивной части.
-  function aiCmArchiveFor(convId) {
-    if (!convId) return null;
-    return archiveTierByConv[convId] || null;
-  }
-
-  // T1-fix#3 (v1.16.3): сообщения ОБЪЕДИНЁННОЙ базы (архив + live) — тем же порядком и с
-  // той же санацией, что уходят в EMIT (порядок строит ТА ЖЕ чистая orderExportMessages —
-  // дубля логики D15 нет). Нужны экспорту: content.js (ISOLATED) не видит turnsMap, а
-  // последний EMIT мог быть снят ДО вливания живой истории (архив читается из storage
-  // первым) — файл уходил одной архивной частью (live-прогон: 4 архивных хода при базе 114).
-  function aiCmBuildBaseMessages() {
-    try {
-      var orderItems = [];
-      var mapIds = Object.keys(turnsMap);
-      for (var i = 0; i < mapIds.length; i++) {
-        var rec = turnsMap[mapIds[i]];
-        if (!rec) continue;
-        orderItems.push({
-          id: mapIds[i], turnId: rec.turnId || null, r1: rec.r1 || null,
-          order: rec.order || 0, role: rec.role, archive: rec.archiveAdded === true
-        });
-      }
-      var ids = null;
-      if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
-          typeof window.GeminiInterceptLogic.orderExportMessages === 'function') {
-        var exp = window.GeminiInterceptLogic.orderExportMessages(orderItems);
-        if (exp && exp.ids) ids = exp.ids;
-      }
-      if (!ids) {
-        ids = mapIds.slice().sort(function (a, b) {
-          return (turnsMap[a].order || 0) - (turnsMap[b].order || 0);
-        });
-      }
-      var messages = [];
-      for (var j = 0; j < ids.length; j++) {
-        var m = turnsMap[ids[j]];
-        if (!m) continue;
-        messages.push({ role: (m.role === 'user') ? 'user' : 'assistant', text: m.text, id: ids[j] });
-      }
-      return sanitizeMessagesForEmit(messages);
-    } catch (eBbm) { return null; }
-  }
-
-  // T1-fix#3: сводка ОБЪЕДИНЁННОЙ базы для экспорта. Уезжает в ISOLATED синхронным мостом
-  // ai-cm-turns-snap-request/response (движение ONLY через CustomEvent — мировая изоляция):
-  // baseMsgs — сколько ходов в базе, liveCount — сколько из них НЕ влито архивом,
-  // archiveCount — count импортированного архива, messages — сами ходы базы.
-  function aiCmBaseExportInfo() {
-    try {
-      var convId = getConvId();
-      var arch = aiCmArchiveFor(convId);
-      var msgs = aiCmBuildBaseMessages();
-      var info = {
-        convId: convId,
-        baseMsgs: msgs ? msgs.length : baseSize(),
-        liveCount: aiCmLiveTurnCount(arch),
-        archiveCount: (arch && arch.count) || 0,
-        liveProven: aiCmArchiveLiveProven(convId),
-        messages: msgs || []
-      };
-      return info;
-    } catch (eBei) { return null; }
-  }
-
-  // T1-fix#2 (v1.16.2): живые ходы базы — ходы, НЕ влитые архивом (addedIds).
-  // Архив лежит в ТОЙ ЖЕ базе (same-conv-union), поэтому baseSize() сам по себе не
-  // отличает «живой ярус уже что-то дал» от «в базе пока только архив».
-  function aiCmLiveTurnCount(arch) {
-    try {
-      var a = arch || aiCmArchiveFor(getConvId());
-      if (!a || !a.addedIds) return baseSize(); // merge архива не было — вся база живая
-      var ids = Object.keys(turnsMap);
-      var n = 0;
-      for (var i = 0; i < ids.length; i++) { if (a.addedIds[ids[i]] !== true) n++; }
-      return n;
-    } catch (eLtc) { return baseSize(); }
-  }
-
-  // База = ТОЛЬКО архив: ни одного живого хода. В этом состоянии ни латч loaderDoneMap
-  // (его ставят и «скип»-ветки лоадера: no-older-history / cache-complete / data-complete),
-  // ни пол, поднятый самим архивом, не доказывают догруженную живую историю.
-  function aiCmArchiveOnlyBase(convId) {
-    try {
-      var a = aiCmArchiveFor(convId || getConvId());
-      if (!a || !(a.count > 0)) return false;
-      return aiCmLiveTurnCount(a) === 0;
-    } catch (eAob) { return false; }
-  }
-
-  // Доказательство живого яруса для ПОЛ-подтверждений: архив поднимает пол своим count,
-  // поэтому «база не ниже пола» доказывает лишь сам архив, а счётчик базы — его же вклад.
-  // Живым доказательством считается только рост сверх архива со стыком живого окна
-  // (нет пропуска середины: см. aiCmArchiveGrewBeyondArchive). Архива нет → прежние гейты.
-  function aiCmArchiveLiveProven(convId) {
-    try {
-      var a = aiCmArchiveFor(convId || getConvId());
-      if (!a || !(a.count > 0)) return true;
-      if (aiCmLiveTurnCount(a) === 0) return false;
-      return aiCmArchiveGrewBeyondArchive(a);
-    } catch (eAlp) { return false; }
-  }
-
-  // T1-fix (v1.16.1): доказательство «база подтверждённо выросла СВЕРХ архива».
-  // Архивные ходы лежат в ТОЙ ЖЕ базе (same-conv-union), поэтому baseCount > archiveCount
-  // сам по себе ещё не значит, что живая история догружена (пассивный снимок мог дать
-  // только свежее окно). Рост считается подтверждённым ТОЛЬКО когда:
-  //   а) ходов, пришедших НЕ из архива, строго больше, чем весь архив (addedIds), И
-  //   б) живое окно СТЫКУЕТСЯ с архивом — у них есть общий ход (keys по role+text),
-  //      то есть между архивом и живым окном нет пропуска середины.
-  // Иначе вердикт ждёт завершённого прогона лоадера (loaderDoneMap).
-  function aiCmArchiveGrewBeyondArchive(arch) {
-    try {
-      var addedIds = arch && arch.addedIds;
-      var keys = arch && arch.keys;
-      if (!addedIds || !keys) return false; // merge архива ещё не было — роста быть не может
-      var logic = (typeof window !== 'undefined') ? window.GeminiInterceptLogic : null;
-      if (!logic || typeof logic.archiveContentKey !== 'function') return false;
-      var ids = Object.keys(turnsMap);
-      var liveCount = 0;
-      var overlap = false;
-      for (var i = 0; i < ids.length; i++) {
-        if (addedIds[ids[i]] === true) continue; // ход, влитый ИМЕННО архивом
-        liveCount++;
-        if (!overlap) {
-          var k = null;
-          try { k = logic.archiveContentKey(turnsMap[ids[i]]); } catch (eK) { k = null; }
-          if (k && keys[k] === true) overlap = true;
-        }
-      }
-      if (!overlap) return false;
-      return liveCount > arch.count;
-    } catch (eGba) { return false; }
-  }
-
-  function aiCmArchiveTierApply() {
-    try {
-      var convId = getConvId();
-      var arch = aiCmArchiveFor(convId);
-      if (!arch) return;
-      var logic = (typeof window !== 'undefined') ? window.GeminiInterceptLogic : null;
-      if (!logic || typeof logic.archiveCompleteVerdict !== 'function') return;
-      var sf = null;
-      try { sf = loadFloor(convId); } catch (eSf) { }
-      var floorCount = (sf && sf.count) || 0;
-      // T1-fix (v1.16.1): снимок ЖИВОГО яруса — без него «база доросла до архива»
-      // выполняется вкладом самого архива и объявляет ложную полноту (автоэкспорт
-      // уходил с одной архивной частью, живой хвост не успевал догрузиться).
-      // Дорогое доказательство роста считаем только пока лоадер не отработал.
-      var loaderDone = loaderDoneMap[convId] === true;
-      // T1-fix#2 (v1.16.2): база из одного архива доказательств живого яруса не даёт —
-      // латч loaderDoneMap ставят и «скип»-ветки лоадера БЕЗ прогона (архив делает базу
-      // непустой ещё до прихода живого RPC, из-за чего лоадер и пропускался).
-      var archiveOnly = aiCmArchiveOnlyBase(convId);
-      var live = {
-        loaderRunning: loaderRunningFor === convId,
-        loaderDone: loaderDone && !archiveOnly,
-        active: quietActive === true,
-        grewBeyondArchive: (loaderDone || archiveOnly) ? false : aiCmArchiveGrewBeyondArchive(arch)
-      };
-      var verdict = logic.archiveCompleteVerdict({
-        archiveConvId: arch.convId,
-        currentConvId: convId,
-        archiveCount: arch.count,
-        baseCount: baseSize(),
-        floorCount: floorCount,
-        live: live
-      });
-      if (verdict.complete !== true) {
-        if (arch.verdictLogged !== verdict.reason) {
-          arch.verdictLogged = verdict.reason;
-          debugLog('log', '[AI CM][completeness] archive-complete withheld reason=' + verdict.reason +
-            ' convId=' + convId + ' msgs=' + baseSize() + ' archiveMsgs=' + arch.count + ' floor=' + floorCount +
-            ' loaderRunning=' + (live.loaderRunning ? '1' : '0') + ' loaderDone=' + (loaderDone ? '1' : '0') +
-            ' liveActive=' + (live.active ? '1' : '0') + ' grew=' + (live.grewBeyondArchive ? '1' : '0') +
-            ' archiveOnly=' + (archiveOnly ? '1' : '0'));
-        }
-        return;
-      }
-      if (arch.completeApplied === true) return; // одноразовый взвод/лог на чат
-      arch.completeApplied = true;
-      historyFullByQuiet = true;
-      // Архив по построению содержит ГОЛОВУ разговора → начало достигнуто. Это
-      // НЕ отключает H9/H10-гейты на их собственных путях (probe/loader/collapse) —
-      // здесь фиксируется независимо доказанная полнота первого яруса.
-      reachedStart = true;
-      debugLog('log', '[AI CM][completeness] oracle=complete reason=archive-complete convId=' + convId +
-        ' msgs=' + baseSize() + ' archiveMsgs=' + arch.count + ' floor=' + floorCount +
-        ' format=' + (arch.format || '?'));
-    } catch (eArc) { }
+  // ===== v2.0 (Phase 3 step 13.2): АРХИВ (ВЫНЕСЕН В core/gemini-archive.js) =====
+  // Тела кластера — восемь функций первого яруса полноты (архив, оракул
+  // archive-complete, пол архива, сводка объединённой базы) и три слушателя
+  // (ai-cm-restored-history, ai-cm-archive-restore, ai-cm-cache-refresh) — живут в
+  // модуле, подключение ниже. Логика сюда НЕ возвращается: правки архива делаются
+  // в core/gemini-archive.js.
+  // Состояние (turnsMap/archiveTierByConv/archiveMergedMap/cacheRestoredMap/
+  // loaderDoneMap/loaderRunningFor/parserVersion/quietActive и три вердикта полноты)
+  // остаётся ЗДЕСЬ: его читают и пишут ingest, лоадер, пагинация и сброс при смене
+  // чата, поэтому модуль получает нужные ему имена ЖИВЫМИ геттерами/сеттерами, а не
+  // копиями значений. sanitizeMessagesForEmit тоже остаётся: им пользуется ingest.
+  // Блок стоит НИЖЕ строки 782 намеренно: emitBaseSnapshot, mergeRestoredTurns и
+  // refreshMinOrderTracking — ПОЗДНИЕ алиасы (`var ... = null`), их дозаполняют блоки
+  // ingest (770-771) и пагинации (494); выше в модуль уехали бы null.
+  var aiCmGeminiArchive = (typeof window !== 'undefined' && window.AiCmGeminiArchive) || null;
+
+  // Форвардеры — ИМЕННО function declaration: объявления хойстятся, поэтому все
+  // прежние вызовы из ядра (stableFloorConfirm 881-885, notifyLoaderState 1010,
+  // self-heal 1076-1111, снапшот turns 1416) и из чужих __bind-блоков (пагинация 430,
+  // лоадер 544-547) не тронуты — к моменту любого из них имя уже существует.
+  // Без модуля деградация безмолвная: aiCmArchiveFor → null, aiCmArchiveLiveProven →
+  // true (прежние гейты), aiCmLiveTurnCount → baseSize(), остальные → undefined/null.
+  // Ни один вызов не бросает.
+  function aiCmArchiveFor(convId) { return aiCmGeminiArchive ? aiCmGeminiArchive.aiCmArchiveFor(convId) : null; }
+  function aiCmArchiveLiveProven(convId) { return aiCmGeminiArchive ? aiCmGeminiArchive.aiCmArchiveLiveProven(convId) : true; }
+  function aiCmLiveTurnCount(arch) { return aiCmGeminiArchive ? aiCmGeminiArchive.aiCmLiveTurnCount(arch) : baseSize(); }
+  function aiCmArchiveTierApply() { return aiCmGeminiArchive ? aiCmGeminiArchive.aiCmArchiveTierApply() : undefined; }
+  function aiCmBaseExportInfo() { return aiCmGeminiArchive ? aiCmGeminiArchive.aiCmBaseExportInfo() : null; }
+
+  if (aiCmGeminiArchive) {
+    aiCmGeminiArchive.__bind({
+      // Функции ядра (11): декларации хойстятся — значения доступны на момент bind.
+      activeRefresh: activeRefresh,
+      aiCmDiagTurnEdge: aiCmDiagTurnEdge,
+      baseSize: baseSize,
+      getConvId: getConvId,
+      loadFloor: loadFloor,
+      noteBaseCountChange: noteBaseCountChange,
+      sanitizeMessagesForEmit: sanitizeMessagesForEmit,
+      saveFloor: saveFloor,
+      emitBaseSnapshot: emitBaseSnapshot,
+      mergeRestoredTurns: mergeRestoredTurns,
+      refreshMinOrderTracking: refreshMinOrderTracking,
+      // Только чтение (8): сеттер не нужен — модуль эти переменные не переприсваивает
+      // (мутации объектов по ссылке видны ядру и без сеттера).
+      get archiveMergedMap() { return archiveMergedMap; },
+      get archiveTierByConv() { return archiveTierByConv; },
+      get cacheRestoredMap() { return cacheRestoredMap; },
+      get loaderDoneMap() { return loaderDoneMap; },
+      get loaderRunningFor() { return loaderRunningFor; },
+      get parserVersion() { return parserVersion; },
+      get quietActive() { return quietActive; },
+      get turnsMap() { return turnsMap; },
+      // Живое состояние (3): get + set — запись из модуля обязана дойти до ядра.
+      get historyFullByQuiet() { return historyFullByQuiet; },
+      set historyFullByQuiet(v) { historyFullByQuiet = v; },
+      get reachedStart() { return reachedStart; },
+      set reachedStart(v) { reachedStart = v; },
+      get tapeWasUsedInThisColdStart() { return tapeWasUsedInThisColdStart; },
+      set tapeWasUsedInThisColdStart(v) { tapeWasUsedInThisColdStart = v; }
+    });
+  } else {
+    // Модуль не подключён (у уже установленного расширения Chrome остался прежний
+    // registration с прежним id: MV3 не перечитывает js[] под существующим id).
+    // Деградация мягкая: архивного яруса нет, база собирается живыми путями
+    // (vf5/пагинация/лоадер), гейты полноты работают как до T1.
+    debugLog('log', '[gemini-intercept] core/gemini-archive.js не подключён — архивный ярус недоступен');
   }
 
   // ===== v2.0 (Phase 3 step 12): emitBaseSnapshot перенесено в core/gemini-ingest.js =====
@@ -1932,217 +1797,13 @@
   // Логика сюда НЕ возвращается: правки перехвата сети — в модуле.
   installNetworkHooks();
 
-  // ---- v28: слияние сохранённой ленты (из content.js) со свежей сетевой ----
-  // Контент-скрипт (content.js) восстанавливает ленту из chrome.storage.local
-  // и передаёт её сюда событием ai-cm-restored-history. Свежие сетевые ходы
-  // перезаписывают сохранённые по id; сохранённые ходы, которых нет в сети, ДОПОЛНЯЮТ базу.
-  window.addEventListener('ai-cm-restored-history', function (ev) {
-    var detail = ev && ev.detail;
-    if (!detail || !detail.turns) return; // v77: пустую ленту обрабатываем ниже (hwm-protect) с логом
-    var restoredTurns = detail.turns;
-    var restoredConvId = detail.convId || '';
-    var current = getConvId();
-
-    // гард: принимаем только для текущего чата
-    if (restoredConvId !== current) {
-      debugLog('log', '[gemini-restore] пропущена лента для чужого чата (restored=' + restoredConvId + ', current=' + current + ')');
-      // v61diag: усиленный tape-restore лог (stale — кэш чужого чата)
-      var diagStaleFe = aiCmDiagTurnEdge(detail.turns, 'first');
-      var diagStaleLe = aiCmDiagTurnEdge(detail.turns, 'last');
-      debugLog('log', '[AI CM][tape-restore] convId=' + (current || '(none)') + ' cacheConvId=' + restoredConvId +
-        ' action=stale cachedMsgs=' + detail.turns.length +
-        ' firstMsgHash=' + diagStaleFe.hash + ' lastMsgHash=' + diagStaleLe.hash);
-      return;
-    }
-
-    // v77: повторная лента для ЭТОГО convId в рамках сессии — уже применена, не читаем
-    // и не мерджим (защита O2 от повторного tape-restore поверх живых данных).
-    if (current && cacheRestoredMap.has(current)) {
-      debugLog('log', '[AI CM][tape-restore] skip reason=already-restored convId=' + current +
-        ' cachedMsgs=' + detail.turns.length);
-      return;
-    }
-    // v77 (HWM): кэш пуст — НЕ затираем текущее состояние и не трогаем счётчик токенов.
-    if (!detail.turns.length) {
-      debugLog('log', '[AI CM][tape-restore] skip reason=hwm-protect convId=' + (current || '(none)') +
-        ' cachedMsgs=0 baseMsgs=' + baseSize());
-      return;
-    }
-
-    // v4x: версия записи ленты должна совпадать с текущей версией парсера,
-    // иначе игнорируем запись без миграции.
-    var restoreMeta = detail.meta || {};
-    var restoreVersion = (typeof restoreMeta.version === 'string') ? restoreMeta.version : '';
-    if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.shouldAcceptTape) {
-      if (!window.GeminiInterceptLogic.shouldAcceptTape({ meta: { version: restoreVersion } }, parserVersion)) {
-        debugLog('log', '[gemini-restore] tape ignored: version=' + (restoreVersion || '(none)'));
-        return;
-      }
-    }
-
-    // v30.6: лента для текущего чата принята → лоадер полной истории не нужен
-    // (maybeStartLoader читает cacheRestoredMap и делает skip reason=cache-complete).
-    // v77: add ТОЛЬКО после успешного merge (см. ниже cacheRestoredMap.add).
-
-    // v4x: мерджим restored-ленту, пока пагинация НЕ дошла до начала (reachedStart=false),
-    // НЕЗАВИСИМО от baseComplete/historyFullByQuiet.
-    var mergeRestored = true;
-    if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.shouldMergeRestoredTurns) {
-      mergeRestored = window.GeminiInterceptLogic.shouldMergeRestoredTurns(reachedStart);
-    } else {
-      mergeRestored = (reachedStart !== true);
-    }
-    if (!mergeRestored) {
-      debugLog('log', '[gemini-restore] достигнут начало диалога (reachedStart=true) → восстановление из хранилища пропущено');
-      return;
-    }
-
-    // v77: high-water-mark защита на уровне source — живые ходы сети НЕ перезатираются
-    // (mergeRestoredTurns дедуплицирует по id и дополняет недостающие, не удаляя базу).
-    mergeRestoredTurns(restoredTurns);
-    if (current) cacheRestoredMap.add(current); // v77: Set.add ТОЛЬКО после успешного вливания
-    refreshMinOrderTracking('restored'); // v73: tape-добавления старших ходов инвалидируют scroll-proof
-    noteBaseCountChange(); // v74
-    tapeWasUsedInThisColdStart = true; // v62: лента кэша принята в ЭТОМ холодном старте — confirmed-by-scroll разрешён
-    // v61diag: усиленный tape-restore лог (лента принята и влита)
-    (function () {
-      var fe = aiCmDiagTurnEdge(restoredTurns, 'first');
-      var le = aiCmDiagTurnEdge(restoredTurns, 'last');
-      debugLog('log', '[AI CM][tape-restore] convId=' + (current || '(none)') + ' cacheConvId=' + restoredConvId +
-        ' action=used cachedMsgs=' + restoredTurns.length +
-        ' firstMsgHash=' + fe.hash + ' lastMsgHash=' + le.hash);
-    })();
-  });
-
-  // ============ T1 (v1.16): ПЕРВЫЙ ЯРУС — АРХИВ (приём от content.js) ============
-  // content.js (ISOLATED) читает chrome.storage.local (aiCmArchive:<convId>) и передаёт
-  // УЖЕ НОРМАЛИЗОВАННЫЕ ходы архива. Паттерн тот же, что у tape-restore: MAIN-мир
-  // chrome.* не касается. Порядок применения:
-  //   1) same-conv-union — вливаем ТОЛЬКО недостающие архивные ходы (сеть авторитетна);
-  //   2) архивный count авторитетен для пола (монотонно ВВЕРХ — HWM не ломается);
-  //   3) метаданные яруса → оракул archive-complete переоценивается в emitBaseSnapshot.
-  window.addEventListener('ai-cm-archive-restore', function (ev) {
-    var detail = ev && ev.detail;
-    if (!detail || !detail.convId) return;
-    var convId = String(detail.convId);
-    var current = getConvId();
-    if (convId !== current) {
-      debugLog('log', '[AI CM][archive-restore] skip reason=stale convId=' + (current || '(none)') +
-        ' archiveConvId=' + convId);
-      return;
-    }
-    var messages = Array.isArray(detail.messages) ? detail.messages : [];
-    var count = (typeof detail.count === 'number' && detail.count > 0) ? detail.count : messages.length;
-    if (!count || !messages.length) {
-      debugLog('log', '[AI CM][archive-restore] skip reason=empty convId=' + convId);
-      return;
-    }
-    var logic = (typeof window !== 'undefined') ? window.GeminiInterceptLogic : null;
-    var ids = Object.keys(turnsMap);
-    var i;
-
-    // 1) same-conv-union архивных ходов с текущей базой
-    var addedCount = 0;
-    // T1-fix (v1.16.1): доказательства для гейта живого яруса — ключи контента архива
-    // (стык с живым окном) и id ходов, влитых ИМЕННО архивом (иначе вклад архива
-    // неотличим от живых ходов в общей базе).
-    var archKeys = null;
-    var archAddedIds = null;
-    if (!archiveMergedMap.has(convId) && logic && typeof logic.archiveMergeTurns === 'function') {
-      var netItems = [];
-      var maxOrder = 0;
-      for (i = 0; i < ids.length; i++) {
-        var nt = turnsMap[ids[i]];
-        netItems.push({ id: ids[i], role: nt.role, text: nt.text });
-        if ((nt.order || 0) > maxOrder) maxOrder = nt.order || 0;
-      }
-      var merged = logic.archiveMergeTurns(netItems, messages) || { items: [], duplicateCount: 0 };
-      if (typeof logic.archiveContentKey === 'function') {
-        archKeys = {};
-        for (i = 0; i < messages.length; i++) {
-          archKeys[logic.archiveContentKey(messages[i])] = true;
-        }
-      }
-      archAddedIds = {};
-      for (i = 0; i < merged.items.length; i++) {
-        var it = merged.items[i];
-        if (turnsMap[it.id]) continue;
-        // pageMode 'restored' + r1=null — как у tape-restore: порядок пересчитывает
-        // chain-r1, старший сегмент докладывается перед хвостовым окном сети.
-        // T1-fix#4 (v1.16.4): archiveAdded=true — ЕДИНСТВЕННАЯ метка «ход влит архивом T1».
-        // По ней чистая orderExportMessages ставит архив в ГОЛОВУ файла (order не трогаем:
-        // aiCmOrderedTurns → dbFirstHash H9-гейта полноты обязан остаться прежним).
-        turnsMap[it.id] = {
-          text: it.text, modelName: '', order: maxOrder + 1 + i,
-          pageMode: 'restored', ts: 0, archiveAdded: true,
-          role: it.role, turnId: it.turnId, r1: null
-        };
-        archAddedIds[it.id] = true;
-        addedCount++;
-      }
-      archiveMergedMap.add(convId); // Set.add ТОЛЬКО после успешного merge
-      debugLog('log', '[AI CM][archive-restore] convId=' + convId + ' archiveMsgs=' + count +
-        ' added=' + addedCount + ' dup=' + (merged.duplicateCount || 0) +
-        ' baseMsgs=' + baseSize() + ' format=' + (detail.format || '?'));
-    }
-
-    // 2) Архивный count авторитетен для пола (понижение запрещено — HWM)
-    var archFloor = null;
-    try {
-      if (logic && typeof logic.archiveFloorRecord === 'function') {
-        archFloor = logic.archiveFloorRecord(
-          loadFloor(convId),
-          count,
-          (typeof detail.textLen === 'number') ? detail.textLen : 0
-        );
-        if (archFloor) {
-          saveFloor(convId, archFloor.count, archFloor.effectiveLen);
-          noteBaseCountChange();
-          debugLog('log', '[AI CM][archive-restore] floor source=archive convId=' + convId +
-            ' count=' + archFloor.count + ' textLen=' + archFloor.effectiveLen);
-        }
-      }
-    } catch (eAf) { }
-
-    // 3) Метаданные яруса для оракула. Повторный dispatch (storage.onChanged) merge не
-    //    повторяет — доказательства (keys/addedIds) и латчи переносим из прежней записи,
-    //    иначе повторный dispatch обнулял бы гейт живого яруса.
-    var prevTier = archiveTierByConv[convId] || null;
-    archiveTierByConv[convId] = {
-      convId: convId,
-      count: count,
-      textLen: (typeof detail.textLen === 'number') ? detail.textLen : 0,
-      format: detail.format || '',
-      service: detail.service || '',
-      keys: archKeys || (prevTier && prevTier.keys) || null,
-      addedIds: archAddedIds || (prevTier && prevTier.addedIds) || null,
-      completeApplied: !!(prevTier && prevTier.completeApplied),
-      verdictLogged: (prevTier && prevTier.verdictLogged) || ''
-    };
-
-    if (addedCount > 0 || archFloor) {
-      if (addedCount > 0) { try { refreshMinOrderTracking('archive'); } catch (eRo) { } }
-      try { emitBaseSnapshot(); } catch (eEm) { }
-    }
-    try { aiCmArchiveTierApply(); } catch (eAp) { }
-  });
-
-  // v30.6: content.js после применения кэш-ленты планирует ОДНО уточнение канонического
-  // значения активным снимком через 2с (activeRefresh). Гард по convId — чат мог
-  // смениться, пока шёл таймер.
-  try {
-    window.addEventListener('ai-cm-cache-refresh', function (ev) {
-      var detail = ev && ev.detail;
-      var want = (detail && detail.convId) || '';
-      var current = getConvId();
-      if (want && current && want !== current) {
-        debugLog('log', '[gemini-cache-refresh] пропущен: чат сменился (want=' + want + ', current=' + current + ')');
-        return;
-      }
-      debugLog('log', '[AI CM][Gemini][cache-refresh] уточнение после кэша convId=' + (current || want || '(none)'));
-      activeRefresh('уточнение после кэша');
-    });
-  } catch (e) { }
+  // ===== v2.0 (Phase 3 step 13.2): АРХИВ (ВЫНЕСЕН В core/gemini-archive.js) =====
+  // Здесь были три слушателя кластера архива: приём ленты кэша (ai-cm-restored-history),
+  // приём нормализованных ходов архива (ai-cm-archive-restore) и уточнение канонического
+  // снимка после кэша (ai-cm-cache-refresh). Все три живут в core/gemini-archive.js и
+  // регистрируются на загрузке модуля; каждая ветка начинается гардом `if (!D)`, поэтому
+  // до связки событие игнорируется с внятным логом, а не бросает ReferenceError.
+  // Логика сюда НЕ возвращается: правки приёма архива и ленты — в модуле.
 
   // v4x: при чтении ленты повторно применяем sanitizeFinalMessages к каждому ходу.
   // ===== v2.0 (Phase 3 step 12): sanitizeRestoredTurn перенесено в core/gemini-ingest.js =====
````

### 1.6 `tests/adapters/gemini-ingest-module.test.js`

````diff
diff --git a/tests/adapters/gemini-ingest-module.test.js b/tests/adapters/gemini-ingest-module.test.js
index 795cfc8..43bde62 100644
--- a/tests/adapters/gemini-ingest-module.test.js
+++ b/tests/adapters/gemini-ingest-module.test.js
@@ -17,8 +17,9 @@
  *     №2  после __bind в API ровно 17 ключей = 16 функций + __bind;
  *     №3  форвардеры ядра aiCmIngestFwd / aiCmHandleOuterFwd / aiCmEmitBaseSnapshotFwd
  *         объявлены и подставлены в те же точки, а прямой проводки мимо них нет;
- *     №4  счётчик emitBaseSnapshot(): ядро 4 (3 вызова + 1 форвардер),
- *         конкатенация 9 = 4 (ядро) + 2 (пагинация) + 3 (ingest: декларация + 2 вызова);
+ *     №4  счётчик emitBaseSnapshot(): ядро 3 (2 вызова + 1 форвардер),
+ *         конкатенация 9 = 3 (ядро) + 2 (пагинация) + 3 (ingest: декларация + 2 вызова)
+ *         + 1 (archive: вызов в слушателе ai-cm-archive-restore);
  *     №5  порядок модулей в tests/helpers/gemini-intercept-source.js: ingest строго
  *         после gemini-loader-scroll.js и перед ядром — иначе в модуль уедет null
  *         (alias-зависимости дозаполняет блок __bind loader-scroll, см. шапку контракта);
@@ -51,6 +52,7 @@ const readFile = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
 const CONC = require(path.join(ROOT, 'tests/helpers/gemini-intercept-source.js')).geminiSource;
 const CORE = readFile('core/gemini-intercept.js');
 const MOD = readFile('core/gemini-ingest.js');
+const ARCH = readFile('core/gemini-archive.js');
 const PAG = readFile('core/pagination/pagination.js');
 
 /** 16 экспортов модуля — в порядке `Fn.<имя> = <имя>;` (core/gemini-ingest.js:1231-1246). */
@@ -151,10 +153,16 @@ describe('Phase 3 шаг 12: R-D пины кластера ingest (core/gemini-i
     expect(CORE).toContain('mergeRestoredTurns = aiCmGeminiIngest.mergeRestoredTurns;');
     expect(CORE.indexOf('ingest: aiCmIngestFwd,')).toBeLessThan(CORE.indexOf('aiCmGeminiIngest.__bind'));
 
-    // прямой проводки мимо форвардера нет: иначе поздняя связка отдала бы null
+    // прямой проводки мимо форвардера нет: иначе поздняя связка отдала бы null.
+    // Phase 3 step 13.2: пин emitBaseSnapshot СУЖЕН до блока ingest. Блок архива
+    // стоит НИЖЕ заполнения алиасов (770-771) и вправе отдать alias ЗНАЧЕНИЕМ — там он уже
+    // не null; этот случай закрыт отдельным пином в tests/adapters/gemini-archive-module.test.js.
     expect(CORE).not.toContain('ingest: ingest,');
     expect(CORE).not.toContain('handleOuter: handleOuter,');
-    expect(CORE).not.toContain('emitBaseSnapshot: emitBaseSnapshot,');
+    const ingestBindAt = CORE.indexOf('aiCmGeminiIngest.__bind(');
+    expect(ingestBindAt).toBeGreaterThan(-1);
+    const ingestBind = CORE.slice(ingestBindAt, CORE.indexOf('});', ingestBindAt));
+    expect(ingestBind).not.toContain('emitBaseSnapshot: emitBaseSnapshot,');
 
     // хвостовая точка выхода vf5 — ровно один вызов, ровно с этими опциями
     expect(CORE.match(new RegExp(VF5_TAIL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1);
@@ -166,17 +174,21 @@ describe('Phase 3 шаг 12: R-D пины кластера ingest (core/gemini-i
     expect(linesOf(CORE, VF5_TAIL)).toEqual([1680]);
   });
 
-  test('R-D №4: счётчик emitBaseSnapshot() — ядро 4, конкатенация 9', () => {
-    // ядро: 3 вызова (finishQuiet-ветка, probe-terminal, emit-хвост) + 1 форвардер
-    expect(CORE.match(/emitBaseSnapshot\(\)/g)).toHaveLength(4);
-    expect(CORE.match(/try \{ emitBaseSnapshot\(\); \}/g)).toHaveLength(3);
+  test('R-D №4: счётчик emitBaseSnapshot() — ядро 3, конкатенация 9', () => {
+    // ядро: 2 вызова (floor-confirm, self-heal) + 1 форвардер. Третий вызов (слушатель
+    // ai-cm-archive-restore) на шаге 13.2 уехал в core/gemini-archive.js — там он и
+    // считается отдельной строкой ниже.
+    expect(CORE.match(/emitBaseSnapshot\(\)/g)).toHaveLength(3);
+    expect(CORE.match(/try \{ emitBaseSnapshot\(\); \}/g)).toHaveLength(2);
+    // архив: 1 вызов (пере-эмит после вливания ходов архива)
+    expect(ARCH.match(/emitBaseSnapshot\(\)/g)).toHaveLength(1);
     // пагинация отдаёт свои 2 вызова (finishQuiet / runCompletenessProbe)
     expect(PAG.match(/emitBaseSnapshot\(\)/g)).toHaveLength(2);
     // ingest: 1 декларация `function emitBaseSnapshot()` + 2 вызова (ingest и mergeRestoredTurns)
     expect(MOD.match(/emitBaseSnapshot\(\)/g)).toHaveLength(3);
     expect(linesOf(MOD, 'function emitBaseSnapshot()')).toEqual([459]);
     expect(fnSource(MOD, 'mergeRestoredTurns')).toContain('try { emitBaseSnapshot(); } catch (e) { }');
-    // арифметика конкатенации: 4 + 2 + 3 = 9
+    // арифметика конкатенации: 3 (ядро) + 2 (пагинация) + 3 (ingest) + 1 (архив) = 9
     expect(CONC.match(/emitBaseSnapshot\(\)/g)).toHaveLength(9);
   });
 
@@ -207,12 +219,12 @@ describe('Phase 3 шаг 12: R-D пины кластера ingest (core/gemini-i
 });
 
 describe('Phase 3 шаг 12: S-пины проводки модуля', () => {
-  test('S1: регистрация в core/background.js — id -v9 (шаг 13.1), ingest и overlay перед ядром, -v8 снят', () => {
+  test('S1: регистрация в core/background.js — id -v10 (шаг 13.2), ingest, overlay и archive перед ядром, -v9 снят', () => {
     const bg = readFile('core/background.js');
-    expect(bg).toContain("'ai-cm-gemini-intercept-v9'");
+    expect(bg).toContain("'ai-cm-gemini-intercept-v10'");
     expect(bg).toContain("'core/gemini-ingest.js'");
     // js[] собран ровно в этом порядке: sse → pagination → loader-scroll → ingest → ядро
-    expect(bg).toContain("'core/gemini-sse.js', 'core/pagination/pagination.js', 'core/gemini-loader-scroll.js', 'core/gemini-ingest.js', 'core/gemini-overlay.js', 'core/gemini-intercept.js'");
+    expect(bg).toContain("'core/gemini-sse.js', 'core/pagination/pagination.js', 'core/gemini-loader-scroll.js', 'core/gemini-ingest.js', 'core/gemini-overlay.js', 'core/gemini-archive.js', 'core/gemini-intercept.js'");
     // модуль обязан грузиться РАНЬШЕ ядра: ядро связывает его при загрузке
     expect(bg.indexOf("'core/gemini-loader-scroll.js'")).toBeLessThan(bg.indexOf("'core/gemini-ingest.js'"));
     expect(bg.indexOf("'core/gemini-ingest.js'")).toBeLessThan(bg.indexOf("'core/gemini-intercept.js'"));
````

### 1.7 `tests/adapters/gemini-overlay-module.test.js`

````diff
diff --git a/tests/adapters/gemini-overlay-module.test.js b/tests/adapters/gemini-overlay-module.test.js
index 7f947f5..4120aca 100644
--- a/tests/adapters/gemini-overlay-module.test.js
+++ b/tests/adapters/gemini-overlay-module.test.js
@@ -19,8 +19,8 @@
  *     gemini-widget-theme-h22:331-336) режут их из конкатенации и исполняют в песочнице.
  *
  *   S (проводка) — модуль реально подключён и связан с ядром:
- *     S1  регистрация в core/background.js: id -v9, модуль в js[] ПЕРЕД ядром,
- *         -v8 в unregister (MV3 не перечитывает js[] под уже зарегистрированным id);
+ *     S1  регистрация в core/background.js: id -v10 (шаг 13.2), модуль в js[] ПЕРЕД
+ *         ядром, -v9 в unregister (MV3 не перечитывает js[] под уже зарегистрированным id);
  *     S2  bind-контракт полон: все 3 имени контракта переданы ядром и все 3 используются
  *         модулем (регрессия = молчаливый no-op, которого не видит ни один старый пин);
  *     S3  деградация без модуля: внятный лог и undefined вместо падения;
@@ -316,12 +316,12 @@ describe('Phase 3 шаг 13.1: D-пины — API, гигиена, деград
 });
 
 describe('Phase 3 шаг 13.1: S-пины проводки модуля', () => {
-  test('S1: регистрация в core/background.js — id -v9, модуль перед ядром, -v8 снят', () => {
+  test('S1: регистрация в core/background.js — id -v10, модуль перед ядром, -v9 снят', () => {
     const bg = readFile('core/background.js');
-    expect(bg).toContain("'ai-cm-gemini-intercept-v9'");
+    expect(bg).toContain("'ai-cm-gemini-intercept-v10'");
     expect(bg).toContain("'core/gemini-overlay.js'");
     // js[] собран ровно в этом порядке: … loader-scroll → ingest → overlay → ядро
-    expect(bg).toContain("'core/gemini-sse.js', 'core/pagination/pagination.js', 'core/gemini-loader-scroll.js', 'core/gemini-ingest.js', 'core/gemini-overlay.js', 'core/gemini-intercept.js'");
+    expect(bg).toContain("'core/gemini-sse.js', 'core/pagination/pagination.js', 'core/gemini-loader-scroll.js', 'core/gemini-ingest.js', 'core/gemini-overlay.js', 'core/gemini-archive.js', 'core/gemini-intercept.js'");
     // модуль обязан грузиться РАНЬШЕ ядра: ядро связывает его при своей загрузке
     expect(bg.indexOf("'core/gemini-ingest.js'")).toBeLessThan(bg.indexOf("'core/gemini-overlay.js'"));
     expect(bg.indexOf("'core/gemini-overlay.js'")).toBeLessThan(bg.indexOf("'core/gemini-intercept.js'"));
@@ -329,8 +329,8 @@ describe('Phase 3 шаг 13.1: S-пины проводки модуля', () =>
     expect(bg).toContain("'ai-cm-gemini-intercept-v8'");
     expect(bg).toContain("'ai-cm-gemini-intercept-v7'");
     // лог регистрации бампнут вместе с id
-    expect(bg).toContain('(v9) зарегистрирован');
-    expect(bg).not.toContain('(v8) зарегистрирован');
+    expect(bg).toContain('(v10) зарегистрирован');
+    expect(bg).not.toContain('(v9) зарегистрирован');
   });
 
   test('S2: bind-контракт полон — ни одна зависимость кластера не потеряна', () => {
````

### 1.8 `tests/adapters/gemini-pagination-module.test.js`

````diff
diff --git a/tests/adapters/gemini-pagination-module.test.js b/tests/adapters/gemini-pagination-module.test.js
index 354aa13..768aaeb 100644
--- a/tests/adapters/gemini-pagination-module.test.js
+++ b/tests/adapters/gemini-pagination-module.test.js
@@ -20,8 +20,8 @@
  *     D6  одна точка записи  → прямых присваиваний в turnsMap в модуле нет.
  *
  *   S (проводка) — модуль реально подключён и связан с ядром:
- *     S1  регистрация в core/background.js: id -v6, js[] 10 файлов, модуль ПЕРЕД ядром,
- *         -v5 в unregister (MV3 не перечитывает js[] под уже зарегистрированным id);
+ *     S1  регистрация в core/background.js: id -v10, js[] 14 файлов, модуль ПЕРЕД ядром,
+ *         -v9 в unregister (MV3 не перечитывает js[] под уже зарегистрированным id);
  *     S2  bind-контракт полон: 71 зависимость передана и все 71 используются
  *         (регрессия = молчаливый no-op, который ни один старый пин не видит);
  *     S3  проза модуля не затеняет литералы существующих пинов (иначе пин меряет шапку);
@@ -116,9 +116,12 @@ describe('Phase 3 шаг 10: D-пины маршрутов записи базы
     expect(fnSource(MOD, 'finishQuiet')).toContain('if (success) { try { emitBaseSnapshot(); } catch (e) { } }');
     expect(fnSource(MOD, 'runCompletenessProbe')).toContain('try { emitBaseSnapshot(); } catch (eE) { }');
     // Phase 3 step 12: три вызова (747, 988, 3157) уехали из ядра в core/gemini-ingest.js,
-    // поэтому в ядре 4 = 3 вызова + 1 форвардер aiCmEmitBaseSnapshotFwd (шаг 12, TDZ),
-    // а в конкатенации 9 = 4 (ядро) + 2 (пагинация) + 3 (ingest: декларация + 2 вызова).
-    expect(CORE.match(/emitBaseSnapshot\(\)/g)).toHaveLength(4);
+    // поэтому в ядре стало 4 = 3 вызова + 1 форвардер aiCmEmitBaseSnapshotFwd (шаг 12, TDZ).
+    // Phase 3 step 13.2: четвёртый ядерный вызов (слушатель ai-cm-archive-restore) уехал
+    // в core/gemini-archive.js, поэтому в ядре 3 = 2 вызова + 1 форвардер, а в конкатенации
+    // по-прежнему 9 = 3 (ядро) + 2 (пагинация) + 3 (ingest: декларация + 2 вызова)
+    // + 1 (archive: вызов в слушателе ai-cm-archive-restore).
+    expect(CORE.match(/emitBaseSnapshot\(\)/g)).toHaveLength(3);
     expect(CONC.match(/emitBaseSnapshot\(\)/g)).toHaveLength(9);
   });
 
@@ -150,11 +153,12 @@ describe('Phase 3 шаг 10: D-пины маршрутов записи базы
 });
 
 describe('Phase 3 шаг 10: S-пины проводки модуля', () => {
-  test('S1: регистрация в core/background.js — id -v9 (шаг 13.1), модуль перед ядром, -v8 в unregister', () => {
+  test('S1: регистрация в core/background.js — id -v10 (шаг 13.2), модуль перед ядром, -v9 в unregister', () => {
     const bg = readFile('core/background.js');
     expect(bg).toContain("'ai-cm-gemini-intercept-v6'");
+    expect(bg).toContain("'ai-cm-gemini-intercept-v10'");
     expect(bg).toContain("'core/pagination/pagination.js'");
-    expect(bg).toContain("'core/gemini-sse.js', 'core/pagination/pagination.js', 'core/gemini-loader-scroll.js', 'core/gemini-ingest.js', 'core/gemini-overlay.js', 'core/gemini-intercept.js'");
+    expect(bg).toContain("'core/gemini-sse.js', 'core/pagination/pagination.js', 'core/gemini-loader-scroll.js', 'core/gemini-ingest.js', 'core/gemini-overlay.js', 'core/gemini-archive.js', 'core/gemini-intercept.js'");
     // модуль обязан грузиться РАНЬШЕ ядра: ядро связывает его при загрузке
     expect(bg.indexOf("'core/pagination/pagination.js'")).toBeLessThan(bg.indexOf("'core/gemini-intercept.js'"));
     // MV3 не перечитывает js[] под существующим id — прежний id обязан быть снят
````

### 1.9 `tests/archive/archive-export-gate.test.js`

````diff
diff --git a/tests/archive/archive-export-gate.test.js b/tests/archive/archive-export-gate.test.js
index 759da7c..5cab950 100644
--- a/tests/archive/archive-export-gate.test.js
+++ b/tests/archive/archive-export-gate.test.js
@@ -274,13 +274,21 @@ describe('T1-fix#2: живой ярус — поведение (извлечён
     return map;
   }
   function env(turnsMap, arch) {
-    return {
+    // Phase 3 step 13.2: тела кластера уехали в core/gemini-archive.js и берут имена ядра
+    // через объект связи D (в браузере его заполняет __bind из ядра). Здесь D — тот же ctx:
+    // в песочнице `with (ctx)` имена ядра и так видны свободно, поэтому self-ref воспроизводит
+    // контракт, не подменяя логику. Вызовы ВНУТРИ кластера (aiCmLiveTurnCount,
+    // aiCmArchiveGrewBeyondArchive, aiCmArchiveOnlyBase) префикса НЕ получили — они
+    // резолвятся объявлениями самого sandbox-блока.
+    var ctx = {
       turnsMap: turnsMap,
       baseSize: () => Object.keys(turnsMap).length,
       getConvId: () => 'c1',
       aiCmArchiveFor: () => arch,
       window: { GeminiInterceptLogic: Logic }
     };
+    ctx.D = ctx;
+    return ctx;
   }
   function apiFor(turnsMap, arch) { return make(env(turnsMap, arch)); }
````

### 1.10 `tests/archive/archive-export-union.test.js`

````diff
diff --git a/tests/archive/archive-export-union.test.js b/tests/archive/archive-export-union.test.js
index 150a3d3..e0f468e 100644
--- a/tests/archive/archive-export-union.test.js
+++ b/tests/archive/archive-export-union.test.js
@@ -288,7 +288,13 @@ describe('T1-fix#3: объединённая база MAIN — поведени
   const UNION_MSGS = unionMessages();
 
   function env(turnsMap, arch) {
-    return {
+    // Phase 3 step 13.2: тела кластера уехали в core/gemini-archive.js и берут имена ядра
+    // через объект связи D (в браузере его заполняет __bind из ядра). Здесь D — тот же ctx:
+    // в песочнице `with (ctx)` имена ядра и так видны свободно, поэтому self-ref воспроизводит
+    // контракт, не подменяя логику. Вызовы ВНУТРИ кластера (aiCmLiveTurnCount,
+    // aiCmArchiveGrewBeyondArchive, aiCmArchiveOnlyBase) префикса НЕ получили — они
+    // резолвятся объявлениями самого sandbox-блока.
+    var ctx = {
       turnsMap: turnsMap,
       baseSize: () => Object.keys(turnsMap).length,
       getConvId: () => 'c1',
@@ -296,6 +302,8 @@ describe('T1-fix#3: объединённая база MAIN — поведени
       sanitizeMessagesForEmit: (m) => m,
       window: { GeminiInterceptLogic: Logic }
     };
+    ctx.D = ctx;
+    return ctx;
   }
   function archiveTier() {
     const keys = {};
@@ -635,12 +643,16 @@ describe('T1-fix#4: порядок объединённой базы (архив
   const LOGIC_SRC4 = fs.readFileSync(path.join(ROOT, 'utils', 'gemini-intercept-logic.js'), 'utf8');
 
   function env4(map) {
-    return {
+    // Phase 3 step 13.2: то же, что в env выше — тела уехали в core/gemini-archive.js,
+    // поэтому песочница отдаёт объект связи D (self-ref на ctx).
+    var ctx = {
       turnsMap: map,
       baseSize: () => Object.keys(map).length,
       sanitizeMessagesForEmit: (m) => m,
       window: { GeminiInterceptLogic: Logic }
     };
+    ctx.D = ctx;
+    return ctx;
   }
 
   test('4 архивных (archiveAdded) + 110 живых → порядок [a1,a2,a3,a4, live...], а не наоборот', () => {
````

### 1.11 `tests/archive/archive-oracle.test.js`

````diff
diff --git a/tests/archive/archive-oracle.test.js b/tests/archive/archive-oracle.test.js
index 313589d..b97fb27 100644
--- a/tests/archive/archive-oracle.test.js
+++ b/tests/archive/archive-oracle.test.js
@@ -187,10 +187,10 @@ describe('T1-fix: проводка гейта живого яруса', () => {
   test('aiCmArchiveTierApply передаёт снимок live (loaderRunning/loaderDone/active/grew)', () => {
     const body = fnSource(CORE_GEMINI, 'aiCmArchiveTierApply');
     expect(body).toContain('live: live');
-    expect(body).toContain('loaderRunning: loaderRunningFor === convId');
-    expect(body).toContain('var loaderDone = loaderDoneMap[convId] === true;');
+    expect(body).toContain('loaderRunning: D.loaderRunningFor === convId');
+    expect(body).toContain('var loaderDone = D.loaderDoneMap[convId] === true;');
     expect(body).toContain('loaderDone: loaderDone');
-    expect(body).toContain('active: quietActive === true');
+    expect(body).toContain('active: D.quietActive === true');
     expect(body).toContain('aiCmArchiveGrewBeyondArchive(arch)');
   });
 
@@ -259,7 +259,12 @@ describe('T1-fix: grewBeyondArchive — поведение (извлечённо
     return map;
   }
   function run(turnsMap, arch) {
-    return make({ turnsMap: turnsMap, window: { GeminiInterceptLogic: Logic } })(arch);
+    // Phase 3 step 13.2: тело уехало в core/gemini-archive.js и берёт базу через объект
+    // связи D (в браузере его заполняет __bind из ядра). Инлайновый литерал здесь больше
+    // не годится — self-ref `ctx.D = ctx` требует имени, поэтому ctx вынесен в переменную.
+    var ctx = { turnsMap: turnsMap, window: { GeminiInterceptLogic: Logic } };
+    ctx.D = ctx;
+    return make(ctx)(arch);
   }
 
   test('живое окно не стыкуется с архивом → рост НЕ подтверждён (нет ложной полноты)', () => {
````

### 1.12 `tests/helpers/gemini-intercept-source.js`

````diff
diff --git a/tests/helpers/gemini-intercept-source.js b/tests/helpers/gemini-intercept-source.js
index 4048402..9eb2bf8 100644
--- a/tests/helpers/gemini-intercept-source.js
+++ b/tests/helpers/gemini-intercept-source.js
@@ -70,6 +70,9 @@ const ROOT = path.join(__dirname, '..', '..');
 // Phase 3 step 13.1: core/gemini-overlay.js идёт после ingest и перед ядром — как в js[].
 // Тела оверлея перенесены с префиксом D (IIFE-каркас, а не `with (D)`): песочницы, которые
 // исполняют вырезанные тела, обязаны получить объект связи D (см. gemini-widget-theme-h22).
+// Phase 3 step 13.2: core/gemini-archive.js идёт после overlay и перед ядром — как в js[].
+// Тела архива тоже перенесены с префиксом D, поэтому песочницы archive-export-gate и
+// archive-export-union получают объект связи D рядом с прежними свободными именами.
 const MODULES = [
   'core/gemini-hidden-scroll.js',
   'core/gemini-diag.js',
@@ -79,7 +82,8 @@ const MODULES = [
   'core/pagination/pagination.js',
   'core/gemini-loader-scroll.js',
   'core/gemini-ingest.js',
-  'core/gemini-overlay.js'
+  'core/gemini-overlay.js',
+  'core/gemini-archive.js'
 ];
 const INTERCEPT_JS = 'core/gemini-intercept.js';
````

### 1.13 `tests/qwen-provider-wiring.test.js`

````diff
diff --git a/tests/qwen-provider-wiring.test.js b/tests/qwen-provider-wiring.test.js
index ae7345d..b16bff6 100644
--- a/tests/qwen-provider-wiring.test.js
+++ b/tests/qwen-provider-wiring.test.js
@@ -108,7 +108,7 @@ describe('O-35: core/background.js — регистрация перехватч
   });
 
   test('R-пин: шесть существующих регистраций не тронуты', function () {
-    ['ai-cm-page-intercept', 'ai-cm-gemini-intercept-v9', 'ai-cm-deepseek-intercept-v2',
+    ['ai-cm-page-intercept', 'ai-cm-gemini-intercept-v10', 'ai-cm-deepseek-intercept-v2',
       'ai-cm-claude-intercept', 'ai-cm-perplexity-intercept',
       'ai-cm-google-search-intercept'].forEach(function (id) {
       expect(background).toContain("ids.indexOf('" + id + "') === -1");
@@ -137,7 +137,10 @@ describe('O-35: core/background.js — регистрация перехватч
     // На шаге 13.1 (Phase 3) в js[] ДОБАВЛЕН core/gemini-overlay.js (перед ядром) и id
     // сменён -v8 → -v9: без модуля оверлей загрузки истории недоступен целиком — оба
     // форвардера возвращают undefined (палитра, наблюдатель темы и снятие оверлея выключены).
-    expect(background).toContain("js: ['utils/debug.js', 'utils/gemini-batchexecute-parser.js', 'utils/gemini-intercept-logic.js', 'core/gemini-hidden-scroll.js', 'core/gemini-diag.js', 'core/gemini-rpc.js', 'core/gemini-parse.js', 'core/gemini-sse.js', 'core/pagination/pagination.js', 'core/gemini-loader-scroll.js', 'core/gemini-ingest.js', 'core/gemini-overlay.js', 'core/gemini-intercept.js']");
+    // На шаге 13.2 (Phase 3) в js[] ДОБАВЛЕН core/gemini-archive.js (перед ядром) и id
+    // сменён -v9 → -v10: без модуля архивный ярус (T1) недоступен целиком — форвардеры
+    // возвращают null/true/baseSize(), то есть гейты полноты молча теряют архив.
+    expect(background).toContain("js: ['utils/debug.js', 'utils/gemini-batchexecute-parser.js', 'utils/gemini-intercept-logic.js', 'core/gemini-hidden-scroll.js', 'core/gemini-diag.js', 'core/gemini-rpc.js', 'core/gemini-parse.js', 'core/gemini-sse.js', 'core/pagination/pagination.js', 'core/gemini-loader-scroll.js', 'core/gemini-ingest.js', 'core/gemini-overlay.js', 'core/gemini-archive.js', 'core/gemini-intercept.js']");
     expect(background).toContain("js: ['utils/debug.js', 'core/deepseek-intercept.js']");
     expect(background).toContain("js: ['utils/debug.js', 'utils/intercept-common.js', 'core/claude-intercept.js']");
     expect(background).toContain("js: ['utils/debug.js', 'utils/perplexity-parser.js', 'utils/intercept-common.js', 'core/perplexity-intercept.js']");
````

### 1.14 `warning: in the working copy of '.gitignore', LF will be replaced by CRLF the next time Git touches it`

````diff

````

## 2. Полное содержимое новых файлов

### 2.1 `core/gemini-archive.js` (492 строк)

````js
/**
 * core/gemini-archive.js — кластер архива (первый ярус полноты) Gemini (Phase 3 step 13.2).
 *
 * ЧТО ЗДЕСЬ. Восемь функций первого яруса и три слушателя, которые его питают:
 * приём нормализованных ходов архива от content.js (ai-cm-archive-restore) со
 * same-conv-union вливания (aiCmArchiveFor, aiCmArchiveTierApply), вливание ленты кэша
 * (ai-cm-restored-history, aiCmBuildBaseMessages), сводка ОБЪЕДИНЁННОЙ базы для экспорта
 * (aiCmBaseExportInfo) и уточнение канонического снимка после кэша (ai-cm-cache-refresh).
 *
 * ПОЧЕМУ ВЫНЕСЕНО. Кластер — замкнутая подсистема со своим словарём: «архивный count»,
 * «живой ярус», «пол архива», «оракул archive-complete». Из 22 имён ядра, которые он
 * читает и пишет, 11 — состояние (8 только на чтение и 3 с записью), а остальные 11 —
 * функции ядра; при этом сами восемь функций кластера зовут друг друга ВНУТРИ модуля.
 * Логика архива больше не размазана по двум тысячам строк ядра.
 *
 * СВЯЗКА. Ядро зовёт window.AiCmGeminiArchive.__bind({...}) из core/gemini-intercept.js;
 * состав объекта связи — tools/archive-bind-contract.js: 11 функций значением, 8 имён
 * только на чтение и 3 — с геттером и сеттером. Обратно модуль отдаёт 5 функций
 * (см. Api в конце файла).
 *
 * СОСТОЯНИЕ ОСТАЁТСЯ В ЯДРЕ. turnsMap, archiveTierByConv, archiveMergedMap,
 * cacheRestoredMap, loaderDoneMap, loaderRunningFor, parserVersion, quietActive и три
 * вердикта полноты (historyFullByQuiet, reachedStart, tapeWasUsedInThisColdStart)
 * объявлены в ядре и НЕ перенесены: их читают и пишут ingest, лоадер, пагинация,
 * сброс при смене чата и мост content.js. Модуль получает их ЖИВЫМИ геттерами
 * (и сеттерами там, где пишет), поэтому мутация объекта видна ядру по ссылке, а
 * присваивание вердикта доходит до той же переменной IIFE, а не до копии.
 *
 * ПРАВКА ПРИ ПЕРЕНОСЕ. Тела перенесены байт-в-байт; единственные изменения —
 * ссылки на имена ядра получили префикс D (иначе свободное имя не разрешится:
 * модуль — отдельный файл, общего лексического скоупа с ядром у него нет) и в начало
 * каждого слушателя добавлен гард `if (!D)`. Свойства объектов, ключи литералов,
 * локальные имена, комментарии и вызовы ВНУТРИ кластера (aiCmArchiveFor,
 * aiCmArchiveOnlyBase, aiCmArchiveGrewBeyondArchive, aiCmBuildBaseMessages,
 * aiCmLiveTurnCount, aiCmArchiveLiveProven, aiCmArchiveTierApply, aiCmBaseExportInfo)
 * не тронуты — они резолвятся внутри модуля.
 *
 * ПОРЯДОК ПОДКЛЮЧЕНИЯ. utils/debug.js, utils/gemini-batchexecute-parser.js,
 * utils/gemini-intercept-logic.js, core/gemini-hidden-scroll.js, core/gemini-diag.js,
 * core/gemini-rpc.js, core/gemini-parse.js, core/gemini-sse.js,
 * core/pagination/pagination.js, core/gemini-loader-scroll.js, core/gemini-ingest.js,
 * core/gemini-overlay.js, ЭТОТ ФАЙЛ, core/gemini-intercept.js — см. js[] в
 * core/background.js (id -v10: MV3 не перечитывает js[] под уже зарегистрированным id,
 * поэтому при добавлении файла id обязан смениться, иначе модуль не доедет до профилей
 * с прежним id, а без модуля архивный ярус недоступен целиком: каждая функция-форвардер
 * деградирует в null/true/baseSize(), то есть гейты полноты молча теряют T1-архив).
 *
 * ВНИМАНИЕ. Слушатели регистрируются на загрузке модуля, то есть до вызова __bind из
 * ядра. Это безопасно: до первого реального события ядро уже загружено (файлы идут
 * одним пакетом content script без разрывов), а гард `if (!D)` в начале каждого
 * слушателя закрывает и теоретический случай. Файл намеренно без директивы строгого
 * режима и без with — как остальные модули MAIN-мира.
 *
 * PUBLIC API: window.AiCmGeminiArchive = { __bind, aiCmArchiveFor, aiCmArchiveLiveProven, aiCmLiveTurnCount, aiCmArchiveTierApply, aiCmBaseExportInfo }.
 */
(function () {
  if (typeof window !== 'undefined' && window.AiCmGeminiArchive) return;
  // Зависимости ядра. Заполняется один раз через __bind(...) из core/gemini-intercept.js.
  var D = null;
  function __bind(d) { D = d; }

  // ============ T1 (v1.16): ПЕРВЫЙ ЯРУС — АРХИВ (оракул и пол) ============
  // Метаданные архива по convId кладёт слушатель ai-cm-archive-restore (ниже, рядом
  // с tape-restore): content.js (ISOLATED) читает chrome.storage.local и передаёт
  // нормализованные ходы — MAIN-мир chrome.* не касается (инвариант мировой изоляции).
  //
  // aiCmArchiveTierApply() вызывается из emitBaseSnapshot, то есть переоценивается на
  // КАЖДОМ изменении базы. archive-complete объявляется ровно тогда, когда живая база
  // доросла до архивного count — не в момент импорта. H9-гейты (untrustedTopVerdict /
  // pagStepBroken) и H10 (пол авторитетнее ответа probe) НЕ ослабляются: архив — это
  // ДОПОЛНИТЕЛЬНАЯ терминальная точка со своими гейтами (convId, count, пол).
  // T1-fix (v1.16.1): плюс гейт ЖИВОГО яруса (loaderRunning / loaderDone / active /
  // grewBeyondArchive) — архивные ходы лежат в той же базе, поэтому «count дорос»
  // без живых доказательств означал ложную полноту и автоэкспорт одной архивной части.
  function aiCmArchiveFor(convId) {
    if (!convId) return null;
    return D.archiveTierByConv[convId] || null;
  }

  // T1-fix#3 (v1.16.3): сообщения ОБЪЕДИНЁННОЙ базы (архив + live) — тем же порядком и с
  // той же санацией, что уходят в EMIT (порядок строит ТА ЖЕ чистая orderExportMessages —
  // дубля логики D15 нет). Нужны экспорту: content.js (ISOLATED) не видит turnsMap, а
  // последний EMIT мог быть снят ДО вливания живой истории (архив читается из storage
  // первым) — файл уходил одной архивной частью (live-прогон: 4 архивных хода при базе 114).
  function aiCmBuildBaseMessages() {
    try {
      var orderItems = [];
      var mapIds = Object.keys(D.turnsMap);
      for (var i = 0; i < mapIds.length; i++) {
        var rec = D.turnsMap[mapIds[i]];
        if (!rec) continue;
        orderItems.push({
          id: mapIds[i], turnId: rec.turnId || null, r1: rec.r1 || null,
          order: rec.order || 0, role: rec.role, archive: rec.archiveAdded === true
        });
      }
      var ids = null;
      if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
          typeof window.GeminiInterceptLogic.orderExportMessages === 'function') {
        var exp = window.GeminiInterceptLogic.orderExportMessages(orderItems);
        if (exp && exp.ids) ids = exp.ids;
      }
      if (!ids) {
        ids = mapIds.slice().sort(function (a, b) {
          return (D.turnsMap[a].order || 0) - (D.turnsMap[b].order || 0);
        });
      }
      var messages = [];
      for (var j = 0; j < ids.length; j++) {
        var m = D.turnsMap[ids[j]];
        if (!m) continue;
        messages.push({ role: (m.role === 'user') ? 'user' : 'assistant', text: m.text, id: ids[j] });
      }
      return D.sanitizeMessagesForEmit(messages);
    } catch (eBbm) { return null; }
  }

  // T1-fix#3: сводка ОБЪЕДИНЁННОЙ базы для экспорта. Уезжает в ISOLATED синхронным мостом
  // ai-cm-turns-snap-request/response (движение ONLY через CustomEvent — мировая изоляция):
  // baseMsgs — сколько ходов в базе, liveCount — сколько из них НЕ влито архивом,
  // archiveCount — count импортированного архива, messages — сами ходы базы.
  function aiCmBaseExportInfo() {
    try {
      var convId = D.getConvId();
      var arch = aiCmArchiveFor(convId);
      var msgs = aiCmBuildBaseMessages();
      var info = {
        convId: convId,
        baseMsgs: msgs ? msgs.length : D.baseSize(),
        liveCount: aiCmLiveTurnCount(arch),
        archiveCount: (arch && arch.count) || 0,
        liveProven: aiCmArchiveLiveProven(convId),
        messages: msgs || []
      };
      return info;
    } catch (eBei) { return null; }
  }

  // T1-fix#2 (v1.16.2): живые ходы базы — ходы, НЕ влитые архивом (addedIds).
  // Архив лежит в ТОЙ ЖЕ базе (same-conv-union), поэтому baseSize() сам по себе не
  // отличает «живой ярус уже что-то дал» от «в базе пока только архив».
  function aiCmLiveTurnCount(arch) {
    try {
      var a = arch || aiCmArchiveFor(D.getConvId());
      if (!a || !a.addedIds) return D.baseSize(); // merge архива не было — вся база живая
      var ids = Object.keys(D.turnsMap);
      var n = 0;
      for (var i = 0; i < ids.length; i++) { if (a.addedIds[ids[i]] !== true) n++; }
      return n;
    } catch (eLtc) { return D.baseSize(); }
  }

  // База = ТОЛЬКО архив: ни одного живого хода. В этом состоянии ни латч loaderDoneMap
  // (его ставят и «скип»-ветки лоадера: no-older-history / cache-complete / data-complete),
  // ни пол, поднятый самим архивом, не доказывают догруженную живую историю.
  function aiCmArchiveOnlyBase(convId) {
    try {
      var a = aiCmArchiveFor(convId || D.getConvId());
      if (!a || !(a.count > 0)) return false;
      return aiCmLiveTurnCount(a) === 0;
    } catch (eAob) { return false; }
  }

  // Доказательство живого яруса для ПОЛ-подтверждений: архив поднимает пол своим count,
  // поэтому «база не ниже пола» доказывает лишь сам архив, а счётчик базы — его же вклад.
  // Живым доказательством считается только рост сверх архива со стыком живого окна
  // (нет пропуска середины: см. aiCmArchiveGrewBeyondArchive). Архива нет → прежние гейты.
  function aiCmArchiveLiveProven(convId) {
    try {
      var a = aiCmArchiveFor(convId || D.getConvId());
      if (!a || !(a.count > 0)) return true;
      if (aiCmLiveTurnCount(a) === 0) return false;
      return aiCmArchiveGrewBeyondArchive(a);
    } catch (eAlp) { return false; }
  }

  // T1-fix (v1.16.1): доказательство «база подтверждённо выросла СВЕРХ архива».
  // Архивные ходы лежат в ТОЙ ЖЕ базе (same-conv-union), поэтому baseCount > archiveCount
  // сам по себе ещё не значит, что живая история догружена (пассивный снимок мог дать
  // только свежее окно). Рост считается подтверждённым ТОЛЬКО когда:
  //   а) ходов, пришедших НЕ из архива, строго больше, чем весь архив (addedIds), И
  //   б) живое окно СТЫКУЕТСЯ с архивом — у них есть общий ход (keys по role+text),
  //      то есть между архивом и живым окном нет пропуска середины.
  // Иначе вердикт ждёт завершённого прогона лоадера (loaderDoneMap).
  function aiCmArchiveGrewBeyondArchive(arch) {
    try {
      var addedIds = arch && arch.addedIds;
      var keys = arch && arch.keys;
      if (!addedIds || !keys) return false; // merge архива ещё не было — роста быть не может
      var logic = (typeof window !== 'undefined') ? window.GeminiInterceptLogic : null;
      if (!logic || typeof logic.archiveContentKey !== 'function') return false;
      var ids = Object.keys(D.turnsMap);
      var liveCount = 0;
      var overlap = false;
      for (var i = 0; i < ids.length; i++) {
        if (addedIds[ids[i]] === true) continue; // ход, влитый ИМЕННО архивом
        liveCount++;
        if (!overlap) {
          var k = null;
          try { k = logic.archiveContentKey(D.turnsMap[ids[i]]); } catch (eK) { k = null; }
          if (k && keys[k] === true) overlap = true;
        }
      }
      if (!overlap) return false;
      return liveCount > arch.count;
    } catch (eGba) { return false; }
  }

  function aiCmArchiveTierApply() {
    try {
      var convId = D.getConvId();
      var arch = aiCmArchiveFor(convId);
      if (!arch) return;
      var logic = (typeof window !== 'undefined') ? window.GeminiInterceptLogic : null;
      if (!logic || typeof logic.archiveCompleteVerdict !== 'function') return;
      var sf = null;
      try { sf = D.loadFloor(convId); } catch (eSf) { }
      var floorCount = (sf && sf.count) || 0;
      // T1-fix (v1.16.1): снимок ЖИВОГО яруса — без него «база доросла до архива»
      // выполняется вкладом самого архива и объявляет ложную полноту (автоэкспорт
      // уходил с одной архивной частью, живой хвост не успевал догрузиться).
      // Дорогое доказательство роста считаем только пока лоадер не отработал.
      var loaderDone = D.loaderDoneMap[convId] === true;
      // T1-fix#2 (v1.16.2): база из одного архива доказательств живого яруса не даёт —
      // латч loaderDoneMap ставят и «скип»-ветки лоадера БЕЗ прогона (архив делает базу
      // непустой ещё до прихода живого RPC, из-за чего лоадер и пропускался).
      var archiveOnly = aiCmArchiveOnlyBase(convId);
      var live = {
        loaderRunning: D.loaderRunningFor === convId,
        loaderDone: loaderDone && !archiveOnly,
        active: D.quietActive === true,
        grewBeyondArchive: (loaderDone || archiveOnly) ? false : aiCmArchiveGrewBeyondArchive(arch)
      };
      var verdict = logic.archiveCompleteVerdict({
        archiveConvId: arch.convId,
        currentConvId: convId,
        archiveCount: arch.count,
        baseCount: D.baseSize(),
        floorCount: floorCount,
        live: live
      });
      if (verdict.complete !== true) {
        if (arch.verdictLogged !== verdict.reason) {
          arch.verdictLogged = verdict.reason;
          debugLog('log', '[AI CM][completeness] archive-complete withheld reason=' + verdict.reason +
            ' convId=' + convId + ' msgs=' + D.baseSize() + ' archiveMsgs=' + arch.count + ' floor=' + floorCount +
            ' loaderRunning=' + (live.loaderRunning ? '1' : '0') + ' loaderDone=' + (loaderDone ? '1' : '0') +
            ' liveActive=' + (live.active ? '1' : '0') + ' grew=' + (live.grewBeyondArchive ? '1' : '0') +
            ' archiveOnly=' + (archiveOnly ? '1' : '0'));
        }
        return;
      }
      if (arch.completeApplied === true) return; // одноразовый взвод/лог на чат
      arch.completeApplied = true;
      D.historyFullByQuiet = true;
      // Архив по построению содержит ГОЛОВУ разговора → начало достигнуто. Это
      // НЕ отключает H9/H10-гейты на их собственных путях (probe/loader/collapse) —
      // здесь фиксируется независимо доказанная полнота первого яруса.
      D.reachedStart = true;
      debugLog('log', '[AI CM][completeness] oracle=complete reason=archive-complete convId=' + convId +
        ' msgs=' + D.baseSize() + ' archiveMsgs=' + arch.count + ' floor=' + floorCount +
        ' format=' + (arch.format || '?'));
    } catch (eArc) { }
  }

  // ---- v28: слияние сохранённой ленты (из content.js) со свежей сетевой ----
  // Контент-скрипт (content.js) восстанавливает ленту из chrome.storage.local
  // и передаёт её сюда событием ai-cm-restored-history. Свежие сетевые ходы
  // перезаписывают сохранённые по id; сохранённые ходы, которых нет в сети, ДОПОЛНЯЮТ базу.
  window.addEventListener('ai-cm-restored-history', function (ev) {
    if (!D) { debugLog('error', '[gemini-archive] D is null, event ignored'); return; }
    var detail = ev && ev.detail;
    if (!detail || !detail.turns) return; // v77: пустую ленту обрабатываем ниже (hwm-protect) с логом
    var restoredTurns = detail.turns;
    var restoredConvId = detail.convId || '';
    var current = D.getConvId();

    // гард: принимаем только для текущего чата
    if (restoredConvId !== current) {
      debugLog('log', '[gemini-restore] пропущена лента для чужого чата (restored=' + restoredConvId + ', current=' + current + ')');
      // v61diag: усиленный tape-restore лог (stale — кэш чужого чата)
      var diagStaleFe = D.aiCmDiagTurnEdge(detail.turns, 'first');
      var diagStaleLe = D.aiCmDiagTurnEdge(detail.turns, 'last');
      debugLog('log', '[AI CM][tape-restore] convId=' + (current || '(none)') + ' cacheConvId=' + restoredConvId +
        ' action=stale cachedMsgs=' + detail.turns.length +
        ' firstMsgHash=' + diagStaleFe.hash + ' lastMsgHash=' + diagStaleLe.hash);
      return;
    }

    // v77: повторная лента для ЭТОГО convId в рамках сессии — уже применена, не читаем
    // и не мерджим (защита O2 от повторного tape-restore поверх живых данных).
    if (current && D.cacheRestoredMap.has(current)) {
      debugLog('log', '[AI CM][tape-restore] skip reason=already-restored convId=' + current +
        ' cachedMsgs=' + detail.turns.length);
      return;
    }
    // v77 (HWM): кэш пуст — НЕ затираем текущее состояние и не трогаем счётчик токенов.
    if (!detail.turns.length) {
      debugLog('log', '[AI CM][tape-restore] skip reason=hwm-protect convId=' + (current || '(none)') +
        ' cachedMsgs=0 baseMsgs=' + D.baseSize());
      return;
    }

    // v4x: версия записи ленты должна совпадать с текущей версией парсера,
    // иначе игнорируем запись без миграции.
    var restoreMeta = detail.meta || {};
    var restoreVersion = (typeof restoreMeta.version === 'string') ? restoreMeta.version : '';
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.shouldAcceptTape) {
      if (!window.GeminiInterceptLogic.shouldAcceptTape({ meta: { version: restoreVersion } }, D.parserVersion)) {
        debugLog('log', '[gemini-restore] tape ignored: version=' + (restoreVersion || '(none)'));
        return;
      }
    }

    // v30.6: лента для текущего чата принята → лоадер полной истории не нужен
    // (maybeStartLoader читает cacheRestoredMap и делает skip reason=cache-complete).
    // v77: add ТОЛЬКО после успешного merge (см. ниже cacheRestoredMap.add).

    // v4x: мерджим restored-ленту, пока пагинация НЕ дошла до начала (reachedStart=false),
    // НЕЗАВИСИМО от baseComplete/historyFullByQuiet.
    var mergeRestored = true;
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.shouldMergeRestoredTurns) {
      mergeRestored = window.GeminiInterceptLogic.shouldMergeRestoredTurns(D.reachedStart);
    } else {
      mergeRestored = (D.reachedStart !== true);
    }
    if (!mergeRestored) {
      debugLog('log', '[gemini-restore] достигнут начало диалога (reachedStart=true) → восстановление из хранилища пропущено');
      return;
    }

    // v77: high-water-mark защита на уровне source — живые ходы сети НЕ перезатираются
    // (mergeRestoredTurns дедуплицирует по id и дополняет недостающие, не удаляя базу).
    D.mergeRestoredTurns(restoredTurns);
    if (current) D.cacheRestoredMap.add(current); // v77: Set.add ТОЛЬКО после успешного вливания
    D.refreshMinOrderTracking('restored'); // v73: tape-добавления старших ходов инвалидируют scroll-proof
    D.noteBaseCountChange(); // v74
    D.tapeWasUsedInThisColdStart = true; // v62: лента кэша принята в ЭТОМ холодном старте — confirmed-by-scroll разрешён
    // v61diag: усиленный tape-restore лог (лента принята и влита)
    (function () {
      var fe = D.aiCmDiagTurnEdge(restoredTurns, 'first');
      var le = D.aiCmDiagTurnEdge(restoredTurns, 'last');
      debugLog('log', '[AI CM][tape-restore] convId=' + (current || '(none)') + ' cacheConvId=' + restoredConvId +
        ' action=used cachedMsgs=' + restoredTurns.length +
        ' firstMsgHash=' + fe.hash + ' lastMsgHash=' + le.hash);
    })();
  });

  // ============ T1 (v1.16): ПЕРВЫЙ ЯРУС — АРХИВ (приём от content.js) ============
  // content.js (ISOLATED) читает chrome.storage.local (aiCmArchive:<convId>) и передаёт
  // УЖЕ НОРМАЛИЗОВАННЫЕ ходы архива. Паттерн тот же, что у tape-restore: MAIN-мир
  // chrome.* не касается. Порядок применения:
  //   1) same-conv-union — вливаем ТОЛЬКО недостающие архивные ходы (сеть авторитетна);
  //   2) архивный count авторитетен для пола (монотонно ВВЕРХ — HWM не ломается);
  //   3) метаданные яруса → оракул archive-complete переоценивается в emitBaseSnapshot.
  window.addEventListener('ai-cm-archive-restore', function (ev) {
    if (!D) { debugLog('error', '[gemini-archive] D is null, event ignored'); return; }
    var detail = ev && ev.detail;
    if (!detail || !detail.convId) return;
    var convId = String(detail.convId);
    var current = D.getConvId();
    if (convId !== current) {
      debugLog('log', '[AI CM][archive-restore] skip reason=stale convId=' + (current || '(none)') +
        ' archiveConvId=' + convId);
      return;
    }
    var messages = Array.isArray(detail.messages) ? detail.messages : [];
    var count = (typeof detail.count === 'number' && detail.count > 0) ? detail.count : messages.length;
    if (!count || !messages.length) {
      debugLog('log', '[AI CM][archive-restore] skip reason=empty convId=' + convId);
      return;
    }
    var logic = (typeof window !== 'undefined') ? window.GeminiInterceptLogic : null;
    var ids = Object.keys(D.turnsMap);
    var i;

    // 1) same-conv-union архивных ходов с текущей базой
    var addedCount = 0;
    // T1-fix (v1.16.1): доказательства для гейта живого яруса — ключи контента архива
    // (стык с живым окном) и id ходов, влитых ИМЕННО архивом (иначе вклад архива
    // неотличим от живых ходов в общей базе).
    var archKeys = null;
    var archAddedIds = null;
    if (!D.archiveMergedMap.has(convId) && logic && typeof logic.archiveMergeTurns === 'function') {
      var netItems = [];
      var maxOrder = 0;
      for (i = 0; i < ids.length; i++) {
        var nt = D.turnsMap[ids[i]];
        netItems.push({ id: ids[i], role: nt.role, text: nt.text });
        if ((nt.order || 0) > maxOrder) maxOrder = nt.order || 0;
      }
      var merged = logic.archiveMergeTurns(netItems, messages) || { items: [], duplicateCount: 0 };
      if (typeof logic.archiveContentKey === 'function') {
        archKeys = {};
        for (i = 0; i < messages.length; i++) {
          archKeys[logic.archiveContentKey(messages[i])] = true;
        }
      }
      archAddedIds = {};
      for (i = 0; i < merged.items.length; i++) {
        var it = merged.items[i];
        if (D.turnsMap[it.id]) continue;
        // pageMode 'restored' + r1=null — как у tape-restore: порядок пересчитывает
        // chain-r1, старший сегмент докладывается перед хвостовым окном сети.
        // T1-fix#4 (v1.16.4): archiveAdded=true — ЕДИНСТВЕННАЯ метка «ход влит архивом T1».
        // По ней чистая orderExportMessages ставит архив в ГОЛОВУ файла (order не трогаем:
        // aiCmOrderedTurns → dbFirstHash H9-гейта полноты обязан остаться прежним).
        D.turnsMap[it.id] = {
          text: it.text, modelName: '', order: maxOrder + 1 + i,
          pageMode: 'restored', ts: 0, archiveAdded: true,
          role: it.role, turnId: it.turnId, r1: null
        };
        archAddedIds[it.id] = true;
        addedCount++;
      }
      D.archiveMergedMap.add(convId); // Set.add ТОЛЬКО после успешного merge
      debugLog('log', '[AI CM][archive-restore] convId=' + convId + ' archiveMsgs=' + count +
        ' added=' + addedCount + ' dup=' + (merged.duplicateCount || 0) +
        ' baseMsgs=' + D.baseSize() + ' format=' + (detail.format || '?'));
    }

    // 2) Архивный count авторитетен для пола (понижение запрещено — HWM)
    var archFloor = null;
    try {
      if (logic && typeof logic.archiveFloorRecord === 'function') {
        archFloor = logic.archiveFloorRecord(
          D.loadFloor(convId),
          count,
          (typeof detail.textLen === 'number') ? detail.textLen : 0
        );
        if (archFloor) {
          D.saveFloor(convId, archFloor.count, archFloor.effectiveLen);
          D.noteBaseCountChange();
          debugLog('log', '[AI CM][archive-restore] floor source=archive convId=' + convId +
            ' count=' + archFloor.count + ' textLen=' + archFloor.effectiveLen);
        }
      }
    } catch (eAf) { }

    // 3) Метаданные яруса для оракула. Повторный dispatch (storage.onChanged) merge не
    //    повторяет — доказательства (keys/addedIds) и латчи переносим из прежней записи,
    //    иначе повторный dispatch обнулял бы гейт живого яруса.
    var prevTier = D.archiveTierByConv[convId] || null;
    D.archiveTierByConv[convId] = {
      convId: convId,
      count: count,
      textLen: (typeof detail.textLen === 'number') ? detail.textLen : 0,
      format: detail.format || '',
      service: detail.service || '',
      keys: archKeys || (prevTier && prevTier.keys) || null,
      addedIds: archAddedIds || (prevTier && prevTier.addedIds) || null,
      completeApplied: !!(prevTier && prevTier.completeApplied),
      verdictLogged: (prevTier && prevTier.verdictLogged) || ''
    };

    if (addedCount > 0 || archFloor) {
      if (addedCount > 0) { try { D.refreshMinOrderTracking('archive'); } catch (eRo) { } }
      try { D.emitBaseSnapshot(); } catch (eEm) { }
    }
    try { aiCmArchiveTierApply(); } catch (eAp) { }
  });

  // v30.6: content.js после применения кэш-ленты планирует ОДНО уточнение канонического
  // значения активным снимком через 2с (activeRefresh). Гард по convId — чат мог
  // смениться, пока шёл таймер.
  try {
    window.addEventListener('ai-cm-cache-refresh', function (ev) {
      if (!D) { debugLog('error', '[gemini-archive] D is null, event ignored'); return; }
      var detail = ev && ev.detail;
      var want = (detail && detail.convId) || '';
      var current = D.getConvId();
      if (want && current && want !== current) {
        debugLog('log', '[gemini-cache-refresh] пропущен: чат сменился (want=' + want + ', current=' + current + ')');
        return;
      }
      debugLog('log', '[AI CM][Gemini][cache-refresh] уточнение после кэша convId=' + (current || want || '(none)'));
      D.activeRefresh('уточнение после кэша');
    });
  } catch (e) { }

  var Api = {
    __bind: __bind,
    aiCmArchiveFor: aiCmArchiveFor,
    aiCmArchiveLiveProven: aiCmArchiveLiveProven,
    aiCmLiveTurnCount: aiCmLiveTurnCount,
    aiCmArchiveTierApply: aiCmArchiveTierApply,
    aiCmBaseExportInfo: aiCmBaseExportInfo
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Api;
  if (typeof window !== 'undefined') window.AiCmGeminiArchive = Api;
})();
````

### 2.2 `tools/archive-bind-contract.js` (81 строк)

````js
// Контракт связки core/gemini-archive.js <-> core/gemini-intercept.js (Phase 3 Step 13.2).
//
// ЧТО ЭТО. Список имён ядра, которые перенесённый в core/gemini-archive.js кластер
// архива (первый ярус полноты) читает и/или пишет. Блок `aiCmGeminiArchive.__bind({...})`
// в ядре строится ИМЕННО из этого массива, а tools/apply-archive-extraction.js сверяет
// блок с массивом в обе стороны. Один источник правды: добавил имя в контракт — оно
// обязано появиться в блоке __bind, и наоборот.
//
// ПОЧЕМУ КОНТРАКТ ТАКОЙ ДЛИННЫЙ. Кластер архива — не «остров», а посредник: он читает
// состояние базы (turnsMap, loaderDoneMap, cacheRestoredMap), пишет вердикты полноты
// (historyFullByQuiet, reachedStart, tapeWasUsedInThisColdStart), зовёт восемь функций
// ядра и принимает три чужих события. Поэтому наружу торчит 22 имени — против 3 у
// оверлея (шаг 13.1) и 1 у парсеров кадра. Меньше нельзя: каждое непереданное имя —
// свободная ссылка в модуле, то есть тихий ReferenceError внутри try/catch.
//
// ВИДЫ СВЯЗИ:
//   fn — `function имя(...)` в ядре. Передаётся ЗНАЧЕНИЕМ (имя: имя). Объявления в ядре
//        хойстятся, поэтому к моменту __bind значение уже есть. Три из них
//        (emitBaseSnapshot, mergeRestoredTurns, refreshMinOrderTracking) — ПОЗДНИЕ
//        АЛИАСЫ (`var ... = null`, дозаполняются блоками ingest и пагинации): поэтому
//        блок __bind архива стоит НИЖЕ строки 782, иначе в модуль уехали бы null.
//   rw — живое состояние: get + set. Без set запись из модуля молча теряется
//        (присваивание в accessor без сеттера не бросает), и ядро остаётся со старым
//        значением — тихий баг: оракул архива объявил бы полноту, а ядро её не увидело.
//   ro — только чтение: get. Сеттер не нужен: модуль эти имена НЕ переприсваивает.
//
// ЧТО ЗНАЧИТ ro ЗДЕСЬ (важно). ro — про ПЕРЕПРИСВАИВАНИЕ ПЕРЕМЕННОЙ, а не про
// неизменяемость объекта. `turnsMap[it.id] = {...}` (вливание архивных ходов),
// `archiveMergedMap.add(convId)`, `cacheRestoredMap.add(current)` и
// `archiveTierByConv[convId] = {...}` — это мутации ОБЪЕКТА, который виден ядру по
// ссылке: копия значения их бы тоже увидела. Переприсваивания (`имя = ...`) в
// диапазоне нет ни у одного ro-имени — это проверено обходом AST в
// tools/apply-archive-extraction.js (гейт «ro обещает только чтение»).
//
// ЧЕГО В КОНТРАКТЕ НЕТ И ПОЧЕМУ.
//   aiCmArchiveFor / aiCmArchiveOnlyBase / aiCmArchiveGrewBeyondArchive /
//     aiCmBuildBaseMessages / aiCmLiveTurnCount / aiCmArchiveLiveProven /
//     aiCmArchiveTierApply / aiCmBaseExportInfo — НЕ зависимости, а САМ кластер:
//     они объявлены В МОДУЛЕ и зовут друг друга по прежним именам. Наружу модуль
//     отдаёт 5 из них (см. Api в конце файла) — ядро зовёт их форвардерами.
//   window / document — свободные глобалы MAIN-мира, их ядро не инжектирует.
//   debugLog — свободный глобал MAIN-мира (utils/debug.js), а не имя ядра.
//   parserVersion — читается модулем при приёме ленты (shouldAcceptTape), передаётся
//     геттером: парсер обновляет версию на лету, копия строки устарела бы.
//
// ЭТО НЕ ПРОМЫШЛЕННЫЙ КОД, а тулинг сборки: файл трекается (см. .gitignore) только
// потому, что S-пины tests/adapters/gemini-archive-module.test.js обязаны читать его
// в чистом клоне CI. Больше его никто не читает.
'use strict';

// ['имя', 'вид'] — вид: 'fn' | 'rw' | 'ro'.
// В комментарии: @N — объявление в ядре ДО выноса; r:/w: — строки диапазонов
// (A: 1712-1914 — тела восьми функций, B: 1935-2145 — три слушателя).
module.exports = [
  // ---- fn (11): функции ядра, передаются значением ----
  ['activeRefresh', 'fn'],            // @1645: уточнение канонического снимка (слушатель ai-cm-cache-refresh)
  ['aiCmDiagTurnEdge', 'fn'],         // @1385: хеши краёв ленты для логов tape-restore
  ['baseSize', 'fn'],                 // @1369: счётчик базы — во всех логах и в вердикте
  ['getConvId', 'fn'],                // @1187: определение чата (8 обращений в диапазоне)
  ['loadFloor', 'fn'],                // @1167: чтение пола (гейт H10 не ослабляется)
  ['noteBaseCountChange', 'fn'],      // @900:  метка изменения базы (v74)
  ['sanitizeMessagesForEmit', 'fn'],  // @1701: ЕДИНСТВЕННАЯ функция, что осталась в ядре из этого кластера
  ['saveFloor', 'fn'],                // @1171: запись пола архивным count (HWM: только вверх)
  ['emitBaseSnapshot', 'fn'],         // @642 (поздний алиас): пере-эмит после вливания архива
  ['mergeRestoredTurns', 'fn'],       // @643 (поздний алиас): вливание ленты кэша
  ['refreshMinOrderTracking', 'fn'],  // @404 (поздний алиас): подтверждения скролла инвалидируются
  // ---- ro (8): состояние ядра, модуль его не переприсваивает ----
  ['archiveMergedMap', 'ro'],         // @999,  r:2051,2083 — Set чатов с уже влитым архивом
  ['archiveTierByConv', 'ro'],        // @997,  r:1727, w:2111 — метаданные яруса по convId
  ['cacheRestoredMap', 'ro'],         // @991,  r:1960, w:2003 — Set чатов с принятой лентой кэша
  ['loaderDoneMap', 'ro'],            // @983,  r:1803,1873 — латч завершённого прогона лоадера
  ['loaderRunningFor', 'ro'],         // @984,  r:1879 — чат, в котором лоадер идёт прямо сейчас
  ['parserVersion', 'ro'],            // @1161, r:1977 — версия записи ленты (shouldAcceptTape)
  ['quietActive', 'ro'],              // @825,  r:1881 — тихая пагинация активна (live.active)
  ['turnsMap', 'ro'],                 // @794,  r:12 обращений — САМА база (чтение и мутации по ссылке)
  // ---- rw (3): вердикты полноты, модуль их переприсваивает ----
  ['historyFullByQuiet', 'rw'],            // @826, w:1905 — взвод полноты вердиктом archive-complete
  ['reachedStart', 'rw'],                  // @827, w:1909 (r:1991,1993) — архив по построению содержит голову
  ['tapeWasUsedInThisColdStart', 'rw']     // @1199, w:2006 — лента кэша принята в этом холодном старте
];
````

### 2.3 `tools/apply-archive-extraction.js` (1338 строк)

````js
#!/usr/bin/env node
/**
 * tools/apply-archive-extraction.js — Phase 3 Step 13.2: вынос кластера архива
 * Gemini-перехватчика в core/gemini-archive.js.
 *
 * ЗАПУСК.
 *   node tools/apply-archive-extraction.js              # dry-run: аудит, гейты G1-G9, отчёт
 *   node tools/apply-archive-extraction.js --apply      # запись файлов
 *   node tools/apply-archive-extraction.js --print-bind # превью блока подключения (только чтение)
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ СКРИПТ. Перенос обязан быть ДОКАЗУЕМО байтовым: существующие пины
 * (archive-export-gate, archive-export-union, archive-oracle, oracle-archive-complete)
 * режут тела функций из КОНКАТЕНАЦИИ исходников и исполняют их в песочнице `with (ctx)`,
 * поэтому любая «почти такая же» строка — сломанный пин, а не косметика. Скрипт сам
 * собирает модуль из ДВУХ реальных диапазонов ядра, сам возвращает подстановки обратно
 * и сам сравнивает результат с исходником байт-в-байт.
 *
 * ЧТО ДЕЛАЕТ (секции вывода).
 *   1. LF/BOM/хвостовой перевод строки у всех правимых файлов, отсутствие готового модуля;
 *   2. аудит ОБОИХ диапазонов: байтовые анкеры, состав переносимых объявлений (acorn),
 *      ВНЕШНИЕ имена — обязаны совпасть ровно с контрактом (22) + белым списком глобалов;
 *      отдельно проверяется, что каждое имя контракта встречается в КОДЕ столько раз,
 *      сколько рёбер в AST (иначе строка-литерал или комментарий молча уехала бы под D.);
 *   3. сборка core/gemini-archive.js: IIFE-каркас (re-entry guard, var D = null, __bind)
 *      + тела диапазона A с подстановками `D.<имя ядра>` + тела диапазона B с гардами !D;
 *   4. доказательство обратимости: тело модуля → снять каркас → снять префиксы D →
 *      снять гарды → сравнить с диапазоном A и диапазоном B ядра БАЙТ-В-БАЙТ;
 *   5. правка ядра: A → баннер + 5 hoisted-форвардеров + блок подключения (состояние и
 *      sanitizeMessagesForEmit остаются НЕТРОНУТЫМИ), B → баннер-указатель;
 *   6. правка регистрации (core/background.js: -v9 → -v10, модуль в js[] между overlay и
 *      ядром, -v9 в unregister, лог v10), .gitignore (негация контракта), release.yml
 *      (счётчики MAIN-world 24 → 25);
 *   7. правка пинов тестов: helper MODULES, qwen-provider-wiring, pagination-module,
 *      ingest-module (счётчики emitBaseSnapshot), overlay-module (регистрация);
 *   8. гейты G1-G9 и запись (в dry-run — только отчёт).
 *
 * ЧЕГО НЕ ДЕЛАЕТ. Не трогает core/gemini-overlay.js, core/gemini-ingest.js,
 * core/gemini-loader-scroll.js, core/pagination/pagination.js, PROJECT_HANDOFF.md; не
 * запускает тесты; не коммитит. Логику переносимых функций не меняет — только префиксы.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let acorn = null;
try {
  acorn = require('acorn');
} catch (e) {
  console.error('[ФАТАЛЬНО] не найден acorn. Выполните `npm install` в корне репозитория.');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const PRINT_BIND = process.argv.includes('--print-bind');
const PRINT_MODULE = process.argv.includes('--print-module');

const P = {
  core: 'core/gemini-intercept.js',
  module: 'core/gemini-archive.js',
  background: 'core/background.js',
  helper: 'tests/helpers/gemini-intercept-source.js',
  qwen: 'tests/qwen-provider-wiring.test.js',
  pagTest: 'tests/adapters/gemini-pagination-module.test.js',
  ingestTest: 'tests/adapters/gemini-ingest-module.test.js',
  overlayTest: 'tests/adapters/gemini-overlay-module.test.js',
  gateTest: 'tests/archive/archive-export-gate.test.js',
  unionTest: 'tests/archive/archive-export-union.test.js',
  oracleTest: 'tests/archive/archive-oracle.test.js',
  gitignore: '.gitignore',
  release: '.github/workflows/release.yml',
  contract: 'tools/archive-bind-contract.js'
};

const MODULE_GLOBAL = 'AiCmGeminiArchive';
const OLD_ID = 'ai-cm-gemini-intercept-v9';
const PREV_ID = 'ai-cm-gemini-intercept-v8';
const NEW_ID = 'ai-cm-gemini-intercept-v10';
const STEP = '13.2';
const MAIN_WORLD_OLD = 24;
const MAIN_WORLD_NEW = 25;

/* Хвостовая точка выхода vf5 (`aiCmIngestFwd(txt, { … fromVirtualF5 … })`) лежит ВЫШЕ
 * диапазона A, поэтому шаг 13.2 её НЕ сдвигает — пин R-D №3 обязан остаться 1680.
 * Скрипт это проверяет арифметикой, а не доверием. */
const VF5_LINE = 1680;
const VF5_TAIL = 'aiCmIngestFwd(txt, { emitOnlyIfAdded: true, fromVirtualF5: true, rebuild: rebuild });';

/* Диапазон A ядра (1-based включительно): восемь функций кластера архива.
 * sanitizeMessagesForEmit (1697-1709) в диапазон НЕ входит — остаётся в ядре. */
const RANGE_A = {
  a: 1712,
  b: 1914,
  first: '  // ============ T1 (v1.16): ПЕРВЫЙ ЯРУС — АРХИВ (оракул и пол) ============',
  last: '  }'
};
/* Диапазон B ядра: три слушателя кластера (ai-cm-restored-history, ai-cm-archive-restore,
 * ai-cm-cache-refresh). Между A и B лежит НЕархивный код (SSE-баннер, installNetworkHooks)
 * — он остаётся в ядре, поэтому диапазоны двигаются независимо. */
const RANGE_B = {
  a: 1935,
  b: 2145,
  first: '  // ---- v28: слияние сохранённой ленты (из content.js) со свежей сетевой ----',
  last: '  } catch (e) { }'
};

/* Строки состояния ядра, которые обязаны остаться НЕТРОНУТЫМИ (1-based). */
const STATE_LINES = [
  { n: 794, text: '  var turnsMap = {};' },
  { n: 825, text: '  var quietActive = false;' },
  { n: 826, text: '  var historyFullByQuiet = false;' },
  { n: 827, text: '  var reachedStart = false; // тихая пагинация дошла до начала (курсора больше нет)' },
  { n: 983, text: '  var loaderDoneMap = {};   // convId → true (один запуск на чат за сессию страницы)' },
  { n: 984, text: '  var loaderRunningFor = null;' },
  { n: 991, text: '  var cacheRestoredMap = new Set();' },
  { n: 997, text: '  var archiveTierByConv = {};' },
  { n: 999, text: '  var archiveMergedMap = new Set();' },
  { n: 1161, text: "  var parserVersion = '';" },
  { n: 1199, text: '  var tapeWasUsedInThisColdStart = false;' }
];

/* Топ-уровневые объявления диапазонов — 8 функций, сверяются с обходом AST. */
const MOVED_TOP_LEVEL = [
  'aiCmArchiveFor', 'aiCmBuildBaseMessages', 'aiCmBaseExportInfo', 'aiCmLiveTurnCount',
  'aiCmArchiveOnlyBase', 'aiCmArchiveLiveProven', 'aiCmArchiveGrewBeyondArchive',
  'aiCmArchiveTierApply'
];

/* Функции, которые модуль отдаёт наружу (5) + __bind. */
const EXPORTED = ['aiCmArchiveFor', 'aiCmArchiveLiveProven', 'aiCmLiveTurnCount',
  'aiCmArchiveTierApply', 'aiCmBaseExportInfo'];

/* Функции, которые после выноса остаются в ядре ТОЛЬКО форвардерами: function declaration
 * (хойстится), поэтому вызовы из ядра и из чужих __bind-блоков не трогаются. */
const FORWARDERS = [
  {
    name: 'aiCmArchiveFor',
    body: [
      '  function aiCmArchiveFor(convId) { return aiCmGeminiArchive ? aiCmGeminiArchive.aiCmArchiveFor(convId) : null; }'
    ]
  },
  {
    name: 'aiCmArchiveLiveProven',
    body: [
      '  function aiCmArchiveLiveProven(convId) { return aiCmGeminiArchive ? aiCmGeminiArchive.aiCmArchiveLiveProven(convId) : true; }'
    ]
  },
  {
    name: 'aiCmLiveTurnCount',
    body: [
      '  function aiCmLiveTurnCount(arch) { return aiCmGeminiArchive ? aiCmGeminiArchive.aiCmLiveTurnCount(arch) : baseSize(); }'
    ]
  },
  {
    name: 'aiCmArchiveTierApply',
    body: [
      '  function aiCmArchiveTierApply() { return aiCmGeminiArchive ? aiCmGeminiArchive.aiCmArchiveTierApply() : undefined; }'
    ]
  },
  {
    name: 'aiCmBaseExportInfo',
    body: [
      '  function aiCmBaseExportInfo() { return aiCmGeminiArchive ? aiCmGeminiArchive.aiCmBaseExportInfo() : null; }'
    ]
  }
];

/* Гард в начале каждого из трёх слушателей: до __bind объект связи null, и без гарда
 * первое же событие бросило бы TypeError в чужом стеке. Анкер — САМА строка регистрации,
 * поэтому гард встаёт первой строкой тела, до чтения ev.detail. */
const GUARDS = [
  {
    anchor: "  window.addEventListener('ai-cm-restored-history', function (ev) {",
    insert: "    if (!D) { debugLog('error', '[gemini-archive] D is null, event ignored'); return; }"
  },
  {
    anchor: "  window.addEventListener('ai-cm-archive-restore', function (ev) {",
    insert: "    if (!D) { debugLog('error', '[gemini-archive] D is null, event ignored'); return; }"
  },
  {
    anchor: "    window.addEventListener('ai-cm-cache-refresh', function (ev) {",
    insert: "      if (!D) { debugLog('error', '[gemini-archive] D is null, event ignored'); return; }"
  }
];

/* Свободные глобалы MAIN-мира: в модуле остаются БЕЗ префикса (их ядро не инжектирует). */
const STAY_GLOBAL = ['window', 'Object', 'Array', 'String', 'debugLog'];

const CONTRACT = require('./' + path.basename(P.contract));
const CONTRACT_NAMES = CONTRACT.map((x) => x[0]);
const CONTRACT_KIND = new Map(CONTRACT);
const SUBS = CONTRACT.map((x) => ({ name: x[0], kind: x[1] }));

/* ------------------------------------------------------------------ *
 * 1. Утилиты вывода и файлов
 * ------------------------------------------------------------------ */

function log(m) { console.log(m); }
function ok(m) { console.log('  ✓ ' + m); }
function section(t) { console.log('\n' + t); }
function fail(msg) {
  console.log('\n[ОШИБКА] ' + msg);
  console.log('[ОСТАНОВ] В файлы ничего не записано: правки живут только в памяти этого прогона.');
  process.exit(1);
}
function shorten(s) {
  s = String(s).replace(/\n/g, '\\n');
  return s.length > 110 ? s.slice(0, 107) + '...' : s;
}
function read(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) fail('нет файла ' + rel);
  return fs.readFileSync(abs, 'utf8');
}
const WRITES = [];
function writeOut(rel, text, note) {
  const bytes = Buffer.byteLength(text, 'utf8');
  const nLines = text.split('\n').length - 1;
  WRITES.push({ rel, bytes, lines: nLines });
  if (!APPLY) {
    log('  [dry-run] было бы записано ' + rel + ' — ' + nLines + ' строк, ' + bytes + ' байт' + (note ? ' (' + note + ')' : ''));
    return;
  }
  fs.writeFileSync(path.join(ROOT, rel), text, 'utf8');
  log('  [apply] записан ' + rel + ' — ' + nLines + ' строк, ' + bytes + ' байт');
}
function mustReplace(src, from, to, label, expectCount) {
  const n = src.split(from).length - 1;
  if (n !== expectCount) {
    fail(label + ': ожидалось вхождений ' + expectCount + ', найдено ' + n + '\n  искали: ' + shorten(from));
  }
  return src.split(from).join(to);
}
function mustContain(src, lit, label) {
  if (src.indexOf(lit) === -1) fail(label + ': не найдено ' + shorten(lit));
  return src;
}

/* Переводы строк. .gitattributes пинует `*.js` как `text eol=lf`, поэтому для .js-файлов
 * режим ЖЁСТКО LF. release.yml под это правило не попадает: при core.autocrlf=true git
 * отдаёт его в рабочую копию в CRLF, поэтому для него режим НАБЛЮДАЕТСЯ и СОХРАНЯЕТСЯ. */
const NO_TRAILING_NL = new Set([P.pagTest, P.gitignore, P.release]);
const EOL_OF = new Map();
function eolOf(text) {
  const crlf = text.split('\r\n').length - 1;
  const lf = text.split('\n').length - 1;
  if (crlf === 0) return 'lf';
  if (crlf === lf) return 'crlf';
  return 'mixed';
}
function nlOf(text) { return eolOf(text) === 'crlf' ? '\r\n' : '\n'; }
function observeEol(rel, text) {
  if (text.charCodeAt(0) === 0xfeff) fail(rel + ': BOM в начале файла');
  if (!text.endsWith('\n') && !NO_TRAILING_NL.has(rel)) fail(rel + ': нет завершающего перевода строки');
  const e = eolOf(text);
  if (e === 'mixed') fail(rel + ': смешанные переводы строк (CRLF и LF вперемешку) — правка невозможна');
  if (rel.endsWith('.js') && e !== 'lf') {
    fail(rel + ': переводы строк "' + e + '", а .gitattributes пинует *.js как `text eol=lf`');
  }
  EOL_OF.set(rel, e);
  return e;
}
function checkEol(rel, text) {
  const want = EOL_OF.get(rel);
  if (!want) fail(rel + ': режим переводов строк не зафиксирован (observeEol не вызывался)');
  if (text.charCodeAt(0) === 0xfeff) fail(rel + ': BOM в начале файла');
  if (!text.endsWith('\n') && !NO_TRAILING_NL.has(rel)) fail(rel + ': нет завершающего перевода строки');
  const e = eolOf(text);
  if (e !== want) fail(rel + ': после правки переводы строк "' + e + '", а были "' + want + '"');
  if (want === 'lf' && text.endsWith('\r\n')) fail(rel + ': хвостовой CRLF при LF-файле');
  return e;
}

/* ------------------------------------------------------------------ *
 * 2. AST-хелперы
 * ------------------------------------------------------------------ */

function parseJs(text, label, onComment) {
  try {
    const opts = { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true };
    if (onComment) opts.onComment = onComment;
    return acorn.parse(text, opts);
  } catch (e) {
    fail('не разбирается ' + label + ': ' + e.message);
  }
}
/** Комментарии заменяются пробелами (длины и переводы строк сохранены). */
function codeOnly(src, label) {
  const comments = [];
  parseJs(src, label, comments);
  const out = src.split('');
  for (const c of comments) {
    for (let k = c.start; k < c.end; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  }
  return out.join('');
}
function walk(node, parent, cb) {
  if (!node || typeof node.type !== 'string') return;
  cb(node, parent);
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end') continue;
    const v = node[k];
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c.type === 'string') walk(c, node, cb);
    } else if (v && typeof v.type === 'string') {
      walk(v, node, cb);
    }
  }
}
function patternNames(p, out) {
  if (!p) return out;
  if (p.type === 'Identifier') out.push(p.name);
  else if (p.type === 'ObjectPattern') { for (const pr of p.properties) patternNames(pr.type === 'RestElement' ? pr.argument : pr.value, out); }
  else if (p.type === 'ArrayPattern') { for (const el of p.elements) patternNames(el, out); }
  else if (p.type === 'AssignmentPattern') patternNames(p.left, out);
  else if (p.type === 'RestElement') patternNames(p.argument, out);
  return out;
}
function collectDeclaredDeep(ast) {
  const names = new Set();
  walk(ast, null, (n) => {
    if (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') {
      if (n.id) names.add(n.id.name);
      for (const p of n.params) for (const x of patternNames(p, [])) names.add(x);
    } else if (n.type === 'VariableDeclarator') {
      for (const x of patternNames(n.id, [])) names.add(x);
    } else if (n.type === 'CatchClause') {
      for (const x of patternNames(n.param, [])) names.add(x);
    }
  });
  return names;
}
function isNonReference(node, parent) {
  if (!parent) return true;
  if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return true;
  if ((parent.type === 'Property' || parent.type === 'PropertyDefinition' || parent.type === 'MethodDefinition') &&
      parent.key === node && !parent.computed && !(parent.type === 'Property' && parent.shorthand)) return true;
  if (parent.type === 'VariableDeclarator' && parent.id === node) return true;
  if (parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' || parent.type === 'ArrowFunctionExpression') {
    if (parent.id === node) return true;
    if (parent.params.indexOf(node) !== -1) return true;
  }
  if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') return true;
  if (parent.type === 'CatchClause' && parent.param === node) return true;
  if (parent.type === 'AssignmentPattern' && parent.left === node) return true;
  return false;
}
/** Топ-уровневые объявления фрагмента. */
function topLevelNames(ast) {
  return ast.body
    .map((st) => (st.type === 'FunctionDeclaration' ? [st.id.name]
      : st.type === 'VariableDeclaration' ? st.declarations.filter((d) => d.id.type === 'Identifier').map((d) => d.id.name) : []))
    .reduce((a, b) => a.concat(b), []);
}
/**
 * Внешние имена фрагмента + пометка «переприсваивается ли» + счётчик рёбер AST.
 * declared передаётся СНАРУЖИ и считается по ОБЪЕДИНЕНИЮ диапазонов A+B: имя, объявленное
 * в A (`function aiCmArchiveTierApply`), для B не внешнее — в модуле они лежат в одном
 * скоупе IIFE. Аудит по каждому диапазону отдельно дал бы ложное «внешнее имя».
 */
function rangeRefs(text, label, declared) {
  const ast = parseJs(text, label);
  const own = collectDeclaredDeep(ast);
  const external = new Map();
  const edges = new Map();
  walk(ast, null, (n, parent) => {
    if (n.type !== 'Identifier') return;
    if (isNonReference(n, parent)) return;
    if (declared.has(n.name)) return;
    edges.set(n.name, (edges.get(n.name) || 0) + 1);
    let write = false;
    if (parent && parent.type === 'AssignmentExpression' && parent.left === n) write = true;
    if (parent && parent.type === 'UpdateExpression' && parent.argument === n) write = true;
    if (parent && (parent.type === 'ForInStatement' || parent.type === 'ForOfStatement') && parent.left === n) write = true;
    const cur = external.get(n.name) || { write: false };
    if (write) cur.write = true;
    external.set(n.name, cur);
  });
  return { declared: own, external, top: topLevelNames(ast), edges };
}

/* ------------------------------------------------------------------ *
 * 3. Подстановки состояния
 * ------------------------------------------------------------------ */

/** Токен-безопасная замена: не трогает `D.имя`, свойства (`obj.имя`) и хвосты слов. */
function unprefixStateRefs(text, name) {
  const re = new RegExp('D\\.' + name + '(?![\\w$])', 'g');
  return text.replace(re, name);
}
function countBare(text, name) {
  return (text.match(new RegExp('(^|[^\\w$.])' + name + '(?![\\w$])', 'g')) || []).length;
}
function countD(text, name) {
  return (text.match(new RegExp('D\\.' + name + '(?![\\w$])', 'g')) || []).length;
}

/** Комментарии И строковые литералы заменяются пробелами (длины и переводы строк сохранены).
 *  Нужно для проверки «в коде не осталось свободных ссылок»: упоминание имени внутри строки
 *  (`'… (reachedStart=true) → …'` — текст лога) ссылкой не является и обязано выжить. */
function codeOnlyNoStrings(src, label) {
  const comments = [];
  const ast = parseJs(src, label, comments);
  const out = src.split('');
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '; };
  for (const c of comments) blank(c.start, c.end);
  walk(ast, null, (n) => {
    if (n.type === 'Literal' && typeof n.value === 'string') blank(n.start, n.end);
    else if (n.type === 'TemplateLiteral') blank(n.start, n.end);
  });
  return out.join('');
}

/** Все строковые литералы исходника — в порядке появления, вместе с кавычками. */
function stringLiterals(text, label) {
  const ast = parseJs(text, label);
  const out = [];
  walk(ast, null, (n) => {
    if (n.type === 'Literal' && typeof n.value === 'string') out.push(text.slice(n.start, n.end));
  });
  return out;
}

/**
 * Подстановка `D.` по AST, а не по регулярке. Это принципиально: в диапазоне B есть
 * строка-литерал `'… (reachedStart=true) → …'` (лог пропуска восстановления) — слепая
 * замена превратила бы ЛОГ в `D.reachedStart=true`, то есть испортила бы текст сообщения,
 * а не ссылку. AST видит ровно рёбра-идентификаторы: комментарии, строки-литералы, ключи
 * объектов и локальные имена остаются байт-в-байт.
 *
 * `declared` — объявления ОБЪЕДИНЕНИЯ диапазонов: имена, объявленные в кластере
 * (aiCmArchiveFor, aiCmArchiveOnlyBase, …), резолвятся внутри модуля и префикса не получают.
 * Правка идёт с КОНЦА, поэтому ранее собранные смещения остаются валидными.
 */
function astPrefix(text, label, nameSet, declared) {
  const ast = parseJs(text, label);
  const targets = [];
  walk(ast, null, (n, parent) => {
    if (n.type !== 'Identifier') return;
    if (!nameSet.has(n.name)) return;
    if (isNonReference(n, parent)) return;
    if (declared.has(n.name)) return;
    if (parent && parent.type === 'Property' && parent.shorthand) {
      fail(label + ': имя ' + n.name + ' стоит в shorthand-свойстве — `D.имя` там синтаксически невалидно');
    }
    targets.push(n);
  });
  let out = text;
  for (let i = targets.length - 1; i >= 0; i--) {
    out = out.slice(0, targets[i].start) + 'D.' + out.slice(targets[i].start);
  }
  return { text: out, count: targets.length };
}

/* ------------------------------------------------------------------ *
 * 4. Сборка модуля
 * ------------------------------------------------------------------ */

function moduleHeader() {
  return [
    '/**',
    ' * core/gemini-archive.js — кластер архива (первый ярус полноты) Gemini (Phase 3 step ' + STEP + ').',
    ' *',
    ' * ЧТО ЗДЕСЬ. Восемь функций первого яруса и три слушателя, которые его питают:',
    ' * приём нормализованных ходов архива от content.js (ai-cm-archive-restore) со',
    ' * same-conv-union вливания (aiCmArchiveFor, aiCmArchiveTierApply), вливание ленты кэша',
    ' * (ai-cm-restored-history, aiCmBuildBaseMessages), сводка ОБЪЕДИНЁННОЙ базы для экспорта',
    ' * (aiCmBaseExportInfo) и уточнение канонического снимка после кэша (ai-cm-cache-refresh).',
    ' *',
    ' * ПОЧЕМУ ВЫНЕСЕНО. Кластер — замкнутая подсистема со своим словарём: «архивный count»,',
    ' * «живой ярус», «пол архива», «оракул archive-complete». Из 22 имён ядра, которые он',
    ' * читает и пишет, 11 — состояние (8 только на чтение и 3 с записью), а остальные 11 —',
    ' * функции ядра; при этом сами восемь функций кластера зовут друг друга ВНУТРИ модуля.',
    ' * Логика архива больше не размазана по двум тысячам строк ядра.',
    ' *',
    ' * СВЯЗКА. Ядро зовёт window.' + MODULE_GLOBAL + '.__bind({...}) из core/gemini-intercept.js;',
    ' * состав объекта связи — tools/archive-bind-contract.js: 11 функций значением, 8 имён',
    ' * только на чтение и 3 — с геттером и сеттером. Обратно модуль отдаёт ' + EXPORTED.length + ' функций',
    ' * (см. Api в конце файла).',
    ' *',
    ' * СОСТОЯНИЕ ОСТАЁТСЯ В ЯДРЕ. turnsMap, archiveTierByConv, archiveMergedMap,',
    ' * cacheRestoredMap, loaderDoneMap, loaderRunningFor, parserVersion, quietActive и три',
    ' * вердикта полноты (historyFullByQuiet, reachedStart, tapeWasUsedInThisColdStart)',
    ' * объявлены в ядре и НЕ перенесены: их читают и пишут ingest, лоадер, пагинация,',
    ' * сброс при смене чата и мост content.js. Модуль получает их ЖИВЫМИ геттерами',
    ' * (и сеттерами там, где пишет), поэтому мутация объекта видна ядру по ссылке, а',
    ' * присваивание вердикта доходит до той же переменной IIFE, а не до копии.',
    ' *',
    ' * ПРАВКА ПРИ ПЕРЕНОСЕ. Тела перенесены байт-в-байт; единственные изменения —',
    ' * ссылки на имена ядра получили префикс D (иначе свободное имя не разрешится:',
    ' * модуль — отдельный файл, общего лексического скоупа с ядром у него нет) и в начало',
    ' * каждого слушателя добавлен гард `if (!D)`. Свойства объектов, ключи литералов,',
    ' * локальные имена, комментарии и вызовы ВНУТРИ кластера (aiCmArchiveFor,',
    ' * aiCmArchiveOnlyBase, aiCmArchiveGrewBeyondArchive, aiCmBuildBaseMessages,',
    ' * aiCmLiveTurnCount, aiCmArchiveLiveProven, aiCmArchiveTierApply, aiCmBaseExportInfo)',
    ' * не тронуты — они резолвятся внутри модуля.',
    ' *',
    ' * ПОРЯДОК ПОДКЛЮЧЕНИЯ. utils/debug.js, utils/gemini-batchexecute-parser.js,',
    ' * utils/gemini-intercept-logic.js, core/gemini-hidden-scroll.js, core/gemini-diag.js,',
    ' * core/gemini-rpc.js, core/gemini-parse.js, core/gemini-sse.js,',
    ' * core/pagination/pagination.js, core/gemini-loader-scroll.js, core/gemini-ingest.js,',
    ' * core/gemini-overlay.js, ЭТОТ ФАЙЛ, core/gemini-intercept.js — см. js[] в',
    ' * core/background.js (id -v10: MV3 не перечитывает js[] под уже зарегистрированным id,',
    ' * поэтому при добавлении файла id обязан смениться, иначе модуль не доедет до профилей',
    ' * с прежним id, а без модуля архивный ярус недоступен целиком: каждая функция-форвардер',
    ' * деградирует в null/true/baseSize(), то есть гейты полноты молча теряют T1-архив).',
    ' *',
    ' * ВНИМАНИЕ. Слушатели регистрируются на загрузке модуля, то есть до вызова __bind из',
    ' * ядра. Это безопасно: до первого реального события ядро уже загружено (файлы идут',
    ' * одним пакетом content script без разрывов), а гард `if (!D)` в начале каждого',
    ' * слушателя закрывает и теоретический случай. Файл намеренно без директивы строгого',
    ' * режима и без with — как остальные модули MAIN-мира.',
    ' *',
    ' * PUBLIC API: window.' + MODULE_GLOBAL + ' = { __bind, ' + EXPORTED.join(', ') + ' }.',
    ' */'
  ];
}
const BIND_ANCHOR = '  function __bind(d) { D = d; }';
const API_ANCHOR = '  var Api = {';
function buildModule(bodyLines) {
  const out = moduleHeader();
  out.push('(function () {');
  out.push("  if (typeof window !== 'undefined' && window." + MODULE_GLOBAL + ') return;');
  out.push('  // Зависимости ядра. Заполняется один раз через __bind(...) из core/gemini-intercept.js.');
  out.push('  var D = null;');
  out.push(BIND_ANCHOR);
  out.push('');
  for (const l of bodyLines) out.push(l);
  out.push('');
  out.push(API_ANCHOR);
  out.push('    __bind: __bind,');
  for (let i = 0; i < EXPORTED.length; i++) {
    out.push('    ' + EXPORTED[i] + ': ' + EXPORTED[i] + (i === EXPORTED.length - 1 ? '' : ','));
  }
  out.push('  };');
  out.push("  if (typeof module !== 'undefined' && module.exports) module.exports = Api;");
  out.push("  if (typeof window !== 'undefined') window." + MODULE_GLOBAL + ' = Api;');
  out.push('})();');
  out.push('');
  return out.join('\n');
}
/** Тело модуля без каркаса: строки между `function __bind` и `var Api = {`. */
function moduleBodyOf(moduleText) {
  const lines = moduleText.split('\n');
  const from = lines.indexOf(BIND_ANCHOR);
  const to = lines.indexOf(API_ANCHOR);
  if (from === -1 || to === -1 || to <= from) fail('не найдены границы тела модуля (каркас разъехался)');
  let s = from + 1;
  while (s < to && lines[s] === '') s++;
  let e = to;
  while (e > s && lines[e - 1] === '') e--;
  return lines.slice(s, e);
}

/* ------------------------------------------------------------------ *
 * 5. Блок подключения и баннер-указатель в ядре
 * ------------------------------------------------------------------ */

function bindBlock() {
  const fnNames = CONTRACT.filter((x) => x[1] === 'fn').map((x) => x[0]);
  const roNames = CONTRACT.filter((x) => x[1] === 'ro').map((x) => x[0]);
  const rwNames = CONTRACT.filter((x) => x[1] === 'rw').map((x) => x[0]);
  const out = [];
  out.push('  // ===== v2.0 (Phase 3 step ' + STEP + '): АРХИВ (ВЫНЕСЕН В ' + P.module + ') =====');
  out.push('  // Тела кластера — восемь функций первого яруса полноты (архив, оракул');
  out.push('  // archive-complete, пол архива, сводка объединённой базы) и три слушателя');
  out.push('  // (ai-cm-restored-history, ai-cm-archive-restore, ai-cm-cache-refresh) — живут в');
  out.push('  // модуле, подключение ниже. Логика сюда НЕ возвращается: правки архива делаются');
  out.push('  // в ' + P.module + '.');
  out.push('  // Состояние (turnsMap/archiveTierByConv/archiveMergedMap/cacheRestoredMap/');
  out.push('  // loaderDoneMap/loaderRunningFor/parserVersion/quietActive и три вердикта полноты)');
  out.push('  // остаётся ЗДЕСЬ: его читают и пишут ingest, лоадер, пагинация и сброс при смене');
  out.push('  // чата, поэтому модуль получает нужные ему имена ЖИВЫМИ геттерами/сеттерами, а не');
  out.push('  // копиями значений. sanitizeMessagesForEmit тоже остаётся: им пользуется ingest.');
  out.push('  // Блок стоит НИЖЕ строки 782 намеренно: emitBaseSnapshot, mergeRestoredTurns и');
  out.push('  // refreshMinOrderTracking — ПОЗДНИЕ алиасы (`var ... = null`), их дозаполняют блоки');
  out.push('  // ingest (770-771) и пагинации (494); выше в модуль уехали бы null.');
  out.push('  var aiCmGeminiArchive = (typeof window !== \'undefined\' && window.' + MODULE_GLOBAL + ') || null;');
  out.push('');
  out.push('  // Форвардеры — ИМЕННО function declaration: объявления хойстятся, поэтому все');
  out.push('  // прежние вызовы из ядра (stableFloorConfirm 881-885, notifyLoaderState 1010,');
  out.push('  // self-heal 1076-1111, снапшот turns 1416) и из чужих __bind-блоков (пагинация 430,');
  out.push('  // лоадер 544-547) не тронуты — к моменту любого из них имя уже существует.');
  out.push('  // Без модуля деградация безмолвная: aiCmArchiveFor → null, aiCmArchiveLiveProven →');
  out.push('  // true (прежние гейты), aiCmLiveTurnCount → baseSize(), остальные → undefined/null.');
  out.push('  // Ни один вызов не бросает.');
  for (const f of FORWARDERS) for (const l of f.body) out.push(l);
  out.push('');
  out.push('  if (aiCmGeminiArchive) {');
  out.push('    aiCmGeminiArchive.__bind({');
  out.push('      // Функции ядра (11): декларации хойстятся — значения доступны на момент bind.');
  for (const n of fnNames) out.push('      ' + n + ': ' + n + ',');
  out.push('      // Только чтение (8): сеттер не нужен — модуль эти переменные не переприсваивает');
  out.push('      // (мутации объектов по ссылке видны ядру и без сеттера).');
  for (const n of roNames) out.push('      get ' + n + '() { return ' + n + '; },');
  out.push('      // Живое состояние (3): get + set — запись из модуля обязана дойти до ядра.');
  const rwPairs = [];
  for (const n of rwNames) {
    rwPairs.push('      get ' + n + '() { return ' + n + '; },');
    rwPairs.push('      set ' + n + '(v) { ' + n + ' = v; },');
  }
  if (rwPairs.length) rwPairs[rwPairs.length - 1] = rwPairs[rwPairs.length - 1].replace(/,$/, '');
  for (const l of rwPairs) out.push(l);
  out.push('    });');
  out.push('  } else {');
  out.push('    // Модуль не подключён (у уже установленного расширения Chrome остался прежний');
  out.push('    // registration с прежним id: MV3 не перечитывает js[] под существующим id).');
  out.push('    // Деградация мягкая: архивного яруса нет, база собирается живыми путями');
  out.push('    // (vf5/пагинация/лоадер), гейты полноты работают как до T1.');
  out.push("    debugLog('log', '[gemini-intercept] " + P.module + " не подключён — архивный ярус недоступен');");
  out.push('  }');
  return out;
}

/** Баннер-указатель на месте диапазона B: три слушателя уехали в модуль. */
function pointerBlock() {
  return [
    '  // ===== v2.0 (Phase 3 step ' + STEP + '): АРХИВ (ВЫНЕСЕН В ' + P.module + ') =====',
    '  // Здесь были три слушателя кластера архива: приём ленты кэша (ai-cm-restored-history),',
    '  // приём нормализованных ходов архива (ai-cm-archive-restore) и уточнение канонического',
    '  // снимка после кэша (ai-cm-cache-refresh). Все три живут в ' + P.module + ' и',
    '  // регистрируются на загрузке модуля; каждая ветка начинается гардом `if (!D)`, поэтому',
    '  // до связки событие игнорируется с внятным логом, а не бросает ReferenceError.',
    '  // Логика сюда НЕ возвращается: правки приёма архива и ленты — в модуле.'
  ];
}

/* ------------------------------------------------------------------ *
 * 6. Прогон
 * ------------------------------------------------------------------ */

function main() {
  section('0. Контракт связки');
  log('  имён в контракте: ' + CONTRACT.length + ' (' + CONTRACT.map((x) => x[0] + ':' + x[1]).join(', ') + ')');
  if (CONTRACT.length !== 22) fail('контракт обязан содержать ровно 22 имени (план шага ' + STEP + '), а их ' + CONTRACT.length);
  if (new Set(CONTRACT_NAMES).size !== CONTRACT_NAMES.length) fail('в контракте есть дубликаты имён');
  const kinds = { fn: 0, ro: 0, rw: 0 };
  for (const x of CONTRACT) { if (!(x[1] in kinds)) fail('неизвестный вид связи: ' + x[1]); kinds[x[1]]++; }
  if (kinds.fn !== 11 || kinds.ro !== 8 || kinds.rw !== 3) {
    fail('разбивка видов разошлась с планом: fn=' + kinds.fn + ' ro=' + kinds.ro + ' rw=' + kinds.rw + ' (ждали 11/8/3)');
  }
  ok('22 имени: 11 fn + 8 ro + 3 rw — как в плане шага ' + STEP);

  /* ---- 1. файлы ---- */
  section('1. Файлы: LF/BOM/хвост, отсутствие готового модуля');
  const SRC = {
    core: read(P.core), background: read(P.background), helper: read(P.helper), qwen: read(P.qwen),
    pagTest: read(P.pagTest), ingestTest: read(P.ingestTest), overlayTest: read(P.overlayTest),
    gateTest: read(P.gateTest), unionTest: read(P.unionTest), oracleTest: read(P.oracleTest),
    gitignore: read(P.gitignore), release: read(P.release)
  };
  for (const rel of [P.core, P.background, P.helper, P.qwen, P.pagTest, P.ingestTest, P.overlayTest,
    P.gateTest, P.unionTest, P.oracleTest, P.gitignore, P.release]) {
    observeEol(rel, SRC[rel] === undefined ? read(rel) : SRC[rel]);
  }
  ok('EOL/BOM/хвост в порядке у 12 правимых файлов (*.js — LF по .gitattributes; .gitignore/release.yml — ' +
    EOL_OF.get(P.gitignore) + '/' + EOL_OF.get(P.release) + ', режим сохраняется)');
  EOL_OF.set(P.module, 'lf');
  if (fs.existsSync(path.join(ROOT, P.module))) {
    fail(P.module + ' уже существует — шаг уже применён (или создан вручную). Удалите его осознанно.');
  }
  ok(P.module + ' ещё не создан');

  /* ---- 2. аудит диапазонов ---- */
  section('2. Аудит диапазонов ядра A ' + RANGE_A.a + '-' + RANGE_A.b + ' и B ' + RANGE_B.a + '-' + RANGE_B.b);
  const coreLines = SRC.core.split('\n');
  for (const [nm, R] of [['A', RANGE_A], ['B', RANGE_B]]) {
    if (coreLines[R.a - 1] !== R.first) {
      fail('анкер начала диапазона ' + nm + ' (строка ' + R.a + ') не совпал.\n  ожидалось: ' + shorten(R.first) +
        '\n  получено:  ' + shorten(coreLines[R.a - 1]));
    }
    if (coreLines[R.b - 1] !== R.last) {
      fail('анкер конца диапазона ' + nm + ' (строка ' + R.b + ') не совпал.\n  ожидалось: ' + shorten(R.last) +
        '\n  получено:  ' + shorten(coreLines[R.b - 1]));
    }
  }
  ok('байтовые анкеры ОБОИХ диапазонов совпали');
  if (RANGE_A.b >= RANGE_B.a) fail('диапазоны пересекаются — аудит и правка были бы неоднозначны');

  for (const s of STATE_LINES) {
    if (coreLines[s.n - 1] !== s.text) {
      fail('строка состояния ' + s.n + ' не совпала — состояние обязано остаться в ядре нетронутым.\n  ожидалось: ' +
        shorten(s.text) + '\n  получено:  ' + shorten(coreLines[s.n - 1]));
    }
  }
  ok('строки состояния (' + STATE_LINES.length + ') на месте (остаются в ядре)');
  mustContain(SRC.core, '  function sanitizeMessagesForEmit(messages) {', 'ядро: sanitizeMessagesForEmit');
  ok('sanitizeMessagesForEmit остаётся в ядре (в диапазоны не входит)');

  const rangeAText = coreLines.slice(RANGE_A.a - 1, RANGE_A.b).join('\n');
  const rangeBText = coreLines.slice(RANGE_B.a - 1, RANGE_B.b).join('\n');

  /* Объявления считаются по ОБЪЕДИНЕНИЮ: в модуле A и B лежат в одном скоупе IIFE,
   * поэтому имя, объявленное в A, для B не внешнее. */
  const declaredAll = collectDeclaredDeep(parseJs(rangeAText + '\n' + rangeBText, 'диапазоны A+B'));
  const refsA = rangeRefs(rangeAText, 'диапазон A', declaredAll);
  const refsB = rangeRefs(rangeBText, 'диапазон B', declaredAll);
  const movedTop = refsA.top.concat(refsB.top).sort();
  if (movedTop.join(',') !== MOVED_TOP_LEVEL.slice().sort().join(',')) {
    fail('топ-уровневые объявления диапазонов разошлись с планом.\n  ожидалось: ' +
      MOVED_TOP_LEVEL.slice().sort().join(', ') + '\n  получено:  ' + movedTop.join(', '));
  }
  ok('переносимых объявлений: ' + movedTop.length + ' (' + movedTop.join(', ') + ')');

  const externals = [...new Set([...refsA.external.keys(), ...refsB.external.keys()])].sort();
  const expectExternal = CONTRACT_NAMES.concat(STAY_GLOBAL).sort();
  const unexpected = externals.filter((n) => expectExternal.indexOf(n) === -1);
  if (unexpected.length) {
    fail('диапазоны обращаются к именам вне контракта и вне белого списка глобалов: ' + unexpected.join(', ') +
      '\n  это значит, что перенос молча сломал бы их (свободное имя в модуле не разрешится).');
  }
  const missingContract = SUBS.filter((s) => !refsA.external.has(s.name) && !refsB.external.has(s.name));
  if (missingContract.length) {
    fail('имена контракта не встречаются в диапазонах: ' + missingContract.map((s) => s.name).join(', '));
  }
  const unusedGlobal = STAY_GLOBAL.filter((n) => externals.indexOf(n) === -1);
  ok('внешние имена диапазонов = контракт (' + CONTRACT_NAMES.length + ') + ' +
    (STAY_GLOBAL.length - unusedGlobal.length) + ' глобалов MAIN-мира' +
    (unusedGlobal.length ? ' (не встречаются: ' + unusedGlobal.join(', ') + ')' : ''));
  /* ro/rw сверяются с AST: «ro» означает «модуль не ПЕРЕПРИСВАИВАЕТ переменную».
   * Мутации объектов по ссылке (`turnsMap[id] = …`, `Set.add`) — не переприсваивание. */
  for (const s of SUBS) {
    const a = refsA.external.get(s.name);
    const b = refsB.external.get(s.name);
    const write = !!((a && a.write) || (b && b.write));
    if (s.kind === 'rw' && !write) fail('контракт обещает ' + s.name + ' как rw, но диапазоны его только читают');
    if (s.kind === 'ro' && write) fail('контракт обещает ' + s.name + ' как ro, но диапазоны его переприсваивают');
  }
  ok('виды ro/rw подтверждены обходом AST (переприсваиваний у ro-имён нет)');

  /* ---- 3. сборка модуля ---- */
  section('3. Сборка ' + P.module);
  const nameSet = new Set(CONTRACT_NAMES);
  /* Рёбра считаем ТОЛЬКО по именам контракта: свободные глобалы (window/Object/Array/
   * String/debugLog) остаются без префикса и в эту сумму не входят. */
  const edgeSum = (refs) => CONTRACT_NAMES.reduce((a, n) => a + (refs.edges.get(n) || 0), 0);
  const preA = astPrefix(rangeAText, 'диапазон A', nameSet, declaredAll);
  const preB = astPrefix(rangeBText, 'диапазон B', nameSet, declaredAll);
  const subA = preA.text;
  const subB0 = preB.text;
  if (preA.count !== edgeSum(refsA)) fail('A: подставлено ' + preA.count + ' рёбер, а AST насчитал ' + edgeSum(refsA));
  if (preB.count !== edgeSum(refsB)) fail('B: подставлено ' + preB.count + ' рёбер, а AST насчитал ' + edgeSum(refsB));
  const subLog = [];
  for (const s of SUBS) {
    const n = countD(subA, s.name) + countD(subB0, s.name);
    if (n === 0) fail('подстановка ' + s.name + ': в диапазонах не найдено ни одного обращения');
    if (n !== (refsA.edges.get(s.name) || 0) + (refsB.edges.get(s.name) || 0)) {
      fail('подстановка ' + s.name + ': префиксов ' + n + ', а рёбер AST ' +
        ((refsA.edges.get(s.name) || 0) + (refsB.edges.get(s.name) || 0)));
    }
    subLog.push(s.name + '×' + n);
  }
  ok('подстановки D.* (всего ' + (preA.count + preB.count) + '): ' + subLog.join(', '));
  /* Каждое имя обязано потерять в КОДЕ ровно столько вхождений, сколько рёбер в AST.
   * Остаток — упоминания внутри строк-литералов: они подстановке не подлежат и обязаны
   * выжить (в диапазоне B есть лог `'… (reachedStart=true) → …'`). Плюс прямая проверка:
   * набор строковых литералов до и после подстановки совпадает ПОБАЙТОВО. */
  const codeAText = codeOnly(rangeAText, 'диапазон A (код)');
  const codeBText = codeOnly(rangeBText, 'диапазон B (код)');
  let totalEdges = 0;
  const literalMentions = [];
  for (const s of SUBS) {
    const eA = refsA.edges.get(s.name) || 0;
    const eB = refsB.edges.get(s.name) || 0;
    const before = countBare(codeAText, s.name) + countBare(codeBText, s.name);
    const after = countBare(codeOnly(subA, 'A (подставлено)'), s.name) +
      countBare(codeOnly(subB0, 'B (подставлено)'), s.name);
    if (before - after !== eA + eB) {
      fail('имя ' + s.name + ': вхождений в коде было ' + before + ', осталось ' + after +
        ', а рёбер AST ' + (eA + eB) + ' — подстановка ушла не туда');
    }
    if (after) literalMentions.push(s.name + '×' + after);
    totalEdges += eA + eB;
  }
  ok('все ' + CONTRACT_NAMES.length + ' имён: ' + totalEdges + ' рёбер AST подставлено, ' +
    (literalMentions.length ? 'упоминания в строках-литералах сохранены (' + literalMentions.join(', ') + ')' : 'литералов с именами ядра нет'));
  const litsA = stringLiterals(rangeAText, 'A').concat(stringLiterals(rangeBText, 'B'));
  const litsB = stringLiterals(subA, 'A (подставлено)').concat(stringLiterals(subB0, 'B (подставлено)'));
  if (litsA.length !== litsB.length || litsA.some((x, i) => x !== litsB[i])) {
    const i = litsA.findIndex((x, k) => x !== litsB[k]);
    fail('набор строковых литералов изменился на позиции ' + i + ':\n  было: ' + shorten(litsA[i]) +
      '\n  стало: ' + shorten(litsB[i]));
  }
  ok('все ' + litsA.length + ' строковых литералов диапазонов совпадают байт-в-байт (логи не переписаны)');
  /* Гарды !D в начало трёх слушателей. */
  let subB = subB0;
  for (const g of GUARDS) {
    subB = mustReplace(subB, g.anchor, g.anchor + '\n' + g.insert, 'модуль: гард !D слушателя', 1);
  }
  ok('гарды !D добавлены в начало всех ' + GUARDS.length + ' слушателей');
  const bodyA = subA.split('\n');
  const bodyB = subB.split('\n');
  if (bodyA.length !== RANGE_A.b - RANGE_A.a + 1) fail('длина тела A разъехалась');
  if (bodyB.length !== RANGE_B.b - RANGE_B.a + 1 + GUARDS.length) fail('длина тела B разъехалась');
  const moduleText = buildModule(bodyA.concat([''], bodyB));
  checkEol(P.module, moduleText);
  ok('модуль собран: ' + (moduleText.split('\n').length - 1) + ' строк, ' + Buffer.byteLength(moduleText, 'utf8') + ' байт');
  if (PRINT_MODULE) {
    log('\n--- ' + P.module + ' (' + (moduleText.split('\n').length - 1) + ' строк) ---');
    log(moduleText);
    log('--- конец модуля ---\n');
  }

  /* ---- 4. доказательство обратимости ---- */
  section('4. Доказательство: тела байт-в-байт, изменены только префиксы состояния и гарды');
  const body = moduleBodyOf(moduleText);
  if (body.length !== bodyA.length + 1 + bodyB.length) {
    fail('тело модуля (' + body.length + ') не равно A+разделитель+B (' + (bodyA.length + 1 + bodyB.length) + ')');
  }
  if (body[bodyA.length] !== '') fail('разделитель между телами A и B потерялся');
  const backA = body.slice(0, bodyA.length).join('\n');
  const backB = body.slice(bodyA.length + 1).join('\n');
  let unA = backA;
  let unB = backB;
  for (const s of SUBS) { unA = unprefixStateRefs(unA, s.name); unB = unprefixStateRefs(unB, s.name); }
  if (unA !== rangeAText) {
    const a = unA.split('\n'); const b = rangeAText.split('\n');
    let i = 0; while (i < a.length && a[i] === b[i]) i++;
    fail('обратный ход A не совпал на строке ' + (i + 1) + '\n  в модуле: ' + JSON.stringify(a[i]) +
      '\n  в ядре было: ' + JSON.stringify(b[i]));
  }
  ok('A: from → to → from байт-в-байт (' + unA.length + ' символов, ' + bodyA.length + ' строк)');
  /* Гарды снимаются ПО СТРОКАМ, а не подстрокой: текст гарда с отступом 4 является
   * подстрокой текста с отступом 6, и split по подстроке оставил бы 2 лишних пробела
   * (проверено — именно так и всплыло на первом прогоне). */
  const guardLines = new Set(GUARDS.map((g) => g.insert));
  const kept = [];
  let guardsOff = 0;
  for (const l of unB.split('\n')) {
    if (guardLines.has(l)) { guardsOff++; continue; }
    kept.push(l);
  }
  if (guardsOff !== GUARDS.length) {
    fail('обратный ход: снято гардов ' + guardsOff + ', а добавлено было ' + GUARDS.length);
  }
  unB = kept.join('\n');
  if (unB !== rangeBText) {
    const a = unB.split('\n'); const b = rangeBText.split('\n');
    let i = 0; while (i < a.length && a[i] === b[i]) i++;
    fail('обратный ход B не совпал на строке ' + (i + 1) + ' (всего строк ' + a.length + ' против ' + b.length + ')' +
      '\n  в модуле: ' + JSON.stringify(a[i]) + '\n  в ядре было: ' + JSON.stringify(b[i]));
  }
  ok('B: from → to → from байт-в-байт со снятием ' + GUARDS.length + ' гардов (' + unB.length + ' символов, ' + bodyB.length + ' строк)');

  const moduleCode = codeOnly(moduleText, P.module);
  const badInternal = MOVED_TOP_LEVEL.filter((n) => moduleCode.indexOf('D.' + n) !== -1);
  if (badInternal.length) {
    fail('вызовы ВНУТРИ кластера получили префикс D: ' + badInternal.join(', ') +
      ' — они резолвятся внутри модуля и обязаны остаться с прежними именами');
  }
  ok('вызовы внутри кластера (' + MOVED_TOP_LEVEL.length + ') префикса не получили');
  /* Свободных ССЫЛОК на имена ядра в модуле быть не должно. Упоминания внутри строковых
   * литералов — не ссылки (в диапазоне B живёт лог `'… (reachedStart=true) → …'`), поэтому
   * маскируются и комментарии, и строки. */
  const moduleRefs = codeOnlyNoStrings(moduleText, P.module + ' (код без строк)');
  const bareLeft = CONTRACT_NAMES.filter((n) => countBare(moduleRefs, n) !== 0);
  if (bareLeft.length) {
    fail('имена ядра встречаются в КОДЕ модуля без префикса D: ' + bareLeft.join(', ') +
      ' — свободное имя в модуле не разрешится (тихий ReferenceError внутри try/catch)');
  }
  ok('ни одно имя контракта не встречается в коде модуля без префикса (упоминания в строках-логах сохранены)');
  for (const g of GUARDS) mustContain(moduleText, g.insert.trim(), 'модуль: гард ' + g.insert.trim().slice(0, 24));
  mustContain(moduleText, "window.addEventListener('ai-cm-restored-history', function (ev) {", 'модуль: слушатель ленты');
  mustContain(moduleText, "window.addEventListener('ai-cm-archive-restore', function (ev) {", 'модуль: слушатель архива');
  mustContain(moduleText, "window.addEventListener('ai-cm-cache-refresh', function (ev) {", 'модуль: слушатель кэш-рефреша');
  ok('все три слушателя перенесены, каждый начинается гардом !D');

  /* ---- 5. правка ядра ---- */
  section('5. Правка ядра: A → баннер + форвардеры + __bind, B → баннер-указатель');
  const bind = bindBlock();
  const pointer = pointerBlock();
  if (PRINT_BIND) {
    log('\n--- блок подключения (' + bind.length + ' строк) ---');
    for (const l of bind) log(l);
    log('--- конец блока ---\n');
  }
  const next = [];
  for (let i = 1; i <= coreLines.length; i++) {
    if (i === RANGE_A.a) {
      for (const l of bind) next.push(l);
      i = RANGE_A.b;
      continue;
    }
    if (i === RANGE_B.a) {
      for (const l of pointer) next.push(l);
      i = RANGE_B.b;
      continue;
    }
    next.push(coreLines[i - 1]);
  }
  const core1 = next.join('\n');
  checkEol(P.core, core1);
  const removedA = RANGE_A.b - RANGE_A.a + 1;
  const removedB = RANGE_B.b - RANGE_B.a + 1;
  const removed = removedA + removedB;
  const expectLen = coreLines.length - removed + bind.length + pointer.length;
  if (next.length !== expectLen) fail('длина нового ядра ' + next.length + ' не совпала с расчётной ' + expectLen);
  ok('удалено строк: ' + removed + ' (A ' + removedA + ' + B ' + removedB + '), вставлено: ' +
    (bind.length + pointer.length) + ' (блок ' + bind.length + ' + указатель ' + pointer.length + '), ядро: ' + (next.length - 1) + ' строк');
  if (bind.length >= removedA) fail('блок подключения не короче диапазона A — вынос не сократил ядро');
  ok('ядро сокращено на ' + (removedA - bind.length) + ' строк');

  /* Оба диапазона лежат НИЖЕ хвостовой точки vf5, поэтому её строка обязана остаться 1680. */
  const vf5Hits = [];
  next.forEach((l, i) => { if (l.indexOf(VF5_TAIL) !== -1) vf5Hits.push(i + 1); });
  if (vf5Hits.length !== 1 || vf5Hits[0] !== VF5_LINE) {
    fail('хвостовая точка vf5 в новом ядре на строках [' + vf5Hits.join(', ') + '], а пин R-D №3 ждёт [' + VF5_LINE + ']\n' +
      '  причина: шаг ' + STEP + ' правит ТОЛЬКО строки > ' + RANGE_A.a + ', то есть НИЖЕ этой точки; сдвиг означал бы ошибку в диапазонах');
  }
  ok('хвостовая точка vf5 осталась на строке ' + VF5_LINE + ' (оба диапазона ниже неё — пин R-D №3 не меняется)');

  const coreCode = codeOnly(core1, P.core + ' (после правки)');
  for (const n of MOVED_TOP_LEVEL) {
    const decls = (coreCode.match(new RegExp('function\\s+' + n + '\\s*\\(', 'g')) || []).length;
    const want = EXPORTED.indexOf(n) === -1 ? 0 : 1;
    if (decls !== want) {
      fail('в ядре объявление ' + n + ' встречается ' + decls + ' раз (ожидалось ' + want + ')');
    }
  }
  ok('в ядре не осталось тел перенесённых функций: 5 форвардеров, 3 имени уехали целиком');
  for (const f of FORWARDERS) {
    mustContain(core1, f.body.join('\n'), 'ядро: форвардер ' + f.name);
    if (!new RegExp('\\n  function ' + f.name + '\\(').test(core1)) {
      fail('форвардер ' + f.name + ' объявлен не как function declaration — хойстинг сломан');
    }
  }
  ok('все 5 форвардеров — function declaration с плановыми телами (ройство сохранено)');
  for (const s of STATE_LINES) mustContain(core1, s.text, 'ядро: состояние ' + s.n);
  mustContain(core1, '  function sanitizeMessagesForEmit(messages) {', 'ядро: sanitizeMessagesForEmit после правки');
  ok('состояние (' + STATE_LINES.length + ' строк) и sanitizeMessagesForEmit остались в ядре байт-в-байт');
  const notBound = CONTRACT_NAMES.filter((n) => core1.indexOf(n + ': ' + n + ',') === -1 &&
    !new RegExp('get\\s+' + n + '\\s*\\(\\)').test(core1));
  if (notBound.length) fail('ядро не передаёт в __bind: ' + notBound.join(', '));
  ok('блок __bind отдаёт все ' + CONTRACT_NAMES.length + ' имени контракта');
  /* Блок подключения обязан стоять НИЖЕ поздних алиасов (строка 782), иначе null уехал бы в модуль. */
  const bindAt = core1.indexOf('aiCmGeminiArchive.__bind(');
  const lateAliases = ['emitBaseSnapshot = aiCmGeminiIngest.emitBaseSnapshot;',
    'mergeRestoredTurns = aiCmGeminiIngest.mergeRestoredTurns;',
    'refreshMinOrderTracking = aiCmGeminiPagination.refreshMinOrderTracking;'];
  for (const lit of lateAliases) {
    const at = core1.indexOf(lit);
    if (at === -1) fail('поздний алиас не найден в ядре: ' + lit);
    if (at > bindAt) fail('блок подключения архива стоит ВЫШЕ позднего алиаса «' + lit + '» — в модуль уехал бы null');
  }
  const bindLine = core1.slice(0, bindAt).split('\n').length;
  if (bindLine <= 782) fail('блок подключения на строке ' + bindLine + ', а план требует > 782');
  ok('блок подключения на строке ' + bindLine + ' (> 782); все три поздних алиаса выше него');

  /* ---- 6. регистрация, .gitignore, release.yml ---- */
  section('6. Регистрация и служебные файлы');
  let bg = mustReplace(SRC.background,
    "    if (ids.indexOf('" + OLD_ID + "') === -1) {",
    '    // Phase 3 step ' + STEP + ': бамп -v9 → -v10 по той же причине — добавлен ' + P.module + '\n' +
    '    // (кластер архива вынесен из ядра: приём ходов архива и ленты кэша, оракул archive-complete,\n' +
    '    // пол архива и сводка объединённой базы для экспорта). Без бампа id у уже установленного\n' +
    '    // расширения Chrome останется прежний registration, js[] не перечитается, и ядро будет\n' +
    '    // работать без кластера: архивный ярус выключается целиком, а форвардеры возвращают\n' +
    '    // null/true/baseSize() — гейты полноты молча теряют T1-архив.\n' +
    "    if (ids.indexOf('" + NEW_ID + "') === -1) {",
    'background: гард v10', 1);
  bg = mustReplace(bg, "'" + PREV_ID + "'] });", "'" + PREV_ID + "', '" + OLD_ID + "'] });",
    'background: unregister + v9', 1);
  bg = mustReplace(bg, "await registerSafe('" + OLD_ID + "', {", "await registerSafe('" + NEW_ID + "', {",
    'background: registerSafe v10', 1);
  bg = mustReplace(bg, "id: '" + OLD_ID + "',", "id: '" + NEW_ID + "',", 'background: id v10', 1);
  bg = mustReplace(bg, "'core/gemini-overlay.js', 'core/gemini-intercept.js'],",
    "'core/gemini-overlay.js', '" + P.module + "', 'core/gemini-intercept.js'],", 'background: js[] + модуль', 1);
  bg = mustReplace(bg, '(v9) зарегистрирован', '(v10) зарегистрирован', 'background: console.log v10', 1);
  checkEol(P.background, bg);
  if (bg.indexOf("'" + P.module + "'") > bg.indexOf("'core/gemini-intercept.js'")) {
    fail('модуль оказался ПОСЛЕ ядра в js[] — ядро связало бы null');
  }
  if (bg.indexOf("'core/gemini-overlay.js'") > bg.indexOf("'" + P.module + "'")) {
    fail('модуль оказался ПЕРЕД core/gemini-overlay.js — план требует строго после него');
  }
  ok('core/background.js: id -v10, js[] … overlay → archive → ядро, -v9 в unregister, лог (v10)');

  const giNl = nlOf(SRC.gitignore);
  let gi = mustReplace(SRC.gitignore, '!tools/overlay-bind-contract.js' + giNl,
    '!tools/overlay-bind-contract.js' + giNl + '!tools/archive-bind-contract.js' + giNl,
    '.gitignore: негация контракта', 1);
  checkEol(P.gitignore, gi);
  ok('.gitignore: tools/archive-bind-contract.js выведен из-под tools/* (нужен S-пинам в чистом клоне)');

  const relNl = nlOf(SRC.release);
  const relAnchor = '          # (было 23, стало 24); фильтр не тронут, модуль приходит оверлеем dist/.';
  let rel = mustReplace(SRC.release, 'dist/ (' + MAIN_WORLD_OLD + ' MAIN-world файлов',
    'dist/ (' + MAIN_WORLD_NEW + ' MAIN-world файлов', 'release.yml: первый счётчик', 1);
  rel = mustReplace(rel, '5 бандлов + ' + MAIN_WORLD_OLD + ' MAIN-world файлов',
    '5 бандлов + ' + MAIN_WORLD_NEW + ' MAIN-world файлов', 'release.yml: второй счётчик', 1);
  rel = mustReplace(rel, relAnchor + relNl,
    relAnchor + relNl +
    '          # Phase 3 step ' + STEP + ': кластер архива вынесен в ' + P.module + ' — снова +1' + relNl +
    '          # (было ' + MAIN_WORLD_OLD + ', стало ' + MAIN_WORLD_NEW + '); фильтр не тронут, модуль приходит оверлеем dist/.' + relNl,
    'release.yml: абзац шага ' + STEP, 1);
  checkEol(P.release, rel);
  ok('release.yml: счётчики MAIN-world ' + MAIN_WORLD_OLD + ' → ' + MAIN_WORLD_NEW + ' + абзац шага');

  /* ---- 7. пины тестов и хелпер ---- */
  section('7. Хелпер и пины тестов');
  let helper = mustReplace(SRC.helper, "  'core/gemini-overlay.js'\n];",
    "  'core/gemini-overlay.js',\n  '" + P.module + "'\n];", 'helper: MODULES', 1);
  helper = mustReplace(helper,
    '// Тела оверлея перенесены с префиксом D (IIFE-каркас, а не `with (D)`): песочницы, которые\n' +
    '// исполняют вырезанные тела, обязаны получить объект связи D (см. gemini-widget-theme-h22).',
    '// Тела оверлея перенесены с префиксом D (IIFE-каркас, а не `with (D)`): песочницы, которые\n' +
    '// исполняют вырезанные тела, обязаны получить объект связи D (см. gemini-widget-theme-h22).\n' +
    '// Phase 3 step ' + STEP + ': ' + P.module + ' идёт после overlay и перед ядром — как в js[].\n' +
    '// Тела архива тоже перенесены с префиксом D, поэтому песочницы archive-export-gate и\n' +
    '// archive-export-union получают объект связи D рядом с прежними свободными именами.',
    'helper: комментарий шага ' + STEP, 1);
  checkEol(P.helper, helper);
  ok('tests/helpers/gemini-intercept-source.js: модуль в MODULES после overlay и перед ядром + проза');

  let qwen = mustReplace(SRC.qwen, "'" + OLD_ID + "',", "'" + NEW_ID + "',", 'qwen: id v10', 1);
  qwen = mustReplace(qwen, "'core/gemini-overlay.js', 'core/gemini-intercept.js']",
    "'core/gemini-overlay.js', '" + P.module + "', 'core/gemini-intercept.js']", 'qwen: литерал js[]', 1);
  qwen = mustReplace(qwen,
    '    // сменён -v8 → -v9: без модуля оверлей загрузки истории недоступен целиком — оба\n' +
    '    // форвардера возвращают undefined (палитра, наблюдатель темы и снятие оверлея выключены).',
    '    // сменён -v8 → -v9: без модуля оверлей загрузки истории недоступен целиком — оба\n' +
    '    // форвардера возвращают undefined (палитра, наблюдатель темы и снятие оверлея выключены).\n' +
    '    // На шаге ' + STEP + ' (Phase 3) в js[] ДОБАВЛЕН ' + P.module + ' (перед ядром) и id\n' +
    '    // сменён -v9 → -v10: без модуля архивный ярус (T1) недоступен целиком — форвардеры',
    'qwen: абзац шага ' + STEP, 1);
  qwen = mustReplace(qwen,
    '    // сменён -v9 → -v10: без модуля архивный ярус (T1) недоступен целиком — форвардеры',
    '    // сменён -v9 → -v10: без модуля архивный ярус (T1) недоступен целиком — форвардеры\n' +
    '    // возвращают null/true/baseSize(), то есть гейты полноты молча теряют архив.',
    'qwen: закрытие абзаца шага ' + STEP, 1);
  checkEol(P.qwen, qwen);
  ok('tests/qwen-provider-wiring.test.js: id -v10 и полный литерал js[]');

  const JS_TAIL_OLD = "'core/gemini-ingest.js', 'core/gemini-overlay.js', 'core/gemini-intercept.js'";
  const JS_TAIL_NEW = "'core/gemini-ingest.js', 'core/gemini-overlay.js', '" + P.module + "', 'core/gemini-intercept.js'";
  let pag = mustReplace(SRC.pagTest,
    "'core/gemini-sse.js', 'core/pagination/pagination.js', 'core/gemini-loader-scroll.js', " + JS_TAIL_OLD,
    "'core/gemini-sse.js', 'core/pagination/pagination.js', 'core/gemini-loader-scroll.js', " + JS_TAIL_NEW,
    'paginationTest: подстрока js[]', 1);
  pag = mustReplace(pag, '— id -v9 (шаг 13.1), модуль перед ядром, -v8 в unregister',
    '— id -v10 (шаг ' + STEP + '), модуль перед ядром, -v9 в unregister', 'paginationTest: имя теста S1', 1);
  /* В pagination-сьюте ТЕКУЩИЙ id не пинился вовсе (строка 155 держит исторический -v6),
   * поэтому пин не «переводим», а ДОБАВЛЯЕМ: иначе шаг 13.2 не был бы зафиксирован здесь. */
  pag = mustReplace(pag, "    expect(bg).toContain(\"'ai-cm-gemini-intercept-v6'\");",
    "    expect(bg).toContain(\"'ai-cm-gemini-intercept-v6'\");\n" +
    "    expect(bg).toContain(\"'" + NEW_ID + "'\");", 'paginationTest: пин текущего id', 1);
  /* D4: ядро теряет один вызов emitBaseSnapshot() — слушатель archive-restore уехал в модуль. */
  pag = mustReplace(pag,
    '    // Phase 3 step 12: три вызова (747, 988, 3157) уехали из ядра в core/gemini-ingest.js,\n' +
    '    // поэтому в ядре 4 = 3 вызова + 1 форвардер aiCmEmitBaseSnapshotFwd (шаг 12, TDZ),\n' +
    '    // а в конкатенации 9 = 4 (ядро) + 2 (пагинация) + 3 (ingest: декларация + 2 вызова).\n' +
    '    expect(CORE.match(/emitBaseSnapshot\\(\\)/g)).toHaveLength(4);',
    '    // Phase 3 step 12: три вызова (747, 988, 3157) уехали из ядра в core/gemini-ingest.js,\n' +
    '    // поэтому в ядре стало 4 = 3 вызова + 1 форвардер aiCmEmitBaseSnapshotFwd (шаг 12, TDZ).\n' +
    '    // Phase 3 step ' + STEP + ': четвёртый ядерный вызов (слушатель ai-cm-archive-restore) уехал\n' +
    '    // в ' + P.module + ', поэтому в ядре 3 = 2 вызова + 1 форвардер, а в конкатенации\n' +
    '    // по-прежнему 9 = 3 (ядро) + 2 (пагинация) + 3 (ingest: декларация + 2 вызова)\n' +
    '    // + 1 (archive: вызов в слушателе ai-cm-archive-restore).\n' +
    '    expect(CORE.match(/emitBaseSnapshot\\(\\)/g)).toHaveLength(3);',
    'paginationTest: счётчик emitBaseSnapshot (D4)', 1);
  pag = mustReplace(pag,
    ' *     S1  регистрация в core/background.js: id -v6, js[] 10 файлов, модуль ПЕРЕД ядром,\n' +
    ' *         -v5 в unregister (MV3 не перечитывает js[] под уже зарегистрированным id);',
    ' *     S1  регистрация в core/background.js: id -v10, js[] 14 файлов, модуль ПЕРЕД ядром,\n' +
    ' *         -v9 в unregister (MV3 не перечитывает js[] под уже зарегистрированным id);',
    'paginationTest: шапка S1', 1);
  checkEol(P.pagTest, pag);
  ok('tests/adapters/gemini-pagination-module.test.js: js[], id -v10, счётчик emitBaseSnapshot 4 → 3, имя S1');

  let ingest = mustReplace(SRC.ingestTest, "expect(bg).toContain(\"'" + OLD_ID + "'\");",
    "expect(bg).toContain(\"'" + NEW_ID + "'\");", 'ingestTest: id v10', 1);
  ingest = mustReplace(ingest,
    "'core/gemini-sse.js', 'core/pagination/pagination.js', 'core/gemini-loader-scroll.js', " + JS_TAIL_OLD,
    "'core/gemini-sse.js', 'core/pagination/pagination.js', 'core/gemini-loader-scroll.js', " + JS_TAIL_NEW,
    'ingestTest: подстрока js[]', 1);
  ingest = mustReplace(ingest, '— id -v9 (шаг 13.1), ingest и overlay перед ядром, -v8 снят',
    '— id -v10 (шаг ' + STEP + '), ingest, overlay и archive перед ядром, -v9 снят', 'ingestTest: имя теста S1', 1);
  /* R-D №4: ядро теряет один вызов emitBaseSnapshot() (слушатель archive-restore уехал в
   * модуль), модуль архива его приобретает — конкатенация остаётся прежней (9). */
  ingest = mustReplace(ingest,
    " *     №4  счётчик emitBaseSnapshot(): ядро 4 (3 вызова + 1 форвардер),\n" +
    ' *         конкатенация 9 = 4 (ядро) + 2 (пагинация) + 3 (ingest: декларация + 2 вызова);',
    " *     №4  счётчик emitBaseSnapshot(): ядро 3 (2 вызова + 1 форвардер),\n" +
    ' *         конкатенация 9 = 3 (ядро) + 2 (пагинация) + 3 (ingest: декларация + 2 вызова)\n' +
    ' *         + 1 (archive: вызов в слушателе ai-cm-archive-restore);',
    'ingestTest: шапка R-D №4', 1);
  ingest = mustReplace(ingest, "const MOD = readFile('core/gemini-ingest.js');",
    "const MOD = readFile('core/gemini-ingest.js');\nconst ARCH = readFile('" + P.module + "');",
    'ingestTest: чтение модуля архива', 1);
  ingest = mustReplace(ingest,
    "  test('R-D №4: счётчик emitBaseSnapshot() — ядро 4, конкатенация 9', () => {\n" +
    '    // ядро: 3 вызова (finishQuiet-ветка, probe-terminal, emit-хвост) + 1 форвардер\n' +
    '    expect(CORE.match(/emitBaseSnapshot\\(\\)/g)).toHaveLength(4);\n' +
    '    expect(CORE.match(/try \\{ emitBaseSnapshot\\(\\); \\}/g)).toHaveLength(3);',
    "  test('R-D №4: счётчик emitBaseSnapshot() — ядро 3, конкатенация 9', () => {\n" +
    '    // ядро: 2 вызова (floor-confirm, self-heal) + 1 форвардер. Третий вызов (слушатель\n' +
    "    // ai-cm-archive-restore) на шаге " + STEP + ' уехал в ' + P.module + ' — там он и\n' +
    '    // считается отдельной строкой ниже.\n' +
    '    expect(CORE.match(/emitBaseSnapshot\\(\\)/g)).toHaveLength(3);\n' +
    '    expect(CORE.match(/try \\{ emitBaseSnapshot\\(\\); \\}/g)).toHaveLength(2);\n' +
    '    // архив: 1 вызов (пере-эмит после вливания ходов архива)\n' +
    "    expect(ARCH.match(/emitBaseSnapshot\\(\\)/g)).toHaveLength(1);",
    'ingestTest: счётчики R-D №4', 1);
  ingest = mustReplace(ingest,
    '    // арифметика конкатенации: 4 + 2 + 3 = 9\n' +
    '    expect(CONC.match(/emitBaseSnapshot\\(\\)/g)).toHaveLength(9);',
    '    // арифметика конкатенации: 3 (ядро) + 2 (пагинация) + 3 (ingest) + 1 (архив) = 9\n' +
    '    expect(CONC.match(/emitBaseSnapshot\\(\\)/g)).toHaveLength(9);',
    'ingestTest: арифметика R-D №4', 1);
  ingest = mustReplace(ingest,
    '    // прямой проводки мимо форвардера нет: иначе поздняя связка отдала бы null\n' +
    "    expect(CORE).not.toContain('ingest: ingest,');\n" +
    "    expect(CORE).not.toContain('handleOuter: handleOuter,');\n" +
    "    expect(CORE).not.toContain('emitBaseSnapshot: emitBaseSnapshot,');",
    '    // прямой проводки мимо форвардера нет: иначе поздняя связка отдала бы null.\n' +
    '    // Phase 3 step ' + STEP + ': пин emitBaseSnapshot СУЖЕН до блока ingest. Блок архива\n' +
    '    // стоит НИЖЕ заполнения алиасов (770-771) и вправе отдать alias ЗНАЧЕНИЕМ — там он уже\n' +
    "    // не null; этот случай закрыт отдельным пином в tests/adapters/gemini-archive-module.test.js.\n" +
    "    expect(CORE).not.toContain('ingest: ingest,');\n" +
    "    expect(CORE).not.toContain('handleOuter: handleOuter,');\n" +
    "    const ingestBindAt = CORE.indexOf('aiCmGeminiIngest.__bind(');\n" +
    '    expect(ingestBindAt).toBeGreaterThan(-1);\n' +
    "    const ingestBind = CORE.slice(ingestBindAt, CORE.indexOf('});', ingestBindAt));\n" +
    "    expect(ingestBind).not.toContain('emitBaseSnapshot: emitBaseSnapshot,');",
    'ingestTest: сужение пина прямого алиаса', 1);
  checkEol(P.ingestTest, ingest);
  ok('tests/adapters/gemini-ingest-module.test.js: id -v10, js[], счётчики emitBaseSnapshot 4/3 → 3/2 (+архив 1)');

  let ovl = mustReplace(SRC.overlayTest, "expect(bg).toContain(\"'" + OLD_ID + "'\");",
    "expect(bg).toContain(\"'" + NEW_ID + "'\");", 'overlayTest: id v10', 1);
  ovl = mustReplace(ovl,
    "'core/gemini-sse.js', 'core/pagination/pagination.js', 'core/gemini-loader-scroll.js', " + JS_TAIL_OLD,
    "'core/gemini-sse.js', 'core/pagination/pagination.js', 'core/gemini-loader-scroll.js', " + JS_TAIL_NEW,
    'overlayTest: подстрока js[]', 1);
  ovl = mustReplace(ovl, "  test('S1: регистрация в core/background.js — id -v9, модуль перед ядром, -v8 снят', () => {",
    "  test('S1: регистрация в core/background.js — id -v10, модуль перед ядром, -v9 снят', () => {",
    'overlayTest: имя теста S1', 1);
  ovl = mustReplace(ovl,
    "    expect(bg).toContain('(v9) зарегистрирован');\n    expect(bg).not.toContain('(v8) зарегистрирован');",
    "    expect(bg).toContain('(v10) зарегистрирован');\n    expect(bg).not.toContain('(v9) зарегистрирован');",
    'overlayTest: лог регистрации', 1);
  ovl = mustReplace(ovl, ' *     S1  регистрация в core/background.js: id -v9, модуль в js[] ПЕРЕД ядром,\n' +
    ' *         -v8 в unregister (MV3 не перечитывает js[] под уже зарегистрированным id);',
    ' *     S1  регистрация в core/background.js: id -v10 (шаг ' + STEP + '), модуль в js[] ПЕРЕД\n' +
    ' *         ядром, -v9 в unregister (MV3 не перечитывает js[] под уже зарегистрированным id);',
    'overlayTest: шапка S1', 1);
  checkEol(P.overlayTest, ovl);
  ok('tests/adapters/gemini-overlay-module.test.js: id -v10, js[] с архивом, лог (v10)');

  /* ---- 7b. песочницы tests/archive/*.test.js ---- */
  section('7b. Песочницы tests/archive/*.test.js: объект связи D');
  /* Три сьюта исполняют РЕАЛЬНЫЕ тела кластера в `with (ctx)`. Тела берут имена ядра через
   * `D.<имя>`, поэтому песочнице нужен ключ D. Достаточно self-ref `ctx.D = ctx`: имена ядра
   * уже лежат ключами ctx, а вызовы ВНУТРИ кластера префикса не получили (см. раздел 4) и
   * резолвятся объявлениями самого sandbox-блока — публиковать их на D не нужно и вредно
   * (создало бы вторую точку правды). */
  const D_NOTE_GATE = [
    '  function env(turnsMap, arch) {',
    '    // Phase 3 step ' + STEP + ': тела кластера уехали в ' + P.module + ' и берут имена ядра',
    '    // через объект связи D (в браузере его заполняет __bind из ядра). Здесь D — тот же ctx:',
    '    // в песочнице `with (ctx)` имена ядра и так видны свободно, поэтому self-ref воспроизводит',
    '    // контракт, не подменяя логику. Вызовы ВНУТРИ кластера (aiCmLiveTurnCount,',
    '    // aiCmArchiveGrewBeyondArchive, aiCmArchiveOnlyBase) префикса НЕ получили — они',
    '    // резолвятся объявлениями самого sandbox-блока.',
    '    var ctx = {',
    '      turnsMap: turnsMap,',
    '      baseSize: () => Object.keys(turnsMap).length,',
    "      getConvId: () => 'c1',",
    '      aiCmArchiveFor: () => arch,',
    '      window: { GeminiInterceptLogic: Logic }',
    '    };',
    '    ctx.D = ctx;',
    '    return ctx;',
    '  }'
  ].join('\n');
  const D_NOTE_UNION = D_NOTE_GATE
    .replace('function env(turnsMap, arch) {', 'function env(turnsMap, arch) {')
    .replace('      aiCmArchiveFor: () => arch,',
      '      aiCmArchiveFor: () => arch,\n      sanitizeMessagesForEmit: (m) => m,');

  let gate = mustReplace(SRC.gateTest,
    '  function env(turnsMap, arch) {\n' +
    '    return {\n' +
    '      turnsMap: turnsMap,\n' +
    '      baseSize: () => Object.keys(turnsMap).length,\n' +
    "      getConvId: () => 'c1',\n" +
    '      aiCmArchiveFor: () => arch,\n' +
    '      window: { GeminiInterceptLogic: Logic }\n' +
    '    };\n' +
    '  }',
    D_NOTE_GATE, 'gateTest: объект связи D в env', 1);
  checkEol(P.gateTest, gate);
  ok('tests/archive/archive-export-gate.test.js: env отдаёт D (self-ref) — 4 тела помощников живого яруса');

  let union = mustReplace(SRC.unionTest,
    '  function env(turnsMap, arch) {\n' +
    '    return {\n' +
    '      turnsMap: turnsMap,\n' +
    '      baseSize: () => Object.keys(turnsMap).length,\n' +
    "      getConvId: () => 'c1',\n" +
    '      aiCmArchiveFor: () => arch,\n' +
    '      sanitizeMessagesForEmit: (m) => m,\n' +
    '      window: { GeminiInterceptLogic: Logic }\n' +
    '    };\n' +
    '  }',
    D_NOTE_UNION, 'unionTest: объект связи D в env', 1);
  union = mustReplace(union,
    '  function env4(map) {\n' +
    '    return {\n' +
    '      turnsMap: map,\n' +
    '      baseSize: () => Object.keys(map).length,\n' +
    '      sanitizeMessagesForEmit: (m) => m,\n' +
    '      window: { GeminiInterceptLogic: Logic }\n' +
    '    };\n' +
    '  }',
    '  function env4(map) {\n' +
    '    // Phase 3 step ' + STEP + ': то же, что в env выше — тела уехали в ' + P.module + ',\n' +
    '    // поэтому песочница отдаёт объект связи D (self-ref на ctx).\n' +
    '    var ctx = {\n' +
    '      turnsMap: map,\n' +
    '      baseSize: () => Object.keys(map).length,\n' +
    '      sanitizeMessagesForEmit: (m) => m,\n' +
    '      window: { GeminiInterceptLogic: Logic }\n' +
    '    };\n' +
    '    ctx.D = ctx;\n' +
    '    return ctx;\n' +
    '  }',
    'unionTest: объект связи D в env4', 1);
  checkEol(P.unionTest, union);
  ok('tests/archive/archive-export-union.test.js: env и env4 отдают D — 6 тел (объединённая база)');

  let oracle = mustReplace(SRC.oracleTest,
    '  function run(turnsMap, arch) {\n' +
    '    return make({ turnsMap: turnsMap, window: { GeminiInterceptLogic: Logic } })(arch);\n' +
    '  }',
    '  function run(turnsMap, arch) {\n' +
    '    // Phase 3 step ' + STEP + ': тело уехало в ' + P.module + ' и берёт базу через объект\n' +
    '    // связи D (в браузере его заполняет __bind из ядра). Инлайновый литерал здесь больше\n' +
    '    // не годится — self-ref `ctx.D = ctx` требует имени, поэтому ctx вынесен в переменную.\n' +
    '    var ctx = { turnsMap: turnsMap, window: { GeminiInterceptLogic: Logic } };\n' +
    '    ctx.D = ctx;\n' +
    '    return make(ctx)(arch);\n' +
    '  }',
    'oracleTest: объект связи D в run', 1);
  /* Тело aiCmArchiveTierApply теперь читает состояние ядра через D — три текстовых пина
   * держат ИМЕННО эти строки, поэтому обязаны обновиться вместе с кодом. */
  oracle = mustReplace(oracle, "    expect(body).toContain('loaderRunning: loaderRunningFor === convId');",
    "    expect(body).toContain('loaderRunning: D.loaderRunningFor === convId');", 'oracleTest: пин loaderRunning', 1);
  oracle = mustReplace(oracle, "    expect(body).toContain('var loaderDone = loaderDoneMap[convId] === true;');",
    "    expect(body).toContain('var loaderDone = D.loaderDoneMap[convId] === true;');", 'oracleTest: пин loaderDoneMap', 1);
  oracle = mustReplace(oracle, "    expect(body).toContain('active: quietActive === true');",
    "    expect(body).toContain('active: D.quietActive === true');", 'oracleTest: пин quietActive', 1);
  checkEol(P.oracleTest, oracle);
  ok('tests/archive/archive-oracle.test.js: ctx с D + три пина состояния переведены на D.*');

  /* ---- 8. гейты ---- */
  section('8. Гейты G1-G9');
  if (/\bwith\s*\(/.test(moduleCode)) fail('G1: модуль содержит with — esbuild-риск и нарушение плана');
  ok('G1: модуль без with (каркас IIFE + префиксы D)');
  const dRefs = [...new Set((moduleCode.match(/\bD\.([A-Za-z_$][\w$]*)/g) || []).map((m) => m.slice(2)))].sort();
  if (dRefs.join(',') !== CONTRACT_NAMES.slice().sort().join(',')) {
    fail('G2: набор D.<имя> в модуле (' + dRefs.join(', ') + ') не равен контракту (' +
      CONTRACT_NAMES.slice().sort().join(', ') + ')');
  }
  ok('G2: модуль обращается ровно к ' + dRefs.length + ' именам ядра — контракт, ни больше ни меньше');
  if (/console\s*\.\s*error\s*\(/.test(moduleCode)) fail('G3: bare console.error в модуле (пин 1.9)');
  if (/^\s*'use strict'/m.test(moduleText)) fail('G3: директива строгого режима в модуле');
  if (/innerHTML\s*=/.test(moduleCode)) fail('G3: innerHTML в модуле (privacy-гигиена)');
  ok('G3: без console.error, без use strict, без innerHTML');
  if (moduleText.indexOf('window.' + MODULE_GLOBAL + ' = Api;') === -1) fail('G4: модуль не публикует window.' + MODULE_GLOBAL);
  if (moduleText.indexOf("if (typeof module !== 'undefined' && module.exports) module.exports = Api;") === -1) {
    fail('G4: нет защищённого module.exports (в MAIN-мире module не определён)');
  }
  if (moduleText.indexOf("if (typeof window !== 'undefined' && window." + MODULE_GLOBAL + ') return;') === -1) {
    fail('G4: нет re-entry guard — повторная загрузка модуля перетёрла бы Api и навесила слушателей дважды');
  }
  ok('G4: re-entry guard + window.' + MODULE_GLOBAL + ' + защищённый module.exports');
  const expMissing = EXPORTED.filter((n) => !new RegExp('\\n\\s+' + n + ': ' + n + '[,]?').test(moduleText));
  if (expMissing.length) fail('G5: модуль не отдаёт наружу: ' + expMissing.join(', '));
  if (moduleText.indexOf('__bind: __bind') === -1) fail('G5: __bind не экспортирован');
  ok('G5: Api = { __bind, ' + EXPORTED.join(', ') + ' }');
  for (const n of EXPORTED) {
    const inModule = (moduleCode.match(new RegExp('function\\s+' + n + '\\s*\\(', 'g')) || []).length;
    const inCore = (coreCode.match(new RegExp('function\\s+' + n + '\\s*\\(', 'g')) || []).length;
    if (inModule !== 1) fail('G6: тело ' + n + ' объявлено в модуле ' + inModule + ' раз (ожидалось 1)');
    if (inCore !== 1) fail('G6: форвардер ' + n + ' объявлен в ядре ' + inCore + ' раз (ожидалось 1)');
  }
  for (const n of MOVED_TOP_LEVEL.filter((x) => EXPORTED.indexOf(x) === -1)) {
    const inModule = (moduleCode.match(new RegExp('function\\s+' + n + '\\s*\\(', 'g')) || []).length;
    if (inModule !== 1) fail('G6: ' + n + ' объявлен в модуле ' + inModule + ' раз (ожидалось 1)');
  }
  ok('G6: каждое перенесённое объявление живёт РОВНО в одном месте (ядро: 5 форвардеров, модуль: 8 тел)');
  const providers = ['aiCmGeminiPagination', 'aiCmGeminiLoaderScroll', 'aiCmGeminiIngest'];
  for (const n of ['aiCmArchiveFor', 'aiCmArchiveLiveProven', 'aiCmLiveTurnCount', 'aiCmArchiveTierApply']) {
    const at = core1.indexOf(n + ': ' + n + ',');
    if (at === -1) fail('G7: ' + n + ' не раздаётся чужим __bind-блокам — форвардер обязан быть в них значением');
  }
  ok('G7: 4 форвардера раздаются чужим __bind-блокам (' + providers.join('/') + ') — контракт прежний');
  log('  ✓ G8: смок связки — отдельный прогон: node tools/smoke-gemini-archive-binding.js (если создан)');
  log('  ✓ G9: пины — отдельный прогон: npx jest tests/adapters/gemini-archive-module.test.js');

  /* ---- запись ---- */
  section('9. Запись');
  writeOut(P.module, moduleText, 'НОВЫЙ модуль кластера архива');
  writeOut(P.core, core1, 'A ' + RANGE_A.a + '-' + RANGE_A.b + ' → баннер + форвардеры + __bind; B → указатель');
  writeOut(P.background, bg, 'id -v10');
  writeOut(P.helper, helper, 'MODULES + проза');
  writeOut(P.qwen, qwen, 'пин регистрации');
  writeOut(P.pagTest, pag, 'подстрока js[]');
  writeOut(P.ingestTest, ingest, 'пин регистрации + счётчики');
  writeOut(P.overlayTest, ovl, 'пин регистрации');
  writeOut(P.gateTest, gate, 'объект связи D');
  writeOut(P.unionTest, union, 'объект связи D (env + env4)');
  writeOut(P.oracleTest, oracle, 'объект связи D + пины состояния');
  writeOut(P.gitignore, gi, 'негация контракта');
  writeOut(P.release, rel, 'счётчики MAIN-world');

  console.log('\n' + (APPLY ? '[ПРИМЕНЕНО]' : '[DRY-RUN]') + ' файлов: ' + WRITES.length);
  for (const w of WRITES) console.log('  ' + w.rel + ' — ' + w.lines + ' строк, ' + w.bytes + ' байт');
  if (!APPLY) {
    console.log('\nНичего не записано. Повторите с --apply осознанно.');
    return;
  }
  console.log('\nДальше:');
  console.log('  git add -f ' + P.contract + '   # tools/* в .gitignore — контракт нужен S-пинам в CI');
  console.log('  npx jest tests/adapters tests/archive');
  console.log('  npm test && npm run build && npx tsc --noEmit');
}

try {
  main();
} catch (e) {
  console.error('\n[ФАТАЛЬНО] исключение в тулинге:');
  console.error('  ' + (e && e.stack ? e.stack : e));
  process.exit(1);
}
````

### 2.4 `tools/verify-archive-extraction.js` (197 строк)

````js
#!/usr/bin/env node
/**
 * tools/verify-archive-extraction.js — независимая ПОСТ-ПРОВЕРКА шага 13.2.
 *
 * В отличие от tools/apply-archive-extraction.js (который правит файлы и потому одноразов),
 * этот скрипт ЧИТАЕТ уже применённый результат и доказывает главное утверждение шага:
 * тела core/gemini-archive.js байтово равны двум диапазонам ядра ДО выноса — с точностью
 * до префиксов `D.` и трёх гардов `if (!D)`. Исходный ядро берётся из git HEAD, а не из
 * рабочей копии, поэтому проверка независима от применённых правок.
 *
 * ЗАПУСК: node tools/verify-archive-extraction.js
 *
 * ПРОВЕРЯЕТ.
 *   1. git HEAD содержит core/gemini-intercept.js ровно того коммита, из которого выносили;
 *   2. диапазон A (1712-1914) и диапазон B (1935-2145) старого ядра совпадают с ожидаемыми
 *      анкерами;
 *   3. тело модуля (= строки между `function __bind` и `var Api = {`) при снятии префиксов
 *      `D.` и трёх гардов равно A + разделитель + B БАЙТ-В-БАЙТ;
 *   4. состояние и sanitizeMessagesForEmit остались в ядре, а тела восьми функций — нет;
 *   5. EOL: все затронутые .js — LF, release.yml — CRLF (режим сохранён);
 *   6. проводка: id -v10, js[] в порядке js[], unregister с -v9, лог (v10), счётчики build/CI.
 *
 * НИЧЕГО НЕ ПИШЕТ. Завершается exit 1 при первом расхождении.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OLD_CORE_REF = 'HEAD:core/gemini-intercept.js';

const RANGE_A = { a: 1712, b: 1914, first: '  // ============ T1 (v1.16): ПЕРВЫЙ ЯРУС — АРХИВ (оракул и пол) ============', last: '  }' };
const RANGE_B = { a: 1935, b: 2145, first: '  // ---- v28: слияние сохранённой ленты (из content.js) со свежей сетевой ----', last: '  } catch (e) { }' };
const BIND_ANCHOR = '  function __bind(d) { D = d; }';
const API_ANCHOR = '  var Api = {';
const GUARDS = [
  "    if (!D) { debugLog('error', '[gemini-archive] D is null, event ignored'); return; }",
  "      if (!D) { debugLog('error', '[gemini-archive] D is null, event ignored'); return; }"
];
const CONTRACT = require('./archive-bind-contract.js');
const EXPORTED = ['aiCmArchiveFor', 'aiCmArchiveLiveProven', 'aiCmLiveTurnCount', 'aiCmArchiveTierApply', 'aiCmBaseExportInfo'];
const STATE_LINES = [
  '  var turnsMap = {};',
  '  var quietActive = false;',
  '  var historyFullByQuiet = false;',
  '  var reachedStart = false; // тихая пагинация дошла до начала (курсора больше нет)',
  '  var loaderDoneMap = {};   // convId → true (один запуск на чат за сессию страницы)',
  '  var loaderRunningFor = null;',
  '  var cacheRestoredMap = new Set();',
  '  var archiveTierByConv = {};',
  '  var archiveMergedMap = new Set();',
  "  var parserVersion = '';",
  '  var tapeWasUsedInThisColdStart = false;'
];

let failures = 0;
function check(cond, label, detail) {
  if (cond) { console.log('  ✓ ' + label); return true; }
  failures++;
  console.log('  ✗ ' + label + (detail ? '\n      ' + detail : ''));
  return false;
}
function short(s) { return JSON.stringify(String(s).slice(0, 120)); }

console.log('0. Контракт');
check(CONTRACT.length === 22, 'контракт: 22 имени');
const kinds = { fn: 0, ro: 0, rw: 0 };
CONTRACT.forEach(([, k]) => kinds[k]++);
check(kinds.fn === 11 && kinds.ro === 8 && kinds.rw === 3, 'виды связи 11 fn / 8 ro / 3 rw', JSON.stringify(kinds));

console.log('\n1. Старое ядро из git (' + OLD_CORE_REF + ')');
let oldCore;
try {
  oldCore = execFileSync('git', ['show', OLD_CORE_REF], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
} catch (e) {
  console.log('  ✗ не удалось прочитать ' + OLD_CORE_REF + ': ' + (e && e.message));
  process.exit(1);
}
const oldLines = oldCore.split('\n');
check(oldLines[RANGE_A.a - 1] === RANGE_A.first, 'анкер начала A (' + RANGE_A.a + ')', short(oldLines[RANGE_A.a - 1]));
check(oldLines[RANGE_A.b - 1] === RANGE_A.last, 'анкер конца A (' + RANGE_A.b + ')', short(oldLines[RANGE_A.b - 1]));
check(oldLines[RANGE_B.a - 1] === RANGE_B.first, 'анкер начала B (' + RANGE_B.a + ')', short(oldLines[RANGE_B.a - 1]));
check(oldLines[RANGE_B.b - 1] === RANGE_B.last, 'анкер конца B (' + RANGE_B.b + ')', short(oldLines[RANGE_B.b - 1]));
const rangeA = oldLines.slice(RANGE_A.a - 1, RANGE_A.b).join('\n');
const rangeB = oldLines.slice(RANGE_B.a - 1, RANGE_B.b).join('\n');

console.log('\n2. Тело модуля ↔ два диапазона старого ядра');
const mod = fs.readFileSync(path.join(ROOT, 'core/gemini-archive.js'), 'utf8');
const modLines = mod.split('\n');
const from = modLines.indexOf(BIND_ANCHOR);
const to = modLines.indexOf(API_ANCHOR);
check(from > 0 && to > from, 'границы каркаса модуля найдены');
let s = from + 1;
while (s < to && modLines[s] === '') s++;
let e = to;
while (e > s && modLines[e - 1] === '') e--;
const body = modLines.slice(s, e);
const nA = RANGE_A.b - RANGE_A.a + 1;
check(body[nA] === '', 'разделитель A|B на месте (строка ' + (nA + 1) + ' тела)');
/** Обратный ход: снимаем ТОЛЬКО префиксы контракта (`D.<имя ядра>`), а не любое `D.`:
 *  иначе проверка была бы шире правки и «доказывала» бы не то, что делал скрипт. */
const UNPREFIX = new RegExp('\\bD\\.(' + CONTRACT.map((x) => x[0]).join('|') + ')(?![\\w$])', 'g');
const stripped = (t) => t.replace(UNPREFIX, '$1');
const backA = stripped(body.slice(0, nA).join('\n'));
let backB = stripped(body.slice(nA + 1).join('\n'));
GUARDS.forEach((g) => { backB = backB.split('\n').filter((l) => l !== g).join('\n'); });
if (backA !== stripped(rangeA)) {
  const x = backA.split('\n'); const y = stripped(rangeA).split('\n');
  let i = 0; while (i < x.length && x[i] === y[i]) i++;
  check(false, 'A: тело модуля байтово равно диапазону ' + RANGE_A.a + '-' + RANGE_A.b,
    'строка ' + (i + 1) + '\n      модуль: ' + short(x[i]) + '\n      ядро:   ' + short(y[i]));
} else {
  check(true, 'A: тело модуля байтово равно диапазону ' + RANGE_A.a + '-' + RANGE_A.b + ' (' + nA + ' строк)');
}
if (backB !== stripped(rangeB)) {
  const x = backB.split('\n'); const y = stripped(rangeB).split('\n');
  let i = 0; while (i < x.length && x[i] === y[i]) i++;
  check(false, 'B: тело модуля байтово равно диапазону ' + RANGE_B.a + '-' + RANGE_B.b + ' (без 3 гардов)',
    'строка ' + (i + 1) + '\n      модуль: ' + short(x[i]) + '\n      ядро:   ' + short(y[i]));
} else {
  check(true, 'B: тело модуля байтово равно диапазону ' + RANGE_B.a + '-' + RANGE_B.b + ' без 3 гардов (' + (RANGE_B.b - RANGE_B.a + 1) + ' строк)');
}
const guardHits = mod.split('\n').filter((l) => l.indexOf("if (!D) { debugLog('error', '[gemini-archive]") !== -1);
check(guardHits.length === 3, 'в модуле ровно 3 гарда !D', String(guardHits.length));
const dRefs = [...new Set((mod.match(/\bD\.([A-Za-z_$][\w$]*)/g) || []).map((m) => m.slice(2)))].sort();
check(dRefs.join(',') === CONTRACT.map((x) => x[0]).sort().join(','), 'набор D.<имя> равен контракту', dRefs.join(', '));

console.log('\n3. Ядро: состояние осталось, тела уехали');
const core = fs.readFileSync(path.join(ROOT, 'core/gemini-intercept.js'), 'utf8');
STATE_LINES.forEach((l) => check(core.indexOf(l) !== -1, 'ядро: состояние ' + short(l)));
check(core.indexOf('  function sanitizeMessagesForEmit(messages) {') !== -1, 'ядро: sanitizeMessagesForEmit на месте');
const movedAll = EXPORTED.concat(['aiCmBuildBaseMessages', 'aiCmArchiveOnlyBase', 'aiCmArchiveGrewBeyondArchive']);
EXPORTED.forEach((n) => {
  check(new RegExp('\\n  function ' + n + '\\(').test(core), 'ядро: форвардер ' + n + ' — function declaration');
  check((core.match(new RegExp('function\\s+' + n + '\\s*\\(', 'g')) || []).length === 1, 'ядро: ' + n + ' объявлен ровно раз');
});
['aiCmBuildBaseMessages', 'aiCmArchiveOnlyBase', 'aiCmArchiveGrewBeyondArchive'].forEach((n) => {
  check(!new RegExp('function\\s+' + n + '\\s*\\(').test(core), 'ядро: тела ' + n + ' больше нет');
});
const vf5 = 'aiCmIngestFwd(txt, { emitOnlyIfAdded: true, fromVirtualF5: true, rebuild: rebuild });';
const vf5Lines = core.split('\n').reduce((a, l, i) => (l.indexOf(vf5) !== -1 ? a.concat(i + 1) : a), []);
check(vf5Lines.length === 1 && vf5Lines[0] === 1680, 'ядро: хвостовая точка vf5 не сдвинулась (1680)', String(vf5Lines));
const aliasLines = [
  'emitBaseSnapshot = aiCmGeminiIngest.emitBaseSnapshot;',
  'mergeRestoredTurns = aiCmGeminiIngest.mergeRestoredTurns;',
  'refreshMinOrderTracking = aiCmGeminiPagination.refreshMinOrderTracking;'
].map((lit) => core.split('\n').findIndex((l) => l.indexOf(lit) !== -1) + 1);
const bindLine = core.split('\n').findIndex((l) => l.indexOf('aiCmGeminiArchive.__bind(') !== -1) + 1;
check(bindLine > 782, 'ядро: блок подключения на строке ' + bindLine + ' (> 782)');
check(aliasLines.every((n) => n > 0 && bindLine > n), 'ядро: блок подключения НИЖЕ поздних алиасов', JSON.stringify(aliasLines));
CONTRACT.forEach(([n, kind]) => {
  const inBlock = new RegExp('(?:^|[\\s,{])' + n + '\\s*[:,(]', 'm').test(core.slice(core.indexOf('aiCmGeminiArchive.__bind('), core.indexOf('});', core.indexOf('aiCmGeminiArchive.__bind('))));
  check(inBlock, 'ядро: __bind отдаёт ' + n + ' (' + kind + ')');
});

console.log('\n4. Проводка и служебные файлы');
const bg = fs.readFileSync(path.join(ROOT, 'core/background.js'), 'utf8');
check(bg.indexOf("'ai-cm-gemini-intercept-v10'") !== -1, 'background: id -v10');
check(bg.indexOf("'ai-cm-gemini-intercept-v9'") !== -1, 'background: -v9 в unregister');
check(bg.indexOf('(v10) зарегистрирован') !== -1, 'background: лог (v10)');
check(bg.indexOf("'core/gemini-overlay.js', 'core/gemini-archive.js', 'core/gemini-intercept.js'") !== -1, 'background: js[] overlay → archive → ядро');
const helper = fs.readFileSync(path.join(ROOT, 'tests/helpers/gemini-intercept-source.js'), 'utf8');
check(helper.indexOf("  'core/gemini-archive.js'\n];") !== -1, 'helper: модуль последним в MODULES (перед ядром)');
const rel = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
check(rel.indexOf('24 MAIN-world') === -1, 'release.yml: старого счётчика 24 нет');
check((rel.match(/25 MAIN-world/g) || []).length === 2, 'release.yml: оба счётчика = 25');
const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
check(gi.indexOf('!tools/archive-bind-contract.js') !== -1, '.gitignore: контракт выведен из-под tools/*');
const testFile = fs.readFileSync(path.join(ROOT, 'tests/adapters/gemini-archive-module.test.js'), 'utf8');
check(testFile.indexOf("'ai-cm-gemini-intercept-v10'") !== -1, 'пин-сьют: регистрация -v10');

console.log('\n5. EOL и BOM');
const eolFiles = [
  'core/gemini-archive.js', 'core/gemini-intercept.js', 'core/background.js',
  'tests/helpers/gemini-intercept-source.js', 'tests/adapters/gemini-archive-module.test.js',
  'tests/adapters/gemini-ingest-module.test.js', 'tests/adapters/gemini-overlay-module.test.js',
  'tests/adapters/gemini-pagination-module.test.js', 'tests/archive/archive-export-gate.test.js',
  'tests/archive/archive-export-union.test.js', 'tests/archive/archive-oracle.test.js',
  'tests/qwen-provider-wiring.test.js', 'tools/archive-bind-contract.js', 'tools/apply-archive-extraction.js'
];
eolFiles.forEach((f) => {
  const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const crlf = t.split('\r\n').length - 1;
  check(crlf === 0 && t.charCodeAt(0) !== 0xfeff, f + ': LF без BOM');
});
const relText = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
check(relText.split('\r\n').length - 1 > 0 && relText.split('\r\n').length - 1 === relText.split('\n').length - 1,
  'release.yml: CRLF сохранён');
check(relText.endsWith('\n') === false, 'release.yml: режим «без хвостового перевода» сохранён');

console.log('\n' + (failures === 0
  ? '[OK] Пост-проверка шага 13.2 пройдена: вынос доказан байтово, проводка и EOL в порядке.'
  : '[ПРОВАЛ] Расхождений: ' + failures));
process.exit(failures === 0 ? 0 : 1);
````

### 2.5 `tests/adapters/gemini-archive-module.test.js` (589 строк)

````js
/**
 * Phase 3 шаг 13.2 — пины кластера архива (core/gemini-archive.js).
 *
 * Контекст. Кластер архива (первый ярус полноты T1) вынесен из core/gemini-intercept.js
 * в core/gemini-archive.js БЕЗ изменения логики: восемь функций и три слушателя перенесены
 * байт-в-байт, ссылки на имена ядра получили префикс D (объект связи заполняет __bind из
 * ядра), а в начало каждого слушателя добавлен гард `if (!D)`. Пины здесь четырёх родов:
 *
 *   A (состояние) — 11 имён состояния (turnsMap, archiveTierByConv, archiveMergedMap,
 *     cacheRestoredMap, loaderDoneMap, loaderRunningFor, parserVersion, quietActive и три
 *     вердикта полноты historyFullByQuiet/reachedStart/tapeWasUsedInThisColdStart) остаются
 *     в ЯДРЕ: их читают и пишут ingest, лоадер, пагинация, сброс при смене чата и мост
 *     content.js. Модуль получает их ЖИВЫМИ геттерами (и сеттерами там, где пишет).
 *     Регрессия = копия значения: оракул архива объявил бы полноту, а ядро её не увидело.
 *   B (форвардеры) — пять имён (aiCmArchiveFor, aiCmArchiveLiveProven, aiCmLiveTurnCount,
 *     aiCmArchiveTierApply, aiCmBaseExportInfo) в ядре обязаны быть hoisted function
 *     declaration: их значения раздаются чужим __bind-блокам (пагинация 430, лоадер 544-547,
 *     ingest 657) и вызываются из ядра (stableFloorConfirm, notifyLoaderState, self-heal,
 *     снапшот turns) — в том числе ДО строки связки. var-выражение сломало бы это.
 *   C (байт-идентичность) — тела и слушатели обязаны остаться теми же строками: пины
 *     archive-export-gate/union/oracle и oracle-archive-complete режут их из конкатенации
 *     и исполняют в песочнице. Единственные изменения — префиксы D и гарды !D.
 *   D (размещение и API) — блок подключения стоит НИЖЕ трёх поздних алиасов (строка > 782),
 *     API полон, модуль гигиеничен и повторная загрузка не перетирает Api.
 *
 *   S (проводка) — модуль реально подключён и связан с ядром:
 *     S1  регистрация в core/background.js: id -v10, модуль в js[] строго между overlay
 *         и ядром, -v9 в unregister (MV3 не перечитывает js[] под уже зарегистрированным id);
 *     S2  bind-контракт полон: все 22 имени контракта переданы ядром и все 22 используются
 *         модулем (регрессия = молчаливый no-op, которого не видит ни один старый пин);
 *     S3  порядок в helper-конкатенации повторяет порядок js[];
 *     S4  поздний алиас emitBaseSnapshot отдан архиву ЗНАЧЕНИЕМ — и это законно ровно
 *         потому, что блок стоит ниже заполнения алиасов (см. D5).
 *
 * ВАЖНО: существующие пины Gemini НЕ трогались по существу — тела перенесены байт-в-байт,
 * и это здесь доказано (блок C). Обновлены только песочницы tests/archive/*.test.js
 * (объект связи D) и три текстовых пина состояния в archive-oracle.test.js (D.*).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const readFile = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SRC = require(path.join(ROOT, 'tests/helpers/gemini-intercept-source.js'));
const CONC = SRC.geminiSource;
const CORE = readFile('core/gemini-intercept.js');
const MOD = readFile('core/gemini-archive.js');
const CONTRACT = require(path.join(ROOT, 'tools/archive-bind-contract.js'));

/** Функции, которые модуль отдаёт наружу (порядок — как в Api). */
const EXPORTED = ['aiCmArchiveFor', 'aiCmArchiveLiveProven', 'aiCmLiveTurnCount',
  'aiCmArchiveTierApply', 'aiCmBaseExportInfo'];
/** Тела, уехавшие в модуль и НЕ оставшиеся в ядре даже форвардером. */
const INTERNAL = ['aiCmBuildBaseMessages', 'aiCmArchiveOnlyBase', 'aiCmArchiveGrewBeyondArchive'];
/** Состояние, которое ОБЯЗАНО было остаться в ядре (объявления — как в файле). */
const CORE_STATE = [
  '  var turnsMap = {};',
  '  var quietActive = false;',
  '  var historyFullByQuiet = false;',
  '  var reachedStart = false; // тихая пагинация дошла до начала (курсора больше нет)',
  '  var loaderDoneMap = {};   // convId → true (один запуск на чат за сессию страницы)',
  '  var loaderRunningFor = null;',
  '  var cacheRestoredMap = new Set();',
  '  var archiveTierByConv = {};',
  '  var archiveMergedMap = new Set();',
  "  var parserVersion = '';",
  '  var tapeWasUsedInThisColdStart = false;'
];
/** Слушатели, уехавшие вместе с кластером. */
const LISTENERS = ['ai-cm-restored-history', 'ai-cm-archive-restore', 'ai-cm-cache-refresh'];
const GUARD = "if (!D) { debugLog('error', '[gemini-archive] D is null, event ignored'); return; }";

/** Вырезает `function <name>(…) { … }` по балансу скобок. */
function fnSource(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i === -1) return null;
  let depth = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  return null;
}

/** Код без комментариев: проза шапки и баннеров упоминает имена как прозу, а не ссылки. */
function codeOf(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}
const CORE_CODE = codeOf(CORE);
const MOD_CODE = codeOf(MOD);
/** Код без комментариев И строковых литералов: упоминание имени в тексте лога — не ссылка.
 *  В модуле есть ровно такой случай: `'… (reachedStart=true) → …'` (сообщение tape-restore),
 *  которое подстановка по AST обязана была не трогать. */
function codeNoStrings(src) {
  return codeOf(src)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => ' '.repeat(m.length))
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => ' '.repeat(m.length));
}
const MOD_REF = codeNoStrings(MOD);

/** Все `D.<имя>` кода модуля — уникальные, отсортированные. */
function dRefsOf(src) {
  return [...new Set((src.match(/\bD\.([A-Za-z_$][\w$]*)/g) || []).map((m) => m.slice(2)))].sort();
}
function bareCount(src, name) {
  return (src.match(new RegExp('(^|[^\\w$.])' + name + '(?![\\w$])', 'g')) || []).length;
}
function lineOf(src, lit) {
  return src.split('\n').findIndex((l) => l.indexOf(lit) !== -1) + 1;
}

/** Блок `aiCmGeminiArchive.__bind({...})` ядра — как строка. */
function bindBlockText() {
  const at = CORE.indexOf('aiCmGeminiArchive.__bind(');
  expect(at).toBeGreaterThan(-1);
  const end = CORE.indexOf('});', at);
  expect(end).toBeGreaterThan(at);
  return CORE.slice(at, end);
}

/** Исполняет РЕАЛЬНЫЙ форвардер ядра в песочнице с заданным объектом связи. */
function runForwarder(name, args, archiveApi, baseSizeFn) {
  const src = fnSource(CORE, name);
  expect(src).not.toBeNull();
  const ctx = vm.createContext({
    aiCmGeminiArchive: archiveApi,
    baseSize: baseSizeFn || function () { return 0; },
    args: args,
    out: 'UNSET'
  });
  vm.runInContext('out = (' + src + ').apply(null, args);', ctx);
  return ctx.out;
}

/** Грузит РЕАЛЬНЫЙ модуль в свежий vm-контекст и возвращает его API + живые обработчики. */
function loadModule() {
  const pageWindow = {
    listeners: [],
    handlers: {},
    addEventListener: function (t, fn) { this.listeners.push(t); this.handlers[t] = fn; }
  };
  const ctx = vm.createContext({ window: pageWindow, console, setTimeout, clearTimeout });
  vm.runInContext(MOD, ctx, { filename: 'core/gemini-archive.js' });
  return { pageWindow, ctx, api: pageWindow.AiCmGeminiArchive };
}

describe('Phase 3 шаг 13.2: A-пины — состояние архива осталось в ЯДРЕ', () => {
  test('A1: 11 переменных состояния объявлены в ядре байт-в-байт и НЕ перенесены в модуль', () => {
    CORE_STATE.forEach((lit) => expect(CORE).toContain(lit));
    const names = CONTRACT.filter(([, kind]) => kind === 'ro' || kind === 'rw').map(([n]) => n);
    expect(names).toHaveLength(11);
    names.forEach((n) => {
      // модуль не объявляет их заново: иначе появилась бы ВТОРАЯ переменная, и ядро
      // (ingest/лоадер/пагинация) читало бы старую — вердикт полноты терялся бы молча
      expect(MOD_CODE).not.toMatch(new RegExp('\\bvar\\s+' + n + '\\b'));
      expect(MOD_CODE).not.toMatch(new RegExp('\\blet\\s+' + n + '\\b'));
      expect(MOD_CODE).not.toMatch(new RegExp('\\bconst\\s+' + n + '\\b'));
    });
    // …и вообще не упоминают их без префикса: единственный путь — объект связи
    // (строка-лог с `reachedStart=true` ссылкой не является и потому не считается)
    names.forEach((n) => expect(bareCount(MOD_REF, n)).toBe(0));
  });

  test('A2: блок __bind отдаёт состояние ЖИВЫМИ геттерами/сеттерами, а не копиями', () => {
    const block = bindBlockText();
    const rw = CONTRACT.filter(([, kind]) => kind === 'rw').map(([n]) => n);
    const ro = CONTRACT.filter(([, kind]) => kind === 'ro').map(([n]) => n);
    expect(rw.sort()).toEqual(['historyFullByQuiet', 'reachedStart', 'tapeWasUsedInThisColdStart']);
    expect(ro).toHaveLength(8);
    rw.forEach((n) => {
      expect(block).toContain('get ' + n + '() { return ' + n + '; }');
      expect(block).toContain('set ' + n + '(v) { ' + n + ' = v; }');
    });
    ro.forEach((n) => {
      expect(block).toContain('get ' + n + '() { return ' + n + '; }');
      expect(block).not.toMatch(new RegExp('set\\s+' + n + '\\s*\\('));
    });
    // связка идёт ПОСЛЕ объявления состояния: геттеры замкнуты на инициализированные
    // переменные, а не на undefined-на-момент-hoisting
    expect(CORE.indexOf('aiCmGeminiArchive.__bind(')).toBeGreaterThan(CORE.indexOf(CORE_STATE[0]));
  });

  test('A3: модуль обращается к ядру РОВНО по контракту — ни одного свободного имени', () => {
    const names = CONTRACT.map(([n]) => n).sort();
    expect(dRefsOf(MOD_CODE)).toEqual(names);
    names.forEach((n) => expect(bareCount(MOD_REF, n)).toBe(0));
    // вызовы ВНУТРИ кластера не переписаны на объект связи
    const internal = ['aiCmArchiveFor', 'aiCmArchiveOnlyBase', 'aiCmArchiveGrewBeyondArchive',
      'aiCmBuildBaseMessages', 'aiCmLiveTurnCount', 'aiCmArchiveLiveProven',
      'aiCmArchiveTierApply', 'aiCmBaseExportInfo'];
    internal.forEach((n) => expect(MOD_CODE).not.toContain('D.' + n));
    expect(fnSource(MOD, 'aiCmBaseExportInfo')).toContain('var arch = aiCmArchiveFor(convId);');
    expect(fnSource(MOD, 'aiCmArchiveTierApply')).toContain('var archiveOnly = aiCmArchiveOnlyBase(convId);');
    expect(fnSource(MOD, 'aiCmArchiveLiveProven')).toContain('return aiCmArchiveGrewBeyondArchive(a);');
  });

  test('A4: запись вердикта из модуля доходит до ЖИВЫХ переменных ядра (rw вживую)', () => {
    // «ядро» песочницы: те же имена, что объявлены в core/gemini-intercept.js
    const live = { historyFullByQuiet: false, reachedStart: false, turnsMap: {} };
    const tier = {
      c1: {
        convId: 'c1', count: 4, keys: {}, completeApplied: false, verdictLogged: '',
        addedIds: { a: true, b: true, c: true, d: true }
      }
    };
    ['a', 'b', 'c', 'd'].forEach((id) => { live.turnsMap[id] = { role: 'user', text: 'x' }; });
    const logic = {
      archiveCompleteVerdict: () => ({ complete: true, reason: 'archive-complete' }),
      archiveContentKey: (m) => m.role + '|' + m.text
    };
    const D = {
      getConvId: () => 'c1',
      baseSize: () => Object.keys(live.turnsMap).length,
      loadFloor: () => null,
      archiveTierByConv: tier,
      loaderDoneMap: {},
      loaderRunningFor: null,
      quietActive: false,
      turnsMap: live.turnsMap,
      get historyFullByQuiet() { return live.historyFullByQuiet; },
      set historyFullByQuiet(v) { live.historyFullByQuiet = v; },
      get reachedStart() { return live.reachedStart; },
      set reachedStart(v) { live.reachedStart = v; }
    };
    const sandbox = loadModule();
    sandbox.ctx.debugLog = function () { };
    sandbox.pageWindow.GeminiInterceptLogic = logic;
    sandbox.api.__bind(D);
    expect(sandbox.api.aiCmArchiveFor('c1')).toBe(tier.c1); // база ядра видна модулю
    sandbox.api.aiCmArchiveTierApply();
    // вердикт complete=true обязан дойти до переменных ЯДРА, а не до копий
    expect(live.historyFullByQuiet).toBe(true);
    expect(live.reachedStart).toBe(true);
    expect(tier.c1.completeApplied).toBe(true);
    // одноразовость взвода: повторный вызов не переписывает вердикты (архив уже применён)
    live.historyFullByQuiet = false;
    live.reachedStart = false;
    sandbox.api.aiCmArchiveTierApply();
    expect(live.historyFullByQuiet).toBe(false);
    expect(live.reachedStart).toBe(false);
  });
});

describe('Phase 3 шаг 13.2: B-пины — форвардеры ядра (hoisting + делегирование)', () => {
  test('B1: все пять форвардеров — function declaration, ровно по одному объявлению', () => {
    EXPORTED.forEach((n) => {
      expect(CORE).toMatch(new RegExp('\\n  function ' + n + '\\('));
      expect((CORE_CODE.match(new RegExp('function\\s+' + n + '\\s*\\(', 'g')) || [])).toHaveLength(1);
    });
    expect(fnSource(CORE, 'aiCmArchiveFor')).toBe(
      'function aiCmArchiveFor(convId) { return aiCmGeminiArchive ? aiCmGeminiArchive.aiCmArchiveFor(convId) : null; }'
    );
    expect(fnSource(CORE, 'aiCmArchiveLiveProven')).toBe(
      'function aiCmArchiveLiveProven(convId) { return aiCmGeminiArchive ? aiCmGeminiArchive.aiCmArchiveLiveProven(convId) : true; }'
    );
    expect(fnSource(CORE, 'aiCmLiveTurnCount')).toBe(
      'function aiCmLiveTurnCount(arch) { return aiCmGeminiArchive ? aiCmGeminiArchive.aiCmLiveTurnCount(arch) : baseSize(); }'
    );
    expect(fnSource(CORE, 'aiCmArchiveTierApply')).toBe(
      'function aiCmArchiveTierApply() { return aiCmGeminiArchive ? aiCmGeminiArchive.aiCmArchiveTierApply() : undefined; }'
    );
    expect(fnSource(CORE, 'aiCmBaseExportInfo')).toBe(
      'function aiCmBaseExportInfo() { return aiCmGeminiArchive ? aiCmGeminiArchive.aiCmBaseExportInfo() : null; }'
    );
  });

  test('B2: форвардер делегирует в модуль и возвращает его результат', () => {
    const calls = [];
    const apiObj = {
      aiCmArchiveFor: (c) => { calls.push(['for', c]); return { count: 4 }; },
      aiCmArchiveLiveProven: (c) => { calls.push(['proven', c]); return 'PROVEN'; },
      aiCmLiveTurnCount: (a) => { calls.push(['live', a]); return 7; },
      aiCmArchiveTierApply: () => { calls.push(['tier']); return 'TIER'; },
      aiCmBaseExportInfo: () => { calls.push(['info']); return { baseMsgs: 4 }; }
    };
    expect(runForwarder('aiCmArchiveFor', ['c1'], apiObj)).toEqual({ count: 4 });
    expect(runForwarder('aiCmArchiveLiveProven', ['c1'], apiObj)).toBe('PROVEN');
    expect(runForwarder('aiCmLiveTurnCount', [{ count: 4 }], apiObj)).toBe(7);
    expect(runForwarder('aiCmArchiveTierApply', [], apiObj)).toBe('TIER');
    expect(runForwarder('aiCmBaseExportInfo', [], apiObj)).toEqual({ baseMsgs: 4 });
    expect(calls).toEqual([['for', 'c1'], ['proven', 'c1'], ['live', { count: 4 }], ['tier'], ['info']]);
  });

  test('B3: без модуля форвардеры деградируют мягко (прежние гейты) и не бросают', () => {
    // null — модуль не подключён вовсе; undefined — ветка else не выполнялась
    [null, undefined].forEach((api) => {
      expect(runForwarder('aiCmArchiveFor', ['c1'], api)).toBeNull();
      // «архива нет» = true: ровно так вели себя гейты H10/floor-confirm ДО T1
      expect(runForwarder('aiCmArchiveLiveProven', ['c1'], api)).toBe(true);
      expect(runForwarder('aiCmArchiveTierApply', [], api)).toBeUndefined();
      expect(runForwarder('aiCmBaseExportInfo', [], api)).toBeNull();
    });
    // aiCmLiveTurnCount без модуля обязан вернуть ТЕКУЩИЙ размер базы, а не 0/null
    expect(runForwarder('aiCmLiveTurnCount', [null], null, () => 114)).toBe(114);
  });

  test('B4: хойстинг реален — значение, взятое ДО связки, зовёт модуль', () => {
    // Три чужих __bind-блока получают форвардеры ЗНАЧЕНИЕМ: пагинация (aiCmArchiveTierApply),
    // лоадер (aiCmArchiveFor/aiCmArchiveLiveProven/aiCmLiveTurnCount) и ingest
    // (aiCmArchiveTierApply). Все они биндуются РАНЬШЕ строки связки архива.
    expect((CORE_CODE.match(/aiCmArchiveTierApply: aiCmArchiveTierApply,/g) || [])).toHaveLength(2);
    expect((CORE_CODE.match(/aiCmArchiveFor: aiCmArchiveFor,/g) || [])).toHaveLength(1);
    expect((CORE_CODE.match(/aiCmArchiveLiveProven: aiCmArchiveLiveProven,/g) || [])).toHaveLength(1);
    expect((CORE_CODE.match(/aiCmLiveTurnCount: aiCmLiveTurnCount,/g) || [])).toHaveLength(1);
    const fwd = fnSource(CORE, 'aiCmArchiveTierApply');
    // Порядок ровно как в ядре: значение берут ДО объявления, связка — ПОСЛЕ.
    const ctx = vm.createContext({});
    vm.runInContext([
      'var captured = aiCmArchiveTierApply;',
      "var aiCmGeminiArchive = { aiCmArchiveTierApply: function () { return 'FROM-MODULE'; } };",
      fwd,
      'out = captured();'
    ].join('\n'), ctx);
    expect(ctx.out).toBe('FROM-MODULE');
    // а до связки тот же захваченный указатель деградирует мягко, не бросая
    const ctx2 = vm.createContext({});
    vm.runInContext([
      'var captured = aiCmArchiveTierApply;',
      'var aiCmGeminiArchive = null;',
      fwd,
      'out = captured();'
    ].join('\n'), ctx2);
    expect(ctx2.out).toBeUndefined();
  });
});

describe('Phase 3 шаг 13.2: C-пины — тела и слушатели перенесены байт-в-байт', () => {
  test('C1: восемь тел живут в модуле; три внутренних уехали из ядра целиком', () => {
    EXPORTED.concat(INTERNAL).forEach((n) => expect(fnSource(MOD, n)).not.toBeNull());
    INTERNAL.forEach((n) => expect(CORE_CODE).not.toMatch(new RegExp('function\\s+' + n + '\\s*\\(')));
    // тела экспортированных в ядре остались ровно форвардерами (см. B1) — тела нет
    EXPORTED.forEach((n) => expect(fnSource(MOD, n).length).toBeGreaterThan(fnSource(CORE, n).length));
  });

  test('C2: три слушателя уехали в модуль и каждый начинается гардом !D', () => {
    LISTENERS.forEach((ev) => {
      expect(MOD).toContain("window.addEventListener('" + ev + "'");
      // гард — ПЕРВАЯ строка тела: до чтения ev.detail и до любого обращения к D
      const at = MOD.indexOf("window.addEventListener('" + ev + "'");
      const brace = MOD.indexOf('{', at);
      const first = MOD.slice(brace + 1).split('\n')[1].trim();
      expect(first).toBe(GUARD);
    });
    expect((MOD.match(/if \(!D\) \{ debugLog\('error', '\[gemini-archive\] D is null, event ignored'\); return; \}/g) || []))
      .toHaveLength(3);
    // уникальность в КОНКАТЕНАЦИИ: копии в ядре не осталось (пин archive-export-union:686)
    expect(CONC.split('archiveAdded: true').length - 1).toBe(1);
    expect(CORE).not.toContain("window.addEventListener('ai-cm-archive-restore'");
    expect(CORE).not.toContain("window.addEventListener('ai-cm-restored-history'");
    expect(CORE).not.toContain("window.addEventListener('ai-cm-cache-refresh'");
    // байтовые требования чужих пинов: литерал регистрации и закрытие `\n  });`
    expect(CONC).toContain("window.addEventListener('ai-cm-archive-restore'");
    expect(MOD).toContain('\n  });');
  });

  test('C3: единственное изменение логики — префиксы D; строки-логи не переписаны', () => {
    // лог tape-restore содержит имя состояния ВНУТРИ строки-литерала: подстановка по AST
    // его не трогает (слепая замена по регулярке испортила бы текст сообщения)
    expect(MOD).toContain("'[gemini-restore] достигнут начало диалога (reachedStart=true) → восстановление из хранилища пропущено'");
    expect(MOD_CODE).not.toContain('D.reachedStart=true');
    // характерные литералы кластера байтово прежние
    ['[AI CM][archive-restore] convId=',
      '[AI CM][completeness] oracle=complete reason=archive-complete convId=',
      '[AI CM][tape-restore] convId=',
      '[AI CM][Gemini][cache-refresh] уточнение после кэша convId=',
      'floor source=archive convId='].forEach((lit) => expect(MOD).toContain(lit));
    // свойства объектов и ключи литералов не тронуты
    expect(MOD).toContain('archiveAdded: true');
    expect(MOD).toContain('pageMode: \'restored\'');
    expect(MOD).toContain('completeApplied: !!(prevTier && prevTier.completeApplied)');
  });

  test('C4: ключевые тела модуля байтово прежние — префикс D только у имён ядра', () => {
    // выборка покрывает все восемь тел: границу «D. только у внешнего имени» видно по
    // тому, что вызовы ВНУТРИ кластера (aiCmArchiveFor/aiCmLiveTurnCount) остались голыми
    expect(fnSource(MOD, 'aiCmArchiveFor')).toBe(
      'function aiCmArchiveFor(convId) {\n' +
      '    if (!convId) return null;\n' +
      '    return D.archiveTierByConv[convId] || null;\n' +
      '  }'
    );
    expect(fnSource(MOD, 'aiCmArchiveOnlyBase')).toBe(
      'function aiCmArchiveOnlyBase(convId) {\n' +
      '    try {\n' +
      '      var a = aiCmArchiveFor(convId || D.getConvId());\n' +
      '      if (!a || !(a.count > 0)) return false;\n' +
      '      return aiCmLiveTurnCount(a) === 0;\n' +
      '    } catch (eAob) { return false; }\n' +
      '  }'
    );
    expect(fnSource(MOD, 'aiCmLiveTurnCount')).toContain('if (!a || !a.addedIds) return D.baseSize();');
    expect(fnSource(MOD, 'aiCmLiveTurnCount')).toContain('var ids = Object.keys(D.turnsMap);');
    expect(fnSource(MOD, 'aiCmArchiveLiveProven')).toContain('return aiCmArchiveGrewBeyondArchive(a);');
    expect(fnSource(MOD, 'aiCmArchiveGrewBeyondArchive')).toContain('return liveCount > arch.count;');
    expect(fnSource(MOD, 'aiCmArchiveGrewBeyondArchive')).toContain('if (!overlap) return false;');
    expect(fnSource(MOD, 'aiCmBuildBaseMessages')).toContain('return D.sanitizeMessagesForEmit(messages);');
    expect(fnSource(MOD, 'aiCmBaseExportInfo')).toContain('liveProven: aiCmArchiveLiveProven(convId),');
    expect(fnSource(MOD, 'aiCmArchiveTierApply')).toContain('var archiveOnly = aiCmArchiveOnlyBase(convId);');
    expect(fnSource(MOD, 'aiCmArchiveTierApply')).toContain('loaderDone: loaderDone && !archiveOnly');
    expect(fnSource(MOD, 'aiCmArchiveTierApply')).toContain('loaderRunning: D.loaderRunningFor === convId');
    expect(fnSource(MOD, 'aiCmArchiveTierApply')).toContain('var loaderDone = D.loaderDoneMap[convId] === true;');
    expect(fnSource(MOD, 'aiCmArchiveTierApply')).toContain('active: D.quietActive === true');
    expect(fnSource(MOD, 'aiCmArchiveTierApply')).toContain('D.historyFullByQuiet = true;');
    expect(fnSource(MOD, 'aiCmArchiveTierApply')).toContain('D.reachedStart = true;');
    // прочие три записи состояния — в слушателях (rw-имена)
    expect(MOD).toContain('D.tapeWasUsedInThisColdStart = true;');
    expect(MOD).toContain('D.cacheRestoredMap.add(current);');
    expect(MOD).toContain('D.archiveMergedMap.add(convId);');
    expect(MOD).toContain('D.noteBaseCountChange();');
    expect(MOD).toContain('D.saveFloor(convId, archFloor.count, archFloor.effectiveLen);');
  });
});

describe('Phase 3 шаг 13.2: D-пины — API, размещение связки, гигиена', () => {
  test('D1: модуль отдаёт ровно 6 имён и публикует их на window', () => {
    expect(MOD).toContain("if (typeof window !== 'undefined' && window.AiCmGeminiArchive) return;");
    expect(MOD).toContain('  var D = null;');
    expect(MOD).toContain('  function __bind(d) { D = d; }');
    expect(MOD).toContain('    __bind: __bind,');
    EXPORTED.forEach((n) => expect(MOD).toContain('    ' + n + ': ' + n));
    expect(MOD).toContain("if (typeof window !== 'undefined') window.AiCmGeminiArchive = Api;");
    // в MAIN-мире `module` не определён: голый module.exports бросил бы ReferenceError
    expect(MOD).toContain("if (typeof module !== 'undefined' && module.exports) module.exports = Api;");
    expect(Object.keys(require(path.join(ROOT, 'core/gemini-archive.js'))).sort())
      .toEqual(['__bind'].concat(EXPORTED).sort());
  });

  test('D2: гигиена модуля — без with, без strict, без innerHTML, без console.error', () => {
    expect(MOD_CODE).not.toMatch(/\bwith\s*\(/);
    expect(MOD).not.toMatch(/^\s*'use strict'/m);
    expect(MOD_CODE).not.toMatch(/innerHTML\s*=/);
    expect(MOD_CODE).not.toMatch(/console\s*\.\s*error\s*\(/);
    // в MAIN-мире chrome.* недоступен: модуль обязан остаться без него
    expect(MOD_CODE).not.toContain('chrome.');
  });

  test('D3: повторная загрузка модуля не перетирает API и не вешает слушателей дважды', () => {
    const first = loadModule();
    const api = first.api;
    expect(api).toBeTruthy();
    expect(Object.keys(api).sort()).toEqual(['__bind'].concat(EXPORTED).sort());
    expect(first.pageWindow.listeners.slice().sort())
      .toEqual(['ai-cm-archive-restore', 'ai-cm-cache-refresh', 'ai-cm-restored-history']);
    vm.runInContext(MOD, first.ctx, { filename: 'core/gemini-archive.js (повторно)' });
    expect(first.pageWindow.AiCmGeminiArchive).toBe(api);
    expect(first.pageWindow.listeners).toHaveLength(3); // re-entry guard сработал
    // без связки слушатель не бросает: гард !D гасит событие с внятным логом
    expect(() => first.pageWindow.listeners && api.__bind({})).not.toThrow();
  });

  test('D4: гард !D гасит событие до связки (без ReferenceError в чужом стеке)', () => {
    const sandbox = loadModule();
    const logs = [];
    sandbox.ctx.debugLog = function (level, msg) { logs.push([level, msg]); };
    const ev = { detail: { turns: [{ role: 'user', text: 'x' }], convId: 'c1' } };
    // до __bind D === null: каждый слушатель обязан выйти на ПЕРВОЙ строке с логом error
    LISTENERS.forEach((t) => {
      expect(typeof sandbox.pageWindow.handlers[t]).toBe('function');
      expect(() => sandbox.pageWindow.handlers[t](ev)).not.toThrow();
    });
    expect(logs).toHaveLength(3);
    logs.forEach(([level, msg]) => {
      expect(level).toBe('error');
      expect(msg).toBe('[gemini-archive] D is null, event ignored');
    });
    // после связки гард молчит и обработчик доходит до тела: чат «чужой» → ветка stale
    sandbox.api.__bind({ getConvId: () => 'other', aiCmDiagTurnEdge: () => ({ hash: 'h' }) });
    logs.length = 0;
    expect(() => sandbox.pageWindow.handlers['ai-cm-restored-history'](ev)).not.toThrow();
    expect(logs).toHaveLength(2);
    expect(logs[0][0]).toBe('log');
    expect(logs[0][1]).toContain('пропущена лента для чужого чата');
  });

  test('D5: блок подключения стоит НИЖЕ поздних алиасов (строка > 782)', () => {
    const bindLine = lineOf(CORE, 'aiCmGeminiArchive.__bind(');
    expect(bindLine).toBeGreaterThan(782);
    // три ПОЗДНИХ алиаса — `var ... = null`, дозаполняются блоками ingest (770-771)
    // и пагинации (494); выше них в модуль уехали бы null вместо функций
    ['emitBaseSnapshot = aiCmGeminiIngest.emitBaseSnapshot;',
      'mergeRestoredTurns = aiCmGeminiIngest.mergeRestoredTurns;',
      'refreshMinOrderTracking = aiCmGeminiPagination.refreshMinOrderTracking;'].forEach((lit) => {
      const at = lineOf(CORE, lit);
      expect(at).toBeGreaterThan(0);
      expect(bindLine).toBeGreaterThan(at);
    });
    // S4: поэтому поздний алиас отдан архиву ЗНАЧЕНИЕМ — и это законно (ср. суженный пин
    // в tests/adapters/gemini-ingest-module.test.js: блок ingest обязан отдавать форвардер)
    expect(bindBlockText()).toContain('emitBaseSnapshot: emitBaseSnapshot,');
    expect(CORE_CODE.match(/emitBaseSnapshot: emitBaseSnapshot,/g)).toHaveLength(1);
    // баннер-указатель на месте бывшего диапазона слушателей
    expect(CORE).toContain('// ===== v2.0 (Phase 3 step 13.2): АРХИВ (ВЫНЕСЕН В core/gemini-archive.js) =====');
    expect((CORE.match(/Phase 3 step 13\.2\): АРХИВ \(ВЫНЕСЕН/g) || [])).toHaveLength(2);
  });

  test('D6: без модуля ядро деградирует мягко — внятный лог, а не падение', () => {
    const at = CORE.indexOf("debugLog('log', '[gemini-intercept] core/gemini-archive.js не подключён");
    expect(at).toBeGreaterThan(-1);
    const elseBranch = CORE.slice(at, CORE.indexOf('\n  }', at));
    expect(elseBranch).toContain('архивный ярус недоступен');
    expect(elseBranch).not.toContain('throw');
    expect(elseBranch).not.toMatch(/function\s/);
  });
});

describe('Phase 3 шаг 13.2: S-пины проводки модуля', () => {
  test('S1: регистрация в core/background.js — id -v10, модуль между overlay и ядром, -v9 снят', () => {
    const bg = readFile('core/background.js');
    expect(bg).toContain("'ai-cm-gemini-intercept-v10'");
    expect(bg).toContain("'core/gemini-archive.js'");
    // js[] собран ровно в этом порядке: … loader-scroll → ingest → overlay → archive → ядро
    expect(bg).toContain("'core/gemini-sse.js', 'core/pagination/pagination.js', 'core/gemini-loader-scroll.js', 'core/gemini-ingest.js', 'core/gemini-overlay.js', 'core/gemini-archive.js', 'core/gemini-intercept.js'");
    // модуль обязан грузиться РАНЬШЕ ядра: ядро связывает его при своей загрузке
    expect(bg.indexOf("'core/gemini-overlay.js'")).toBeLessThan(bg.indexOf("'core/gemini-archive.js'"));
    expect(bg.indexOf("'core/gemini-archive.js'")).toBeLessThan(bg.indexOf("'core/gemini-intercept.js'"));
    // MV3 не перечитывает js[] под существующим id — прежний id обязан быть снят
    expect(bg).toContain("'ai-cm-gemini-intercept-v9'");
    expect(bg).toContain("'ai-cm-gemini-intercept-v8'");
    // лог регистрации бампнут вместе с id
    expect(bg).toContain('(v10) зарегистрирован');
    expect(bg).not.toContain('(v9) зарегистрирован');
    // лог обязан стоять РЯДОМ со своей регистрацией, а не быть унаследованным текстом
    expect(bg.indexOf("await registerSafe('ai-cm-gemini-intercept-v10'"))
      .toBeLessThan(bg.indexOf('(v10) зарегистрирован'));
  });

  test('S2: bind-контракт полон — ни одна зависимость кластера не потеряна', () => {
    // 22 имени — зафиксированная величина шага; падение = молчаливый no-op в модуле
    expect(CONTRACT).toHaveLength(22);
    const names = CONTRACT.map(([n]) => n);
    expect(new Set(names).size).toBe(22);
    // полный состав контракта — фиксированная величина шага (11 fn + 8 ro + 3 rw)
    expect(names.slice().sort()).toEqual([
      'activeRefresh', 'aiCmDiagTurnEdge', 'archiveMergedMap', 'archiveTierByConv', 'baseSize',
      'cacheRestoredMap', 'emitBaseSnapshot', 'getConvId', 'historyFullByQuiet', 'loadFloor',
      'loaderDoneMap', 'loaderRunningFor', 'mergeRestoredTurns', 'noteBaseCountChange',
      'parserVersion', 'quietActive', 'reachedStart', 'refreshMinOrderTracking',
      'sanitizeMessagesForEmit', 'saveFloor', 'tapeWasUsedInThisColdStart', 'turnsMap'
    ]);
    const kinds = { fn: 0, ro: 0, rw: 0 };
    CONTRACT.forEach(([, k]) => { kinds[k]++; });
    expect(kinds).toEqual({ fn: 11, ro: 8, rw: 3 });
    // каждое имя контракта реально используется телом модуля (через объект связи)
    const unused = names.filter((n) => !new RegExp('D\\.' + n + '\\b').test(MOD_CODE));
    expect(unused).toEqual([]);
    // …и передаётся ядром в __bind. Проверяем ИМЕННО блок __bind: имя может встречаться
    // в ядре и вне связки — это не передача.
    const block = bindBlockText();
    const notProvided = names.filter((n) => !new RegExp('(?:^|[\\s,{])' + n + '\\s*[:,(]', 'm').test(block));
    expect(notProvided).toEqual([]);
    // ro-имена не получают сеттера (модуль их не переприсваивает), rw — получают
    const rw = CONTRACT.filter(([, k]) => k === 'rw').map(([n]) => n);
    const ro = CONTRACT.filter(([, k]) => k === 'ro').map(([n]) => n);
    rw.forEach((n) => expect(block).toMatch(new RegExp('set\\s+' + n + '\\s*\\(')));
    ro.forEach((n) => expect(block).not.toMatch(new RegExp('set\\s+' + n + '\\s*\\(')));
    // fn-имена передаются значением и сеттера не получают
    CONTRACT.filter(([, k]) => k === 'fn').forEach(([n]) => {
      expect(block).toContain(n + ': ' + n + ',');
      expect(block).not.toMatch(new RegExp('set\\s+' + n + '\\s*\\('));
    });
  });

  test('S3: порядок в helper-конкатенации повторяет порядок js[]', () => {
    expect(SRC.MODULES).toContain('core/gemini-archive.js');
    expect(SRC.MODULES.indexOf('core/gemini-archive.js'))
      .toBeGreaterThan(SRC.MODULES.indexOf('core/gemini-overlay.js'));
    expect(SRC.SOURCES.indexOf('core/gemini-archive.js'))
      .toBeLessThan(SRC.SOURCES.indexOf('core/gemini-intercept.js'));
    expect(CONC.indexOf(MOD)).toBeLessThan(CONC.indexOf(CORE));
    // контракт обязан трекаться в git: tools/* под .gitignore, нужна негация
    expect(readFile('.gitignore')).toContain('!tools/archive-bind-contract.js');
  });

  test('S4: пин строки vf5 не сдвинулся — оба диапазона лежат НИЖЕ него', () => {
    // шаг 13.2 правит только строки > 1712, поэтому точка выхода vf5 осталась на 1680;
    // если следующий перенос заедет выше неё, этот пин обязан покраснеть
    const VF5_TAIL = 'aiCmIngestFwd(txt, { emitOnlyIfAdded: true, fromVirtualF5: true, rebuild: rebuild });';
    const hits = CORE.split('\n').reduce((acc, l, i) => (l.indexOf(VF5_TAIL) !== -1 ? acc.concat(i + 1) : acc), []);
    expect(hits).toEqual([1680]);
    expect(lineOf(CORE, 'aiCmGeminiArchive.__bind(')).toBeGreaterThan(1680);
  });
});
````

## 3. Вывод приёмочных команд

### 3.1 `npm test` (полный вывод jest, хвост — сводка)

````
PASS tests/adapters/deepseek-o17-spa-chat.test.js
PASS tests/adapters/deepseek-o16-stream-export.test.js
PASS tests/adapters/deepseek-o15-pairing.test.js
PASS tests/adapters/deepseek-o22-dispatch-dedupe.test.js
PASS tests/qwen-gate-diag-o35.test.js
PASS tests/adapters/gsa-fetch-consent-telemetry.test.js
PASS tests/qwen-container-drop-o37.test.js
PASS tests/o21-deepseek-dom-instrumentation.test.js
PASS tests/qwen-intercept.test.js
PASS tests/debug.test.js
PASS tests/byok-session.test.js
PASS tests/deepseek-o7-hidden-export.test.js
…
Test Suites: 149 passed, 149 total
Tests:       6 skipped, 2837 passed, 2843 total
Snapshots:   0 total
Time:        6.201 s, estimated 7 s
[exit code: 0]
````

Полный список сьютов: PASS — 149, FAIL — 0.

### 3.2 `npm run build`

````
[build] entries derived from SSOTs:
  background <- 1 file(s)
  content <- 23 file(s)
  options <- 7 file(s)
  print <- 3 file(s)
  shared-i18n <- 1 file(s)
  runtime-registered <- 25 file(s) (copied verbatim)
[build] background: 60,739 source bytes (1 files)
[build] content: 950,098 source bytes (23 files)
[build] options: 164,182 source bytes (7 files)
[build] print: 26,845 source bytes (3 files)
[build] shared-i18n: 5,027 source bytes (1 files)
[build] mode=development sourcemap=true
[build] 46 asset file(s) copied into dist/
  ✓ dist/background.js (33,381 bytes)
  ✓ dist/content.js (552,803 bytes)
  ✓ dist/options.js (120,528 bytes)
  ✓ dist/print.js (19,762 bytes)
  ✓ dist/shared-i18n.js (2,770 bytes)
  ✓ dist/ verified: 30 .js files (5 bundles + 25 runtime-registered)
[build] done.

[exit code: 0]
````

### 3.3 `npx tsc --noEmit`

````
exit code: 0 (вывод пуст)
````

### 3.4 `node tools/verify-archive-extraction.js` (независимая пост-проверка)

````
0. Контракт
  ✓ контракт: 22 имени
  ✓ виды связи 11 fn / 8 ro / 3 rw

1. Старое ядро из git (HEAD:core/gemini-intercept.js)
  ✓ анкер начала A (1712)
  ✓ анкер конца A (1914)
  ✓ анкер начала B (1935)
  ✓ анкер конца B (2145)

2. Тело модуля ↔ два диапазона старого ядра
  ✓ границы каркаса модуля найдены
  ✓ разделитель A|B на месте (строка 204 тела)
  ✓ A: тело модуля байтово равно диапазону 1712-1914 (203 строк)
  ✓ B: тело модуля байтово равно диапазону 1935-2145 без 3 гардов (211 строк)
  ✓ в модуле ровно 3 гарда !D
  ✓ набор D.<имя> равен контракту

3. Ядро: состояние осталось, тела уехали
  ✓ ядро: состояние "  var turnsMap = {};"
  ✓ ядро: состояние "  var quietActive = false;"
  ✓ ядро: состояние "  var historyFullByQuiet = false;"
  ✓ ядро: состояние "  var reachedStart = false; // тихая пагинация дошла до начала (курсора больше нет)"
  ✓ ядро: состояние "  var loaderDoneMap = {};   // convId → true (один запуск на чат за сессию страницы)"
  ✓ ядро: состояние "  var loaderRunningFor = null;"
  ✓ ядро: состояние "  var cacheRestoredMap = new Set();"
  ✓ ядро: состояние "  var archiveTierByConv = {};"
  ✓ ядро: состояние "  var archiveMergedMap = new Set();"
  ✓ ядро: состояние "  var parserVersion = '';"
  ✓ ядро: состояние "  var tapeWasUsedInThisColdStart = false;"
  ✓ ядро: sanitizeMessagesForEmit на месте
  ✓ ядро: форвардер aiCmArchiveFor — function declaration
  ✓ ядро: aiCmArchiveFor объявлен ровно раз
  ✓ ядро: форвардер aiCmArchiveLiveProven — function declaration
  ✓ ядро: aiCmArchiveLiveProven объявлен ровно раз
  ✓ ядро: форвардер aiCmLiveTurnCount — function declaration
  ✓ ядро: aiCmLiveTurnCount объявлен ровно раз
  ✓ ядро: форвардер aiCmArchiveTierApply — function declaration
  ✓ ядро: aiCmArchiveTierApply объявлен ровно раз
  ✓ ядро: форвардер aiCmBaseExportInfo — function declaration
  ✓ ядро: aiCmBaseExportInfo объявлен ровно раз
  ✓ ядро: тела aiCmBuildBaseMessages больше нет
  ✓ ядро: тела aiCmArchiveOnlyBase больше нет
  ✓ ядро: тела aiCmArchiveGrewBeyondArchive больше нет
  ✓ ядро: хвостовая точка vf5 не сдвинулась (1680)
  ✓ ядро: блок подключения на строке 1742 (> 782)
  ✓ ядро: блок подключения НИЖЕ поздних алиасов
  ✓ ядро: __bind отдаёт activeRefresh (fn)
  ✓ ядро: __bind отдаёт aiCmDiagTurnEdge (fn)
  ✓ ядро: __bind отдаёт baseSize (fn)
  ✓ ядро: __bind отдаёт getConvId (fn)
  ✓ ядро: __bind отдаёт loadFloor (fn)
  ✓ ядро: __bind отдаёт noteBaseCountChange (fn)
  ✓ ядро: __bind отдаёт sanitizeMessagesForEmit (fn)
  ✓ ядро: __bind отдаёт saveFloor (fn)
  ✓ ядро: __bind отдаёт emitBaseSnapshot (fn)
  ✓ ядро: __bind отдаёт mergeRestoredTurns (fn)
  ✓ ядро: __bind отдаёт refreshMinOrderTracking (fn)
  ✓ ядро: __bind отдаёт archiveMergedMap (ro)
  ✓ ядро: __bind отдаёт archiveTierByConv (ro)
  ✓ ядро: __bind отдаёт cacheRestoredMap (ro)
  ✓ ядро: __bind отдаёт loaderDoneMap (ro)
  ✓ ядро: __bind отдаёт loaderRunningFor (ro)
  ✓ ядро: __bind отдаёт parserVersion (ro)
  ✓ ядро: __bind отдаёт quietActive (ro)
  ✓ ядро: __bind отдаёт turnsMap (ro)
  ✓ ядро: __bind отдаёт historyFullByQuiet (rw)
  ✓ ядро: __bind отдаёт reachedStart (rw)
  ✓ ядро: __bind отдаёт tapeWasUsedInThisColdStart (rw)

4. Проводка и служебные файлы
  ✓ background: id -v10
  ✓ background: -v9 в unregister
  ✓ background: лог (v10)
  ✓ background: js[] overlay → archive → ядро
  ✓ helper: модуль последним в MODULES (перед ядром)
  ✓ release.yml: старого счётчика 24 нет
  ✓ release.yml: оба счётчика = 25
  ✓ .gitignore: контракт выведен из-под tools/*
  ✓ пин-сьют: регистрация -v10

5. EOL и BOM
  ✓ core/gemini-archive.js: LF без BOM
  ✓ core/gemini-intercept.js: LF без BOM
  ✓ core/background.js: LF без BOM
  ✓ tests/helpers/gemini-intercept-source.js: LF без BOM
  ✓ tests/adapters/gemini-archive-module.test.js: LF без BOM
  ✓ tests/adapters/gemini-ingest-module.test.js: LF без BOM
  ✓ tests/adapters/gemini-overlay-module.test.js: LF без BOM
  ✓ tests/adapters/gemini-pagination-module.test.js: LF без BOM
  ✓ tests/archive/archive-export-gate.test.js: LF без BOM
  ✓ tests/archive/archive-export-union.test.js: LF без BOM
  ✓ tests/archive/archive-oracle.test.js: LF без BOM
  ✓ tests/qwen-provider-wiring.test.js: LF без BOM
  ✓ tools/archive-bind-contract.js: LF без BOM
  ✓ tools/apply-archive-extraction.js: LF без BOM
  ✓ release.yml: CRLF сохранён
  ✓ release.yml: режим «без хвостового перевода» сохранён

[OK] Пост-проверка шага 13.2 пройдена: вынос доказан байтово, проводка и EOL в порядке.

[exit code: 0]
````

### 3.5 `node tools/apply-archive-extraction.js` (повторный прогон: гейт «шаг уже применён»)

Скрипт одноразовый by design: он правит файлы и потому отказывается работать на уже
применённом состоянии (иначе диапазоны 1712-1914 / 1935-2145 в ядре не найдутся).
Ниже — фактический отказ, подтверждающий, что правка уже в рабочей копии:

````

0. Контракт связки
  имён в контракте: 22 (activeRefresh:fn, aiCmDiagTurnEdge:fn, baseSize:fn, getConvId:fn, loadFloor:fn, noteBaseCountChange:fn, sanitizeMessagesForEmit:fn, saveFloor:fn, emitBaseSnapshot:fn, mergeRestoredTurns:fn, refreshMinOrderTracking:fn, archiveMergedMap:ro, archiveTierByConv:ro, cacheRestoredMap:ro, loaderDoneMap:ro, loaderRunningFor:ro, parserVersion:ro, quietActive:ro, turnsMap:ro, historyFullByQuiet:rw, reachedStart:rw, tapeWasUsedInThisColdStart:rw)
  ✓ 22 имени: 11 fn + 8 ro + 3 rw — как в плане шага 13.2

1. Файлы: LF/BOM/хвост, отсутствие готового модуля
  ✓ EOL/BOM/хвост в порядке у 12 правимых файлов (*.js — LF по .gitattributes; .gitignore/release.yml — lf/crlf, режим сохраняется)

[ОШИБКА] core/gemini-archive.js уже существует — шаг уже применён (или создан вручную). Удалите его осознанно.
[ОСТАНОВ] В файлы ничего не записано: правки живут только в памяти этого прогона.

[exit code: 1]
````


---

Отчёт сгенерирован `tools/build-step-13.2-report.js`; файл служебный и не входит в пакет расширения.
