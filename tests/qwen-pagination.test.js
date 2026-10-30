/**
 * O-53: чистые функции курсорной пагинации Qwen (core/qwen-pagination.js).
 *
 * Здесь ВОСЕМЬ независимых блоков:
 *   1) форма модуля и UUID-курсор;
 *   2) historyPageUrl — сборка URL старой страницы;
 *   3) paginationInfo / nextCursorOf — где в payload живёт курсор;
 *   4) oldestMessageId — фолбэк по id при дрейфе схемы;
 *   5) pageStepDecision / assignPageOrders — решение о шаге и порядок ходов;
 *   6) emitSnapshot / recordTurn — снимок собирается по order, а не по порядку добавления (O-54);
 *   7) гейт автоэкспорта держит Qwen до конца пагинации (O-54);
 *   8) предикат неполноты базы — только Qwen, в core/export-manager.js (O-54).
 *
 * Модуль ЧИСТЫЙ: сети и состояния нет, payload-объекты собраны вручную по замеру probe
 * (data.chat.history.pagination = {enabled, oldest_id, newest_id, has_more_older, ...}).
 */

const fs = require('fs');
const path = require('path');

const P = require('../core/qwen-pagination.js');
const Gate = require('../utils/export-emit-pipeline.js');

const INTERCEPT_SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'qwen-intercept.js'), 'utf8');

// Рез по балансу фигурных скобок (конвенция сьюта: tests/qwen-o39-history-reasoning.test.js).
function fnDecl(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('declaration not found: ' + name);
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

// O-54: emitSnapshot/recordTurn исполняются ИЗ РЕАЛЬНОГО исходника в песочнице `with (ctx)`:
// тест ловит именно тот цикл, что собирает снимок, а не переписанную копию логики.
function makeTurnStore() {
  const ctx = {
    turns: [],
    userTurns: [],
    turnSeq: 0,
    dispatchSig: null,
    lastDispatchResult: false,
    currentChatId: '',
    lastReqChatId: '',
    dispatched: [],
    buildSignature: function () { return null; },
    composeTurnText: function (answer) { return answer; },
    userTextOf: function () { return ''; },
    diagLine: function () {},
    diagTag: function () {},
    diagUrl: function () { return ''; },
    swallow: function () {},
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; }
  };
  ctx.window = { dispatchEvent: function (ev) { ctx.dispatched.push(ev); return true; } };
  const SCOPE = 'with (ctx) { ' + fnDecl(INTERCEPT_SRC, 'recordTurn') + '\n' +
    fnDecl(INTERCEPT_SRC, 'emitSnapshot') +
    '\n return { recordTurn: recordTurn, emitSnapshot: emitSnapshot }; }';
  const api = new Function('ctx', SCOPE)(ctx);
  return { ctx: ctx, recordTurn: api.recordTurn, emitSnapshot: api.emitSnapshot };
}

const CHAT = 'ab45dc99-cbab-435e-b0d3-f0440f6422df';
const CUR = 'dad1e741-f84e-4498-adc4-30de309636bd';
const NEXT = '1bce0eea-3b22-45ae-828a-4c666c95bd68';

// Минимальный payload первой страницы: та же вложенность, что у сайта.
function pageOf(pagination, messages) {
  return {
    success: true,
    request_id: '00000000-0000-4000-8000-000000000001',
    data: {
      id: CHAT,
      chat: {
        history: {
          messages: messages || {},
          currentId: 'af26d582-a534-4f03-a78e-f18693c2444b',
          pagination: pagination
        }
      }
    }
  };
}

function msg(id, role, timestamp) {
  const out = { id: id, role: role, content: 'x' };
  if (typeof timestamp === 'number') out.timestamp = timestamp;
  return out;
}

