/**
 * Реэкспорт parsePerplexityThread из utils/perplexity-parser.js для тестов.
 * Ph2: модуль — ES-модуль, поэтому грузится через loadEsmModule (named-экспорты);
 * window.parsePerplexityThread больше не публикуется.
 */

const { loadEsmModule } = require('./load-esm.js');

const { parsePerplexityThread } = loadEsmModule('utils/perplexity-parser.js');

module.exports = { parsePerplexityThread };
