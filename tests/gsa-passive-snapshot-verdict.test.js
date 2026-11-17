'use strict';
/**
 * BUG-M / BUG-N / BUG-H: вердикт полноты ПАССИВНОГО снимка и состав слияния.
 *
 * Тест поведенческий: продукт не читается — реальные функции перехватчика приходят из
 * общей песочницы tests/adapters/helpers/gsa-loop-sandbox.js (makePassiveApi), вход —
 * фикстуры состава 2.1.4, выход — снимок (история/причина/сообщения) и факт запуска probe.
 *
 * Пины (задача 2.1.4, STATE.md §4, BUG-M/BUG-O):
 *  - netTurns >= ИСПОЛЬЗУЕМЫХ domTurns + у всех ходов есть вопрос → historyComplete=true,
 *    причина `passive-complete`, без probe;
 *  - A-only ход без вопроса → `historyComplete=false`, причина `missing-user-text`;
 *  - сессионный mstk AUtEx… в пассивном теле — НЕ признак неполноты: после тишины снимок
 *    полный (BUG-M: токен стоит в URL страницы и эхо-повторяется в теле);
 *  - probe по пассивному снимку запускается ТОЛЬКО с курсором истории (AUtEx…), не с mstk;
 *  - domTurns считаются после dedupe/canonicalize: 24 контейнера / 23 используемых хода →
 *    net>=dom проходит (контейнер ошибки/регенерации — вторая форма того же хода);
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

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Живой DOM одного хода: контейнер turn + h2-вопрос + aimfl-ответ (форма GSA).
function domTurnHtml(t) {
  const q = t.userText ? String(t.userText) : '';
  return '<div data-scope-id="turn" jsuid="' + t.id + '">' +
    (q ? '<h2 class="iMqumd">Вы сказали: "' + escHtml(q) + '"</h2>' : '') +
    '<div data-subtree="aimfl">' + escHtml(t.assistantText || '') + '</div>' +
    '</div>';
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

  test('AUtEx… в пассивном теле — сессионный mstk, а не «не полон»: снимок complete', function () {
    const h = harness({ domTid: SPA.threadId, domCount: SPA.turns.length });
    h.api.mergeTurns(turnsOf(SPA), true, SPA.threadId, HISTORY_BODY);
    expect(h.api.lastFullSnapshot.historyComplete).toBe(true);
    expect(h.api.lastFullSnapshot.historyCompleteReason).toBe('passive-complete');
    expect(String(h.api.lastFullSnapshot.historyCompleteReason || '')).not.toContain('history-cursor');
  });

  test('netTurns < domTurns → passive-incomplete:net-lt-dom', function () {
    const h = harness({ domTid: SPA.threadId, domCount: SPA.turns.length + 1 });
    h.api.mergeTurns(turnsOf(SPA), true, SPA.threadId, FOLIF_BODY);
    expect(h.api.lastFullSnapshot.historyComplete).toBe(false);
    expect(h.api.lastFullSnapshot.historyCompleteReason).toBe('passive-incomplete:net-lt-dom');
  });

  test('24 сырых контейнера / 23 используемых хода → net>=dom проходит (dedupe как у базы)', function () {
    const html = '<div><div data-session-thread-id="' + RET.threadId + '"></div>' +
      RET.turns.map(domTurnHtml).join('') + domTurnHtml(RET.turns[0]) + '</div>';
    const domDoc = new DOMParser().parseFromString(html, 'text/html');
    const h = harness({ domTid: RET.threadId, document: domDoc });
    // Сырых контейнеров 24, но контейнер регенерации — вторая форма того же хода.
    expect(domDoc.querySelectorAll('[data-scope-id="turn"]').length).toBe(24);
    const dom = h.api.passiveDomTurns(RET.threadId);
    expect(dom.count).toBe(23);
    // A-only ход 16 (вопрос только в обёртке-эха) в множество вопросов DOM не входит.
    expect(dom.questions.length).toBe(22);
    h.api.mergeTurns(turnsOf(RET), true, RET.threadId, FOLIF_BODY);
    expect(h.api.lastFullSnapshot.historyComplete).toBe(true);
    expect(h.api.lastFullSnapshot.historyCompleteReason).toBe('passive-complete');
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

/**
 * BUG-M (2.1.4, High): признак полноты ПАССИВНОГО снимка — «поток успокоился», а НЕ тип
 * запроса. Живой путь GSA — только /folif, full=1 не встречается, поэтому прежний гейт
 * `if (isFull !== true) return 'passive-incomplete:stream'` держал baseComplete в 0 вечно.
 * Теперь тишина доказывается per-tid debounce: SETTLE_MS (1000) от ПОСЛЕДНЕГО чанка, и по
 * таймеру снимок переэмитится как полный тем же emitDetail (baseComplete/латч/бейдж/
 * автоэкспорт обновляются штатно).
 */
