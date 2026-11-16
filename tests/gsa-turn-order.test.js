/**
 * BUG-D (act-gsa-turn-order): канонический порядок ходов GSA — old→new.
 *
 * ЧТО ЗДЕСЬ УДОСТОВЕРЯЕТСЯ (поведением, без чтения исходника продукта):
 *   T1 17 ходов в снимке + 1 живой ход, который уже есть в DOM, но ещё не попал в снимок:
 *      после open-пути (добор из DOM в голову + окно открытия в хвост) живой ход стоит
 *      ПОСЛЕДНИМ, а база идёт old→new;
 *   T2 пагинация: страница 2 старше базы → в голову, страница 3 ещё старше → в голову,
 *      итоговая база old→new (свежайший ход в хвосте);
 *   T3 реальная new→old фикстура: messages[0] — самый старый user, последний — новейший
 *      assistant.
 *
 * Исполняются РЕАЛЬНЫЕ функции перехватчика (песочница tests/adapters/helpers/
 * gsa-loop-sandbox.js) и РЕАЛЬНЫЙ парсер utils/google-search-folwr-parser.ts. Порядок
 * сторится ровно тем же слиянием, что в open-пути: mergeTurnsByKey(domTurns, baseTurns)
 * (prepend, DOM = весь тред) → applyTurns(…, 'append').
 */
'use strict';

const fs = require('fs');
const path = require('path');
const SANDBOX = require('./adapters/helpers/gsa-loop-sandbox.js');

const { Parser, makeApi, makeFetch } = SANDBOX;

const TID = 'GSA-TURN-ORDER';
const FOLWR_URL = 'https://www.google.com/search?udm=50&async=folwr';
const DIAG_PREFIX = '[AI CM][diag]';

function turnObj(id) {
  return { id: id, userText: 'Вопрос ' + id, assistantText: 'Ответ ' + id };
}

function turnHtml(t) {
  return '<div class="CKgc1d" data-scope-id="turn" jsuid="' + t.id + '">' +
    '<h2 class="iMqumd">Вы сказали: "' + t.userText + '"</h2></div>' +
    '<div class="n6owBd awi2gc">' + t.assistantText + '</div>';
}

/** Документ в порядке реального GSA-экспорта: new→old (первый блок — новейший ход). */
function snapshotHtml(turnsNewToOld) {
  return '<div><div data-session-thread-id="' + TID + '" style="display:none"></div>' +
    '<div data-container-id="synth"></div><div>' +
    turnsNewToOld.map(turnHtml).join('') + '</div></div>';
}

// Живой DOM: переданные ходы идут в document order как есть. Замер 2026-11-14 (тред
// 8bTpaveuJtWckdUP46iumAo): 21 контейнер [data-scope-id="turn"], document order
// ХРОНОЛОГИЧЕСКИЙ (c[0] — вопрос «deepseek fall down»), поэтому DOM-фикстура — old→new.
function docHtml(turnsInDocumentOrder) {
  return '<div><div data-session-thread-id="' + TID + '" style="display:none"></div>' +
    '<div data-container-id="synth"></div><div>' +
    turnsInDocumentOrder.map(turnHtml).join('') + '</div></div>';
}

