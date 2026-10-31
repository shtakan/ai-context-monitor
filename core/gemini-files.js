/**
 * core/gemini-files.js — экспорт вложений Gemini с ТЕКСТОМ (MAIN-мир).
 *
 * Gemini отдаёт вложения не как inlineData/base64, а списком узлов в
 * turn[2][0][4][0][4]. У документов (pdf/docx) есть download-URL
 * contribution.usercontent.google.com, у изображений — CDN-ссылка
 * lh3.googleusercontent.com. Скачивание работает только из MAIN-мира страницы
 * с credentials:'include' (cookie сессии), поэтому модуль живёт рядом с
 * перехватчиком и получает нативный fetch через __bind.
 *
 * Что делает модуль:
 *   • collectTurnFiles(turn) даёт ref-ы вложений (имя/mime/type/token/img/dl);
 *   • перехватчик на каждом пользовательском ходе зовёт
 *     gfEnqueueTurnFiles(convId, msgId, files);
 *   • DOCX распаковывается без внешних зависимостей: zip-локальный заголовок →
 *     DecompressionStream('deflate-raw') → word/document.xml → текст;
 *   • PDF не парсится: запрашивается Range: bytes=0-0, из content-range берётся
 *     полный размер (запасной путь — content-length), в экспорт едет мета-секция;
 *   • изображения не скачиваются (CORS lh3), в экспорт едет [IMAGE: имя] URL;
 *   • FIFO-очередь, concurrency 2, дедуп convId|token|name: один файл,
 *     приложенный к двум ходам, качается один раз, секции получают оба хода;
 *   • готовый текст складывается в карту <convId>\u0000<msgId> и дописывается
 *     к тексту пользовательского хода в emitBaseSnapshot;
 *   • после прихода текста — дебаунс 250 мс и повторный снимок базы;
 *   • пока очередь не пуста, gfPendingCount()>0 и база не объявляется полной.
 *
 * Лимиты: 200 000 символов текста на файл, 2 000 000 на чат, тело файла
 * 200 КБ, таймаут запроса 15 с.
 *
 * Контракт связки: только __bind(deps) из core/gemini-intercept.js.
 *   emitSnapshot — форвардер emitBaseSnapshot;
 *   getConvId     — текущий разговор;
 *   originalFetch — нативный fetch;
 *   diagLine      — диагностика под гейтом aiCmDebug.
 * Сброс: gfReset(convId) на SPA-переходе.
 */
