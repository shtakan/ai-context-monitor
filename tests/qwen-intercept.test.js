/**
 * O-35: core/qwen-intercept.js — MAIN-world перехватчик chat.qwen.ai.
 *
 * Стенд: РЕАЛЬНЫЙ файл перехватчика в jsdom + реальный utils/stream-frames.js;
 * «сервер» — подменённый window.fetch, отдающий SSE-фикстуру спеки провайдера
 * (экспорт чата ai-context-monitor-deepseek-DeepSeek-R1-2026-09-18-17-53.txt).
 *
 * Пины D1–D8 (нумерация отчёта инспекции §5.2):
 *   D1 responseId из response.created (→ parentId следующего хода);
 *   D2 phase='thinking_summary' → extra.summary_thought.content[] семантикой REPLACE
 *      (массив КУМУЛЯТИВНЫЙ: 1→2→3→4→5 элементов; append размножил бы текст);
 *   D3 phase='answer' → delta.content семантикой APPEND;
 *   D4 usage — ПЕРЕЗАПИСЬ последним чанком (кумулятив) + АНТИПОД-ПИН: 63+174+337+553+884 ≠ 884;
 *   D5 маппинг полей в detail (serverTokens/reasoningText/qwenUsage/chatId/responseId),
 *      [REASONING]/[ANSWER] в тексте хода;
 *   D6 конец стрима идемпотентен (повторный endStream/повторный emit не дублирует);
 *   D7 приоритет матчера qwen > openai (чужой /chat/completions не берётся);
 *   D8 расхождения deepseekWeb (схема {p,o,v}) зафиксированы: Qwen-кадры по ней НЕ парсятся.
 *
 * Плюс: фолбэк «полный текст после стрима» (clone() сломан → тело страницы не трогаем),
 * G1 (диагностика только под гейтом aiCmDebug) и G2 (байты выхода при гейте вкл/выкл идентичны).
 */

const fs = require('fs');
const path = require('path');
const { TextEncoder } = require('util');

const ROOT = path.join(__dirname, '..');
const INTERCEPT_SRC = fs.readFileSync(path.join(ROOT, 'core', 'qwen-intercept.js'), 'utf8');
const STREAM_FRAMES_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'stream-frames.js'), 'utf8');
const DEBUG_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'debug.js'), 'utf8');

const CHAT_ID = 'cda86f26-0155-4243-a134-777d909a936b';
const RESPONSE_ID = '3d0a3654-aaaa-bbbb-cccc-000000000001';
const PARENT_ID = 'b64b341e-1111-2222-3333-444444444444';
const FID = 'e91333ae-5555-6666-7777-888888888888';
const PROMPT = 'привет';
const MODEL = 'qwen3.8-max';
const URL_QWEN = 'https://chat.qwen.ai/api/v2/chat/completions?chat_id=' + CHAT_ID;

// Эталон usage тестового «привет» из файла экспорта: input 1709 / output 884 / total 2593,
// где output_tokens ВКЛЮЧАЕТ reasoning_tokens (884).
const USAGE_REF = {
  input_tokens: 1709, output_tokens: 884, total_tokens: 2593,
  output_tokens_details: { reasoning_tokens: 884 },
  prompt_tokens_details: { cached_tokens: 0 }
};
// Кумулятивная лестница output_tokens живого стрима (63 → 174 → 337 → 553 → 884).
const CUMULATIVE = [63, 174, 337, 553, 884];
// Кумулятивный массив размышлений: 1 → 2 → 3 → 4 → 5 элементов (всего 5 «мыслей»).
const THOUGHTS = [
  'Пользователь здоровается.',
  'Нужно ответить коротко.',
  'Достаточно одного приветствия.',
  'Можно добавить, что я готов помочь.',
  'Формат ответа — обычный текст.'
];
const ANSWER_PARTS = ['Привет', '!', ' Чем могу помочь', '?'];
const ANSWER_TEXT = ANSWER_PARTS.join('');
const REASONING_TEXT = THOUGHTS.join('');

function usageFrame(n) {
  return {
    input_tokens: 1709, output_tokens: CUMULATIVE[n], total_tokens: 1709 + CUMULATIVE[n],
    output_tokens_details: { reasoning_tokens: CUMULATIVE[n] },
    prompt_tokens_details: { cached_tokens: 0 }
  };
}

