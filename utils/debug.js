// utils/debug.js — единый флаг отладки и обёртка-логгер для AI Context Monitor
// В релизе DEBUG = false (конечный пользователь не видит диагностику).
// Разработчик меняет на true для включения ВСЕХ console.log-выводов.
// console.warn и console.error видны ВСЕГДА, независимо от флага.
var DEBUG = true;

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
  if (level === 'error' || level === 'warn') {
    (console[level] || console.log).apply(console, args);
    return;
  }
  if (DEBUG) {
    (console[level] || console.log).apply(console, args);
  }
}