/**
 * O-31 (High, живой прогон GSA 2026-09-16 12:15): сетевая база google_search дописывала
 * ходы ЧУЖИХ разговоров при SPA-переключении.
 *
 * Факты прогона: fire приписал convId=kSqqasn… базу msgs=10 (8 своих + 2 чужих), файл
 * экспорта B нёс хвост разговора A, а netMsgs рос 8→10→18→20 при domMsgs 8↔2.
 *
 * Причина (инспекция): у базы перехватчика не было принадлежности разговору.
 * mergeTurns брал `currentThreadId || emittedThreadId`, threadId самого ответа не сверял;
 * applyTurns (probe/пагинация, стартовавшие ДО переключения) применял снимок старого
 * треда к активной базе; checkThreadSwitch сбрасывал накопитель только в ветке «кэша
 * нет» (core/google-search-intercept.js:843-852 старой нумерации). А content.js принимал
 * любой снимок: lastBaseTexts = detail.messageTexts без сверки с открытым разговором
 * (core/content.js:394), поэтому чужой снимок подменял и базу (pct), и файл экспорта.
 *
 * Фикс (две точки):
 *   1) перехватчик MAIN-мира сегментирует базу по threadId: isForeignThread /
 *      absorbForeignSnapshot / activateThread — смена треда сбрасывает накопитель, снимок
 *      чужого разговора пишется ТОЛЬКО в свой сегмент (threadCache) и не эмитится;
 *   2) content.js (ISOLATED) отбрасывает снимок чужого треда ДО присвоений базы
 *      (aiCmSnapshotIsCurrentThread + aiCmDomThreadId) — defense-in-depth.
 *
 * Тест-пины: (а) два разговора эмитят последовательно → базы раздельны (8 и 2, НЕ 10),
 * pct по текущему; (б) состав экспорта канонический per-conversation — user-строки своего
 * разговора на месте, чужих ходов нет (закрывает O-30); (в) регресс O-15…O-20 и O-11
 * (два файра за минуту → «-2») — отдельные наборы, здесь проверяется их наличие и живость.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONTENT = require('./helpers/content-source.js').contentSource;
const INTERCEPT = fs.readFileSync(path.join(ROOT, 'core', 'google-search-intercept.js'), 'utf8');
const P = require('../utils/export-emit-pipeline.js');

// Рез по балансу фигурных скобок (как в tests/gsa-autoexport.test.js).
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
// Песочница РЕАЛЬНЫХ функций перехватчика (MAIN-мир) — сегментация базы по threadId
// =====================================================================================
const SCOPE_FNS = [
  'messagesFromTurns',
  // O-27 (a): валидация сетевого тела (≥1 непустой ход) — писатели базы зовут её из
  // applyTurns/mergeTurns, поэтому в песочнице она должна быть в скоупе.
  'isRawXssiPayload',
  'isUsableTurn',
  'hasUsableTurns',
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
  'checkThreadSwitch'
];
const SCOPE = 'with (ctx) { ' + SCOPE_FNS.map((n) => fnDecl(INTERCEPT, n)).join('\n') +
  '\n return { ' + SCOPE_FNS.map((n) => n + ': ' + n).join(', ') + ' }; }';
const makeIntercept = new Function('ctx', SCOPE);

function turn(id, q, a) {
  return { id: id, userText: q, assistantText: a };
}

// Разговор A — 4 хода (8 сообщений), разговор B — 1 ход (2 сообщения).
const TURNS_A = [
  turn('a1', 'Вопрос A1', 'Ответ A1'),
  turn('a2', 'Вопрос A2', 'Ответ A2'),
  turn('a3', 'Вопрос A3', 'Ответ A3'),
  turn('a4', 'Вопрос A4', 'Ответ A4')
];
const TURNS_B = [turn('b1', 'Вопрос B1', 'Ответ B1')];

function interceptCtx(over) {
  const events = [];
  const loads = [];
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
    loads: loads,
    console: { log: function () { } },
    debugLog: function (lvl, msg) { logs.push(String(msg)); },
    window: {
      GoogleFolwrUtils: require('../utils/google-search-folwr-parser.js'),
      dispatchEvent: function (ev) { events.push(ev.detail); }
    }
  };
  ctx.readDomThreadId = function () { return ctx.domTid; };
  ctx.activeLoadFolwr = function (reason) { loads.push(reason); };
  Object.assign(ctx, over || {});
  return { ctx: ctx, events: events, logs: logs, loads: loads, api: makeIntercept(ctx) };
}

const COUNT = (detail) => (detail && typeof detail.count === 'number') ? detail.count : -1;

// =====================================================================================
// (а) два разговора эмитят последовательно → базы раздельны
// =====================================================================================
describe('O-31 (а): база и счётчики — по текущему разговору', () => {
  test('8 и 2, НЕ 10: база нового разговора не содержит ходов старого', () => {
    const h = interceptCtx({ domTid: 'TID-A' });
    h.ctx.currentThreadId = 'TID-A';

    h.api.applyTurns(TURNS_A, 'TID-A', true);
    expect(h.ctx.lastFullMessages).toHaveLength(8);
    expect(COUNT(h.events[h.events.length - 1])).toBe(8);
    expect(h.ctx.baseThreadId).toBe('TID-A');

    // SPA-переключение: DOM уже на B
    h.ctx.domTid = 'TID-B';
    h.api.applyTurns(TURNS_B, 'TID-B', true);

    expect(h.ctx.lastFullMessages).toHaveLength(2);          // ← было 10 (8 своих + 2 чужих)
    expect(COUNT(h.events[h.events.length - 1])).toBe(2);
    expect(h.ctx.lastFullMessages.length).not.toBe(10);
    expect(h.ctx.baseThreadId).toBe('TID-B');
    // сегмент A не потерян — лежит отдельно (SPA-возврат отдаст его из кэша)
    expect(h.ctx.threadCache.get('TID-A').turns).toHaveLength(4);
  });

  test('поздний ответ старого разговора (applyTurns probe/пагинации) в базу нового не идёт', () => {
    const h = interceptCtx({ domTid: 'TID-A' });
    h.ctx.currentThreadId = 'TID-A';
    h.api.applyTurns(TURNS_A, 'TID-A', true);
    h.ctx.domTid = 'TID-B';
    h.api.applyTurns(TURNS_B, 'TID-B', true);
    const emitted = h.events.length;

    // probe/пагинация стартовали на A и завершились уже после переключения на B
    h.api.applyTurns(TURNS_A, 'TID-A', true);

    expect(h.ctx.lastFullMessages).toHaveLength(2);          // активная база B не выросла
    expect(h.events.length).toBe(emitted);                   // чужой снимок не эмитится
    expect(h.ctx.threadCache.get('TID-A').turns).toHaveLength(4);
    expect(h.logs.join('\n')).toContain('снимок чужого разговора не применён: tid=TID-A');
  });

  test('поздний ответ старого разговора (mergeTurns/folif) уходит в свой сегмент', () => {
    const h = interceptCtx({ domTid: 'TID-A' });
    h.ctx.currentThreadId = 'TID-A';
    h.api.applyTurns(TURNS_A, 'TID-A', true);
    h.ctx.domTid = 'TID-B';
    h.api.applyTurns(TURNS_B, 'TID-B', true);
    const emitted = h.events.length;

    h.api.mergeTurns([turn('a5', 'Вопрос A5', 'Ответ A5')], true, 'TID-A');

    expect(h.ctx.lastFullMessages).toHaveLength(2);          // база B цела
    expect(h.events.length).toBe(emitted);
    expect(h.ctx.threadCache.get('TID-A').turns.map((t) => t.id))
      .toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);              // ход остался у СВОЕГО разговора
    // обратный случай: свой ответ того же разговора применяется как прежде
    h.api.mergeTurns([turn('a5', 'Вопрос A5', 'Ответ A5')], true, 'TID-B');
    expect(h.ctx.lastFullMessages).toHaveLength(2);          // дедуп по ключу — без роста
  });

  test('SPA-возврат в A: сегменты независимы (8 у A, 2 у B)', () => {
    const h = interceptCtx({ domTid: 'TID-A' });
    h.ctx.currentThreadId = 'TID-A';
    h.api.applyTurns(TURNS_A, 'TID-A', true);
    h.ctx.domTid = 'TID-B';
    h.api.applyTurns(TURNS_B, 'TID-B', true);

    h.ctx.domTid = 'TID-A';                                  // возврат в разговор A
    // база всё ещё принадлежит B → опрос DOM ре-синхронизирует её на A (сегмент из кэша)
    expect(h.api.checkThreadSwitch()).toBe(true);

    expect(h.ctx.lastFullMessages).toHaveLength(8);
    expect(COUNT(h.events[h.events.length - 1])).toBe(8);
    expect(h.ctx.threadCache.get('TID-B').turns).toHaveLength(1);
    expect(h.loads).toHaveLength(0);                         // кэш A был — активная догрузка не нужна
  });

  test('pct считается по базе текущего разговора (текст снимка — только свои ходы)', () => {
    const h = interceptCtx({ domTid: 'TID-A' });
    h.ctx.currentThreadId = 'TID-A';
    h.api.applyTurns(TURNS_A, 'TID-A', true);
    h.ctx.domTid = 'TID-B';
    h.api.applyTurns(TURNS_B, 'TID-B', true);

    const last = h.events[h.events.length - 1];
    // pct считается по baseText/baseCount/effectiveLen — все они производные ЭТОГО detail
    expect(last.text).toBe('Вопрос B1\nОтвет B1');
    expect(last.text).not.toContain('Вопрос A');
    expect(last.effectiveLen).toBe('Вопрос B1\nОтвет B1'.length);
    expect(h.ctx.lastFullMessages.map((m) => m.text))
      .toEqual(['Вопрос B1', 'Ответ B1']);
  });

  test('новый разговор без кэша: накопитель сбрасывается, чужое не переносится', () => {
    const h = interceptCtx({ domTid: 'TID-A' });
    h.ctx.currentThreadId = 'TID-A';
    h.api.applyTurns(TURNS_A, 'TID-A', true);
    // уходим на невиданный ранее разговор C (кэша нет)
    h.ctx.domTid = 'TID-C';
    expect(h.api.checkThreadSwitch()).toBe(true);
    expect(h.ctx.lastFullTurns).toHaveLength(0);             // сетевой накопитель сброшен
    expect(h.ctx.lastFullMessages).toHaveLength(0);
    expect(h.ctx.baseThreadId).toBe('TID-C');
    expect(h.loads).toEqual(['thread-switch:TID-C']);        // активная догрузка истории C
  });
});

// =====================================================================================
// (б) состав экспорта канонический per-conversation (закрывает O-30)
// =====================================================================================
describe('O-31 (б): экспорт — канонический состав своего разговора', () => {
  test('user-строки своего разговора присутствуют, чужих ходов нет', () => {
    const h = interceptCtx({ domTid: 'TID-A' });
    h.ctx.currentThreadId = 'TID-A';
    h.api.applyTurns(TURNS_A, 'TID-A', true);
    h.ctx.domTid = 'TID-B';
    h.api.applyTurns(TURNS_B, 'TID-B', true);
    h.api.applyTurns(TURNS_A, 'TID-A', true);                 // поздний чужой снимок

    const detail = h.events[h.events.length - 1];
    // экспорт собирается из lastBaseTexts = detail.messageTexts, роли — из detail.messages
    expect(detail.messageTexts).toEqual(['Вопрос B1', 'Ответ B1']);
    expect(detail.messages).toEqual([
      { role: 'user', text: 'Вопрос B1' },
      { role: 'assistant', text: 'Ответ B1' }
    ]);
    const users = detail.messages.filter((m) => m.role === 'user').map((m) => m.text);
    expect(users).toEqual(['Вопрос B1']);                    // user-строка СВОЕГО разговора на месте
    expect(detail.text).not.toContain('A1');
    expect(detail.text).not.toContain('A4');
  });

  test('content.js: чужой снимок отбрасывается ДО присвоений базы (source-пин)', () => {
    const iGuard = CONTENT.indexOf('!aiCmSnapshotIsCurrentThread(detail.threadId, domTid31)');
    const iBase = CONTENT.indexOf('lastBaseTexts = texts;');
    expect(iGuard).toBeGreaterThan(-1);
    expect(iBase).toBeGreaterThan(iGuard);                   // гард стоит выше приёма базы
    expect(CONTENT).toContain('function aiCmSnapshotIsCurrentThread(emitThreadId, domThreadId)');
    expect(CONTENT).toContain('function aiCmDomThreadId()');
    expect(CONTENT).toContain("document.querySelector('[data-session-thread-id]')");
    expect(CONTENT).toContain('O-31: снимок чужого разговора не применён');
    // счётчики/база/экспорт прежних имён: гард ничего не переименовывает
    expect(CONTENT).toContain('var netMsgsS1 = lastBaseTexts.length;');
  });

  test('aiCmSnapshotIsCurrentThread: чистый гард (поведение)', () => {
    const src = 'with (ctx) { ' + fnDecl(CONTENT, 'aiCmSnapshotIsCurrentThread') +
      '\n return { f: aiCmSnapshotIsCurrentThread }; }';
    const f = new Function('ctx', src)({}).f;
    expect(f('TID-A', 'TID-B')).toBe(false);                 // снимок чужого треда — отбросить
    expect(f('TID-B', 'TID-B')).toBe(true);                  // свой разговор — принять
    expect(f('', 'TID-B')).toBe(true);                       // снимок без threadId — прежнее поведение
    expect(f('TID-A', '')).toBe(true);                       // DOM-атрибута нет — прежнее поведение
    expect(f('TID-A', null)).toBe(true);
    expect(f(null, 'TID-A')).toBe(true);
  });

  test('aiCmDomThreadId читает data-session-thread-id живого DOM', () => {
    const src = 'with (ctx) { ' + fnDecl(CONTENT, 'aiCmDomThreadId') +
      '\n return { f: aiCmDomThreadId }; }';
    const mk = (attr) => new Function('ctx', src)({
      document: { querySelector: () => (attr === null ? null : { getAttribute: () => attr }) }
    }).f;
    expect(mk('TID-B')()).toBe('TID-B');
    expect(mk('  TID-B  ')()).toBe('TID-B');
    expect(mk('')()).toBe('');
    expect(mk(null)()).toBe('');
  });
});

// =====================================================================================
// (в) регресс: одиночный разговор байтово прежний; O-11 и O-15…O-20 живы
// =====================================================================================
describe('O-31 (в): регрессионный контур', () => {
  test('buildDetail одиночного разговора байтово прежний (форма снимка не изменилась)', () => {
    const h = interceptCtx({ domTid: 'TID-A' });
    const d = h.api.buildDetail(TURNS_B, undefined, 'TID-A', true);
    expect(d).toEqual({
      convId: '',
      threadId: 'TID-A',
      text: 'Вопрос B1\nОтвет B1',
      count: 2,
      effectiveLen: 'Вопрос B1\nОтвет B1'.length,
      lastMessageText: 'Ответ B1',
      modelSlug: 'gemini-2.5-flash',
      messageTexts: ['Вопрос B1', 'Ответ B1'],
      messageIds: ['b1_user', 'b1_assistant'],
      messages: [
        { role: 'user', text: 'Вопрос B1' },
        { role: 'assistant', text: 'Ответ B1' }
      ],
      attachTokens: 0,
      attachBreak: { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 },
      historyComplete: true
    });
  });

  test('обе точки мутации базы перехватчика проходят через сегментацию (source-пин)', () => {
    expect(fnDecl(INTERCEPT, 'applyTurns')).toContain('absorbForeignSnapshot(tid, turns, historyComplete)');
    expect(fnDecl(INTERCEPT, 'mergeTurns')).toContain('absorbForeignSnapshot(threadId, newTurns, false)');
    expect(fnDecl(INTERCEPT, 'checkThreadSwitch')).toContain('activateThread(tid)');
    // threadId ТЕЛА ответа доезжает до mergeTurns (иначе атрибуция по DOM/активному треду)
    expect(INTERCEPT).toContain('mergeTurns(parsed.turns, isFull, parsed.threadId);');
    expect(INTERCEPT).toContain('mergeTurns(parsed.turns, isFullXhr, parsed.threadId);');
    // живой DOM — источник правды о текущем разговоре
    expect(fnDecl(INTERCEPT, 'isForeignThread')).toContain('tid !== domTid');
    // probe-вердикт полноты (F1, O-28) не тронут
    expect(INTERCEPT).toContain('applyTurns(merged.length > 0 ? merged : lastFullTurns, tid, true);');
    expect(INTERCEPT).toContain('historyComplete: historyComplete !== false');
  });

  test('O-11: дисамбигуатор «-2» жив (два файра в одну минуту → разные имена)', () => {
    expect(P.disambiguateFileName('a.txt', { 'a.txt': true })).toBe('a-2.txt');
    expect(P.disambiguateFileName('a.txt', { 'a.txt': true, 'a-2.txt': true })).toBe('a-3.txt');
    expect(P.disambiguateFileName('a.txt', {})).toBe('a.txt');
  });

  test('регресс-наборы O-15…O-20 и O-11 на месте (исполняются npm test)', () => {
    const suites = [
      'tests/adapters/deepseek-o15-pairing.test.js',
      'tests/adapters/deepseek-o16-stream-export.test.js',
      'tests/adapters/deepseek-o17-spa-chat.test.js',
      'tests/adapters/deepseek-o18-export-net-sync.test.js',
      'tests/adapters/deepseek-o18-frag-resync.test.js',
      'tests/export-sanitize.test.js',                       // O-20
      'tests/gsa-autoexport-o11-name-collision.test.js'      // O-11 раунд 1/2
    ];
    suites.forEach((rel) => {
      expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
    });
    const o11 = fs.readFileSync(path.join(ROOT, 'tests/gsa-autoexport-o11-name-collision.test.js'), 'utf8');
    expect(o11).toContain('-2');                             // пин «два файра за минуту → -2»
    expect(fs.readFileSync(path.join(ROOT, 'core/export-manager.js'), 'utf8'))
      .toContain('function aiCmAutoExportStartDownload(');
  });
});
