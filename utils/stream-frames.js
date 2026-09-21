/**
 * O-35: UMD-порт КАРКАСА универсального stream-analyzer.js (экспорт чата
 * ai-context-monitor-deepseek-DeepSeek-R1-2026-09-18-17-53.txt, раздел «stream-analyzer.js»).
 *
 * Перенесены РОВНО три функции каркаса — и ничего больше:
 *   frames(res)                  — ReadableStream → SSE-кадры { event, data };
 *   normUsage(u)                 — нормализация usage разных провайдеров
 *                                  (input/output/total/reasoning/cached);
 *   mergeUsage(prev, next, cum)  — слияние usage: cumulative → перезапись, иначе — сумма.
 *
 * ЧЕГО ЗДЕСЬ СОЗНАТЕЛЬНО НЕТ (вариант A + C-lite, решение владельца по O-35):
 *   - адаптеров провайдеров (qwen/openai/anthropic/gemini/generic/deepseekWeb) — они не
 *     задействуются: шесть существующих перехватчиков сохраняют собственные парсеры, а
 *     Qwen-перехватчик читает свои поля сам (core/qwen-intercept.js);
 *   - detectProvider/analyze-фасада и реестра PROVIDERS.
 *   Поэтому исходный файл в проект НЕ копировался: порт — только каркас.
 *
 * Совместимость (ключевое требование O-35):
 *   - НИКАКОГО ESM-синтаксиса: нет export/import, нет литерала async-генератора в коде.
 *     Нативный async-generator создаётся РАНТАЙМ-конструктором (Function) и только если
 *     рантайм его поддерживает; иначе работает ручной pull-итератор на Promise. Это снимает
 *     блокер «ESM-синтаксис не грузится как классический скрипт MV3»: файл подключается и как
 *     классический content-script (MAIN-мир, registerContentScripts), и как importScripts в SW,
 *     и как require() в Node/jest.
 *   - Именованная обёртка по образцу utils/intercept-common.js: window.aiCmStreamFrames /
 *     self.aiCmStreamFrames / module.exports.
 *
 * Контракт frames() — эквивалентный исходному каркасу, включая:
 *   - не-SSE (нет 'event-stream' в content-type): тело копится целиком, затем JSON-массив
 *     (каждый элемент — отдельный кадр) ЛИБО склейка объектов {...}{...} (splitJsonObjects);
 *   - SSE: построчный разбор, ':'-комментарии/ping пропускаются, 'event:' копится до 'data:',
 *     пустая строка закрывает событие, хвост без '\n' дочитывается после done;
 *   - '[DONE]' НЕ фильтруется здесь — это решение вызывающего (как в исходнике).
 */
