'use strict';

/**
 * ESM-пилот (Roadmap Ph2): загрузка ES-модулей в Jest (CJS) без babel/трансформера.
 *
 * util/markdown.js и print/print.js переведены на import/export, но часть тестов
 * исполняет их исходники через new Function (классический scope). Хелпер повторяет
 * то, что делает esbuild в сборке: статический import разворачивается в IIFE
 * зависимости, export-обёртки снимаются, default-экспорт возвращается из IIFE.
 * Новых npm-зависимостей нет — только fs/path и new Function.
 *
 *   loadEsm('utils/markdown.js')     → default-экспорт модуля (API рендерера).
 *   loadAsClassic('print/print.js')  → классический исходник с уже втянутым
 *                                      markdown.js; годится для new Function(...).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function readSource(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

/** Разворачивает import-граф в один классический исходник (без export/import). */
function inlineModule(relPath) {
  const source = readSource(relPath);
  const dir = path.posix.dirname(relPath);

  let out = source.replace(
    /^[ \t]*import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm,
    function (line, name, spec) {
      const dep = path.posix.normalize(path.posix.join(dir, spec));
      return 'var ' + name + ' = (function () {\n' + inlineModule(dep) + '\n})();';
    }
  );

  out = out.replace(/^[ \t]*export\s+(?=(?:function|var|let|const|class)\s)/gm, '');

  let defaultName = null;
  out = out.replace(/^[ \t]*export\s+default\s+([A-Za-z_$][\w$]*)\s*;?[ \t]*$/gm, function (line, name) {
    defaultName = name;
    return '';
  });

  if (defaultName) out += '\nreturn ' + defaultName + ';\n';
  return out;
}

function loadEsm(relPath) {
  return new Function(inlineModule(relPath))();
}

function loadAsClassic(relPath) {
  return inlineModule(relPath);
}

module.exports = { loadEsm: loadEsm, loadAsClassic: loadAsClassic };
