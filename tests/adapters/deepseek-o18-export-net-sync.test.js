/** @jest-environment node */
/**
 * O-18 (фаза 2): сетевой дозапрос истории в момент экспорта (DeepSeek).
 *
 * ИЗМЕРЕНО (дамп прогона 19-12): оба экспортных снимка имели netTurns=0, netSnapshot=null,
 * historyRefetchDone=false, baseEmpty=true → сетевая история в момент экспорта не
 * запрашивалась вовсе, файл собирался только из live-памяти (и потому нёс повреждённый
 * парсером текст). Правило фазы 2: ПЕРЕД композицией файла (авто и ручной экспорт) история
 * текущего чата запрашивается по сети, если снимок сети пуст или старше последнего
 * завершённого хода; таймаут 3 с; при неудаче/пустой сети — прежний live-путь.
 *
 * Стенд: РЕАЛЬНЫЙ core/deepseek-intercept.js (MAIN) + РЕАЛЬНЫЙ core/base-handler.js
 * (ISOLATED-мост aiCmExportNetSyncThen) в одном jsdom-окне + РЕАЛЬНЫЙ doAutoExportDownload
 * из core/export-manager.js в срез-песочнице (как tests/adapters/deepseek-o16-stream-export).
 *
 * Проверки:
 *  1) netSnapshot=null + live-ход → дозапрос выполнен, ФАЙЛ ИЗ СЕТИ (полный текст);
 *  2) per-turn выбор: live — префикс сети (TAIL-CUT) → в файл идёт СЕТЕВОЙ текст;
 *  3) сеть недоступна (reject) → файл из live + маркер, поведение прежнее;
 *  4) таймаут дозапроса → файл из live, ответ моста с reason=timeout;
 *  5) пустая сеть (авторитетно пустой SPA-чат — ровно прогон 19-12) → live + маркер ONE-SIDE;
 *  6) свежий снимок сети покрывает live-ходы → дозапроса НЕТ (fast-path reason=fresh);
 *  7) ONE-SIDE по ходу: хода нет в сети → live-текст сохраняется, сетевые ходы на месте;
 *  8) source-пины проводки (авто и ручной экспорт).
 */

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const P = require('../../utils/export-emit-pipeline.js');
const Builders = require('../../utils/export-text-builders.js');
const CONTENT = require('../helpers/content-source.js').contentSource;

const ROOT = path.join(__dirname, '..', '..');
const INTERCEPT_SRC = fs.readFileSync(path.join(ROOT, 'core', 'deepseek-intercept.js'), 'utf8');
const BASE_HANDLER_SRC = fs.readFileSync(path.join(ROOT, 'core', 'base-handler.js'), 'utf8');
const EXPORT_MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');
// Фикстура: сырьё прогона 19-12 (tools/fixtures, gitignored) либо синтезированный эквивалент.
const O18 = require('../helpers/o18-fixture.js');
const FIX = O18.scenarios;

const CID = FIX.source.conv.slice(0, 8);
const PROMPT = FIX.liveTurn.prompt;
const LIVE_ANSWER = FIX.liveTurn.answer;            // обрыв на «…DEFAULT_SU» (live-путь)
const FULL_ANSWER = FIX.netHistoryFull.data.biz_data.chat_messages[1].fragments[1].content;
const NET_TAIL = FULL_ANSWER.slice(LIVE_ANSWER.length);   // хвост, которого live не видел
const THINK = FIX.liveTurn.think;
// Тело файла собирает РЕАЛЬНЫЙ сборщик (utils/buildReferenceText.js) — он чистит разметку
// построчно, поэтому на уровне ФАЙЛА проверяем устойчивые фразы, а байтовые пины — на EMIT.
const NET_ONLY_PHRASE = 'примените описанные паттерны.';  // конец хвоста кольца (live его не видел)
const NET_ONLY_PHRASE2 = 'если worker неактивен';
const LIVE_SEAM = 'DEFAULT_SU';
const waitFor = async (fn, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 4000)) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
};

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

