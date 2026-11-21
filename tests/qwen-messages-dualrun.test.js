'use strict';

/**
 * 2.2/фаза 3: dual-run messages для Qwen.
 * Старый extractMessages не меняется; canonicalizeBatch(capture()) считается
 * рядом. Флаг — общий aiCmV2Messages.
 */

const {
  compareQwenMessages,
  aiCmV2QwenDualRun,
  installQwenDualRun,
  resetQwenDualRunForTests
} = require('../core/qwen-dualrun.ts');
const { resetAistudioDualRunForTests } = require('../core/aistudio-dualrun.ts');

function batchOf(messages) {
  return {
    v: 1,
    platform: 'qwen',
    kind: 'dom',
    convId: 'conv-q',
    routeKey: 'c/conv-q',
    capturedAt: 1,
    complete: true,
    messages: messages.map(function (m, i) {
      return { role: m.role, text: m.text, ordinal: i, nodeType: 'message' };
    })
  };
}

const OLD = [
  { role: 'user', content: 'привет' },
  { role: 'assistant', content: 'Привет! Чем помочь?' }
];

describe('Qwen dual-run: compare', () => {
  test('одинаковый состав → same, roleHash совпадает', function () {
    const r = compareQwenMessages(OLD, batchOf([
      { role: 'user', text: 'привет' },
      { role: 'assistant', text: 'Привет! Чем помочь?' }
    ]));
    expect(r.verdict).toBe('same');
    expect(r.reasons).toEqual([]);
    expect(r.oldRoleHash).toBe(r.newRoleHash);
    expect(r.firstDiff).toBe(-1);
  });

  test('сдвиг роли / потеря → diff с причиной', function () {
    const r = compareQwenMessages(OLD, batchOf([
      { role: 'assistant', text: 'привет' },
      { role: 'user', text: 'Привет! Чем помочь?' }
    ]));
    expect(r.verdict).toBe('diff');
    expect(r.reasons).toContain('role-sequence');
    expect(r.firstDiff).toBe(0);
  });
});

describe('Qwen dual-run: флаг и установщик', () => {
  test('без флага capture не вызывается, extractMessages прежний', function () {
    sessionStorage.removeItem('aiCmV2Messages');
    resetAistudioDualRunForTests();
    resetQwenDualRunForTests();

    let captures = 0;
    function Fake() { this.siteName = 'qwen'; }
    Fake.prototype.extractMessages = function () { return OLD.slice(); };
    Fake.prototype.capture = function () {
      captures++;
      return batchOf([{ role: 'user', text: 'привет' }, { role: 'assistant', text: 'Привет! Чем помочь?' }]);
    };
    expect(installQwenDualRun(Fake)).toBe(true);
    expect(installQwenDualRun(Fake)).toBe(false);
    const out = new Fake().extractMessages();
    expect(out).toEqual(OLD);
    expect(captures).toBe(0);
  });

  test('с флагом capture считается рядом, результат не меняется и нет рекурсии', function () {
    sessionStorage.setItem('aiCmV2Messages', '1');
    resetQwenDualRunForTests();
    let captures = 0;
    function Fake() { this.siteName = 'qwen'; }
    Fake.prototype.extractMessages = function () { return OLD.slice(); };
    Fake.prototype.capture = function () {
      captures++;
      return batchOf([{ role: 'user', text: 'привет' }, { role: 'assistant', text: 'Привет! Чем помочь?' }]);
    };
    installQwenDualRun(Fake);
    const adapter = new Fake();
    const out = adapter.extractMessages();
    expect(out).toEqual(OLD);
    expect(captures).toBe(1);
    expect(aiCmV2QwenDualRun(adapter, out).verdict).toBe('same');
    sessionStorage.removeItem('aiCmV2Messages');
    resetQwenDualRunForTests();
  });
});
