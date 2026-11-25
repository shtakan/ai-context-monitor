/**
 * core/content-pdf.ts — 2.3 Stage 3: PDF-мост MAIN ai-cm-pdf:* → SW (Port) →
 * pdf.js и локальный fallback Firefox.
 *
 * Classic-скрипт в manifest.content_scripts[0].js ПЕРЕД core/content.ts:
 * общий лексический скоуп. Блок перенесён как есть, включая маркеры
 * [pdf-bridge:start]/[pdf-bridge:end] и top-level aiCmPdfBridgeStart().
 */

/** Задача pdf-моста (window.postMessage -> Port/local, сборка чанков). */
interface AiCmPdfJob {
  total: number;
  parts: Uint8Array[];
  got: number;
  size: number;
  port: any;
  sent: boolean;
  maxChars: number;
  attempt: number;
  portEverStarted: boolean;
  localTried: boolean;
  localPending: boolean;
  retryTimer: any;
  localTimer: any;
  localReadyTimer: any;
  localBytes: Uint8Array | null;
}

/** Порт pdf-моста (chrome.runtime.connect) — только используемые члены. */
interface AiCmPdfPort {
  onMessage: { addListener(cb: (msg: any) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
  postMessage(msg: unknown): void;
  disconnect(): void;
}

// ===== v2.0.37 (PDF): мост MAIN ai-cm-pdf:* → SW (Port) → pdf.js =====
// MAIN-хелпер core/pdf-bytes.js скачивает байты originalFetch'ом провайдера и
// отдаёт их чанками 512 КиБ. Здесь они собираются, кодируются в base64 (Port
// сериализует JSON — ArrayBuffer через него не проходит) и уходят в SW-брокер
// core/pdf-parser.js, который поднимает offscreen-документ Chrome либо зовёт
// AiCmPdfHost в event page Firefox. Обратно приходит {t:'result'}, и мост
// публикует его CustomEvent'ом 'ai-cm-pdf-result' (JSON-строка в detail, как
// остальные MAIN↔isolated мосты репозитория).
//
// Фикс A2 (Firefox pdf-aborted): event page Firefox засыпает на холодном старте,
// порт вкладки рвётся посреди разбора, и раньше это сразу отдавало pdf-aborted
// при живых байтах. Теперь (1) порт повторяется один раз — просыпание SW лечится
// реконнектом; (2) если порт умер и во второй раз, PDF разбирается здесь же в
// странице, силами core/pdf-bytes.js (postMessage с transfer ArrayBuffer: ни
// base64, ни 5 МБ по messaging-каналу). Firefox пробует локальный разбор первым:
// offscreen-хоста там нет, а локальный путь не зависит от жизненного цикла
// event page. Локальный разбор — резерв, а не замена pdf.js: он читает только
// content-стримы с литералами Tj/TJ, поэтому при пустом результате мост всё
// равно пробует Port, а pdf-aborted остаётся последним средством.
// [pdf-bridge:start]
var aiCmPdfBridgeStarted: boolean = false;
var aiCmPdfJobs: Record<string, AiCmPdfJob> = {};
var aiCmPdfLocalReady: boolean = false;
var AI_CM_PDF_SRC: string = 'ai-cm-pdf';
var AI_CM_PDF_LOCAL_SRC: string = 'ai-cm-pdf-local';
var AI_CM_PDF_MAX_BYTES: number = 10 * 1024 * 1024;
var AI_CM_PDF_MAX_CHUNKS: number = 64;
var AI_CM_PDF_CHUNK_MAX: number = 1024 * 1024;
var AI_CM_PDF_PORT_RETRY: number = 1;
var AI_CM_PDF_RETRY_DELAY_MS: number = 250;
var AI_CM_PDF_LOCAL_MAX_BYTES: number = 5 * 1024 * 1024;
var AI_CM_PDF_LOCAL_TIMEOUT_MS: number = 12000;
var AI_CM_PDF_LOCAL_READY_WAIT_MS: number = 1200;

function aiCmPdfLog(tag: string, err: unknown): void {
  if (typeof debugLog === 'function') debugLog('warn', '[AI CM][pdf] ' + tag, err);
}

function aiCmPdfDetail(ev: any) {
  var raw = (ev && ev.detail !== undefined) ? ev.detail : null;
  if (typeof raw !== 'string') return (raw && typeof raw === 'object') ? raw : null;
  try { return JSON.parse(raw); } catch (eParse) { aiCmPdfLog('detail', eParse); return null; }
}

function aiCmPdfB64(u8: Uint8Array): string {
  var bin = '';
  var step = 0x8000;
  for (var i = 0; i < u8.length; i += step) {
    bin += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + step)));
  }
  try { return btoa(bin); } catch (eB64) { aiCmPdfLog('btoa', eB64); return ''; }
}

