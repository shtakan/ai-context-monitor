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

  // v31: флаг «Подробные логи» транслируется из content.js (ISOLATED) через CustomEvent
  try { window.addEventListener('ai-cm-debug-logs', function (ev) { __aiCmSetDebugLogs(!!(ev && ev.detail)); }); } catch (e) {}

  // v36: trace-логи для диагностики регрессий (видны ТОЛЬКО при флаге «Подробные логи»)
  function traceLog(msg) {
    try { if (window.__aiCmDebugLogs) console.info('[AI CM][Claude][trace] ' + msg); } catch (e) {}
  }

  var originalFetch = window.fetch;
  if (typeof originalFetch !== 'function') return;

  // ---- состояние ----
  var lastHistoryUrl = null;       // адрес последнего GET снимка чата
  var lastOrgPrefix = '';          // v49: /api/organizations/<uuid>/chat_conversations/ — для построения URL в новом чате
  var lastModel = '';              // модель из последнего ответа
  var refreshBusy = false;
  var activeDisabled = false;
  // v31: retry с backoff вместо вечного latch — при сбое vf5 планируем сброс 30s→60s→120s (кап 2 мин)
  var activeRetryTimer = null;
  var activeRetryDelay = 30000;
  var dirty = false;
  var loggedActiveStatus = false;
  var guardToken = '__aicm_claude__';

  function scheduleActiveRetry() {
    if (activeRetryTimer) return; // один страховой интервал
    var retryConvId = currentConvId; // v37: retry чужого чата после смены — не наш
    activeRetryTimer = setTimeout(function () {
      activeRetryTimer = null;
      if (currentConvId !== retryConvId) { traceLog('vf5 retry skip (чат сменился)'); return; }
      debugLog('log', '[claude-vf5] retry после сбоя (delay=' + activeRetryDelay + 'мс)');
      // v36: таймер вне promise-цепочки — бросок был бы uncaught
      try { activeRefresh('retry-backoff'); } catch (e) { console.error('[AI CM][Claude][error] vf5 retry timer: ' + e.message); }
    }, activeRetryDelay);
    activeRetryDelay = Math.min(activeRetryDelay * 2, 120000);
  }
  function clearActiveRetry() {
    if (activeRetryTimer) { clearTimeout(activeRetryTimer); activeRetryTimer = null; }
    activeRetryDelay = 30000;
  }

  // ---- bootstrap: активный снимок при загрузке (сервер рендерит HTML без fetch) ----
  var orgId = '';
  var snapshotReceived = false;
  var bootstrapTimer = null;
  // v37: последний ВАЛИДНЫЙ снимок (msgs>0) текущего чата — гард от обнуления
  // бейджа пустыми повторными GET (msgs=0, model='-')
  var validEmitConvId = '';
  var validEmitCount = 0;

  // ---- токены вложений (оценка) ----
  var IMAGE_DEFAULT_TOKENS = 516;   // как в Gemini
  var DOC_EST_TOKENS = 2500;
  var attachSeen = {};
  var attachTokens = 0;
  var attachBreak = { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 };
  var loggedAttach = false;
  // Вложения из msg.files (PASTED-тексты, картинки): кэш текста файла по file_uuid,
  // чтобы повторные эмиты не ре-фетчили. null = файл не текстовый (заглушка).
  var fileTextCache = {};
  var fileFetchInFlight = {};
  // v51 (M1): LRU-лимит на fileTextCache — не даём кэшу текстов вложений расти бесконечно
  var fileTextCacheMax = 50;
  var fileTextCacheOrder = [];
  function fileTextCacheInsert(uuid, val) {
    try {
      var idx = fileTextCacheOrder.indexOf(uuid);
      if (idx !== -1) fileTextCacheOrder.splice(idx, 1);
      fileTextCache[uuid] = val;
      fileTextCacheOrder.push(uuid);
      while (fileTextCacheOrder.length > fileTextCacheMax) {
        var oldest = fileTextCacheOrder.shift();
        delete fileTextCache[oldest];
      }
    } catch (e) { }
  }
  var lastHistoryRaw = null; // сырые данные последней истории для пере-эмита после догрузки файлов
  var lastHistoryRawConvId = ''; // v48: чат, которому принадлежит lastHistoryRaw (stale-защита)
  var postSendTimer = null; // v48: страховочный refetch истории после отправки completion
  // H23: РЕТЕЙН последнего ЭМИТА — готовый detail (не raw) + его convId. Нужен для ре-эмита
  // по handshake 'ai-cm-content-ready'/'ai-cm-request-emit', когда снимок ушёл раньше, чем
  // content.js (ISOLATED, document_idle) успел зарегистрировать слушатель ai-cm-full-history.
  // Храним готовый detail: повторный parseHistoryWithEffects имел бы сайд-эффекты
  // (attachTokens/collectAttachments/кэш вложений) и мог бы изменить пейлоад, а ре-эмит
  // обязан быть БАЙТОВО тем же снимком (идемпотентность без перепарса).
  var lastEmitDetail = null;
  var lastEmitDetailConvId = '';

  // v34: внутренние fetch (по path вложений) не должны проходить через наш wrapper как события страницы
  var internalFetchUrls = {};
  function markInternalUrl(u) {
    internalFetchUrls[u] = true;
    setTimeout(function () { try { delete internalFetchUrls[u]; } catch (e) {} }, 60000);
  }
  // v34-C: скан тел запросов на предмет pasted-текста
  var PASTED_TEXT_FIELDS = ['extracted_text', 'preview_text', 'text_content', 'content_text', 'pasted_text', 'paste', 'text', 'content', 'body', 'value', 'contents'];
  function findPastedInValue(val, depth, found) {
    if (!val || typeof val !== 'object' || depth > 6) return;
    if (Array.isArray(val)) {
      for (var ai = 0; ai < val.length; ai++) findPastedInValue(val[ai], depth + 1, found);
      return;
    }
    var id = '';
    try { id = (typeof val.file_uuid === 'string' && val.file_uuid) || (typeof val.uuid === 'string' && val.uuid) || ''; } catch (e) {}
    if (id) {
      // п.10: лог ключей объектов с file_uuid/uuid И file_kind (только ключи, без текста)
      if (val.file_kind) {
        try {
          debugLog('log', '[AI CM][Claude][pasted] req-keys keys=' + Object.keys(val).join('|'));
        } catch (e) {}
      }
      for (var fi = 0; fi < PASTED_TEXT_FIELDS.length; fi++) {
        var fv = null;
        try { fv = val[PASTED_TEXT_FIELDS[fi]]; } catch (e) {}
        if (typeof fv === 'string' && fv.trim()) { found.push({ uuid: id, key: PASTED_TEXT_FIELDS[fi], text: fv }); break; }
      }
    }
    try {
      var ks = Object.keys(val);
      for (var ki = 0; ki < ks.length; ki++) {
        var child = null;
        try { child = val[ks[ki]]; } catch (e) {}
        if (child && typeof child === 'object') findPastedInValue(child, depth + 1, found);
      }
    } catch (e) {}
  }
  function applyFoundPasted(found) {
    if (!found || !found.length) return false;
    var applied = false;
    for (var i = 0; i < found.length; i++) {
      var it = found[i];
      var cur = Object.prototype.hasOwnProperty.call(fileTextCache, it.uuid) ? fileTextCache[it.uuid] : undefined;
      if (typeof cur === 'string') continue; // уже есть строка
      var t = it.text;
      var realLen = t.length;
      if (realLen > 500000) { t = t.slice(0, 500000) + '\n[обрезано]'; }
      fileTextCacheInsert(it.uuid, t);
      fetchAttempted[it.uuid] = true; // текст из тела — fetch по path уже не нужен
      debugLog('log', '[AI CM][Claude][pasted] req-body uuid=' + String(it.uuid).slice(0, 8) +
        ' textLen=' + realLen + ' keys=' + it.key);
      applied = true;
    }
    return applied;
  }
  // v41: структура тела чат-POST — ТОЛЬКО ключи и типы, глубина 2 (корень + дети).
  // Значения не логируются; списки ≤20 ключей, каждый ≤40 символов; всё в try/catch.
  function clipKeyList(obj) {
    var out = '';
    try {
      var ks = Object.keys(obj || {}).slice(0, 20);
      for (var i = 0; i < ks.length; i++) ks[i] = String(ks[i]).slice(0, 40);
      out = ks.join('|');
    } catch (eK) { out = '(err)'; }
    return out;
  }
  function traceBodyStruct(url, rawText) {
    try {
      var data = JSON.parse(rawText);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      traceLog('body-struct url=' + String(url).slice(0, 80) + ' keys=' + clipKeyList(data));
      var ks = Object.keys(data).slice(0, 20);
      for (var i = 0; i < ks.length; i++) {
        var k = String(ks[i]);
        var v = null;
        try { v = data[k]; } catch (eG) { continue; }
        if (!v || typeof v !== 'object') continue; // логируем только object|array на глубине 1
        var isArr = Array.isArray(v);
        var line = 'body-struct.' + k.slice(0, 40) + ' kind=' + (isArr ? 'array' : 'object');
        if (isArr) {
          line += ' len=' + Math.min(v.length, 999);
          if (v.length > 0 && v[0] && typeof v[0] === 'object' && !Array.isArray(v[0])) {
            line += ' itemKeys=' + clipKeyList(v[0]);
          }
        } else {
          line += ' subkeys=' + clipKeyList(v);
        }
        traceLog(line);
      }
    } catch (e) { /* молча: диагностика не должна влиять на запрос */ }
  }
  // v45-A1: в Chrome stable DecompressionStream поддерживает только gzip/deflate/deflate-raw
  var DECOMP_FORMATS = ['gzip', 'deflate', 'deflate-raw'];
  function decompressProbe(url, u8) {
    // v44-A1: след старта probe — всегда
    var dLen = -1;
    try { dLen = (u8 && typeof u8.byteLength === 'number') ? u8.byteLength : ((u8 && u8.length) || -1); } catch (eLen) {}
    var ctorS = '';
    try { ctorS = Object.prototype.toString.call(u8).replace(/^\[object /, '').replace(/\]$/, '').slice(0, 40); } catch (eCt) {}
    traceLog('decomp-start url=' + String(url).slice(0, 160) + ' len=' + dLen + ' ctor=' + ctorS);
    try {
      // v45-A3: тело меньше 64 байт (или слишком большое) — all-failed без попыток
      if (!u8 || u8.length < 64 || u8.length > 2 * 1024 * 1024) {
        traceLog('body-decomp all-failed len=' + dLen);
        return;
      }
      var tryNext = function (idx) {
        try {
          if (idx >= DECOMP_FORMATS.length) {
            traceLog('body-decomp all-failed len=' + u8.length);
            return;
          }
          var fmt = DECOMP_FORMATS[idx];
          var ds = null;
          try { ds = new DecompressionStream(fmt); } catch (eC) { setTimeout(function () { tryNext(idx + 1); }, 0); return; }
          var copy = u8.slice(); // работаем только с копией
          var srcStream = null;
          try { srcStream = new Response(copy).body.pipeThrough(ds); } catch (eS) { setTimeout(function () { tryNext(idx + 1); }, 0); return; }
          new Response(srcStream).text()
            .then(function (text) {
              try {
                var prev = '';
                try { prev = (String(text).match(/[\x20-\x7E\u00A0-\uD7FF\uE000-\uFFFD]{4,}/g) || []).join('|').slice(0, 150); } catch (eP) {}
                if (prev) {
                  traceLog('body-decomp url=' + String(url).slice(0, 160) +
                    ' format=' + fmt + ' ok=1 outLen=' + text.length + ' preview=' + prev);
                  traceDecompStruct(text); // v51: где Claude хранит pasted-контент
                  // v52-3: attachments с extracted_content → в кэш (источник для hist-attach)
                  try {
                    var dj = JSON.parse(text);
                    var dAtts = (dj && Array.isArray(dj.attachments)) ? dj.attachments : [];
                    for (var di = 0; di < dAtts.length; di++) {
                      var da = dAtts[di];
                      if (!da || typeof da.extracted_content !== 'string' || !da.extracted_content.trim()) continue;
                      var dName = String(da.file_name || 'pasted').slice(0, 40);
                      var dSize = Number(da.file_size || 0) || 0;
                      var dText = da.extracted_content.slice(0, 500000);
                      reqAttachCache[dName + '|' + dSize] = dText;
                      var rk = Object.keys(reqAttachCache);
                      while (rk.length > 5) { delete reqAttachCache[rk[0]]; rk.shift(); }
                      debugLog('log', '[AI CM][Claude][pasted] req-attach name=' + dName +
                        ' size=' + dSize + ' textLen=' + dText.length);
                    }
                  } catch (eDA) {}
                } else {
                  setTimeout(function () { tryNext(idx + 1); }, 0);
                }
              } catch (eO) { setTimeout(function () { tryNext(idx + 1); }, 0); }
            })
            .catch(function () { setTimeout(function () { tryNext(idx + 1); }, 0); });
        } catch (eT) { setTimeout(function () { tryNext(idx + 1); }, 0); }
      };
      tryNext(0);
    } catch (e) {
      // v44-A1: ошибка до/вне цепочки форматов — печатаем, не молчим
      traceLog('decomp-error msg=' + ((e && e.message) || String(e)));
    }
  }

  // v51: структура декомпрессированного completion-тела (глубина 1, только ключи/типы)
  function traceDecompStruct(text) {
    try {
      var data = JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      traceLog('decomp-struct keys=' + clipKeyList(data));
      var ks = Object.keys(data).slice(0, 20);
      for (var i = 0; i < ks.length; i++) {
        var k = String(ks[i]);
        var v = null;
        try { v = data[k]; } catch (eG) { continue; }
        if (!v || typeof v !== 'object') continue;
        var isArr = Array.isArray(v);
        var line = 'decomp-struct.' + k.slice(0, 40) + ' kind=' + (isArr ? 'array' : 'object');
        if (isArr) {
          line += ' len=' + Math.min(v.length, 999);
          if (v.length > 0 && v[0] && typeof v[0] === 'object' && !Array.isArray(v[0])) {
            line += ' itemKeys=' + clipKeyList(v[0]);
          }
        } else {
          line += ' subkeys=' + clipKeyList(v);
        }
        traceLog(line);
      }
    } catch (e) { /* диагностика — молча */ }
  }

  function processPostBody(url, rawText) {
    var jsonOk = 0;
    try {
      if (!rawText || typeof rawText !== 'string') return 0;
      if (rawText.length > 5 * 1024 * 1024) return 0; // п.11: только тела < 5 МБ
      var roots = [];
      var parsed = null;
      try { parsed = JSON.parse(rawText); } catch (e) { parsed = null; }
      if (parsed) {
        roots.push(parsed);
      } else {
        // form-поля: k=v&..., значения пробуем распарсить как JSON
        var pairs = rawText.split('&');
        for (var pi = 0; pi < pairs.length && pi < 200; pi++) {
          var eq = pairs[pi].indexOf('=');
          if (eq === -1) continue;
          var v = pairs[pi].substring(eq + 1);
          try {
            v = decodeURIComponent(v.replace(/\+/g, ' '));
          } catch (e2) {}
          if (v.charAt(0) === '{' || v.charAt(0) === '[') {
            try { roots.push(JSON.parse(v)); } catch (e3) {}
          }
        }
      }
      jsonOk = roots.length > 0 ? 1 : 0;
      var found = [];
      for (var ri = 0; ri < roots.length; ri++) findPastedInValue(roots[ri], 1, found);
      if (applyFoundPasted(found)) scheduleReEmit('req-body');
    } catch (e) {}
    return jsonOk;
  }
  // v39: скан тел ТОЛЬКО безопасных типов — строка / FormData / URLSearchParams.
  // ReadableStream и Request-тела НЕ читаем и НЕ клонируем: чтение клона Request
  // ломало запрос сайта (retry «This response didn't load»). Оригинал не изменяем никогда.
  function capturePostBody(input, init) {
    try {
      var url = '', method = 'GET', body = null;
      var hasInitBody = !!(init && init.body != null);
      if (typeof input === 'string') {
        url = input;
        method = (init && init.method) || 'GET';
        body = init ? init.body : null;
      } else if (input && typeof input === 'object') {
        url = input.url || '';
        method = (init && init.method) || input.method || 'GET';
        body = hasInitBody ? init.body : null; // тело самого Request НЕ трогаем
      }
      method = String(method).toUpperCase();
      var isApiScan = !!url && url.indexOf('/api/') !== -1 && url.indexOf(guardToken) === -1 &&
        !internalFetchUrls[url] && !NOISE_URL_RE.test(url) && (method === 'POST' || method === 'PUT');
      if (!isApiScan) return;

      // v44-A2/v46-4: probe ГАРАНТИРОВАН для бинарных тел на /completion;
      // каждый пропуск — с причиной probe-skip.
      // v48: после отправки completion-POST стрим ответа не читается (v40), поэтому
      // «после стрима» не наступает → страховочный принудительный GET истории через 2с.
      // Гард по АКТУАЛЬНОМУ URL-convId (не stale currentConvId): v33.4 не блокирует.
      if (/\/completion/.test(String(url)) && method === 'POST') {
        var sendConvId = '';
        try {
          var mSend = String(url).match(/\/chat_conversations\/([0-9a-fA-F-]{8,})/);
          if (mSend) sendConvId = mSend[1];
        } catch (eM3) {}
        traceLog('post-send state convIdUrl=' + String(sendConvId || '-').slice(0, 8) +
          ' lastHistoryConvId=' + String(currentConvId || '-').slice(0, 8));
        if (sendConvId && !postSendTimer) {
          var urlConvAtSched = sendConvId;
          postSendTimer = setTimeout(function () {
            postSendTimer = null;
            try {
              var curNow = getConvId();
              if (!curNow || curNow !== urlConvAtSched) {
                traceLog('post-send refresh=skipped(reason=convId-changed)');
                return;
              }
              if (refreshBusy || !lastHistoryUrl) {
                traceLog('post-send refresh=skipped(reason=' + (refreshBusy ? 'busy' : 'no-url') + ')');
                return;
              }
              traceLog('post-send refresh=triggered');
              activeRefresh('после отправки');
            } catch (eR) { console.error('[AI CM][Claude][error] post-send refresh: ' + eR.message); }
          }, 2000);
        }
      }

      if (/\/completion/.test(String(url))) {
        var probeU8 = asUint8View(body);
        if (probeU8) {
          decompressProbe(url, probeU8);
        } else {
          traceLog('probe-skip url=' + String(url).slice(0, 160) +
            ' reason=' + ((method !== 'POST' && method !== 'PUT') ? 'not-post' : (body == null ? 'no-body' : 'not-binary')));
        }
      } else if (method === 'POST' || method === 'PUT') {
        traceLog('probe-skip url=' + String(url).slice(0, 160) + ' reason=not-completion');
      }

      // классификация тела (ничего не читаем из потоков)
      var inputIsRequest = (typeof Request !== 'undefined' && input instanceof Request) ? 1 : 0;
      var kind = 'other', len = -1, scanText = null;
      if (typeof body === 'string') {
        kind = 'string'; len = body.length;
        scanText = (len <= 5 * 1024 * 1024) ? body : null;
      } else if (body && typeof FormData !== 'undefined' && body instanceof FormData) {
        kind = 'formdata';
      } else if (body && typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
        kind = 'urlsp';
        try { scanText = body.toString(); len = scanText.length; } catch (eU) {}
      } else if (body && typeof body.getReader === 'function') {
        kind = 'stream';
      } else if (!hasInitBody && inputIsRequest) {
        kind = 'stream'; // Request-тело: skip, не клонируем
      }

      if (kind === 'stream') {
        traceLog('body-scan ' + method + ' ' + String(url).slice(0, 100) +
          ' bodyKind=stream skip len=- jsonOk=0 inputIsRequest=' + inputIsRequest);
        return;
      }
      var jsonOk = 0;
      if (kind === 'formdata') {
        var parts = [];
        try { body.forEach(function (v, k) { if (typeof v === 'string') parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v)); }); } catch (eF) {}
        jsonOk = processPostBody(url, parts.join('&'));
      } else if (scanText != null) {
        jsonOk = processPostBody(url, scanText);
        if (kind === 'string' && jsonOk === 1) traceBodyStruct(url, scanText); // v41: структура чат-POST
      }
      // v43: заголовки запроса (content-type / content-encoding, ≤60 символов)
      try {
        var hCt = '-', hCe = '-';
        var hdrs = null;
        if (init && init.headers) hdrs = init.headers;
        else if (inputIsRequest && input && input.headers) hdrs = input.headers;
        if (hdrs) {
          if (typeof Headers !== 'undefined' && hdrs instanceof Headers) {
            hCt = String(hdrs.get('content-type') || '-');
            hCe = String(hdrs.get('content-encoding') || '-');
          } else {
            try {
              hdrs.forEach(function (hv, hk) {
                var hkl = String(hk).toLowerCase();
                if (hkl === 'content-type') hCt = String(hv);
                else if (hkl === 'content-encoding') hCe = String(hv);
              });
            } catch (eF2) {}
          }
        }
        traceLog('req-headers url=' + String(url).slice(0, 160) +
          ' ct=' + hCt.slice(0, 60) + ' ce=' + hCe.slice(0, 60));
      } catch (eH) {}
      var diag = '';
      if (kind === 'other') {
        var ctorName = '';
        try { ctorName = Object.prototype.toString.call(body).replace(/^\[object /, '').replace(/\]$/, '').slice(0, 40); } catch (eC) {}
        diag = ' bodyCtor=' + (ctorName || '?') + ' inputIsRequest=' + inputIsRequest;
        // v42: решающая диагностика бинарных тел
        var prev = binaryPreview(body);
        if (prev) {
          traceLog('body-preview url=' + String(url).slice(0, 160) +
            ' len=' + binaryPreviewLen(body) + ' preview=' + prev);
        }
      }
      traceLog('body-scan ' + method + ' ' + String(url).slice(0, 160) +
        ' bodyKind=' + kind + ' len=' + len + ' jsonOk=' + jsonOk + diag);
    } catch (e) {}
  }

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

  // v54: жёсткая привязка снимка к convId — convId читаем ИЗ ТЕЛА ответа (data.uuid),
  // а не из текущего URL: за время полёта fetch мог случиться SPA-переход, и тогда
  // чужой снимок помечался бы текущим convId и протекал в бейдж/экспорт.
  function snapshotConvIdOf(data) {
    try { return String((data && data.uuid) || ''); } catch (e) { return ''; }
  }
  // Возвращает true, если тело ответа принадлежит ДРУГОМУ чату (игнорируем целиком).
  function isStaleSnapshotBody(data, where) {
    var dConv = snapshotConvIdOf(data);
    if (!dConv || dConv === currentConvId) return false;
    traceLog('tape-restore convId=' + currentConvId + ' cacheConvId=' + dConv + ' action=ignored (' + where + ')');
    return true;
  }

  function resetForNewConversation() {
    try {
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
    fileTextCache = {};
    fileTextCacheOrder = []; // v51: сброс LRU-порядка вместе с кэшем
    fileFetchInFlight = {};
    // v34: fetchAttempted НЕ сбрасываем — uuid глобально уникален
    lastHistoryRaw = null;
    lastHistoryRawConvId = ''; // v48: raw-снимок старого чата недействителен
    snapshotReceived = false;
    validEmitConvId = ''; // v37: валидный снимок старого чата недействителен
    validEmitCount = 0;
    lastEmitDetail = null; // H23: ретейн старого чата не ре-эмитится в новый чат
    lastEmitDetailConvId = '';
    clearActiveRetry(); // v31: при смене convId страховой интервал очищается
    if (bootstrapTimer) { clearTimeout(bootstrapTimer); bootstrapTimer = null; }
    debugLog('log', '[claude-intercept] смена чата → состояние сброшено (convId=' + (currentConvId || '(не чат)') + ')');
    try { window.dispatchEvent(new CustomEvent('ai-cm-conversation-changed')); } catch (e) {}
    // v36: колбэк таймера обёрнут — бросок был бы uncaught
    bootstrapTimer = setTimeout(function () {
      try { bootstrapSnapshot(); } catch (bsErr) { console.error('[AI CM][Claude][error] bootstrap timer (SPA): ' + bsErr.message); }
    }, 1500);
    } catch (e) {
      console.error('[AI CM][Claude][error] reset: ' + e.message);
    }
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
          try {
          if (!data) return;
          // v54: чужой чат в теле ответа — игнор целиком (SPA-гонка bootstrap)
          if (isStaleSnapshotBody(data, 'bootstrap')) return;
          snapshotReceived = true;
          lastHistoryUrl = url;
          emitSnapshot(parseHistoryWithEffects(data), 'bootstrap');
          } catch (e) { console.error('[AI CM][Claude][error] bootstrap parse: ' + e.message); }
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
  // v53: seenLocal — локальный dedup на каждый парс (идемпотентность)
  function collectAttachments(messages, seenLocal) {
    try {
    if (!Array.isArray(messages)) return;
    if (!seenLocal || typeof seenLocal !== 'object') seenLocal = {};
    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      var blocks = msg && msg.content;
      if (!Array.isArray(blocks)) continue;
      for (var j = 0; j < blocks.length; j++) {
        var b = blocks[j];
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'image' || b.type === 'image_url') {
          var imgKey = 'img_' + (msg.uuid || i) + '_' + j;
          if (!seenLocal[imgKey]) {
            seenLocal[imgKey] = 1;
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
    } catch (eCA) { console.error('[AI CM][Claude][error] collectAttachments: ' + eCA.message); }
  }

  // Оценка токенов картинки из files: ceil(w*h/750), фолбэк 1500 без размеров.
  function estimateImageTokensFromFile(f) {
    try {
      var pa = f.preview_asset || f.previewAsset || {};
      var w = pa.image_width || pa.width;
      var h = pa.image_height || pa.height;
      if (w && h) return Math.ceil((w * h) / 750);
    } catch (e) { }
    return 1500;
  }

  // v33: нормализация pasted-текстовых вложений Claude — у PASTED-файлов может не быть
  // preview_url, но текст лежит в одном из строковых полей самого объекта файла.
  function extractPastedText(f) {
    var fields = ['extracted_text', 'preview_text', 'text_content', 'content_text', 'text', 'content', 'body', 'value'];
    for (var i = 0; i < fields.length; i++) {
      try {
        var v = f[fields[i]];
        if (typeof v === 'string' && v.trim()) return v;
      } catch (e) {}
    }
    return '';
  }
  function logPastedDebug(f, uuid, textLen, phase) {
    var keys = '';
    try { keys = Object.keys(f).join('|'); } catch (e) { keys = '(err)'; }
    var hasPreviewUrl = !!(f && f.preview_url);
    debugLog('log', '[AI CM][Claude][pasted] ' + (phase || '') +
      ' uuid=' + String(uuid).slice(0, 8) +
      ' kind=' + (f && f.file_kind) +
      ' type=' + typeof (f && f.text) +
      ' textLen=' + textLen +
      ' hasPreviewUrl=' + hasPreviewUrl +
      ' keys=' + keys);
  }

  // Асинхронная догрузка текста файла (не-картинки). По завершении — пере-эмит снимка.
  var fetchAttempted = {}; // v33.2: защита от повторных fetch по uuid

  // v44-B4: очередь pasted-текстов из content.js (paste-capture через postMessage), ≤5, FIFO
  var pasteQueue = [];
  // v47: очередь pasted-текстов — элементы живут ДО совпадения (TTL 10 мин),
  // cap 5 с вытеснением старшего; miss очередь НЕ дренирует; успех — удаляет элемент.
  function fileSizeOf(f) {
    try { return Number(f.file_size || f.size_bytes || f.size || 0) || 0; } catch (eS) { return 0; }
  }
  function fileKindOf(f) {
    try { return String(f.file_kind || f.kind || ''); } catch (eK) { return ''; }
  }
  var PASTE_TTL_MS = 10 * 60 * 1000;
  var pasteQueue = []; // элементы { text, ts }
  // v52-3: кэш extracted_content из декомпрессированного completion-запроса
  // (ключ file_name|file_size; cap 5 с вытеснением старшего; текст ≤500000 символов)
  var reqAttachCache = {};
  function pasteQueuePrune() {
    try {
      var now = Date.now();
      while (pasteQueue.length && now - pasteQueue[0].ts > PASTE_TTL_MS) pasteQueue.shift();
    } catch (eP) {}
  }
  function utf8ByteLen(s) {
    try { return new TextEncoder().encode(s).length; } catch (eE) { return -1; }
  }
  function takePastedFromQueue(uuid, sizeBytes) {
    try {
      pasteQueuePrune();
      for (var i = 0; i < pasteQueue.length; i++) {
        var it = pasteQueue[i];
        // v47-4: матч по UTF-8 byte length ИЛИ UTF-16 length
        var bl = utf8ByteLen(it.text);
        if (sizeBytes > 0 && bl === sizeBytes) {
          pasteQueue.splice(i, 1); // v47-3: успешный матч убирает элемент
          debugLog('log', '[AI CM][Claude][pasted] paste-match uuid=' + String(uuid).slice(0, 8) +
            ' by=size-utf8 textLen=' + it.text.length);
          return it.text;
        }
        if (sizeBytes > 0 && it.text.length === sizeBytes) {
          pasteQueue.splice(i, 1);
          debugLog('log', '[AI CM][Claude][pasted] paste-match uuid=' + String(uuid).slice(0, 8) +
            ' by=size-utf16 textLen=' + it.text.length);
          return it.text;
        }
      }
      debugLog('log', '[AI CM][Claude][pasted] paste-match uuid=' + String(uuid).slice(0, 8) +
        ' miss (reason=' + (pasteQueue.length ? 'size-mismatch' : 'empty-queue') + ')');
    } catch (eQ) {}
    return '';
  }
  // v47-1: listener регистрируется СТРОГО один раз (дубли paste-recv = двойная регистрация)
  if (!window.__aiCmPasteMsgListenerInstalled) {
    window.__aiCmPasteMsgListenerInstalled = true;
    try {
      window.addEventListener('message', function (ev) {
        try {
          var d = ev && ev.data;
          if (!d || d.source !== 'ai-cm-paste' || typeof d.text !== 'string' || !d.text) return;
          pasteQueue.push({ text: d.text, ts: Date.now() });
          while (pasteQueue.length > 5) pasteQueue.shift(); // cap 5, вытеснение старшего
          // v46-2/v47-1: диагностика канала ISOLATED→MAIN (без дублей)
          debugLog('log', '[AI CM][Claude][pasted] paste-recv len=' + d.text.length + ' queueSize=' + pasteQueue.length);
        } catch (e2) {}
      });
    } catch (eM) {}
  }
  function scheduleFileTextFetch(f, fileName) {
    var uuid = f.file_uuid || '';
    if (!uuid) return;
    // v47-5: dedup ТОЛЬКО по строке в кэше (null от html-reject не блокирует новые попытки)
    if (typeof fileTextCache[uuid] === 'string') {
      debugLog('log', '[AI CM][Claude][pasted] paste-match skip uuid=' + String(uuid).slice(0, 8) + ' already-cached');
      return;
    }
    if (fileFetchInFlight[uuid]) return;
    // v33: сначала пробуем извлечь текст прямо из объекта файла (pasted-вложение)
    var inline = extractPastedText(f);
    if (inline) {
      fileTextCacheInsert(uuid, inline);
      logPastedDebug(f, uuid, inline.length, 'inline');
      scheduleReEmit(fileName);
      return;
    }
    // v44-B5/v45-B4: клиентский источник — paste-очередь (inline → очередь → fetch по path).
    // ДО гейта fetchAttempted: вставка могла случиться уже после первого эмита с заглушкой.
    var pasteSize = fileSizeOf(f);
    var pasteKind = fileKindOf(f);
    try {
      // v47-6: диагностика перед сопоставлением — utf8/utf16 длины очереди, ≤5 элементов
      pasteQueuePrune();
      var qU8 = [], qU16 = [], qLens = [];
      for (var qi = 0; qi < pasteQueue.length && qi < 5; qi++) {
        qU8.push(utf8ByteLen(pasteQueue[qi].text));
        qU16.push(pasteQueue[qi].text.length);
        qLens.push(pasteQueue[qi].text.length);
      }
      debugLog('log', '[AI CM][Claude][pasted] paste-check uuid=' + String(uuid).slice(0, 8) +
        ' size_bytes=' + pasteSize +
        ' utf8=[' + qU8.join(',') + ']' +
        ' utf16=[' + qU16.join(',') + ']' +
        ' queue=[' + qLens.join(',') + ']' +
        ' file_kind=' + pasteKind);
    } catch (ePC) {}
    var ptext = takePastedFromQueue(uuid, pasteSize);
    if (ptext) {
      fileTextCacheInsert(uuid, ptext);
      scheduleReEmit(fileName);
      return;
    }
    if (fetchAttempted[uuid]) { logPastedDebug(f, uuid, 0, 'already-attempted'); return; }
    fetchAttempted[uuid] = true;
    // v33.2: источник URL = preview_url || path (path может быть относительным)
    var rawPath = f.preview_url || f.path || '';
    var url = '';
    if (rawPath) {
      if (rawPath.indexOf('http') === 0) url = rawPath;
      else {
        try {
          url = location.origin + (rawPath.charAt(0) === '/' ? rawPath : '/' + rawPath);
        } catch (e) { url = rawPath; }
      }
    }
    if (!url) { fileTextCacheInsert(uuid, null); logPastedDebug(f, uuid, 0, 'no-preview-url'); return; }
    fileFetchInFlight[uuid] = true;
    markInternalUrl(url); // v34: внутренний fetch не должен проходить через wrapper как событие страницы
    originalFetch(url, { credentials: 'include' })
      .then(function (r) {
        fileFetchInFlight[uuid] = false;
        if (!r || !r.ok) { fileTextCacheInsert(uuid, null); logPastedDebug(f, uuid, 0, 'http-' + (r ? r.status : 'none')); return; }
        var ct = '';
        try { ct = (r.headers && r.headers.get('content-type')) || ''; } catch (e) { }
        return r.clone().text().then(function (body) {
          var ctLower = String(ct).toLowerCase();
          var trimmed = String(body || '').trim();
          // v34: SPA index.html по path — мусор; reject по content-type ИЛИ по содержимому
          var looksHtml = ctLower.indexOf('html') !== -1 ||
            ((trimmed.charAt(0) === '<') && (trimmed.indexOf('<html') !== -1 || trimmed.indexOf('<!doctype') !== -1 || trimmed.indexOf('<script') !== -1));
          if (looksHtml) {
            fileTextCacheInsert(uuid, null);
            debugLog('log', '[AI CM][Claude][pasted] html-rejected uuid=' + String(uuid).slice(0, 8) +
              ' len=' + (body || '').length);
            return;
          }
          var isTextCt = ctLower.indexOf('text') !== -1 || ctLower.indexOf('json') !== -1;
          if (!isTextCt && body.indexOf('\u0000') !== -1) {
            fileTextCacheInsert(uuid, null);
            logPastedDebug(f, uuid, 0, 'binary-rejected ct=' + String(ct).slice(0, 40));
            return;
          }
          var realLen = (body || '').length;
          if (realLen > 500000) {
            body = body.slice(0, 500000) + '\n[обрезано]';
            debugLog('log', '[AI CM][Claude][pasted] fetch truncated uuid=' + String(uuid).slice(0, 8) + ' realLen=' + realLen);
          }
          fileTextCacheInsert(uuid, body || '');
          debugLog('log', '[AI CM][Claude][pasted] fetch uuid=' + String(uuid).slice(0, 8) +
            ' status=' + r.status + ' ct=' + String(ct).slice(0, 40) +
            ' len=' + realLen +
            ' url=' + String(url).slice(0, 120));
          scheduleReEmit(fileName);
        });
      })
      .catch(function () {
        fileFetchInFlight[uuid] = false;
        logPastedDebug(f, uuid, 0, 'fetch-error');
      });
  }

  // v33: пере-эмит базового снимка после появления текста вложения
  function reEmitWithFileText(fileName) {
    debugLog('log', '[claude-intercept] файл догружен: ' + fileName);
    if (lastHistoryRaw) {
      // v48 stale-защита: сырые данные чужого/старого чата не пере-эмитятся
      if (lastHistoryRawConvId !== currentConvId) {
        debugLog('log', '[claude-intercept] reEmit пропущен — снимок чужого чата (raw=' +
          String(lastHistoryRawConvId).slice(0, 8) + ', текущий=' + String(currentConvId).slice(0, 8) + ')');
        return;
      }
      try {
        emitSnapshot(parseHistoryWithEffects(lastHistoryRaw), 'вложения догружены');
      } catch (e) { console.error('[AI CM][Claude][error] re-emit вложений: ' + e.message); }
    }
  }

  // v53-3: пере-эмиты из applyMessageFiles/scheduleFileTextFetch — ОТЛОЖЕННЫЕ и
  // одноразовые (один ожидающий): синхронный reEmit внутри парса порождал каскад
  // вложенных парсов того же lastHistoryRaw → блок [Файл …] умножался ×N.
  var reEmitPending = false;
  function scheduleReEmit(fileName) {
    try {
      if (reEmitPending) return;
      reEmitPending = true;
      setTimeout(function () {
        reEmitPending = false;
        try { reEmitWithFileText(fileName); } catch (eSR) { console.error('[AI CM][Claude][error] scheduleReEmit: ' + eSR.message); }
      }, 50);
    } catch (eS) {}
  }

  // Встраивает вложения из msg.files/attachments в разобранные сообщения (мутирует parsed).
  // Индексация через uuidIdx из parseHistory (system-сообщения пропущены там же).
  // v53: seenLocal — СТРОГО локальный dedup на каждый парс; возвращает
  // { extrasBlocks, histAttachCount } для parse-summary.
  function applyMessageFiles(parsed, messages, seenLocal) {
    var stats = { extrasBlocks: 0, histAttachCount: 0 };
    try {
    if (!Array.isArray(messages) || !parsed || !parsed.uuidIdx) return stats;
    if (!seenLocal || typeof seenLocal !== 'object') seenLocal = {};
    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      var files = (msg && Array.isArray(msg.files)) ? msg.files : [];
      // v52: attachments[] (pasted-чипы) — наравне с files
      // v54-2: attachments читаем ТОЛЬКО у узлов sender=human/user; у assistant-узлов
      // attachments игнорируем (эхо вложения). Если sender не определён — полагаемся
      // на дедуп по ключу идентичности вложения (v54-1).
      var nodeSender = '';
      try { nodeSender = String((msg && msg.sender) || '').toLowerCase(); } catch (eNS) { nodeSender = ''; }
      var attsAllowed = (nodeSender !== 'assistant');
      var atts = (msg && attsAllowed && Array.isArray(msg.attachments)) ? msg.attachments : [];
      if (!files.length && !atts.length) continue;
      var k = parsed.uuidIdx[String(msg.uuid)];
      if (k == null || !parsed.messages[k]) continue;
      var extras = [];
      for (var fi = 0; fi < files.length; fi++) {
        var f = files[fi];
        if (!f || typeof f !== 'object') continue;
        var fname = f.file_name || 'файл';
        var fkey = 'file_' + (f.file_uuid || (msg.uuid || i) + '_' + fi);
        if (f.file_kind === 'image') {
          extras.push('[Вложение: ' + fname + ']');
          if (!seenLocal[fkey]) {
            seenLocal[fkey] = 1;
            var it = estimateImageTokensFromFile(f);
            attachTokens += it;
            attachBreak.imgTokens += it;
            attachBreak.imgCount++;
          }
        } else {
          var uuid = f.file_uuid || '';
          var cached = (uuid && Object.prototype.hasOwnProperty.call(fileTextCache, uuid)) ? fileTextCache[uuid] : undefined;
          // v33: pasted-вложение без preview_url и без file_uuid — текст может лежать в самом объекте
          var inline = (typeof cached !== 'string') ? extractPastedText(f) : '';
          if (typeof cached === 'string' && cached) {
            // v46-3: dedup — текст для этого uuid уже в кэше
            debugLog('log', '[AI CM][Claude][pasted] paste-match skip uuid=' + String(uuid || '').slice(0, 8) + ' already-cached');
            extras.push('[File ' + fname + ']:\n' + cached);
          } else if (inline) {
            if (uuid) fileTextCacheInsert(uuid, inline);
            extras.push('[File ' + fname + ']:\n' + inline);
            logPastedDebug(f, uuid || 'noidx_' + fi, inline.length, 'inline');
          } else {
            // v45-B6: очередь paste-capture проверяем прямо при парсинге —
            // вложение появляется в истории позже вставки, очередь уже может быть заполнена.
            var ptextA = takePastedFromQueue(uuid || ('noidx_' + fi), fileSizeOf(f));
            if (ptextA) {
              if (uuid) fileTextCacheInsert(uuid, ptextA);
              extras.push('[File ' + fname + ']:\n' + ptextA);
            } else {
              extras.push('[Вложение: ' + fname + ']'); // заглушка до догрузки / навсегда для не-текста
              if (uuid) scheduleFileTextFetch(f, fname);
              else logPastedDebug(f, 'noidx_' + fi, 0, 'no-uuid');
            }
          }
        }
      }
      // v52: attachments[] — pasted-чипы с extracted_content (история) / req-cache (completion)
      for (var ai = 0; ai < atts.length; ai++) {
        var a = atts[ai];
        if (!a || typeof a !== 'object') continue;
        var aname = a.file_name || 'pasted';
        var akey = String(aname) + '|' + fileSizeOf(a);
        // v54-1: ключ dedup — ТОЛЬКО идентичность вложения; uuid сообщения/узла НЕ входит
        var attKey = '';
        try {
          var aSize = (a.size_bytes != null) ? a.size_bytes : ((a.file_size != null) ? a.file_size : fileSizeOf(a));
          attKey = 'att_' + String(a.file_uuid || a.uuid || (String(aname) + '|' + aSize)).slice(0, 56);
        } catch (eAK) { attKey = 'att_' + String(aname).slice(0, 56); }
        if (seenLocal[attKey]) {
          debugLog('log', '[AI CM][Claude][pasted] hist-attach dup-skip key=' + attKey.slice(0, 60));
          continue;
        }
        var atext = '';
        var asrc = 'none';
        if (typeof a.extracted_content === 'string' && a.extracted_content.trim()) {
          atext = a.extracted_content; asrc = 'inline';
        } else if (reqAttachCache[akey]) {
          atext = reqAttachCache[akey]; asrc = 'req-cache';
        } else {
          // paste-очередь — запасной канал после inline/req-cache
          var aptext = takePastedFromQueue(a.file_uuid || aname, fileSizeOf(a));
          if (ptext) { atext = ptext; asrc = 'paste-queue'; }
        }
        debugLog('log', '[AI CM][Claude][pasted] hist-attach name=' + String(aname).slice(0, 40) +
          ' textLen=' + atext.length + ' source=' + asrc + ' key=' + attKey.slice(0, 60));
        // v54-1: вложение учтено в этом парсе — повторные узлы-эхо пропускаются выше
        seenLocal[attKey] = 1;
        if (atext) {
          if (atext.length > 500000) atext = atext.slice(0, 500000) + '\n[обрезано]';
          extras.push('[File ' + aname + ']:\n' + atext);
          stats.histAttachCount++;
          var dt = Math.max(1, Math.round(atext.length / 4));
          attachTokens += dt;
          attachBreak.docTokens += dt;
          attachBreak.docCount++;
        } else {
          extras.push('[Вложение: ' + aname + ']');
        }
      }
      if (extras.length) {
        stats.extrasBlocks += extras.length;
        var newText = parsed.messages[k].text + '\n' + extras.join('\n');
        parsed.messages[k].text = newText;
        parsed.pieces[k] = newText;
        parsed.lastText = parsed.pieces[parsed.pieces.length - 1];
        parsed.text = parsed.pieces.join('\n');
      }
    }
    if (!loggedAttach && attachTokens > 0) {
      loggedAttach = true;
      debugLog('log', '[claude-intercept] вложения из files: токенов≈' + attachTokens +
        ' (img=' + attachBreak.imgCount + ')');
    }
    return stats;
    } catch (eAM) { console.error('[AI CM][Claude][error] applyMessageFiles: ' + eAM.message); return stats; }
  }

  // ---- чистый разбор истории (без сайд-эффектов, переиспользуется в тестах) ----
  function parseHistory(data) {
    var messages = data.chat_messages;
    if (!Array.isArray(messages)) messages = [];
    var model = data.model || '';
    var resultMessages = [];
    var pieces = [];
    var ids = [];
    var uuidIdx = {};
    var count = 0;
    var lastText = '';
    var traceNodeCount = 0; // v50: trace user-узлов, ≤10 на парс

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
        // v30: в эталон идёт только видимый диалог — блоки type==="text";
        // tool_use/tool_result/document/image/thinking пропускаем;
        // для tool_use вставляем компактный маркер вместо сырого JSON.
        if (b.type === 'text' && typeof b.text === 'string') {
          textParts.push(b.text);
        } else if (b.type === 'tool_use') {
          var toolName = (b.name && typeof b.name === 'string') ? b.name : 'unknown';
          textParts.push('[tool: ' + toolName + ']');
        }
      }

      var text = textParts.join('\n').trim();
      // v50/v52: user-узел включается при непустых files ИЛИ attachments (pasted-чипы)
      var atts = (sender !== 'assistant' && Array.isArray(msg.attachments)) ? msg.attachments : [];
      var filesN = (sender !== 'assistant' && Array.isArray(msg.files)) ? msg.files.length : 0;
      var hasFiles = sender !== 'assistant' && ((Array.isArray(msg.files) && msg.files.length > 0) || atts.length > 0);
      if (sender === 'human' && traceNodeCount < 5) {
        traceNodeCount++;
        // v51: ключи user-узла — где Claude хранит pasted-контент
        var nodeKeys = '';
        try {
          nodeKeys = Object.keys(msg || {}).slice(0, 20).map(function (s) { return String(s).slice(0, 40); }).join('|');
        } catch (eNK) {}
        traceLog('parse-node kind=user textLen=' + text.length +
          ' attach=' + (filesN + atts.length) +
          ' keys=' + nodeKeys +
          ' → ' + ((text || hasFiles) ? 'included' : 'skipped(no-text-no-files)'));
      }
      if (text || hasFiles) {
        if (msg.uuid) uuidIdx[String(msg.uuid)] = resultMessages.length;
        resultMessages.push({ role: sender === 'assistant' ? 'assistant' : 'human', text: text });
        // attach-only узел кладёт пустую строку — параллельность pieces/ids сохранена,
        // пустая строка в экспорт не выводится (normalize отфильтрует)
        pieces.push(text);
        ids.push(msg.uuid || ('msg' + i));
        count++;
        if (text) lastText = text;
      }
    }

    return { text: pieces.join('\n'), count: count, lastText: lastText, modelSlug: model, pieces: pieces, ids: ids, uuidIdx: uuidIdx, messages: resultMessages, model: model };
  }

  // ---- обёртка с сайд-эффектами для боевого кода ----
  function parseHistoryWithEffects(data) {
    var parsed = parseHistory(data);
    var model = parsed.model || lastModel || '';
    if (model) lastModel = model;
    parsed.modelSlug = model;

    var messages = data.chat_messages;
    var seenLocal = {}; // v53: локальный dedup вложений на этот парс
    // v1.8-fix: attachTokens/attachBreak — чистая функция raw: сбрасываем ПЕРЕД сбором,
    // иначе idle-проходы (страховочный таймер/retry/re-emit) плюсовали одни и те же
    // вложения поверх уже учтённых и бейдж полз вверх при неизменном raw.
    attachTokens = 0;
    attachBreak = { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 };
    loggedAttach = false;
    if (Array.isArray(messages)) collectAttachments(messages, seenLocal);
    // Вложения из msg.files: картинки — сразу в текст+токены; документы — заглушка,
    // текст догружается асинхронно (кэш по file_uuid), затем пере-эмит.
    lastHistoryRaw = data;
    lastHistoryRawConvId = currentConvId; // v48: привязка raw-снимка к чату
    var amStats = { extrasBlocks: 0, histAttachCount: 0 };
    try { amStats = applyMessageFiles(parsed, messages, seenLocal) || amStats; } catch (eAM2) {}
    // v53-4: сводка парса — на каком проходе умножение видно сразу
    traceLog('parse-summary msgs=' + parsed.count +
      ' rawLen=' + (parsed.text || '').length +
      ' extrasBlocks=' + amStats.extrasBlocks +
      ' hist-attach-count=' + amStats.histAttachCount);

    // v37: снимок самодостаточен — emit строит detail ТОЛЬКО из parsed
    // (никаких чтений устаревших модульных переменных в цепочке эмита)
    // v54: convId снимка — из тела ответа (data.uuid), не из текущего URL (SPA-гонка)
    parsed.convId = snapshotConvIdOf(data) || currentConvId;
    parsed.attachTokens = attachTokens;
    parsed.attachBreak = {
      imgTokens: attachBreak.imgTokens,
      docTokens: attachBreak.docTokens,
      imgCount: attachBreak.imgCount,
      docCount: attachBreak.docCount
    };

    return parsed;
  }

  function emitSnapshot(parsed, when) {
    if (!parsed.text) return;
    // v54: trace источника снимка — экспорт/бейдж строятся ТОЛЬКО из сети текущего convId
    traceLog('snapshot source=network convId=' + (parsed.convId || '-') + ' msgs=' + (parsed.count || 0));
    // v36/v37: trace эмита (токены — оценка: текст/4 + вложения; percent считает content.js)
    // v1.8: emit-stat с итогом total= — видно двойной учёт сразу (total не должен расти при том же raw)
    var statTotal = Math.round(parsed.text.length / 4) + (parsed.attachTokens || 0);
    traceLog('[AI CM][Claude][trace] emit-stat src=' + (when || '-') +
      ' convId=' + (parsed.convId || '-') +
      ' textLen=' + parsed.text.length +
      ' tokens~' + Math.round(parsed.text.length / 4) +
      ' attachTokens=' + (parsed.attachTokens || 0) +
      ' total=' + statTotal);
    traceLog('emit (' + when + ') msgs=' + parsed.count +
      ' model=' + (parsed.modelSlug || '-') +
      ' textLen=' + parsed.text.length +
      ' tokens~' + (Math.round(parsed.text.length / 4) + (parsed.attachTokens || 0)) +
      ' attachTokens=' + (parsed.attachTokens || 0));
    console.log('[claude-intercept] ' + String.fromCodePoint(0x1F4E5) + ' полный снимок (' + when + '): ' + parsed.count +
      ' сообщений' + (parsed.modelSlug ? ', model=' + parsed.modelSlug : '') +
      ((parsed.attachTokens || 0) > 0 ? ', вложений' + String.fromCodePoint(0x2248) + parsed.attachTokens + ' ток' : '') +
      ' (без скролла)');
    // H23: пейлоад строится ОДИН раз и одновременно становится ретейном — ре-эмит по
    // handshake отдаёт ровно этот объект (байтово тот же снимок, без перепарса).
    var detail = {
      text: parsed.text,
      count: parsed.count,
      lastMessageText: parsed.lastText,
      modelSlug: parsed.modelSlug,
      messageTexts: parsed.pieces,
      messageIds: parsed.ids,
      messages: parsed.messages || [],
      convId: parsed.convId || '',
      attachTokens: parsed.attachTokens || 0,
      attachBreak: parsed.attachBreak || { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 },
      historyComplete: true,
      serverTokens: 0
    };
    lastEmitDetail = detail;
    lastEmitDetailConvId = detail.convId || '';
    try {
      window.dispatchEvent(new CustomEvent('ai-cm-full-history', {
        detail: detail
      }));
      // v37: фиксируем валидный снимок (msgs>0) для гарда от пустых повторных GET
      if (parsed.count > 0) {
        validEmitConvId = parsed.convId || currentConvId;
        validEmitCount = parsed.count;
      }
    } catch (e) {}
  }

  // ---- H23: ре-эмит ретейна по handshake (гонка «ответ истории раньше слушателя») ----
  // Перехватчик (MAIN, document_start) может распарсить и эмитнуть снимок ДО инжекции
  // content.js (ISOLATED, document_idle): fire-once emit теряется, бейдж/попап стоят
  // пустыми до F5. По 'ai-cm-content-ready' (content.js зарегистрировал слушатель) и по
  // 'ai-cm-request-emit' (3с без badge-recv при сетевом адаптере) отдаём последний снимок
  // повторно. Гарды: чужой чат в ретейне не ре-эмитится; гейты автоэкспорта
  // (baseComplete/latch) не меняются — событие идёт обычным путём слушателя content.js.
  function reEmitLastSnapshot(reason) {
    if (!lastEmitDetail) { traceLog('re-emit skip (' + reason + ') — ретейна нет'); return; }
    if (lastEmitDetailConvId && currentConvId && lastEmitDetailConvId !== currentConvId) {
      traceLog('re-emit skip (' + reason + ') — ретейн чужого чата (' +
        String(lastEmitDetailConvId).slice(0, 8) + ' != ' + String(currentConvId).slice(0, 8) + ')');
      return;
    }
    traceLog('re-emit (' + reason + ') msgs=' + (lastEmitDetail.count || 0) +
      ' convId=' + (lastEmitDetailConvId || '-') + ' textLen=' + ((lastEmitDetail.text || '').length));
    console.log('[claude-intercept] ' + String.fromCodePoint(0x21BA) + ' ре-эмит снимка по ' + reason +
      ': ' + (lastEmitDetail.count || 0) + ' сообщений');
    try { window.dispatchEvent(new CustomEvent('ai-cm-full-history', { detail: lastEmitDetail })); } catch (e) {}
  }
  try {
    window.addEventListener('ai-cm-content-ready', function () { reEmitLastSnapshot('content-ready'); });
  } catch (eCr) {}
  try {
    window.addEventListener('ai-cm-request-emit', function () { reEmitLastSnapshot('request-emit'); });
  } catch (eRe) {}

  // ---- обработка ответа истории ----
  function handleHistoryResponse(response, when, expectedConvId) {
    var copy = response.clone();
    var st = 0;
    try { st = response.status; } catch (e) {}
    // v37: читаем ТЕКСТ клона (не json()) — видны status и bodyLen; тело не потребляется дважды
    copy.text().then(function (rawText) {
      var bodyLen = (rawText || '').length;
      traceLog('intercept-resp (' + when + ') status=' + st + ' bodyLen=' + bodyLen);
      var data = null;
      try { data = JSON.parse(rawText); } catch (pj) {
        debugLog('log', '[claude-intercept] не-JSON история (' + when + ') status=' + st + ' bodyLen=' + bodyLen);
        return;
      }
      try {
      if (expectedConvId && expectedConvId !== currentConvId) {
        debugLog('log', '[claude-intercept] пропущен устаревший снимок (convId=' + expectedConvId + ' != текущий ' + currentConvId + ')');
        // v36: снимок устарел, но текущий чат мог ещё не получить базу — перезаводим
        // bootstrap, иначе после SPA-перехода бейдж навсегда 0.0% (до F5).
        if (!snapshotReceived && !bootstrapTimer && currentConvId) {
          bootstrapTimer = setTimeout(function () {
            bootstrapTimer = null;
            try { bootstrapSnapshot(); } catch (bsErr) { console.error('[AI CM][Claude][error] bootstrap retry: ' + bsErr.message); }
          }, 1500);
        }
        return;
      }
      // v54: чужой чат в теле ответа — игнор целиком (SPA-гонка пассивной ловли)
      if (isStaleSnapshotBody(data, String(when || 'passive'))) return;
      var parsedHist = parseHistoryWithEffects(data);
      traceLog('parse-end (' + when + ') msgs=' + parsedHist.count +
        ' model=' + (parsedHist.modelSlug || '-') + ' attachTokens=' + attachTokens);
      // v37 гард обнуления: пустой разбор (msgs=0) при живом валидном снимке этого
      // же чата НЕ эмитит и НЕ трогает состояние (лочку/bootstrap не трогаем).
      if (!parsedHist.count) {
        if (validEmitCount > 0 && validEmitConvId === currentConvId) {
          traceLog('parse-empty skip (' + when + ') status=' + st + ' bodyLen=' + bodyLen +
            ' — есть валидный снимок msgs=' + validEmitCount);
          return;
        }
        // валидного снимка ещё нет: оставляем bootstrap-таймер жить для дозапроса
        debugLog('log', '[claude-intercept] пустой снимок (' + when + ') status=' + st +
          ' bodyLen=' + bodyLen + ' — ждём bootstrap/повтор');
        return;
      }
      // Валидный снимок получен — отменяем bootstrap-таймер и лочим
      if (bootstrapTimer) { clearTimeout(bootstrapTimer); bootstrapTimer = null; }
      snapshotReceived = true;
      emitSnapshot(parsedHist, when);
      } catch (e) { console.error('[AI CM][Claude][error] history parse: ' + e.message); }
    }).catch(function (e) {
      debugLog('log', '[claude-intercept] ошибка чтения тела истории: ' + e);
    });
  }

  // ---- «виртуальный F5»: активный GET полного снимка ----
  function activeRefresh(reason) {
    if (activeDisabled || refreshBusy) return;
    if (!currentConvId) { traceLog('vf5 skip (' + reason + ') — не в чате'); return; } // v37
    // v49: URL снимка — из lastHistoryUrl ТОЛЬКО если его convId совпадает с актуальным;
    // иначе (или если пусто) строим из lastOrgPrefix + текущий convId.
    var refreshSource = 'last';
    var baseUrl = '';
    try {
      var mU = String(lastHistoryUrl || '').match(/\/chat_conversations\/([0-9a-fA-F-]{8,})/);
      var urlConv = mU ? mU[1] : '';
      if (lastHistoryUrl && urlConv === currentConvId) {
        baseUrl = lastHistoryUrl;
      } else if (lastOrgPrefix) {
        baseUrl = lastOrgPrefix + currentConvId + '?tree=True';
        lastHistoryUrl = baseUrl;
        refreshSource = 'built';
      } else {
        traceLog('refresh-url skip reason=no-org-prefix');
        if (!loggedActiveStatus) { loggedActiveStatus = true; debugLog('log', '[claude-vf5] активный запрос отложен: нет адреса снимка пока'); }
        return;
      }
    } catch (eBu) { debugLog('log', '[claude-vf5] ошибка построения url: ' + eBu); return; }
    traceLog('refresh-url ' + String(baseUrl).slice(0, 160) + ' source=' + refreshSource);
    var sentConvId = currentConvId;
    refreshBusy = true;
    var sep = baseUrl.indexOf('?') === -1 ? '?' : '&';
    var markedUrl = baseUrl + sep + guardToken + '=1';
    originalFetch(markedUrl, { method: 'GET', credentials: 'include' })
      .then(function (resp) {
        if (!loggedActiveStatus) {
          loggedActiveStatus = true;
          console.log('[claude-vf5] первый активный запрос: статус ' + (resp ? resp.status : 'none'));
        }
        if (!resp || !resp.ok) {
          // v31: не вечный latch — активный режим отключаем до планового retry
          activeDisabled = true;
          scheduleActiveRetry();
          debugLog('log', '[claude-vf5] не прошёл (статус ' + (resp ? resp.status : 'none') + ') → пассивная ловля, retry через ' + activeRetryDelay / 1000 + 'с');
          return null;
        }
        clearActiveRetry(); // v31: успех — сбрасываем backoff
        console.log('[claude-vf5] ' + String.fromCodePoint(0x2713) + ' работает (' + reason + ')');
        return resp.json();
      })
      .then(function (data) {
        try {
        if (!data) return;
        if (sentConvId !== currentConvId) {
          debugLog('log', '[claude-intercept] пропущен устаревший vf5 (convId=' + sentConvId + ' != текущий ' + currentConvId + ')');
          return;
        }
        // v54: жёсткая проверка по телу ответа — тело могло оказаться от другого чата
        if (isStaleSnapshotBody(data, 'vf5')) return;
        emitSnapshot(parseHistoryWithEffects(data), 'виртуальный F5');
        dirty = false;
        } catch (e) { console.error('[AI CM][Claude][error] vf5 parse: ' + e.message); }
      })
      .catch(function (err) {
        if (!loggedActiveStatus) { loggedActiveStatus = true; }
        // v31: не вечный latch — активный режим отключаем до планового retry
        activeDisabled = true;
        scheduleActiveRetry();
        debugLog('log', '[claude-vf5] ошибка: ' + err + ' → пассивная ловля, retry через ' + activeRetryDelay / 1000 + 'с');
      })
      .finally(function () { refreshBusy = false; });
  }

  function scheduleActive(reason, delay) {
    if (activeDisabled) return;
    dirty = true;
    var schedConvId = currentConvId; // v37: vf5 «после стрима» старого чата — не для нового
    // v36: колбэк таймера вне promise-цепочки — бросок был бы uncaught
    setTimeout(function () {
      if (currentConvId !== schedConvId) { traceLog('vf5 timer skip (' + reason + ') — чат сменился'); return; }
      try { activeRefresh(reason); } catch (e) { console.error('[AI CM][Claude][error] vf5 timer (' + reason + '): ' + e.message); }
    }, delay);
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

  // v39: диагностика upload-кандидатов (поиск реального эндпоинта pasted-текста).
  // Только наблюдение: статус/длину берём из Response.headers, тело НЕ читаем.
  var UPLOAD_URL_RE = /upload|file|attachment|pasted/i;
  // v40: шумовые эндпоинты тел — не сканируем и не логируем
  var NOISE_URL_RE = /datadoghq|event_logging|\/rum/i;
  // v42: upload-кандидаты — расширенный набор
  var UPLOAD_URL_RE = /upload|file|files|blob|store|attachment|pasted/i;
  // v42: решающая диагностика бинарных тел (Uint8Array/ArrayBuffer/typed array):
  // первые 400 байт → utf-8 с заменой ошибок → печатные пробеги ≥4 через '|', итог ≤150.
  function binaryPreviewLen(body) {
    try { return body && typeof body.byteLength === 'number' ? body.byteLength : -1; } catch (eL) { return -1; }
  }
  // v44-A2: бинарное тело → Uint8Array-вид (или null); realm-безопасно, всё в try/catch
  function asUint8View(body) {
    try {
      if (typeof Uint8Array !== 'undefined' && body instanceof Uint8Array) return body;
      if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return new Uint8Array(body);
      if (body && body.buffer instanceof ArrayBuffer && typeof body.byteLength === 'number') {
        return new Uint8Array(body.buffer, body.byteOffset || 0, body.byteLength);
      }
    } catch (e) {}
    return null;
  }
  function binaryPreview(body) {
    try {
      var u8 = null;
      if (typeof Uint8Array !== 'undefined' && body instanceof Uint8Array) u8 = body;
      else if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) u8 = new Uint8Array(body);
      else if (body && body.buffer instanceof ArrayBuffer && typeof body.byteLength === 'number') {
        u8 = new Uint8Array(body.buffer, body.byteOffset || 0, body.byteLength);
      } else return '';
      var dec = null;
      try { dec = new TextDecoder('utf-8', { fatal: false }); } catch (eD) { return ''; }
      var s = dec.decode(u8.subarray(0, 400));
      var runs = String(s).match(/[\x20-\x7E\u00A0-\uD7FF\uE000-\uFFFD]{4,}/g) || [];
      return runs.join('|').slice(0, 150);
    } catch (e) { return ''; }
  }
  function observeUpload(method, url, promise) {
    try {
      if (!promise || typeof promise.then !== 'function') return;
      if (!UPLOAD_URL_RE.test(String(url || ''))) return;
      promise.then(function (resp) {
        try {
          var cl = '-';
          try { cl = (resp && resp.headers && resp.headers.get('content-length')) || '-'; } catch (e1) {}
          traceLog('upload-candidate ' + method + ' ' + String(url).slice(0, 120) +
            ' status=' + (resp ? resp.status : 'none') + ' bodyLen=' + cl);
        } catch (e2) {}
      }).catch(function () {
        traceLog('upload-candidate ' + method + ' ' + String(url).slice(0, 120) + ' status=error');
      });
    } catch (e) {}
  }

  // ---- перехват fetch ----
  function makeUrlMatcher(url) {
    try {
      var u = typeof url === 'string' ? url : (url && url.url ? url.url : '');
      return {
        full: u,
        // v36/v52: история = ТОЛЬКО /chat_conversations/<uuid> с концом пути или '?'
        // (composer_notices/title/completion и др. подпути снимком НЕ являются —
        // иначе lastHistoryUrl загрязнялся не-историческим URL).
        isHistory: /\/chat_conversations\/[0-9a-fA-F-]{8,}(\?|$)/.test(u) && u.indexOf('/completion') === -1,
        isCompletion: u.indexOf('/completion') !== -1,
        hasGuard: u.indexOf(guardToken) !== -1
      };
    } catch (e) { return { full: '', isHistory: false, isCompletion: false, hasGuard: false }; }
  }

  window.fetch = function (input, init) {
    var m = makeUrlMatcher(input);

    // v34: внутренние fetch по path вложений — не события страницы
    try {
      if (m.full && internalFetchUrls[m.full]) {
        return originalFetch.call(this, input, init);
      }
    } catch (e) {}

    // v34-C: тела POST на /api/ сканируем на pasted-текст (оригинал не потребляем)
    try { capturePostBody(input, init); } catch (e) {}

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

    // v36: trace url-match (метод + url≤80) — только при флаг «Подробные логи»
    var _mth = 'GET';
    try { _mth = String((init && init.method) || (input && input.method) || 'GET').toUpperCase(); } catch (e0) {}
    var isHistory = m.isHistory && !m.hasGuard;
    var isCompletion = m.isCompletion;

    // v40: тело ОТВЕТА читаем ТОЛЬКО для GET/HEAD. Раньше isCompletion/isHistory
    // матчились по URL без метода: POST /chat_conversations/<uuid>/b/completion
    // (text/event-stream) попадал в readLoop через resp.clone() — клонирование
    // стрима ломало чтение SSE страницей → «This response didn't load» + retry.
    // POST/PUT-ответы теперь возвращаются странице НЕТРОНУТЫМИ: без clone(),
    // text(), new Response(), readLoop.
    var canReadStream = (_mth === 'GET' || _mth === 'HEAD');
    if (!canReadStream && (isHistory || isCompletion)) {
      traceLog('intercept-skip ' + _mth + ' ' + String(m.full || '').slice(0, 80) + ' — ответ не читаем (не GET)');
      isHistory = false;
      isCompletion = false;
    }

    if (isHistory || isCompletion) {
      // v42: для POST/PUT клип url до 160 — видеть суффикс эндпоинта (/completion и т.п.)
      var _uClip = (_mth === 'POST' || _mth === 'PUT') ? 160 : 80;
      traceLog('intercept ' + _mth + ' ' + String(m.full || '').slice(0, _uClip));
    }

    if (!isHistory && !isCompletion) {
      var p = originalFetch.call(this, input, init);
      observeUpload(_mth, m.full, p); // v39: upload-кандидаты (любой метод/origin)
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
      // v36: здесь больше НИЧЕГО не лочим. Раньше bootstrapTimer снимался и
      // snapshotReceived=true ставился уже на этапе ЗАПРОСА; если ответ затем
      // отбрасывал гард устаревшего convId (SPA: запрос истории уходит до pushState),
      // новый чат оставался без снимка навсегда (бейдж 0.0% до F5), причём обрыв был
      // тихий. Лочка теперь происходит ТОЛЬКО в handleHistoryResponse при успехе.
      // v49: запоминаем org-префикс — из него строится URL снимка для чата из /new.
      try {
        var mOrg = String(lastHistoryUrl).match(/\/api\/organizations\/[0-9a-fA-F-]+\/chat_conversations\//);
        if (mOrg) lastOrgPrefix = mOrg[0];
      } catch (eOrg) {}
    }

    var fetchPromise = originalFetch.call(this, input, init);
    observeUpload(_mth, m.full, fetchPromise); // v39: upload-кандидаты (история/completion тоже наблюдаем)

    // Ветвь A: история (GET, /chat_conversations/)
    if (isHistory) {
      fetchPromise.then(function (resp) {
        try {
          if (!resp || !resp.ok) return;
          handleHistoryResponse(resp, 'пассив', sentConvId);
        } catch (e) { console.error('[AI CM][Claude][error] fetch-история колбэк: ' + e.message); }
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
            try {
              if (result.done) {
                var fullText = chunks.join('');
                var parsed = null;
                var stopDetected = false;
                try {
                  parsed = parseSSEWithEffects(fullText, m.full);
                  stopDetected = parsed.stopDetected;
                } catch (parseErr) {
                  console.error('[AI CM][Claude][error] sse parse: ' + parseErr.message);
                }
                if (stopDetected) {
                  scheduleActive('после стрима', 800);
                }
                return;
              }
              chunks.push(decoder.decode(result.value, { stream: true }));
              readLoop();
            } catch (eLoop) { console.error('[AI CM][Claude][error] sse readLoop: ' + eLoop.message); }
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

  // ---- v34-C/v39: перехват XHR.send — pasted-скан (строка/FormData/URLSearchParams) + диагностика ----
  (function () {
    try {
      var OrigXHR = window.XMLHttpRequest;
      if (!OrigXHR || !OrigXHR.prototype) return;
      var origOpen = OrigXHR.prototype.open;
      var origSend = OrigXHR.prototype.send;
      OrigXHR.prototype.open = function (method, url) {
        try { this.__aicm_method = method; this.__aicm_url = url; } catch (e) {}
        return origOpen.apply(this, arguments);
      };
      OrigXHR.prototype.send = function (bodyValue) {
        try {
          var method = String(this.__aicm_method || 'GET').toUpperCase();
          var url = String(this.__aicm_url || '');
          var isApiScan = (method === 'POST' || method === 'PUT') &&
            url.indexOf('/api/') !== -1 && url.indexOf(guardToken) === -1 &&
            !internalFetchUrls[url] && !NOISE_URL_RE.test(url);
          if (isApiScan) {
            var kind = 'other', len = -1, scanText = null, jsonOk = 0;
            if (typeof bodyValue === 'string') {
              kind = 'string'; len = bodyValue.length;
              scanText = (len <= 5 * 1024 * 1024) ? bodyValue : null;
            } else if (bodyValue && typeof FormData !== 'undefined' && bodyValue instanceof FormData) {
              kind = 'formdata';
            } else if (bodyValue && typeof URLSearchParams !== 'undefined' && bodyValue instanceof URLSearchParams) {
              kind = 'urlsp';
              try { scanText = bodyValue.toString(); len = scanText.length; } catch (eU) {}
            }
            if (kind === 'string' && scanText != null) {
              jsonOk = processPostBody(url, scanText);
              if (jsonOk === 1) traceBodyStruct(url, scanText); // v41: структура чат-POST
            }
            else if (kind === 'formdata') {
              var parts = [];
              try { bodyValue.forEach(function (v, k) { if (typeof v === 'string') parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v)); }); } catch (e2) {}
              jsonOk = processPostBody(url, parts.join('&'));
            }
            var diagX = '';
            if (kind === 'other') {
              var ctorNameX = '';
              try { ctorNameX = Object.prototype.toString.call(bodyValue).replace(/^\[object /, '').replace(/\]$/, '').slice(0, 40); } catch (eC2) {}
              diagX = ' bodyCtor=' + (ctorNameX || '?') + ' inputIsRequest=0';
              // v42: решающая диагностика бинарных тел
              var prevX = binaryPreview(bodyValue);
              if (prevX) {
                traceLog('body-preview url=' + url.slice(0, 160) +
                  ' len=' + binaryPreviewLen(bodyValue) + ' preview=' + prevX);
              }
            }
            traceLog('body-scan ' + method + ' ' + url.slice(0, 160) +
              ' bodyKind=' + kind + ' len=' + len + ' jsonOk=' + jsonOk + diagX);
          }
          // v39: upload-кандидаты через XHR — статус/длина берём из loadend, тело не трогаем
          if (UPLOAD_URL_RE.test(url)) {
            var xhr = this;
            if (!xhr.__aicm_upl_obs) {
              xhr.__aicm_upl_obs = true;
              xhr.addEventListener('loadend', function () {
                try {
                  var blen = -1;
                  try { blen = (typeof xhr.responseText === 'string') ? xhr.responseText.length : -1; } catch (eR) {}
                  traceLog('upload-candidate ' + method + ' ' + url.slice(0, 120) +
                    ' status=' + (xhr.status || 'none') + ' bodyLen=' + blen);
                } catch (eL) {}
              });
            }
          }
        } catch (e) {}
        return origSend.apply(this, arguments);
      };
    } catch (e) { console.error('[AI CM][Claude][error] xhr wrap: ' + e.message); }
  })();

  // ---- страховка: если стрим прочитан, но stop не поймался ----
  // v1.13.1 (R2): guard-поллинг через aiCmCommon.setIntervalVisible — skip при
  // скрытой вкладке; фолбэк на plain setInterval, если window.aiCmCommon недоступен.
  var aiCmPoll = (typeof window !== 'undefined' && window.aiCmCommon && window.aiCmCommon.setIntervalVisible)
    ? function (f, m) { return window.aiCmCommon.setIntervalVisible(f, m); }
    : setInterval;
  aiCmPoll(function () {
    if (dirty && !refreshBusy) {
      // v36: интервал вне promise-цепочки — бросок был бы uncaught
      try { activeRefresh('таймер-страховка'); } catch (e) { console.error('[AI CM][Claude][error] vf5 страховка: ' + e.message); }
    }
  }, 15000);

  // ---- bootstrap: активный снимок при старте скрипта ----
  // v36: колбэк таймера обёрнут — бросок был бы uncaught
  bootstrapTimer = setTimeout(function () {
    try { bootstrapSnapshot(); } catch (e) { console.error('[AI CM][Claude][error] bootstrap timer: ' + e.message); }
  }, 1500);

  console.log('[claude-intercept] перехватчик Claude установлен (GET истории + SSE completion → vf5 + bootstrap, MAIN world, document_start)');
})();