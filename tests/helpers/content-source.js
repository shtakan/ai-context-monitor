/**
 * v2.0 (этап 1/3): карта исходников контент-скрипта.
 *
 * core/content.js декомпозирован на 5 модулей. Порядок в MODULES — ровно порядок
 * <script> в manifest.json (content_scripts[0].js): модули идут ПЕРЕД content.js.
 *
 * Классические content-скрипты манифеста исполняются в одном изолированном мире и
 * делят ОДИН глобальный лексический скоуп: объявления модулей видны content.js (и
 * наоборот) по прежним именам, без импортов и префиксов. Поэтому конкатенация
 * исходников в этом порядке — тот же текст в том же скоупе, что и в браузере, и
 * source-level пин-тесты читают функции оттуда, где они теперь живут, не меняя
 * ни одного ассерта.
 *
 * Потребители: тесты, которые режут функцию из исходника по имени
 * (`src.indexOf('function ' + name + '(')`) или по маркерам-комментариям.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

const MODULES = [
  'core/state.js',
  'core/widget.js',
  'core/base-handler.js',
  'core/hybrid-tail.js',
  'core/export-manager.js'
];
const CONTENT_JS = 'core/content.js';

/** Пути (от корня репозитория) всех файлов контент-скрипта в порядке manifest.json. */
const SOURCES = MODULES.concat([CONTENT_JS]);

function readSource(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Исходник одного модуля по имени файла ('widget.js' или 'core/widget.js'). */
function moduleSource(name) {
  const rel = name.indexOf('/') === -1 ? 'core/' + name : name;
  return readSource(rel);
}

/** Конкатенация модулей + content.js в порядке manifest.json (единый скоуп). */
const contentSource = SOURCES.map(readSource).join('\n');

module.exports = { ROOT, MODULES, CONTENT_JS, SOURCES, readSource, moduleSource, contentSource };
