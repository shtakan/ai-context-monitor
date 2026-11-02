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
 *   8) предикат неполноты базы — только Qwen, в core/export-manager.js (O-54);
 *   9) O-55: публичный курсорный путь — старая страница вливается в НАЧАЛО истории,
 *      а перекрытие adopted-ходов не разрезает блок страницы.
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

// O-55: песочница «страница истории» — боевые applyHistoryPayload/recordTurn/emitSnapshot/
// renumberHistoryPage и парсер с НАСТОЯЩИМ модулем пагинации в window.AiCmQwenPagination.
// Тот же приём, что makeTurnStore: пины бьют по исходнику, а не по переписанной копии.
function makeHistoryStore(opts) {
  const o = opts || {};
  const ctx = {
    turns: [],
    userTurns: [],
    turnSeq: 0,
    currentChatId: '',
    lastReqChatId: '',
    // O-57: состояние нативной полной истории (chatId → 'pending' | 'done' | 'failed').
    fh: o.fh || {},
    dispatchSig: null,
    lastDispatchResult: false,
    dispatched: [],
    pq: { chatId: CHAT, running: false, orderFloor: 0, usedCursors: {}, pages: 0 },
    FILE_ONLY_PLACEHOLDER: '[Вложение]',
    PHASE_THINKING: 'thinking_summary',
    REASONING_TAG: '[REASONING]',
    ANSWER_TAG: '[ANSWER]',
    qwenPaginationApi: function () { return P; },
    startQwenPagination: o.startQwenPagination || function () { return false; },
    diagLine: function () {},
    diagTag: function () {},
    diagUrl: function () { return ''; },
    swallow: function () {},
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; }
  };
  ctx.window = {
    AiCmQwenPagination: P,
    dispatchEvent: function (ev) { ctx.dispatched.push(ev); return true; }
  };
  const FNS = ['contentListOf', 'isHistoryMessageNode', 'walkHistoryMessages', 'historyMessageId',
    'thinkingTextOf', 'historyThinkingOf', 'historyAnswerOf', 'historyUsageOf', 'historyChatIdOf',
    'findHistoryChatId', 'historyFilesOf', 'parseQwenHistory', 'composeTurnText', 'recordTurn',
    'buildSignature', 'userTextOf', 'emitSnapshot', 'applyHistoryPayload', 'renumberHistoryPage',
    // O-56: полная история — распознавание формы URL, парсер словаря и хронология по parentId.
    'isFullHistoryUrl', 'reindexByChain', 'qwenParseFullChain', 'qwenThinkingItem',
    'qwenReasoningOf', 'qwenContentText',
    // O-57: гард «полная история уже принята → страницу пагинации не применяем».
    'fullHistoryBlocksPage', 'skipFullHistoryPage'];
  const SCOPE = 'with (ctx) { ' + FNS.map(function (n) { return fnDecl(INTERCEPT_SRC, n); }).join('\n') +
    '\n return { applyHistoryPayload: applyHistoryPayload, recordTurn: recordTurn,' +
    ' emitSnapshot: emitSnapshot, buildSignature: buildSignature,' +
    // O-61: парсер и цепочка — наружу, чтобы пины били по исходнику (off-chain ветвление).
    ' parseQwenHistory: parseQwenHistory, qwenParseFullChain: qwenParseFullChain,' +
    ' reindexByChain: reindexByChain,' +
    ' renumberHistoryPage: renumberHistoryPage }; }';
  const api = new Function('ctx', SCOPE)(ctx);
  api.ctx = ctx;
  // O-56: чистые функции полной истории доступны тестам как есть.
  api.isFullHistoryUrl = new Function('ctx', 'with (ctx) { ' +
    fnDecl(INTERCEPT_SRC, 'isFullHistoryUrl') + ' return isFullHistoryUrl; }')(ctx);
  return api;
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
      'oldestMessageId', 'pageStepDecision', 'assignPageOrders', 'isOlderPageUrl', 'floorOf'].forEach(function (name) {
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

// ---------------------------------------------------------------------------------------
// O-55: публичный курсорный путь. Сайт сам скроллит вверх и запрашивает ?cursor=... —
// метаданных НАШЕГО цикла (m.paginate) у такого ответа нет. Раньше он дописывался в КОНЕЦ
// истории (order = max + 1), а перенумерация страницы шла только по created.
// ---------------------------------------------------------------------------------------
const BASE_URL = 'https://chat.qwen.ai/api/v2/chats/' + CHAT + '?direction=up&limit=10';
const OLDER_URL = BASE_URL + '&cursor=' + CUR;

function histTurn(id, question, answer) {
  return [
    { id: 'u-' + id, role: 'user', content: question },
    { id: id, role: 'assistant', content: answer }
  ];
}

function historyPage(turns) {
  return pageOf({
    enabled: true,
    oldest_id: CUR,
    newest_id: NEXT,
    has_more_older: true,
    path_count: 2
  }, [].concat.apply([], turns));
}

// O-56: узел нативного полного ответа (словарь chat.history.messages).
function fullNode(id, role, parentId, answer, opts) {
  const o = opts || {};
  const node = { id: id, role: role, parentId: parentId, content_list: [] };
  if (o.thinking) node.content_list.push({ phase: 'thinking', content: o.thinking });
  node.content_list.push({ phase: 'answer', content: answer });
  if (o.reasoningContent) node.reasoning_content = o.reasoningContent;
  return node;
}

// reverse=true — ключи словаря вставлены задом наперёд: хронологию задаёт только parentId.
function fullDoc(nodes, pagination, reverse) {
  const messages = {};
  const list = reverse ? nodes.slice().reverse() : nodes;
  list.forEach(function (n) { messages[n.id] = n; });
  return {
    success: true,
    request_id: 'full',
    data: {
      id: CHAT,
      chat: {
        history: {
          messages: messages,
          currentId: nodes[nodes.length - 1].id,
          pagination: pagination === undefined ? null : pagination
        }
      }
    }
  };
}

function turnOf(store, key) {
  return store.ctx.turns.filter(function (t) { return t.key === key; })[0];
}

function lastDetail(store) {
  return store.ctx.dispatched[store.ctx.dispatched.length - 1].detail;
}

function sortedKeys(turns) {
  return turns.slice().sort(function (l, r) { return l.order - r.order; })
    .map(function (t) { return t.key; });
}

describe('O-55: isOlderPageUrl — сайт сам просит более старую страницу', function () {
  test('курсор в query — старая страница; базовая и направление вниз — нет', function () {
    expect(P.isOlderPageUrl(BASE_URL)).toBe(false);
    expect(P.isOlderPageUrl(OLDER_URL)).toBe(true);
    expect(P.isOlderPageUrl('https://chat.qwen.ai/api/v2/chats/' + CHAT + '?cursor=' + CUR)).toBe(true);
    expect(P.isOlderPageUrl('https://chat.qwen.ai/api/v2/chats/' + CHAT +
      '?direction=up&limit=10&next_cursor=' + CUR)).toBe(true);
    expect(P.isOlderPageUrl('https://chat.qwen.ai/api/v2/chats/' + CHAT +
      '?cursor=' + CUR + '&direction=down')).toBe(false);
    expect(P.isOlderPageUrl('https://chat.qwen.ai/api/v2/chats/' + CHAT)).toBe(false);
    expect(P.isOlderPageUrl('https://chat.qwen.ai/api/v2/chats/' + CHAT + '?cursor=')).toBe(false);
    expect(P.isOlderPageUrl('')).toBe(false);
    expect(P.isOlderPageUrl(null)).toBe(false);
  });
});

describe('O-55: floorOf — пол страницы считается без её собственных ходов', function () {
  function t(key, order) { return { key: key, order: order }; }

  test('минимум известных ходов вне страницы', function () {
    const a = t('a', 0), b = t('b', 1), c = t('c', 2);
    expect(P.floorOf([a, b, c], [])).toBe(0);
    expect(P.floorOf([a, b, c], [a, b, c])).toBe(0);     // вся страница уже известна
    expect(P.floorOf([a, b, c], [b])).toBe(0);
    expect(P.floorOf([a, b, c], [a])).toBe(1);
  });

  test('отрицательный пол прошлой страницы продолжается', function () {
    const o1 = t('o1', -4), o2 = t('o2', -3), base = t('p1', 0);
    expect(P.floorOf([o1, o2, base], [o1, o2])).toBe(0);
    expect(P.floorOf([o1, o2, base], [base])).toBe(-4);
  });

  test('пустой список и нечисловой order — пол 0', function () {
    expect(P.floorOf([], [])).toBe(0);
    expect(P.floorOf(null, null)).toBe(0);
    expect(P.floorOf([{ key: 'x', order: 'oops' }], [])).toBe(0);
  });
});

describe('O-55: публичная старая страница (?cursor=) вливается в НАЧАЛО истории', function () {
  test('D1: запрос сайта без m.paginate — ходы страницы уходят в отрицательные order', function () {
    const store = makeHistoryStore();
    const base = store.applyHistoryPayload(historyPage([
      histTurn('a', 'Aq', 'A'),
      histTurn('b', 'Bq', 'B')
    ]), { chatId: CHAT, url: BASE_URL });
    expect(base.added).toBe(2);
    expect(store.ctx.turns.map(function (t) { return t.order; })).toEqual([0, 1]);
    expect(lastDetail(store).messageTexts).toEqual(['Aq', 'A', 'Bq', 'B']);

    // Публичный путь: сайт сам просит более старую страницу. m.paginate НЕТ.
    const older = store.applyHistoryPayload(historyPage([
      histTurn('x', 'Xq', 'X'),
      histTurn('y', 'Yq', 'Y')
    ]), { chatId: CHAT, url: OLDER_URL });

    expect(older.added).toBe(2);
    expect(turnOf(store, 'x').order).toBe(-2);
    expect(turnOf(store, 'y').order).toBe(-1);
    expect(store.ctx.pq.orderFloor).toBe(-2);
    expect(lastDetail(store).messageTexts)
      .toEqual(['Xq', 'X', 'Yq', 'Y', 'Aq', 'A', 'Bq', 'B']);
  });

  test('D2: перекрытие adopted в середине страницы не разрезает блок ходов', function () {
    const store = makeHistoryStore();
    store.applyHistoryPayload(historyPage([
      histTurn('a', 'Aq', 'A'),
      histTurn('b', 'Bq', 'B'),
      histTurn('c', 'Cq', 'C')
    ]), { chatId: CHAT, url: BASE_URL });

    // Старая страница, в середине которой сервер повторил уже известный ход b (adopted).
    store.applyHistoryPayload(historyPage([
      histTurn('x', 'Xq', 'X'),
      histTurn('b', 'Bq', 'B'),
      histTurn('y', 'Yq', 'Y')
    ]), { chatId: CHAT, url: OLDER_URL });

    const x = turnOf(store, 'x'), b = turnOf(store, 'b');
    const y = turnOf(store, 'y'), c = turnOf(store, 'c');
    expect([x.order, b.order, y.order]).toEqual([-3, -2, -1]);   // блок страницы непрерывен
    expect(y.order).toBeLessThan(c.order);

    const texts = lastDetail(store).messageTexts;
    const iX = texts.indexOf('Xq'), iB = texts.indexOf('Bq'), iY = texts.indexOf('Yq');
    expect(iX).toBeGreaterThanOrEqual(0);
    expect([iB - iX, iY - iB]).toEqual([2, 2]);                  // Xq,X | Bq,B | Yq,Y — без разрезов

    // Контроль дефекта: старый вызов assignPageOrders(created, 0) двигал ТОЛЬКО новые ходы —
    // adopted b оставался на order 1 и вклинивался между страницей и базой.
    const legacy = [
      { key: 'a', order: 0 }, { key: 'b', order: 1 }, { key: 'c', order: 2 },
      { key: 'x', order: 3 }, { key: 'y', order: 4 }
    ];
    P.assignPageOrders([legacy[3], legacy[4]], 0);
    expect(sortedKeys(legacy)).toEqual(['x', 'y', 'a', 'b', 'c']);
  });
});

describe('O-55: регрессы R1 (живой ход в конец) и R2 (дубликаты не чинятся)', function () {
  test('R1: живой ход после перенумерации старой страницы встаёт в конец (max+1)', function () {
    const store = makeHistoryStore();
    store.applyHistoryPayload(historyPage([histTurn('a', 'Aq', 'A')]), { chatId: CHAT, url: BASE_URL });
    store.applyHistoryPayload(historyPage([histTurn('x', 'Xq', 'X')]), { chatId: CHAT, url: OLDER_URL });

    const live = store.recordTurn({
      chatId: CHAT, responseId: 'z', userKey: 'u-z', userPrompt: 'Zq', answer: 'Z'
    });
    expect(live.created).toBe(true);
    expect(live.turn.order).toBe(1);                             // max(0) + 1
    store.emitSnapshot({ complete: true });
    expect(lastDetail(store).messageTexts).toEqual(['Xq', 'X', 'Aq', 'A', 'Zq', 'Z']);
  });

  test('R2: дубликат с другим id остаётся дублем — составной ключ отложен (П2-C)', function () {
    const store = makeHistoryStore();
    store.applyHistoryPayload(historyPage([histTurn('a', 'Aq', 'A')]), { chatId: CHAT, url: BASE_URL });
    const dup = store.applyHistoryPayload(historyPage([histTurn('a2', 'Aq', 'A')]), { chatId: CHAT, url: OLDER_URL });

    expect(dup.added).toBe(1);                                   // второй ход заведён, не слит
    expect(store.ctx.turns.length).toBe(2);
    expect(store.ctx.turns.map(function (t) { return t.text; })).toEqual(['A', 'A']);
    // Дедуп по составному ключу — отдельная задача П2-C; здесь поведение намеренно прежнее.
  });
});

// ===== П1: отсутствие курсора не означает конец истории =====
describe('П1: no-cursor не объявляет историю полной', function () {
  const MGR_SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'export-manager.js'), 'utf8');

  // Реальный pqFinish из исходника: причина → аргумент снимка (complete/partial/partialSoft).
  function makeFinishStore() {
    const emitted = [];
    const ctx = {
      pq: { chatId: CHAT, url: BASE_URL, pages: 3, cursorSrc: 'field',
        startTs: Date.now(), running: true, aborted: false },
      turns: [],
      diagTag: function () {},
      swallow: function () {},
      qwenPaginationApi: function () { return P; },
      emitSnapshot: function (s) { emitted.push(s); return true; }
    };
    const SCOPE = 'with (ctx) { ' + fnDecl(INTERCEPT_SRC, 'pqFinish') + '\n return pqFinish; }';
    return { ctx: ctx, emitted: emitted, finish: new Function('ctx', SCOPE)(ctx) };
  }

  function incompleteQwen(baseSeen, baseComplete, partialSoft) {
    const fn = new Function('ctx',
      'with (ctx) { ' + fnDecl(MGR_SRC, 'aiCmHistoryPaginationIncomplete') +
      '\n return aiCmHistoryPaginationIncomplete; }')({});
    return fn('qwen', baseSeen, baseComplete, partialSoft);
  }

  function snapshotDetail(s) {
    const store = makeTurnStore();
    store.ctx.turns = [{ key: 'a', order: 0, text: 'A' }];
    store.emitSnapshot(s);
    return store.ctx.dispatched[0].detail;
  }

  test('D1: oldest_id нет, has_more_older !== false → no-cursor, база неполная, автоэкспорт закрыт', function () {
    // Реальный payload: поля курсора нет вовсе, флаг «старше есть» во вложенном pagination.
    const payload = pageOf({ has_more_older: true, oldest_id: '' });
    expect(P.nextCursorOf(payload)).toBe('');
    expect(P.paginationInfo(payload).hasMoreOlder).toBe(true);
    // Шаг не может быть объявлен «концом»: pageStepDecision получает причину no-cursor.
    const dec = P.pageStepDecision({ hasCursor: false, pages: 3 }, {}, 'no-cursor');
    expect(dec.action).toBe('incomplete');
    expect(dec.complete).toBe(false);
    expect(dec.baseComplete).toBe(false);
    expect(dec.reachedStart).toBe(false);
    // Финал прогона: реальный pqFinish('no-cursor') → неполный снимок, НЕ мягкий.
    const fin = makeFinishStore();
    fin.finish('no-cursor');
    const s = fin.emitted[0];
    expect(s.complete).toBe(false);
    expect(s.partial).toEqual({ pages: 3, reason: 'no-cursor' });
    expect(s.partialSoft).toBe(false);
    const detail = snapshotDetail(s);
    expect(detail.historyComplete).toBe(false);
    expect(detail.reachedRoot).toBe(false);
    expect(detail.partial).toEqual({ pages: 3, reason: 'no-cursor' });
    // Гейт автоэкспорта: предикат неполноты держит файл (O-54 не ослаблен).
    expect(incompleteQwen(true, false, detail.partialSoft)).toBe(true);
    expect(Gate.shouldSkipAutoExport({
      enabled: true, percentage: 95, threshold: 90, loaderRunning: false, fired: false,
      isGemini: false, domBaseTrusted: true,
      site: 'qwen', baseComplete: false, baseSeen: true,
      historyIncomplete: incompleteQwen(true, false, detail.partialSoft)
    })).toEqual({ skip: true, reason: 'not-complete', resetFired: false });
  });

  test('D2: has_more_older === false → end, история полная', function () {
    const payload = pageOf({ has_more_older: false, oldest_id: '' });
    expect(P.nextCursorOf(payload)).toBe('');
    expect(P.paginationInfo(payload).hasMoreOlder).toBe(false);
    // Легитимный конец: pageStepDecision без причины и pqFinish('end') объявляют полноту.
    expect(P.pageStepDecision({ hasCursor: false, pages: 3 }).baseComplete).toBe(true);
    const fin = makeFinishStore();
    fin.finish('end');
    const s = fin.emitted[0];
    expect(s.complete).toBe(true);
    expect(s.partial).toBe(null);
    const detail = snapshotDetail(s);
    expect(detail.historyComplete).toBe(true);
    expect(detail.reachedRoot).toBe(true);
    expect(incompleteQwen(true, true, false)).toBe(false);
  });

  test('D2: source-пин pqApplyPage — «нет курсора» разводится по has_more_older', function () {
    const body = fnDecl(INTERCEPT_SRC, 'pqApplyPage');
    expect(body).toContain('api.paginationInfo(json).hasMoreOlder === false');
    expect(body).toContain("? 'end' : 'no-cursor'");
    expect(body.indexOf('no-gain')).toBeGreaterThan(body.indexOf("'no-cursor'"));
  });

  test('D3: buildSignature меняется от суммы длин пользовательских текстов', function () {
    const store = makeHistoryStore();
    store.ctx.turns = [{ key: 'q1', userKey: 'u1', order: 0, text: 'A' }];
    store.ctx.userTurns = [{ key: 'u1', text: 'ab' }];
    const before = store.buildSignature(100, true, false);
    expect(before).toContain('u:2');
    // Число ходов, ответ и serverTokens те же — меняется только длина вопроса.
    store.ctx.userTurns = [{ key: 'u1', text: 'abcdef' }];
    const after = store.buildSignature(100, true, false);
    expect(after).toContain('u:6');
    expect(after).not.toBe(before);
  });
});

