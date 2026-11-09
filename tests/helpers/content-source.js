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
const { readCore } = require('./core-src.js');
const path = require('path');

const { stripTypesKeepComments } = require('./read-module-source.js');

const ROOT = path.join(__dirname, '..', '..');

const MODULES = [
  'core/state.ts',
  'core/widget.ts',
  'core/base-handler.ts',
  'core/hybrid-tail.ts',
  'core/export-manager.ts'
];
const CONTENT_JS = 'core/content.js';

/** Пути (от корня репозитория) всех файлов контент-скрипта в порядке manifest.json. */
const SOURCES = MODULES.concat([CONTENT_JS]);

/**
 * Модули Core Wave 1, ставшие `.ts`: их читают и как текст (source-level пины),
 * и как код (песочницы `new Function`), поэтому типы снимаются, а комментарии
 * остаются — текст совпадает с до-миграционным.
 */
const TS_EXECUTABLE = new Set([
  'core/state.ts',
  'core/widget.ts',
  'core/base-handler.ts',
  'core/hybrid-tail.ts',
  'core/export-manager.ts'
]);

/** Исходник файла: для мигрированных `.ts` — в исполнимой форме. */
function readSource(rel) {
  const source = readCore(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  if (!TS_EXECUTABLE.has(rel)) return source;
  return stripTypesKeepComments(source, rel);
}

/** Исходник в «исполнимой» форме: любые `.ts` отдаются без типов. */
function readExecutable(rel) {
  const source = readCore(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  if (!/\.tsx?$/.test(rel)) return source;
  return stripTypesKeepComments(source, rel);
}

/** Исходник одного модуля по имени файла ('widget.ts' или 'core/widget.ts'). */
function moduleSource(name) {
  const rel = name.indexOf('/') === -1 ? 'core/' + name : name;
  return readExecutable(rel);
}

/** Конкатенация модулей + content.js в порядке manifest.json (единый скоуп). */
const contentSource = SOURCES.map(readExecutable).join('\n');

module.exports = {
  ROOT, MODULES, CONTENT_JS, SOURCES, readSource, readExecutable, moduleSource, contentSource
};
