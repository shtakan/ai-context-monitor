/**
 * BUG-E (gsa-late-question): после SPA-возврата GSA отдаёт последний ход «разорванным»:
 * вопрос приходит отдельным ходом «только user», а ответ уже лежит ходом «только
 * assistant» с эхом вопроса ВНУТРИ текста («Ответ в режиме ИИ, исходный запрос: "Q" A»).
 * findPrefixCompatibleIndex требует обе части хода (u и a) → склейки нет, mergeTurns
 * дописывает вопрос в хвост → в файле вопрос стоит ПОСЛЕ своего ответа (11-52: 35
 * сообщений, хвост …A A U). Инвариант: база содержит один ход на обмен.
 *
 * Фикстура (tests/fixtures/gsa-e-tail-question.json) — РЕАЛЬНЫЕ БАЙТЫ треда
 * 8bTpaveuJtWckdUP46iumAo (экспорты 11-48/11-52 от 2026-11-14 и лог 11:52:35):
 *   q18     103 B — вопрос Q18 с «\n\n» и внутренними кавычками («…в папку "спам"…»);
 *   echo962 962 B — эхо-ответ A18 18-го хода (обёртка «Ответ в режиме ИИ …» + вопрос + тело);
 *   q141    141 B — эхо-ВОПРОС без тела ответа (19-й ход окна passive-folif: 37 B префикса
 *                   + q18 + закрывающая кавычка; лог: incoming userLen=7425 asstLen=35619);
 *   a17    1669 B — эхо-ответ «API DeepSeek полностью восстановлен» (17-й ход);
 *   full     16 полных ходов — вопросы 7219 B / ответы 32847 B.
 * Живая последовательность (лог www.google.com-*.log):
 *   11:48:35  mergeTurns accept shape=turns=18 userLen=7219 asstLen=35478 msgs=34 textLen=42730
 *   11:52:35  passive-folif shape=turns=19 empty=0 userLen=7425 asstLen=35619 → mergeTurns
 *             accept shape=turns=19 userLen=7322 asstLen=36440 → msgs=36 textLen=43797
 *             («ответ 962» в базе дважды) → dedupe removed=1 msgs=36→35 (экспорт 11-52).
 * Гейт RED (до правки): 19 ходов / 36 сообщений / хвост …A,A,U,A / эхо 962 дважды.
 * Гейт T1 (после):      18 ходов / 35 сообщений / хвост …U,A, эхо 962 один раз,
 *                        userLen 7322, asstLen 35478, textLen 42834, export-dedupe removed=0.
 *
 * Контракт фикса (utils/google-search-folwr-parser.ts: dedupeTurns):
 *   (1) A-only эхо + Q-only вопрос: вопрос побайтово стоит сразу после wrapperPrefix
 *       текста ответа → склеить в ход {id стороны с ответом, userText = вопрос,
 *       assistantText БЕЗ изменений};
 *   (2) оба assistantText строго равны побайтово, userText ровно у одной стороны →
 *       сохранить её userText, assistantText как есть, id/позиция первого хода.
 * Текст ответа не переписывается: байты assistantText, канонические ключи и
 * направления слияний (BUG-D) остаются прежними.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const Parser = require('./helpers/load-esm.js').loadEsmModule('utils/google-search-folwr-parser.ts');
const Pipeline = require('./helpers/load-esm.js').loadEsmModule('utils/export-emit-pipeline.ts');
const INTERCEPT = fs.readFileSync(path.join(ROOT, 'core', 'google-search-intercept.js'), 'utf8');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'gsa-e-tail-question.json'), 'utf8'));

const TID = FIXTURE.threadId;

// Рез по балансу фигурных скобок (как в tests/gsa-o27-protective-form-guard.test.js).
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

// Песочница РЕАЛЬНЫХ функций перехватчика (MAIN-мир) — писатели базы.
// BUG-E: dedupeTurnsForCache теперь зовётся ещё и из applyTurns/absorbForeignSnapshot,
// поэтому она обязана быть в скоупе (иначе ReferenceError в нарезке).
const SCOPE_FNS = [
  'messagesFromTurns',
  'gsaTurnKeyOfLocal',
  'gsaTurnKey',
  'seedSeenKeys',
  'dedupeTurnsForCache',
  'isRawXssiPayload',
  'isUsableTurn',
  'hasUsableTurns',
  'isGarbageBody',
  'buildDetail',
  'emitDetail',
  'cacheSet',
  'isForeignThread',
  'segmentTurnsOf',
  'activateThread',
  'absorbForeignSnapshot',
  'unionTurnsByDirection',
  'applyTurns',
  'mergeStreamTurns',
  'mergeTurns'
];
const SCOPE = 'with (ctx) { ' + SCOPE_FNS.map((n) => fnDecl(INTERCEPT, n)).join('\n') +
  '\n return { ' + SCOPE_FNS.map((n) => n + ': ' + n).join(', ') + ' }; }';
const makeIntercept = new Function('ctx', SCOPE);

function interceptCtx(over) {
  const events = [];
  const logs = [];
  const ctx = {
    MAX_CACHE_ENTRIES: 10,
    threadCache: new Map(),
    lastFullTurns: [],
    lastFullMessages: [],
    lastFullSnapshot: null,
    seenKeys: {},
    currentThreadId: TID,
    emittedThreadId: '',
    baseThreadId: '',
    detectedModelSlug: 'gemini-2.5-flash',
    domTid: TID,
    logs: logs,
    console: { log: function () { } },
    debugLog: function (lvl, msg) { logs.push(String(msg)); },
    window: {
      GoogleFolwrUtils: Parser,
      parseGoogleFolwrOpen: Parser.parseGoogleFolwrOpen,
      dispatchEvent: function (ev) { events.push(ev.detail); }
    }
  };
  ctx.readDomThreadId = function () { return ctx.domTid; };
  Object.assign(ctx, over || {});
  return { ctx: ctx, events: events, logs: logs, api: makeIntercept(ctx) };
}

function turn(id, q, a) {
  return { id: id, userText: q, assistantText: a };
}

// ---- реальные байты фикстуры ----
const FULL = FIXTURE.full.map((t) => turn(t.id, t.userText, t.assistantText));
const A17 = turn('e17', null, FIXTURE.a17);                        // эхо «API DeepSeek полностью восстановлен»
const A18_ECHO = turn('e18', null, FIXTURE.echo962);              // эхо Q18 без структуры (11-48, принято)
const Q_A18 = turn('q18', FIXTURE.q18, FIXTURE.echo962);          // Q+A18 окна passive-folif
const Q_ONLY19 = turn('x19', FIXTURE.q18, FIXTURE.q141);          // эхо-вопрос без тела ответа (19-й ход окна)
const BASE_11_48 = FULL.concat([A17, A18_ECHO]);                   // 18 ходов / 34 сообщения (11-48)
const WINDOW_11_52 = FULL.concat([A17, Q_A18, Q_ONLY19]);          // 19 ходов / 37 сообщений входа (11:52:35)

function msgStats(messages) {
  let userLen = 0;
  let asstLen = 0;
  let echo = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user') userLen += m.text.length;
    else asstLen += m.text.length;
    if (m.text === FIXTURE.echo962) echo++;
  }
  return { count: messages.length, userLen: userLen, asstLen: asstLen, echo: echo };
}

function tailRoles(messages, n) {
  return messages.slice(-n).map((m) => (m.role === 'user' ? 'U' : 'A')).join(',');
}

function mergedStats(ctx) {
  const st = msgStats(ctx.lastFullMessages);
  st.turns = ctx.lastFullTurns.length;
  st.textLen = ctx.lastFullSnapshot ? ctx.lastFullSnapshot.text.length : -1;
  st.count = ctx.lastFullSnapshot ? ctx.lastFullSnapshot.count : st.count;
  return st;
}

// Отпечаток базы: канонические ключи ходов + count + textLen (O-32). id и форма
// хода в отпечаток не входят — ровно как в проде.
function fingerprintOf(ctx) {
  const keys = ctx.lastFullTurns.map((t) => Parser.canonicalTurnKeyOf(t)).sort();
  return JSON.stringify({
    turns: ctx.lastFullTurns.length,
    msgs: ctx.lastFullMessages.length,
    textLen: ctx.lastFullSnapshot.text.length,
    keys: keys
  });
}

function exportDedupe(ctx) {
  return Pipeline.prepareExportMessages(ctx.lastFullMessages);
}

// =====================================================================================
// T1: 11-52 после SPA — «рваный» хвост склеивается, ответ не переписан
// =====================================================================================
describe('BUG-E T1: SPA-возврат — 18 ходов / 35 сообщений, эхо 962 один раз', () => {
  test('mergeTurns(11-48, true) → mergeTurns(11-52 окно, false): хвост …U,A, байты и ключи сохранены', () => {
    const h = interceptCtx();
    h.api.mergeTurns(BASE_11_48, true);
    expect(h.ctx.lastFullTurns.length).toBe(18);
    expect(h.ctx.lastFullMessages.length).toBe(34);
    expect(tailRoles(h.ctx.lastFullMessages, 3)).toBe('A,A,A');
    expect(msgStats(h.ctx.lastFullMessages).echo).toBe(1);

    h.api.mergeTurns(WINDOW_11_52, false);

    const st = mergedStats(h.ctx);
    expect(st.turns).toBe(18);
    expect(st.count).toBe(35);
    expect(st.userLen).toBe(7322);
    expect(st.asstLen).toBe(35478);
    expect(st.textLen).toBe(42834);
    expect(tailRoles(h.ctx.lastFullMessages, 2)).toBe('U,A');
    expect(st.echo).toBe(1);

    // Вопрос стоит ПЕРЕД своим ответом; текст ответа — байтово прежний эхо-ответ.
    const last = h.ctx.lastFullTurns[17];
    expect(last.id).toBe('e18');
    expect(last.userText).toBe(FIXTURE.q18);
    expect(last.assistantText).toBe(FIXTURE.echo962);
    expect(last.assistantText.length).toBe(962);
    // Канонический ключ хода не изменился (идентичность Q+A18 сохранена).
    expect(Parser.canonicalTurnKeyOf(last)).toBe(Parser.canonicalTurnKeyOf(Q_A18));

    // export-dedupe (E-2: prepareExportMessages) больше не вырезает дубль эха.
    const res = exportDedupe(h.ctx);
    expect(res.removed).toBe(0);
    expect(res.messages.length).toBe(35);
  });
});

// =====================================================================================
// T2: идемпотентность — тот же window и полный снимок не меняют отпечаток
// =====================================================================================
describe('BUG-E T2: повторный SPA-возврат идемпотентен', () => {
  test('window дважды и full-снимок → тот же fingerprint, export-dedupe removed=0', () => {
    const h = interceptCtx();
    h.api.mergeTurns(BASE_11_48, true);
    h.api.mergeTurns(WINDOW_11_52, false);
    const fp = fingerprintOf(h.ctx);
    expect(mergedStats(h.ctx).turns).toBe(18);
    expect(mergedStats(h.ctx).count).toBe(35);

    h.api.mergeTurns(WINDOW_11_52, false);
    expect(fingerprintOf(h.ctx)).toBe(fp);
    expect(mergedStats(h.ctx).turns).toBe(18);
    expect(mergedStats(h.ctx).count).toBe(35);
    expect(exportDedupe(h.ctx).removed).toBe(0);

    // Полный снимок того же окна (F5/повторный folif) — та же база, тот же отпечаток.
    const hFull = interceptCtx();
    hFull.api.mergeTurns(BASE_11_48, true);
    hFull.api.mergeTurns(WINDOW_11_52, true);
    expect(fingerprintOf(hFull.ctx)).toBe(fp);
    expect(exportDedupe(hFull.ctx).removed).toBe(0);
  });
});

// =====================================================================================
// T3: обратная сторона — вопрос в хвосте, затем пришёл ответ
// =====================================================================================
describe('BUG-E T3: Q-only в хвосте + пришедший эхо-ответ → 18 ходов, не 19', () => {
  test('база [ … , A17, Q-only18] + ответ A18 → вопрос встаёт перед ответом', () => {
    const qOnly = turn('s18', FIXTURE.q18, null);
    const base = FULL.concat([A17, qOnly]);                 // 18 ходов / 34 сообщения
    const win = FULL.concat([A17, qOnly, A18_ECHO]);        // 19 ходов / 35 сообщений
    const h = interceptCtx();
    h.api.mergeTurns(base, true);
    expect(h.ctx.lastFullTurns.length).toBe(18);
    expect(h.ctx.lastFullMessages.length).toBe(34);

    h.api.mergeTurns(win, false);
    const st = mergedStats(h.ctx);
    expect(st.turns).toBe(18);
    expect(st.count).toBe(35);
    expect(st.userLen).toBe(7322);
    expect(st.asstLen).toBe(35478);
    expect(st.textLen).toBe(42834);
    expect(tailRoles(h.ctx.lastFullMessages, 2)).toBe('U,A');

    const last = h.ctx.lastFullTurns[17];
    expect(last.userText).toBe(FIXTURE.q18);
    expect(last.assistantText).toBe(FIXTURE.echo962);
    expect(msgStats(h.ctx.lastFullMessages).echo).toBe(1);
  });
});

// =====================================================================================
// T4: анти-тесты — склейка НЕ должна срабатывать на похожих формах
// =====================================================================================
describe('BUG-E T4: анти-склейка', () => {
  test('два полных хода с одним вопросом / эхо ДРУГОГО вопроса — не склеиваются', () => {
    // (а) два ПОЛНЫХ хода с одним вопросом: обе стороны имеют ответ → склейки нет.
    const dupA = turn('d1', FIXTURE.q18, 'Первый ответ на этот вопрос.');
    const dupB = turn('d2', FIXTURE.q18, 'Совершенно иной ответ, без общего префикса с первым.');
    const h = interceptCtx();
    h.api.mergeTurns(BASE_11_48, true);
    h.api.mergeTurns(BASE_11_48.concat([dupA, dupB]), false);
    expect(h.ctx.lastFullTurns.length).toBe(20);
    expect(tailRoles(h.ctx.lastFullMessages, 4)).toBe('U,A,U,A');
    const tail = h.ctx.lastFullTurns.slice(-2);
    expect(tail[0].id).toBe('d1');
    expect(tail[1].id).toBe('d2');

    // (б) хвост [эхо ДРУГОГО вопроса, Q-only]: вопрос не стоит в эхе побайтово → склейки нет.
    const other = turn('o19', 'Это совершенно другой вопрос, которого нет в эхе.', null);
    const h2 = interceptCtx();
    h2.api.mergeTurns(BASE_11_48, true);
    h2.api.mergeTurns(BASE_11_48.concat([other]), false);
    expect(h2.ctx.lastFullTurns.length).toBe(19);
    expect(tailRoles(h2.ctx.lastFullMessages, 2)).toBe('A,U');
    expect(h2.ctx.lastFullTurns[18].id).toBe('o19');
    expect(h2.ctx.lastFullTurns[18].assistantText).toBeNull();
    expect(h2.ctx.lastFullTurns[17].assistantText).toBe(FIXTURE.echo962);
  });
});

// =====================================================================================
// T5: 11-48 — прежние 18 ходов / 34 сообщения / …A A A; applyTurns и чужой сегмент
// =====================================================================================
describe('BUG-E T5: инвариант 11-48 и пути applyTurns/absorbForeignSnapshot', () => {
  test('11-48 байтово прежний; повторный SPA не растёт; снимок-окно склеен и в кэше', () => {
    const h = interceptCtx();
    h.api.mergeTurns(BASE_11_48, true);
    const base = mergedStats(h.ctx);
    expect(base.turns).toBe(18);
    expect(base.count).toBe(34);
    expect(base.userLen).toBe(7219);
    expect(base.asstLen).toBe(35478);
    expect(base.textLen).toBe(42730);
    expect(tailRoles(h.ctx.lastFullMessages, 3)).toBe('A,A,A');
    expect(h.ctx.lastFullTurns[17].assistantText).toBe(FIXTURE.echo962);
    expect(h.ctx.lastFullTurns[16].assistantText).toBe(FIXTURE.a17);

    // Повторный SPA-возврат не добавляет ни хода, ни сообщения.
    h.api.mergeTurns(WINDOW_11_52, false);
    expect(mergedStats(h.ctx).turns).toBe(18);
    expect(mergedStats(h.ctx).count).toBe(35);
    h.api.mergeTurns(WINDOW_11_52, false);
    expect(mergedStats(h.ctx).turns).toBe(18);
    expect(mergedStats(h.ctx).count).toBe(35);

    // applyTurns (снимок-окно, направление 'append'): dedupeTurnsForCache ПОСЛЕ union.
    const hApply = interceptCtx();
    hApply.api.mergeTurns(BASE_11_48, true);
    hApply.api.applyTurns(WINDOW_11_52, TID, false, 'body', 'append');
    const stApply = mergedStats(hApply.ctx);
    expect(stApply.turns).toBe(18);
    expect(stApply.count).toBe(35);
    expect(stApply.textLen).toBe(42834);
    expect(tailRoles(hApply.ctx.lastFullMessages, 2)).toBe('U,A');

    // Чужой сегмент: снимок-окно чистится ДО записи в кэш треда.
    const hForeign = interceptCtx();
    hForeign.api.mergeTurns(BASE_11_48, true);
    expect(hForeign.api.absorbForeignSnapshot('TID-B', WINDOW_11_52, false)).toBe(true);
    const seg = hForeign.ctx.threadCache.get('TID-B');
    expect(seg).toBeTruthy();
    expect(seg.turns.length).toBe(18);
    expect(seg.messages.length).toBe(35);
    expect(tailRoles(seg.messages, 2)).toBe('U,A');
  });
});
