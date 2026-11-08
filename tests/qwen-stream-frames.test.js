/**
 * O-35: utils/stream-frames.ts — КАРКАС stream-analyzer.js, ESM-модуль (Roadmap Ph2).
 * (frames / normalizeUsage / mergeUsage + эталонные framesManual / splitJsonObjects).
 * Источник: экспорт чата ai-context-monitor-deepseek-DeepSeek-R1-2026-09-18-17-53.txt
 * («stream-analyzer.js»).
 *
 * Пины:
 *   1) файл — настоящий ESM: inline 'export function ...', UMD-хвоста и CJS-экспорта нет;
 *      нативный async-генератор — ЛИТЕРАЛ в коде (ES2018), Function-конструктора нет;
 *   2) frames(): SSE-кадры ({event,data}, ':'-комментарии, пустая строка как граница
 *      события, хвост без \n, CRLF), не-SSE фолбэк (склейка {...}{...} и JSON-массив);
 *   3) normalizeUsage(): имена полей Qwen/OpenAI/Anthropic/Gemini -> единая форма;
 *   4) mergeUsage(): cumulative=true — ПЕРЕЗАПИСЬ (Qwen: 63->174->337->553->884 даёт 884,
 *      а не 2011), cumulative=false — сумма; null не затирает собранное;
 *   5) паритет нативной и ручной веток frames() на одних и тех же телах;
 *   6) модуль подключается ТОЛЬКО статическим import (core/qwen-intercept.js), поэтому
 *      глобальных window/self-имён больше нет.
 */
const fs = require('fs');
const path = require('path');
const { TextEncoder } = require('util');   // jsdom-окружение не даёт TextEncoder глобально
const { loadEsmModule } = require('./helpers/load-esm.js');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'utils', 'stream-frames.ts'), 'utf8');
// Ph2: модуль — ESM, require() его не берёт; грузим тем же приёмом, что прод-код
// (tests/helpers/load-esm.js: fs + new Function, без babel и новых зависимостей).
const SF = loadEsmModule('utils/stream-frames.ts');
const { frames, normalizeUsage, mergeUsage, framesManual, splitJsonObjects } = SF;

// ---------- фейковый ReadableStream-ответ (jsdom без ReadableStream) ----------
// ВАЖНО: каждый вызов getReader() отдаёт НЕЗАВИСИМОЕ чтение с нуля — иначе повторный
// проход (паритет нативной и ручной веток, отладочный лог) видел бы пустой поток.
function responseOf(text, contentType, chunkSize) {
  const enc = new TextEncoder();
  const size = chunkSize || 7;                      // дробим — проверяем сборку буфера
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(enc.encode(text.slice(i, i + size)));
  return {
    headers: { get: function () { return contentType; } },
    body: {
      getReader: function () {
        let i = 0;
        return {
          read: function () {
            return Promise.resolve(i < chunks.length
              ? { done: false, value: chunks[i++] }
              : { done: true });
          }
        };
      }
    }
  };
}

async function collect(fn, res) {
  const out = [];
  for await (const f of fn(res)) out.push(f);
  return out;
}

// ---- Принудительный ФОЛБЭК-декодер (модуль без TextDecoder вообще) ----
// jsdom не даёт глобального TextDecoder, поэтому stream-frames.js берёт его из 'util';
// чтобы исполнить ВСТРОЕННЫЙ потоковый UTF-8 декодер (fallback на урезанных песочницах,
// где TextDecoder нет ни глобально, ни в util), подменяем ровно util.TextDecoder на время
// загрузки СВЕЖЕГО экземпляра модуля (jest.resetModules + doMock/dontMock).
function loadWithoutTextDecoder() {
  // Модуль больше не тянет Node-'util': без глобального TextDecoder он сразу выбирает
  // ВСТРОЕННЫЙ потоковый UTF-8 декодер. Убираем глобал на время загрузки СВЕЖЕГО экземпляра
  // модуля и возвращаем его назад в finally.
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'TextDecoder');
  const saved = globalThis.TextDecoder;
  try {
    delete globalThis.TextDecoder;
    return loadEsmModule('utils/stream-frames.ts');
  } finally {
    if (had) globalThis.TextDecoder = saved;
    else delete globalThis.TextDecoder;
  }
}

