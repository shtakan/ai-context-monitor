/**
 * tests/adapters/aistudio-network.test.js — сетевой перехват истории AI Studio.
 *
 * ЧТО ПРОВЕРЯЕМ. core/aistudio-intercept.js (MAIN-мир, aistudio.google.com) патчит
 * fetch/XHR, читает тела `$rpc`-запросов и ответов и передаёт в ISOLATED разобранные
 * данные:
 *   • 'history' — ходы диалога: ответ UpdatePrompt/CreatePrompt (`data[13][0]`) и
 *                 тело запроса GenerateContent (`data[1]`);
 *   • 'count'   — точный размер контекста из usage ответа GenerateContent.
 * Плюс adapters/aistudio-adapter.js, который обязан предпочесть сеть DOM-фолбэку.
 *
 * ОТКУДА ФОРМАТЫ. Фикстуры собраны по живому захвату AI Studio (октябрь 2026, чат
 * /prompts/1sLNDy3E1UDKpOyYVg1kcWCk6PvB70rOS, 3 хода):
 *   • ответ UpdatePrompt — 14-элементный массив, `data[13][0]` = 9 сообщений по 33
 *     поля: текст `msg[0]`, роль `msg[8]` ('user'/'model'), «мысль» помечена
 *     `msg[19] === 1` (на 3 хода приходится 3 мысли → после фильтра остаётся 6 реплик);
 *   • тело GenerateContent — `data[1]` = 5 ходов `[[part, …], role]`, текст части
 *     `turn[0][j][1]`, роль `turn[1]`; у ответа модели часть 0 — reasoning (последний
 *     элемент части 1), части 1..2 — куски ответа, часть 3 — пустой текст с подписью;
 *   • ответ GenerateContent — `[ [chunk, …] ]`, chunk это `[content, null, usage,
 *     null, id]`, usage = `[promptTokens, candidateTokens, totalTokens, …]`
 *     (219 → 486 по потоку; 486 и есть размер контекста).
 *
 * КАК ЗАПУСКАЕМ. Перехватчик — классический скрипт MAIN-мира: грузим его исходник в
 * минимальную песочницу с ОДНИМ общим `window` (как в браузере: патчи fetch/XHR и
 * window.__aiCmNetMsgs живут в одном объекте, их и проверяем). Адаптер грузится
 * штатным харнессом (tests/helpers/adapter-harness.js) поверх jsdom.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { loadSource, REPO_ROOT } = require('../helpers/adapter-harness');

const INTERCEPTOR = path.join(REPO_ROOT, 'core', 'aistudio-intercept.js');
const SOURCE = fs.readFileSync(INTERCEPTOR, 'utf8');

const AISTUDIO_LOC = {
  hostname: 'aistudio.google.com',
  pathname: '/prompts/abc123',
  href: 'https://aistudio.google.com/prompts/abc123'
};

/** Настоящие эндпоинты AI Studio (из захвата): MAKER_SUITE + имя метода. */
const MAKER_SUITE = 'https://alkalimakersuite-pa.clients6.google.com/$rpc/' +
  'google.internal.alkali.applications.makersuite.v1.MakerSuiteService/';
const UPDATE_URL = MAKER_SUITE + 'UpdatePrompt';
const CREATE_URL = MAKER_SUITE + 'CreatePrompt';
const GENERATE_URL = MAKER_SUITE + 'GenerateContent';

/** Микротаски (клон → text → обработчик) — дожидаемся обработки тела ответа. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Песочница MAIN-мира: `window` один и тот же для патчей, событий и __aiCmNetMsgs.
 * @param {object} [options] { fetch, XMLHttpRequest, location, source }
 */
