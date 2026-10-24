/**
 * v95 (METRICS-SYNC): ресинк метрик (pct/histKey) после deferred-флаша истории.
 *
 * Живой дефект: после 0→1 base-complete deferred-запись истории флашится финальным срезом
 * (120 сообщений), а histKey/pct в content.js остаются на прежнем срезе (101) — UI показывает
 * устаревшие цифры, пока в историю уже записан полный чат. Шаг 4 запроса: принудительный
 * пересчёт по ФИНАЛЬНОМУ состоянию сразу после флаша.
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
});
