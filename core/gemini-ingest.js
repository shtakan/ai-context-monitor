/**
 * core/gemini-ingest.js — ingest-кластер Gemini-перехватчика (Phase 3 step 12).
 *
 * ЧТО ЗДЕСЬ. Приём снимков базы (handleOuter, ingest), точка выхода снимка
 * (emitBaseSnapshot), разбор кадра в ходы (ingestAttachments, firstRc, logIdmap,
 * extractModelName, extractTurnId/Ts/R1, rontgenPagination, applyStreamAliases),
 * слияние восстановленных ходов (sanitizeRestoredTurn, mergeRestoredTurns),
 * наблюдатель активного обновления (shouldPollVf5, startRefreshObserver) и их
 * состояние: 24 объявления — самая крупная связная группа ядра.
 *
 * ПОЧЕМУ ВЫНЕСЕНО. Кластер занимал 17 кусков ядра между чужими функциями.
 * Тела перенесены БАЙТ-В-БАЙТ, без префиксов: существующие пины режут функции из
 * конкатенации и исполняют их в песочнице с подменённым окружением, поэтому тела
 * обязаны остаться с голыми идентификаторами. Связь с ядром — через объект связи,
 * который ядро передаёт в __bind (внутренняя переменная D).
 *
 * СВЯЗКА. Ядро зовёт window.AiCmGeminiIngest.__bind({...}) из core/gemini-intercept.js;
 * состав объекта связи — tools/ingest-bind-contract.js: 13 функций значением,
 * 11 поздних алиасов, 41 живое состояние с геттером и сеттером, 7 только на чтение.
 * Обратно модуль отдаёт 16 функций (см. PUBLIC API ниже).
 *
 * ПРАВКА ПРИ ПЕРЕНОСЕ. Единственная — присваивание имени функции объекту Fn внутри
 * with, вместо возврата объекта: возврат объекта внутри with ломает esbuild.
 * Тела функций и инициализаторы состояния не тронуты.
 *
 * ПОРЯДОК ПОДКЛЮЧЕНИЯ. В js[] core/background.js модуль идёт после
 * core/gemini-loader-scroll.js и перед core/gemini-intercept.js. При добавлении
 * сюда файла — бамп id регистрации: MV3 не перечитывает js[] под уже
 * зарегистрированным id.
 *
 * ВНИМАНИЕ. Файл намеренно без директивы строгого режима: with в строгом режиме
 * запрещён, и файл никогда не попадает в esbuild-бандл (как модуль пагинации).
 * Прозу этой шапки проверяет tools/check-ingest-comment-shadows.js: длинные цитаты
 * из пинов тестов здесь запрещены, иначе пин начинает мерить шапку, а не код.
 *
 * PUBLIC API: window.AiCmGeminiIngest = { __bind, firstRc, logIdmap,
 *   ingestAttachments, extractModelName, extractTurnId, extractTurnTs, extractTurnR1,
 *   handleOuter, rontgenPagination, shouldPollVf5, startRefreshObserver,
 *   emitBaseSnapshot, applyStreamAliases, ingest, sanitizeRestoredTurn,
 *   mergeRestoredTurns }.
 */

