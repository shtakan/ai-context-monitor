// parser/offscreen.js — сборка байтов и запуск pdf.js в offscreen-документе Chrome.
//
// Почему offscreen: воркеру pdf.js нужен DOM/Worker-контекст, которого у MV3 SW нет.
// Документ создаётся брокером (core/pdf-parser.js) ровно один раз на профиль и
// закрывается по idle-сигналу через 120 с простоя.
//
// Протокол (Port 'ai-cm-pdf-host'): begin → chunk* → end → result; cancel — отмена.
// Байты идут base64-строками: chrome.runtime.Port сериализует сообщения в JSON и
// ArrayBuffer через него не проходит. Декодирование — здесь, перед pdf.js.
(function (root) {
  'use strict';

  var HOST_PORT = 'ai-cm-pdf-host';
  var MAX_BYTES = 10 * 1024 * 1024;
  var MAX_CHUNKS = 64;
  var IDLE_MS = 120000;
  var RETRY_MS = 250;
  var RETRY_MAX = 20;
  var DEFAULT_MAX_CHARS = 200000;
  var DEFAULT_MAX_PAGES = 500;

  var port = null;
  var retries = 0;
  var idleTimer = null;
  var sessions = {};

  function warn(tag, e) {
    if (root.console && typeof root.console.warn === 'function') {
      root.console.warn('[ai-cm-pdf-offscreen] ' + tag + ':', e);
    }
  }

  function num(v) {
    var n = typeof v === 'number' ? v : parseInt(v, 10);
    return (isFinite(n) && n > 0) ? n : 0;
  }

  function post(msg) {
    if (!port) return false;
    try {
      port.postMessage(msg);
      return true;
    } catch (ePost) {
      warn('post', ePost);
      return false;
    }
  }

  function connect() {
    if (port) return port;
    try {
      port = root.chrome.runtime.connect({ name: HOST_PORT });
    } catch (eConnect) {
      warn('connect', eConnect);
      port = null;
      return null;
    }
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    retries = 0;
    return port;
  }

  // SW мог перезапуститься и потерять порт: документ продолжает жить, поэтому
  // переподключаемся сами, пока брокер не поднимется (или пока не исчерпан лимит).
  function onDisconnect() {
    try { void root.chrome.runtime.lastError; } catch (eLast) { warn('lastError', eLast); }
    port = null;
    if (retries >= RETRY_MAX) return;
    retries++;
    setTimeout(function () {
      connect();
      if (port) post({ t: 'hello', from: 'offscreen' });
    }, RETRY_MS * retries);
  }

  function b64ToBytes(b64) {
    var bin = root.atob(String(b64 || ''));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xFF;
    return out;
  }

  function assemble(session) {
    var parts = [];
    var total = 0;
    for (var i = 0; i < session.chunks.length; i++) {
      var u8 = b64ToBytes(session.chunks[i]);
      parts.push(u8);
      total += u8.length;
      if (total > MAX_BYTES) return null;
    }
    var out = new Uint8Array(total);
    var offset = 0;
    for (var j = 0; j < parts.length; j++) {
      out.set(parts[j], offset);
      offset += parts[j].length;
    }
    return out;
  }

  function reply(id, res) {
    var r = res || {};
    post({
      t: 'result',
      id: id,
      ok: r.ok === true,
      text: typeof r.text === 'string' ? r.text : '',
      pages: num(r.pages),
      truncated: r.truncated === true,
      reason: typeof r.reason === 'string' ? r.reason : (r.ok === true ? '' : 'pdf-host-error'),
      size: num(r.size),
      ms: num(r.ms)
    });
  }

  function scheduleIdle() {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      idleTimer = null;
      if (Object.keys(sessions).length > 0) return;
      post({ t: 'idle' });
    }, IDLE_MS);
  }

  function parseSession(session) {
    var host = root.AiCmPdfHost;
    if (!host || typeof host.parsePdf !== 'function') {
      reply(session.id, { ok: false, reason: 'pdf-unavailable' });
      return;
    }
    var bytes = assemble(session);
    if (!bytes || bytes.length === 0) {
      reply(session.id, { ok: false, reason: 'pdf-invalid' });
      return;
    }
    var started = Date.now();
    host.parsePdf(bytes, {
      maxChars: session.maxChars || DEFAULT_MAX_CHARS,
      maxPages: session.maxPages || DEFAULT_MAX_PAGES
    }).then(function (res) {
      var out = res || { ok: false, reason: 'pdf-host-error' };
      out.size = bytes.length;
      out.ms = Date.now() - started;
      reply(session.id, out);
    }, function (eParse) {
      warn('parse', eParse);
      reply(session.id, { ok: false, reason: 'pdf-host-error', size: bytes.length, ms: Date.now() - started });
    });
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    var type = String(msg.t || '');
    var id = String(msg.id || '');
    if (!id) return;

    if (type === 'begin') {
      sessions[id] = {
        id: id,
        name: String(msg.name || ''),
        total: num(msg.total),
        maxChars: num(msg.maxChars) || DEFAULT_MAX_CHARS,
        maxPages: num(msg.maxPages) || DEFAULT_MAX_PAGES,
        chunks: [],
        bytes: 0
      };
      return;
    }

    var session = sessions[id];
    if (!session) return;

    if (type === 'chunk') {
      if (session.chunks.length >= MAX_CHUNKS) {
        delete sessions[id];
        reply(id, { ok: false, reason: 'pdf-too-large' });
        return;
      }
      var b64 = typeof msg.b64 === 'string' ? msg.b64 : '';
      session.chunks.push(b64);
      session.bytes += Math.floor(b64.length * 3 / 4);
      if (session.bytes > MAX_BYTES) {
        delete sessions[id];
        reply(id, { ok: false, reason: 'pdf-too-large' });
      }
      return;
    }

    if (type === 'end') {
      delete sessions[id];
      parseSession(session);
      scheduleIdle();
      return;
    }

    if (type === 'cancel') {
      delete sessions[id];
      var host = root.AiCmPdfHost;
      if (host && typeof host.stop === 'function') host.stop();
      reply(id, { ok: false, reason: 'pdf-aborted' });
      scheduleIdle();
    }
  }

  var api = {
    connect: connect,
    onMessage: onMessage,
    MAX_BYTES: MAX_BYTES
  };

  root.AiCmPdfOffscreen = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (root.chrome && root.chrome.runtime && typeof root.chrome.runtime.connect === 'function') {
    connect();
  }
}(typeof self !== 'undefined' ? self : globalThis));
