// core/deepseek-intercept.js (v6 = v5 + детектор усечения истории после F5 + тихий дозапрос полной цепочки)
// Перехватчик DeepSeek в МИРЕ САЙТА (world: "MAIN"), document_start. Регистрация — background.js.
// В этом шаге меняется ТОЛЬКО этот файл. content.js / page-intercept.js / gemini-intercept.js /
// background.js / manifest / адаптеры / model-config — НЕ ТРОГАТЬ.
//
// Источник данных: перехват fetch/XHR в МИРЕ САЙТА (world:"MAIN", document_start).
// Тихая пагинация: НЕ НУЖНА (вся история в одном ответе history_messages).
// Числитель процента: accumulated_token_usage с сервера (без токенизатора).
// Гард перекрёста: chat_session_id из URL/тела vs currentConvId из location.pathname.
//
// ВНИМАНИЕ: ModelConfig НЕ доступен в world:MAIN (инжектится в ISOLATED мире контент-скрипта).
// Модель определяется ПОХОДОВО по thinking_enabled: true → r1, иначе → v3.
// model_type (expert/default) не влияет на выбор модели, а передаётся как modelMode в detail.
//
// v5: подавление ложной кнопки «Ошибки» на плитке расширения (chrome://extensions).
//   Причина: обёртка window.fetch подменяет оригинал, поэтому ЛЮБОЙ fetch страницы создаёт
//   промис внутри нашей обёртки. Когда чужой запрос страницы отклоняется без обработчика
//   (Failed to fetch при навигации/переключении/обрыве стрима), браузер видит unhandled
//   rejection и, поскольку промис создан в обёртке, приписывает ошибку расширению.
//   Решение: (1) тихий .catch на промисе originalFetch — снимает unhandled-сигнал для
//   чужих прерванных запросов, не меняя поведения страницы; (2) устранение висячих
//   Promise.reject(err) в onRejected цепочек истории и стрима (замена на пустую функцию).
//
// v6: детектор усечения истории после F5.
//   Проблема: при перезагрузке сервер иногда возвращает усечённый history_messages —
//   не полную цепочку, а «хвост». Существующий MERGE-дозапрос срабатывает только
//   при полностью пустом chat_messages.
//   Решение: buildActiveChain возвращает флаг truncated (цепочка оборвана — первый
//   parent_id не null, но сообщение отсутствует в chat_messages). При усечении —
//   однократный тихий дозапрос полной истории без cache_version/cache_reset_at.
//   Флаг дозапроса сбрасывается в resetForNewConversation для защиты от зацикливания.