function responseOfChunks(chunks, contentType) {
  return {
    headers: { get: function () { return contentType; } },
    body: {
      getReader: function () {
        let i = 0;
        return {
          read: function () {
            return Promise.resolve(i < chunks.length
              ? { done: false, value: chunks[i++] }
              : { done: true });
          }
        };
      }
    }
  };
}

describe('O-35: stream-frames.js — ESM-модуль (Roadmap Ph2)', () => {
  test('исходник — ESM: inline export есть, UMD-хвоста нет, генератор — один литерал', () => {
    expect(SRC).toContain('export function frames(res: FramesResponse | null)');
    expect(SRC).toContain('export function normalizeUsage(u: unknown)');
    expect(SRC).not.toContain('module.exports');
    expect(SRC).not.toContain('window.aiCmStreamFrames');
    // Литерал = строка КОДА вида: async function* name(...). Нативная реализация —
    // единственная, поэтому литерал ровно один (комментарии и строки не считаются).
    const codeLines = SRC.split(/\r?\n/).filter(function (l) {
      const t = l.trim();
      return t.indexOf('//') !== 0 && t.indexOf('*') !== 0 && t.indexOf('/*') !== 0;
    });
    const asyncGenLiterals = codeLines.filter(function (l) { return /^async\s+function\s*\*/.test(l.trim()); });
    expect(asyncGenLiterals).toHaveLength(1);
    expect(asyncGenLiterals[0]).toContain('async function* framesNative');
  });

  test('нативный async-generator объявлен литералом, Function-конструктор не нужен (CSP)', () => {
    expect(SRC).not.toContain('new Function');
    expect(typeof framesManual).toBe('function');              // ручной pull-итератор — эталон паритета
  });

  test('ESM-экспорт: frames/normalizeUsage/mergeUsage + эталонные helpers', () => {
    expect(typeof SF.frames).toBe('function');
    expect(typeof normalizeUsage).toBe('function');
    expect(typeof mergeUsage).toBe('function');
    expect(typeof framesManual).toBe('function');
    expect(typeof splitJsonObjects).toBe('function');
  });

  test('порядок аргументов mergeUsage(prev, next, cumulative) сохранён', () => {
    expect(mergeUsage.length).toBe(3);
    expect(normalizeUsage.length).toBe(1);
  });
});

describe('O-35: frames() — SSE-кадры', () => {
  test('обычный SSE: data-кадры по порядку, включая [DONE] (фильтрация — дело вызывающего)', async () => {
    const body = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n';
    const out = await collect(frames, responseOf(body, 'text/event-stream; charset=utf-8'));
    expect(out.map(function (f) { return f.data; }))
      .toEqual(['{"a":1}', '{"b":2}', '[DONE]']);
  });

  test('event: копится до data:, пустая строка сбрасывает, ":"-комментарии пропускаются', async () => {
    const body = ': ping\n\nevent: message\ndata: {"x":1}\n\ndata: {"y":2}\n\n';
    const out = await collect(frames, responseOf(body, 'text/event-stream'));
    expect(out).toEqual([
      { event: 'message', data: '{"x":1}' },
      { event: null, data: '{"y":2}' }
    ]);
  });

  test('хвост без завершающего \\n дочитывается после done; CRLF снимается', async () => {
    const out = await collect(frames, responseOf('data: {"a":1}\r\n\r\ndata: tail', 'text/event-stream'));
    expect(out.map(function (f) { return f.data; })).toEqual(['{"a":1}', 'tail']);
  });

  test('пустое SSE-тело → ни одного кадра', async () => {
    expect(await collect(frames, responseOf('', 'text/event-stream'))).toEqual([]);
  });

  test('не-SSE: склейка {...}{...} режется на отдельные кадры', async () => {
    const out = await collect(frames, responseOf('{"a":1}{"b":[2,3]}', 'application/json'));
    expect(out.map(function (f) { return f.data; })).toEqual(['{"a":1}', '{"b":[2,3]}']);
  });

  test('не-SSE: JSON-массив (Gemini без ?alt=sse) → кадр на элемент', async () => {
    const out = await collect(frames, responseOf('[{"a":1},{"b":2}]', 'application/json'));
    expect(out.map(function (f) { return f.data; })).toEqual(['{"a":1}', '{"b":2}']);
  });

  test('паритет нативной и ручной веток на всех формах тела', async () => {
    const cases = [
      ['data: {"a":1}\n\nevent: e\ndata: {"b":2}\n\n', 'text/event-stream'],
      ['data: tail', 'text/event-stream'],
      ['{"a":1}{"b":2}', 'application/json'],
      ['[1,2,3]', 'application/json']
    ];
    for (const [body, ct] of cases) {
      const native = await collect(frames, responseOf(body, ct));
      const manual = await collect(framesManual, responseOf(body, ct));
      expect([body, manual]).toEqual([body, native]);
    }  });

  test('резак склейки публичен и учитывает строки/экранирование', () => {
    expect(splitJsonObjects('{"a":"}{"}{"b":1}')).toEqual(['{"a":"}{"}', '{"b":1}']);
  });
});

