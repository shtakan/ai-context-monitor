'use strict';
/**
 * M1 (QUALITY_AUDIT): fileTextCache в core/claude-intercept.js — строгий LRU
 * на 50 записей.
 *
 * Кэш живёт внутри IIFE перехватчика и наружу не экспортируется (нет test-hook),
 * поэтому извлекаем его фрагмент исходника и исполняем в new Function — та же
 * конвенция source-pin тестов, что и в tests/helpers/main-intercept.js.
 */

const fs = require('fs');
const path = require('path');

const CLAUDE_REL = 'core/claude-intercept.js';
const START = '  var fileTextCache = {};';
const END = '  var lastHistoryRaw = null;';

const SRC = fs
  .readFileSync(path.join(__dirname, '..', 'core', 'claude-intercept.js'), 'utf8')
  .replace(/^\uFEFF/, '');

function loadFileTextCache() {
  const from = SRC.indexOf(START);
  const to = SRC.indexOf(END, from);
  if (from === -1 || to === -1) {
    throw new Error('M1: не найден блок fileTextCache в ' + CLAUDE_REL);
  }
  const fragment = SRC.slice(from, to);
  const factory = new Function(
    'swallow',
    fragment +
      '\n' +
      [
        'return {',
        '  insert: fileTextCacheInsert,',
        '  touch: fileTextCacheTouch,',
        '  has: function (k) { return Object.prototype.hasOwnProperty.call(fileTextCache, k); },',
        '  value: function (k) { return fileTextCache[k]; },',
        '  size: function () { return Object.keys(fileTextCache).length; },',
        '  order: function () { return fileTextCacheOrder.slice(); },',
        '  max: fileTextCacheMax',
        '};',
      ].join('\n')
  );
  return factory(function () {});
}

describe('M1: fileTextCache — LRU-лимит', function () {
  test('исходник помечен M1, лимит равен 50', function () {
    expect(SRC).toContain('(M1)');
    const cache = loadFileTextCache();
    expect(cache.max).toBe(50);
  });

  test('при переполнении вытесняются самые старые записи', function () {
    const cache = loadFileTextCache();
    for (let i = 0; i < 60; i++) cache.insert('file-' + i, 'text-' + i);

    expect(cache.size()).toBe(50);
    for (let i = 0; i < 10; i++) {
      expect(cache.has('file-' + i)).toBe(false);
    }
    for (let i = 10; i < 60; i++) {
      expect(cache.has('file-' + i)).toBe(true);
      expect(cache.value('file-' + i)).toBe('text-' + i);
    }
    expect(cache.order()).toEqual(
      Array.from({ length: 50 }, function (_, i) { return 'file-' + (i + 10); })
    );
  });

  test('true-LRU: обращение (touch) спасает запись от вытеснения', function () {
    const cache = loadFileTextCache();
    for (let i = 0; i < 50; i++) cache.insert('file-' + i, 'text-' + i);
    expect(cache.size()).toBe(50);

    // file-0 — самая старая; попадание в кэш должно освежить её.
    cache.touch('file-0');
    expect(cache.order()[cache.order().length - 1]).toBe('file-0');

    cache.insert('file-50', 'text-50');
    expect(cache.size()).toBe(50);
    expect(cache.has('file-0')).toBe(true); // спасена touch'ем
    expect(cache.has('file-1')).toBe(false); // вытеснена как самая старая
    expect(cache.has('file-50')).toBe(true);
  });

  test('повторная вставка не увеличивает размер и освежает запись', function () {
    const cache = loadFileTextCache();
    cache.insert('a', '1');
    cache.insert('b', '2');
    cache.insert('a', '3');

    expect(cache.size()).toBe(2);
    expect(cache.value('a')).toBe('3');
    expect(cache.order()).toEqual(['b', 'a']);
  });

  test('touch несуществующего ключа — no-op', function () {
    const cache = loadFileTextCache();
    cache.insert('a', '1');
    expect(function () { cache.touch('missing'); }).not.toThrow();
    expect(cache.order()).toEqual(['a']);
    expect(cache.size()).toBe(1);
  });
});
