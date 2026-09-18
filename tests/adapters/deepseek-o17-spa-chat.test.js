/** @jest-environment node */
/**
 * O-17: DeepSeek — чат, созданный через SPA (без F5): полнота базы и turnsMap.
 *
 * Живой прогон (чистый чат, страница НЕ перезагружалась):
 *   17:39:50 conv-changed old=(none) new=020f8d7d… (SPA-смена чата)
 *   17:39:51 «история не пришла после смены чата → тихий дозапрос по таймеру»
 *   17:40:04 EMIT принят baseComplete=false baseCount=2   ← база БЕЗ «ПОЛНАЯ по сети»
 *   17:41:20 EMIT baseComplete=false baseCount=4 pct=6%   ← порог пройден, экспорт отложен
 *   17:41:04/17:42:20 deferred-timeout(60s) → as-is + [LOW CONFIDENCE]_ (файл неполный)
 *   после F5 тот же чат → «история ПОЛНАЯ по сети» и полный файл (эталон).
 *
 * Причины (обе — в core/deepseek-intercept.js, обе ветки работают через ingestHistory):
 *   1) полнота выносилась ТОЛЬКО по обходу цепочки (buildActiveChain → reachedRoot) и
 *      требовала НЕПУСТОЙ цепочки. В ветке тихого дозапроса после SPA-смены чата
 *      (scheduleHistoryRefetch → refetchFullHistory) единственный ответ — АВТОРИТЕТНО
 *      ПУСТАЯ база нового чата (is_empty=true, chat_messages=[]): ранний
 *      `if (!chain.length) return;` оставлял historyComplete=false НАВСЕГДА, realtime-эмиты
 *      наследовали false, гейт O-16 «defer до base-complete» разрешался только 60s-таймаутом.
 *   2) сброс turnsMap стоял ДО проверок снимка → пустой/MERGE/усечённый ответ СТИРАЛ уже
 *      собранные live-ходы, и следующая публикация базы была КОРОЧЕ (в живом логе запись
 *      истории msgs=1..2 при 4 ходах в чате) — авто- и ручной экспорт получали обрезок.
 *
 * Стенд: РЕАЛЬНЫЙ core/deepseek-intercept.js в jsdom (node-окружение + свой JSDOM, как в
 * tests/adapters/deepseek-o16-stream-export.test.js), сервер — подменённый window.fetch,
 * таймер дозапроса — управляемый (jest fake timers, подсаженные в окно стенда).
 * Инварианты: live-база == база после перезагрузки (состав ходов + БАЙТЫ тела файла),
 * ручной экспорт берёт базу того же момента, [LOW CONFIDENCE]_ на здоровом сценарии нет.
 * O-7 (OFF): секции [REASONING]…[ANSWER]… остаются в БАЗЕ (метрики/пороги не пересчитываются)
 * и урезаются единой точкой выхода экспорта до части [ANSWER].
 */

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const Builders = require('../../utils/export-text-builders.js');
const P = require('../../utils/export-emit-pipeline.js');
const buildReferenceText = require('../../utils/buildReferenceText.js');

const ROOT = path.join(__dirname, '..', '..');
const INTERCEPT_SRC = fs.readFileSync(path.join(ROOT, 'core', 'deepseek-intercept.js'), 'utf8');

jest.useFakeTimers();

// ======================= фикстура SPA-чата =======================

const CID = 'spaO17chat';
const HOME_URL = 'https://chat.deepseek.com/a/chat';                    // чата ещё нет (old=(none))
const CHAT_URL = 'https://chat.deepseek.com/a/chat/s/' + CID;           // чат создан SPA-переходом

const Q1 = 'Первый вопрос';
const R1 = 'Считаю варианты.';
const A1 = 'Первый ответ';
const Q2 = 'Второй вопрос';
const R2 = 'Проверяю вывод.';
const A2 = 'Второй ответ';

