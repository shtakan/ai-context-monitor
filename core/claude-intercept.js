// core/claude-intercept.js — перехватчик Claude (claude.ai) в MAIN world, document_start.
// Паттерн: как page-intercept.js (ChatGPT) — виртуальный F5 после стрима.
//
// Реальные данные (DevTools, 11.08.2026):
//   GET  /api/organizations/{orgId}/chat_conversations/{uuid}?tree=True&...
//        → { uuid, name, model, chat_messages: [{uuid, sender:"human"|"assistant", content:[блоки]}] }
//        usage НЕТ — токены считаются эвристикой на стороне расширения.
//   POST /api/organizations/{orgId}/chat_conversations/{uuid}/b/completion
//        → SSE: message_start (model), ... content_block_delta (delta.text), message_stop.
//   При отправке: сайт делает GET истории (уже с сообщением пользователя) ДО completion.
//   Ответ ассистента приходит только через completion.

(function () {
  if (window.__aiCmClaudeInterceptInstalled) return;
  window.__aiCmClaudeInterceptInstalled = true;

  var originalFetch = window.fetch;
  if (typeof originalFetch !== 'function') return;

  // ---- состояние ----
  var lastHistoryUrl = null;       // адрес последнего GET снимка чата
  var lastModel = '';              // модель из последнего ответа
  var refreshBusy = false;
  var activeDisabled = false;
  var dirty = false;
  var loggedActiveStatus = false;
  var guardToken = '__aicm_claude__';

  // ---- bootstrap: активный снимок при загрузке (сервер рендерит HTML без fetch) ----
  var orgId = '';
  var snapshotReceived = false;
  var bootstrapTimer = null;

  // ---- токены вложений (оценка) ----
  var IMAGE_DEFAULT_TOKENS = 516;   // как в Gemini
  var DOC_EST_TOKENS = 2500;
  var attachSeen = {};
  var attachTokens = 0;
  var attachBreak = { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 };
  var loggedAttach = false;

  // ---- SPA: детектор смены чата (по образцу page-intercept.js v11) ----
  function getConvId() {
    try {
      // Claude URL: https://claude.ai/chat/<uuid>  или  /project/<pid>/chat/<uuid>
      var parts = location.pathname.split('/');
      var chatIdx = parts.indexOf('chat');
      if (chatIdx !== -1 && chatIdx + 1 < parts.length) return parts[chatIdx + 1];
      return '';
    } catch (e) { return ''; }
  }
  var currentConvId = getConvId();

  function resetForNewConversation() {
    lastHistoryUrl = null;
    lastModel = '';
    dirty = false;
    refreshBusy = false;
    activeDisabled = false;
    loggedActiveStatus = false;
    attachSeen = {};
    attachTokens = 0;
    attachBreak = { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 };
    loggedAttach = false;
    snapshotReceived = false;
    if (bootstrapTimer) { clearTimeout(bootstrapTimer); bootstrapTimer = null; }
    debugLog('log', '[claude-intercept] смена чата → состояние сброшено (convId=' + (currentConvId || '(не чат)') + ')');
    try { window.dispatchEvent(new CustomEvent('ai-cm-conversation-changed')); } catch (e) {}
    bootstrapTimer = setTimeout(function () { bootstrapSnapshot(); }, 1500);
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
        try { checkConvChange(); } catch (e) {}
        return r;
      };
    }
    var origReplace = history.replaceState;
    if (origReplace) {
      history.replaceState = function () {
        var r = origReplace.apply(this, arguments);
        try { checkConvChange(); } catch (e) {}
        return r;
      };
    }
    window.addEventListener('popstate', function () { try { checkConvChange(); } catch (e) {} });
  } catch (e) {}

  // ---- bootstrap: активный запрос снимка при загрузке (сервер рендерит HTML без fetch) ----
  function bootstrapSnapshot() {
    if (bootstrapTimer) { clearTimeout(bootstrapTimer); bootstrapTimer = null; }
    if (!currentConvId) { debugLog('log', '[claude-intercept] bootstrap: нет convId — не чат'); return; }
    if (snapshotReceived) { debugLog('log', '[claude-intercept] bootstrap: не нужен (снимок уже получен для ' + currentConvId + ')'); return; }

    function doFetchWithOrg(id) {
      var url = '/api/organizations/' + id + '/chat_conversations/' + currentConvId + '?tree=True&rendering_mode=messages&render_all_tools=true&consistency=eventual';
      debugLog('log', '[claude-intercept] bootstrap: активный снимок при загрузке (' + url + ')');
      originalFetch(url, { credentials: 'include' })
        .then(function (resp) {
          if (!resp || !resp.ok) { debugLog('log', '[claude-intercept] bootstrap: ошибка статус=' + (resp ? resp.status : 'none')); return null; }
          return resp.json();
        })
        .then(function (data) {
          if (!data) return;
          snapshotReceived = true;
          lastHistoryUrl = url;
          emitSnapshot(parseHistoryWithEffects(data), 'bootstrap');
        })
        .catch(function (e) { debugLog('log', '[claude-intercept] bootstrap: ошибка fetch: ' + e); });
    }

    if (orgId) {
      doFetchWithOrg(orgId);
    } else {
      debugLog('log', '[claude-intercept] bootstrap: orgId неизвестен, запрашиваю /api/organizations');
      originalFetch('/api/organizations', { credentials: 'include' })
        .then(function (resp) {
          if (!resp || !resp.ok) { debugLog('log', '[claude-intercept] bootstrap: /api/organizations статус=' + (resp ? resp.status : 'none')); return null; }
          return resp.json();
        })
        .then(function (data) {
          if (!data) return;
          var id = '';
          if (Array.isArray(data) && data.length > 0) {
            id = data[0].uuid || data[0].id || '';
          } else if (typeof data === 'object' && data !== null) {
            var keys = Object.keys(data);
            if (keys.length > 0) {
              var first = data[keys[0]];
              id = (first && (first.uuid || first.id)) || keys[0];
            }
          }
          if (id) {
            orgId = id;
            debugLog('log', '[claude-intercept] bootstrap: orgId получен=' + orgId);
            doFetchWithOrg(orgId);
          } else {
            debugLog('log', '[claude-intercept] bootstrap: не удалось получить orgId из ответа');
          }
        })
        .catch(function (e) { debugLog('log', '[claude-intercept] bootstrap: ошибка fetch организаций: ' + e); });
    }
  }

  // ---- сбор вложений из блоков ----
  function collectAttachments(messages) {
    if (!Array.isArray(messages)) return;
    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      var blocks = msg && msg.content;
      if (!Array.isArray(blocks)) continue;
      for (var j = 0; j < blocks.length; j++) {
        var b = blocks[j];
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'image' || b.type === 'image_url') {
          var imgKey = 'img_' + (msg.uuid || i) + '_' + j;
          if (!attachSeen[imgKey]) {
            attachSeen[imgKey] = 1;
            attachTokens += IMAGE_DEFAULT_TOKENS;
            attachBreak.imgTokens += IMAGE_DEFAULT_TOKENS;
            attachBreak.imgCount++;
          }
        }
      }
    }
    if (!loggedAttach && attachTokens > 0) {
      loggedAttach = true;
      debugLog('log', '[claude-intercept] изображений в диалоге: ' + attachBreak.imgCount +
        ', добавлено токенов: ' + attachBreak.imgTokens +
        ' (по ' + IMAGE_DEFAULT_TOKENS + ' ток/изобр)');
    }
  }

   // ---- чистый разбор истории (без сайд-эффектов, переиспользуется в тестах) ----
   function parseHistory(data) {
     var messages = data.chat_messages;
     if (!Array.isArray(messages)) messages = [];
     var model = data.model || '';

     var resultMessages = [];
     var pieces = [];
     var ids = [];
     var count = 0;
     var lastText = '';

     for (var i = 0; i < messages.length; i++) {
       var msg = messages[i];
       if (!msg || !msg.content) continue;
       var sender = msg.sender || '';
       if (sender === 'system') continue;

       var blocks = msg.content;
       if (!Array.isArray(blocks)) continue;

       var textParts = [];
       for (var j = 0; j < blocks.length; j++) {
         var b = blocks[j];
         if (!b || typeof b !== 'object') continue;

         if (b.type === 'text' && typeof b.text === 'string') {
           textParts.push(b.text);
         } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
           textParts.push(b.thinking);
         } else if (b.type === 'tool_use') {
           textParts.push(JSON.stringify(b));
         } else if (b.type === 'tool_result') {
           textParts.push(JSON.stringify(b));
         }
       }

       var text = textParts.join('\n').trim();
       if (text) {
         resultMessages.push({ role: sender === 'assistant' ? 'assistant' : 'human', text: text });
         pieces.push(text);
         ids.push(msg.uuid || ('msg' + i));
         count++;
         lastText = text;
       }
     }

     return { text: pieces.join('\n'), count: count, lastText: lastText, modelSlug: model, pieces: pieces, ids: ids, messages: resultMessages, model: model };
   }

   // ---- обёртка с сайд-эффектами для боевого кода ----
   function parseHistoryWithEffects(data) {
     var parsed = parseHistory(data);
     var model = parsed.model || lastModel || '';
     if (model) lastModel = model;
     parsed.modelSlug = model;

     var messages = data.chat_messages;
     if (Array.isArray(messages)) collectAttachments(messages);

     return parsed;
   }

  function emitSnapshot(parsed, when) {
    if (!parsed.text) return;
    console.log('[claude-intercept] ' + String.fromCodePoint(0x1F4E5) + ' полный снимок (' + when + '): ' + parsed.count +
      ' сообщений' + (parsed.modelSlug ? ', model=' + parsed.modelSlug : '') +
      (attachTokens > 0 ? ', вложений' + String.fromCodePoint(0x2248) + attachTokens + ' ток' : '') +
      ' (без скролла)');
    try {
      window.dispatchEvent(new CustomEvent('ai-cm-full-history', {
        detail: {
          text: parsed.text,
          count: parsed.count,
          lastMessageText: parsed.lastText,
          modelSlug: parsed.modelSlug,
          messageTexts: parsed.pieces,
          messageIds: parsed.ids,
          attachTokens: attachTokens,
          attachBreak: {
            imgTokens: attachBreak.imgTokens,
            docTokens: attachBreak.docTokens,
            imgCount: attachBreak.imgCount,
            docCount: attachBreak.docCount
          },
          historyComplete: true,
          serverTokens: 0
        }
      }));
    } catch (e) {}
  }

  // ---- обработка ответа истории ----
  function handleHistoryResponse(response, when, expectedConvId) {
    var copy = response.clone();
    copy.json().then(function (data) {
      if (expectedConvId && expectedConvId !== currentConvId) {
        debugLog('log', '[claude-intercept] пропущен устаревший снимок (convId=' + expectedConvId + ' != текущий ' + currentConvId + ')');
        return;
      }
      // Пассивный снимок получен — отменяем bootstrap-таймер
      if (bootstrapTimer) { clearTimeout(bootstrapTimer); bootstrapTimer = null; }
      snapshotReceived = true;
      emitSnapshot(parseHistoryWithEffects(data), when);
    }).catch(function (e) {
      debugLog('log', '[claude-intercept] ошибка парсинга JSON истории: ' + e);
    });
  }

  // ---- «виртуальный F5»: активный GET полного снимка ----
  function activeRefresh(reason) {
    if (activeDisabled || refreshBusy) return;
    if (!lastHistoryUrl) {
      if (!loggedActiveStatus) { loggedActiveStatus = true; debugLog('log', '[claude-vf5] активный запрос отложен: нет адреса снимка пока'); }
      return;
    }
    var sentConvId = currentConvId;
    refreshBusy = true;
    var sep = lastHistoryUrl.indexOf('?') === -1 ? '?' : '&';
    var markedUrl = lastHistoryUrl + sep + guardToken + '=1';
    originalFetch(markedUrl, { method: 'GET', credentials: 'include' })
      .then(function (resp) {
        if (!loggedActiveStatus) {
          loggedActiveStatus = true;
          console.log('[claude-vf5] первый активный запрос: статус ' + (resp ? resp.status : 'none'));
        }
        if (!resp || !resp.ok) {
          activeDisabled = true;
          debugLog('log', '[claude-vf5] не прошёл (статус ' + (resp ? resp.status : 'none') + ') → остаёмся на пассивной ловле');
          return null;
        }
        console.log('[claude-vf5] ' + String.fromCodePoint(0x2713) + ' работает (' + reason + ')');
        return resp.json();
      })
      .then(function (data) {
        if (!data) return;
        if (sentConvId !== currentConvId) {
          debugLog('log', '[claude-intercept] пропущен устаревший vf5 (convId=' + sentConvId + ' != текущий ' + currentConvId + ')');
          return;
        }
        emitSnapshot(parseHistoryWithEffects(data), 'виртуальный F5');
        dirty = false;
      })
      .catch(function (err) {
        if (!loggedActiveStatus) { loggedActiveStatus = true; }
        activeDisabled = true;
        debugLog('log', '[claude-vf5] ошибка: ' + err + ' → остаёмся на пассивной ловле');
      })
      .finally(function () { refreshBusy = false; });
  }

  function scheduleActive(reason, delay) {
    if (activeDisabled) return;
    dirty = true;
    setTimeout(function () { activeRefresh(reason); }, delay);
  }

  // ---- чистый парсинг SSE-стрима (без сайд-эффектов, переиспользуется в тестах) ----
  function parseSSEStream(text, url) {
    var lines = text.split('\n');
    var model = '';
    var stopDetected = false;
    var textParts = [];
    var rateLimit5h = 0;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf('event: ') === 0 || line.indexOf('data: ') !== 0) continue;

      var jsonStr = line.substring(6);
      try {
        var data = JSON.parse(jsonStr);
        if (data.type === 'message_start' && data.message && data.message.model) {
          model = data.message.model;
        }
        if (data.type === 'content_block_delta' && data.delta && typeof data.delta.text === 'string') {
          textParts.push(data.delta.text);
        }
        if (data.type === 'content_block_delta' && data.delta && data.delta.type === 'thinking_delta' && typeof data.delta.thinking === 'string') {
          textParts.push(data.delta.thinking);
        }
        if (data.type === 'content_block_delta' && data.delta && data.delta.type === 'thinking_summary_delta' && data.delta.thinking_summary) {
          textParts.push(data.delta.thinking_summary);
        }
        if (data.type === 'message_limit' && data.message_limit && data.message_limit.windows &&
            data.message_limit.windows['5h'] && typeof data.message_limit.windows['5h'].utilization === 'number') {
          rateLimit5h = data.message_limit.windows['5h'].utilization;
        }
        if (data.type === 'message_stop') {
          stopDetected = true;
        }
      } catch (e) {}
    }
    return { model: model, stopDetected: stopDetected, text: textParts.join(''), rateLimit5h: rateLimit5h };
  }

  // ---- обёртка с сайд-эффектами для боевого кода ----
  function parseSSEWithEffects(fullText, url) {
    var parsed = parseSSEStream(fullText, url);
    if (parsed.model) lastModel = parsed.model;
    return parsed;
  }

  // ---- перехват fetch ----
  function makeUrlMatcher(url) {
    try {
      var u = typeof url === 'string' ? url : (url && url.url ? url.url : '');
      return {
        full: u,
        isHistory: u.indexOf('/chat_conversations/') !== -1 && u.indexOf('/completion') === -1,
        isCompletion: u.indexOf('/completion') !== -1,
        hasGuard: u.indexOf(guardToken) !== -1
      };
    } catch (e) { return { full: '', isHistory: false, isCompletion: false, hasGuard: false }; }
  }

  window.fetch = function (input, init) {
    var m = makeUrlMatcher(input);

    // Извлекаем orgId из ЛЮБОГО URL, содержащего /api/organizations/
    if (!orgId) {
      try {
        var orgMatch = m.full.match(/\/api\/organizations\/([0-9a-f-]{36})/);
        if (orgMatch) {
          orgId = orgMatch[1];
          debugLog('log', '[claude-intercept] orgId перехвачен из URL: ' + orgId);
        }
      } catch (e) {}
    }

    var isHistory = m.isHistory && !m.hasGuard;
    var isCompletion = m.isCompletion;

    if (!isHistory && !isCompletion) {
      var p = originalFetch.call(this, input, init);
      if (p && typeof p.catch === 'function') p.catch(function () {});
      return p;
    }

    var sentConvId = currentConvId;

    if (isHistory) {
      try {
        lastHistoryUrl = typeof input === 'string' ? input : (input && input.url ? input.url : '');
      } catch (e) {}
      if (lastHistoryUrl.indexOf(guardToken) !== -1) {
        lastHistoryUrl = lastHistoryUrl.replace(/[?&]__aicm_claude__=1/, '').replace(/\?$/, '');
      }
      // Пассивный перехват получил снимок раньше таймера bootstrap — отменяем таймер
      if (bootstrapTimer) { clearTimeout(bootstrapTimer); bootstrapTimer = null; }
      snapshotReceived = true;
    }

    var fetchPromise = originalFetch.call(this, input, init);

    // Ветвь A: история (GET, /chat_conversations/)
    if (isHistory) {
      fetchPromise.then(function (resp) {
        if (!resp || !resp.ok) return;
        handleHistoryResponse(resp, 'пассив', sentConvId);
      }).catch(function () {});
    }

    // Ветвь B: стрим (POST, /completion)
    if (isCompletion) {
      fetchPromise.then(function (resp) {
        if (!resp || !resp.ok || !resp.body) return;
        var reader = resp.clone().body.getReader();
        var decoder = new TextDecoder('utf-8');
        var chunks = [];
        function readLoop() {
          reader.read().then(function (result) {
            if (result.done) {
              var fullText = chunks.join('');
              var parsed = parseSSEWithEffects(fullText, m.full);
              if (parsed.stopDetected) {
                scheduleActive('после стрима', 800);
              }
              return;
            }
            chunks.push(decoder.decode(result.value, { stream: true }));
            readLoop();
          }).catch(function () {
            scheduleActive('после стрима (err)', 1200);
          });
        }
        readLoop();
      }).catch(function () {});
    }

    if (fetchPromise && typeof fetchPromise.catch === 'function') {
      fetchPromise.catch(function () {});
    }

    return fetchPromise;
  };

  // ---- страховка: если стрим прочитан, но stop не поймался ----
  setInterval(function () {
    if (dirty && !refreshBusy) {
      activeRefresh('таймер-страховка');
    }
  }, 15000);

  // ---- bootstrap: активный снимок при старте скрипта ----
  bootstrapTimer = setTimeout(function () { bootstrapSnapshot(); }, 1500);

  console.log('[claude-intercept] перехватчик Claude установлен (GET истории + SSE completion → vf5 + bootstrap, MAIN world, document_start)');
})();