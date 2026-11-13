/**
 * v95 (METRICS-SYNC): ресинк метрик (pct/histKey) после deferred-флаша истории.
 *
 * Живой дефект: после 0→1 base-complete deferred-запись истории флашится финальным срезом
 * (120 сообщений), а histKey/pct в content.js остаются на прежнем срезе (101) — UI показывает
 * устаревшие цифры, пока в историю уже записан полный чат. Шаг 4 запроса: принудительный
 * пересчёт по ФИНАЛЬНОМУ состоянию сразу после флаша.
 *
 * v96 (баг 34.6%): дедупликатор схлопывает базу — сеть отдала 120 сообщений, а финальный срез
 * снова 101, histKey совпал с прошлым ⇒ ресинк пропускался и метрики замирали навсегда.
 * Теперь пропуск требует ещё и неизменного счётчика ДО дедупликации (detail.count):
 * aiCmNetRawCount / aiCmNetRawCountUsed. Изменился сырой счётчик — histKey снимается (null),
 * чтобы следующий processAndSend не отсеялся дедупом и пересчитал pct.
 *
 * Здесь исполняется ВЫРЕЗАННЫЙ из core/content.ts реальный текст функции (конвенция репозитория:
 * тест гоняет исходник, а не копию логики) — tests/helpers/content-source.js.
 */

'use strict';

const fs = require('fs');
const { readCore } = require('./helpers/core-src.js');
const read = function (rel) { return readCore(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8')); };
const path = require('path');

const H = require('./helpers/content-source.js');

const ROOT = H.ROOT;
const CONTENT = readCore('core/content.ts');
const WIDGET = read('core/widget.ts');
const MGR = read('core/export-manager.ts');

const CID = 'c-metrics-resync';

/** Тело функции по имени: от `function name(` до парной закрывающей скобки. */
function sliceFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  expect(start).toBeGreaterThan(-1);
  let i = src.indexOf('{', start);
  let depth = 0;
  const open = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unterminated ' + name + ' @' + open);
}

/** Прогон реального текста aiCmResyncMetricsAfterFlush с подставленным состоянием. */
function runResync(over) {
  const logs = [];
  const sent = [];
  let snapshotCalls = 0;
  const ctx = {
    baseSeen: true,
    baseCount: 101,
    lastBaseTexts: ['старое'],
    baseText: 'старое',
    lastHistoryWroteKey: '101|6',
    getCurrentConvId: function () { return CID; },
    aiCmCurrentBaseSnapshot: function () {
      snapshotCalls++;
      return over.msgs;
    },
    processAndSend: function () { sent.push(1); },
    aiCmDiagLine: function () { },
    debugLog: function (lvl, msg) { logs.push(String(msg)); },
    swallowSoft: function () { }
  };
  Object.assign(ctx, over.ctx || {});
  const body = sliceFunction(CONTENT, 'aiCmResyncMetricsAfterFlush');
  const fn = new Function('ctx', 'with (ctx) { ' + body + '\n return aiCmResyncMetricsAfterFlush; }')(ctx);
  const ret = fn(over.cid === undefined ? CID : over.cid, over.reason || 'loader-stop');
  return { ctx, logs, sent, ret, snapshotCalls };
}

function msgs(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ role: i % 2 ? 'assistant' : 'user', text: 'm' + i });
  return out;
}

