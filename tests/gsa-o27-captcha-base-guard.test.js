/**
 * O-27 (Medium-High, живой прогон GSA 2026-09-16 10:46): сервисная страница Google
 * (captcha / «подозрительный трафик») стала источником автоэкспорта — файл `f.txt`
 * с мусором `)]}' [""]` (сырой префикс XHR с пустым payload).
 *
 * Инспекция (read-only, до фикса):
 *   (а) базу из сетевого тела пишут writers перехватчика MAIN-мира
 *       (core/google-search-intercept.js: applyTurns / mergeTurns, ветки folwr-open,
 *       passive folwr/folif, XHR) и взводят baseComplete через buildDetail.historyComplete
 *       (content.js: `const newBaseComplete = !!detail.historyComplete;`). Валидация была
 *       только «turns.length > 0»: тело с контейнером без содержимого (или пустой payload)
 *       проходило дальше, а снимок помечался ПОЛНОЙ (historyComplete по умолчанию true) —
 *       то есть baseComplete мог быть взведён по мусору;
 *   (б) pct/lastPercentage — ПАМЯТЬ ЭКЗЕМПЛЯРА (core/state.js: lastPercentage, maxTokenCount,
 *       autoExportLastPct; sessionStorage не используется), но сам pct в момент файра
 *       ПЕРЕСЧИТЫВАЕТСЯ в DRAW (core/content.js: `percentage = maxTokenCount / displayLimit`)
 *       от базы/текста текущего документа и передаётся в maybeAutoExport(percentage);
 *       re-check-пути (loader-stop / base-complete 0→1 / tape-restore) берут autoExportLastPct,
 *       который на новом документе = −1 (resetConversationState);
 *   (в) гейт автоэкспорта на странице без чата проверял ТОЛЬКО enabled/percentage/
 *       baseComplete|baseSeen/порог/латч (utils/export-emit-pipeline.js:
 *       shouldSkipAutoExport) — ни признака чат-страницы, ни непустой базы, ни msgs≥1.
 *
 * Фикс O-27:
 *   (а) сетевой писатель GSA (applyTurns/mergeTurns) отклоняет тела, не распарсившиеся в
 *       ≥1 НЕПУСТОЙ ход, и ТОЧНУЮ форму мусора (тело начинается XSSI-префиксом `)]}'` И
 *       разбор дал 0 непустых ходов): база не пишется, снимок не эмитится, baseComplete не
 *       взводится. Легитимное тело — в т.ч. начинающееся тем же префиксом, но с ходами, —
 *       пишется байтово прежним путём (защитный фикс O-27: сужение гарда до формы мусора;
 *       пины — tests/gsa-o27-protective-form-guard.test.js);
 *   (б) гейт автоэкспорта GSA требует msgs≥1, непустой текст базы и признак чат-страницы
 *       (threadId снаффнут ИЛИ чат-контейнер в DOM) — shouldSkipGsaPageGuard;
 *   (в) база/pct прошлого документа на не-чат документе гасятся при load/в DRAW
 *       (aiCmGsaResetStaleStateOnChatlessDoc) и всё равно не проходят гейт.
 *
 * НЕ ТРОГАЕТСЯ: байты и маска экспорта чат-страниц, пороговые гейты чат-страниц, латч и
 * реестр имён (O-11), CHANGELOG/privacy/release.yml.
 */

const fs = require('fs');
const path = require('path');

const P = require('../utils/export-emit-pipeline.js');
const Parser = require('../utils/google-search-folwr-parser.js');

const ROOT = path.join(__dirname, '..');
const CONTENT = require('./helpers/content-source.js').contentSource;
const PIPELINE_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'export-emit-pipeline.js'), 'utf8');
const INTERCEPT = fs.readFileSync(path.join(ROOT, 'core', 'google-search-intercept.js'), 'utf8');
const FOLWR_FIXTURE = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'google-folwr-open.html'), 'utf8');

