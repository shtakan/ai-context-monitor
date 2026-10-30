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
const { openOptionsExportGate, defaultState } = require('../helpers/options-export-gate');
const { stripPerplexityHistoryTruncation } = require('../../utils/perplexity-parser.js');

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

  test('v2.0.34: stub-лог extractMessages — debug и один раз на разговор', function () {
    const res = loadAdapter('adapters/perplexity-adapter.js', {
      exportExpr: 'PerplexityAdapter',
      location: { hostname: 'www.perplexity.ai', pathname: '/search/conv-a' }
    });
    const adapter = res.Adapter;

    adapter.extractMessages();
    adapter.extractMessages();
    adapter.extractMessages();

    const stubLogs = res.sandbox.logs.filter(function (e) {
      return String(e.args[0] || '').indexOf('extractMessages') !== -1;
    });
    expect(stubLogs.length).toBe(1);
    expect(stubLogs[0].level).toBe('debug');
    expect(res.sandbox.logs.filter(function (e) { return e.level === 'log'; })).toEqual([]);

    res.sandbox.window.location.pathname = '/search/conv-b';
    adapter.extractMessages();
    adapter.extractMessages();
    expect(res.sandbox.logs.filter(function (e) {
      return String(e.args[0] || '').indexOf('extractMessages') !== -1;
    }).length).toBe(2);
  });

  test('v2.0.34: шаблон истории не закрепляет limit/offset/from_first', function () {
    const url = 'https://www.perplexity.ai/rest/thread/abc123' +
      '?with_parent_info=true&supported_block_use_cases=true' +
      '&limit=20&offset=0&from_first=false';
    const normalized = stripPerplexityHistoryTruncation(url);
    expect(normalized).not.toContain('limit=');
    expect(normalized).not.toContain('offset=');
    expect(normalized).not.toContain('from_first=');
    expect(normalized).toContain('with_parent_info=true');
    expect(normalized).toContain('supported_block_use_cases=true');
    // Хвост/хэш и порядок прочих параметров не трогаем.
    expect(stripPerplexityHistoryTruncation('https://x/thread/a?b=1&limit=20#frag'))
      .toBe('https://x/thread/a?b=1#frag');
  });

  test('v2.0.34: сетевой снимок включает экспорт даже при пустом DOM', function () {
    const host = 'www.perplexity.ai';
    const state = defaultState(host, 'perplexity');
    const ui = openOptionsExportGate({
      host: host,
      tabUrl: 'https://' + host + '/search/conv-a',
      state: state,
      history: null
    });
    expect(ui.md.disabled).toBe(false);
    expect(ui.json.disabled).toBe(false);
    expect(ui.pdf.disabled).toBe(false);
    expect(ui.txt.disabled).toBe(false);
    expect(ui.hint.textContent).toContain('Готово к экспорту');
  });
});