function aiCmPdfAnnounceReady(): void {
  try {
    window.dispatchEvent(new CustomEvent('ai-cm-pdf-ready', { detail: JSON.stringify({ enabled: true }) }));
  } catch (eReady) { aiCmPdfLog('ready', eReady); }
}

// Firefox определяем по UA: chrome.runtime есть и там, но offscreen-хоста нет, а
// event page засыпает — значит локальный разбор для него основной путь.
function aiCmPdfIsFirefox(): boolean {
  try {
    if (typeof navigator === 'undefined' || !navigator) return false;
    return String(navigator.userAgent || '').indexOf('Firefox/') !== -1;
  } catch (eUa) { aiCmPdfLog('ua', eUa); return false; }
}

function aiCmPdfConcat(job: AiCmPdfJob): Uint8Array | null {
  if (!job || !job.parts || job.got <= 0 || job.size <= 0) return null;
  var out = new Uint8Array(job.size);
  var at = 0;
  for (var i = 0; i < job.parts.length; i++) {
    var part = job.parts[i];
    if (!part) return null;
    out.set(part, at);
    at += part.length;
  }
  return at === job.size ? out : null;
}

function aiCmPdfClearJobTimers(job: AiCmPdfJob): void {
  if (!job || typeof job !== 'object') return;
  var keys: Array<'retryTimer' | 'localTimer' | 'localReadyTimer'> = ['retryTimer', 'localTimer', 'localReadyTimer'];
  for (var i = 0; i < keys.length; i++) {
    var timer = job[keys[i]];
    if (timer !== null && timer !== undefined) {
      try { clearTimeout(timer); } catch (eTimer) { aiCmPdfLog('clear-timer', eTimer); }
    }
    job[keys[i]] = null;
  }
  job.localBytes = null;
}

function aiCmPdfDeliver(id: string, res: any): void {
  var job = aiCmPdfJobs[id];
  delete aiCmPdfJobs[id];
  aiCmPdfClearJobTimers(job);
  var out = (res && typeof res === 'object') ? res : {};
  var payload = {
    id: id,
    ok: out.ok === true,
    text: typeof out.text === 'string' ? out.text : '',
    pages: typeof out.pages === 'number' ? out.pages : 0,
    truncated: out.truncated === true,
    reason: typeof out.reason === 'string' ? out.reason : (out.ok === true ? '' : 'pdf-host-error'),
    size: typeof out.size === 'number' ? out.size : (job ? job.size : 0),
    ms: typeof out.ms === 'number' ? out.ms : 0
  };
  if (job && job.port) {
    try { job.port.disconnect(); } catch (eDisc) { aiCmPdfLog('disconnect', eDisc); }
  }
  try {
    window.dispatchEvent(new CustomEvent('ai-cm-pdf-result', { detail: JSON.stringify(payload) }));
  } catch (eEvent) { aiCmPdfLog('result-event', eEvent); }
}

