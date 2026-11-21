'use strict';

/**
 * Фаза 4: единый владелец partial/partialReason.
 * partial=true без причины → incomplete; partial=false/нет снимка → ключей нет;
 * неизвестная непустая причина сохраняется (байтовый паритет).
 */

const { derivePartial, PARTIAL_REASONS } = require('../utils/export/completeness.ts');
const { moduleSource } = require('./helpers/content-source.js');

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

  test('source: manual/auto/current-history используют мост', function () {
    const content = moduleSource('content.ts');
    const mgr = moduleSource('export-manager.ts');
    const contentCalls = (content.match(/aiCmExportPartialView\(/g) || []).length;
    expect(contentCalls).toBeGreaterThanOrEqual(4); // net + adapter + manual + declaration
    expect(mgr).toContain('aiCmExportPartialView');
  });
});
