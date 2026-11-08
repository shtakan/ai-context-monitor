'use strict';

/**
 * ESM-пилот (Roadmap Ph2): исполнение ES-модулей внутри Jest (CJS) без babel.
 *
 * Сборка (build.mjs) конкатенирует исходники в `.build/entry-<name>.js` и отдаёт
 * их esbuild, который разрешает статические import/export сам. Тестам нужен тот
 * же граф, но без сборки, поэтому хелпер повторяет шаг разрешения графа вручную:
 * статический import разворачивается в IIFE зависимости, export-обёртки
 * снимаются, default-экспорт возвращается наружу. Из зависимостей — только
 * fs/path и esbuild (снимает типы с `.ts`-исходников, см.
 * tests/helpers/read-module-source.js), исполнение — new Function.
 *
 *   loadEsm('utils/buildReferenceText.ts')            → default-экспорт модуля
 *   loadEsmGlobal('utils/export-text-builders.js', 'AiCmExportBuilders')
 *                                                      → публичное API, которое
 *                                                        модуль кладёт в window
 *   loadAsClassic('print/print.js')                    → исходник с уже
 *                                                        втянутыми зависимостями,
 *                                                        для new Function(...)
 */

const path = require('path');
const { readModuleSource } = require('./read-module-source');

const ROOT = path.join(__dirname, '..', '..');

// Уникальные имена для развёрнутых зависимостей: два файла могут импортировать
// один и тот же модуль, а повторный `var` в одном scope недопустим.
let depSeq = 0;

/** Имена named-экспортов, объявленных как function/var/let/const/class. */
function collectNamedExports(source) {
  const re = /^[ \t]*export\s+(?:async\s+)?(?:function|var|let|const|class)\s+([A-Za-z_$][\w$]*)/gm;
  const out = [];
  let m;
  while ((m = re.exec(source)) !== null) out.push(m[1]);
  return out;
}

function inlineModule(relPath, asNamespace) {
  const file = path.join(ROOT, relPath);
  const source = readModuleSource(file);
  const dir = path.posix.dirname(relPath.replace(/\\/g, '/'));
  const named = collectNamedExports(source);

  let out = source;

  // import { a, b as c } from './x.js' → IIFE зависимости (namespace) + привязки.
  out = out.replace(
    /^[ \t]*import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?[ \t]*$/gm,
    function (line, names, spec) {
      const dep = path.posix.normalize(path.posix.join(dir, spec));
      const ref = '__dep' + ++depSeq;
      const binds = names
        .split(',')
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean)
        .map(function (s) {
          const parts = s.split(/\s+as\s+/);
          return 'var ' + (parts[1] || parts[0]) + ' = ' + ref + '[' + JSON.stringify(parts[0]) + '];';
        })
        .join('\n      ');
      return 'var ' + ref + ' = (function () {\n' + inlineModule(dep, true) + '\n})();\n      ' + binds;
    }
  );

  // import Default from './x.js' → IIFE зависимости, возвращающая её default.
  out = out.replace(
    /^[ \t]*import\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"];?[ \t]*$/gm,
    function (line, name, spec) {
      const dep = path.posix.normalize(path.posix.join(dir, spec));
      return 'var ' + name + ' = (function () {\n' + inlineModule(dep) + '\n})();';
    }
  );

  let defaultName = null;
  out = out.replace(
    /^[ \t]*export\s+default\s+([A-Za-z_$][\w$]*)\s*;?[ \t]*$/gm,
    function (line, name) {
      defaultName = name;
      return '';
    }
  );
  out = out.replace(/^[ \t]*export\s+(?=(?:async\s+)?(?:function|var|let|const|class)\s)/gm, '');

  if (asNamespace) {
    const fields = named.map(function (n) {
      return n + ': ' + n;
    });
    if (defaultName) fields.push('default: ' + defaultName);
    out += '\nreturn {' + fields.join(', ') + '};\n';
  } else if (defaultName) {
    out += '\nreturn ' + defaultName + ';\n';
  }
  return out;
}

/** Исполняет модуль и возвращает его default-экспорт. */
function loadEsm(relPath) {
  return new Function(inlineModule(relPath))();
}

/**
 * Исполняет модуль и отдаёт namespace-объект (все named-экспорты + default).
 * Нужен адаптерам-песочницам (tests/helpers/adapter-harness.js): они склеивают
 * исходники в один Function-body, где `import` недопустим, и переписывают его
 * в `var { x } = require(load-esm).loadEsmModule('utils/....js')`.
 */
function loadEsmModule(relPath) {
  return new Function(inlineModule(relPath, true))();
}

/**
 * Исполняет модуль и отдаёт его публичное API: default-экспорт ES-модуля (Roadmap Ph2 —
 * сборщики экспорта), иначе window[globalName], иначе CJS-экспорт (`module.exports`
 * в UMD-хвосте ещё не переведённых модулей). Последний фолбэк обязателен: часть тестов
 * идёт в `@jest-environment node` (tests/adapters/deepseek-o17-spa-chat.test.js), где
 * window нет.
 */
function loadEsmGlobal(relPath, globalName) {
  const moduleObj = { exports: {} };
  const api = new Function('module', 'exports', inlineModule(relPath))(moduleObj, moduleObj.exports);
  if (api !== undefined && api !== null) return api;
  const scope = typeof window !== 'undefined'
    ? window
    : (typeof globalThis !== 'undefined' ? globalThis : null);
  if (scope && scope[globalName] !== undefined) return scope[globalName];
  if (moduleObj.exports && Object.keys(moduleObj.exports).length > 0) return moduleObj.exports;
  return scope ? scope[globalName] : undefined;
}

/** Исходник с втянутыми зависимостями — для new Function(...) в тестах. */
function loadAsClassic(relPath) {
  return inlineModule(relPath);
}

module.exports = { loadEsm, loadEsmGlobal, loadEsmModule, loadAsClassic };
