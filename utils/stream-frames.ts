/**
 * O-35: КАРКАС универсального stream-analyzer.js → ESM-модуль (Roadmap Ph2).
 *
 * Перенесены РОВНО функции каркаса — и ничего больше:
 *   frames(res)                  — ReadableStream → SSE-кадры { event, data };
 *   normalizeUsage(u)            — нормализация usage разных провайдеров
 *                                  (input/output/total/reasoning/cached);
 *   mergeUsage(prev, next, cum)  — слияние usage: cumulative → перезапись, иначе — сумма.
 * Кадры потока отдаёт frames() (внутри — async-функция-генератор framesNative); ручной
 * pull-итератор framesManual и splitJsonObjects сохранены как ЭТАЛОН ПАРИТЕТА (не рантайм-
 * фолбэк: на них держатся пины равенства кадров двух реализаций) и экспортированы именованно.
 *
 * ЧЕГО ЗДЕСЬ СОЗНАТЕЛЬНО НЕТ (вариант A + C-lite, решение владельца по O-35):
 *   - адаптеров провайдеров (qwen/openai/anthropic/gemini/generic/deepseekWeb) — они не
 *     задействуются: шесть существующих перехватчиков сохраняют собственные парсеры, а
 *     Qwen-перехватчик читает свои поля сам (core/qwen-intercept.js);
 *   - detectProvider/analyze-фасада и реестра PROVIDERS.
 *
 * Ph2 (ESM-pilot, единственное исключение из concat-сборки build.mjs):
 *   - файл — настоящий ESM: export-декларации, UMD-каркаса больше нет (глобальных публикаций
 *     в window/self и CJS-экспорта нет); подключается ТОЛЬКО статическим import;
 *   - единственный потребитель — core/qwen-intercept.js (тоже ESM): esbuild вшивает этот файл
 *     в бандл MAIN-перехватчика (build.mjs, mainInterceptOptions); отдельным content-script
 *     из js[] и как importScripts файл больше НЕ подключается;
 *   - require('util') больше нет: при отсутствии TextDecoder работает ВСТРОЕННЫЙ потоковый
 *     UTF-8 декодер (jsdom-стенды, урезанные песочницы), поэтому в бандл не тянется Node-код;
 *   - async-функция-генератор — языковая конструкция ES2018, а не ESM, CSP-блокера нет:
 *     Function/eval в файле отсутствуют.
 *
 * Контракт frames() — эквивалентный исходному каркасу, включая:
 *   - не-SSE (нет 'event-stream' в content-type): тело копится целиком, затем JSON-массив
 *     (каждый элемент — отдельный кадр) ЛИБО склейка объектов {...}{...} (splitJsonObjects);
 *   - SSE: построчный разбор, ':'-комментарии/ping пропускаются, 'event:' копится до 'data:',
 *     пустая строка закрывает событие, хвост без '\n' дочитывается после done;
 *   - '[DONE]' НЕ фильтруется здесь — это решение вызывающего (как в исходнике).
 *
 * @module utils/stream-frames
 */

import type { StreamFrame, Usage } from '../types/stream';

/** Response-подобный вход frames(): только заголовки и поток тела. */
export interface FramesResponse {
  headers?: { get(name: string): string | null } | null;
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: unknown }> } } | null;
}

/** Контракт потокового декодера кадров: TextDecoder либо встроенный UTF-8 декодер. */
export interface FrameDecoder {
  text(v: unknown, stream?: boolean): string;
  flush(): string;
}

// Резать склейку {...}{...} на отдельные объекты (не-SSE фолбэк). Тот же алгоритм, что в
// исходном каркасе: глубина фигурных скобок + корректный учёт строк/экранирования.
/**
 * Режет склейку {...}{...} на отдельные JSON-объекты (не-SSE фолбэк).
 * Возвращает объекты в порядке следования; [] для пустого входа.
 */