function docFrom(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

async function settle(h, tid) {
  const key = (tid || TID) + '|';
  for (let i = 0; i < 200 && h.api.folwrRunLiveMap[key]; i++) await sleep(10);
  await sleep(30);
}

// Минимальная песочница перехватчика — та же форма ctx, что в tests/adapters/
// gsa-loop-guard.test.js (реальные функции базы, остальное — заглушки окружения).
function loopCtx(over) {
  const sink = [];
  const events = [];
  const utils = Object.create(Parser);
  utils.extractContinuationToken = function (txt) {
    return txt && txt.indexOf('mstk') !== -1 ? 'CURSOR-SAME' : null;
  };
  utils.extractTurnsFromDocument = function () { return utils.__domTurns || []; };
  utils.countTurnContainers = function (html) {
    return (html.match(/data-scope-id="turn"/g) || []).length;
  };

  const ctx = {
    FOLWR_MAX_PAGES: 12,
    FOLWR_PAGE_DELAY_MS: 400,
    location: { href: FOLWR_URL, hostname: 'www.google.com', search: '?udm=50' },
    console: { log: function (m) { sink.push(String(m)); } },
    debugLog: function (lvl, msg) { sink.push(String(msg)); },
    document: { querySelectorAll: function () { return []; }, querySelector: function () { return null; } },
    URL: URL,
    Math: Math,
    Date: Date,
    setTimeout: setTimeout,
    parseWithParser: function (txt) {
      const r = Parser.parseGoogleFolwrOpen(txt);
      return { turns: r.turns, messages: r.messages, count: r.count, text: r.text, threadId: r.threadId };
    },
    describeFolwrPage: function () {
      return { cls: { kind: 'no-new-turns', complete: false, canContinue: false }, line: 'kind=no-new-turns' };
    },
    window: {
      GoogleFolwrUtils: utils,
      dispatchEvent: function (ev) { events.push(ev.detail); }
    },
    readDomThreadId: function () { return TID; },
    vsCalls: [],
    vsBackfillStub: function (reason) { ctx.vsCalls.push(reason); return true; },
    diagPreview: function (txt) { return String(txt || '').slice(0, 300); },
    activeLoadFolwr: function () { },
    ownRequestsAllowed: function () { return true; },
    threadAuthKey: function (tid) { return (tid || '') + '|'; },
    urlWithMstk: function (u) { return u; },
    isSorryResponse: function () { return false; },
    triggerSorryCooldown: function () { }
  };

  const diag = {
    on: function () { return ctx.diagGate === true; },
    line: function (point, fields) {
      if (!diag.on()) return false;
      const pairs = [];
      Object.keys(fields || {}).forEach(function (k) { pairs.push(k + '=' + fields[k]); });
      sink.push(DIAG_PREFIX + ' ' + point + ' ' + pairs.join(' '));
      return true;
    },
    kind: function () { return 'chat'; }
  };
  ctx.aiCmDiagOn = diag.on;
  ctx.aiCmDiagLine = diag.line;
  ctx.aiCmDiagDocKind = diag.kind;
  ctx.diagGate = true;

  Object.assign(ctx, over || {});
  ctx.window = Object.assign({
    GoogleFolwrUtils: utils,
    dispatchEvent: function (ev) { events.push(ev.detail); }
  }, ctx.window || {});
  if (!ctx.window.fetch) ctx.window.fetch = makeFetch([], FOLWR_URL);

  const api = makeApi(ctx);
  utils.__domTurns = api.domTurns;
  api.setThread(TID);
  api.setVsImpl(ctx.vsBackfillStub);
  return { ctx: ctx, api: api, sink: sink, events: events, utils: utils };
}

describe('BUG-D: порядок ходов GSA old→new', () => {
  test('17 ходов снимка + live только в DOM → live в хвосте, база old→new', async () => {
    const h = loopCtx({});
    const snapIds = [];
    for (let i = 17; i >= 1; i--) snapIds.push('t' + i);   // документ: t17 … t1
    const baseTurns = Parser.parseGoogleFolwrOpen(snapshotHtml(snapIds.map(turnObj))).turns;
    expect(baseTurns).toHaveLength(17);

    // DOM: document order хронологический — t1 … t17, затем живой ход (он новее всех и уже
    // отрисован, снимок ещё без него); live стоит последним в самой странице, не в голове.
    const domTurns = Parser.extractTurnsFromDocument(
      docFrom(docHtml(snapIds.slice().reverse().map(turnObj).concat([turnObj('live')]))));
    expect(domTurns).toHaveLength(18);

    // Ровно open-путь: DOM = весь тред → добор в голову, окно открытия — в хвост.
    const merged = Parser.mergeTurnsByKey(domTurns, baseTurns);
    h.api.applyTurns(merged, TID, false, 'body', 'append');

    const order = h.api.lastFullTurns.map(function (t) { return t.userText; });
    expect(order).toEqual(['Вопрос t1', 'Вопрос t2', 'Вопрос t3', 'Вопрос t4', 'Вопрос t5',
      'Вопрос t6', 'Вопрос t7', 'Вопрос t8', 'Вопрос t9', 'Вопрос t10', 'Вопрос t11',
      'Вопрос t12', 'Вопрос t13', 'Вопрос t14', 'Вопрос t15', 'Вопрос t16', 'Вопрос t17',
      'Вопрос live']);                                            // живой ход — последний
    expect(h.api.lastFullTurns[17].assistantText).toBe('Ответ live');
    await settle(h);
  });

  test('пагинация: страница 2 и 3 старше базы → обе в голову, итог old→new', async () => {
    const pages = { P2: ['t1', 't2'], P3: ['t0a', 't0b'] };      // внутри страницы old→new
    const h = loopCtx({
      parseWithParser: function (txt) {
        const ids = pages[txt];
        if (!ids) return { turns: [], messages: [], count: 0, text: '', threadId: TID };
        return { turns: ids.map(turnObj), messages: [], count: ids.length, text: '', threadId: TID };
      },
      describeFolwrPage: function (resp, txt, gained, cursor) {
        return { cls: { kind: 'new-turns', complete: false, canContinue: !!cursor }, line: 'kind=new-turns' };
      },
      window: { fetch: makeFetch(['P2', 'P3'], FOLWR_URL) }
    });
    h.utils.extractContinuationToken = function (txt) { return txt === 'P2' ? 'CURSOR-2' : null; };

    const base = ['t3', 't4', 't5'].map(turnObj);                 // база: свежайшее окно
    h.api.applyTurns(base, TID, false, 'body');
    expect(h.api.lastFullTurns.map(function (t) { return t.userText; })).toEqual(
      ['Вопрос t3', 'Вопрос t4', 'Вопрос t5']);

    h.api.followFolwrPagination(FOLWR_URL, base, TID, 'CURSOR-1', 0);
    await sleep(1300);                                           // 2 страницы × FOLWR_PAGE_DELAY_MS

    expect(h.api.lastFullTurns.map(function (t) { return t.userText; })).toEqual(
      ['Вопрос t0a', 'Вопрос t0b', 'Вопрос t1', 'Вопрос t2',
        'Вопрос t3', 'Вопрос t4', 'Вопрос t5']);
    await settle(h);
  });

  test('фикстура new→old: messages[0] — самый старый user, последний — новейший assistant', () => {
    const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'google-folwr-open.html'), 'utf8');
    const parsed = Parser.parseGoogleFolwrOpen(html);

    expect(parsed.messages).toHaveLength(4);
    expect(parsed.messages[0]).toEqual({ role: 'user', text: 'Сколько будет два плюс два?' });
    expect(parsed.messages[0].text).toBe('Сколько будет два плюс два?');
    expect(parsed.messages[3]).toEqual({ role: 'assistant', text: 'Будет то же число в этом случае.' });
    expect(parsed.messages[2]).toEqual({ role: 'user', text: 'А если умножить?' });
    expect(parsed.messages[1].role).toBe('assistant');
    expect(parsed.messages[1].text).toContain('Четыре.');
    expect(parsed.turns[0].userText).toContain('два плюс два');
    expect(parsed.turns[parsed.turns.length - 1].userText).toContain('умножить');
  });

  test('фикстура в форме реального экспорта (new→old, новейший без h2) → oldest-first', () => {
    const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'gsa-folwr-newest-first.html'), 'utf8');
    const parsed = Parser.parseGoogleFolwrOpen(html);

    expect(parsed.threadId).toBe('GSA-REAL-SHAPE-1');
    expect(parsed.turns).toHaveLength(3);
    // Новейший ход (первый блок документа) — assistant-only, без h2 с вопросом:
    // после реверса он последний, userText у него пуст.
    expect(parsed.turns[2].userText).toBeNull();
    expect(parsed.turns[2].assistantText).toContain('Ответ в режиме ИИ, исходный запрос:');
    expect(parsed.turns[2].assistantText).toContain('rsync -av /data /backup');
    // Старший ход обрезан на «Быстрые ответы из интернета:» — после реверса он первый.
    expect(parsed.turns[0].userText).toBe('Что такое rsync?');
    expect(parsed.turns[0].assistantText).toContain('Быстрые ответы из интернета:');

    expect(parsed.messages[0]).toEqual({ role: 'user', text: 'Что такое rsync?' });
    expect(parsed.messages[parsed.messages.length - 1].role).toBe('assistant');
    expect(parsed.messages[parsed.messages.length - 1].text).toContain('Ответ в режиме ИИ');
  });

  test('legacy-снимок GSA без msgOrder не предлагается к экспорту; другие сайты — без изменений', () => {
    const gate = require('./helpers/options-export-gate.js');
    const openOptionsExportGate = gate.openOptionsExportGate;
    const defaultState = gate.defaultState;
    const loadSource = require('./helpers/adapter-harness').loadSource;

    // site берём у РЕАЛЬНОГО адаптера (не константу из самого гарда): гард должен
    // срабатывать ровно на том значении, которое пишет парсер/снимок.
    const GsaAdapter = loadSource(
      ['adapters/base-adapter.ts', 'adapters/google-search-adapter.ts'],
      {
        document: document,
        location: {
          hostname: 'www.google.com',
          pathname: '/search',
          href: 'https://www.google.com/search?q=test&udm=50'
        },
        exportExpr: 'GoogleSearchAdapter'
      }
    ).value;
    const gsaSite = new GsaAdapter().siteName;
    expect(gsaSite).toBe('google_search');

    // Старый снимок: ходы лежат new→old и метки msgOrder нет — экспорт дал бы
    // перевёрнутый файл, поэтому кнопки заблокированы, а подсказка просит обновить страницу.
    const legacyHistory = {
      host: 'www.google.com',
      site: gsaSite,
      model: 'AI Mode',
      tokens: 1200,
      limit: 200000,
      percent: 0.6,
      updatedAt: Date.now() - 60000,
      isLowConfidenceBase: false,
      sourceKind: 'network',
      messages: [
        { role: 'assistant', text: 'новейший ответ' },
        { role: 'user', text: 'свежий вопрос' },
        { role: 'assistant', text: 'старый ответ' },
        { role: 'user', text: 'старый вопрос' }
      ]
    };
    const gsa = openOptionsExportGate({
      host: 'www.google.com',
      tabUrl: 'https://www.google.com/search?q=test&udm=50',
      history: legacyHistory,
      state: defaultState('www.google.com', gsaSite)
    });
    expect(gsa.md.disabled).toBe(true);
    expect(gsa.json.disabled).toBe(true);
    expect(gsa.hint.textContent).toBe('Обновите страницу');

    // А исправленный снимок (msgOrder:2) экспортируется как обычно — гейт не блокирует
    // GSA целиком, только снимки, записанные до фикса порядка.
    const freshHistory = Object.assign({}, legacyHistory, { msgOrder: 2, updatedAt: Date.now() });
    const fresh = openOptionsExportGate({
      host: 'www.google.com',
      tabUrl: 'https://www.google.com/search?q=test&udm=50',
      history: freshHistory,
      state: defaultState('www.google.com', gsaSite)
    });
    expect(fresh.md.disabled).toBe(false);
    expect(fresh.hint.textContent).not.toBe('Обновите страницу');

    // Прочие сайты не затронуты: снимок без msgOrder у них по-прежнему экспортируется
    // (histKey/порядок для них не менялись — поведение байт-в-байт прежнее).
    const others = [
      ['claude', 'claude.ai', 'https://claude.ai/chat/test-conv'],
      ['qwen', 'chat.qwen.ai', 'https://chat.qwen.ai/c/test'],
      ['deepseek', 'chat.deepseek.com', 'https://chat.deepseek.com/a/chat/s/test'],
      ['gemini', 'gemini.google.com', 'https://gemini.google.com/app/test']
    ];
    others.forEach(function (c) {
      const site = c[0], host = c[1], tabUrl = c[2];
      const hist = {
        host: host, site: site, model: 'm', tokens: 10, limit: 200000, percent: 0.1,
        updatedAt: Date.now(), isLowConfidenceBase: false, sourceKind: 'network',
        messages: [{ role: 'user', text: 'вопрос' }, { role: 'assistant', text: 'ответ' }]
      };
      const view = openOptionsExportGate({
        host: host, tabUrl: tabUrl, history: hist, state: defaultState(host, site)
      });
      expect(view.md.disabled).toBe(false);
      expect(view.hint.textContent).not.toBe('Обновите страницу');
    });
  });
});

