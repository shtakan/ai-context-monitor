'use strict';

/**
 * AI Studio: автоэкспорт по базе адаптера не блокируется причиной base-pending
 * (plan-aistudio-export-block.md, Вариант A; v2.0.34).
 *
 * ПРОБЛЕМА. У AI Studio нет события ai-cm-full-history, поэтому baseSeen/baseComplete у него
 * всегда false; gsa-латч сетевой полноты — только google_search; domBaseTrusted заполнялся
 * лишь для qwen. Итог: все четыре пути «база готова» закрыты, гейт возвращал base-pending на
 * каждом пороге, и автоэкспорт не срабатывал ни разу — при том что база честно приходила
 * адаптером (adapterBaseSeen) и сеть отдавала полную ленту (historyComplete=true).
 *
 * ЧТО ПРОВЕРЯЕМ (три сценария из задачи):
 *   1. historyComplete=true (полный снимок) → база считается готовой, base-pending нет;
 *   2. shrunk=true (коллапс ленты 6→2 после F5) → доверия НЕ взводит, base-pending остаётся;
 *   3. сети не было вовсе → доверия нет, base-pending остаётся.
 * Плюс: доверие привязано к чату (карта по ключу convId/пути), сброс в resetConversationState
 * и защита прочих платформ (qwen/остальные вердикты не сдвинулись, признак не проник в
 * core/export-manager.js и utils/export-emit-pipeline.js).
 *
 * КАК ЗАПУСКАЕМ. Группа 1 — реальный предикат core/content.js (aiCmAutoExportTrustedBase +
 * его диагностика) в `with (ctx)`-песочнице + реальный гейт utils/export-emit-pipeline.js.
 * Группа 2 — реальный срез core/content.js от `var aiCmNetMsgsAistudio` до восстановления
 * кэша (тот же приём, что в tests/adapters/aistudio-history-cache.test.js): проверяем, что
 * флаг взводится РОВНО полным снимком текущего пути.
 */

const fs = require('fs');
const path = require('path');

const P = require('../../utils/export-emit-pipeline.js');
const { contentSource: CONTENT } = require('../helpers/content-source.js');

const ROOT = path.join(__dirname, '..', '..');
const CONTENT_SRC = fs.readFileSync(path.join(ROOT, 'core', 'content.js'), 'utf8');
const WIDGET_SRC = fs.readFileSync(path.join(ROOT, 'core', 'widget.js'), 'utf8');
const MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');
const PIPELINE_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'export-emit-pipeline.js'), 'utf8');

// Рез по балансу фигурных скобок (конвенция сьюта).
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

const CID = 'conv-1';
const URL_1 = 'https://aistudio.google.com/prompts/conv-1';
const LIVE_PCT = 41.2;
const LIVE_THRESHOLD = 30;

const SCOPE = 'with (ctx) { ' +
  fnDecl(CONTENT, 'aiCmAutoExportTrustedBase') + '\n' +
  fnDecl(CONTENT, 'aiCmAutoExportTrustedBaseDiag') + '\n' +
  fnDecl(CONTENT, 'aiCmNetReadyKey') + '\n' +
  fnDecl(CONTENT, 'aiCmAistudioPathOf') + '\n' +
  ' return { trusted: aiCmAutoExportTrustedBase, diag: aiCmAutoExportTrustedBaseDiag }; }';
const makeScope = new Function('ctx', SCOPE);

/**
 * Песочница content-скрипта для предиката доверия.
 * over: site, adapterBaseSeen, ready, cid.
 */
function stand(over) {
  const o = over || {};
  const diag = [];
  const ctx = {
    currentAdapter: { siteName: o.site || 'aistudio' },
    adapterBaseSeen: o.adapterBaseSeen === true,
    aiCmNetReadyAistudio: o.ready || {},
    getCurrentConvId: function () { return (o.cid !== undefined) ? o.cid : CID; },
    baseSeen: false,
    baseComplete: false,
    window: {
      location: { hostname: 'aistudio.google.com', href: URL_1 }
    },
    aiCmDiagLine: function (evt, payload) { diag.push({ evt: evt, p: payload }); }
  };
  const api = makeScope(ctx);
  return {
    ctx: ctx,
    diag: diag,
    trusted: api.trusted,
    trustedDiag: api.diag,
    gate: function (domBaseTrusted) {
      return P.shouldSkipAutoExport({
        enabled: true, percentage: LIVE_PCT, threshold: LIVE_THRESHOLD,
        baseComplete: false, baseSeen: false, loaderRunning: false, fired: false,
        isGemini: false, site: o.site || 'aistudio', domBaseTrusted: domBaseTrusted
      });
    }
  };
}