const GSA = 'google_search';
const TID = 'SYNTHETIC-THREAD-1';
// Живой мусор captcha-страницы: префикс XHR Google + пустой payload (ни одного хода).
const CAPTCHA_BODY = ')]}\' [""]';
// Живой артефакт O-27 — файл `f.txt`: XSSI-префикс Google (4 символа) + перевод строки +
// пустой payload `[""]` + перевод строки (ни одного хода — точная форма мусора).
const F_TXT = ")]}'\n[\"\"]\n";

// Рез по балансу фигурных скобок (как в tests/gsa-autoexport.test.js / O-31).
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

// =====================================================================================
// Песочница РЕАЛЬНЫХ функций перехватчика (MAIN-мир) — писатели базы + парсер
// =====================================================================================
const SCOPE_FNS = [
  'messagesFromTurns',
  // O-32: канонический ключ хода в скоупе песочницы — его зовут все точки записи базы.
  'gsaTurnKeyOfLocal',
  'gsaTurnKey',
  'seedSeenKeys',
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
  'applyTurns',
  'mergeStreamTurns',
  'mergeTurns',
  'parseTurns',
  'parseWithParser'
];
const SCOPE = 'with (ctx) { ' + SCOPE_FNS.map((n) => fnDecl(INTERCEPT, n)).join('\n') +
  '\n return { ' + SCOPE_FNS.map((n) => n + ': ' + n).join(', ') + ' }; }';
const makeIntercept = new Function('ctx', SCOPE);

function turn(id, q, a) {
  return { id: id, userText: q, assistantText: a };
}

// Валидная база разговора: 4 хода (8 сообщений).
const TURNS_A = [
  turn('a1', 'Вопрос A1', 'Ответ A1'),
  turn('a2', 'Вопрос A2', 'Ответ A2'),
  turn('a3', 'Вопрос A3', 'Ответ A3'),
  turn('a4', 'Вопрос A4', 'Ответ A4')
];
// «Мусор, прошедший парсер»: контейнер хода есть, содержимого нет (captcha/интерстишиал).
const JUNK_TURNS = [turn('j1', null, null)];
const JUNK_WS_TURNS = [turn('j2', '   ', '')];

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
    currentThreadId: '',
    emittedThreadId: '',
    baseThreadId: '',
    detectedModelSlug: 'gemini-2.5-flash',
    domTid: '',
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

const COUNT = (detail) => (detail && typeof detail.count === 'number') ? detail.count : -1;

