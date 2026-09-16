// utils/debug.js — единый флаг отладки и обёртка-логгер для AI Context Monitor
// v31: DEBUG управляется чекбоксом «Подробные логи» (ключ aiCmDebugLogs в chrome.storage.local).
// По умолчанию ВЫКЛ: скрываются [gemini-autoscroll], [gemini-base-diag], token-diag-scan,
// content-trace EMIT/DRAW и прочие v4x-логи. Всегда остаются (console.log напрямую):
// версия расширения, инициализация адаптеров, «база полной истории», логи экспорта.
// console.warn и console.error видны ВСЕГДА, независимо от флага.
var DEBUG = false;

// v31: сеттер флага (вызывается из content.js при загрузке ключа и по onChanged;
// в MAIN-мире перехватчики получают значение через событие 'ai-cm-debug-logs').
function __aiCmSetDebugLogs(v) {
  DEBUG = !!v;
  try { if (typeof window !== 'undefined') window.__aiCmDebugLogs = !!v; } catch (e) { }
}

// Ring-буфер логов (≤200 строк) для дампа диагностики. console.* НЕ затрагивается.
// Каждая строка, проходящая через debugLog, дополнительно пишется в ring текущего мира
// (у перехватчика MAIN-мир и у content.js ISOLATED-мир — отдельные буферы).
var __aiCmLogRing = [];
var __aiCmLogRingMax = 200;

function __aiCmStringifyArg(a) {
  if (typeof a === 'string') return a;
  try {
    var s = JSON.stringify(a);
    if (s === undefined) return String(a);
    if (s.length > 500) s = s.slice(0, 500) + '…';
    return s;
  } catch (e) { return String(a); }
}

function __aiCmPushLogRing(line) {
  try {
    __aiCmLogRing.push(line);
    if (__aiCmLogRing.length > __aiCmLogRingMax) __aiCmLogRing.shift();
  } catch (e) { }
}

// Копия ring-буфера текущего мира (для дампа диагностики).
function __aiCmGetLogRing() {
  try { return __aiCmLogRing.slice(); } catch (e) { return []; }
}

/**
 * Обёртка над console-методами. Заменяет прямой console.log во всём проекте.
 * @param {string} level — 'log', 'info', 'debug', 'warn', 'error'
 * @param {...any} последующие аргументы — то, что будет передано в console[level]
 *
 * Правила:
 *   - 'warn' и 'error' → выводятся ВСЕГДА (сигнал реальной проблемы, не спам)
 *   - 'log' / 'info' / 'debug' → выводятся ТОЛЬКО при DEBUG === true
 */
function debugLog(level) {
  var args = Array.prototype.slice.call(arguments, 1);
  try {
    var line = args.map(__aiCmStringifyArg).join(' ');
    __aiCmPushLogRing(line);
  } catch (e) { }
  if (level === 'error' || level === 'warn') {
    (console[level] || console.log).apply(console, args);
    return;
  }
  // v31: динамическая проверка — флаг может меняться в рантайме из любого мира
  var enabled = DEBUG;
  try { if (typeof window !== 'undefined' && window.__aiCmDebugLogs === true) enabled = true; } catch (e) { }
  if (enabled) {
    (console[level] || console.log).apply(console, args);
  }
}

// =============================================================================
// O-27/O-32 (ДИАГНОСТИКА, только измерение): единый гейт инструментирования и печать
// строк «точки скачивания / точки записи базы / точки сброса состояния».
//
// Гейт — aiCmDebug: sessionStorage 'aiCmDebug' === '1' (тот же флаг, что у СЕКЦИИ 13
// DeepSeek и санации экспорта) ИЛИ чекбокс «Подробные логи» (chrome.storage.local
// aiCmDebugLogs → window.__aiCmDebugLogs). Гейт выключен → НИ ОДНОЙ новой строки.
//
// Контракт инструментирования (поведение не меняется):
//   - функции только ЧИТАЮТ уже посчитанные значения (content/fileName/url/threadId);
//   - ни одна из них не пишет в базу/storage/DOM и не трогает байты экспорта;
//   - вызовы в чужом коде защищены typeof-гардом, поэтому срез-песочницы тестов без
//     этих хелперов видят прежнее поведение 1:1.
// =============================================================================
function aiCmDiagOn() {
  try {
    if (typeof sessionStorage !== 'undefined' && sessionStorage &&
      sessionStorage.getItem('aiCmDebug') === '1') return true;
  } catch (eSess) { }
  try {
    if (typeof window !== 'undefined' && window && window.__aiCmDebugLogs === true) return true;
  } catch (eWin) { }
  return false;
}

