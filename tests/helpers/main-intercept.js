'use strict';
/**
 * Ph2: тестовый мост для MAIN-перехватчиков, перешедших на ESM.
 *
 * Перехватчики и utils/intercept-common.ts теперь содержат top-level import,
 * поэтому их нельзя просто прочитать и выполнить как classic-скрипт: Node
 * (require) и прямой eval упадут на `import`. Сборка решает это esbuild'ом
 * (build.mjs, mainInterceptOptions), а тестам нужен эквивалент без сборки:
 * типы `.ts`-исходников снимает tests/helpers/read-module-source.js (тот же
 * esbuild.transformSync), поэтому в new Function уходит уже чистый JS.
 *
 *   - commonSource()     — intercept-common.ts без import'а debug.js; вместо
 *                          него — мост в window.__aiCmSwallowSoft (тот же
 *                          контракт, что у debugSoftFacadePlugin в build.mjs);
 *   - interceptSource()  — commonSource() + исходник перехватчика без его
 *                          import'а intercept-common.ts, одной classic-областью;
 *   - loadCommon()       — namespace { setIntervalVisible } для юнит-теста.
 *
 * Тесты, которым нужны только строковые пины по исходнику, продолжают читать
 * файл напрямую — import для них просто текст.
 */
const path = require('path');
const { readModuleSource } = require('./read-module-source');

const ROOT = path.join(__dirname, '..', '..');
const COMMON_REL = 'utils/intercept-common.ts';

function read(relPath) {
  return readModuleSource(path.join(ROOT, relPath)).replace(/^\uFEFF/, '');
}

/** export default / export {…} / export перед function|var|let|const|class. */
function stripExports(src) {
  return src
    .replace(/^[ \t]*export\s+default\s+[^\n]*\n?/gm, '')
    .replace(/^[ \t]*export\s*\{[^}]*\}\s*;?[ \t]*\n?/gm, '')
    .replace(/^[ \t]*export\s+(?=(?:async\s+)?(?:function|var|let|const|class)\s)/gm, '');
}

/**
 * intercept-common.ts без import'а: swallowSoft смотрит в window-зеркало
 * debug.js, как и в собранном MAIN-бандле (см. build.mjs, debugSoftFacadePlugin).
 */
function commonSource() {
  const bridge = [
    'var swallowSoft = function (error, tag) {',
    '  try {',
    "    if (typeof window !== 'undefined' && typeof window.__aiCmSwallowSoft === 'function') {",
    '      return window.__aiCmSwallowSoft(error, tag);',
    '    }',
    '  } catch (eBridge) {',
    '    // window недоступен — молча выходим, как и зеркало debug.js',
    '  }',
    '  return undefined;',
    '};',
  ].join('\n');
  let src = read(COMMON_REL).replace(
    /^[ \t]*import\s*\{[^}]*\}\s*from\s*['"][^'"]*debug\.(?:js|ts)['"];?[ \t]*$/m,
    bridge
  );
  // Директива относится к import'у, который мы только что убрали.
  src = src.replace(/^[ \t]*\/\/\s*@ts-expect-error[^\n]*\n/m, '');
  return stripExports(src);
}

/**
 * Ph2: импорт utils/perplexity-parser.ts в перехватчике — статический ESM-импорт.
 * В classic-eval его разворачивать не нужно: тесты этих перехватчиков подменяют парсер
 * через window.parsePerplexityThread (мок снимка), поэтому мост смотрит в тот же
 * window-глобал, что и до миграции. Нет глобала — пустой результат ровно как раньше.
 */
function parserBridge() {
  return [
    'var parsePerplexityThread = function (json) {',
    '  if (typeof window !== "undefined" && typeof window.parsePerplexityThread === "function") {',
    '    return window.parsePerplexityThread(json);',
    '  }',
    "  return { text: '', count: 0 };",
    '};',
    'var stripPerplexityHistoryTruncation = function (urlStr) {',
    '  if (typeof window !== "undefined" && typeof window.stripPerplexityHistoryTruncation === "function") {',
    '    return window.stripPerplexityHistoryTruncation(urlStr);',
    '  }',
    "  return String(urlStr || '');",
    '};',
  ].join('\n');
}

/** commonSource() + перехватчик без import'а, одна classic-область видимости. */
function interceptSource(relPath) {
  let src = read(relPath).replace(
    /^[ \t]*import\s*\{[^}]*\}\s*from\s*['"][^'"]*intercept-common\.ts['"];?[ \t]*$/m,
    ''
  ).replace(
    /^[ \t]*import\s*\{[^}]*\}\s*from\s*['"][^'"]*perplexity-parser\.ts['"];?[ \t]*$/m,
    parserBridge()
  );
  src = stripExports(src);
  return commonSource() + '\n' + src;
}

/** Загрузка namespace'а intercept-common для юнит-теста (аналог loadEsmModule). */
function loadCommon() {
  return new Function(
    commonSource() +
    '\nreturn { setIntervalVisible: setIntervalVisible, fetchGuarded: fetchGuarded, ' +
    'isOnFreezeError: isOnFreezeError, ONFREEZE_ERROR_RE: ONFREEZE_ERROR_RE };'
  )();
}

module.exports = { commonSource, interceptSource, loadCommon };