(function () {
  if (typeof window !== 'undefined' && window.AiCmGeminiFiles) return;

  var D = null;
  var Fn = {};

  // ===== СЕКЦИЯ 1: КОНСТАНТЫ И СОСТОЯНИЕ =====
  var GF_CONCURRENCY = 2;
  var GF_TEXT_CAP = 200000;
  var GF_TOTAL_CAP = 2000000;
  var GF_TIMEOUT_MS = 15000;
  var GF_EMIT_DEBOUNCE_MS = 250;
  var GF_DRAIN_TIMEOUT_MS = 6000;
  var GF_BODY_MAX = 200 * 1024;

  // Карта сообщений: `<convId>\u0000<msgId>` -> { convId, msgId, refs:[], recs:{} }.
  var gfMsgs = {};
  // Израсходованный кап чата: convId -> символов уже отдано в текст.
  var gfCharsByChat = {};
  // Очередь FIFO + карта дедупа convId|token|name + счётчики активных.
  var gfQueue = [];
  var gfQueueByKey = {};
  var gfActive = 0;
  var gfActiveByChat = {};
  // Готовые записи по ключу дедупа: новый ход с тем же файлом получает текст
  // без повторного скачивания.
  var gfRecsByKey = {};
  // Поколение: reset делает результаты «старых» запросов недействительными.
  var gfEpoch = 0;
  var gfEmitTimer = null;
  var gfEmitChatId = '';
  var gfDrainWaiters = [];

  // ===== СЕКЦИЯ 2: ХЕЛПЕРЫ =====
  function gfStr(v) {
    return (typeof v === 'string') ? v : '';
  }

  function gfNum(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
    return 0;
  }

  function gfMsgKey(convId, msgId) {
    return gfStr(convId) + '\u0000' + gfStr(msgId);
  }

  function gfDedupeKey(convId, ref) {
    return gfStr(convId) + '|' + gfStr(ref && ref.token) + '|' + gfStr(ref && ref.name);
  }

  function gfCurrentConvId() {
    try {
      if (D && typeof D.getConvId === 'function') return gfStr(D.getConvId());
      if (D && typeof D.currentChatId === 'string') return D.currentChatId;
    } catch (eConv) { }
    return '';
  }

  function gfBridgeDetail(ev) {
    var raw = (ev && ev.detail !== undefined) ? ev.detail : null;
    if (typeof raw !== 'string') return raw || null;
    try { return JSON.parse(raw); } catch (eBd) { return null; }
  }

  function gfDiag(tag, fields) {
    try {
      if (typeof aiCmDiagLine === 'function') { aiCmDiagLine('gemini-files-' + tag, fields); return; }
      if (D && typeof D.diagLine === 'function') D.diagLine('files-' + tag, fields);
    } catch (eDiag) { }
  }

  function gfWarn(tag, msg, e) {
    if (typeof aiCmDiagWarn === 'function') aiCmDiagWarn(tag, msg, e);
  }

  function gfBytes(n) {
    var v = gfNum(n);
    return (v > 0) ? (String(v) + ' Б') : 'размер неизвестен';
  }

  // ===== СЕКЦИЯ 3: НОРМАЛИЗАЦИЯ ВЛОЖЕНИЙ =====
  // Полная форма узла описана в plan-gemini-attachments.md. Функция не бросает и
  // возвращает null для мусора; collectTurnFiles фильтрует такие узлы.
  function gfRefFromNode(n) {
    try {
      if (!Array.isArray(n)) return null;
      var name = (typeof n[2] === 'string') ? n[2].trim() : '';
      if (!name) return null;
      var mime = (typeof n[11] === 'string') ? n[11] : '';
      var type = (typeof n[1] === 'number') ? n[1] : 0;
      var token = (typeof n[5] === 'string') ? n[5] : '';
      var img = (typeof n[3] === 'string') ? n[3] : '';
      var dl = '';
      var urls = [];
      (function walk(v) {
        if (typeof v === 'string') {
          if (v) urls.push(v);
          if (!dl && v.indexOf('contribution.usercontent.google.com/download') !== -1) dl = v;
        } else if (Array.isArray(v)) {
          for (var i = 0; i < v.length; i++) walk(v[i]);
        }
      })(n[7]);
      return {
        name: name,
        mime: mime,
        type: type,
        token: token,
        img: img,
        dl: dl,
        urls: urls,
        isImage: (type === 1) || /^image\//i.test(mime)
      };
    } catch (e) { return null; }
  }

  function gfCollectTurnFiles(turn) {
    var out = [];
    try {
      var arr = turn[2][0][4][0][4];
      if (!Array.isArray(arr)) return out;
      for (var i = 0; i < arr.length; i++) {
        var ref = gfRefFromNode(arr[i]);
        if (ref) out.push(ref);
      }
    } catch (e) { }
    return out;
  }

  // Объект от парсера (collectTurnFiles) или сырой узел — приводим к ref.
  function gfNormalizeRef(o) {
    if (Array.isArray(o)) return gfRefFromNode(o);
    if (!o || typeof o !== 'object') return null;
    var name = gfStr(o.name).trim();
    if (!name) return null;
    var mime = gfStr(o.mime);
    var type = gfNum(o.type);
    return {
      name: name,
      mime: mime,
      type: type,
      token: gfStr(o.token),
      img: gfStr(o.img),
      dl: gfStr(o.dl),
      urls: Array.isArray(o.urls) ? o.urls.slice() : [],
      isImage: (o.isImage === true) || (type === 1) || /^image\//i.test(mime)
    };
  }

  function gfIsPdf(ref) {
    return /application\/pdf/i.test(gfStr(ref && ref.mime)) || /\.pdf$/i.test(gfStr(ref && ref.name));
  }

  function gfIsDocx(ref) {
    return /wordprocessingml\.document/i.test(gfStr(ref && ref.mime)) || /\.docx$/i.test(gfStr(ref && ref.name));
  }

  var GF_TEXT_MIME_RE = /^text\/[a-z0-9.+-]*$/i;
  var GF_TEXT_APP_RE = /^application\/(json|xml|xhtml\+xml|javascript|ecmascript|x-yaml|yaml|csv)\b/i;
  var GF_TEXT_EXT_RE = /\.(txt|text|md|markdown|json|jsonl|csv|tsv|log|xml|html?|css|yml|yaml|ini|cfg|conf|sql|srt|vtt)$/i;

  function gfIsText(ref) {
    var mime = gfStr(ref && ref.mime);
    if (GF_TEXT_MIME_RE.test(mime) || GF_TEXT_APP_RE.test(mime)) return true;
    return GF_TEXT_EXT_RE.test(gfStr(ref && ref.name));
  }

  function gfNote(ref, size) {
    var mime = gfStr(ref && ref.mime) || 'application/octet-stream';
    return mime + ', ' + gfBytes(size) + ', текст не получен';
  }

  // Секция вложения. URL изображения — единственное место, где ссылка попадает
  // в текст; download-URL документов (с токеном доступа) не экспортируется.
  function gfSection(rec) {
    var name = gfStr(rec && rec.name) || 'attachment';
    if (rec && rec.isImage) {
      var url = gfStr(rec.url);
      return '\n\n[IMAGE: ' + name + ']' + (url ? ' ' + url : '');
    }
    if (rec && rec.ok === true && gfStr(rec.text)) {
      return '\n\n[FILE: ' + name + ']\n' + rec.text;
    }
    if (rec && gfStr(rec.note)) {
      return '\n\n[FILE: ' + name + ' — ' + rec.note + ']';
    }
    var reason = gfStr(rec && rec.reason);
    return '\n\n[FILE: ' + name + ' — текст не получен' + (reason ? ': ' + reason : '') + ']';
  }

  // ===== СЕКЦИЯ 4: КАРТА СООБЩЕНИЙ =====
  function gfMsgEntry(convId, msgId) {
    var key = gfMsgKey(convId, msgId);
    var m = gfMsgs[key];
    if (!m) {
      m = { convId: gfStr(convId), msgId: gfStr(msgId), refs: [], recs: {} };
      gfMsgs[key] = m;
    }
    return m;
  }

  function gfApplyRec(msgKey, ref, rec) {
    var m = gfMsgs[msgKey];
    if (!m) return false;
    m.recs[ref.dk] = rec;
    return true;
  }

  function gfSectionsFor(convId, msgId) {
    var m = gfMsgs[gfMsgKey(convId, msgId)];
    if (!m || !m.refs.length) return '';
    var out = '';
    for (var i = 0; i < m.refs.length; i++) {
      var rec = m.recs[m.refs[i].dk];
      if (rec) out += gfSection(rec);
    }
    return out;
  }

  function gfSectionLength(convId, msgId) {
    var m = gfMsgs[gfMsgKey(convId, msgId)];
    if (!m || !m.refs.length) return 0;
    var n = 0;
    for (var i = 0; i < m.refs.length; i++) {
      var rec = m.recs[m.refs[i].dk];
      if (rec) n += gfSection(rec).length;
    }
    return n;
  }

  function gfTextsCount() {
    var keys = Object.keys(gfMsgs);
    var n = 0;
    for (var i = 0; i < keys.length; i++) {
      var m = gfMsgs[keys[i]];
      if (!m) continue;
      var rk = Object.keys(m.recs);
      for (var j = 0; j < rk.length; j++) {
        if (m.recs[rk[j]] && gfStr(m.recs[rk[j]].text)) { n++; break; }
      }
    }
    return n;
  }

  function gfPendingCount(convId) {
    var cid = gfStr(convId);
    var n = 0;
    for (var i = 0; i < gfQueue.length; i++) {
      if (!cid || gfQueue[i].chatId === cid) n++;
    }
    n += cid ? (gfActiveByChat[cid] || 0) : gfActive;
    if (gfEmitTimer !== null && (!cid || gfEmitChatId === cid)) n++;
    return n;
  }

  // ===== СЕКЦИЯ 5: ПРОТОКОЛ ОЖИДАНИЯ ОЧЕРЕДИ =====
  function gfStateRespond() {
    try {
      if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
      window.dispatchEvent(new CustomEvent('ai-cm-deepseek-files-state-response', {
        detail: {
          pending: gfPendingCount(),
          active: gfActive,
          queued: gfQueue.length,
          texts: gfTextsCount()
        }
      }));
    } catch (eState) {
      gfWarn('gemini:files:state', '[gemini-files] состояние очереди вложений:', eState);
    }
  }

  function gfDrainRespond(requestId, detail) {
    try {
      var payload = { requestId: requestId };
      var keys = Object.keys(detail || {});
      for (var i = 0; i < keys.length; i++) payload[keys[i]] = detail[keys[i]];
      if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
      window.dispatchEvent(new CustomEvent('ai-cm-deepseek-files-drain-done', { detail: payload }));
    } catch (eDone) {
      gfWarn('gemini:files:drain', '[gemini-files] ответ на ожидание очереди:', eDone);
    }
  }

  function gfDrainSettle(w, reason) {
    var idx = gfDrainWaiters.indexOf(w);
    if (idx === -1) return;
    gfDrainWaiters.splice(idx, 1);
    if (w.timer !== null) { clearTimeout(w.timer); w.timer = null; }
    gfDrainRespond(w.requestId, {
      ok: reason === 'drained',
      drained: reason === 'drained',
      reason: reason,
      pending: gfPendingCount(),
      waitedMs: Date.now() - w.at
    });
  }

  function gfDrainKick(reason) {
    if (!gfDrainWaiters.length || gfPendingCount() > 0) return;
    var waiters = gfDrainWaiters.slice();
    for (var i = 0; i < waiters.length; i++) gfDrainSettle(waiters[i], reason || 'drained');
  }

  function gfDrainHandle(detail) {
    var reqId = detail && detail.requestId;
    if (!reqId) return;
    var cap = (detail && typeof detail.timeoutMs === 'number' && detail.timeoutMs > 0)
      ? detail.timeoutMs : GF_DRAIN_TIMEOUT_MS;
    if (gfPendingCount() === 0) {
      gfDrainRespond(reqId, { ok: true, drained: true, reason: 'idle', pending: 0, waitedMs: 0 });
      return;
    }
    var w = { requestId: String(reqId), at: Date.now(), timer: null };
    w.timer = setTimeout(function () { gfDrainSettle(w, 'file-queue-timeout'); }, cap);
    gfDrainWaiters.push(w);
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('ai-cm-deepseek-files-state-request', function () { gfStateRespond(); });
    window.addEventListener('ai-cm-deepseek-files-drain', function (ev) { gfDrainHandle(gfBridgeDetail(ev)); });
  }

  // ===== СЕКЦИЯ 6: СКАЧИВАНИЕ И РАЗБОР ТЕЛА =====
  function gfFetchImpl() {
    var f = null;
    try { f = D ? D.originalFetch : null; } catch (eF) { f = null; }
    if (typeof f === 'function') return f;
    if (typeof window !== 'undefined' && typeof window.fetch === 'function') return window.fetch;
    return null;
  }

  function gfHeader(res, name) {
    try {
      if (res && res.headers && typeof res.headers.get === 'function') return gfStr(res.headers.get(name));
    } catch (eH) { }
    return '';
  }

  // v2.1: полный размер PDF из content-range ответа на Range: bytes=0-0.
  // Сервер отдаёт «bytes 0-0/12345» (или «bytes */12345»); иначе — 0.
  function gfSizeFromContentRange(v) {
    var s = gfStr(v);
    if (!s) return 0;
    var m = /(?:^|\s)(?:\d+-\d+|\*)\/(\d+)\s*$/.exec(s);
    if (!m) return 0;
    var n = gfNum(m[1]);
    return (n > 0) ? n : 0;
  }

  function gfCancelBody(res, ctrl) {
    try {
      if (res && res.body && typeof res.body.cancel === 'function') {
        var p = res.body.cancel();
        if (p && typeof p.catch === 'function') p.catch(function () { });
      }
    } catch (eCancel) { }
    try { if (ctrl) ctrl.abort(); } catch (eAbort) { }
  }

  function gfCapText(text) {
    var s = gfStr(text);
    if (s.length <= GF_TEXT_CAP) return { text: s, truncated: false };
    var cut = s.length - GF_TEXT_CAP;
    var suffix = '\n…[обрезано ' + cut + ']';
    var keep = GF_TEXT_CAP - suffix.length;
    if (keep < 0) keep = 0;
    return { text: s.slice(0, keep) + suffix, truncated: true };
  }

  function gfFetchFile(item) {
    var fetchImpl = gfFetchImpl();
    if (!fetchImpl) return Promise.resolve({ ok: false, reason: 'no-fetch', text: '' });
    var url = gfStr(item && item.url);
    if (!url) return Promise.resolve({ ok: false, reason: 'no-url', text: '' });
    var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    var isPdf = gfIsPdf(item && item.ref);
    var opts = { method: 'GET', credentials: 'include' };
    // v2.1: PDF не тянем целиком — просим первый байт. Сервер отвечает 206 и
    // content-range с полным размером; Range «bytes=0-0» — safelisted (без preflight).
    if (isPdf) opts.headers = { 'Range': 'bytes=0-0' };
    if (ctrl && ctrl.signal) opts.signal = ctrl.signal;
    return new Promise(function (resolve) {
      var settled = false;
      var timer = null;
      function done(res) {
        if (settled) return;
        settled = true;
        if (timer !== null) { clearTimeout(timer); timer = null; }
        resolve(res || { ok: false, reason: 'empty', text: '' });
      }
      timer = setTimeout(function () {
        if (ctrl) { try { ctrl.abort(); } catch (eAbort) { gfWarn('gemini:files:abort', '[gemini-files] abort вложения:', eAbort); } }
        done({ ok: false, reason: 'timeout', text: '' });
      }, GF_TIMEOUT_MS);
      var p;
      try { p = fetchImpl(url, opts); } catch (eFetch) {
        gfWarn('gemini:files:fetch', '[gemini-files] fetch вложения упал:', eFetch);
        done({ ok: false, reason: 'fetch-throw', text: '' });
        return;
      }
      Promise.resolve(p).then(function (res) {
        if (!res || res.ok !== true) {
          gfCancelBody(res, ctrl);
          done({ ok: false, reason: 'http-' + ((res && res.status) || '?'), text: '' });
          return;
        }
        // PDF: текст не извлекаем, но размер нужен для мета-секции.
        // Range-ответ даёт полный размер в content-range; content-length — запасной
        // путь для серверов, игнорирующих Range. Тело сразу отменяем.
        if (isPdf) {
          var pdfSize = gfSizeFromContentRange(gfHeader(res, 'content-range'));
          // 206 без разбираемого content-range — размер неизвестен: content-length
          // у частичного ответа равен 1, а не полному размеру файла.
          if (!pdfSize && (!res || res.status !== 206)) pdfSize = gfNum(gfHeader(res, 'content-length'));
          gfCancelBody(res, ctrl);
          done({ ok: false, pdf: true, size: pdfSize, reason: 'pdf-no-text', text: '' });
          return;
        }
        var clen = gfNum(gfHeader(res, 'content-length'));
        if (clen > GF_BODY_MAX) { gfCancelBody(res, ctrl); done({ ok: false, reason: 'too-large', text: '' }); return; }
        if (gfIsDocx(item.ref)) {
          if (typeof res.arrayBuffer !== 'function') { done({ ok: false, reason: 'body-error', text: '' }); return; }
          var ab;
          try { ab = res.arrayBuffer(); } catch (eAb) {
            gfWarn('gemini:files:body', '[gemini-files] arrayBuffer DOCX упал:', eAb);
            done({ ok: false, reason: 'body-error', text: '' });
            return;
          }
          return Promise.resolve(ab).then(function (buf) {
            var u8 = new Uint8Array(buf || new ArrayBuffer(0));
            if (u8.length > GF_BODY_MAX) { done({ ok: false, reason: 'too-large', text: '' }); return; }
            gfDocxText(u8).then(function (parsed) {
              done(parsed);
            }, function (eDocx) {
              gfWarn('gemini:files:docx', '[gemini-files] DOCX не разобран:', eDocx);
              done({ ok: false, reason: 'docx-error', text: '' });
            });
          }, function (eBody) {
            gfWarn('gemini:files:body', '[gemini-files] тело DOCX не прочитано:', eBody);
            done({ ok: false, reason: 'body-error', text: '' });
          });
        }
        if (typeof res.text !== 'function') { done({ ok: false, reason: 'body-error', text: '' }); return; }
        return Promise.resolve(res.text()).then(function (raw) {
          var text = gfStr(raw);
          if (text.length > GF_BODY_MAX) { done({ ok: false, reason: 'too-large', text: '' }); return; }
          if (!text) { done({ ok: false, reason: 'empty-body', text: '' }); return; }
          done({ ok: true, text: text, truncated: false });
        }, function (eBody) {
          gfWarn('gemini:files:body', '[gemini-files] тело вложения не прочитано:', eBody);
          done({ ok: false, reason: 'body-error', text: '' });
        });
      }, function (eNet) {
        gfWarn('gemini:files:net', '[gemini-files] сеть вложения:', eNet);
        done({ ok: false, reason: 'network', text: '' });
      });
    });
  }

  // ---- DOCX: zip → word/document.xml → текст ----
  function gfU16(b, o) {
    return (b[o] | (b[o + 1] << 8)) & 0xffff;
  }

  function gfU32(b, o) {
    return ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0);
  }

  function gfUtf8(b) {
    try {
      if (typeof TextDecoder === 'function') return new TextDecoder('utf-8').decode(b);
    } catch (eTd) { }
    var s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
  }

  function gfFindEocd(b) {
    var start = Math.max(0, b.length - 65557);
    for (var i = b.length - 22; i >= start; i--) {
      if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) return i;
    }
    return -1;
  }

  function gfZipEntry(b) {
    var e = gfFindEocd(b);
    if (e >= 0) {
      var count = gfU16(b, e + 10);
      var p = gfU32(b, e + 16);
      for (var i = 0; i < count && p + 46 <= b.length; i++) {
        if (gfU32(b, p) !== 0x02014b50) break;
        var method = gfU16(b, p + 10);
        var csize = gfU32(b, p + 20);
        var nlen = gfU16(b, p + 28);
        var elen = gfU16(b, p + 30);
        var clen = gfU16(b, p + 32);
        var lho = gfU32(b, p + 42);
        var name = gfUtf8(b.subarray(p + 46, p + 46 + nlen));
        if (name === 'word/document.xml') {
          if (lho + 30 > b.length || gfU32(b, lho) !== 0x04034b50) return null;
          var dataOff = lho + 30 + gfU16(b, lho + 26) + gfU16(b, lho + 28);
          if (dataOff + csize > b.length) return null;
          return { method: method, data: b.subarray(dataOff, dataOff + csize) };
        }
        p += 46 + nlen + elen + clen;
      }
    }
    // Фолбэк: zip без центрального каталога (или каталог за пределами капа) —
    // ищем local header по имени.
    for (var q = 0; q + 30 <= b.length; q++) {
      if (gfU32(b, q) !== 0x04034b50) continue;
      var ln = gfU16(b, q + 26);
      var le = gfU16(b, q + 28);
      var lname = gfUtf8(b.subarray(q + 30, q + 30 + ln));
      if (lname !== 'word/document.xml') continue;
      var m2 = gfU16(b, q + 8);
      var cs = gfU32(b, q + 18);
      var off = q + 30 + ln + le;
      if (!cs) {
        // data descriptor: до следующего local header
        var next = b.length;
        for (var r = off; r + 4 <= b.length; r++) {
          if (gfU32(b, r) === 0x04034b50) { next = r; break; }
        }
        cs = next - off;
      }
      if (off + cs > b.length) continue;
      return { method: m2, data: b.subarray(off, off + cs) };
    }
    return null;
  }

  function gfInflateRaw(data) {
    if (typeof DecompressionStream !== 'function') {
      return Promise.resolve({ ok: false, reason: 'no-decompression-stream', text: '' });
    }
    return new Promise(function (resolve) {
      try {
        var ds = new DecompressionStream('deflate-raw');
        var writer = ds.writable.getWriter();
        var reader = ds.readable.getReader();
        var chunks = [];
        var total = 0;
        function pump() {
          return reader.read().then(function (r) {
            if (r && r.done) {
              var out = new Uint8Array(total);
              var at = 0;
              for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], at); at += chunks[i].length; }
              resolve({ ok: true, bytes: out });
              return;
            }
            if (r && r.value && r.value.length) { chunks.push(r.value); total += r.value.length; }
            return pump();
          }, function () {
            resolve({ ok: false, reason: 'inflate-fail', text: '' });
          });
        }
        writer.write(data).then(function () { return writer.close(); }).catch(function () { });
        pump();
      } catch (eDs) {
        resolve({ ok: false, reason: 'inflate-throw', text: '' });
      }
    });
  }

  function gfXmlDecode(s) {
    return s
      .replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCodePoint(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (m, d) { return String.fromCodePoint(parseInt(d, 10)); })
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  function gfDocxTextFromXml(xml) {
    var s = gfStr(xml)
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '');
    s = gfXmlDecode(s);
    s = s.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
    return s.trim();
  }

  function gfDocxText(u8) {
    var entry = gfZipEntry(u8);
    if (!entry || !entry.data || !entry.data.length) {
      return Promise.resolve({ ok: false, reason: 'no-document-xml', text: '' });
    }
    function fromXml(xml) {
      var txt = gfDocxTextFromXml(xml);
      if (!txt) return { ok: false, reason: 'empty-docx', text: '' };
      return { ok: true, text: txt, truncated: false };
    }
    if (entry.method === 0) return Promise.resolve(fromXml(gfUtf8(entry.data)));
    if (entry.method !== 8) return Promise.resolve({ ok: false, reason: 'zip-method-' + entry.method, text: '' });
    return gfInflateRaw(entry.data).then(function (inf) {
      if (!inf || inf.ok !== true) return { ok: false, reason: (inf && inf.reason) || 'inflate-fail', text: '' };
      return fromXml(gfUtf8(inf.bytes));
    }, function () {
      return { ok: false, reason: 'inflate-fail', text: '' };
    });
  }

  // ===== СЕКЦИЯ 7: ОЧЕРЕДЬ, РЕЗУЛЬТАТ, РЕ-ЭМИТ =====
  function gfRecFromResult(item, res) {
    var r = res || {};
    if (r.pdf === true) {
      return {
        name: item.ref.name,
        isImage: false,
        ok: false,
        text: '',
        note: gfNote(item.ref, r.size),
        reason: 'pdf-no-text',
        truncated: false,
        chars: 0,
        at: item.doneAt || 0
      };
    }
    var ok = r.ok === true && gfStr(r.text) !== '';
    return {
      name: item.ref.name,
      isImage: false,
      ok: ok,
      text: ok ? gfStr(r.text) : '',
      note: '',
      reason: ok ? '' : (gfStr(r.reason) || 'empty'),
      truncated: ok ? (r.truncated === true) : false,
      chars: ok ? gfStr(r.text).length : 0,
      at: item.doneAt || 0
    };
  }

  function gfOnFetched(item, res) {
    item.doneAt = Date.now();
    item.result = (res && typeof res === 'object') ? res : { ok: false, reason: 'empty', text: '' };
    var rec = gfRecFromResult(item, item.result);
    if (rec.ok) {
      var cid = gfStr(item.chatId);
      var used = gfCharsByChat[cid] || 0;
      var room = GF_TOTAL_CAP - used;
      if (room <= 0) {
        rec.ok = false;
        rec.text = '';
        rec.reason = 'chat-cap';
      } else {
        var capped = gfCapText(rec.text);
        var text = capped.text;
        var truncated = capped.truncated === true;
        if (text.length > room) { text = text.slice(0, room); truncated = true; }
        rec.text = text;
        rec.truncated = truncated;
        rec.chars = text.length;
        gfCharsByChat[cid] = used + text.length;
      }
    }
    item.state = rec.ok ? 'done' : 'failed';
    gfRecsByKey[item.dk] = rec;
    if (gfQueueByKey[item.dk] === item) delete gfQueueByKey[item.dk];
    var keys = Object.keys(item.targets || {});
    var applied = 0;
    for (var i = 0; i < keys.length; i++) {
      if (gfApplyRec(keys[i], item.ref, rec)) applied++;
    }
    if (rec.ok) {
      gfDiag('fetch-done', {
        file: item.ref.name,
        chars: rec.chars,
        truncated: rec.truncated === true,
        turns: keys.length,
        applied: applied
      });
    } else {
      gfDiag('fetch-fail', {
        file: item.ref.name,
        mime: item.ref.mime,
        reason: rec.reason || 'empty',
        applied: applied
      });
      gfWarn('gemini:files:fetch', '[gemini-files] текст вложения не получен: ' + item.ref.name + ' reason=' + (rec.reason || '-'));
    }
    gfScheduleEmit(item.chatId);
  }

  function gfStartFetch(item) {
    item.startedAt = Date.now();
    item.state = 'active';
    gfActive++;
    gfActiveByChat[item.chatId] = (gfActiveByChat[item.chatId] || 0) + 1;
    gfFetchFile(item).then(function (res) {
      gfActive--;
      if (gfActive < 0) gfActive = 0;
      gfActiveByChat[item.chatId] = Math.max(0, (gfActiveByChat[item.chatId] || 0) - 1);
      if (item.epoch !== gfEpoch) { pumpQueue(); return; }
      gfOnFetched(item, res);
      gfDrainKick('drained');
      pumpQueue();
    }, function () {
      gfActive--;
      if (gfActive < 0) gfActive = 0;
      gfActiveByChat[item.chatId] = Math.max(0, (gfActiveByChat[item.chatId] || 0) - 1);
      if (item.epoch !== gfEpoch) { pumpQueue(); return; }
      gfOnFetched(item, { ok: false, reason: 'reject', text: '' });
      gfDrainKick('drained');
      pumpQueue();
    });
  }

  function pumpQueue() {
    while (gfActive < GF_CONCURRENCY && gfQueue.length > 0) {
      var item = gfQueue.shift();
      if (!item || item.state !== 'queued') continue;
      gfStartFetch(item);
    }
  }

  function gfQueueFile(chatId, msgKey, ref) {
    var cid = gfStr(chatId);
    var known = gfQueueByKey[ref.dk];
    if (known) {
      known.targets[msgKey] = 1;
      if (known.result) gfApplyRec(msgKey, ref, gfRecsByKey[ref.dk] || gfRecFromResult(known, known.result));
      return false;
    }
    if (gfRecsByKey[ref.dk]) {
      gfApplyRec(msgKey, ref, gfRecsByKey[ref.dk]);
      return false;
    }
    var item = {
      dk: ref.dk,
      chatId: cid,
      ref: ref,
      url: ref.dl || ref.img,
      targets: {},
      result: null,
      state: 'queued',
      epoch: gfEpoch,
      startedAt: 0,
      doneAt: 0
    };
    item.targets[msgKey] = 1;
    gfQueueByKey[ref.dk] = item;
    gfQueue.push(item);
    pumpQueue();
    return true;
  }

  function gfEnqueueTurnFiles(convId, msgId, files) {
    try {
      if (!Array.isArray(files) || !files.length) return 0;
      var mid = gfStr(msgId);
      if (!mid) return 0;
      var cid = gfStr(convId) || gfCurrentConvId();
      var cur = gfCurrentConvId();
      if (cur && cid && cur !== cid) {
        gfDiag('enqueue-skip', { reason: 'other-chat' });
        return 0;
      }
      var m = gfMsgEntry(cid, mid);
      var oldRecs = m.recs || {};
      var refs = [];
      var seen = {};
      for (var i = 0; i < files.length; i++) {
        var ref = gfNormalizeRef(files[i]);
        if (!ref) continue;
        ref.dk = gfDedupeKey(cid, ref);
        if (seen[ref.dk]) continue;
        seen[ref.dk] = 1;
        refs.push(ref);
      }
      if (!refs.length) return 0;
      m.refs = refs;
      m.recs = {};
      var msgKey = gfMsgKey(cid, mid);
      var queued = 0;
      for (var j = 0; j < refs.length; j++) {
        var r = refs[j];
        if (oldRecs[r.dk]) { m.recs[r.dk] = oldRecs[r.dk]; continue; }
        if (gfRecsByKey[r.dk]) { m.recs[r.dk] = gfRecsByKey[r.dk]; continue; }
        if (r.isImage) {
          var imgRec = {
            name: r.name, isImage: true, ok: false, text: '',
            url: r.img, note: '', reason: '', truncated: false, chars: 0, at: 0
          };
          gfRecsByKey[r.dk] = imgRec;
          m.recs[r.dk] = imgRec;
          continue;
        }
        if (gfIsPdf(r) && !r.dl) {
          var pdfRec = {
            name: r.name, isImage: false, ok: false, text: '',
            note: gfNote(r, 0), reason: 'pdf-no-url', truncated: false, chars: 0, at: 0
          };
          gfRecsByKey[r.dk] = pdfRec;
          m.recs[r.dk] = pdfRec;
          continue;
        }
        if (!r.dl) {
          m.recs[r.dk] = {
            name: r.name, isImage: false, ok: false, text: '', note: '',
            reason: 'no-url', truncated: false, chars: 0, at: 0
          };
          continue;
        }
        if (!gfIsPdf(r) && !gfIsDocx(r) && !gfIsText(r)) {
          var noteRec = {
            name: r.name, isImage: false, ok: false, text: '',
            note: gfNote(r, 0), reason: 'unsupported-mime', truncated: false, chars: 0, at: 0
          };
          gfRecsByKey[r.dk] = noteRec;
          m.recs[r.dk] = noteRec;
          continue;
        }
        gfQueueFile(cid, msgKey, r);
        queued++;
      }
      if (queued) {
        gfDiag('enqueue', {
          chat: cid.slice(0, 8),
          files: refs.length,
          queued: queued,
          pending: gfPendingCount(cid)
        });
      }
      return queued;
    } catch (eEnq) {
      gfWarn('gemini:files:enqueue', '[gemini-files] постановка вложений в очередь:', eEnq);
      return 0;
    }
  }

  function gfScheduleEmit(chatId) {
    if (typeof setTimeout !== 'function') return;
    gfEmitChatId = gfStr(chatId);
    if (gfEmitTimer !== null) { clearTimeout(gfEmitTimer); gfEmitTimer = null; }
    gfEmitTimer = setTimeout(gfEmitNow, GF_EMIT_DEBOUNCE_MS);
  }

  function gfEmitNow() {
    if (gfEmitTimer !== null) { clearTimeout(gfEmitTimer); gfEmitTimer = null; }
    gfEmitChatId = '';
    if (D && typeof D.emitSnapshot === 'function') {
      try { D.emitSnapshot(); } catch (eEmit) {
        gfWarn('gemini:files:emit', '[gemini-files] ре-эмит после вложения:', eEmit);
      }
    }
    gfDrainKick('drained');
  }

  function gfReset(convId) {
    gfEpoch++;
    gfMsgs = {};
    gfCharsByChat = {};
    gfQueue = [];
    gfQueueByKey = {};
    gfRecsByKey = {};
    gfActive = 0;
    gfActiveByChat = {};
    gfDrainWaiters.length = 0;
    if (gfEmitTimer !== null) { clearTimeout(gfEmitTimer); gfEmitTimer = null; }
    gfEmitChatId = '';
    gfDiag('reset', { chat: gfStr(convId).slice(0, 8) });
    return true;
  }

  function gfStats() {
    return {
      queued: gfQueue.length,
      active: gfActive,
      pending: gfPendingCount(),
      texts: gfTextsCount(),
      messages: Object.keys(gfMsgs),
      chats: Object.keys(gfCharsByChat)
    };
  }

  // ===== СЕКЦИЯ 8: СВЯЗКА С ЯДРОМ =====
  function __bind(d) {
    D = d || null;
    return Fn;
  }

  Fn.gfEnqueueTurnFiles = gfEnqueueTurnFiles;
  Fn.gfSectionsFor = gfSectionsFor;
  Fn.gfSectionLength = gfSectionLength;
  Fn.gfPendingCount = gfPendingCount;
  Fn.gfReset = gfReset;
  Fn.gfStats = gfStats;
  Fn.enqueueTurnFiles = gfEnqueueTurnFiles;
  Fn.sectionsFor = gfSectionsFor;
  Fn.sectionLength = gfSectionLength;
  Fn.pendingCount = gfPendingCount;
  Fn.reset = gfReset;
  Fn.stats = gfStats;
  Fn.refFromNode = gfRefFromNode;
  Fn.collectTurnFiles = gfCollectTurnFiles;
  Fn.sectionOf = gfSection;
  Fn.fetchFile = gfFetchFile;
  Fn.stateRespond = gfStateRespond;
  Fn.messages = function () { return gfMsgs; };
  Fn.constants = {
    concurrency: GF_CONCURRENCY,
    textCap: GF_TEXT_CAP,
    totalCap: GF_TOTAL_CAP,
    timeoutMs: GF_TIMEOUT_MS,
    emitDebounceMs: GF_EMIT_DEBOUNCE_MS,
    drainTimeoutMs: GF_DRAIN_TIMEOUT_MS,
    bodyMax: GF_BODY_MAX
  };
  Fn.__bind = __bind;

  if (typeof window !== 'undefined') window.AiCmGeminiFiles = Fn;
  if (typeof module !== 'undefined' && module.exports) module.exports = Fn;
})();