describe('O-56: нативная полная история — парсер без пагинации', function () {
  const FULL_URL = 'https://chat.qwen.ai/api/v2/chats/' + CHAT;

  test('S: полный URL распознаётся по отсутствию direction/limit/cursor', function () {
    const store = makeHistoryStore();
    expect(store.isFullHistoryUrl(FULL_URL)).toBe(true);
    expect(store.isFullHistoryUrl(FULL_URL + '?')).toBe(true);
    expect(store.isFullHistoryUrl(BASE_URL)).toBe(false);
    expect(store.isFullHistoryUrl(OLDER_URL)).toBe(false);
    expect(store.isFullHistoryUrl(FULL_URL + '?foo=1')).toBe(true);
  });

  test('D1: pagination:null разбирается целиком, ходы идут по parentId (38 сообщений)', function () {
    const nodes = [];
    let parent = '';
    for (let i = 0; i < 19; i++) {
      const uid = 'u' + String(i).padStart(2, '0');
      const aid = 'a' + String(i).padStart(2, '0');
      nodes.push(fullNode(uid, 'user', parent, 'Q' + i));
      nodes.push(fullNode(aid, 'assistant', uid, 'A' + i));
      parent = aid;
    }
    const payload = fullDoc(nodes, null, true);
    const starts = [];
    const store = makeHistoryStore({
      startQwenPagination: function () { starts.push(1); return true; }
    });
    const res = store.applyHistoryPayload(payload, { chatId: CHAT, url: FULL_URL });
    const detail = lastDetail(store);

    expect(res.added).toBe(19);
    expect(detail.messages.length).toBe(38);
    expect(detail.messageTexts.length).toBe(38);
    expect(detail.messageTexts[0]).toBe('Q0');
    expect(detail.messageTexts[1]).toBe('A0');
    expect(detail.messageTexts[37]).toBe('A18');
    expect(store.ctx.turns.map(function (t) { return t.key; }))
      .toEqual(nodes.filter(function (n) { return n.role === 'assistant'; }).map(function (n) { return n.id; }));
    expect(store.ctx.turns.map(function (t) { return t.order; }))
      .toEqual(Array.from({ length: 19 }, function (_, i) { return i; }));
    expect(detail.historyComplete).toBe(true);
    expect(starts.length).toBe(0);
  });

  test('D2: reasoning из phase:thinking и reasoning_content попадает в [REASONING]', function () {
    const payload = fullDoc([
      fullNode('u0', 'user', '', 'Вопрос 1'),
      fullNode('a0', 'assistant', 'u0', 'Ответ 1', { thinking: 'Мысль из thinking' }),
      fullNode('u1', 'user', 'a0', 'Вопрос 2'),
      fullNode('a1', 'assistant', 'u1', 'Ответ 2', { reasoningContent: 'Мысль из поля' })
    ]);
    const store = makeHistoryStore();
    store.applyHistoryPayload(payload, { chatId: CHAT, url: FULL_URL });

    expect(turnOf(store, 'a0').reasoning).toBe('Мысль из thinking');
    expect(turnOf(store, 'a0').text).toBe('[REASONING]\nМысль из thinking\n\n[ANSWER]\nОтвет 1');
    expect(turnOf(store, 'a1').reasoning).toBe('Мысль из поля');
    expect(turnOf(store, 'a1').text).toBe('[REASONING]\nМысль из поля\n\n[ANSWER]\nОтвет 2');

    const messages = lastDetail(store).messages;
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].reasoning).toBe('Мысль из thinking');
    expect(messages[1].hiddenReasoning).toBe('Мысль из thinking');
    expect(messages[3].reasoning).toBe('Мысль из поля');
  });

  test('R1: pagination.oldest_id по-прежнему запускает старую пагинацию (фолбэк)', function () {
    const starts = [];
    const store = makeHistoryStore({
      startQwenPagination: function (meta, payload, count) {
        starts.push({ meta: meta, payload: payload, count: count });
        return true;
      }
    });
    store.applyHistoryPayload(historyPage([histTurn('a1', 'Вопрос', 'Ответ')]),
      { chatId: CHAT, url: BASE_URL });

    expect(starts.length).toBe(1);
    expect(starts[0].meta.url).toBe(BASE_URL);
    expect(starts[0].count).toBe(1);
    const detail = lastDetail(store);
    expect(detail.historyComplete).toBe(false);
    expect(detail.partial.reason).toBe('in-progress');
  });
});

