/**
 * Тесты ПОРЯДКА и полноты активной цепочки DeepSeek (v7).
 *
 * В отличие от остальных deepseek-тестов (чистый хелпер parse-deepseek), эти тесты
 * грузят РЕАЛЬНЫЙ core/deepseek-intercept.js в jsdom и гоняют его через подменённый
 * window.fetch (история → wrapped fetch → ingestHistory → emitBaseSnapshot →
 * событие ai-cm-full-history). Это единственный способ проверить buildActiveChain
 * и emitBaseSnapshot «как в проде».
 *
 * Чего тесты ловят:
 *  1) sort по inserted_at УБРАН: inserted_at внутри пары инвертирован (assistant
 *     раньше user) + ISO-строки дают NaN-компаратор — эмит ВСЁ РАВНО обязан дать
 *     строгое user,assistant,user,assistant, начиная с user.
 *  2) честный historyComplete: усечённая сервером цепочка после дозапроса
 *     НЕ помечается полной (reachedRoot=false → historyComplete=false).
 *  3) convId пробрасывается в detail (гард stale-conv в content.js).
 *  4) роль unknown сохраняется как есть, не маппится в assistant.
 */

const fs = require('fs');
const path = require('path');

const INTERCEPT_PATH = path.join(__dirname, '..', '..', 'core', 'deepseek-intercept.js');

// ---- jsdom-харнесс: подменённый window.fetch играет роль сервера ----
let events = [];          // detail'ы событий ai-cm-full-history (в порядке прихода)
let serverCalls = 0;      // сколько раз fakeFetch реально обратился к «серверу»
let route = null;         // function(url) => json-тело (biz_data реакций) или null

function fakeResponse(jsonBody) {
  return {
    ok: true,
    json: () => Promise.resolve(jsonBody),
    clone: () => ({
      json: () => Promise.resolve(jsonBody),
      text: () => Promise.resolve('')
    })
  };
}

function fakeFetch(input) {
  serverCalls++;
  const url = String(typeof input === 'string' ? input : (input && input.url) || '');
  const body = route ? route(url) : null;
  return Promise.resolve(fakeResponse(body));
}

// прогон микрозадач: wrapper -> fake fetch -> clone().json() -> ingestHistory -> emit
function flush(times) {
  let p = Promise.resolve();
  for (let i = 0; i < (times || 60); i++) p = p.then(() => {});
  return p;
}

// ---- фикстуры ----

// Полная цепочка u,a,u,a. inserted_at ВНУТРИ ПАР инвертирован (assistant раньше user)
// и лежит как ISO-строка → старый компаратор давал бы NaN и инвертировал пару.
function fullFixture() {
  return {
    code: 0,
    data: {
      biz_data: {
        chat_session: { current_message_id: 'm4', model_type: 'default', is_empty: false },
        chat_messages: [
          { message_id: 'm1', parent_id: null, role: 'USER', thinking_enabled: false, inserted_at: '2026-08-29T10:00:01.000Z', accumulated_token_usage: 100, fragments: [{ type: 'REQUEST', content: 'Первый вопрос' }] },
          { message_id: 'm2', parent_id: 'm1', role: 'ASSISTANT', thinking_enabled: false, inserted_at: '2026-08-29T10:00:00.500Z', accumulated_token_usage: 800, fragments: [{ type: 'RESPONSE', content: 'Первый ответ' }] },
          { message_id: 'm3', parent_id: 'm2', role: 'USER', thinking_enabled: true, inserted_at: '2026-08-29T10:01:01.000Z', accumulated_token_usage: 1500, fragments: [{ type: 'REQUEST', content: 'Второй вопрос' }] },
          { message_id: 'm4', parent_id: 'm3', role: 'ASSISTANT', thinking_enabled: true, inserted_at: '2026-08-29T10:01:00.500Z', accumulated_token_usage: 3000, fragments: [{ type: 'RESPONSE', content: 'Второй ответ' }] }
        ]
      }
    }
  };
}

// Цепочка с сообщением нестандартной роли SYSTEM (должно остаться 'unknown').
function unknownRoleFixture() {
  return {
    code: 0,
    data: {
      biz_data: {
        chat_session: { current_message_id: 'm3', model_type: 'default', is_empty: false },
        chat_messages: [
          { message_id: 'm1', parent_id: null, role: 'USER', thinking_enabled: false, inserted_at: '2026-08-29T09:00:01.000Z', accumulated_token_usage: 100, fragments: [{ type: 'REQUEST', content: 'вопрос' }] },
          { message_id: 'm2', parent_id: 'm1', role: 'SYSTEM', thinking_enabled: false, inserted_at: '2026-08-29T09:00:02.000Z', accumulated_token_usage: 200, fragments: [{ type: 'RESPONSE', content: 'системная вставка' }] },
          { message_id: 'm3', parent_id: 'm2', role: 'ASSISTANT', thinking_enabled: true, inserted_at: '2026-08-29T09:00:03.000Z', accumulated_token_usage: 1500, fragments: [{ type: 'RESPONSE', content: 'ответ' }] }
        ]
      }
    }
  };
}