describe('O-35: normalizeUsage() — нормализация usage провайдеров', () => {
  test('Qwen: input/output/total + reasoning внутри output + cached', () => {
    expect(normalizeUsage({
      input_tokens: 1709,
      output_tokens: 884,
      total_tokens: 2593,
      output_tokens_details: { reasoning_tokens: 884 },
      prompt_tokens_details: { cached_tokens: 0 }
    })).toEqual({ input: 1709, output: 884, total: 2593, reasoning: 884, cached: 0 });
  });

  test('OpenAI-совместимые: prompt/completion + completion_tokens_details', () => {
    expect(normalizeUsage({
      prompt_tokens: 10, completion_tokens: 20, total_tokens: 30,
      completion_tokens_details: { reasoning_tokens: 7 },
      prompt_tokens_details: { cached_tokens: 3 }
    })).toEqual({ input: 10, output: 20, total: 30, reasoning: 7, cached: 3 });
  });

  test('Anthropic/Gemini имена: cache_read_input_tokens, thoughtsTokenCount, *TokenCount', () => {
    expect(normalizeUsage({ input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 2 }))
      .toEqual({ input: 5, output: 6, total: null, reasoning: null, cached: 2 });
    expect(normalizeUsage({ promptTokenCount: 11, candidatesTokenCount: 12, totalTokenCount: 23, thoughtsTokenCount: 4, cachedContentTokenCount: 1 }))
      .toEqual({ input: 11, output: 12, total: 23, reasoning: 4, cached: 1 });
  });

  test('не-объект/пусто → null (не выдумываем нули)', () => {
    expect(normalizeUsage(null)).toBeNull();
    expect(normalizeUsage(undefined)).toBeNull();
    expect(normalizeUsage('x')).toBeNull();
  });

  test('0 — валидное число (cached 0 не превращается в null)', () => {
    expect(normalizeUsage({ input_tokens: 0, output_tokens: 0 }).input).toBe(0);
  });
});

describe('O-35: mergeUsage() — кумулятивный vs аддитивный usage', () => {
  test('D4-антипод: Qwen кумулятивен — последний кадр 884, а НЕ сумма 63+174+337+553+884', () => {
    let u = null;
    [63, 174, 337, 553, 884].forEach(function (v) {
      u = mergeUsage(u, { output: v }, true);
    });
    expect(u.output).toBe(884);
    expect(u.output).not.toBe(63 + 174 + 337 + 553 + 884);
    expect(63 + 174 + 337 + 553 + 884).toBe(2011);   // антипод-пин: сумма заведомо другая
  });

  test('аддитивный режим (Claude: input в message_start, output в message_delta) — сумма', () => {
    let u = null;
    u = mergeUsage(u, { input: 100, output: 0 }, false);
    u = mergeUsage(u, { output: 50 }, false);
    expect(u).toEqual({ input: 100, output: 50 });
  });

  test('null/undefined в next не затирают уже собранное', () => {
    const u = mergeUsage({ input: 10, output: 20, reasoning: 5 }, { input: null, reasoning: undefined }, true);
    expect(u).toEqual({ input: 10, output: 20, reasoning: 5 });
  });

  test('null-состояние: next копируется (не тот же объект), next=null → prev как есть', () => {
    const next = { input: 1 };
    const copy = mergeUsage(null, next, true);
    expect(copy).toEqual(next);
    expect(copy).not.toBe(next);
    const prev = { input: 2 };
    expect(mergeUsage(prev, null, true)).toBe(prev);
  });

  test('кумулятивный режим перезаписывает, но не трогает отсутствующие поля', () => {
    const u = mergeUsage({ input: 1709, output: 63, total: 100 }, { output: 884 }, true);
    expect(u).toEqual({ input: 1709, output: 884, total: 100 });
  });
});