// ---------------------------------------------------------------------------------------
// O-57: полная история чата (fh=done) — страница пагинации сайта её не перезаписывает.
// Дефект живого прогона: прокрутка вверх отдавала ?cursor=-страницу, она применялась
// поверх уже полной базы, recordTurn перезаписывал текст ходов (573k → 471k).
// ---------------------------------------------------------------------------------------
describe('O-57: fh=done — пагинационная страница не перезаписывает полную базу', function () {
  const FULL_URL = 'https://chat.qwen.ai/api/v2/chats/' + CHAT;

  // Нативный полный GET: 19 обменов = 38 сообщений, словарь без пагинации.
  function fullPayload19() {
    const nodes = [];
    let parent = '';
    for (let i = 0; i < 19; i++) {
      const uid = 'u' + String(i).padStart(2, '0');
      const aid = 'a' + String(i).padStart(2, '0');
      nodes.push(fullNode(uid, 'user', parent, 'Q' + i));
      nodes.push(fullNode(aid, 'assistant', uid, 'A' + i));
      parent = aid;
    }
    return fullDoc(nodes, null, true);
  }

  function textLen(store) {
    return store.ctx.turns.reduce(function (n, t) { return n + String(t.text || '').length; }, 0);
  }

  test('S: гард стоит в обеих точках входа — до разбора тела', function () {
    const apply = fnDecl(INTERCEPT_SRC, 'applyHistoryPayload');
    expect(apply.indexOf('fullHistoryBlocksPage(')).toBeGreaterThan(-1);
    expect(apply.indexOf('fullHistoryBlocksPage(')).toBeLessThan(apply.indexOf('parseQwenHistory('));
    const xhr = fnDecl(INTERCEPT_SRC, 'consumeHistoryXhr');
    expect(xhr.indexOf('fullHistoryBlocksPage(')).toBeGreaterThan(-1);
    expect(xhr.indexOf('fullHistoryBlocksPage(')).toBeLessThan(xhr.indexOf('JSON.parse('));
    // Наш собственный полный GET идёт мимо хуков и помечен m.full — гард его пропускает.
    expect(fnDecl(INTERCEPT_SRC, 'fullHistoryBlocksPage')).toContain('m.full === true');
  });

  test('D1: fh=done + ?cursor=-страница → count и textLen не меняются', function () {
    const store = makeHistoryStore();
    store.applyHistoryPayload(fullPayload19(), { chatId: CHAT, url: FULL_URL, full: true });
    expect(lastDetail(store).messages.length).toBe(38);
    store.ctx.fh[CHAT] = 'done';                        // noteNativeFullHistory по транспорту

    const count = store.ctx.turns.length;
    const len = textLen(store);
    const emitted = store.ctx.dispatched.length;
    const users = store.ctx.userTurns.length;
    expect([count, emitted]).toEqual([19, 1]);

    // Сайт прокрутили вверх: ?cursor=-страница несёт ТЕ ЖЕ ключи с усечённым текстом.
    const older = store.applyHistoryPayload(historyPage([
      [{ id: 'u-a00', role: 'user', content: 'Q0' },
        { id: 'a00', role: 'assistant', content: 'A' }],
      histTurn('x0', 'Xq', 'X')
    ]), { chatId: CHAT, url: OLDER_URL });

    expect(older.added).toBe(0);
    expect(older.blocked).toBe('full-history');
    expect(store.ctx.turns.length).toBe(count);
    expect(textLen(store)).toBe(len);
    expect(store.ctx.dispatched.length).toBe(emitted);   // снимок/экспорт не пересобирались
    expect(store.ctx.userTurns.length).toBe(users);
    expect(turnOf(store, 'a00').text).toBe('A0');        // текст хода не перезаписан

    // Базовая страница (?direction=up&limit=10) — тоже не трогает полную базу.
    const base = store.applyHistoryPayload(historyPage([
      [{ id: 'u-a01', role: 'user', content: 'Q1' },
        { id: 'a01', role: 'assistant', content: 'A' }]
    ]), { chatId: CHAT, url: BASE_URL });
    expect(base.blocked).toBe('full-history');
    expect(turnOf(store, 'a01').text).toBe('A1');
    expect(store.ctx.turns.length).toBe(count);
  });

  test('R1: полная история грузится штатно и при уже взведённом fh (38 сообщений)', function () {
    const store = makeHistoryStore();
    store.ctx.fh[CHAT] = 'done';
    const res = store.applyHistoryPayload(fullPayload19(), { chatId: CHAT, url: FULL_URL, full: true });
    const detail = lastDetail(store);
    expect(res.added).toBe(19);
    expect(detail.messages.length).toBe(38);
    expect(detail.historyComplete).toBe(true);
  });

  test('R2: полной истории нет — ?cursor=-фолбэк работает как раньше', function () {
    const store = makeHistoryStore();
    store.ctx.fh[CHAT] = 'failed';                      // полный GET не удался → фолбэк
    const base = store.applyHistoryPayload(historyPage([histTurn('a', 'Aq', 'A')]),
      { chatId: CHAT, url: BASE_URL });
    expect(base.added).toBe(1);
    const older = store.applyHistoryPayload(historyPage([histTurn('x', 'Xq', 'X')]),
      { chatId: CHAT, url: OLDER_URL });
    expect(older.added).toBe(1);
    expect(older.blocked).toBeUndefined();
    expect(turnOf(store, 'x').order).toBeLessThan(turnOf(store, 'a').order);
    expect(lastDetail(store).messageTexts).toEqual(['Xq', 'X', 'Aq', 'A']);
  });
});

