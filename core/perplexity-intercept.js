// core/perplexity-intercept.js — перехватчик Perplexity (perplexity.ai) в MAIN world, document_start.
// Паттерн: как claude-intercept.js — пассивный снимок + виртуальный F5 после стрима.
//
// Реальные данные (DevTools, 12.08.2026):
//   Страница диалога: /search/{slug} или /thread/{slug}
//   Отправка вопроса: POST /rest/sse/perplexity_ask
//     Payload: { query_str, params: { last_backend_uuid, ... } }
//     Ответ: SSE (text/event-stream) — стрим читается до конца, после запускается виртуальный F5
//   История треда: загружается через fetch или XHR (точный URL неизвестен).
//     Ответ JSON: { entries: [...], thread_metadata: {...}, ... }
//     КЛЮЧИ МОГУТ БЫТЬ С ПРОБЕЛАМИ ("entries ", "thread_metadata " и т.д. на всех уровнях).
//   Парсинг делегирован в window.parsePerplexityThread (utils/perplexity-parser.js).
//   usage НЕТ — токены считаются эвристикой на стороне расширения.

(function () {
  if (window.__aiCmPerplexityInterceptInstalled) return;
  window.__aiCmPerplexityInterceptInstalled = true;
  console.log('[perplexity-intercept] parser available: ' + typeof window.parsePerplexityThread);

  var originalFetch = window.fetch;
  if (typeof originalFetch !== 'function') return;

  // ---- состояние ----
  var lastHistoryUrl = null;
  var historyUrlTemplate = null;
  var lastModel = '';
  var refreshBusy = false;
  var activeDisabled = false;
  var dirty = false;
  var loggedActiveStatus = false;
  var guardToken = '__aicm_perplexity__';
  var snapshotReceived = false;
  var bootstrapTimer = null;
  var bootstrapAcceptJsonFailed = false;

  // ---- хелперы (используются для детекции до вызова парсера) ----
  function getTrim(obj, name) {
    if (!obj || typeof obj !== 'object') return undefined;
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].trim() === name) return obj[keys[i]];
    }
    return undefined;
  }

  function hasEntriesAndMetadata(data) {
    if (!data || typeof data !== 'object') return false;
    var entries = getTrim(data, 'entries');
    var meta = getTrim(data, 'thread_metadata');
    return Array.isArray(entries) && meta && typeof meta === 'object';
  }

  // ---- extractUrl: надёжное извлечение URL из аргументов fetch ----
  function extractUrl(args) {
    try {
      var a = (args && args.length > 0) ? args[0] : undefined;
      var raw = '';
      if (typeof a === 'string') { raw = a; }
      else if (a && typeof a.url === 'string') { raw = a.url; }
      else if (a) { raw = String(a); }
      try { raw = new URL(raw, location.href).href; } catch (e) { }
      return raw;
    } catch (e) { return ''; }
  }

  function getMethod(input, init) {
    try { if (init && init.method) return String(init.method).toUpperCase(); if (input && input.method) return String(input.method).toUpperCase(); } catch (e) { }
    return 'GET';
  }

  function isExcludedUrl(urlStr) {
    if (!urlStr) return true;
    if (urlStr.indexOf('_next/static') !== -1) return true;
    if (urlStr.indexOf('restricted-static-assets') !== -1) return true;
    if (urlStr.indexOf('cdn-cgi') !== -1) return true;
    if (urlStr.indexOf('datadoghq') !== -1) return true;
    if (urlStr.indexOf('eppo') !== -1) return true;
    if (/\.(js|css|png|svg|woff|woff2|ico|jpg|jpeg|gif|webp|mp4|webm)(\?|#|$)/.test(urlStr)) return true;
    return false;
  }

  function isPerplexityUrl(urlStr) {
    try {
      if (!urlStr) return false;
      var u = new URL(urlStr, location.href);
      var host = u.hostname.toLowerCase();
      return host === 'www.perplexity.ai' || host === 'perplexity.ai';
    } catch (e) { return false; }
  }

  // ---- SPA: детектор смены треда ----
  function getConvId() {
    try {
      var parts = location.pathname.split('/');
      if (parts.length >= 3) {
        var type = parts[1];
        if (type === 'search' || type === 'thread') return parts.slice(2).join('/');
      }
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
    snapshotReceived = false;
    bootstrapAcceptJsonFailed = false;
    if (bootstrapTimer) { clearTimeout(bootstrapTimer); bootstrapTimer = null; }
    debugLog('log', '[perplexity-intercept] смена треда → состояние сброшено (slug=' + (currentConvId || '(не тред)') + ')');
    try { window.dispatchEvent(new CustomEvent('ai-cm-conversation-changed')); } catch (e) {}
    bootstrapTimer = setTimeout(function () { bootstrapSnapshot(); }, 1500);
  }

  function checkConvChange() {
    var newId = getConvId();
    if (newId !== currentConvId) { currentConvId = newId; resetForNewConversation(); }
  }

  try {
    var origPush = history.pushState;
    if (origPush) { history.pushState = function () { var r = origPush.apply(this, arguments); try { checkConvChange(); } catch (e) {} return r; }; }
    var origReplace = history.replaceState;
    if (origReplace) { history.replaceState = function () { var r = origReplace.apply(this, arguments); try { checkConvChange(); } catch (e) {} return r; }; }
    window.addEventListener('popstate', function () { try { checkConvChange(); } catch (e) {} });
  } catch (e) {}

  // ---- bootstrap ----
  function bootstrapSnapshot() {
    if (bootstrapTimer) { clearTimeout(bootstrapTimer); bootstrapTimer = null; }
    if (!currentConvId) { debugLog('log', '[perplexity-intercept] bootstrap: нет slug — не тред'); return; }
    if (snapshotReceived) { debugLog('log', '[perplexity-intercept] bootstrap: не нужен'); return; }

    if (historyUrlTemplate) {
      var url = historyUrlTemplate.replace('{slug}', currentConvId);
      debugLog('log', '[perplexity-intercept] bootstrap: по шаблону (' + url + ')');
      originalFetch(url, { credentials: 'include' })
        .then(function (resp) { if (!resp || !resp.ok) return null; return resp.json(); })
        .then(function (data) {
          if (!data || currentConvId !== getConvId()) return;
          snapshotReceived = true; lastHistoryUrl = url;
          emitSnapshot(data, 'bootstrap');
        }).catch(function (e) { debugLog('log', '[perplexity-intercept] bootstrap: ошибка ' + e); });
    } else if (!bootstrapAcceptJsonFailed) {
      var url2 = new URL(location.pathname, location.href).href;
      debugLog('log', '[perplexity-intercept] bootstrap: Accept=json (' + url2 + ')');
      originalFetch(url2, { headers: { 'Accept': 'application/json' }, credentials: 'include' })
        .then(function (resp) { if (!resp || !resp.ok) return null; return resp.text(); })
        .then(function (rawText) {
          if (!rawText) return;
          try {
            var data = JSON.parse(rawText);
            if (hasEntriesAndMetadata(data)) {
              snapshotReceived = true; lastHistoryUrl = url2;
              tryBuildTemplate(url2, data);
              emitSnapshot(data, 'bootstrap');
            } else { bootstrapAcceptJsonFailed = true; console.log('[perplexity-intercept] bootstrap: Accept=json вернул не-JSON (нет entries+thread_metadata)'); }
          } catch (e) { bootstrapAcceptJsonFailed = true; console.log('[perplexity-intercept] bootstrap: Accept=json вернул не-JSON'); }
        }).catch(function (e) { bootstrapAcceptJsonFailed = true; console.log('[perplexity-intercept] bootstrap: Accept=json ошибка ' + e); });
    }
  }

  // ---- эмит снимка через window.parsePerplexityThread ----
  function emitSnapshot(data, when) {
    var parsed = { text: '', count: 0 };
    try {
      parsed = window.parsePerplexityThread ? window.parsePerplexityThread(data) : { text: '', count: 0 };
    } catch (e) {
      console.log('[perplexity-intercept] ошибка emitSnapshot:', e && e.message);
      return;
    }
    if (!parsed || !parsed.text) return;
    var model = parsed.model || lastModel || '';
    if (model) lastModel = model;
    console.log('[perplexity-intercept] ' + String.fromCodePoint(0x1F4E5) + ' полный снимок (' + when + '): ' + parsed.count +
      ' сообщений, model=' + (model || '(неизвестно)'));
    try {
      window.dispatchEvent(new CustomEvent('ai-cm-full-history', {
        detail: {
          text: parsed.text, count: parsed.count, lastMessageText: parsed.lastText,
          modelSlug: model, messageTexts: parsed.pieces || [], messageIds: parsed.ids || [],
          messages: parsed.messages || [],
          attachTokens: 0, attachBreak: { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 },
          historyComplete: true, serverTokens: 0
        }
      }));
    } catch (e) {
      console.log('[perplexity-intercept] ошибка emitSnapshot:', e && e.message);
    }
  }

  function tryBuildTemplate(url, data) {
    if (historyUrlTemplate) return;
    var slugToReplace = '';
    var entries = getTrim(data, 'entries');
    if (Array.isArray(entries) && entries.length > 0) {
      var firstSlug = getTrim(entries[0], 'thread_url_slug');
      if (firstSlug && typeof firstSlug === 'string' && url.indexOf(firstSlug) !== -1) slugToReplace = firstSlug;
      if (!slugToReplace) { var enc = encodeURIComponent(firstSlug || ''); if (enc && url.indexOf(enc) !== -1) slugToReplace = enc; }
    }
    if (!slugToReplace && currentConvId) {
      if (url.indexOf(currentConvId) !== -1) slugToReplace = currentConvId;
      else { var enc2 = encodeURIComponent(currentConvId); if (url.indexOf(enc2) !== -1) slugToReplace = enc2; }
    }
    if (slugToReplace) {
      historyUrlTemplate = url.replace(slugToReplace, '{slug}');
      debugLog('log', '[perplexity-intercept] historyUrlTemplate выучен: ' + historyUrlTemplate);
      if (currentConvId && !snapshotReceived) {
        if (bootstrapTimer) { clearTimeout(bootstrapTimer); bootstrapTimer = null; }
        bootstrapTimer = setTimeout(function () { bootstrapSnapshot(); }, 300);
      }
    }
  }

  function processHistoryData(data, url, source) {
    if (!data) return;
    console.log('[perplexity-intercept] сниффинг: снимок истории пойман (' + source + '), URL: ' + url);
    if (bootstrapTimer) { clearTimeout(bootstrapTimer); bootstrapTimer = null; }
    snapshotReceived = true;
    lastHistoryUrl = url;
    tryBuildTemplate(url, data);
    emitSnapshot(data, source);
  }

  // ---- виртуальный F5 ----
  function activeRefresh(reason) {
    if (activeDisabled || refreshBusy) return;
    var url = lastHistoryUrl;
    if (!url && historyUrlTemplate && currentConvId) url = historyUrlTemplate.replace('{slug}', currentConvId);
    if (!url) { if (!loggedActiveStatus) { loggedActiveStatus = true; debugLog('log', '[perplexity-vf5] нет адреса снимка'); } return; }
    if (!currentConvId) return;
    var sentConvId = currentConvId;
    refreshBusy = true;
    var sep = url.indexOf('?') === -1 ? '?' : '&';
    originalFetch(url + sep + guardToken + '=1', { method: 'GET', credentials: 'include' })
      .then(function (resp) {
        if (!loggedActiveStatus) { loggedActiveStatus = true; console.log('[perplexity-vf5] первый запрос: статус ' + (resp ? resp.status : 'none')); }
        if (!resp || !resp.ok) { activeDisabled = true; return null; }
        console.log('[perplexity-vf5] \u2713 работает (' + reason + ')');
        return resp.json();
      })
      .then(function (data) { if (!data || sentConvId !== currentConvId) return; emitSnapshot(data, 'виртуальный F5'); dirty = false; })
      .catch(function (err) { if (!loggedActiveStatus) loggedActiveStatus = true; activeDisabled = true; })
      .finally(function () { refreshBusy = false; });
  }

  function scheduleActive(reason, delay) { if (activeDisabled) return; dirty = true; setTimeout(function () { activeRefresh(reason); }, delay); }

  // ---- сниффинг ----
  function sniffResponseText(resp, url, source) {
    try {
      var copy = resp.clone ? resp.clone() : resp;
      copy.text().then(function (rawText) {
        try {
          var data = JSON.parse(rawText);
          if (hasEntriesAndMetadata(data)) processHistoryData(data, url, source);
          else { var he = getTrim(data, 'entries'); if (he !== undefined) debugLog('log', '[perplexity-intercept] JSON с entries но нет thread_metadata'); }
        } catch (e) { console.log('[perplexity-intercept] ошибка emitSnapshot:', e && e.message); }
      }).catch(function () {});
    } catch (e) {}
  }

  // ---- XHR-патч ----
  (function () {
    var origXHROpen = XMLHttpRequest.prototype.open;
    var origXHRSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) { this.__aicm_method = method; this.__aicm_url = url; return origXHROpen.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      var method = (xhr.__aicm_method || 'GET').toUpperCase();
      var rawUrl = xhr.__aicm_url || '';
      var url = rawUrl;
      try { url = new URL(rawUrl, location.href).href; } catch (e) { url = rawUrl; }
      if (method === 'GET' && isPerplexityUrl(url) && !isExcludedUrl(url) && url.indexOf(guardToken) === -1) {
        xhr.addEventListener('loadend', function () {
          var respUrl = this.responseURL;
          try { respUrl = new URL(respUrl || url, location.href).href; } catch (e) {}
          console.log("[perplexity-intercept] diag: XHR same-host GET", (respUrl || url).slice(0, 140));
          try {
            var data = JSON.parse(xhr.responseText);
            if (hasEntriesAndMetadata(data)) processHistoryData(data, respUrl || url, 'XHR');
            else { var he = getTrim(data, 'entries'); if (he !== undefined) debugLog('log', '[perplexity-intercept] XHR: JSON с entries но нет thread_metadata'); }
          } catch (e) { console.log('[perplexity-intercept] ошибка emitSnapshot:', e && e.message); }
        });
      }
      return origXHRSend.apply(this, arguments);
    };
  })();

  // ---- fetch-патч ----
  window.fetch = function () {
    var url = extractUrl(arguments);
    var method = getMethod(arguments[0], arguments[1]);
    var isAsk = method === 'POST' && url.indexOf('perplexity_ask') !== -1;
    var isSameHost = isPerplexityUrl(url);
    var isExcluded = isExcludedUrl(url);
    var isGuard = url.indexOf(guardToken) !== -1;
    var shouldSniff = method !== 'POST' && isSameHost && !isExcluded && !isGuard;

    if (isSameHost && !isExcluded && !isGuard) {
      console.log("[perplexity-intercept] diag: same-host GET", url.slice(0, 140));
    }

    var fetchPromise = originalFetch.apply(this, arguments);

    if (shouldSniff) {
      fetchPromise.then(function (resp) { if (!resp || !resp.ok) return; sniffResponseText(resp, url, 'fetch'); }).catch(function () {});
    }

    if (isAsk) {
      fetchPromise.then(function (resp) {
        if (!resp || !resp.ok || !resp.body) return;
        var reader = resp.clone().body.getReader();
        var decoder = new TextDecoder('utf-8');
        var chunks = [];
        function readLoop() {
          reader.read().then(function (result) {
            if (result.done) { scheduleActive('после стрима', 800); return; }
            chunks.push(decoder.decode(result.value, { stream: true }));
            readLoop();
          }).catch(function () { scheduleActive('после стрима (err)', 1200); });
        }
        readLoop();
      }).catch(function () {});
    }

    if (fetchPromise && typeof fetchPromise.catch === 'function') fetchPromise.catch(function () {});
    return fetchPromise;
  };

  setInterval(function () { if (dirty && !refreshBusy) activeRefresh('таймер-страховка'); }, 15000);
  bootstrapTimer = setTimeout(function () { bootstrapSnapshot(); }, 1500);

  console.log('[perplexity-intercept] перехватчик Perplexity установлен (window.parsePerplexityThread + extractUrl + сниффинг, MAIN world, document_start)');
})();