describe('O-53: форма модуля и UUID-курсор', function () {
  test('экспортирует контракт и константы', function () {
    expect(typeof P).toBe('object');
    expect(P.PAGE_LIMIT).toBe(10);
    expect(P.DEFAULT_PAGE_CAP).toBe(10);
    expect(P.DEFAULT_TIME_CAP_MS).toBe(30000);
    expect(P.SOFT_PARTIAL_REASONS).toEqual(['time-cap', 'page-cap', 'no-gain']);
    ['isUuid', 'historyPageUrl', 'paginationInfo', 'nextCursorOf', 'isSoftPartialReason',
      'oldestMessageId', 'pageStepDecision', 'assignPageOrders'].forEach(function (name) {
      expect(typeof P[name]).toBe('function');
    });
  });

  test('isUuid принимает только канонический UUID', function () {
    expect(P.isUuid(CUR)).toBe(true);
    expect(P.isUuid('DAD1E741-F84E-4498-ADC4-30DE309636BD')).toBe(true);
    expect(P.isUuid('dad1e741f84e4498adc430de309636bd')).toBe(false);
    expect(P.isUuid('{' + CUR + '}')).toBe(false);
    expect(P.isUuid('')).toBe(false);
    expect(P.isUuid(null)).toBe(false);
    expect(P.isUuid(42)).toBe(false);
  });
});

describe('R1: isSoftPartialReason — мягкий финал пагинации', function () {
  // Truth table: мягкий финал = исчерпан наш потолок или страница не дала ходов при
  // живом курсоре. error (состояние неизвестно) и cursor-loop (баг курсора) — жёсткие.
  const TABLE = [
    ['time-cap', true],
    ['page-cap', true],
    ['no-gain', true],
    ['end', false],
    ['error', false],
    ['cursor-loop', false],
    ['in-progress', false],
    ['no-start', false],
    ['', false]
  ];
  test('truth table причин завершения', function () {
    TABLE.forEach(function (row) {
      expect(P.isSoftPartialReason(row[0])).toBe(row[1]);
    });
  });

  test('не-строки и мусор не становятся мягкой причиной', function () {
    expect(P.isSoftPartialReason(null)).toBe(false);
    expect(P.isSoftPartialReason(undefined)).toBe(false);
    expect(P.isSoftPartialReason(0)).toBe(false);
    expect(P.isSoftPartialReason({})).toBe(false);
    expect(P.isSoftPartialReason(true)).toBe(false);
    expect(P.isSoftPartialReason(' time-cap')).toBe(false);
    expect(P.isSoftPartialReason('time-cap ')).toBe(false);
    expect(P.isSoftPartialReason('TIME-CAP')).toBe(false);
  });
});

describe('O-53: historyPageUrl — URL старой страницы', function () {
  test('добавляет cursor к базовому URL сайта, не дублируя direction/limit', function () {
    const url = P.historyPageUrl('https://chat.qwen.ai/api/v2/chats/' + CHAT + '?direction=up&limit=10', CUR);
    expect(url).toContain('cursor=' + CUR);
    expect(url.split('cursor=').length).toBe(2);      // ровно один параметр
    expect(url.split('direction=').length).toBe(2);   // не задублирован
    expect(url.split('limit=').length).toBe(2);
    expect(new URL(url).searchParams.get('direction')).toBe('up');
    expect(new URL(url).searchParams.get('limit')).toBe('10');
    expect(new URL(url).searchParams.get('cursor')).toBe(CUR);
  });

  test('добавляет query, если база пришла без него', function () {
    const url = P.historyPageUrl('https://chat.qwen.ai/api/v2/chats/' + CHAT, CUR);
    const u = new URL(url);
    expect(u.pathname).toBe('/api/v2/chats/' + CHAT);
    expect(u.searchParams.get('cursor')).toBe(CUR);
    expect(u.searchParams.get('direction')).toBe('up');
    expect(u.searchParams.get('limit')).toBe('10');
  });

  test('пустой курсор — база как есть (байтово)', function () {
    const base = 'https://chat.qwen.ai/api/v2/chats/' + CHAT + '?direction=up&limit=10';
    expect(P.historyPageUrl(base, '')).toBe(base);
    expect(P.historyPageUrl(base, null)).toBe(base);
    expect(P.historyPageUrl(base, undefined)).toBe(base);
  });

  test('курсор кодируется в фолбэке без конструктора URL', function () {
    // Строка не парсится new URL — идём через ручную сборку query.
    const url = P.historyPageUrl('chat.qwen.ai/api/v2/chats/' + CHAT, 'a b');
    expect(url).toBe('chat.qwen.ai/api/v2/chats/' + CHAT + '?direction=up&limit=10&cursor=a%20b');
  });

  test('null/undefined база не бросает', function () {
    expect(P.historyPageUrl(null, '')).toBe('');
    expect(P.historyPageUrl(undefined, CUR)).toContain('cursor=');
  });
});