function aiCmPdfDropPort(job: AiCmPdfJob): void {
  if (!job || typeof job !== 'object') return;
  if (job.retryTimer !== null && job.retryTimer !== undefined) {
    clearTimeout(job.retryTimer);
    job.retryTimer = null;
  }
  var port = job.port;
  job.port = null;
  if (!port) return;
  try { port.disconnect(); } catch (eDisc) { aiCmPdfLog('drop-port', eDisc); }
}

// Порт умер. Порядок эскалации: один реконнект (лечит просыпание SW), затем
// локальный разбор в странице, и только если он уже был — pdf-aborted.
function aiCmPdfAfterPort(id: string, reason: string, retryable: boolean): void {
  var job = aiCmPdfJobs[id];
  if (!job) return;
  aiCmPdfDropPort(job);
  if (retryable === true && job.attempt < AI_CM_PDF_PORT_RETRY) {
    if (job.retryTimer !== null) return;
    job.retryTimer = setTimeout(function () {
      job.retryTimer = null;
      if (!aiCmPdfJobs[id]) return;
      aiCmPdfPortAttempt(id, job.attempt + 1);
    }, AI_CM_PDF_RETRY_DELAY_MS);
    return;
  }
  // Локальный разбор уже был и не помог: дальше только честный отказ.
  if (job.localTried === true) {
    aiCmPdfDeliver(id, { ok: false, reason: (typeof reason === 'string' && reason) ? reason : 'pdf-aborted' });
    return;
  }
  aiCmPdfLocalStart(id);
}

function aiCmPdfLocalSend(id: string): void {
  var job = aiCmPdfJobs[id];
  if (!job || !job.localBytes) return;
  if (job.localReadyTimer !== null && job.localReadyTimer !== undefined) {
    clearTimeout(job.localReadyTimer);
    job.localReadyTimer = null;
  }
  var bytes = job.localBytes;
  job.localBytes = null;
  try {
    window.postMessage({
      source: AI_CM_PDF_LOCAL_SRC,
      id: id,
      bytes: bytes.buffer,
      maxChars: job.maxChars || 200000
    }, '*', [bytes.buffer]);
  } catch (ePost) {
    aiCmPdfLog('local-post', ePost);
    aiCmPdfAfterLocal(id, { ok: false, reason: 'pdf-host-error' });
  }
}

function aiCmPdfLocalStart(id: string): void {
  var job = aiCmPdfJobs[id];
  if (!job) return;
  if (job.localTried === true || job.localPending === true) return;
  if (job.size > AI_CM_PDF_LOCAL_MAX_BYTES) {
    aiCmPdfDeliver(id, { ok: false, reason: 'pdf-too-large' });
    return;
  }
  var bytes = aiCmPdfConcat(job);
  if (!bytes) {
    aiCmPdfDeliver(id, { ok: false, reason: 'pdf-invalid' });
    return;
  }
  job.localTried = true;
  job.localPending = true;
  job.localBytes = bytes;
  job.localTimer = setTimeout(function () {
    job.localTimer = null;
    if (!aiCmPdfJobs[id]) return;
    aiCmPdfAfterLocal(id, { ok: false, reason: 'pdf-timeout' });
  }, AI_CM_PDF_LOCAL_TIMEOUT_MS);
  if (aiCmPdfLocalReady === true) {
    aiCmPdfLocalSend(id);
    return;
  }
  // MAIN-хелпер мог ещё не загрузиться (chrome.scripting world:'MAIN' инжектится
  // по требованию). Ждём его ready немногим больше секунды, затем всё равно
  // отправляем: потеря сообщения страхует локальный таймаут.
  job.localReadyTimer = setTimeout(function () {
    job.localReadyTimer = null;
    if (!aiCmPdfJobs[id]) return;
    aiCmPdfLocalSend(id);
  }, AI_CM_PDF_LOCAL_READY_WAIT_MS);
}

