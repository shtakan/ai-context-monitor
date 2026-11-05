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
    // Мост поднялся — сообщаем ему, что локальный разбор в странице доступен:
    // это его резервный путь при отвале порта в Firefox (фикс A2).
    emit('ai-cm-pdf-local-ready', { version: LOCAL_VERSION });
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

  // Xray (Firefox): байты приходят из другого realm. Там `instanceof ArrayBuffer`
  // ложен (Xray-обёртка не наследует конструктор песочницы), а `.slice()` на чужом
  // типизированном массиве падает на чтении `constructor` («constructor error»).
  // Поэтому класс определяем через Object.prototype.toString, а байты сразу
  // копируем в свой буфер: только он гарантированно transferable из этого realm.
  function isArrayBufferLike(buf) {
    if (buf == null) return false;
    try {
      return Object.prototype.toString.call(buf) === '[object ArrayBuffer]';
    } catch (eClass) {
      aiCmPdfWarn('array-buffer-class', eClass);
      return false;
    }
  }

  function copyBytes(src, len) {
    var out = new Uint8Array(len);
    try {
      out.set(src);
    } catch (eSet) {
      // set() через Xray может быть недоступен — построчная копия как резерв.
      aiCmPdfWarn('bytes-copy', eSet);
      for (var i = 0; i < len; i++) out[i] = src[i];
    }
    return out;
  }

  function toBytes(buf) {
    try {
      if (!buf) return null;
      if (isArrayBufferLike(buf)) return copyBytes(new Uint8Array(buf), buf.byteLength);
      if (buf && typeof buf.byteLength === 'number' && typeof buf.length === 'number') {
        return copyBytes(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), buf.byteLength);
      }
      return null;
    } catch (eBytes) {
      aiCmPdfWarn('to-bytes', eBytes);
      return null;
    }
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
      // Тело в try/catch: любая Xray-ошибка (срез чужого массива, конструктор
      // ArrayBuffer, transfer) должна оставить след [ai-cm-pdf], а не повиснуть.
      try {
        if (seq >= total) {
          done(total);
          return;
        }
        var start = seq * CHUNK;
        var end = Math.min(start + CHUNK, u8.length);
        // Копия в свой буфер: `.slice()` у чужого массива читает `constructor`
        // (в Firefox это «constructor error»), а buffer среза может остаться
        // чужим — такой ArrayBuffer нельзя передать в transfer.
        var copy = copyBytes(u8.subarray(start, end), end - start);
        var buf = copy.buffer;
        var msg = { source: SRC, id: id, seq: seq, total: total, bytes: buf };
        if (maxChars > 0) msg.maxChars = maxChars;
        seq++;
        window.postMessage(msg, '*', [buf]);
        setTimeout(next, 0);
      } catch (eChunk) {
        aiCmPdfWarn('chunk', eChunk);
        done(-1);
      }
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

  // Xray: Promise.resolve(чужой_promise) возвращает сам чужой promise (IsPromise
  // видит internal slot через обёртку), и следующий .then уходит за границу realm.
  // new Promise с явным .then забирает результат в этот realm — обе ветки целы.
  function adopt(thenable) {
    return new Promise(function (resolve, reject) {
      try {
        thenable.then(resolve, reject);
      } catch (eThen) {
        reject(eThen);
      }
    });
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
    return adopt(p).then(function (res) {
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
      return adopt(res.arrayBuffer()).then(function (buf) {
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

  // ===== A2: резервный разбор PDF прямо в странице (Firefox pdf-aborted) =====
  // Порядок в мосте: Port → один реконнект → этот разбор → pdf-aborted. Байты
  // уже лежат в MAIN, поэтому запрос и ответ идут postMessage/CustomEvent'ом:
  // ни base64, ни мегабайтов по messaging-каналу, ни зависимости от того, спит
  // ли event page Firefox.
  //
  // Это НЕ pdf.js и не замена ему: поддерживаются только content-стримы с
  // литеральными/hex-строками Tj/TJ и FlateDecode (DecompressionStream).
  // CID-шрифты и ToUnicode остаются за pdf.js-хостом — если локальный разбор
  // вернул пусто, мост всё равно пробует Port.
  var LOCAL_VERSION = '1.2.0';
  var LOCAL_SRC = 'ai-cm-pdf-local';
  var LOCAL_MAX_CHARS = 200000;
  var LOCAL_MAX_SEGMENTS = 4096;

  /** Байты → строка latin1 (код символа === байт): так индексы строки совпадают с индексами PDF. */
  function latin1(u8, from, to) {
    var s = '';
    var step = 0x8000;
    var end = (to === undefined) ? u8.length : to;
    for (var i = from; i < end; i += step) {
      s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + step, end)));
    }
    return s;
  }

  /** zlib-поток → байты; null, если DecompressionStream недоступен или поток битый. */
  function inflate(u8) {
    if (typeof DecompressionStream !== 'function') return Promise.resolve(null);
    var stream = null;
    try {
      stream = new DecompressionStream('deflate');
    } catch (eOpen) {
      aiCmPdfWarn('local-inflate-open', eOpen);
      return Promise.resolve(null);
    }
    var writer = stream.writable.getWriter();
    var reader = stream.readable.getReader();
    try {
      writer.write(u8).then(function () {
        return writer.close();
      }, function (eWrite) {
        aiCmPdfWarn('local-inflate-write', eWrite);
      }).then(null, function (eClose) {
        // Битый zlib отвечает ошибкой и на close — без обработчика это был бы
        // unhandled rejection страницы.
        aiCmPdfWarn('local-inflate-close', eClose);
      });
    } catch (ePost) {
      aiCmPdfWarn('local-inflate-write', ePost);
    }
    var parts = [];
    var total = 0;
    function pump() {
      return reader.read().then(function (step) {
        if (!step || step.done) {
          var out = new Uint8Array(total);
          var at = 0;
          for (var i = 0; i < parts.length; i++) {
            out.set(parts[i], at);
            at += parts[i].length;
          }
          return out;
        }
        var chunk = (step.value && typeof step.value.length === 'number') ? step.value : null;
        if (!chunk) return null;
        parts.push(chunk);
        total += chunk.length;
        return pump();
      });
    }
    return pump().then(null, function (eRead) {
      aiCmPdfWarn('local-inflate-read', eRead);
      return null;
    });
  }

  function segmentBytes(s) {
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xFF;
    return out;
  }

  /** PDF-строка: UTF-16BE по BOM (FE FF), иначе PDFDocEncoding ≈ latin1. */
  function decodeTextString(raw) {
    if (raw.length >= 2 && raw.charCodeAt(0) === 0xFE && raw.charCodeAt(1) === 0xFF) {
      var out = '';
      for (var i = 2; i + 1 < raw.length; i += 2) {
        out += String.fromCharCode((raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1));
      }
      return out;
    }
    return raw;
  }

  /** Литерал `(...)` с балансом скобок и escape-последовательностями. */
  function decodeLiteral(s, start) {
    var out = '';
    var depth = 1;
    var i = start + 1;
    var n = s.length;
    while (i < n && depth > 0) {
      var ch = s.charAt(i);
      if (ch === '\\') {
        var next = s.charAt(i + 1);
        i += 2;
        if (next === 'n') out += '\n';
        else if (next === 'r') out += '\r';
        else if (next === 't') out += '\t';
        else if (next === 'b') out += '\b';
        else if (next === 'f') out += '\f';
        else if (next === '\n') { /* склейка строк: символ не выводим */ }
        else if (next === '\r') { if (s.charAt(i) === '\n') i++; }
        else if (next >= '0' && next <= '7') {
          var oct = next;
          for (var k = 0; k < 2; k++) {
            var c2 = s.charAt(i);
            if (c2 >= '0' && c2 <= '7') { oct += c2; i++; } else break;
          }
          out += String.fromCharCode(parseInt(oct, 8) & 0xFF);
        } else out += next;
        continue;
      }
      if (ch === '(') { depth++; out += ch; i++; continue; }
      if (ch === ')') {
        depth--;
        i++;
        if (depth === 0) break;
        out += ch;
        continue;
      }
      out += ch;
      i++;
    }
    return { text: out, next: i };
  }

  /** Hex-строка `<48656C6C6F>` (не путать с `<<`-словарём). */
  function decodeHex(s, start) {
    var end = s.indexOf('>', start);
    if (end < 0) return { text: '', next: s.length };
    var hex = s.slice(start + 1, end).replace(/[^0-9A-Fa-f]/g, '');
    if (hex.length % 2 === 1) hex += '0';
    var out = '';
    for (var i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    return { text: out, next: end + 1 };
  }

  // ===== Фильтрация бинарного мусора в тексте (SOH, \x01, ESC) =====
  // Причина: у CID/Type0-шрифтов глифы приходят двухбайтовыми кодами
  // (`<000100020003>` Tj), а `\001` в литерале — восьмеричный escape. Без фильтра
  // такие коды уезжают в текст вложения управляющими символами.
  // Печатный: код > 31 вне 127…255; исключение — кириллица: Unicode 0x0400–0x04FF
  // и байты CP1251 0xC0–0xFF (PDFDocEncoding ≈ latin1).
  // v2.6 (CID-мусор): UTF-16BE-ветка `decodeTextString` собирает code point'ы из
  // двух байт, поэтому глифовые коды CID-шрифта приходят как U+FFFD, U+FFFE/FFFF
  // и U+E000–F8FF (зона приватного использования). Это не текст, а номера глифов:
  // раньше они проходили фильтр и раздували textLen. Теперь отбрасываются.
  function isPrintableCode(code) {
    if (code === 0x09 || code === 0x0A || code === 0x0D) return true;
    if (code < 0x20) return false;
    if (code >= 0x7F && code <= 0x9F) return false;
    if (code === 0xFFFD || code === 0xFFFE || code === 0xFFFF) return false;
    if (code >= 0xD800 && code <= 0xDFFF) return false;
    if (code >= 0xE000 && code <= 0xF8FF) return false;
    if (code >= 0x0400 && code <= 0x04FF) return true;
    if (code >= 0x80 && code <= 0xFF) return code >= 0xC0;
    return true;
  }

  /** Оставляет в строке потока только печатные символы. */
  function filterPrintable(raw) {
    var out = '';
    for (var i = 0; i < raw.length; i++) {
      var code = raw.charCodeAt(i);
      if (isPrintableCode(code)) out += raw.charAt(i);
    }
    return out;
  }

  /** Бинарный поток (программа шрифта, objstm, XMP): серия управляющих байтов. */
  function looksBinary(content) {
    var cap = Math.min(content.length, 8192);
    var run = 0;
    for (var i = 0; i < cap; i++) {
      var code = content.charCodeAt(i);
      if (code < 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D) {
        run++;
        if (run >= 8) return true;
      } else {
        run = 0;
      }
    }
    return false;
  }

  var SHOW_OPS = { Tj: true, TJ: true, "'": true, '"': true };
  var BREAK_OPS = { BT: true, ET: true, Tm: true, Td: true, TD: true, 'T*': true };

  function isOpChar(ch) {
    return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '"' || ch === "'";
  }

  /** Текст content-стрима: строки, привязанные к операторам показа Tj/TJ/'/". */
  function extractText(content, limit) {
    var cap = (typeof limit === 'number' && limit > 0) ? limit : LOCAL_MAX_CHARS;
    var out = '';
    var pending = '';
    var shown = 0;
    var i = 0;
    var n = content.length;
    function flushOp(op) {
      if (pending) {
        if (SHOW_OPS[op] === true) { out += pending; shown++; }
        pending = '';
      }
      if (SHOW_OPS[op] === true) {
        if (out && out.charAt(out.length - 1) !== '\n') out += ' ';
        return;
      }
      if (BREAK_OPS[op] === true && out && out.charAt(out.length - 1) !== '\n') out += '\n';
    }
    while (i < n && out.length < cap) {
      var ch = content.charAt(i);
      if (ch === '(') {
        var lit = decodeLiteral(content, i);
        pending += filterPrintable(decodeTextString(lit.text));
        i = lit.next;
        continue;
      }
      if (ch === '<') {
        if (content.charAt(i + 1) === '<') { i += 2; continue; }
        var hx = decodeHex(content, i);
        pending += filterPrintable(decodeTextString(hx.text));
        i = hx.next;
        continue;
      }
      if (ch === '>' && content.charAt(i + 1) === '>') { i += 2; continue; }
      if (isOpChar(ch)) {
        var start = i;
        while (i < n && isOpChar(content.charAt(i))) i++;
        flushOp(content.slice(start, i));
        continue;
      }
      i++;
    }
    // Поток без валидных операторов показа текста (шрифты, objstm, XMP) не даёт
    // ни символа: только строки под Tj/TJ/'/" попадают в результат.
    return shown > 0 ? out : '';
  }

  function countPages(all) {
    var m = all.match(/\/Type\s*\/Page(?![a-zA-Z])/g);
    return m ? m.length : 0;
  }

  /**
   * Похож ли собранный текст на мусор, а не на содержимое PDF.
   * Локальный разбор не читает ToUnicode, поэтому при CID-шрифтах вместо букв
   * приходят коды глифов. Признаки: доля replacement/private-use/управляющих
   * code point'ов выше 2%, текст без единого пробела на 400+ символов, или одна
   * «строка» длиннее 2000 символов без разрывов. В таких случаях текст
   * отбрасывается целиком (pdf-no-text), а не попадает в базу.
   * @param {string} text Собранный текст.
   * @returns {boolean} true — текст мусорный.
   */
  function localTextIsGarbage(text) {
    if (!text) return true;
    var total = text.length;
    var bad = 0;
    var spaces = 0;
    var longestRun = 0;
    var run = 0;
    for (var i = 0; i < total; i++) {
      var code = text.charCodeAt(i);
      var isBlank = (code === 0x20 || code === 0x09 || code === 0x0A || code === 0x0D);
      if (isBlank) { spaces++; run = 0; } else { run++; if (run > longestRun) longestRun = run; }
      if (code === 0xFFFD || code === 0xFFFE || code === 0xFFFF ||
          (code >= 0xD800 && code <= 0xDFFF) || (code >= 0xE000 && code <= 0xF8FF) ||
          (code < 0x20 && !isBlank) || (code >= 0x7F && code <= 0x9F)) bad++;
    }
    if (bad / total > 0.02) return true;
    if (total >= 400 && spaces / total < 0.005) return true;
    if (longestRun > 2000) return true;
    return !localTextLooksLikeLanguage(text);
  }

  /**
   * Похож ли текст на связный язык: среди «слов» должна быть заметная доля
   * таких, где есть латиница, кириллица или цифра. CID-мусор, декодированный
   * как latin1, даёт слова из символов ÿýþø — букв латиницы/кириллицы там нет,
   * зато они похожи на текст и проходят фильтр печатности. Проверка идёт по
   * первым 20000 символам: страница PDF этого хватает.
   * @param {string} text Проверяемый текст.
   * @returns {boolean} true — текст похож на язык.
   */
  function localTextLooksLikeLanguage(text) {
    var sample = text.length > 20000 ? text.slice(0, 20000) : text;
    var words = sample.split(/\s+/);
    var words_n = 0;
    var plausible = 0;
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (!w) continue;
      words_n++;
      if (/[a-zA-Zа-яА-ЯёЁ0-9]/.test(w)) plausible++;
    }
    if (words_n < 10) return true;
    return plausible / words_n >= 0.5;
  }

  /** EOL перед `endstream` — разделитель, а не данные: иначе zlib видит хвост. */
  function trimStreamEol(s) {
    var end = s.length;
    if (end > 0 && s.charAt(end - 1) === '\n') end--;
    if (end > 0 && s.charAt(end - 1) === '\r') end--;
    return end === s.length ? s : s.slice(0, end);
  }

  /** Стримы PDF со словарём (последние 4 КиБ перед `stream`) и телом. */
  function collectSegments(all) {
    var out = [];
    var from = 0;
    while (out.length < LOCAL_MAX_SEGMENTS) {
      var start = all.indexOf('stream', from);
      if (start < 0) break;
      if (start >= 3 && all.slice(start - 3, start) === 'end') { from = start + 6; continue; }
      var dict = all.slice(Math.max(0, start - 4096), start);
      var body = start + 6;
      if (all.charAt(body) === '\r') body++;
      if (all.charAt(body) === '\n') body++;
      var end = all.indexOf('endstream', body);
      if (end < 0) break;
      out.push({ dict: dict, body: all.slice(body, end) });
      from = end + 9;
    }
    return out;
  }

  function parseLocal(buf, opts) {
    var o = opts || {};
    var maxChars = num(o.maxChars) || LOCAL_MAX_CHARS;
    var u8 = toBytes(buf);
    if (!u8 || u8.length === 0) return Promise.resolve(fail('pdf-invalid', 0));
    if (u8.length > MAX_BYTES) return Promise.resolve(fail('pdf-too-large', u8.length));
    var all = latin1(u8, 0);
    if (all.indexOf('%PDF-') === -1) return Promise.resolve(fail('pdf-invalid', u8.length));
    var pages = countPages(all);
    var segments = collectSegments(all);
    var text = '';
    var index = 0;
    var truncated = false;
    function finish() {
      var out = text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
      // Вторая линия защиты: управляющие символы не должны дожить до вложения.
      out = out.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
      out = out.replace(/^\s+|\s+$/g, '');
      if (out.length > maxChars) {
        out = out.slice(0, maxChars);
        truncated = true;
      }
      if (!out || localTextIsGarbage(out)) return fail('pdf-no-text', u8.length);
      return { ok: true, text: out, pages: pages, truncated: truncated, reason: '', size: u8.length };
    }
    function step() {
      if (index >= segments.length || text.length >= maxChars) return Promise.resolve(finish());
      var seg = segments[index];
      index++;
      var dict = seg.dict;
      // 4 КиБ перед `stream` захватывают и предыдущие объекты, поэтому смотрим
      // словарь самого stream-объекта: от последнего «N 0 obj» до `stream`.
      var own = dict;
      var objRe = /(?:^|[\s>])\d+\s+\d+\s+obj\b/g;
      var lastObj = -1;
      var objHit;
      while ((objHit = objRe.exec(dict)) !== null) lastObj = objHit.index;
      if (lastObj >= 0) own = dict.slice(lastObj);
      var isImage = own.indexOf('/Image') !== -1 || own.indexOf('/DCTDecode') !== -1 ||
        own.indexOf('/JPXDecode') !== -1;
      // Программа шрифта, objstm, ICC-профиль и XMP — не content-стримы: в них
      // нет операторов показа текста, а байты после FlateDecode похожи на строки.
      var isBinaryDict = own.indexOf('/FontFile') !== -1 || own.indexOf('/Length1') !== -1 ||
        own.indexOf('/ObjStm') !== -1 || own.indexOf('/ICCBased') !== -1 ||
        own.indexOf('/Metadata') !== -1;
      if (isImage || isBinaryDict || !seg.body) return step();
      var bodyText = dict.indexOf('/FlateDecode') !== -1
        ? inflate(segmentBytes(trimStreamEol(seg.body))).then(function (bytes) {
          return bytes ? latin1(bytes, 0) : null;
        })
        : Promise.resolve(seg.body);
      return bodyText.then(function (content) {
        if (content && !looksBinary(content)) {
          var piece = extractText(content, maxChars);
          if (piece) {
            if (text) text += '\n';
            text += piece;
          }
        }
        return step();
      }, function (eStream) {
        aiCmPdfWarn('local-stream', eStream);
        return step();
      });
    }
    return step();
  }

  // Запрос локального разбора: изолированный мир → MAIN. Ответ уходит
  // 'ai-cm-pdf-local-result' (JSON-строка в detail, как остальные мосты).
  window.addEventListener('message', function (ev) {
    if (!ev || ev.source !== window) return;
    var data = ev.data;
    if (!data || data.source !== LOCAL_SRC) return;
    var id = (typeof data.id === 'string') ? data.id : '';
    if (!id) return;
    var started = nowMs();
    Promise.resolve(parseLocal(data.bytes, { maxChars: num(data.maxChars) })).then(function (res) {
      var out = (res && typeof res === 'object') ? res : fail('pdf-host-error', 0);
      out.id = id;
      out.ms = nowMs() - started;
      emit('ai-cm-pdf-local-result', out);
    }, function (eLocal) {
      aiCmPdfWarn('local-parse', eLocal);
      emit('ai-cm-pdf-local-result', {
        id: id, ok: false, text: '', pages: 0, truncated: false,
        reason: 'pdf-host-error', ms: nowMs() - started
      });
    });
  });

  emit('ai-cm-pdf-local-ready', { version: LOCAL_VERSION });

  window.AiCmPdf = {
    version: '1.2.0',
    MAX_BYTES: MAX_BYTES,
    CHUNK: CHUNK,
    isReady: function () { return readyFlag; },
    fromUrl: fromUrl,
    fromBytes: function (buf, opts) { return run(buf, opts); },
    parseLocal: function (buf, opts) { return parseLocal(buf, opts); },
    cancel: function (id) { emit('ai-cm-pdf-cancel', { id: String(id || '') }); }
  };
}());
