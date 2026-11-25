/**
 * Stage 0 (2.3): единый источник порядка core-модулей контент-скрипта.
 *
 * `tests/helpers/content-source.js` собирает общий лексический скоуп из
 * `manifest.content_scripts[0].js`. Если manifest и тестовый бандл разъедутся,
 * source-level пины начнут искать функции не в том файле, а песочницы — терять
 * объявления. Этот пин ловит расхождение до первого переноса.
 */

const fs = require('fs');
const path = require('path');
const H = require('./helpers/content-source.js');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
const scripts = manifest.content_scripts[0].js;
const core = scripts.filter(function (rel) { return rel.indexOf('core/') === 0; });

describe('2.3 Stage 0: порядок core-модулей контент-скрипта', () => {
  test('content.ts — последний скрипт, core-хвост совпадает с SOURCES', () => {
    expect(scripts[scripts.length - 1]).toBe(H.CONTENT_JS);
    expect(core).toEqual(H.SOURCES);
    expect(H.SOURCES[H.SOURCES.length - 1]).toBe(H.CONTENT_JS);
    expect(new Set(H.SOURCES).size).toBe(H.SOURCES.length);
  });

  test('каждый core-модуль существует и не пуст', () => {
    H.SOURCES.forEach(function (rel) {
      const abs = path.join(H.ROOT, rel);
      expect([rel, fs.existsSync(abs)]).toEqual([rel, true]);
      expect([rel, fs.statSync(abs).size > 0]).toEqual([rel, true]);
    });
  });

  test('MODULES не содержит content.ts и не выходит за core/', () => {
    expect(H.MODULES).not.toContain(H.CONTENT_JS);
    H.MODULES.forEach(function (rel) {
      expect(rel.indexOf('core/')).toBe(0);
    });
  });
});