// =====================================================================================
// O-27 (а): тело без непустых ходов базой не становится
// =====================================================================================
describe('O-27 (а): сетевой писатель GSA отклоняет тело без непустых ходов', () => {
  test('captcha-тело `)]}\' [""]` не парсится в ход → база не пишется, эмита нет', () => {
    const h = interceptCtx({ domTid: TID });
    const parsed = h.api.parseWithParser(CAPTCHA_BODY);
    expect(parsed.turns).toHaveLength(0);          // сырой префикс XHR с пустым payload

    h.api.applyTurns(parsed.turns, TID, true, CAPTCHA_BODY); // прод-путь folwr-open с complete=true

    expect(h.ctx.lastFullTurns).toHaveLength(0);
    expect(h.ctx.lastFullMessages).toHaveLength(0);
    expect(h.ctx.lastFullSnapshot).toBeNull();      // baseComplete взводить не из чего
    expect(h.events).toHaveLength(0);               // файра не будет: AI CM не получил базу
    // отдельно: пустой разбор отвергается и внутренним гардом (не только счётчиком turns)
    expect(h.api.hasUsableTurns(parsed.turns)).toBe(false);
    // ТОЧНАЯ форма мусора (защитный фикс O-27): тело начинается XSSI-префиксом `)]}'`
    // И разбор дал 0 непустых ходов. Писатель с таким телом базу не трогает и ПОЛНУЮ
    // не взводит — при этом причина в вердикте отдельная (reason=xssi-prefix).
    expect(h.api.isGarbageBody(F_TXT, [])).toBe(true);
    expect(h.api.isGarbageBody(F_TXT, [{ id: 'x', userText: '', assistantText: null }])).toBe(true);
    h.api.mergeTurns([{ id: 'x', userText: '', assistantText: null }], true, TID, F_TXT);
    expect(h.ctx.lastFullSnapshot).toBeNull();
    expect(h.ctx.lastFullTurns).toHaveLength(0);
    expect(h.logs.join('\n')).toContain('O-27: форма мусора');
    // СУЖЕНИЕ гарда: ход с НЕПУСТЫМ текстом форму мусора не образует (в т.ч. если текстом
    // хода оказалось сырое тело) — по тексту хода гард больше не отклоняет; остаточный
    // случай закрыт пост-гардом ЕДИНСТВЕННОЙ точки скачивания (`download-blocked
    // reason=xssi-prefix`, пины — tests/gsa-o27-protective-form-guard.test.js).
    expect(h.api.isGarbageBody(F_TXT, [{ id: 'x', userText: CAPTCHA_BODY, assistantText: null }])).toBe(false);
    expect(h.api.hasUsableTurns([{ id: 'x', userText: CAPTCHA_BODY, assistantText: null }])).toBe(true);
  });

  test('контейнер хода БЕЗ содержимого (мусор после парсера) не пишет базу и не ставит ПОЛНАЯ', () => {
    const h = interceptCtx({ domTid: TID });
    h.api.applyTurns(JUNK_TURNS, TID, true);
    expect(h.ctx.lastFullSnapshot).toBeNull();
    expect(h.events).toHaveLength(0);

    // та же проверка через mergeTurns (пассивный folwr/folif + XHR путь)
    h.api.mergeTurns(JUNK_WS_TURNS, true, TID);
    expect(h.ctx.lastFullSnapshot).toBeNull();
    expect(h.events).toHaveLength(0);
    expect(h.logs.join('\n')).toContain('O-27: тело без непустых ходов');
  });

  test('мусор не портит уже накопленную базу разговора (ни сжатия, ни ПОЛНАЯ)', () => {
    const h = interceptCtx({ domTid: TID });
    h.api.applyTurns(TURNS_A, TID, true);
    const emitted = h.events.length;

    // isFull=true до фикса ЗАМЕНЯЛ базу мусорным телом — теперь писатель его не принимает
    h.api.mergeTurns(JUNK_TURNS, true, TID);

    expect(h.ctx.lastFullMessages).toHaveLength(8);
    expect(COUNT(h.ctx.lastFullSnapshot)).toBe(8);
    expect(h.ctx.lastFullSnapshot.historyComplete).toBe(true);
    expect(h.events.length).toBe(emitted);          // повторного эмита по мусору нет
  });
});

