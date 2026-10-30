/**
 * §п.8-A, C-zero: контракт ClaudeAdapter на DOM-снимке ОТСУТСТВУЕТ ПО ДИЗАЙНУ.
 *
 * DOM-контракт вакуумный по дизайну; §п.8-B отложен до сбора снимков.
 *
 * Почему так. Рабочий путь захвата Claude — сетевой перехватчик (core/claude-intercept.js,
 * 95 671 Б) плюс архив: adapters/claude-adapter.js:71-76 НАМЕРЕННО возвращает пустой массив
 * («Запасной DOM-парсинг: всегда пустой (основной источник — сеть)»), потому что разметка
 * claude.ai нестабильна (React, нет data-testid). Пин держит ПРИОРИТЕТ intercept-пути:
 * если кто-то начнёт реализовывать DOM-путь и сломает этот приоритет (или уронит контракт
 * адаптера), тест падает. Невакуумность обеспечена не числом реплик (их по дизайну ноль),
 * а проверкой, что загружен настоящий класс адаптера и что intercept-источник на месте.
 */

const fs = require('fs');
const path = require('path');
const { loadAdapter, REPO_ROOT } = require('../helpers/adapter-harness');
const { openOptionsExportGate } = require('../helpers/options-export-gate');

jest.setTimeout(5000);

const DOM_SNAPSHOT =
  '<div class="font-claude-message">Ответ ассистента</div>' +
  '<div class="font-user-message">Вопрос пользователя</div>';

describe('§п.8-A: ClaudeAdapter — C-zero (DOM пуст по дизайну, приоритет — intercept)', function () {
  test('C-zero: extractMessages() возвращает [] — DOM-путь отключён намеренно', function () {
    const res = loadAdapter('adapters/claude-adapter.js', {
      exportExpr: 'ClaudeAdapter',
      document: {
        querySelector: function () { return null; },
        querySelectorAll: function () { return []; },
        body: { innerHTML: DOM_SNAPSHOT },
        documentElement: { innerHTML: DOM_SNAPSHOT }
      },
      location: { hostname: 'claude.ai', pathname: '/chat/p8' }
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
    const intercept = path.join(REPO_ROOT, 'core', 'claude-intercept.js');
    expect(fs.existsSync(intercept)).toBe(true);
    expect(fs.statSync(intercept).size).toBeGreaterThan(10000);
    expect(fs.readFileSync(intercept, 'utf8')).toContain('claude');
  });

  test('v2.0.34: stub-лог extractMessages — debug и один раз на разговор', function () {
    const res = loadAdapter('adapters/claude-adapter.js', {
      exportExpr: 'ClaudeAdapter',
      location: { hostname: 'claude.ai', pathname: '/chat/conv-a' }
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
    // Уровень 'log' у Claude-адаптера больше не используется (анти-спам).
    expect(res.sandbox.logs.filter(function (e) { return e.level === 'log'; })).toEqual([]);

    // Другой разговор (SPA-переход) — новое пояснение, но тоже одно.
    res.sandbox.window.location.pathname = '/chat/conv-b';
    adapter.extractMessages();
    adapter.extractMessages();
    expect(res.sandbox.logs.filter(function (e) {
      return String(e.args[0] || '').indexOf('extractMessages') !== -1;
    }).length).toBe(2);
  });

  test('v2.0.34: сетевой снимок включает экспорт даже при пустом DOM', function () {
    global.URL.createObjectURL = jest.fn(function () { return 'blob:mock'; });
    global.URL.revokeObjectURL = jest.fn();
    const ui = openOptionsExportGate({ history: null });
    expect(ui.md.disabled).toBe(false);
    expect(ui.json.disabled).toBe(false);
    expect(ui.pdf.disabled).toBe(false);
    expect(ui.txt.disabled).toBe(false);
    expect(ui.hint.textContent).toContain('Готово к экспорту');
  });

  test('v2.0.34: клик TXT экспортирует сетевой снимок с пустым convId', function () {
    global.URL.createObjectURL = jest.fn(function () { return 'blob:mock'; });
    global.URL.revokeObjectURL = jest.fn();
    const ui = openOptionsExportGate({
      history: null,
      snapshot: {
        host: 'claude.ai',
        convId: '',
        site: 'claude',
        messages: [{ role: 'user', text: 'вопрос из сети' }]
      }
    });
    ui.txt.click();
    expect(global.URL.createObjectURL).toHaveBeenCalledTimes(1);
    const blob = global.URL.createObjectURL.mock.calls[0][0];
    expect(blob).toBeTruthy();
  });
});