function makeSandbox(options) {
  const opts = options || {};
  const events = [];
  const logs = [];
  const warns = [];
  const errors = [];
  const listeners = Object.create(null);

  const win = {
    location: opts.location || Object.assign({}, AISTUDIO_LOC),
    addEventListener: function (name, fn) {
      (listeners[name] = listeners[name] || []).push(fn);
    },
    removeEventListener: function () { },
    dispatchEvent: function (ev) { events.push(ev); return true; },
    // fetch/XHR появляются ДО загрузки перехватчика — он снимает их на старте.
    fetch: opts.fetch,
    XMLHttpRequest: opts.XMLHttpRequest
  };

  const ctx = {
    window: win,
    // CustomEvent должен вести себя как браузерный: detail кладёт вызывающий.
    CustomEvent: function CustomEvent(type, init) {
      this.type = type;
      this.detail = (init && init.detail !== undefined) ? init.detail : null;
    },
    console: {
      log: function () { logs.push(Array.prototype.join.call(arguments, ' ')); },
      warn: function () { warns.push(Array.prototype.join.call(arguments, ' ')); }
    },
    swallowSoft: function (e, tag) { errors.push(String(tag || '')); }
  };

  const argNames = Object.keys(ctx);
  const argValues = argNames.map(function (k) { return ctx[k]; });
  const source = opts.source === undefined ? SOURCE : opts.source;
  // eslint-disable-next-line no-new-func
  const factory = Function.apply(null, argNames.concat([source + '\nreturn window.AiCmAistudioIntercept;\n']));
  const api = factory.apply(null, argValues);

  return {
    api: api,
    win: win,
    events: events,
    logs: logs,
    warns: warns,
    errors: errors,
    fire: function (name, detail) {
      const ev = { type: name, detail: detail };
      (listeners[name] || []).forEach(function (fn) { fn(ev); });
    }
  };
}

/** fetch-заглушка: отвечает на каждый URL заранее заданным Response-подобным объектом. */
function makeFetch(responder) {
  const fn = function (input) {
    const url = (typeof input === 'string') ? input : ((input && input.url) || '');
    return Promise.resolve(responder(url));
  };
  fn.__aiCmAistudioWrapped = false;
  return fn;
}

/** Response-подобный объект: тело читается ТОЛЬКО через clone().text() — как в браузере. */
function makeResponse(body, contentType) {
  const state = { textReads: 0 };
  const resp = {
    headers: {
      get: function (name) {
        return (String(name).toLowerCase() === 'content-type') ? (contentType || 'application/json+protobuf') : null;
      }
    },
    clone: function () {
      return {
        text: function () {
          state.textReads++;
          return Promise.resolve(body);
        }
      };
    },
    text: function () {
      throw new Error('оригинальное тело страницы не должно читаться перехватчиком');
    },
    state: state
  };
  return resp;
}

/** Минимальный XMLHttpRequest: open/send + события, как у настоящего. */
function makeXhrClass() {
  function FakeXhr() {
    this._listeners = Object.create(null);
    this.responseText = '';
    this.responseType = '';
    this._headers = Object.create(null);
    this.opened = 0;
    this.sent = 0;
    this.sentBody = undefined;
  }
  FakeXhr.prototype.open = function (method, url) {
    this.method = method;
    this.url = url;
    this.opened++;
  };
  FakeXhr.prototype.send = function (body) {
    this.sent++;
    this.sentBody = body;
  };
  FakeXhr.prototype.addEventListener = function (name, fn) {
    (this._listeners[name] = this._listeners[name] || []).push(fn);
  };
  FakeXhr.prototype.getResponseHeader = function (name) {
    return this._headers[String(name).toLowerCase()] || null;
  };
  FakeXhr.prototype.fire = function (name) {
    (this._listeners[name] || []).forEach(function (fn) { fn.call(this); }, this);
  };
  return FakeXhr;
}

/* ------------------------------------------------------------------ *
 * Фикстуры — точная форма протобуфера из живого захвата
 * ------------------------------------------------------------------ */

/**
 * Сообщение снимка UpdatePrompt: 33 поля, текст [0], роль [8], признак «мысли»
 * `[19] === 1`, счётчик токенов [18], время хода [32].
 */
function snapshotMsg(text, role, opts) {
  const o = opts || {};
  const m = new Array(33).fill(null);
  m[0] = text;
  m[8] = role;
  if (o.reasoning) m[19] = 1;
  if (typeof o.tokens === 'number') m[18] = o.tokens;
  m[32] = ['1793095607', 981000000];
  return m;
}

/**
 * Ответ UpdatePrompt/CreatePrompt: 14 полей, поле 13 — `[сообщения, ожидающий ход]`.
 * Поле 13 у протобуфера Prompt действительно массив — пустые поля 1..12 значимы.
 */
function snapshotBody(msgs) {
  const data = new Array(13).fill(null);
  data[0] = 'prompts/1sLNDy3E1UDKpOyYVg1kcWCk6PvB70rOS';
  data[12] = [];
  data.push([msgs, [['', null, null, null, null, null, null, null, 'user']]]);
  return JSON.stringify(data);
}