describe('v95 metrics-resync: pct/histKey по финальному срезу', () => {
  test('R1: срез дорос 101 → 120 — histKey/baseCount обновлены, UI перерисован', () => {
    const r = runResync({ msgs: msgs(120) });
    expect(r.ret).toBe(true);
    expect(r.ctx.baseCount).toBe(120);
    expect(r.ctx.lastBaseTexts).toHaveLength(120);
    expect(r.ctx.lastBaseTexts[119]).toBe('m119');
    expect(r.ctx.lastHistoryWroteKey).toBe('120|' + r.ctx.baseText.length);
    expect(r.ctx.lastHistoryWroteKey).not.toBe('101|6');
    expect(r.sent).toHaveLength(1); // processAndSend → пересчёт pct и бейджа
    expect(r.logs.join('\n')).toContain('metrics-resync');
    expect(r.logs.join('\n')).toContain('msgs=101->120');
  });

  test('R2: срез не изменился — записи и перерисовки нет (дедуп по histKey)', () => {
    const same = msgs(101);
    const key = '101|' + same.map((m) => m.text).join('\n').length;
    const r = runResync({ msgs: same, ctx: { lastHistoryWroteKey: key } });
    expect(r.ret).toBe(false);
    expect(r.ctx.baseCount).toBe(101);
    expect(r.sent).toEqual([]);
    expect(r.logs.join('\n')).toContain('metrics-resync skip reason=same');
  });

  test('R3: срез короче базы — не откатываем UI назад (shrink)', () => {
    const r = runResync({ msgs: msgs(80) });
    expect(r.ret).toBe(false);
    expect(r.ctx.baseCount).toBe(101);
    expect(r.ctx.lastHistoryWroteKey).toBe('101|6');
    expect(r.sent).toEqual([]);
    expect(r.logs.join('\n')).toContain('metrics-resync skip reason=shrink');
  });

  test('R9 (v1.9): 88→88, длина 568620→249856 — короткий срез НЕ принимается, бейдж не падает', () => {
    // Живой замер 6eed4c3f: та же база 88 сообщений, но joined.length упал
    // 268 503 → 249 856; гард по msgs.length такой случай не видел. Здесь 88→88
    // и база длиной 568 620 символов (белый шум экспортного контента не нужен —
    // проверяется именно длина базы), срез — 88 сообщений общей длиной ~249 856.
    const list = [];
    const per = Math.floor((249856 - 87) / 88);
    for (let i = 0; i < 88; i++) list.push({ role: i % 2 ? 'assistant' : 'user', text: 'x'.repeat(per) });
    const base = 'x'.repeat(568620);
    const r = runResync({
      msgs: list,
      reason: 'base-complete',
      ctx: { baseCount: 88, baseText: base, lastHistoryWroteKey: '88|568620' }
    });
    expect(r.ret).toBe(false);                       // срез НЕ принят
    expect(r.ctx.baseCount).toBe(88);                // база не подменена коротким срезом
    expect(r.ctx.baseText.length).toBe(568620);      // принятая длина сохранена
    expect(r.sent).toEqual([]);                      // processAndSend не звался → бейдж не просел
    const logs = r.logs.join('\n');
    expect(logs).toContain('metrics-resync skip reason=shrink-length');
    expect(logs).toContain('prevLen=568620');
  });

  test('R4: чужой convId — ресинк не применяется', () => {
    const r = runResync({ msgs: msgs(120), cid: 'other' });
    expect(r.ret).toBe(false);
    expect(r.ctx.baseCount).toBe(101);
    expect(r.sent).toEqual([]);
    expect(r.snapshotCalls).toBe(0);
  });

  test('R5: пустой срез/нет baseSeen — тихий отказ без исключения', () => {
    const empty = runResync({ msgs: [] });
    expect(empty.ret).toBe(false);
    expect(empty.ctx.baseCount).toBe(101);
    const unseen = runResync({ msgs: msgs(120), ctx: { baseSeen: false } });
    expect(unseen.ret).toBe(false);
    expect(unseen.snapshotCalls).toBe(0);
  });

  test('R6: баг 34.6% — сеть 120 схлопнулась дедупом до 101, ключ прежний ⇒ пересчёт ОБЯЗАН сработать', () => {
    const same = msgs(101);
    const key = '101|' + same.map((m) => m.text).join('\n').length; // совпадает с прошлой записью
    const r = runResync({
      msgs: same,
      reason: 'base-complete',
      ctx: { lastHistoryWroteKey: key, aiCmNetRawCount: 120, aiCmNetRawCountUsed: 101 }
    });
    expect(r.ret).toBe(true);                        // НЕ skip, хотя histKey не изменился
    expect(r.ctx.baseCount).toBe(101);               // схлопнутый срез остаётся как есть
    expect(r.ctx.aiCmNetRawCountUsed).toBe(120);     // сырой счётчик сети учтён
    expect(r.ctx.lastHistoryWroteKey).toBeNull();    // ключ снят → следующая запись не отсеется
    expect(r.sent).toHaveLength(1);                  // processAndSend → пересчёт pct/бейджа
    expect(r.logs.join('\n')).toContain('raw=101->120');
  });

  test('R7: анти-дребезг — сырой счётчик не менялся ⇒ повторный ресинк по-прежнему пропуск', () => {
    const same = msgs(101);
    const key = '101|' + same.map((m) => m.text).join('\n').length;
    const r = runResync({
      msgs: same,
      ctx: { lastHistoryWroteKey: key, aiCmNetRawCount: 120, aiCmNetRawCountUsed: 120 }
    });
    expect(r.ret).toBe(false);
    expect(r.ctx.lastHistoryWroteKey).toBe(key);     // ключ жив, дребезга нет
    expect(r.sent).toEqual([]);
    expect(r.logs.join('\n')).toContain('metrics-resync skip reason=same');
  });

  test('R8: сырой счётчик вырос И срез реально дорос — ключ обновляется, лишней записи нет', () => {
    const r = runResync({
      msgs: msgs(120),
      ctx: { aiCmNetRawCount: 120, aiCmNetRawCountUsed: 101 }
    });
    expect(r.ret).toBe(true);
    expect(r.ctx.baseCount).toBe(120);
    expect(r.ctx.lastHistoryWroteKey).toBe('120|' + r.ctx.baseText.length); // НЕ null
    expect(r.ctx.aiCmNetRawCountUsed).toBe(120);
    expect(r.sent).toHaveLength(1);
  });
});

