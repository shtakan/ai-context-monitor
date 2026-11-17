'use strict';
/**
 * BUG-M / BUG-N / BUG-H: вердикт полноты ПАССИВНОГО снимка и состав слияния.
 *
 * Тест поведенческий: продукт не читается — реальные функции перехватчика приходят из
 * общей песочницы tests/adapters/helpers/gsa-loop-sandbox.js (makePassiveApi), вход —
 * фикстуры состава 2.1.4, выход — снимок (история/причина/сообщения) и факт запуска probe.
 *
 * Пины (задача 2.1.4, STATE.md §4):
 *  - нет курсора истории + netTurns >= domTurns + у всех ходов есть вопрос →
 *    historyComplete=true, причина `passive-complete`, без probe;
 *  - A-only ход без вопроса → `historyComplete=false`, причина `missing-user-text`;
 *  - курсор истории AUtEx… → `passive-incomplete:history-cursor` (probe нужен, пассив — нет);
 *  - probe по пассивному снимку запускается ТОЛЬКО с курсором истории (AUtEx…), не с mstk;
 *  - вопрос из обёртки-эха становится userText (идемпотентно, assistantText не меняется);
 *  - dedupeTurns не теряет userText при замене формы; mergeTurnsByKey не увеличивает ходы;
 *  - состав: SPA 4 хода / 8 сообщений (4u/4a); возврат 23 хода / 45 (22u/23a) в сети,
 *    после закрытия вопроса из эха — 23u/23a (46) без добавленных ходов и дублей ответов.
 */
const fs = require('fs');
const path = require('path');

const sandbox = require('./adapters/helpers/gsa-loop-sandbox.js');
const Parser = sandbox.Parser;
const ROOT = path.join(__dirname, '..');
const SPA = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/gsa-passive-spa-8u8a.json'), 'utf8'));
const RET = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/gsa-passive-return-22u23a.json'), 'utf8'));

function harness(over) {
  const events = [];
  const ctx = {
    detectedModelSlug: 'gemini-search-default',
    domTid: '',
    domCount: 0,
    probeCalls: [],
    pendingProbeTid: '',
    swallow: function () { },
    console: { log: function () { } },
    debugLog: function () { },
    window: {
      GoogleFolwrUtils: Parser,
      dispatchEvent: function (ev) { events.push(ev.detail); }
    }
  };
  ctx.document = {
    querySelectorAll: function () { return { length: ctx.domCount }; }
  };
  ctx.readDomThreadId = function () { return ctx.domTid; };
  // Заглушка вместо сети: нас интересует только ФАКТ запуска probe и его курсор.
  ctx.probeFolwrCompleteness = function (url, turns, tid, cursor) {
    ctx.probeCalls.push({ url: url, tid: tid, cursor: cursor });
  };
  Object.assign(ctx, over || {});
  return { ctx: ctx, events: events, api: sandbox.makePassiveApi(ctx) };
}

function turnsOf(fixture) {
  return fixture.turns.map(function (t) {
    return { id: t.id, userText: t.userText, assistantText: t.assistantText };
  });
}

// Тело пассивного folif-снимка: сессионный mstk (не курсор истории).
const FOLIF_BODY = '<html><body><div data-mstk="AF_initDataCallback_mstk_1"></div></body></html>';
const HISTORY_BODY = '<html><body><div data-mstk="AUtExfTOKEN123"></div></body></html>';