describe('O-53: paginationInfo — авторитетный источник курсора', function () {
  test('находит реальный путь data.chat.history.pagination', function () {
    const info = P.paginationInfo(pageOf({ enabled: true, oldest_id: CUR, has_more_older: true }));
    expect(info.found).toBe(true);
    expect(info.hasMoreOlder).toBe(true);
    expect(info.oldest).toBe(CUR);
  });

  test('has_more_older=false доезжает как false', function () {
    const info = P.paginationInfo(pageOf({ oldest_id: CUR, has_more_older: false }));
    expect(info.hasMoreOlder).toBe(false);
  });

  test('нет pagination — found=false и пустые поля', function () {
    const info = P.paginationInfo({ data: { chat: { history: { messages: {} } } } });
    expect(info).toEqual({ found: false, hasMoreOlder: null, oldest: '' });
  });

  test('oldest_id не-UUID не становится курсором', function () {
    const info = P.paginationInfo(pageOf({ oldest_id: 'not-a-uuid', has_more_older: true }));
    expect(info.found).toBe(true);
    expect(info.oldest).toBe('');
  });

  test('слишком глубокая вложенность не сканируется', function () {
    let node = { oldest_id: CUR, has_more_older: true };
    for (let i = 0; i < 8; i++) node = { child: node };
    expect(P.paginationInfo(node).found).toBe(false);
  });
});

describe('O-53: nextCursorOf — курсор следующей страницы', function () {
  test('берёт pagination.oldest_id при has_more_older=true', function () {
    expect(P.nextCursorOf(pageOf({ oldest_id: CUR, has_more_older: true }))).toBe(CUR);
  });

  test('has_more_older=false — дальше не идём (пустой курсор)', function () {
    expect(P.nextCursorOf(pageOf({ oldest_id: CUR, has_more_older: false }))).toBe('');
  });

  test('pagination есть, но oldest_id пуст — курсора нет', function () {
    expect(P.nextCursorOf(pageOf({ has_more_older: true }))).toBe('');
  });

  test('generic next_cursor (дрейф схемы) подхватывается', function () {
    expect(P.nextCursorOf({ data: { next_cursor: NEXT } })).toBe(NEXT);
  });

  test('generic cursor с has_more=false — вето', function () {
    expect(P.nextCursorOf({ data: { cursor: NEXT, has_more: false } })).toBe('');
  });

  test('generic cursor не-UUID игнорируется', function () {
    expect(P.nextCursorOf({ data: { cursor: 'page-2' } })).toBe('');
  });

  test('пустой/битый payload — пустой курсор', function () {
    expect(P.nextCursorOf(null)).toBe('');
    expect(P.nextCursorOf(undefined)).toBe('');
    expect(P.nextCursorOf({})).toBe('');
    expect(P.nextCursorOf({ data: { chat: { history: { messages: [] } } } })).toBe('');
  });
});

describe('O-53: oldestMessageId — фолбэк по id', function () {
  test('выбирает сообщение с минимальным timestamp', function () {
    const messages = {
      'af26d582-a534-4f03-a78e-f18693c2444b': msg('af26d582-a534-4f03-a78e-f18693c2444b', 'user', 100),
      [CUR]: msg(CUR, 'user', 50),
      '366ec424-7dd4-41e1-8b75-cc1920cc0f34': msg('366ec424-7dd4-41e1-8b75-cc1920cc0f34', 'assistant', 60)
    };
    expect(P.oldestMessageId(pageOf({}, messages))).toBe(CUR);
  });

  test('без timestamp — первый по обходу', function () {
    const messages = {
      'af26d582-a534-4f03-a78e-f18693c2444b': msg('af26d582-a534-4f03-a78e-f18693c2444b', 'user'),
      [CUR]: msg(CUR, 'user')
    };
    expect(P.oldestMessageId(pageOf({}, messages))).toBe('af26d582-a534-4f03-a78e-f18693c2444b');
  });

  test('сообщения без UUID id и не-диалоговые роли игнорируются', function () {
    const messages = {
      'temp-1': msg('temp-1', 'user', 1),
      'system-x': { id: CUR, role: 'system', timestamp: 2 }
    };
    expect(P.oldestMessageId(pageOf({}, messages))).toBe('');
  });

  test('пустой payload — пустая строка', function () {
    expect(P.oldestMessageId(null)).toBe('');
    expect(P.oldestMessageId({})).toBe('');
  });
});

