/**
 * tests/adapters/aistudio-network.test.js — сетевой перехват истории AI Studio.
 *
 * ЧТО ПРОВЕРЯЕМ. core/aistudio-intercept.js (MAIN-мир, aistudio.google.com) патчит
 * fetch/XHR, ловит `$rpc`-ответы и передаёт в ISOLATED разобранные данные:
 *   • 'history' — ходы диалога из UpdatePrompt/Create/GenerateContent;
 *   • 'count'   — точное число токенов из CountTokens.
 * Плюс adapters/aistudio-adapter.js, который обязан предпочесть сеть DOM-фолбэку.
 *
 * ОТКУДА ФОРМАТЫ. Живой ответ AI Studio — JSON-массив протобуфера, тексты ходов
 * лежат в data[13] кортежами `[[null, "текст"], "role"]`; CountTokens отвечает
 * `[5632]`. Дерево `data` в фикстуре повторяет этот вид: 13 пустых позиций перед
 * массивом ходов (поле протобуфера, а не выдумка теста).
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
        return (String(name).toLowerCase() === 'content-type') ? (contentType || 'application/json') : null;
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
  }
  FakeXhr.prototype.open = function (method, url) {
    this.method = method;
    this.url = url;
    this.opened++;
  };
  FakeXhr.prototype.send = function () {
    this.sent++;
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
 * Фикстуры ответов AI Studio
 * ------------------------------------------------------------------ */

/** Кортеж хода: `[[null, "текст"], "role"]` — точная форма протобуфера AI Studio. */
const turn = (text, role) => [[null, text], role];

/** data[0..12] — прочие поля протобуфера Prompt (индекс 13 — массив ходов). */
function promptTree(turns) {
  const data = new Array(13).fill(null);
  data.push(turns);
  return data;
}

const HISTORY_BODY = JSON.stringify(promptTree([
  turn('Как посчитать токены в AI Studio?', 'user'),
  turn('Через $rpc CountTokens: сервер вернёт точное число.', 'model'),
  turn('Спасибо!', 'user')
]));

const COUNT_BODY = '[5632]';

describe('core/aistudio-intercept.js: классификация $rpc-запросов', () => {
  const api = makeSandbox().api;

  test('CountTokens узнаётся по имени метода и только внутри $rpc', () => {
    expect(api.__handlers.isCountRpc('https://aistudio.google.com/$rpc/google.ai.v1.CountTokens')).toBe(true);
    expect(api.__handlers.isCountRpc('https://aistudio.google.com/$rpc/x/countTokens')).toBe(true);
    expect(api.__handlers.isCountRpc('https://aistudio.google.com/api/CountTokens')).toBe(false);
    expect(api.__handlers.isCountRpc('')).toBe(false);
  });

  test('история: UpdatePrompt / Create / CreatePrompt / GenerateContent под $rpc', () => {
    const h = api.__handlers;
    expect(h.isHistoryRpc('https://aistudio.google.com/$rpc/x.UpdatePrompt')).toBe(true);
    expect(h.isHistoryRpc('https://aistudio.google.com/$rpc/x.Create')).toBe(true);
    expect(h.isHistoryRpc('https://aistudio.google.com/$rpc/x.CreatePrompt')).toBe(true);
    expect(h.isHistoryRpc('https://aistudio.google.com/$rpc/x.GenerateContent')).toBe(true);
    expect(h.isHistoryRpc('https://aistudio.google.com/api/UpdatePrompt')).toBe(false);
    // CountTokens не должен попасть в историю (порядок проверок в handleResponse)
    expect(h.isHistoryRpc('https://aistudio.google.com/$rpc/x.CountTokens')).toBe(false);
  });

  test('история: ListPrompts даёт снимок библиотеки промптов', () => {
    // Живой лог AI Studio (страница /prompts/...): ListPrompts вызывается 4 раза,
    // GenerateContent/CreatePrompt на этой странице не было вовсе. Старая
    // регулярка `/updateprompt|create|generatecontent/` его не ловила → история
    // не поднималась, хотя полный снимок уже приходил в ответе.
    const h = api.__handlers;
    expect(h.isHistoryRpc('https://aistudio.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ListPrompts')).toBe(true);
    expect(h.isHistoryRpc('https://aistudio.google.com/$rpc/x.ListPrompts')).toBe(true);
    // прочие методы того же сервиса — не история
    expect(h.isHistoryRpc('https://aistudio.google.com/$rpc/x.ListModels')).toBe(false);
    expect(h.isHistoryRpc('https://aistudio.google.com/$rpc/x.ResolveDriveResource')).toBe(false);
  });
});

