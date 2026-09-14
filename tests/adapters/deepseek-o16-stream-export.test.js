/** @jest-environment node */
/**
 * O-16: DeepSeek — автоэкспорт/ручной экспорт не фиксируют усечённый ответ на живом стриме.
 *
 * Симптом живого прогона: файл автоэкспорта (histSource=memory) обрывался на полуслове
 * в последнем ответе ассистента (лог сети «📥 база полной истории: 10 сообщений …
 * textLen=29255» против усечённого файла), потому что экспорт срабатывал в середине
 * SSE-стрима по ПОЛУ-собранной memory-базе (lastBaseTexts последнего EMIT).
 *
 * Стенд: РЕАЛЬНЫЙ core/deepseek-intercept.js в jsdom с УПРАВЛЯЕМЫМ телом ответа
 * (ReadableStream: чанки подаются вручную) + РЕАЛЬНЫЕ maybeAutoExport/doAutoExportDownload
 * из core/export-manager.js в песочнице `with(ctx)` (как tests/autoexport-settings-m13),
 * где ctx.window === jsdom-window: CustomEvent-мост probe/flush говорит с живым
 * перехватчиком, а тело файла собирают реальные сборщики utils/export-text-builders.js.
 *
 * Проверки:
 *  1) воспроизведение дефекта: терминальный чанк (quasi_status FINISHED) приходит ДО
 *     конца тела ответа → EMIT середины стрима несёт ЧАСТИЧНЫЙ последний ход ассистента;
 *  2) фикс memory: досланные после терминала фрагменты не теряются — повторный финал
 *     того же потока ОБОГАЩАЕТ ход (буфер не сбрасывается), финальный EMIT полный;
 *  3) фикс автоэкспорт: probe видит active=true → пороговый триггер ОТКЛАДЫВАЕТСЯ
 *     (файл не пишется, латч already-fired не ставится), после конца потока отложка
 *     стреляет и файл содержит ПОЛНЫЙ ответ;
 *  4) фикс ручной экспорт: живой стрим → синхронный сброс буфера ДО buildHistoryMessages();
 *  5) прочие сервисы не затронуты (гейт только для deepseek) + потолок отложек;
 *  6) source-пины новой проводки.
 */

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const P = require('../../utils/export-emit-pipeline.js');
const Builders = require('../../utils/export-text-builders.js');
const CONTENT = require('../helpers/content-source.js').contentSource;

const ROOT = path.join(__dirname, '..', '..');
const INTERCEPT_SRC = fs.readFileSync(path.join(ROOT, 'core', 'deepseek-intercept.js'), 'utf8');
const EXPORT_MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');

// Рез по балансу фигурных скобок (стиль tests/autoexport-settings-m13.test.js).
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

// ======================= фикстура длинного ответа =======================

const CID = 'convO16live';
const QUESTION = 'Сравни три модели и объясни, почему итог именно такой.';
// PART1 — то, что успело прийти до терминального чанка (обрыв НА ПОЛУСЛОВЕ).
const PART1 = 'Разбор вариантов: сначала сравним M1 и M2, затем перейдём к выводу о';
// PART2 — остаток, который сервер досылает ПОСЛЕ терминала.
const PART2 = ' выборе модели с неверным M. Итог: берите модель B.';
const FULL_ANSWER = PART1 + PART2;

function line(obj) { return 'data: ' + JSON.stringify(obj) + '\n'; }
function ev(name) { return 'event: ' + name + '\n'; }
const BLANK = '\n';

function chunkReady() {
  return ev('ready') +
    line({ request_message_id: 'u1', response_message_id: 'a1', model_type: 'expert' }) + BLANK +
    ev('message') +
    line({ v: { response: { accumulated_token_usage: 1000, model_type: 'expert', fragments: [{ type: 'THINK', content: 'Сначала посчитаю бюджет.' }] } } }) + BLANK;
}
function chunkAnswer(part) {
  return line({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: part }] }) + BLANK;
}
function chunkTerminal() {
  return line({ p: 'response', o: 'BATCH', v: [{ p: 'accumulated_token_usage', v: 9000 }, { p: 'quasi_status', v: 'FINISHED' }] }) + BLANK;
}
function chunkClose() {
  return ev('close') + line({}) + BLANK;
}

