// Контракт связки core/gemini-oracle.js <-> core/gemini-intercept.js (Phase 3 Step 13.3).
//
// ЧТО ЭТО. Список имён ядра, которые перенесённый в core/gemini-oracle.js кластер оракула
// полноты читает и/или пишет. Блок `aiCmGeminiOracle.__bind({...})` в ядре строится ИМЕННО
// из этого массива, а tools/verify-oracle-extraction.js сверяет блок с массивом в обе
// стороны. Один источник правды: добавил имя в контракт — оно обязано появиться в блоке
// __bind, и наоборот.
//
// ПОЧЕМУ КОНТРАКТ ТАКОЙ ДЛИННЫЙ. Оракул — не «остров», а СУДЬЯ полноты: он читает вердикты
// и счётчики базы (historyFullByQuiet, reachedStart, pendingCursor, lastBaseCount), пишет
// вердикты (historyFullByQuiet/reachedStart/quietIncompleteNoStart/lastCycleEndedHidden),
// зовёт десять функций ядра (в том числе форвардеры архива: ярус архива переоценивается
// именно на стопе лоадера) и владеет таймером debounce. Отсюда 32 имени: меньше нельзя —
// каждое непереданное имя в `with (D)`-теле не бросает, а ТИХО деградирует (typeof-гарды
// дают false/0, свободные чтения — undefined), и вердикт полноты становится ложным.
//
// ВИДЫ СВЯЗИ:
//   fn — `function имя(...)` в ядре. Передаётся ЗНАЧЕНИЕМ (имя: имя). Пять из них —
//        форвардеры ядра в модуль (noteBaseCountChange/notifyLoaderState/aiCmDiag*); они
//        объявлены function declaration и хойстятся, поэтому чужие __bind-блоки (diag, rpc,
//        parse, лоадер, пагинация, архив) получают их значением ДО строки связки оракула.
//        emitBaseSnapshot — ПОЗДНИЙ АЛИАС (`var ... = null`, дозаполняется блоком ingest):
//        поэтому блок __bind оракула стоит НИЖЕ строки 782, иначе в модуль уехал бы null.
//   rw — живое состояние: get + set. Без set запись из модуля молча теряется (присваивание
//        в accessor без сеттера не бросает), и ядро остаётся со старым значением — тихий баг:
//        оракул объявил бы полноту, а ядро её не увидело бы.
//   ro — только чтение: get. Сеттер не нужен: модуль эти имена НЕ переприсваивает.
//
// ЧТО ЗНАЧИТ ro ЗДЕСЬ (важно). ro — про ПЕРЕПРИСВАИВАНИЕ ПЕРЕМЕННОЙ, а не про неизменяемость
// объекта: `delete oracleIncompleteSeen[convId]` — это мутация, и она живёт у rw-имени,
// а `turnsMap[it.id]` читается по ссылке. Переприсваиваний у ro-имён в перенесённых телах
// нет — проверено обходом AST в tools/verify-oracle-extraction.js.
//
// ДВА ИМЕНИ СВЕРХ ПЛАНА ШАГА — И ПОЧЕМУ БЕЗ НИХ НЕЛЬЗЯ.
//   lastHnvPageError, lastBaseTextLen читаются в stableCheck74 под typeof-гардом:
//     pageError: (typeof lastHnvPageError === 'undefined') ? false : (lastHnvPageError === true),
//     provenLen: (typeof lastBaseTextLen === 'undefined') ? 0 : lastBaseTextLen.
//   Гард нужен песочницам пинов (gemini-floor-self-heal, gemini-collapse-guard) — там имена
//   не передаются, и typeof обязан вернуть 'undefined', а не бросить. Но в бою гард обязан
//   видеть ЖИВОЕ значение, иначе: pageError навсегда false → самоунижение устаревшего пола
//   разрешалось бы при ошибке страницы (ослабление H10-гейта), provenLen=0 → понижение пола
//   записало бы УСТАРЕВШУЮ длину вместо реальной (ровно то, что запрещает
//   selfHealFloorVerdict и держит пин gemini-floor-self-heal «устаревшая длина НЕ
//   сохраняется»). Оба имени переданы геттерами — как в tools/pagination-bind-contract.js
//   (`['lastHnvPageError', 'ro']`, `['lastBaseTextLen', 'ro']`), где тот же приём уже принят.
//
// ДВА ИМЕНИ В КОНТРАКТЕ, КОТОРЫХ ТЕЛА НЕ ЧИТАЮТ (осознанно, см. KNOWN_UNUSED в S2-пине):
//   parserVersion — версию записи пола подставляют сами обёртки ядра (loadFloor/saveFloor/
//     selfHealFloor), которые тела оракула и зовут; буквальной ссылки на имя в телах нет.
//   lastOrderedIds — последний эмитнутый порядок id читает слушатель ai-cm-diag-request,
//     который остаётся в ядре; оракул восстанавливает порядок сам (aiCmOrderedTurns).
//   Оба имени оставлены по решению шага: контракт фиксирует СОСТОЯНИЕ, от которого зависит
//   вердикт полноты, а не только буквальные ссылки. Любое ТРЕТЬЕ неиспользуемое имя обязано
//   покраснеть — это и проверяет S2 (KNOWN_UNUSED ровно из двух записей).
//
// ЧЕГО В КОНТРАКТЕ НЕТ И ПОЧЕМУ.
//   stableFloorConfirm / stableCheck74 — НЕ зависимости, а САМ кластер: stableFloorConfirm
//     зовётся таймером debounce внутри модуля, stableCheck74 объявлен внутри notifyLoaderState.
//   window / document / debugLog — свободные глобалы MAIN-мира (debugLog объявляет
//     utils/debug.js), их ядро не инжектирует.
//   loaderState — передан: снапшот ходов читает loaderState.scrollEngaged (v66).
//
// ЭТО НЕ ПРОМЫШЛЕННЫЙ КОД, а тулинг сборки: файл трекается (см. .gitignore) только
// потому, что S-пины tests/adapters/gemini-oracle-module.test.js обязаны читать его
// в чистом клоне CI. Больше его никто не читает.
'use strict';

