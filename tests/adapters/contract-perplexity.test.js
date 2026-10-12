/**
 * §п.8-A, C-zero: контракт PerplexityAdapter на DOM-снимке ОТСУТСТВУЕТ ПО ДИЗАЙНУ.
 *
 * DOM-контракт вакуумный по дизайну; §п.8-B отложен до сбора снимков.
 *
 * Почему так. Рабочий путь захвата Perplexity — сетевой перехватчик
 * (core/perplexity-intercept.js, 29 815 Б) плюс архив: adapters/perplexity-adapter.js:72-76
 * НАМЕРЕННО возвращает пустой массив («Запасной DOM-парсинг: всегда пустой (основной источник —
 * сеть)»). Пин держит ПРИОРИТЕТ intercept-пути: если кто-то начнёт реализовывать DOM-путь и
 * сломает этот приоритет (или уронит контракт адаптера), тест падает. Невакуумность обеспечена
 * не числом реплик (их по дизайну ноль), а проверкой, что загружен настоящий класс адаптера
 * и что intercept-источник на месте.
 */

const fs = require('fs');
const path = require('path');
const { loadAdapter, REPO_ROOT } = require('../helpers/adapter-harness');

jest.setTimeout(5000);

const DOM_SNAPSHOT =
  '<div class="prose">Ответ ассистента</div>' +
  '<div class="whitespace-pre-wrap">Вопрос пользователя</div>';

describe('§п.8-A: PerplexityAdapter — C-zero (DOM пуст по дизайну, приоритет — intercept)', function () {
  test('C-zero: extractMessages() возвращает [] — DOM-путь отключён намеренно', function () {
    const res = loadAdapter('adapters/perplexity-adapter.js', {
      exportExpr: 'PerplexityAdapter',
      document: {
        querySelector: function () { return null; },
        querySelectorAll: function () { return []; },
        body: { innerHTML: DOM_SNAPSHOT },
        documentElement: { innerHTML: DOM_SNAPSHOT }
      },
      location: { hostname: 'www.perplexity.ai', pathname: '/search/p8' }
    });
    const adapter = res.Adapter;

    // невакуумный страж: загружен настоящий класс, а не пустой object-заглушка
    expect(typeof res.Ctor).toBe('function');
    expect(typeof adapter.extractMessages).toBe('function');
    expect(adapter.isOnDialogPage()).toBe(true);
    expect(res.sandbox.errors.length).toBe(0);

    // сам пин: DOM-контракт пуст ПО ДИЗАЙНУ (рабочий путь — intercept + архив)
    expect(adapter.extractMessages()).toEqual([]);

    // рабочий путь на месте: сетевой перехватчик существует и не пуст
    const intercept = path.join(REPO_ROOT, 'core', 'perplexity-intercept.js');
    expect(fs.existsSync(intercept)).toBe(true);
    expect(fs.statSync(intercept).size).toBeGreaterThan(10000);
    expect(fs.readFileSync(intercept, 'utf8')).toContain('perplexity');
  });
});
