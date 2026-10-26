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
 * Здесь исполняется ВЫРЕЗАННЫЙ из core/content.js реальный текст функции (конвенция репозитория:
 * тест гоняет исходник, а не копию логики) — tests/helpers/content-source.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const H = require('./helpers/content-source.js');

const ROOT = H.ROOT;
const CONTENT = fs.readFileSync(path.join(ROOT, 'core', 'content.js'), 'utf8');
const MGR = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');

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
  test('P1: в обработчике loader-stop ресинк идёт ПОСЛЕ aiCmFlushDeferredHistWrite', () => {
    const iFlush = MGR.indexOf("aiCmFlushDeferredHistWrite(d.convId, 'loader-stop')");
    expect(iFlush).toBeGreaterThan(-1);
    const iResync = MGR.indexOf("aiCmResyncMetricsAfterFlush(d.convId, 'loader-stop')", iFlush);
    expect(iResync).toBeGreaterThan(iFlush);
    // только при подтверждённой полноте: вызов внутри ветки aiCmBaseConfirmedByConv === 1
    const iGate = MGR.lastIndexOf('aiCmBaseConfirmedByConv[d.convId] === 1', iFlush);
    expect(iGate).toBeGreaterThan(-1);
    expect(iGate).toBeLessThan(iFlush);
  });

  test('P2: после base-complete (0→1) ресинк идёт сразу после флаша', () => {
    const iFlush = CONTENT.indexOf("aiCmFlushDeferredHistWrite(cid79, 'base-complete')");
    expect(iFlush).toBeGreaterThan(-1);
    const iResync = CONTENT.indexOf("aiCmResyncMetricsAfterFlush(cid79, 'base-complete')", iFlush);
    expect(iResync).toBeGreaterThan(iFlush);
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
    // объявление + UMD-доступ (конвенция core/state.js) и обнуление при сбросе чата
    const state = H.readSource('core/state.js');
    expect(state).toContain('let aiCmNetRawCount = 0;');
    expect(state).toContain('let aiCmNetRawCountUsed = -1;');
    expect(state).toContain("Object.defineProperty(Api, 'aiCmNetRawCount',");
    expect(state).toContain("Object.defineProperty(Api, 'aiCmNetRawCountUsed',");
    expect(H.readSource('core/widget.js')).toContain('aiCmNetRawCountUsed = -1;');
  });
});

// =====================================================================================
// v98 (EXTRAPOLATION-GATE): масштаб эвристики по netEffectiveLen разрешён ТОЛЬКО на полной базе.
//
// Живой дефект: после F5 бейдж «скакал» 35.8% → 35.2% на одном и том же треде. Механизм:
// на неполной базе getEffectiveText (core/hybrid-tail.js) отдаёт КАНОНИЧЕСКИЙ ПОЛ базы, а
// netEffectiveLen приходит из ПОЛНОГО сетевого снимка — доля netEffectiveLen/fullText.length
// раздувала эвристику на промежуточном проходе (maxTokenCount монотонно вверх, useMonotonic
// при baseSeen && baseCount>0), а первая же ПОЛНАЯ база перезаписывала максимум вниз
// (`maxTokenCount = tokenEstimate`, ветка baseComplete === true). Итог — видимый скачок вниз.
//
// Правило: числитель и знаменатель масштаба должны относиться к ОДНОЙ базе ⇒ масштабировать
// можно только при baseComplete === true. Исполняются РЕАЛЬНЫЕ байты core/content.js
// (срез по маркерам + new Function, конвенция сьюта), не пересказ логики.
// =====================================================================================
const NET_ATTACH_TAIL = 'tokenEstimate += netAttachTokens;';

