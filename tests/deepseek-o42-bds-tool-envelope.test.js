/**
 * O-42 (P1): АГЕНТНЫЙ КОНВЕРТ соседнего расширения Better DeepSeek (tool-continuation) —
 * прочь из OFF-пути экспорта. НОВЫЙ ТУМБЛЕР НЕ ЗАВОДИТСЯ: та же единственная точка и тот же
 * OFF-путь, что у O-20/O-40 — utils/export-emit-pipeline.js:sanitizeEmitMessages, OFF-путь
 * тумблера aiCmIncludeHiddenInExport (ON-путь = сырой режим, конверт не трогает вовсе).
 *
 * ИЗМЕРЕНИЕ (живой артефакт владельца ai-context-monitor-deepseek-DeepSeek-R1-2026-09-21-10-19.json,
 * per-message границы; тот же конверт в txt-экспорте deepseek-565a7cd8-2026-09-21_15-40.txt:
 * 5 блоков <local_file_read>, 7 проза-блоков, 7 пар <original_task>, 14 тегов <tool_results>):
 *   A tc-local-file-read     msg 1/3/9/11/13 строки 1-3 (ЦЕЛОЕ сообщение, role=assistant) — 5
 *   B tc-prose-continuation  msg 2/4/7/8/10/12/14 строки 1-9 — 7
 *   C tc-original-task       msg 2/4 строки 11-12 (ПУСТАЯ пара) + msg 7/8/10/12/14 строки 11-17 — 7
 *   D tc-tool-results        msg 2/4 строки 14-26 / 14-35, msg 7/8/10/12/14 строки 19-…(конец
 *                            сообщения 31/40/49/58/66) — 7; закрывающий тег '…</tool_results>' в
 *                            артефакте — ПОСЛЕДНЯЯ строка сообщения (7/7), незакрытых 0.
 * Всего вхождений 5+7+7+7 = 26; все 12 вхождений — ЦЕЛЫЕ сообщения (спанов форм в артефакте 0).
 *
 * ОТКЛОНЕНИЕ (зафиксировано; старые ожидания НЕ редактировались): спан формы A внутри
 * сообщения НЕ снимается — своего измерения спана в артефакте НЕТ (0 вхождений), а живые байты
 * такого спана заморожены как СОХРАНЯЕМЫЙ текст тремя существующими пинами:
 *   tests/deepseek-o40-better-deepseek-sanitation.test.js:1747 (D-F7, role=user),
 *   tests/deepseek-o40-better-deepseek-sanitation.test.js:2008 (R-F7-4, role=assistant),
 *   tests/o40-f3-diag-instrumentation.test.js:474 (txt OFF-пути содержит '<local_file_read>').
 * По правилу «у формы нет измеримой границы — не угадывать» спан формы A — R-пин (байты
 * прежние), а не D-пин. Остальные три формы имеют и целое-сообщение, и конверт-спан.
 */
const fs = require('fs');
const path = require('path');