// Кадры ровно в форме спеки: response.created, thinking_summary (кумулятивный массив), answer.
function qwenFrames() {
  const frames = [{ 'response.created': { chat_id: CHAT_ID, parent_id: PARENT_ID, response_id: RESPONSE_ID, response_index: '0' } }];
  for (let n = 0; n < CUMULATIVE.length; n++) {
    frames.push({
      choices: [{
        delta: {
          role: 'assistant', content: '', phase: 'thinking_summary',
          extra: { summary_title: { content: ['Размышление'] }, summary_thought: { content: THOUGHTS.slice(0, n + 1) } },
          status: 'typing'
        }
      }],
      response_id: RESPONSE_ID,
      usage: usageFrame(n),
      timestamp: 1789638270 + n
    });
  }
  for (let i = 0; i < ANSWER_PARTS.length; i++) {
    frames.push({
      choices: [{ delta: { role: 'assistant', content: ANSWER_PARTS[i], phase: 'answer', status: 'typing' } }],
      response_id: RESPONSE_ID,
      usage: usageFrame(CUMULATIVE.length - 1),
      timestamp: 1789638280 + i
    });
  }
  return frames;
}

function sseBody(frames, includeDone) {
  const parts = frames.map(function (f) { return 'data: ' + JSON.stringify(f) + '\n\n'; });
  if (includeDone !== false) parts.push('data: [DONE]\n\n');
  return parts.join('');
}

// ---------- стенд ----------
function makeResponse(body, opts) {
  const o = opts || {};
  const enc = new TextEncoder();
  const size = o.chunk || 11;                      // дробим тело — проверяем сборку буфера
  const chunks = [];
  for (let i = 0; i < body.length; i += size) chunks.push(enc.encode(body.slice(i, i + size)));
  return {
    ok: o.ok !== false,
    status: o.status || 200,
    // Реальный ответ страницы всегда несёт content-type: именно по нему frames() выбирает
    // SSE-ветку (без заголовка тело ушло бы в не-SSE фолбэк одним куском).
    headers: { get: function (name) { return name === 'content-type' ? 'text/event-stream' : null; } },
    body: {
      getReader: function () {
        let i = 0;
        return {
          read: function () {
            return Promise.resolve(i < chunks.length ? { done: false, value: chunks[i++] } : { done: true });
          }
        };
      }
    },
    clone: function () {
      if (o.cloneThrows) throw new TypeError('clone failed (stream locked)');
      return makeResponse(body, { chunk: size, ok: true, status: 200 });
    }
  };
}

// Прокрутка асинхронного разбора потока: тело дробится на сотни мелких чанков, каждый —
// отдельный шаг микротасок, поэтому ждём РЕАЛЬНЫЕ макротаски (setTimeout 0), а не цепочку
// из N промис-резолюций (её может не хватить на всё тело).
function settle(rounds) {
  let p = Promise.resolve();
  for (let i = 0; i < (rounds || 5); i++) {
    p = p.then(function () {
      return new Promise(function (r) { setTimeout(r, 0); });
    });
  }
  return p;
}

function installStand(opts) {
  const o = opts || {};
  // Реальные utils в окно стенда (MAIN-мир страницы).
  new Function('window', 'self', DEBUG_SRC)(window, window);
  new Function('window', 'self', STREAM_FRAMES_SRC)(window, window);

  const events = [];
  const calls = [];
  window.addEventListener('ai-cm-full-history', function (ev) { events.push(ev.detail); });

  window.fetch = function (input, init) {
    calls.push({
      url: String(typeof input === 'string' ? input : (input && input.url) || ''),
      method: String((init && init.method) || 'GET').toUpperCase(),
      body: (init && typeof init.body === 'string') ? init.body : ''
    });
    return Promise.resolve(makeResponse(sseBody(qwenFrames()), o));
  };

  jest.spyOn(console, 'log').mockImplementation(function () { });
  jest.spyOn(console, 'warn').mockImplementation(function () { });

  // Свежий перехватчик на каждый стенд: снимаем latч установки (в браузере он ставится один раз).
  delete window.__aiCmQwenInterceptInstalled;
  new Function(INTERCEPT_SRC)();
  return { events: events, calls: calls };
}

// Отправка «как страница»: ход в текущий чат (тело — ровно схема спеки Qwen).
function emitRequest() {
  const body = JSON.stringify({
    stream: true, version: '2.1', incremental_output: true,
    chatId: CHAT_ID, chat_id: CHAT_ID, parentId: '', parent_id: null,
    chat_mode: 'normal', model: MODEL,
    messages: [{
      id: null, fid: FID, parentId: null, childrenIds: [], role: 'user', content: PROMPT,
      user_action: 'chat', files: [], timestamp: 1789638251, models: [MODEL], model: '',
      chat_type: 't2t', sub_chat_type: 't2t', parent_id: null
    }],
    timestamp: 1789638252
  });
  return window.fetch(URL_QWEN, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body });
}

