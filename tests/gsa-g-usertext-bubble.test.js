/**
 * BUG-G (gsa-usertext-bubble): A-only ход GSA теряет реплику пользователя.
 *
 * Живой дефект (тред 8bTpaveuJtWckdUP46iumAo): GSA иногда отдаёт ход БЕЗ вопроса —
 * в контейнере [data-scope-id="turn"] остаётся только заголовок-эхо h3.iMqumd
 * («Ответ в режиме ИИ, исходный запрос: "Q"»), а сам вопрос пользователя живёт
 * в DOM-пузыре рядом с контейнером. Сеть в такой форме даёт userText=null, и в
 * экспорте тред выглядит как «…A,A» (два ответа подряд, вопрос потерян).
 *
 * Правка (узкая, по каноническому ключу):
 *   1) extractEchoQuestion/resolveUserQuestionForTurn — вопрос берётся из ТЕКСТА
 *      DOM-пузыря, а эхо h3 служит ТОЛЬКО валидатором пары (normalizeTurnKeyPart).
 *      Кандидат — листовой span вне контейнеров ходов; 0 или ≥2 совпадений → null.
 *      Из эха userText НЕ синтезируется: состав ходов остаётся сетевым.
 *   2) fillMissingUserText/fillUserTextFromLiveDom — заполняют ТОЛЬКО пустой userText
 *      существующих ходов по каноническому ключу; длина/порядок/id/байты ответа не
 *      меняются, новые ходы не добавляются.
 *
 * Замер 2026-11-14 (живой DOM того же треда): 21 контейнер [data-scope-id="turn"],
 * document order ХРОНОЛОГИЧЕСКИЙ (c[0] — вопрос «deepseek fall down»), поэтому reverse
 * DOM-пути убран; реверс остался только у сетевого снимка folwr (он new→old).
 *
 * Фикстура tests/fixtures/gsa-f-merge-upgrade.json — РЕАЛЬНЫЕ байты (base18: 18 ходов /
 * userLen 7322 / asstLen 35478; q19 — 52 симв.; echo397 — 397 симв.). Полный живой
 * инвариант (39 сообщений / 7419 / 36217 / 43674) включает 20-й ход, которого в
 * фикстурах репозитория нет; здесь пинится честный 19-ходовой эквивалент:
 * 19 ходов / 37 сообщений / userLen 7374 / asstLen 35875 / textLen 43285, хвост …U,A.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// BUG-G: перехватчик проверяется ПОВЕДЕНЧЕСКИ через общую песочницу (она сама читает core;
// отдельный read продукта из нового теста запрещён behaviour-only-gate).
const SANDBOX = require('./adapters/helpers/gsa-loop-sandbox.js');
const { Parser, makeApi } = SANDBOX;
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'gsa-f-merge-upgrade.json'), 'utf8'));

const TID = FIXTURE.threadId;
const Q19 = FIXTURE.q19;
const ECHO = FIXTURE.echo397;
// Заголовок-эхо A-only хода в DOM: ровно строка-обёртка, без тела ответа.
const ECHO_LINE = 'Ответ в режиме ИИ, исходный запрос: "' + Q19 + '"';

// ---- DOM-фикстуры (jsdom): контейнер хода + ответ-чанк .n6owBd.awi2gc ---- //
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function turnBlock(o) {
  const attr = ' class="CKgc1d" data-scope-id="turn"' + (o.id ? ' jsuid="' + esc(o.id) + '"' : '');
  let head = '';
  if (o.h2) head = '<h2 class="iMqumd">' + esc(o.h2) + '</h2>';
  else if (o.h3) head = '<h3 class="iMqumd">' + esc(o.h3) + '</h3>';
  return '<div' + attr + '>' + head + '</div>' +
    (o.answer != null ? '<div class="n6owBd awi2gc">' + esc(o.answer) + '</div>' : '');
}

function bubble(text, cls) {
  return '<span class="' + (cls || 'bubble') + '">' + esc(text) + '</span>';
}

function page(parts) {
  const body = Array.isArray(parts) ? parts.join('') : String(parts || '');
  return '<div><div data-session-thread-id="' + esc(TID) + '" style="display:none"></div>' +
    '<div data-container-id="synth"></div>' + body + '</div>';
}

function docOf(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

function aOnlyDoc(q, opts) {
  const o = opts || {};
  // По умолчанию пузырь есть (это и есть живая форма A-only хода); пустой список — негатив.
  const bubbles = o.bubbles || [bubble('«' + q + '»')];
  return docOf(page(bubbles.join('') +
    turnBlock({ id: o.id || 'a1', h3: o.echo || ('Ответ в режиме ИИ, исходный запрос: "' + q + '"'), answer: o.answer || ECHO })));
}

// =====================================================================================
// T3: вопрос A-only хода из DOM-пузыря по эхо-валидации
// =====================================================================================
describe('BUG-G T3: вопрос из пузыря — эхо h3 валидирует пару, вопрос берётся из текста', () => {
  test('эхо h3 + листовой span-пузырь → текст без кавычек; hashed-классы не нужны', () => {
    const doc = docOf(page(bubble('«' + Q19 + '»', 'VndcI xEFZqe') +
      turnBlock({ id: 'a1', h3: ECHO_LINE, answer: ECHO })));
    const turnEl = doc.querySelector('[data-scope-id="turn"]');
    expect(Parser.resolveUserQuestionForTurn(doc, turnEl)).toBe(Q19);
  });

  test('обычный ход с h2 — тот же хелпер вопрос не подменяет (null)', () => {
    const doc = docOf(page(bubble('«' + Q19 + '»') +
      turnBlock({ id: 't2', h2: 'Вы сказали: "Вопрос Q2"', answer: 'Ответ Q2' })));
    const turnEl = doc.querySelector('[data-scope-id="turn"]');
    expect(Parser.resolveUserQuestionForTurn(doc, turnEl)).toBeNull();
  });

  test('эхо есть, пузыря нет → null (из эха вопрос не синтезируется)', () => {
    const doc = aOnlyDoc(Q19, { bubbles: [] });
    const turnEl = doc.querySelector('[data-scope-id="turn"]');
    expect(Parser.resolveUserQuestionForTurn(doc, turnEl)).toBeNull();
  });

  test('после закрывающей кавычки эха остался текст → это не эхо (null)', () => {
    const doc = docOf(page(bubble('«' + Q19 + '»') +
      turnBlock({ id: 'a1', h3: ECHO_LINE + ' и продолжение', answer: ECHO })));
    const turnEl = doc.querySelector('[data-scope-id="turn"]');
    expect(Parser.resolveUserQuestionForTurn(doc, turnEl)).toBeNull();
  });
});

// =====================================================================================
// T4: fail-safe — неоднозначность/иной формат не дают добора; ходы не добавляются
// =====================================================================================
describe('BUG-G T4: fail-safe — непарная или неоднозначная пара не даёт добора', () => {
  test('два кандидата, нормализованно равные эху → null', () => {
    const doc = docOf(page(bubble('«' + Q19 + '»') + bubble(Q19.replace(/\.$/, '') + '!')) +
      turnBlock({ id: 'a1', h3: ECHO_LINE, answer: ECHO }));
    const turnEl = doc.querySelector('[data-scope-id="turn"]');
    expect(Parser.resolveUserQuestionForTurn(doc, turnEl)).toBeNull();
  });

  test('вложенные span-дубли считаются ОДНИМ кандидатом (внутренний лист)', () => {
    const doc = docOf(page('<span class="outer"><span class="inner">' + esc(Q19) + '</span></span>' +
      turnBlock({ id: 'a1', h3: ECHO_LINE, answer: ECHO })));
    const turnEl = doc.querySelector('[data-scope-id="turn"]');
    expect(Parser.resolveUserQuestionForTurn(doc, turnEl)).toBe(Q19);
  });

  test('нет кандидата → userText=null, ответ сохранён, ход не синтезирован из эха', () => {
    const turns = Parser.extractTurnsFromDocument(aOnlyDoc(Q19, { bubbles: [] }));
    expect(turns.length).toBe(1);
    expect(turns[0].userText).toBeNull();
    expect(turns[0].assistantText).toBe(ECHO.trim());
  });

  test('DOM без turn-контейнеров → ходов не добавляется', () => {
    expect(Parser.extractTurnsFromDocument(docOf(page(bubble('«' + Q19 + '»'))))).toEqual([]);
  });

  test('другой язык/разметка с той же формой пары валидируется по нормализации', () => {
    const doc = docOf(page(bubble('«Hello, world!»')) +
      turnBlock({ id: 'a1', h3: 'AI answer, original query: "hello world"', answer: 'Answer' }));
    const turnEl = doc.querySelector('[data-scope-id="turn"]');
    expect(Parser.resolveUserQuestionForTurn(doc, turnEl)).toBe('Hello, world!');
  });

  test('латиница без кавычки после двоеточия — обёртки нет, добора нет (null)', () => {
    const doc = docOf(page(bubble('«Hello, world!»')) +
      turnBlock({ id: 'a1', h3: 'AI Mode answer without wrapper', answer: 'Answer' }));
    const turnEl = doc.querySelector('[data-scope-id="turn"]');
    expect(Parser.resolveUserQuestionForTurn(doc, turnEl)).toBeNull();
  });
});

// =====================================================================================
// T5: extractTurnsFromDocument — h2-путь байтово прежний, A-only получает вопрос,
//     порядок DOM — хронологический (document order), reverse убран
// =====================================================================================
describe('BUG-G T5: DOM-путь — хронологический порядок и вопрос A-only хода', () => {
  test('A-only ход получает вопрос из пузыря, h2-ход не меняется, порядок document order', () => {
    const doc = docOf(page(
      bubble('«Вопрос Q1»') +
      turnBlock({ id: 'a1', h3: 'Ответ в режиме ИИ, исходный запрос: "Вопрос Q1"', answer: 'Ответ A1' }) +
      turnBlock({ id: 't2', h2: 'Вы сказали: "Вопрос Q2"', answer: 'Ответ A2' })
    ));
    const turns = Parser.extractTurnsFromDocument(doc);
    expect(turns.map((t) => t.id)).toEqual(['a1', 't2']);
    expect(turns[0].userText).toBe('Вопрос Q1');
    expect(turns[0].assistantText).toBe('Ответ A1');
    expect(turns[1].userText).toBe('Вопрос Q2');
    expect(turns[1].assistantText).toBe('Ответ A2');
  });

  test('h2-путь байтово прежний (внутренние кавычки вопроса сохраняются)', () => {
    const raw = 'Вы сказали: "Как дела, "друг"?"';
    const doc = docOf(page(turnBlock({ id: 't1', h2: raw, answer: 'Ответ' })));
    const turns = Parser.extractTurnsFromDocument(doc);
    expect(turns.length).toBe(1);
    expect(turns[0].userText).toBe('Как дела, "друг"?');
  });

});

// =====================================================================================
// T6: fillMissingUserText — узкий добор: только пустой userText, без новых ходов
// =====================================================================================
describe('BUG-G T6: fillMissingUserText заполняет только пустой userText по ключу', () => {
  const base = [
    { id: 'b1', userText: null, assistantText: ECHO },
    { id: 'b2', userText: 'Вопрос 2', assistantText: 'Ответ 2' }
  ];
  const extra = [{ id: 'd1', userText: Q19, assistantText: ECHO }];

  test('длина/порядок/id/assistantText не меняются, вход не мутируется', () => {
    const out = Parser.fillMissingUserText(base, extra);
    expect(out.length).toBe(2);
    expect(out[0].id).toBe('b1');
    expect(out[0].userText).toBe(Q19);
    expect(out[0].assistantText).toBe(ECHO);
    expect(out[1]).toBe(base[1]);
    expect(base[0].userText).toBeNull();
  });

  test('два РАЗНЫХ текста на один ключ → пропуск (пара неоднозначна)', () => {
    const twin = { id: 'd2', userText: Q19.replace(/\.$/, ''), assistantText: ECHO };
    const out = Parser.fillMissingUserText(base, [extra[0], twin]);
    expect(out).toBe(base);
    expect(out[0].userText).toBeNull();
  });

  test('лишний extra не добавляет ход и не трогает заполненные вопросы', () => {
    const out = Parser.fillMissingUserText([base[1]], [extra[0], { id: 'd3', userText: 'Другой', assistantText: 'Другой ответ' }]);
    expect(out.length).toBe(1);
    expect(out[0]).toBe(base[1]);
  });

  test('пустые/невалидные входы не бросают', () => {
    expect(Parser.fillMissingUserText(null, extra)).toEqual([]);
    expect(Parser.fillMissingUserText(base, null)).toBe(base);
    expect(Parser.fillMissingUserText(base, [])).toBe(base);
  });
});

// =====================================================================================
// T7: mergeTurnsByKey — fill-only при совпадении ключа и перенос вопроса при повышении
// =====================================================================================
describe('BUG-G T7: mergeTurnsByKey — fill-only и перенос уже добытого вопроса', () => {
  test('сеть длиннее (A-only) + DOM с вопросом → id/байты сети, вопрос из DOM', () => {
    const net = { id: 'net19', userText: null, assistantText: ECHO + '\n\n' };
    const dom = { id: 'dom19', userText: Q19, assistantText: ECHO };
    const out = Parser.mergeTurnsByKey([net], [dom]);
    expect(out.length).toBe(1);
    expect(out[0].id).toBe('net19');
    expect(out[0].userText).toBe(Q19);
    expect(out[0].assistantText).toBe(ECHO + '\n\n');
  });

  test('богаче сеть (длиннее ответ) → вопрос переносится в форму сети', () => {
    const dom = { id: 'dom19', userText: Q19, assistantText: ECHO };
    const net = { id: 'net19', userText: null, assistantText: ECHO + '\n\n' };
    const out = Parser.mergeTurnsByKey([dom], [net]);
    expect(out.length).toBe(1);
    expect(out[0].id).toBe('net19');
    expect(out[0].userText).toBe(Q19);
    expect(out[0].assistantText).toBe(ECHO + '\n\n');
  });

  test('непарный ход не добавляет вопрос и не создаёт новый ход', () => {
    const base = [{ id: 'b1', userText: null, assistantText: ECHO }];
    const out = Parser.mergeTurnsByKey(base, [{ id: 'd9', userText: 'Не тот вопрос', assistantText: 'Не тот ответ' }]);
    expect(out.length).toBe(2);                       // ход DOM — новый ход, но не добор
    expect(out[0].userText).toBeNull();
    const onlyBase = Parser.mergeTurnsByKey(base, []);
    expect(onlyBase.length).toBe(1);
    expect(onlyBase[0].userText).toBeNull();
  });
});

// =====================================================================================
// T8: fillUserTextFromLiveDom (перехватчик) — поведение и все пропуски
// =====================================================================================
function fillCtx(opts) {
  const o = opts || {};
  const state = { reads: 0 };
  const ctx = {};
  Object.defineProperty(ctx, 'document', {
    get: function () { state.reads++; return o.doc; }
  });
  if (o.withWindow !== false) ctx.window = { GoogleFolwrUtils: (o.utils === undefined ? Parser : o.utils) };
  if (o.withReader !== false) ctx.readDomThreadId = o.reader || function () { return TID; };
  return { ctx: ctx, state: state, fill: makeApi(ctx).fillUserTextFromLiveDom };
}

describe('BUG-G T8: fillUserTextFromLiveDom — добор только из своего живого DOM', () => {
  const netTurns = [{ id: 'net19', userText: null, assistantText: ECHO }];

  test('совпавший threadId: вопрос заполнен, id и байты ответа прежние, ход один', () => {
    const h = fillCtx({ doc: aOnlyDoc(Q19) });
    const out = h.fill(netTurns, TID);
    expect(out.length).toBe(1);
    expect(out[0].id).toBe('net19');
    expect(out[0].userText).toBe(Q19);
    expect(out[0].assistantText).toBe(ECHO);
    expect(netTurns[0].userText).toBeNull();
    expect(h.state.reads).toBeGreaterThan(0);
  });

  test('чужой threadId → без изменений (DOM чужого треда не источник)', () => {
    const h = fillCtx({ doc: aOnlyDoc(Q19), reader: function () { return 'thread-other'; } });
    expect(h.fill(netTurns, TID)).toBe(netTurns);
  });

  test('нет пустых userText → skip без чтения DOM', () => {
    const h = fillCtx({ doc: aOnlyDoc(Q19) });
    const full = [{ id: 'b1', userText: 'Вопрос', assistantText: 'Ответ' }];
    expect(h.fill(full, TID)).toBe(full);
    expect(h.state.reads).toBe(0);
  });

  test('в utils нет fillMissingUserText → skip', () => {
    const h = fillCtx({ doc: aOnlyDoc(Q19), utils: { extractTurnsFromDocument: function () { return []; } } });
    expect(h.fill(netTurns, TID)).toBe(netTurns);
  });

  test('разбор DOM бросил → turns без изменений (try/catch)', () => {
    const h = fillCtx({
      doc: aOnlyDoc(Q19),
      utils: {
        extractTurnsFromDocument: function () { throw new Error('boom'); },
        fillMissingUserText: Parser.fillMissingUserText
      }
    });
    expect(h.fill(netTurns, TID)).toBe(netTurns);
  });

  test('нет document / нет GoogleFolwrUtils → skip', () => {
    const noDoc = fillCtx({ doc: undefined });
    expect(noDoc.fill(netTurns, TID)).toBe(netTurns);
    const noWin = fillCtx({ doc: aOnlyDoc(Q19), utils: null });
    expect(noWin.fill(netTurns, TID)).toBe(netTurns);
  });
});

// =====================================================================================
// T9: сквозной пин на РЕАЛЬНЫХ байтах треда + порядок вызовов в перехватчике
// =====================================================================================
// Песочница предоставляет НАСТОЯЩИЕ mergeTurns/fillUserTextFromLiveDom/messagesFromTurns
// из core/google-search-intercept.js — поведение, не чтение исходника.


function interceptCtx(over) {
  const events = [];
  const logs = [];
  const diag = [];
  const ctx = {
    MAX_CACHE_ENTRIES: 10,
    threadCache: new Map(),
    seenKeys: {},
    currentThreadId: TID,
    emittedThreadId: '',
    baseThreadId: '',
    detectedModelSlug: 'gemini-2.5-flash',
    domTid: TID,
    console: { log: function () { } },
    debugLog: function (lvl, msg) { logs.push(String(msg)); },
    aiCmDiagLine: function (name, fields) { diag.push({ name: name, fields: fields }); },
    window: {
      GoogleFolwrUtils: Parser,
      parseGoogleFolwrOpen: Parser.parseGoogleFolwrOpen,
      dispatchEvent: function (ev) { events.push(ev.detail); }
    }
  };
  ctx.readDomThreadId = function () { return ctx.domTid; };
  Object.assign(ctx, over || {});
  return { ctx: ctx, events: events, logs: logs, diag: diag, api: makeApi(ctx) };
}

function turn(id, q, a) {
  return { id: id, userText: q, assistantText: a };
}

const BASE18 = FIXTURE.base18.map((t) => turn(t.id, t.userText, t.assistantText));
const NET19 = turn('net19', null, ECHO);
const BASE19 = BASE18.concat([NET19]);

function msgStats(messages) {
  let userLen = 0;
  let asstLen = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') userLen += messages[i].text.length;
    else asstLen += messages[i].text.length;
  }
  return { count: messages.length, userLen: userLen, asstLen: asstLen };
}

function tailRoles(messages, n) {
  return messages.slice(-n).map((m) => (m.role === 'user' ? 'U' : 'A')).join(',');
}

describe('BUG-G T9: сквозной пин 19-ходового эквивалента треда (реальные байты)', () => {
  test('A-only 19-й ход: вопрос из DOM-пузыря, 37 сообщений, хвост …U,A, id и байты сети', () => {
    const h = interceptCtx({ document: aOnlyDoc(Q19) });
    h.api.mergeTurns(BASE18, true);
    expect(h.api.lastFullTurns.length).toBe(18);
    expect(h.api.lastFullMessages.length).toBe(35);

    h.api.mergeTurns(BASE19, false);              // 19-й ход пришёл БЕЗ вопроса

    const st = msgStats(h.api.lastFullMessages);
    expect(h.api.lastFullTurns.length).toBe(19);
    expect(st.count).toBe(37);
    expect(st.userLen).toBe(7374);                 // 7322 + q19 (52)
    expect(st.asstLen).toBe(35875);
    expect(h.api.lastFullSnapshot.text.length).toBe(43285);
    expect(h.api.lastFullSnapshot.count).toBe(37);
    expect(tailRoles(h.api.lastFullMessages, 2)).toBe('U,A');

    expect(h.api.lastFullTurns[18].id).toBe('net19');       // id хода — сетевой
    expect(h.api.lastFullTurns[18].userText).toBe(Q19);     // вопрос — из пузыря
    expect(h.api.lastFullTurns[18].assistantText).toBe(ECHO); // байты ответа не сдвинуты
    // A17-эхо (единственный A-only ход базы) свой ключ имеет — чужой вопрос к нему не липнет.
    const a17 = BASE18.findIndex((t) => !t.userText);
    expect(a17).toBeGreaterThan(-1);
    expect(h.api.lastFullTurns[a17].userText).toBeNull();
    expect(h.api.lastFullTurns[a17].assistantText).toBe(BASE18[a17].assistantText);
    expect(h.api.lastFullSnapshot.text).not.toContain('Что-то пошло не так');
    expect(h.api.lastFullTurns[0].assistantText).toBe(BASE18[0].assistantText);
  });

});
