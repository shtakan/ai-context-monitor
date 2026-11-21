'use strict';

/**
 * Фаза 3, I5: live и reload одного Qwen-треда дают один состав.
 * Проверяем чистый reconcile на синтетическом треде: 10 ходов / 20 сообщений,
 * как в живом прогоне (20/20, roleHash 8ac38489).
 */

const { canonicalizeMessages, messageHash } = require('../utils/messages/canonicalize.ts');
const { reconcile } = require('../utils/messages/reconcile.ts');

function rawThread(pairs, overrides) {
  const out = [];
  for (let i = 0; i < pairs.length; i++) {
    out.push({ role: 'user', text: pairs[i][0], ordinal: i * 2, nodeType: 'message' });
    out.push({ role: 'assistant', text: pairs[i][1], ordinal: i * 2 + 1, nodeType: 'message' });
  }
  if (overrides) {
    for (const idx in overrides) out[Number(idx)].text = overrides[idx];
  }
  return out;
}

function threadOf(pairs, kind, complete, overrides) {
  return canonicalizeMessages(rawThread(pairs, overrides), {
    platform: 'qwen',
    convId: 'c1d7e850',
    kind: kind,
    capturedAt: 1,
    complete: complete !== false
  });
}

function pairsN(n) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push(['вопрос ' + i, 'ответ ' + i]);
  return out;
}

describe('I5 Qwen: reconcile live/reload', () => {
  const pairs = pairsN(10);

  test('live (dom) и reload (net) одного состава → 10 ходов / 20 сообщений', function () {
    const live = threadOf(pairs, 'dom', true);
    const reload = threadOf(pairs, 'net', true);
    const a = reconcile({ thread: live, kind: 'dom' }, { thread: reload, kind: 'net' });
    const b = reconcile({ thread: reload, kind: 'net' }, { thread: live, kind: 'dom' });
    for (const r of [a, b]) {
      expect(r.thread.turns).toHaveLength(10);
      expect(r.thread.messages).toHaveLength(20);
      expect(r.diagnostics.some(function (d) { return d.type === 'turn-mismatch'; })).toBe(false);
      expect(r.thread.messages.map(function (m) { return m.role === 'user' ? 'u' : 'a'; }).join('')).toBe('ua'.repeat(10));
    }
  });

  test('текстовое расхождение не смешивается: выбранный вариант + text-divergence', function () {
    const live = threadOf(pairs, 'dom', true);
    const reload = threadOf(pairs, 'net', true, { 3: 'ответ 2 (reload)' });
    const r = reconcile({ thread: live, kind: 'dom' }, { thread: reload, kind: 'net' });
    // net приоритетнее dom при равной полноте — база reload
    expect(r.thread.messages[3].text).toBe('ответ 2 (reload)');
    expect(r.diagnostics.some(function (d) { return d.type === 'text-divergence' && d.field === 'assistant'; })).toBe(true);
    expect(r.thread.messages).toHaveLength(20);
  });

  test('база net с пустым user добирает его из live (filled)', function () {
    const reload = threadOf(pairs, 'net', true);
    // turn 3 (0-based): user потерян, но общая полнота ещё заявлена complete=true
    reload.turns[3].user = null;
    const live = threadOf(pairs, 'dom', true);
    const r = reconcile({ thread: reload, kind: 'net' }, { thread: live, kind: 'dom' });
    expect(r.thread.turns).toHaveLength(10);
    expect(r.thread.messages).toHaveLength(20);
    expect(r.thread.turns[3].user.text).toBe('вопрос 4');
    expect(r.diagnostics.some(function (d) { return d.type === 'filled'; })).toBe(true);
  });

  test('messageHash учитывает роль и текст (база для divergence)', function () {
    expect(messageHash('assistant', 'ответ 1')).toBe(messageHash('assistant', 'ответ 1'));
    expect(messageHash('assistant', 'ответ 1')).not.toBe(messageHash('user', 'ответ 1'));
  });
});