// ======================= jsdom-стенд с управляемым стримом =======================

function makeChunkedResponse() {
  const enc = new TextEncoder();
  let ctrl = null;
  const stream = new ReadableStream({ start(c) { ctrl = c; } });
  const resp = {
    ok: true,
    status: 200,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
    clone: () => ({ body: stream, text: () => Promise.resolve('') })
  };
  return {
    resp,
    push: (s) => ctrl.enqueue(enc.encode(s)),
    end: () => ctrl.close()
  };
}

function historyResp() {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(null),
    text: () => Promise.resolve(''),
    clone: () => ({ json: () => Promise.resolve(null), text: () => Promise.resolve('') })
  };
}

function flush(times) {
  let p = Promise.resolve();
  for (let i = 0; i < (times || 120); i++) p = p.then(() => { });
  return p;
}
// Читатель потока резолвится и микрозадачами, и macrotask'ами — даём обоим шанс.
async function settle(times) {
  await new Promise((r) => setImmediate(r));
  await flush(times || 120);
  await new Promise((r) => setImmediate(r));
  await flush(40);
}

function makeStand(convId) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://chat.deepseek.com/a/chat/s/' + convId,
    runScripts: 'dangerously',
    virtualConsole: new VirtualConsole()
  });
  const { window } = dom;
  window.TextDecoder = TextDecoder;   // node-декодер: включаем инкрементальный путь чтения тела
  const events = [];
  const streams = [];
  window.fetch = (input) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || '');
    if (url.indexOf('completion') !== -1) {
      const c = makeChunkedResponse();
      streams.push(c);
      return Promise.resolve(c.resp);
    }
    return Promise.resolve(historyResp());
  };
  window.eval(INTERCEPT_SRC);
  window.addEventListener('ai-cm-full-history', (e) => events.push(e.detail));
  return {
    window,
    events,
    streams,
    last: () => events[events.length - 1],
    texts: () => ((events[events.length - 1] || {}).messageTexts) || [],
    roles: () => (((events[events.length - 1] || {}).messages) || []).map((m) => m.role),
    close: () => { try { window.close(); } catch (e) { } }
  };
}

function sendCompletion(stand, convId, prompt) {
  return stand.window.fetch('https://chat.deepseek.com/api/v1/chat/completion?x=1', {
    method: 'POST',
    body: JSON.stringify({ prompt: prompt || QUESTION, chat_session_id: convId, thinking_enabled: true })
  });
}

