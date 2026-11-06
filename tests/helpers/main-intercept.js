'use strict';
/**
 * Ph2: тестовый мост для MAIN-перехватчиков, перешедших на ESM.
 *
 * Перехватчики и utils/intercept-common.js теперь содержат top-level import,
 * поэтому их нельзя просто прочитать и выполнить как classic-скрипт: Node
 * (require) и прямой eval упадут на `import`. Сборка решает это esbuild'ом
 * (build.mjs, mainInterceptOptions), а тестам нужен эквивалент без сборки:
 *
 *   - commonSource()     — intercept-common.js без import'а debug.js; вместо
 *                          него — мост в window.__aiCmSwallowSoft (тот же
 *                          контракт, что у debugSoftFacadePlugin в build.mjs);
 *   - interceptSource()  — commonSource() + исходник перехватчика без его
 *                          import'а intercept-common.js, одной classic-областью;
 *   - loadCommon()       — namespace { setIntervalVisible } для юнит-теста.
 *
 * Тесты, которым нужны только строковые пины по исходнику, продолжают читать
 * файл напрямую — import для них просто текст.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const COMMON_REL = 'utils/intercept-common.js';

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8').replace(/^\uFEFF/, '');
}

/** export default / export {…} / export перед function|var|let|const|class. */
function stripExports(src) {
  return src
    .replace(/^[ \t]*export\s+default\s+[^\n]*\n?/gm, '')
    .replace(/^[ \t]*export\s*\{[^}]*\}\s*;?[ \t]*\n?/gm, '')
    .replace(/^[ \t]*export\s+(?=(?:async\s+)?(?:function|var|let|const|class)\s)/gm, '');
}

/**
 * intercept-common.js без import'а: swallowSoft смотрит в window-зеркало
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
    /^[ \t]*import\s*\{[^}]*\}\s*from\s*['"][^'"]*debug\.js['"];?[ \t]*$/m,
    bridge
  );
  // Директива относится к import'у, который мы только что убрали.
  src = src.replace(/^[ \t]*\/\/\s*@ts-expect-error[^\n]*\n/m, '');
  return stripExports(src);
}

/** commonSource() + перехватчик без import'а, одна classic-область видимости. */
function interceptSource(relPath) {
  let src = read(relPath).replace(
    /^[ \t]*import\s*\{[^}]*\}\s*from\s*['"][^'"]*intercept-common\.js['"];?[ \t]*$/m,
    ''
  );
  src = stripExports(src);
  return commonSource() + '\n' + src;
}

/** Загрузка namespace'а intercept-common для юнит-теста (аналог loadEsmModule). */
function loadCommon() {
  return new Function(
    commonSource() + '\nreturn { setIntervalVisible: setIntervalVisible };'
  )();
}

module.exports = { commonSource, interceptSource, loadCommon };