describe('BUG-M: вердикт полноты пассивного снимка (без probe)', function () {
  test('netTurns >= domTurns, нет курсора истории, у всех ходов вопрос → passive-complete', function () {
    const h = harness({ domTid: SPA.threadId, domCount: SPA.turns.length });
    h.api.mergeTurns(turnsOf(SPA), true, SPA.threadId, FOLIF_BODY);
    const snap = h.api.lastFullSnapshot;
    expect(snap.historyComplete).toBe(true);
    expect(snap.historyCompleteReason).toBe('passive-complete');
    expect(h.ctx.probeCalls.length).toBe(0);
    expect(snap.messages.filter(function (m) { return m.role === 'user'; }).length).toBe(4);
    expect(snap.messages.filter(function (m) { return m.role === 'assistant'; }).length).toBe(4);
  });

  test('A-only ход без вопроса (и без эха) → missing-user-text, полнота не выдумана', function () {
    const api = harness().api;
    const snap = api.buildDetail(
      [{ id: 'x1', userText: null, assistantText: 'Ответ без обёртки и без вопроса.' }],
      null, 'TID_A_ONLY', true
    );
    expect(snap.historyComplete).toBe(false);
    expect(snap.historyCompleteReason).toBe('missing-user-text');
  });

  test('A-only ход с вопросом в обёртке-эхе считается ходом с вопросом', function () {
    const api = harness().api;
    const snap = api.buildDetail(
      [{ id: 'x2', userText: null, assistantText: 'Ответ в режиме ИИ, исходный запрос: "Вопрос из эха"\n\nТело ответа.' }],
      null, 'TID_ECHO', true
    );
    expect(snap.historyComplete).toBe(true);
    // Поле причины необязательное: полный вердикт «complete» не пишется (байтовый контракт).
    expect('historyCompleteReason' in snap).toBe(false);
  });

  test('недоказанный вердикт не защёлкивается: A-only не переводит тред в completedTids', function () {
    const api = harness().api;
    const bad = api.buildDetail([{ id: 'y1', userText: null, assistantText: 'Голый ответ.' }], null, 'TID_LATCH', true);
    expect(bad.historyComplete).toBe(false);
    expect(bad.historyCompleteReason).toBe('missing-user-text');
    // Повторный полный вердикт того же треда не поднимает полноту из защёлки.
    const later = api.buildDetail([{ id: 'y1', userText: null, assistantText: 'Голый ответ.' }], null, 'TID_LATCH', true);
    expect(later.historyComplete).toBe(false);
    expect(later.historyCompleteReason).toBe('missing-user-text');
    // А доказанный тред защёлкивается (BUG-L: монотонность вердикта).
    const good = [{ id: 'g1', userText: 'Вопрос', assistantText: 'Ответ.' }];
    api.buildDetail(good, null, 'TID_GOOD', true);
    const monotone = api.buildDetail(good, null, 'TID_GOOD', false);
    expect(monotone.historyComplete).toBe(true);
  });

  test('курсор истории AUtEx → passive-incomplete:history-cursor (нужен probe, не пассив)', function () {
    const h = harness({ domTid: SPA.threadId, domCount: SPA.turns.length });
    h.api.mergeTurns(turnsOf(SPA), true, SPA.threadId, HISTORY_BODY);
    expect(h.api.lastFullSnapshot.historyComplete).toBe(false);
    expect(h.api.lastFullSnapshot.historyCompleteReason).toBe('passive-incomplete:history-cursor');
  });

  test('netTurns < domTurns → passive-incomplete:net-lt-dom', function () {
    const h = harness({ domTid: SPA.threadId, domCount: SPA.turns.length + 1 });
    h.api.mergeTurns(turnsOf(SPA), true, SPA.threadId, FOLIF_BODY);
    expect(h.api.lastFullSnapshot.historyComplete).toBe(false);
    expect(h.api.lastFullSnapshot.historyCompleteReason).toBe('passive-incomplete:net-lt-dom');
  });

  test('чужой DOM: снимок не трогает активную базу, а кладётся в свой сегмент', function () {
    const h = harness({ domTid: 'ДРУГОЙ_ТРЕД', domCount: 99 });
    h.api.mergeTurns(turnsOf(SPA), true, SPA.threadId, FOLIF_BODY);
    expect(h.api.lastFullSnapshot).toBeNull();
    const seg = h.api.threadCache.get(SPA.threadId);
    expect(seg.turns.length).toBe(4);
  });

  test('нет живого DOM → сравнение не применяется, вердикт по составу', function () {
    const h = harness({ domTid: SPA.threadId, document: null });
    h.api.mergeTurns(turnsOf(SPA), true, SPA.threadId, FOLIF_BODY);
    expect(h.api.lastFullSnapshot.historyComplete).toBe(true);
    expect(h.api.lastFullSnapshot.historyCompleteReason).toBe('passive-complete');
  });

  test('поток (isFull=false) не доказывает полноту → passive-incomplete:stream', function () {
    const h = harness({ domTid: SPA.threadId, domCount: SPA.turns.length });
    h.api.mergeTurns(turnsOf(SPA), false, SPA.threadId, FOLIF_BODY);
    expect(h.api.lastFullSnapshot.historyComplete).toBe(false);
    expect(h.api.lastFullSnapshot.historyCompleteReason).toBe('passive-incomplete:stream');
  });
});