/** Срез масштабирования tokenEstimate из processAndSend — реальными байтами исходника. */
function metricScaleSnippet() {
  const draw = sliceFunction(CONTENT, 'processAndSend');
  const iStart = draw.indexOf('let tokenEstimate = metricServerTokens > 0');
  expect(iStart).toBeGreaterThan(-1);
  const iEnd = draw.indexOf(NET_ATTACH_TAIL, iStart);
  expect(iEnd).toBeGreaterThan(iStart);
  return draw.slice(iStart, iEnd + NET_ATTACH_TAIL.length);
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

/** Прогон реального среза масштабирования; возвращает итоговый tokenEstimate. */
function runScale(o) {
  const ctx = {
    metricServerTokens: o.metricServerTokens || 0,
    netEffectiveLen: o.netEffectiveLen,
    fullText: o.fullText,
    countForTokens: 1,
    netAttachTokens: 0,
    baseComplete: o.baseComplete === true,
    Tokenizer: {
      estimateDialogTokens: function () { return o.raw; }
    }
  };
  return new Function('ctx', 'with (ctx) { ' + metricScaleSnippet() +
    '\nreturn tokenEstimate; }')(ctx);
}

/** Прогон реального ветвления maxTokenCount; возвращает итоговый maxTokenCount. */
function runMaxBranch(o) {
  const ctx = {
    metricServerTokens: o.metricServerTokens || 0,
    byokHeuristicHold: o.byokHeuristicHold === true,
    baseComplete: o.baseComplete === true,
    useMonotonic: o.useMonotonic === true,
    tokenEstimate: o.tokenEstimate,
    maxTokenCount: o.maxTokenCount
  };
  return new Function('ctx', 'with (ctx) { ' + metricMaxBranch() +
    '\nreturn maxTokenCount; }')(ctx);
}

const RAW_ESTIMATE = 100000;
const FULL_TEXT = 'я'.repeat(400000);            // канонический пол базы (fullText)
const NET_LEN = 408000;                          // сеть: полный снимок на 2% длиннее

describe('v98: масштаб по netEffectiveLen только при baseComplete === true', () => {
  test('D1: baseComplete=0 (неполная база) — tokenEstimate НЕ умножается и не «взлетает»', () => {
    const est = runScale({ raw: RAW_ESTIMATE, fullText: FULL_TEXT, netEffectiveLen: NET_LEN, baseComplete: false });
    // до правки здесь было Math.round(100000 * 1.02) = 102000 (раздувание на промежуточном проходе)
    expect(est).toBe(RAW_ESTIMATE);
    expect(est).toBeLessThan(Math.round(RAW_ESTIMATE * 1.001));
    expect(est).toBeLessThan(Math.round(RAW_ESTIMATE * (NET_LEN / FULL_TEXT.length)));
  });

  test('D2: baseComplete=1 (полная база) — масштаб по-прежнему применяется', () => {
    const est = runScale({ raw: RAW_ESTIMATE, fullText: FULL_TEXT, netEffectiveLen: NET_LEN, baseComplete: true });
    expect(est).toBe(Math.round(RAW_ESTIMATE * (NET_LEN / FULL_TEXT.length)));
    expect(est).toBeGreaterThan(RAW_ESTIMATE);
  });

  test('D3: контроль — пол и текст одной базы (netEffectiveLen ≤ fullText.length) не масштабируются', () => {
    expect(runScale({ raw: RAW_ESTIMATE, fullText: FULL_TEXT, netEffectiveLen: FULL_TEXT.length, baseComplete: true }))
      .toBe(RAW_ESTIMATE);
    expect(runScale({ raw: RAW_ESTIMATE, fullText: FULL_TEXT, netEffectiveLen: NET_LEN, baseComplete: false }))
      .toBe(RAW_ESTIMATE);
  });

  test('D4: серверный/точный счётчик (metricServerTokens>0) масштабом не трогается ни при какой базе', () => {
    expect(runScale({ raw: RAW_ESTIMATE, fullText: FULL_TEXT, netEffectiveLen: NET_LEN, baseComplete: true, metricServerTokens: 1234 }))
      .toBe(1234);
    expect(runScale({ raw: RAW_ESTIMATE, fullText: FULL_TEXT, netEffectiveLen: NET_LEN, baseComplete: false, metricServerTokens: 1234 }))
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

  test('D6: source-пин — гейт стоит в ОБЕИХ точках метрики (бейдж и GET_STATS попапа)', () => {
    const guarded = CONTENT.split('baseComplete === true && metricServerTokens === 0 && netEffectiveLen > 0').length - 1;
    expect(guarded).toBe(2);                                 // processAndSend + GET_STATS
    // неохраняемой формы (масштаб без вердикта полноты) в исходнике не осталось
    expect(CONTENT).not.toContain('if (metricServerTokens === 0 && netEffectiveLen > 0');
    expect(metricScaleSnippet()).toContain('if (baseComplete === true && metricServerTokens === 0');
    // масштаб идёт ДО `tokenEstimate += netAttachTokens` (вложения добавляются к готовому числу)
    const draw = sliceFunction(CONTENT, 'processAndSend');
    expect(draw.indexOf('if (baseComplete === true && metricServerTokens === 0'))
      .toBeLessThan(draw.indexOf(NET_ATTACH_TAIL));
  });
});
