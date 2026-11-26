'use strict';

/**
 * Фаза 4: единый владелец partial/partialReason.
 * partial=true без причины → incomplete; partial=false/нет снимка → ключей нет;
 * неизвестная непустая причина сохраняется (байтовый паритет).
 */

const { derivePartial, PARTIAL_REASONS } = require('../utils/export/completeness.ts');
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

describe('export/completeness: derivePartial', () => {
  test('все причины словаря проходят как есть', function () {
    for (const reason of PARTIAL_REASONS) {
      expect(derivePartial({ partial: true, partialReason: reason })).toEqual({ partial: true, partialReason: reason });
    }
  });

  test('partial=true без причины → incomplete', function () {
    expect(derivePartial({ partial: true })).toEqual({ partial: true, partialReason: 'incomplete' });
    expect(derivePartial({ partial: true, partialReason: '   ' })).toEqual({ partial: true, partialReason: 'incomplete' });
  });

  test('partial=false/null/undefined → оба ключа undefined (JSON их опустит)', function () {
    const empty = { partial: undefined, partialReason: undefined };
    expect(derivePartial(null)).toEqual(empty);
    expect(derivePartial(undefined)).toEqual(empty);
    expect(derivePartial({ partial: false, partialReason: 'stale' })).toEqual(empty);
    expect(JSON.stringify(derivePartial({ partial: false }))).toBe('{}');
  });

  test('неизвестная непустая причина сохраняется; вход не мутируется', function () {
    const src = { partial: true, partialReason: 'legacy-reason' };
    expect(derivePartial(src)).toEqual({ partial: true, partialReason: 'legacy-reason' });
    expect(src).toEqual({ partial: true, partialReason: 'legacy-reason' });
  });

  test('P3 union: конкретная причина GSA не сворачивается в incomplete', function () {
    const content = moduleSource('content.ts');
    const reasonOf = new Function('ctx',
      'with (ctx) { ' + fnDecl(content, 'aiCmPartialReasonFromBase') + '\n return aiCmPartialReasonFromBase; }')({});
    expect(reasonOf('passive-incomplete:stream', false)).toBe('passive-incomplete:stream');
    expect(reasonOf('passive-incomplete:history-cursor', false)).toBe('passive-incomplete:history-cursor');
    expect(reasonOf('passive-incomplete:missing-user-text', false)).toBe('missing-user-text');
    expect(reasonOf('passive-complete', false)).toBe('incomplete');
    expect(reasonOf('incomplete', false)).toBe('incomplete');
    expect(reasonOf('passive-incomplete:stream', true)).toBe('stopped');

    const state = moduleSource('state.ts');
    const commit = new Function('ctx',
      'with (ctx) { ' + fnDecl(state, 'aiCmCommitContextSnapshot') + '\n return aiCmCommitContextSnapshot; }')({
      aiCmLoaderRunningByConv: null,
      aiCmGsaProbeRunningFor: function () { return false; },
      aiCmNetSnapshotPending: function () { return false; }
    });
    const next = {
      convId: 'c1', capturedAt: 1, site: 'google_search', model: 'm', modelName: 'm',
      src: 'net', tokens: 1, percent: 1, limit: 1, effectiveLimit: 1, contextLimit: 1,
      partial: true, partialReason: 'passive-incomplete:stream', bodyHash: 'h1'
    };
    const prev = Object.assign({}, next, { partialReason: 'incomplete' });
    expect(commit(prev, next).partialReason).toBe('passive-incomplete:stream');

    // Окно сбора: удержанный снимок сохраняет конкретную причину кандидата.
    const held = commit(
      Object.assign({}, next, { partialReason: 'passive-incomplete:history-cursor' }),
      Object.assign({}, next, { bodyHash: '' })
    );
    expect(held.partialReason).toBe('passive-incomplete:stream');

    // Без partial причина удаляется.
    const clean = commit(prev, Object.assign({}, next, { partial: false }));
    expect('partialReason' in clean).toBe(false);
  });

  test('source: manual/auto/current-history используют мост', function () {
    const content = require('./helpers/content-source.js').contentSource;
    const mgr = moduleSource('export-manager.ts');
    const contentCalls = (content.match(/aiCmExportPartialView\(/g) || []).length;
    expect(contentCalls).toBeGreaterThanOrEqual(4); // net + adapter + manual + declaration
    expect(mgr).toContain('aiCmExportPartialView');
  });
});