/** Ход, отправленный в редакторе: 9 сообщений, из них 3 — «мысли» модели. */
const HISTORY_MSGS = [
  snapshotMsg('Тест 1\n', 'user'),
  snapshotMsg('**Interpreting the Input**\n\nРазбираю ввод пользователя.', 'model', { reasoning: true, tokens: 162 }),
  snapshotMsg('Тест 1 пройден успешно! Связь работает отлично. \n\nЧем могу вам помочь?', 'model', { tokens: 20 }),
  snapshotMsg('Тест 2', 'user'),
  snapshotMsg('**Initiating Russian Test Flow**\n\nПродолжаю тестовый сценарий.', 'model', { reasoning: true }),
  snapshotMsg('Тест 2 также пройден успешно! Системы работают в штатном режиме. \n\nГотов к следующему тесту или вашей задаче.', 'model'),
  snapshotMsg('Тест 3\n', 'user'),
  snapshotMsg('**Confirming Test Completion**\n\nФиксирую завершение проверки.', 'model', { reasoning: true }),
  snapshotMsg('Тест 3 принят! Сигнал стабильный, всё работает без сбоев.', 'model')
];

const HISTORY_BODY = snapshotBody(HISTORY_MSGS);

/** Часть хода в теле запроса: `[null, "текст"]` — поле 2 части это её текст. */
const reqPart = (text) => [null, text];

/** Reasoning-часть: последний элемент части равен 1 (живой захват: 13 полей). */
function reqThought(text) {
  const p = new Array(13).fill(null);
  p[1] = text;
  p[12] = 1;
  return p;
}

/** Пустая часть с подписью мысли (15 полей, текст пуст) — в захвате есть всегда. */
function reqSignaturePart() {
  const p = new Array(15).fill(null);
  p[1] = '';
  p[14] = 'EpUHCpIHAWkUfRPHJxNQNTRQhtFEoHP5MLEDY9UO';
  return p;
}

/** Ход запроса: `[[part, …], "role"]`. */
const reqTurn = (parts, role) => [parts, role];

/**
 * Тело запроса GenerateContent: 14 полей, поле 1 — ходы, поле 13 — таймзона
 * (`[[null, null, "Asia/Yekaterinburg"]]`). Таймзона — ловушка для парсера:
 * без проверки формы она выдала бы «сообщение» с ролью из служебного поля.
 */
function requestBody(turns) {
  const data = new Array(14).fill(null);
  data[0] = 'models/gemini-3.8-flash';
  data[1] = turns;
  data[13] = [[null, null, 'Asia/Yekaterinburg']];
  return JSON.stringify(data);
}

/** 5 ходов из захвата: ответы модели разбиты на reasoning + два куска текста. */
const REQUEST_BODY = requestBody([
  reqTurn([reqPart('Тест 1\n')], 'user'),
  reqTurn([
    reqThought('**Interpreting the Input**\n\nРазбираю ввод пользователя.'),
    reqPart('Тест 1 пройден успешно! Связь работает отлично'),
    reqPart('. \n\nЧем могу вам помочь?'),
    reqSignaturePart()
  ], 'model'),
  reqTurn([reqPart('Тест 2')], 'user'),
  reqTurn([
    reqThought('**Initiating Russian Test Flow**\n\nПродолжаю тестовый сценарий.'),
    reqPart('Тест 2 также пройден успешно! Системы работают в штатном режиме. \n\n'),
    reqPart('Готов к следующему тесту или вашей задаче.'),
    reqSignaturePart()
  ], 'model'),
  reqTurn([reqPart('Тест 3\n')], 'user')
]);

/** usage чанка: `[promptTokens, candidateTokens, totalTokens, null, [[1, prompt]], …]`. */
function chunkUsage(prompt, candidate, total) {
  return [prompt, candidate, total, null, [[1, prompt]], null, null, null, null, 110];
}

/** Чанк потока: `[content, null, usage, null, id]`; content — текст на глубине, роли нет в нём. */
function streamChunk(text, usage) {
  return [[[[null, text]], 'model'], null, usage || null, null, 'v1_Chd0ZXN0'];
}

/**
 * Ответ GenerateContent: `[ [chunk, …] ]`. promptTokenCount накапливается по
 * потоку (219 → 486), финальный чанк приходит без usage — терминальная отметка.
 */
const TOKENS_BODY = JSON.stringify([[
  streamChunk('нал', chunkUsage(219, null, 315)),
  streamChunk(' стабильный,', chunkUsage(219, 9, 338)),
  streamChunk(' всё работает без сбоев.', chunkUsage(219, 38, 367)),
  streamChunk('', chunkUsage(486, 38, 634)),
  streamChunk('', null)
]]);

