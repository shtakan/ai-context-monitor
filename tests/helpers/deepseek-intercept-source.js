/**
 * v1.3 (Step D.4): карта исходников MAIN-перехватчика DeepSeek.
 *
 * core/deepseek-intercept.js декомпозирован: кластер диагностики (СЕКЦИЯ 13/13D/13B —
 * диагностический дампа, вербатим usage по ходам, измерение live vs network) вынесен
 * в core/deepseek-diag.js (шаг D.1), кластер сетевого дозапроса истории в момент
 * экспорта (СЕКЦИЯ 9C, O-18 фаза 2) — в core/deepseek-netsync.js (шаг D.2), кластер
 * REFETCH/URL-гигиены (СЕКЦИЯ 10 — гард перекрёста convId, СЕКЦИЯ 10B — хелперы
 * MERGE-дозапроса: collectHeaders/stripCacheParams/historyRefetchUrl/historyUrlForConv/
 * refetchFullHistory/scheduleHistoryRefetch) — в core/deepseek-refetch.js (шаг D.3),
 * кластер цепочки/текста хода (СЕКЦИЯ 5 — MODEL-хелпер getModelSlug, СЕКЦИЯ 6 —
 * buildActiveChain, СЕКЦИЯ 7 — collectTurnText/collectTurnReasoning/composeTurnText +
 * hidden-пометки базы DS_PP_VISIBLE_MARKER/hasInjectedUserPrompt) — в
 * core/deepseek-parse.js (шаг D.4).
 * Порядок в MODULES — ровно порядок инъекции в core/background.js (registerSafe
 * 'ai-cm-deepseek-intercept-v6', document_start, world 'MAIN'): модули идут ПЕРЕД
 * core/deepseek-intercept.js.
 *
 * Скрипты одного registerContentScripts-пакета исполняются в одном мировом глобальном
 * лексическом скоупе: до связки на window.AiCmDeepseekDiag / window.AiCmDeepseekNetsync /
 * window.AiCmDeepseekRefetch / window.AiCmDeepseekParse лежит только __bind, после связки
 * ядро раздаёт значения функций модулей по прежним именам (alias-блоки в ядре).
 * Тела модулей объявлены ВНУТРИ `with (D) { … }` и НЕ имеют префиксов `D.` — свободные
 * имена резолвятся в with-объект (ES3 Annex B), как в gemini-oracle.js / pagination.js.
 * Часть тел живёт в PURE-зонах модулей (вне with) — им ядро не нужно.
 *
 * ВАЖНО: перенос кода обязан быть БАЙТОВЫМ, включая ведущие отступы, и рабочие файлы
 * обязаны остаться в LF (.gitattributes: *.js text eol=lf). Часть пин-тестов ищет
 * литералы с ведущими пробелами и режет функции по терминаторам '\n  function '.
 *
 * Потребители: тесты, которые режут функцию из источника по имени
 * (`src.indexOf('function ' + name + '(')`) или по маркерам-комментариям.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// Порядок = порядок js[] в core/background.js для 'ai-cm-deepseek-intercept-v6'.
// utils/debug.js сюда НЕ входит: он не декомпозировался (как и в content-source.js).
const MODULES = [
  'core/deepseek-diag.js',
  'core/deepseek-netsync.js',
  'core/deepseek-refetch.js',
  'core/deepseek-parse.js'
];
const INTERCEPT_JS = 'core/deepseek-intercept.js';

/** Пути (от корня репозитория) всех файлов перехватчика в порядке инъекции. */
const SOURCES = MODULES.concat([INTERCEPT_JS]);

function readSource(rel) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  // Рабочая копия на Windows может быть CRLF (eol=lf в .gitattributes гарантирует LF
  // только в индексе/блобах) — нормализуем к LF, чтобы склейка была байт-стабильной.
  return text.replace(/\r\n/g, '\n');
}

/** Исходник одного модуля по имени файла ('deepseek-diag.js' или с 'core/'). */
function moduleSource(name) {
  const rel = name.indexOf('/') === -1 ? 'core/' + name : name;
  return readSource(rel);
}

/** Конкатенация модулей + deepseek-intercept.js в порядке инъекции (единый скоуп). */
const deepseekSource = SOURCES.map(readSource).join('\n');

module.exports = {
  ROOT,
  MODULES,
  INTERCEPT_JS,
  SOURCES,
  readSource,
  moduleSource,
  deepseekSource,
  // алиасы, чтобы свопы читались единообразно с gemini-intercept-source.js:
  interceptSource: deepseekSource,
  source: deepseekSource
};