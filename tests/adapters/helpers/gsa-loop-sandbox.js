/**
 * Песочница РЕАЛЬНЫХ функций перехватчика GSA (core/google-search-intercept.js) для тестов
 * петли GSA (tests/adapters/gsa-loop-guard.test.js).
 *
 * Функции вырезаются из исходника по балансу фигурных скобок и собираются в один скоуп
 * `with (ctx) { … }`, а состояние песочницы (карты гарда, флаг скролла, база) объявляется
 * ЛЕКСИЧЕСКИ внутри этого скоупа и отдаётся наружу аксессорами — ровно как общий лексический
 * скоуп контент-скриптов в браузере. Иначе присваивание в срезе ушло бы в объект ctx, а гард
 * читал бы прежнюю привязку, и тест был бы зелёным на сломанном коде.
 *
 * Вынесено из теста отдельным модулем: так песочницу можно поднять и из отладочного скрипта,
 * не тащя за собой весь jest-контекст (на этом шаге уже была потеряна пара итераций).
 */

const fs = require('fs');
const path = require('path');

const Parser = require('../../../utils/google-search-folwr-parser.js');

const ROOT = path.join(__dirname, '..', '..', '..');
const INTERCEPT = fs.readFileSync(path.join(ROOT, 'core', 'google-search-intercept.js'), 'utf8');

// Рез по балансу фигурных скобок (как в tests/o32-gsa-canonical-thread-invariant.test.js).
// ОГРАНИЧЕНИЕ: счётчик не различает скобки в строках/комментариях, поэтому функции с
// литералом `")]}'"` (diagPreview) резать нельзя — такие хелперы кладутся в ctx заглушкой.
// Срез проверяется на синтаксическую целостность: обман баланса падает громко, не молча.
function fnDecl(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('declaration not found: ' + name);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        const body = src.slice(start, i + 1);
        if (body.slice(-1) !== '}') throw new Error('truncated declaration: ' + name);
        try { new Function(body); } catch (e) { throw new Error('broken declaration: ' + name + ' — ' + e.message); }
        return body;
      }
    }
  }
  throw new Error('unbalanced declaration: ' + name);
}

// Функции, которые зовёт сам тест (SCOPE_FNS нужен для нарезки исходника — экспорт отдельно,
// иначе наружу уходили бы имена, которых в Api нет).
// ВАЖНО: сюда нельзя класть имена, которые тест подменяет в ctx (например
// virtualScrollBackfill-заглушку для пути пагинации): `Api.virtualScrollBackfill = X`
// резолвит X из `with (ctx)` и затёр бы РЕАЛЬНУЮ функцию песочницы.
const API_FNS = [
  'applyTurns', 'buildDetail', 'followFolwrPagination',
  'folwrRunPermit', 'beginFolwrRun', 'endFolwrRun', 'markFolwrRunGain', 'gsaDiagLoopGuard'
];

const SCOPE_FNS = [
  'messagesFromTurns',
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
  // гард прогонов на тред (предмет задачи «петля GSA»)
  'gsaDiagLoopGuard',
  'folwrRunSince',
  'folwrRunPermit',
  'beginFolwrRun',
  'endFolwrRun',
  'markFolwrRunGain',
  // диаг-строка гарда виртуального скролла
  'gsaDiagVs',
  // прогоны
  'followFolwrPagination',
  'findChatScroller',
  'virtualScrollBackfill'
];

const STATE_ACCESSORS = [
  'folwrRunAtMap', 'folwrNoGainMap', 'folwrRunLiveMap', 'folwrRunLastVerdict',
  'folwrGainSeenAtMap', 'vsActive', 'lastFullTurns', 'baseThreadId', 'currentThreadId'
];

