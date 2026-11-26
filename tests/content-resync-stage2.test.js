'use strict';
/**
 * 2.4 Stage 2: чистое решение ресинка метрик (core/content-resync.ts).
 *
 * Фиксируются правила v95/v96/v1.9 без DOM/state:
 *   рост среза → resync; тот же histKey + тот же raw → skip;
 *   короткий срез → shrink; та же длина сообщений, но короче текст → shrink-length;
 *   выросший raw при том же histKey → resync-raw (ключ будет снят).
 */
const { moduleSource } = require('./helpers/content-source.js');

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

const RESYNC = moduleSource('content-resync.ts');
const resolveResyncDecision = new Function('ctx',
  'with (ctx) { ' + fnDecl(RESYNC, 'resolveResyncDecision') + '\n return resolveResyncDecision; }'
)({});

function input(over) {
  return Object.assign({
    finalCount: 120,
    previousCount: 101,
    finalLength: 6000,
    previousLength: 5000,
    newKey: '120|6000',
    lastHistoryWroteKey: '101|5000',
    rawKnown: true,
    rawCount: 101,
    previousRawCount: 101
  }, over || {});
}

describe('2.4 Stage 2: resolveResyncDecision — чистый вердикт', function () {
  test('рост среза: resync, ключ обновляется', function () {
    const d = resolveResyncDecision(input());
    expect(d).toMatchObject({ verdict: 'resync', canSkip: false, shrinkCount: false, shrinkLength: false, keyRepeated: false, rawUnchanged: true });
  });

  test('тот же histKey и тот же raw: skip', function () {
    const d = resolveResyncDecision(input({
      finalCount: 101, previousCount: 101, finalLength: 5000, previousLength: 5000,
      newKey: '101|5000', lastHistoryWroteKey: '101|5000', rawCount: 101, previousRawCount: 101
    }));
    expect(d).toMatchObject({ verdict: 'skip', canSkip: true, keyRepeated: true, rawUnchanged: true });
  });

  test('финальный срез короче базы: shrink', function () {
    const d = resolveResyncDecision(input({ finalCount: 80, finalLength: 4000, newKey: '80|4000' }));
    expect(d).toMatchObject({ verdict: 'shrink', shrinkCount: true, canSkip: false });
  });

  test('то же число сообщений, но текст короче: shrink-length', function () {
    const d = resolveResyncDecision(input({
      finalCount: 88, previousCount: 88, finalLength: 249856, previousLength: 568620,
      newKey: '88|249856', lastHistoryWroteKey: '88|568620', rawCount: 88, previousRawCount: 88
    }));
    expect(d).toMatchObject({ verdict: 'shrink-length', shrinkLength: true, canSkip: false });
  });

  test('raw вырос, histKey тот же: resync-raw, keyRepeated=true', function () {
    const d = resolveResyncDecision(input({
      finalCount: 101, previousCount: 101, finalLength: 5000, previousLength: 5000,
      newKey: '101|5000', lastHistoryWroteKey: '101|5000', rawCount: 120, previousRawCount: 101
    }));
    expect(d).toMatchObject({ verdict: 'resync-raw', rawUnchanged: false, canSkip: false, keyRepeated: true });
  });

  test('raw неизвестен (срез-песочница): неизменен, поведение прежнее', function () {
    const d = resolveResyncDecision(input({
      finalCount: 101, previousCount: 101, finalLength: 5000, previousLength: 5000,
      newKey: '101|5000', lastHistoryWroteKey: '101|5000', rawKnown: false
    }));
    expect(d).toMatchObject({ verdict: 'skip', rawUnchanged: true, canSkip: true });
  });

  test('raw вырос и срез реально дорос: resync-raw, keyRepeated=false', function () {
    const d = resolveResyncDecision(input({ rawCount: 120, previousRawCount: 101 }));
    expect(d).toMatchObject({ verdict: 'resync-raw', rawUnchanged: false, keyRepeated: false });
  });
});