// Усечённая цепочка: у корня m1 parent_id='mX' отсутствует в chat_messages.
// Детектор усечения делает дозапрос; сервер и на дозапросе отдаёт тот же усечённый
// хвост → честный итог: reachedRoot=false, historyComplete=false.
function truncatedFixture() {
  return {
    code: 0,
    data: {
      biz_data: {
        chat_session: { current_message_id: 'm4', model_type: 'default', is_empty: false },
        chat_messages: [
          { message_id: 'm1', parent_id: 'mX', role: 'USER', thinking_enabled: false, inserted_at: '2026-08-29T08:00:01.000Z', accumulated_token_usage: 100, fragments: [{ type: 'REQUEST', content: 'первый' }] },
          { message_id: 'm2', parent_id: 'm1', role: 'ASSISTANT', thinking_enabled: false, inserted_at: '2026-08-29T08:00:02.000Z', accumulated_token_usage: 500, fragments: [{ type: 'RESPONSE', content: 'второй' }] },
          { message_id: 'm3', parent_id: 'm2', role: 'USER', thinking_enabled: true, inserted_at: '2026-08-29T08:00:03.000Z', accumulated_token_usage: 900, fragments: [{ type: 'REQUEST', content: 'третий' }] },
          { message_id: 'm4', parent_id: 'm3', role: 'ASSISTANT', thinking_enabled: true, inserted_at: '2026-08-29T08:00:04.000Z', accumulated_token_usage: 2000, fragments: [{ type: 'RESPONSE', content: 'четвёртый' }] }
        ]
      }
    }
  };
}

// История-URL в формате DeepSeek; convId должен совпадать с путём /a/chat/s/<id>.
function historyUrl(convId) {
  return 'http://localhost/api/v0/chat/history_messages?chat_session_id=' + convId + '&cache_version=abc';
}
let interceptLoaded = false;

beforeAll(() => {
  jest.useFakeTimers();
  // путь задаём ДО require — currentConvId читается из location при инициализации
  window.history.pushState({}, '', '/a/chat/s/convOrder');
  window.fetch = fakeFetch;
  global.fetch = fakeFetch;
  require(INTERCEPT_PATH);
  interceptLoaded = true;
  window.addEventListener('ai-cm-full-history', function (e) { events.push(e.detail); });
});

describe('DeepSeek buildActiveChain/emitBaseSnapshot (v7)', () => {
  it('порядок эмита строго u,a,u,a при инвертированном inserted_at внутри пар', async () => {
    events.length = 0;
    serverCalls = 0;
    route = () => fullFixture();

    await window.fetch(historyUrl('convOrder'));
    await flush(80);

    expect(serverCalls).toBe(1); // полная цепочка — дозапрос не нужен
    const d = events[events.length - 1];
    expect(d).toBeDefined();
    expect(d.convId).toBe('convOrder');                 // v7: convId в detail (stale-conv гард)
    expect(d.count).toBe(4);
    expect(d.reachedRoot).toBe(true);                   // корень m1.parent_id=null достигнут
    expect(d.historyComplete).toBe(true);               // честная полнота
    expect(d.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(d.messages[0].role).toBe('user');            // строго начинается с user
    expect(d.messageTexts).toEqual(['Первый вопрос', 'Первый ответ', 'Второй вопрос', 'Второй ответ']);
    expect(d.text.split('\n')).toEqual(['Первый вопрос', 'Первый ответ', 'Второй вопрос', 'Второй ответ']);
  });

  it('роль unknown сохраняется как есть и не маппится в assistant', async () => {
    window.history.pushState({}, '', '/a/chat/s/convUnknown'); // смена чата → reset
    events.length = 0;
    serverCalls = 0;
    route = () => unknownRoleFixture();

    await window.fetch(historyUrl('convUnknown'));
    await flush(80);

    const d = events[events.length - 1];
    expect(d).toBeDefined();
    expect(d.convId).toBe('convUnknown');
    expect(d.count).toBe(3);
    expect(d.messages.map((m) => m.role)).toEqual(['user', 'unknown', 'assistant']);
    expect(d.messages[1].role).toBe('unknown');
  });

  it('усечённая цепочка: после дозапроса historyComplete=false, reachedRoot=false', async () => {
    window.history.pushState({}, '', '/a/chat/s/convTrunc');  // смена чата → reset
    events.length = 0;
    serverCalls = 0;
    route = (url) => truncatedFixture(); // и первичный запрос, и дозапрос — одинаково усечены

    await window.fetch(historyUrl('convTrunc'));
    await flush(80);

    expect(serverCalls).toBe(2);          // первичный + тихий дозапрос детектора усечения
    const d = events[events.length - 1];
    expect(d).toBeDefined();
    expect(d.convId).toBe('convTrunc');
    expect(d.reachedRoot).toBe(false);    // корень не доказан (parent_id='mX' отсутствует)
    expect(d.historyComplete).toBe(false); // честно: база усечена, а не «всегда true»
    expect(d.count).toBe(4);              // хвост цепочки всё равно эмитится (не пустой)
    expect(d.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });
});

describe('DeepSeek: NaN-компаратор по inserted_at больше не существует', () => {
  it('ISO-строка минус ISO-строка даёт NaN — именно это ломал прежний sort', () => {
    // доказательство WHY: вычитание inserted_at (ISO) не детерминирует порядок
    expect(('2026-08-29T10:00:00.500Z') - ('2026-08-29T10:00:01.000Z')).toBeNaN();
  });

  it('в buildActiveChain нет sort по inserted_at (source-level пин)', () => {
    const source = fs.readFileSync(INTERCEPT_PATH, 'utf8');
    expect(source).not.toContain("(a.inserted_at || 0) - (b.inserted_at || 0)");
    expect(source).not.toMatch(/chain\.sort\s*\(/);
    expect(interceptLoaded).toBe(true); // харнесс реально загрузил файл
  });
});