// =====================================================================================
// 1. Гейт: полный снимок снимает base-pending; shrunk/без сети — не снимает
// =====================================================================================
describe('AI Studio (Вариант A): доверие к базе адаптера по флагу полноты сети', () => {
  test('historyComplete=true: предикат истинен, гейт пропускает (base-pending не возвращается)', () => {
    const h = stand({ adapterBaseSeen: true, ready: { 'conv-1': true } });
    expect(h.trusted()).toBe(true);
    expect(h.gate(h.trusted())).toEqual({ skip: false, reason: null, resetFired: false });
  });

  test('shrunk=true (флаг не взведён): доверия нет, base-pending остаётся прежним', () => {
    const h = stand({ adapterBaseSeen: true, ready: {} });
    expect(h.trusted()).toBe(false);
    expect(h.gate(h.trusted())).toEqual({ skip: true, reason: 'base-pending', resetFired: false });
  });

  test('сети не было вовсе (базы адаптера нет): доверия нет, base-pending', () => {
    const h = stand({ adapterBaseSeen: false, ready: {} });
    expect(h.trusted()).toBe(false);
    expect(h.gate(h.trusted())).toEqual({ skip: true, reason: 'base-pending', resetFired: false });
  });

  test('доверие привязано к чату: флаг другого convId базу этого не открывает', () => {
    const other = stand({ adapterBaseSeen: true, ready: { 'conv-2': true } });
    expect(other.trusted()).toBe(false);
    expect(other.gate(other.trusted()).reason).toBe('base-pending');
  });

  test('без adapterBaseSeen даже полный флаг не открывает экспорт (нужна база адаптера)', () => {
    const h = stand({ adapterBaseSeen: false, ready: { 'conv-1': true } });
    expect(h.trusted()).toBe(false);
  });

  test('прочие платформы 1:1: qwen — по adapterBaseSeen, остальные — никогда', () => {
    expect(stand({ site: 'qwen', adapterBaseSeen: true }).trusted()).toBe(true);
    expect(stand({ site: 'qwen', adapterBaseSeen: false }).trusted()).toBe(false);
    ['chatgpt', 'gemini', 'deepseek', 'claude', 'perplexity', 'google_search'].forEach(function (site) {
      expect(stand({ site: site, adapterBaseSeen: true, ready: { 'conv-1': true } }).trusted()).toBe(false);
    });
  });

  test('диагностика: site=aistudio, netReady=1, domBaseTrusted=1, байты файла не меняются', () => {
    const h = stand({ adapterBaseSeen: true, ready: { 'conv-1': true } });
    expect(h.trustedDiag('threshold', CID, LIVE_PCT)).toBe(true);
    expect(h.diag).toHaveLength(1);
    expect(h.diag[0].evt).toBe('auto-export');
    expect(h.diag[0].p.site).toBe('aistudio');
    expect(h.diag[0].p.verdict).toBe('fire');
    expect(h.diag[0].p.netReady).toBe(1);
    expect(h.diag[0].p.domBaseTrusted).toBe(1);
    expect(h.diag[0].p.adapterBaseSeen).toBe(1);
    // без доверия строки нет вовсе (гейт aiCmDebug не расширяем шумом)
    const noTrust = stand({ adapterBaseSeen: true, ready: {} });
    expect(noTrust.trustedDiag('threshold', CID, LIVE_PCT)).toBe(false);
    expect(noTrust.diag).toEqual([]);
  });
});

// =====================================================================================
// 2. Ingest: флаг взводится РОВНО полным снимком текущего пути
// =====================================================================================
const START_MARK = 'var aiCmNetMsgsAistudio = null;';
const END_MARK = 'aiCmAistudioHistoryCacheRestore();';

/** Минимальное окно AI Studio (то, что читает срез сети/кэша). */
function makeWin(pathname) {
  const loc = { hostname: 'aistudio.google.com', href: 'https://aistudio.google.com' + pathname };
  return {
    location: loc,
    addEventListener: function () { },
    removeEventListener: function () { },
    dispatchEvent: function () { return true; }
  };
}

function loadIngest(win) {
  const from = CONTENT_SRC.indexOf(START_MARK);
  const to = CONTENT_SRC.indexOf(END_MARK, from);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  const section = CONTENT_SRC.slice(from, to + END_MARK.length);
  const factory = new Function(
    'window', 'sessionStorage', 'netServerTokens', 'debugLog', 'swallowSoft', 'aiCmBridgeDetail',
    'detectedModelSlug',
    section + '\nreturn {' +
    ' ingest: aiCmIngestAistudioNet,' +
    ' reset: aiCmNetReadyAistudioReset,' +
    ' ready: function () { return aiCmNetReadyAistudio; },' +
    ' key: aiCmNetReadyKey,' +
    ' state: function () { return aiCmNetMsgsAistudio; }' +
    ' };'
  );
  return factory(win, window.sessionStorage, 0, function () { }, function () { },
    function (ev) { return ev && ev.detail; }, '');
}