describe('O-53: pageStepDecision — потолки и конец', function () {
  test('потолок страниц срабатывает первым', function () {
    const d = P.pageStepDecision({ hasCursor: true, pages: 10, elapsedMs: 999999, added: 5 });
    expect(d).toMatchObject({ action: 'cap', reason: 'page-cap', reachedStart: false, baseComplete: false });
    expect(d.warn).toContain('10');
  });

  test('потолок времени — второй', function () {
    const d = P.pageStepDecision({ hasCursor: true, pages: 1, elapsedMs: 30000 });
    expect(d).toMatchObject({ action: 'cap', reason: 'time-cap' });
  });

  test('курсор жив — продолжаем', function () {
    const d = P.pageStepDecision({ hasCursor: true, pages: 2, elapsedMs: 10 });
    expect(d).toMatchObject({ action: 'continue', reason: 'cursor-alive' });
  });

  test('курсора нет — честный конец (даже при added=0, как на корневой странице)', function () {
    const d = P.pageStepDecision({ hasCursor: false, pages: 3, elapsedMs: 10, added: 0 });
    expect(d).toEqual({ action: 'complete', reason: 'end', reachedStart: true, baseComplete: true, warn: '' });
  });

  test('курсора нет, но страница падала — no-start', function () {
    const d = P.pageStepDecision({ hasCursor: false, failedPage: true });
    expect(d.action).toBe('complete');
    expect(d.reason).toBe('no-start');
    expect(d.reachedStart).toBe(false);
  });

  test('пустое состояние — defaults (по умолчанию потолков нет)', function () {
    const d = P.pageStepDecision({}, {});
    expect(d.action).toBe('complete');
    expect(d.reason).toBe('end');
    expect(P.pageStepDecision({ pages: 10 }).reason).toBe('page-cap');
    expect(P.pageStepDecision({ elapsedMs: 30000 }).reason).toBe('time-cap');
  });

  test('явные caps перекрывают дефолты', function () {
    expect(P.pageStepDecision({ pages: 3 }, { pageCap: 3 }).reason).toBe('page-cap');
    expect(P.pageStepDecision({ elapsedMs: 500 }, { timeCapMs: 500 }).reason).toBe('time-cap');
  });
});

describe('O-53: assignPageOrders — порядок oldest→newest', function () {
  const turn = function (key) { return { key: key, order: 0 }; };

  test('старая страница получает меньшие order и новый пол', function () {
    const created = [{ turn: turn('a') }, { turn: turn('b') }, { turn: turn('c') }];
    const floor = P.assignPageOrders(created, 0);
    expect(floor).toBe(-3);
    expect(created.map(function (x) { return x.turn.order; })).toEqual([-3, -2, -1]);
  });

  test('следующая (ещё более старая) страница продолжает пол', function () {
    const first = [{ turn: turn('a') }, { turn: turn('b') }];
    const floor1 = P.assignPageOrders(first, 0);
    const second = [{ turn: turn('c') }, { turn: turn('d') }];
    const floor2 = P.assignPageOrders(second, floor1);
    expect(floor2).toBe(-4);
    const all = first.concat(second).map(function (x) { return x.turn; });
    all.sort(function (l, r) { return l.order - r.order; });
    expect(all.map(function (t) { return t.key; })).toEqual(['c', 'd', 'a', 'b']);
  });

  test('принимает и голый массив ходов', function () {
    const turns = [turn('a'), turn('b')];
    expect(P.assignPageOrders(turns, -2)).toBe(-4);
    expect(turns.map(function (t) { return t.order; })).toEqual([-4, -3]);
  });

  test('пустой список не двигает пол', function () {
    expect(P.assignPageOrders([], 5)).toBe(5);
    expect(P.assignPageOrders(null, 5)).toBe(5);
    expect(P.assignPageOrders([], undefined)).toBe(0);
  });

  test('не-числовой floor трактуется как 0', function () {
    const created = [{ turn: turn('a') }];
    expect(P.assignPageOrders(created, 'oops')).toBe(-1);
    expect(created[0].turn.order).toBe(-1);
  });
});