// =====================================================================================
// O-27 (а)/регресс: нормальное folwr-тело пишется БАЙТОВО прежним путём
// =====================================================================================
describe('O-27: нормальное folwr-тело → база байтово прежняя', () => {
  function snapshotOf(ctx) {
    return JSON.stringify({
      turns: ctx.lastFullTurns,
      messages: ctx.lastFullMessages,
      text: ctx.lastFullSnapshot.text,
      count: ctx.lastFullSnapshot.count,
      historyComplete: ctx.lastFullSnapshot.historyComplete,
      messageIds: ctx.lastFullSnapshot.messageIds
    });
  }

  test('снимок совпадает с до-фиксовым поведением (гард только пропускает)', () => {
    const hFix = interceptCtx({ domTid: TID });
    const p1 = hFix.api.parseWithParser(FOLWR_FIXTURE);
    hFix.api.applyTurns(p1.turns, TID, true, FOLWR_FIXTURE);
    const afterFix = snapshotOf(hFix.ctx);

    // до-фиксовое поведение: гард отключён (hasUsableTurns всегда true)
    const hPre = interceptCtx({ domTid: TID, hasUsableTurns: function () { return true; } });
    const p2 = hPre.api.parseWithParser(FOLWR_FIXTURE);
    hPre.api.applyTurns(p2.turns, TID, true);
    const beforeFix = snapshotOf(hPre.ctx);

    expect(afterFix).toBe(beforeFix);
    expect(hFix.ctx.lastFullSnapshot.count).toBe(4);
    expect(hFix.ctx.lastFullSnapshot.text).toContain('Сколько будет два плюс два?');
    expect(hFix.ctx.lastFullSnapshot.text).toContain('Будет то же число в этом случае.');
    // F1 не тронут: probe-вердикт по-прежнему доезжает одной точкой
    expect(hFix.ctx.lastFullSnapshot.historyComplete).toBe(true);
    expect(COUNT(hFix.events[hFix.events.length - 1])).toBe(4);
  });

  test('легитимное тело С XSSI-префиксом, но с ходами — не форма мусора (сужение гарда)', () => {
    // Сужение до точной формы мусора: префикс `)]}'` сам по себе тело мусором не делает —
    // решает РАЗБОР. Тело с префиксом, но с непустыми ходами пишется базой как раньше.
    const prefixedBody = ")]}'\n" + FOLWR_FIXTURE;
    const h = interceptCtx({ domTid: TID });
    expect(h.api.isGarbageBody(prefixedBody, TURNS_A)).toBe(false);
    expect(h.api.hasUsableTurns(TURNS_A)).toBe(true);
    h.api.applyTurns(TURNS_A, TID, true, prefixedBody);
    expect(h.ctx.lastFullSnapshot.count).toBe(8);
    expect(h.ctx.lastFullSnapshot.historyComplete).toBe(true);
    expect(h.events).toHaveLength(1);
  });

  test('восемь пустых контейнеров в теле — тоже не база (счётчик ходов ≠ содержимое)', () => {
    const turns = [];
    for (let i = 0; i < 8; i++) turns.push(turn('e' + i, null, null));
    const h = interceptCtx({ domTid: TID });
    h.api.applyTurns(turns, TID, true);
    expect(h.events).toHaveLength(0);
    expect(h.ctx.lastFullSnapshot).toBeNull();
  });
});

// =====================================================================================
// O-27 (б)/(в): чистый гейт автоэкспорта GSA
// =====================================================================================
function gsaState(over) {
  return Object.assign({
    enabled: true, percentage: 95, threshold: 90,
    baseComplete: true, baseSeen: true, loaderRunning: false,
    fired: false, isGemini: false,
    site: GSA, chatPageMarker: true, msgCount: 8, baseTextLen: 13270
  }, over || {});
}

describe('O-27 (б)/(в): гейт автоэкспорта требует чат-страницу и непустую базу', () => {
  test('страница без чата (captcha): база/pct состояния не проходят → not-chat-page', () => {
    const v = P.shouldSkipAutoExport(gsaState({
      chatPageMarker: false,                       // threadId не снаффнут и чат-контейнера нет
      baseCount: 8, baseTextLen: 13270, percentage: 95, baseComplete: true
    }));
    expect(v).toEqual({ skip: true, reason: 'not-chat-page', resetFired: false });
  });

  test('навигационная протечка: состояние прошлого документа на не-чат документе не стреляет', () => {
    // ровно то, что видел живой прогон: полная база (8 ходов), полный pct, baseComplete=1,
    // но документ — сервисная страница Google без чата
    const prevDoc = gsaState({
      percentage: 95, baseComplete: true, baseSeen: true, msgCount: 8, baseTextLen: 13270,
      chatPageMarker: false
    });
    const v = P.shouldSkipAutoExport(prevDoc);
    expect(v.skip).toBe(true);
    expect(v.reason).toBe('not-chat-page');
    expect(v.resetFired).toBe(false);              // честный поздний экспорт остаётся возможен
  });

  test('пустая база: msgs=0 → no-messages, пустой текст базы → empty-base', () => {
    expect(P.shouldSkipAutoExport(gsaState({ msgCount: 0 })))
      .toEqual({ skip: true, reason: 'no-messages', resetFired: false });
    expect(P.shouldSkipAutoExport(gsaState({ baseTextLen: 0 })))
      .toEqual({ skip: true, reason: 'empty-base', resetFired: false });
  });

  test('нормальная чат-страница GSA: пороговые гейты не тронуты (skip=false при pct ≥ порога)', () => {
    expect(P.shouldSkipAutoExport(gsaState({}))).toEqual({ skip: false, reason: null, resetFired: false });
    // пороги на чат-странице — прежние: ниже порога → below-threshold (без сброса латча),
    // ниже на 10 п.п. → гистерезис со сбросом
    expect(P.shouldSkipAutoExport(gsaState({ percentage: 85 })).reason).toBe('below-threshold');
    expect(P.shouldSkipAutoExport(gsaState({ percentage: 79, fired: true })))
      .toEqual({ skip: true, reason: 'below-threshold-hysteresis', resetFired: true });
  });

  test('обратная совместимость: без новых полей вердикт прежний (прочие сайты 1:1)', () => {
    expect(P.shouldSkipAutoExport({
      enabled: true, percentage: 95, threshold: 90, baseComplete: true, baseSeen: true,
      loaderRunning: false, fired: false, isGemini: false
    })).toEqual({ skip: false, reason: null, resetFired: false });
    // не-GSA сайт: даже «пустая база»/не-чат маркер гейт не трогают
    expect(P.shouldSkipGsaPageGuard({ site: 'gemini', chatPageMarker: false, msgCount: 0 }))
      .toEqual({ skip: false, reason: null });
    expect(typeof P.shouldSkipGsaPageGuard).toBe('function');
  });
});

