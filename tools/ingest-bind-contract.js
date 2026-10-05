// Контракт связки gemini-ingest.js <-> gemini-intercept.js (Phase 3 Step 12).
//
// ЧТО ЭТО. Список имён ядра, которые перенесённый в core/gemini-ingest.js
// ingest-кластер читает и/или пишет. Блок `aiCmGeminiIngest.__bind({...})` в
// ядре строится ИМЕННО из этого массива, а tools/verify-ingest-module.js
// сверяет блок с массивом в обе стороны. Один источник правды: добавил имя в
// контракт — оно обязано появиться в блоке __bind, и наоборот.
//
// ПОРЯДОК. Сгруппирован по виду связи, внутри группы — по первому обращению
// в ядре (строка указана в комментарии рядом с именем), затем по алфавиту.
//
// ВИДЫ СВЯЗИ:
//   fn    — `function имя(...)` в ядре. Передаётся ЗНАЧЕНИЕМ (имя: имя).
//           Ключевая тонкость: вызов через with (D) делает this = D, поэтому
//           тела fn-значений обязаны обходиться без `this` (урок
//           FIX-PAGINATION-FETCH-BINDING, гейт G1 в apply-ingest-extraction.js).
//   alias — `var имя = null;` в ядре, дозаполняется блоком __bind РАННЕГО
//           модуля (gemini-rpc/parse/sse/pagination/loader-scroll). Передаётся
//           ЗНАЧЕНИЕМ, и блок ingest обязан стоять ПОСЛЕ всех ранних блоков,
//           иначе в модуль уедет null.
//   rw    — живое состояние: get + set. Без set запись из модуля в sloppy-with
//           молча теряется (присваивание в accessor без сеттера не бросает),
//           и ядро остаётся со старым значением — тихий баг. Гейт G2.
//   ro    — только чтение: get. Запись в кластере отсутствует (проверено
//           обходом AST: ни `=`, ни `+=`, ни `++`).
//
// РАСХОЖДЕНИЕ С УТВЕРЖДЁННЫМ ПЛАНОМ (зафиксировано сознательно). План говорит
// "35 rw — get+set; 13 ro — get". Фактический обход AST даёт 41 rw и 7 ro:
// шесть имён (lastAllStrings, lastBaseTextLen, lastCursorSource,
// lastIngestParseFail, lastOrderedIds, lastPaginateOuter) ЗАПИСЫВАЮТСЯ внутри
// кластера, но читаются только ядром, поэтому в плане они попали в ro по
// аналогии с шагом 10 (в pagination-bind-contract.js эти же имена действительно
// ro — для ТОГО модуля). Здесь ro означало бы отсутствие сеттера, то есть
// молча потерянную запись (например lastBaseTextLen — floor provenLen читается
// в ядре). Поэтому контракт кодирует 41 rw / 7 ro; сумма 72 не меняется.
//
// ЭТО НЕ ПРОМЫШЛЕННЫЙ КОД, а тулинг сборки: файл лежит в tools/ (каталог в
// .gitignore) и читается только tools/apply-ingest-extraction.js.
'use strict';