function line(obj) { return 'data: ' + JSON.stringify(obj) + '\n'; }
function ev(name) { return 'event: ' + name + '\n'; }
const BLANK = '\n';

function makeChunkedResponse() {
  const enc = new TextEncoder();
  let ctrl = null;
  const stream = new ReadableStream({ start(c) { ctrl = c; } });
  return {
    resp: { ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve(''), clone: () => ({ body: stream, text: () => Promise.resolve('') }) },
    push: (s) => ctrl.enqueue(enc.encode(s)),
    end: () => ctrl.close()
  };
}
const flush = (n) => { let p = Promise.resolve(); for (let i = 0; i < (n || 120); i++) p = p.then(() => { }); return p; };
async function settle(n) {
  await new Promise((r) => setImmediate(r));
  await flush(n || 200);
  await new Promise((r) => setImmediate(r));
  await flush(60);
}

// ===================== стенд: MAIN-перехватчик + ISOLATED-мост =====================
function makeStand(over) {
  const o = over || {};
  const vc = new VirtualConsole();
  const logs = [];
  ['log', 'warn', 'error'].forEach((k) => vc.on(k, (...a) => logs.push(a.map(String).join(' '))));
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://chat.deepseek.com/a/chat/s/' + CID, runScripts: 'dangerously', virtualConsole: vc
  });
  const { window } = dom;
  window.TextDecoder = TextDecoder;
  window.sessionStorage.setItem('aiCmDebug', '1');
  window.currentAdapter = { siteName: 'deepseek' };
  window.debugLog = (lvl, msg) => { logs.push(String(msg)); };
  const streams = [];
  const netCalls = [];
  let netPlan = o.netPlan || (() => FIX.netHistoryFull);
  window.fetch = (input) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || '');
    if (url.indexOf('completion') !== -1) {
      const c = makeChunkedResponse();
      streams.push(c);
      return Promise.resolve(c.resp);
    }
    if (url.indexOf('history_messages') !== -1) {
      netCalls.push({ url: url, t: Date.now() });
      const plan = netPlan(netCalls.length, url);
      if (plan && plan.reject) return Promise.reject(new Error('network down'));
      if (plan && plan.pending) return new Promise(() => { });     // зависший запрос (таймаут)
      const jsonBody = (plan && plan.json !== undefined) ? plan.json : (plan || FIX.netHistoryFull);
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve(jsonBody),
        text: () => Promise.resolve(''),
        clone: () => ({ json: () => Promise.resolve(jsonBody), text: () => Promise.resolve('') })
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(null), text: () => Promise.resolve(''), clone: () => ({ json: () => Promise.resolve(null), text: () => Promise.resolve('') }) });
  };
  window.eval(INTERCEPT_SRC);
  window.eval(BASE_HANDLER_SRC);
  const emits = [];
  window.addEventListener('ai-cm-full-history', (e) => emits.push(e.detail));
  return {
    window, dom, logs, streams, emits, netCalls,
    last: () => emits[emits.length - 1] || {},
    texts: () => ((emits[emits.length - 1] || {}).messageTexts) || [],
    netSync: (convId, cb, cap) => window.AiCmBaseHandler.aiCmExportNetSyncThen(convId || CID, cb, cap),
    setNetPlan: (fn) => { netPlan = fn; }
  };
}

async function sendCompletion(stand) {
  await stand.window.fetch('https://chat.deepseek.com/api/v1/chat/completion?x=1', {
    method: 'POST', body: JSON.stringify({ prompt: PROMPT, chat_session_id: CID, thinking_enabled: true })
  });
}
// Живой ход: THINK + ЧАСТЬ ответа (столько, сколько успел увидеть SSE-путь до обрыва/десинхрона).
async function runLiveTurn(stand, answer) {
  await sendCompletion(stand);
  const st = stand.streams[stand.streams.length - 1];
  st.push(ev('ready') + line({ request_message_id: '3', response_message_id: '4', model_type: 'expert' }) + BLANK);
  st.push(ev('message') + line({ v: { response: { accumulated_token_usage: 1000, model_type: 'expert', fragments: [{ type: 'THINK', content: THINK }] } } }) + BLANK);
  st.push(line({ p: 'response/fragments', o: 'APPEND', v: ['RESPONSE'] }) + BLANK);
  const part = answer || LIVE_ANSWER;
  for (let i = 0; i < part.length; i += 40) {
    st.push(line({ p: 'response/fragments', o: 'APPEND', v: part.slice(i, i + 40) }) + BLANK);
  }
  st.push(line({ p: 'response', o: 'BATCH', v: [{ p: 'accumulated_token_usage', v: 9000 }, { p: 'quasi_status', v: 'FINISHED' }] }) + BLANK);
  st.push(ev('close') + line({}) + BLANK);
  await settle();
  st.end();
  await settle();
}

