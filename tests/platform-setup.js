// Jest setupFiles: options/options.js исполняется в Node без общего лексического
// окружения страницы, поэтому публикуем aiCmIsFirefox в global до загрузки тестов.
// Ph2, шаг 3: utils/platform.js — ESM-модуль (export function), поэтому берём его
// через load-esm.js (тот же приём, что у остальных пилотных модулей), а не require.
// Тело функции читает global.chrome/browser в момент вызова, так что per-test моки
// (chrome-extension:// / moz-extension://) работают штатно.
const { loadEsmModule } = require('./helpers/load-esm.js');

global.aiCmIsFirefox = loadEsmModule('utils/platform.js').aiCmIsFirefox;