/**
 * BUG-J (cold load): при холодной загрузке GSA (`folwr-open`) счётчики снимка и DOM совпадают,
 * досбора нет — и в базу уходил порядок снимка new→old (messages[0] — последний ход).
 * Живой DOM хронологический, поэтому open-путь выравнивает список по нему до applyTurns.
 */
describe('BUG-J: выравнивание порядка по живому DOM', () => {
  const ORDER = Parser;

  function mk(id, n) {
    return { id: id, userText: 'Вопрос ' + n, assistantText: 'Ответ ' + n };
  }
  function seq(from, to) {
    const out = [];
    const step = from <= to ? 1 : -1;
    for (let n = from; step > 0 ? n <= to : n >= to; n += step) out.push(mk('t' + n, n));
    return out;
  }
  function ids(list) {
    return list.map(function (x) { return x.id; });
  }

  // ---- 4.1 юнит: вердикты ----
  test('keep: снимок уже old→new → verdict kept, массив не копируется', () => {
    const turns = seq(1, 3);
    const res = ORDER.orderTurnsByDom(turns, seq(1, 3));
    expect(res.verdict).toBe('kept');
    expect(res.matched).toBe(3);
    expect(ids(res.turns)).toEqual(['t1', 't2', 't3']);
    expect(res.turns).toBe(turns);
  });

  test('reverse: снимок new→old против хронологического DOM → verdict reversed', () => {
    const turns = seq(3, 1);                                  // по-прежнему new→old
    const res = ORDER.orderTurnsByDom(turns, seq(1, 3));
    expect(res.verdict).toBe('reversed');
    expect(res.matched).toBe(3);
    expect(ids(res.turns)).toEqual(['t1', 't2', 't3']);
    expect(turns.map(function (t) { return t.id; })).toEqual(['t3', 't2', 't1']);  // исходный не мутирован
  });

  test('no-evidence: DOM пуст → вердикт no-evidence и исходный массив', () => {
    const turns = seq(2, 1);
    const res = ORDER.orderTurnsByDom(turns, []);
    expect(res.verdict).toBe('no-evidence');
    expect(res.matched).toBe(0);
    expect(res.turns).toBe(turns);
  });

  test('no-evidence: меньше двух сопоставлений (пересечение по одному ходу)', () => {
    const turns = [mk('t9', 9), mk('t8', 8)];
    const res = ORDER.orderTurnsByDom(turns, [mk('t1', 1), mk('t9', 9)]);
    expect(res.verdict).toBe('no-evidence');
    expect(res.matched).toBe(1);
    expect(ids(res.turns)).toEqual(['t9', 't8']);
  });

  test('частичное перекрытие: страница-хвост 6..10 против DOM 1..10 → reversed', () => {
    const turns = seq(10, 6);                                 // снимок хвоста, new→old
    const res = ORDER.orderTurnsByDom(turns, seq(1, 10));
    expect(res.verdict).toBe('reversed');
    expect(res.matched).toBe(5);                              // ходы 1..5 в снимке отсутствуют
    expect(ids(res.turns)).toEqual(['t6', 't7', 't8', 't9', 't10']);
  });

  test('фолбэк 1 — id (jsuid): совпадает, даже если канонический ключ разошёлся', () => {
    const dom = seq(1, 3);
    // Тексты разные (ключи не совпадут), id те же — идентичность держится на jsuid.
    const turns = [
      { id: 't3', userText: 'Вопрос иначе 3', assistantText: 'Другой ответ 3' },
      { id: 't2', userText: 'Вопрос иначе 2', assistantText: 'Другой ответ 2' },
      { id: 't1', userText: 'Вопрос иначе 1', assistantText: 'Другой ответ 1' }
    ];
    const res = ORDER.orderTurnsByDom(turns, dom);
    expect(res.verdict).toBe('reversed');
    expect(res.matched).toBe(3);
    expect(ids(res.turns)).toEqual(['t1', 't2', 't3']);
  });

  test('синтетический idx-id идентичностью не считается (иначе совпал бы у разных ходов)', () => {
    // id совпадают позиционно (idx0/idx1), а ходы разные: сопоставление обязано идти по ключу.
    const dom = [mk('z1', 1), mk('z2', 2)];
    const turns = [{ id: 'idx1', userText: 'Совсем другой вопрос', assistantText: 'Совсем другой ответ' },
      { id: 'idx0', userText: 'Тоже другой вопрос', assistantText: 'Тоже другой ответ' }];
    const res = ORDER.orderTurnsByDom(turns, dom);
    expect(res.verdict).toBe('no-evidence');                  // ни один ход не сопоставлен
    expect(res.matched).toBe(0);
  });

  test('фолбэк 2 — канонический ключ при синтетическом id', () => {
    const dom = seq(1, 3).map(function (t) {
      return { id: 'z' + t.id, userText: t.userText, assistantText: t.assistantText };
    });
    const turns = seq(3, 1).map(function (t) {
      return { id: 'idx' + t.id, userText: t.userText, assistantText: t.assistantText };
    });
    const res = ORDER.orderTurnsByDom(turns, dom);
    expect(res.verdict).toBe('reversed');
    expect(res.matched).toBe(3);
    expect(res.turns.map(function (t) { return t.userText; }))
      .toEqual(['Вопрос 1', 'Вопрос 2', 'Вопрос 3']);
  });

  test('фолбэк 3 — тело ответа (префикс) при разных вопросах и синтетическом id', () => {
    const bodies = [
      'Уникальный ответ номер один — длинный текст для проверки префикса.',
      'Уникальный ответ номер два — длинный текст для проверки префикса.',
      'Уникальный ответ номер три — длинный текст для проверки префикса.'
    ];
    const dom = bodies.map(function (b, i) {
      return { id: 'z' + (i + 1), userText: 'Вопрос ' + (i + 1), assistantText: b };
    });
    const turns = [2, 1, 0].map(function (i) {
      return { id: 'idx' + i, userText: null, assistantText: bodies[i].slice(0, 40) };
    });
    const res = ORDER.orderTurnsByDom(turns, dom);
    expect(res.verdict).toBe('reversed');
    expect(res.matched).toBe(3);
    expect(res.turns.map(function (t) { return t.id; })).toEqual(['idx0', 'idx1', 'idx2']);
  });

  // ---- 4.2 интеграция на РЕАЛЬНОМ парсере + РЕАЛЬНОМ applyTurns ----
  test('холодная загрузка: без выравнивания база new→old, с выравниванием old→new', async () => {
    const snapshotOldToNew = snapshotHtml([1, 2, 3, 4, 5].map(function (n) { return turnObj('t' + n); }));
    const domHtmlOldToNew = docHtml([1, 2, 3, 4, 5].map(function (n) { return turnObj('t' + n); }));

    // Что было до фикса: снимок парсится в new→old и уходит в базу как есть.
    const raw = loopCtx({});
    raw.api.applyTurns(Parser.parseGoogleFolwrOpen(snapshotOldToNew).turns, TID, false, 'body', 'append');
    expect(raw.api.lastFullTurns.map(function (t) { return t.userText; }))
      .toEqual(['Вопрос t5', 'Вопрос t4', 'Вопрос t3', 'Вопрос t2', 'Вопрос t1']);
    await settle(raw);

    // После фикса: DOM (old→new) — эталон, список разворачивается ДО записи базы.
    const h = loopCtx({});
    const baseTurns = Parser.parseGoogleFolwrOpen(snapshotOldToNew).turns;
    const domTurns = Parser.extractTurnsFromDocument(docFrom(domHtmlOldToNew));
    expect(domTurns).toHaveLength(5);
    const ordered = Parser.orderTurnsByDom(baseTurns, domTurns);
    expect(ordered.verdict).toBe('reversed');
    h.api.applyTurns(ordered.turns, TID, false, 'body', 'append');

    expect(h.api.lastFullTurns.map(function (t) { return t.userText; })).toEqual(
      ['Вопрос t1', 'Вопрос t2', 'Вопрос t3', 'Вопрос t4', 'Вопрос t5']);
    expect(h.api.lastFullTurns[0].assistantText).toBe('Ответ t1');
    await settle(h);
  });

  test('существующая фикстура new→old: после выравнивания тот же old→new', async () => {
    const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'google-folwr-open.html'), 'utf8');
    const baseTurns = Parser.parseGoogleFolwrOpen(html).turns;   // new→old
    const domTurns = baseTurns.slice().reverse();                // живой DOM: old→new
    const ordered = Parser.orderTurnsByDom(baseTurns, domTurns);
    expect(ordered.verdict).toBe('reversed');
    expect(ordered.turns.map(function (t) { return t.userText; }))
      .toEqual(domTurns.map(function (t) { return t.userText; }));

    const h = loopCtx({});
    h.api.applyTurns(ordered.turns, TID, false, 'body', 'append');
    expect(h.api.lastFullTurns.map(function (t) { return t.userText; })).toEqual(
      domTurns.map(function (t) { return t.userText; }));
    expect(h.api.lastFullTurns[0].userText).toContain('А если умножить?');
    await settle(h);
  });

  // ---- 4.3 пин исходника: вызов ДО applyTurns, без исполнения перехватчика ----
  test('пин open-пути: orderTurnsByDom вызывается после fillMissingUserText и до applyTurns', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'google-search-intercept.js'), 'utf8');
    const fillAt = src.indexOf('fillMissingUserText(mergedTurns, domTurns)');
    const orderAt = src.indexOf('orderTurnsByDom(mergedTurns, domTurns)');
    const applyAt = src.indexOf("applyTurns(mergedTurns, tid, historyComplete, txt, 'append')");

    expect(fillAt).toBeGreaterThan(-1);
    expect(orderAt).toBeGreaterThan(-1);
    expect(applyAt).toBeGreaterThan(-1);
    expect(orderAt).toBeGreaterThan(fillAt);
    expect(orderAt).toBeLessThan(applyAt);
    // вердикт и число сопоставлений уходят в диагностику записи базы
    expect(src).toContain("order: orderVerdict");
    expect(src).toContain('orderMatched: orderMatched');
  });

  // ---- 4.4 BUG-J-2: probe не перезаписывает выровненную open-путём базу ----
  test('probe после open: cursor-repeat (added=0) сохраняет old→new', async () => {
    const snapshotHtmlNewToOld = snapshotHtml([1, 2, 3, 4, 5].map(function (n) { return turnObj('t' + n); }));
    const rawSnapshotTurns = Parser.parseGoogleFolwrOpen(snapshotHtmlNewToOld).turns; // new→old
    const domTurns = Parser.extractTurnsFromDocument(
      docFrom(docHtml([1, 2, 3, 4, 5].map(function (n) { return turnObj('t' + n); })))); // old→new

    // Живая последовательность: open уже выровнял базу по DOM, затем probe на повторной
    // странице (kind=cursor-repeat, +ходов=0) пересобирает merged из сырого ответа new→old.
    const h = loopCtx({
      parseWithParser: function () {
        return { turns: rawSnapshotTurns, messages: [], count: rawSnapshotTurns.length, text: '', threadId: TID };
      },
      describeFolwrPage: function () {
        return { cls: { kind: 'cursor-repeat', complete: true, canContinue: false }, line: 'kind=cursor-repeat +ходов=0' };
      },
      window: { fetch: makeFetch(['REPEAT'], FOLWR_URL) }
    });
    h.utils.__domTurns = domTurns;

    const ordered = Parser.orderTurnsByDom(rawSnapshotTurns, domTurns);
    expect(ordered.verdict).toBe('reversed');
    h.api.applyTurns(ordered.turns, TID, false, 'body', 'append');
    const expected = ['Вопрос t1', 'Вопрос t2', 'Вопрос t3', 'Вопрос t4', 'Вопрос t5'];
    expect(h.api.lastFullTurns.map(function (t) { return t.userText; })).toEqual(expected);

    h.api.probeFolwrCompleteness(FOLWR_URL, ordered.turns, TID, 'CURSOR-1', 0, domTurns);
    await settle(h);

    expect(h.api.lastFullTurns.map(function (t) { return t.userText; })).toEqual(expected);
    expect(h.api.lastFullMessages[0]).toEqual({ role: 'user', text: 'Вопрос t1' });
  });

  test('probe добавляет старшую страницу (added>0) → итог old→new по DOM', async () => {
    const olderPageOldToNew = [turnObj('t0a'), turnObj('t0b')];
    const domTurns = Parser.extractTurnsFromDocument(docFrom(docHtml([
      turnObj('t0a'), turnObj('t0b'), turnObj('t1'), turnObj('t2'), turnObj('t3')
    ])));
    const h = loopCtx({
      parseWithParser: function () {
        return { turns: olderPageOldToNew, messages: [], count: olderPageOldToNew.length, text: '', threadId: TID };
      },
      describeFolwrPage: function (resp, txt, added) {
        return { cls: { kind: 'new-turns', complete: true, canContinue: false }, line: 'kind=new-turns +ходов=' + added };
      },
      window: { fetch: makeFetch(['PAGE'], FOLWR_URL) }
    });

    const base = ['t1', 't2', 't3'].map(turnObj);
    h.api.applyTurns(base, TID, false, 'body', 'append');
    h.api.probeFolwrCompleteness(FOLWR_URL, base, TID, 'CURSOR-2', 0, domTurns);
    await settle(h);

    expect(h.api.lastFullTurns.map(function (t) { return t.userText; })).toEqual(
      ['Вопрос t0a', 'Вопрос t0b', 'Вопрос t1', 'Вопрос t2', 'Вопрос t3']);
    expect(h.api.lastFullTurns[0].assistantText).toBe('Ответ t0a');
  });

  // ---- 4.5 пин исходника probe-пути и диагностики O-43 ----
  test('пин probe: normalizeOrder и последняя база при addedTotal===0', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'google-search-intercept.js'), 'utf8');
    expect(src).toContain('function probeFolwrCompleteness(startUrl, startTurns, tid, firstCursor, gainedIn, domTurnsIn)');
    expect(src).toContain('probeFolwrCompleteness(url, mergedTurns, tid, folwrCursor, openGained, domTurns)');
    expect(src).toContain('function normalizeOrder(list)');
    expect(src).toContain('merged = normalizeOrder(merged);');
    expect(src).toContain('(addedTotal === 0) ? lastFullTurns : normalizeOrder(merged)');
    expect(src).toContain("applyTurns(finalTurns.length > 0 ? finalTurns : lastFullTurns, tid, true, lastBody, 'prepend')");
  });

  test('пин диагностики O-43: gsa-latch point=set/reset', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'export-manager.ts'), 'utf8');
    expect(src).toContain("aiCmDiagLine('gsa-latch', { point: 'set', cid: cid, key: site + '|' + cid })");
    expect(src).toContain("aiCmDiagLine('gsa-latch', { point: 'reset', tid: tid, prev: String(prev), cleared: cleared })");
    // чтение (Is) строку не печатает — спам-гард
    const isFn = src.slice(src.indexOf('function aiCmGsaNetworkCompleteIs('));
    expect(isFn.slice(0, isFn.indexOf('\n}'))).not.toContain('gsa-latch');
  });
});