// Ходы сервера: тот же чат, что собран live (id берём те же, что в SSE ready).
function serverTurn(n) {
  return n === 1
    ? { uid: 'u1', aid: 'a1', q: Q1, r: R1, a: A1, parent: null, tokens: 900 }
    : { uid: 'u2', aid: 'a2', q: Q2, r: R2, a: A2, parent: 'a1', tokens: 2100 };
}
function fullBase(turns) {
  const msgs = [];
  const list = turns.map(serverTurn);
  list.forEach((t) => {
    msgs.push({
      message_id: t.uid, parent_id: t.parent, role: 'USER', thinking_enabled: true,
      accumulated_token_usage: Math.round(t.tokens / 3),
      fragments: [{ type: 'REQUEST', content: t.q }]
    });
    msgs.push({
      message_id: t.aid, parent_id: t.uid, role: 'ASSISTANT', thinking_enabled: true,
      accumulated_token_usage: t.tokens,
      fragments: [{ type: 'THINK', content: t.r }, { type: 'RESPONSE', content: t.a }]
    });
  });
  const last = list[list.length - 1];
  return {
    code: 0,
    data: {
      biz_data: {
        chat_session: { current_message_id: last ? last.aid : null, model_type: 'expert', is_empty: list.length === 0 },
        chat_messages: msgs
      }
    }
  };
}
// Авторитетно пустая база нового чата (то, что реально отдаёт сервер сразу после SPA-создания).
function emptyBase() {
  return {
    code: 0,
    data: {
      biz_data: {
        chat_session: { current_message_id: null, model_type: 'expert', is_empty: true },
        chat_messages: []
      }
    }
  };
}
// MERGE/cache-ответ: пустой chat_messages при is_empty!==true (кеш не отдал историю).
function mergeBase() {
  return {
    code: 0,
    data: {
      biz_data: {
        chat_session: { current_message_id: 'a1', model_type: 'expert', is_empty: false },
        chat_messages: []
      }
    }
  };
}

function sseTurn(n) {
  const t = serverTurn(n);
  return [
    'event: ready',
    'data: ' + JSON.stringify({ request_message_id: t.uid, response_message_id: t.aid, model_type: 'expert' }),
    '',
    'event: message',
    'data: ' + JSON.stringify({ v: { response: { accumulated_token_usage: Math.round(t.tokens / 3), model_type: 'expert', fragments: [{ type: 'THINK', content: t.r }] } } }),
    '',
    'data: ' + JSON.stringify({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: t.a }] }),
    '',
    'data: ' + JSON.stringify({ p: 'response', o: 'BATCH', v: [{ p: 'accumulated_token_usage', v: t.tokens }, { p: 'quasi_status', v: 'FINISHED' }] }),
    '',
    'event: close',
    'data: {}',
    ''
  ].join('\n');
}

function fakeResponse(jsonBody, textBody) {
  const clone = { json: () => Promise.resolve(jsonBody), text: () => Promise.resolve(textBody || '') };
  return { ok: true, status: 200, json: () => Promise.resolve(jsonBody), text: () => Promise.resolve(textBody || ''), clone: () => clone };
}
function historyUrl(convId, cached) {
  return 'https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=' + convId +
    (cached ? '&cache_version=v9&cache_reset_at=175' : '');
}
function flush(times) {
  let p = Promise.resolve();
  for (let i = 0; i < (times || 120); i++) p = p.then(() => { });
  return p;
}
// Прогон микрозадач: путь ответа истории и SSE в этом сценарии идёт по clone().text()/.json()
// (макротаски не нужны, а setImmediate у fake-таймеров не срабатывает без их прокрутки).
async function settle(times) {
  await flush(times || 150);
  await Promise.resolve();
  await flush(40);
}

// ======================= стенд: реальный перехватчик + сервер =======================

