// core/pdf-bytes.js — MAIN-мир: единственная точка, откуда провайдер запускает
// разбор PDF. Байты скачиваются тем же originalFetch, которым провайдер уже
// пользуется, и уходят в isolated-мир чанками через window.postMessage (transfer
// ArrayBuffer, без base64 и без копий в MAIN).
//
// Дальше: core/content.js (мост) → Port 'ai-cm-pdf:<id>' → core/pdf-parser.js →
// parser/offscreen.html (Chrome) или AiCmPdfHost (Firefox). Текст возвращается
// CustomEvent'ом 'ai-cm-pdf-result' с JSON-строкой в detail — так же, как остальные
// мосты репозитория (aiCmBridgeDetail).
//
// Гарантии: pdf.js в MAIN не попадает; при отсутствии моста (страница без content.js,
// jsdom-тесты) запрос быстро отваливается с reason 'pdf-unavailable', и провайдер
// остаётся на прежней ветке заглушки.
(function () {
  'use strict';

  if (typeof window === 'undefined') return;
  if (window.AiCmPdf) return;

  var SRC = 'ai-cm-pdf';
  var CHUNK = 512 * 1024;
  var MAX_BYTES = 10 * 1024 * 1024;
  var MAX_CHUNKS = 64;
  var DEFAULT_TIMEOUT = 15000;
  var READY_TIMEOUT = 1500;

  var counter = 0;
  var pending = {};
  var readyFlag = false;

  function aiCmPdfWarn(tag, e) {
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn('[ai-cm-pdf] ' + tag + ':', e);
    }
  }

  function num(v) {
    var n = typeof v === 'number' ? v : parseInt(v, 10);
    return (isFinite(n) && n > 0) ? n : 0;
  }

  function nowMs() {
    return (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0;
  }

  function fail(reason, size) {
    return { ok: false, text: '', pages: 0, truncated: false, reason: reason, size: num(size) };
  }

  function newId() {
    counter = (counter + 1) % 1000000;
    return 'pdf-' + nowMs().toString(36) + '-' + counter.toString(36) + '-' +
      Math.floor(Math.random() * 1296).toString(36);
  }

  function emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(detail || {}) }));
      return true;
    } catch (eEmit) {
      aiCmPdfWarn('emit:' + name, eEmit);
      return false;
    }
  }

  function parseDetail(ev) {
    var raw = (ev && ev.detail !== undefined) ? ev.detail : null;
    if (typeof raw !== 'string') return (raw && typeof raw === 'object') ? raw : null;
    try {
      return JSON.parse(raw);
    } catch (eParse) {
      aiCmPdfWarn('parse-result', eParse);
      return null;
    }
  }

  // Мост живёт в isolated-мире и отвечает ready на hello и на загрузке страницы.
  // Ждать дольше READY_TIMEOUT бессмысленно: провайдер должен быстро откатиться
  // на заглушку, а не держать очередь вложений.
  window.addEventListener('ai-cm-pdf-ready', function () {
    readyFlag = true;
  });

  function ensureReady(requestId) {
    if (readyFlag) return Promise.resolve(true);
    return new Promise(function (resolve) {
      var settled = false;
      var timer = null;
      function finish(ok) {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        window.removeEventListener('ai-cm-pdf-ready', onReady);
        resolve(ok === true);
      }
      function onReady() {
        readyFlag = true;
        finish(true);
      }
      timer = setTimeout(function () { finish(false); }, READY_TIMEOUT);
      window.addEventListener('ai-cm-pdf-ready', onReady);
      emit('ai-cm-pdf-hello', { id: requestId });
    });
  }

  window.addEventListener('ai-cm-pdf-result', function (ev) {
    var res = parseDetail(ev);
    if (!res || typeof res.id !== 'string') return;
    var entry = pending[res.id];
    if (!entry) return;
    delete pending[res.id];
    entry.finish(res);
  });

  // pagehide (закрытие вкладки, уход в bfcache): результат уже никто не прочитает,
  // поэтому отменяем хост, чтобы не держать воркер pdf.js в offscreen-документе.
  window.addEventListener('pagehide', function () {
    var ids = Object.keys(pending);
    for (var i = 0; i < ids.length; i++) {
      var entry = pending[ids[i]];
      delete pending[ids[i]];
      emit('ai-cm-pdf-cancel', { id: ids[i] });
      if (entry && typeof entry.finish === 'function') entry.finish(fail('pdf-aborted', 0));
    }
  });

  function toBytes(buf) {
    if (!buf) return null;
    if (typeof ArrayBuffer !== 'undefined' && buf instanceof ArrayBuffer) return new Uint8Array(buf);
    if (buf && typeof buf.byteLength === 'number' && typeof buf.length === 'number') return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    return null;
  }

  // Нарезка 512 КиБ с yield между сообщениями: MAIN не должен стоять дольше ~50 мс,
  // иначе провайдерский emit и редактирование страницы дёргаются.
  function postChunks(id, u8, maxChars, done) {
    var total = Math.max(1, Math.ceil(u8.length / CHUNK));
    if (total > MAX_CHUNKS) {
      done(0);
      return;
    }
    var seq = 0;
    function next() {
      if (seq >= total) {
        done(total);
        return;
      }
      var start = seq * CHUNK;
      var slice = u8.slice(start, Math.min(start + CHUNK, u8.length));
      var buf = slice.buffer;
      var msg = { source: SRC, id: id, seq: seq, total: total, bytes: buf };
      if (maxChars > 0) msg.maxChars = maxChars;
      seq++;
      try {
        window.postMessage(msg, '*', [buf]);
      } catch (ePost) {
        aiCmPdfWarn('postMessage', ePost);
        done(-1);
        return;
      }
      setTimeout(next, 0);
    }
    next();
  }

  function run(buf, opts) {
    var o = opts || {};
    var maxBytes = num(o.maxBytes) || MAX_BYTES;
    var maxChars = num(o.maxChars);
    var timeoutMs = num(o.timeoutMs) || DEFAULT_TIMEOUT;
    var u8 = toBytes(buf);
    if (!u8 || u8.length === 0) return Promise.resolve(fail('pdf-invalid', 0));
    if (u8.length > maxBytes || u8.length > MAX_BYTES) {
      return Promise.resolve(fail('pdf-too-large', u8.length));
    }
    var id = newId();
    var started = nowMs();
    return ensureReady(id).then(function (ready) {
      if (!ready) return fail('pdf-unavailable', u8.length);
      return new Promise(function (resolve) {
        var settled = false;
        var timer = null;
        function finish(res) {
          if (settled) return;
          settled = true;
          if (timer !== null) { clearTimeout(timer); timer = null; }
          if (o.signal && typeof o.signal.removeEventListener === 'function') {
            o.signal.removeEventListener('abort', onAbort);
          }
          delete pending[id];
          var out = (res && typeof res === 'object') ? res : fail('pdf-host-error', u8.length);
          if (!num(out.size)) out.size = u8.length;
          if (typeof out.ms !== 'number') out.ms = nowMs() - started;
          resolve(out);
        }
        function onAbort() {
          emit('ai-cm-pdf-cancel', { id: id });
          finish(fail('pdf-aborted', u8.length));
        }
        pending[id] = { finish: finish };
        timer = setTimeout(function () {
          emit('ai-cm-pdf-cancel', { id: id });
          finish(fail('pdf-timeout', u8.length));
        }, timeoutMs);
        if (o.signal && o.signal.aborted === true) {
          onAbort();
          return;
        }
        if (o.signal && typeof o.signal.addEventListener === 'function') {
          o.signal.addEventListener('abort', onAbort);
        }
        postChunks(id, u8, maxChars, function (total) {
          if (total > 0) return;
          emit('ai-cm-pdf-cancel', { id: id });
          finish(fail(total < 0 ? 'pdf-host-error' : 'pdf-too-large', u8.length));
        });
      });
    });
  }

  function abortBody(res) {
    try {
      if (res && res.body && typeof res.body.cancel === 'function') {
        var p = res.body.cancel();
        if (p && typeof p.catch === 'function') p.catch(function (eCancel) { aiCmPdfWarn('cancel-body', eCancel); });
      }
    } catch (eAbort) {
      aiCmPdfWarn('cancel-body', eAbort);
    }
  }

  function fromUrl(url, opts) {
    var o = opts || {};
    var impl = (typeof o.fetch === 'function') ? o.fetch : ((typeof window.fetch === 'function') ? window.fetch : null);
    if (!impl) return Promise.resolve(fail('pdf-unavailable', 0));
    if (typeof url !== 'string' || url === '') return Promise.resolve(fail('pdf-invalid', 0));
    var maxBytes = num(o.maxBytes) || MAX_BYTES;
    var init = { method: 'GET', credentials: o.credentials || 'omit' };
    if (o.headers) init.headers = o.headers;
    var p;
    try {
      p = impl(url, init);
    } catch (eFetch) {
      aiCmPdfWarn('fetch', eFetch);
      return Promise.resolve(fail('pdf-host-error', 0));
    }
    return Promise.resolve(p).then(function (res) {
      if (!res || res.ok !== true) {
        abortBody(res);
        return fail('pdf-host-error', 0);
      }
      var clen = 0;
      try {
        if (res.headers && typeof res.headers.get === 'function') clen = num(res.headers.get('content-length'));
      } catch (eLen) {
        aiCmPdfWarn('content-length', eLen);
        clen = 0;
      }
      // Верхняя граница проверяется ДО чтения тела: 10-мегабайтный PDF не должен
      // скачиваться в MAIN только для того, чтобы быть отвергнутым.
      if (clen > maxBytes || clen > MAX_BYTES) {
        abortBody(res);
        return fail('pdf-too-large', clen);
      }
      if (typeof res.arrayBuffer !== 'function') {
        abortBody(res);
        return fail('pdf-invalid', 0);
      }
      return Promise.resolve(res.arrayBuffer()).then(function (buf) {
        if (!buf || !buf.byteLength) return fail('pdf-invalid', 0);
        return run(buf, o);
      }, function (eRead) {
        aiCmPdfWarn('arrayBuffer', eRead);
        return fail('pdf-invalid', 0);
      });
    }, function (eNet) {
      aiCmPdfWarn('network', eNet);
      return fail('pdf-host-error', 0);
    });
  }

  window.AiCmPdf = {
    version: '1.0.0',
    MAX_BYTES: MAX_BYTES,
    CHUNK: CHUNK,
    isReady: function () { return readyFlag; },
    fromUrl: fromUrl,
    fromBytes: function (buf, opts) { return run(buf, opts); },
    cancel: function (id) { emit('ai-cm-pdf-cancel', { id: String(id || '') }); }
  };
}());
