// core/pagination/pagination.js — Phase 3 шаг 10: кластер пагинации вынесен из
// core/gemini-intercept.js (строки 1461–1570, 2612–2992, 2993–3035, 3037–3196,
// 3198–3275, 3277–3310) и живёт в отдельном модуле.
//
// ЧТО ЗДЕСЬ: весь цикл докачивания полной истории Gemini и всё, чем он
// доказывает полноту базы:
//   - extractCursor/classifyOpaque(+Wide)/findCursors/edges8 — поиск ИР-курсора
//     продолжения (узкая зона turns и широкая: inner outer[0][2] + rest);
//   - refreshMinOrderTracking — пересчёт минимума order (понижение вне 'pag'
//     инвалидирует scroll-proof);
//   - paginateLoop — тихий постраничный проход: сборка url/body/headers, канон
//     решения о следующем шаге (окно-ретраи, эскалация нативного скролла,
//     v68-сервер-авторитет), retained last-good (H9b), терминальные выходы;
//   - finishQuiet — решение о полноте по итогам тихой пагинации (v78 floor);
//   - runCompletenessProbe — НЕЗАВИСИМАЯ проверка полноты: курсор в probe-ответе
//     означает «есть ещё история», а непрочитанная строка — не «начало»;
//   - runCompletenessWatchdog + finishWatchdogDecision — до 3 попыток сверки
//     firstMsgHash против lastHeadToken, чтобы полнота не была объявлена на
//     усечённой базе.
//
// ПОЧЕМУ ВЫНЕСЕНО: это ~700 строк самостоятельной подсистемы с одним контрактом —
// «добирай историю И докажи, что она полная». Она читает и пишет состояние ядра,
// но сама оркестрацией не является: вызовы идут из ingest/rontgenPagination/loader.
//
// СВЯЗКА: ядро отдаёт живые переменные через `__bind` (геттеры/сеттеры), функции —
// значениями. Тела функций ссылаются на инжектированные имена БЕЗ префикса `D.`:
// объявления лежат внутри `with (D) { … }`, поэтому свободное имя резолвится в
// with-объект (ES3 Annex B: объявленная внутри with функция захватывает его
// окружение). Это не украшение, а требование СУЩЕСТВУЮЩИХ пинов: они режут эти
// функции из конкатенации и исполняют в `with (ctx)` без ключа D
// (gemini-h13-inner-cursor, o48, o51, o51b, gemini-untrusted-top, archive-oracle).
// Побочный плюс: песочница теста и браузер разрешают имена ОДНИМ механизмом.
//
// ВНИМАНИЕ: `with` запрещён в strict mode. Файл намеренно без 'use strict'
// и никогда не попадает в esbuild-бандл: entry берётся из manifest
// content_scripts[0].js (там перехватчика Gemini нет), а runtime-регистрируемые
// файлы build.mjs копирует в dist/ дословно. При появлении этого файла в entry —
// читать этот комментарий снова.
//
// ПОРЯДОК ПОДКЛЮЧЕНИЯ: core/background.js, js[] — ПОСЛЕ core/gemini-sse.js и
// ПЕРЕД core/gemini-intercept.js (модуль подключается раньше ядра, которое его
// связывает). При добавлении сюда файла — бамп id регистрации (-v5 → -v6):
// MV3 не перечитывает js[] под уже зарегистрированным id.
//
// PUBLIC API: window.AiCmGeminiPagination = { __bind, classifyOpaque, edges8, walkOpaque, findCursors, extractCursor, classifyOpaqueWide, extractCursorWide, refreshMinOrderTracking, paginateLoop, finishQuiet, runCompletenessProbe, runCompletenessWatchdog, finishWatchdogDecision }.
// Тела перенесены байт-в-байт; единственная правка — `Fn.<имя> = <имя>` на экспорт
// (вместо `return`: esbuild схлопывает return-объект внутри with в
// `var f = f2, f = f2`, что не парсится).

