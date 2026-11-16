/**
 * BUG-L: probe даёт historyComplete=1 раньше, чем content-script назначил адаптер.
 *
 * ЖИВЫЕ ФАКТЫ (21:14): probe `historyComplete=1` → content `baseComplete=true` → поздний
 * open того же треда с `complete=0` → baseComplete снова false, латч O-43 не взведён
 * (`currentAdapter.siteName` пуст в момент complete=1), файл уходит partial.
 *
 * ФИКС (три независимых слоя, каждый пиннится здесь):
 *   1) core/export-manager.ts:aiCmGsaNetworkCompleteSet(threadId, siteOverride)
 *      — сайт с моста, а не только currentAdapter;
 *   2) core/content.ts: обработчик ai-cm-full-history передаёт emitSite явно
 *      (currentAdapter || google-хост), прочие сайты остаются no-op;
 *   3) core/google-search-intercept.js:buildDetail — монотонный вердикт по треду
 *      (completedTids): поздний open с historyComplete=0 не откатывает доказанную полноту.
 *
 * НЕ ТРОГАЕТСЯ: aiCmGsaNetworkCompleteIs, probe watchdog/TTL/foreign, orderTurnsByDom,
 * fillMissingUserText, пороги/латчи fired, dist/, версия.
 */

const fs = require('fs');
const path = require('path');

const HELPER = require('./helpers/content-source.js');
const ROOT = HELPER.ROOT;
const CONTENT = HELPER.contentSource;
const MGR_SRC = HELPER.readSource('core/export-manager.ts');
const INTERCEPT_SRC = fs.readFileSync(path.join(ROOT, 'core', 'google-search-intercept.js'), 'utf8');

// Рез по балансу фигурных скобок (как в tests/o43-gsa-autoexport-race.test.js).
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

const GSA = 'google_search';
const TID = 'BUG-L-THREAD-A';
const TID2 = 'BUG-L-THREAD-B';

// =====================================================================================
// Слой 3: монотонный вердикт MAIN-перехватчика
// =====================================================================================
describe('BUG-L: buildDetail — вердикт полноты монотонен по threadId', () => {
  function makeBuildDetail() {
    const ctx = {
      completedTids: Object.create(null),
      detectedModelSlug: 'Gemini (Search AI)',
      messagesFromTurns: function (turns) {
        const out = [];
        (turns || []).forEach(function (t) {
          if (t.userText) out.push({ role: 'user', text: t.userText });
          if (t.assistantText) out.push({ role: 'assistant', text: t.assistantText });
        });
        return out;
      }
    };
    const build = new Function('ctx',
      'with (ctx) { ' + fnDecl(INTERCEPT_SRC, 'buildDetail') + '\n return buildDetail; }')(ctx);
    return { build, ctx };
  }
  const turns = [{ id: 't1', userText: 'вопрос', assistantText: 'ответ' }];

  test('true → false того же треда: вердикт остаётся true (поздний open не откатывает)', function () {
    const h = makeBuildDetail();
    expect(h.build(turns, null, TID, true).historyComplete).toBe(true);
    expect(h.build(turns, null, TID, false).historyComplete).toBe(true);
    expect(h.build(turns, null, TID, undefined).historyComplete).toBe(true);
  });

  test('другой тред не наследует доказанную полноту', function () {
    const h = makeBuildDetail();
    h.build(turns, null, TID, true);
    expect(h.build(turns, null, TID2, false).historyComplete).toBe(false);
    // пустой threadId без явного вердикта — по-прежнему false (дефолта полноты нет)
    expect(h.build(turns, null, '', false).historyComplete).toBe(false);
    // явный вердикт без threadId сохраняется (O-32: доказанная полнота)
    expect(h.build(turns, null, '', true).historyComplete).toBe(true);
  });

  test('повторный true идемпотентен', function () {
    const h = makeBuildDetail();
    expect(h.build(turns, null, TID, true).historyComplete).toBe(true);
    expect(h.build(turns, null, TID, true).historyComplete).toBe(true);
    expect(Object.keys(h.ctx.completedTids)).toEqual([TID]);
  });

  test('размер реестра ограничен 50 тредами, самый старый вытесняется', function () {
    const h = makeBuildDetail();
    for (let i = 0; i < 60; i++) h.build(turns, null, 'TID-' + i, true);
    const keys = Object.keys(h.ctx.completedTids);
    expect(keys.length).toBeLessThanOrEqual(50);
    expect(keys).not.toContain('TID-0');       // самый старый вытеснен
    expect(keys).toContain('TID-59');          // последний на месте
  });
});