// Тип документа для логов сброса состояния: captcha / chat / search / unknown.
function aiCmDiagDocKind() {
  var href = '';
  var host = '';
  try { href = String((typeof location !== 'undefined' && location && location.href) || ''); } catch (eHref) { }
  try { host = String((typeof location !== 'undefined' && location && location.hostname) || ''); } catch (eHost) { }
  var isGoogle = (host === 'google.com' || host === 'www.google.com');
  try {
    if (href.indexOf('/sorry/') !== -1) return 'captcha';
    if (isGoogle && (document.querySelector('#captcha-form') ||
      document.querySelector('form[action*="sorry"]') ||
      document.querySelector('iframe[src*="recaptcha"]'))) return 'captcha';
  } catch (eCap) { }
  try {
    var tid = '';
    var el = document.querySelector('[data-session-thread-id]');
    if (el) tid = String(el.getAttribute('data-session-thread-id') || '').trim();
    if (tid) return 'chat';
    if (document.querySelector('[data-scope-id="turn"]') ||
      document.querySelector('[data-subtree="aimfl"]')) return 'chat';
  } catch (eChat) { }
  if (isGoogle) return 'search';
  return 'chat';
}

// Первые n символов (по умолчанию 100) базы/тела ОДНОЙ строкой; пустое — явно.
function aiCmDiagHead(v, n) {
  try {
    var lim = (typeof n === 'number' && n > 0) ? n : 100;
    if (v === undefined || v === null) return '(пусто)';
    var s = String(v);
    if (!s) return '(пусто)';
    var flat = s.replace(/\s+/g, ' ').trim();
    if (!flat) return '(пусто/пробелы)';
    return (flat.length > lim) ? (flat.slice(0, lim) + '…') : flat;
  } catch (eHead) { return '(ошибка)'; }
}

// Источник вызова (dev-режим/подробные логи): верхние кадры стека одной строкой.
function aiCmDiagStack(skip) {
  try {
    var st = String((new Error()).stack || '');
    if (!st) return '';
    var lines = st.split('\n');
    var out = [];
    var from = 1 + ((typeof skip === 'number' && skip >= 0) ? skip : 0);
    for (var i = from; i < lines.length && out.length < 4; i++) {
      var s = String(lines[i] || '').replace(/\s+/g, ' ').trim();
      if (!s || s.indexOf('aiCmDiag') !== -1) continue;
      out.push(s);
    }
    return out.join(' <- ');
  } catch (eStack) { return ''; }
}

// Печать строки диагностики: tag + key=value… Только под гейтом aiCmDebug.
function aiCmDiagLine(tag, fields) {
  if (!aiCmDiagOn()) return false;
  try {
    var parts = [];
    var f = fields || {};
    for (var k in f) {
      if (!Object.prototype.hasOwnProperty.call(f, k)) continue;
      var v = f[k];
      parts.push(k + '=' + ((v === undefined || v === null) ? '(нет)' : String(v)));
    }
    console.log('[AI CM][diag] ' + tag + ' ' + parts.join(' '));
  } catch (eLine) { }
  return true;
}

// ЕДИНАЯ точка лога скачивания: триггер, имя файла (пустое — словом «пустое»),
// первые 100 символов базы, длина, URL документа, threadId, источник вызова.
function aiCmDiagDownload(trigger, content, fileName, extra) {
  if (!aiCmDiagOn()) return false;
  var e = extra || {};
  var url = '';
  try { url = String((typeof location !== 'undefined' && location && location.href) || ''); } catch (eUrl) { }
  return aiCmDiagLine('download', {
    trigger: trigger || '(нет)',
    file: (fileName === undefined || fileName === null || String(fileName) === '') ? 'пустое' : String(fileName),
    bytes100: aiCmDiagHead(content, 100),
    len: (content === undefined || content === null) ? 0 : String(content).length,
    mime: e.mime,
    url: url,
    threadId: e.threadId,
    site: e.site,
    reason: e.reason,
    src: aiCmDiagStack(1)
  });
}

// O-27 (защитный фикс): ЕДИНСТВЕННАЯ точка скачивания ОТКАЗАЛА в выдаче файла.
// reason=xssi-prefix — первые байты контента начинаются XSSI-префиксом Google (`)]}'`,
// живой артефакт `f.txt`); reason=empty-name — имя файла пустое/не задано (живой путь
// автоэкспорта на captcha-странице). Строка — только под гейтом aiCmDebug; reason идёт
// ПЕРВЫМ полем, поэтому в логе всегда читается `download-blocked reason=<причина>`.
function aiCmDiagDownloadBlocked(trigger, content, fileName, reason, extra) {
  if (!aiCmDiagOn()) return false;
  var e = extra || {};
  var url = '';
  try { url = String((typeof location !== 'undefined' && location && location.href) || ''); } catch (eUrlB) { }
  return aiCmDiagLine('download-blocked', {
    reason: reason || '(нет)',
    trigger: trigger || '(нет)',
    file: (fileName === undefined || fileName === null || String(fileName) === '') ? 'пустое' : String(fileName),
    bytes100: aiCmDiagHead(content, 100),
    len: (content === undefined || content === null) ? 0 : String(content).length,
    mime: e.mime,
    url: url,
    threadId: e.threadId,
    site: e.site,
    src: aiCmDiagStack(1)
  });
}