/** Ответ CountTokens из захвата: считает только ВХОД — в контекст не годится. */
const COUNT_TOKENS_BODY = '[5,[],[[[4],1]],null,null,[[1,5]]]';

describe('core/aistudio-intercept.js: классификация $rpc-запросов', () => {
  const api = makeSandbox().api;

  test('GenerateContent узнаётся по имени метода и только внутри $rpc', () => {
    const h = api.__handlers;
    expect(h.isGenerateRpc(GENERATE_URL)).toBe(true);
    expect(h.isGenerateRpc('https://aistudio.google.com/$rpc/x/GenerateContent')).toBe(true);
    expect(h.isGenerateRpc('https://aistudio.google.com/api/GenerateContent')).toBe(false);
    expect(h.isGenerateRpc(MAKER_SUITE + 'CountTokens')).toBe(false);
    expect(h.isGenerateRpc('')).toBe(false);
  });

  test('история: UpdatePrompt / CreatePrompt под $rpc', () => {
    const h = api.__handlers;
    expect(h.isHistoryRpc(UPDATE_URL)).toBe(true);
    expect(h.isHistoryRpc(CREATE_URL)).toBe(true);
    expect(h.isHistoryRpc('https://aistudio.google.com/api/UpdatePrompt')).toBe(false);
    // CountTokens не история: счётчик берётся из GenerateContent
    expect(h.isHistoryRpc(MAKER_SUITE + 'CountTokens')).toBe(false);
    expect(h.isHistoryRpc(GENERATE_URL)).toBe(false);
  });

  test('ListPrompts — библиотека промптов, не история диалога', () => {
    // Живой лог: на странице /prompts/... ListPrompts вызывается 4 раза, но его
    // ответ — карточки промптов, data[13][0] в нём нет (проверено захватом).
    const h = api.__handlers;
    expect(h.isHistoryRpc(MAKER_SUITE + 'ListPrompts')).toBe(false);
    expect(h.isHistoryRpc(MAKER_SUITE + 'ListModels')).toBe(false);
    expect(h.isHistoryRpc(MAKER_SUITE + 'ResolveDriveResource')).toBe(false);
  });
});

describe('core/aistudio-intercept.js: снимок UpdatePrompt (data[13][0])', () => {
  const h = makeSandbox().api.__handlers;

  test('9 сообщений с 3 «мыслями» → 6 реплик, reasoning отфильтрован', () => {
    const found = h.findMessageArray(JSON.parse(HISTORY_BODY));
    expect(found.path).toBe('13[0]');
    const msgs = found.msgs;
    expect(msgs).toHaveLength(6);
    expect(msgs.map(function (m) { return m.role; })).toEqual([
      'user', 'assistant', 'user', 'assistant', 'user', 'assistant'
    ]);
    expect(msgs[0].text).toBe('Тест 1');
    expect(msgs[1].text).toBe('Тест 1 пройден успешно! Связь работает отлично. \n\nЧем могу вам помочь?');
    // текст «мысли» не попал ни в одну реплику
    expect(msgs.map(function (m) { return m.text; }).join('\n')).not.toContain('Interpreting the Input');
  });

  test('ожидающий ход data[13][1] в историю не попадает', () => {
    const root = JSON.parse(HISTORY_BODY);
    expect(root[13]).toHaveLength(2);
    expect(h.parseHistory(HISTORY_BODY)).toHaveLength(6);
  });

  test('XSSI-префикс )]}\' не мешает разбору', () => {
    expect(h.parseHistory(")]}'\n" + HISTORY_BODY)).toHaveLength(6);
  });

  test('мусор и сообщения без формы протобуфера отбрасываются', () => {
    const body = snapshotBody([
      ['строка вместо массива'],                 // не массив сообщения
      snapshotMsg('', 'user'),                   // пустой текст
      snapshotMsg('   ', 'model'),               // только пробелы
      snapshotMsg('без роли', null),             // роль не строка
      snapshotMsg('без известной роли', 'narrator'),
      snapshotMsg('живая реплика', 'user')
    ]);
    const msgs = h.parseHistory(body);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe('живая реплика');
    expect(msgs[0].role).toBe('user');
  });

  test('CRLF нормализуется в LF', () => {
    const body = snapshotBody([snapshotMsg('первая\r\nвторая', 'user')]);
    expect(h.parseHistory(body)[0].text).toBe('первая\nвторая');
  });
});