// ---------------------------------------------------------------------------------------
// O-61: abandoned-ветки (off-chain) — в экспорт и метрики не идут, в nodes остаются.
// Живой дефект: полная история несёт словарь со всеми ответвлениями; цепочка currentId →
// parentId задаёт активные ходы, остальные — «мёртвые» ветки, которые попадали в файл.
// ---------------------------------------------------------------------------------------
describe('O-61: off-chain (abandoned) ветки не попадают в экспорт и метрики', function () {
  const FULL_URL = 'https://chat.qwen.ai/api/v2/chats/' + CHAT;

  // Активная цепочка: ровно turns обменов, parentId связывает ходы, корень — пустой.
  function activeNodes(turns) {
    const nodes = [];
    let parent = '';
    for (let i = 0; i < turns; i++) {
      const uid = 'u' + String(i).padStart(2, '0');
      const aid = 'a' + String(i).padStart(2, '0');
      nodes.push(fullNode(uid, 'user', parent, 'Q' + i));
      nodes.push(fullNode(aid, 'assistant', uid, 'A' + i));
      parent = aid;
    }
    return nodes;
  }

  // currentId — последний АКТИВНЫЙ узел: extra лежат в словаре, но в цепочку не входят.
  function docWithExtra(active, extra) {
    const messages = {};
    (extra || []).forEach(function (n) { messages[n.id] = n; });
    active.forEach(function (n) { messages[n.id] = n; });
    return {
      success: true,
      request_id: 'o61',
      data: {
        id: CHAT,
        chat: {
          history: {
            messages: messages,
            currentId: active[active.length - 1].id,
            pagination: null
          }
        }
      }
    };
  }

  function abandonedNodes() {
    const out = [];
    for (let i = 0; i < 8; i++) {
      out.push(fullNode('x' + i, 'assistant', 'a' + String(i * 11).padStart(2, '0'),
        'ABANDONED ' + i));
    }
    return out;
  }

  test('D1: 198 узлов (190 актив + 8 abandoned) → 190 сообщений / 95 ходов', function () {
    const active = activeNodes(95);
    const abandoned = abandonedNodes();
    const payload = docWithExtra(active, abandoned);
    const store = makeHistoryStore();

    const parsed = store.parseQwenHistory(payload);
    expect(parsed.nodes).toBe(198);                       // диагностика: пришло всё
    expect(parsed.messages.length).toBe(190);             // экспорт: только активные
    expect(parsed.messages.filter(function (m) { return m.role === 'assistant'; }).length).toBe(95);
    expect(parsed.messages.some(function (m) { return m.text.indexOf('ABANDONED') !== -1; })).toBe(false);

    // Цепочка помечает только 8 ответвлений; payload не мутирован.
    const chain = store.qwenParseFullChain(payload);
    expect(chain.nodes.length).toBe(198);
    expect(chain.nodes.filter(function (n) { return n.offChain === true; }).length).toBe(8);
    expect(abandoned.every(function (n) { return n.offChain === undefined; })).toBe(true);

    const res = store.applyHistoryPayload(payload, { chatId: CHAT, url: FULL_URL, full: true });
    const detail = lastDetail(store);
    expect(res.added).toBe(95);
    expect(detail.messages.length).toBe(190);
    expect(detail.count).toBe(190);
    expect(detail.text.indexOf('ABANDONED')).toBe(-1);
    expect(store.ctx.turns.length).toBe(95);
    // STEP 4: reindexByChain нумерует ТОЛЬКО активные ходы — 0..94 без дыр.
    expect(store.ctx.turns.map(function (t) { return t.order; }))
      .toEqual(Array.from({ length: 95 }, function (_, i) { return i; }));
  });

  test('R1: битый parentId — цепочка недоказана, в messages идут ВСЕ узлы (fallback)', function () {
    const active = activeNodes(3);
    active[active.length - 1].parentId = 'ghost';          // обрыв цепочки на листе
    const store = makeHistoryStore();
    const payload = docWithExtra(active, []);

    const parsed = store.parseQwenHistory(payload);
    expect(parsed.nodes).toBe(6);
    expect(parsed.messages.length).toBe(6);                // потерь нет
    const chain = store.qwenParseFullChain(payload);
    expect(chain.nodes.length).toBe(6);
    expect(chain.nodes.filter(function (n) { return n.offChain === true; }).length).toBe(0);

    // Второй вид неразрешённой цепочки: currentId не найден вовсе → walker-фолбэк.
    const broken = docWithExtra(active, []);
    broken.data.chat.history.currentId = 'ghost';
    const parsed2 = store.parseQwenHistory(broken);
    expect(parsed2.messages.length).toBe(6);
  });

  test('R2: метрики базы (textLen, msgs) считаются без off-chain', function () {
    const clean = activeNodes(95);
    const cleanStore = makeHistoryStore();
    const dirtyStore = makeHistoryStore();

    cleanStore.applyHistoryPayload(docWithExtra(clean, []),
      { chatId: CHAT, url: FULL_URL, full: true });
    dirtyStore.applyHistoryPayload(docWithExtra(clean, abandonedNodes()),
      { chatId: CHAT, url: FULL_URL, full: true });

    const a = lastDetail(cleanStore);
    const b = lastDetail(dirtyStore);
    expect(b.text).toBe(a.text);                          // textLen одинаков
    expect(b.text.length).toBe(a.text.length);
    expect(b.count).toBe(a.count);
    expect(b.messages.length).toBe(a.messages.length);    // msgs одинаков
    expect(dirtyStore.ctx.turns.length).toBe(cleanStore.ctx.turns.length);
  });
});
