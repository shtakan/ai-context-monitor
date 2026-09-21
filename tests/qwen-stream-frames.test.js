/**
 * O-35: utils/stream-frames.js — UMD-порт КАРКАСА stream-analyzer.js
 * (frames / normUsage / mergeUsage). Источник: экспорт чата
 * ai-context-monitor-deepseek-DeepSeek-R1-2026-09-18-17-53.txt («stream-analyzer.js»).
 *
 * Пины:
 *   1) НЕТ ESM-синтаксиса и нет литерала async-generator внутри исходника — файл обязан
 *      грузиться как КЛАССИЧЕСКИЙ скрипт MV3 (это и был блокер O-35); нативный
 *      async-generator допустим только как рантайм-конструкция, и рядом есть ES5-ветка;
 *   2) frames(): SSE-кадры ({event,data}, ':'-комментарии, пустая строка как граница
 *      события, хвост без \n, CRLF), не-SSE фолбэк (склейка {...}{...} и JSON-массив);
 *   3) normUsage(): имена полей Qwen/OpenAI/Anthropic/Gemini → единая форма;
 *   4) mergeUsage(): cumulative=true — ПЕРЕЗАПИСЬ (Qwen: 63→174→337→553→884 даёт 884,
 *      а не 2011), cumulative=false — сумма; null не затирает собранное;
 *   5) паритет нативной и ручной веток frames() на одних и тех же телах;
 *   6) именованная обёртка по образцу utils/intercept-common.js (window/self/module.exports).
 */
const fs = require('fs');
const path = require('path');
const { TextEncoder } = require('util');   // jsdom-окружение не даёт TextEncoder глобально

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'utils', 'stream-frames.js'), 'utf8');
const SF = require('../utils/stream-frames.js');
const { frames, normUsage, mergeUsage } = SF;

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

describe('O-35: stream-frames.js — совместимость (нет ESM, UMD-обёртка)', () => {
  test('в исходнике нет ESM-синтаксиса (export / import) и нет ЛИТЕРАЛА async-генератора', () => {
    // Литерал = строка КОДА вида: async function* name(   (в строковой константе генератора
    // он выглядит иначе — там после 'async function* ' идёт '__GENERATOR__' в кавычках).
    const codeLines = SRC.split(/\r?\n/).filter(function (l) {
      const t = l.trim();
      return t.indexOf('//') !== 0 && t.indexOf('*') !== 0 && t.indexOf('/*') !== 0;
    });
    const code = codeLines.join('\n');
    expect(code).not.toMatch(/\bexport\s+(default|const|function|\{)/);
    expect(code).not.toMatch(/^\s*import\s/m);
    // ни одна СТРОКА КОДА не начинается с литерала async-генератора
    codeLines.forEach(function (l) {
      const t = l.trim();
      const isCodeLiteral = /^async\s+function\s*\*/.test(t) && t.indexOf("'") !== 0 && t.indexOf('"') !== 0;
      expect([l, isCodeLiteral]).toEqual([l, false]);
    });
  });

  test('нативный async-generator создаётся рантайм-конструктором, есть ES5-ветка', () => {
    expect(SRC).toContain('new Function');
    expect(SRC).toContain('async function* __GENERATOR__');   // как СТРОКА генератора, не литерал кода
    expect(typeof SF._framesManual).toBe('function');          // ручной pull-итератор на месте
  });

  test('UMD-обёртка: module.exports + window/self-имена (образец intercept-common.js)', () => {
    expect(typeof SF.frames).toBe('function');
    expect(typeof normUsage).toBe('function');
    expect(typeof mergeUsage).toBe('function');
    expect(SRC).toContain('window.aiCmStreamFrames = api;');
    expect(SRC).toContain('self.aiCmStreamFrames = api;');
    expect(SRC).toContain('module.exports = api;');
  });

  test('порядок аргументов mergeUsage(prev, next, cumulative) сохранён', () => {
    expect(mergeUsage.length).toBe(3);
    expect(normUsage.length).toBe(1);
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
      const manual = await collect(SF._framesManual, responseOf(body, ct));
      expect([body, manual]).toEqual([body, native]);
    }  });

  test('резак склейки публичен и учитывает строки/экранирование', () => {
    expect(SF._splitJsonObjects('{"a":"}{"}{"b":1}')).toEqual(['{"a":"}{"}', '{"b":1}']);
  });
});

describe('O-35: normUsage() — нормализация usage провайдеров', () => {
  test('Qwen: input/output/total + reasoning внутри output + cached', () => {
    expect(normUsage({
      input_tokens: 1709,
      output_tokens: 884,
      total_tokens: 2593,
      output_tokens_details: { reasoning_tokens: 884 },
      prompt_tokens_details: { cached_tokens: 0 }
    })).toEqual({ input: 1709, output: 884, total: 2593, reasoning: 884, cached: 0 });
  });

  test('OpenAI-совместимые: prompt/completion + completion_tokens_details', () => {
    expect(normUsage({
      prompt_tokens: 10, completion_tokens: 20, total_tokens: 30,
      completion_tokens_details: { reasoning_tokens: 7 },
      prompt_tokens_details: { cached_tokens: 3 }
    })).toEqual({ input: 10, output: 20, total: 30, reasoning: 7, cached: 3 });
  });

  test('Anthropic/Gemini имена: cache_read_input_tokens, thoughtsTokenCount, *TokenCount', () => {
    expect(normUsage({ input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 2 }))
      .toEqual({ input: 5, output: 6, total: null, reasoning: null, cached: 2 });
    expect(normUsage({ promptTokenCount: 11, candidatesTokenCount: 12, totalTokenCount: 23, thoughtsTokenCount: 4, cachedContentTokenCount: 1 }))
      .toEqual({ input: 11, output: 12, total: 23, reasoning: 4, cached: 1 });
  });

  test('не-объект/пусто → null (не выдумываем нули)', () => {
    expect(normUsage(null)).toBeNull();
    expect(normUsage(undefined)).toBeNull();
    expect(normUsage('x')).toBeNull();
  });

  test('0 — валидное число (cached 0 не превращается в null)', () => {
    expect(normUsage({ input_tokens: 0, output_tokens: 0 }).input).toBe(0);
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