describe('O-54: emitSnapshot — ходы в снимке идут по order (oldest→newest)', function () {
  test('порядок добавления в turns не равен хронологии — снимок сортирует по order', function () {
    const store = makeTurnStore();
    // Так turns выглядит после пагинации: базовая страница добавлена первой, старые страницы —
    // позже, но их order ОТРИЦАТЕЛЬНЫЙ (assignPageOrders). Без сортировки файл начинался бы
    // с 10 последних турнов, а старые дописывались бы в конец.
    store.ctx.turns = [
      { key: 'p1', order: 0, text: 'P1' },
      { key: 'p2', order: 1, text: 'P2' },
      { key: 'old1', order: -4, text: 'OLD1' },
      { key: 'old2', order: -3, text: 'OLD2' },
      { key: 'p3', order: 2, text: 'P3' }
    ];
    expect(store.emitSnapshot({ complete: true })).toBe(true);
    const detail = store.ctx.dispatched[0].detail;
    expect(detail.messageTexts).toEqual(['OLD1', 'OLD2', 'P1', 'P2', 'P3']);
    expect(detail.messageIds).toEqual(['old1', 'old2', 'p1', 'p2', 'p3']);
    expect(detail.text).toBe('OLD1\nOLD2\nP1\nP2\nP3');
    expect(detail.historyComplete).toBe(true);
  });

  test('неполный снимок тоже хронологичен (historyComplete=false)', function () {
    const store = makeTurnStore();
    store.ctx.turns = [
      { key: 'new', order: 3, text: 'NEW' },
      { key: 'old', order: -1, text: 'OLD' }
    ];
    store.emitSnapshot({ complete: false, partial: { pages: 1, reason: 'in-progress' } });
    const detail = store.ctx.dispatched[0].detail;
    expect(detail.messageTexts).toEqual(['OLD', 'NEW']);
    expect(detail.historyComplete).toBe(false);
    expect(detail.partial).toEqual({ pages: 1, reason: 'in-progress' });
  });

  test('recordTurn после перенумерации страницы в отрицательные ставит новый ход в конец (max+1)', function () {
    const store = makeTurnStore();
    const r1 = store.recordTurn({ responseId: 'r1', answer: 'R1' });
    const r2 = store.recordTurn({ responseId: 'r2', answer: 'R2' });
    expect([r1.turn.order, r2.turn.order]).toEqual([0, 1]);

    // Пагинация: ходы старой страницы уходят в отрицательные order (assignPageOrders(created, 0)).
    const older = [store.recordTurn({ responseId: 'r0', answer: 'R0' })];
    P.assignPageOrders(older, 0);
    expect(older[0].turn.order).toBe(-1);

    const live = store.recordTurn({ responseId: 'r3', answer: 'R3' });
    expect(live.turn.order).toBe(2);                    // max(1) + 1, а не turns.length (4)
    expect(live.turn.order).toBeGreaterThan(older[0].turn.order);
    store.emitSnapshot({ complete: true });
    expect(store.ctx.dispatched[0].detail.messageTexts).toEqual(['R0', 'R1', 'R2', 'R3']);
  });

  test('order не зависит от счётчика элементов: разрежённые номера не ломают хвост', function () {
    const store = makeTurnStore();
    store.ctx.turns = [
      { key: 'a', order: -2, text: 'A' },
      { key: 'b', order: 5, text: 'B' }
    ];
    const live = store.recordTurn({ responseId: 'c', answer: 'C' });
    expect(live.turn.order).toBe(6);                    // turns.length дал бы 2 — меньше уже выданного 5
    store.emitSnapshot({ complete: true });
    expect(store.ctx.dispatched[0].detail.messageTexts).toEqual(['A', 'B', 'C']);
  });
});