// Прогон одного хода целиком: запрос → ответ → (клонированный) разбор потока.
async function runTurn() {
  const resp = emitRequest();
  await resp;              // страница получила ответ
  await settle(8);         // макротаски разбора потока (тело дробится на сотни чанков)
  return resp;
}

function diagLines() {
  return console.log.mock.calls.map(function (a) { return String(a[0]); })
    .filter(function (s) { return s.indexOf('[AI CM][diag] qwen-') === 0; });
}

beforeAll(function () {
  window.history.replaceState({}, '', '/c/' + CHAT_ID);
});

beforeEach(function () {
  try { sessionStorage.removeItem('aiCmDebug'); } catch (e) { }
});

afterEach(function () {
  jest.restoreAllMocks();
  try { sessionStorage.removeItem('aiCmDebug'); } catch (e) { }
});

describe('O-35 (D7): детект URL Qwen, приоритет над openai-совместимым', function () {
  test('Qwen-эндпоинт опознаётся, чужой /chat/completions — нет', function () {
    installStand({});
    const B = window.__aiCmQwenBridge;
    expect(B.isQwenCompletions('https://chat.qwen.ai/api/v2/chat/completions?chat_id=x', 'POST')).toBe(true);
    expect(B.isQwenCompletions('https://chat.qwen.ai/api/v3/chat/completions', 'POST')).toBe(true);
    expect(B.isQwenCompletions('https://api.openai.com/v1/chat/completions', 'POST')).toBe(false);
    expect(B.isQwenCompletions('https://chat.qwen.ai/api/v2/chat/completions', 'GET')).toBe(false);
    expect(B.chatIdFromUrl(URL_QWEN)).toBe(CHAT_ID);
  });
});

describe('O-35 (D1–D5): разбор живого SSE-стрима Qwen', function () {
  test('D1/D5: responseId, chatId и запрос страницы', async function () {
    const st = installStand({});
    await runTurn();

    expect(st.calls).toHaveLength(1);
    expect(st.calls[0].url).toBe(URL_QWEN);
    expect(st.calls[0].method).toBe('POST');
    expect(st.events).toHaveLength(1);
    const d = st.events[0];
    expect(d.responseId).toBe(RESPONSE_ID);          // D1: id ответа для parentId следующего хода
    expect(d.chatId).toBe(CHAT_ID);
    expect(d.convId).toBe(CHAT_ID);
    expect(d.modelSlug).toBe(MODEL);
  });

  test('D2: thinking_summary — REPLACE кумулятивного массива (не append)', async function () {
    const st = installStand({});
    await runTurn();
    const d = st.events[0];
    expect(d.reasoningTexts[1]).toBe(REASONING_TEXT);
    expect(d.reasoningTexts[1]).toHaveLength(REASONING_TEXT.length);
    // антипод: append-семантика склеила бы префиксы и дала другой текст
    const appended = THOUGHTS.map(function (_, i) { return THOUGHTS.slice(0, i + 1).join(''); }).join('');
    expect(appended).not.toBe(REASONING_TEXT);
    expect(d.reasoningTurns).toBe(1);
  });

  test('D3: answer — APPEND по кускам delta.content', async function () {
    const st = installStand({});
    await runTurn();
    const d = st.events[0];
    expect(d.text).toContain('[ANSWER]\n' + ANSWER_TEXT);
    expect(d.messageTexts[1]).toBe('[REASONING]\n' + REASONING_TEXT + '\n\n[ANSWER]\n' + ANSWER_TEXT);
  });

  test('D4: usage — ПЕРЕЗАПИСЬ последним чанком + антипод-пин суммы', async function () {
    const st = installStand({});
    await runTurn();
    const d = st.events[0];
    expect(d.serverTokens).toBe(1709);                              // из usage.input_tokens
    expect(d.qwenUsage.outputTokens).toBe(884);                     // последний кадр, НЕ 2011
    expect(d.qwenUsage.totalTokens).toBe(2593);
    expect(d.qwenUsage.reasoningTokens).toBe(884);                  // output ВКЛЮЧАЕТ reasoning
    expect(d.qwenUsage.inputTokens).toBe(1709);
    expect(d.qwenUsage.cachedTokens).toBe(0);
    const sum = CUMULATIVE.reduce(function (a, b) { return a + b; }, 0);
    expect(sum).toBe(2011);
    expect(d.qwenUsage.outputTokens).not.toBe(sum);                 // антипод-пин: не суммируем
    expect(d.serverTokens).toBe(USAGE_REF.input_tokens);
    expect(d.qwenUsage.outputTokens).toBe(USAGE_REF.output_tokens);
    expect(d.qwenUsage.reasoningTokens).toBe(USAGE_REF.output_tokens_details.reasoning_tokens);
  });

  test('D5: контракт detail — пары user/assistant, hiddenReasoning, полнота истории', async function () {
    const st = installStand({});
    await runTurn();
    const d = st.events[0];
    expect(d.count).toBe(2);
    expect(d.messages.map(function (m) { return m.role; })).toEqual(['user', 'assistant']);
    expect(d.messages[0].text).toBe(PROMPT);
    expect(d.messages[1].reasoning).toBe(REASONING_TEXT);
    expect(d.messages[1].hiddenReasoning).toBe(REASONING_TEXT);      // сырой режим экспорта
    expect(d.historyComplete).toBe(true);
    expect(d.reachedRoot).toBe(true);
    expect(d.attachTokens).toBe(0);
    expect(d.messageIds).toEqual(['u:' + FID, RESPONSE_ID]);
  });
});

