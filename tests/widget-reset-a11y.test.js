'use strict';

/**
 * BUG-19: сброс бейджа в «—» возвращает и доступное имя (aria-label).
 * До фикса на новом чате текст был «—», а aria-label держал «30.9 %» старого треда.
 */

const { moduleSource } = require('./helpers/content-source.js');
const WIDGET = moduleSource('widget.ts');

function fnDecl(src, name) {
  const start = src.indexOf('function ' + name + '(');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced declaration: ' + name);
}

const makeReset = new Function('ctx',
  'with (ctx) { ' + fnDecl(WIDGET, 'aiCmResetWidgetA11yLabel') + '\n return aiCmResetWidgetA11yLabel; }');

describe('BUG-19: aria-label при сбросе бейджа', () => {
  test('ставит исходное доступное имя, а не процент прошлого треда', function () {
    const attrs = {};
    makeReset({
      aiCmI18nMessage: function (key, fallback) { return fallback; }
    })({ setAttribute: function (k, v) { attrs[k] = v; } });
    expect(attrs['aria-label']).toBe('Открыть панель порога контекста');
  });

  test('использует локализованный ключ, если хелпер есть', function () {
    const attrs = {};
    makeReset({
      aiCmI18nMessage: function (key, fallback) { return key === 'content_a11y_circle_initial' ? 'LOCALIZED' : fallback; }
    })({ setAttribute: function (k, v) { attrs[k] = v; } });
    expect(attrs['aria-label']).toBe('LOCALIZED');
  });

  test('source: resetConversationState вызывает сброс a11y рядом с «—»', function () {
    const reset = fnDecl(WIDGET, 'resetConversationState');
    expect(reset).toContain("pt.textContent = '—'");
    expect(reset).toContain('aiCmResetWidgetA11yLabel(widgetElement.querySelector(\'.ai-widget-circle\'))');
  });
});
