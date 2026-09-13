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

  // v31: флаг «Подробные логи» транслируется из content.js (ISOLATED) через CustomEvent
  try { window.addEventListener('ai-cm-debug-logs', function (ev) { __aiCmSetDebugLogs(!!(ev && ev.detail)); }); } catch (e) {}

  console.log('[perplexity-intercept] parser available: ' + typeof window.parsePerplexityThread);

  var originalFetch = window.fetch;
  if (typeof originalFetch !== 'function') return;

  // ---- состояние ----
  var lastHistoryUrl = null;
  var historyUrlTemplate = null;
  var lastModel = '';
  var refreshBusy = false;
  var activeDisabled = false;
  // v31: retry с backoff вместо вечного latch — при сбое vf5 планируем сброс 30s→60s→120s (кап 2 мин)
  var activeRetryTimer = null;
  var activeRetryDelay = 30000;
  var dirty = false;
  var loggedActiveStatus = false;
  var guardToken = '__aicm_perplexity__';

  function scheduleActiveRetry() {
    if (activeRetryTimer) return; // один страховой интервал
    activeRetryTimer = setTimeout(function () {
      activeRetryTimer = null;
      debugLog('log', '[perplexity-vf5] retry после сбоя (delay=' + activeRetryDelay + 'мс)');
      activeRefresh('retry-backoff');
    }, activeRetryDelay);
    activeRetryDelay = Math.min(activeRetryDelay * 2, 120000);
  }
  function clearActiveRetry() {
    if (activeRetryTimer) { clearTimeout(activeRetryTimer); activeRetryTimer = null; }
    activeRetryDelay = 30000;
  }
  var snapshotReceived = false;
  var bootstrapTimer = null;
  // фикс: вместо вечного латча bootstrapAcceptJsonFailed — retry с backoff 2с/4с/8с (3 ретрая),
  // по образцу scheduleActiveRetry. Первый Accept=json на свежем треде рано приходит (HTML/RSC),
  // поздний — успешен.
  var bootstrapAcceptJsonRetryTimer = null;
  var bootstrapAcceptJsonRetryCount = 0;
  var bootstrapAcceptJsonRetryDelay = 2000;
  var bootstrapAcceptJsonInFlight = false;

  function scheduleBootstrapAcceptJsonRetry() {
    if (bootstrapAcceptJsonRetryCount >= 3) {
      console.log('[perplexity-intercept] bootstrap: Accept=json не ответил JSON после 3 ретраев — сдаёмся до смены треда');
      return;
    }
    if (bootstrapAcceptJsonRetryTimer) return; // один таймер
    bootstrapAcceptJsonRetryTimer = setTimeout(function () {
      bootstrapAcceptJsonRetryTimer = null;
      bootstrapAcceptJsonRetryCount++;
      debugLog('log', '[perplexity-intercept] bootstrap: retry Accept=json #' + bootstrapAcceptJsonRetryCount + ' (delay=' + bootstrapAcceptJsonRetryDelay + 'мс)');
      bootstrapSnapshot();
    }, bootstrapAcceptJsonRetryDelay);
    bootstrapAcceptJsonRetryDelay = Math.min(bootstrapAcceptJsonRetryDelay * 2, 8000);
  }
  function clearBootstrapAcceptJsonRetry() {
    if (bootstrapAcceptJsonRetryTimer) { clearTimeout(bootstrapAcceptJsonRetryTimer); bootstrapAcceptJsonRetryTimer = null; }
    bootstrapAcceptJsonRetryCount = 0;
    bootstrapAcceptJsonRetryDelay = 2000;
    bootstrapAcceptJsonInFlight = false;
  }

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

  // ---- M-12: привязка сниффинг-снимка к странице (slug снимка vs slug страницы) ----
  // Дефект 13.09 17:24 (домашняя страница perplexity.ai — URL без slug): гейт «нет slug — не тред»
  // стоял ТОЛЬКО на bootstrap. Пассивный сниффинг (fetch/XHR) ловил снимки ЧУЖИХ тредов
  // (e2ffa178, 193399cd, bf464421…) и эмитил их в бейдж/историю — каждый перерисовывал бейдж
  // (2.7→0.8→0.4→…). Гейт сниффинга: эмитим ТОЛЬКО снимок, чей slug доказуемо совпал со slug
  // текущей страницы (/search/<id> или /thread/<id>); на странице без slug не эмитим вовсе —
  // виджет держит «—», история не пишется. bootstrap и виртуальный F5 не тронуты: их адрес
  // всегда строится от currentConvId.

  // slug из URL ответа: /search/<id>, /thread/<id>, /rest/thread/<id>, /api/thread/<id>
  function slugFromThreadUrl(urlStr) {
    try {
      if (!urlStr) return '';
      var path = String(urlStr);
      try { path = new URL(String(urlStr), location.href).pathname; } catch (eU) { path = String(urlStr); }
      var m = path.match(/\/(?:search|thread|rest\/thread|api\/thread)\/([^\/?#]+)/);
      if (!m) return '';
      var raw = m[1];
      try { raw = decodeURIComponent(raw); } catch (eD) { }
      return String(raw).trim();
    } catch (e) { return ''; }
  }

  // slug снимка: тело (thread_metadata.slug/url_slug/thread_url_slug/thread_id, затем
  // единогласный entries[*].thread_url_slug) → фолбэк на URL ответа. Пусто = slug не доказан.
  function snapshotSlug(data, url) {
    try {
      var meta = getTrim(data, 'thread_metadata');
      if (meta && typeof meta === 'object') {
        var names = ['slug', 'url_slug', 'thread_url_slug', 'thread_id'];
        for (var i = 0; i < names.length; i++) {
          var cand = getTrim(meta, names[i]);
          if (typeof cand === 'string' && cand.trim()) return cand.trim();
        }
      }
      var entries = getTrim(data, 'entries');
      if (Array.isArray(entries)) {
        var only = null;
        for (var j = 0; j < entries.length; j++) {
          var s = getTrim(entries[j], 'thread_url_slug');
          if (typeof s !== 'string' || !s.trim()) continue;
          s = s.trim();
          if (only === null) only = s;
          else if (only !== s) { only = null; break; } // разные slug'и записей — тело не улика
        }
        if (only) return only;
      }
      return slugFromThreadUrl(url);
    } catch (e) { return ''; }
  }

  // ---- M-14: полный набор query-параметров истории — адрес снимка целиком ----
  // Дефект M-14 (SPA домашняя→тред, без F5): bootstrap учил ГОЛЫЙ /rest/thread/{slug} и получал
  // урезанный снимок (textLen 5764, 1.4%); запрос страницы с полным набором параметров отдаёт
  // textLen 11164, 2.6%. Причина: гейт M-12 отбрасывает чужие снимки ДО выучивания шаблона, а
  // SPA-клик переиспользует кэш — нового сниффинга с полным адресом нет до F5. Поэтому полный
  // набор параметров — и константа адреса (REST-fallback bootstrap), и улика для шаблона.
  var FULL_HISTORY_QUERY = '?with_parent_info=true&supported_block_use_cases=true';
  var FULL_HISTORY_PARAMS = ['with_parent_info', 'supported_block_use_cases'];

  // URL несёт query-параметры полного набора (with_parent_info / supported_block_use_cases)?
  function hasFullHistoryParams(urlStr) {
    var u = String(urlStr || '');
    var q = u.indexOf('?');
    if (q === -1) return false;
    var query = u.slice(q + 1);
    for (var i = 0; i < FULL_HISTORY_PARAMS.length; i++) {
      if (query.indexOf(FULL_HISTORY_PARAMS[i]) !== -1) return true;
    }
    return false;
  }

  // M-14: выучить historyUrlTemplate из URL, отклонённого гейтом M-12 (id-сегмент → {slug}).
  // Это ТОЛЬКО адрес: данные отклонённого снимка не эмитим, состояние (snapshotReceived/
  // lastHistoryUrl, уже выученный шаблон) не трогаем. Учим лишь URL полного набора — иначе
  // шаблон закрепил бы урезанный адрес.
  function learnTemplateFromRejectedUrl(urlStr) {
    if (historyUrlTemplate) return false;
    var url = String(urlStr || '');
    if (!hasFullHistoryParams(url)) return false;
    var m = url.match(/\/(?:search|thread|rest\/thread|api\/thread)\/([^\/?#]+)/);
    if (!m) return false;
    // id-сегмент → {slug}: заменяем ровно совпавший фрагмент пути, хвост URL (query) сохраняем
    historyUrlTemplate = url.slice(0, m.index) + m[0].slice(0, m[0].length - m[1].length) + '{slug}' + url.slice(m.index + m[0].length);
    debugLog('log', '[perplexity-intercept] гейт M-12: шаблон выучен из URL отклонённого снимка: ' + historyUrlTemplate);
    return true;
  }

  function resetForNewConversation() {
    lastHistoryUrl = null;
    lastModel = '';
    dirty = false;
    refreshBusy = false;
    activeDisabled = false;
    loggedActiveStatus = false;
    snapshotReceived = false;
    clearBootstrapAcceptJsonRetry(); // фикс: retry-состояние Accept=json сбрасывается при смене треда
    clearActiveRetry(); // v31: при смене convId страховой интервал очищается
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
    } else if (bootstrapAcceptJsonRetryCount < 3 && !bootstrapAcceptJsonInFlight) {
      var url2 = new URL(location.pathname, location.href).href;
      debugLog('log', '[perplexity-intercept] bootstrap: Accept=json (попытка ' + (bootstrapAcceptJsonRetryCount + 1) + ', ' + url2 + ')');
      bootstrapAcceptJsonInFlight = true;
      originalFetch(url2, { headers: { 'Accept': 'application/json' }, credentials: 'include' })
        .then(function (resp) { if (!resp || !resp.ok) return null; return resp.text(); })
        .then(function (rawText) {
          bootstrapAcceptJsonInFlight = false;
          if (!rawText) return;
          try {
            var data = JSON.parse(rawText);
            if (hasEntriesAndMetadata(data)) {
              clearBootstrapAcceptJsonRetry(); // успех — сбрасываем backoff
              snapshotReceived = true; lastHistoryUrl = url2;
              tryBuildTemplate(url2, data);
              emitSnapshot(data, 'bootstrap');
            } else {
              // фикс: Accept=json на свежем треде стабильно отдаёт HTML/RSC-payload —
              // REST-fallback с полным набором параметров (M-14) отдаёт снимок целиком (entries+thread_metadata)
              bootstrapRestSnapshot();
            }
          } catch (e) { bootstrapRestSnapshot(); }
        }).catch(function (e) { bootstrapAcceptJsonInFlight = false; bootstrapRestSnapshot(); });
    }
  }

  // ---- bootstrap REST-fallback: адрес с тем же полным набором параметров, что и сниффинг-URL (M-14) ----
  // Раньше здесь стоял голый /rest/thread/{slug} → урезанный снимок (textLen 5764, 1.4%).
  function bootstrapRestSnapshot() {
    if (!currentConvId) return;
    var restUrl = location.origin + '/rest/thread/' + currentConvId + FULL_HISTORY_QUERY;
    debugLog('log', '[perplexity-intercept] bootstrap: REST-fallback (' + restUrl + ')');
    originalFetch(restUrl, { credentials: 'include' })
      .then(function (resp) { if (!resp || !resp.ok) return null; return resp.json(); })
      .then(function (data) {
        if (currentConvId !== getConvId()) return;
        if (!data || !hasEntriesAndMetadata(data)) { scheduleBootstrapAcceptJsonRetry(); return; }
        clearBootstrapAcceptJsonRetry(); // успех — сбрасываем backoff
        snapshotReceived = true; lastHistoryUrl = restUrl;
        tryBuildTemplate(restUrl, data);
        emitSnapshot(data, 'bootstrap-rest');
      }).catch(function (e) { scheduleBootstrapAcceptJsonRetry(); debugLog('log', '[perplexity-intercept] bootstrap: REST-fallback ошибка ' + e); });
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
    // M-12: гейт «снимок принадлежит текущей странице» — ДО любых мутаций состояния
    // (bootstrapTimer/snapshotReceived/lastHistoryUrl): пропущенный чужой снимок
    // не должен ни эмититься в бейдж/историю, ни уводить за собой виртуальный F5.
    // M-14: единственное, что берётся у отклонённого снимка, — АДРЕС полного набора (шаблон),
    // и только пока шаблон не выучен; данные снимка и состояние не трогаются.
    if (!currentConvId) {
      debugLog('log', '[perplexity-intercept] сниффинг (' + source + '): нет slug страницы — не тред, снимок не эмитим (' + url + ')');
      learnTemplateFromRejectedUrl(url); // M-14: у отклонённого снимка берём только адрес полного набора
      return;
    }
    var sniffSlug = snapshotSlug(data, url);
    if (sniffSlug !== currentConvId) {
      debugLog('log', '[perplexity-intercept] сниффинг (' + source + '): чужой снимок (slug=' +
        (sniffSlug || '(не определён)') + ' != slug страницы ' + currentConvId + ') — пропуск, URL: ' + url);
      learnTemplateFromRejectedUrl(url); // M-14: у отклонённого снимка берём только адрес полного набора
      return;
    }
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
    if (!url) {
      // фикс: не тихий выход — bootstrapSnapshot умеет получить снимок/выучить шаблон без адреса
      debugLog('log', '[perplexity-vf5] нет адреса снимка → bootstrapSnapshot (выучить шаблон)');
      if (loggedActiveStatus) loggedActiveStatus = false; // снять флаг — повторная попытка vf5 после выучивания шаблона
      bootstrapSnapshot();
      return;
    }
    if (!currentConvId) return;
    var sentConvId = currentConvId;
    refreshBusy = true;
    var sep = url.indexOf('?') === -1 ? '?' : '&';
    originalFetch(url + sep + guardToken + '=1', { method: 'GET', credentials: 'include' })
      .then(function (resp) {
        if (!loggedActiveStatus) { loggedActiveStatus = true; console.log('[perplexity-vf5] первый запрос: статус ' + (resp ? resp.status : 'none')); }
        if (!resp || !resp.ok) {
          // v31: не вечный latch — активный режим отключаем до планового retry
          activeDisabled = true;
          scheduleActiveRetry();
          debugLog('log', '[perplexity-vf5] не прошёл (статус ' + (resp ? resp.status : 'none') + ') → пассивная ловля, retry через ' + activeRetryDelay / 1000 + 'с');
          return null;
        }
        clearActiveRetry(); // v31: успех — сбрасываем backoff
        console.log('[perplexity-vf5] \u2713 работает (' + reason + ')');
        return resp.json();
      })
      .then(function (data) { if (!data || sentConvId !== currentConvId) return; emitSnapshot(data, 'виртуальный F5'); dirty = false; })
      .catch(function (err) {
        if (!loggedActiveStatus) loggedActiveStatus = true;
        // v31: не вечный latch — активный режим отключаем до планового retry
        activeDisabled = true;
        scheduleActiveRetry();
        debugLog('log', '[perplexity-vf5] ошибка: ' + err + ' → пассивная ловля, retry через ' + activeRetryDelay / 1000 + 'с');
      })
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

  // v1.13.1 (R2): guard-поллинг через aiCmCommon.setIntervalVisible — skip при
  // скрытой вкладке; фолбэк на plain setInterval, если window.aiCmCommon недоступен.
  var aiCmPoll = (typeof window !== 'undefined' && window.aiCmCommon && window.aiCmCommon.setIntervalVisible)
    ? function (f, m) { return window.aiCmCommon.setIntervalVisible(f, m); }
    : setInterval;
  aiCmPoll(function () { if (dirty && !refreshBusy) activeRefresh('таймер-страховка'); }, 15000);
  bootstrapTimer = setTimeout(function () { bootstrapSnapshot(); }, 1500);

  console.log('[perplexity-intercept] перехватчик Perplexity установлен (window.parsePerplexityThread + extractUrl + сниффинг, MAIN world, document_start)');
})();