// =====================================================================================
// O-27 (б): РЕАЛЬНЫЙ maybeAutoExport (ISOLATED) — на captcha файра нет
// =====================================================================================
describe('O-27: реальный maybeAutoExport GSA — файла на не-чат странице нет', () => {
  const SCOPE_MGR = 'with (ctx) { ' +
    fnDecl(CONTENT, 'aiCmAutoExportConvId') + '\n' +
    fnDecl(CONTENT, 'aiCmGsaProbeRunningFor') + '\n' +
    fnDecl(CONTENT, 'aiCmGsaAutoExportSkipLog') + '\n' +
    fnDecl(CONTENT, 'maybeAutoExport') + '\n' +
    ' return { run: maybeAutoExport }; }';
  const makeRun = new Function('ctx', SCOPE_MGR);

  function gateCtx(over) {
    const logs = [];
    const fired = [];
    const ctx = {
      autoExportSettings: { enabled: true, pct: 90, fmt: 'txt' },
      autoExportLastConvId: '',
      autoExportPctBySite: {},
      autoExportFired: {},
      autoExportLastPct: -1,
      notCompleteLogged: {},
      sessionFiredCache: {},
      aiCmGsaProbeByThread: {},
      aiCmGsaProbeRunning: false,
      aiCmLoaderRunningByConv: {},
      aiCmCursorLiveByConv: {},
      aiCmArchiveCountFor: function () { return 0; },
      baseSeen: true,
      baseComplete: true,
      baseCount: 8,
      baseText: new Array(13271).join('x'),
      lastThreadId: TID,
      currentAdapter: { siteName: GSA },
      gsaChatPage: true,
      aiCmGsaChatPageMarker: function () { return ctx.gsaChatPage; },
      getCurrentConvId: function () { return ''; },  // у GSA URL-id нет
      debugLog: function (lvl, msg) { logs.push(String(msg)); },
      doAutoExportDownload: function (cid, pct, reason) {
        fired.push({ cid: cid, pct: pct, reason: reason });
        P.markAutoExportFired(ctx.autoExportFired, GSA, cid);
      },
      chrome: { storage: { session: { remove: function () { }, set: function () { } } } },
      window: { AiCmExportEmitPipeline: P }
    };
    Object.assign(ctx, over || {});
    return { ctx: ctx, logs: logs, fired: fired, run: makeRun(ctx).run };
  }

  test('регресс: настоящая чат-страница (threadId/контейнер есть) → fired как прежде', () => {
    const h = gateCtx({});
    h.run(95);
    expect(h.fired).toEqual([{ cid: TID, pct: 95, reason: 'threshold' }]);
  });

  test('captcha: состояние прошлого документа → fired нет, лог not-chat-page, латч не поставлен', () => {
    const h = gateCtx({ gsaChatPage: false });
    h.run(95);
    expect(h.fired).toHaveLength(0);
    expect(h.logs.join('\n')).toContain(
      '[AI CM][auto-export] site=google_search skip reason=not-chat-page convId=' + TID);
    expect(h.ctx.autoExportFired).toEqual({});      // поздний честный экспорт не заблокирован
  });

  test('после возврата на настоящую чат-страницу тот же разговор экспортируется (латч не сожжён)', () => {
    const h = gateCtx({ gsaChatPage: false });
    h.run(95);
    expect(h.fired).toHaveLength(0);
    h.ctx.gsaChatPage = true;                       // чат-страница: threadId снаффнут
    h.run(95);
    expect(h.fired).toEqual([{ cid: TID, pct: 95, reason: 'threshold' }]);
  });

  test('пустой текст базы на чат-странице → fired нет, reason=empty-base', () => {
    const h = gateCtx({ baseText: '' });
    h.run(95);
    expect(h.fired).toHaveLength(0);
    expect(h.logs.join('\n')).toContain('skip reason=empty-base');
  });

  test('сообщений в базе нет (msgs=0) → fired нет, reason=no-messages', () => {
    const h = gateCtx({ baseCount: 0, baseText: '' });
    h.run(95);
    expect(h.fired).toHaveLength(0);
    expect(h.logs.join('\n')).toContain('skip reason=no-messages');
  });
});

