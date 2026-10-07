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
 * v2.0 (Phase 3 step 9): SSE-кластер (перехват сети — врапперы fetch и XMLHttpRequest) вынесен
 * в core/gemini-sse.js и добавлен в MODULES тем же порядком, что и в js[] core/background.js
 * (parse -> sse -> ядро). Модуль не объявляет врапперы на верхнем уровне: ядро получает
 * installNetworkHooks() и зовёт его из прежнего места установки, поэтому конкатенация ниже
 * по-прежнему ставит сетевые патчи ровно один раз и в исходном порядке.
 *
 * v2.0 (Phase 3 step 10): кластер пагинации и контроля полноты (extractCursor/
 * classifyOpaque(+Wide)/findCursors/edges8/refreshMinOrderTracking, paginateLoop, finishQuiet,
 * runCompletenessProbe, runCompletenessWatchdog, finishWatchdogDecision) вынесен в
 * core/pagination/pagination.js и добавлен в MODULES тем же порядком, что и в js[]
 * core/background.js (sse -> pagination -> ядро). Тела функций перенесены БАЙТОВЫМИ, без
 * префикса `D.`: объявления лежат внутри `with (D) { … }`, поэтому свободное имя
 * резолвится в with-объект. Именно этим механизмом — и только им — существующие пины
 * исполняют вырезанные тела (`with (ctx)`, без ключа D), поэтому ассерты не менялись ни
 * в одном сьюте.
 *
 * v2.0 (Phase 3 step 11): кластер лоадера полной истории (LOADER_*, MIN_SCROLL_H_FOR_ENGAGEMENT,
 * SCROLL_PAUSE_HIDDEN_MS, loadFullHistoryInvisibly со вложенными помощниками,
 * LOADER_SIGNAL_WAIT_*, maybeStartLoader, слушатель visibilitychange, консольный хэндл ручного
 * запуска) вынесен в core/gemini-loader-scroll.js и добавлен в MODULES тем же порядком, что и в
 * js[] core/background.js (pagination -> loader-scroll -> ядро). В отличие от шага 10, тела
 * перенесены с префиксом `D.` (объявления лежат в IIFE-каркасе модуля, а не в `with (D)`),
 * поэтому песочницы, исполняющие вырезанные тела, обязаны получить ключ `D: ctx` (см. выше).
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
// Phase 3 step 12: core/gemini-ingest.js идёт после loader-scroll и перед ядром — как в js[].
// Phase 3 step 13.1: core/gemini-overlay.js идёт после ingest и перед ядром — как в js[].
// Тела оверлея перенесены с префиксом D (IIFE-каркас, а не `with (D)`): песочницы, которые
// исполняют вырезанные тела, обязаны получить объект связи D (см. gemini-widget-theme-h22).
// Phase 3 step 13.2: core/gemini-archive.js идёт после overlay и перед ядром — как в js[].
// Тела архива тоже перенесены с префиксом D, поэтому песочницы archive-export-gate и
// archive-export-union получают объект связи D рядом с прежними свободными именами.
// Phase 3 step 13.3: core/gemini-oracle.js идёт после archive и перед ядром — как в js[].
// Тела оракула перенесены БЕЗ префикса D (объявления лежат внутри `with (D) { … }`, как в
// pagination и ingest), поэтому песочницы gemini-floor-confirmed / gemini-floor-self-heal /
// gemini-collapse-guard / o48-gemini-parse-fail-salvage режут тела ОТСЮДА и исполняют их
// в `with (ctx)` без ключа D — ни один ассерт этих пинов не менялся.
const MODULES = [
  'core/gemini-hidden-scroll.js',
  'core/gemini-diag.js',
  'core/gemini-rpc.js',
  'core/gemini-parse.js',
  'core/gemini-sse.js',
  'core/pagination/pagination.js',
  'core/gemini-loader-scroll.js',
  'core/gemini-ingest.js',
  'core/gemini-overlay.js',
  'core/gemini-archive.js',
  'core/gemini-oracle.js'
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
