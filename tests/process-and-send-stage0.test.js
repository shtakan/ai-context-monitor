'use strict';
/**
 * Stage 0 (2.4): характеризационный контракт `processAndSend`.
 *
 * Это НЕ рефакторинг и не новая логика: тест запускает реальную `processAndSend`
 * из contentSource в песочнице `tests/helpers/process-and-send-probe.js` и
 * фиксирует текущие решения/вызовы. Любое изменение поведения при Stage 1+
 * обязано сначала обновить эту таблицу осознанно.
 *
 * Сценарии: обычный чат, F5/restore (adapter → сеть), context-saturated,
 * Stop, пустая база, AI Studio native tokens.
 */
const { makeProbe } = require('./helpers/process-and-send-probe.js');

function expectNoSwallowed(r) {
  expect(r.logs.filter(function (x) { return x.indexOf('swallowSoft') === 0 || x.indexOf('swallow ') === 0; })).toEqual([]);
}

describe('Stage 0: processAndSend — характеризационный контракт', function () {
  test('обычный чат: снимок net, бейдж/threshold = tokens/limit, история и CONTEXT_UPDATE', function () {
    const p = makeProbe();
    const r = p.run();
    expectNoSwallowed(r);

    expect(r.updateWidget).toEqual([7.8, 10000, 128000, 128000, 128000, 'Test Model', null]);
    expect(r.thresholds).toEqual([7.8]);
    expect(r.autoExport).toEqual([]);                    // сетевой путь не планирует автоэкспорт здесь
    expect(r.commit).toMatchObject({
      tokens: 10000, percent: 7.8, src: 'net', partial: false,
      chars: 9, msgs: 2, bodyHash: 'probe-hash', baseComplete: true
    });
    expect(r.historyWrites).toHaveLength(1);
    expect(r.historyWrites[0].aiCmHistory).toMatchObject({
      site: 'chatgpt', tokens: 10000, percent: 7.8, limit: 128000
    });
    expect(r.stateWrites).toHaveLength(1);
    expect(r.runtimeMessages.map(function (m) { return m.type; })).toEqual(['CONTEXT_UPDATE']);
    expect(r.runtimeMessages[0].data).toMatchObject({ percentage: 7.8, tokenCount: 10000, messageCount: 10 });
  });

  test('F5/restore: adapter-база → бейдж, adapter-history, автоэкспорт; затем полная сеть', function () {
    const p = makeProbe({
      state: {
        site: 'qwen', convId: 'qwen-1',
        baseSeen: false, baseComplete: false, baseCount: 0, baseText: '', lastBaseTexts: [],
        adapterMessages: [{ role: 'user', text: 'Q1' }, { role: 'assistant', text: 'A1' }],
        adapterBaseSeen: true, fullText: 'Q1\nA1', countForTokens: 2,
        tokens: 500, windowLimit: 1000000, displayLimit: 1000000,
        modelId: 'qwen3.7-plus', modelName: 'Qwen3.7-Plus',
        sourceKind: 'dom', baseSource: 'dom'
      }
    });

    const first = p.run();
    expectNoSwallowed(first);
    expect(first.updateWidget).toEqual([0.1, 500, 1000000, 1000000, 1000000, 'Qwen3.7-Plus', null]);
    expect(first.commit).toMatchObject({ tokens: 500, percent: 0.1, src: 'dom', partial: false });
    expect(first.autoExport).toEqual([0.1]);             // adapter-запись базы планирует порог
    expect(first.historyWrites).toHaveLength(1);
    expect(first.historyWrites[0].aiCmHistory).toMatchObject({ site: 'qwen', convId: 'qwen-1', tokens: 500 });

    const second = p.run({
      baseSeen: true, baseComplete: true, baseCount: 268,
      lastBaseTexts: new Array(268).fill('x'), fullText: 'x'.repeat(1000),
      countForTokens: 268, tokens: 1186363, sourceKind: 'net', baseSource: 'net',
      adapterBaseSeen: true
    });
    expectNoSwallowed(second);
    expect(second.updateWidget).toEqual([118.6, 1186363, 1000000, 1000000, 1000000, 'Qwen3.7-Plus', null]);
    expect(second.commit).toMatchObject({ tokens: 1186363, percent: 118.6, src: 'net' });
    expect(second.thresholds).toEqual([0.1, 118.6]);
    expect(second.historyWrites).toHaveLength(2);
    expect(second.historyWrites[1].aiCmHistory).toMatchObject({ site: 'qwen', convId: 'qwen-1', tokens: 1186363, percent: 118.6 });
  });

  test('context-saturated: платформенный 100 % и saturated=1, токены остаются измеренными', function () {
    const p = makeProbe({
      state: {
        tokens: 2686, saturated: true, fullText: 'x'.repeat(1000), countForTokens: 28,
        modelId: 'gpt-6', modelName: 'GPT-6', windowLimit: 1050000, displayLimit: 128000
      }
    });
    const r = p.run();
    expectNoSwallowed(r);
    expect(r.updateWidget).toEqual([100, 2686, 128000, 1050000, 128000, 'GPT-6', null]);
    expect(r.commit).toMatchObject({ tokens: 2686, percent: 100, src: 'net', saturated: true });
    expect(r.thresholds).toEqual([100]);
    expect(r.logs.join('\n')).toContain('платформа: контекст заполнен');
  });

  test('Stop: partial=true/reason=stop, история отложена, бейдж по серверным токенам', function () {
    const p = makeProbe({
      state: {
        site: 'deepseek', convId: 'ds-1',
        baseSeen: true, baseComplete: false, baseCount: 97, baseText: 'x'.repeat(1000),
        lastBaseTexts: new Array(97).fill('x'), fullText: 'x'.repeat(1000),
        countForTokens: 97, tokens: 894892, windowLimit: 1000000, displayLimit: 1000000,
        stopActive: true, partial: true, partialReason: 'stop',
        serverTokens: 894892, sourceKind: 'server', baseSource: 'net'
      }
    });
    const r = p.run();
    expectNoSwallowed(r);
    expect(r.updateWidget).toEqual([89.5, 894892, 1000000, 1000000, 1000000, 'Test Model', null]);
    expect(r.commit).toMatchObject({ tokens: 894892, percent: 89.5, src: 'server', partial: true, partialReason: 'stop' });
    expect(r.thresholds).toEqual([89.5]);
    expect(r.deferred).toEqual(['ds-1']);                // история не пишется до полной базы
    expect(r.historyWrites).toHaveLength(0);
    expect(r.runtimeMessages.map(function (m) { return m.type; })).toEqual(['CONTEXT_UPDATE']);
  });

  test('пустая база: нет снимка/бейджа, aiCmState удаляется, threshold 0 и CONTEXT_UPDATE 0', function () {
    const p = makeProbe({
      state: {
        baseSeen: false, baseComplete: false, baseCount: 0, baseText: '', lastBaseTexts: [],
        adapterMessages: [], adapterBaseSeen: false, fullText: '', countForTokens: 0,
        tokens: 0, historyMessages: []
      }
    });
    const r = p.run();
    expectNoSwallowed(r);
    expect(r.updateWidget).toBeNull();
    expect(r.commit).toBeNull();
    expect(r.thresholds).toEqual([0]);
    expect(r.historyWrites).toHaveLength(0);
    expect(r.stateWrites).toHaveLength(0);
    expect(r.stateRemove).toEqual([['aiCmState', 'aiCmState:example.test']]);
    expect(r.runtimeMessages.map(function (m) { return m.type; })).toEqual(['CONTEXT_UPDATE']);
    expect(r.runtimeMessages[0].data.percentage).toBe(0);
  });

  test('AI Studio native tokens: src=server, окно модели отдельно от display-limit', function () {
    const p = makeProbe({
      state: {
        site: 'aistudio', convId: 'ai-1',
        baseSeen: true, baseComplete: true, baseCount: 35, baseText: 'x'.repeat(1000),
        lastBaseTexts: new Array(35).fill('x'), fullText: 'x'.repeat(1000),
        countForTokens: 35, tokens: 47412, serverTokens: 47412,
        windowLimit: 1048576, displayLimit: 128000,
        modelId: 'gemini-3.8-flash', modelName: 'Gemini 3.8 Flash',
        sourceKind: 'server', baseSource: 'server'
      }
    });
    const r = p.run();
    expectNoSwallowed(r);
    expect(r.updateWidget).toEqual([37, 47412, 128000, 1048576, 128000, 'Gemini 3.8 Flash', null]);
    expect(r.commit).toMatchObject({
      tokens: 47412, percent: 37, src: 'server',
      limit: 128000, effectiveLimit: 128000, contextLimit: 1048576, windowLimit: 1048576
    });
    expect(r.thresholds).toEqual([37]);
    expect(r.runtimeMessages[0].data).toMatchObject({ percentage: 37, contextLimit: 128000 });
  });
});
