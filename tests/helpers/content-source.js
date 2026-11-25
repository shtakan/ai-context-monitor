/**
 * v2.0 (этап 1/3): карта исходников контент-скрипта.
 *
 * core/content.ts декомпозирован на 5 модулей. Порядок в MODULES — ровно порядок
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

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const CONTENT_SCRIPTS = manifest.content_scripts[0].js;
const CONTENT_JS = 'core/content.ts';

/**
 * Core-модули контент-скрипта — из manifest, а не из ручного списка. Порядок
 * `content_scripts[0].js` и есть порядок общего лексического скоупа; ручной
 * список разъезжался бы с ним при добавлении нового `content-*.ts`.
 */
const MODULES = CONTENT_SCRIPTS.filter(function (rel) {
  return rel.indexOf('core/') === 0 && rel !== CONTENT_JS;
});

/** Пути (от корня репозитория) всех файлов контент-скрипта в порядке manifest.json. */
const SOURCES = MODULES.concat([CONTENT_JS]);

/**
 * Core-модули, ставшие `.ts`: их читают и как текст (source-level пины),
 * и как код (песочницы `new Function`), поэтому типы снимаются, а комментарии
 * остаются — текст совпадает с до-миграционным.
 */
const TS_EXECUTABLE = new Set(SOURCES.filter(function (rel) {
  return /\.tsx?$/.test(rel);
}));

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
  ROOT, CONTENT_SCRIPTS, MODULES, CONTENT_JS, SOURCES,
  readSource, readExecutable, moduleSource, contentSource
};
