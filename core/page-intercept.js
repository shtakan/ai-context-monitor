// core/page-intercept.js  (v14 = v13 + подавление ложных unhandled rejection от чужих прерванных fetch)
// Мир сайта (world: "MAIN"), document_start — регистрация из background.js.
//
// Идея Олега, реализованная буквально: realtime берёт показания ТОГО ЖЕ полного
// снимка, что и F5, но БЕЗ F5 — расширением, после каждого обмена. Это обходит
// виртуализацию DOM в корне (полный снимок = вся история, не «окно»), поэтому
// расхождения «realtime vs F5» больше не будет.
//
// Как: перехватчик запоминает набор заголовков (включая пропуск Authorization),
// с которым САЙТ только что успешно ходил за данными, и адрес последнего полного
// снимка. После обмена (POST отправки / конец ответа) делает ОДИН тихий GET полного
// снимка этим адресом и этими заголовками (originalFetch, credentials:include) —
// сервер отвечает 200, парсим ВСЮ историю, шлём в content.js событием ai-cm-full-history
// (тем же, что при настоящем F5 — content.js не меняется). Плюс таймер-страховка.
// Пассивная ловля снимка при F5 и DOM-хвост в content.js остаются как страховка/мгновенный отклик.
//
// БЕЗОПАСНОСТЬ (важно): пропуск хранится ТОЛЬКО в памяти этой вкладки (переменная),
// используется ТОЛЬКО для fetch к тому же chatgpt.com, НЕ пишется в storage и НЕ шлётся
// в sendMessage/на сервер. Это локальное использование, эквивалентное тому, что сайт
// делает сам. Если активный запрос не проходит (401/403) — молча отключаем его и остаёмся
// на пассивной ловле + DOM-хвост (статус-кво, ничего не ломается).
//
// v11: добавлен детектор смены чата в SPA (ChatGPT переключает чаты без перезагрузки
// страницы через history.pushState/replaceState + popstate). По образцу gemini-intercept.js v17:
// обёртки history API, getConvId из /c/<id>, resetForNewConversation сбрасывает накопители
// и диспатчит ai-cm-conversation-changed для виджета. Заголовки (lastHeaders) НЕ сбрасываем —
// они валидны для любого чата. Сброс срабатывает ТОЛЬКО при смене id чата.
//
// v12: фикс гонки GET-запросов. При быстром переключении чатов ответ /backend-api/conversation/<id>
// от старого чата может прийти с задержкой и лечь в базу нового. Теперь при отправке запоминаем
// convId, для которого он сделан (из URL запроса или currentConvId), а при приходе ответа
// сравниваем с актуальным currentConvId; при несовпадении ответ игнорируется целиком
// (не пишется в базу, не диспатчится ai-cm-full-history).
//
// v13: switch-refetch с constructedUrl для ChatGPT in-memory cache. При SPA-переключении
// на уже-открытый-в-сессии чат сайт не делает GET /backend-api/conversation/<id> (берёт
// из памяти) → lastSnapshotUrl остаётся null → activeRefresh не мог взвести базу.
// Теперь: lastLoadedConvId отслеживает, в какой чат последний раз лёг снимок;
// scheduleSwitchRefetch через 1.2с после resetForNewConversation проверяет, совпадает ли
// lastLoadedConvId с currentConvId, и если нет — вызывает activeRefresh, который умеет
// собрать URL из currentConvId (location.origin + '/backend-api/conversation/' + currentConvId)
// даже без lastSnapshotUrl. При первом клике сайт сам ходит в сеть → lastLoadedConvId
// совпадает → лишнего запроса нет. При обратном клике сайт молчит → activeRefresh
// сходит сам и взведёт базу.
//
// v14: подавление ложной кнопки «Ошибки» на плитке расширения (chrome://extensions).
//   Причина: обёртка window.fetch подменяет оригинал, поэтому ЛЮБОЙ fetch страницы создаёт
//   промис внутри нашей обёртки. Когда чужой запрос страницы отклоняется без обработчика
//   (Failed to fetch при навигации/переключении), браузер видит unhandled rejection
//   и, поскольку промис создан в обёртке, приписывает ошибку расширению.
//   Решение: (1) тихий .catch на промисе originalFetch — снимает unhandled-сигнал для
//   чужих прерванных запросов, не меняя поведения страницы; (2) устранение висячего
//   Promise.reject(err) в onRejected пассивной ловли снимка (замена на пустую функцию).