(function () {
  'use strict';

  // Резать склейку {...}{...} на отдельные объекты (не-SSE фолбэк). Тот же алгоритм, что в
  // исходном каркасе: глубина фигурных скобок + корректный учёт строк/экранирования.
  function splitJsonObjects(s) {
    var out = [], depth = 0, start = -1, inStr = false, esc = false;
    var str = String(s == null ? '' : s);
    for (var i = 0; i < str.length; i++) {
      var c = str.charAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') { if (depth++ === 0) start = i; }
      else if (c === '}') { if (--depth === 0 && start >= 0) { out.push(str.slice(start, i + 1)); start = -1; } }
    }
    return out;
  }

  function hasAsyncGenerators() {
    try {
      // Проверка РАНТАЙМА, а не парсера: async-генератор создаётся только там, где он реально
      // поддержан (Node 10+ / Chromium 63+). Это рантайм-конструкция, а не ESM-синтаксис файла.
      new Function('return async function*(){}');
      return true;
    } catch (e) { return false; }
  }

  var NATIVE_ASYNC_GEN = hasAsyncGenerators();

  // Декодер тела: глобальный TextDecoder (браузер, worker, Node 18+) либо, если глобального
  // нет (jsdom-стенды jest, урезанные песочницы), — из встроенного модуля 'util'.
  var TEXT_DECODER = (function () {
    try { if (typeof TextDecoder !== 'undefined') return TextDecoder; } catch (eG) { }
    try {
      if (typeof require === 'function') {
        var utilMod = require('util');
        if (utilMod && typeof utilMod.TextDecoder === 'function') return utilMod.TextDecoder;
      }
    } catch (eReq) { }
    return null;
  })();

  // Единый декодер кадров потока: TextDecoder, если он есть, иначе — ВСТРОЕННЫЙ потоковый
  // UTF-8 декодер. Второй путь нужен потому, что разбор идёт и в мире БЕЗ TextDecoder
  // (jsdom-стенды, урезанные песочницы), а String(Uint8Array) дал бы "123,34,…" вместо JSON.
  // Фолбэк ОБЯЗАН дочитывать многобайтные последовательности между чанками: у Qwen русский
  // текст режется по байтам, и побайтовое String.fromCharCode дало бы «ÐÐ¾Ð»…» (ловлено пробой).
  // Возвращает { text(v, stream), flush() } — один контракт для обеих веток frames().
  function makeDecodeStream() {
    var dec = null;
    if (TEXT_DECODER) {
      try { dec = new TEXT_DECODER(); } catch (eNew) { dec = null; }
    }
    if (dec) {
      return {
        text: function (v, stream) { return dec.decode(v, { stream: stream === true }); },
        flush: function () { return dec.decode(); }
      };
    }

    var pending = [];   // байты незавершённой UTF-8 последовательности

    function asBytes(v) {
      try {
        if (typeof v === 'string') return null;
        if (v && typeof v.length === 'number') return v;
        if (v && typeof v.byteLength === 'number') return new Uint8Array(v);
      } catch (eB) { }
      return null;
    }
    // Ожидаемая длина последовательности по ведущему байту (1 — ASCII/невалидный).
    function seqLen(b) {
      if (b < 0x80) return 1;
      if (b >= 0xC2 && b <= 0xDF) return 2;
      if (b >= 0xE0 && b <= 0xEF) return 3;
      if (b >= 0xF0 && b <= 0xF4) return 4;
      return 1;
    }
    function decodeNative(v) {
      var b = asBytes(v);
      if (!b) return String(v);
      var bytes = pending.length ? pending.concat(Array.prototype.slice.call(b)) : Array.prototype.slice.call(b);
      pending = [];
      var out = '';
      var i = 0;
      while (i < bytes.length) {
        var n = seqLen(bytes[i]);
        if (i + n > bytes.length) {                       // хвост добираем следующим чанком
          pending = bytes.slice(i);
          break;
        }
        var cp;
        if (n === 1) cp = bytes[i];
        else if (n === 2) cp = ((bytes[i] & 0x1F) << 6) | (bytes[i + 1] & 0x3F);
        else if (n === 3) cp = ((bytes[i] & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F);
        else cp = ((bytes[i] & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) | ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F);
        if (cp > 0xFFFF) {                                // суррогатная пара
          cp -= 0x10000;
          out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
        } else {
          out += String.fromCharCode(cp);
        }
        i += n;
      }
      return out;
    }

    return {
      text: function (v) { return decodeNative(v); },
      flush: function () {
        // незавершённая последовательность в конце потока: байты по одному (лучше, чем потерять)
        var rest = pending;
        pending = [];
        var out = '';
        for (var i = 0; i < rest.length; i++) out += String.fromCharCode(rest[i]);
        return out;
      }
    };
  }

  // Нативный async-generator — ТОЛЬКО как рантайм-конструкция, создаваемая Function-конструктором
  // (в исходнике файла нет ни export, ни литерала async-генератора). Фабрика ниже получает ПОТОК
  // инструкций (объявление генератора) вместо '__SRC__' и возвращает обёртку frames — обычную
  // функцию (ES5-совместимую снаружи), возвращающую async-итератор. Ошибка компиляции (CSP,
  // урезанный рантайм) → тихий переход на ручной pull-итератор ниже.
  //
  // Резак склейки и декодер потока приходят в фабрику АРГУМЕНТАМИ из замыкания модуля: у
  // сгенерированного кода своя область видимости, и ни резак, ни TextDecoder ему не видны.
  var ASYNC_GEN_FACTORY_BODY = "(function (splitJsonObjects, dec) {\n" +
    "  'use strict';\n" +
    '  __SRC__\n' +
    '  return function frames(res) { return __GENERATOR__(res); };\n' +
    '})';

  var ASYNC_GEN_SOURCE = [
    'async function* __GENERATOR__(res) {',
    "  var ct = '';",
    "  try { if (res && res.headers && typeof res.headers.get === 'function') ct = String(res.headers.get('content-type') || '').toLowerCase(); } catch (eCt) { ct = ''; }",
    "  var isSSE = ct.indexOf('event-stream') !== -1;",
    "  var reader = (res && res.body && typeof res.body.getReader === 'function') ? res.body.getReader() : null;",
    "  if (!reader) return;",
    "  var buf = '';",
    "  if (!isSSE) {",
    "    var all = '';",
    "    while (true) {",
    "      var r0 = await reader.read();",
    "      if (!r0 || r0.done) break;",
    "      all += dec.text(r0.value, true);",
    "    }",
    "    all += dec.flush();",
    "    var trimmed = all.trim();",
    "    if (!trimmed) return;",
    "    if (trimmed.charAt(0) === '[') {",
    "      var arr = null;",
    "      try { arr = JSON.parse(trimmed); } catch (eArr) { arr = null; }",
    "      if (arr && typeof arr.length === 'number') {",
    "        for (var ai = 0; ai < arr.length; ai++) yield { data: JSON.stringify(arr[ai]) };",
    "      }",
    "    } else {",
    "      var glued = splitJsonObjects(trimmed);",
    "      for (var gi = 0; gi < glued.length; gi++) yield { data: glued[gi] };",
    "    }",
    "    return;",
    "  }",
    "  var pendingEvent = null;",
    "  while (true) {",
    "    var r1 = await reader.read();",
    "    if (!r1 || r1.done) break;",
    "    buf += dec.text(r1.value, true);",
    "    var idx;",
    "    while ((idx = buf.indexOf('\\n')) >= 0) {",
    "      var line = buf.slice(0, idx);",
    "      if (line.charAt(line.length - 1) === '\\r') line = line.slice(0, -1);",
    "      buf = buf.slice(idx + 1);",
    "      if (!line) { pendingEvent = null; continue; }",
    "      if (line.charAt(0) === ':') continue;",
    "      var ev = /^event:\\s?(.*)$/.exec(line);",
    "      if (ev) { pendingEvent = ev[1]; continue; }",
    "      var d = /^data:\\s?(.*)$/.exec(line);",
    "      if (d) yield { event: pendingEvent, data: d[1] };",
    "    }",
    "  }",
    "  var tail = buf;",
    "  if (tail.charAt(tail.length - 1) === '\\r') tail = tail.slice(0, -1);",
    "  var dt = /^data:\\s?(.*)$/.exec(tail);",
    "  if (dt) yield { event: pendingEvent, data: dt[1] };",
    "}"
  ].join('\n');

  // Ручной pull-итератор на Promise (рантайм без нативных async-генераторов либо запрет
  // Function/eval): семантика кадров 1:1 с нативной веткой выше. Поток читается ОДНИМ проходом,
  // кадры кладутся в очередь, а каждый next() отдаёт голову очереди — либо ждёт следующего
  // кадра/конца. Хвост без '\n' кладётся в очередь ПОСЛЕДНИМ кадром, поэтому порядок
  // «хвост → done» соблюдён (ровно этот случай ловился пробой на этапе разработки).
  function framesManual(res) {
    var queue = [];
    var waiters = [];
    var failure = null;         // ошибка чтения — отдаётся первым же ожидающим
    var started = false;
    var finishedRead = false;   // чтение тела завершено (очередь может быть ещё не пуста)

    function wake() {
      while (waiters.length) {
        if (queue.length) { waiters.shift().resolve({ value: queue.shift(), done: false }); continue; }
        if (failure) { waiters.shift().reject(failure); continue; }
        if (finishedRead) { waiters.shift().resolve({ value: undefined, done: true }); continue; }
        return;                                        // кадра ещё нет — ждём дальше
      }
    }
    function push(frame) { queue.push(frame); wake(); }

    function run() {
      var ct = '';
      try {
        if (res && res.headers && typeof res.headers.get === 'function') {
          ct = String(res.headers.get('content-type') || '').toLowerCase();
        }
      } catch (eCt) { ct = ''; }
      var isSSE = ct.indexOf('event-stream') !== -1;
      var reader = (res && res.body && typeof res.body.getReader === 'function') ? res.body.getReader() : null;
      if (!reader) { finishedRead = true; return Promise.resolve(); }
      var dec = makeDecodeStream();

      if (!isSSE) {
        // Не-SSE: тело копится ЦЕЛИКОМ, затем JSON-массив либо склейка {...}{...}.
        var all = '';
        var readAll = function () {
          return reader.read().then(function (r) {
            if (r && r.done) {
              all += dec.flush();
              var trimmed = all.trim();
              if (trimmed) {
                if (trimmed.charAt(0) === '[') {
                  var arr = null;
                  try { arr = JSON.parse(trimmed); } catch (eArr) { arr = null; }
                  if (arr && typeof arr.length === 'number') {
                    for (var i = 0; i < arr.length; i++) push({ data: JSON.stringify(arr[i]) });
                  }
                } else {
                  var glued = splitJsonObjects(trimmed);
                  for (var j = 0; j < glued.length; j++) push({ data: glued[j] });
                }
              }
              finishedRead = true;
              return;
            }
            all += dec.text(r.value, true);
            return readAll();
          });
        };
        return readAll();
      }

      var buf = '';
      var pendingEvent = null;
      var readLines = function () {
        return reader.read().then(function (r) {
          if (r && r.done) {
            var tail = buf;
            if (tail.charAt(tail.length - 1) === '\r') tail = tail.slice(0, -1);
            var dt = /^data:\s?(.*)$/.exec(tail);
            if (dt) push({ event: pendingEvent, data: dt[1] });   // хвост без '\n' — последний кадр
            finishedRead = true;
            return;
          }
          buf += dec.text(r.value, true);
          var idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            var line = buf.slice(0, idx);
            if (line.charAt(line.length - 1) === '\r') line = line.slice(0, -1);
            buf = buf.slice(idx + 1);
            if (!line) { pendingEvent = null; continue; }         // конец события
            if (line.charAt(0) === ':') continue;                 // ping/comment
            var ev = /^event:\s?(.*)$/.exec(line);
            if (ev) { pendingEvent = ev[1]; continue; }
            var d = /^data:\s?(.*)$/.exec(line);
            if (d) push({ event: pendingEvent, data: d[1] });
          }
          return readLines();
        });
      };
      return readLines();
    }

    var it = {};
    it.next = function () {
      if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
      if (failure) return Promise.reject(failure);
      if (!started) {
        started = true;
        return run().then(
          function () { return it.next(); },
          function (e) { failure = e; wake(); throw e; }
        );
      }
      if (finishedRead) return Promise.resolve({ value: undefined, done: true });
      return new Promise(function (resolve, reject) { waiters.push({ resolve: resolve, reject: reject }); });
    };
    if (typeof Symbol !== 'undefined' && Symbol.asyncIterator) {
      it[Symbol.asyncIterator] = function () { return it; };
    }
    return it;
  }

  var frames = framesManual;
  if (NATIVE_ASYNC_GEN) {
    try {
      // Тонкость Function-конструктора: new Function(BODY) даёт функцию-ОБЁРТКУ, телом которой
      // является BODY; вызов обёртки возвращает объявленную в BODY фабрику (ловилось пробой).
      var factory = new Function(ASYNC_GEN_FACTORY_BODY.replace('__SRC__', ASYNC_GEN_SOURCE))();
      frames = factory(splitJsonObjects, makeDecodeStream());
      if (typeof frames !== 'function' || frames === factory) frames = framesManual;
    } catch (eNative) {
      frames = framesManual;
    }
  }

  // ─────────────── Нормализация usage ───────────────
  // Первое ЧИСЛОВОЕ значение из кандидатов (0 — валидное число, undefined/null/строки — нет).
  function num() {
    for (var i = 0; i < arguments.length; i++) {
      if (typeof arguments[i] === 'number') return arguments[i];
    }
    return null;
  }
  function pick(obj, key) {
    try { return (obj && typeof obj === 'object') ? obj[key] : undefined; } catch (e) { return undefined; }
  }

  /**
   * Нормализация usage разных провайдеров к единой форме.
   * Qwen: input_tokens/output_tokens/total_tokens + output_tokens_details.reasoning_tokens
   * + prompt_tokens_details.cached_tokens (спека провайдера, экспорт чата 2026-09-18).
   */
  function normalizeUsage(u) {
    if (!u || typeof u !== 'object') return null;
    return {
      input: num(u.input_tokens, u.prompt_tokens, u.promptTokenCount),
      output: num(u.output_tokens, u.completion_tokens, u.candidatesTokenCount),
      total: num(u.total_tokens, u.totalTokenCount),
      reasoning: num(pick(u.output_tokens_details, 'reasoning_tokens'),
        pick(u.completion_tokens_details, 'reasoning_tokens'),
        u.thoughtsTokenCount),
      cached: num(pick(u.prompt_tokens_details, 'cached_tokens'),
        u.cache_read_input_tokens,
        u.cachedContentTokenCount)
    };
  }

  /**
   * Слияние usage. cumulative === true → перезапись (Qwen отдаёт КУМУЛЯТИВНЫЙ usage в каждом
   * чанке: сумма 63+174+337+553+884 даёт 2011 — неверно, верно последнее значение 884).
   * cumulative !== true → суммирование полей (OpenAI/Claude: usage приходит частями).
   * null-поля next не затирают уже собранное.
   */
  function mergeUsage(prev, next, cumulative) {
    if (!next) return prev;
    if (!prev) {
      var copy = {};
      for (var k0 in next) {
        if (Object.prototype.hasOwnProperty.call(next, k0)) copy[k0] = next[k0];
      }
      return copy;
    }
    var out = {};
    for (var k1 in prev) {
      if (Object.prototype.hasOwnProperty.call(prev, k1)) out[k1] = prev[k1];
    }
    for (var k2 in next) {
      if (!Object.prototype.hasOwnProperty.call(next, k2)) continue;
      var v = next[k2];
      if (v === null || v === undefined) continue;
      out[k2] = cumulative ? v : ((typeof out[k2] === 'number' ? out[k2] : 0) + v);
    }
    return out;
  }

  var api = {
    frames: frames,
    normUsage: normalizeUsage,
    mergeUsage: mergeUsage,
    // Пины/диагностика: доступна ли нативная ветка async-генератора в этом рантайме и ТА ЖЕ
    // функция кадров в ручной ветке (пин паритета обеих веток). Побочных эффектов нет.
    _nativeAsyncGenerator: NATIVE_ASYNC_GEN,
    _framesManual: framesManual,
    _splitJsonObjects: splitJsonObjects
  };

  if (typeof window !== 'undefined') {
    window.aiCmStreamFrames = api;
  }
  // MV3 Service Worker / воркеры: глобальный объект — self (window отсутствует).
  if (typeof self !== 'undefined') {
    self.aiCmStreamFrames = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