describe('core/aistudio-intercept.js: тело запроса GenerateContent (data[1])', () => {
  const h = makeSandbox().api.__handlers;

  test('5 ходов → 5 реплик, reasoning пропущен, куски склеены без разделителя', () => {
    const found = h.findMessageArray(JSON.parse(REQUEST_BODY));
    expect(found.path).toBe('1');
    const msgs = found.msgs;
    expect(msgs).toHaveLength(5);
    expect(msgs.map(function (m) { return m.role; })).toEqual([
      'user', 'assistant', 'user', 'assistant', 'user'
    ]);
    // склейка частей даёт ровно ту же строку, что и сохранённое сообщение в снимке
    expect(msgs[1].text).toBe('Тест 1 пройден успешно! Связь работает отлично. \n\nЧем могу вам помочь?');
    expect(msgs[3].text).toBe('Тест 2 также пройден успешно! Системы работают в штатном режиме. \n\n' +
      'Готов к следующему тесту или вашей задаче.');
    expect(msgs[4].text).toBe('Тест 3');
  });

  test('таймзона в поле 13 не принимается за снимок истории', () => {
    const root = JSON.parse(REQUEST_BODY);
    expect(root[13][0][2]).toBe('Asia/Yekaterinburg');
    expect(h.msgsFromSnapshot(root)).toEqual([]);   // снимка нет
    expect(h.findMessageArray(root).path).toBe('1');
  });

  test('пустое тело, мусор и SSE → пустая история, без throw', () => {
    expect(h.parseHistory('')).toEqual([]);
    expect(h.parseHistory(null)).toEqual([]);
    expect(h.parseHistory('data: {"candidates":[]}\n\n')).toEqual([]);
    expect(h.parseHistory('ok')).toEqual([]);
    expect(h.parseHistory('[]')).toEqual([]);
    expect(h.parseHistory(requestBody([]))).toEqual([]);
  });

  test('ответ GenerateContent (чанки) историей не считается', () => {
    // Иначе стриминг давал бы «историю» из кусков одного ответа (3 «сообщения» мусора).
    expect(h.parseHistory(TOKENS_BODY)).toEqual([]);
  });
});

