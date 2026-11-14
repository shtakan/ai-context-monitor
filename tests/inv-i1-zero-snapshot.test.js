/**
 * INV-I1 (ADR-001 / S2.2, empty-chat): пустой чат НЕ публикует «нулевой снимок».
 *
 * Инвариант: чат без payload (нет текста, вложений и сообщений) не оставляет
 * lastTokensSnapshot вовсе — иначе потребитель (бейдж, панель GET_STATS, попап,
 * шапка файла экспорта) печатает 0 / «0.0 %» для чата, которого ещё нет.
 * Снимок ПРОШЛОГО разговора при этом обязан сниматься ДО чтения badgeSnap:
 * снимок принадлежит ровно одному чату (I6, core/state.ts:aiCmCanonicalConvId),
 * поэтому после навигации в новый пустой чат потребители не получили бы числа
 * покинутого чата: чтение идёт с каноническим convId, а не без аргумента.
 *
 * Гейт СТРУКТУРНЫЙ — «нечего мерить», а не «tokens === 0»: у крошечного чата
 * 0.0 % — легитимное измерение (кейс 3), и гейт не смотрит на body (кейс 4).
 *
 * Тест исполняет РЕАЛЬНЫЙ writer-блок core/content.ts (не копию): срез от
 * `var aiCmSnapPending83` до комментария следующего шага, в песочнице SCOPE с
 * настоящими aiCmCommitContextSnapshot / aiCmReadContextSnapshot из core/state.ts.
 * В ctx НЕТ lastTokensSnapshot — он обязан резолвиться в замыкание SCOPE, иначе
 * проверка «снимок снят» была бы фикцией.
 */
'use strict';

const H = require('./helpers/content-source.js');

const CONTENT = H.readSource('core/content.ts');
const STATE = H.readExecutable('core/state.ts');

const HOST = 'chatgpt.com';

// Рез по балансу фигурных скобок (тот же приём, что в tests/inv-i1-single-snapshot.test.js).
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

// {...} блока, начинающегося с marker (marker включает "{").
function blockAt(src, marker) {
  const start = src.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error('unbalanced block: ' + marker);
}

// Песочница ТОЛЬКО из чистых мапперов core/state.ts.
const MAPPERS = new Function(
  fnDecl(STATE, 'aiCmWidgetDataFromSnapshot') + '\n' +
  fnDecl(STATE, 'aiCmStatePatchFromSnapshot') + '\n' +
  'return { widget: aiCmWidgetDataFromSnapshot, patch: aiCmStatePatchFromSnapshot };'
)();

const SNAPSHOT_PARTIAL = new Function(
  fnDecl(STATE, 'aiCmSnapshotPartial') + '\nreturn aiCmSnapshotPartial;'
)();

// Реальный writer-блок: от объявления pending-гейта до следующего шага S2.2.
const START = CONTENT.indexOf('var aiCmSnapPending83');
expect(START).toBeGreaterThan(-1);
const END = CONTENT.indexOf('// S2.2 (ADR-001): данные бейджа', START);
expect(END).toBeGreaterThan(START);
const BLOCK = CONTENT.slice(START, END);

// lastTokensSnapshot живёт в замыкании SCOPE — ровно как в core/state.ts.
// Блок вставляется в ИСХОДНИК SCOPE, а не в new Function(ctx, ...) на лету:
// конструктор Function не видит лексический скоуп, и тогда ни `lastTokensSnapshot`,
// ни aiCmCommitContextSnapshot внутри блока не резолвились бы (проверка «снимок
// снят» стала бы фикцией). `with (ctx)` даёт свойства ctx, остальное — замыкание.
const SCOPE = [
  'let lastTokensSnapshot = null;',
  fnDecl(STATE, 'aiCmCommitContextSnapshot'),
  fnDecl(STATE, 'aiCmReadContextSnapshot'),
  'return {',
  '  run: function (ctx) {',
  '    with (ctx) {',
  BLOCK,
  '    }',
  '  },',
  '  read: aiCmReadContextSnapshot,',
  '  get: function () { return lastTokensSnapshot; },',
  '  set: function (v) { lastTokensSnapshot = v; }',
  '};'
].join('\n');
const api = new Function(SCOPE)();

// Фикстура «снимка покинутого чата»: намеренно ненулевая и «неестественная».
function oldSnapshot() {
  return {
    convId: 'conv-old',
    capturedAt: 1700000000000,
    site: 'chatgpt',
    model: 'gpt-5',
    modelName: 'GPT-5',
    src: 'dom',
    tokens: 1000,
    percent: 7.7,
    limit: 128000,
    effectiveLimit: 128000,
    contextLimit: 128000,
    attachBreak: null,
    chars: 4000,
    msgs: 2,
    bodyHash: 'hash-old',
    baseComplete: true,
    partial: false
  };
}

