// utils/debug.js — единый флаг отладки и обёртка-логгер для AI Context Monitor
// В релизе DEBUG = false (конечный пользователь не видит диагностику).
// Разработчик меняет на true для включения ВСЕХ console.log-выводов.
// console.warn и console.error видны ВСЕГДА, независимо от флага.
var DEBUG = true;

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
  if (DEBUG) {
    (console[level] || console.log).apply(console, args);
  }
}