// ===================== песочница РЕАЛЬНОГО автоэкспорта =====================
function makeExportSandbox(stand, over) {
  const logs = [];
  const downloads = [];
  const timers = [];
  const w = stand.window;
  const buildHistoryMessages = function () {
    const d = stand.last() || {};
    return ((d.messages) || []).map((m, i) => ({ role: m.role, text: d.messageTexts[i] }));
  };
  const B = Object.assign({}, Builders, {
    downloadBlob: function (content, file, mime) { downloads.push({ file: file, mime: mime, content: content }); }
  });
  w.AiCmExportEmitPipeline = P;
  w.AiCmExportBuilders = B;
  const SCOPE = 'with (ctx) { ' +
    fnDecl(EXPORT_MGR_SRC, 'aiCmDeepseekStreamProbe') + '\n' +
    fnDecl(EXPORT_MGR_SRC, 'aiCmDeepseekStreamActiveFor') + '\n' +
    fnDecl(EXPORT_MGR_SRC, 'aiCmFlushLiveStreamForExport') + '\n' +
    fnDecl(EXPORT_MGR_SRC, 'aiCmDeferAutoExportOnLiveStream') + '\n' +
    fnDecl(EXPORT_MGR_SRC, 'aiCmAutoExportConvId') + '\n' +
    fnDecl(EXPORT_MGR_SRC, 'maybeAutoExport') + '\n' +
    fnDecl(EXPORT_MGR_SRC, 'aiCmAutoExportStartDownload') + '\n' +
    fnDecl(EXPORT_MGR_SRC, 'doAutoExportDownload') + '\n' +
    ' return { run: maybeAutoExport, download: doAutoExportDownload }; }';
  const ctx = {
    window: w, CustomEvent: w.CustomEvent,
    AI_CM_DS_STREAM_DEFER_MS: 800, AI_CM_DS_STREAM_DEFER_MAX: 150,
    aiCmDsStreamDeferByConv: {}, aiCmDsStreamDeferLogged: {}, aiCmDsStreamFlushLogged: {},
    setTimeout: function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; },
    autoExportSettings: { enabled: true, pct: 90, fmt: 'txt' },
    autoExportLastConvId: '', autoExportPctBySite: {}, autoExportFired: {}, autoExportLastPct: -1,
    notCompleteLogged: {}, sessionFiredCache: {}, aiCmLoaderRunningByConv: {}, aiCmCursorLiveByConv: {},
    aiCmArchiveCountFor: function () { return 0; }, aiCmLowConfidenceByConv: {},
    baseSeen: true, baseComplete: true, baseCount: 2, lastBaseTexts: ['q', 'a'], lastThreadId: '',
    lastEmitConvId: CID, lastResolvedModelId: 'deepseek-r1', lastSnapshotModelName: 'DeepSeek-R1',
    maxTokenCount: 9000, currentAdapter: { siteName: 'deepseek' },
    getCurrentConvId: function () { return CID; },
    buildHistoryMessages: buildHistoryMessages,
    aiCmExportBaseSource: function () { return null; },
    aiCmDumpTurnsSnapshot: function () { },
    aiCmCancelDeferredHistWrite: function () { },
    // O-18 (фаза 2): РЕАЛЬНЫЙ ISOLATED-мост из core/base-handler.js (тот же jsdom-мир)
    aiCmExportNetSyncThen: w.AiCmBaseHandler.aiCmExportNetSyncThen,
    aiCmExportNetSyncSite: w.AiCmBaseHandler.aiCmExportNetSyncSite,
    aiCmNetSyncInFlight: {},
    ModelConfig: { getModel: function () { return { name: 'DeepSeek-R1' }; } },
    debugLog: function (lvl, msg) { logs.push(String(msg)); },
    chrome: { storage: { session: { remove: function () { }, set: function () { } }, local: { get: function () { } } } }
  };
  Object.assign(ctx, over || {});
  const api = new Function('ctx', SCOPE)(ctx);
  return {
    ctx: ctx, logs: logs, downloads: downloads, timers: timers,
    run: api.run, download: api.download,
    body: () => (downloads.length ? downloads[downloads.length - 1].content : ''),
    file: () => (downloads.length ? downloads[downloads.length - 1].file : '')
  };
}