describe('O-35: frames() — fallback UTF-8 декодер (без TextDecoder)', () => {
  const dec = loadWithoutTextDecoder();

  test('стенд действительно без TextDecoder: выбран встроенный декодер', () => {
    expect(typeof TextDecoder).toBe('undefined');
    expect(typeof dec.frames).toBe('function');
    expect(typeof dec.framesManual).toBe('function');
  });

  test('fallback-декодер: многобайтная UTF-8 последовательность через границу чанка', async () => {
    const enc = new TextEncoder();
    // 'Привет' в UTF-8: [0xD0,0x9F, 0xD1,0x80, 0xD0,0xB8, 0xD0,0xB2, 0xD0,0xB5, 0xD1,0x82]
    const fullBytes = enc.encode('data: {"text":"Привет"}\n\n');
    // Разрезаем между двумя байтами одного символа
    const chunk1 = fullBytes.slice(0, 10);
    const chunk2 = fullBytes.slice(10);

    const out = await collect(dec.framesManual, responseOfChunks([chunk1, chunk2], 'text/event-stream'));
    expect(out).toHaveLength(1);
    expect(out[0].data).toBe('{"text":"Привет"}');
  });

  test('fallback-декодер: символ режется по каждому байту (по одному в чанке)', async () => {
    const enc = new TextEncoder();
    const bytes = enc.encode('data: {"t":"Привет"}\n\n');
    const chunks = [];
    for (let i = 0; i < bytes.length; i++) chunks.push(bytes.slice(i, i + 1));

    const out = await collect(dec.framesManual, responseOfChunks(chunks, 'text/event-stream'));
    expect(out).toHaveLength(1);
    expect(out[0].data).toBe('{"t":"Привет"}');
  });

  test('fallback-декодер: 4-байтная последовательность (суррогатная пара) не рвётся', async () => {
    const enc = new TextEncoder();
    const fullBytes = enc.encode('data: "🙂"\n\n');
    const cut = fullBytes.indexOf(0xF0) + 2;            // внутри 4-байтного эмодзи
    const out = await collect(dec.framesManual,
      responseOfChunks([fullBytes.slice(0, cut), fullBytes.slice(cut)], 'text/event-stream'));
    expect(out).toHaveLength(1);
    expect(out[0].data).toBe('"🙂"');
  });

  test('flush(): незавершённая UTF-8 последовательность в конце потока не теряется', async () => {
    const enc = new TextEncoder();
    const bytes = enc.encode('data: {"t":"Привет"}');
    // Обрезаем многобайтный символ: flush() обязан вернуть остаток байтами
    const chunk = bytes.slice(0, bytes.length - 1);

    const out = await collect(dec.framesManual, responseOfChunks([chunk], 'text/event-stream'));
    expect(out).toHaveLength(1);
    expect(out[0].data).toContain('Приве');
  });

  test('fallback-декодер: flush() без pending (поток оборвался на границе символа)', async () => {
    const enc = new TextEncoder();
    const bytes = enc.encode('data: {"t":"ok"}\n\n');
    const out = await collect(dec.framesManual, responseOfChunks([bytes], 'text/event-stream'));
    expect(out).toHaveLength(1);
    expect(out[0].data).toBe('{"t":"ok"}');
  });

  test('asBytes: ArrayBuffer конвертируется в Uint8Array', async () => {
    const enc = new TextEncoder();
    const encoded = enc.encode('data: {"a":1}\n\n');
    // Передаём как ArrayBuffer (не Uint8Array)
    const ab = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);

    const out = await collect(dec.framesManual, responseOfChunks([ab], 'text/event-stream'));
    expect(out).toHaveLength(1);
    expect(out[0].data).toBe('{"a":1}');
  });

  test('asBytes: не-байты (объект без length/byteLength) → String(v) без падения', async () => {
    const notBytes = { toString: function () { return 'data: {"s":1}\n\n'; } };
    const out = await collect(dec.framesManual, responseOfChunks([notBytes], 'text/event-stream'));
    expect(out).toHaveLength(1);
    expect(out[0].data).toBe('{"s":1}');
  });

  test('fallback-декодер: не-SSE ветка (склейка {...}{...} и JSON-массив)', async () => {
    const enc = new TextEncoder();
    const glued = await collect(dec.framesManual,
      responseOfChunks([enc.encode('{"a":1}'), enc.encode('{"b":2}')], 'application/json'));
    expect(glued.map(function (f) { return f.data; })).toEqual(['{"a":1}', '{"b":2}']);

    const arr = await collect(dec.framesManual,
      responseOfChunks([enc.encode('[{"c":3},{"d":4}]')], 'application/json'));
    expect(arr.map(function (f) { return f.data; })).toEqual(['{"c":3}', '{"d":4}']);
  });

  test('fallback-декодер: пустое тело → ни одного кадра', async () => {
    const out = await collect(dec.framesManual, responseOfChunks([new Uint8Array(0)], 'text/event-stream'));
    expect(out).toEqual([]);
  });

  test('паритет нативной и фолбэк-веток декодера на кириллице', async () => {
    const enc = new TextEncoder();
    const body = 'data: {"text":"Привет, мир"}\n\ndata: {"text":"ещё"}\n\n';
    const native = await collect(frames, responseOf(body, 'text/event-stream'));
    const fallback = await collect(dec.framesManual, responseOfChunks([enc.encode(body)], 'text/event-stream'));
    expect(fallback).toEqual(native);
  });
});