describe('core/aistudio-intercept.js: парсер истории (data[13])', () => {
  const h = makeSandbox().api.__handlers;

  test('кортежи из data[13] → msgs с ролями user/assistant', () => {
    const msgs = h.parseHistory(HISTORY_BODY);
    expect(msgs).toHaveLength(3);
    expect(msgs.map(function (m) { return m.role; })).toEqual(['user', 'assistant', 'user']);
    expect(msgs[0].text).toBe('Как посчитать токены в AI Studio?');
    expect(msgs[1].text).toContain('CountTokens');
    // роль кортежа 'model' нормализована к контракту адаптеров
    expect(msgs[1].role).not.toBe('model');
  });

  test('вложенный текст хода не теряется и не дублируется', () => {
    const body = JSON.stringify(promptTree([turn('первая строка\nвторая строка', 'user')]));
    const msgs = h.parseHistory(body);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe('первая строка\nвторая строка');
  });

  test('data[13] нет — обход дерева находит массив ходов', () => {
    const body = JSON.stringify({ prompt: { nested: [turn('вопрос', 'user'), turn('ответ', 'model')] } });
    const msgs = h.parseHistory(body);
    expect(msgs).toHaveLength(2);
    expect(msgs.map(function (m) { return m.role; })).toEqual(['user', 'assistant']);
  });

  test('пустые ходы и мусор отбрасываются', () => {
    const body = JSON.stringify(promptTree([
      turn('', 'user'),
      turn('   ', 'model'),
      [null, 'user'],
      'строка вместо кортежа',
      turn('живой ход', 'user')
    ]));
    const msgs = h.parseHistory(body);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe('живой ход');
  });

  test('XSSI-префикс )]}\' не мешает разбору', () => {
    const msgs = h.parseHistory(")]}'\n" + HISTORY_BODY);
    expect(msgs).toHaveLength(3);
  });

  test('SSE-поток GenerateContent (не JSON) → пусто, без throw', () => {
    expect(h.parseHistory('data: {"candidates":[]}\n\n')).toEqual([]);
    expect(h.parseHistory('')).toEqual([]);
    expect(h.parseHistory(null)).toEqual([]);
  });
});

describe('core/aistudio-intercept.js: вложенная форма GenerateContent', () => {
  const h = makeSandbox().api.__handlers;

  /**
   * Реальный ответ GenerateContent — `[[[[[null,"текст"]], "model"]]]`:
   * TextPart лежит на четыре уровня глубже кортежа, роль — рядом с ним, а не в
   * item[1]. Фикстура собирается литералами, чтобы форма была видна глазами.
   */
  const nestedTurn = (text, role) => [[[null, text]], role];

  test('текст из [[[[[null,"текст"]], "model"]]] найден, роль → assistant', () => {
    const body = JSON.stringify([[nestedTurn('Ответ модели из вложенной формы', 'model')]]);
    const msgs = h.parseHistory(body);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe('Ответ модели из вложенной формы');
    expect(msgs[0].role).toBe('assistant');
  });

  test('несколько вложенных ходов → все msgs по порядку, без дублей', () => {
    const body = JSON.stringify([[
      nestedTurn('вопрос пользователя', 'user'),
      nestedTurn('ответ модели', 'model')
    ]]);
    const msgs = h.parseHistory(body);
    expect(msgs).toHaveLength(2);
    expect(msgs.map(function (m) { return m.role; })).toEqual(['user', 'assistant']);
    expect(msgs[0].text).toBe('вопрос пользователя');
    expect(msgs[1].text).toBe('ответ модели');
  });

  test('глубокая вложенность и мусорные поля вокруг хода не мешают', () => {
    const body = JSON.stringify([[
      [null, null, nestedTurn('ход в глубине дерева', 'user')],
      nestedTurn('ответ в глубине дерева', 'model')
    ]]);
    const msgs = h.parseHistory(body);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].text).toBe('ход в глубине дерева');
    expect(msgs[1].text).toBe('ответ в глубине дерева');
  });
});