describe('BUG-M: probe по пассивному снимку — только с курсором истории', function () {
  test('folif mstk не запускает probe (иначе HTTP 400 probe-http-error)', function () {
    const h = harness({ pendingProbeTid: SPA.threadId });
    h.api.gsaProbeAfterPassiveSnapshot(true, 'https://www.google.com/async/folif', turnsOf(SPA), SPA.threadId, FOLIF_BODY);
    expect(h.ctx.probeCalls.length).toBe(0);
    expect(h.ctx.pendingProbeTid).toBe(SPA.threadId);
  });

  test('курсор истории AUtEx запускает probe и снимает pending', function () {
    const h = harness({ pendingProbeTid: SPA.threadId });
    h.api.gsaProbeAfterPassiveSnapshot(true, 'https://www.google.com/async/folwr', turnsOf(SPA), SPA.threadId, HISTORY_BODY);
    expect(h.ctx.probeCalls.length).toBe(1);
    expect(h.ctx.probeCalls[0].cursor).toBe('AUtExfTOKEN123');
    expect(h.ctx.pendingProbeTid).toBe('');
  });

  test('неполный (не isFull) снимок probe не запускает даже с AUtEx', function () {
    const h = harness({ pendingProbeTid: SPA.threadId });
    h.api.gsaProbeAfterPassiveSnapshot(false, 'https://www.google.com/async/folwr', turnsOf(SPA), SPA.threadId, HISTORY_BODY);
    expect(h.ctx.probeCalls.length).toBe(0);
  });
});

describe('BUG-H: вопрос из обёртки-эха и сохранение userText', function () {
  test('canonicalizeTurnForThread идемпотентен и не меняет байты assistantText', function () {
    const src = RET.turns[RET.aOnlyIndex];
    const once = Parser.canonicalizeTurnForThread(src);
    const twice = Parser.canonicalizeTurnForThread(once);
    expect(once.userText).toBe(RET.aOnlyQuestion);
    expect(twice.userText).toBe(once.userText);
    expect(twice).toEqual(once);
    expect(twice.assistantText).toBe(src.assistantText);
    expect(src.userText).toBeNull();
  });

  test('курсор истории распознаётся по AUtEx, сессионный mstk — нет', function () {
    expect(Parser.isHistoryCursor('AUtExfTOKEN123')).toBe(true);
    expect(Parser.isHistoryCursor('AUtEx')).toBe(true);
    expect(Parser.isHistoryCursor('AF_initDataCallback')).toBe(false);
    expect(Parser.isHistoryCursor('')).toBe(false);
    expect(Parser.isHistoryCursor(null)).toBe(false);
  });

  test('dedupeTurns переносит userText при замене формы более богатой', function () {
    const q = 'Вопрос хода';
    const a = 'Ответ номер один, достаточно длинный.';
    const base = { id: 't1', userText: q, assistantText: a };
    // Та же пара «вопрос+тело», но в форме обёртки-эха: userText структурно пуст.
    const richer = { id: 't1', userText: null, assistantText: 'Ответ в режиме ИИ, исходный запрос: "' + q + '"\n\n' + a };
    expect(Parser.canonicalTurnKeyOf(base)).toBe(Parser.canonicalTurnKeyOf(richer));
    const out = Parser.dedupeTurns([base, richer]);
    expect(out.length).toBe(1);
    expect(out[0].userText).toBe(q);
    expect(out[0].assistantText).toBe(richer.assistantText);
  });

  test('mergeTurnsByKey не увеличивает число ходов на DOM-формах имеющихся', function () {
    const base = turnsOf(SPA);
    const domForms = SPA.turns.map(function (t) {
      return {
        id: t.id,
        userText: null,
        assistantText: 'Ответ в режиме ИИ, исходный запрос: "' + t.userText + '"\n\n' + t.assistantText
      };
    });
    // Формы — один и тот же ход (ключ по вопросу из обёртки и телу ответа).
    expect(domForms.map(function (t) { return Parser.canonicalTurnKeyOf(t); }))
      .toEqual(base.map(function (t) { return Parser.canonicalTurnKeyOf(t); }));
    const out = Parser.mergeTurnsByKey(base, domForms);
    expect(out.length).toBe(base.length);
    expect(out.map(function (t) { return t.id; })).toEqual(base.map(function (t) { return t.id; }));
    expect(out.every(function (t) { return !!t.userText; })).toBe(true);
  });
});