describe('v95 metrics-resync: вызов стоит сразу после deferred-флаша (source-pin)', () => {
  test('P1: в обработчике loader-stop ресинк идёт ДО aiCmFlushDeferredHistWrite (R1)', () => {
    // v2.6 (R1, Шаг 3): порядок инвертирован — файл/панель обязаны получить снимок метрики
    // ПОСЛЕ пересчёта. Прежний порядок (flush → resync) фиксировал устаревший снимок:
    // живой замер R1 — 81 токен между шапкой файла и бейджем сразу после F5.
    const iResync = MGR.indexOf("aiCmResyncMetricsAfterFlush(d.convId, 'loader-stop')");
    expect(iResync).toBeGreaterThan(-1);
    const iFlush = MGR.indexOf("aiCmFlushDeferredHistWrite(d.convId, 'loader-stop')", iResync);
    expect(iFlush).toBeGreaterThan(iResync);
    // и флаш ровно один (дубликата «до ресинка» не осталось)
    expect(MGR.split("aiCmFlushDeferredHistWrite(d.convId, 'loader-stop')").length - 1).toBe(1);
    // только при подтверждённой полноте: оба вызова внутри ветки aiCmBaseConfirmedByConv === 1
    const iGate = MGR.lastIndexOf('aiCmBaseConfirmedByConv[d.convId] === 1', iResync);
    expect(iGate).toBeGreaterThan(-1);
    expect(iGate).toBeLessThan(iResync);
  });

  test('P2: после base-complete (0→1) ресинк идёт ДО флаша истории (тот же порядок R1)', () => {
    const iResync = CONTENT.indexOf("aiCmResyncMetricsAfterFlush(cid79, 'base-complete')");
    expect(iResync).toBeGreaterThan(-1);
    const iFlush = CONTENT.indexOf("aiCmFlushDeferredHistWrite(cid79, 'base-complete')", iResync);
    expect(iFlush).toBeGreaterThan(iResync);
    // ресинк по-прежнему до автоэкспорта (v2.5 D2): файл берёт готовый снимок
    const iExport = CONTENT.indexOf('maybeAutoExport(freshPct79)', iFlush);
    expect(iExport).toBeGreaterThan(iFlush);
  });

  test('P3: единая точка снимка — aiCmWriteCurrentHistory не собирает базу вручную', () => {
    // v95: тот же снапшот, по которому чинится histKey, пишется и в историю
    const name = 'aiCmCurrentBaseSnapshot';
    expect(MGR.indexOf('function ' + name + '(')).toBeGreaterThan(-1);
    const iWrite = MGR.indexOf('function aiCmWriteCurrentHistory(');
    const iNext = MGR.indexOf('\nfunction ', iWrite + 10);
    const body = MGR.slice(iWrite, iNext);
    expect(body).toContain('aiCmCurrentBaseSnapshot(cid)');
  });

  test('P4 (v96): detail.count снимается ДО дедупликатора; состояние объявлено и сбрасывается', () => {
    // сырой счётчик сети фиксируется сразу, пока дедуп не перезаписал baseCount;
    // только явное число: снимок без count не обнуляет признак «сеть принесла новое»
    expect(CONTENT).toContain('if (typeof detail.count === \'number\') aiCmNetRawCount = detail.count;');
    const iRaw = CONTENT.indexOf('aiCmNetRawCount = detail.count;');
    expect(iRaw).toBeGreaterThan(-1);
    expect(CONTENT.lastIndexOf('baseCount = detail.count || 0;', iRaw)).toBeGreaterThan(-1);
    // и строго до схлопывания базы дедупликатором
    const iDedup = CONTENT.indexOf('baseCount = texts18.length;');
    expect(iDedup).toBeGreaterThan(iRaw);
    // объявление + UMD-доступ (конвенция core/state.ts) и обнуление при сбросе чата
    const state = H.readSource('core/state.ts');
    expect(state).toContain('let aiCmNetRawCount = 0;');
    expect(state).toContain('let aiCmNetRawCountUsed = -1;');
    expect(state).toContain("Object.defineProperty(Api, 'aiCmNetRawCount',");
    expect(state).toContain("Object.defineProperty(Api, 'aiCmNetRawCountUsed',");
    expect(H.readSource('core/widget.ts')).toContain('aiCmNetRawCountUsed = -1;');
  });
});

