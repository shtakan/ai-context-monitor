'use strict';

/**
 * BUG-14 регресс: автоэкспорт AI Studio планируется на сетевом пути.
 *
 * До фикса обе точки планирования были недостижимы: 'ai-cm-full-history'
 * AI Studio не диспатчит, а adapter-ветка закрыта флагом !baseSeen —
 * базу взводит aiCmApplyAistudioNetBase() раньше. Файла не было никогда.
 * Теперь aiCmAfterAistudioNetKick() планирует проверку после processAndSend,
 * когда lastPercentage уже пересчитан по сетевой базе.
 */

const CONTENT = require('./helpers/content-source.js').contentSource;

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

const makeKick = new Function('ctx',
  'with (ctx) { ' + fnDecl(CONTENT, 'aiCmAfterAistudioNetKick') + '\n return aiCmAfterAistudioNetKick; }');

describe('BUG-14: автоэкспорт AI Studio планируется', () => {
  test('kick планирует автоэкспорт со свежим lastPercentage после processAndSend', function () {
    const calls = [];
    const ctx = {
      isInitialized: true,
      lastPercentage: -1,
      processAndSend: function () { ctx.lastPercentage = 30.9; calls.push('process'); },
      aiCmScheduleAutoExport: function (pct) { calls.push('schedule:' + pct); },
      swallowSoft: function () { }
    };
    makeKick(ctx)();
    expect(ctx.lastPercentage).toBe(30.9);
    expect(calls).toEqual(['process', 'schedule:30.9']);
  });

  test('source: ingest сетевой истории доводит до kick, kick — до планировщика', function () {
    const kick = fnDecl(CONTENT, 'aiCmAfterAistudioNetKick');
    const ingest = fnDecl(CONTENT, 'aiCmIngestAistudioNet');
    expect(ingest).toContain('aiCmAfterAistudioNetKick()');
    expect(kick).toContain('aiCmScheduleAutoExport(lastPercentage)');
    // порядок внутри kick: сначала пересчёт pct, потом планирование
    expect(kick.indexOf('processAndSend()')).toBeGreaterThan(-1);
    expect(kick.indexOf('processAndSend()')).toBeLessThan(kick.indexOf('aiCmScheduleAutoExport(lastPercentage)'));
  });

  test('source: база сети применяется до kick (иначе снова !baseSeen)', function () {
    const ingest = fnDecl(CONTENT, 'aiCmIngestAistudioNet');
    expect(ingest.indexOf('aiCmApplyAistudioNetBase()')).toBeGreaterThan(-1);
    expect(ingest.indexOf('aiCmApplyAistudioNetBase()')).toBeLessThan(ingest.indexOf('aiCmAfterAistudioNetKick()'));
  });
});