describe('O-35 (D6): конец стрима идемпотентен', function () {
  test('повторная приёмка того же потока не дублирует ход и текст', async function () {
    const st = installStand({});
    await runTurn();
    const first = st.events[0];
    expect(st.events).toHaveLength(1);

    // повторный прогон ТЕХ ЖЕ кадров: та же сигнатура снимка → второй emit не публикуется
    window.__aiCmQwenBridge.applyFrames(qwenFrames());
    expect(st.events).toHaveLength(1);
    expect(st.events[0].text).toBe(first.text);
  });

  test('пустой кадр после [DONE] не меняет снимок', async function () {
    const st = installStand({});
    await runTurn();
    const text = st.events[0].text;
    window.__aiCmQwenBridge.applyFrames([{ choices: [{ delta: { content: '', phase: 'answer' } }] }]);
    expect(st.events).toHaveLength(1);
    expect(st.events[0].text).toBe(text);
  });
});

describe('O-35 (D8): расхождения со схемой deepseekWeb зафиксированы', function () {
  test('кадр {p,o,v} (deepseekWeb) не даёт Qwen ни текста, ни usage', function () {
    const st = installStand({});
    window.__aiCmQwenBridge.applyFrames([
      { p: 'response/fragments/-1/content', o: 'APPEND', v: 'текст-из-чужой-схемы' },
      { p: 'accumulated_token_usage', o: 'SET', v: { total_tokens: 999 } }
    ]);
    expect(st.events).toHaveLength(0);               // пустой поток → emit не публикуется
    expect(window.__aiCmQwenBridge.usage()).toBeNull();
  });
});

describe('O-35: фолбэк «полный текст после стрима» (clone() сломан)', function () {
  test('clone() бросает → тело страницы не читается, emit не публикуется (база пойдёт из DOM)', async function () {
    const st = installStand({ cloneThrows: true });
    const resp = await runTurn();
    expect(resp).toBeTruthy();
    expect(typeof resp.clone).toBe('function');      // ответ отдан странице КАК ЕСТЬ
    expect(st.events).toHaveLength(0);
  });

  test('HTTP-ошибка стрима → разбор не запускается', async function () {
    const st = installStand({ ok: false, status: 500 });
    await runTurn();
    expect(st.events).toHaveLength(0);
  });
});

describe('O-35 (G1/G2): диагностика только под гейтом, байты выхода не зависят от гейта', function () {
  test('G1: гейт выключен → ни одной диагностической строки qwen-', async function () {
    const st = installStand({});
    await runTurn();
    expect(st.events).toHaveLength(1);
    expect(diagLines()).toEqual([]);
  });

  test('G1: гейт включён (sessionStorage aiCmDebug=1) → строки появляются', async function () {
    sessionStorage.setItem('aiCmDebug', '1');
    installStand({});
    await runTurn();
    const lines = diagLines();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).toContain('qwen-response-created');
    expect(lines.join('\n')).toContain('qwen-usage');
    expect(lines.join('\n')).toContain('qwen-stream-end');
  });

  test('G2: байты выхода при гейте вкл/выкл идентичны', async function () {
    const off = installStand({});
    await runTurn();
    const offDetail = JSON.parse(JSON.stringify(off.events[0]));
    jest.restoreAllMocks();

    sessionStorage.setItem('aiCmDebug', '1');
    const on = installStand({});
    await runTurn();
    const onDetail = JSON.parse(JSON.stringify(on.events[0]));

    expect(onDetail).toEqual(offDetail);
    expect(onDetail.text).toBe(offDetail.text);
    expect(onDetail.serverTokens).toBe(offDetail.serverTokens);
  });
});