export function splitJsonObjects(s: string | null | undefined): string[] {
  var out: string[] = [], depth = 0, start = -1, inStr = false, esc = false;
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

// Декодер тела: глобальный TextDecoder (браузер, worker, Node 18+). Если его нет
// (jsdom-стенды jest, урезанные песочницы), работает ВСТРОЕННЫЙ потоковый UTF-8 декодер
// ниже — поэтому модуль не тянет Node-модуль 'util' и остаётся чистым ESM без require.
/** Глобальный TextDecoder либо null (тогда — встроенный декодер). */
var TEXT_DECODER: typeof TextDecoder | null = (function (): typeof TextDecoder | null {
  try { if (typeof TextDecoder !== 'undefined') return TextDecoder; } catch (eG) { }
  return null;
})();

// Единый декодер кадров потока: TextDecoder, если он есть, иначе — ВСТРОЕННЫЙ потоковый
// UTF-8 декодер. Второй путь нужен потому, что разбор идёт и в мире БЕЗ TextDecoder
// (jsdom-стенды, урезанные песочницы), а String(Uint8Array) дал бы "123,34,…" вместо JSON.
// Фолбэк ОБЯЗАН дочитывать многобайтные последовательности между чанками: у Qwen русский
// текст режется по байтам, и побайтовое String.fromCharCode дало бы «ÐÐ¾Ð»…» (ловлено пробой).
// Возвращает { text(v, stream), flush() } — один контракт для обеих веток frames().
/**
 * Единый потоковый декодер кадров: TextDecoder либо встроенный UTF-8 декодер.
 */
function makeDecodeStream(): FrameDecoder {
  var dec: TextDecoder | null = null;
  if (TEXT_DECODER) {
    try { dec = new TEXT_DECODER(); } catch (eNew) { dec = null; }
  }
  if (dec) {
    return {
      text: function (v: unknown, stream?: boolean): string { return dec.decode(v as BufferSource, { stream: stream === true }); },
      flush: function (): string { return dec.decode(); }
    };
  }

  var pending: number[] = [];   // байты незавершённой UTF-8 последовательности

  function asBytes(v: unknown): ArrayLike<number> | null {
    try {
      if (typeof v === 'string') return null;
      var src = v as { length?: number; byteLength?: number } | null;
      if (src && typeof src.length === 'number') return src as ArrayLike<number>;
      if (src && typeof src.byteLength === 'number') return new Uint8Array(v as ArrayBufferLike);
    } catch (eB) { }
    return null;
  }
  // Ожидаемая длина последовательности по ведущему байту (1 — ASCII/невалидный).
  function seqLen(b: number): number {
    if (b < 0x80) return 1;
    if (b >= 0xC2 && b <= 0xDF) return 2;
    if (b >= 0xE0 && b <= 0xEF) return 3;
    if (b >= 0xF0 && b <= 0xF4) return 4;
    return 1;
  }
  function decodeNative(v: unknown): string {
    var b = asBytes(v);
    if (!b) return String(v);
    var bytes: number[] = pending.length ? pending.concat(Array.prototype.slice.call(b)) : Array.prototype.slice.call(b);
    pending = [];
    var out = '';
    var i = 0;
    while (i < bytes.length) {
      var n = seqLen(bytes[i]);
      if (i + n > bytes.length) {                       // хвост добираем следующим чанком
        pending = bytes.slice(i);
        break;
      }
      var cp: number;
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

// Нативный async-generator объявлен ЛИТЕРАЛОМ прямо в файле (ES2018). Это не ESM-синтаксис,
// поэтому файл по-прежнему грузится как классический content-script MV3, как importScripts в
// SW и как require() в Node/jest. Function-конструктор/eval не используются вовсе — CSP-блокер,
// ради которого раньше существовала строковая фабрика, снят. Тело перенесено из прежней
// строковой константы ДОСЛОВНО (та же логика кадров и тот же порядок yield'ов).
//
// Резак склейки берётся из замыкания модуля, декодер потока приходит АРГУМЕНТОМ (это ровно
// те две вещи, которые прежняя фабрика передавала сгенерированному коду параметрами).
/**
 * Нативный async-генератор кадров (ES2018-литерал): SSE — построчно, не-SSE — целиком.
 * res — Response-подобный объект, dec — декодер потока.
 */
async function* framesNative(res: FramesResponse | null, dec: FrameDecoder): AsyncGenerator<StreamFrame, void, unknown> {
  var ct = '';
  try { if (res && res.headers && typeof res.headers.get === 'function') ct = String(res.headers.get('content-type') || '').toLowerCase(); } catch (eCt) { ct = ''; }
  var isSSE = ct.indexOf('event-stream') !== -1;
  var reader = (res && res.body && typeof res.body.getReader === 'function') ? res.body.getReader() : null;
  if (!reader) return;
  var buf = '';
  if (!isSSE) {
    var all = '';
    while (true) {
      var r0 = await reader.read();
      if (!r0 || r0.done) break;
      all += dec.text(r0.value, true);
    }
    all += dec.flush();
    var trimmed = all.trim();
    if (!trimmed) return;
    if (trimmed.charAt(0) === '[') {
      var arr = null;
      try { arr = JSON.parse(trimmed); } catch (eArr) { arr = null; }
      if (arr && typeof arr.length === 'number') {
        for (var ai = 0; ai < arr.length; ai++) yield { data: JSON.stringify(arr[ai]) };
      }
    } else {
      var glued = splitJsonObjects(trimmed);
      for (var gi = 0; gi < glued.length; gi++) yield { data: glued[gi] };
    }
    return;
  }
  var pendingEvent = null;
  while (true) {
    var r1 = await reader.read();
    if (!r1 || r1.done) break;
    buf += dec.text(r1.value, true);
    var idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      var line = buf.slice(0, idx);
      if (line.charAt(line.length - 1) === '\r') line = line.slice(0, -1);
      buf = buf.slice(idx + 1);
      if (!line) { pendingEvent = null; continue; }
      if (line.charAt(0) === ':') continue;
      var ev = /^event:\s?(.*)$/.exec(line);
      if (ev) { pendingEvent = ev[1]; continue; }
      var d = /^data:\s?(.*)$/.exec(line);
      if (d) yield { event: pendingEvent, data: d[1] };
    }
  }
  var tail = buf;
  if (tail.charAt(tail.length - 1) === '\r') tail = tail.slice(0, -1);
  var dt = /^data:\s?(.*)$/.exec(tail);
  if (dt) yield { event: pendingEvent, data: dt[1] };
}

// Ручной pull-итератор на Promise (рантайм без нативных async-генераторов либо запрет
// Function/eval): семантика кадров 1:1 с нативной веткой выше. Поток читается ОДНИМ проходом,
// кадры кладутся в очередь, а каждый next() отдаёт голову очереди — либо ждёт следующего
// кадра/конца. Хвост без '\n' кладётся в очередь ПОСЛЕДНИМ кадром, поэтому порядок
// «хвост → done» соблюдён (ровно этот случай ловился пробой на этапе разработки).
/**
 * Итератор кадров ручной ветки: next() отдаёт голову очереди либо ждёт следующий кадр/конец.
 */
export interface ManualFrameIterator {
  next(): Promise<{ value?: StreamFrame; done: boolean }>;
  [Symbol.asyncIterator](): ManualFrameIterator;
}

/**
 * Ручной pull-итератор кадров (ES5-эталон паритета): очередь кадров + ожидающие next().
 */
export function framesManual(res: FramesResponse | null): ManualFrameIterator {
  var queue: StreamFrame[] = [];
  var waiters: Array<{ resolve: (r: { value?: StreamFrame; done: boolean }) => void; reject: (e: unknown) => void }> = [];
  var failure: unknown = null;         // ошибка чтения — отдаётся первым же ожидающим
  var started = false;
  var finishedRead = false;   // чтение тела завершено (очередь может быть ещё не пуста)

  function wake(): void {
    while (waiters.length) {
      if (queue.length) { waiters.shift().resolve({ value: queue.shift(), done: false }); continue; }
      if (failure) { waiters.shift().reject(failure); continue; }
      if (finishedRead) { waiters.shift().resolve({ value: undefined, done: true }); continue; }
      return;                                        // кадра ещё нет — ждём дальше
    }
  }
  function push(frame: StreamFrame): void { queue.push(frame); wake(); }

  function run(): Promise<void> {
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

  var it = {} as ManualFrameIterator;
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

// Декодер создаётся ОДИН раз при инициализации модуля — ровно как в прежней фабрике, которой
// он передавался аргументом, и не создаётся заново на каждый вызов frames(). Семантика
// сохранена 1:1 (один экземпляр на модуль); ручная ветка по-прежнему делает свой декодер в run().
/** Декодер модуля (один на файл). */
var framesDecodeStream: FrameDecoder = makeDecodeStream();
/**
 * Кадры потока: нативная async-функция-генератор с декодером модуля.
 */
export function frames(res: FramesResponse | null): AsyncGenerator<StreamFrame, void, unknown> {
  return framesNative(res, framesDecodeStream);
}

// ─────────────── Нормализация usage ───────────────
// Первое ЧИСЛОВОЕ значение из кандидатов (0 — валидное число, undefined/null/строки — нет).
/**
 * Первое ЧИСЛОВОЕ значение из кандидатов (0 — валидное число).
 */
function num(...args: unknown[]): number | null {
  for (var i = 0; i < args.length; i++) {
    if (typeof args[i] === 'number') return args[i] as number;
  }
  return null;
}
/**
 * Безопасное чтение поля объекта (не бросает на null/примитивах).
 */
function pick(obj: unknown, key: string): unknown {
  try { return (obj && typeof obj === 'object') ? (obj as Record<string, unknown>)[key] : undefined; } catch (e) { return undefined; }
}

/**
 * Нормализация usage разных провайдеров к единой форме.
 * Qwen: input_tokens/output_tokens/total_tokens + output_tokens_details.reasoning_tokens
 * + prompt_tokens_details.cached_tokens (спека провайдера, экспорт чата 2026-09-18).
 * Возвращает нормализованный usage либо null, если вход не объект.
 */
export function normalizeUsage(u: unknown): Usage | null {
  if (!u || typeof u !== 'object') return null;
  var src = u as Record<string, unknown>;
  return {
    input: num(src.input_tokens, src.prompt_tokens, src.promptTokenCount),
    output: num(src.output_tokens, src.completion_tokens, src.candidatesTokenCount),
    total: num(src.total_tokens, src.totalTokenCount),
    reasoning: num(pick(src.output_tokens_details, 'reasoning_tokens'),
      pick(src.completion_tokens_details, 'reasoning_tokens'),
      src.thoughtsTokenCount),
    cached: num(pick(src.prompt_tokens_details, 'cached_tokens'),
      src.cache_read_input_tokens,
      src.cachedContentTokenCount)
  };
}

/**
 * Слияние usage. cumulative === true → перезапись (Qwen отдаёт КУМУЛЯТИВНЫЙ usage в каждом
 * чанке: сумма 63+174+337+553+884 даёт 2011 — неверно, верно последнее значение 884).
 * cumulative !== true → суммирование полей (OpenAI/Claude: usage приходит частями).
 * null-поля next не затирают уже собранное.
 */
export function mergeUsage(prev: Usage | null, next: Usage | null, cumulative?: boolean): Usage | null {
  if (!next) return prev;
  if (!prev) {
    var copy = {} as Usage;
    for (var k0 in next) {
      if (Object.prototype.hasOwnProperty.call(next, k0)) copy[k0] = next[k0];
    }
    return copy;
  }
  var out = {} as Usage;
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