// ======== песочница РЕАЛЬНОГО пути экспорта (ISOLATED-мир, ctx.window = jsdom) ========
function makeExportSandbox(stand, over) {
  const logs = [];
  const downloads = [];
  const timers = [];
  const w = stand.window;
  // memory-база ISOLATED-мира: ровно последний EMIT (как слушатель ai-cm-full-history)
  const buildHistoryMessages = function () {
    const d = stand.last() || {};
    return ((d.messages) || []).map((m, i) => ({ role: m.role, text: d.messageTexts[i] }));
  };
  const B = Object.assign({}, Builders, {
    downloadBlob: function (content, file, mime) {
      downloads.push({ file: file, mime: mime, content: content, textLen: String(content).replace(/^\uFEFF/, '').replace(/\s+/g, '').length });
    }
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
    fnDecl(EXPORT_MGR_SRC, 'doAutoExportDownload') + '\n' +
    ' return { run: maybeAutoExport, probe: aiCmDeepseekStreamProbe,' +
    ' active: aiCmDeepseekStreamActiveFor, flush: aiCmFlushLiveStreamForExport,' +
    ' download: doAutoExportDownload }; }';

  const ctx = {
    window: w,
    CustomEvent: w.CustomEvent,
    AI_CM_DS_STREAM_DEFER_MS: 800,
    AI_CM_DS_STREAM_DEFER_MAX: 150,
    aiCmDsStreamDeferByConv: {},
    aiCmDsStreamDeferLogged: {},
    aiCmDsStreamFlushLogged: {},
    setTimeout: function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; },
    autoExportSettings: { enabled: true, pct: 90, fmt: 'txt' },
    autoExportLastConvId: '',
    autoExportPctBySite: {},
    autoExportFired: {},
    autoExportLastPct: -1,
    notCompleteLogged: {},
    sessionFiredCache: {},
    aiCmLoaderRunningByConv: {},
    aiCmCursorLiveByConv: {},
    aiCmArchiveCountFor: function () { return 0; },
    aiCmLowConfidenceByConv: {},
    baseSeen: true,
    baseComplete: true,
    baseCount: 2,
    lastBaseTexts: ['q', 'a'],
    lastThreadId: '',
    lastEmitConvId: CID,
    lastResolvedModelId: 'deepseek-r1',
    lastSnapshotModelName: 'DeepSeek-R1',
    maxTokenCount: 9000,
    currentAdapter: { siteName: 'deepseek' },
    getCurrentConvId: function () { return CID; },
    buildHistoryMessages: buildHistoryMessages,
    aiCmExportBaseSource: function () { return null; },
    aiCmDumpTurnsSnapshot: function () { },
    aiCmCancelDeferredHistWrite: function () { },
    ModelConfig: { getModel: function () { return { name: 'DeepSeek-R1' }; } },
    debugLog: function (lvl, msg) { logs.push(String(msg)); },
    chrome: { storage: { session: { remove: function () { }, set: function () { } }, local: { get: function () { } } } }
  };
  Object.assign(ctx, over || {});
  const api = new Function('ctx', SCOPE)(ctx);
  return {
    ctx: ctx, logs: logs, downloads: downloads, timers: timers,
    run: api.run, probe: api.probe, active: api.active, flush: api.flush, download: api.download,
    body: () => (downloads.length ? downloads[downloads.length - 1].content : '')
  };
}

// ======================= прогон: экспорт в середине стрима =======================

async function startMidStreamStand(stage2) {
  const stand = makeStand(CID);
  await sendCompletion(stand, CID);
  await settle();
  const st = stand.streams[0];
  st.push(chunkReady());
  await settle();
  st.push(chunkAnswer(PART1));
  await settle();
  if (stage2 !== false) {
    st.push(chunkTerminal());   // терминальный чанк РАНЬШЕ конца тела — триггер дефекта
    await settle();
  }
  return { stand: stand, st: st };
}

describe('O-16: DeepSeek — экспорт в середине живого SSE-стрима', () => {
  let stand;

  afterEach(() => { if (stand) stand.close(); stand = null; });

  test('воспроизведение: терминал до конца тела → EMIT середины стрима несёт ОБРЫВ на полуслове', async () => {
    const h = await startMidStreamStand();
    stand = h.stand;

    const mid = stand.last();
    expect(mid).toBeDefined();
    expect(mid.messageTexts.length).toBe(2);              // user + assistant (парность O-15 жива)
    expect(stand.roles()).toEqual(['user', 'assistant']);
    expect(mid.messageTexts[0]).toBe(QUESTION);
    expect(mid.messageTexts[1]).toContain(PART1);
    expect(mid.messageTexts[1]).not.toContain(PART2);      // ← именно этот снимок уходил в файл
    // probe честно сообщает: тело ответа ещё читается
    const sb = makeExportSandbox(stand);
    expect(sb.probe()).toEqual({ convId: CID, active: true, turnFinished: true });
    expect(sb.active(CID)).toBe(true);
  });

  test('фикс memory: досланные после терминала фрагменты не теряются — финальный EMIT полный', async () => {
    const h = await startMidStreamStand();
    stand = h.stand;
    const st = h.st;
    const mid = stand.last().messageTexts[1];

    st.push(chunkAnswer(PART2));     // остаток ответа после терминала
    await settle();
    st.push(chunkClose());
    st.end();
    await settle();

    const finalText = stand.last().messageTexts[1];
    expect(stand.last().messageTexts.length).toBe(2);
    expect(stand.roles()).toEqual(['user', 'assistant']);
    expect(finalText).toContain(PART2);                    // ход ОБОГАЩЁН, а не заморожен на PART1
    expect(finalText).toContain(FULL_ANSWER);
    expect(finalText.length).toBeGreaterThan(mid.length);
    const sb = makeExportSandbox(stand);
    expect(sb.probe().active).toBe(false);                 // поток закрыт
  });

  test('фикс автоэкспорт: триггер на живом стриме ОТКЛАДЫВАЕТСЯ, файл после конца потока — полный', async () => {
    const h = await startMidStreamStand();
    stand = h.stand;
    const st = h.st;

    const sb = makeExportSandbox(stand);
    sb.run(95);                                            // порог 90 достигнут в середине стрима
    expect(sb.downloads).toEqual([]);                      // файл НЕ написан
    expect(sb.logs.join('\n')).toContain('[AI CM][auto-export] defer reason=stream-active convId=' + CID +
      ' pct=95 ms=800 histSource=memory');
    expect(sb.timers.length).toBe(1);
    expect(sb.timers[0].ms).toBe(800);
    expect(P.getAutoExportFired(sb.ctx.autoExportFired, 'deepseek', CID)).toBe(false); // латч не поставлен    expect(sb.logs.join('\n')).not.toContain('[AI CM][auto-export] fired convId=' + CID);

    st.push(chunkAnswer(PART2));                           // сервер досылает остаток
    await settle();
    st.push(chunkClose());
    st.end();
    await settle();

    sb.timers[0].fn();                                     // отложенный re-check после конца потока
    expect(sb.downloads.length).toBe(1);
    expect(P.getAutoExportFired(sb.ctx.autoExportFired, 'deepseek', CID)).toBe(true); // латч поставлен обычным путём
    expect(sb.logs.join('\n')).toContain('[AI CM][auto-export] fired convId=' + CID +
      ' pct=95 file=' + sb.downloads[0].file);
    expect(sb.logs.join('\n')).toContain('histSource=memory histConvId=' + CID);

    const body = sb.body();                                // тело файла — реальный сборщик txt
    expect(body).toContain(PART1);
    expect(body).toContain(PART2);
    expect(body).toContain(FULL_ANSWER);                   // обрыва на полуслове нет
    expect(body).toContain('[REASONING]');
    expect(body).toContain('[ANSWER]');

    sb.run(95);                                            // повторный триггер — файл ровно один
    expect(sb.downloads.length).toBe(1);
    expect(sb.logs.join('\n')).toContain('[AI CM][auto-export] skip reason=already-fired convId=' + CID);
  });

  test('фикс ручной экспорт: живой стрим → синхронный сброс буфера ДО сборки файла', async () => {
    const h = await startMidStreamStand();
    stand = h.stand;
    const st = h.st;
    st.push(chunkAnswer(PART2));     // пришло, но ход ещё не пере-финализирован
    await settle();
    const beforeFlush = stand.last().messageTexts[1];
    expect(beforeFlush).not.toContain(PART2);

    const sb = makeExportSandbox(stand);
    expect(sb.flush(CID)).toBe(true);                      // snapshot-at-manual: флаш ДО сборки
    expect(sb.logs.join('\n')).toContain('[AI CM][auto-export] stream-flush convId=' + CID + ' reason=manual');
    const afterFlush = stand.last().messageTexts[1];
    expect(afterFlush).toContain(PART1);
    expect(afterFlush).toContain(PART2);                   // в файл уйдёт всё принятое, а не обрыв
    expect(afterFlush.length).toBeGreaterThan(beforeFlush.length);
    expect(stand.roles()).toEqual(['user', 'assistant']);  // user-роли не тронуты
    expect(sb.flush(CID)).toBe(true);                      // повторный флаш безопасен
  });

  test('прочие сервисы не затронуты: для chatgpt гейт молчит (поведение 1:1)', async () => {
    const h = await startMidStreamStand();
    stand = h.stand;

    const sb = makeExportSandbox(stand, { currentAdapter: { siteName: 'chatgpt' } });
    expect(sb.active(CID)).toBe(false);                    // site-гейт: только deepseek
    sb.run(95);
    expect(sb.downloads.length).toBe(1);
    expect(sb.body()).toContain(PART1);                    // прежнее (немедленное) поведение сохранено
    expect(sb.logs.join('\n')).not.toContain('defer reason=stream-active');
  });

  test('дебаунс не бесконечен: потолок отложек → принудительный flush и запись (без залипания)', async () => {
    const h = await startMidStreamStand();
    stand = h.stand;

    const sb = makeExportSandbox(stand);
    sb.ctx.aiCmDsStreamDeferByConv[CID] = 150;             // потолок уже достигнут
    sb.run(95);
    expect(sb.downloads.length).toBe(1);
    expect(sb.logs.join('\n')).toContain('[AI CM][auto-export] stream-flush convId=' + CID +
      ' reason=defer-cap defers=150');
    expect(sb.body()).toContain(PART1);                    // пишем максимум принятого, без молчания
  });
});

// ======================= source-пины проводки O-16 =======================

describe('O-16: source-пины проводки (перехватчик + экспортёр + ручной экспорт)', () => {
  test('перехватчик: состояние потока, probe/flush, обогащение хода, сброс только на старте потока', () => {
    expect(INTERCEPT_SRC).toContain('ai-cm-deepseek-stream-probe');
    expect(INTERCEPT_SRC).toContain('ai-cm-deepseek-stream-probe-response');
    expect(INTERCEPT_SRC).toContain('ai-cm-deepseek-stream-flush');
    expect(INTERCEPT_SRC).toContain('function beginSseStream() {');
    expect(INTERCEPT_SRC).toContain('function endSseStream() {');
    expect(INTERCEPT_SRC).toContain('sseStreamActive = true;');
    // усечённый ход обогащается, а не игнорируется (прежний гард `!turnsMap[assistantId]` снят для второго финала)
    expect(INTERCEPT_SRC).toContain('} else if (turnsMap[assistantId]) {');
    expect(INTERCEPT_SRC).toContain('var nextAnswer = (answerText && answerText.length >= exAnswer.length) ? answerText : exAnswer;');
    // поля ЗАПРОСА не теряются при старте потока (иначе live-экспорт остался бы без USER-хода)
    expect(INTERCEPT_SRC).toContain('var keepPrompt = sseUserPrompt;');
    // полный сброс потока — только старт потока / смена чата, НЕ финал хода
    const fin = fnDecl(INTERCEPT_SRC, 'finalizeRealtimeTurn');
    expect(fin).toContain('sseTurnFinished = true;');
    expect(fin).toContain("dispatchStreamState('finalize');");
    expect(fin).not.toContain('resetStreamState()');
    expect(fnDecl(INTERCEPT_SRC, 'beginSseStream')).toContain('resetStreamState();');
    expect(INTERCEPT_SRC).toContain("console.log('[deepseek-intercept] перехватчик DeepSeek v10 установлен");
  });

  test('экспортёр: гейт стоит в единственной точке записи файла (doAutoExportDownload)', () => {
    const dl = fnDecl(EXPORT_MGR_SRC, 'doAutoExportDownload');
    expect(dl).toContain("if (typeof aiCmDeferAutoExportOnLiveStream === 'function' &&");
    expect(dl).toContain('aiCmDeferAutoExportOnLiveStream(cid, percentage)) return;');
    // гейт — ДО латча/лога fired (пин порядка H21 не сдвинут)
    expect(dl.indexOf('aiCmDeferAutoExportOnLiveStream(cid, percentage)'))
      .toBeLessThan(dl.indexOf('markAutoExportFired(autoExportFired,'));
    // «НЕ трогать»: гейты полноты, пороговый путь, формат [REASONING]/[ANSWER] не тронуты
    expect(EXPORT_MGR_SRC).toContain('function maybeAutoExport(');
    expect(EXPORT_MGR_SRC).toContain('shouldSkipAutoExport');
    expect(EXPORT_MGR_SRC).toContain("doAutoExportDownload(cid, percentage, 'threshold');");
  });

  test('ручной экспорт: flush вызывается ДО buildHistoryMessages()', () => {
    const iHandler = CONTENT.indexOf("message.type === 'aiCmExportCurrent'");
    const iFlush = CONTENT.indexOf('aiCmFlushLiveStreamForExport(curCidExp);', iHandler);
    const iBuild = CONTENT.indexOf('messages: buildHistoryMessages()', iHandler);
    expect(iHandler).toBeGreaterThan(-1);
    expect(iFlush).toBeGreaterThan(iHandler);
    expect(iBuild).toBeGreaterThan(iFlush);
  });
});
