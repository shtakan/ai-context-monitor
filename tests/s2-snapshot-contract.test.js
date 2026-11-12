/**
 * S2.1 (ADR-001): контракт снимка контекста — чистые хелперы core/state.ts.
 *
 * ИНВАРИАНТ «один снимок — один читатель»: запись — только content.ts:processAndSend
 * через aiCmCommitContextSnapshot, чтение — только через aiCmReadContextSnapshot.
 * Этот тест держит три свойства контракта, которые нельзя проверить поведением
 * потребителей (бейдж/панель/история/экспорт в S2.1 не меняются):
 *
 *  1) reader: нет снимка → null; чужой непустой convId → null; пустой/совпадающий →
 *     КОПИЯ (мутация копии не портит источник), ageMs выводится из capturedAt;
 *  2) commit: та же сигнатура → ТОТ ЖЕ объект (и тот же capturedAt), иначе — новый;
 *     сигнатура шире лог-сигнатуры: site/model/baseComplete входят в неё (иначе имя
 *     модели замирало бы при том же лимите — класс BUG-02, а baseComplete — у Qwen);
 *  3) consent: aiCmSnapshotPartial — ЧИСТЫЙ предикат полноты базы; на готовых
 *     состояниях он согласован с shouldSkipAutoExport(...).skip (порог/fired/enabled
 *     кодирует гейт, а не предикат).
 *
 * core/state.ts читается ТОЛЬКО через readExecutable: readCore отдаёт .ts как есть,
 * и `new Function` упал бы на TS-аннотациях. readExecutable снимает типы и интерфейсы,
 * поэтому песочница исполняет ровно те три функции, что и браузер.
 */
const { readExecutable } = require('./helpers/content-source.js');
const P = require('./helpers/load-esm.js').loadEsmModule('utils/export-emit-pipeline.ts');

const STATE = readExecutable('core/state.ts');

// Рез по балансу фигурных скобок (тот же приём, что в tests/perplexity-o9-signature.test.js).
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

// Песочница: let lastTokensSnapshot — та же переменная, что в core/state.ts (classic-script scope).
const SCOPE = 'let lastTokensSnapshot = null;\n' +
  fnDecl(STATE, 'aiCmSnapshotPartial') + '\n' +
  fnDecl(STATE, 'aiCmCommitContextSnapshot') + '\n' +
  fnDecl(STATE, 'aiCmReadContextSnapshot') + '\n' +
  'return { partial: aiCmSnapshotPartial, commit: aiCmCommitContextSnapshot, read: aiCmReadContextSnapshot,' +
  ' set: function (v) { lastTokensSnapshot = v; }, get: function () { return lastTokensSnapshot; } };';
const api = new Function(SCOPE)();

function snapshot(over) {
  return Object.assign({
    convId: 'conv-a',
    capturedAt: 1700000000000,
    site: 'qwen',
    model: 'qwen3-max',
    modelName: 'Qwen3 Max',
    src: 'dom',
    tokens: 1000,
    percent: 10,
    limit: 10000,
    effectiveLimit: 10000,
    contextLimit: 10000,
    attachBreak: null,
    chars: 4000,
    msgs: 12,
    bodyHash: 'hash-1',
    baseComplete: true,
    partial: false
  }, over || {});
}

test('reader: без снимка → null (и по любому convId)', () => {
  api.set(null);
  expect(api.read()).toBeNull();
  expect(api.read('conv-a')).toBeNull();
});

test('reader: чужой непустой convId → null; пустой/совпадающий → копия снимка', () => {
  const snap = snapshot();
  api.set(snap);
  expect(api.read('conv-b')).toBeNull();
  expect(api.read('')).not.toBeNull();
  expect(api.read('conv-a')).not.toBeNull();
  const copy = api.read('conv-a');
  expect(copy).not.toBe(snap);
  expect(copy.convId).toBe('conv-a');
  expect(copy.tokens).toBe(1000);
  expect(copy.percent).toBe(10);
  expect(api.get()).toBe(snap);
});

test('reader: копия не мутирует источник; ageMs≥0, capturedAt<=0 → 0', () => {
  api.set(snapshot({ capturedAt: Date.now() - 50 }));
  const copy = api.read('conv-a');
  copy.tokens = 999999;
  copy.convId = 'hacked';
  expect(api.get().tokens).toBe(1000);
  expect(api.get().convId).toBe('conv-a');
  expect(api.read('conv-a').tokens).toBe(1000);
  expect(copy.ageMs).toBeGreaterThanOrEqual(0);

  api.set(snapshot({ capturedAt: 0 }));
  expect(api.read('conv-a').ageMs).toBe(0);
  api.set(snapshot({ capturedAt: -5 }));
  expect(api.read('conv-a').ageMs).toBe(0);
});

test('commit: та же сигнатура → тот же объект и тот же capturedAt', () => {
  const prev = snapshot();
  const next = Object.assign({}, prev, { capturedAt: prev.capturedAt + 5000 });
  expect(api.commit(prev, next)).toBe(prev);
  expect(api.commit(prev, next).capturedAt).toBe(prev.capturedAt);
  expect(api.commit(null, next)).toBe(next);
});

test('commit: смена любого поля сигнатуры → новый объект', () => {
  const prev = snapshot();
  const changes = [
    { convId: 'conv-b' },
    { src: 'net' },
    { tokens: 1001 },
    { percent: 10.1 },
    { limit: 10001 },
    { partial: true },
    { bodyHash: 'hash-2' },
    { site: 'aistudio' },
    { model: 'qwen3-coder' },
    { baseComplete: false }
  ];
  changes.forEach((change) => {
    const next = Object.assign({}, prev, change);
    expect(api.commit(prev, next)).toBe(next);
  });
});

test('consent: aiCmSnapshotPartial согласован с shouldSkipAutoExport на готовых состояниях', () => {
  // Колонки: baseComplete / baseSeen / domBaseTrusted / gsaNetworkCompleteLatch.
  const rows = [
    { baseComplete: false, baseSeen: false, domBaseTrusted: false, gsa: false, partial: 1, skip: true },
    { baseComplete: false, baseSeen: true, domBaseTrusted: false, gsa: false, partial: 1, skip: true },
    { baseComplete: true, baseSeen: true, domBaseTrusted: false, gsa: false, partial: 0, skip: false },
    { baseComplete: false, baseSeen: true, domBaseTrusted: true, gsa: false, partial: 0, skip: false },
    { baseComplete: false, baseSeen: false, domBaseTrusted: false, gsa: true, partial: 0, skip: false }
  ];
  rows.forEach((row) => {
    const partial = api.partial(row.baseComplete, row.domBaseTrusted || row.gsa);
    expect(partial ? 1 : 0).toBe(row.partial);
    const verdict = P.shouldSkipAutoExport({
      enabled: true,
      percentage: 95,
      threshold: 90,
      isGemini: false,
      fired: false,
      loaderRunning: false,
      historyIncomplete: false,
      baseComplete: row.baseComplete,
      baseSeen: row.baseSeen,
      domBaseTrusted: row.domBaseTrusted,
      gsaNetworkCompleteLatch: row.gsa
    });
    expect(verdict.skip).toBe(row.skip);
  });
});