// ctx writer-блока: всё, что он читает, кроме lastTokensSnapshot (он — в SCOPE).
function makeCtx(over) {
  const ctx = {
    aiCmNetSnapshotPending: function () { return false; },
    fullText: '',
    effective: '',
    countForTokens: 0,
    netAttachTokens: 0,
    body: null,
    maxTokenCount: 0,
    percentage: 0,
    displayLimit: 128000,
    effectiveLimit: 128000,
    contextLimit: 128000,
    modelId: 'gpt-5',
    ModelConfig: { getModel: function () { return { name: 'GPT-5' }; } },
    currentAdapter: { siteName: 'chatgpt' },
    aiCmMetricValueSrc: 'dom',
    netAttachBreak: null,
    baseComplete: true,
    aiCmAutoExportConvId: function () { return 'conv-new'; },
    getCurrentConvId: function () { return 'conv-new'; },
    aiCmAutoExportTrustedBase: function () { return true; },
    aiCmGsaNetworkCompleteIs: function () { return false; },
    aiCmSnapshotPartial: SNAPSHOT_PARTIAL,
    lastCtxSnapSig: '',
    debugLog: function () { }
  };
  return Object.assign(ctx, over || {});
}

// Запись aiCmState в попап: реальный блок из core/content.ts (а не пересказ).
const STATE_WRITE_AT = CONTENT.indexOf('var stateNumbers = aiCmStatePatchFromSnapshot');
expect(STATE_WRITE_AT).toBeGreaterThan(-1);
const STATE_WRITE_START = CONTENT.lastIndexOf('if (isExtensionValid())', STATE_WRITE_AT);
expect(STATE_WRITE_START).toBeGreaterThan(-1);
const STATE_WRITE = 'if (isExtensionValid()) ' +
  blockAt(CONTENT.slice(STATE_WRITE_START), 'if (isExtensionValid())');

function runStateWrite(badgeSnap) {
  const set = jest.fn();
  const remove = jest.fn();
  const ctx = {
    badgeSnap: badgeSnap,
    isExtensionValid: function () { return true; },
    aiCmStatePatchFromSnapshot: MAPPERS.patch,
    window: { location: { hostname: HOST } },
    currentAdapter: { siteName: 'chatgpt' },
    stale: false,
    lastBaseTexts: [],
    aiCmSourceInfo: function () { return { kind: 'net', label: 'Net' }; },
    chrome: { storage: { local: { set: set, remove: remove } } },
    swallowSoft: function () { }
  };
  new Function('ctx', 'with (ctx) { ' + STATE_WRITE + ' }')(ctx);
  return { set: set, remove: remove };
}

describe('S2.2 empty-chat: пустой чат не публикует нулевой снимок', () => {
  test('кейс 1: пустой чат снимает снимок прошлого разговора и не коммитит', () => {
    api.set(oldSnapshot());
    api.run(makeCtx());
    expect(api.get()).toBeNull();
    expect(api.read('conv-new')).toBeNull();
    expect(api.read()).toBeNull(); // I6: без аргумента снимок не отдаётся никогда
    // Потребители: ни числа, ни нулей — пустой патч.
    expect(MAPPERS.patch(api.read())).toEqual({});
    expect(MAPPERS.widget(api.read())).toBeNull();
  });

  test('кейс 2: pending сети не спасает — clear стоит ДО pending-гейта', () => {
    api.set(oldSnapshot());
    api.run(makeCtx({ aiCmNetSnapshotPending: function () { return true; } }));
    expect(api.get()).toBeNull();
    expect(api.read('conv-new')).toBeNull();
    expect(api.read()).toBeNull();
  });

  test('кейс 3: крошечный чат — легитимные 0.0% (гейт не числовой)', () => {
    api.set(null);
    api.run(makeCtx({
      fullText: 'x',
      effective: 'x',
      countForTokens: 1,
      body: { text: 'x', chars: 1, msgs: 1, bodyHash: 'h' },
      maxTokenCount: 1,
      percentage: 0
    }));
    expect(api.read()).toBeNull();
    const snap = api.read('conv-new');
    expect(snap).not.toBeNull();
    expect(snap.tokens).toBe(1);
    expect(snap.percent).toBe(0);
  });

  test('кейс 4: гейт не по body — пустое тело, но текст есть', () => {
    api.set(null);
    api.run(makeCtx({
      fullText: 'abc',
      effective: 'abc',
      countForTokens: 0,
      body: null,
      maxTokenCount: 42,
      percentage: 0.1
    }));
    expect(api.read()).toBeNull();
    const snap = api.read('conv-new');
    expect(snap).not.toBeNull();
    expect(snap.tokens).toBe(42);
  });

  test('кейс 5: null-снимок → aiCmState удаляется, set не вызван', () => {
    const r = runStateWrite(null);
    expect(r.set).not.toHaveBeenCalled();
    expect(r.remove).toHaveBeenCalledWith(['aiCmState', 'aiCmState:' + HOST]);
  });
});
