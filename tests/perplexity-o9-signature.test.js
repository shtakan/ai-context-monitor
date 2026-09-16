/**
 * O-9-подпись: `[AI CM][turnsMap] snapshot-at-manual msgs=0` на Perplexity при живой истории.
 *
 * ЖИВОЙ ДЕФЕКТ: подпись в момент ручного экспорта собиралась ТОЛЬКО из MAIN-моста
 * `ai-cm-turns-snap-request/response` (это мост turnsMap Gemini/DeepSeek). У Perplexity
 * MAIN-перехватчик на мост не отвечает (его база живёт в ISOLATED-снимке — detail.messages /
 * lastBaseTexts), поэтому snap=null, а третьим аргументом content.js передавал null →
 * подпись печатала msgs=0 firstText="" при непустой истории; читалось как «пустая база».
 *
 * ФИКС: источник подписи в точке ручного экспорта — КАНОНИЧЕСКАЯ база текущего снимка,
 * ровно тот же массив, что идёт в файл (buildHistoryMessages() → detail.messages/lastBaseTexts).
 * Мост остаётся ПРИОРИТЕТНЫМ: если MAIN-перехватчик ответил (Gemini / DeepSeek O-17),
 * подпись печатает его числа — фолбэк не подставляется (семантика O-17 не тронута).
 *
 * НЕ ТРОГАЕТСЯ: гейты автоэкспорта, поведение экспорта (байты файла), парсинг
 * perplexity-intercept, firstMsgHash/lastMsgHash + baseComplete/reachedStart/confirmedByScroll
 * (формула и дефолты прежние).
 */
const P = require('../utils/export-emit-pipeline.js');
const Parser = require('../utils/perplexity-parser.js');
const { readSource } = require('./helpers/content-source.js');

const CONTENT = readSource('core/content.js');
const BASE_HANDLER = readSource('core/base-handler.js');
const EXPORT_MGR = readSource('core/export-manager.js');

const PERP_CID = 'perplexity-thread-9f2c';
const DS_CID = 'deepseek-spa-o17';

// Рез по балансу фигурных скобок (тот же приём, что в tests/autoexport-export-isolation-e1.test.js).
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

// Регион РЕАЛЬНОГО обработчика aiCmExportCurrent (ручной экспорт md/txt из options/print).
const MANUAL_START = CONTENT.indexOf("if (message.type === 'aiCmExportCurrent') {");
const MANUAL_END = CONTENT.indexOf("if (message.type === 'GET_STATS') {");
const MANUAL = CONTENT.slice(MANUAL_START, MANUAL_END);

// Песочница ручного экспорта: функции, которые обязаны быть НАСТОЯЩИМИ (base-handler +
// export-manager), остальное — состояние/заглушки через ctx. `window` — jsdom-мир, поэтому
// CustomEvent-мост turns-snap работает по-настоящему (Perplexity на запрос не отвечает).
const SCOPE = 'with (ctx) { ' +
  fnDecl(BASE_HANDLER, 'aiCmDiagHash6') + '\n' +
  fnDecl(BASE_HANDLER, 'aiCmGeminiTurnsSnapshotSync') + '\n' +
  fnDecl(BASE_HANDLER, 'aiCmDumpTurnsSnapshot') + '\n' +
  fnDecl(BASE_HANDLER, 'aiCmLogIntraDedupe') + '\n' +
  fnDecl(BASE_HANDLER, 'aiCmLogDedupeRemoved') + '\n' +
  fnDecl(BASE_HANDLER, 'aiCmDedupeExportSource') + '\n' +
  fnDecl(BASE_HANDLER, 'buildHistoryMessages') + '\n' +
  fnDecl(EXPORT_MGR, 'sanitizeGeminiText') + '\n' +
  fnDecl(EXPORT_MGR, 'aiCmSanitizeDebugOn') + '\n' +
  fnDecl(EXPORT_MGR, 'aiCmLogSanitizeSkip') + '\n' +
  fnDecl(EXPORT_MGR, 'aiCmSanitizeEmitUserTexts') + '\n' +
  fnDecl(EXPORT_MGR, 'aiCmCollectExportSource') + '\n' +
  'var run = function (message, sendResponse) {' + MANUAL + '}; return { run: run }; }';
const makeManualExport = new Function('ctx', SCOPE);