describe('core/aistudio-intercept.js: числовые ID не считаются текстом', () => {
  const h = makeSandbox().api.__handlers;

  test('16-значный ID вместо текста отбрасывается, соседние ходы живы', () => {
    const body = JSON.stringify(promptTree([
      turn('1234567890123456', 'user'),     // ID промпта, а не реплика
      turn('настоящий вопрос', 'user'),
      turn('9876543210987654', 'model'),
      turn('настоящий ответ', 'model')
    ]));
    const msgs = h.parseHistory(body);
    expect(msgs).toHaveLength(2);
    expect(msgs.map(function (m) { return m.text; })).toEqual(['настоящий вопрос', 'настоящий ответ']);
  });

  test('короткое и длинное число — это текст, а не ID', () => {
    const body = JSON.stringify(promptTree([
      turn('42', 'user'),
      turn('123456789012345', 'model'),      // 15 знаков — ещё текст
      turn('12345678901234567', 'user')      // 17 знаков — тоже текст
    ]));
    const msgs = h.parseHistory(body);
    expect(msgs.map(function (m) { return m.text; })).toEqual(['42', '123456789012345', '12345678901234567']);
  });

  test('ID в служебном поле не становится единственной репликой снимка', () => {
    // ListPrompts: рядом с настоящим ходом лежит служебный 16-значный ID.
    const body = JSON.stringify(promptTree([
      ['5555444433332222', turn('живой ход', 'user')]
    ]));
    const msgs = h.parseHistory(body);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe('живой ход');
  });
});

describe('core/aistudio-intercept.js: парсер CountTokens', () => {
  const h = makeSandbox().api.__handlers;

  test('[5632] → 5632 (точное число токенов контекста)', () => {
    expect(h.parseCountTokens(COUNT_BODY)).toBe(5632);
  });

  test('объектная форма и XSSI-префикс', () => {
    expect(h.parseCountTokens('[{"tokenCount": 4096}]')).toBe(4096);
    expect(h.parseCountTokens(")]}'\n[5632]")).toBe(5632);
  });

  test('не наш формат / нули / мусор → 0', () => {
    expect(h.parseCountTokens('')).toBe(0);
    expect(h.parseCountTokens('ok')).toBe(0);
    expect(h.parseCountTokens('[0]')).toBe(0);
    expect(h.parseCountTokens('[null]')).toBe(0);
  });
});

