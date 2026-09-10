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