const PERP_QUERY_1 = 'Первый вопрос Perplexity';
const PERP_ANSWER_1 = 'Первый ответ Perplexity.';
const PERP_QUERY_2 = 'Второй вопрос Perplexity';
const PERP_ANSWER_2 = 'Второй ответ Perplexity.';
const PERP_MODEL = 'sonar-pro';

// ФИКСТУРА Perplexity-снапшота: JSON треда в форме REST /rest/thread/{slug} (блоки
// workflow_block), прогнанный через РЕАЛЬНЫЙ парсер utils/perplexity-parser.js —
// pieces/ids/messages/count 1:1 с тем, что уходит в EMIT ai-cm-full-history.
function workflowEntry(slug, query, answer) {
  return {
    thread_url_slug: slug, display_model: PERP_MODEL, query_str: query,
    blocks: [{
      workflow_block: {
        steps: [{ items: [{ type: 'WORKFLOW_ITEM_TEXT', payload: { text_payload: { text: answer } } }] }]
      }
    }]
  };
}
function perplexitySnapshot() {
  return Parser.parsePerplexityThread({
    thread_metadata: { slug: PERP_CID },
    entries: [
      workflowEntry(PERP_CID + '_1', PERP_QUERY_1, PERP_ANSWER_1),
      workflowEntry(PERP_CID + '_2', PERP_QUERY_2, PERP_ANSWER_2)
    ]
  });
}

// ctx ISOLATED-мира после EMIT Perplexity (то, что кладёт слушатель ai-cm-full-history).
function perplexityCtx(over) {
  const snap = perplexitySnapshot();
  const logs = [];
  const sent = [];
  const ctx = {
    window: window,
    currentAdapter: { siteName: 'perplexity' },
    baseSeen: true,
    baseComplete: true,
    baseCount: snap.count,
    baseText: snap.text,
    lastBaseTexts: snap.pieces,
    lastBaseIds: snap.ids,
    lastDetailMessages: snap.messages.map(function (m) { return { role: m.role, text: m.text, id: '' }; }),
    lastPercentage: 3.4,
    lastSnapshotModelName: PERP_MODEL,
    lastResolvedModelId: PERP_MODEL,
    maxTokenCount: 4321,
    computeEffectiveLimit: function () { return 200000; },
    getCurrentConvId: function () { return PERP_CID; },
    aiCmFlushLiveStreamForExport: function () { },
    aiCmExportNetSyncThen: function (cid, cb) { cb({ ok: false, reason: 'no-conv' }); },
    aiCmExportNetSyncSite: function () { return false; },
    aiCmBaseConfirmedByConv: {},
    lastDedupeLogSig: null,
    sessionStorage: window.sessionStorage,
    debugLog: function (lvl, msg) { logs.push(String(msg)); }
  };
  Object.assign(ctx, over || {});
  window.AiCmExportEmitPipeline = P;
  const api = makeManualExport(ctx);
  return {
    ctx: ctx,
    snap: snap,
    logs: logs,
    sent: sent,
    run: function () {
      api.run({ type: 'aiCmExportCurrent' }, function (resp) { sent.push(resp); });
      return sent[sent.length - 1];
    },
    dumpLine: function () {
      for (let i = logs.length - 1; i >= 0; i--) {
        if (logs[i].indexOf('[AI CM][turnsMap] snapshot-at-manual') === 0) return logs[i];
      }
      return '';
    }
  };
}