function aiCmPdfAfterLocal(id: string, res: any): void {
  var job = aiCmPdfJobs[id];
  if (!job) return;
  if (job.localTimer !== null && job.localTimer !== undefined) {
    clearTimeout(job.localTimer);
    job.localTimer = null;
  }
  if (job.localReadyTimer !== null && job.localReadyTimer !== undefined) {
    clearTimeout(job.localReadyTimer);
    job.localReadyTimer = null;
  }
  job.localPending = false;
  job.localBytes = null;
  var out = (res && typeof res === 'object') ? res : {};
  if (out.ok === true && typeof out.text === 'string' && out.text !== '') {
    aiCmPdfDeliver(id, out);
    return;
  }
  if (job.portEverStarted !== true) {
    // Хоста ещё не звали (локальный разбор в Firefox, MAIN без Port): пробуем.
    aiCmPdfPortAttempt(id, 0);
    return;
  }
  // Хост уже отвалился — сохраняем прежний контракт отказа для провайдера.
  aiCmPdfDeliver(id, { ok: false, reason: 'pdf-aborted' });
}

function aiCmPdfPortAttempt(id: string, attempt: number): void {
  var job = aiCmPdfJobs[id];
  if (!job) return;
  if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.connect !== 'function') {
    aiCmPdfLocalStart(id);
    return;
  }
  var port: AiCmPdfPort;
  try {
    port = chrome.runtime.connect({ name: 'ai-cm-pdf:' + id });
  } catch (ePort) {
    aiCmPdfLog('connect', ePort);
    aiCmPdfAfterPort(id, 'pdf-unavailable', false);
    return;
  }
  if (!aiCmPdfJobs[id]) {
    try { port.disconnect(); } catch (eDisc) { aiCmPdfLog('disconnect', eDisc); }
    return;
  }
  job.port = port;
  job.attempt = attempt;
  job.portEverStarted = true;
  port.onMessage.addListener(function (msg) {
    if (!msg || typeof msg !== 'object') return;
    if (aiCmPdfJobs[id] !== job || job.port !== port) return;
    if (String(msg.t || '') !== 'result') return;
    aiCmPdfDeliver(id, msg);
  });
  port.onDisconnect.addListener(function () {
    try { void chrome.runtime.lastError; } catch (eLast) { aiCmPdfLog('lastError', eLast); }
    if (aiCmPdfJobs[id] !== job || job.port !== port) return;
    job.port = null;
    aiCmPdfAfterPort(id, 'pdf-aborted', true);
  });
  try {
    port.postMessage({ t: 'begin', id: id, total: job.got, maxChars: job.maxChars || 200000 });
    for (var i = 0; i < job.parts.length; i++) {
      if (!job.parts[i]) continue;
      port.postMessage({ t: 'chunk', id: id, seq: i, b64: aiCmPdfB64(job.parts[i]) });
    }
    port.postMessage({ t: 'end', id: id });
  } catch (ePost) {
    aiCmPdfLog('post', ePost);
    job.port = null;
    aiCmPdfAfterPort(id, 'pdf-host-error', false);
  }
}

function aiCmPdfDispatch(id: string): void {
  var job = aiCmPdfJobs[id];
  if (!job || job.sent) return;
  job.sent = true;
  if (aiCmPdfIsFirefox() && job.size > 0 && job.size <= AI_CM_PDF_LOCAL_MAX_BYTES) {
    aiCmPdfLocalStart(id);
    return;
  }
  aiCmPdfPortAttempt(id, 0);
}

