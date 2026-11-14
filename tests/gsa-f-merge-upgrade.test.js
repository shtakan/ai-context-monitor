/**
 * BUG-F (gsa-incomplete-merge-upgrade): неполная ветка mergeTurns (и mergeStreamTurns)
 * обязана ПОВЫШАТЬ форму хода по КАНОНИЧЕСКОМУ ключу, а не отбрасывать полную форму
 * как «уже виденный» дубль.
 *
 * Живой дефект (лог 1794647370479, тред 8bTpaveuJtWckdUP46iumAo, одно окно turns=20):
 *   13:55:31 passive-folif → mergeTurns(full=0)   → 19 ходов / userLen 7322 / asstLen 35875
 *            / 36 msgs / textLen 43232 — последний вопрос (52 симв.) потерян;
 *   14:07:09 open (applyTurns/mergeTurnsMonotone) → 19 / 7374 / 35875 / 37 / 43285 — вопрос на месте.
 * Разница ровно 52 симв. = q19 «Предлагаю обменяться репликами для теста расширения.»
 * (данные в окне были всегда — теряла их только неполная ветка; окно 20/7477/36016 в
 * тесте не воспроизводится: состав 20-го хода в логе неизвестен).
 *
 * Фикстура tests/fixtures/gsa-f-merge-upgrade.json — РЕАЛЬНЫЕ байты (экспорт 14-07,
 * сообщения U#36/A#37; base18 — те же байты, что в gsa-e-tail-question.json):
 *   q19     52 симв. — вопрос 19-го хода (UTF-8 98 B);
 *   echo397 397 симв. — эхо-ответ A19 (обёртка «Ответ в режиме ИИ, исходный запрос: "q19"»,
 *                       UTF-8 708 B);
 *   base18  18 ходов / userLen 7322 / asstLen 35478 — 16 полных + A17-эхо + полный 18-й ход.
 * Сети/окну соответствуют:
 *   base19 = base18 + {id 'net19', userText null, assistantText echo397} (19 / 7322 / 35875);
 *   window = base18 + {id 'dom19', userText q19, assistantText echo397}  (19 / 7374 / 35875).
 *
 * Гейт RED (до правки): 19 ходов / 36 сообщений / хвост …A,A / userLen 7322.
 * Гейт после правки:    19 / 37 / …U,A / userLen 7374 / asstLen 35875 / textLen 43285,
 *                       id последнего хода 'dom19' — тот же, что даёт applyTurns на том же входе.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const loadEsmModule = require('./helpers/load-esm.js').loadEsmModule;
const Parser = loadEsmModule('utils/google-search-folwr-parser.ts');
const INTERCEPT = fs.readFileSync(path.join(ROOT, 'core', 'google-search-intercept.js'), 'utf8');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'gsa-f-merge-upgrade.json'), 'utf8'));
// Байты 11-48 (18 ходов / 34 сообщения) — для гарда «нет синтеза» (T5).
const FIXTURE_E = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'gsa-e-tail-question.json'), 'utf8'));

const TID = FIXTURE.threadId;

// Рез по балансу фигурных скобок (как в tests/gsa-e-tail-question-merge.test.js).
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
// BUG-F: ветка повышения ходит в парсер через window.GoogleFolwrUtils.mergeTurnsByKey
// (тот же образец, что applyTurns для mergeTurnsMonotone) — поэтому Parser кладётся в window.
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
  const diag = [];
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
    diag: diag,
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
  return { ctx: ctx, events: events, logs: logs, diag: diag, api: makeIntercept(ctx) };
}

function turn(id, q, a) {
  return { id: id, userText: q, assistantText: a };
}

// ---- реальные байты фикстуры BUG-F ----
const BASE18 = FIXTURE.base18.map((t) => turn(t.id, t.userText, t.assistantText));
const NET19 = turn('net19', null, FIXTURE.echo397);                 // 19-й ход сети: только ответ
const DOM19 = turn('dom19', FIXTURE.q19, FIXTURE.echo397);          // 19-й ход окна: вопрос + ответ
const BASE19 = BASE18.concat([NET19]);                              // 19 / 7322 / 35875
const WINDOW = BASE18.concat([DOM19]);                              // 19 / 7374 / 35875

// ---- байты 11-48 (BUG-E): 18 ходов / 34 сообщения ----
const FULL16 = FIXTURE_E.full.map((t) => turn(t.id, t.userText, t.assistantText));
const A17 = turn('e17', null, FIXTURE_E.a17);
const A18_ECHO = turn('e18', null, FIXTURE_E.echo962);
const BASE_11_48 = FULL16.concat([A17, A18_ECHO]);
const WINDOW_11_48_ECHO = FULL16.concat([A17, A18_ECHO]);           // окно без полного хода 18
// Окно 11-52 (BUG-E, 19 ходов / 37 сообщений): тот же вопрос полной формой + эхо-вопрос 19-го.
const Q_A18 = turn('q18', FIXTURE_E.q18, FIXTURE_E.echo962);
const Q_ONLY19 = turn('x19', FIXTURE_E.q18, FIXTURE_E.q141);
const WINDOW_11_52 = FULL16.concat([A17, Q_A18, Q_ONLY19]);

function msgStats(messages) {
  let userLen = 0;
  let asstLen = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user') userLen += m.text.length;
    else asstLen += m.text.length;
  }
  return { count: messages.length, userLen: userLen, asstLen: asstLen };
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

// Отпечаток базы (диагностика 'gsa-thread-fingerprint'): hash(sorted(канонические ключи
// сообщений)) + count + textLen. id и форма хода в отпечаток не входят — ровно как в проде.
function lastFingerprint(h) {
  for (let i = h.diag.length - 1; i >= 0; i--) {
    if (h.diag[i].name === 'gsa-thread-fingerprint') return h.diag[i].fields;
  }
  throw new Error('gsa-thread-fingerprint не эмитился');
}

function idSeq(ctx) {
  return ctx.lastFullTurns.map((t) => String(t.id)).join(',');
}

// =====================================================================================
// T1: A-only эхо в базе + полная форма в окне → повышение на месте
// =====================================================================================
describe('BUG-F T1: неполное слияние повышает A-only эхо-ход до полной формы', () => {
  test('mergeTurns(base19) → mergeTurns(window): 19 / 7374 / 35875 / 43285, 37 msgs, …U,A, id dom19', () => {
    const h = interceptCtx();
    h.api.mergeTurns(BASE18, true);
    expect(h.ctx.lastFullTurns.length).toBe(18);
    expect(h.ctx.lastFullMessages.length).toBe(35);   // 16 полных (32) + A17-эхо (1) + полный 18-й (2)

    h.api.mergeTurns(BASE19, false);              // сеть/неполный folwr: 19-й ход только ответом
    expect(h.ctx.lastFullTurns.length).toBe(19);
    expect(h.ctx.lastFullMessages.length).toBe(36);
    expect(tailRoles(h.ctx.lastFullMessages, 2)).toBe('A,A');
    expect(h.ctx.lastFullTurns[18].userText).toBeNull();

    h.api.mergeTurns(WINDOW, false);              // пассивный folif: тот же вопрос полной формой

    const st = mergedStats(h.ctx);
    expect(st.turns).toBe(19);
    expect(st.count).toBe(37);
    expect(st.userLen).toBe(7374);
    expect(st.asstLen).toBe(35875);
    expect(st.textLen).toBe(43285);
    expect(tailRoles(h.ctx.lastFullMessages, 2)).toBe('U,A');

    const last = h.ctx.lastFullTurns[18];
    expect(last.id).toBe('dom19');                          // id БОГАТОЙ (входящей) формы
    expect(last.userText).toBe(FIXTURE.q19);
    expect(last.userText.length).toBe(52);
    expect(last.assistantText).toBe(FIXTURE.echo397);       // байт-в-байт, без переписывания
    expect(last.assistantText.length).toBe(397);
    expect(Parser.canonicalTurnKeyOf(last)).toBe(Parser.canonicalTurnKeyOf(DOM19));

    // Обе дороги на одном входе дают ОДНО состояние: id последнего хода совпадает с applyTurns.
    const hOpen = interceptCtx();
    hOpen.api.mergeTurns(BASE18, true);
    hOpen.api.applyTurns(WINDOW, TID, false, null, 'append');
    const openSt = mergedStats(hOpen.ctx);
    expect(openSt.turns).toBe(19);
    expect(openSt.count).toBe(37);
    expect(openSt.userLen).toBe(7374);
    expect(openSt.asstLen).toBe(35875);
    expect(openSt.textLen).toBe(43285);
    expect(tailRoles(hOpen.ctx.lastFullMessages, 2)).toBe('U,A');
    expect(hOpen.ctx.lastFullTurns[18].id).toBe('dom19');
    expect(hOpen.ctx.lastFullTurns[18].id).toBe(last.id);
    expect(hOpen.ctx.lastFullTurns[18].assistantText).toBe(last.assistantText);
  });
});

// =====================================================================================
// T2: идемпотентность — окно трижды и полный снимок не двигают базу
// =====================================================================================
describe('BUG-F T2: повторное окно и полный снимок идемпотентны', () => {
  test('3× window + full-снимок → те же turns/userLen/asstLen/msgs/textLen/ids и отпечаток', () => {
    const h = interceptCtx();
    h.api.mergeTurns(BASE18, true);
    h.api.mergeTurns(BASE19, false);
    h.api.mergeTurns(WINDOW, false);

    const fp0 = lastFingerprint(h);
    const ids0 = idSeq(h.ctx);
    const st0 = mergedStats(h.ctx);
    expect(st0.turns).toBe(19);
    expect(st0.count).toBe(37);
    expect(fp0.msgs).toBe(37);
    expect(fp0.textLen).toBe(43285);

    for (let i = 0; i < 3; i++) h.api.mergeTurns(WINDOW, false);

    expect(idSeq(h.ctx)).toBe(ids0);
    const st1 = mergedStats(h.ctx);
    expect(st1.turns).toBe(19);
    expect(st1.count).toBe(37);
    expect(st1.userLen).toBe(7374);
    expect(st1.asstLen).toBe(35875);
    expect(st1.textLen).toBe(43285);
    const fp1 = lastFingerprint(h);
    expect(fp1.hash).toBe(fp0.hash);
    expect(fp1.count).toBe(fp0.count);
    expect(fp1.msgs).toBe(fp0.msgs);
    expect(fp1.textLen).toBe(fp0.textLen);

    h.api.mergeTurns(WINDOW, true);               // полный снимок окна

    expect(idSeq(h.ctx)).toBe(ids0);
    expect(h.ctx.lastFullTurns.length).toBe(19);
    expect(h.ctx.lastFullMessages.length).toBe(37);
    const fp2 = lastFingerprint(h);
    expect(fp2.hash).toBe(fp0.hash);
    expect(fp2.msgs).toBe(37);
    expect(fp2.textLen).toBe(43285);
  });
});

// =====================================================================================
// T3: mergeStreamTurns — обе стороны, без обеднения
// =====================================================================================
describe('BUG-F T3: mergeStreamTurns повышает форму, но не обедняет базу', () => {
  test('база full + стрим A-only → userText на месте; база A-only + стрим full → повышение', () => {
    // (а) полная база, стрим принёс A-only эхо того же хода: база не обедняется.
    const h = interceptCtx();
    h.api.mergeTurns(BASE18, true);
    h.api.mergeTurns(WINDOW, true);
    expect(h.ctx.lastFullTurns[18].userText).toBe(FIXTURE.q19);

    h.api.mergeStreamTurns([NET19], TID);

    expect(h.ctx.lastFullTurns.length).toBe(19);
    expect(h.ctx.lastFullMessages.length).toBe(37);
    expect(h.ctx.lastFullTurns[18].userText).toBe(FIXTURE.q19);
    expect(h.ctx.lastFullTurns[18].assistantText).toBe(FIXTURE.echo397);
    expect(tailRoles(h.ctx.lastFullMessages, 2)).toBe('U,A');

    // (б) A-only база, стрим принёс полную форму: повышение на месте (id богатой формы).
    const h2 = interceptCtx();
    h2.api.mergeTurns(BASE18, true);
    h2.api.mergeTurns(BASE19, true);
    expect(h2.ctx.lastFullTurns[18].userText).toBeNull();
    expect(h2.ctx.lastFullMessages.length).toBe(36);

    h2.api.mergeStreamTurns([DOM19], TID);

    const st = mergedStats(h2.ctx);
    expect(st.turns).toBe(19);
    expect(st.count).toBe(37);
    expect(st.userLen).toBe(7374);
    expect(st.asstLen).toBe(35875);
    expect(h2.ctx.lastFullTurns[18].id).toBe('dom19');
    expect(h2.ctx.lastFullTurns[18].userText).toBe(FIXTURE.q19);
    expect(tailRoles(h2.ctx.lastFullMessages, 2)).toBe('U,A');
  });
});

// =====================================================================================
// T4: анти-обеднение — короткая префикс-форма не укорачивает длинный ответ
// =====================================================================================
describe('BUG-F T4: неполное слияние не обедняет длинный ответ', () => {
  test('окно с коротким префиксом того же вопроса → длина assistantText не уменьшается', () => {
    const LONG = 'Полный ответ на вопрос T4. ' + 'Подробность. '.repeat(40) + 'Конец ответа.';
    const SHORT = LONG.slice(0, 40);
    expect(SHORT.length).toBe(40);
    expect(LONG.length).toBeGreaterThan(400);

    const h = interceptCtx();
    h.api.mergeTurns([turn('b1', 'вопрос T4', LONG)], true);
    expect(h.ctx.lastFullTurns.length).toBe(1);
    expect(h.ctx.lastFullMessages.length).toBe(2);

    h.api.mergeTurns([turn('w1', 'вопрос T4', SHORT)], false);

    expect(h.ctx.lastFullTurns.length).toBe(1);
    expect(h.ctx.lastFullTurns[0].assistantText).toBe(LONG);
    expect(h.ctx.lastFullTurns[0].assistantText.length).toBe(LONG.length);
    expect(h.ctx.lastFullTurns[0].userText).toBe('вопрос T4');
    expect(h.ctx.lastFullMessages.length).toBe(2);
  });
});

// =====================================================================================
// T5: гард «нет синтеза» — A-only эхо без полного хода не рождает userText
// =====================================================================================
describe('BUG-F T5: userText из эха не синтезируется', () => {
  test('11-48 остаётся 34 сообщения / хвост …A,A,A при повторном A-only окне', () => {
    const h = interceptCtx();
    h.api.mergeTurns(BASE_11_48, true);

    let st = mergedStats(h.ctx);
    expect(st.turns).toBe(18);
    expect(st.count).toBe(34);
    expect(st.userLen).toBe(7219);
    expect(st.asstLen).toBe(35478);
    expect(tailRoles(h.ctx.lastFullMessages, 3)).toBe('A,A,A');

    h.api.mergeTurns(WINDOW_11_48_ECHO, false);   // окно: то же A-only эхо, полного хода нет

    st = mergedStats(h.ctx);
    expect(st.turns).toBe(18);
    expect(st.count).toBe(34);
    expect(st.userLen).toBe(7219);
    expect(st.asstLen).toBe(35478);
    expect(tailRoles(h.ctx.lastFullMessages, 3)).toBe('A,A,A');
    // у последнего хода по-прежнему только ответ: вопрос из обёртки эха не синтезирован
    const last = h.ctx.lastFullTurns[17];
    expect(last.userText).toBeNull();
    expect(last.assistantText).toBe(FIXTURE_E.echo962);
    expect(h.ctx.lastFullMessages.filter((m) => m.role === 'user' && m.text === FIXTURE_E.q18).length).toBe(0);
  });
});

// =====================================================================================
// T6: инвариант «одна дорога» — полный снимок и неполное слияние дают ОДНО состояние
// (второй независимый вход — окно 11-52 из BUG-E; регрессии T6 списка гоняются сьютом)
// =====================================================================================
describe('BUG-F T6: неполная ветка ≡ applyTurns на окне 11-52 (BUG-E)', () => {
  test('mergeTurns(window 11-52, false) и applyTurns(window 11-52) → 18 / 35 / 42834, хвост …U,A', () => {
    const h1 = interceptCtx();
    h1.api.mergeTurns(BASE_11_48, true);
    h1.api.mergeTurns(WINDOW_11_52, false);

    const h2 = interceptCtx();
    h2.api.mergeTurns(BASE_11_48, true);
    h2.api.applyTurns(WINDOW_11_52, TID, false, null, 'append');

    for (const h of [h1, h2]) {
      const st = mergedStats(h.ctx);
      expect(st.turns).toBe(18);
      expect(st.count).toBe(35);
      expect(st.userLen).toBe(7322);
      expect(st.asstLen).toBe(35478);
      expect(st.textLen).toBe(42834);
      expect(tailRoles(h.ctx.lastFullMessages, 2)).toBe('U,A');
      expect(h.ctx.lastFullTurns[17].id).toBe('e18');
    }
    expect(idSeq(h1.ctx)).toBe(idSeq(h2.ctx));
    expect(h1.ctx.lastFullTurns[17].assistantText).toBe(h2.ctx.lastFullTurns[17].assistantText);
  });
});