function makeStand(startUrl, opts) {
  const o = opts || {};
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: startUrl,
    runScripts: 'dangerously',
    virtualConsole: new VirtualConsole()
  });
  const { window } = dom;
  // таймер дозапроса после SPA-смены чата — управляемый (jest fake timers в окне стенда)
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  const events = [];
  const calls = [];
  // server.mode: 'merge' — кеш отдал пустой chat_messages при is_empty=false (MERGE);
  //              'empty' — сервер считает чат пустым (is_empty=true, chat_messages=[]);
  //              'full'  — полная история (столько ходов, сколько уже было в чате).
  const server = { turns: o.turns || 0, mode: o.mode || 'merge' };
  window.fetch = (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || '');
    calls.push(url);
    if (url.indexOf('completion') !== -1) {
      const prompt = (init && init.body) ? JSON.parse(init.body).prompt : '';
      const n = prompt === Q1 ? 1 : 2;
      return Promise.resolve(fakeResponse({}, sseTurn(n)));
    }
    if (url.indexOf('history_messages') !== -1) {
      const cached = url.indexOf('cache_version') !== -1;
      if (cached && server.mode === 'merge') return Promise.resolve(fakeResponse(mergeBase()));
      if (cached && server.mode === 'empty') return Promise.resolve(fakeResponse(emptyBase()));
      return Promise.resolve(fakeResponse(fullBase(server.turns ? [1, 2].slice(0, server.turns) : [])));
    }
    return Promise.resolve(fakeResponse({}, ''));
  };
  window.eval(INTERCEPT_SRC);
  window.addEventListener('ai-cm-full-history', (e) => events.push(e.detail));
  return {
    window, events, calls, server,
    last: () => events[events.length - 1],
    counts: () => events.map((d) => d.count),
    texts: () => ((events[events.length - 1] || {}).messageTexts) || [],
    msgs: () => (((events[events.length - 1] || {}).messages) || []).map((m, i) => ({ role: m.role, text: events[events.length - 1].messageTexts[i] })),
    // мост сводки turnsMap (aiCmDumpTurnsSnapshot в core/base-handler.js)
    turnsSnap: function () {
      let resp = null;
      const h = (ev) => { resp = ev.detail; };
      window.addEventListener('ai-cm-turns-snap-response', h, { once: true });
      window.dispatchEvent(new window.CustomEvent('ai-cm-turns-snap-request'));
      window.removeEventListener('ai-cm-turns-snap-response', h);
      return resp;
    },
    completion: (n) => window.fetch('https://chat.deepseek.com/api/v1/chat/completion?x=' + n, {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
      body: JSON.stringify({ prompt: n === 1 ? Q1 : Q2, chat_session_id: CID, thinking_enabled: true, parent_message_id: n === 1 ? null : 'a1' })
    }),
    history: (cached) => window.fetch(historyUrl(CID, cached), { headers: { Authorization: 'Bearer t' } }),
    spa: () => window.history.pushState({}, '', '/a/chat/s/' + CID),
    close: () => { try { window.close(); } catch (e) { } }
  };
}

// Прогон «SPA-чат без перезагрузки»: пустая база дозапроса → live-ходы → MERGE-полл кеша.
async function runSpaScenario() {
  const stand = makeStand(HOME_URL);
  // авторизованный запрос страницы ДО смены чата (иначе таймер-дозапрос молчит — как в проде)
  await stand.window.fetch('https://chat.deepseek.com/api/v0/chat_session/fetch_page', {
    method: 'POST', headers: { Authorization: 'Bearer t' }, body: '{}'
  });
  await settle();

  stand.spa();                                   // ← SPA-создание чата (без F5)
  await settle();
  const historyCalls = () => stand.calls.filter((u) => u.indexOf('history_messages') !== -1);
  expect(historyCalls().length).toBe(0);         // сайт историю нового чата НЕ запрашивал

  jest.advanceTimersByTime(1000);                // таймер 1s → тихий дозапрос полной истории
  await settle();
  const emptyBaseEmitCount = stand.events.length;
  const afterTimerHistory = historyCalls();
  const snapAfterTimer = stand.turnsSnap();

  stand.server.turns = 1;
  await stand.completion(1);                     // первый обмен (live)
  await settle();
  const afterTurn1 = stand.last();
  const snapAfterTurn1 = stand.turnsSnap();

  stand.server.mode = 'merge';
  await stand.history(true);                     // полл кеша: MERGE-пусто → автодозапрос полной истории
  await settle();
  const afterMerge = stand.last();
  const afterMergeHistory = historyCalls();

  // Полл кеша, когда сервер ещё считает чат пустым (is_empty=true): ответ НЕ авторитетен
  // для состава (live-ходы уже собраны) — база и turnsMap обязаны выжить.
  stand.server.mode = 'empty';
  await stand.history(true);
  await settle();
  const afterEmptyPoll = stand.last();
  const snapAfterEmptyPoll = stand.turnsSnap();
  const snapAtManual = stand.turnsSnap();        // дамп ручного экспорта (snapshot-at-manual)

  stand.server.turns = 2;
  await stand.completion(2);                     // второй обмен (live)
  await settle();
  const live = stand.last();

  return {
    stand, emptyBaseEmitCount, afterTimerHistory, afterMergeHistory,
    afterTurn1, afterMerge, afterEmptyPoll, live,
    snapAfterTimer, snapAfterTurn1, snapAfterEmptyPoll, snapAtManual
  };
}

