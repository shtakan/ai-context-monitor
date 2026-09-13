/**
 * v2.0 (этап 2/3): карта исходников MAIN-перехватчика Gemini.
 *
 * core/gemini-intercept.js декомпозирован: кластер скрытого скролла вынесен в
 * core/gemini-hidden-scroll.js. Порядок в MODULES — ровно порядок инъекции в
 * core/background.js (registerSafe 'ai-cm-gemini-intercept', document_start,
 * world 'MAIN'): модули идут ПЕРЕД core/gemini-intercept.js.
 *
 * Скрипты одного registerContentScripts-пакета исполняются в одном мировом
 * глобальном лексическом скоупе: объявления модуля видны gemini-intercept.js
 * (и наоборот) по прежним именам, без импортов и префиксов. Поэтому
 * конкатенация исходников в этом порядке — тот же текст, что и в браузере, и
 * source-level пин-тесты читают функции оттуда, где они теперь живут, не меняя
 * ни одного ассерта.
 *
 * ВАЖНО: перенос кода обязан быть БАЙТОВЫМ, включая ведущие отступы, и рабочие
 * файлы обязаны остаться в LF. Часть пин-тестов ищет литералы с ведущими
 * пробелами ("  function finishQuiet(...)", "\n  });",
 * "            if (lastLoaderDoneReason !== 'top') {") и режет функции по
 * терминатору '\n  function '.
 *
 * Потребители: тесты, которые режут функцию из исходника по имени
 * (`src.indexOf('function ' + name + '(')`) или по маркерам-комментариям.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// Порядок = порядок js[] в core/background.js для 'ai-cm-gemini-intercept'.
// utils/* сюда НЕ входят: они не декомпозировались (как и в content-source.js).
const MODULES = [
  'core/gemini-hidden-scroll.js'
];
const INTERCEPT_JS = 'core/gemini-intercept.js';

/** Пути (от корня репозитория) всех файлов перехватчика в порядке инъекции. */
const SOURCES = MODULES.concat([INTERCEPT_JS]);

function readSource(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Исходник одного модуля по имени файла ('gemini-hidden-scroll.js' или с 'core/'). */
function moduleSource(name) {
  const rel = name.indexOf('/') === -1 ? 'core/' + name : name;
  return readSource(rel);
}

/** Конкатенация модулей + gemini-intercept.js в порядке инъекции (единый скоуп). */
const geminiSource = SOURCES.map(readSource).join('\n');

module.exports = {
  ROOT,
  MODULES,
  INTERCEPT_JS,
  SOURCES,
  readSource,
  moduleSource,
  geminiSource,
  // алиасы, чтобы свопы читались единообразно:
  interceptSource: geminiSource,
  source: geminiSource
};