describe('core/aistudio-intercept.js: токены из ответа GenerateContent', () => {
  const h = makeSandbox().api.__handlers;

  test('финальный promptTokenCount = 486 (путь root[0][last][2][0])', () => {
    const root = JSON.parse(TOKENS_BODY);
    expect(root[0][3][2][0]).toBe(486);
    expect(h.parseUsageTokens(TOKENS_BODY)).toBe(486);
  });

  test('usage накапливается: максимум, а не первый чанк', () => {
    expect(h.parseUsageTokens(TOKENS_BODY)).toBeGreaterThan(parseInt(TOKENS_BODY.match(/\[219/)[0].slice(1), 10));
    const reversed = JSON.stringify([[
      streamChunk('', chunkUsage(486, 38, 634)),
      streamChunk('', chunkUsage(219, 9, 338))
    ]]);
    expect(h.parseUsageTokens(reversed)).toBe(486);
  });

  test('XSSI-префикс и одиночный чанк без внешнего массива', () => {
    const one = JSON.stringify([streamChunk('', chunkUsage(5632, 12, 5660)), streamChunk('', null)]);
    expect(h.parseUsageTokens(")]}'\n" + one)).toBe(5632);
  });

  test('нет usage / чужое тело / CountTokens → 0', () => {
    expect(h.parseUsageTokens('')).toBe(0);
    expect(h.parseUsageTokens('ok')).toBe(0);
    expect(h.parseUsageTokens(JSON.stringify([streamChunk('', null)]))).toBe(0);
    expect(h.parseUsageTokens(COUNT_TOKENS_BODY)).toBe(0);
    // нестриминговый ответ-промпт (14 полей) токенов не несёт
    expect(h.parseUsageTokens(snapshotBody(HISTORY_MSGS))).toBe(0);
  });
});

describe('core/aistudio-intercept.js: мост MAIN → ISOLATED', () => {
  test('снимок ответа: detail — строка JSON, есть обязательная строка лога', () => {
    const sb = makeSandbox();
    sb.api.__handlers.handleResponse(UPDATE_URL, HISTORY_BODY);

    expect(sb.events).toHaveLength(1);
    const detail = sb.events[0].detail;
    // Xray/Firefox: через границу компартментов идёт примитив, а не объект
    expect(typeof detail).toBe('string');
    const payload = JSON.parse(detail);
    expect(payload.kind).toBe('history');
    expect(payload.site).toBe('aistudio');
    expect(payload.count).toBe(6);
    expect(payload.msgs).toHaveLength(6);
    expect(typeof payload.ts).toBe('number');
    expect(sb.logs.join('\n')).toContain('[aistudio-intercept] history loaded msgs=6');
  });

  test('тело запроса GenerateContent → history в мост', () => {
    const sb = makeSandbox();
    sb.api.__handlers.handleRequest(GENERATE_URL, REQUEST_BODY);

    expect(sb.events).toHaveLength(1);
    const payload = JSON.parse(sb.events[0].detail);
    expect(payload.kind).toBe('history');
    expect(payload.count).toBe(5);
    expect(payload.url).toBe(GENERATE_URL);
  });

  test('токены: serverTokens уходит отдельным событием, без строки истории', () => {
    const sb = makeSandbox();
    sb.api.__handlers.handleResponse(GENERATE_URL, TOKENS_BODY);

    expect(sb.events).toHaveLength(1);
    const payload = JSON.parse(sb.events[0].detail);
    expect(payload.kind).toBe('count');
    expect(payload.serverTokens).toBe(486);
    expect(sb.logs.join('\n')).not.toContain('history loaded');
  });

  test('повторный тот же снимок не дублирует лог и событие', () => {
    const sb = makeSandbox();
    sb.api.__handlers.handleResponse(UPDATE_URL, HISTORY_BODY);
    sb.api.__handlers.handleResponse(UPDATE_URL, HISTORY_BODY);
    expect(sb.events).toHaveLength(1);
    expect(sb.logs.join('\n').match(/history loaded/g)).toHaveLength(1);
  });

  test('тот же promptTokenCount второй раз не отправляется', () => {
    const sb = makeSandbox();
    sb.api.__handlers.handleResponse(GENERATE_URL, TOKENS_BODY);
    sb.api.__handlers.handleResponse(GENERATE_URL, TOKENS_BODY);
    expect(sb.events).toHaveLength(1);
  });

  test('чужой запрос и пустые тела игнорируются', () => {
    const sb = makeSandbox();
    sb.api.__handlers.handleResponse('https://aistudio.google.com/api/prompts', HISTORY_BODY);
    sb.api.__handlers.handleResponse(UPDATE_URL, '');
    sb.api.__handlers.handleRequest(MAKER_SUITE + 'ListPrompts', REQUEST_BODY);
    sb.api.__handlers.handleResponse(MAKER_SUITE + 'CountTokens', COUNT_TOKENS_BODY);
    expect(sb.events).toHaveLength(0);
  });

  test('COUNT_TOKENS: тело [5,…] больше не даёт serverTokens', () => {
    const sb = makeSandbox();
    sb.api.__handlers.handleResponse(GENERATE_URL, COUNT_TOKENS_BODY);
    expect(sb.events).toHaveLength(0);
    expect(sb.api.stats().lastTokens).toBe(0);
  });

  test('обратный канал: настройка verbose разбирается aiCmBridgeDetail', () => {
    const sb = makeSandbox();
    expect(sb.api.stats().verbose).toBe(false);
    sb.fire('ai-cm-aistudio-net-settings', JSON.stringify({ verbose: true }));
    expect(sb.api.stats().verbose).toBe(true);
    // мусор не переключает режим
    sb.fire('ai-cm-aistudio-net-settings', '{');
    expect(sb.api.stats().verbose).toBe(true);
  });
});

describe('core/aistudio-intercept.js: патч fetch', () => {
  test('$rpc UpdatePrompt: ответ страницы не тронут, история уходит в мост', async () => {
    const resp = makeResponse(HISTORY_BODY);
    const fetchStub = makeFetch(function () { return resp; });
    const sb = makeSandbox({ fetch: fetchStub });
    expect(sb.win.fetch).not.toBe(fetchStub);
    expect(sb.win.fetch.__aiCmAistudioWrapped).toBe(true);

    const got = await sb.win.fetch(UPDATE_URL, { method: 'POST', body: '["x"]' });
    expect(got).toBe(resp); // страница получила ИСХОДНЫЙ объект
    await flush();

    expect(resp.state.textReads).toBe(1); // читали клон, а не оригинал
    expect(sb.events).toHaveLength(1);
    expect(JSON.parse(sb.events[0].detail).count).toBe(6);
    expect(sb.logs.join('\n')).toContain('[aistudio-intercept] history loaded msgs=6');
  });

  test('GenerateContent: история из тела запроса + токены из ответа', async () => {
    const resp = makeResponse(TOKENS_BODY);
    const sb = makeSandbox({ fetch: makeFetch(function () { return resp; }) });

    await sb.win.fetch(GENERATE_URL, { method: 'POST', body: REQUEST_BODY });
    await flush();

    expect(sb.events).toHaveLength(2);
    const kinds = sb.events.map(function (ev) { return JSON.parse(ev.detail).kind; });
    expect(kinds).toEqual(['history', 'count']);
    expect(JSON.parse(sb.events[0].detail).count).toBe(5);
    expect(JSON.parse(sb.events[1].detail).serverTokens).toBe(486);
  });

  test('нестроковое тело запроса не ломает разбор ответа', async () => {
    const resp = makeResponse(HISTORY_BODY);
    const sb = makeSandbox({ fetch: makeFetch(function () { return resp; }) });

    await sb.win.fetch(UPDATE_URL, { method: 'POST', body: { not: 'a string' } });
    await flush();
    expect(sb.events).toHaveLength(1);
  });

  test('посторонний запрос не разбирается и не читает тело', async () => {
    const resp = makeResponse(HISTORY_BODY);
    const sb = makeSandbox({ fetch: makeFetch(function () { return resp; }) });

    await sb.win.fetch('https://aistudio.google.com/api/prompts', {});
    await flush();
    expect(resp.state.textReads).toBe(0);
    expect(sb.events).toHaveLength(0);
  });

  test('SSE-стрим не буферизуется', async () => {
    const resp = makeResponse('data: {"x":1}\n\n', 'text/event-stream');
    const sb = makeSandbox({ fetch: makeFetch(function () { return resp; }) });

    await sb.win.fetch(GENERATE_URL, {});
    await flush();
    expect(resp.state.textReads).toBe(0);
    expect(sb.events).toHaveLength(0);
  });
});

describe('core/aistudio-intercept.js: патч XMLHttpRequest', () => {
  test('$rpc CreatePrompt: история из responseText уходит в мост', () => {
    const Xhr = makeXhrClass();
    const sb = makeSandbox({ XMLHttpRequest: Xhr });
    expect(Xhr.prototype.send.__aiCmAistudioWrapped).toBe(true);

    const xhr = new sb.win.XMLHttpRequest();
    xhr.open('POST', CREATE_URL);
    xhr.send();
    expect(xhr.opened).toBe(1);
    expect(xhr.sent).toBe(1);

    xhr.responseText = HISTORY_BODY;
    xhr._headers['content-type'] = 'application/json+protobuf';
    xhr.fire('load');

    expect(sb.events).toHaveLength(1);
    expect(JSON.parse(sb.events[0].detail).count).toBe(6);
  });

  test('GenerateContent: снимок из send() сразу, токены из load()', () => {
    const Xhr = makeXhrClass();
    const sb = makeSandbox({ XMLHttpRequest: Xhr });

    const xhr = new sb.win.XMLHttpRequest();
    xhr.open('POST', GENERATE_URL);
    xhr.send(REQUEST_BODY);
    expect(xhr.sentBody).toBe(REQUEST_BODY);

    // история отправлена синхронно, ещё до ответа
    expect(sb.events).toHaveLength(1);
    expect(JSON.parse(sb.events[0].detail).count).toBe(5);

    xhr.responseText = TOKENS_BODY;
    xhr._headers['content-type'] = 'application/json+protobuf';
    xhr.fire('load');

    expect(sb.events).toHaveLength(2);
    expect(JSON.parse(sb.events[1].detail).serverTokens).toBe(486);
  });

  test('ответ на посторонний URL не разбирается', () => {
    const Xhr = makeXhrClass();
    const sb = makeSandbox({ XMLHttpRequest: Xhr });

    const xhr = new sb.win.XMLHttpRequest();
    xhr.open('GET', 'https://aistudio.google.com/api/prompts');
    xhr.send();
    xhr.responseText = HISTORY_BODY;
    xhr._headers['content-type'] = 'application/json+protobuf';
    xhr.fire('load');

    expect(sb.events).toHaveLength(0);
  });

  test('responseType=json: объект превращается в текст и разбирается', () => {
    const Xhr = makeXhrClass();
    const sb = makeSandbox({ XMLHttpRequest: Xhr });

    const xhr = new sb.win.XMLHttpRequest();
    xhr.open('POST', GENERATE_URL);
    xhr.send(REQUEST_BODY);
    xhr.responseType = 'json';
    xhr.response = JSON.parse(TOKENS_BODY);
    xhr._headers['content-type'] = 'application/json+protobuf';
    xhr.fire('load');

    expect(JSON.parse(sb.events[1].detail).serverTokens).toBe(486);
  });

  test('нестроковое тело send() не мешает разбору ответа', () => {
    const Xhr = makeXhrClass();
    const sb = makeSandbox({ XMLHttpRequest: Xhr });

    const xhr = new sb.win.XMLHttpRequest();
    xhr.open('POST', UPDATE_URL);
    xhr.send({ upload: true });
    xhr.responseText = HISTORY_BODY;
    xhr._headers['content-type'] = 'application/json+protobuf';
    xhr.fire('load');

    expect(sb.events).toHaveLength(1);
    expect(JSON.parse(sb.events[0].detail).kind).toBe('history');
  });
});

/* ------------------------------------------------------------------ *
 * Адаптер: сеть главнее DOM
 * ------------------------------------------------------------------ */

const ADAPTER_FILES = [
  'adapters/base-adapter.js',
  'adapters/gemini-adapter.js',
  'adapters/aistudio-adapter.js'
];

function loadAistudio(doc, location) {
  const res = loadSource(ADAPTER_FILES, {
    document: doc,
    location: location || Object.assign({}, AISTUDIO_LOC),
    exportExpr: 'AistudioAdapter'
  });
  return { adapter: new res.value(), sandbox: res.sandbox };
}

const NET_SNAPSHOT = {
  msgs: [
    { role: 'user', text: 'вопрос из сети' },
    { role: 'assistant', text: 'ответ из сети' }
  ],
  count: 2,
  ts: 1700000000000,
  href: AISTUDIO_LOC.href
};

describe('AistudioAdapter: сетевая история из window.__aiCmNetMsgs', () => {
  test('сеть есть → extractMessages отдаёт её, даже если DOM пуст', () => {
    document.body.innerHTML = '<div class="prompts-gallery"></div>';
    const { adapter, sandbox } = loadAistudio(document, Object.assign({}, AISTUDIO_LOC));
    sandbox.window.__aiCmNetMsgs = JSON.parse(JSON.stringify(NET_SNAPSHOT));

    expect(adapter.isOnDialogPage()).toBe(true); // DOM пуст, но сеть даёт диалог

    const messages = adapter.extractMessages();
    expect(messages).toHaveLength(2);
    expect(messages.map(function (m) { return m.role; })).toEqual(['user', 'assistant']);
    expect(messages[0].content).toBe('вопрос из сети');
    expect(messages[1].content).toBe('ответ из сети');
  });

  test('сеть главнее DOM: при обоих источниках побеждает сеть', () => {
    document.body.innerHTML =
      '<ms-cmark-node class="cmark-node v3-font-body user-chunk"><p>из DOM</p></ms-cmark-node>';
    const { adapter, sandbox } = loadAistudio(document, Object.assign({}, AISTUDIO_LOC));
    sandbox.window.__aiCmNetMsgs = JSON.parse(JSON.stringify(NET_SNAPSHOT));

    const messages = adapter.extractMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0].content).not.toContain('из DOM');
  });

  test('снимок чужого разговора (другой pathname) не используется', () => {
    document.body.innerHTML = '<div></div>';
    const loc = Object.assign({}, AISTUDIO_LOC, {
      pathname: '/prompts/other',
      href: 'https://aistudio.google.com/prompts/other'
    });
    const { adapter, sandbox } = loadAistudio(document, loc);
    sandbox.window.__aiCmNetMsgs = JSON.parse(JSON.stringify(NET_SNAPSHOT));

    expect(adapter.extractMessages()).toEqual([]);
    expect(adapter.isOnDialogPage()).toBe(false);
  });

  test('без снимка адаптер работает по DOM как раньше', () => {
    document.body.innerHTML =
      '<ms-cmark-node class="cmark-node v3-font-body user-chunk"><p>дом-вопрос</p></ms-cmark-node>' +
      '<ms-cmark-node class="cmark-node v3-font-body"><p>дом-ответ</p></ms-cmark-node>';
    const { adapter } = loadAistudio(document, Object.assign({}, AISTUDIO_LOC));

    const messages = adapter.extractMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain('дом-вопрос');
    expect(messages[1].content).toContain('дом-ответ');
  });
});