const SCOPE_DECLS = [
  'var folwrRunAtMap = {};',
  'var folwrNoGainMap = {};',
  'var folwrRunLiveMap = {};',
  'var folwrRunLastVerdict = {};',
  'var folwrGainSeenAtMap = {};',
  'var vsActive = null;',
  'var FOLWR_RUN_MIN_COOLDOWN_MS = 2000;',
  'var FOLWR_NO_GAIN_COOLDOWN_MS = 30000;',
  'var FOLWR_PAGE_DELAY_MS = 400;',
  'var FOLWR_MAX_PAGES = 12;',
  'var VS_MAX_ITERATIONS = 20;',
  'var VS_STEP_WAIT_MS = 800;',
  'var VS_STALL_LIMIT = 3;',
  'var lastFullTurns = [];',
  'var lastFullMessages = [];',
  'var lastFullSnapshot = null;',
  'var seenKeys = {};',
  'var currentThreadId = "";',
  'var emittedThreadId = "";',
  'var baseThreadId = "";',
  'var detectedModelSlug = "gemini-search-default";',
  'var MAX_CACHE_ENTRIES = 10;',
  'var threadCache = new Map();',
  'var activeFolwrInFlight = {};',
  'var lastFolwrSig = "";',
  'var lastDiagSwitchSig = "";',
  'var sorryCooldownUntil = 0;',
  'var evidences = [];',
  'var vsCalls = [];',
  // Гейта диагностики здесь НЕТ намеренно: `var __gate` перекрывал бы одноимённое свойство
  // ctx (bare-идентификатор в `with` разрешается лексически), и тест не смог бы включить
  // гейт извне. Гейт живёт только в ctx (ctx.diagGate) — как sessionStorage в браузере.
  // Мутируемые хелперы песочницы: объявлены ЗДЕСЬ (а не положены в ctx) — присваивание
  // обязано менять ту же привязку, которую читает срез перехватчика.
  'var __domTurns = [];',
  'var __scroller = null;'
];

const SCOPE_EXPORTS = [
  'var Api = {};',
  API_FNS.map(function (n) { return 'Api.' + n + ' = ' + n + ';'; }).join('\n'),
  STATE_ACCESSORS.map(function (n) {
    return "Object.defineProperty(Api, '" + n + "', { enumerable: true, get: function () { return " + n + '; } });';
  }).join('\n'),
  "Object.defineProperty(Api, 'evidences', { enumerable: true, get: function () { return evidences; } });",
  "Object.defineProperty(Api, 'inFlight', { enumerable: true, get: function () { return activeFolwrInFlight; } });",
  "Object.defineProperty(Api, 'vsCalls', { enumerable: true, get: function () { return vsCalls; } });",
  "Object.defineProperty(Api, 'domTurns', { enumerable: true, get: function () { return __domTurns; } });",
  "Object.defineProperty(Api, 'scrollerEl', { enumerable: true, get: function () { return __scroller; } });",
  // Подмена реализации Варианта Б для тестов пагинации (D1/D2/R1): реальный скролл там
  // стартует по setTimeout и живёт 800 мс — несовместимо с прокачкой микрозадач.
  // Re-entrancy-гард скролла проверяется на РЕАЛЬНОЙ функции в D3/D4.
  'Api.setVsImpl = function (fn) { vsDispatch = fn; };',
  "Object.defineProperty(Api, 'realVs', { enumerable: true, get: function () { return virtualScrollBackfill; } });",
  'Api.setScroller = function (el) { __scroller = el; };',
  'Api.switchThread = function (t) { currentThreadId = t; };',
  'Api.setThread = function (t) { currentThreadId = t; baseThreadId = t; };',
  'return Api;'
];

// Срез вставляется двумя шагами: (1) `var __code` со JSON-экранированным текстом функций —
// единственная форма, которую принимает тело `with` (голый строковый литерал там выражение,
// а не оператор, и function-декларации в него не хойстятся: проверено — «f is not defined»);
// (2) `eval(__code)` ВНУТРИ `with` — декларации попадают в тот же лексический скоуп, что и
// `with (ctx)`, поэтому хелперы и состояние видны телам функций ровно как в браузере.
// JSON.stringify экранирует и апострофы (`")]}'"` в isRawXssiPayload), и обратные кавычки
// в комментариях (`f.txt`); текст функций остаётся байт-в-байт исходным.
const SANDBOX_CODE = SCOPE_FNS.map(function (n) { return fnDecl(INTERCEPT, n); }).join('\n');

const SCOPE = 'with (ctx) {' +
  'var __code = ' + JSON.stringify(SANDBOX_CODE) + ';' +
  'eval(__code);' +
  SCOPE_DECLS.join(' ') +
  SCOPE_EXPORTS.join(' ') + '}';

const makeApi = new Function('ctx', SCOPE);

// Ответ сети для шагов пагинации: тела отдаются по очереди (последнее — повторяется).
function makeFetch(bodies, url) {
  const queue = bodies.slice();
  return function () {
    const body = (queue.length > 1) ? queue.shift() : (queue[0] || '');
    return Promise.resolve({
      ok: true,
      status: 200,
      url: url,
      clone: function () { return this; },
      text: function () { return Promise.resolve(body); }
    });
  };
}

module.exports = {
  ROOT: ROOT,
  INTERCEPT: INTERCEPT,
  Parser: Parser,
  fnDecl: fnDecl,
  makeApi: makeApi,
  makeFetch: makeFetch,
  SCOPE_FNS: SCOPE_FNS,
  API_FNS: API_FNS,
  SANDBOX_CODE: SANDBOX_CODE
};