// =====================================================================================
// Source-пины: гард живёт в писателе, факты страницы доезжают до гейта
// =====================================================================================
describe('O-27: source-пины (где живёт гарантия)', () => {
  test('intercept: валидация ≥1 непустого хода в ОБОИХ писателях базы', () => {
    expect(INTERCEPT).toContain('function isUsableTurn(');
    expect(INTERCEPT).toContain('function hasUsableTurns(');
    expect(INTERCEPT).toContain('function isRawXssiPayload(');
    expect(INTERCEPT).toContain('function isGarbageBody(');
    expect(fnDecl(INTERCEPT, 'applyTurns')).toContain('if (!hasUsableTurns(turns))');
    expect(fnDecl(INTERCEPT, 'mergeTurns')).toContain('if (!hasUsableTurns(newTurns))');
    // O-27 (защитный фикс): точная форма мусора проверяется ТЕЛОМ в обоих писателях
    expect(fnDecl(INTERCEPT, 'applyTurns')).toContain('if (isGarbageBody(bodyText, turns))');
    expect(fnDecl(INTERCEPT, 'mergeTurns')).toContain('if (isGarbageBody(bodyText, newTurns))');
    // оба выходят ДО записи базы/эмита
    // O-32: точка записи applyTurns — монотонное слияние «накопитель ∪ снимок»
    // (unionFn(lastFullTurns, turns)) вместо прямого `lastFullTurns = turns.slice()`.
    const apply = fnDecl(INTERCEPT, 'applyTurns');
    expect(apply.indexOf('hasUsableTurns')).toBeLessThan(apply.indexOf('lastFullTurns = unionFn(lastFullTurns, turns)'));
    const merge = fnDecl(INTERCEPT, 'mergeTurns');
    expect(merge.indexOf('hasUsableTurns')).toBeLessThan(merge.indexOf('lastFullTurns = newTurns.slice()'));
  });

  test('content.js: признак чат-страницы + сброс состояния прошлого документа в DRAW', () => {
    const marker = fnDecl(CONTENT, 'aiCmGsaChatPageMarker');
    expect(marker).toContain("document.querySelector('[data-scope-id=\"turn\"]')");
    expect(marker).toContain("document.querySelector('[data-subtree=\"aimfl\"]')");
    expect(marker).toContain('aiCmDomThreadId()');
    expect(fnDecl(CONTENT, 'aiCmGsaResetStaleStateOnChatlessDoc')).toContain('resetConversationState()');
    // вызов — на входе DRAW (до расчёта pct и до maybeAutoExport)
    const draw = fnDecl(CONTENT, 'processAndSend');
    expect(draw).toContain('aiCmGsaResetStaleStateOnChatlessDoc();');
    expect(draw.indexOf('aiCmGsaResetStaleStateOnChatlessDoc();'))
      .toBeLessThan(draw.indexOf('maybeAutoExport(percentage);'));
  });

  test('export-manager: гейт получает site + факты чат-страницы', () => {
    const mgr = fnDecl(CONTENT, 'maybeAutoExport');
    expect(mgr).toContain('site: siteName,');
    expect(mgr).toContain('chatPageMarker: gsaChatMarker,');
    expect(mgr).toContain('msgCount: gsaMsgCount,');
    expect(mgr).toContain('baseTextLen: gsaBaseTextLen');
    expect(mgr).toContain("if (siteName === 'google_search') {");
    // прочие сайты факты не считают вовсе
    expect(mgr.indexOf("siteName === 'google_search'")).toBeLessThan(mgr.indexOf('chatPageMarker: gsaChatMarker,'));
  });

  test('пайплайн: гейт страницы экспортирован и стоит ДО гейта полноты', () => {
    expect(typeof P.shouldSkipGsaPageGuard).toBe('function');
    const gate = fnDecl(PIPELINE_SRC, 'shouldSkipAutoExport');
    expect(gate).toContain('shouldSkipGsaPageGuard(s)');
    expect(gate.indexOf('shouldSkipGsaPageGuard(s)')).toBeLessThan(gate.indexOf("reason: 'not-complete'"));
  });
});