(function () {
  if (typeof window !== 'undefined' && window.AiCmGeminiPagination) return;
  var D = null;
  var Fn = {};
  function __bind(d) {
    D = d;
    with (D) {

      // ---- cursor-cluster: classifyOpaque / edges8 / walkOpaque / findCursors / extractCursor / classifyOpaqueWide / extractCursorWide / refreshMinOrderTracking ----
  // H13 (inner-cursor): канон opaque-экстракции курсора — window.GeminiInterceptLogic.*
  // (utils/gemini-intercept-logic.js); здесь — делегация + inline-дубль (конвенция
  // probeTerminalGate/pagStepBroken). H13: потолок классификатора 600→2000 — токены
  // глубоких окон (e292: len=705/849 в turns[1] parsed-inner) реальны, отсечение 600
  // было ложным negative; фильтры мусора (image/png-строки, не-b64) сохранены.
  function classifyOpaque(s) {
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
        typeof window.GeminiInterceptLogic.classifyOpaque === 'function') {
      return window.GeminiInterceptLogic.classifyOpaque(s);
    }
    if (typeof s !== 'string') return false;
    if (s.length < 40 || s.length > 2000) return false;
    if (!/^[A-Za-z0-9+\/]+={0,2}$/.test(s)) return false;
    if (s.indexOf('$AVuibg') === 0) return false;
    return true;
  }
  function edges8(s) { return s.slice(0, 8) + '…' + s.slice(-8); }
  function walkOpaque(node, path, out) {
    if (out.length > 30) return;
    if (typeof node === 'string') {
      if (classifyOpaque(node)) out.push(path + ' len=' + node.length + ' "' + edges8(node) + '"');
      return;
    }
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) walkOpaque(node[i], path + '[' + i + ']', out);
    }
  }
  function findCursors(node, out) {
    if (out.length > 8) return;
    if (typeof node === 'string') { if (classifyOpaque(node)) out.push(node); return; }
    if (Array.isArray(node)) { for (var i = 0; i < node.length; i++) findCursors(node[i], out); }
  }
  // H13: канон в GeminiInterceptLogic.extractCursor — opaque-кандидаты по всему turns
  // (включая turns[1] parsed-inner), приоритет — ДЛИННЕЙШИЙ (равные: последний, как до H13).
  function extractCursor(turns) {
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
        typeof window.GeminiInterceptLogic.extractCursor === 'function') {
      return window.GeminiInterceptLogic.extractCursor(turns);
    }
    var c = [];
    if (Array.isArray(turns)) { for (var i = 0; i < turns.length; i++) findCursors(turns[i], c); }
    if (!c.length) return null;
    if (c.length > 1 && !loggedMultiCursor) {
      loggedMultiCursor = true;
      debugLog('log', '[gemini-paginate] найдено ' + c.length + ' opaque-кандидатов в ответе (беру длиннейший): ' + c.map(edges8).join(' | '));
    }
    var bestC = c[c.length - 1];
    for (var bj = 0; bj < c.length; bj++) { if (c[bj].length > bestC.length) bestC = c[bj]; }
    return bestC;
  }
  // v73/H13: фиксированная ШИРОКАЯ экстракция курсора — строки 8..2000
  // (потолок classifyOpaque 600 снят), base64-подобные, без '$AVuibg'. Канон — в utils.
  function classifyOpaqueWide(s) {
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
        typeof window.GeminiInterceptLogic.classifyOpaqueWide === 'function') {
      return window.GeminiInterceptLogic.classifyOpaqueWide(s);
    }
    if (typeof s !== 'string') return false;
    if (s.length < 8 || s.length > 2000) return false;
    if (!/^[A-Za-z0-9+/=]+$/.test(s)) return false;
    if (s.indexOf('$AVuibg') === 0) return false;
    return true;
  }
  // H13 (inner-cursor): зоны wide-скана — (1) inner: outer[0][2] → JSON.parse → turns
  // (слот курсора turns[1]; e292: токены len=705/849 жили ТОЛЬКО там, rest их не нёс →
  // probe объявлял ложный терминал), (2) rest: outer[0].slice(3) как было. Порядок зон —
  // inner ПЕРВОЙ; приоритет — ДЛИННЕЙШИЙ b64-кандидат (classifyOpaqueWide). Канон —
  // в GeminiInterceptLogic.extractCursorWide, ниже inline-дубль.
  function extractCursorWide(outer) {
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
        typeof window.GeminiInterceptLogic.extractCursorWide === 'function') {
      return window.GeminiInterceptLogic.extractCursorWide(outer);
    }
    var bestW = null;
    function scanWideZone(zone) {
      (function walkW(n) {
        if (typeof n === 'string') {
          if (classifyOpaqueWide(n) && (!bestW || n.length > bestW.length)) bestW = n;
          return;
        }
        if (Array.isArray(n)) { for (var i = 0; i < n.length; i++) walkW(n[i]); }
      })(zone);
    }
    try {
      if (!Array.isArray(outer) || !Array.isArray(outer[0])) return null;
      var innerParsedW = null;
      try {
        var innerStrW = outer[0][2];
        if (typeof innerStrW === 'string') {
          var parsedInnerW = JSON.parse(innerStrW);
          if (Array.isArray(parsedInnerW)) innerParsedW = parsedInnerW;
        }
      } catch (eH13WIn) { innerParsedW = null; }
      if (innerParsedW) scanWideZone(innerParsedW);
      scanWideZone(outer[0].slice(3));
      return bestW;
    } catch (eH13W) { return null; }
  }
  // v73: пересчёт минимума order; понижение минимума вне 'pag' инвалидирует scroll-proof
  function refreshMinOrderTracking(src) {
    var minOrd = Infinity;
    for (var k in turnsMap) {
      var o = turnsMap[k] && turnsMap[k].order;
      if (typeof o === 'number' && o < minOrd) minOrd = o;
    }
    if (minOrd !== Infinity && minOrd < minOrderSeen) {
      if (src !== 'pag') lastOlderNonPagAddAt = Date.now();
      minOrderSeen = minOrd;
    }
  }

      // ---- paginate-loop: paginateLoop — один шаг постраничного прохода: сборка url/body/headers, канон решения о следующем шаге (окно-ретраи, эскалация, v68-сервер-авторитет), retained last-good (H9b), эскалация нативного скролла, терминальные выходы ----
  // ================= ВИРТУАЛЬНЫЙ F5 ДЛЯ ХВОСТА + ТИХАЯ ПАГИНАЦИЯ =================

  // v2.0 (Phase 3 step 5): метаданные RPC (captureHeadersFromInit/convIdFromBody/
  // rememberSiteMeta/buildActiveBodyWith/buildActiveBody/buildActiveUrl) уехали в
  // core/gemini-rpc.js и приходят сюда через bind-алиасы в начале IIFE.
  function paginateLoop(token, depth) {
    // v68: сервер-авторитетный прогон — счётчики страницы/времени живут в paginationRun
    // (сброс при смене чата). Потолок ≤ 25 страниц ИЛИ 60с — при достижении база НЕполная + warn.
    if (depth === 0) {
      paginationRun.pageCount = 0;
      paginationRun.startTs = Date.now();
      lastPagStepBroken = false; // H9: новый прогон тихой пагинации — сброс флага «последний шаг сломан»
      pagErrorRetries = 0; // v1.15: новый прогон — новый бюджет ретраев окна после ошибки-страницы
      quietEndedClean = false; // v1.15: чистый конец определяется по шагам ЭТОГО прогона
      quietErrStreak = 0; // v1.16 (1177-PACE): новый прогон — серия ошибок-страниц с нуля
    }
    // v1.15: convId на момент отправки шага (смена чата отменяет отложенный ретрай окна)
    var __pagLoopConv = getConvId();
    paginationRun.pageCount++;
    lastHeadToken = token; // v69: токен текущей страницы — по завершении цикла это голова
    if (!lastAtEncoded || !lastBaseUrl || !lastHeaders) { finishQuiet(false, 'no-meta'); return; }
    // v59: тег шага пагинации на момент отправки — устаревший шаг прекращает цикл
    var reqTagPag = captureReqTag();
    var headers = {};
    for (var k in lastHeaders) headers[k] = lastHeaders[k];
    // FIX-PAGINATION-FETCH-BINDING: explicit window binding for MV3 module scope
    originalFetch.call(globalThis, buildActiveUrl(), {
      method: 'POST',
      headers: headers,
      body: buildActiveBodyWith(token),
      credentials: 'include'
    })
      .then(function (resp) {
        if (!resp || !resp.ok) { finishQuiet(false, 'status' + (resp ? resp.status : 'none')); return null; }
        return resp.text();
      })
      .then(function (txt) {
        if (!txt) return;
        // v59: страница, уходившая для старого чата — тихо прекращаем цикл
        // (не ингестируем, не трогаем reachedStart/historyFullByQuiet нового чата)
        if (isStaleReqTag(reqTagPag, 'pag')) return;
        var added = ingest(txt, { emitOnlyIfAdded: true, fromActivePaginate: true });
        if (added > 0) quietPaginated = true;
        var next = pendingCursor;
        var totalNow = baseSize();
        // v1.16 (1177-PACE): серия ошибок-страниц копится (снижает темп продолжения);
        // успешная страница (добавила ходы или принесла курсор) сбрасывает серию.
        if (lastHnvPageError === true) quietErrStreak++;
        else if (added > 0 || next) quietErrStreak = 0;
        // v27: диагностика opaque-кандидатов на каждом шаге пагинации
        if (lastPaginateOpaqueCandidates) {
          var cands = lastPaginateOpaqueCandidates.cands;
          debugLog('log', '[gemini-paginate] шаг ' + depth + ': +ходов=' + added + ' всего=' + totalNow +
            ' | outer[0].len=' + lastPaginateOpaqueCandidates.arr0len +
            ' | rest=[' + lastPaginateOpaqueCandidates.restTypes.join(',') + ']' +
            ' | turns.len=' + lastPaginateOpaqueCandidates.turnsLen +
            ' | lastTurn=' + lastPaginateOpaqueCandidates.lastDesc +
            ' | opaque-кандидаты: ' + (cands.length ? cands.join('  ||  ') : '(кандидатов 0)'));
        } else {
          debugLog('log', '[gemini-paginate] шаг ' + depth + ': +ходов=' + added + ' всего=' + totalNow + ' | lastPaginateOpaqueCandidates=null (handleOuter не заполнил)');
        }
        // v1.15 (BUG «холодное открытие без полной истории»): убран опасный fbb-фолбэк —
        // «курсор» из ПЕРВОГО вхождения fbb-строки в сыром тексте. fbb-строки здесь — это
        // ПРЕФИКСЫ ID ходов (см. isIdLike), а не континуационный курсор: подстановка такого
        // токена в запрос окна стабильно возвращает ошибку Bard (1177) вместо следующей
        // страницы → тихая пагинация обрывалась, лоадер уходил в collapse и база оставалась
        // неполной. Продолжаем цикл ТОЛЬКО по настоящему opaque-курсору (extractCursor);
        // его отсутствие — честный сигнал «старших страниц в этом ответе больше нет».
        // H9 (last-step-broken): на каждом шаге тихого цикла отмечаем, сломан ли он —
        // added=0, курсора нет, страница не распарсилась (скелет) ИЛИ opaque-кандидатов 0.
        // При added>0 или живом курсоре pagStepBroken вернёт false (сброс флага). Флаг гейтит
        // scroll-top-proof (a): serverFirstHash последней «живой» страницы при оборванном
        // финальном шаге циркулярен и не является независимым подтверждением полноты.
        {
          var __candsH9 = 0;
          if (lastPaginateOpaqueCandidates && Array.isArray(lastPaginateOpaqueCandidates.cands)) {
            __candsH9 = lastPaginateOpaqueCandidates.cands.length;
          }
          if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
              typeof window.GeminiInterceptLogic.pagStepBroken === 'function') {
            lastPagStepBroken = window.GeminiInterceptLogic.pagStepBroken({
              added: added,
              nextCursor: !!next,
              failedSkeleton: lastFailedSkeleton,
              opaqueCandidates: __candsH9
            });
          } else {
            lastPagStepBroken = (added === 0 && !next && (lastFailedSkeleton || __candsH9 === 0));
          }
        }
        // H9b (retain-last-good): фиксация retained ТОЛЬКО на здоровом шаге тихой пагинации
        // (шаг не сломан И (added>0 ИЛИ живой курсор)); probe-парсы ('pb'/'sh'/'wd') этот блок
        // не проходят — он живёт в шагах цикла src='pag'. Сломанный финальный шаг (added=0,
        // курсора нет) сюда не попадает → lastPaginateOuter, перезаписанный битой/терминальной
        // страницей, НЕ трогает retained: wide-курсор и метаданные последнего здорового шага
        // остаются входом для контрольного probe (монотонное правило updateProbeMetaRetain:
        // stepOk=false → keep prev; stepOk=true → replace; мусор не принимается).
        if (!lastPagStepBroken && (added > 0 || next)) {
          try {
            var rCurH9b = null;
            try { rCurH9b = extractCursorWide(lastPaginateOuter); } catch (eRcH9b) { rCurH9b = null; }
            // H9b: wide-экстракция (rest + inner-turns, H13) может не найти кандидата
            // (битый/терминальный outer) — берём «живой» курсор шага: next
            // (continuation ЭТОГО шага) либо, на финальном здоровом шаге, токен запроса
            // lastHeadToken (курсор, который привёл к голове). Оба — настоящие
            // opaque-токены цепочки (не fbb-префиксы). Монотонно:
            // retained двигается только ВПЕРЁД по здоровым шагам (см. гейт выше).
            if (!rCurH9b && next) rCurH9b = next;
            if (!rCurH9b && lastHeadToken) rCurH9b = lastHeadToken;
            if (rCurH9b) lastGoodWideCur = { conv: __pagLoopConv || '', cur: rCurH9b, ts: Date.now() };
          } catch (eRwH9b) { }
          try {
            if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
                typeof window.GeminiInterceptLogic.updateProbeMetaRetain === 'function') {
              var rMetaH9b = { conv: __pagLoopConv || '', atEncoded: lastAtEncoded, baseUrl: lastBaseUrl, headers: lastHeaders };
              var rUpdH9b = window.GeminiInterceptLogic.updateProbeMetaRetain(lastGoodProbeMeta, rMetaH9b, true);
              if (rUpdH9b) lastGoodProbeMeta = rUpdH9b;
            }
          } catch (eRmH9b) { }
        }
        // v1.15 (BUG «холодное открытие без полной истории»): страница вернула ОШИБКУ Bard
        // (inner не строка / BardErrorInfo, см. isBardErrorPage) — это НЕ конец истории.
        // Курсор прошлого окна (token) жив: повторяем запрос того же окна с растущей паузой,
        // не гася тихий цикл и не роняя reachedStart/historyFullByQuiet в неполноту.
        var __errRetry = null;
        try {
          var __errPage1177 = (lastHnvPageError === true);
          if (__errPage1177 && added === 0 && !next) {
            if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
                typeof window.GeminiInterceptLogic.paginateErrorRetryDecision === 'function') {
              __errRetry = window.GeminiInterceptLogic.paginateErrorRetryDecision({
                errPage: __errPage1177, hasCursor: !!next, added: added, retries: pagErrorRetries
              });
            } else {
              __errRetry = (pagErrorRetries < PAGINATE_ERROR_RETRY_CAP)
                ? { retry: true, backoffMs: PAGINATE_ERROR_BACKOFF_MS * (pagErrorRetries + 1) }
                : { retry: false };
            }
          }
        } catch (eEr1177) { __errRetry = null; }
        if (__errRetry && __errRetry.retry === true) {
          pagErrorRetries++;
          var __retryDelay = (typeof __errRetry.backoffMs === 'number' && __errRetry.backoffMs > 0)
            ? __errRetry.backoffMs : PAGINATE_ERROR_BACKOFF_MS;
          debugLog('log', '[AI CM][cold-debug] pag-error-retry окно повторяется depth=' + depth +
            ' retry=' + pagErrorRetries + '/' + PAGINATE_ERROR_RETRY_CAP +
            ' backoff=' + __retryDelay + 'ms msgs=' + totalNow +
            ' convId=' + (getConvId() || '(none)') +
            ' token=' + (typeof token === 'string' ? token.slice(0, 8) + '…' + token.slice(-8) : '?'));
          setTimeout(function () {
            try {
              if (getConvId() !== __pagLoopConv) return;   // чат сменился — отложенный ретрай не нужен
              if (!quietActive || historyFullByQuiet === true) return; // цикл остановлен/полнота уже есть
              paginateLoop(token, depth + 1);
            } catch (eErT) { swallowSoft(eErT, 'gemini:paginateLoop-retry-timer'); }
          }, __retryDelay);
          return;
        }
        // v1.16 (1177-BYPASS): ретраи окна исчерпаны, а страница всё ещё ошибка Bard (1177) —
        // продолжать цепочку тем же токеном бессмысленно, «старших страниц больше нет» тоже
        // объявлять НЕЛЬЗЯ (курсор прошлого окна жив, сервер просто не отдаёт глубокое окно
        // этому запросу). Эскалируем на НАТИВНЫЙ скрытый скролл (loadFullHistoryInvisibly):
        // сам сайт Gemini запросит старшие окна своими континуационными токенами и в своём
        // темпе (scrollTop=0 + синтетический scroll под оверлеем), их ответы (src=passive)
        // сливаются в базу. Один раз на чат (nativeEscalationUsedMap) — вечного цикла нет.
        var __esc1177 = null;
        try {
          var __escPage1177 = (lastHnvPageError === true);
          if (__escPage1177 && added === 0 && !next &&
              typeof window !== 'undefined' && window.GeminiInterceptLogic &&
              typeof window.GeminiInterceptLogic.paginateErrorEscalation === 'function') {
            __esc1177 = window.GeminiInterceptLogic.paginateErrorEscalation({
              errPage: __escPage1177,
              hasCursor: !!next,
              added: added,
              retries: pagErrorRetries,
              cap: PAGINATE_ERROR_RETRY_CAP,
              loaderRunning: !!(loaderRunningFor && loaderRunningFor === (getConvId() || '')),
              nativeEscalationUsed: !!(getConvId() && nativeEscalationUsedMap[getConvId()])
            });
          }
        } catch (eEsc1177) { __esc1177 = null; }
        if (__esc1177 && __esc1177.escalate === true) {
          var __escConv = getConvId();
          quietActive = false; // тихий цикл сворачиваем — дальше рулит лоадер (нативный скролл)
          try { quietIncompleteNoStart = false; } catch (eEscQ) { }
          try { nativeEscalationUsedMap[__escConv] = true; } catch (eEscM) { }
          try { nativeEscalationFor = __escConv; } catch (eEscF) { }
          debugLog('log', '[AI CM][1177-bypass] escalate-native-scroll reason=' + (__esc1177.reason || 'err1177') +
            ' convId=' + (__escConv || '(none)') + ' msgs=' + totalNow +
            ' errRetries=' + pagErrorRetries + '/' + PAGINATE_ERROR_RETRY_CAP +
            ' — старшие окна доберёт нативный скролл сайта (обход 1177)');
          // лоадер обязан перезапуститься, минуя латчи already-done / cache-complete
          try { delete loaderDoneMap[__escConv]; } catch (eEscL) { }
          try { oracleIncompleteSeen[__escConv] = true; } catch (eEscO) { }
          try { maybeStartLoader(); } catch (eEscS) { swallowSoft(eEscS, 'gemini:paginateLoop-native-escalation-loader'); }
          return;
        }
        // v68: сервер-авторитетное решение о следующем шаге. Полнота — ТОЛЬКО по курсору
        // («старших страниц больше нет»), НЕ по DOM-росту; потолок ≤ 25 страниц ИЛИ 60с.
        var step;
        if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.paginateStepDecision) {
          step = window.GeminiInterceptLogic.paginateStepDecision({
            hasCursor: !!next,
            pages: paginationRun.pageCount,
            elapsedMs: paginationRun.startTs ? (Date.now() - paginationRun.startTs) : 0,
            added: added,
            failedSkeleton: lastFailedSkeleton
          }, { pageCap: PAGINATE_CAP, timeCapMs: PAGINATE_TIME_CAP_MS });
        } else {
          var fbRs = added > 0;
          step = {
            action: next ? 'continue' : 'complete',
            reason: next ? 'cursor-alive' : (fbRs ? 'end' : 'no-start'),
            reachedStart: fbRs,
            baseComplete: fbRs,
            warn: ''
          };
        }
        // v1.15: фиксируем «чистый конец» — завершающий шаг БЕЗ ошибки-страницы (курсора нет)
        // И НЕ оборванный: lastPagStepBroken===false (H9). Сломанный финальный шаг (added=0 +
        // скелет/0 opaque-кандидатов) не даёт права считать сеть «честно закончившейся», поэтому
        // quietEndedClean=true требует необорванного финального шага (инвариант 3а).
        // Позже лоадер на физическом верхе при схлопнутом скроллере сможет подтвердить полноту
        // даже при base < устаревшего пола (чат ужат на сервере), не крутя collapse-ретраи вечно.
        if (step.action === 'complete') {
          quietEndedClean = (lastHnvPageError === false) && lastPagStepBroken !== true;
          if (quietEndedClean) {
            debugLog('log', '[AI CM][cold-debug] quiet-clean-end convId=' + (getConvId() || '(none)') +
              ' msgs=' + totalNow + ' src=' + (lastCursorSource || 'none') + ' added=' + added);
          }
        } else if (step.action === 'cap') {
          quietEndedClean = false;
        }
        if (step.action === 'continue') {
          // v1.16 (1177-PACE): после серии ошибок-страниц (троттлинг старых окон) между
          // продолжениями цепочки — пауза; в штатном режиме (quietErrStreak=0) паузы нет,
          // поведение рабочей цепочки не меняется.
          var __paceMs1177 = 0;
          try {
            if (quietErrStreak > 0 && typeof window !== 'undefined' && window.GeminiInterceptLogic &&
                typeof window.GeminiInterceptLogic.paginatePaceDelayMs === 'function') {
              __paceMs1177 = window.GeminiInterceptLogic.paginatePaceDelayMs(depth, true);
            }
          } catch (ePace1177) { __paceMs1177 = 0; }
          if (__paceMs1177 > 0) {
            var __paceConv1177 = getConvId();
            debugLog('log', '[AI CM][1177-bypass] pace-window ms=' + __paceMs1177 +
              ' errStreak=' + quietErrStreak + ' depth=' + depth + ' convId=' + (__paceConv1177 || '(none)'));
            setTimeout(function () {
              try {
                if (getConvId() !== __paceConv1177) return; // чат сменился — шаг не нужен
                if (!quietActive || historyFullByQuiet === true) return;
                paginateLoop(next, depth + 1);
              } catch (ePaceT) { swallowSoft(ePaceT, 'gemini:paginateLoop-pace-retry'); }
            }, __paceMs1177);
          } else {
            paginateLoop(next, depth + 1);
          }
          return;
        }
        if (step.action === 'cap') {
          console.warn('[AI CM][paginate] ' + (step.warn || ('потолок достигнут reason=' + step.reason)) +
            ' pages=' + paginationRun.pageCount +
            ' elapsed=' + (paginationRun.startTs ? (Date.now() - paginationRun.startTs) : 0) + 'ms' +
            ' msgs=' + totalNow + ' курсор=' + (next ? '1' : '0'));
          finishQuiet(false, step.reason);
          return;
        }
        // action === 'complete': решение принимает НЕЦИРКУЛЯРНЫЙ оракул полноты (v73).
        // Гейт (предварительный): serverFirstHash установлен И dbFirstHash !== serverFirstHash
        //   → гарантированно incomplete (reason=circular-mismatch). Совпадение само по себе
        //   НЕ источник complete (голова базы и есть страница, с которой сверяем — циркулярно).
        // Источники complete — ТОЛЬКО независимые (серверно-авторитетные):
        //   (b) probe: запрос с курсором широкой экстракции (rest + inner-turns
        //       outer[0][2]→turns[1], H13; потолок 2000 вместо 600): 0 новых старших
        //       ходов и курсора нет → complete.
        // Иначе: historyFullByQuiet=false, reachedStart=false → лоадер-фолбэк (maybeStartLoader),
        // полноту выставляет лоадер. step.reachedStart (added>0/protobuf) — только диагностика.
        var dbFirstHash = aiCmDiagTurnEdge(aiCmOrderedTurns(), 'first').hash;
        var retriesC73 = completenessWatchdogRetries[getConvId()] || 0;
        reachedStartByScroll = false; // v61diag: reachedStart от независимых источников, не от скролла-эвристики
        debugLog('log', '[gemini-paginate] шаг ' + depth + ': +ходов=' + added + ' всего=' + totalNow + ', курсора нет → нециркулярный оракул (v73) src=' +
          (lastCursorSource || 'none') + ' olderHistorySeen=' + (olderHistorySeen ? '1' : '0'));
        debugLog('log', '[paginate-dump] строки оборвавшегося ответа: ' +
          (lastAllStrings.length ? lastAllStrings.join(' | ') : '(нет)'));
        // v27: дополнительный полный рентген для шага, оборвавшего цикл
        if (lastPaginateOpaqueCandidates) {
          var c = lastPaginateOpaqueCandidates;
          debugLog('log', '[gemini-paginate] ⚠ РЕНТГЕН ОБОРВАВШЕГО ШАГА depth=' + depth +
            ': outer[0].len=' + c.arr0len +
            ' | rest=[' + c.restTypes.join(',') + ']' +
            ' | turns.len=' + c.turnsLen +
            ' | lastTurn=' + c.lastDesc +
            ' | opaque-кандидаты: ' + (c.cands.length ? c.cands.join('  ||  ') : '(кандидатов 0)'));
        }
        // v72diag: ОДИН теневой probe — курсор мог жить в rest оборвавшего шага (вне turns).
        // Состояние (turnsMap/pendingCursor/historyFullByQuiet/reachedStart) НЕ меняем — только лог.
        if (!next && lastPaginateOuter) {
          var shadowCur = shadowCursorFromRest(lastPaginateOuter);
          if (shadowCur) {
            debugLog('log', '[AI CM][cursor-diag] shadow-probe fired rest-candidate len=' + shadowCur.length +
              ' head=' + JSON.stringify(shadowCur.slice(0, 12)) +
              ' tail=' + JSON.stringify(shadowCur.slice(-12)) +
              ' convId=' + (getConvId() || '(none)'));
            (function () {
              var reqTagSh = captureReqTag();
              var shHeaders = {};
              for (var sk in lastHeaders) shHeaders[sk] = lastHeaders[sk];
              // FIX-PAGINATION-FETCH-BINDING: explicit window binding for MV3 module scope
              originalFetch.call(globalThis, buildActiveUrl(), {
                method: 'POST', headers: shHeaders, body: buildActiveBodyWith(shadowCur), credentials: 'include'
              }).then(function (shResp) {
                if (!shResp || !shResp.ok) {
                  debugLog('log', '[AI CM][cursor-diag] shadow-probe status=' + (shResp ? shResp.status : 'none'));
                  return null;
                }
                return shResp.text();
              }).then(function (shTxt) {
                if (!shTxt || isStaleReqTag(reqTagSh, 'sh')) return;
                // parseBatchExecute → handleOuter меняет pendingCursor/cursorEpoch/olderHistorySeen:
                // сохраняем и восстанавливаем — состояние пагинации не трогаем.
                var savedCursorSh = pendingCursor;
                var savedEpochSh = cursorEpoch;
                var savedOlderSh = olderHistorySeen;
                var shParsed = parseBatchExecute(shTxt, 'sh');
                var shadowCursorFound = pendingCursor;
                pendingCursor = savedCursorSh;
                cursorEpoch = savedEpochSh;
                olderHistorySeen = savedOlderSh;
                var shFe = aiCmDiagTurnEdge(shParsed, 'first');
                var shLe = aiCmDiagTurnEdge(shParsed, 'last');
                debugLog('log', '[AI CM][cursor-diag] shadow-probe result ходов=' + shParsed.length +
                  ' firstText="' + shFe.text + '" lastText="' + shLe.text + '"' +
                  ' cursorFound=' + (shadowCursorFound ? 'yes' : 'no') +
                  ' convId=' + (getConvId() || '(none)'));
              }).catch(function (shErr) {
                debugLog('log', '[AI CM][cursor-diag] shadow-probe error=' + (shErr && shErr.message || shErr));
              });
            })();
          }
        }
        // v73: нециркулярное решение о полноте (гейт → (b) probe; scroll-top-proof удалён — H12/A5b)
        if (serverFirstHash && dbFirstHash !== serverFirstHash) {
          reachedStart = false;
          debugLog('log', '[AI CM][completeness] oracle=incomplete reason=circular-mismatch' +
            ' firstHash=' + dbFirstHash + ' serverFirstHash=' + serverFirstHash + ' retries=' + retriesC73);
          console.log('[AI CM][paginate] incomplete reason=circular-mismatch (added=' + added + ' всего=' + totalNow + ')');
          finishQuiet(false, 'circular-mismatch');
        } else {
          // H12 (A5b): scroll-top-proof удалён — циркулярный оракул; полнота только из серверно-авторитетных точек (ARCHITECTURE_STANDARDS.md)
          // H9 (last-step-broken): финальный шаг тихой пагинации сломан (added=0, курсора нет,
          // скелет/0 кандидатов) → даже при topReached+scrollEngaged scroll-top-proof больше
          // НЕ объявляется (удалён, H12) — уходим в (b) probe / loader-restart; if ниже —
          // диагностика сломанного финального шага (гейт lastPagStepBroken сохранён).
          if (lastPagStepBroken && loaderState.topReached === true && loaderState.scrollEngaged === true &&
              lastOlderNonPagAddAt < (paginationRun.startTs || 0)) {
            debugLog('log', '[gemini-paginate] scroll-top-proof suppressed: last step broken' +
              ' added=' + added + ' serverFirstHash=' + serverFirstHash + ' dbFirstHash=' + dbFirstHash +
              ' retries=' + retriesC73);
          }
          // (b) контрольный probe; решение — в колбэке runCompletenessProbe
          var wideCur = extractCursorWide(lastPaginateOuter);
          // H9b (retain-last-good): оборванный финальный шаг перезаписал lastPaginateOuter
          // битой/терминальной страницей → живой wide-курсор пуст; подаём retained last-good
          // того же convId (ВХОД запроса probe — complete решается только по ответу probe).
          if (!wideCur && lastGoodWideCur && lastGoodWideCur.conv && lastGoodWideCur.conv === (getConvId() || '')) {
            wideCur = lastGoodWideCur.cur;
            debugLog('log', '[AI CM][completeness] retained-wide-cur fed reason=oracle-b' +
              ' convId=' + (getConvId() || '(none)') + ' firstHash=' + dbFirstHash);
          }
          reachedStart = false;
          finishQuiet(false, 'await-probe');
          runCompletenessProbe(dbFirstHash, wideCur);
        }
      })
      .catch(function (err) {
        // v59: устаревший шаг не трогает состояние нового чата
        if (isStaleReqTag(reqTagPag, 'pag')) return;
        debugLog('log', '[gemini-paginate] ошибка шага ' + depth + ': ' + err);
        finishQuiet(false, 'err');
      });
  }

      // ---- finish-quiet: finishQuiet — единственная точка, которая объявляет полноту базы по тихой пагинации (v78 floor-применение, архивный тир) ----
  function finishQuiet(success, reason) {
    quietActive = false;
    // v1.13.1: цикл завершён — фиксируем видимость вкладки на момент завершения
    // (Win+L во время тихой пагинации → результат цикла недостоверен).
    lastCycleEndedHidden = (typeof document !== 'undefined' && document.visibilityState !== 'visible');
    if (success) {
      historyFullByQuiet = true;
      if (reachedStart === true) {
        quietIncompleteNoStart = false; // начало подтверждено — доверие восстановлено
      } else if (reason !== 'end') {
        quietIncompleteNoStart = true;  // 'cap'/'no-meta' без подтверждённого начала — база неполная
      }
      // v69: watchdog — явный probe первой страницы после data-complete; несовпадение
      // firstMsgHash → дозапуск лоадера (≤3 ретраев).
      try { runCompletenessWatchdog(getConvId()); } catch (eW) { swallowSoft(eW, 'gemini:finishQuiet-watchdog'); }
    }
    debugLog('log', '[gemini-paginate] тихий цикл завершён: success=' + success + ' reason=' + reason +
      ' quietPaginated=' + quietPaginated + ' ходов в базе=' + baseSize() +
      (success ? ' (ПОЛНАЯ история собрана СЕТЬЮ, без скролла)' : ''));
    if (success) { try { emitBaseSnapshot(); } catch (e) { swallowSoft(e, 'gemini:finishQuiet-emit'); } }
    if (success && quietPaginated) {
      try { activeRefresh('досбор хвоста после тихой пагинации'); } catch (e) { swallowSoft(e, 'gemini:finishQuiet-tail-refresh'); }
    }
    // v41: при baseComplete=true (голова собрана сетью, цепочка непрерывна) автоскролл
    // НЕ запускаем — он даёт белый экран на скрытом контейнере и крутится до empty*3
    // из-за устаревшего пола в localStorage. Пол перезаписываем фактическим count.
    if (success) {
      var fqId = getConvId();
      if (fqId && parserVersion && typeof localStorage !== 'undefined') {
        try {
          var fk = 'ai-cm-gemini-floor-' + parserVersion + '-' + fqId;
          localStorage.setItem(fk, JSON.stringify({ count: baseSize(), effectiveLen: lastBaseTextLen, ts: Date.now(), version: parserVersion }));
        } catch (e) { swallowSoft(e, 'gemini:finishQuiet-floor-write'); }
      }
      debugLog('log', '[gemini-paginate] фолбэк пропущен: история полная по сети (baseComplete=true)');
    } else if (!quietPaginated) {
      debugLog('log', '[gemini-paginate] тихий цикл не добавил ходов → фолбэк: запускаю автоскролл');
      scheduleAutoScroll();
    }
    // T1-fix (v1.16.1): тихий цикл завершился — гейт live-loading снят, переоцениваем
    // оракул архива ПОСЛЕ собственных решений цикла (порядок веток выше не меняем).
    try { aiCmArchiveTierApply(); } catch (eArcFq) { swallowSoft(eArcFq, 'gemini:finishQuiet-archive-reapply'); }
  }

      // ---- completeness-probe: runCompletenessProbe — независимая проверка полноты: курсор ИИР в probe-ответе, непрочитанная строка НЕ означает more-историю ----
  // ================= v73: контрольный probe полноты (независимый источник (b)) =================
  // Запрос с курсором ШИРОКОЙ экстракции (rest, строки 8..2000) из оборвавшего ответа.
  // Ответ: 0 новых старших ходов И курсора нет → complete; иначе → лоадер-фолбэк.
  // Состояние пагинации (pendingCursor/cursorEpoch/olderHistorySeen/turnsMap) НЕ меняем.
  function runCompletenessProbe(dbFirstHash, wideCur, optsP) {
    var convId = getConvId();
    var retriesP = completenessWatchdogRetries[convId] || 0;
    function probeIncomplete(reason) {
      debugLog('log', '[AI CM][completeness] oracle=incomplete reason=' + reason +
        ' firstHash=' + dbFirstHash + ' retries=' + retriesP + ' convId=' + convId);
      debugLog('log', '[AI CM][completeness] loader-restart reason=incomplete-oracle convId=' + convId);
      // v1.6 (D14): оракул авторитетнее кэш-эвристики — снимаем латч loaderDoneMap,
      // иначе maybeStartLoader упрётся в skip reason=already-done (cache-complete от
      // tape-restore) и страховочный скролл/прогон полноты не перезапустится.
      try { delete loaderDoneMap[convId]; } catch (eD14p) { }
      try { oracleIncompleteSeen[convId] = true; } catch (eD15i) { } // v1.6 (D15): флаг для обхода cache-complete
      debugLog('log', '[AI CM][completeness] latch-cleared for rerun convId=' + convId);
      // v80 (O1-C): ре-ран лоадера (D14/D15) — тоже ПОД оверлеем: закрываем экран заранее,
      // чтобы между loader-stop и повторным hide-apply не мелькал чат. Разоружение — если
      // ре-ран не стартовал/не взял оверлей, снимаем по таймауту (протечки нет: свой
      // __restoreLoader ре-рана снимает оверлей в любом случае). v81 (O1 white-screen A):
      // при восстановленной ленте (tapeWasUsedInThisColdStart) pre-apply НЕ делаем — тейп
      // уже отрисован, оверлей давал «белый экран».
      try {
        if (getConvId() === convId) {
          if (tapeWasUsedInThisColdStart === true) {
            debugLog('log', '[AI CM][visibility] overlay-suppressed reason=tape-present convId=' + (getConvId() || '(none)'));
          } else {
            aiCmSetScrollOverlay(true, 'loader-restart');
          }
          if (aiCmRerunOverlayTimer) { clearTimeout(aiCmRerunOverlayTimer); aiCmRerunOverlayTimer = null; }
          aiCmRerunOverlayTimer = setTimeout(function () {
            aiCmRerunOverlayTimer = null;
            if (aiCmScrollOverlay && !loaderRunningFor) aiCmSetScrollOverlay(false, 'rerun-overlay-disarm');
          }, 4000);
        }
      } catch (eO80) { }
      try { maybeStartLoader(); } catch (eR) { swallowSoft(eR, 'gemini:probeIncomplete-loader-restart'); } // латч loaderDoneMap гейтирует повторный прогон
    }
    // H9b (retain-last-good): retained — ТОЛЬКО вход запроса probe (complete решается
    // исключительно по ответу: probe-terminal). Оборванный финальный шаг пагинации
    // перезаписал lastPaginateOuter битой/терминальной страницей → живой wide-курсор пуст:
    // берём last-good того же convId. Метаданные запроса при пустом живом слоте — из
    // retained (same-convId; ответ всё равно гейтится isStaleReqTag → старый conv не
    // пройдёт). Глобалы подменяем ТОЛЬКО на время синхронной сборки запроса и сразу
    // восстанавливаем — probe-парс не мутирует состояние пагинации.
    var __pMetaSavedH9b = null;
    try {
      if (!wideCur && lastGoodWideCur && lastGoodWideCur.conv &&
          lastGoodWideCur.conv === (getConvId() || '')) {
        wideCur = lastGoodWideCur.cur;
        debugLog('log', '[AI CM][completeness] probe retained-wide-cur convId=' + (getConvId() || '(none)'));
      }
      if ((!lastAtEncoded || !lastBaseUrl || !lastHeaders) && lastGoodProbeMeta &&
          lastGoodProbeMeta.conv && lastGoodProbeMeta.conv === (getConvId() || '')) {
        __pMetaSavedH9b = { a: lastAtEncoded, b: lastBaseUrl, h: lastHeaders };
        lastAtEncoded = lastGoodProbeMeta.atEncoded || lastAtEncoded;
        lastBaseUrl = lastGoodProbeMeta.baseUrl || lastBaseUrl;
        lastHeaders = lastGoodProbeMeta.headers || lastHeaders;
        debugLog('log', '[AI CM][completeness] probe retained-meta convId=' + (getConvId() || '(none)'));
      }
    } catch (eRmH9bp) { }
    if (!wideCur) { probeIncomplete('no-wide-cursor'); return; }
    if (!lastAtEncoded || !lastBaseUrl || !lastHeaders) { probeIncomplete('no-meta'); return; }
    var reqTagP = captureReqTag();
    var pHeaders = {};
    for (var k in lastHeaders) pHeaders[k] = lastHeaders[k];
    // FIX-PAGINATION-FETCH-BINDING: explicit window binding for MV3 module scope
    var pFetchPromH9b = originalFetch.call(globalThis, buildActiveUrl(), {
      method: 'POST', headers: pHeaders, body: buildActiveBodyWith(wideCur), credentials: 'include'
    });
    // H9b: запрос уже сформирован (url/body/headers собраны синхронно) — восстанавливаем
    // живой слот метаданных, если он был подменён retained (см. выше).
    if (__pMetaSavedH9b) {
      try {
        lastAtEncoded = __pMetaSavedH9b.a;
        lastBaseUrl = __pMetaSavedH9b.b;
        lastHeaders = __pMetaSavedH9b.h;
      } catch (eRsH9b) { }
      __pMetaSavedH9b = null;
    }
    pFetchPromH9b
      .then(function (pResp) {
        if (!pResp || !pResp.ok) { probeIncomplete('probe-status' + (pResp ? pResp.status : 'none')); return null; }
        return pResp.text();
      })
      .then(function (pTxt) {
        if (!pTxt || isStaleReqTag(reqTagP, 'pb')) { if (pTxt) probeIncomplete('probe-stale'); return; }
        // parseBatchExecute → handleOuter мутирует диагностику/курсор: сохраняем и восстанавливаем
        var savedCursorP = pendingCursor, savedEpochP = cursorEpoch, savedOlderP = olderHistorySeen;
        var pParsed = parseBatchExecute(pTxt, 'pb');
        var pParseFailed = !!lastFrameParseFail; // O-48: кадр probe-ответа оборван
        var pCursorWide = extractCursorWide(lastPaginateOuter); // outer probe-ответа
        pendingCursor = savedCursorP; cursorEpoch = savedEpochP; olderHistorySeen = savedOlderP;
        // O-48: обрыв кадра probe — НЕ терминал (0 новых ходов и «нет курсора» на обрезанном
        // ответе ничего не доказывают) и НЕ повод гнать лоадер по кругу: отдельный reason,
        // полнота не объявляется (ложная полнота запрещена, [LOW CONFIDENCE] остаётся честным).
        if (pParseFailed) {
          debugLog('log', '[AI CM][completeness] oracle=incomplete reason=parse-fail (probe)' +
            ' firstHash=' + dbFirstHash + ' retries=' + retriesP + ' convId=' + convId +
            ' (кадр probe оборван — терминал НЕ объявляется, рестарт лоадера не запускается)');
          return;
        }
        var newOlder = 0;
        for (var pi = 0; pi < pParsed.length; pi++) {
          var pid = pParsed[pi] && pParsed[pi].id;
          if (pid && !turnsMap[pid]) newOlder++;
        }
        if (newOlder === 0 && !pCursorWide) {
          // H10 (probe-terminal gate): пол авторитетнее ответа probe. Терминальный ответ
          // окна-ДУБЛЯ (e292: newOlder=0 + курсор в turns вне rest-скана extractCursorWide →
          // cursorFound=no) ложно взводил complete на усечённой базе (80 < floor=108);
          // ошибка-страница pb (lastHnvPageError) — complete по не-данным. block →
          // probeIncomplete(reason) → loader-restart (утренний путь докрутки до начала).
          var __ptGate = null;
          var __ptFloor = 0;
          try { __ptFloor = (loadFloor(convId) || {}).count || 0; } catch (ePtF) { swallowSoft(ePtF, 'gemini:runCompletenessProbe-floor-read'); }
          try {
            if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
                typeof window.GeminiInterceptLogic.probeTerminalGate === 'function') {
              __ptGate = window.GeminiInterceptLogic.probeTerminalGate({
                floorCount: __ptFloor,
                baseCount: baseSize(),
                pbError: lastHnvPageError === true
              });
            } else {
              // inline-дубль правила (логика-скрипт недоступен): пол-гейт + pb-error-гейт
              if (__ptFloor > 0 && baseSize() < __ptFloor) {
                __ptGate = { block: true, reason: 'below-floor-probe-terminal' };
              } else if (lastHnvPageError === true) {
                __ptGate = { block: true, reason: 'pb-error-page' };
              }
            }
          } catch (ePtG) { __ptGate = null; }
          if (__ptGate && __ptGate.block) {
            debugLog('log', '[AI CM][completeness] probe-terminal blocked reason=' + __ptGate.reason +
              ' msgs=' + baseSize() + ' floor=' + __ptFloor +
              ' pbError=' + (lastHnvPageError === true ? '1' : '0') + ' convId=' + convId);
            probeIncomplete(__ptGate.reason);
            return;
          }
          historyFullByQuiet = true;
          reachedStart = true;
          quietIncompleteNoStart = false;
          lastCycleEndedHidden = (typeof document !== 'undefined' && document.visibilityState !== 'visible');
          debugLog('log', '[AI CM][completeness] oracle=complete reason=probe-terminal' +
            ' firstHash=' + dbFirstHash + ' newOlder=0 cursorFound=no retries=' + retriesP + ' convId=' + convId);
          try { emitBaseSnapshot(); } catch (eE) { swallowSoft(eE, 'gemini:runCompletenessProbe-emit'); }
          // H9b: терминальный ответ — retained last-good отработал (был входом запроса);
          // сброс, чтобы не перетекать в следующий цикл/чат (прочие сбросы — смена чата).
          lastGoodWideCur = null;
          lastGoodProbeMeta = null;
          if (optsP && typeof optsP.onTerminal === 'function') { try { optsP.onTerminal(); } catch (eCbt) { } }
        } else {
          probeIncomplete('probe-non-terminal newOlder=' + newOlder + ' cursorFound=' + (pCursorWide ? 'yes' : 'no'));
        }
      })
      .catch(function (pErr) {
        probeIncomplete('probe-error ' + (pErr && pErr.message || pErr));
      });
  }

      // ---- completeness-watchdog: runCompletenessWatchdog — до 3 попыток сверки firstMsgHash/lastHeadToken, чтобы не объявить полноту на усечённой базе ----
  // ================= v69: completeness watchdog =================
  // После каждого data-complete (finishQuiet success) выполняем явный probe первой страницы:
  // повторно тянем голову по lastHeadToken и сверяем firstMsgHash. Несовпадение → дозапуск
  // лоадера (≤3 ретраев на чат). DOM-эвристики не участвуют — только факт сети.
  function runCompletenessWatchdog(convId) {
    if (!convId) return;
    if (watchdogFiredMap[convId]) return; // probe уже идёт
    var retries = completenessWatchdogRetries[convId] || 0;
    if (retries >= 3) {
      debugLog('log', '[AI CM][completeness] watchdog=capped retries=' + retries + ' convId=' + convId);
      return;
    }
    var dbFirstHash = aiCmDiagTurnEdge(aiCmOrderedTurns(), 'first').hash;
    // Без метаданных сети или без токена головы сетевой probe невозможен — сверяем по
    // уже захваченному serverFirstHash (курсор считаем исчерпанным, т.к. оракул уже прошёл).
    if (!lastAtEncoded || !lastBaseUrl || !lastHeaders || !lastHeadToken) {
      finishWatchdogDecision(convId, dbFirstHash, serverFirstHash, true, retries);
      return;
    }
    watchdogFiredMap[convId] = true;
    var reqTagW = captureReqTag();
    var headers = {};
    for (var k in lastHeaders) headers[k] = lastHeaders[k];
    // FIX-PAGINATION-FETCH-BINDING: explicit window binding for MV3 module scope
    originalFetch.call(globalThis, buildActiveUrl(), {
      method: 'POST',
      headers: headers,
      body: buildActiveBodyWith(lastHeadToken),
      credentials: 'include'
    })
      .then(function (resp) {
        if (!resp || !resp.ok) {
          debugLog('log', '[AI CM][completeness] watchdog=error reason=status' + (resp ? resp.status : 'none') + ' convId=' + convId);
          watchdogFiredMap[convId] = false;
          return null;
        }
        return resp.text();
      })
      .then(function (txt) {
        if (!txt) { watchdogFiredMap[convId] = false; return; }
        // v59: ответ уходил для старого чата/эпохи — игнорируем probe
        if (isStaleReqTag(reqTagW, 'wd')) { watchdogFiredMap[convId] = false; return; }
        var probeFirstHash = '';
        var probeCursorExhausted = false;
        var probeParseFailed = false; // O-48: обрыв JSON-кадра probe-страницы
        try {
          // parseBatchExecute вызывает handleOuter (диагностические побочки + pendingCursor),
          // но НЕ трогает turnsMap — база не мутируется. Курсор пагинации (D2) не мутируем:
          // состояние probe читаем локально и возвращаем живой pendingCursor на место.
          var savedCursorW = pendingCursor;
          var probeParsed = parseBatchExecute(txt, 'wd');
          probeParseFailed = !!lastFrameParseFail; // O-48: обрыв ≠ «курсора нет»
          var probeCursorFound = pendingCursor;    // курсор probe-страницы (null = её курсор исчерпан)
          pendingCursor = savedCursorW;
          var ordered = probeParsed;
          if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.orderPageByR1) {
            var r1w = window.GeminiInterceptLogic.orderPageByR1(probeParsed);
            if (r1w && r1w.ok && Array.isArray(r1w.ids) && r1w.ids.length === probeParsed.length) {
              var byIdW = {};
              for (var wi = 0; wi < probeParsed.length; wi++) byIdW[probeParsed[wi].id] = probeParsed[wi];
              var reW = [];
              for (var wj = 0; wj < r1w.ids.length; wj++) { if (byIdW[r1w.ids[wj]]) reW.push(byIdW[r1w.ids[wj]]); }
              if (reW.length === probeParsed.length) ordered = reW;
            }
          }
          if (ordered.length) probeFirstHash = aiCmDiagHash6(ordered[0].id, ordered[0].text);
          probeCursorExhausted = !probeCursorFound;
        } catch (e) {
          probeFirstHash = '';
          probeCursorExhausted = false;
          probeParseFailed = true; // O-48: исключение парса — тот же класс обрыва кадра
        }
        finishWatchdogDecision(convId, dbFirstHash, probeFirstHash, probeCursorExhausted, retries, probeParseFailed);
      })
      .catch(function (err) {
        debugLog('log', '[AI CM][completeness] watchdog=error err=' + (err && err.message || err) + ' convId=' + convId);
        watchdogFiredMap[convId] = false;
      });
  }

      // ---- finish-watchdog-decision: finishWatchdogDecision — сводит доказательства (совпадение first-hash, исчерпанность курсора, ретраи, ошибки парса) в один вердикт ----
  function finishWatchdogDecision(convId, dbFirstHash, probeFirstHash, probeCursorExhausted, retries, probeParseFailed) {
    var ok = (probeCursorExhausted === true) && !!dbFirstHash && !!probeFirstHash && dbFirstHash === probeFirstHash;
    if (ok) {
      completenessWatchdogRetries[convId] = 0;
      debugLog('log', '[AI CM][completeness] watchdog=ok firstHash=' + dbFirstHash + ' serverFirstHash=' + probeFirstHash + ' retries=' + retries + ' convId=' + convId);
      watchdogFiredMap[convId] = false;
      return;
    }
    // O-48 (D3): обрыв JSON-кадра probe-страницы — отдельный reason='parse-fail'. Это НЕ
    // неполнота базы (на обрезанном ответе «курсора нет» ничего не доказывает) и НЕ повод
    // гнать лоадер по кругу: бюджет полноты не тратится, рестарт не запускается, полнота
    // не объявляется — итог честный ([LOW CONFIDENCE] по 60с-таймауту, D1).
    if (probeParseFailed === true) {
      debugLog('log', '[AI CM][completeness] watchdog=fail reason=parse-fail firstHash=' + dbFirstHash +
        ' serverFirstHash=' + probeFirstHash + ' retries=' + (retries || 0) + ' convId=' + convId +
        ' (кадр probe оборван: ретрай лоадера НЕ запускается, полнота НЕ объявляется)');
      watchdogFiredMap[convId] = false;
      return;
    }
    completenessWatchdogRetries[convId] = (retries || 0) + 1;
    var reason = (probeCursorExhausted === false) ? 'cursor-alive' : 'first-hash-mismatch';
    debugLog('log', '[AI CM][completeness] watchdog=fail reason=' + reason + ' firstHash=' + dbFirstHash + ' serverFirstHash=' + probeFirstHash + ' retries=' + completenessWatchdogRetries[convId] + ' convId=' + convId);
    // Дозапуск лоадера (≤3): сбрасываем полноту и разрешаем повторный прогон.
    historyFullByQuiet = false;
    reachedStart = false;
    reachedStartByScroll = false;
    quietIncompleteNoStart = false;
    quietDecisionMade = false;
    delete loaderDoneMap[convId];
    if (completenessWatchdogRetries[convId] <= 3) {
      try { maybeStartLoader(); } catch (eR) { swallowSoft(eR, 'gemini:finishWatchdogDecision-loader-restart'); }
    }
    watchdogFiredMap[convId] = false;
  }

      Fn.classifyOpaque = classifyOpaque;
      Fn.edges8 = edges8;
      Fn.walkOpaque = walkOpaque;
      Fn.findCursors = findCursors;
      Fn.extractCursor = extractCursor;
      Fn.classifyOpaqueWide = classifyOpaqueWide;
      Fn.extractCursorWide = extractCursorWide;
      Fn.refreshMinOrderTracking = refreshMinOrderTracking;
      Fn.paginateLoop = paginateLoop;
      Fn.finishQuiet = finishQuiet;
      Fn.runCompletenessProbe = runCompletenessProbe;
      Fn.runCompletenessWatchdog = runCompletenessWatchdog;
      Fn.finishWatchdogDecision = finishWatchdogDecision;
    }
  }
  Fn.__bind = __bind;
  if (typeof window !== 'undefined') { window.AiCmGeminiPagination = Fn; }
}());