// =====================================================================================
// v98 (EXTRAPOLATION-GATE): масштаб эвристики по netEffectiveLen разрешён ТОЛЬКО на полной базе.
//
// Живой дефект: после F5 бейдж «скакал» 35.8% → 35.2% на одном и том же треде. Механизм:
// на неполной базе getEffectiveText (core/hybrid-tail.ts) отдаёт КАНОНИЧЕСКИЙ ПОЛ базы, а
// netEffectiveLen приходит из ПОЛНОГО сетевого снимка — доля netEffectiveLen/fullText.length
// раздувала эвристику на промежуточном проходе (maxTokenCount монотонно вверх, useMonotonic
// при baseSeen && baseCount>0), а первая же ПОЛНАЯ база перезаписывала максимум вниз
// (`maxTokenCount = tokenEstimate`, ветка baseComplete === true). Итог — видимый скачок вниз.
//
// Правило: числитель и знаменатель масштаба должны относиться к ОДНОЙ базе ⇒ масштабировать
// можно только при baseComplete === true. Исполняются РЕАЛЬНЫЕ байты core/content.ts
// (срез по маркерам + new Function, конвенция сьюта), не пересказ логики.
// =====================================================================================
// v2.3 (B1): вложения добавляются долей пула через aiCmAttachPendingTokens — теперь это
// внутренняя точка ЕДИНОГО расчёта (v2.6/R1: aiCmTokenSnapshot), её и исполняет пин.
const NET_ATTACH_LINE = 'var attachAdd = aiCmAttachPendingTokens(text, attach, attachBreak);';
// Гейт масштаба живёт в ОДНОМ месте: если он появится/пропадёт в одном из путей — расхождение.
const SCALE_GATE = 'baseComplete === true) && serverTokens === 0';