function field(line, name) {
  const m = String(line).match(new RegExp('(?:^| )' + name + '=("[^"]*"|[^ ]+)'));
  return m ? m[1].replace(/^"|"$/g, '') : null;
}
function collapse80(text) {
  return String(text || '').slice(0, 80).replace(/\s+/g, ' ');
}
// Независимая копия формулы base-handler: FNV-1a(6) от '' + text (фолбэк без MAIN-моста).
function fnv6(text) {
  const s = String('') + '\u0000' + String(text || '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('000000' + h.toString(16)).slice(-6);
}

// =====================================================================================
// 1. Воспроизведение дефекта: Perplexity, живая история → путь snapshot-at-manual
// =====================================================================================
describe('O-9-подпись: Perplexity snapshot-at-manual печатает реальные msgs из базы', () => {
  test('мост turnsMap на Perplexity молчит (нет ответа на ai-cm-turns-snap-request)', () => {
    let resp = null;
    const h = function (ev) { resp = ev.detail; };
    window.addEventListener('ai-cm-turns-snap-response', h, { once: true });
    window.dispatchEvent(new window.CustomEvent('ai-cm-turns-snap-request'));
    window.removeEventListener('ai-cm-turns-snap-response', h);
    expect(resp).toBeNull();                        // опора только на мост давала msgs=0
    expect(perplexitySnapshot().count).toBe(4);     // при этом история в базе ЖИВАЯ
  });

  test('подпись печатает msgs=N (N>0) — число ходов канонической базы, а не 0', () => {
    const h = perplexityCtx();
    h.run();
    const line = h.dumpLine();
    expect(line).not.toBe('');
    expect(line).toContain('[AI CM][turnsMap] snapshot-at-manual convId=' + PERP_CID);
    expect(field(line, 'msgs')).toBe(String(h.snap.count));
    expect(Number(field(line, 'msgs'))).toBeGreaterThan(0);
    expect(h.snap.count).toBe(4);                   // 2 обмена: user+assistant на каждый
  });

  test('firstText/lastText (и хеши) — из ТОЙ ЖЕ базы, что уходит в экспорт', () => {
    const h = perplexityCtx();
    const resp = h.run();
    const line = h.dumpLine();
    const msgs = resp.data.messages;
    // подпись и файл — один источник: канонический снимок detail.messages/lastBaseTexts
    expect(msgs.length).toBe(h.snap.count);
    expect(msgs.map(function (m) { return m.text; })).toEqual(h.snap.pieces);
    expect(field(line, 'firstText')).toBe(collapse80(msgs[0].text));
    expect(field(line, 'lastText')).toBe(collapse80(msgs[msgs.length - 1].text));
    expect(field(line, 'firstText')).toBe(PERP_QUERY_1);
    expect(field(line, 'lastText')).toBe(PERP_ANSWER_2);
    // формула хешей прежняя (aiCmDiagHash6('', text) из base-handler) — дефолтов не выдумано
    expect(field(line, 'firstMsgHash')).toBe(fnv6(msgs[0].text));
    expect(field(line, 'lastMsgHash')).toBe(fnv6(msgs[msgs.length - 1].text));
    expect(field(line, 'firstMsgHash')).not.toBe('-');
    expect(field(line, 'lastMsgHash')).not.toBe('-');
  });

  test('семантика baseComplete/reachedStart/confirmedByScroll прежняя (не выдумана)', () => {
    const h = perplexityCtx();
    h.run();
    const line = h.dumpLine();
    expect(field(line, 'baseComplete')).toBe('1');       // baseComplete=true из состояния
    // detail.reachedStart у Perplexity нет → карта подтверждения не заполнена → дефолт false
    expect(field(line, 'reachedStart')).toBe('false');
    expect(field(line, 'confirmedByScroll')).toBe('false');
  });

  test('экспорт не изменился: подпись не влияет на payload ручного экспорта', () => {
    const h = perplexityCtx();
    const resp = h.run();
    expect(resp.data.site).toBe('perplexity');
    expect(resp.data.convId).toBe(PERP_CID);
    expect(resp.data.isLowConfidenceBase).toBe(false);
    expect(resp.data.messages.map(function (m) { return m.role; }))
      .toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(h.sent.length).toBe(1);                       // ручной экспорт ответил ровно один раз
  });
});

// =====================================================================================
// 2. DeepSeek O-17: мост turnsMap приоритетен — подпись байтово прежняя
// =====================================================================================
describe('O-9-подпись: DeepSeek O-17 не тронут — мост turnsMap остаётся источником подписи', () => {
  const BRIDGE = {
    convId: DS_CID,
    msgs: 2,
    firstText: 'BRIDGE-первый ход',
    lastText: 'BRIDGE-последний ход',
    firstMsgHash: 'abc123',
    lastMsgHash: 'def456',
    baseComplete: true,
    reachedStart: true,
    confirmedByScroll: true,
    scrollEngaged: true
  };

  // Реальный ответ MAIN-перехватчика на мост (как deepseek-intercept.js O-17).
  function deepseekCtx() {
    const answerBridge = function () {
      window.dispatchEvent(new window.CustomEvent('ai-cm-turns-snap-response', { detail: BRIDGE }));
    };
    window.addEventListener('ai-cm-turns-snap-request', answerBridge);
    const h = perplexityCtx({
      currentAdapter: { siteName: 'deepseek' },
      getCurrentConvId: function () { return DS_CID; },
      baseComplete: true,
      baseCount: 4,
      lastBaseTexts: ['q1', 'a1', 'q2', 'a2'],
      lastDetailMessages: [
        { role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' },
        { role: 'user', text: 'q2' }, { role: 'assistant', text: 'a2' }
      ],
      aiCmBaseConfirmedByConv: { [DS_CID]: 1 }
    });
    return { h: h, off: function () { window.removeEventListener('ai-cm-turns-snap-request', answerBridge); } };
  }

  test('ответ моста перекрывает канонический фолбэк (msgs=2, а не 4)', () => {
    const d = deepseekCtx();
    try {
      d.h.run();
      const line = d.h.dumpLine();
      expect(line).toContain('[AI CM][turnsMap] snapshot-at-manual convId=' + DS_CID);
      expect(field(line, 'msgs')).toBe('2');                     // числа моста, не длина базы
      expect(field(line, 'firstText')).toBe(BRIDGE.firstText);
      expect(field(line, 'lastText')).toBe(BRIDGE.lastText);
      expect(field(line, 'firstMsgHash')).toBe(BRIDGE.firstMsgHash);
      expect(field(line, 'lastMsgHash')).toBe(BRIDGE.lastMsgHash);
      expect(field(line, 'baseComplete')).toBe('1');
      expect(field(line, 'reachedStart')).toBe('true');
      expect(field(line, 'confirmedByScroll')).toBe('true');
    } finally { d.off(); }
  });

  test('payload ручного экспорта DeepSeek прежний: 4 хода in-memory базы', () => {
    const d = deepseekCtx();
    try {
      const resp = d.h.run();
      expect(resp.data.messages.map(function (m) { return m.text; })).toEqual(['q1', 'a1', 'q2', 'a2']);
      expect(resp.data.messages.length).toBe(4);                 // подпись msgs=2 файл не подменила
    } finally { d.off(); }
  });
});

// =====================================================================================
// 3. Source-пины: правка локальна, дефолты и мост не тронуты
// =====================================================================================
describe('O-9-подпись: source-пины правки', () => {
  test('точка ручного экспорта передаёт КАНОНИЧЕСКУЮ базу (buildHistoryMessages), а не null', () => {
    expect(MANUAL).toContain("aiCmDumpTurnsSnapshot('snapshot-at-manual', curCidExp, buildHistoryMessages());");
    expect(MANUAL).not.toContain("aiCmDumpTurnsSnapshot('snapshot-at-manual', curCidExp, null);");
    expect(CONTENT.match(/aiCmDumpTurnsSnapshot\(/g).length).toBe(1);   // других путей не задето
  });

  test('base-handler: приоритет моста и семантика дефолтов байтово прежние', () => {
    const dump = fnDecl(BASE_HANDLER, 'aiCmDumpTurnsSnapshot');
    expect(dump).toContain('var snap = aiCmGeminiTurnsSnapshotSync();');
    expect(dump).toContain('if (!msgsN && Array.isArray(msgs) && msgs.length > 0) {');
    expect(dump).toContain("firstHash = aiCmDiagHash6('', msgs[0] && msgs[0].text);");
    expect(dump).toContain('if (bc === null) bc = (baseComplete === true);');
    expect(dump).toContain('var conf = (aiCmBaseConfirmedByConv[cid] === 1);');
  });

  test('автоэкспорт (snapshot-at-fired) не тронут: дамп получает сообщения файла', () => {
    expect(EXPORT_MGR).toContain("aiCmDumpTurnsSnapshot('snapshot-at-fired', cid, msgs);");
  });

  test('перехватчики не тронуты: мосты Gemini/DeepSeek на месте, у Perplexity моста нет', () => {
    const gem = readSource('core/gemini-intercept.js');
    const ds = readSource('core/deepseek-intercept.js');
    const perp = readSource('core/perplexity-intercept.js');
    expect(gem).toContain("new CustomEvent('ai-cm-turns-snap-response', { detail: diagSnap })");
    expect(ds).toContain("new CustomEvent('ai-cm-turns-snap-response', { detail: turnsSnapshot() })");
    expect(perp).not.toContain('ai-cm-turns-snap-request');
    expect(perp).not.toContain('snapshot-at-manual');
  });
});
