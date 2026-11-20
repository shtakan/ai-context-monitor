'use strict';

/**
 * 2.2 dual-run messages на AI Studio: сравнение старого адаптерного массива
 * с каноном из CaptureBatch. Флаг и установщик проверяются на фейковом
 * адаптере, поэтому тест не зависит от живого DOM/страницы.
 */

const fs = require('fs');
const path = require('path');

const {
  compareAistudioMessages,
  aiCmV2AistudioDualRun,
  aiCmV2MessagesEnabled,
  installAistudioDualRun,
  resetAistudioDualRunForTests,
  roleSequenceHash,
  roleSequence
} = require('../core/aistudio-dualrun.ts');

const DIR = path.join(__dirname, 'fixtures', 'aistudio');

function docOf(file) {
  return JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
}

function batchOf(file) {
  const doc = docOf(file);
  return {
    v: 1,
    platform: 'aistudio',
    kind: doc.src === 'server' ? 'net' : 'dom',
    convId: null,
    routeKey: 'prompts/fixture',
    capturedAt: Date.parse(doc.exportedAt),
    complete: doc.partial !== true,
    messages: doc.messages.map(function (m, i) {
      return { role: m.role, text: m.text, ordinal: i, nodeType: 'message' };
    })
  };
}

/** Старый путь адаптера: подряд идущие assistant-сегменты склеены '\n\n'. */
function oldMergedOf(file) {
  const out = [];
  const doc = docOf(file);
  for (const m of doc.messages) {
    const prev = out.length ? out[out.length - 1] : null;
    if (prev && prev.role === 'assistant' && m.role === 'assistant') {
      prev.content = prev.content + '\n\n' + m.text;
    } else {
      out.push({ role: m.role, content: m.text });
    }
  }
  return out;
}

describe('dual-run messages: сравнение старого пути и канона', () => {
  test.each(['back.json', 'settled.json', 'fast.json', 'retest-merge.json', 'export-s3-new-thread.json', 'export-s1-cold-f5.json'])(
    '%s: старый merge и canonicalize дают один bodyHash (verdict=same)',
    function (file) {
      const result = compareAistudioMessages(oldMergedOf(file), batchOf(file));
      expect(result.verdict).toBe('same');
      expect(result.oldHash).toBe(result.newHash);
      expect(result.oldRoleHash).toBe(result.newRoleHash);
      expect(result.roleDiffs).toEqual([]);
      expect(result.oldRoles).toBe(result.newRoles);
      expect(result.oldRoles.length).toBe(result.oldUser + result.oldAssistant);
      expect(result.oldUser).toBe(result.newUser);
      expect(result.oldAssistant).toBe(result.newAssistant);
      expect(result.firstDiff).toBe(-1);
      expect(result.reasons).toEqual([]);
    }
  );

  test('roleHash ловит сдвиг ролей отдельно от текста (K2)', function () {
    const shifted = oldMergedOf('back.json').map(function (m, i) {
      if (i === 1) return { role: 'user', content: m.content };
      if (i === 2) return { role: 'assistant', content: m.content };
      return m;
    });
    const result = compareAistudioMessages(shifted, batchOf('back.json'));
    expect(result.verdict).toBe('diff');
    expect(result.oldRoleHash).not.toBe(result.newRoleHash);
    expect(result.reasons).toContain('role-sequence');
    expect(result.firstRoleDiff).toBe(1);
    expect(result.roleDiffs.length).toBeGreaterThan(0);
  });

  test('roleSequenceHash зависит только от порядка ролей, не от текста', function () {
    const a = roleSequenceHash([{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }]);
    const b = roleSequenceHash([{ role: 'user', text: 'совсем другой' }, { role: 'assistant', text: 'текст' }]);
    const c = roleSequenceHash([{ role: 'assistant', text: 'a' }, { role: 'user', text: 'b' }]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test('сырой вход (без старого merge): retest-merge даёт diff 9A → 7A', function () {
    const doc = docOf('retest-merge.json');
    const raw = doc.messages.map(function (m) { return { role: m.role, content: m.text }; });
    const result = compareAistudioMessages(raw, batchOf('retest-merge.json'));

    expect(result.verdict).toBe('diff');
    expect(result.oldAssistant).toBe(9);
    expect(result.newAssistant).toBe(7);
    expect(result.reasons).toContain('count');
    expect(result.reasons).toContain('assistant-count');
    expect(result.reasons).toContain('first-diff');
    expect(result.firstDiff).toBe(11);
  });

  test('другая генерация (fast vs back) — diff, ошибка не глотается', function () {
    const result = compareAistudioMessages(oldMergedOf('fast.json'), batchOf('back.json'));
    expect(result.verdict).toBe('diff');
    expect(result.oldHash).not.toBe(result.newHash);
    expect(result.reasons).toContain('body-hash');
    expect(result.reasons).toContain('first-diff');
    expect(result.firstDiff).toBeGreaterThanOrEqual(0);
  });

  test('пустой старый вход — diff, а не исключение', function () {
    const result = compareAistudioMessages(null, batchOf('back.json'));
    expect(result.verdict).toBe('diff');
    expect(result.oldUser).toBe(0);
    expect(result.reasons).toContain('count');
  });

  test('ответ без user: канон понижает полноту и сообщает причину', function () {
    const batch = batchOf('back.json');
    batch.messages = [{ role: 'assistant', text: 'сирота', ordinal: 0, nodeType: 'message' }];
    const result = compareAistudioMessages([], batch);
    expect(result.newUser).toBe(0);
    expect(result.newAssistant).toBe(1);
    expect(result.newComplete).toBe(false);
    expect(result.newReasons).toContain('missing-user-text');
    expect(result.reasons).toContain('missing-user-turns');
  });

  test('флаг: без sessionStorage capture не вызывается, с флагом — вызывается', function () {
    resetAistudioDualRunForTests();
    sessionStorage.removeItem('aiCmV2Messages');

    let captureCalls = 0;
    function FakeAdapter() {
      this.siteName = 'aistudio';
    }
    FakeAdapter.prototype.extractMessages = function () {
      return [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }];
    };
    FakeAdapter.prototype.capture = function () {
      captureCalls++;
      return {
        v: 1,
        platform: 'aistudio',
        kind: 'dom',
        convId: 'c1',
        routeKey: 'prompts/c1',
        capturedAt: 1,
        complete: true,
        messages: [
          { role: 'user', text: 'q', ordinal: 0, nodeType: 'message' },
          { role: 'assistant', text: 'a', ordinal: 1, nodeType: 'message' }
        ]
      };
    };

    expect(installAistudioDualRun(FakeAdapter)).toBe(true);
    expect(installAistudioDualRun(FakeAdapter)).toBe(false);

    const adapter = new FakeAdapter();
    const before = adapter.extractMessages();
    expect(before).toHaveLength(2);
    expect(captureCalls).toBe(0);
    expect(aiCmV2MessagesEnabled()).toBe(false);

    sessionStorage.setItem('aiCmV2Messages', '1');
    const after = adapter.extractMessages();
    expect(after).toEqual(before);
    expect(captureCalls).toBe(1);
    expect(aiCmV2MessagesEnabled()).toBe(true);

    const direct = aiCmV2AistudioDualRun(adapter, before);
    expect(direct.verdict).toBe('same');

    sessionStorage.removeItem('aiCmV2Messages');
    resetAistudioDualRunForTests();
  });
});