// ===================== сценарии =====================
describe('O-18: экспортный сетевой дозапрос истории (DeepSeek)', () => {
  test('netSnapshot=null + live-ход → дозапрос выполнен, ФАЙЛ ИЗ СЕТИ (полный текст)', async () => {
    const stand = makeStand();
    // Ровно прогон 19-12: страница прислала авторитетно пустую историю нового чата
    // (netSnapshot=null по ходам), а к моменту экспорта история в сети уже есть.
    stand.setNetPlan(() => ({ json: FIX.netHistoryEmpty }));
    await stand.window.fetch('https://chat.deepseek.com/api/v1/chat/history_messages?chat_session_id=' + CID, { method: 'GET' });
    await settle();
    stand.setNetPlan(() => ({ json: FIX.netHistoryFull }));
    await runLiveTurn(stand);
    expect(stand.last().messageTexts[1]).toContain(LIVE_ANSWER);      // live-база — обрыв
    expect(stand.last().messageTexts[1]).not.toContain(NET_TAIL);

    const sb = makeExportSandbox(stand);
    const info = await new Promise((res) => sb.ctx.aiCmExportNetSyncThen(CID, res));
    expect(info.ok).toBe(true);
    expect(info.refetched).toBe(true);
    expect(info.netTurns).toBeGreaterThan(0);
    // EMIT после дозапроса несёт ПОЛНЫЙ сетевой текст хода (байт-в-байт).
    expect(stand.last().messageTexts[1]).toContain(FULL_ANSWER);
    // Файл собирается из базы ПОСЛЕ дозапроса — в нём текст, которого live не видел.
    sb.run(95);
    await settle();
    const body = sb.body();
    expect(body).toContain(NET_ONLY_PHRASE);
    expect(body).toContain(NET_ONLY_PHRASE2);
    expect(body).toContain('[REASONING]');
    expect(body).toContain('[ANSWER]');
    expect(stand.logs.join('\n')).toContain('[AI CM][net-sync] convId=' + CID + ' ok=1 reason=merged refetched=1');
    stand.dom.window.close();
  });

  test('per-turn выбор: live — префикс сети (TAIL-CUT) → в файл идёт СЕТЕВОЙ текст', async () => {
    const stand = makeStand();
    await runLiveTurn(stand);
    // ДО дозапроса база — live-версия хода (обрыв на «…DEFAULT_SU»).
    const liveText = stand.last().messageTexts[1];
    expect(liveText).toContain(LIVE_SEAM);
    expect(liveText).not.toContain(NET_ONLY_PHRASE);

    const sb = makeExportSandbox(stand);
    const info = await new Promise((res) => sb.ctx.aiCmExportNetSyncThen(CID, res));
    expect(info.ok).toBe(true);
    expect(info.verdicts['TAIL-CUT']).toBeGreaterThan(0);
    expect(stand.logs.join('\n')).toContain('сетевой текст полнее live (TAIL-CUT');
    // EMIT после дозапроса — полный сетевой текст (live был его префиксом, TAIL-CUT).
    const netText = stand.last().messageTexts[1];
    expect(netText.length).toBeGreaterThan(liveText.length);
    expect(netText).toContain(FULL_ANSWER);
    sb.run(95);
    await settle();
    const body = sb.body();
    expect(body).toContain(NET_ONLY_PHRASE);                 // в файл идёт СЕТЕВОЙ (полный) текст
    expect(body.length).toBeGreaterThan(liveText.length);
    stand.dom.window.close();
  });

  test('сеть недоступна (reject) → файл из live + маркер, поведение прежнее', async () => {
    const stand = makeStand();
    await runLiveTurn(stand);
    stand.setNetPlan(() => ({ reject: true }));
    const sb = makeExportSandbox(stand);
    const info = await new Promise((res) => sb.ctx.aiCmExportNetSyncThen(CID, res));
    expect(info.ok).toBe(false);
    expect(info.reason).toBe('error');
    expect(stand.logs.join('\n')).toContain('сетевой дозапрос не удался → прежний live-путь');
    sb.run(95);
    await settle();
    const body = sb.body();
    expect(body).toContain(LIVE_SEAM);              // прежний live-путь: текст как был
    expect(body).toContain('[ANSWER]');
    expect(sb.downloads.length).toBe(1);            // файл ровно один, латч выставлен
    expect(P.getAutoExportFired(sb.ctx.autoExportFired, 'deepseek', CID)).toBe(true);
    expect(stand.logs.join('\n')).toContain('ok=0 reason=error');
    stand.dom.window.close();
  });

  test('таймаут дозапроса: файл НЕ пишется до конца ожидания, затем — из live (reason=timeout)', async () => {
    const stand = makeStand();
    await runLiveTurn(stand);
    stand.setNetPlan(() => ({ pending: true }));    // запрос никогда не отвечает
    const sb = makeExportSandbox(stand);
    const t0 = Date.now();
    const info = await new Promise((res) => sb.ctx.aiCmExportNetSyncThen(CID, res, 150));
    expect(info.ok).toBe(false);
    expect(info.reason).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(2000);
    // Автоэкспорт: дозапрос идёт ПЕРЕД композицией файла — файла ещё нет.
    sb.run(95);
    await settle();
    expect(sb.downloads.length).toBe(0);
    // Ждём штатный таймаут экспортного дозапроса (3 с) — затем файл из live-базы.
    const wrote = await waitFor(() => sb.downloads.length > 0, 5000);
    expect(wrote).toBe(true);
    expect(sb.body()).toContain(LIVE_SEAM);
    expect(sb.downloads.length).toBe(1);
    expect(stand.logs.join('\n')).toContain('ok=0 reason=timeout');
    stand.dom.window.close();
  }, 15000);

  test('пустая сеть (SPA-чат из прогона 19-12) → live + маркер ONE-SIDE', async () => {
    const stand = makeStand();
    await runLiveTurn(stand);
    stand.setNetPlan(() => ({ json: FIX.netHistoryEmpty }));
    const sb = makeExportSandbox(stand);
    const info = await new Promise((res) => sb.ctx.aiCmExportNetSyncThen(CID, res));
    expect(info.ok).toBe(false);
    expect(info.reason).toBe('empty');
    expect(info.verdicts['ONE-SIDE']).toBeGreaterThan(0);
    expect(stand.logs.join('\n')).toContain('history_messages пуста (чат без истории в сети)');
    sb.run(95);
    await settle();
    expect(sb.body()).toContain(LIVE_SEAM);         // live-база не тронута
    expect(sb.downloads.length).toBe(1);
    expect(stand.logs.join('\n')).toContain('reason=empty');
    stand.dom.window.close();
  });

  test('усечённый сетевой снимок НЕ принимается: экспорт не становится хуже live-базы', async () => {
    const stand = makeStand();
    await runLiveTurn(stand);
    // Цепочка оборвана: у текущего узла parent_id указывает на отсутствующее сообщение.
    const truncated = JSON.parse(JSON.stringify(FIX.netHistoryFull));
    truncated.data.biz_data.chat_messages = [FIX.netHistoryFull.data.biz_data.chat_messages[1]];
    truncated.data.biz_data.chat_session.current_message_id = '4';
    stand.setNetPlan(() => ({ json: truncated }));
    const sb = makeExportSandbox(stand);
    const info = await new Promise((res) => sb.ctx.aiCmExportNetSyncThen(CID, res));
    expect(info.ok).toBe(false);
    expect(info.reason).toBe('truncated');
    expect(stand.logs.join('\n')).toContain('сетевой снимок усечён (цепочка оборвана) → база не тронута');
    // База осталась live-базой: ход не потерян, ранние ходы не срезаны.
    expect(stand.last().messageTexts[1]).toContain(LIVE_SEAM);
    sb.run(95);
    await settle();
    expect(sb.body()).toContain(LIVE_SEAM);
    expect(sb.body()).toContain('Пользователь просит пример.');
    stand.dom.window.close();
  });

  test('свежий снимок сети покрывает live-ходы → дозапроса НЕТ (fast-path reason=fresh)', async () => {
    const stand = makeStand();
    // Сетевой снимок принят ПОСЛЕ live-хода и содержит его → дозапрос не нужен.
    await runLiveTurn(stand);
    await stand.window.fetch('https://chat.deepseek.com/api/v1/chat/history_messages?chat_session_id=' + CID, { method: 'GET' });
    await settle();
    const beforeCalls = stand.netCalls.length;
    const sb = makeExportSandbox(stand);
    const info = await new Promise((res) => sb.ctx.aiCmExportNetSyncThen(CID, res));
    expect(info.ok).toBe(true);
    expect(info.reason).toBe('fresh');
    expect(info.refetched).toBe(false);
    expect(stand.netCalls.length).toBe(beforeCalls);       // сети в момент экспорта не было
    expect(stand.logs.join('\n')).toContain('ok=1 reason=fresh refetched=0');
    stand.dom.window.close();
  });

  test('ONE-SIDE по ходу: хода нет в сети → live-текст сохраняется, сетевые ходы на месте', async () => {
    const stand = makeStand();
    await runLiveTurn(stand);
    // Сеть знает только ПРЕДЫДУЩИЙ ход (user 1 / assistant 2): live-ход 3/4 в сети ещё нет.
    const partial = JSON.parse(JSON.stringify(FIX.netHistoryFull));
    partial.data.biz_data.chat_messages = [
      { message_id: '1', parent_id: null, role: 'USER', thinking_enabled: true, accumulated_token_usage: 100, fragments: [{ type: 'REQUEST', content: 'Первый вопрос' }] },
      { message_id: '2', parent_id: '1', role: 'ASSISTANT', thinking_enabled: true, accumulated_token_usage: 900, fragments: [{ type: 'RESPONSE', content: 'Первый ответ.' }] }
    ];
    partial.data.biz_data.chat_session.current_message_id = '2';
    stand.setNetPlan(() => ({ json: partial }));
    const sb = makeExportSandbox(stand);
    const info = await new Promise((res) => sb.ctx.aiCmExportNetSyncThen(CID, res));
    expect(info.ok).toBe(true);
    expect(info.verdicts['ONE-SIDE']).toBeGreaterThan(0);
    expect(stand.logs.join('\n')).toContain('есть только в live-базе (ONE-SIDE, сети нет)');
    sb.run(95);
    await settle();
    const body = sb.body();
    expect(body).toContain('Первый ответ.');        // сетевой ход на месте
    expect(body).toContain(LIVE_SEAM);              // live-ход не потерян
    expect(body.indexOf('Первый ответ.')).toBeLessThan(body.indexOf(LIVE_SEAM));
    stand.dom.window.close();
  });
});