(function () {
  if (window.__aiCmDeepseekInterceptInstalled) return;
  window.__aiCmDeepseekInterceptInstalled = true;

  var originalFetch = window.fetch;
  var OriginalXHR = window.XMLHttpRequest;
  var originalXHROpen = OriginalXHR ? OriginalXHR.prototype.open : null;
  var originalXHRSend = OriginalXHR ? OriginalXHR.prototype.send : null;

  // ===== СЕКЦИЯ 1: КОНСТАНТЫ =====
  var INCLUDE_THINKING = false;
  var MODEL_WINDOW_DEFAULT = 131072;  // совпадает с model-config deepseek-v3/r1

  // ===== СЕКЦИЯ 2: НАКОПИТЕЛИ =====
  var turnsMap = {};          // ключ = String(message_id)
  var orderCounter = 0;
  var attachTokens = 0;
  var attachBreak = { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 };
  var loggedOk = false;
  var loggedHistory = false;
  var loggedRealtime = false;

  // ===== СЕКЦИЯ 3: CONV ID + ДЕТЕКТОР СМЕНЫ ЧАТА (образец: gemini v17 + page-intercept v11) =====
  function getConvId() {
    try {
      var m = location.pathname.match(/\/a\/chat\/s\/([A-Za-z0-9_-]+)/);
      if (m) return m[1];
      m = location.pathname.match(/\/a\/chat\/([A-Za-z0-9_-]+)/);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }
  var currentConvId = getConvId();
  var lastAuthHeaders = {};
  var lastLoadedConvId = '';
  var historyRefetchTimer = null;
  var lastHistoryUrl = '';          // v6: URL последнего history-запроса для дозапроса при усечении
  var historyRefetchDone = false;   // v6: флаг «один дозапрос за загрузку чата»

  function resetForNewConversation() {
    turnsMap = {};
    orderCounter = 0;
    attachTokens = 0;
    attachBreak = { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 };
    loggedOk = false;
    loggedHistory = false;
    loggedRealtime = false;
    lastLoadedConvId = '';
    lastHistoryUrl = '';          // v6
    historyRefetchDone = false;   // v6
    resetStreamState();
    console.log('[deepseek-intercept] смена чата → состояние перехватчика сброшено (convId=' + (currentConvId || '(не чат)') + ')');
    try { window.dispatchEvent(new CustomEvent('ai-cm-conversation-changed')); } catch (e) { }
    scheduleHistoryRefetch();
  }

  function checkConvChange() {
    var newId = getConvId();
    if (newId !== currentConvId) {
      currentConvId = newId;
      resetForNewConversation();
    }
  }

  try {
    var origPush = history.pushState;
    if (origPush) {
      history.pushState = function () {
        var r = origPush.apply(this, arguments);
        try { checkConvChange(); } catch (e) { }
        return r;
      };
    }
    var origReplace = history.replaceState;
    if (origReplace) {
      history.replaceState = function () {
        var r = origReplace.apply(this, arguments);
        try { checkConvChange(); } catch (e) { }
        return r;
      };
    }
    window.addEventListener('popstate', function () { try { checkConvChange(); } catch (e) { } });
  } catch (e) { }

  // ===== СЕКЦИЯ 4: EMIT (контракт как в gemini v21, + serverTokens, + modelMode) =====
  function emitBaseSnapshot(serverTokens, chatMode) {
    serverTokens = (typeof serverTokens === 'number' && serverTokens > 0) ? serverTokens : 0;
    chatMode = chatMode || '';
    var ids = Object.keys(turnsMap).sort(function (a, b) {
      return (turnsMap[a].order || 0) - (turnsMap[b].order || 0);
    });
    var pieces = [];
    var lastModel = '';
    for (var j = 0; j < ids.length; j++) {
      var t = turnsMap[ids[j]];
      pieces.push(t.text);
      if (t.modelSlug) lastModel = t.modelSlug;
    }
    var text = pieces.join('\n');
    try {
      window.dispatchEvent(new CustomEvent('ai-cm-full-history', {
        detail: {
          text: text,
          count: ids.length,
          lastMessageText: pieces.length ? pieces[pieces.length - 1] : '',
          modelSlug: lastModel || '',
          modelMode: chatMode,
          messageTexts: pieces,
          messageIds: ids,
          attachTokens: attachTokens,
          attachBreak: {
            imgTokens: attachBreak.imgTokens,
            docTokens: attachBreak.docTokens,
            imgCount: attachBreak.imgCount,
            docCount: attachBreak.docCount
          },
          historyComplete: true,
          serverTokens: serverTokens
        }
      }));
    } catch (e) { }
    return { count: ids.length, textLen: text.length, lastModel: lastModel, serverTokens: serverTokens };
  }

  // ===== СЕКЦИЯ 5: МОДЕЛЬ (походово по thinking_enabled, без DOM) =====
  function getModelSlug(thinkingEnabled) {
    return thinkingEnabled === true ? 'deepseek-r1' : 'deepseek-v3';
  }

  // ===== СЕКЦИЯ 6: АКТИВНАЯ ЦЕПОЧКА (walk по parent_id, ловушка №1) =====
  // v6: возвращает { chain, truncated }
  //   - truncated = false: дошли до корня (parent_id === null/undefined) — норма
  //   - truncated = true: walk остановился, потому что следующий parent_id не null,
  //     но сообщения с таким id нет в messagesById — цепочка оборвана (усечение)
  function buildActiveChain(chatSession, messagesById) {
    var chain = [];
    var currentId = chatSession.current_message_id;
    var visited = {};
    var truncated = false;
    while (currentId != null && currentId !== undefined) {
      var msg = messagesById[currentId];
      if (!msg) {
        // parent_id не null, но сообщение отсутствует в полученном chat_messages → усечение
        truncated = true;
        break;
      }
      if (visited[currentId]) break;   // защита от циклов
      visited[currentId] = true;
      chain.push(msg);
      currentId = msg.parent_id;
    }
    chain.reverse();
    // сортировка по inserted_at для гарантии хронологии
    chain.sort(function (a, b) { return (a.inserted_at || 0) - (b.inserted_at || 0); });
    return { chain: chain, truncated: truncated };
  }

  // ===== СЕКЦИЯ 7: СБОР ТЕКСТА ХОДА (по type, не по порядку фрагментов) =====
  function collectTurnText(fragments, role) {
    var types;
    if (role === 'USER') {
      types = ['REQUEST'];
    } else {
      types = ['RESPONSE'];
      if (INCLUDE_THINKING) types.push('THINK');
    }
    var parts = [];
    for (var i = 0; i < fragments.length; i++) {
      var f = fragments[i];
      if (types.indexOf(f.type) !== -1 && typeof f.content === 'string') {
        parts.push(f.content);
      }
      // TIP — всегда игнорируем
    }
    return parts.join('').trim();
  }

  // ===== СЕКЦИЯ 8: ПАРСИНГ history_messages =====
  // v6: детектор усечения активной цепочки + однократный тихий дозапрос полной истории
  function ingestHistory(jsonBody) {
    try {
      if (jsonBody.code !== 0) return;
      var bizData = jsonBody.data && jsonBody.data.biz_data;
      if (!bizData) return;
      var chatSession = bizData.chat_session;
      var chatMessages = bizData.chat_messages;
      if (!chatSession || !Array.isArray(chatMessages)) return;

      // Помечаем «ответ для текущего чата обработан» — ДО buildActiveChain и ДО return по пустой цепочке
      lastLoadedConvId = currentConvId;

      // Сначала СБРОС — история = полный авторитетный снимок (условие 3 из рецензии)
      turnsMap = {};
      orderCounter = 0;
      // (attachTokens/attachBreak на 1-м этапе не трогаем — всегда 0)

      // Строим Map<message_id, msg>
      var messagesById = {};
      for (var i = 0; i < chatMessages.length; i++) {
        var msg = chatMessages[i];
        if (msg && msg.message_id != null) {
          messagesById[msg.message_id] = msg;
        }
      }

      // Восстанавливаем активную цепочку (ловушка №1)
      // v6: получаем { chain, truncated } вместо просто массива
      var chainResult = buildActiveChain(chatSession, messagesById);
      var chain = chainResult.chain;
      var truncated = chainResult.truncated;
      if (!chain.length) return;

      // v6: ДЕТЕКТОР УСЕЧЕНИЯ — если цепочка оборвана и дозапрос ещё не делался
      if (truncated && !historyRefetchDone) {
        historyRefetchDone = true;
        // НЕ помечаем loggedHistory = true — лог и диагностический дамп сработают на полной истории
        console.log('[deepseek-intercept] кеш усечён (цепочка оборвана) → тихий дозапрос полной истории (без cache_version)');
        lastLoadedConvId = currentConvId;
        refetchFullHistory(lastHistoryUrl, lastAuthHeaders, currentConvId);
        return; // не обрабатываем усечённый ответ — ждём полный
      }

      // chatMode — модель чата (expert/default/null), не влияет на выбор модели
      var chatMode = chatSession.model_type || '';

      // Заполняем turnsMap: модель ПОХОДОВО по thinking_enabled
      for (var c = 0; c < chain.length; c++) {
        var ch = chain[c];
        var chId = String(ch.message_id);
        if (turnsMap[chId]) continue;          // дедуп
        var fragments = Array.isArray(ch.fragments) ? ch.fragments : [];
        var text = collectTurnText(fragments, ch.role);
        if (!text) continue;
        var turnSlug = getModelSlug(ch.thinking_enabled === true);
        var chRole = (!ch.role) ? 'unknown' : (ch.role === 'USER' ? 'user' : (ch.role === 'ASSISTANT' ? 'assistant' : 'unknown'));
        turnsMap[chId] = {
          text: text,
          modelSlug: turnSlug,
          order: orderCounter++,
          ts: ch.inserted_at || 0,
          role: chRole
        };
      }

      // УСЛОВИЕ 1: accumulated_token_usage — максимум по всем сообщениям цепочки (накопительное, монотонно растёт)
      var lastAccumulated = 0;
      for (var ci = 0; ci < chain.length; ci++) {
        var at = chain[ci].accumulated_token_usage;
        if (typeof at === 'number' && at > lastAccumulated) {
          lastAccumulated = at;
        }
      }

      var em = emitBaseSnapshot(lastAccumulated, chatMode);
      if (!loggedHistory) {
        loggedHistory = true;
        console.log('[deepseek-intercept] ✓ история загружена: ходов=' + em.count +
          ', символов=' + em.textLen + ', модель=' + (em.lastModel || '?') +
          ', serverTokens=' + lastAccumulated +
          (lastAccumulated > 0 ? ' (' + Math.round(lastAccumulated / MODEL_WINDOW_DEFAULT * 1000) / 10 + '%)' : '') +
          ', modelMode=' + (chatMode || '(default)'));

        // ДИАГНОСТИЧЕСКИЙ ДАМП — только при включённом флаге aiCmDebug
        if (isDebugEnabled()) {
          var diagState = determineState();
          dumpHistorySnapshot(diagState.state, diagState.reason, {
            capturePoint: 'ingestHistory',
            navType: diagState.navType,
            chatMessages: chatMessages,
            chatSession: chatSession,
            chain: chain,
            lastAccumulated: lastAccumulated,
            chatMode: chatMode
          });
        }
      }
    } catch (e) {
      console.warn('[deepseek-intercept] ошибка парсинга history_messages:', e);
    }
  }

  // ===== СЕКЦИЯ 9: ПАРСЕР SSE (постфактум, из полного текста, ловушка №2) =====
  var sseLastPath = null;
  var sseLastOp = null;
  var sseRealtimeEntryTokens = 0;
  var sseRealtimeFinalTokens = 0;
  var sseRequestMessageId = null;
  var sseResponseMessageId = null;
  var sseModelType = null;
  var sseCollectedText = '';
  var sseUserPrompt = '';
  var sseParentMessageId = null;
  var sseThinkingEnabled = null;

  function resetStreamState() {
    sseLastPath = null;
    sseLastOp = null;
    sseRealtimeEntryTokens = 0;
    sseRealtimeFinalTokens = 0;
    sseRequestMessageId = null;
    sseResponseMessageId = null;
    sseModelType = null;
    sseCollectedText = '';
    sseUserPrompt = '';
    sseParentMessageId = null;
    sseThinkingEnabled = null;
  }

  function processChunk(path, op, val) {
    if (path === 'response/fragments/-1/content' && op === 'APPEND' && typeof val === 'string') {
      sseCollectedText += val;
    }
  }

  function finalizeRealtimeTurn() {
    if (!sseRequestMessageId || !sseResponseMessageId) return;

    // УСЛОВИЕ 2: добавляем ОБА хода — USER и ASSISTANT
    // USER-ход
    var userId = String(sseRequestMessageId);
    if (!turnsMap[userId] && sseUserPrompt) {
      turnsMap[userId] = {
        text: sseUserPrompt,
        modelSlug: '',
        order: orderCounter++,
        ts: Date.now() / 1000,
        role: 'user'
      };
    }

    // ASSISTANT-ход: модель по thinking_enabled (sseModelType не влияет на выбор)
    var assistantId = String(sseResponseMessageId);
    if (!turnsMap[assistantId] && sseCollectedText) {
      var slug = getModelSlug(sseThinkingEnabled === true);
      turnsMap[assistantId] = {
        text: sseCollectedText,
        modelSlug: slug,
        order: orderCounter++,
        ts: Date.now() / 1000,
        role: 'assistant'
      };
    }

    // Числитель = финальный accumulated_token_usage из BATCH (фолбэк — entry из первого response)
    var serverTokens = sseRealtimeFinalTokens || sseRealtimeEntryTokens || 0;

    // chatMode для realtime = sseModelType (expert/default/null)
    var chatMode = sseModelType || '';

    var em = emitBaseSnapshot(serverTokens, chatMode);
    if (!loggedRealtime) {
      loggedRealtime = true;
      console.log('[deepseek-intercept] ✓ realtime обновление: ходов=' + em.count +
        ', serverTokens=' + serverTokens +
        (serverTokens > 0 ? ' (' + Math.round(serverTokens / MODEL_WINDOW_DEFAULT * 1000) / 10 + '%)' : '') +
        ', модель=' + (em.lastModel || '?') +
        ', modelMode=' + (chatMode || '(default)'));

      // ДИАГНОСТИЧЕСКИЙ ДАМП — только при включённом флаге aiCmDebug
      if (isDebugEnabled()) {
        dumpHistorySnapshot('after_reply', 'realtime turn finalized', {
          capturePoint: 'finalizeRealtimeTurn',
          navType: '',
          sseEntry: sseRealtimeEntryTokens,
          sseFinal: sseRealtimeFinalTokens,
          modelType: sseModelType
        });
      }
    }

    resetStreamState();
  }

  function parseSSE(text) {
    if (typeof text !== 'string' || !text) return;
    var lines = text.split('\n');
    var currentEvent = '';

    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];

      // event: ...
      if (ln.indexOf('event:') === 0) {
        currentEvent = ln.slice(6).trim();
        continue;
      }

      // data: ...
      if (ln.indexOf('data:') !== 0) continue;
      var jsonStr = ln.slice(5).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;

      var obj;
      try { obj = JSON.parse(jsonStr); } catch (e) { continue; }

      // === ready ===
      if (currentEvent === 'ready' && obj.request_message_id) {
        sseRequestMessageId = obj.request_message_id;
        sseResponseMessageId = obj.response_message_id;
        sseModelType = obj.model_type || null;
        currentEvent = '';
        continue;
      }

      // === update_session (игнорируем, только updated_at) ===
      if (currentEvent === 'update_session') {
        currentEvent = '';
        continue;
      }

      // === close ===
      if (currentEvent === 'close') {
        if (sseRequestMessageId && sseResponseMessageId) {
          finalizeRealtimeTurn();
        }
        currentEvent = '';
        continue;
      }

      // === первый response-объект: {v:{response:{...}}} ===
      // Извлекаем accumulated_token_usage, model_type И начальный контент из fragments
      // (первый символ ответа приходит здесь, а не в APPEND-чанках — без этого теряется символ)
      if (obj.v && obj.v.response && typeof obj.v.response.accumulated_token_usage === 'number') {
        sseRealtimeEntryTokens = obj.v.response.accumulated_token_usage;
        sseModelType = sseModelType || obj.v.response.model_type || null;

        // Извлекаем начальный контент из fragments первого response-объекта
        var initFrags = obj.v.response.fragments;
        if (Array.isArray(initFrags)) {
          for (var fi = 0; fi < initFrags.length; fi++) {
            var ifr = initFrags[fi];
            if (ifr.type === 'RESPONSE' && typeof ifr.content === 'string') {
              sseCollectedText += ifr.content;
            } else if (INCLUDE_THINKING && ifr.type === 'THINK' && typeof ifr.content === 'string') {
              sseCollectedText += ifr.content;
            }
          }
        }
        continue;
      }

      // === финальный BATCH: {p:"response", o:"BATCH", v:[...]} ===
      if (obj.p === 'response' && obj.o === 'BATCH' && Array.isArray(obj.v)) {
        for (var b = 0; b < obj.v.length; b++) {
          var batchItem = obj.v[b];
          if (batchItem.p === 'accumulated_token_usage' && typeof batchItem.v === 'number') {
            sseRealtimeFinalTokens = batchItem.v;
          }
          if (batchItem.p === 'quasi_status' && batchItem.v === 'FINISHED') {
            if (sseRequestMessageId && sseResponseMessageId) {
              finalizeRealtimeTurn();
            }
          }
        }
        continue;
      }

      // === status FINISHED (страховка, если BATCH не сработал) ===
      if (obj.p === 'response/status' && obj.o === 'SET' && obj.v === 'FINISHED') {
        if (!sseRealtimeFinalTokens && sseRequestMessageId && sseResponseMessageId) {
          finalizeRealtimeTurn();
        }
        continue;
      }

      // === чанк с путём (запоминаем lastPath/lastOp для сокращённых чанков — ловушка №2) ===
      if (obj.p && obj.o) {
        sseLastPath = obj.p;
        sseLastOp = obj.o;
        processChunk(obj.p, obj.o, obj.v);
        continue;
      }

      // === сокращённый чанк (только v, без p и o) — используем запомненный путь ===
      if (obj.v !== undefined && sseLastPath && sseLastOp) {
        processChunk(sseLastPath, sseLastOp, obj.v);
        continue;
      }
    }
  }

  // ===== СЕКЦИЯ 10: ГАРД ПЕРЕКРЁСТА (chat_session_id vs currentConvId) =====
  function convIdFromHistoryUrl(url) {
    try {
      var m = url.match(/[?&]chat_session_id=([A-Za-z0-9_-]+)/);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }

  function convIdFromCompletionBody(bodyStr) {
    try {
      if (typeof bodyStr !== 'string' || !bodyStr) return '';
      var obj = JSON.parse(bodyStr);
      return obj.chat_session_id || '';
    } catch (e) { return ''; }
  }

  function guardCheck(reqConvId) {
    if (!reqConvId) return true;   // не удалось извлечь — пропускаем (не блокируем)
    if (reqConvId !== currentConvId) {
      console.log('[deepseek-intercept] пропущен ответ (convId запроса ' + reqConvId + ' != текущий ' + currentConvId + ')');
      return false;
    }
    return true;
  }

  // ===== СЕКЦИЯ 10B: ХЕЛПЕРЫ ДЛЯ MERGE-ДОЗАПРОСА =====

  // Сбор заголовков из fetch-запроса в plain object (поддержка Headers, Array, Object)
  function collectHeaders(input, init) {
    var h = {};
    try {
      var src = (init && init.headers) || (input && input.headers ? input.headers : null);
      if (!src) return h;
      // Headers-объект (forEach существует)
      if (typeof src.forEach === 'function') {
        src.forEach(function (v, k) { h[k] = v; });
      } else if (Array.isArray(src)) {
        for (var i = 0; i < src.length; i++) {
          if (Array.isArray(src[i]) && src[i].length >= 2) h[src[i][0]] = src[i][1];
        }
      } else if (typeof src === 'object') {
        var keys = Object.keys(src);
        for (var i = 0; i < keys.length; i++) {
          h[keys[i]] = src[keys[i]];
        }
      }
    } catch (e) { }
    return h;
  }

  // Удаление cache_version и cache_reset_at из URL (оставляем chat_session_id и всё остальное)
  function stripCacheParams(url) {
    try {
      var u = new URL(url, location.origin);
      u.searchParams.delete('cache_version');
      u.searchParams.delete('cache_reset_at');
      return u.toString();
    } catch (e) {
      return url.replace(/[?&]cache_(version|reset_at)=[^&]*/g, '').replace(/\?$/, '');
    }
  }

  // Тихий повторный запрос полной истории БЕЗ cache_version/cache_reset_at
  // Использует originalFetch (нативный fetch ДО нашей обёртки) — рекурсия исключена по построению
  function refetchFullHistory(originalUrl, authHeaders, convId) {
    if (!convId || convId !== currentConvId) { return; }
    var cleanUrl = stripCacheParams(originalUrl);
    originalFetch(cleanUrl, {
      method: 'GET',
      headers: authHeaders || {}
    }).then(function (r) {
      if (r && r.ok) return r.json();
      return null;
    }).then(function (json) {
      if (json && convId === currentConvId) {
        ingestHistory(json);
      }
    }).catch(function (e) {
      console.warn('[deepseek-intercept] refetchFullHistory ошибка:', e);
    });
  }

  // Таймер-дозапрос после смены чата (если сайт не прислал историю сам)
  function scheduleHistoryRefetch() {
    try { clearTimeout(historyRefetchTimer); } catch (e) { }
    historyRefetchTimer = setTimeout(function () {
      try {
        if (currentConvId && currentConvId !== lastLoadedConvId && lastAuthHeaders && (lastAuthHeaders.Authorization || lastAuthHeaders.authorization)) {
          var url = location.origin + '/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(currentConvId);
          console.log('[deepseek-intercept] история не пришла после смены чата → тихий дозапрос по таймеру (convId=' + currentConvId + ')');
          refetchFullHistory(url, lastAuthHeaders, currentConvId);
        }
      } catch (e) { }
    }, 1000);
  }

  // ===== СЕКЦИЯ 11: ПЕРЕХВАТ FETCH (v5: тихий catch + устранение висячих Promise.reject) =====
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      var url = '';
      try { url = (typeof input === 'string') ? input : (input && input.url) || ''; } catch (e) { }
      var method = (init && init.method) ? String(init.method).toUpperCase() : 'GET';

      // Сбор заголовков ВСЕХ запросов (для сохранения auth)
      var allH = collectHeaders(input, init);
      if (allH.Authorization || allH.authorization) lastAuthHeaders = allH;

      // --- история: URL содержит "history_messages" ---
      var isHistory = (url.indexOf('history_messages') !== -1);
      var historyConvId = '';
      var historyAuthHeaders = null;
      if (isHistory) {
        historyConvId = convIdFromHistoryUrl(url);
        historyAuthHeaders = allH;
        lastHistoryUrl = url;   // v6: сохраняем URL для возможного дозапроса при усечении
      }

      // --- отправка: URL содержит "completion", метод POST ---
      var isCompletion = (url.indexOf('completion') !== -1 && method === 'POST');
      var completionConvId = '';
      if (isCompletion) {
        var bodyStr = '';
        try {
          if (init && typeof init.body === 'string') {
            bodyStr = init.body;
            var payload = JSON.parse(bodyStr);
            sseUserPrompt = payload.prompt || '';
            sseParentMessageId = payload.parent_message_id || null;
            sseThinkingEnabled = payload.thinking_enabled;        // сохраняем для getModelSlug
            completionConvId = payload.chat_session_id || '';
          }
        } catch (e) { }
      }

      var promise;
      try { promise = originalFetch.apply(this, arguments); } catch (e) { return Promise.reject(e); }

      // v5: тихий catch — снимает ложный unhandled rejection для чужих прерванных запросов
      // (Failed to fetch при навигации/переключении/обрыве стрима), не меняя поведения страницы
      promise.catch(function () { /* тихо: снимаем ложный unhandled для чужих прерванных запросов */ });

      // обработка ответа истории
      if (isHistory) {
        promise.then(function (resp) {
          try {
            if (resp && resp.ok && guardCheck(historyConvId)) {
              resp.clone().json().then(function (json) {
                // Проверка «пусто+MERGE»: сервер вернул пустой chat_messages при is_empty!==true
                var bd = json && json.data && json.data.biz_data;
                if (bd) {
                  var cs = bd.chat_session;
                  var emptyMERGE = cs && cs.is_empty !== true && (!Array.isArray(bd.chat_messages) || bd.chat_messages.length === 0);
                  if (emptyMERGE && guardCheck(historyConvId)) {
                    console.log('[deepseek-intercept] кеш MERGE → тихий дозапрос полной истории (без cache_version)');
                    lastLoadedConvId = currentConvId;
                    refetchFullHistory(url, historyAuthHeaders, historyConvId);
                    return;
                  }
                }
                ingestHistory(json);
              }).catch(function () { });
            }
          } catch (e) { }
          return resp;
        }, function () { /* v5: тихо — не создаём висячий Promise.reject */ });
      }

      // обработка ответа стрима (постфактум, из полного текста)
      if (isCompletion) {
        promise.then(function (resp) {
          try {
            if (resp && resp.ok && guardCheck(completionConvId)) {
              resp.clone().text().then(function (txt) { parseSSE(txt); }).catch(function () { });
            }
          } catch (e) { }
          return resp;
        }, function () { /* v5: тихо — не создаём висячий Promise.reject */ });
      }

      return promise;
    };
  }

  // ===== СЕКЦИЯ 12: ПЕРЕХВАТ XHR (зеркалит fetch, +setRequestHeader-копилка) =====
  if (originalXHROpen && originalXHRSend) {
    // Обёртка setRequestHeader — копим заголовки для повторного запроса при MERGE
    var originalSetRequestHeader = OriginalXHR.prototype.setRequestHeader;
    if (originalSetRequestHeader) {
      OriginalXHR.prototype.setRequestHeader = function (name, value) {
        try {
          if (this.__aiCmDs && this.__aiCmDs.headers) {
            this.__aiCmDs.headers[name] = value;
          }
        } catch (e) { }
        return originalSetRequestHeader.apply(this, arguments);
      };
    }

    OriginalXHR.prototype.open = function (method, url) {
      try {
        this.__aiCmDs = {
          method: String(method).toUpperCase(),
          url: String(url),
          completionBody: null,
          completionConvId: '',
          historyConvId: '',
          headers: {}
        };
      } catch (e) { }
      return originalXHROpen.apply(this, arguments);
    };

    OriginalXHR.prototype.send = function (body) {
      var info = this.__aiCmDs;
      if (!info) return originalXHRSend.apply(this, arguments);

      // Сохраняем auth-заголовки при наличии Authorization
      if (info.headers && (info.headers.Authorization || info.headers.authorization)) lastAuthHeaders = info.headers;

      var url = info.url || '';
      var method = info.method || 'GET';

      // --- история ---
      if (url.indexOf('history_messages') !== -1) {
        info.historyConvId = convIdFromHistoryUrl(url);
        lastHistoryUrl = url;   // v6: сохраняем URL для возможного дозапроса при усечении
      }

      // --- отправка ---
      if (url.indexOf('completion') !== -1 && method === 'POST') {
        var bodyStr = (typeof body === 'string') ? body : '';
        info.completionBody = bodyStr;
        info.completionConvId = convIdFromCompletionBody(bodyStr);
        try {
          if (bodyStr) {
            var payload = JSON.parse(bodyStr);
            sseUserPrompt = payload.prompt || '';
            sseParentMessageId = payload.parent_message_id || null;
            sseThinkingEnabled = payload.thinking_enabled;
          }
        } catch (e) { }
      }

      var self = this;

      // обработка ответа (load)
      this.addEventListener('load', function () {
        var info2 = self.__aiCmDs;
        if (!info2) return;
        try {
          if (self.status < 200 || self.status >= 300) return;
          if (!self.responseText) return;

          var loadUrl = info2.url || '';

          // история
          if (loadUrl.indexOf('history_messages') !== -1) {
            if (guardCheck(info2.historyConvId)) {
              try {
                var jsonH = JSON.parse(self.responseText);
                // Проверка «пусто+MERGE»: сервер вернул пустой chat_messages при is_empty!==true
                var bdH = jsonH && jsonH.data && jsonH.data.biz_data;
                if (bdH) {
                  var csH = bdH.chat_session;
                  var emptyMERGE = csH && csH.is_empty !== true && (!Array.isArray(bdH.chat_messages) || bdH.chat_messages.length === 0);
                  if (emptyMERGE && guardCheck(info2.historyConvId)) {
                    console.log('[deepseek-intercept] кеш MERGE → тихий дозапрос полной истории (без cache_version)');
                    lastLoadedConvId = currentConvId;
                    refetchFullHistory(loadUrl, info2.headers || {}, info2.historyConvId);
                    return;
                  }
                }
                ingestHistory(jsonH);
              } catch (e) { }
            }
          }

          // стрим
          if (loadUrl.indexOf('completion') !== -1 && info2.method === 'POST') {
            if (guardCheck(info2.completionConvId)) {
              parseSSE(self.responseText);
            }
          }
        } catch (e) { }
      });

      return originalXHRSend.apply(this, arguments);
    };
  }

  // ===== СЕКЦИЯ 13: ДИАГНОСТИЧЕСКИЙ ДАМП (только при sessionStorage aiCmDebug === '1') =====

  function isDebugEnabled() {
    try {
      return sessionStorage.getItem('aiCmDebug') === '1';
    } catch (e) { return false; }
  }

  function getNavigationType() {
    try {
      var entries = performance.getEntriesByType('navigation');
      if (entries && entries.length > 0) {
        return entries[0].type || '';
      }
    } catch (e) { }
    return '';
  }

  function determineState() {
    var navType = getNavigationType();
    var convPrefix = '';
    try { convPrefix = (currentConvId || '').slice(0, 8); } catch (e) { }
    var visitedKey = '';
    var wasVisited = false;
    if (convPrefix) {
      visitedKey = 'aiCmVisited:' + convPrefix;
      try { wasVisited = sessionStorage.getItem(visitedKey) === '1'; } catch (e) { }
    }

    if (navType === 'reload' || navType === 'back_forward') {
      return { state: 'after_f5', reason: 'navigationType=' + navType + ', convId=' + convPrefix, navType: navType };
    }
    if (wasVisited) {
      return { state: 'after_f5', reason: 'sessionStorage marker found for ' + convPrefix, navType: navType };
    }
    if (convPrefix) {
      try { sessionStorage.setItem(visitedKey, '1'); } catch (e) { }
    }
    return { state: 'open', reason: 'first visit (nav=' + (navType || 'unknown') + ', convId=' + convPrefix + ')', navType: navType };
  }

  // Нормализация роли: USER→user, ASSISTANT→assistant, иначе→unknown
  function normalizeRole(rawRole) {
    if (!rawRole) return 'unknown';
    if (rawRole === 'USER') return 'user';
    if (rawRole === 'ASSISTANT') return 'assistant';
    return 'unknown';
  }

  function buildMessagesFromRaw(chatMessages, chain) {
    var chainIds = {};
    for (var ci = 0; ci < chain.length; ci++) {
      chainIds[String(chain[ci].message_id)] = true;
    }

    var messages = [];
    for (var i = 0; i < chatMessages.length; i++) {
      var msg = chatMessages[i];
      var mid = String(msg.message_id || '');
      var totalLen = 0;
      var hasContent = false;
      var frags = Array.isArray(msg.fragments) ? msg.fragments : [];
      for (var fi = 0; fi < frags.length; fi++) {
        if (typeof frags[fi].content === 'string') {
          totalLen += frags[fi].content.length;
        }
      }
      if (totalLen > 0) hasContent = true;

      var atts = Array.isArray(msg.attachments) ? msg.attachments : [];
      var attCount = atts.length;
      var attTokens = null;
      if (attCount > 0) {
        attTokens = 0;
        for (var ai = 0; ai < atts.length; ai++) {
          var a = atts[ai];
          if (a && typeof a.token_count === 'number') attTokens += a.token_count;
        }
        if (attTokens === 0) attTokens = null;
      }

      messages.push({
        index: i,
        messageIdPrefix: mid.slice(0, 8),
        role: normalizeRole(msg.role),
        hasContent: hasContent,
        contentLength: totalLen,
        inActiveChain: !!chainIds[mid],
        hasTokenField: typeof msg.accumulated_token_usage === 'number',
        tokenFieldName: 'accumulated_token_usage',
        tokenValue: typeof msg.accumulated_token_usage === 'number' ? msg.accumulated_token_usage : null,
        hasParentId: !!msg.parent_id,
        parentIdPrefix: msg.parent_id ? String(msg.parent_id).slice(0, 8) : null,
        hasAttachments: attCount > 0,
        attachmentCount: attCount,
        attachmentTokens: attTokens,
        hasThinkingEnabled: typeof msg.thinking_enabled === 'boolean',
        thinkingEnabled: typeof msg.thinking_enabled === 'boolean' ? msg.thinking_enabled : null
      });
    }
    return messages;
  }

  function buildMessagesFromTurnsMap() {
    var ids = Object.keys(turnsMap);
    // Сортируем по order, при одинаковом — по ts
    var orderSource = 'order';
    var hasOrder = true;
    var hasTs = true;
    for (var k = 0; k < ids.length; k++) {
      var t = turnsMap[ids[k]];
      if (typeof t.order !== 'number') { hasOrder = false; }
      if (typeof t.ts !== 'number') { hasTs = false; }
    }
    if (!hasOrder) orderSource = 'keys_unknown';

    ids.sort(function (a, b) {
      var oa = turnsMap[a].order;
      var ob = turnsMap[b].order;
      if (typeof oa === 'number' && typeof ob === 'number') {
        if (oa !== ob) return oa - ob;
        // при одинаковом order — по ts
        var tsa = turnsMap[a].ts;
        var tsb = turnsMap[b].ts;
        if (typeof tsa === 'number' && typeof tsb === 'number') return tsa - tsb;
        return 0;
      }
      if (typeof oa === 'number') return -1;
      if (typeof ob === 'number') return 1;
      // оба без order — по ts если доступно
      var tsa2 = turnsMap[a].ts;
      var tsb2 = turnsMap[b].ts;
      if (typeof tsa2 === 'number' && typeof tsb2 === 'number') return tsa2 - tsb2;
      return 0;
    });

    var messages = [];
    for (var i = 0; i < ids.length; i++) {
      var ti = turnsMap[ids[i]];
      var role = (ti.role === 'user' || ti.role === 'assistant') ? ti.role : 'unknown';

      messages.push({
        index: i,
        messageIdPrefix: ids[i].slice(0, 8),
        role: role,
        hasContent: !!ti.text && ti.text.length > 0,
        contentLength: ti.text ? ti.text.length : 0,
        inActiveChain: null,
        hasTokenField: false,
        tokenFieldName: null,
        tokenValue: null,
        hasParentId: null,
        parentIdPrefix: null,
        hasAttachments: null,
        attachmentCount: null,
        attachmentTokens: null,
        hasThinkingEnabled: null,
        thinkingEnabled: null,
        modelSlug: ti.modelSlug || null
      });
    }

    return { messages: messages, orderSource: orderSource };
  }

  function dumpHistorySnapshot(state, stateReason, ctx) {
    // Вызывается ТОЛЬКО после проверки isDebugEnabled() в точках вызова
    try {
      ctx = ctx || {};
      var nowTs = Date.now();
      var convPrefix = '';
      try { convPrefix = (currentConvId || '').slice(0, 8); } catch (e) { }

      // Виджет-процент из DOM
      var widgetPercent = null;
      var widgetPercentRaw = null;
      var widgetPercentSource = 'none';
      try {
        var widgetEl = document.querySelector('.ai-widget-text');
        if (widgetEl) {
          widgetPercentRaw = widgetEl.textContent || '';
          var pctMatch = widgetPercentRaw.match(/([0-9]+(?:\.[0-9]+)?)/);
          if (pctMatch) {
            widgetPercent = parseFloat(pctMatch[1]);
            widgetPercentSource = 'dom';
          }
        }
      } catch (e) { }

      // Модель — по последнему ходу по order (упорядоченный turnsMap)
      var lastModel = '';
      var tmIds = Object.keys(turnsMap).sort(function (a, b) {
        return (turnsMap[a].order || 0) - (turnsMap[b].order || 0);
      });
      for (var j = 0; j < tmIds.length; j++) {
        var t = turnsMap[tmIds[j]];
        if (t.modelSlug) lastModel = t.modelSlug;
      }

      var modelMode = '';
      if (typeof ctx.chatMode === 'string') modelMode = ctx.chatMode;
      if (typeof ctx.modelType === 'string' && ctx.modelType) modelMode = ctx.modelType;

      // serverTokens
      var stUsed = null;
      var stSource = 'none';
      var stAccumulated = null;
      var stSseEntry = null;
      var stSseFinal = null;

      if (ctx.lastAccumulated !== undefined) {
        stAccumulated = (typeof ctx.lastAccumulated === 'number' && ctx.lastAccumulated > 0) ? ctx.lastAccumulated : null;
        stUsed = stAccumulated;
        stSource = 'accumulated_last_message';
      }
      if (ctx.sseEntry !== undefined) {
        stSseEntry = (typeof ctx.sseEntry === 'number' && ctx.sseEntry > 0) ? ctx.sseEntry : null;
      }
      if (ctx.sseFinal !== undefined) {
        stSseFinal = (typeof ctx.sseFinal === 'number' && ctx.sseFinal > 0) ? ctx.sseFinal : null;
      }
      // SSE приоритетнее — перезаписывает used/source
      if (stSseFinal !== null) {
        stUsed = stSseFinal;
        stSource = 'sse_final_batch';
      } else if (stSseEntry !== null) {
        stUsed = stSseEntry;
        stSource = 'sse_entry_response';
      }

      // Сообщения
      var messages;
      var messagesSource;
      var messagesOrderSource = null;
      var rawMessagesCount = null;
      var activeChainCount = null;
      if (Array.isArray(ctx.chatMessages)) {
        var chain = Array.isArray(ctx.chain) ? ctx.chain : [];
        messages = buildMessagesFromRaw(ctx.chatMessages, chain);
        messagesSource = 'chat_messages_raw';
        messagesOrderSource = 'raw_array_order';
        rawMessagesCount = ctx.chatMessages.length;
        activeChainCount = chain.length;
      } else {
        var tmResult = buildMessagesFromTurnsMap();
        messages = tmResult.messages;
        messagesSource = 'turns_map';
        messagesOrderSource = tmResult.orderSource;
      }

      var turnsMapSize = Object.keys(turnsMap).length;

      // Статистика
      var userCount = 0;
      var assistantCount = 0;
      var unknownCount = 0;
      var totalContentLength = 0;
      var maxTokenValue = null;
      var lastTokenValue = null;
      for (var mi = 0; mi < messages.length; mi++) {
        var m = messages[mi];
        if (m.role === 'user') userCount++;
        else if (m.role === 'assistant') assistantCount++;
        else unknownCount++;
        if (typeof m.contentLength === 'number') totalContentLength += m.contentLength;
        if (typeof m.tokenValue === 'number') {
          lastTokenValue = m.tokenValue;
          if (maxTokenValue === null || m.tokenValue > maxTokenValue) {
            maxTokenValue = m.tokenValue;
          }
        }
      }

      // historyFullByNetwork: true только для ingestHistory
      var capPoint = ctx.capturePoint || 'unknown';
      var hfbn = null;
      if (capPoint === 'ingestHistory') {
        hfbn = true;
      }

      var dump = {
        ai: 'deepseek',
        state: state,
        stateReason: stateReason || '',
        navigationType: ctx.navType || '',
        capturedAt: nowTs,
        capturePoint: capPoint,
        convIdPrefix: convPrefix || null,
        widgetPercent: widgetPercent,
        widgetPercentRaw: widgetPercentRaw,
        widgetPercentSource: widgetPercentSource,
        model: lastModel || null,
        modelMode: modelMode || null,
        flags: {
          historyFullByNetwork: hfbn,
          loggedHistory: loggedHistory,
          loggedRealtime: loggedRealtime
        },
        serverTokens: {
          used: stUsed,
          source: stSource,
          accumulatedFromLastMessage: stAccumulated,
          sseEntryTokens: stSseEntry,
          sseFinalTokens: stSseFinal
        },
        messages: messages,
        summary: {
          totalMessages: messages.length,
          userMessages: userCount,
          assistantMessages: assistantCount,
          unknownMessages: unknownCount,
          totalContentLength: totalContentLength,
          sumTokenFields: null,
          maxTokenValue: maxTokenValue,
          lastTokenValue: lastTokenValue,
          tokenFieldPolicy: 'cumulative_not_summable',
          rawMessagesCount: rawMessagesCount,
          activeChainCount: activeChainCount,
          turnsMapSize: turnsMapSize,
          historyLoadedTurns: turnsMapSize,
          messagesSource: messagesSource,
          messagesOrderSource: messagesOrderSource
        }
      };

      try {
        console.log('[ai-cm-debug] DEEPSEEK_STRUCT_DUMP\n' + JSON.stringify(dump, null, 2));
      } catch (jsonErr) {
        console.warn('[ai-cm-debug] DEEPSEEK_STRUCT_DUMP ошибка сериализации:', jsonErr);
      }
    } catch (e) {
      console.warn('[ai-cm-debug] DEEPSEEK_STRUCT_DUMP ошибка дампа:', e);
    }
  }

  // ===== СЕКЦИЯ 14: ФИНАЛ =====
  console.log('[deepseek-intercept] перехватчик DeepSeek v6 установлен (server-first, walk parent_id, SSE постфактум, USER+ASSISTANT оба хода, historyComplete всегда true, serverTokens из accumulated_token_usage, +self-fetch при MERGE, +per-turn model по thinking_enabled, +modelMode в detail, +timer-refetch on switch, +подавление чужих unhandled fetch, +детектор усечения цепочки с дозапросом)');

  // Экспорт для ручного вызова диагностического дампа
  try {
    if (!window.__aiCmDebug) window.__aiCmDebug = {};
    window.__aiCmDebug.dumpDeepSeekHistory = function (state) {
      if (!isDebugEnabled()) return;
      if (!state) {
        var ds = determineState();
        state = ds.state;
        var reason = 'manual:' + state + ' (nav=' + (ds.navType || 'unknown') + ', convId=' + (currentConvId || '').slice(0, 8) + ')';
      } else {
        var reason = 'manual:' + state;
      }
      dumpHistorySnapshot(state, reason, {
        capturePoint: 'manual_call',
        navType: getNavigationType()
      });
    };
  } catch (e) { }
})();