// =====================================================================================
// Регрессионный контур: O-11 / O-31 / O-15…O-20 не тронуты
// =====================================================================================
describe('O-27: регрессионный контур', () => {
  test('O-31: сегментация по threadId жива (чужой тред по-прежнему не пишется в базу)', () => {
    const h = interceptCtx({ domTid: 'TID-A' });
    h.ctx.currentThreadId = 'TID-A';
    h.api.applyTurns(TURNS_A, 'TID-A', true);
    h.ctx.domTid = 'TID-B';
    const emitted = h.events.length;
    h.api.applyTurns([turn('b1', 'Вопрос B1', 'Ответ B1')], 'TID-B', true);
    h.api.applyTurns(TURNS_A, 'TID-A', true);       // поздний ответ старого разговора
    expect(h.ctx.lastFullMessages).toHaveLength(2);
    expect(h.events.length).toBe(emitted + 1);      // только снимок B
    expect(h.ctx.threadCache.get('TID-A').turns).toHaveLength(4);
  });

  test('O-11: латч и реестр имён не тронуты (site+convId, дисамбигуатор -2)', () => {
    const store = {};
    P.markAutoExportFired(store, GSA, TID);
    expect(P.getAutoExportFired(store, GSA, TID)).toBe(true);
    expect(P.latchKey(GSA, TID)).toBe(GSA + '|' + TID);
    const used = {};
    used['ai-context-monitor-google_search-Gemini-Search-AI-2026-09-16-10-49.txt'] = 1;
    expect(P.disambiguateFileName('ai-context-monitor-google_search-Gemini-Search-AI-2026-09-16-10-49.txt', used))
      .toBe('ai-context-monitor-google_search-Gemini-Search-AI-2026-09-16-10-49-2.txt');
  });

  test('O-31-песочница сегментации знает новые хелперы гарда (иначе писатели не исполнятся)', () => {
    const o31 = fs.readFileSync(path.join(ROOT, 'tests', 'gsa-o31-thread-segmentation.test.js'), 'utf8');
    expect(o31).toContain("'isUsableTurn'");
    expect(o31).toContain("'hasUsableTurns'");
  });

  test('O-15…O-20/O-11/O-31 — отдельные наборы на месте (исполняются npm test)', () => {
    const files = [
      'tests/adapters/deepseek-o15-pairing.test.js',
      'tests/adapters/deepseek-o16-stream-export.test.js',
      'tests/adapters/deepseek-o17-spa-chat.test.js',
      'tests/adapters/deepseek-o18-export-net-sync.test.js',
      'tests/adapters/deepseek-o18-frag-resync.test.js',
      'tests/gsa-autoexport-o11-name-collision.test.js',
      'tests/gsa-o31-thread-segmentation.test.js'
    ];
    for (const f of files) {
      expect(fs.existsSync(path.join(ROOT, f))).toBe(true);
    }
  });
});