// ['имя', 'вид'] — вид: 'fn' | 'alias' | 'rw' | 'ro'.
module.exports = [
  ['buildJsonSkeleton', 'fn'], // @1496
  ['getConvId', 'fn'], // @1534
  ['structureMap', 'fn'], // @1601
  ['collectAttachments', 'fn'], // @1624
  ['collectContent', 'fn'], // @1639
  ['activeRefresh', 'fn'], // @2012
  ['aiCmArchiveTierApply', 'fn'], // @2243
  ['sanitizeMessagesForEmit', 'fn'], // @2368
  ['loadFloor', 'fn'], // @2394
  ['saveFloor', 'fn'], // @2415
  ['baseSize', 'fn'], // @2508
  ['aiCmDiagHash6', 'fn'], // @2841
  ['noteBaseCountChange', 'fn'], // @2896
  ['extractCursor', 'alias'], // @1512
  ['classifyOpaque', 'alias'], // @1548
  ['edges8', 'alias'], // @1548
  ['walkOpaque', 'alias'], // @1552
  ['aiCmEnsureColdWindow', 'alias'], // @2500
  ['parseBatchExecute', 'alias'], // @2531
  ['maybeStartLoader', 'alias'], // @2600
  ['refreshMinOrderTracking', 'alias'], // @2895
  ['aiCmColdStartIngestLog', 'alias'], // @2905
  ['paginateLoop', 'alias'], // @2938
  ['scheduleAutoScroll', 'alias'], // @2950
  ['attachSeen', 'rw'], // @1374 w:2650
  ['attachBreak', 'rw'], // @1379 w:2652
  ['attachTokens', 'rw'], // @1395 w:1395,2651
  ['lastHnvPageError', 'rw'], // @1477 w:1477,1495
  ['lastFailedSkeleton', 'rw'], // @1496 w:1496,1503,1666
  ['loggedRontgen', 'rw'], // @1507 w:1507
  ['lastPaginateOuter', 'rw'], // @1509 w:1509
  ['pendingCursor', 'rw'], // @1512 w:1512,2524,2534,2541
  ['lastCursorSource', 'rw'], // @1514 w:1514,1515
  ['cursorEpoch', 'rw'], // @1517 w:1517
  ['olderHistorySeen', 'rw'], // @1519 w:1519,2637
  ['historyFullByQuiet', 'rw'], // @1528 w:1529,2638,2810
  ['reachedStart', 'rw'], // @1530 w:1530,2639
  ['quietIncompleteNoStart', 'rw'], // @1531 w:1531,2648
  ['quietDecisionMade', 'rw'], // @1532 w:1532,2647,2813,2935,2942
  ['lastPaginateOpaqueCandidates', 'rw'], // @1556 w:1556,1598
  ['lastAllStrings', 'rw'], // @1576 w:1576
  ['loggedStructure', 'rw'], // @1599 w:1600
  ['lastVf5ActivityAt', 'rw'], // @1961 w:1969,1987,2499
  ['lastActiveAt', 'rw'], // @1968 w:1968,2011
  ['quietActive', 'rw'], // @2002 w:2645,2811,2934,2944
  ['turnsMap', 'rw'], // @2247 w:2634,2758
  ['lastOrderedIds', 'rw'], // @2304 w:2304
  ['lastBaseTextLen', 'rw'], // @2387 w:2387
  ['isLowConfidenceBase', 'rw'], // @2446 w:2633
  ['loggedErr', 'rw'], // @2533 w:2533,2570
  ['lastIngestParseFail', 'rw'], // @2544 w:2544
  ['vf5OverlapSinceLoaderStart', 'rw'], // @2590 w:2590,2632
  ['convEpoch', 'rw'], // @2630 w:2630
  ['tapeWasUsedInThisColdStart', 'rw'], // @2631 w:2631
  ['orderCounter', 'rw'], // @2635 w:2635,2759,2849,2856
  ['prependCursor', 'rw'], // @2636 w:2636,2760,2857
  ['reachedStartByScroll', 'rw'], // @2640 w:2640
  ['serverFirstHash', 'rw'], // @2641 w:2641,2841
  ['lastHeadToken', 'rw'], // @2642 w:2642
  ['lastGoodWideCur', 'rw'], // @2643 w:2643
  ['lastGoodProbeMeta', 'rw'], // @2644 w:2644
  ['quietPaginated', 'rw'], // @2646 w:2646,2812
  ['lastCycleEndedHidden', 'rw'], // @2649 w:2649
  ['loggedOk', 'rw'], // @2910 w:2911
  ['loggedAttach', 'rw'], // @2917 w:2918
  ['idmapCalls', 'ro'], // @1604
  ['scrollRecentUntil', 'ro'], // @1990
  ['loaderRunningFor', 'ro'], // @2001
  ['loaderDoneMap', 'ro'], // @2515
  ['lastFrameParseFail', 'ro'], // @2537
  ['loaderRetryUsedMap', 'ro'], // @2595
  ['parserVersion', 'ro'], // @3216
];