describe('BUG-M 2.1.4: тишина потока (settle) как признак полноты folif-снимка', function () {
  function roles(snap) {
    return {
      user: snap.messages.filter(function (m) { return m.role === 'user'; }).length,
      assistant: snap.messages.filter(function (m) { return m.role === 'assistant'; }).length
    };
  }

  test('чанк + тишина без роста текста → passive-complete, historyComplete=1, partial нет', function () {
    const h = harness({ domTid: SPA.threadId, domCount: SPA.turns.length });
    h.api.mergeTurns(turnsOf(SPA), false, SPA.threadId, FOLIF_BODY);
    // до срабатывания таймера снимок неполный (baseComplete не взведён)
    expect(h.api.lastFullSnapshot.historyComplete).toBe(false);
    expect(h.api.lastFullSnapshot.historyCompleteReason).toBe('passive-incomplete:stream');
    expect(h.api.gsaSettleRow(SPA.threadId).settled).toBe(false);
    expect(h.events.length).toBe(1);

    h.api.gsaSettleFlush(SPA.threadId); // таймер сработал, состав не вырос

    const done = h.api.lastFullSnapshot;
    expect(h.api.gsaSettleRow(SPA.threadId).settled).toBe(true);
    expect(done.historyComplete).toBe(true);
    expect(done.historyCompleteReason).toBe('passive-complete');
    // переэмит тем же emitDetail: второй кадр уже полный
    expect(h.events.length).toBe(2);
    expect(h.events[1].historyComplete).toBe(true);
    expect(h.events[1].count).toBe(8);
    // partial нет: у полного снимка не остаётся неполной причины
    expect(String(done.historyCompleteReason || '').indexOf('passive-incomplete')).toBe(-1);
    expect(h.ctx.probeCalls.length).toBe(0);
    expect(h.api.threadCache.get(SPA.threadId).snapshot.historyComplete).toBe(true);
  });

  test('чанк до срабатывания таймера: ни один эмит не взводит baseComplete', function () {
    const h = harness({ domTid: SPA.threadId, domCount: SPA.turns.length });
    h.api.mergeTurns(turnsOf(SPA), false, SPA.threadId, FOLIF_BODY);
    h.api.mergeTurns(turnsOf(SPA).slice(0, 3), false, SPA.threadId, FOLIF_BODY);
    expect(h.events.length).toBeGreaterThan(0);
    expect(h.events.every(function (e) { return e.historyComplete !== true; })).toBe(true);
    expect(h.api.threadCache.get(SPA.threadId).snapshot.historyComplete).toBe(false);
  });

  test('рост состава после взвода (applyTurns) → тишина не доказана, переэмита нет', function () {
    const h = harness({ domTid: SPA.threadId, domCount: SPA.turns.length });
    h.api.mergeTurns(turnsOf(SPA), false, SPA.threadId, FOLIF_BODY);
    h.api.applyTurns([{ id: 'extra1', userText: 'Ещё вопрос', assistantText: 'Ещё ответ' }], SPA.threadId, false, FOLIF_BODY, 'append');
    const grown = h.events.length;
    expect(h.api.lastFullTurns.length).toBe(5);

    h.api.gsaSettleFlush(SPA.threadId); // отпечаток разошёлся с взведённым

    expect(h.events.length).toBe(grown);
    expect(h.api.lastFullSnapshot.historyComplete).toBe(false);
    expect(h.api.gsaSettleRow(SPA.threadId).settled).toBe(false);
  });

  test('AUtEx… + тишина → complete: probe не требуется, partial не выставляется', function () {
    const h = harness({ domTid: SPA.threadId, domCount: SPA.turns.length });
    h.api.mergeTurns(turnsOf(SPA), false, SPA.threadId, HISTORY_BODY);
    expect(h.api.lastFullSnapshot.historyComplete).toBe(false);
    const before = h.events.length;
    h.api.gsaSettleFlush(SPA.threadId);
    expect(h.events.length).toBe(before + 1);
    expect(h.events[h.events.length - 1].historyComplete).toBe(true);
    expect(h.api.lastFullSnapshot.historyComplete).toBe(true);
    expect(h.api.lastFullSnapshot.historyCompleteReason).toBe('passive-complete');
    expect(h.ctx.probeCalls.length).toBe(0);
  });

  test('domTurns больше netTurns на потоке → net-lt-dom (счёт до любых return)', function () {
    const h = harness({ domTid: SPA.threadId, domCount: SPA.turns.length + 2 });
    h.api.mergeTurns(turnsOf(SPA), false, SPA.threadId, FOLIF_BODY);
    expect(h.api.lastFullSnapshot.historyCompleteReason).toBe('passive-incomplete:net-lt-dom');
    const before = h.events.length;
    h.api.gsaSettleFlush(SPA.threadId);
    expect(h.events.length).toBe(before);
    expect(h.api.lastFullSnapshot.historyComplete).toBe(false);
  });

  test('пустой вопрос важнее тишины: missing-user-text, а не passive-complete', function () {
    const h = harness({ domTid: 'TID_Q', domCount: 0 });
    const one = [{ id: 'q1', userText: '', assistantText: 'Ответ без вопроса' }];
    expect(h.api.passiveVerdictOf(one, 'TID_Q', null, true).reason).toBe('passive-incomplete:missing-user-text');
    // порядок проверок: пустой вопрос перекрывает и «поток»
    expect(h.api.passiveVerdictOf(one, 'TID_Q', null, false).reason).toBe('passive-incomplete:missing-user-text');
  });

  test('составы на settled-снимке: 8 (4u/4a), 16 (8u/8a), 46 (23u/23a)', function () {
    const spa = harness({ domTid: SPA.threadId, domCount: SPA.turns.length });
    spa.api.mergeTurns(turnsOf(SPA), false, SPA.threadId, FOLIF_BODY);
    spa.api.gsaSettleFlush(SPA.threadId);
    expect(spa.api.lastFullSnapshot.count).toBe(8);
    expect(roles(spa.api.lastFullSnapshot)).toEqual({ user: 4, assistant: 4 });

    // Эквивалент живого SPA-треда 16 (8u/8a): фикстуры нет — 8 разных ходов
    const eight = [];
    for (let i = 0; i < 8; i++) eight.push({ id: 'c' + i, userText: 'Вопрос ' + i, assistantText: 'Ответ ' + i });
    const big = harness({ domTid: 'TID8', domCount: 8 });
    big.api.mergeTurns(eight, false, 'TID8', FOLIF_BODY);
    expect(big.api.lastFullSnapshot.historyComplete).toBe(false);
    big.api.gsaSettleFlush('TID8');
    expect(big.api.lastFullSnapshot.count).toBe(16);
    expect(roles(big.api.lastFullSnapshot)).toEqual({ user: 8, assistant: 8 });
    expect(big.api.lastFullSnapshot.historyComplete).toBe(true);

    const ret = harness({ domTid: RET.threadId, domCount: RET.turns.length });
    ret.api.mergeTurns(turnsOf(RET), false, RET.threadId, FOLIF_BODY);
    ret.api.gsaSettleFlush(RET.threadId);
    expect(ret.api.lastFullSnapshot.count).toBe(46);
    expect(roles(ret.api.lastFullSnapshot)).toEqual({ user: 23, assistant: 23 });
    expect(ret.api.lastFullSnapshot.historyComplete).toBe(true);
  });

  test('таймер: перевзвод от последнего чанка, снятие при смене треда, пропуск чужого DOM', function () {
    jest.useFakeTimers();
    try {
      const h = harness({ domTid: SPA.threadId, domCount: SPA.turns.length });
      h.api.mergeTurns(turnsOf(SPA), false, SPA.threadId, FOLIF_BODY);
      expect(h.events.length).toBe(1);

      jest.advanceTimersByTime(400);
      h.api.mergeTurns(turnsOf(SPA).slice(0, 3), false, SPA.threadId, FOLIF_BODY);
      expect(h.events.length).toBe(2);

      jest.advanceTimersByTime(700); // 700 мс тишины от последнего чанка — мало
      expect(h.events.length).toBe(2);

      jest.advanceTimersByTime(400); // 1100 мс — таймер сработал
      expect(h.events.length).toBe(3);
      expect(h.events[2].historyComplete).toBe(true);
      expect(h.api.lastFullSnapshot.historyCompleteReason).toBe('passive-complete');

      // смена треда: незавершённый таймер прежнего треда снимается
      const h2 = harness({ domTid: 'TID_A', domCount: 1 });
      h2.api.mergeTurns([{ id: 'a1', userText: 'Вопрос', assistantText: 'Ответ' }], false, 'TID_A', FOLIF_BODY);
      const marked = h2.events.length;
      h2.api.activateThread('TID_B');
      jest.advanceTimersByTime(5000);
      expect(h2.events.length).toBe(marked);

      // тред перестал быть активным (чужой DOM) — выход без эмита
      const h3 = harness({ domTid: 'TID_X', domCount: 1 });
      h3.api.mergeTurns([{ id: 'x1', userText: 'Вопрос', assistantText: 'Ответ' }], false, 'TID_X', FOLIF_BODY);
      const n3 = h3.events.length;
      h3.ctx.domTid = 'ДРУГОЙ_ТРЕД';
      h3.api.gsaSettleFlush('TID_X');
      expect(h3.events.length).toBe(n3);
      expect(h3.api.lastFullSnapshot.historyComplete).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test('поздний чанк после settle не роняет доказанную полноту (монотонность)', function () {
    const h = harness({ domTid: SPA.threadId, domCount: SPA.turns.length });
    h.api.mergeTurns(turnsOf(SPA), false, SPA.threadId, FOLIF_BODY);
    h.api.gsaSettleFlush(SPA.threadId);
    expect(h.api.lastFullSnapshot.historyComplete).toBe(true);

    h.api.mergeTurns([{ id: 'n1', userText: 'Новый вопрос', assistantText: 'Новый ответ' }], false, SPA.threadId, FOLIF_BODY);
    expect(h.api.lastFullSnapshot.historyComplete).toBe(true);
    expect(h.api.lastFullSnapshot.count).toBe(10);
  });
});

/**
 * BUG-P 2.1.4 (High): признак полноты пассивного снимка — ПОКРЫТИЕ ВОПРОСОВ базы, а не число
 * DOM-контейнеров. Контейнер второй ФОРМЫ ОТВЕТА на уже известный вопрос (stub «Что-то пошло
 * не так…» + полный ответ, разные jsuid, тела не prefix-совместимы) — не новый ход: dedupe его
 * не схлопывает, и прежний счётчик давал net=23 / dom=24 → net-lt-dom навсегда
 * (historyComplete=0 → partial → [LOW CONFIDENCE]_ → автоэкспорт пропущен).
 *
 * Пины: живая форма 23 базы + 24 контейнера (stub 5f + полный ft) → complete, 46 (23u/23a);
 * новый вопрос в DOM, которого нет в базе → incomplete; A-only DOM-ход → complete;
 * 24 сырых / 23 используемых → complete; сбой разбора → фолбэк на счётчик; повтор вопроса с
 * двумя полными ответами, оба есть в базе → complete.
 */
describe('BUG-P 2.1.4: полнота по покрытию вопросов, а не по числу контейнеров', function () {
  const STUB = 'Что-то пошло не так. Искусственному интеллекту не удалось создать ответ.';

  function htmlOfTurn(t, body, id) {
    const q = t.userText ? String(t.userText) : '';
    return '<div data-scope-id="turn" jsuid="' + escHtml(id || t.id) + '">' +
      (q ? '<h2 class="iMqumd">Вы сказали: "' + escHtml(q) + '"</h2>' : '') +
      '<div data-subtree="aimfl">' + escHtml(body == null ? (t.assistantText || '') : body) + '</div>' +
      '</div>';
  }

  function docOf(tid, htmls) {
    return new DOMParser().parseFromString(
      '<div><div data-session-thread-id="' + tid + '"></div>' + htmls.join('') + '</div>',
      'text/html'
    );
  }

  test('живая форма: 23 базы + 24 контейнера (stub 5f + полный ft) → complete, 46 (23u/23a)', function () {
    // Контейнер-двойник: ТОТ ЖЕ вопрос (h2), тело-заглушка другого jsuid — как JRy2Fc_5f/ft.
    const full = RET.turns[5];
    const htmls = RET.turns.map(function (t) { return htmlOfTurn(t); })
      .concat([htmlOfTurn(full, STUB, 'JRy2Fc_5f')]);
    const domDoc = docOf(RET.threadId, htmls);
    const h = harness({ domTid: RET.threadId, document: domDoc });
    expect(domDoc.querySelectorAll('[data-scope-id="turn"]').length).toBe(24);

    const dom = h.api.passiveDomTurns(RET.threadId);
    // Контейнеров 24 (тела не схлопываются), вопросов — 22 уникальных: двойник не новый
    // вопрос, а A-only ход 16 (вопрос только в эхе) вопроса не добавляет.
    expect(dom.count).toBe(24);
    expect(dom.questions.length).toBe(22);

    h.api.mergeTurns(turnsOf(RET), true, RET.threadId, FOLIF_BODY);
    const snap = h.api.lastFullSnapshot;
    expect(snap.historyComplete).toBe(true);
    expect(snap.historyCompleteReason).toBe('passive-complete');
    expect(snap.count).toBe(46);
    expect(snap.messages.filter(function (m) { return m.role === 'user'; }).length).toBe(23);
    expect(snap.messages.filter(function (m) { return m.role === 'assistant'; }).length).toBe(23);
    expect(h.ctx.probeCalls.length).toBe(0);
  });

  test('новый вопрос в DOM, которого нет в базе → incomplete (покрытие не выполнено)', function () {
    const extra = { id: 'new1', userText: 'Совсем новый вопрос, которого нет в сети', assistantText: 'Ответ на новый вопрос.' };
    const htmls = RET.turns.map(function (t) { return htmlOfTurn(t); }).concat([htmlOfTurn(extra)]);
    const h = harness({ domTid: RET.threadId, document: docOf(RET.threadId, htmls) });

    h.api.mergeTurns(turnsOf(RET), true, RET.threadId, FOLIF_BODY);
    expect(h.api.lastFullSnapshot.historyComplete).toBe(false);
    expect(h.api.lastFullSnapshot.historyCompleteReason).toBe('passive-incomplete:net-lt-dom');
    // База не тронута: DOM-ходы в базу не дописываются (fill-only).
    expect(h.api.lastFullTurns.length).toBe(23);
  });

  test('A-only DOM-ход (без вопроса) контейнером больше не считается → complete', function () {
    // 5 контейнеров: 4 хода SPA + A-only двойник первого ответа (эхо-вопрос в теле, без h2).
    const echoBody = 'Ответ в режиме ИИ, исходный запрос: "' + SPA.turns[0].userText + '"\n\nДругой ответ.';
    const htmls = SPA.turns.map(function (t) { return htmlOfTurn(t); })
      .concat([htmlOfTurn({ userText: null }, echoBody, 'aonly1')]);
    const domDoc = docOf(SPA.threadId, htmls);
    const h = harness({ domTid: SPA.threadId, document: domDoc });
    expect(domDoc.querySelectorAll('[data-scope-id="turn"]').length).toBe(5);

    const dom = h.api.passiveDomTurns(SPA.threadId);
    expect(dom.count).toBe(5);          // контейнеры не схлопнулись
    expect(dom.questions.length).toBe(4); // вопросов ровно 4 — A-only вопроса не добавляет

    h.api.mergeTurns(turnsOf(SPA), true, SPA.threadId, FOLIF_BODY);
    expect(h.api.lastFullSnapshot.historyComplete).toBe(true);
    expect(h.api.lastFullSnapshot.historyCompleteReason).toBe('passive-complete');
  });

  test('сбой разбора DOM → фолбэк на счётчик (не 0), вердикт прежний', function () {
    const broken = Object.assign({}, Parser, {
      extractTurnsFromDocument: function () { throw new Error('разбор сломан'); }
    });
    const h = harness({ domTid: SPA.threadId, domCount: SPA.turns.length + 1, window: { GoogleFolwrUtils: broken, dispatchEvent: function () { } } });
    const dom = h.api.passiveDomTurns(SPA.threadId);
    expect(dom.count).toBe(5);       // счётчик контейнеров, не 0
    expect(dom.questions.length).toBe(0);
    h.api.mergeTurns(turnsOf(SPA), true, SPA.threadId, FOLIF_BODY);
    expect(h.api.lastFullSnapshot.historyCompleteReason).toBe('passive-incomplete:net-lt-dom');

    // Тот же сбой, но контейнеров не больше состава → прежний счётчик пропускает снимок.
    const ok = harness({ domTid: SPA.threadId, domCount: SPA.turns.length, window: { GoogleFolwrUtils: broken, dispatchEvent: function () { } } });
    ok.api.mergeTurns(turnsOf(SPA), true, SPA.threadId, FOLIF_BODY);
    expect(ok.api.lastFullSnapshot.historyComplete).toBe(true);
    expect(ok.api.lastFullSnapshot.historyCompleteReason).toBe('passive-complete');
  });

  test('повтор вопроса с двумя полными ответами, оба есть в базе → complete', function () {
    const base = turnsOf(RET).slice();
    const twin = { id: 'twin1', userText: RET.turns[7].userText, assistantText: 'Ответ 8бис. Повторная проверка узла связи завершена успешно.' };
    base.push(twin);
    const htmls = base.map(function (t) { return htmlOfTurn(t); });
    const h = harness({ domTid: RET.threadId, document: docOf(RET.threadId, htmls) });
    const dom = h.api.passiveDomTurns(RET.threadId);
    expect(dom.count).toBe(24);
    expect(dom.questions.length).toBe(22); // twin — тот же вопрос, A-only вопроса не даёт

    h.api.mergeTurns(base, true, RET.threadId, FOLIF_BODY);
    const snap = h.api.lastFullSnapshot;
    expect(snap.historyComplete).toBe(true);
    expect(snap.historyCompleteReason).toBe('passive-complete');
    // Дубль вопроса не превратился в дубль сообщения: два РАЗНЫХ ответа = два хода.
    expect(snap.count).toBe(48);
  });
});