describe('O-54: гейт автоэкспорта — Qwen ждёт конца пагинации', function () {
  const BASE = {
    enabled: true,
    percentage: 95,
    threshold: 90,
    loaderRunning: false,
    fired: false,
    isGemini: false,
    domBaseTrusted: true
  };
  function qwen(extra) {
    return Object.assign({}, BASE, {
      site: 'qwen', baseComplete: false, baseSeen: true, historyIncomplete: true
    }, extra || {});
  }

  test('середина пагинации (historyIncomplete=true) — not-complete', function () {
    expect(Gate.shouldSkipAutoExport(qwen()))
      .toEqual({ skip: true, reason: 'not-complete', resetFired: false });
  });

  test('честный конец пагинации (historyIncomplete=false, baseComplete=true) — файл разрешён', function () {
    expect(Gate.shouldSkipAutoExport(qwen({ baseComplete: true, historyIncomplete: false })))
      .toEqual({ skip: false, reason: null, resetFired: false });
  });

  test('R1: мягкий финал (historyIncomplete=false при baseComplete=false) — файл разрешён', function () {
    // time-cap/page-cap/no-gain: база неполная, но продолжать нечем. Гейт получает
    // historyIncomplete=false (его свернул предикат с partialSoft=true) — экспорт идёт,
    // а [LOW CONFIDENCE]_ ставит export-manager.
    expect(Gate.shouldSkipAutoExport(qwen({ baseComplete: false, historyIncomplete: false })))
      .toEqual({ skip: false, reason: null, resetFired: false });
  });

  test('DOM-путь Qwen без сети (baseSeen=false) не заблокирован — как O-37', function () {
    expect(Gate.shouldSkipAutoExport(qwen({ baseSeen: false, historyIncomplete: false })))
      .toEqual({ skip: false, reason: null, resetFired: false });
  });

  test('скоуп строго Qwen: без флага вердикты DeepSeek и Gemini прежние', function () {
    const deepseek = Object.assign({}, BASE, {
      site: 'deepseek', baseComplete: false, baseSeen: true, historyIncomplete: false
    });
    expect(Gate.shouldSkipAutoExport(deepseek)).toEqual({ skip: false, reason: null, resetFired: false });

    const gemini = Object.assign({}, BASE, {
      site: 'gemini', isGemini: true, baseComplete: true, baseSeen: true, historyIncomplete: false
    });
    expect(Gate.shouldSkipAutoExport(gemini)).toEqual({ skip: false, reason: null, resetFired: false });
  });
});

describe('O-54: предикат неполноты базы — только Qwen (core/export-manager.js)', function () {
  const MGR_SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'export-manager.js'), 'utf8');

  function incomplete(site, baseSeen, baseComplete, partialSoft) {
    const ctx = {};
    const fn = new Function('ctx',
      'with (ctx) { ' + fnDecl(MGR_SRC, 'aiCmHistoryPaginationIncomplete') +
      '\n return aiCmHistoryPaginationIncomplete; }')(ctx);
    return fn(site, baseSeen, baseComplete, partialSoft);
  }

  test('Qwen: сеть без полноты — true; честный конец и отсутствие снимка — false', function () {
    expect(incomplete('qwen', true, false)).toBe(true);
    expect(incomplete('qwen', true, true)).toBe(false);
    expect(incomplete('qwen', false, false)).toBe(false);
  });

  test('R1: 4-й аргумент partialSoft снимает блокировку только у qwen', function () {
    // Мягкий финал: база неполная, но продолжать нечем → гейт не блокирует.
    expect(incomplete('qwen', true, false, true)).toBe(false);
    // Не мягкий финал (error/cursor-loop/in-progress) — поведение O-54 прежнее.
    expect(incomplete('qwen', true, false, false)).toBe(true);
    // Старый 3-аргументный вызов (partialSoft === undefined) — true, O-54 не ослаблен.
    expect(incomplete('qwen', true, false)).toBe(true);
    expect(incomplete('qwen', true, false, undefined)).toBe(true);
    // Полнота важнее флага: честный конец не становится «неполным» из-за soft.
    expect(incomplete('qwen', true, true, true)).toBe(false);
    // Строго qwen-only: флаг у прочих платформ ничего не разрешает.
    ['deepseek', 'gemini', 'chatgpt', 'claude', 'google_search', 'perplexity'].forEach(function (site) {
      expect(incomplete(site, true, false, true)).toBe(false);
    });
  });

  test('прочие платформы — всегда false, даже при неполном сетевом снимке', function () {
    ['deepseek', 'gemini', 'chatgpt', 'claude', 'google_search', 'perplexity'].forEach(function (site) {
      expect(incomplete(site, true, false)).toBe(false);
    });
    expect(incomplete('', true, false)).toBe(false);
  });
});