describe('BUG-N: состав пассивного снимка на фикстурах 2.1.4', function () {
  test('SPA: 4 хода → 8 сообщений (4u/4a), ни одного добавленного хода', function () {
    const h = harness({ domTid: SPA.threadId, domCount: SPA.turns.length });
    h.api.mergeTurns(turnsOf(SPA), true, SPA.threadId, FOLIF_BODY);
    const snap = h.api.lastFullSnapshot;
    expect(h.api.lastFullTurns.length).toBe(4);
    expect(snap.count).toBe(8);
    expect(snap.messages.map(function (m) { return m.role; })).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    const answers = snap.messages.filter(function (m) { return m.role === 'assistant'; }).map(function (m) { return m.text; });
    expect(new Set(answers).size).toBe(4);
  });

  test('возврат: сеть 22u/23a (45), экспорт закрывает вопрос A-only хода (23u/23a) без дублей', function () {
    const raw = turnsOf(RET);
    expect(raw.length).toBe(23);
    expect(raw.filter(function (t) { return !!t.userText; }).length).toBe(22);
    expect(RET.composition).toEqual({ messages: 45, user: 22, assistant: 23 });

    const h = harness({ domTid: RET.threadId, domCount: raw.length });
    h.api.mergeTurns(raw, true, RET.threadId, FOLIF_BODY);
    const snap = h.api.lastFullSnapshot;

    expect(h.api.lastFullTurns.length).toBe(23);
    expect(snap.historyComplete).toBe(true);
    expect(snap.historyCompleteReason).toBe('passive-complete');

    const assistantRows = snap.messages.filter(function (m) { return m.role === 'assistant'; });
    const userRows = snap.messages.filter(function (m) { return m.role === 'user'; });
    expect(assistantRows.length).toBe(23);
    expect(new Set(assistantRows.map(function (m) { return m.text; })).size).toBe(23);

    // BUG-H: 17-й ход получил вопрос из обёртки-эха — это ЕДИНСТВЕННОЕ расхождение с сетью.
    expect(userRows.length).toBe(23);
    const aOnly = h.api.lastFullTurns[RET.aOnlyIndex];
    expect(aOnly.userText).toBe(RET.aOnlyQuestion);
    const restored = userRows.filter(function (m) { return m.text === RET.aOnlyQuestion; });
    expect(restored.length).toBe(1);
    for (const t of raw) {
      if (!t.userText) continue;
      const rows = userRows.filter(function (m) { return m.text === t.userText; });
      expect(rows.length).toBe(1);
    }
  });
});
