/**
 * O-53: чистые функции курсорной пагинации Qwen (core/qwen-pagination.js).
 *
 * Здесь ПЯТЬ независимых блоков:
 *   1) форма модуля и UUID-курсор;
 *   2) historyPageUrl — сборка URL старой страницы;
 *   3) paginationInfo / nextCursorOf — где в payload живёт курсор;
 *   4) oldestMessageId — фолбэк по id при дрейфе схемы;
 *   5) pageStepDecision / assignPageOrders — решение о шаге и порядок ходов.
 *
 * Модуль ЧИСТЫЙ: сети и состояния нет, payload-объекты собраны вручную по замеру probe
 * (data.chat.history.pagination = {enabled, oldest_id, newest_id, has_more_older, ...}).
 */

const P = require('../core/qwen-pagination.js');

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
    ['isUuid', 'historyPageUrl', 'paginationInfo', 'nextCursorOf',
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