describe('O-35: framesManual — защитные ветки читателя и очереди', () => {
  test('res без body.getReader → ни одного кадра, мгновенный done', async () => {
    const out = await collect(framesManual, { headers: { get: function () { return 'text/event-stream'; } } });
    expect(out).toEqual([]);
  });

  test('res = null → ни одного кадра (нет читателя, нет заголовков)', async () => {
    const out = await collect(framesManual, null);
    expect(out).toEqual([]);
  });

  test('headers.get бросает → content-type считается пустым, не-SSE фолбэк работает', async () => {
    const enc = new TextEncoder();
    const res = {
      headers: { get: function () { throw new Error('нет доступа к заголовкам'); } },
      body: {
        getReader: function () {
          let done = false;
          return {
            read: function () {
              if (done) return Promise.resolve({ done: true });
              done = true;
              return Promise.resolve({ done: false, value: enc.encode('{"a":1}') });
            }
          };
        }
      }
    };
    const out = await collect(framesManual, res);
    expect(out.map(function (f) { return f.data; })).toEqual(['{"a":1}']);
  });

  test('read(): Promise.reject → ошибка чтения доезжает до потребителя (ветка failure)', async () => {
    const res = {
      headers: { get: function () { return 'text/event-stream'; } },
      body: {
        getReader: function () {
          return { read: function () { return Promise.reject(new Error('обрыв потока')); } };
        }
      }
    };
    await expect(collect(framesManual, res)).rejects.toThrow('обрыв потока');
  });

  test('не-SSE: невалидный JSON-массив целиком → кадров нет (JSON.parse в catch)', async () => {
    const enc = new TextEncoder();
    const out = await collect(framesManual,
      responseOfChunks([enc.encode('[{"a":1}')], 'application/json'));
    expect(out).toEqual([]);
  });

  test('не-SSE: пустое тело после trim → кадров нет', async () => {
    const enc = new TextEncoder();
    const out = await collect(framesManual, responseOfChunks([enc.encode('   \n  ')], 'application/json'));
    expect(out).toEqual([]);
  });

  test('SSE: не-data строки (мусор) игнорируются, хвост без \\n отдаётся последним кадром', async () => {
    const enc = new TextEncoder();
    const body = 'event: message\ndata: {"a":1}\n\n: ping\nмусорная строка\ndata: tail';
    const out = await collect(framesManual, responseOfChunks([enc.encode(body)], 'text/event-stream'));
    expect(out).toEqual([
      { event: 'message', data: '{"a":1}' },
      { event: null, data: 'tail' }
    ]);
  });
});
