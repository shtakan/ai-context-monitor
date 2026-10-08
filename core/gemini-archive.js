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
      try { sf = D.loadFloor(convId); } catch (eSf) { swallowSoft(eSf, 'gemini:archive-tier-floor-read'); }
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
    } catch (eArc) { swallowSoft(eArc, 'gemini:aiCmArchiveTierApply'); }
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
    } catch (eAf) { swallowSoft(eAf, 'gemini:archive-restore-listener'); }

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
      if (addedCount > 0) { try { D.refreshMinOrderTracking('archive'); } catch (eRo) { swallowSoft(eRo, 'gemini:archive-restore-min-order'); } }
      try { D.emitBaseSnapshot(); } catch (eEm) { swallowSoft(eEm, 'gemini:archive-restore-emit'); }
    }
    try { aiCmArchiveTierApply(); } catch (eAp) { swallowSoft(eAp, 'gemini:archive-restore-tier-reapply'); }
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