const MSGS_FULL = [
  { role: 'user', text: 'первый вопрос' },
  { role: 'model', text: 'первый ответ' },
  { role: 'user', text: 'второй вопрос' },
  { role: 'model', text: 'второй ответ' },
  { role: 'user', text: 'третий вопрос' },
  { role: 'model', text: 'третий ответ' }
];
const MSGS_SHRUNK = MSGS_FULL.slice(0, 2);

describe('AI Studio: взвод флага полноты в aiCmIngestAistudioNet', () => {
  beforeEach(() => { window.sessionStorage.clear(); });

  test('полный снимок (historyComplete=true) взводит флаг чата', () => {
    const api = loadIngest(makeWin('/prompts/conv-1'));
    api.ingest({ kind: 'history', href: URL_1, msgs: MSGS_FULL.slice(), ts: 1 });
    expect(api.state().historyComplete).toBe(true);
    expect(api.state().count).toBe(6);
    expect(api.ready()[api.key()]).toBe(true);
    expect(api.key()).toBe('path:/prompts/conv-1');
  });

  test('shrunk=true (коллапс 6→2 после F5) доверия НЕ взводит', () => {
    const api = loadIngest(makeWin('/prompts/conv-1'));
    api.ingest({ kind: 'history', href: URL_1, msgs: MSGS_FULL.slice(), ts: 1 });
    api.reset();
    expect(api.ready()).toEqual({});
    api.ingest({ kind: 'history', href: URL_1, msgs: MSGS_SHRUNK.slice(), ts: 2 });
    expect(api.state().historyComplete).toBe(false);
    expect(api.state().count).toBe(6); // полный снимок не затёрт
    expect(api.ready()).toEqual({});
  });

  test('снимок чужого пути доверия текущему чату не даёт', () => {
    const api = loadIngest(makeWin('/prompts/conv-2'));
    api.ingest({ kind: 'history', href: URL_1, msgs: MSGS_FULL.slice(), ts: 1 });
    expect(api.state().href).toBe(URL_1);
    expect(api.ready()).toEqual({});
  });

  test('reset очищает карту (смена чата не наследует полноту прошлого)', () => {
    const api = loadIngest(makeWin('/prompts/conv-1'));
    api.ingest({ kind: 'history', href: URL_1, msgs: MSGS_FULL.slice(), ts: 1 });
    expect(Object.keys(api.ready())).toHaveLength(1);
    api.reset();
    expect(api.ready()).toEqual({});
    expect(api.ingest({ kind: 'history', href: URL_1, msgs: MSGS_FULL.slice(), ts: 3 })).toBe(true);
    expect(api.ready()[api.key()]).toBe(true);
  });
});

// =====================================================================================
// 3. Проводка и границы (source-пины): R1 — другие платформы не задеты
// =====================================================================================
describe('AI Studio: проводка фикса и границы R1', () => {
  test('content.js: флаг+ключ+сброс и взвод только при !shrunk', () => {
    expect(CONTENT_SRC).toContain('var aiCmNetReadyAistudio = {};');
    expect(CONTENT_SRC).toContain('function aiCmNetReadyKey()');
    expect(CONTENT_SRC).toContain('function aiCmNetReadyAistudioReset()');
    const ingest = fnDecl(CONTENT_SRC, 'aiCmIngestAistudioNet');
    expect(ingest).toContain('if (!shrunk) {');
    expect(ingest).toContain('aiCmNetReadyAistudio[readyKey] = true;');
    expect(ingest).toContain('historyComplete: !shrunk');
    // предикат: ветка aistudio узкая — флаг И база адаптера
    const trusted = fnDecl(CONTENT_SRC, 'aiCmAutoExportTrustedBase');
    expect(trusted).toContain("currentAdapter.siteName === 'aistudio'");
    expect(trusted).toContain('adapterBaseSeen === true');
    expect(trusted).toContain('aiCmNetReadyAistudio[cidReady] === true');
  });

  test('widget.js: сброс флага в resetConversationState через typeof-гард', () => {
    expect(WIDGET_SRC).toContain("if (typeof aiCmNetReadyAistudioReset === 'function') { aiCmNetReadyAistudioReset(); }");
    const reset = fnDecl(WIDGET_SRC, 'resetConversationState');
    expect(reset).toContain('adapterBaseSeen = false;');
    expect(reset).toContain('aiCmNetReadyAistudioReset()');
  });

  test('признак не проник в export-manager.js и гейт (R1: порядок причин прежний)', () => {
    expect(MGR_SRC).not.toContain('aiCmNetReadyAistudio');
    expect(MGR_SRC).not.toContain('aistudio');
    expect(PIPELINE_SRC).not.toContain('aiCmNetReadyAistudio');
    const gate = fnDecl(PIPELINE_SRC, 'shouldSkipAutoExport');
    expect(gate).toContain('var basePending = (s.isGemini !== true && s.baseSeen !== true && !domBaseTrusted && !networkCompleteLatch);');
    expect(gate).toContain("reason: 'base-pending'");
  });
});
