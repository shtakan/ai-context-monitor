/**
 * Реэкспорт parsePerplexityThread из utils/perplexity-parser.js для тестов.
 * Функция — единая для боевого кода (window.parsePerplexityThread) и тестов.
 */

const { parsePerplexityThread } = require('../../utils/perplexity-parser');

module.exports = { parsePerplexityThread };