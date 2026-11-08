/**
 * РЕГРЕССИЯ «активный vf5-дозапрос базы мёртв из-за Illegal invocation» (Phase 3).
 *
 * ЖИВОЙ ДЕФЕКТ (лог пользователя 2026-11-08 15:37:25.809, Gemini MAIN-мир):
 *   [gemini-virtual-f5] ошибка активного запроса: TypeError: Failed to execute 'fetch' on
 *   'Window': Illegal invocation → остаёмся на пассиве+DOM
 * После этой строки `.catch` взводил `activeDisabled = true` НАВСЕГДА (до перезагрузки), и
 * единственный designed-путь дозапроса истории после обмена репликами умирал: новый ход
 * приходит только в DOM, `turnsMap` до F5 не пополняется → бейдж держит значение загрузки.
 *
 * КОРОНЬ: `originalFetch` — нативная операция Window с brand-check. Вызов свободной функцией
 * (`originalFetch(url, init)`) даёт `this === undefined` → TypeError. Исправление в
 * core/gemini-active-refresh.js: `originalFetch.call(window, …)`.
 *
 * ПРАВИЛО 3 (Behavior-Only Tests): тест не читает исходники — модуль подключается
 * `require('../core/gemini-active-refresh.js')` (он экспортирует своё API через module.exports
 * и window.AiCmGeminiActiveRefresh), нативный fetch подменяется поведенческим дублёром с
 * теми же brand-check правилами. Вход — окружение и вызов activeRefresh, выход — факт
 * запроса, его аргументы и переходы состояния.
 */

'use strict';

const loadEsmHelper = require('./helpers/load-esm.js');
const API_PATH = 'core/gemini-active-refresh.js';
// Модуль объявлен внутри `with (D)` BIND-зоны (как ingest/oracle/spa-lifecycle), поэтому
// require() его не берёт: babel парсит файл как модуль, а `with` в strict-режиме запрещён.
// Штатный путь для таких модулей — хелпер loadAsClassic (исходник как есть, для new Function).
const API_SRC = loadEsmHelper.loadAsClassic(API_PATH);
const CONV_ID = '32cdd7e3977def19';
const ACTIVE_URL = 'https://gemini.google.com/u/1/app/' + CONV_ID;
const ACTIVE_BODY = 'f.req=%5B%5B%5B%22hNvQHb%22%5D%5D%5D';
const RESPONSE_BODY = ')]}\'\n[["wrb.fr","hNvQHb","[[\\"c_32cdd7e3977def19\\"]]",null,null,null,"generic"]]';

// Нативный fetch: операция Window с brand-check — ровно та семантика, на которой падал вызов.
function makeNativeFetch(win, rec, response) {
  return function nativeFetch(url, init) {
    'use strict';
    if (this !== win) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    }
    rec.calls.push({ thisArg: this, url: url, init: init });
    return Promise.resolve(response || {
      ok: true,
      status: 200,
      text: function () { return Promise.resolve(RESPONSE_BODY); }
    });
  };
}

// Модуль идемпотентен на странице (страховка от двойной регистрации в background.js),
// поэтому для каждого окружения снимаем его window-метку и исполняем свежую копию.
function loadModule() {
  delete window.AiCmGeminiActiveRefresh;
  const moduleObj = { exports: {} };
  new Function('module', 'exports', 'window', API_SRC)(moduleObj, moduleObj.exports, window);
  return moduleObj.exports;
}

function bindCtx(win, rec, over) {
  const ctx = {
    window: win,
    originalFetch: makeNativeFetch(win, rec, over && over.__response),
    activeDisabled: false,
    activeBusy: false,
    loggedActiveStatus: false,
    lastAtEncoded: 'encoded-at',
    lastBaseUrl: 'https://gemini.google.com/app/' + CONV_ID,
    lastHeaders: { 'x-goog-ext-1': 'v' },
    getConvId: function () { return CONV_ID; },
    captureReqTag: function () { return { conv: CONV_ID, epoch: 1 }; },
    isStaleReqTag: function () { return false; },
    buildActiveUrl: function () { return ACTIVE_URL; },
    buildActiveBody: function () { return ACTIVE_BODY; },
    debugLog: function (level, msg) { rec.logs.push(String(msg)); },
    aiCmIngestFwd: function (txt, opts) { rec.ingest.push({ txt: txt, opts: opts }); }
  };
  Object.assign(ctx, over || {});
  return ctx;
}

