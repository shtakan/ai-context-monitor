/**
 * v2.0 (этап 2/3): карта исходников MAIN-перехватчика Gemini.
 *
 * core/gemini-intercept.js декомпозирован: кластер скрытого скролла вынесен в
 * core/gemini-hidden-scroll.js. Порядок в MODULES — ровно порядок инъекции в
 * core/background.js (registerSafe 'ai-cm-gemini-intercept', document_start,
 * world 'MAIN'): модули идут ПЕРЕД core/gemini-intercept.js.
 *
 * v2.0 (Phase 3 step 1): кластер диагностики (DIAG_TOKENS-сканер и логи холодного старта) вынесен
 * в core/gemini-diag.js и добавлен в MODULES тем же порядком, что и в js[] core/background.js
 * (hidden-scroll -> diag -> ядро). Ядро при отсутствии модуля деградирует мягко, но в браузере
 * он подключён всегда, поэтому конкатенация ниже по-прежнему равна единому скоупу страницы.
 *
 * v2.0 (Phase 3 step 6): кластер парсеров кадра batchexecute (parseByBytes / parseByLines /
 * parseBatchExecute + tolerant-salvage обрезанного кадра) вынесен в core/gemini-parse.js и
 * добавлен в MODULES тем же порядком, что и в js[] core/background.js (rpc -> parse -> ядро).
 * Парсеры живут в модуле, поэтому fnDecl(...) режет их ОТТУДА; в ядре остались только
 * блок связки (__bind + алиасы) и handleOuter, который модуль получает инжекцией.
 * Песочницы тестов передают модулю его зависимости как ctx.D = ctx (D.<имя> — биндинг).
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
  'core/gemini-hidden-scroll.js',
  'core/gemini-diag.js',
  'core/gemini-rpc.js',
  'core/gemini-parse.js'
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