// =====================================================================================
// Слой 1: site override на взводе латча (адаптер ещё не назначен)
// =====================================================================================
describe('BUG-L: aiCmGsaNetworkCompleteSet(tid, siteOverride) взводит латч без адаптера', () => {
  function makeLatchApi(over) {
    const ctx = Object.assign({
      aiCmGsaNetworkCompleteLatch: Object.create(null),
      aiCmGsaNetworkCompleteThreadId: null,
      currentAdapter: null,
      getCurrentConvId: function () { return ''; },
      lastThreadId: TID,
      aiCmDiagLine: function () { }
    }, over || {});
    const api = new Function('ctx', 'with (ctx) { ' +
      fnDecl(MGR_SRC, 'aiCmAutoExportConvId') + '\n' +
      fnDecl(MGR_SRC, 'aiCmGsaNetworkCompleteSet') + '\n' +
      fnDecl(MGR_SRC, 'aiCmGsaNetworkCompleteIs') + '\n' +
      ' return { set: aiCmGsaNetworkCompleteSet, is: aiCmGsaNetworkCompleteIs }; }')(ctx);
    return { api, ctx };
  }

  test('currentAdapter=null + siteOverride=google_search → ключ взведён, Is даёт true', function () {
    const h = makeLatchApi();
    expect(h.api.set(TID, GSA)).toBe(true);
    expect(h.ctx.aiCmGsaNetworkCompleteLatch[GSA + '|' + TID]).toBe(1);
    expect(h.api.is(GSA, TID)).toBe(true);
    // чужой тред не задет
    expect(h.api.is(GSA, TID2)).toBe(false);
  });

  test('пустой site + не-google хост → no-op (прочие сайты не тронуты)', function () {
    const h = makeLatchApi();
    const fakeLocation = { hostname: 'example.com' };
    const emitSite = (fakeLocation.hostname === 'www.google.com') ? GSA : '';
    expect(h.api.set(TID, emitSite)).toBe(false);
    expect(Object.keys(h.ctx.aiCmGsaNetworkCompleteLatch)).toEqual([]);
  });

  test('явный не-google сайт — no-op; google-хост даёт google_search', function () {
    const h = makeLatchApi();
    expect(h.api.set(TID, 'gemini')).toBe(false);
    const fakeLocation = { hostname: 'www.google.com' };
    const emitSite = (fakeLocation.hostname === 'www.google.com') ? GSA : '';
    expect(h.api.set(TID, emitSite)).toBe(true);
    expect(h.api.is(GSA, TID)).toBe(true);
  });

  test('адаптер назначен — прежний путь без override работает байтово', function () {
    const h = makeLatchApi({ currentAdapter: { siteName: GSA } });
    expect(h.api.set(TID)).toBe(true);
    expect(h.api.is(GSA, TID)).toBe(true);
  });
});

// =====================================================================================
// Слой 2: content.ts явно передаёт сайт на мосту
// =====================================================================================
describe('BUG-L: content.ts — emitSite вторым аргументом взвода', () => {
  test('сайт вычисляется до вызова и передаётся в aiCmGsaNetworkCompleteSet', function () {
    const iSite = CONTENT.indexOf("var emitSite = (currentAdapter && currentAdapter.siteName) || ((location.hostname === 'www.google.com') ? 'google_search' : '');");
    const iSet = CONTENT.indexOf("aiCmGsaNetworkCompleteSet(detail.threadId || '', emitSite)");
    expect(iSite).toBeGreaterThan(-1);
    expect(iSet).toBeGreaterThan(iSite);
  });

  test('вызов тот же единственный и только под newBaseComplete', function () {
    const iComplete = CONTENT.indexOf('const newBaseComplete = !!detail.historyComplete;');
    const iSet = CONTENT.indexOf('aiCmGsaNetworkCompleteSet(detail.threadId');
    expect(iComplete).toBeGreaterThan(-1);
    expect(iSet).toBeGreaterThan(iComplete);
    expect(CONTENT.slice(iComplete, iSet)).toContain('if (newBaseComplete');
    expect((CONTENT.match(/aiCmGsaNetworkCompleteSet\(/g) || []).length).toBe(2);
  });
});