// ['имя', 'вид'] — вид: 'fn' | 'rw' | 'ro'.
// В комментарии: @N — объявление в ядре ДО выноса; r:/w: — строки диапазонов
// (E1 866-909 — floor-confirmed + debounce, E2 1001-1155 — notifyLoaderState,
//  E3a 1372-1398 — отпечатки, E3b 1408-1436 — снимок turnsMap, E4 1850-1859 — мост).
module.exports = [
  // ---- fn (10): функции ядра, передаются значением ----
  ['getConvId', 'fn'],               // @1187, r:E1,E2,E3b — определение чата
  ['baseSize', 'fn'],                // @1369, r:E1 (n74) — счётчик базы в метке изменения
  ['loadFloor', 'fn'],               // @1167, r:E1,E2 — пол чата (гейт H10 не ослабляется)
  ['selfHealFloor', 'fn'],           // @1179, r:E2 — единственная точка ПОНИЖЕНИЯ пола
  ['emitBaseSnapshot', 'fn'],        // @642 (поздний алиас), r:E1,E2 — пере-эмит после вердикта
  ['aiCmArchiveFor', 'fn'],          // @1735, r:E2 — ярус архива (гейт archive-live-pending)
  ['aiCmArchiveLiveProven', 'fn'],   // @1736, r:E1,E2 — доказан ли ЖИВОЙ ярус (T1-fix#2)
  ['aiCmLiveTurnCount', 'fn'],       // @1737, r:E1,E2 — сколько ходов базы не из архива
  ['aiCmArchiveTierApply', 'fn'],    // @1738, r:E2 — переоценка archive-complete на стопе лоадера
  ['aiCmBaseExportInfo', 'fn'],      // @1739, r:E3b — объединённая база (архив + live) в снимке
  // ---- rw (10): живое состояние — get + set (модуль переприсваивает эти имена) ----
  ['historyFullByQuiet', 'rw'],      // @826,  w:E1(891),E2(1131), r:E1,E2 — вердикт полноты
  ['reachedStart', 'rw'],            // @827,  w:E1(892),E2(1132), r:E2 — начало диалога достигнуто
  ['quietIncompleteNoStart', 'rw'],  // @835,  w:E1(893),E2(1133) — цикл кончился без начала
  ['lastCycleEndedHidden', 'rw'],    // @836,  w:E2(1006) — цикл завершился при скрытой вкладке
  ['quietEndedClean', 'rw'],         // @958,  r:E2(1047) — сеть честно отдала «старше нет»
  ['oracleIncompleteSeen', 'rw'],    // @986,  w:E1(894),E2(1134) delete — обход cache-complete
  ['lastLoaderDoneReason', 'rw'],    // @1581, r:E2(1101,1116,1121) — done-reason лоадера
  ['lastBaseCount', 'rw'],           // @858,  r/w:E1,E2 — счётчик базы и его стабильность
  ['lastBaseCountChangeAt', 'rw'],   // @859,  r/w:E1,E2 — момент последнего изменения счётчика
  ['floorConfirmDebounceTimer', 'rw'], // @865 (объявление осталось в ядре), r/w:E1(906,907)
  // ---- ro (12): только чтение — get без сеттера ----
  ['pendingCursor', 'ro'],           // @837,  r:E2(1017,1049,1072,1150) — живой курсор продолжения
  ['lastIngestParseFail', 'ro'],     // @948,  r:E2(1023) — обрыв JSON-кадра (O-48)
  ['lastOlderNonPagAddAt', 'ro'],    // @855,  r:E1(890),E2(1130) — старшие добавления вне 'pag'
  ['turnsMap', 'ro'],                // @794,  r:E3a — САМА база (в модуле только чтение)
  ['lastOrderedIds', 'ro'],          // @795,  не читается телами (см. шапку: KNOWN_UNUSED)
  ['parserVersion', 'ro'],           // @1161, не читается телами (см. шапку: KNOWN_UNUSED)
  ['loaderRunningFor', 'ro'],        // @984,  r:E1(869),E2(1075) — чат, где лоадер идёт сейчас
  ['quietActive', 'ro'],             // @825,  r:E1(869),E2(1073) — тихая пагинация активна
  ['reachedStartByScroll', 'ro'],    // @828,  r:E3b — reachedStart от confirmed-by-scroll
  ['loaderState', 'ro'],             // @1573, r:E3b — сводное состояние прогона лоадера (v66)
  ['lastHnvPageError', 'ro'],        // @933,  r:E2(1074) — ошибка-страница (гейт H10), typeof-гард
  ['lastBaseTextLen', 'ro']          // @796,  r:E2(1081) — textLen базы для provenLen, typeof-гард
];
