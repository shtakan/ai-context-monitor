'use strict';

/**
 * ESM-пилот (Roadmap Ph2), шаг 3: загрузка options/options.js в Jest.
 *
 * options/options.js начинается со статического `import { aiCmIsFirefox } from
 * '../utils/platform.js'`, поэтому обычный `require('../options/options.js')`
 * падает в CJS-режиме jest: "Cannot use import statement outside a module".
 * Хелпер повторяет шаг сборки (build.mjs + esbuild): load-esm.js разворачивает
 * статический import в IIFE зависимости, после чего исходник исполняется как
 * классический скрипт — ровно так он и живёт в бандле options.js расширения.
 *
 * module/exports передаются параметрами (как в module-wrapper jest), чтобы
 * работал UMD-хвост `if (typeof module !== 'undefined' && module.exports)` в
 * конце options.js: он отдаёт чистые функции для юнит-тестов (isChatHome,
 * buildArchiveStoragePatch, ...).
 *
 *   const mod = require('./helpers/load-options.js').loadOptions();
 *   expect(mod.isChatHome('https://gemini.google.com/app')).toBe(true);
 *
 * Побочные эффекты те же, что у require: скрипт навешивает обработчики на
 * document/window и читает global.chrome в момент загрузки, поэтому вызывать
 * хелпер надо после подготовки DOM и моков. Каждый вызов исполняет скрипт заново
 * (своя область видимости — повторные вызовы не конфликтуют по top-level const).
 */

const { loadAsClassic } = require('./load-esm.js');

/** Исполняет options/options.js как классический скрипт и отдаёт его UMD-экспорт. */
function loadOptions() {
  const moduleObj = { exports: {} };
  new Function('module', 'exports', loadAsClassic('options/options.js'))(moduleObj, moduleObj.exports);
  return moduleObj.exports;
}

module.exports = { loadOptions };