/** Срез единой точки расчёта — РЕАЛЬНЫЕ байты aiCmTokenSnapshot (v2.6/R1). */
function snapshotSnippet() {
  const src = sliceFunction(CONTENT, 'aiCmTokenSnapshot');
  expect(src.indexOf(SCALE_GATE)).toBeGreaterThan(-1);
  return src;
}

/** Срез ветвления maxTokenCount (перезапись/монотонный максимум) из processAndSend. */
function metricMaxBranch() {
  const draw = sliceFunction(CONTENT, 'processAndSend');
  const iAnchor = draw.indexOf('// точное число из countTokens авторитетно');
  expect(iAnchor).toBeGreaterThan(-1);
  const iStart = draw.lastIndexOf('if (metricServerTokens > 0) {', iAnchor);
  expect(iStart).toBeGreaterThan(-1);
  const iEnd = draw.indexOf('const percentage = displayLimit > 0', iStart);
  expect(iEnd).toBeGreaterThan(iStart);
  return draw.slice(iStart, iEnd);
}

/** Прогон РЕАЛЬНОГО aiCmTokenSnapshot в песочнице; возвращает его результат. */
function runSnapshot(o) {
  const ctx = {
    getServiceKey: function () { return o.svc || 'gemini'; },
    currentAdapter: { siteName: o.svc || 'gemini' },
    aiCmMetricServerTokens: function () { return o.serverTokens || 0; },
    aiCmCanonicalTokens: function () { return o.raw; },
    aiCmAttachPendingTokens: function () { return o.attachAdd || 0; },
    aiCmAistudioNativePromptTokens: function () { return 0; },
    baseComplete: o.baseComplete === true,
    netEffectiveLen: o.netEffectiveLen,
    resolveCurrentModel: function () { return 'gemini-2.5-pro'; },
    lastResolvedModelId: 'gemini-2.5-pro',
    computeEffectiveLimit: function () { return 1000000; }
  };
  const snap = new Function('ctx', 'with (ctx) { ' + snapshotSnippet() +
    '\nreturn aiCmTokenSnapshot; }')(ctx);
  return snap(o.fullText, 1, 0, null);
}

/** Прогон реального ветвления maxTokenCount; возвращает итоговый maxTokenCount. */
function runMaxBranch(o) {
  const ctx = {
    metricServerTokens: o.metricServerTokens || 0,
    byokHeuristicHold: o.byokHeuristicHold === true,
    baseComplete: o.baseComplete === true,
    useMonotonic: o.useMonotonic === true,
    tokenEstimate: o.tokenEstimate,
    maxTokenCount: o.maxTokenCount,
    // v1.9: срез ветвления читает только эти два поля; непереданные → typeof-гард
    // оставляет прежнюю безусловную перезапись (D5/gemini).
    aiCmHwKeep: o.aiCmHwKeep,
    aiCmMetricValueSrc: o.aiCmMetricValueSrc,
    svc: o.svc || 'gemini'
  };
  return new Function('ctx', 'with (ctx) { ' + metricMaxBranch() +
    '\nreturn maxTokenCount; }')(ctx);
}

const RAW_ESTIMATE = 100000;
const FULL_TEXT = 'я'.repeat(400000);            // канонический пол базы (fullText)
const NET_LEN = 408000;                          // сеть: полный снимок на 2% длиннее