/** Полное окружение: модуль + MAIN-мир (window) + записанные вызовы нативного fetch. */
function makeEnv(over) {
  const api = loadModule();
  const rec = { calls: [], logs: [], ingest: [] };
  const ctx = bindCtx(window, rec, over);
  api.__bind(ctx);
  return { win: window, api: api, ctx: ctx, rec: rec };
}

const settle = () => new Promise(function (resolve) { setTimeout(resolve, 10); });

describe('activeRefresh: нативный fetch вызывается с получателем window (Illegal invocation)', () => {
  test('дозапрос уходит, ответ ингестится, activeBusy снят (на HEAD падает в TypeError)', () => {
    const env = makeEnv({});

    // На HEAD здесь синхронный TypeError: `originalFetch(...)` без получателя.
    expect(function () { env.api.activeRefresh('после мутаций (realtime)', true); }).not.toThrow();

    return settle().then(function () {
      expect(env.rec.calls).toHaveLength(1);
      expect(env.rec.calls[0].thisArg).toBe(env.win);   // получатель — window, а не undefined
      expect(env.rec.calls[0].url).toBe(ACTIVE_URL);
      expect(env.rec.calls[0].init.method).toBe('POST');
      expect(env.rec.calls[0].init.body).toBe(ACTIVE_BODY);
      expect(env.rec.calls[0].init.credentials).toBe('include');
      // ответ дошёл до ingest → база обновляется без F5 (это и есть живой догон)
      expect(env.rec.ingest).toEqual([{
        txt: RESPONSE_BODY,
        opts: { emitOnlyIfAdded: true, fromVirtualF5: true, rebuild: true }
      }]);
      expect(env.ctx.activeDisabled).toBe(false);       // пассивный режим не включён навсегда
      expect(env.ctx.activeBusy).toBe(false);           // флаг не залип после исключения
      expect(env.rec.logs.some(function (m) { return m.indexOf('ошибка активного запроса') !== -1; })).toBe(false);
    });
  });

  test('последующие обмены тоже дозапрашивают базу (activeDisabled не выставлен)', () => {
    const env = makeEnv({});

    expect(function () { env.api.activeRefresh('после мутаций (realtime)', false); }).not.toThrow();
    return settle().then(function () {
      expect(function () { env.api.activeRefresh('пагинация', false); }).not.toThrow();
      return settle();
    }).then(function () {
      expect(env.rec.calls).toHaveLength(2);
      expect(env.ctx.activeDisabled).toBe(false);
      expect(env.rec.ingest.every(function (i) { return i.opts.fromVirtualF5 === true; })).toBe(true);
    });
  });

  test('прежние ветки не тронуты: ответ не-ok по-прежнему уводит на пассив+DOM', () => {
    const env = makeEnv({
      __response: { ok: false, status: 403, text: function () { return Promise.resolve(''); } }
    });

    expect(function () { env.api.activeRefresh('проверка', true); }).not.toThrow();
    return settle().then(function () {
      expect(env.rec.calls).toHaveLength(1);
      expect(env.ctx.activeDisabled).toBe(true);
      expect(env.ctx.activeBusy).toBe(false);
      expect(env.rec.logs.some(function (m) { return m.indexOf('не прошёл (статус 403)') !== -1; })).toBe(true);
      expect(env.rec.ingest).toHaveLength(0);
    });
  });

  test('нет convId/at/url/заголовков — запрос отложен, fetch не зовётся', () => {
    const env = makeEnv({ getConvId: function () { return ''; } });

    expect(function () { env.api.activeRefresh('проверка', true); }).not.toThrow();
    expect(env.rec.calls).toHaveLength(0);
    expect(env.rec.logs.some(function (m) { return m.indexOf('активный запрос отложен') !== -1; })).toBe(true);
    expect(env.ctx.activeBusy).toBe(false);
  });
});