(function () {
  if (typeof window !== 'undefined' && window.AiCmGeminiIngest) return;
  var D = null;
  var Fn = {};
  function __bind(d) {
    D = d;
    with (D) {

      // ---- consts-media: константы-накопители вложений (оценка токенов картинок/документов) ----
  var IMAGE_DEFAULT_TOKENS = 516;
  var DOC_EST_TOKENS = 2500;

      // ---- DEBUG_STRUCTURE: флаг подробного лога структуры ----
  var DEBUG_STRUCTURE = false;

      // ---- IDMAP_MAX: потолок карты id↔ход ----
  var IDMAP_MAX = 6;

      // ---- REFRESH_MIN_MS: минимальный интервал активного refresh ----
  var REFRESH_MIN_MS = 4000;

      // ---- observer-mut: состояние наблюдателя мутаций ----
  var observerStarted = false;
  var mutTimer = null;

      // ---- firstRc+logIdmap: разбор первого rc-узла и лог карты id ----
  function firstRc(node) {
    var found = null;
    (function walk(n) {
      if (found) return;
      if (typeof n === 'string' && /^rc_[0-9a-f]+$/.test(n)) { found = n; return; }
      else if (Array.isArray(n)) { for (var i = 0; i < n.length; i++) { walk(n[i]); if (found) return; } }
    })(node);
    return found;
  }
  function logIdmap(t, src, textlen, preview) {
    var r0 = (Array.isArray(t) && Array.isArray(t[0]) && typeof t[0][1] === 'string') ? t[0][1] : '';
    var r1 = (Array.isArray(t) && Array.isArray(t[1]) && typeof t[1][1] === 'string') ? t[1][1] : '';
    var rc = firstRc(t);
    var ts = 0;
    try { if (Array.isArray(t) && Array.isArray(t[1]) && typeof t[1][0] === 'number' && t[1][0] > 1000000000) ts = t[1][0]; } catch (e) { }
    // v1.6 (D15a-2): preview — первые 40 символов текста хода (для поиска «Составь промт…» по id)
    var txt = String(preview || '').replace(/\s+/g, ' ').slice(0, 40);
    debugLog('log', '[gemini-idmap] src=' + src + ' ts=' + ts + ' r0=' + (r0 ? r0.slice(0, 6) : '-') + ' r1=' + (r1 ? r1.slice(0, 6) : '-') +
      ' rc=' + (rc ? rc.slice(0, 6) : '-') + ' textlen=' + textlen + ' txt=' + JSON.stringify(txt));
  }

      // ---- ingestAttachments: сбор вложений хода ----
  function ingestAttachments(items) {
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (attachSeen[it.name]) continue;
      attachSeen[it.name] = 1;
      var tt;
      if (it.mime && it.mime.indexOf('image/') === 0) {
        tt = IMAGE_DEFAULT_TOKENS;
        attachBreak.imgTokens += tt;
        attachBreak.imgCount++;
      } else if (it.mime && (it.mime === 'application/pdf' ||
        it.mime.indexOf('wordprocessingml') !== -1 ||
        it.mime.indexOf('spreadsheetml') !== -1 ||
        it.mime.indexOf('presentationml') !== -1 ||
        it.mime.indexOf('officedocument') !== -1)) {
        tt = DOC_EST_TOKENS;
        attachBreak.docTokens += tt;
        attachBreak.docCount++;
      } else {
        // прочие MIME — считаем по умолчанию как изображение (516)
        tt = IMAGE_DEFAULT_TOKENS;
        attachBreak.imgTokens += tt;
        attachBreak.imgCount++;
      }
      attachTokens += tt;
    }
  }

      // ---- extract*: регулярка модели и извлечение id/ts/rc хода ----
  var MODEL_NAME_RE = /^\s*(?:Gemini\s*[\d.]?|\d+(?:\.\d+)?\s+(?:Flash|Pro|Ultra|Gemini))/i;
  function extractModelName(node) {
    var found = null;
    (function walk(n) {
      if (found) return;
      if (typeof n === 'string') {
        if (n.length < 60 && n.indexOf('\n') < 0 && MODEL_NAME_RE.test(n)) { found = n.trim(); return; }
      } else if (Array.isArray(n)) { for (var i = 0; i < n.length; i++) { walk(n[i]); if (found) return; } }
    })(node);
    return found || '';
  }
  function extractTurnId(node) {
    var found = null;
    (function walk(n) {
      if (found) return;
      if (typeof n === 'string' && /^r_[0-9a-f]+$/.test(n)) { found = n; return; }
      else if (Array.isArray(n)) { for (var i = 0; i < n.length; i++) { walk(n[i]); if (found) return; } }
    })(node);
    return found;
  }
  function extractTurnTs(t) {
    try {
      if (Array.isArray(t) && Array.isArray(t[1]) && typeof t[1][0] === 'number' && t[1][0] > 1000000000) return t[1][0];
    } catch (e) { swallow(e, 'gemini:extractTurnTs'); }
    return 0;
  }
  // v35: r1 = id соседа НОВЕЕ (t[1][1], подтверждено логами idmap).
  function extractTurnR1(t) {
    try {
      if (Array.isArray(t) && Array.isArray(t[1]) && typeof t[1][1] === 'string') return t[1][1];
    } catch (e) { swallow(e, 'gemini:extractTurnR1'); }
    return null;
  }

      // ---- handleOuter: приём кадра базы (outer) — главная точка входа ingest ----
  function handleOuter(outer, out, src) {
    try {
      // v1.15: маркер ошибки-страницы сбрасывается для КАЖДОЙ новой hNvQHb-страницы.
      // Страница-ошибка (inner не строка / BardErrorInfo) НЕ является концом истории:
      // курсор прошлого шага жив — окно повторяем (ретрай в paginateLoop), а не гасим цикл.
      lastHnvPageError = false;
      if (!Array.isArray(outer) || !Array.isArray(outer[0])) return;
      if (outer[0][1] !== 'hNvQHb') return;
      var inner = outer[0][2];
      if (typeof inner !== 'string') {
        // v1.15: распознаём ошибку Bard (inner=null + BardErrorInfo в метаданных wrb-блока,
        // пример: code 1177) и сообщаем пагинации, что это НЕ терминальная страница.
        var isErr1177 = false;
        try {
          if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
              typeof window.GeminiInterceptLogic.isBardErrorPage === 'function') {
            isErr1177 = window.GeminiInterceptLogic.isBardErrorPage(outer);
          } else {
            var __s1177 = JSON.stringify(outer[0]).slice(0, 2000);
            isErr1177 = __s1177.indexOf('type.googleapis.com') !== -1 ||
              __s1177.indexOf('BardError') !== -1 || __s1177.indexOf('ErrorInfo') !== -1;
          }
        } catch (e1177) { isErr1177 = false; }
        lastHnvPageError = isErr1177;
        lastFailedSkeleton = buildJsonSkeleton(outer, 0);
        debugLog('log', '[gemini-skeleton] сохранён src=' + src + ' (inner не строка)' +
          (isErr1177 ? ' → BARD-ERROR PAGE (окно будет повторено)' : ''));
        return;
      }
      var turns = JSON.parse(inner);
      if (!Array.isArray(turns)) {
        lastFailedSkeleton = buildJsonSkeleton(outer, 0);
        debugLog('log', '[gemini-skeleton] сохранён src=' + src + ' (turns не массив)');
        return;
      }
      if (!loggedRontgen) { loggedRontgen = true; try { rontgenPagination(outer, turns); } catch (e) { } }
      // сохраняем outer для дампа в paginateLoop (диагностика формата курсора)
      lastPaginateOuter = outer;
      // v18: извлекаем opaque-курсор из ответа и сохраняем в pendingCursor для запуска тихой пагинации.
      //   Эта строка была потеряна в v17 при добавлении сброса чата → тихий цикл никогда не стартовал.
      pendingCursor = extractCursor(turns);
      // v1.6 (D16): диагностика источника курсора (откуда взят токен пагинации)
      if (pendingCursor) lastCursorSource = src;
      else if (src === 'pag' || src === 'vf5' || src === 'passive') lastCursorSource = 'none:' + src;
      // v53: любой history-write с курсором — новое поколение (сбрасывает счётчики лоадера)
      if (pendingCursor) cursorEpoch++;
      // v46: сигнал «есть старшая история» для гейта старта лоадера
      if (pendingCursor) olderHistorySeen = true;
      // v74 (баг B): первый снимок БЕЗ continuation-курсора (olderHistorySeen=false) —
      // сервер отдал терминальную страницу (страница без курсора = неполная/последняя),
      // старшей истории нет → полнота сразу. Только для пассивных снимков (passive/vf5):
      // pag-страницы и диагностические парсы ('pb'/'sh'/'wd') оракул не минуют.
      // O-48: блок НЕ переписан (байтовый пин «прежние пути полноты»). На ВОССТАНОВЛЕННОМ
      // (обрезанном) кадре взведённая здесь полнота откатывается вызывающим —
      // см. handleSalvagedOuter (отсутствие курсора в обрывке ничего не доказывает, D1).
      if ((src === 'passive' || src === 'vf5') && !pendingCursor && !olderHistorySeen &&
          Array.isArray(turns) && turns.length > 0 && !historyFullByQuiet) {
        historyFullByQuiet = true;
        reachedStart = true;
        quietIncompleteNoStart = false;
        quietDecisionMade = true; // фолбэк-автоскролл не нужен — история полная
        debugLog('log', '[AI CM][completeness] oracle=complete reason=no-older-history turns=' + turns.length +
          ' convId=' + (getConvId() || '(none)'));
      }
      // v27: сбор ВСЕХ opaque-кандидатов в lastPaginateOpaqueCandidates (как rontgenPagination,
      // но на каждом вызове handleOuter) для диагностики обрыва тихой пагинации
      try {
        var arr0 = outer[0];
        var rest = arr0.slice(3);
        var restTypes = rest.map(function (x) { return x === null ? 'null' : (Array.isArray(x) ? 'arr' : typeof x); });
        var turnsLen = Array.isArray(turns) ? turns.length : ('не_массив:' + typeof turns);
        var lastDesc = '?';
        if (Array.isArray(turns) && turns.length) {
          var le = turns[turns.length - 1];
          if (le === null) lastDesc = 'null';
          else if (Array.isArray(le)) lastDesc = 'массив(ход?) len=' + le.length;
          else if (typeof le === 'string') lastDesc = 'СТРОКА len=' + le.length + (classifyOpaque(le) ? ' → OPAQUE "' + edges8(le) + '"' : ' → текст/прочее(не opaque)');
          else lastDesc = typeof le;
        }
        var cands = [];
        walkOpaque(rest, 'rest', cands);
        if (Array.isArray(turns)) {
          for (var wi = 0; wi < turns.length; wi++) walkOpaque(turns[wi], 'turn' + wi, cands);
        }
        lastPaginateOpaqueCandidates = {
          arr0len: arr0.length,
          restTypes: restTypes,
          turnsLen: turnsLen,
          lastDesc: lastDesc,
          cands: cands
        };
        // сбор всех строк длиной 20..2000 из текущего outer для диагностики формата курсора
        var allStrs = [];
        (function walkAll(node) {
          if (allStrs.length >= 40) return;
          if (typeof node === 'string') {
            if (node.length >= 20 && node.length <= 2000)
              allStrs.push('len=' + node.length +
                ' head=' + JSON.stringify(node.slice(0, 24)) +
                ' tail=' + JSON.stringify(node.slice(-24)));
            return;
          }
          if (Array.isArray(node)) for (var i = 0; i < node.length; i++) walkAll(node[i]);
        })(outer);
        lastAllStrings = allStrs;
        // v72diag: rest-строки (outer[0].slice(3)) для КАЖДОЙ страницы hNvQHb — кандидаты
        // курсора ВНЕ turns (walkOpaque ограничен 40..600; курсор может быть длиннее).
        try {
          var restDiag = arr0.slice(3);
          for (var rdi = 0; rdi < restDiag.length; rdi++) {
            (function walkRest(node) {
              if (typeof node === 'string') {
                if (node.length < 8) return;
                var isB64 = /^[A-Za-z0-9+/=]+$/.test(node);
                debugLog('log', '[AI CM][cursor-diag] rest[' + rdi + '] len=' + node.length +
                  ' b64=' + (isB64 ? 'yes' : 'no') +
                  ' head=' + JSON.stringify(node.slice(0, 12)) +
                  ' tail=' + JSON.stringify(node.slice(-12)) +
                  (isB64 && node.length >= 40 ? ' → CANDIDATE' : '') +
                  ' convId=' + (getConvId() || '(none)') + ' src=' + src);
                return;
              }
              if (Array.isArray(node)) for (var ri = 0; ri < node.length; ri++) walkRest(node[ri]);
            })(restDiag[rdi]);
          }
        } catch (eRd) { }
      } catch (e) { lastPaginateOpaqueCandidates = null; }
      if (DEBUG_STRUCTURE && !loggedStructure) {
        loggedStructure = true;
        var sm = []; structureMap(turns, 0, sm, { n: 0 });
        debugLog('log', '[gemini-intercept] рентген структуры хода #0 (глубина:длина:тип): ' + sm.join(' | '));
      }
      var doIdmap = (idmapCalls < IDMAP_MAX);
      var _nonEmpty = 0, _empty = 0, _skippedIds = [];
      var realTurns = (Array.isArray(turns[0]) && Array.isArray(turns[0][0])) ? turns[0] : turns;
      // v1.6 (D13): DR stateless — обновляем DR-контент парсера из этих realTurns;
      // splitTurnMessages в цикле ниже заменит голые ссылки (immersive/подтверждение)
      // на текст отчёта/плана. Пересборки стабильны (нет синтетического хода).
      try {
        if (typeof window !== 'undefined' && window.GeminiBatchexecuteParser &&
            typeof window.GeminiBatchexecuteParser.extractDrTexts === 'function' &&
            typeof window.GeminiBatchexecuteParser.__setDrTexts === 'function') {
          window.GeminiBatchexecuteParser.__setDrTexts(window.GeminiBatchexecuteParser.extractDrTexts(realTurns));
        }
      } catch (eD13) { debugLog('log', '[gemini-intercept] parse-top fail (eD13/DR): ' + (eD13 && eD13.message || eD13)); }
      // v38: raw внутри страницы идёт «новые→старые». Обходим С КОНЦА, чтобы
      // по возрастанию order (assignPageOrders) итог был «старые→новые»;
      // внутри хода user стоит раньше assistant → получает меньший order.
      for (var i = realTurns.length - 1; i >= 0; i--) {
        var t = realTurns[i];
        if (!Array.isArray(t)) continue;
        var localSeen = new Set(); var items = [];
        collectAttachments(t, localSeen, items);
        ingestAttachments(items);
        var modelName = extractModelName(t);
        var turnId = extractTurnId(t) || ('idx' + out.total++);
        var turnTs = extractTurnTs(t);
        var r1 = extractTurnR1(t);
        // v30/v31: текст хода и роли собираем через чистый сетевой парсер
        // (utils/gemini-batchexecute-parser.js): вычищаем $AXzLiR-токены и сегменты «мышления»,
        // разделяем вопрос пользователя и ответ модели, сохраняем таблицы.
        var segs = [];
        if (typeof window !== 'undefined' && window.GeminiBatchexecuteParser) {
          try { segs = window.GeminiBatchexecuteParser.splitTurnMessages(t); } catch (e) { segs = []; }
        }
        if (!segs || !segs.length) {
          // fallback: прежний сбор одним текстом (без ролей)
          var fb = []; collectContent(t, fb);
          var fbt = fb.join('\n').trim();
          if (fbt) segs = [{ role: 'assistant', text: fbt }];
        }
        var anyNonEmpty = false;
        for (var s = 0; s < segs.length; s++) {
          var seg = segs[s];
          var stxt = (seg && seg.text) ? seg.text.trim() : '';
          if (!stxt) continue;
          anyNonEmpty = true;
          var role = (seg.role === 'user') ? 'user' : 'assistant';
          var mid = turnId + '_' + role;
          out.turns.push({ id: mid, text: stxt, modelName: modelName, ts: turnTs, role: role, turnId: turnId, r1: r1 });
        }
        if (doIdmap) {
          try {
            var previewTxt = '';
            for (var pv = 0; pv < segs.length; pv++) {
              if (segs[pv] && segs[pv].text) { previewTxt = segs[pv].text; break; }
            }
            logIdmap(t, src, (segs && segs.length) ? segs.map(function (x) { return (x && x.text) ? x.text.length : 0; }).reduce(function (a, b) { return a + b; }, 0) : 0, previewTxt);
          } catch (e) { }
        }
        if (anyNonEmpty) { _nonEmpty++; }
        else { _empty++; _skippedIds.push(turnId); }
      }
      if (_nonEmpty === 0) {
        lastFailedSkeleton = buildJsonSkeleton(outer, 0);
        debugLog('log', '[gemini-skeleton] сохранён src=' + src + ' (0 извлечённых ходов, outer len=' + (Array.isArray(outer) ? outer.length : '?') + ')');
      }
      // NOTE: успешные страницы НЕ сбрасывают lastFailedSkeleton — последний скелет
      // непарсящейся страницы должен дожить до дампа диагностики.
      debugLog('log', '[gemini-ingest-trace] handleOuter src=' + src + ' ходов_всего=' + turns.length +
        ' непустых=' + _nonEmpty + ' пропущено(пустой_text)=' + _empty +
        (_empty > 0 ? ' пропущ_ids=[' + _skippedIds.join(',') + ']' : ''));
    } catch (e) { debugLog('log', '[gemini-intercept] parse-top fail (handleOuter): ' + (e && e.message || e)); /* один кривой блок не ломает остальные */ }
  }

      // ---- rontgenPagination: рентген пагинации (диагностика кадра) ----
  function rontgenPagination(outer, turns) {
    try {
      var arr0 = outer[0];
      var rest = arr0.slice(3);
      var restTypes = rest.map(function (x) { return x === null ? 'null' : (Array.isArray(x) ? 'arr' : typeof x); });
      var turnsLen = Array.isArray(turns) ? turns.length : ('не_массив:' + typeof turns);
      var lastDesc = '?';
      if (Array.isArray(turns) && turns.length) {
        var le = turns[turns.length - 1];
        if (le === null) lastDesc = 'null';
        else if (Array.isArray(le)) lastDesc = 'массив(ход?) len=' + le.length;
        else if (typeof le === 'string') lastDesc = 'СТРОКА len=' + le.length + (classifyOpaque(le) ? ' → OPAQUE "' + edges8(le) + '"' : ' → текст/прочее(не opaque)');
        else lastDesc = typeof le;
      }
      var cands = [];
      walkOpaque(rest, 'rest', cands);
      if (Array.isArray(turns)) {
        for (var i = 0; i < turns.length; i++) walkOpaque(turns[i], 'turn' + i, cands);
      }
      debugLog('log', '[gemini-rontgen] outer[0].len=' + arr0.length +
        ' | rest(после inner)=[' + restTypes.join(',') + ']' +
        ' | turns.len=' + turnsLen +
        ' | lastTurn=' + lastDesc +
        ' | opaque-кандидаты(НЕ переписка — рус.текст фильтр не проходит): ' +
        (cands.length ? cands.join('  ||  ') : '(НЕТ ни на уровне rest, ни внутри ходов)'));
    } catch (e) { debugLog('log', '[gemini-rontgen] ошибка:', e); }
  }

      // ---- shouldPollVf5: решение о поллинге vf5 ----
  function shouldPollVf5(now) {
    if (typeof window === 'undefined' || !window.GeminiInterceptLogic || !window.GeminiInterceptLogic.shouldPollVf5) {
      return true;
    }
    return window.GeminiInterceptLogic.shouldPollVf5({
      baseComplete: historyFullByQuiet,
      reachedStart: reachedStart,
      lastActivityAt: lastVf5ActivityAt
    }, now);
  }

      // ---- startRefreshObserver: наблюдатель активного обновления ----
  function startRefreshObserver() {
    if (observerStarted) return;
    observerStarted = true;
    lastActiveAt = Date.now();
    lastVf5ActivityAt = Date.now();
    try {
      var obs = new MutationObserver(function (mutations) {
        var hasNew = false;
        for (var i = 0; i < mutations.length; i++) {
          var m = mutations[i];
          var tgt = m.target;
          try { if (tgt && tgt.closest && tgt.closest('#ai-context-widget')) continue; } catch (e) { }
          if (m.type === 'characterData') { hasNew = true; break; }
          if (m.type === 'childList') {
            for (var j = 0; j < m.addedNodes.length; j++) {
              var n = m.addedNodes[j];
              if (n.nodeType === 1 && (n.textContent || '').trim().length > 10) { hasNew = true; break; }
            }
          }
          if (hasNew) break;
        }
        if (!hasNew) return;
        lastVf5ActivityAt = Date.now(); // v40: DOM-мутация — активность, сброс тишины
        clearTimeout(mutTimer);
        mutTimer = setTimeout(function () {
          if (Date.now() < scrollRecentUntil) return; // мутации от скролла — не rebuild
          var now = Date.now();
          // v55: DOM-догон. Срабатывание дебаунса = 2.5с без новых мутаций = стриминг
          // ответа завершён. Просим content.js (ISOLATED) сделать ЛОКАЛЬНЫЙ пересчёт
          // токенов (baseText + DOM-хвост, существующий tokenEstimate) и переэмитить
          // базу — БЕЗ сетевого запроса. Это снимает «лаг в одну реплику» независимо
          // от rpcids. Гарды: активная вкладка, лоадер не бежит (не ломать пол),
          // тихая пагинация не активна. Stream-ingest (rpcid I4z33b/Bsxleb) остаётся
          // запасным источником — здесь мы его не заменяем, а дублируем локально.
          var convIdDe = getConvId();
          if (convIdDe &&
              loaderRunningFor !== convIdDe &&
              !quietActive &&
              document.visibilityState === 'visible') {
            try { window.dispatchEvent(new CustomEvent('ai-cm-dom-emit-request')); } catch (eDe) { }
          }
          if (!shouldPollVf5(now)) {
            debugLog('log', '[gemini-virtual-f5] vf5-поллер в тишине — полная история без активности 60с, пропускаю');
            return;
          }
          if (now - lastActiveAt < REFRESH_MIN_MS) return;
          lastActiveAt = now;
          activeRefresh('после мутаций (realtime)', true);
        }, 2500);
      });
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    } catch (e) {
      debugLog('log', '[gemini-virtual-f5] не удалось поставить observer-триггер:', e);
    }
  }

      // ---- emitBaseSnapshot: точка выхода снимка базы ----
  function emitBaseSnapshot() {
    // T1 (v1.16): первый ярус — архив. Переоценка archive-complete на каждом EMIT:
    // база могла дорасти до архивного count уже после импорта. Гейты H9/H10 не тронуты.
    try { aiCmArchiveTierApply(); } catch (eArcEmit) { swallow(eArcEmit, 'gemini:emitBaseSnapshot-archive-reapply'); }
    // v35: финальный порядок по связному списку r1 (детерминирован, не зависит от
    // порядка прибытия страниц). Фолбэк — сортировка по order (прежнее поведение).
    var orderItems = [];
    var mapIds = Object.keys(turnsMap);
    // v36 диагностика head: «ход» = turnId||id (как в orderByR1Chain).
    var diagR1Targets = {};   // значения r1 (id более новых соседей)
    var diagTurnSeen = {};    // turnId -> true
    var diagTurnNull = {};    // turnId -> true, если у хода r1 === null/undefined
    for (var oi = 0; oi < mapIds.length; oi++) {
      var oid = mapIds[oi];
      var ot = turnsMap[oid];
      orderItems.push({
        id: oid,
        turnId: ot.turnId || null,
        r1: ot.r1 || null,
        order: ot.order || 0,
        role: ot.role,
        // T1-fix#4 (v1.16.4): ход влит архивом → чистая orderExportMessages уведёт его
        // в ГОЛОВУ файла (архив = старшая история). У чатов без архива поля нет —
        // порядок байтово прежний.
        archive: ot.archiveAdded === true
      });
      var oTk = ot.turnId || oid;
      if (ot.r1) diagR1Targets[ot.r1] = true;
      if (!(oTk in diagTurnSeen)) {
        diagTurnSeen[oTk] = true;
        diagTurnNull[oTk] = !ot.r1;
      } else if (ot.r1) {
        diagTurnNull[oTk] = false;
      }
    }
    var nullR1Count = 0;
    var headCandidates = [];
    var diagTurns = Object.keys(diagTurnSeen);
    for (var dti = 0; dti < diagTurns.length; dti++) {
      var dTk = diagTurns[dti];
      if (diagTurnNull[dTk]) nullR1Count++;
      if (!diagR1Targets[dTk]) headCandidates.push(dTk);
    }
    // v4x: финальный порядок — единая функция экспорта (D15): r1-цепочка ТОЛЬКО когда
    // её голова = серверной (первый user-ход); при рваной r1-перемычке (nullR1Count>=1)
    // приоритет — серверный порядок (orderByArrival / order). Авто == ручной побайтово.
    var ids = null;
    var usedR1 = false;
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic &&
        typeof window.GeminiInterceptLogic.orderExportMessages === 'function') {
      var expD15 = window.GeminiInterceptLogic.orderExportMessages(orderItems);
      if (expD15 && expD15.ids) {
        ids = expD15.ids;
        usedR1 = (expD15.mode === 'chain-r1');
      }
    }
    if (!ids) {
      if (orderItems.length) {
        debugLog('log', '[gemini-order] порядок не построен, фолбэк (сортировка по order)');
      }
      ids = mapIds.slice().sort(function (a, b) {
        return (turnsMap[a].order || 0) - (turnsMap[b].order || 0);
      });
    }
    lastOrderedIds = ids.slice();

    // v39: самопроверка r1-инверсий (r1 = сосед СТАРШЕ, должен идти раньше).
    var inversions = 0;
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.countR1Inversions) {
      var invItems = [];
      for (var ivi = 0; ivi < ids.length; ivi++) {
        var ivRec = turnsMap[ids[ivi]];
        invItems.push({ id: ids[ivi], turnId: ivRec ? ivRec.turnId : null, r1: ivRec ? ivRec.r1 : null });
      }
      inversions = window.GeminiInterceptLogic.countR1Inversions(invItems);
    }
    debugLog('log', '[gemini-order-check] inversions=' + inversions);

    // Диагностика порядка/покрытия одним логом (см. ТЗ).
    var mapTurns = mapIds.length;
    var chainLen = ids.length;
    var inChain = {};
    for (var ci = 0; ci < ids.length; ci++) inChain[ids[ci]] = true;
    var disconnected = [];
    for (var di = 0; di < mapIds.length; di++) {
      if (!inChain[mapIds[di]]) disconnected.push(mapIds[di]);
    }
    var disconnectedCount = Math.max(0, mapTurns - chainLen);
    var firstUser = '';
    for (var fu = 0; fu < ids.length; fu++) {
      var fud = turnsMap[ids[fu]];
      if (fud && fud.role === 'user') { firstUser = (fud.text || '').slice(0, 60); break; }
    }
    var lastId = ids.length ? ids[ids.length - 1] : null;
    var lastText = lastId && turnsMap[lastId] ? (turnsMap[lastId].text || '').slice(-60) : '';
    var orderLog = '[gemini-order] mode=' + (usedR1 ? 'chain-r1' : 'arrival') +
      ' mapTurns=' + mapTurns +
      ' chainLen=' + chainLen +
      ' disconnected=' + disconnectedCount +
      ' nullR1Count=' + nullR1Count +
      ' headCandidates=' + (headCandidates.length ? headCandidates.join(',') : 'нет head') +
      ' firstUser=' + JSON.stringify(firstUser) +
      ' lastText=' + JSON.stringify(lastText);
    if (disconnectedCount > 0 || mapTurns !== chainLen) {
      var dd = [];
      for (var dk = 0; dk < disconnected.length && dk < 3; dk++) {
        var did = disconnected[dk];
        dd.push(did + '(r1=' + (turnsMap[did] ? String(turnsMap[did].r1 || '') : '') + ')');
      }
      if (dd.length) orderLog += ' detached=[' + dd.join(',') + ']';
    }
    debugLog('log', orderLog);

    var pieces = []; var lastModelName = '';
    for (var j = 0; j < ids.length; j++) {
      var t = turnsMap[ids[j]];
      pieces.push(t.text);
      if (t.modelName) lastModelName = t.modelName;
    }
    // v31: сообщения с ролями (user/assistant) для экспорта истории
    var messages = [];
    for (var mi = 0; mi < ids.length; mi++) {
      var tm = turnsMap[ids[mi]];
      messages.push({ role: (tm.role === 'user') ? 'user' : 'assistant', text: tm.text, id: ids[mi] });
    }
    // v4x: санация мышления и строгий дедуп ПЕРЕД эмиссией и сохранением.
    // messageTexts/messageIds пересобираем из санированного messages, чтобы
    // historyPreviews и экспорт не содержали блоков мышления и дублей.
    messages = sanitizeMessagesForEmit(messages);
    // v4x: возвращаем r1/turnId к санированным сообщениям, чтобы лента (tape) сохраняла
    // связный список порядка и после восстановления мерджилась по r1-цепочке.
    for (var mr = 0; mr < messages.length; mr++) {
      var mrid = messages[mr].id;
      var mrec = turnsMap[mrid];
      if (mrec) {
        messages[mr].r1 = mrec.r1 || null;
        messages[mr].turnId = mrec.turnId || null;
      }
    }
    pieces = [];
    var cleanIds = [];
    for (var cj = 0; cj < messages.length; cj++) {
      pieces.push(messages[cj].text);
      if (messages[cj].id != null) cleanIds.push(messages[cj].id);
    }
    ids = cleanIds;
    var text = pieces.join('\n');
    lastBaseTextLen = text.length;
    var effectiveLen = text.length;
    var floorApplied = false;
    var floorValue = 0;

    // v29: диагностика полноты базы ДО применения пола
    var fid = getConvId();
    var savedFloor = fid ? loadFloor(fid) : null;
    var baseComplete = historyFullByQuiet;
    debugLog('log', '[gemini-base-diag] count=' + ids.length + ' textLen=' + text.length +
      ' baseComplete=' + baseComplete + ' floorCount=' + (savedFloor ? savedFloor.count : '-'));

    // v27/vXX: пол применяем ТОЛЬКО как защиту от просадки при НЕполной загрузке
    // (baseComplete=false). При baseComplete=true effectiveLen = фактический textLen базы,
    // пол НЕ применяется. Обновляем пол только когда база полная (baseComplete) и
    // тихая пагинация дошла до начала (reachedStart).
    if (fid && typeof window !== 'undefined' && window.GeminiInterceptLogic) {
      var resolved = window.GeminiInterceptLogic.resolveFloor(text.length, ids.length, savedFloor, baseComplete);
      effectiveLen = resolved.effectiveLen;
      floorApplied = resolved.floorApplied;
      floorValue = resolved.floorValue;
      if (floorApplied) {
        debugLog('log', '[gemini-intercept] пол применён: count=' + ids.length +
          ' (сохранённый=' + savedFloor.count + '), effectiveLen=' + effectiveLen +
          ' (сохранённый=' + savedFloor.effectiveLen + '), floorApplied=true, floorValue=' + floorValue);
      }
      if (window.GeminiInterceptLogic.shouldSaveFloor(baseComplete, reachedStart)) {
        // передаём РЕАЛЬНЫЕ text.length и ids.length — saveFloor сама решит, обновлять ли
        saveFloor(fid, ids.length, text.length);
      }
    }
    // v78: жёсткий пол — при floorCount > baseCount бейдж/токены НЕ опускаются ниже пола
    // даже при baseComplete=true (ложная полнота loader-стопа не должна ронять бейдж:
    // 90.7% → 53.4% на base=80 < floor=124). Применяется независимо от resolveFloor.
    if (savedFloor && savedFloor.count > ids.length && effectiveLen < savedFloor.effectiveLen) {
      effectiveLen = savedFloor.effectiveLen;
      floorApplied = true;
      floorValue = savedFloor.effectiveLen;
      debugLog('log', '[gemini-intercept] пол гарантирован (v78): count=' + ids.length +
        ' (сохранённый=' + savedFloor.count + '), effectiveLen поднят до ' + effectiveLen +
        ' floorApplied=true baseComplete=' + baseComplete);
    }

    try {
      window.dispatchEvent(new CustomEvent('ai-cm-full-history', {
        detail: {
          convId: fid,
          text: text,
          count: ids.length,
          effectiveLen: effectiveLen,
          lastMessageText: pieces.length ? pieces[pieces.length - 1] : '',
          modelSlug: lastModelName || '',
          messageTexts: pieces,
          messageIds: ids,
          messages: messages,
          attachTokens: attachTokens,
          attachBreak: { imgTokens: attachBreak.imgTokens, docTokens: attachBreak.docTokens, imgCount: attachBreak.imgCount, docCount: attachBreak.docCount },
          historyComplete: historyFullByQuiet,
          reachedStart: reachedStart === true, // v1.13.1: подтверждение полноты для гейта экспорта
          isLowConfidenceBase: isLowConfidenceBase === true, // v63: sanity-фолбэк без proof — префикс [LOW CONFIDENCE]_
          floorApplied: floorApplied,
          floorValue: floorValue
        }
      }));
    } catch (e) { swallow(e, 'gemini:emitBaseSnapshot-dispatch'); }
    return { count: ids.length, textLen: text.length, effectiveLen: effectiveLen, lastModelName: lastModelName, floorApplied: floorApplied, floorValue: floorValue };
  }

      // ---- applyStreamAliases: алиасы потоковых полей на разобранный ход ----
  function applyStreamAliases(parsed) {
    try {
      if (!Array.isArray(parsed) || !parsed.length) return;
      for (var pi = 0; pi < parsed.length; pi++) {
        var p = parsed[pi];
        if (!p || !p.id || !/^r_[0-9a-f]+_(user|assistant)$/.test(String(p.id))) continue;
        var pRole = (p.role === 'user') ? 'user' : 'assistant';
        var candKey = null, candOrder = Infinity;
        for (var k in turnsMap) {
          var rec = turnsMap[k];
          if (!rec || rec.pageMode !== 'stream' || rec.aliasResolved) continue;
          if ((rec.role || '') !== pRole) continue;
          var o = (typeof rec.order === 'number') ? rec.order : Infinity;
          if (o < candOrder) { candOrder = o; candKey = k; }
        }
        if (!candKey) continue;
        var candRec = turnsMap[candKey];
        delete turnsMap[candKey];
        candRec.aliasResolved = true;
        if (turnsMap[p.id]) {
          debugLog('log', '[AI CM][stream-alias] ' + candKey.slice(0, 24) + ' удалён (уже есть ' + p.id.slice(0, 24) + ') convId=' + getConvId() + ' turnId=' + (p.turnId || '-'));
        } else {
          turnsMap[p.id] = candRec;
          debugLog('log', '[AI CM][stream-alias] ' + candKey.slice(0, 24) + ' → ' + p.id.slice(0, 24) + ' convId=' + (getConvId() || '(none)') + ' turnId=' + (p.turnId || '-'));
        }
      }
    } catch (e) { swallow(e, 'gemini:applyStreamAliases'); }
  }

      // ---- ingest: приём текста базы целиком (ingest) — ядро кластера ----
  function ingest(raw, opts) {
    opts = opts || {};
    var emitOnlyIfAdded = !!opts.emitOnlyIfAdded;
    var fromVirtualF5 = !!opts.fromVirtualF5;
    var fromActivePaginate = !!opts.fromActivePaginate;
    var shouldRebuild = !!opts.rebuild;
    // v52: stream-ingest — предвыбранные walker'ом ходы (opts.turns), метка источника (srcOverride),
    // запрет трогать курсор/пагинацию (preservePagination). Без этих opts поведение прежнее.
    var preTurns = Array.isArray(opts.turns) ? opts.turns : null;
    var srcOverride = (typeof opts.srcOverride === 'string' && opts.srcOverride) ? opts.srcOverride : '';
    var preservePagination = !!opts.preservePagination;
    var src = srcOverride || (fromVirtualF5 ? 'vf5' : (fromActivePaginate ? 'pag' : 'passive'));
    if (src === 'passive') lastVf5ActivityAt = Date.now(); // v40: пассивный batchexecute — активность
    try { aiCmEnsureColdWindow(); } catch (e) { } // v61diag: окно холодного старта (первый ingest или рост convEpoch)
    // cold-debug (баг «холодное открытие без полной истории»): снапшот флагов ДО парсинга —
    // что перехватчик ПОЛУЧИЛ (rawLen) и в каком состоянии стейт-машина принимает решение.
    if (typeof raw === 'string' && raw.indexOf('hNvQHb') !== -1) {
      try {
        var __cdCid = getConvId() || '';
        debugLog('log', '[AI CM][cold-debug] ingest-enter src=' + src + ' convId=' + (__cdCid || '(none)') +
          ' rawLen=' + raw.length +
          ' baseSize=' + baseSize() +
          ' historyFullByQuiet=' + (historyFullByQuiet ? '1' : '0') +
          ' reachedStart=' + (reachedStart ? '1' : '0') +
          ' olderHistorySeen=' + (olderHistorySeen ? '1' : '0') +
          ' pendingCursor=' + (pendingCursor ? '1' : '0') +
          ' quietActive=' + (quietActive ? '1' : '0') +
          ' loaderRunning=' + (loaderRunningFor === __cdCid ? 'this' : (loaderRunningFor || 'none')) +
          ' doneMap=' + (__cdCid && loaderDoneMap[__cdCid] ? '1' : '0'));
      } catch (eCd1) { }
    }
    var wasFull = historyFullByQuiet;
    // O-48 (D2): курсор продолжения сохраняется ДО парса. Парс страницы (handleOuter)
    // перезаписывает pendingCursor ответом; при обрыве JSON-кадра нового курсора нет, а
    // старый уже уничтожен строкой ниже — цепочка пагинации рвалась, база не дозревала
    // (60с-таймаут → [LOW CONFIDENCE]). Тот же паттерн, что у shadow-probe/probe-парсов.
    var savedPendingCursor = pendingCursor;
    if (!preservePagination) pendingCursor = null; // v52: стрим-инжест не трогает курсор пагинации

    var parsed;
    var ingestParseFail = null; // O-48: обрыв JSON-кадра этого парса (читаем сразу после)
    if (preTurns) {
      parsed = preTurns;
    } else {
      try { parsed = parseBatchExecute(raw, src); }
      catch (e) {
        if (!loggedErr) { loggedErr = true; debugLog('log', '[gemini-intercept] ошибка парсинга batchexecute:', e); }
        if (!preservePagination) pendingCursor = savedPendingCursor; // O-48 (D2)
        return 0;
      }
      ingestParseFail = lastFrameParseFail;
    }
    // O-48 (D2): обрыв кадра или ноль ходов — нового курсора нет, сохранённый жив: возвращаем.
    if (!preTurns && !preservePagination && (ingestParseFail || !parsed.length)) {
      pendingCursor = savedPendingCursor;
    }
    if (ingestParseFail) {
      lastIngestParseFail = {
        convId: getConvId() || '', src: src, ts: Date.now(),
        where: ingestParseFail.where, declaredN: ingestParseFail.declaredN,
        availableBytes: ingestParseFail.availableBytes, reEncodedLen: ingestParseFail.reEncodedLen,
        rawLen: ingestParseFail.rawLen, clamped: ingestParseFail.clamped === true,
        salvaged: ingestParseFail.salvaged || 0
      };
      // O-48 (D3): обрыв — отдельный reason, НЕ маскируется под first-hash-mismatch и не
      // объявляет полноту. Честный итог неполного кадра — неполная база + LOW CONFIDENCE.
      debugLog('log', '[AI CM][completeness] oracle=incomplete reason=parse-fail src=' + src +
        ' convId=' + (getConvId() || '(none)') +
        ' declaredN=' + ingestParseFail.declaredN + ' availableBytes=' + ingestParseFail.availableBytes +
        ' reEncodedLen=' + ingestParseFail.reEncodedLen + ' rawLen=' + ingestParseFail.rawLen +
        ' clamped=' + (ingestParseFail.clamped ? '1' : '0') +
        ' salvagedTurns=' + (ingestParseFail.salvaged || 0) +
        ' pendingCursor=' + (pendingCursor ? 'alive' : 'none') + ' (полнота НЕ взводится)');
    }
    if (!parsed.length) {
      // cold-debug: что РЕАЛЬНО вернул сервер на «пустой» hNvQHb-странице (обрыв пагинации)
      if (typeof raw === 'string' && raw.indexOf('hNvQHb') !== -1) {
        try {
          debugLog('log', '[AI CM][cold-debug] empty-hNvQHb src=' + src + ' rawLen=' + raw.length +
            ' convId=' + (getConvId() || '(none)') +
            ' raw=' + JSON.stringify(raw.slice(0, 400)));
        } catch (eEh) { }
      }
      if (!preTurns && !loggedErr) { loggedErr = true; debugLog('log', '[gemini-intercept] batchexecute распознан, но ходов не найдено'); }
      return 0;
    }

    // v60: disjoint-reset — контентный критерий смены сеанса/аккаунта. Гард ТОЛЬКО для
    // путей vf5 и passive-снапшотов (pag/тихая пагинация легитимно не пересекается с
    // базой — её страницы СТАРШЕ). База непуста и НОЛЬ пересечений id с входящим
    // снапшотом → чужой сеанс: полный сброс + ingest как новая база. Решение принимаем
    // ДО блока v32 — покрывает и «merge по id без сброса» (vf5 с курсором продолжения),
    // и passive-снапшоты. Пересечение ненулевое → merge-by-id без изменений (v32-блок).
    var disjointGuardSrc = (src === 'vf5' || src === 'passive');
    // v61diag: данные для merge-decision лога (решение НЕ меняется)
    var diagExistingBefore = baseSize();
    var diagDisjointReset = false;
    var diagOverlap = 0;
    for (var dgi = 0; dgi < parsed.length; dgi++) {
      var dgid = parsed[dgi] && parsed[dgi].id;
      if (dgid && turnsMap[dgid]) diagOverlap++;
    }
    // v62: фиксация vf5-overlap — доказательство достоверности базы для confirmed-by-scroll
    if (src === 'vf5' && diagOverlap > 0) vf5OverlapSinceLoaderStart = true;
    // v66: латч already-done — сброс при НОВЫХ непересекающихся данных после done
    // (pag/vf5 с overlapCount=0 при непустой базе): разрешаем ровно один повторный прогон.
    if (!loaderRunningFor && (src === 'pag' || src === 'vf5') && diagOverlap === 0 && diagExistingBefore > 0) {
      var curConvLatch66 = getConvId();
      if (curConvLatch66 && loaderDoneMap[curConvLatch66] && !loaderRetryUsedMap[curConvLatch66]) {
        loaderRetryUsedMap[curConvLatch66] = true;
        delete loaderDoneMap[curConvLatch66];
        debugLog('log', '[AI CM][loader] v66 latch-reset reason=new-disjoint-data src=' + src +
          ' convId=' + curConvLatch66 + ' overlap=0 (ровно один повторный прогон)');
        setTimeout(function () { try { maybeStartLoader(); } catch (eL66) { swallow(eL66, 'gemini:ingest-loader-restart'); } }, 2000);
      }
    }
    if (disjointGuardSrc && baseSize() > 0) {
      var disjointReset = false;
      // v64: снапшот vf5/passive принадлежит чату из URL (incomingConvId === currentConvId):
      // disjoint-reset ЗАПРЕЩЁН — непересекающиеся окна одного чата мерджатся union по id
      // (same-conv-union). Сброс разрешён ТОЛЬКО при incomingConvId !== currentConvId
      // (страховка cross-conv; основной путь там — stale-conv drop v59, не трогается).
      // stale-conv drop, convEpoch-сбросы, tape-restore, trim, пороги — без изменений.
      var diagSameConv = !!getConvId();
      if (diagSameConv) {
        disjointReset = false;
      } else {
      var disjointIdsBase = Object.keys(turnsMap);
      var disjointIdsIn = [];
      for (var dri = 0; dri < parsed.length; dri++) disjointIdsIn.push(parsed[dri] && parsed[dri].id);
      if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.shouldDisjointReset) {
        disjointReset = window.GeminiInterceptLogic.shouldDisjointReset({ src: src, existingIds: disjointIdsBase, incomingIds: disjointIdsIn });
      } else {
        disjointReset = true;
        var drSeen = {};
        for (var drs = 0; drs < disjointIdsBase.length; drs++) drSeen[disjointIdsBase[drs]] = true;
        for (var drj = 0; drj < disjointIdsIn.length; drj++) {
          if (disjointIdsIn[drj] && drSeen[disjointIdsIn[drj]]) { disjointReset = false; break; }
        }
      }
      } // v64: else (cross-conv страховка)
      if (disjointReset) {
        diagDisjointReset = true; // v61diag
        convEpoch++; // v60: старые ответы (тег с прошлой эпохой) больше не ингестируются
        tapeWasUsedInThisColdStart = false; // v62: сброс базы = новая эпоха, кэш не считается
        vf5OverlapSinceLoaderStart = false; // v62: сброс базы = старый vf5-overlap не считается
        isLowConfidenceBase = false; // v63: сброс базы = low-confidence не перетекает
        turnsMap = {};
        orderCounter = 0;
        prependCursor = -1;
        olderHistorySeen = false;
        historyFullByQuiet = false;
        reachedStart = false;
        reachedStartByScroll = false; // v61diag
        serverFirstHash = ''; // v69
        lastHeadToken = null; // v69
        lastGoodWideCur = null; // H9b: retained last-good не переживает сброс базы
        lastGoodProbeMeta = null; // H9b
        quietActive = false;
        quietPaginated = false;
        quietDecisionMade = false;
        quietIncompleteNoStart = false;
        lastCycleEndedHidden = false;
        attachSeen = {};
        attachTokens = 0;
        attachBreak = { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 };
        debugLog('log', '[AI CM][session] disjoint-reset convId=' + (getConvId() || '(none)') + ' src=' + src);
        // pendingCursor НЕ трогаем: курсор входящего снапшота нужен пагинации новой базы
      }
    }

    // v32/vXX: полная пересборка vf5 допустима ТОЛЬКО если пейлоад НЕ содержит курсора
    // продолжения (действительно полная история). При наличии курсора это частичная история —
    // merge по id без сброса (turnsMap дедуплицирует). Решение принимаем ПОСЛЕ парсинга,
    // когда pendingCursor (курсор из этого пейлоада) уже известен.
    // O-51 (монотонный union): пересборка запрещена ЕЩЁ и тогда, когда входящий снапшот —
    // ПОДМНОЖЕСТВО уже собранной базы (все его id известны). Такой снапшот не добавляет ни
    // одного хода, зато сброс turnsMap уничтожает накопленное — живой прогон 2026-09-25 на
    // чате 8f1343975188be5d: база 36 → 20 ходов, метрика 39% → 10%. Усечённый
    // (виртуализированный) vf5-ответ без курсора и «полная история» по форме неразличимы —
    // решает content-критерий по id (`isSubsetIds`). Следствие запрета — stable merge
    // (merge-by-id ниже): база сохраняется ЦЕЛИКОМ, ходы снапшота, которых в ней нет,
    // добавляются из его хвоста.
    // O-51b: ЕДИНАЯ точка извлечения id. Раньше массивы заполнялись ТОЛЬКО на vf5-ветке
    // (`if (fromVirtualF5)`), а свидетельство трейса собиралось отдельно (`parsed.map(x => x.id)`)
    // — решение и его доказательство могли разойтись, и при ПУСТЫХ массивах форма снапшота
    // («vf5 без курсора = полная история») работала как доказательство полноты: живая приёмка
    // 16:31:33.906, чат 8f1343975188be5d — снапшот 20 ходов из 36 (все id уже собраны,
    // overlapCount=20, disjointFlag=false) дал `action=reset reason=full-rebuild-vf5-no-cursor`,
    // база схлопнулась 36 → 20, метрика 39.1% → 10.8%, pre-trim файл потерял старшие ходы.
    // Теперь ОДНИ И ТЕ ЖЕ массивы идут и в трейс, и в критерий пересборки.
    function collectTurnIds(list) {
      var ids = [];
      if (!list) return ids;
      for (var ci = 0; ci < list.length; ci++) ids.push(list[ci] && list[ci].id);
      return ids;
    }
    // Свидетельство пригодно, только если с ОБЕИХ сторон есть хотя бы один живой id: пустой
    // массив — это отсутствие доказательства, а не доказательство полноты (fail-closed).
    function hasUsableTurnIds(ids) {
      if (!ids || !ids.length) return false;
      for (var hi = 0; hi < ids.length; hi++) { if (ids[hi]) return true; }
      return false;
    }
    var rebuildExistingIds = baseSize() > 0 ? Object.keys(turnsMap) : [];
    var rebuildIncomingIds = collectTurnIds(parsed);
    var rebuildIdsUsable = hasUsableTurnIds(rebuildExistingIds) && hasUsableTurnIds(rebuildIncomingIds);
    var incomingIsSubsetOfBase = false;
    if (rebuildIdsUsable) {
      if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.isSubsetIds) {
        incomingIsSubsetOfBase = window.GeminiInterceptLogic.isSubsetIds(rebuildIncomingIds, rebuildExistingIds);
      } else {
        // фолбэк (модуль логики недоступен/стар): тот же критерий по образцу shouldDisjointReset
        var rebuildSeen = {};
        for (var rbs = 0; rbs < rebuildExistingIds.length; rbs++) {
          if (rebuildExistingIds[rbs]) rebuildSeen[rebuildExistingIds[rbs]] = true;
        }
        incomingIsSubsetOfBase = true;
        for (var rbj = 0; rbj < rebuildIncomingIds.length; rbj++) {
          var rbid = rebuildIncomingIds[rbj];
          if (!rbid || !rebuildSeen[rbid]) { incomingIsSubsetOfBase = false; break; }
        }
      }
    }
    var fullRebuildFromVf5 = false;
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic) {
      fullRebuildFromVf5 = window.GeminiInterceptLogic.shouldFullRebuild({
        fromVirtualF5: fromVirtualF5, wasFull: wasFull, hasCursor: !!pendingCursor,
        existingIds: rebuildExistingIds, incomingIds: rebuildIncomingIds
      });
    } else {
      // O-51b: фолбэк без модуля логики обязан повторять контракт v32 ЦЕЛИКОМ — курсор
      // продолжения означает НЕПОЛНУЮ историю, пересборка запрещена. Раньше проверка курсора
      // терялась вместе с модулем, и vf5-снапшот с курсором стирал накопленную базу.
      fullRebuildFromVf5 = !!(fromVirtualF5 && wasFull && !pendingCursor);
    }
    // O-51: страховка уровня вызова — даже если модуль логики стар и не знает про
    // подмножество, сброс по снапшоту-подмножеству НЕ выполняется (data-safety важнее формы).
    if (fullRebuildFromVf5 && incomingIsSubsetOfBase) fullRebuildFromVf5 = false;
    // O-51b (fail-closed): база непуста, а id-свидетельства нет (массивы пусты или без id) —
    // ОДНА форма сброс не разрешает. Фолбэк — на content-критерий O-51 `shouldDisjointReset`:
    // он требует доказанного НУЛЕВОГО пересечения (чужой сеанс/аккаунт). Доказательства нет →
    // нет сброса: идёт merge-by-id (данные важнее формы). Пустая база ничего не теряет — там
    // сброс остаётся разрешённым.
    var noIdEvidenceNoReset = false;
    if (fullRebuildFromVf5 && baseSize() > 0 && !rebuildIdsUsable) {
      var idFallbackDisjoint = false;
      if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.shouldDisjointReset) {
        idFallbackDisjoint = window.GeminiInterceptLogic.shouldDisjointReset({
          src: src, existingIds: rebuildExistingIds, incomingIds: rebuildIncomingIds
        });
      }
      // Страховка уровня вызова (конвенция O-51): вердикт disjoint принимается только при ГОДНОМ
      // id-свидетельстве — модуль логики может быть старой сборкой без O-51b-гарда. Здесь оно по
      // построению негодно, поэтому сброс запрещён: пустой массив — не «другое» множество, а
      // отсутствие множества (доказывать нечего).
      idFallbackDisjoint = idFallbackDisjoint &&
        hasUsableTurnIds(rebuildExistingIds) && hasUsableTurnIds(rebuildIncomingIds);
      if (!idFallbackDisjoint) {
        fullRebuildFromVf5 = false;
        noIdEvidenceNoReset = true;
      }
    }
    // v75 (D-head): после tape-restore в этом холодном старте полная пересборка vf5 запрещена —
    // сброс turnsMap уничтожил бы восстановленную голову тейпа (restored-ходы с order<0),
    // а повторный tape-restore заблокирован cacheRestoredMap → merge по id без сброса.
    if (tapeWasUsedInThisColdStart === true && fullRebuildFromVf5) {
      debugLog('log', '[AI CM][merge-decision] action=merge incomingSrc=vf5 reason=tape-protect-no-rebuild existingMsgs=' + baseSize() + ' incomingMsgs=' + parsed.length);
      fullRebuildFromVf5 = false;
    }
    if (fullRebuildFromVf5) {
      turnsMap = {};
      orderCounter = 0;
      prependCursor = -1;
      debugLog('log', '[gemini-rebuild] полная пересборка из vf5 (без курсора), ходов: ' + parsed.length);
    } else if (fromVirtualF5 && wasFull && pendingCursor) {
      debugLog('log', '[gemini-rebuild] vf5 содержит курсор продолжения → merge по id без сброса (turnsMap дедуплицирует)');
    }
    // v61diag: merge-decision — только фиксация решения, логика не меняется
    (function () {
      var action = 'merge';
      var reason = 'merge-by-id';
      if (diagDisjointReset) { action = 'disjoint-reset'; reason = 'zero-id-overlap'; }
      else if (fullRebuildFromVf5) { action = 'reset'; reason = 'full-rebuild-vf5-no-cursor'; }
      // O-51: снапшот — подмножество базы, форма при этом «полная история без курсора»:
      // сброс ЗАПРЕЩЁН, идёт stable merge (причина называется честно, а не «merge-by-id»).
      else if (incomingIsSubsetOfBase && fromVirtualF5 && wasFull && !pendingCursor &&
               tapeWasUsedInThisColdStart !== true) { reason = 'vf5-subset-no-reset'; }
      // O-51b: id-свидетельства не было вовсе (пустые массивы) — сброс по одной форме запрещён,
      // причина называется честно (иначе дефект «тихого» стирания базы неотличим в логе).
      else if (noIdEvidenceNoReset) { reason = 'vf5-no-id-evidence-no-reset'; }
      else if (disjointGuardSrc && diagExistingBefore > 0 && diagOverlap === 0 && !!getConvId()) { reason = 'same-conv-union'; } // v64
      else if (fromVirtualF5 && wasFull && pendingCursor) { reason = 'vf5-cursor-continue'; }
      else if (diagExistingBefore === 0) { reason = 'empty-base'; }
      // v64: для same-conv-union — дельта окна входящего снапшота (новые id сверх пересечения)
      var diagWindowDelta = (reason === 'same-conv-union')
        ? ' windowDelta=+' + Math.max(0, parsed.length - diagOverlap) : '';
      debugLog('log', '[AI CM][merge-decision] action=' + action + ' incomingSrc=' + src +
        ' incomingConvId=' + (getConvId() || '(none)') +
        ' existingMsgs=' + diagExistingBefore + ' incomingMsgs=' + parsed.length +
        ' overlapCount=' + diagOverlap + ' disjointFlag=' + (diagOverlap === 0 ? 'true' : 'false') +
        ' reason=' + reason + diagWindowDelta);
    })();
    // O-51b: трейс печатает ТЕ ЖЕ массивы, что ушли в критерий пересборки (`rebuildIncomingIds`),
    // плюс его пригодность — по логу сразу видно, было ли id-свидетельство (baseIds/idEvidence).
    debugLog('log', '[gemini-ingest-trace] src=' + src + ' блоков_ходов=' + parsed.length +
      ' ids=[' + rebuildIncomingIds.join(',') + ']' +
      ' baseIds=' + rebuildExistingIds.length + ' idEvidence=' + (rebuildIdsUsable ? '1' : '0'));

    // v25: пересборка ветки при realtime-vf5 (после действий пользователя).
    // Парсинг уже выполнен — handleOuter установил pendingCursor (или оставил null).
    // Стоп-кран: если курсора нет — пересборка отменяется, turnsMap не сбрасывается.
    // v26: пересборка только пока история ещё не полная (wasFull=false);
    // после полной сборки vf5 только докидывает ходы поверх, не перетирает базу.
    var doRebuild = shouldRebuild && !wasFull;
    debugLog('log', '[gemini-rebuild] src=' + src + ' wasFull=' + wasFull +
      ' rebuild=' + doRebuild + ' baseSizeBefore=' + baseSize());
    if (doRebuild) {
      if (!pendingCursor) {
        debugLog('log', '[gemini-rebuild] pendingCursor в vf5-блоке = null → пересборка отменена, оставлено прежнее поведение');
      } else {
        debugLog('log', '[gemini-rebuild] курсор есть — докидываем vf5-ходы к накопленной базе (дедуп по id), курсор=' + edges8(pendingCursor) +
          ' было_ходов=' + baseSize());
        historyFullByQuiet = false;
        quietActive = false;
        quietPaginated = false;
        quietDecisionMade = false;
        // turnsMap и orderCounter не сбрасываем — vf5-ходы добавляются к уже накопленной базе
      }
    }

    // v52: stream-alias — ДО мерджа снапшота: замещаем стримовские rc_*-записи постоянными r_*.
    if ((fromVirtualF5 || src === 'passive') && !preTurns) applyStreamAliases(parsed);

    // v33: глобальный порядок страниц. Страницы пагинации — «старше» (prepend, отрицательный
    // order), passive/vf5 — «свежие» (append). order хранит глобальную позицию.
    // v39: внутри страницы порядок строим по r1-цепочке (old→new), иначе — порядок прибытия.
    var pageSeq = parsed;
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.orderPageByR1) {
      var r1pg = window.GeminiInterceptLogic.orderPageByR1(parsed);
      if (r1pg && Array.isArray(r1pg.ids) && r1pg.ids.length === parsed.length) {
        var byIdPage = {};
        for (var pb = 0; pb < parsed.length; pb++) byIdPage[parsed[pb].id] = parsed[pb];
        var reorderedPage = [];
        for (var pr = 0; pr < r1pg.ids.length; pr++) {
          var prec = byIdPage[r1pg.ids[pr]];
          if (prec) reorderedPage.push(prec);
        }
        if (reorderedPage.length === parsed.length) pageSeq = reorderedPage;
      }
    }
    // v69: захват firstMsgHash головы сервера — каждая страница пагинации перезаписывает
    // эту переменную; по завершении цикла в ней голова (первое сообщение первой страницы).
    if (fromActivePaginate && pageSeq.length) {
      serverFirstHash = aiCmDiagHash6(pageSeq[0].id, pageSeq[0].text);
    }
    var pageMode = fromActivePaginate ? 'older' : 'fresh';
    var orderState = { orderCounter: orderCounter, prependCursor: prependCursor };
    var pageOrders = [];
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.assignPageOrders) {
      pageOrders = window.GeminiInterceptLogic.assignPageOrders(pageSeq.length, pageMode, orderState);
    } else {
      for (var oi = 0; oi < pageSeq.length; oi++) pageOrders.push(orderCounter++);
      // O-51b: фолбэк без модуля логики обязан, как и assignPageOrders, вернуть счётчику
      // порядка новое значение — иначе строка ниже откатывала его к достраничному (0 после
      // полной пересборки) и следующие страницы получали бы уже занятые order.
      orderState.orderCounter = orderCounter;
      orderState.prependCursor = prependCursor;
    }
    orderCounter = orderState.orderCounter;
    prependCursor = orderState.prependCursor;

    var added = 0;
    for (var i = 0; i < pageSeq.length; i++) {
      var p = pageSeq[i];
      if (!turnsMap[p.id]) {
        turnsMap[p.id] = { text: p.text, modelName: p.modelName, order: pageOrders[i], pageMode: src, ts: p.ts || 0, role: (p.role === 'user') ? 'user' : 'assistant', turnId: p.turnId || null, r1: p.r1 || null };
        added++;
      } else if (turnsMap[p.id].pageMode === 'restored') {
        // v1.14.1 (SHRINK-GUARD): сетевой ход перезаписывает restored-ход того же id
        // только если входящий текст НЕ короче (решение в GeminiInterceptLogic.decideRestoredMerge).
        // Обрезанные сетевые копии уже известных ходов не затирают полные тексты из ленты.
        var recRest = turnsMap[p.id];
        var dRm = null;
        if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.decideRestoredMerge) {
          dRm = window.GeminiInterceptLogic.decideRestoredMerge(recRest, p);
        } else {
          var oldLenRm = (recRest.text || '').length;
          var newLenRm = (p.text || '').length;
          dRm = (newLenRm >= oldLenRm)
            ? { replace: true, r1: null, turnId: null }
            : { replace: false, r1: (!recRest.r1 && p.r1) ? p.r1 : null, turnId: (!recRest.turnId && p.turnId) ? p.turnId : null };
        }
        if (dRm.replace) {
          turnsMap[p.id] = { text: p.text, modelName: p.modelName, order: pageOrders[i], pageMode: src, ts: p.ts || 0, role: (p.role === 'user') ? 'user' : 'assistant', turnId: p.turnId || null, r1: p.r1 || null };
        } else {
          if (dRm.r1) recRest.r1 = dRm.r1;
          if (dRm.turnId) recRest.turnId = dRm.turnId;
          debugLog('log', '[AI CM][ingest] shrink-guard kept-restored id=' + String(p.id).slice(0, 24) +
            ' restoredLen=' + ((recRest.text || '').length) + ' netLen=' + ((p.text || '').length) + ' src=' + src +
            ' convId=' + (getConvId() || '(none)'));
        }
      } else if (!turnsMap[p.id].r1 && p.r1) {
        if (!turnsMap[p.id].pageMode) turnsMap[p.id].pageMode = src;
        turnsMap[p.id].r1 = p.r1;
        if (!turnsMap[p.id].turnId && p.turnId) turnsMap[p.id].turnId = p.turnId;
      }
    }
    refreshMinOrderTracking(src); // v73: старшие добавления вне пагинации (инвалидация scroll-proof)
    noteBaseCountChange(); // v74: стабильность счётчика базы
    var em = null;
    var shouldEmit = !emitOnlyIfAdded || added > 0;
    // v50: явный инкрементальный лог — Chrome-проверка попадания НОВЫХ ходов в turnsMap
    // (новые обмены открытого чата, приходящие инкрементальным фидом без hNvQHb в URL).
    if (added > 0) {
      debugLog('log', '[AI CM][ingest] new-turns +' + added + ' convId=' + (getConvId() || '(none)') + ' src=' + src + ' total=' + baseSize());
    }
    // v61diag: cold-start лог каждого ingest в первые 60с окна (края входящего снапшота)
    try { aiCmColdStartIngestLog(src, pageSeq, added, pageSeq.length > 0 && diagOverlap === pageSeq.length); } catch (e) { }
    if (shouldEmit) em = emitBaseSnapshot();
    var emCount = em ? em.count : baseSize();
    var emLen = em ? em.textLen : 0;
    var emModel = em ? em.lastModelName : '';
    if (!loggedOk) {
      loggedOk = true;
      debugLog('log', '[gemini-intercept] ✓ распознано ходов: ' + emCount + ' (новых: ' + added +
        '), символов: ' + emLen + ', модель из данных: ' + (emModel || '?') + ' [' + src + ']');
    } else if (added > 0) {
      debugLog('log', '[gemini-intercept] + добавлено ходов: ' + added + ', всего: ' + emCount + ', символов: ' + emLen + ' [' + src + ']');
    }
    if (!loggedAttach && attachTokens > 0) {
      loggedAttach = true;
      debugLog('log', '[gemini-intercept] 📎 вложения учтены (дедуп по имени, глобально): картинок=' +
        attachBreak.imgCount + ' (≈' + attachBreak.imgTokens + ' ток, по 2 тайла), файлов=' +
        attachBreak.docCount + ' (≈' + attachBreak.docTokens + ' ток, оценочно) → всего вложений ≈' + attachTokens + ' токенов');
    }

    if (!observerStarted && baseSize() > 0) {
      startRefreshObserver();
    }

    // v19: разрешаем тихую пагинацию из vf5-ответа при переключении чата.
    // При SPA-переключении сайт не всегда шлёт пассивный загрузочный hNvQHb;
    // тогда база остаётся vf5-хвостом с неполными вложениями (наблюдено 37.8% против 41.7% F5).
    // Теперь vf5 сам запускает paginateLoop по курсору из ответа, если история ещё не собрана.
    // quietDecisionMade взводим сразу, чтобы пассивная ветка не запустила второй параллельный цикл.
    if (fromVirtualF5 && !historyFullByQuiet && !quietActive && pendingCursor && baseSize() > 0) {
      quietActive = true;
      quietDecisionMade = true;
      debugLog('log', '[gemini-paginate] курсор найден в vf5-ответе (len=' + pendingCursor.length + ', ' + edges8(pendingCursor) +
        ') → запускаю тихий цикл пагинации БЕЗ скролла (vf5-инициирован)');
      paginateLoop(pendingCursor, 0);
    }

    if (!fromVirtualF5 && !fromActivePaginate && src !== 'stream' && baseSize() > 0 && !quietDecisionMade) {
      quietDecisionMade = true;
      if (pendingCursor) {
        quietActive = true;
        debugLog('log', '[gemini-paginate] курсор найден в снимке (len=' + pendingCursor.length + ', ' + edges8(pendingCursor) +
          ') → запускаю тихий цикл пагинации БЕЗ скролла');
        paginateLoop(pendingCursor, 0);
      } else {
        debugLog('log', '[gemini-paginate] курсора в снимке нет → тихий путь недоступен, фолбэк: автоскролл');
        scheduleAutoScroll();
      }
    }

    return added;
  }

      // ---- sanitizeRestoredTurn: очистка восстановленного хода ----
  function sanitizeRestoredTurn(rt) {
    var arr = [{
      role: (rt && rt.role === 'user') ? 'user' : 'assistant',
      text: (rt && rt.text != null) ? String(rt.text) : '',
      id: (rt && rt.id != null) ? String(rt.id) : null
    }];
    var clean = sanitizeMessagesForEmit(arr);
    if (!clean || !clean.length) return null;
    var c = clean[0];
    if (!c || !c.text || !c.text.trim()) return null;
    return { id: c.id, text: c.text, role: c.role, r1: (rt && rt.r1) || null };
  }

      // ---- mergeRestoredTurns: слияние восстановленных ходов ----
  function mergeRestoredTurns(restoredTurns) {
    // v4x: сеть авторитетна по id — restored добавляется ТОЛЬКО для недостающих id.
    // Финальный порядок строит orderByR1Chain по объединению (в emitBaseSnapshot);
    // приоритет порядка restored-ленты убран полностью, несвязанный остаток — по arrival.
    var i, rt, m;
    var missing = [];
    var maxOrder = 0;
    var netIds = Object.keys(turnsMap);
    for (i = 0; i < netIds.length; i++) {
      var no = turnsMap[netIds[i]].order || 0;
      if (no > maxOrder) maxOrder = no;
    }
    for (i = 0; i < restoredTurns.length; i++) {
      rt = restoredTurns[i];
      if (!rt || !rt.id) continue;
      if (turnsMap[rt.id]) continue; // сеть авторитетна
      var clean = sanitizeRestoredTurn(rt);
      if (!clean) continue;
      var turnId = String(clean.id).replace(/_(user|assistant)$/, '');
      var rr1 = clean.r1 ? String(clean.r1).replace(/_(user|assistant)$/, '') : null;
      missing.push({ id: clean.id, text: clean.text, role: clean.role, turnId: turnId, r1: rr1 });
    }
    if (!missing.length) {
      debugLog('log', '[gemini-restore] merged 0 missing ids (version=' + parserVersion + ')');
      return;
    }
    for (i = 0; i < missing.length; i++) {
      m = missing[i];
      turnsMap[m.id] = {
        text: m.text, modelName: '', order: maxOrder + 1 + i,
        pageMode: 'restored', ts: 0,
        role: (m.role === 'user') ? 'user' : 'assistant',
        turnId: m.turnId, r1: m.r1
      };
    }
    debugLog('log', '[gemini-restore] merged ' + missing.length + ' missing ids (version=' + parserVersion + ')');
    // v61diag: tape-мердж учитывается в окне холодного старта как src=tape
    try { aiCmEnsureColdWindow(); aiCmColdStartIngestLog('tape', missing, missing.length, false); } catch (e) { }
    try { emitBaseSnapshot(); } catch (e) { swallow(e, 'gemini:mergeRestoredTurns-emit'); }
  }

      Fn.firstRc = firstRc;
      Fn.logIdmap = logIdmap;
      Fn.ingestAttachments = ingestAttachments;
      Fn.extractModelName = extractModelName;
      Fn.extractTurnId = extractTurnId;
      Fn.extractTurnTs = extractTurnTs;
      Fn.extractTurnR1 = extractTurnR1;
      Fn.handleOuter = handleOuter;
      Fn.rontgenPagination = rontgenPagination;
      Fn.shouldPollVf5 = shouldPollVf5;
      Fn.startRefreshObserver = startRefreshObserver;
      Fn.emitBaseSnapshot = emitBaseSnapshot;
      Fn.applyStreamAliases = applyStreamAliases;
      Fn.ingest = ingest;
      Fn.sanitizeRestoredTurn = sanitizeRestoredTurn;
      Fn.mergeRestoredTurns = mergeRestoredTurns;
    }
  }
  Fn.__bind = __bind;
  if (typeof window !== 'undefined') { window.AiCmGeminiIngest = Fn; }
}());