const P = require('../utils/export-emit-pipeline.js');
const Builders = require('../utils/export-text-builders.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const PIPELINE_SRC = read('utils/export-emit-pipeline.js');
const DEBUG_SRC = read('utils/debug.js');
const OPTIONS_JS = read('options/options.js');
const OPTIONS_HTML = read('options/options.html');
const ru = JSON.parse(read('_locales/ru/messages.json'));

const SETTING_KEY = 'aiCmIncludeHiddenInExport';

// =====================================================================================
// ФИКСТУРЫ: побайтовые фрагменты живого артефакта 10-19 (границы — как в таблице дескрипторов)
// =====================================================================================
// Форма A, msg 1 (артефакт 10-19), строки 1-3 — целое сообщение, role=assistant.
const LFR_MSG1 = [
  "<local_file_read>",   // msg 1, строка 1
  "{\"path\": \"C:/Users/oleg/Desktop/Prompts/ai-context-monitor-v2.0.10/PROJECT_HANDOFF.md\", \"max_chars\": 40000}",   // msg 1, строка 2
  "</local_file_read>"   // msg 1, строка 3
].join('\n');

// Форма A, msg 3, строки 1-3 (та же форма, ДРУГАЯ полезная нагрузка: "start": 40000).
const LFR_MSG3 = [
  "<local_file_read>",   // msg 3, строка 1
  "{\"path\": \"C:/Users/oleg/Desktop/Prompts/ai-context-monitor-v2.0.10/PROJECT_HANDOFF.md\", \"start\": 40000, \"max_chars\": 20000}",   // msg 3, строка 2
  "</local_file_read>"   // msg 3, строка 3
].join('\n');

// Форма A, msg 9, строки 1-3 (max_chars 12000).
const LFR_MSG9 = [
  "<local_file_read>",   // msg 9, строка 1
  "{\"path\": \"C:/Users/oleg/Desktop/Prompts/ai-context-monitor-v2.0.10/PROJECT_HANDOFF.md\", \"max_chars\": 12000}",   // msg 9, строка 2
  "</local_file_read>"   // msg 9, строка 3
].join('\n');

// Форма A, msg 11, строки 1-3 (другой файл: utils/stream-frames.js).
const LFR_MSG11 = [
  "<local_file_read>",   // msg 11, строка 1
  "{\"path\": \"C:/Users/oleg/Desktop/Prompts/ai-context-monitor-v2.0.10/utils/stream-frames.js\", \"max_chars\": 16000}",   // msg 11, строка 2
  "</local_file_read>"   // msg 11, строка 3
].join('\n');

// Форма A, msg 13, строки 1-3 (другой файл: core/qwen-intercept.js).
const LFR_MSG13 = [
  "<local_file_read>",   // msg 13, строка 1
  "{\"path\": \"C:/Users/oleg/Desktop/Prompts/ai-context-monitor-v2.0.10/core/qwen-intercept.js\", \"max_chars\": 20000}",   // msg 13, строка 2
  "</local_file_read>"   // msg 13, строка 3
].join('\n');

// Конверт-ход, msg 2 (13 379 символов): проза 1-9, ПУСТАЯ пара original_task 11-12, tool_results 14-26 (закрывающий тег — последняя строка).
const ENV_MSG2 = [
  "These are the tool results just executed for the tool-continuation task. Continue like a real agent, using the original task and these tool results to move the work forward.",   // строка 1 из 26
  "If the results are enough, output the final answer. Only call more tools when more information, verification, or file changes are truly needed.",   // строка 2 из 26
  "Do not ask the user to click continue, and do not output pseudo tool-call JSON. When more action is needed, output only executable XML tool tags. Deliver files, HTML pages, and charts as Markdown fenced code blocks (e.g. ```html, ```xychart-beta, ```mermaid) so the page renders them natively; never use artifact XML tags.",   // строка 3 из 26
  "When emitting a ```xychart-beta fence, its body must use native Mermaid XY Chart syntax directly. Valid body example:",   // строка 4 из 26
  "title \"ARR\"",   // строка 5 из 26
  "x-axis [\"2024-01\", \"2024-02\"]",   // строка 6 из 26
  "y-axis \"ARR ($B)\" 0 --> 50",   // строка 7 из 26
  "line [1, 2]",   // строка 8 из 26
  "You may use bar [...]. Do not use x-label, y-label, chart-type, data:, series:, xy ..., or a Markdown table as the chart body.",   // строка 9 из 26
  "",   // строка 10 из 26
  "<original_task>",   // строка 11 из 26
  "</original_task>",   // строка 12 из 26
  "",   // строка 13 из 26
  "<tool_results>",   // строка 14 из 26
  "[",   // строка 15 из 26
  "  {",   // строка 16 из 26
  "    \"tool\": \"local_file_read\",",   // строка 17 из 26
  "    \"provider\": \"Shell Local\",",   // строка 18 из 26
  "    \"ok\": true,",   // строка 19 из 26
  "    \"summary\": \"local_file_read auto 续读完成\",",   // строка 20 из 26
  "    \"detail\": \"{\\n  \\\"data\\\": {\\n    \\\"path\\\": \\\"C:/Users/oleg/Desktop/Prompts/ai-context-monitor-v2.0.10/PROJECT_HANDOFF.md\\\",\\n    \\\"windows\\\": 4,\\n    \\\"totalChars\\\": 56861,\\n    \\\"charsReturned\\\": 40000,\\n    \\\"truncated\\\": true,\\n    \\\"content\\\": \\\"# PROJECT_HANDOFF.md (для нового чата)\\\\n\\\\n## §0. Принцип качества (неоспоримый)\\\\n\\\\n1. Расширение соответствует стандартам: Chrome MV3 best practices; программные политики Chrome Web Store как эталон качества (дистрибуция — GitHub Releases); надёжность перехватчиков (исключение внутри враппера не должно ломать хост-страницу); privacy-гигиена (нет innerHTML с контентом чата, ключи только в chrome.storage, тихая консоль без гейта aiCmDebug); тестируемость (каждый фикс — R-D пины на каждый путь записи базы и точку выхода).\\\\n2. Реализация, рецензия и приёмка — уровень senior и выше: нет фикса без корня; нет коммита без зелёной Chrome-проверки; нет релиза без зелёного сьюта и RELEASE_CHECKLIST; каждое отклонение от стандартов фиксируется в docs/QUALITY_AUDIT.md с ID и приоритетом P0/P1/P2 и либо чинится, либо осознанно принимается владельцем.\\\\n3. Действие: на старте сессии — из настоящего handoff; на каждом шаге — строкой контекст-переноса промпта кодеру; на релизе — гейтом RELEASE_CHECKLIST.md. Обновляющие блоки handoff могут перекрывать строки очереди и релизов, но не §0.\\\\n\\\\n## Обновление 2026-09-19 (v2.0.10 опубликован; голова очереди — O-35 универсальный SSE-парсер)\\\\nПерекрывает конфликтующие места блоков ниже (включая строки релиза и очереди предыдущих обновлений):\\\\n- HEAD: этот docs-коммит (поверх `083caa7` docs с тегом `v2.0.10` → `e080313` release v2.0.10). Рабочая копия чиста.\\\\n- Релиз v2.0.10 опубликован: GitHub Release на теге `v2.0.10` (`083caa7`), Release ZIP #13 зелёный (13s), asset ai-context-monitor-v2.0.10.zip 2.64 MB (sha256 b40297640d18d985cc2e7773fcc…); Lint #32 (`e080313`) и #33 (`083caa7`) зелёные.\\\\n- Очередь (решение владельца 2026-09-19): голова — O-35 (универсальный SSE-парсер с автодетектом провайдера + провайдер Qwen; источник спецификации и готовый stream-analyzer.js — экспорт чата ai-context-monitor-deepseek-DeepSeek-R1-2026-09-18-17-53.txt: эндпоинты /api/v2/chats/new и /api/v2/chat/completions?chat_id=, SSE-фазы thinking_summary/answer, usage кумулятивный, антибот bx-ua только на /chats/new); далее O-23 (F5: калибровка tokens~ против serverTokens, Medium), O-24, O-34 (Low); хвост: O-29 → O-32 → O-21 (малоактуальна).\\\\n- Спецификация O-23 (F5) зафиксирована: расхождение tokens~ с serverTokens на чистом payload без соседей (недооценка Δ=-67 при serverTokens=78; переоценка Δ=+1902 при 1176 на русском тексте); воспроизведение — контрольный прогон B1, DeepSeek++ выкл; замер — парные значения в badge-recv/badge-update; ожидание — уточнение семантики и калибровка эвристики (критична для платформ без серверного usage); приоритет Medium.\\\\n- Подход O-35: начать с read-only инспекции точек SSE-парсинга шести перехватчиков и маппинга на адаптеры stream-analyzer.js; реализация — только после отчёта инспекции и плана интеграции с R-пинами на все 6 платформ и живой приёмкой на Qwen (usage input/output/reasoning из стрима).\\\\n\\\\n## Обновление 2026-09-19 (релизная пачка 2.0.10 собрана; тег v2.0.10 на этом docs-коммите)\\\\nПерекрывает конфликтующие места блоков ниже (включая строки релиза предыдущих обновлений):\\\\n- HEAD: этот docs-коммит (поверх `e080313` release v2.0.10 → `89201e6` fix O-22 → `558e832` docs O-22). Рабочая копия чиста после коммита.\\\\n- Релизная пачка 2.0.10: состав 11 трекаемых файлов (manifest/package 2.0.10, CHANGELOG [2.0.10] Fixed с O-14 и O-22, футер docs/index.html, 7 версионных пинов) + 2 untracked на диске (package-lock.json, tools/edge-listing-metadata.txt); сьют 93/1616/6 (число тестов не изменилось).\\\\n- Отклонения от промпта релизного бампа: (а) три негативных ассерта version-hygiene переведены с not.toContain('2.0.1') на regex 2\\\\\\\\.0\\\\\\\\.1(?!\\\\\\\\d) из-за префиксной коллизии 2.0.1 внутри 2.0.10 — смысл сохранён (lookahead не матчит 2.0.10), логика пинов не менялась; (б) мок-литерал 2.0.10 в \\n...[truncated]\",",   // строка 21 из 26
  "    \"output\": \"{\\\"data\\\":{\\\"path\\\":\\\"C:/Users/oleg/Desktop/Prompts/ai-context-monitor-v2.0.10/PROJECT_HANDOFF.md\\\",\\\"windows\\\":4,\\\"totalChars\\\":56861,\\\"charsReturned\\\":40000,\\\"truncated\\\":true,\\\"content\\\":\\\"# PROJECT_HANDOFF.md (для нового чата)\\\\n\\\\n## §0. Принцип качества (неоспоримый)\\\\n\\\\n1. Расширение соответствует стандартам: Chrome MV3 best practices; программные политики Chrome Web Store как эталон качества (дистрибуция — GitHub Releases); надёжность перехватчиков (исключение внутри враппера не должно ломать хост-страницу); privacy-гигиена (нет innerHTML с контентом чата, ключи только в chrome.storage, тихая консоль без гейта aiCmDebug); тестируемость (каждый фикс — R-D пины на каждый путь записи базы и точку выхода).\\\\n2. Реализация, рецензия и приёмка — уровень senior и выше: нет фикса без корня; нет коммита без зелёной Chrome-проверки; нет релиза без зелёного сьюта и RELEASE_CHECKLIST; каждое отклонение от стандартов фиксируется в docs/QUALITY_AUDIT.md с ID и приоритетом P0/P1/P2 и либо чинится, либо осознанно принимается владельцем.\\\\n3. Действие: на старте сессии — из настоящего handoff; на каждом шаге — строкой контекст-переноса промпта кодеру; на релизе — гейтом RELEASE_CHECKLIST.md. Обновляющие блоки handoff могут перекрывать строки очереди и релизов, но не §0.\\\\n\\\\n## Обновление 2026-09-19 (v2.0.10 опубликован; голова очереди — O-35 универсальный SSE-парсер)\\\\nПерекрывает конфликтующие места блоков ниже (включая строки релиза и очереди предыдущих обновлений):\\\\n- HEAD: этот docs-коммит (поверх `083caa7` docs с тегом `v2.0.10` → `e080313` release v2.0.10). Рабочая копия чиста.\\\\n- Релиз v2.0.10 опубликован: GitHub Release на теге `v2.0.10` (`083caa7`), Release ZIP #13 зелёный (13s), asset ai-context-monitor-v2.0.10.zip 2.64 MB (sha256 b40297640d18d985cc2e7773fcc…); Lint #32 (`e080313`) и #33 (`083caa7`) зелёные.\\\\n- Очередь (решение владельца 2026-09-19): голова — O-35 (универсальный SSE-парсер с автодетектом провайдера + провайдер Qwen; источник спецификации и готовый stream-analyzer.js — экспорт чата ai-context-monitor-deepseek-DeepSeek-R1-2026-09-18-17-53.txt: эндпоинты /api/v2/chats/new и /api/v2/chat/completions?chat_id=, SSE-фазы thinking_summary/answer, usage кумулятивный, антибот bx-ua только на /chats/new); далее O-23 (F5: калибровка tokens~ против serverTokens, Medium), O-24, O-34 (Low); хвост: O-29 → O-32 → O-21 (малоактуальна).\\\\n- Спецификация O-23 (F5) зафиксирована: расхождение tokens~ с serverTokens на чистом payload без соседей (недооценка Δ=-67 при serverTokens=78; переоценка Δ=+1902 при 1176 на русском тексте); воспроизведение — контрольный прогон B1, DeepSeek++ выкл; замер — парные значения в badge-recv/badge-update; ожидание — уточнение семантики и калибровка эвристики (критична для платформ без серверного usage); приоритет Medium.\\\\n- Подход O-35: начать с read-only инспекции точек SSE-парсинга шести перехватчиков и маппинга на адаптеры stream-analyzer.js; реализация — только после отчёта инспекции и плана интеграции с R-пинами на все 6 платформ и живой приёмкой на Qwen (usage input/output/reasoning из стрима).\\\\n\\\\n## Обновление 2026-09-19 (релизная пачка 2.0.10 собрана; тег v2.0.10 на этом docs-коммите)\\\\nПерекрывает конфликтующие места блоков ниже (включая строки релиза предыдущих обновлений):\\\\n- HEAD: этот docs-коммит (поверх `e080313` release v2.0.10 → `89201e6` fix O-22 → `558e832` docs O-22). Рабочая копия чиста после коммита.\\\\n- Релизная пачка 2.0.10: состав 11 трекаемых файлов (manifest/package 2.0.10, CHANGELOG [2.0.10] Fixed с O-14 и O-22, футер docs/index.html, 7 версионных пинов) + 2 untracked на диске (package-lock.json, tools/edge-listing-metadata.txt); сьют 93/1616/6 (число тестов не изменилось).\\\\n- Отклонения от промпта релизного бампа: (а) три негативных ассерта version-hygiene переведены с not.toContain('2.0.1') на regex 2\\\\\\\\.0\\\\\\\\.1(?!\\\\\\\\d) из-за префиксной коллизии 2.0.1 внутри 2.0.10 — смысл сохранён (lookahead не матчит 2.0.10), логика пинов не менялась; (б) мок-литерал 2.0.10 в tests/o14-reset-popup-snapshot.test.js:223 оставлен для согласованности (мок песочницы, не пин релизной версии).\\\\n- Тег v2.0.10: первоначально создан на `e080313` (отступление от конвенции «тег на верхнем docs-коммите пачки»); переставлен на этот docs-коммит через `git tag -f` + `git push origin -f v2.0.10` (восстановление конвенции).\\\\n- GitHub Release v2.0.10: шаг владельца (создать релиз на теге v2.0.10; Release ZIP workflow соберёт asset автоматически).\\\\n- Очередь: голова — O-23; далее O-24; O-34 (Low); хвост: O-29 → O-32 → O-21 (малоактуальна).\\\\n\\\\n## Обновление 2026-09-19 (O-22 закрыта в main; голова очереди — O-23)\\\\nПерекрывает конфликтующие места блоков ниже (включая строки очереди предыдущих обновлений):\\\\n- HEAD: этот docs-коммит (поверх `89201e6` fix O-22 → `27df84a` измерение-2 → `f201957` инструментирование O-22 → `d237c51` docs очереди). Рабочая копия чиста после коммита.\\\\n- O-22 ЗАКРЫТА в main: источник F4 = сайт S1172 (deepseek-intercept.js) — тройной диспатч ai-cm-full-history с идентичным payload за ~10 мс на записи нового хода (живой лог 2026-09-18 21:31:12); фикс `89201e6` — payload-точный гард в emitBaseSnapshot (сигнатура по всем полям detail, сброс на смене convId и ai-cm-conversation-changed), 10 R-D пинов tests/adapters/deepseek-o22-dispatch-dedupe.test.js, сьют 93/1616/6.\\\\n- Живая приёмка 2026-09-19 11:46–11:51 (DeepSeek, DeepSeek++ выкл, оба гейта ВКЛ, сборка 89201e6): запись нового хода 11:49:05 — 3 MAIN-диспатча S1172 (.318/.323/.324), но ровно 1 svc-emit/badge-recv/listener-entry и 2 o22-dispatch-skip (sig d1aa2b); загрузка 11:48:33 и SPA-смена 11:49:15 — одиночные диспатчи прежние, гард сброшен на смене (write с lastKey=(нет)); SW: все 3 записи win100ms=1. Критерий провала (тройной svc-emit/badge за 4–7 мс) не реализовался.\\\\n- Границы: кандидат (b) (deferred-flush) не упражнялся ни в одном из 4 прогонов (ноль строк o22-deferred-flush) — за границей закрытия; маркер o22-call725 печатает src= пусто (дефект aiCmDiagStack(2)) — закрыт как неблокирующий (сопоставление по ts); инструментирование O-22 и измереия-2 остаётся в main под гейтом как источник пинов.\\\\n- Очередь: голова — O-23; далее O-24; O-34 (Low); хвост: O-29 → O-32 → O-21 (малоактуальна).\\\\n- Релиз: O-14 и O-22 входят в следующую релизную пачку (номер версии и CHANGELOG-секция — только в релизном коммите, конвенция); тег v2.0.9 не переставляется.\\\\n- Служебное: в этом же коммите — конвенция «Промпт кодеру» (строка 144): промпт = один блок из четырёх обратных кавычек, вложенные тройные оградки запрещены (инцидент 2026-09-18).\\\\n\\\\n## Обновление 2026-09-18 (очередь: O-21 перенесена в хвост решением владельца; голова — O-22)\\\\nПерекрывает конфликтующие места блоков ниже (включая строки очереди предыдущего обновления):\\\\n- Решение владельца 2026-09-18: O-21 (F3: усечение DOM-экстрактора DeepSeek msgs=3 при сетевых msgs=6 под соседом DeepSeek++) перенесена в хвост очереди как малоактуальная; живые артефакты F3 не сохранились (владелец удаляет файлы прогонов с Desktop несколько раз в день), механизм — неподтверждённая гипотеза; промпт инспекции O-21 отозван, сессия DSH не заказывалась.\\\\n- Открытая очередь: O-22 (голова) → O-23 → O-24; O-34 (Low); хвост: O-29 → O-32 → O-21 (малоактуальна).\\\\n- Уточнение конвенции «Окружение кодера»: файлы живых прогонов на `C:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop` регулярно удаляются владельцем; отсутствие артефактов — дефолтное допущение; DSH начинает поиск с Desktop только при подтверждении владельца, что файлы конкретного прогона живы.\\\\n- Голова O-22: спецификации в PROJECT_HANDOFF.md нет (только групповая строка O-21…O-24) — работа начнётся после спецификации от владельца либо решением владельца переходом к следующему пункту со спецификацией (O-34 / O-29).\\\\n\\\\n## Обновление 2026-09-18 (O-14 закрыта в main; голова очереди — O-21)\\\\nПерекрывает конфликтующие места блоков ниже (включая предыдущее обновление и «Состояние проекта»):\\\\n- HEAD: этот docs-коммит (поверх `2ed8d7f` fix O-14 → `6f7a37e` docs с битой кодировкой → `e2a6acb` test-хотфикс R2 → `377aab9` docs, тег `v2.0.9`).\\n...[truncated]\",",   // строка 22 из 26
  "    \"truncated\": true",   // строка 23 из 26
  "  }",   // строка 24 из 26
  "]",   // строка 25 из 26
  "</tool_results>"   // строка 26 из 26
].join('\n');

// Конверт-ход, msg 7: проза 1-9, эхо задачи 11-17, tool_results 19-31 (закрывающий тег — последняя строка).
const ENV_MSG7 = [
  "These are the tool results just executed for the tool-continuation task. Continue like a real agent, using the original task and these tool results to move the work forward.",   // строка 1 из 31
  "If the results are enough, output the final answer. Only call more tools when more information, verification, or file changes are truly needed.",   // строка 2 из 31
  "Do not ask the user to click continue, and do not output pseudo tool-call JSON. When more action is needed, output only executable XML tool tags. Deliver files, HTML pages, and charts as Markdown fenced code blocks (e.g. ```html, ```xychart-beta, ```mermaid) so the page renders them natively; never use artifact XML tags.",   // строка 3 из 31
  "When emitting a ```xychart-beta fence, its body must use native Mermaid XY Chart syntax directly. Valid body example:",   // строка 4 из 31
  "title \"ARR\"",   // строка 5 из 31
  "x-axis [\"2024-01\", \"2024-02\"]",   // строка 6 из 31
  "y-axis \"ARR ($B)\" 0 --> 50",   // строка 7 из 31
  "line [1, 2]",   // строка 8 из 31
  "You may use bar [...]. Do not use x-label, y-label, chart-type, data:, series:, xy ..., or a Markdown table as the chart body.",   // строка 9 из 31
  "",   // строка 10 из 31
  "<original_task>",   // строка 11 из 31
  "Жив ли файл экспорта на Desktop — да/нет - нет",   // строка 12 из 31
  "Экспорт чата …DeepSeek-R1-2026-09-18-17-53.txt  - отсутствует",   // строка 13 из 31
  "Какой перехватчик из семи вне области O-35 - не могу сказать.",   // строка 14 из 31
  "",   // строка 15 из 31
  "Проверь папку проекта повторно - добавил туда недостающие файлы.",   // строка 16 из 31
  "</original_task>",   // строка 17 из 31
  "",   // строка 18 из 31
  "<tool_results>",   // строка 19 из 31
  "[",   // строка 20 из 31
  "  {",   // строка 21 из 31
  "    \"tool\": \"shell_exec\",",   // строка 22 из 31
  "    \"provider\": \"Shell Local\",",   // строка 23 из 31
  "    \"ok\": true,",   // строка 24 из 31
  "    \"summary\": \"MCP 工具已执行\",",   // строка 25 из 31
  "    \"detail\": \"{\\n  \\\"ok\\\": true,\\n  \\\"data\\\": {\\n    \\\"command\\\": \\\"Get-ChildItem -LiteralPath \\\\\\\"C:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\" -File -Recurse | Select-Object -ExpandProperty FullName\\\",\\n    \\\"shell\\\": \\\"powershell.exe\\\",\\n    \\\"exitCode\\\": 0,\\n    \\\"signal\\\": null,\\n    \\\"stdout\\\": \\\"C:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\.gitattributes\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\.gitignore\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\ARCHITECTURE_STANDARDS.md\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\CHANGELOG.md\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\CLINE_PROMPT_RULES.md\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\CLINE_TEMPLATE.md\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\DHS_RULES.md\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\INSTRUCTIONS.md\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\LICENSE\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\manifest.json\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\package-lock.json\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\package.json\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\PROJECT_HANDOFF.md\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\README.md\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\RELEASE_CHECKLIST.md\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\RELEASE_PROTOCOL.md\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\test_write.txt\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\.github\\\\\\\\workflows\\\\\\\\lint.yml\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\.github\\\\\\\\workflows\\\\\\\\release.yml\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\.vscode\\\\\\\\settings.json\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\adapters\\\\\\\\base-adapter.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\adapters\\\\\\\\chatgpt-adapter.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\adapters\\\\\\\\claude-adapter.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\adapters\\\\\\\\deepseek-adapter.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\adapters\\\\\\\\gemini-adapter.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\adapters\\\\\\\\google-search-adapter.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\adapters\\\\\\\\perplexity-adapter.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\adapters\\\\\\\\qwen-adapter.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\background.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\base-handler.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\claude-intercept.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\content.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\deepseek-intercept.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\export-manager.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\gemini-hidden-scroll.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\gemini-intercept.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\google-search-intercept.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\hybrid-tail.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\page-intercept.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\perplexity-intercept.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\qwen-intercept.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\state.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\D\\n...[truncated]\",",   // строка 26 из 31
  "    \"output\": \"{\\\"ok\\\":true,\\\"data\\\":{\\\"command\\\":\\\"Get-ChildItem -LiteralPath \\\\\\\"C:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\" -File -Recurse | Select-Object -ExpandProperty FullName\\\",\\\"shell\\\":\\\"powershell.exe\\\",\\\"exitCode\\\":0,\\\"signal\\\":null,\\\"stdout\\\":\\\"C:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\.gitattributes\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\.gitignore\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\ARCHITECTURE_STANDARDS.md\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\CHANGELOG.md\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\CLINE_PROMPT_RULES.md\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\CLINE_TEMPLATE.md\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\DHS_RULES.md\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\INSTRUCTIONS.md\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\LICENSE\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\manifest.json\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\package-lock.json\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\package.json\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\PROJECT_HANDOFF.md\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\README.md\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\RELEASE_CHECKLIST.md\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\RELEASE_PROTOCOL.md\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\test_write.txt\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\.github\\\\\\\\workflows\\\\\\\\lint.yml\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\.github\\\\\\\\workflows\\\\\\\\release.yml\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\.vscode\\\\\\\\settings.json\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\adapters\\\\\\\\base-adapter.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\adapters\\\\\\\\chatgpt-adapter.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\adapters\\\\\\\\claude-adapter.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\adapters\\\\\\\\deepseek-adapter.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\adapters\\\\\\\\gemini-adapter.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\adapters\\\\\\\\google-search-adapter.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\adapters\\\\\\\\perplexity-adapter.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\adapters\\\\\\\\qwen-adapter.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\background.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\base-handler.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\claude-intercept.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\content.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\deepseek-intercept.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\export-manager.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\gemini-hidden-scroll.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\gemini-intercept.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\google-search-intercept.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\hybrid-tail.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\page-intercept.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\perplexity-intercept.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\qwen-intercept.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\state.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\core\\\\\\\\widget.js\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\docs\\\\\\\\AUDIT.md\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\docs\\\\\\\\CLINE_TEMPLATE.md\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\docs\\\\\\\\context-transfer-template.md\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\docs\\\\\\\\index.html\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\docs\\\\\\\\QUALITY_AUDIT.md\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\docs\\\\\\\\TESTS.md\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\docs\\\\\\\\screenshots\\\\\\\\chatgpt-red.png\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\docs\\\\\\\\screenshots\\\\\\\\claude.png\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\docs\\\\\\\\screenshots\\\\\\\\gemini-yellow.png\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\docs\\\\\\\\screenshots\\\\\\\\google-search-popup.png\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\docs\\\\\\\\screenshots\\\\\\\\perplexity.png\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\icons\\\\\\\\icon128.png\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\icons\\\\\\\\icon16.png\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\icons\\\\\\\\icon48.png\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\node_modules\\\\\\\\.package-lock.json\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\node_modules\\\\\\\\.bin\\\\\\\\acorn\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\node_modules\\\\\\\\.bin\\\\\\\\acorn.cmd\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\node_modules\\\\\\\\.bin\\\\\\\\acorn.ps1\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\node_modules\\\\\\\\.bin\\\\\\\\baseline-browser-mapping\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\node_modules\\\\\\\\.bin\\\\\\\\baseline-browser-mapping.cmd\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\node_modules\\\\\\\\.bin\\\\\\\\baseline-browser-mapping.ps1\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\node_modules\\\\\\\\.bin\\\\\\\\browserslist\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\node_modules\\\\\\\\.bin\\\\\\\\browserslist.cmd\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\node_modules\\\\\\\\.bin\\\\\\\\browserslist.ps1\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\node_modules\\\\\\\\.bin\\\\\\\\create-jest\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\node_modules\\\\\\\\.bin\\\\\\\\create-jest.cmd\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\node_modules\\\\\\\\.bin\\\\\\\\create-jest.ps1\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\node_modules\\\\\\\\.bin\\\\\\\\escodegen\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\node_modules\\\\\\\\.bin\\\\\\\\escodegen.cmd\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\node_modules\\\\\\\\.bin\\\\\\\\escodegen.ps1\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\node_modules\\\\\\\\.bin\\\\\\\\esgenerate\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\node_modules\\\\\\\\.bin\\\\\\\\esgenerate.cmd\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\node_modules\\\\\\\\.bin\\\\\\\\esgenerate.ps1\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\node_modules\\\\\\\\.bin\\\\\\\\esparse\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\node_modules\\\\\\\\.bin\\\\\\\\esparse.cmd\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\node_modules\\\\\\\\.bin\\\\\\\\esparse.ps1\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\node_modules\\\\\\\\.bin\\\\\\\\esvalidate\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\node_modules\\\\\\\\.bin\\\\\\\\esvalidate.cmd\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\node_modules\\\\\\\\.bin\\\\\\\\esvalidate.ps1\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\node_modules\\\\\\\\.bin\\\\\\\\import-local-fixture\\\\r\\\\nC:\\\\\\\\Users\\\\\\\\oleg\\\\\\\\Desktop\\\\\\\\Prompts\\\\\\\\ai-context-monitor-v2.0.10\\\\\\\\no\\n...[truncated]\",",   // строка 27 из 31
  "    \"truncated\": true",   // строка 28 из 31
  "  }",   // строка 29 из 31
  "]",   // строка 30 из 31
  "</tool_results>"   // строка 31 из 31
].join('\n');

// Пять блоков запроса тула (форма A): msg 1/3/9/11/13, строки 1-3. Полезная нагрузка измерена
// как ПЕРЕМЕННАЯ (max_chars 40000/20000/12000/16000; "start": 40000 — только в msg 3), поэтому
// опора дескриптора — строки тегов, а не тело.
const LFR_BLOCKS = [LFR_MSG1, LFR_MSG3, LFR_MSG9, LFR_MSG11, LFR_MSG13];

// Конверт-ходы: msg 2 (пустая пара original_task) и msg 7 (эхо задачи) — целые сообщения артефакта.
// msg 4 побайтово несёт те же опорные строки, что msg 2 (проза 1-9 + пустая пара 11-12);
// msg 8/10/12/14 — те же строки прозы 1-9 и пары 11-17, что msg 7 (различаются только тела
// tool_results — форма D опирается на строки тегов). Поэтому в массиве-счётчике они
// представлены теми же фикстурами, а счёт форм сверяется с измеренными числами артефакта.
const ENV_EMPTY = ENV_MSG2;
const ENV_FILLED = ENV_MSG7;

// Измеренные числа вхождений по артефакту 10-19 (5+7+7+7 = 26; пустых пар original_task — 2).
const ARTIFACT_OCCURRENCES = {
  'tc-local-file-read': 5,
  'tc-prose-continuation': 7,
  'tc-original-task': 7,
  'tc-tool-results': 7
};
const ARTIFACT_EMPTY_TASK_PAIRS = 2;
const ARTIFACT_LFR_SPANS = 0;                  // спанов формы A в артефакте нет
const ARTIFACT_TOTAL = 26;
const ARTIFACT_MESSAGES = 12;                  // 5 запросов тула + 7 конверт-ходов

const F = P.toolContinuationForms;
const ID_LFR = 'tc-local-file-read';
const ID_PROSE = 'tc-prose-continuation';
const ID_TASK = 'tc-original-task';
const ID_RESULTS = 'tc-tool-results';

/** 12 измеренных сообщений (5 целых запросов тула + 7 целых конверт-ходов). */
function measuredMessages() {
  const out = [];
  LFR_BLOCKS.forEach((text, i) => out.push({ role: 'assistant', text: text, id: 'lfr-' + i }));
  out.push({ role: 'user', text: ENV_EMPTY, id: 'env-msg2' });     // msg 2, пустая пара
  out.push({ role: 'user', text: ENV_EMPTY, id: 'env-msg4' });     // msg 4, те же опоры
  ['msg7', 'msg8', 'msg10', 'msg12', 'msg14'].forEach((tag) => {
    out.push({ role: 'user', text: ENV_FILLED, id: 'env-' + tag });
  });
  return out;
}

/** Тело функции пайплайна по имени (source-пины точки и порядка). */
function fnBody(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return '';
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return '';
}

// Канонический гейт диагностики: РЕАЛЬНЫЕ aiCmDiagOn/aiCmDiagLine из utils/debug.js (как в
// контент-скрипте) — для пина «байты выхода при гейте вкл/выкл идентичны» и «O-42 молчит».
const DIAG_PREFIX = '[AI CM][diag] ';
const DEBUG_API = new Function(
  fnBody(DEBUG_SRC, 'aiCmDiagOn') + '\n' +
  fnBody(DEBUG_SRC, 'aiCmDiagLine') + '\n' +
  ' return { on: aiCmDiagOn, line: aiCmDiagLine };')();

beforeAll(() => {
  global.aiCmDiagOn = DEBUG_API.on;
  global.aiCmDiagLine = DEBUG_API.line;
});

afterAll(() => {
  try { delete global.aiCmDiagOn; } catch (e1) { }
  try { delete global.aiCmDiagLine; } catch (e2) { }
});

/** Пять прочих платформ: тексты без форм конверта и без инъекций соседей (байтово прежние). */
const OTHER_PLATFORMS = [
  { role: 'user', text: 'ChatGPT: обычный вопрос без служебных блоков.', id: 'gpt-u' },
  { role: 'assistant', text: 'ChatGPT: обычный ответ.', id: 'gpt-a' },
  { role: 'user', text: 'Gemini: вопрос про <original_task> как СЛОВО в прозе, не строкой.', id: 'gem-u' },
  { role: 'assistant', text: 'Gemini: ответ.', id: 'gem-a' },
  { role: 'user', text: 'GSA: поисковый запрос.', id: 'gsa-u' },
  { role: 'user', text: 'Claude: вопрос без тегов.', id: 'claude-u' },
  { role: 'user', text: 'Perplexity: вопрос без тегов.', id: 'pplx-u' }
];

// =====================================================================================
// O-40 (F1-F6 + F3-обёртка): те же опоры, что в tests/deepseek-o40-… — O-42 их не касается
// =====================================================================================
const BDS_OPEN = '<BetterDeepSeek>';
const BDS_CLOSE = '</BetterDeepSeek>';
const DEEP_CODE_HEAD = '[DEEP_CODE_MODE_ACTIVE]';
const TOOL_PROMPT_HEAD = 'You are Better DeepSeek. You have access to specialized tools.';
const DATETIME_HEAD = "User's System Date & Time: ";
const USER_PROMPT = [
  'ИНСТРУКЦИЯ ДЛЯ ИИ-АРХИТЕКТОРА (ПРОТОКОЛ ПРАВДЫ)',
  'Ты — ведущий архитектор и аудитор проекта ai-context-monitor.'
].join('\n');
const F1 = BDS_OPEN + '\n' + DEEP_CODE_HEAD + '\nDeepCode mode is ENABLED.\n' + BDS_CLOSE;
const F2 = BDS_OPEN + '\n' + TOOL_PROMPT_HEAD + '\nThe system prompt has ended. User prompt:\n' + BDS_CLOSE;
const F3 = BDS_OPEN + '\n' + USER_PROMPT + '\n' + BDS_CLOSE;
const F4 = BDS_OPEN + '\n' + DATETIME_HEAD + '19.09.2026, 20:40:27\n' + BDS_CLOSE;
const F5 = '<original_task>\n' + BDS_OPEN + '\n' + DEEP_CODE_HEAD + '\n...[truncated]\n</original_task>';
const F6 = '<original_task>\n' + BDS_OPEN + '\n' + DEEP_CODE_HEAD + '\n...[truncated]\n</original_task>';
const ORIGINAL_TASK_SHELL = '<original_task>\n</original_task>';
const F7_HEAD = 'Мой вопрос перед инъекцией.';
const F7_TAIL = '<local_file_read>\n' +
  '{"path": "C:/Users/oleg/Desktop/Prompts/ai-context-monitor-clean/PROJECT_HANDOFF.md", "max_chars": 40000}\n' +
  '</local_file_read>';
const F7 = F7_HEAD + '\n' + F3 + '\n' + F7_TAIL;
const F7_EXPECT = F7_HEAD + '\n' + USER_PROMPT + '\n' + F7_TAIL;

const O20_START = '<!-- deepseek-pp-visible-user-prompt:start -->';
const O20_END = '<!-- deepseek-pp-visible-user-prompt:end -->';
const O20_VISIBLE = 'O-20: в экспорте виден только мой текст.';
const O20_TEXT = 'преамбула DeepSeek++\n' + O20_START + '\n' + O20_VISIBLE + '\n' + O20_END;

// =====================================================================================
// (D) D-ПИНЫ: измеренные формы конверта — вон из экспорта
// =====================================================================================
describe('O-42 (D): измеренные формы агентного конверта', () => {
  test('таблица измеренных дескрипторов: 4 формы конверта, опоры и правила границ', () => {
    expect(F.map((f) => f.id)).toEqual([ID_LFR, ID_PROSE, ID_TASK, ID_RESULTS]);
    F.forEach((f) => {
      expect(typeof f.boundary).toBe('string');
      expect(f.boundary.length).toBeGreaterThan(0);
      expect(typeof f.basis).toBe('string');
      expect(f.basis.indexOf('artifact 10-19')).toBe(0);            // основание — номера строк артефакта
    });
    expect(F[0].open).toBe('<local_file_read>');
    expect(F[0].close).toBe('</local_file_read>');
    expect(F[1].openPrefix).toBe('These are the tool results just executed for the tool-continuation task.');
    expect(F[2].open).toBe('<original_task>');
    expect(F[2].close).toBe('</original_task>');
    expect(F[3].open).toBe('<tool_results>');
    expect(F[3].close).toBe('</tool_results>');
    // измеренные числа вхождений: 5 / 7 / 7 / 7 = 26
    expect(Object.keys(ARTIFACT_OCCURRENCES)).toEqual(F.map((f) => f.id));
    expect(ARTIFACT_OCCURRENCES[ID_LFR] + ARTIFACT_OCCURRENCES[ID_PROSE] +
      ARTIFACT_OCCURRENCES[ID_TASK] + ARTIFACT_OCCURRENCES[ID_RESULTS]).toBe(ARTIFACT_TOTAL);
    expect(ARTIFACT_EMPTY_TASK_PAIRS).toBe(2);
    expect(ARTIFACT_LFR_SPANS).toBe(0);
  });

  test('пустая пара original_task — измеренная граница: теги строками 11-12 артефакта', () => {
    expect(ENV_EMPTY.split('\n')[10]).toBe('<original_task>');     // строка 11 сообщения
    expect(ENV_EMPTY.split('\n')[11]).toBe('</original_task>');    // строка 12 сообщения
    expect(ENV_EMPTY.indexOf('<original_task>\n</original_task>')).not.toBe(-1);
    const empty = P.sanitizeToolContinuationText(ENV_EMPTY);
    expect(empty.forms).toContain(ID_TASK);                        // пустая пара снята
  });

  test('граница формы D: закрывающий тег — последняя строка сообщения (незакрытых нет)', () => {
    const lines = ENV_EMPTY.split('\n');
    expect(lines[lines.length - 1]).toBe('</tool_results>');
    expect(lines[13]).toBe('<tool_results>');                      // строка 14 сообщения
    expect(lines.indexOf('<tool_results>')).toBeGreaterThan(lines.indexOf('</original_task>'));
    const filled = ENV_FILLED.split('\n');
    expect(filled[filled.length - 1]).toBe('</tool_results>');
  });

  test.each(LFR_BLOCKS.map((b, i) => [i, b]))(
    'D-A: запрос тула #%i (целое сообщение артефакта) — снят целиком, вырезка одна',
    (i, block) => {
      const r = P.sanitizeToolContinuationText(block);
      expect(r.removed).toBe(1);
      expect(r.forms).toEqual([ID_LFR]);
      expect(r.text).toBe('');                                     // целое сообщение → пусто → S5
      // и через массив сообщений (роль ассистента — как в артефакте)
      const res = P.sanitizeEmitMessages([{ role: 'assistant', text: block, id: 'x' }]);
      expect(res.messages).toEqual([]);
      expect(res.dropped).toBe(1);
      expect(res.tcRemoved).toBe(1);
      expect(res.tcForms).toEqual([ID_LFR]);
      expect(P.sanitizeToolContinuationText(r.text).removed).toBe(0);   // идемпотентность
    }
  );

  test('D-A-R: спан запроса тула внутри сообщения — БАЙТОВО (измерения спана в артефакте нет)', () => {
    const span = 'Перед запросом.\n' + LFR_MSG1 + '\nПосле запроса.';
    const r = P.sanitizeToolContinuationText(span);
    expect(r.removed).toBe(0);
    expect(r.text).toBe(span);                                     // тот же текст, байтово
    // и роль значения не имеет: замороженные пины F7 (user 1747 / assistant 2008) и
    // tests/o40-f3-diag-…:474 держат ровно этот хвост
    const viaUser = P.sanitizeEmitMessages([{ role: 'user', text: span, id: 'u' }]);
    const viaAssistant = P.sanitizeEmitMessages([{ role: 'assistant', text: span, id: 'a' }]);
    expect(viaUser.messages[0].text).toBe(span);
    expect(viaAssistant.messages[0].text).toBe(span);
    expect(viaUser.tcRemoved).toBe(0);
    expect(viaAssistant.tcRemoved).toBe(0);
  });

  test('D-B/D-C/D-D: проза-блок, эхо задачи и результаты — целый конверт-ход снят', () => {
    const r = P.sanitizeToolContinuationText(ENV_FILLED);
    expect(r.removed).toBe(3);
    expect(r.forms).toEqual([ID_PROSE, ID_TASK, ID_RESULTS]);
    expect(r.text).toBe('');
    const res = P.sanitizeEmitMessages([{ role: 'user', text: ENV_FILLED, id: 'env' }]);
    expect(res.messages).toEqual([]);                              // целое сообщение → S5
    expect(res.dropped).toBe(1);
    expect(res.tcRemoved).toBe(3);
    expect(res.tcForms).toEqual([ID_PROSE, ID_TASK, ID_RESULTS]);
    expect(JSON.stringify(res)).not.toContain('<tool_results>');
    expect(JSON.stringify(res)).not.toContain('<original_task>');
    expect(JSON.stringify(res)).not.toContain('These are the tool results just executed');
  });

  test('D-B/D-C/D-D спан: конверт внутри сообщения — снят ТОЛЬКО конверт, текст вокруг байтово', () => {
    const span = 'Перед конвертом.\n' + ENV_EMPTY + '\nПосле конверта.';
    const r = P.sanitizeToolContinuationText(span);
    expect(r.removed).toBe(3);
    expect(r.forms).toEqual([ID_PROSE, ID_TASK, ID_RESULTS]);
    expect(r.text).toBe('Перед конвертом.\nПосле конверта.');     // окружающий текст байтово
    expect(r.text.slice(0, 'Перед конвертом.'.length)).toBe('Перед конвертом.');
    expect(r.text.slice(-'После конверта.'.length)).toBe('После конверта.');
    const res = P.sanitizeEmitMessages([{ role: 'user', text: span, id: 'span' }]);
    expect(res.messages[0].text).toBe(r.text);
    expect(res.dropped).toBe(0);                                   // текст вокруг не пуст
    expect(res.tcRemoved).toBe(3);
  });

  test('D-E: счёт вырезок = числу вхождений: 12 измеренных сообщений — 26 вырезок 5/7/7/7', () => {
    const src = measuredMessages();
    expect(src.length).toBe(ARTIFACT_MESSAGES);
    const res = P.sanitizeEmitMessages(src);
    expect(res.tcRemoved).toBe(ARTIFACT_TOTAL);
    const counts = {};
    res.tcForms.forEach((id) => { counts[id] = (counts[id] || 0) + 1; });
    expect(counts).toEqual(ARTIFACT_OCCURRENCES);
    expect(res.messages).toEqual([]);                              // все 12 — машинные ходы
    expect(res.dropped).toBe(ARTIFACT_MESSAGES);
    expect(res.bdsRemoved).toBe(0);                                // конверт — не инъекции BDS
  });

  test('D-F: конверт внутри сообщения с реальным текстом: пользовательский текст сохранён', () => {
    const text = 'Мой настоящий вопрос.\n' + ENV_FILLED + '\nИ ещё строка вопроса.';
    const res = P.sanitizeEmitMessages([{ role: 'user', text: text, id: 'real' }]);
    expect(res.messages.length).toBe(1);
    expect(res.messages[0].text).toBe('Мой настоящий вопрос.\nИ ещё строка вопроса.');
    expect(res.tcRemoved).toBe(3);
  });

  test('D-G: незакрытая пара — границы нет, текст не трогаем (не угадываем)', () => {
    const unclosedResults = ENV_FILLED.split('\n').slice(0, -1).join('\n');   // без '</tool_results>'
    const r1 = P.sanitizeToolContinuationText(unclosedResults);
    expect(r1.forms).toEqual([ID_PROSE, ID_TASK]);                 // результатов нет — границы нет
    expect(r1.text).not.toContain('<original_task>');
    const unclosedLfr = LFR_MSG1.split('\n').slice(0, -1).join('\n');
    const r2 = P.sanitizeToolContinuationText(unclosedLfr);
    expect(r2.removed).toBe(0);
    expect(r2.text).toBe(unclosedLfr);
  });
});

// =====================================================================================
// (R) R-ПИНЫ: байтовые регрессии
// =====================================================================================
describe('O-42 (R): байтовые регрессии', () => {
  test('R1: F1-F4 и F3-обёртка (O-40) — поведение прежнее', () => {
    expect(P.sanitizeBetterDeepSeekText(F1)).toEqual({ text: '', removed: 1, forms: ['bds-deep-code-prompt'] });
    expect(P.sanitizeBetterDeepSeekText(F2)).toEqual({ text: '', removed: 1, forms: ['bds-tool-system-prompt'] });
    expect(P.sanitizeBetterDeepSeekText(F3)).toEqual({ text: USER_PROMPT, removed: 1, forms: ['bds-prompt-wrapper'] });
    expect(P.sanitizeBetterDeepSeekText(F4)).toEqual({ text: '', removed: 1, forms: ['bds-system-datetime'] });
  });

  test('R2: F5/F6 — конверт <original_task> вокруг спана: O-42 не трогает (нет якоря прозы)', () => {
    [F5, F6].forEach((f) => {
      const r = P.sanitizeBetterDeepSeekText(f);
      expect(r.text).toBe(ORIGINAL_TASK_SHELL);
      expect(P.sanitizeToolContinuationText(r.text).removed).toBe(0);   // пустая пара вне конверта
    });
    const res = P.sanitizeEmitMessages([
      { role: 'user', text: F5, id: 'u-f5' },
      { role: 'user', text: F6, id: 'u-f6' }
    ]);
    expect(res.messages.map((m) => m.id)).toEqual(['u-f5', 'u-f6']);
    expect(res.messages.map((m) => m.text)).toEqual([ORIGINAL_TASK_SHELL, ORIGINAL_TASK_SHELL]);
    expect(res.tcRemoved).toBe(0);
    expect(res.bdsRemoved).toBe(2);
  });

  test('R3: F7 (хвост-запрос тула внутри сообщения) — байты прежние в user и assistant роли', () => {
    expect(P.sanitizeToolContinuationText(F7).text).toBe(F7);
    expect(P.sanitizeToolContinuationText(F7_EXPECT).text).toBe(F7_EXPECT);
    const res = P.sanitizeEmitMessages([
      { role: 'user', text: F7, id: 'u-f7' },
      { role: 'assistant', text: F7, id: 'a-f7' }
    ]);
    expect(res.messages.map((m) => m.text)).toEqual([F7_EXPECT, F7_EXPECT]);
    expect(res.bdsRemoved).toBe(2);
    expect(res.tcRemoved).toBe(0);
    expect(res.messages[0].text).toContain(F7_TAIL);               // хвост '<local_file_read>' жив
  });

  test('R4: легитимный текст пользователя — байтово; тег, упомянутый в прозе, не форма', () => {
    const legit = [
      { role: 'user', text: 'Привет! Как дела?', id: 'u1' },
      { role: 'assistant', text: 'Всё хорошо.', id: 'a1' },
      { role: 'user', text: 'В инструкции есть тег <local_file_read> и слово original_task.', id: 'u2' },
      { role: 'user', text: 'Строка <tool_results> без пары', id: 'u3' }
    ];
    const res = P.sanitizeEmitMessages(legit);
    expect(res.tcRemoved).toBe(0);
    expect(res.dropped).toBe(0);
    legit.forEach((m, i) => expect(res.messages[i]).toBe(m));      // те же объекты (байтово)
  });

  test('R5: пять прочих платформ — байты прежние', () => {
    const res = P.sanitizeEmitMessages(OTHER_PLATFORMS);
    expect(res.tcRemoved).toBe(0);
    expect(res.bdsRemoved).toBe(0);
    OTHER_PLATFORMS.forEach((m, i) => expect(res.messages[i]).toBe(m));
    expect(res.messages.map((m) => m.text)).toEqual(OTHER_PLATFORMS.map((m) => m.text));
  });

  test('R6: паритет O-20 — маркеры DeepSeek++ работают ровно как прежде', () => {
    const res = P.sanitizeEmitMessages([{ role: 'user', text: O20_TEXT, id: 'u20' }]);
    expect(res.sanitized).toBe(1);
    expect(res.messages[0].text).toBe(O20_VISIBLE);
    expect(res.tcRemoved).toBe(0);
    // порядок один: конверт внутри маркеров уходит на OFF-пути вместе с преамбулой
    const mixed = O20_START + '\n' + ENV_FILLED + '\n' + O20_VISIBLE + '\n' + O20_END;
    const res2 = P.sanitizeEmitMessages([{ role: 'user', text: mixed, id: 'u21' }]);
    expect(res2.tcRemoved).toBe(3);
    expect(res2.messages[0].text).toBe(O20_VISIBLE);
  });

  test('R7: паритет O-7 — секции [REASONING]/[ANSWER] урезаются ДО конверта', () => {
    const withSections = '[REASONING]\nдумаю\n\n[ANSWER]\n' + ENV_FILLED;
    expect(P.stripReasoningSections(withSections)).toBe(ENV_FILLED);
    const res = P.sanitizeEmitMessages([{ role: 'assistant', text: withSections, id: 'a1' }]);
    expect(res.messages).toEqual([]);                              // остался только конверт
    expect(res.tcRemoved).toBe(3);
    const plain = '[REASONING]\nдумаю\n\n[ANSWER]\nобычный ответ';
    const res2 = P.sanitizeEmitMessages([{ role: 'assistant', text: plain, id: 'a2' }]);
    expect(res2.messages[0].text).toBe('обычный ответ');
    expect(res2.tcRemoved).toBe(0);
  });

  test('R8: база и метрики не пересчитываются; входной массив не мутируется', () => {
    const src = measuredMessages().concat([{ role: 'user', text: 'Настоящий вопрос.', id: 'real' }]);
    const before = JSON.stringify(src);
    const res = P.sanitizeEmitMessages(src);
    expect(JSON.stringify(src)).toBe(before);                      // вход байтово прежний
    expect(res.messages.map((m) => m.text)).toEqual(['Настоящий вопрос.']);
    const hist = {
      host: 'chat.deepseek.com', convId: '565a7cd8', site: 'deepseek', model: 'DeepSeek R1',
      tokens: 105217, limit: 131072, percent: 82.2, messages: res.messages
    };
    const txt = Builders.buildTxtFromHistory(hist);
    const md = Builders.buildMdFromHistory(hist, 'DeepSeek R1');
    const js = Builders.buildJsonFromHistory(hist, 'DeepSeek R1');
    [txt, md, js].forEach((out) => {
      expect(out).not.toContain('<local_file_read>');
      expect(out).not.toContain('<original_task>');
      expect(out).not.toContain('<tool_results>');
      expect(out).not.toContain('These are the tool results just executed');
      expect(out).toContain('Настоящий вопрос.');
    });
    expect(js).toContain('"tokens": 105217');                      // метрики — из истории, не из конверта
    expect(js).toContain('"percent": 82.2');
    expect(hist.tokens).toBe(105217);                              // метрика не тронута
    expect(hist.percent).toBe(82.2);
  });

  test('R9: ON-путь (сырой режим) — конверт не трогается вовсе (байтово)', () => {
    const src = measuredMessages();
    expect(P.includeHiddenExportBlocks(src)).toEqual(src);
    const srcJson = JSON.stringify(src);
    expect(JSON.stringify(P.includeHiddenExportBlocks(src))).toBe(srcJson);
  });

  test('R10: диаг — только каноническим хелпером под гейтом; O-42 не печатает ничего', () => {
    const tags = [];
    const prevLine = global.aiCmDiagLine;
    const prevOn = global.aiCmDiagOn;
    global.aiCmDiagLine = function (tag) { tags.push(String(tag)); return true; };
    delete global.aiCmDiagOn;
    try {
      const envOnly = P.sanitizeEmitMessages([
        { role: 'user', text: ENV_FILLED, id: 'e' },
        { role: 'assistant', text: LFR_MSG1, id: 'l' }
      ]);
      expect(envOnly.tcRemoved).toBe(4);
      // ни одной строки O-42: теги только o40-emit-msg (O-40 печатает их безусловно)
      expect(tags.filter((t) => t.indexOf('o42') !== -1)).toEqual([]);
      expect(tags.every((t) => t === 'o40-emit-msg')).toBe(true);
      // байты выхода не зависят от наличия гейта/хелпера
      delete global.aiCmDiagLine;
      const quiet = P.sanitizeEmitMessages([
        { role: 'user', text: ENV_FILLED, id: 'e' },
        { role: 'assistant', text: LFR_MSG1, id: 'l' }
      ]);
      expect(JSON.stringify(quiet)).toBe(JSON.stringify(envOnly));
    } finally {
      if (prevLine === undefined) { try { delete global.aiCmDiagLine; } catch (e1) { } }
      else global.aiCmDiagLine = prevLine;
      if (prevOn === undefined) { try { delete global.aiCmDiagOn; } catch (e2) { } }
      else global.aiCmDiagOn = prevOn;
    }
  });

  test('R11: source-пины — та же точка, что O-20/O-40, ДО S5; своего вывода и chrome нет', () => {
    const body = fnBody(PIPELINE_SRC, 'sanitizeEmitMessages');
    const iO40 = body.indexOf('sanitizeBetterDeepSeekText(');
    const iO42 = body.indexOf('sanitizeToolContinuationText(');
    const iS4 = body.indexOf("m.role !== 'user'");
    const iS5 = body.indexOf('isEmptyExportText(');
    expect(iO40).toBeGreaterThan(-1);
    expect(iO42).toBeGreaterThan(iO40);                            // после O-40
    expect(iS4).toBeGreaterThan(iO42);                             // ... и до S4/S5
    expect(iS5).toBeGreaterThan(iO42);
    const o42 = fnBody(PIPELINE_SRC, 'sanitizeToolContinuationText');   // помощники — в блоке O-42
    expect(o42.length).toBeGreaterThan(0);
    const block = PIPELINE_SRC.slice(PIPELINE_SRC.indexOf('// O-42: АГЕНТНЫЙ КОНВЕРТ'),
      PIPELINE_SRC.indexOf('// O-7 (OFF): УРЕЗАНИЕ СЕКЦИЙ'));
    expect(block).not.toContain('console.');
    expect(block).not.toContain('aiCmDiagLine');
    expect(block).not.toContain('aiCmDiagOn');
    expect(block).not.toContain('chrome.');
    expect(block).not.toContain('document.');
    // своя ветка OFF/ON пайплайну не нужна: выбор делает core/export-manager.js по тому же ключу
    expect(fnBody(PIPELINE_SRC, 'sanitizeEmitMessages')).not.toContain('aiCmIncludeHiddenInExport');
    expect(P.toolContinuationForms.length).toBe(4);
  });

  test('R13: байты выхода при гейте aiCmDebug вкл/выкл идентичны; O-42 молчит и под гейтом', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => { });
    const gateOff = () => {
      try { window.sessionStorage.removeItem('aiCmDebug'); } catch (eS) { }
      try { delete window.__aiCmDebugLogs; } catch (eW) { }
    };
    const gateOn = () => { window.sessionStorage.setItem('aiCmDebug', '1'); };
    const msgs = () => measuredMessages().concat([{ role: 'user', text: 'Настоящий вопрос.', id: 'real' }]);
    const diag = () => spy.mock.calls.map((a) => String(a[0])).filter((s) => s.indexOf(DIAG_PREFIX) === 0);
    try {
      gateOff();
      const off = P.sanitizeEmitMessages(msgs());
      expect(diag()).toEqual([]);                                  // без гейта — ни одной строки
      const offBytes = JSON.stringify(off);
      spy.mockClear();
      gateOn();
      const on = P.sanitizeEmitMessages(msgs());
      const onLines = diag();
      expect(onLines.length).toBeGreaterThan(0);                    // O-40 под гейтом печатает
      expect(onLines.filter((s) => s.indexOf('o42') !== -1)).toEqual([]);   // O-42 — ни строки
      expect(JSON.stringify(on)).toBe(offBytes);                    // байты не зависят от гейта
      expect(on.tcRemoved).toBe(off.tcRemoved);
      expect(on.dropped).toBe(off.dropped);
      expect(on.tcForms).toEqual(off.tcForms);
    } finally { gateOff(); spy.mockRestore(); }
  });

  test('R12: тумблер не новый — тот же ключ и та же точка, что у O-7/O-20/O-40', () => {
    expect(OPTIONS_JS.split("'" + SETTING_KEY + "'").length - 1).toBe(2);   // get + set
    expect(OPTIONS_JS).toContain("chrome.storage.local.get(['" + SETTING_KEY + "']");
    expect(OPTIONS_JS).toContain('chrome.storage.local.set({ ' + SETTING_KEY + ': includeHiddenCheckbox.checked });');
    expect(OPTIONS_HTML).toContain('id="' + SETTING_KEY + '"');
    // подпись и справка говорят про ОБА соседних расширения (O-42: Better DeepSeek — сосед)
    expect(ru.options_export_hidden_label.message).toContain('Better DeepSeek');
    expect(ru.options_export_hidden_label.message).toContain('DeepSeek++');
    expect(ru.options_export_hidden_hint.message).toContain('Better DeepSeek');
    expect(ru.options_export_hidden_hint.message).toContain('DeepSeek++');
    expect(OPTIONS_HTML).toContain('data-i18n="options_export_hidden_label">' +
      ru.options_export_hidden_label.message + '</label>');
    expect(OPTIONS_HTML).toContain('data-i18n="options_export_hidden_hint">' +
      ru.options_export_hidden_hint.message + '</span>');
  });
});
