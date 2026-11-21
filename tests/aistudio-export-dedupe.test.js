'use strict';

/**
 * BUG-13: след dedupe в JSON-снимке (input/output/removedUsers/foldedAssistants).
 * Чистый helper + общий сборщик; файлы без dedupe остаются байтово прежними.
 */

const { exportDedupeInfo } = require('../core/aistudio-dualrun.ts');
const loadEsm = require('./helpers/load-esm.js');

const Builders = loadEsm.loadEsmGlobal('utils/export-text-builders.ts', 'AiCmExportBuilders');
const P = loadEsm.loadEsmModule('utils/export-emit-pipeline.ts');

function roles(user, assistant) {
  const out = [];
  for (let i = 0; i < user; i++) out.push({ role: 'user' });
  for (let i = 0; i < assistant; i++) out.push({ role: 'assistant' });
  return out;
}

describe('BUG-13: dedupe-маркер снимка', () => {
  test('33 (17u/16a) → 31 (15u/16a): removedUsers=2, foldedAssistants=0', function () {
    const info = exportDedupeInfo(roles(17, 16), roles(15, 16));
    expect(info).toEqual({ input: 33, output: 31, removedUsers: 2, foldedAssistants: 0 });
  });

  test('старый 29 (15u/14a): removedUsers=2 + foldedAssistants=2', function () {
    const info = exportDedupeInfo(roles(17, 16), roles(15, 14));
    expect(info).toEqual({ input: 33, output: 29, removedUsers: 2, foldedAssistants: 2 });
  });

  test('без изменения счёта — undefined (ключ в JSON не появляется)', function () {
    expect(exportDedupeInfo(roles(2, 2), roles(2, 2))).toBeUndefined();
  });

  test('buildJsonFromHistory печатает dedupe только когда он есть', function () {
    const withInfo = JSON.parse(Builders.buildJsonFromHistory({
      messages: [{ role: 'user', text: 'q' }],
      dedupe: { input: 3, output: 1, removedUsers: 2, foldedAssistants: 0 }
    }, 'aistudio'));
    expect(withInfo.dedupe).toEqual({ input: 3, output: 1, removedUsers: 2, foldedAssistants: 0 });

    const without = JSON.parse(Builders.buildJsonFromHistory({
      messages: [{ role: 'user', text: 'q' }]
    }, 'aistudio'));
    expect('dedupe' in without).toBe(false);
  });
});

describe('BUG-13 остаток: файловый user-дубль (#19/#20)', () => {
  const PROMPT = 'Завтра займусь починкой и диагностикой бага. Сейчас иногда полная история, а иногда нет.';
  const RICH = PROMPT + '\n\n[FILE: export.md]\n# AI Context Monitor — экспорт истории\nтело файла';
  function triple(short) {
    return [
      { role: 'user', text: RICH },
      { role: 'user', text: short === undefined ? PROMPT : short },
      { role: 'assistant', text: 'Ответ.' }
    ];
  }

  test('option=true: текст + [FILE:] и следующий тот же текст без файла → один ход', function () {
    const res = P.prepareExportMessages(triple(), null, { collapseFileUserDuplicates: true });
    expect(res.messages).toHaveLength(2);
    expect(res.messages[0].text).toBe(RICH);
    expect(res.messages[1]).toEqual({ role: 'assistant', text: 'Ответ.' });
    expect(res.removed).toBe(1);
  });

  test('option=false (прочие сайты): пара не трогается', function () {
    const res = P.prepareExportMessages(triple(), null);
    expect(res.messages).toHaveLength(3);
    expect(res.messages[1].text).toBe(PROMPT);
    expect(res.removed).toBe(0);
  });

  test('короткий текст не совпал с префиксом — пара остаётся', function () {
    const res = P.prepareExportMessages(triple('Другой вопрос'), null, { collapseFileUserDuplicates: true });
    expect(res.messages).toHaveLength(3);
  });

  test('у короткого хода есть artifacts — не копия, остаётся', function () {
    const withArtifact = triple();
    withArtifact[1].artifacts = [{ name: 'x.md', content: 'x' }];
    const res = P.prepareExportMessages(withArtifact, null, { collapseFileUserDuplicates: true });
    expect(res.messages).toHaveLength(3);
    expect(res.messages[1].artifacts).toEqual([{ name: 'x.md', content: 'x' }]);
  });

  test('aiCmDedupeExportSource: правило включено только для aistudio', function () {
    const { moduleSource } = require('./helpers/content-source.js');
    const BASE = moduleSource('base-handler.ts');
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
    function run(site) {
      const dedupe = new Function('ctx',
        'with (ctx) { ' + fnDecl(BASE, 'aiCmDedupeExportSource') + '\n return aiCmDedupeExportSource; }')({
        currentAdapter: { siteName: site },
        AiCmExportEmitPipeline: P,
        aiCmMergeAssistantRuns: function (m) { return m; },
        aiCmLogIntraDedupe: function () { },
        debugLog: function () { },
        swallow: function () { }
      });
      return dedupe(triple());
    }
    expect(run('aistudio').messages).toHaveLength(2);
    expect(run('aistudio').removed).toBe(1);
    expect(run('gemini').messages).toHaveLength(3);
  });
});

describe('BUG-13 parity: dedupe-маркер авто-экспорта', () => {
  const { moduleSource, contentSource } = require('./helpers/content-source.js');

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

  const makeAutoInfo = new Function('ctx',
    'with (ctx) { ' + fnDecl(contentSource, 'aiCmExportDedupeInfoAuto') + '\n return aiCmExportDedupeInfoAuto; }');

  test('обёртка возвращает тот же dedupe-info, что ручной снимок', function () {
    const autoInfo = makeAutoInfo({ exportDedupeInfo: exportDedupeInfo, currentAdapter: { siteName: 'aistudio' } });
    expect(autoInfo(roles(17, 16), roles(15, 16)))
      .toEqual({ input: 33, output: 31, removedUsers: 2, foldedAssistants: 0 });
    expect(autoInfo(roles(2, 2), roles(2, 2))).toBeUndefined();
  });

  test('обёртка не ставит маркер прочим сайтам (гейт в content, не в export-manager)', function () {
    const other = makeAutoInfo({ exportDedupeInfo: exportDedupeInfo, currentAdapter: { siteName: 'gemini' } });
    expect(other(roles(17, 16), roles(15, 16))).toBeUndefined();
  });

  test('source: авто-файл читает маркер из lastDetailMessages, платформа не проникает в export-manager', function () {
    const mgr = moduleSource('export-manager.ts');
    const writer = fnDecl(mgr, 'aiCmWriteAutoExportFile');
    expect(writer).toContain('aiCmExportDedupeInfoAuto(lastDetailMessages, msgs)');
    expect(mgr).not.toContain('aistudio');
  });
});