describe('v98: масштаб по netEffectiveLen только при baseComplete === true', () => {
  test('D1: baseComplete=0 (неполная база) — tokens НЕ умножаются и не «взлетают»', () => {
    const snap = runSnapshot({ raw: RAW_ESTIMATE, fullText: FULL_TEXT, netEffectiveLen: NET_LEN, baseComplete: false });
    const est = snap.tokens;
    // до правки здесь было Math.round(100000 * 1.02) = 102000 (раздувание на промежуточном проходе)
    expect(est).toBe(RAW_ESTIMATE);
    expect(est).toBeLessThan(Math.round(RAW_ESTIMATE * 1.001));
    expect(est).toBeLessThan(Math.round(RAW_ESTIMATE * (NET_LEN / FULL_TEXT.length)));
    // percent считается от того же числа и того же лимита — расхождения «число/круг» нет
    expect(snap.percent).toBe(Math.round((est / snap.limit) * 1000) / 10);
  });

  test('D2: baseComplete=1 (полная база) — масштаб по-прежнему применяется', () => {
    const est = runSnapshot({ raw: RAW_ESTIMATE, fullText: FULL_TEXT, netEffectiveLen: NET_LEN, baseComplete: true }).tokens;
    expect(est).toBe(Math.round(RAW_ESTIMATE * (NET_LEN / FULL_TEXT.length)));
    expect(est).toBeGreaterThan(RAW_ESTIMATE);
  });

  test('D3: контроль — пол и текст одной базы (netEffectiveLen ≤ fullText.length) не масштабируются', () => {
    expect(runSnapshot({ raw: RAW_ESTIMATE, fullText: FULL_TEXT, netEffectiveLen: FULL_TEXT.length, baseComplete: true }).tokens)
      .toBe(RAW_ESTIMATE);
    expect(runSnapshot({ raw: RAW_ESTIMATE, fullText: FULL_TEXT, netEffectiveLen: NET_LEN, baseComplete: false }).tokens)
      .toBe(RAW_ESTIMATE);
  });

  test('D4: серверный/точный счётчик (serverTokens>0) масштабом не трогается ни при какой базе', () => {
    expect(runSnapshot({ raw: RAW_ESTIMATE, fullText: FULL_TEXT, netEffectiveLen: NET_LEN, baseComplete: true, serverTokens: 1234 }).tokens)
      .toBe(1234);
    expect(runSnapshot({ raw: RAW_ESTIMATE, fullText: FULL_TEXT, netEffectiveLen: NET_LEN, baseComplete: false, serverTokens: 1234 }).tokens)
      .toBe(1234);
    // и серверное число остаётся видимым потребителю как serverTokens (O-47: гейт Qwen выше)
    expect(runSnapshot({ raw: RAW_ESTIMATE, fullText: FULL_TEXT, netEffectiveLen: NET_LEN, baseComplete: true, serverTokens: 1234 }).serverTokens)
      .toBe(1234);
  });

  test('D5: при baseComplete=1 перезапись maxTokenCount идёт НОВЫМ (немасштабированным) значением', () => {
    // сценарий F5: предыдущий проход неполной базы удержал раздутое 35800, полная база даёт 35100
    const finalEst = 35100;
    const rewritten = runMaxBranch({
      baseComplete: true, useMonotonic: true, tokenEstimate: finalEst, maxTokenCount: 35800
    });
    expect(rewritten).toBe(finalEst);                       // безусловная перезапись (не max-merge)
    expect(rewritten).toBeLessThan(35800);                  // 35.8% → 35.2%: это и есть целевое поведение
    // и на неполной базе тот же проход НЕ роняет максимум вниз (скачка посреди загрузки нет)
    expect(runMaxBranch({ baseComplete: false, useMonotonic: true, tokenEstimate: finalEst, maxTokenCount: 35800 }))
      .toBe(35800);
  });

  test('D7 (v1.9): qwen high-water — короткий net-срез не роняет уже измеренный длинный текст', () => {
    const body = sliceFunction(CONTENT, 'aiCmQwenHighWaterTrack') + '\n' +
      sliceFunction(CONTENT, 'aiCmQwenHighWaterKeep');
    const ctx = { aiCmTokenHighWater: null, swallowSoft: function () { } };
    const api = new Function('ctx', 'with (ctx) { ' + body +
      '\nreturn { track: aiCmQwenHighWaterTrack, keep: aiCmQwenHighWaterKeep }; }')(ctx);
    // DOM-проход: 661 388 символов → 218 334 токена (живой замер 6eed4c3f)
    api.track(CID, 661388, 218334, 'dom');
    expect(api.keep(CID, 249856)).toBe(218334);      // сеть короче → отдаём high-water
    expect(ctx.aiCmTokenHighWater.len).toBe(661388);
    expect(ctx.aiCmTokenHighWater.src).toBe('dom');
    // чужой чат не наследует максимум
    expect(api.keep('other', 249856)).toBe(0);
    // текущий текст длиннее — слияние не нужно, берётся текущее число
    expect(api.keep(CID, 700000)).toBe(0);
    // максимум обновляется только при РОСТЕ длины (токены не сравниваются)
    api.track(CID, 700000, 230000, 'net');
    expect(api.keep(CID, 249856)).toBe(230000);
    expect(ctx.aiCmTokenHighWater.tokens).toBe(230000);
  });

  test('D8 (v1.9): qwen baseComplete уступает high-water; gemini перезаписывается как раньше', () => {
    const qwen = runMaxBranch({
      baseComplete: true, useMonotonic: true, tokenEstimate: 92197,
      maxTokenCount: 218334, aiCmHwKeep: 218334, aiCmMetricValueSrc: 'net', svc: 'qwen'
    });
    expect(qwen).toBe(218334);                       // 92 197 не затирает измеренные 218 334
    expect(runMaxBranch({
      baseComplete: true, useMonotonic: true, tokenEstimate: 92197,
      maxTokenCount: 218334, aiCmHwKeep: 0, aiCmMetricValueSrc: 'net', svc: 'qwen'
    })).toBe(92197);                                 // нет более длинного текста → числа сети
    expect(runMaxBranch({
      baseComplete: true, useMonotonic: true, tokenEstimate: 35100, maxTokenCount: 35800
    })).toBe(35100);                                 // D5/gemini: безусловная перезапись
  });

  test('D9 (v1.9): сброс чата гасит canonical-источник и emergency high-water', () => {
    // v37: смена convId в content.ts сбрасывает оба поля рядом с maxTokenCount.
    const hwReset = CONTENT.indexOf("if (typeof aiCmTokenHighWater !== 'undefined') aiCmTokenHighWater = null;");
    const srcReset = CONTENT.indexOf("aiCmBaseSource = '';", hwReset);
    expect(hwReset).toBeGreaterThan(-1);
    expect(srcReset).toBeGreaterThan(hwReset);
    expect(srcReset - hwReset).toBeLessThan(400);
    // resetConversationState (core/widget.ts) — второй путь сброса при SPA-переходе.
    expect(WIDGET).toContain('aiCmTokenHighWater = null;');
    expect(WIDGET).toContain("aiCmBaseSource = '';");
  });

  test('D6: source-пин — гейт стоит в ЕДИНОЙ точке расчёта, а её зовут ОБА пути (бейдж и панель)', () => {
    // v2.6 (R1): прежние два независимых среза схлопнуты в одну функцию aiCmTokenSnapshot;
    // гейт масштаба обязан остаться ровно один (иначе пути снова разойдутся).
    expect(CONTENT.split(SCALE_GATE).length - 1).toBe(1);
    expect(CONTENT.split('aiCmTokenSnapshot(').length - 1).toBe(2);   // объявление + бейдж
    // неохраняемой формы (масштаб без вердикта полноты) в исходнике не осталось
    expect(CONTENT).not.toContain('if (metricServerTokens === 0 && netEffectiveLen > 0');
    // масштаб идёт ДО добавки доли вложений (вложения добавляются к готовому числу)
    const snap = snapshotSnippet();
    expect(snap.indexOf(SCALE_GATE)).toBeLessThan(snap.indexOf(NET_ATTACH_LINE));
    // и сама единая точка не читает сырое поле снимка сети: только site-гейт метрики
    expect(snap).not.toContain('netServerTokens');
    expect(snap).toContain('serverTokens = aiCmMetricServerTokens(svc, text)');
  });
});