// Эталон «после F5»: страница сама запрашивает историю, ответ — полная цепочка.
async function runReloadScenario() {
  const stand = makeStand(CHAT_URL);
  stand.server.turns = 2;
  await stand.history(true);
  await settle();
  return { stand, d: stand.last() };
}

function bodyTxt(msgs) { return buildReferenceText(msgs); }
function bodyMd(msgs, tokens) {
  return Builders.buildMdFromHistory({ site: 'deepseek', model: 'DeepSeek-R1', tokens: tokens, limit: 131072, percent: 0.7, messages: msgs }, 'deepseek');
}
function buildName(hist, ext) {
  const lowConfPrefix = (hist && hist.isLowConfidenceBase === true) ? '[LOW CONFIDENCE]_' : '';
  return lowConfPrefix + P.buildExportFileName(hist.site || 'deepseek', hist.convId || '', 'threshold', false, ext);
}

// ======================= сценарий =======================

describe('O-17: DeepSeek — SPA-чат без перезагрузки', () => {
  let spa = null;
  let reload = null;
  beforeAll(async () => {
    spa = await runSpaScenario();
    reload = await runReloadScenario();
  });
  afterAll(() => {
    if (spa) spa.stand.close();
    if (reload) reload.stand.close();
  });

  test('ветка тихого дозапроса: пустая база нового чата признана ПОЛНОЙ (baseComplete=1)', () => {
    const calls = spa.afterTimerHistory;
    expect(calls.length).toBe(1);                                  // ровно один — таймер-дозапрос
    expect(calls[0]).toContain('history_messages');
    expect(calls[0]).toContain('chat_session_id=' + CID);          // канонический URL ТЕКУЩЕГО чата
    expect(calls[0]).not.toContain('cache_version');               // дозапрос без cache-параметров
    expect(spa.emptyBaseEmitCount).toBe(0);                        // пустую базу content.js игнорирует (!detail.text)
    const snap = spa.snapAfterTimer;                               // мост сводки turnsMap
    expect(snap.convId).toBe(CID);
    expect(snap.msgs).toBe(0);
    expect(snap.baseComplete).toBe(true);                          // ← вердикт полноты вынесен
  });

  test('первый live-ход наследует полноту: historyComplete=true (а не «навсегда false»)', () => {
    const d = spa.afterTurn1;
    expect(d.convId).toBe(CID);
    expect(d.count).toBe(2);
    expect(d.historyComplete).toBe(true);      // было false → defer до 60s и [LOW CONFIDENCE]_
    // полнота вынесена по авторитетно пустой базе (0 ходов), а не обходом цепочки:
    // reachedRoot не доказывался, baseEmpty=true — вердикт наследуется live-эмитами
    expect(d.reachedRoot).toBe(false);
    expect(d.baseEmpty).toBe(true);
    expect(d.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(d.messageTexts[0]).toBe(Q1);
    expect(d.messageTexts[1]).toBe('[REASONING]\n' + R1 + '\n\n[ANSWER]\n' + A1);
    // 2) turnsMap ПОПОЛНЯЕТСЯ live-ходами: дамп ручного экспорта видит реальные ходы
    //    (в живом прогоне тут было msgs=0 firstText="" — мост сводки отсутствовал)
    expect(spa.snapAfterTurn1 && spa.snapAfterTurn1.msgs).toBe(2);
    expect(spa.snapAfterTurn1.firstText).toBe(Q1);
    expect(spa.snapAtManual && spa.snapAtManual.msgs).toBe(2);
    expect(spa.snapAtManual.baseComplete).toBe(true);
    expect(spa.snapAtManual.firstText).toBe(Q1);
  });

  test('MERGE-ответ полла кеша не стирает live-базу: автодозапрос полной истории, состав не схлопнулся', () => {
    const d = spa.afterMerge;
    expect(spa.afterMergeHistory.length).toBe(3);              // полл кеша + автодозапрос + таймер
    expect(d.count).toBe(2);                                   // база не схлопнулась и не обнулилась
    expect(d.historyComplete).toBe(true);                      // цепочка дошла до корня
    expect(d.baseEmpty).toBe(false);
    expect(d.messageTexts[0]).toBe(Q1);
    expect(d.messageTexts[1]).toBe('[REASONING]\n' + R1 + '\n\n[ANSWER]\n' + A1);
  });

  test('пустой ответ полла (is_empty=true) НЕ стирает turnsMap: следующий live-ход не теряет первый обмен', () => {
    // pre-fix: `turnsMap = {}` стоял ДО проверок снимка → пустой ответ обнулял базу,
    // и следующий realtime-финал публиковал СХЛОПНУВШИЙСЯ состав (живой лог: msgs=1..2 при 4 ходах)
    expect(spa.snapAfterEmptyPoll && spa.snapAfterEmptyPoll.msgs).toBe(2);
    expect(spa.snapAfterEmptyPoll.firstText).toBe(Q1);
    expect(spa.afterEmptyPoll.count).toBe(2);                  // база не усохла
    const counts = spa.stand.counts();
    expect(counts[0]).toBe(2);
    expect(counts[counts.length - 1]).toBe(4);                 // 4 хода, а не «хвост» из 2
    expect(counts).toEqual(counts.slice().sort((a, b) => a - b)); // ни одного усохшего снимка
    expect(spa.live.messageTexts[0]).toBe(Q1);                 // первый обмен на месте
    expect(spa.live.messageTexts[2]).toBe(Q2);
  });

  test('диагностика экспорта: snapshot-at-manual видит РЕАЛЬНЫЕ ходы (msgs=N, а не 0)', () => {
    // живой лог O-17: «snapshot-at-manual msgs=0 firstText=""» читался как пустой turnsMap,
    // хотя база была собрана — DeepSeek не отвечал на мост сводки (мост был Gemini-only),
    // а фолбэк дампа подставляет msgs только когда передан массив (ручной путь передаёт null).
    const Api = require('../../core/base-handler.js');
    const lines = [];
    const prev = {
      window: global.window, debugLog: global.debugLog,
      baseComplete: global.baseComplete, conf: global.aiCmBaseConfirmedByConv,
      adapter: global.currentAdapter, getCurrentConvId: global.getCurrentConvId,
      CustomEvent: global.CustomEvent
    };
    // base-handler (ISOLATED-мир) в проде делит window/CustomEvent со страницей — в стенде
    // подставляем окно jsdom, иначе мост не находит слушателя перехватчика.
    global.window = spa.stand.window;
    global.CustomEvent = spa.stand.window.CustomEvent;
    global.debugLog = (lvl, msg) => lines.push(String(msg));
    global.baseComplete = spa.live.historyComplete === true;
    global.aiCmBaseConfirmedByConv = {};
    global.currentAdapter = { siteName: 'deepseek' };
    global.getCurrentConvId = () => CID;
    try {
      Api.aiCmDumpTurnsSnapshot('snapshot-at-manual', CID, null);
    } finally {
      global.window = prev.window; global.debugLog = prev.debugLog;
      global.baseComplete = prev.baseComplete; global.aiCmBaseConfirmedByConv = prev.conf;
      global.currentAdapter = prev.adapter; global.getCurrentConvId = prev.getCurrentConvId;
      global.CustomEvent = prev.CustomEvent;
    }
    const line = lines.join('\n');
    expect(line).toContain('[AI CM][turnsMap] snapshot-at-manual convId=' + CID);
    expect(line).toContain('msgs=4');
    expect(line).toContain('firstText="' + Q1 + '"');
    expect(line).toContain('lastText="[REASONING] ' + R2 + ' [ANSWER] ' + A2 + '"');
    expect(line).toContain('baseComplete=1');
  });

  test('ИНВАРИАНТ: live-база == база после перезагрузки (состав ходов + БАЙТЫ тела файла)', () => {
    const liveMsgs = spa.stand.msgs();
    const reloadMsgs = reload.stand.msgs();
    expect(liveMsgs).toEqual(reloadMsgs);
    expect(liveMsgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(liveMsgs.map((m) => m.text)).toEqual([
      Q1, '[REASONING]\n' + R1 + '\n\n[ANSWER]\n' + A1,
      Q2, '[REASONING]\n' + R2 + '\n\n[ANSWER]\n' + A2
    ]);
    // байты тела файла: те же сборщики, что у автоэкспорта/ручных кнопок
    expect(bodyTxt(liveMsgs)).toBe(bodyTxt(reloadMsgs));
    expect(bodyMd(liveMsgs, 2100)).toBe(bodyMd(reloadMsgs, 2100));
    expect(reload.stand.last().historyComplete).toBe(true);    // эталон после F5 — «ПОЛНАЯ по сети»
  });

  test('ручной экспорт в любой момент == база того же момента; [LOW CONFIDENCE]_ нет', () => {    // ручной путь content.js: aiCmFlushLiveStreamForExport (стрима нет) + buildHistoryMessages()
    const live = spa.live;
    const manualMsgs = ((live.messages) || []).map((m, i) => ({ role: m.role, text: live.messageTexts[i] }));
    expect(manualMsgs).toEqual(spa.stand.msgs());               // источник — база ТОГО ЖЕ момента
    expect(bodyTxt(manualMsgs)).toBe(bodyTxt(reload.stand.msgs()));

    // O-7 (OFF): БАЗА несёт секции [REASONING]/[ANSWER] (метрики/пороги не пересчитываются),
    // а единая точка выхода экспорта оставляет от хода ассистента только часть [ANSWER] —
    // именно её и собирает ручной файл (buildHistoryMessages → aiCmCollectExportSource).
    expect(manualMsgs[1].text).toBe('[REASONING]\n' + R1 + '\n\n[ANSWER]\n' + A1);
    const exportMsgs = P.sanitizeEmitMessages(manualMsgs).messages;
    expect(exportMsgs.map((m) => m.text)).toEqual([Q1, A1, Q2, A2]);

    // v1.14.1: isLowConfidenceBase — живой флаг (baseComplete !== true), префикс даёт options.js
    const baseComplete = live.historyComplete === true;         // маппинг content.js: newBaseComplete
    const histSnapshot = { site: 'deepseek', convId: CID, isLowConfidenceBase: (baseComplete !== true) };
    expect(baseComplete).toBe(true);
    expect(histSnapshot.isLowConfidenceBase).toBe(false);
    expect(buildName(histSnapshot, 'txt')).not.toMatch(/^\[LOW CONFIDENCE\]_/);
    // аварийный путь (реально неполная база) префикс по-прежнему даёт — гейт O-16 жив
    expect(buildName({ site: 'deepseek', convId: CID, isLowConfidenceBase: (false !== true) }, 'txt'))
      .toMatch(/^\[LOW CONFIDENCE\]_/);
  });
});

// ======================= «НЕ трогать» + source-пины =======================

describe('O-17: поведение O-15/O-16 сохранено, прочие сервисы не затронуты', () => {
  test('defer до base-complete остаётся; as-is — только аварийный 60s-таймаут', () => {
    const contentSrc = require('../helpers/content-source.js').contentSource;
    const exportSrc = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');
    expect(contentSrc).toContain('if (baseComplete !== true) return;');                  // late re-check
    expect(exportSrc).toContain('if (baseComplete !== true) return;');                   // aiCmTryLateAutoExport
    expect(exportSrc).toContain("if (reason !== 'timeout' && !(baseComplete === true && !aiCmLoaderRunningByConv[p.convId])) return;");
    expect(exportSrc).toContain('deferred-timeout(60s), exporting as-is');               // единственный as-is
    expect(exportSrc).toContain('isLowConfidenceBase: (baseComplete !== true)');
  });

  test('формат [REASONING]/[ANSWER] и парность ходов не тронуты (O-15/O-16 живы)', () => {
    expect(INTERCEPT_SRC).toContain("var REASONING_TAG = '[REASONING]';");
    expect(INTERCEPT_SRC).toContain("var ANSWER_TAG = '[ANSWER]';");
    expect(INTERCEPT_SRC).toContain('return REASONING_TAG + \'\\n\' + reasoning + \'\\n\\n\' + ANSWER_TAG + \'\\n\' + answer;');
    expect(INTERCEPT_SRC).toContain('} else if (turnsMap[assistantId]) {');              // O-16: обогащение хода
    expect(INTERCEPT_SRC).toContain('ai-cm-deepseek-stream-probe');                      // O-16: мост стрима
  });

  test('source-пины O-17: единый критерий полноты, сброс только принятым снимком, канонический URL, мост turnsMap', () => {
    const ingest = INTERCEPT_SRC.slice(INTERCEPT_SRC.indexOf('function ingestHistory(jsonBody)'));
    // 1) пустая авторитетная база = полная база (обе ветки — один код ingestHistory)
    expect(ingest).toContain('var baseEmptyAuthoritative = (chatMessages.length === 0) &&');
    expect(ingest).toContain('(chatSession.is_empty === true || chatSession.current_message_id == null);');
    expect(ingest).toContain('histCompletion.historyComplete = true;');
    expect(INTERCEPT_SRC).toContain('histCompletion.baseEmpty = true;');
    // 2) turnsMap сбрасывается ТОЛЬКО принятым снимком (после проверок MERGE/пустоты/усечения)
    const iReset = ingest.indexOf('turnsMap = {};');
    const iMerge = ingest.indexOf('пустой кеш (MERGE)');
    const iTrunc = ingest.indexOf('if (truncated && !historyRefetchDone)');
    expect(iReset).toBeGreaterThan(iMerge);
    expect(iReset).toBeGreaterThan(iTrunc);
    // 3) дозапрос не уходит по URL предыдущего чата
    expect(INTERCEPT_SRC).toContain('function historyUrlForConv(url, convId) {');
    expect(INTERCEPT_SRC).toContain('var cleanUrl = historyUrlForConv(originalUrl, convId) || historyRefetchUrl();');
    expect(INTERCEPT_SRC).toContain('refetchFullHistory(historyRefetchUrl(), lastAuthHeaders, currentConvId);');
    // 4) мост сводки turnsMap (диагностика snapshot-at-manual msgs=N)
    expect(INTERCEPT_SRC).toContain("window.addEventListener('ai-cm-turns-snap-request'");
    expect(INTERCEPT_SRC).toContain("new CustomEvent('ai-cm-turns-snap-response', { detail: turnsSnapshot() })");
    // 5) вердикт полноты едет в detail (наследуется realtime-эмитами)
    expect(INTERCEPT_SRC).toContain('historyComplete: histCompletion.historyComplete,');
    expect(INTERCEPT_SRC).toContain('baseEmpty: histCompletion.baseEmpty === true,');
  });

  test('прочие сервисы не тронуты: правки O-17 только в deepseek-intercept.js', () => {
    // content.js/export-manager.js/adapters не содержат O-17-специфичных веток
    const contentSrc = require('../helpers/content-source.js').contentSource;
    expect(contentSrc).not.toContain('baseEmptyAuthoritative');
    expect(contentSrc).not.toContain('turnsSnapshot');
    expect(fs.readFileSync(path.join(ROOT, 'adapters', 'deepseek-adapter.js'), 'utf8')).not.toContain('baseEmptyAuthoritative');
    expect(fs.readFileSync(path.join(ROOT, 'adapters', 'gemini-adapter.js'), 'utf8')).not.toContain('historyUrlForConv');
  });
});