// ===================== source-пины проводки =====================
describe('O-18: source-пины проводки экспортного дозапроса', () => {
  test('MAIN: мост, решение о дозапросе, per-turn выбор, таймаут', () => {
    expect(INTERCEPT_SRC).toContain("window.addEventListener('ai-cm-deepseek-net-sync'");
    expect(INTERCEPT_SRC).toContain("new CustomEvent('ai-cm-deepseek-net-sync-done'");
    expect(INTERCEPT_SRC).toContain('function netSyncNeeded() {');
    expect(INTERCEPT_SRC).toContain('function exportComposeTurns() {');
    expect(INTERCEPT_SRC).toContain('function applyExportNetSnapshot(json, convId) {');
    expect(INTERCEPT_SRC).toContain('var NET_SYNC_TIMEOUT_DEFAULT = 3000;');
    expect(INTERCEPT_SRC).toContain('var url = historyRefetchUrl();');
    expect(INTERCEPT_SRC).toContain('function liveTurnRecord(id, role, text, answer, reasoning, modelSlug) {');
    expect(INTERCEPT_SRC).toContain('netSnapshotAt = Date.now();');
    // per-turn выбор не ломает ни O-15/O-16 (длиннее побеждает), ни гейты O-17
    const compose = fnDecl(INTERCEPT_SRC, 'exportComposeTurns');
    expect(compose).toContain("v.verdict === 'TAIL-CUT'");
    expect(compose).toContain("bump('ONE-SIDE')");
    expect(fnDecl(INTERCEPT_SRC, 'applyExportNetSnapshot')).toContain('if (prevComplete && !histCompletion.historyComplete) {');
  });

  test('ISOLATED: мост-ожидание с таймаутом в base-handler + порядок вызовов в обоих путях', () => {
    expect(BASE_HANDLER_SRC).toContain('function aiCmExportNetSyncThen(convId, cb, timeoutMs) {');
    expect(BASE_HANDLER_SRC).toContain('function aiCmExportNetSyncSite() {');
    expect(BASE_HANDLER_SRC).toContain("window.addEventListener('ai-cm-deepseek-net-sync-done', handler)");
    expect(BASE_HANDLER_SRC).toContain("window.dispatchEvent(new CustomEvent('ai-cm-deepseek-net-sync'");
    expect(BASE_HANDLER_SRC).toContain("reason: 'timeout'");
    // ручной экспорт: flush → дамп → дозапрос (колбэк replyManualExport) → сборка базы
    const iHandler = CONTENT.indexOf("message.type === 'aiCmExportCurrent'");
    const iFlush = CONTENT.indexOf('aiCmFlushLiveStreamForExport(curCidExp);', iHandler);
    const iDump = CONTENT.indexOf("aiCmDumpTurnsSnapshot('snapshot-at-manual'", iHandler);
    const iSync = CONTENT.indexOf('aiCmExportNetSyncThen(curCidExp, replyManualExport);', iHandler);
    expect(iFlush).toBeGreaterThan(iHandler);
    expect(iSync).toBeGreaterThan(iFlush);
    expect(iSync).toBeGreaterThan(iDump);
    // байты файла собираются ТОЛЬКО в колбэке дозапроса (buildHistoryMessages внутри replyManualExport)
    const reply = CONTENT.slice(CONTENT.indexOf('var replyManualExport = function () {', iHandler),
      CONTENT.indexOf('if (typeof aiCmExportNetSyncThen ===', iHandler));
    expect(reply).toContain('messages: buildHistoryMessages()');
    expect(CONTENT).toContain('isLowConfidenceBase: (baseComplete !== true),');
    // автоэкспорт: гейт O-16 → дозапрос → (повторный вход) → композиция файла
    const dl = fnDecl(EXPORT_MGR_SRC, 'doAutoExportDownload');
    const iDefer = dl.indexOf('aiCmDeferAutoExportOnLiveStream(cid, percentage)');
    const iNet = dl.indexOf('aiCmExportNetSyncThen(cid, selfSync)');
    expect(iNet).toBeGreaterThan(iDefer);
    expect(dl).toContain('doAutoExportDownload(cid, percentage, reason, true)');
    expect(EXPORT_MGR_SRC).toContain('var aiCmNetSyncInFlight = {};');
    // латч и запись файла остались ПОСЛЕ дозапроса (порядок H21 не сдвинут)
    expect(dl.indexOf('aiCmExportNetSyncThen(cid, selfSync)')).toBeLessThan(dl.indexOf('markAutoExportFired(autoExportFired,'));
  });
});