describe('core/aistudio-intercept.js: мост MAIN → ISOLATED', () => {
  test('history: detail — строка JSON, есть обязательная строка лога', () => {
    const sb = makeSandbox();
    sb.api.__handlers.handleResponse('https://aistudio.google.com/$rpc/x.UpdatePrompt', HISTORY_BODY);

    expect(sb.events).toHaveLength(1);
    const detail = sb.events[0].detail;
    // Xray/Firefox: через границу компартментов идёт примитив, а не объект
    expect(typeof detail).toBe('string');
    const payload = JSON.parse(detail);
    expect(payload.kind).toBe('history');
    expect(payload.count).toBe(3);
    expect(payload.msgs).toHaveLength(3);
    expect(payload.site).toBe('aistudio');
    expect(sb.logs.join('\n')).toContain('[aistudio-intercept] history loaded msgs=3');
  });

  test('ListPrompts → history в мост (снимок истории без новых чанков)', () => {
    const sb = makeSandbox();
    const url = 'https://aistudio.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ListPrompts';
    sb.api.__handlers.handleResponse(url, HISTORY_BODY);

    expect(sb.events).toHaveLength(1);
    const payload = JSON.parse(sb.events[0].detail);
    expect(payload.kind).toBe('history');
    expect(payload.msgs).toHaveLength(3);
  });

  test('count: serverTokens уходит отдельным событием', () => {
    const sb = makeSandbox();
    sb.api.__handlers.handleResponse('https://aistudio.google.com/$rpc/x.CountTokens', COUNT_BODY);

    expect(sb.events).toHaveLength(1);
    const payload = JSON.parse(sb.events[0].detail);
    expect(payload.kind).toBe('count');
    expect(payload.serverTokens).toBe(5632);
    expect(sb.logs.join('\n')).not.toContain('history loaded'); // счётчик — не история
  });

  test('повторный тот же снимок не дублирует лог и событие', () => {
    const sb = makeSandbox();
    const url = 'https://aistudio.google.com/$rpc/x.UpdatePrompt';
    sb.api.__handlers.handleResponse(url, HISTORY_BODY);
    sb.api.__handlers.handleResponse(url, HISTORY_BODY);
    expect(sb.events).toHaveLength(1);
    expect(sb.logs.join('\n').match(/history loaded/g)).toHaveLength(1);
  });

  test('чужой запрос и пустое тело игнорируются', () => {
    const sb = makeSandbox();
    sb.api.__handlers.handleResponse('https://aistudio.google.com/api/prompts', HISTORY_BODY);
    sb.api.__handlers.handleResponse('https://aistudio.google.com/$rpc/x.UpdatePrompt', '');
    expect(sb.events).toHaveLength(0);
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

    const got = await sb.win.fetch('https://aistudio.google.com/$rpc/x.UpdatePrompt', { method: 'POST' });
    expect(got).toBe(resp); // страница получила ИСХОДНЫЙ объект
    await flush();

    expect(resp.state.textReads).toBe(1); // читали клон, а не оригинал
    expect(sb.events).toHaveLength(1);
    expect(JSON.parse(sb.events[0].detail).count).toBe(3);
    expect(sb.logs.join('\n')).toContain('[aistudio-intercept] history loaded msgs=3');
  });

  test('посторонний запрос не разбирается и не читает тело', async () => {
    const resp = makeResponse(HISTORY_BODY);
    const sb = makeSandbox({ fetch: makeFetch(function () { return resp; }) });

    await sb.win.fetch('https://aistudio.google.com/api/prompts', {});
    await flush();
    expect(resp.state.textReads).toBe(0);
    expect(sb.events).toHaveLength(0);
  });

  test('CountTokens через fetch обновляет serverTokens', async () => {
    const resp = makeResponse(COUNT_BODY);
    const sb = makeSandbox({ fetch: makeFetch(function () { return resp; }) });

    await sb.win.fetch('https://aistudio.google.com/$rpc/x.CountTokens', {});
    await flush();
    expect(JSON.parse(sb.events[0].detail).serverTokens).toBe(5632);
  });

  test('SSE-стрим GenerateContent не буферизуется', async () => {
    const resp = makeResponse('data: {"x":1}\n\n', 'text/event-stream');
    const sb = makeSandbox({ fetch: makeFetch(function () { return resp; }) });

    await sb.win.fetch('https://aistudio.google.com/$rpc/x.GenerateContent', {});
    await flush();
    expect(resp.state.textReads).toBe(0);
    expect(sb.events).toHaveLength(0);
  });
});

describe('core/aistudio-intercept.js: патч XMLHttpRequest', () => {
  test('$rpc Create: история из responseText уходит в мост', () => {
    const Xhr = makeXhrClass();
    const sb = makeSandbox({ XMLHttpRequest: Xhr });
    expect(Xhr.prototype.send.__aiCmAistudioWrapped).toBe(true);

    const xhr = new sb.win.XMLHttpRequest();
    xhr.open('POST', 'https://aistudio.google.com/$rpc/x.Create');
    xhr.send();
    expect(xhr.opened).toBe(1);
    expect(xhr.sent).toBe(1);

    xhr.responseText = HISTORY_BODY;
    xhr._headers['content-type'] = 'application/json';
    xhr.fire('load');

    expect(sb.events).toHaveLength(1);
    expect(JSON.parse(sb.events[0].detail).count).toBe(3);
  });

  test('ответ на посторонний URL не разбирается', () => {
    const Xhr = makeXhrClass();
    const sb = makeSandbox({ XMLHttpRequest: Xhr });

    const xhr = new sb.win.XMLHttpRequest();
    xhr.open('GET', 'https://aistudio.google.com/api/prompts');
    xhr.send();
    xhr.responseText = HISTORY_BODY;
    xhr._headers['content-type'] = 'application/json';
    xhr.fire('load');

    expect(sb.events).toHaveLength(0);
  });

  test('responseType=json: объект превращается в текст и разбирается', () => {
    const Xhr = makeXhrClass();
    const sb = makeSandbox({ XMLHttpRequest: Xhr });

    const xhr = new sb.win.XMLHttpRequest();
    xhr.open('POST', 'https://aistudio.google.com/$rpc/x.CountTokens');
    xhr.send();
    xhr.responseType = 'json';
    xhr.response = [5632];
    xhr._headers['content-type'] = 'application/json';
    xhr.fire('load');

    expect(JSON.parse(sb.events[0].detail).serverTokens).toBe(5632);
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