function aiCmPdfOnMessage(ev: MessageEvent): void {
  if (!ev || ev.source !== window) return;
  var data = ev.data;
  if (!data || data.source !== AI_CM_PDF_SRC) return;
  var id = typeof data.id === 'string' ? data.id : '';
  if (!id) return;
  var job = aiCmPdfJobs[id];
  if (!job) {
    job = aiCmPdfJobs[id] = {
      total: 0, parts: [], got: 0, size: 0, port: null, sent: false, maxChars: 0,
      attempt: -1, portEverStarted: false, localTried: false, localPending: false,
      retryTimer: null, localTimer: null, localReadyTimer: null, localBytes: null
    };
  }
  if (typeof data.maxChars === 'number' && data.maxChars > 0) job.maxChars = data.maxChars;
  var total = typeof data.total === 'number' ? data.total : 0;
  if (total > 0 && total <= AI_CM_PDF_MAX_CHUNKS) job.total = total;
  var seq = typeof data.seq === 'number' ? data.seq : -1;
  var bytes = data.bytes;
  var len = (bytes && typeof bytes.byteLength === 'number') ? bytes.byteLength : 0;
  if (seq < 0 || seq >= AI_CM_PDF_MAX_CHUNKS || len <= 0 || len > AI_CM_PDF_CHUNK_MAX) {
    aiCmPdfDeliver(id, { ok: false, reason: 'pdf-invalid' });
    return;
  }
  if (job.parts[seq]) return;
  if (job.size + len > AI_CM_PDF_MAX_BYTES) {
    aiCmPdfDeliver(id, { ok: false, reason: 'pdf-too-large' });
    return;
  }
  job.parts[seq] = new Uint8Array(bytes);
  job.got++;
  job.size += len;
  if (job.total > 0 && job.got >= job.total) aiCmPdfDispatch(id);
}

function aiCmPdfAbortAll(): void {
  var ids = Object.keys(aiCmPdfJobs);
  for (var i = 0; i < ids.length; i++) {
    var job = aiCmPdfJobs[ids[i]];
    delete aiCmPdfJobs[ids[i]];
    aiCmPdfClearJobTimers(job);
    if (job && job.port) {
      try { job.port.postMessage({ t: 'cancel', id: ids[i] }); } catch (eCancel) { aiCmPdfLog('cancel', eCancel); }
      try { job.port.disconnect(); } catch (eDisc) { aiCmPdfLog('cancel-disconnect', eDisc); }
    }
  }
}

function aiCmPdfOnCancel(ev: any): void {
  var detail = aiCmPdfDetail(ev);
  var id = (detail && typeof detail.id === 'string') ? detail.id : '';
  if (!id) return;
  aiCmPdfDeliver(id, { ok: false, reason: 'pdf-aborted' });
}

function aiCmPdfOnLocalResult(ev: any): void {
  var detail = aiCmPdfDetail(ev);
  var id = (detail && typeof detail.id === 'string') ? detail.id : '';
  if (!id) return;
  var job = aiCmPdfJobs[id];
  if (!job || job.localPending !== true) return;
  aiCmPdfAfterLocal(id, detail);
}

function aiCmPdfOnLocalReady(): void {
  aiCmPdfLocalReady = true;
  var ids = Object.keys(aiCmPdfJobs);
  for (var i = 0; i < ids.length; i++) {
    var job = aiCmPdfJobs[ids[i]];
    if (job && job.localBytes) aiCmPdfLocalSend(ids[i]);
  }
}

function aiCmPdfBridgeStart(): void {
  if (aiCmPdfBridgeStarted) return;
  // Без chrome.runtime в этом контексте моста нет: MAIN не должен получить
  // 'ready' и обязан остаться на прежней ветке заглушки.
  if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.connect !== 'function') return;
  aiCmPdfBridgeStarted = true;
  window.addEventListener('message', aiCmPdfOnMessage);
  window.addEventListener('ai-cm-pdf-hello', aiCmPdfAnnounceReady);
  window.addEventListener('ai-cm-pdf-cancel', aiCmPdfOnCancel);
  window.addEventListener('ai-cm-pdf-local-result', aiCmPdfOnLocalResult);
  window.addEventListener('ai-cm-pdf-local-ready', aiCmPdfOnLocalReady);
  window.addEventListener('pagehide', aiCmPdfAbortAll);
  aiCmPdfAnnounceReady();
}

aiCmPdfBridgeStart();
// [pdf-bridge:end]