(function () {
  if (window.__aiCmInterceptInstalled) return;
  window.__aiCmInterceptInstalled = true;

  var originalFetch = window.fetch;
  if (typeof originalFetch !== 'function') return;

  // ---- состояние для «виртуального F5» ----
  var lastHeaders = null;       // свежий набор заголовков сайта (вкл. Authorization)
  var lastSnapshotUrl = null;   // адрес последнего полного снимка, по которому сайт получил 200
  var refreshBusy = false;
  var activeDisabled = false;   // если активный запрос не прошёл — выключаем его
  var dirty = false;            // был обмен с последнего снимка
  var loggedActiveStatus = false;
  var guardToken = '__aicm_active__';

  // ---- учёт изображений в диалоге (включения, как в Gemini) ----
  var IMAGE_DEFAULT_TOKENS = 765;  // средняя оценка OpenAI high-detail, 1024×1024
  var attachSeen = {};
  var attachTokens = 0;
  var attachBreak = { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 };
  var loggedAttach = false;

  // ---- v13: состояние для switch-refetch (in-memory cache ChatGPT) ----
  var lastLoadedConvId = '';
  var switchRefetchTimer = null;

  var activeRetryCount = 0;       // счётчик ретраев activeRefresh при устаревшем JSON (последнее — user)
  var passiveGetInFlight = false; // флаг: пассивный GET полного снимка для текущего чата ещё в полёте
  var fallbackTimer = null;       // таймер отложенного фолбэка снимка при открытии/переключении

  // ============== v11: детектор смены чата в SPA (образец: gemini-intercept.js v17) ==============
  function getConvId() {
    try {
      // ChatGPT URL: https://chatgpt.com/c/<conversation-id>
      var m = location.pathname.match(/\/c\/([A-Za-z0-9_-]+)/);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }
  var currentConvId = getConvId();

  function resetForNewConversation() {
    lastSnapshotUrl = null;
    lastLoadedConvId = '';
    dirty = false;
    refreshBusy = false;
    activeDisabled = false;
    loggedActiveStatus = false;
    attachSeen = {};
    attachTokens = 0;
    attachBreak = { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 };
    loggedAttach = false;
    activeRetryCount = 0;
    debugLog('log', '[ai-cm-intercept] смена чата → состояние перехватчика сброшено (convId=' + (currentConvId || '(не чат)') + ')');
    try { window.dispatchEvent(new CustomEvent('ai-cm-conversation-changed')); } catch (e) {}
    scheduleSwitchRefetch();
    scheduleFallback(currentConvId, 2000);
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
  // ============================================================================================

  // ---- v12: извлечь convId из URL бэкенд-запроса (для проверки гонки) ----
  function convIdFromBackendUrl(url) {
    try {
      // URL: /backend-api/conversation/<convId>  или  .../backend-api/conversation/<convId>?...
      var m = url.match(/\/backend-api\/conversation\/([A-Za-z0-9_-]+)/);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }

  function urlOf(input) {
    try { if (typeof input === 'string') return input; if (input && input.url) return input.url; } catch (e) { }
    return '';
  }
  function methodOf(input, init) {
    try { if (init && init.method) return String(init.method).toUpperCase(); if (input && input.method) return String(input.method).toUpperCase(); } catch (e) { }
    return 'GET';
  }
  function tail(url) {
    var i = url.indexOf('/backend-api/');
    var s = (i !== -1) ? url.slice(i) : url;
    return s.length > 72 ? s.slice(0, 72) + '…' : s;
  }

  function isFullSnapshotGet(url, m) {
    return !!url && m === 'GET' &&
      url.indexOf('/backend-api/conversation/') !== -1 &&
      url.indexOf('/stream') === -1 &&
      url.indexOf('/f/') === -1 &&
      url.indexOf('/textdocs') === -1 &&
      url.indexOf(guardToken) === -1;
  }
  function isBackend(url) { return !!url && url.indexOf('/backend-api/') !== -1; }
  function isSendPost(url, m) {
    return !!url && m === 'POST' && url.indexOf('/f/conversation') !== -1 && url.indexOf('/prepare') === -1;
  }
  function isStreamEnd(url, m) {
    return !!url && m === 'GET' && url.indexOf('/backend-api/conversation/') !== -1 && url.indexOf('/stream') !== -1;
  }

  // ---- запоминаем заголовки сайта (включая пропуск) из его исходящих запросов ----
  function captureHeaders(input, init) {
    var h = {};
    try {
      if (typeof Request !== 'undefined' && input instanceof Request && input.headers && typeof input.headers.forEach === 'function') {
        input.headers.forEach(function (v, k) { h[k] = v; });
      }
    } catch (e) { }
    try {
      if (init && init.headers) {
        var hh = init.headers;
        if (hh && typeof hh.forEach === 'function') { hh.forEach(function (v, k) { h[k] = v; }); }
        else if (Array.isArray(hh)) { for (var i = 0; i < hh.length; i++) if (hh[i] && hh[i][0]) h[hh[i][0]] = hh[i][1]; }
        else if (typeof hh === 'object') { for (var k in hh) h[k] = hh[k]; }
      }
    } catch (e) { }
    return h;
  }
  function hasAuth(h) {
    if (!h) return false;
    for (var k in h) if (k.toLowerCase() === 'authorization' && h[k]) return true;
    return false;
  }

  // ---- разбор полного снимка (тот же, что при F5) ----
  function parseHistory(data) {
    var mapping = (data && data.mapping) ? data.mapping : {};
    var pieces = []; var ids = []; var roles = []; var count = 0; var lastText = ''; var lastModelSlug = ''; var lastRole = '';
    var localImgSeen = {}; var imgCount = 0; var imgTokens = 0;
    for (var key in mapping) {
      var node = mapping[key]; var msg = node && node.message;
      if (!msg || !msg.content) continue;
      var role = (msg.author && msg.author.role) ? msg.author.role : '';
      if (role === 'system') continue;
      var parts = msg.content.parts;
      if (!Array.isArray(parts)) continue;
      var text = '';
      for (var i = 0; i < parts.length; i++) {
        if (typeof parts[i] === 'string') {
          text += parts[i] + '\n';
        } else if (typeof parts[i] === 'object' && parts[i] !== null) {
          // изображения: content_type содержит 'image' или есть asset_pointer / attachment
          var isImage = false;
          if (parts[i].content_type && typeof parts[i].content_type === 'string' && parts[i].content_type.indexOf('image') !== -1) isImage = true;
          if (!isImage && parts[i].asset_pointer) isImage = true;
          if (!isImage) {
            // вложения могут иметь content_type с 'image' или быть картинкой-мультиформатом
            try { if (parts[i].content_type && typeof parts[i].content_type === 'string') isImage = true; } catch (e) { }
          }
          if (isImage) {
            var imgKey = key + '_' + i;
            if (!localImgSeen[imgKey]) {
              localImgSeen[imgKey] = 1;
              imgCount++;
              imgTokens += IMAGE_DEFAULT_TOKENS;
              if (!attachSeen[imgKey]) {
                attachSeen[imgKey] = 1;
                attachBreak.imgTokens += IMAGE_DEFAULT_TOKENS;
                attachBreak.imgCount++;
                attachTokens += IMAGE_DEFAULT_TOKENS;
              }
            }
          }
        }
      }
      text = text.trim();
      var meta = msg.metadata || {};
      var slug = meta.model_slug || meta.model || '';
      if (text) {
        pieces.push(text); ids.push(String(key)); roles.push(role); count++; lastText = text; lastRole = role;
        if (slug) lastModelSlug = slug;
      }
    }
    // лог изображений (однократно при первом обнаружении)
    if (!loggedAttach && attachTokens > 0) {
      loggedAttach = true;
      console.log('[ai-cm] картинок в диалоге: ' + attachBreak.imgCount +
        ', добавлено токенов: ' + attachBreak.imgTokens +
        ' (по ' + IMAGE_DEFAULT_TOKENS + ' ток/изобр, high-detail оценка OpenAI 1024×1024)');
    }
    return { text: pieces.join('\n'), count: count, lastText: lastText, lastModelSlug: lastModelSlug, pieces: pieces, ids: ids, roles: roles, lastRole: lastRole, imgCount: imgCount, imgTokens: imgTokens };
  }
  function emitSnapshot(parsed, when) {
    if (!parsed.text) return;
    lastLoadedConvId = currentConvId;
    // Диагностика: роли и длины последних 3 сообщений распарсенного JSON (до попадания в базу).
    // Показывает, есть ли ответ ассистента в самом JSON или бэкенд отдал устаревшую версию.
    var diagTail = [];
    var diagPieces = parsed.pieces || [];
    var diagRoles = parsed.roles || [];
    for (var di = Math.max(0, diagRoles.length - 3); di < diagRoles.length; di++) {
      diagTail.push(diagRoles[di] + ':' + (diagPieces[di] ? diagPieces[di].length : 0));
    }
    console.log('[ai-cm-intercept] diag: хвост снимка: ' + JSON.stringify(diagTail));
    console.log('[ai-cm-intercept] 📥 полный снимок (' + when + '): ' + parsed.count +
      ' сообщений' + (parsed.lastModelSlug ? ', model_slug=' + parsed.lastModelSlug : '') +
      (attachTokens > 0 ? ', картинок=' + attachBreak.imgCount + ' ≈' + attachBreak.imgTokens + ' ток' : '') +
      ' (без скролла)');
    // Экспорт истории: роли берём из внутреннего разбора (parsed.roles, параллелен parsed.pieces).
    var messages = [];
    for (var mi = 0; mi < diagPieces.length; mi++) {
      var mRole = diagRoles[mi] || '';
      messages.push({ role: (mRole === 'user') ? 'user' : 'assistant', text: diagPieces[mi] || '' });
    }
    try {
      window.dispatchEvent(new CustomEvent('ai-cm-full-history', {
        detail: {
          text: parsed.text, count: parsed.count, lastMessageText: parsed.lastText,
          modelSlug: parsed.lastModelSlug, messageTexts: parsed.pieces, messageIds: parsed.ids,
          messages: messages,
          attachTokens: attachTokens,
          attachBreak: { imgTokens: attachBreak.imgTokens, docTokens: attachBreak.docTokens, imgCount: attachBreak.imgCount, docCount: attachBreak.docCount },
          historyComplete: true,
          serverTokens: 0
        }
      }));
    } catch (e) { }
  }
  function handleSnapshot(response, when, expectedConvId) {
    var copy = response.clone();
    copy.json().then(function (data) {
      // v12: проверка гонки — ответ от старого чата игнорируем
      if (expectedConvId && expectedConvId !== currentConvId) {
        debugLog('log', '[ai-cm-intercept] пропущен устаревший снимок (convId ответа ' + expectedConvId + ' != текущий ' + currentConvId + ')');
        return;
      }
      emitSnapshot(parseHistory(data), when);
    }).catch(function () { });
  }

  // ---- «виртуальный F5»: активный GET полного снимка заголовками сайта ----
  function activeRefresh(reason) {
    if (activeDisabled || refreshBusy) return;
    var baseUrl = lastSnapshotUrl || (currentConvId ? (location.origin + '/backend-api/conversation/' + currentConvId) : null);
    if (!baseUrl || !lastHeaders || !hasAuth(lastHeaders)) {
      if (!loggedActiveStatus) { loggedActiveStatus = true; debugLog('log', '[virtual-f5] активный запрос отложен: нет адреса/пропуска пока'); }
      return;
    }
    // v12: запоминаем convId на момент отправки для проверки гонки
    var sentConvId = currentConvId;
    refreshBusy = true;
    var headers = {};
    for (var k in lastHeaders) headers[k] = lastHeaders[k]; // воспроизводим свежий набор сайта
    // помечаем URL, чтобы наша обёртка не словила свой же запрос как входящий снимок
    var sep = baseUrl.indexOf('?') === -1 ? '?' : '&';
    var markedUrl = baseUrl + sep + guardToken + '=1&cb=' + Date.now();
    originalFetch(markedUrl, { method: 'GET', headers: headers, credentials: 'include' })
      .then(function (resp) {
        if (!loggedActiveStatus) {
          loggedActiveStatus = true;
          console.log('[virtual-f5] первый активный запрос: статус ' + resp.status + ' (пропуск=' + (hasAuth(lastHeaders) ? 'да' : 'нет') + ')');
        }
        if (!resp || !resp.ok) {
          activeDisabled = true;
          debugLog('log', '[virtual-f5] не прошёл (статус ' + (resp ? resp.status : 'none') +
            ') → остаёмся на пассивной ловле + DOM-хвост (поведение как раньше)');
          return null;
        }
        console.log('[virtual-f5] ✓ работает — realtime теперь по полному снимку без F5 (' + reason + ')');
        return resp.json();
      })
      .then(function (data) {
        if (!data) return;
        // v12: проверка гонки
        if (sentConvId !== currentConvId) {
          debugLog('log', '[ai-cm-intercept] пропущен устаревший снимок (convId ответа ' + sentConvId + ' != текущий ' + currentConvId + ')');
          return;
        }
        var parsed = parseHistory(data);
        if (parsed.text) {
          emitSnapshot(parsed, 'виртуальный F5');
          dirty = false;
          // Ветка А: если последнее сообщение в JSON — user, значит ответ ассистента ещё не записался
          // (бэкенд/CDN отдал устаревшую версию). Повторяем активный GET через 1500/4000/9000/16000 мс (до 4 ретраев).
          if (parsed.lastRole === 'user' && activeRetryCount < 4) {
            activeRetryCount++;
            var retrySchedule = [1500, 4000, 9000, 16000];
            var retryDelay = retrySchedule[activeRetryCount - 1] || 16000;
            setTimeout(function () { activeRefresh('ретрай после ответа #' + activeRetryCount); }, retryDelay);
          } else if (parsed.lastRole === 'assistant') {
            activeRetryCount = 0;
          }
        }
      })
      .catch(function (err) {
        if (!loggedActiveStatus) { loggedActiveStatus = true; }
        activeDisabled = true;
        debugLog('log', '[virtual-f5] ошибка активного запроса: ' + err + ' → остаёмся на пассивной ловле + DOM-хвост');
      })
      .finally(function () { refreshBusy = false; });
  }

  function scheduleActive(reason, delay) {
    if (activeDisabled) return;
    dirty = true;
    setTimeout(function () { activeRefresh(reason); }, delay);
  }

  // ---- отложенный фолбэк активного снимка (для аккаунтов, где сайт не делает пассивный GET) ----
  function fallbackSnapshot(convId) {
    if (!convId) return;
    // Пропуск: пассивный снимок для текущего convId уже получен
    if (lastLoadedConvId === convId) {
      console.log('[ai-cm-intercept] fallback: пропуск (пассивный снимок уже получен)');
      return;
    }
    // Пропуск: пассивный GET для текущего convId ещё в полёте
    if (passiveGetInFlight) {
      console.log('[ai-cm-intercept] fallback: пропуск (пассивный GET ещё в полёте)');
      return;
    }
    console.log('[ai-cm-intercept] fallback: активный снимок');
    var url = location.origin + '/backend-api/conversation/' + convId;
    var init = { method: 'GET', credentials: 'include' };
    if (lastHeaders && hasAuth(lastHeaders)) {
      var fh = {};
      for (var fk in lastHeaders) fh[fk] = lastHeaders[fk];
      init.headers = fh;
    }
    originalFetch(url, init)
      .then(function (resp) {
        if (!resp || !resp.ok) {
          console.log('[ai-cm-intercept] fallback: статус ' + (resp ? resp.status : 'none') + ' для ' + convId);
          return null;
        }
        handleSnapshot(resp, 'fallback', convId);
        return null;
      })
      .catch(function () { /* тихо */ });
  }

  function scheduleFallback(convId, delay) {
    try { clearTimeout(fallbackTimer); } catch (e) { }
    fallbackTimer = setTimeout(function () {
      if (!convId) return;
      fallbackSnapshot(convId);
    }, delay);
  }

  // ---- v13: switch-refetch — покрывает случай, когда сайт не ходит в сеть при SPA-переключении ----
  function scheduleSwitchRefetch() {
    try { clearTimeout(switchRefetchTimer); } catch (e) { }
    switchRefetchTimer = setTimeout(function () {
      try {
        if (currentConvId && currentConvId !== lastLoadedConvId && lastHeaders && hasAuth(lastHeaders)) {
          activeRefresh('переключение чата (сайт не сходил в сеть)');
        }
      } catch (e) { }
    }, 1200);
  }

  // таймер-страховка: если был обмен, а снимок давно не приходил — сходим сами
  setInterval(function () {
    if (activeDisabled || !dirty || refreshBusy) return;
    activeRefresh('таймер-страховка');
  }, 12000);

  // ---- подмена fetch (v14: тихий catch + устранение висячего Promise.reject) ----
  window.fetch = function (input, init) {
    var url = urlOf(input);
    var method = methodOf(input, init);

    // запоминаем заголовки сайта со ВСЕХ backend-запросов, где есть пропуск
    if (isBackend(url)) {
      var h = captureHeaders(input, init);
      if (hasAuth(h)) lastHeaders = h;
    }

    var responsePromise;
    try { responsePromise = originalFetch.apply(this, arguments); }
    catch (e) { return Promise.reject(e); }

    // v14: тихий catch — снимает ложный unhandled rejection для чужих прерванных запросов
    // (Failed to fetch при навигации/переключении), не меняя поведения страницы
    responsePromise.catch(function () { /* тихо: снимаем ложный unhandled для чужих прерванных запросов */ });

    // пассивная ловля полного снимка (при F5 и когда сайт сам шлёт после ответа)
    if (isFullSnapshotGet(url, method)) {
      debugLog('log', '[ai-cm-intercept] req GET ' + tail(url));
      // v12: извлекаем convId из URL запроса для проверки гонки
      var snapshotConvId = convIdFromBackendUrl(url);
      // флаг «пассивный GET в полёте» — чтобы фолбэк не дублировал сайт и не уходил в 404
      var isPassiveForCurrent = !!(snapshotConvId && snapshotConvId === currentConvId);
      if (isPassiveForCurrent) passiveGetInFlight = true;
      responsePromise.then(function (resp) {
        try {
          if (resp && resp.ok) {
            lastSnapshotUrl = url;          // адрес для «виртуального F5»
            dirty = false;                  // свежий снимок — хвост/активный не нужны
            handleSnapshot(resp, (document.readyState === 'complete') ? 'после ответа/обновления' : 'при загрузке', snapshotConvId);
          }
        } catch (e) { }
        if (isPassiveForCurrent) passiveGetInFlight = false;
        return resp;
      }, function () {
        if (isPassiveForCurrent) passiveGetInFlight = false;
        /* v14: тихо — не создаём висячий Promise.reject */
      });
    }

    // триггеры обмена → планируем «виртуальный F5» (даём серверу время зафиксировать)
    if (isSendPost(url, method)) scheduleActive('после отправки', 2500);
    if (isStreamEnd(url, method)) scheduleActive('после конца ответа', 2000);

    return responsePromise;
  };

  // ---- отложенный фолбэк снимка при первом открытии чата ----
  window.addEventListener('load', function () {
    var cid = getConvId();
    if (cid) scheduleFallback(cid, 2000);
  });
  // если к моменту установки скрипта страница уже загружена — запускаем сразу
  if (document.readyState === 'complete') {
    var cid2 = getConvId();
    if (cid2) scheduleFallback(cid2, 2000);
  }

  console.log('[ai-cm-intercept] перехватчик v14 (виртуальный F5 + пассивная ловля + детектор смены чата + фикс гонки GET + switch-refetch с constructedUrl + подавление чужих unhandled fetch + отложенный фолбэк снимка) установлен');
})();