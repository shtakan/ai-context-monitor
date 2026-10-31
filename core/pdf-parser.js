// core/pdf-parser.js — брокер SW: content.js (Port) → хост pdf.js → результат.
//
// Два хоста под одним контрактом:
//   • Chrome: offscreen-документ parser/offscreen.html (reasons:['WORKERS']) —
//     создаётся лениво, ровно один на профиль, закрывается после 120 с простоя;
//   • Firefox: event page грузит parser/pdf-host.js как background.scripts —
//     Worker там доступен напрямую, offscreen API нет.
//
// Файл входит в BACKGROUND_PRELUDE (build.mjs) и вшивается в background.js,
// поэтому importScripts и dynamic import здесь запрещены (гейты verify/verifyDist).
// Все обращения к chrome.* обёрнуты typeof-гардами: тесты и jsdom-песочницы
// грузят background.js с частичным стабом chrome, и модуль обязан оставаться
// загружаемым (иначе развалится весь SW-бандл в тестах).
(function (root) {
  'use strict';

  var PORT_PREFIX = 'ai-cm-pdf:';
  var HOST_PORT = 'ai-cm-pdf-host';
  var HOST_URL = 'parser/offscreen.html';
  var HOST_OFFSCREEN_REASONS = ['WORKERS'];
  var HOST_JUSTIFICATION = 'pdf.js worker for attachment text extraction';
  var WATCHDOG_MS = 20000;
  var HOST_PORT_WAIT_MS = 5000;
  var IDLE_MS = 120000;
  var MAX_BYTES = 10 * 1024 * 1024;
  var MAX_CHUNKS = 64;
  var DEFAULT_MAX_CHARS = 200000;
  var DEFAULT_MAX_PAGES = 500;

  var hostPort = null;
  var hostWaiters = [];
  var sessions = {};
  var idleTimer = null;
  var offscreenPromise = null;

  // Брокер всегда живёт внутри бандла background.js (BACKGROUND_PRELUDE), где
  // debugLog уже определён function-декларацией; отдельного console.warn здесь
  // быть не должно — tests/no-bare-console-warn.test.js сканирует core/.
  function warn(tag, e) {
    if (typeof debugLog === 'function') debugLog('warn', '[ai-cm-pdf] ' + tag + ':', e);
  }

  function num(v) {
    var n = typeof v === 'number' ? v : parseInt(v, 10);
    return (isFinite(n) && n > 0) ? n : 0;
  }

  function runtimeApi() {
    if (typeof chrome === 'undefined' || !chrome) return null;
    return chrome.runtime || null;
  }

  function offscreenApi() {
    if (typeof chrome === 'undefined' || !chrome) return null;
    return chrome.offscreen || null;
  }

  function hasOffscreenHost() {
    var off = offscreenApi();
    return !!(off && typeof off.createDocument === 'function');
  }

  function hasFirefoxHost() {
    var host = root.AiCmPdfHost;
    return !!(host && typeof host.parsePdf === 'function');
  }

  /* ------------------------------- offscreen ------------------------------- */

  function hasDocument() {
    var off = offscreenApi();
    if (!off || typeof off.hasDocument !== 'function') return Promise.resolve(false);
    try {
      return Promise.resolve(off.hasDocument()).then(function (open) {
        return open === true;
      }, function (eHas) {
        warn('hasDocument', eHas);
        return false;
      });
    } catch (eThrow) {
      warn('hasDocument-throw', eThrow);
      return Promise.resolve(false);
    }
  }

  function isOffscreenOpen() {
    var rt = runtimeApi();
    if (rt && typeof rt.getContexts === 'function') {
      var url = (typeof rt.getURL === 'function') ? rt.getURL(HOST_URL) : HOST_URL;
      try {
        return Promise.resolve(rt.getContexts({
          contextTypes: ['OFFSCREEN_DOCUMENT'],
          documentUrls: [url]
        })).then(function (list) {
          return !!(list && list.length);
        }, function (eCtx) {
          warn('getContexts', eCtx);
          return hasDocument();
        });
      } catch (eThrow) {
        warn('getContexts-throw', eThrow);
      }
    }
    return hasDocument();
  }

  function createOffscreen() {
    var off = offscreenApi();
    if (!off || typeof off.createDocument !== 'function') {
      return Promise.reject(new Error('offscreen-api-missing'));
    }
    try {
      return Promise.resolve(off.createDocument({
        url: HOST_URL,
        reasons: HOST_OFFSCREEN_REASONS.slice(0),
        justification: HOST_JUSTIFICATION
      }));
    } catch (eCreate) {
      warn('createDocument', eCreate);
      return Promise.reject(eCreate);
    }
  }

  // Лестница «уже открыт → создать → перепроверить»: гонка двух вкладок не должна
  // валить парсинг, второй createDocument отвергается платформой.
  function ensureOffscreen() {
    if (hostPort) return Promise.resolve(true);
    if (offscreenPromise) return offscreenPromise;
    offscreenPromise = isOffscreenOpen().then(function (open) {
      if (open === true) return true;
      return createOffscreen().then(function () {
        return true;
      }, function (eCreate) {
        return isOffscreenOpen().then(function (nowOpen) {
          if (nowOpen === true) return true;
          throw eCreate;
        });
      });
    }).then(function (ok) {
      return ok;
    }, function (eEnsure) {
      offscreenPromise = null;
      throw eEnsure;
    });
    return offscreenPromise;
  }

  function closeHost() {
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
    if (hostPort) {
      try { hostPort.disconnect(); } catch (eDisc) { warn('host-disconnect', eDisc); }
      hostPort = null;
    }
    var off = offscreenApi();
    if (!off || typeof off.closeDocument !== 'function') {
      offscreenPromise = null;
      return Promise.resolve(false);
    }
    try {
      return Promise.resolve(off.closeDocument()).then(function () {
        offscreenPromise = null;
        return true;
      }, function (eClose) {
        warn('closeDocument', eClose);
        offscreenPromise = null;
        return false;
      });
    } catch (eThrow) {
      warn('closeDocument-throw', eThrow);
      offscreenPromise = null;
      return Promise.resolve(false);
    }
  }

  function scheduleIdle() {
    if (idleTimer !== null) return;
    if (Object.keys(sessions).length > 0) return;
    idleTimer = setTimeout(function () {
      idleTimer = null;
      if (Object.keys(sessions).length > 0) return;
      closeHost();
    }, IDLE_MS);
  }

  /* --------------------------------- порты --------------------------------- */

  function flushHostWaiters(port) {
    var waiters = hostWaiters;
    hostWaiters = [];
    if (port) {
      for (var i = 0; i < waiters.length; i++) waiters[i](port);
    }
  }

  function waitHostPort(timeoutMs) {
    if (hostPort) return Promise.resolve(hostPort);
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error('pdf-host-port-timeout'));
      }, timeoutMs || HOST_PORT_WAIT_MS);
      hostWaiters.push(function (port) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(port);
      });
    });
  }

  /* -------------------------------- сессии -------------------------------- */

  function startSession(id, port) {
    return {
      id: id,
      port: port,
      total: 0,
      name: '',
      maxChars: DEFAULT_MAX_CHARS,
      maxPages: DEFAULT_MAX_PAGES,
      chunks: [],
      bytes: 0,
      timer: null,
      started: Date.now()
    };
  }

  function armWatchdog(session) {
    if (session.timer !== null) clearTimeout(session.timer);
    session.timer = setTimeout(function () {
      session.timer = null;
      finishSession(session.id, { ok: false, reason: 'pdf-timeout' });
    }, WATCHDOG_MS);
  }

  function finishSession(id, res) {
    var session = sessions[id];
    if (!session) return;
    delete sessions[id];
    if (session.timer !== null) { clearTimeout(session.timer); session.timer = null; }
    var out = (res && typeof res === 'object') ? res : {};
    var payload = {
      t: 'result',
      id: id,
      ok: out.ok === true,
      text: typeof out.text === 'string' ? out.text : '',
      pages: num(out.pages),
      truncated: out.truncated === true,
      reason: typeof out.reason === 'string' ? out.reason : (out.ok === true ? '' : 'pdf-host-error'),
      size: num(out.size) || session.bytes,
      ms: num(out.ms)
    };
    try {
      session.port.postMessage(payload);
    } catch (ePost) {
      warn('reply', ePost);
    }
    try {
      if (typeof session.port.disconnect === 'function') session.port.disconnect();
    } catch (eDisc) {
      warn('reply-disconnect', eDisc);
    }
    scheduleIdle();
  }

  function cancelHost(id) {
    if (hostPort) {
      try { hostPort.postMessage({ t: 'cancel', id: id }); } catch (eCancel) { warn('host-cancel', eCancel); }
      return;
    }
    var host = root.AiCmPdfHost;
    if (host && typeof host.stop === 'function') {
      try { host.stop(); } catch (eStop) { warn('host-stop', eStop); }
    }
  }

  /* ------------------------------- парсинг -------------------------------- */

  function b64ToBytes(b64) {
    var atobFn = root.atob || (typeof atob === 'function' ? atob : null);
    if (typeof atobFn !== 'function') return null;
    var bin;
    try {
      bin = atobFn(String(b64 || ''));
    } catch (eDecode) {
      warn('atob', eDecode);
      return null;
    }
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xFF;
    return out;
  }

  function concatChunks(chunks) {
    var parts = [];
    var total = 0;
    for (var i = 0; i < chunks.length; i++) {
      var part = b64ToBytes(chunks[i]);
      if (!part) return null;
      parts.push(part);
      total += part.length;
    }
    if (total === 0 || total > MAX_BYTES) return null;
    var out = new Uint8Array(total);
    var offset = 0;
    for (var j = 0; j < parts.length; j++) {
      out.set(parts[j], offset);
      offset += parts[j].length;
    }
    return out;
  }

  function parseChrome(session) {
    return ensureOffscreen().then(function () {
      return waitHostPort(HOST_PORT_WAIT_MS);
    }).then(function (port) {
      try {
        port.postMessage({
          t: 'begin',
          id: session.id,
          total: session.chunks.length,
          name: session.name,
          maxChars: session.maxChars,
          maxPages: session.maxPages
        });
        for (var i = 0; i < session.chunks.length; i++) {
          port.postMessage({ t: 'chunk', id: session.id, seq: i, b64: session.chunks[i] });
        }
        port.postMessage({ t: 'end', id: session.id });
      } catch (ePost) {
        warn('host-post', ePost);
        return { ok: false, reason: 'pdf-host-error' };
      }
      return null; // результат придёт асинхронно в onHostMessage
    });
  }

  function parseFirefox(session) {
    var bytes = concatChunks(session.chunks);
    if (!bytes) return { ok: false, reason: 'pdf-invalid' };
    var started = Date.now();
    return root.AiCmPdfHost.parsePdf(bytes, {
      maxChars: session.maxChars,
      maxPages: session.maxPages
    }).then(function (res) {
      var out = (res && typeof res === 'object') ? res : { ok: false, reason: 'pdf-host-error' };
      out.size = bytes.length;
      out.ms = Date.now() - started;
      return out;
    });
  }

  function startParse(session) {
    var pending;
    if (hasOffscreenHost()) {
      pending = parseChrome(session);
    } else if (hasFirefoxHost()) {
      pending = parseFirefox(session);
    } else {
      finishSession(session.id, { ok: false, reason: 'pdf-unavailable' });
      return;
    }
    Promise.resolve(pending).then(function (res) {
      if (!res) return; // Chrome-ветка отдаёт результат через порт хоста
      finishSession(session.id, res);
    }, function (eStart) {
      warn('parse-start', eStart);
      finishSession(session.id, { ok: false, reason: 'pdf-host-error' });
    });
  }

  /* ------------------------------- сообщения ------------------------------- */

  function onContentMessage(session, msg) {
    if (!msg || typeof msg !== 'object') return;
    // Сессия могла завершиться раньше (pdf-too-large, отмена, watchdog), а порт
    // вкладки ещё досылает чанки: такие сообщения не должны поднимать хост заново.
    if (!session || sessions[session.id] !== session) return;
    var type = String(msg.t || '');
    if (type === 'begin') {
      session.total = num(msg.total);
      session.name = String(msg.name || '');
      session.maxChars = num(msg.maxChars) || DEFAULT_MAX_CHARS;
      session.maxPages = num(msg.maxPages) || DEFAULT_MAX_PAGES;
      armWatchdog(session);
      return;
    }
    if (type === 'chunk') {
      var b64 = typeof msg.b64 === 'string' ? msg.b64 : '';
      var add = Math.floor(b64.length * 3 / 4);
      if (session.chunks.length >= MAX_CHUNKS || session.bytes + add > MAX_BYTES) {
        finishSession(session.id, { ok: false, reason: 'pdf-too-large', size: session.bytes });
        return;
      }
      session.chunks.push(b64);
      session.bytes += add;
      return;
    }
    if (type === 'end') {
      armWatchdog(session);
      startParse(session);
      return;
    }
    if (type === 'cancel') {
      cancelHost(session.id);
      finishSession(session.id, { ok: false, reason: 'pdf-aborted' });
    }
  }

  function onHostMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    var type = String(msg.t || '');
    if (type === 'result') {
      finishSession(String(msg.id || ''), msg);
      return;
    }
    if (type === 'idle') closeHost();
  }

  // Единая точка входа: chrome.runtime.onConnect SW. Имя порта — единственный
  // маршрутизатор (аналог onConnect-паттерна из соседних модулей).
  function onConnect(port) {
    if (!port || typeof port !== 'object') return;
    var name = String(port.name || '');
    if (name === HOST_PORT) {
      hostPort = port;
      if (port.onMessage && typeof port.onMessage.addListener === 'function') {
        port.onMessage.addListener(function (msg) { onHostMessage(msg); });
      }
      if (port.onDisconnect && typeof port.onDisconnect.addListener === 'function') {
        port.onDisconnect.addListener(function () {
          if (hostPort === port) hostPort = null;
          try { void (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError); } catch (eLast) { warn('lastError', eLast); }
        });
      }
      offscreenPromise = Promise.resolve(true);
      flushHostWaiters(port);
      return;
    }
    if (name.indexOf(PORT_PREFIX) !== 0) return;
    var id = name.slice(PORT_PREFIX.length);
    if (!id || sessions[id]) return;
    var session = startSession(id, port);
    sessions[id] = session;
    if (port.onMessage && typeof port.onMessage.addListener === 'function') {
      port.onMessage.addListener(function (msg) { onContentMessage(session, msg); });
    }
    if (port.onDisconnect && typeof port.onDisconnect.addListener === 'function') {
      port.onDisconnect.addListener(function () {
        if (!sessions[id]) return;
        delete sessions[id];
        if (session.timer !== null) { clearTimeout(session.timer); session.timer = null; }
        cancelHost(id);
        scheduleIdle();
      });
    }
  }

  var api = {
    MAX_BYTES: MAX_BYTES,
    MAX_CHUNKS: MAX_CHUNKS,
    WATCHDOG_MS: WATCHDOG_MS,
    IDLE_MS: IDLE_MS,
    HOST_URL: HOST_URL,
    HOST_PORT: HOST_PORT,
    onConnect: onConnect,
    onHostMessage: onHostMessage,
    finishSession: finishSession,
    closeHost: closeHost,
    sessions: sessions,
    hasOffscreenHost: hasOffscreenHost,
    hasFirefoxHost: hasFirefoxHost,
    reset: function () {
      if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
      var ids = Object.keys(sessions);
      for (var i = 0; i < ids.length; i++) {
        var s = sessions[ids[i]];
        if (s && s.timer !== null) clearTimeout(s.timer);
        delete sessions[ids[i]];
      }
      hostWaiters = [];
      hostPort = null;
      offscreenPromise = null;
    }
  };

  root.AiCmPdfBroker = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  try {
    if (typeof chrome !== 'undefined' && chrome && chrome.runtime && chrome.runtime.onConnect &&
        typeof chrome.runtime.onConnect.addListener === 'function') {
      chrome.runtime.onConnect.addListener(onConnect);
    }
  } catch (eListen) {
    warn('onConnect-register', eListen);
  }
}(typeof self !== 'undefined' ? self : globalThis));
