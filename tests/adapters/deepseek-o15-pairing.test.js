/** @jest-environment node */
/**
 * O-15: DeepSeek-экспорт — парность ходов live-режима и целостность фрагментов reasoning/answer.
 *
 * Фикстуры — синтезированы по логам живого прогона (те же формы лежат в tools/fixtures/
 * deepseek-o15-* для ручного харнесса tools/_o7-reasoning-verify.js; здесь они встроены,
 * потому что tools/ в .gitignore).
 *
 * Гоняется РЕАЛЬНЫЙ core/deepseek-intercept.js в jsdom (окружение node + явный JSDOM)
 * через подменённый window.fetch (история/SSE → ingest → emitBaseSnapshot →
 * ai-cm-full-history), как в deepseek-order.test.js.
 *
 * Что ловим:
 *  1) чанк {p:"response/fragments",o:"APPEND",v:[{type,content}]} — это ещё и ПЕРВАЯ ПОРЦИЯ
 *     КОНТЕНТА фрагмента: v8 выбрасывал её (потеря 2 символов «Ре»/«Те»/«По», «точка-паразит»
 *     в начале [ANSWER]). Инвариант: live-экспорт == экспорт из истории по составу ходов и БАЙТАМ;
 *  2) ответ, пришедший целиком в таком чанке, не должен терять ход ассистента; последний ход
 *     сессии обязан попадать в live-экспорт даже без event: close / quasi_status FINISHED;
 *  3) узел-assistant только с THINK (пара assi+assi) — не отдельное сообщение: reasoning
 *     становится частью assistant-хода (user + assistant(reasoning+answer));
 *  4) живой DOM-адаптер: роли user/assistant не сбиваются, панель reasoning не сообщение,
 *     «.»-артефакт свёрнутой панели в текст не попадает.
 */

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const INTERCEPT_PATH = path.join(__dirname, '..', '..', 'core', 'deepseek-intercept.js');
const ADAPTER_DIR = path.join(__dirname, '..', '..', 'adapters');
const P = require('../../utils/export-emit-pipeline.js');

// ===================== фикстуры =====================

const HISTORY_FIXTURE = {
  code: 0,
  data: {
    biz_data: {
      chat_session: { current_message_id: 'a4', model_type: 'expert', is_empty: false },
      chat_messages: [
        { message_id: 'u1', parent_id: null, role: 'USER', thinking_enabled: false, accumulated_token_usage: 300, fragments: [{ type: 'REQUEST', content: 'Как выбрать ноутбук?' }] },
        { message_id: 'a1', parent_id: 'u1', role: 'ASSISTANT', thinking_enabled: false, accumulated_token_usage: 1300, fragments: [{ type: 'RESPONSE', content: 'Смотрите на экран и клавиатуру.' }] },
        { message_id: 'u2', parent_id: 'a1', role: 'USER', thinking_enabled: false, accumulated_token_usage: 1900, fragments: [{ type: 'REQUEST', content: 'А для монтажа видео?' }] },
        { message_id: 'a2', parent_id: 'u2', role: 'ASSISTANT', thinking_enabled: false, accumulated_token_usage: 3200, fragments: [{ type: 'RESPONSE', content: 'Тогда важны CPU и быстрый SSD.' }] },
        { message_id: 'u3', parent_id: 'a2', role: 'USER', thinking_enabled: true, accumulated_token_usage: 3900, fragments: [{ type: 'REQUEST', content: 'Сравни три модели и дай итог.' }] },
        {
          message_id: 'a3', parent_id: 'u3', role: 'ASSISTANT', thinking_enabled: true, accumulated_token_usage: 7000,
          fragments: [
            { type: 'THINK', content: 'Пользователь просит сравнить три модели.' },
            { type: 'THINK', content: '\n\nВыполню поиск.' },
            { type: 'THINK', content: 'Результаты поиска показывают три кандидата.' },
            { type: 'THINK', content: '\n\nОткрою несколько ссылок.' },
            { type: 'THINK', content: 'Теперь у меня есть цены.' },
            { type: 'THINK', content: '\n\nВыполню поиск.' },
            { type: 'THINK', content: 'Похоже, лучший вариант — модель B.' },
            { type: 'SEARCH', content: 'ноутбук модель A/B/C' },
            { type: 'RESPONSE', content: 'Итог: берите модель B' },
            { type: 'RESPONSE', content: '. Она дешевле' },
            { type: 'RESPONSE', content: ' и тише.' }
          ]
        },
        { message_id: 'u4', parent_id: 'a3', role: 'USER', thinking_enabled: true, accumulated_token_usage: 7800, fragments: [{ type: 'REQUEST', content: 'А что брать для поездок?' }] },
        {
          message_id: 'a4', parent_id: 'u4', role: 'ASSISTANT', thinking_enabled: true, accumulated_token_usage: 9000,
          fragments: [
            { type: 'THINK', content: 'Пользователь спрашивает про компактную модель.' },
            { type: 'THINK', content: '\n\nПосмотрю вес.' },
            { type: 'RESPONSE', content: 'Для поездок берите модель C.' }
          ]
        }
      ]
    }
  }
};

// Тот же чат, что и в HISTORY_FIXTURE, но разложенный в сырые SSE-чанки (как их шлёт сервер):
// контент новой порции приходит ВМЕСТЕ с объявлением типа фрагмента.
const EXPECTED = [
  { role: 'user', text: 'Как выбрать ноутбук?' },
  { role: 'assistant', text: 'Смотрите на экран и клавиатуру.' },
  { role: 'user', text: 'А для монтажа видео?' },
  { role: 'assistant', text: 'Тогда важны CPU и быстрый SSD.' },
  { role: 'user', text: 'Сравни три модели и дай итог.' },
  {
    role: 'assistant',
    text: '[REASONING]\nПользователь просит сравнить три модели.\n\nВыполню поиск.Результаты поиска показывают три кандидата.\n\nОткрою несколько ссылок.Теперь у меня есть цены.\n\nВыполню поиск.Похоже, лучший вариант — модель B.\n\n[ANSWER]\nИтог: берите модель B. Она дешевле и тише.'
  },
  { role: 'user', text: 'А что брать для поездок?' },
  {
    role: 'assistant',
    text: '[REASONING]\nПользователь спрашивает про компактную модель.\n\nПосмотрю вес.\n\n[ANSWER]\nДля поездок берите модель C.'
  }
];

function line(obj) { return 'data: ' + JSON.stringify(obj); }
function sseReady(reqId, resId, tokens, fragments) {
  return [
    'event: ready',
    line({ request_message_id: reqId, response_message_id: resId, model_type: 'expert' }),
    '',
    'event: message',
    line({ v: { response: { accumulated_token_usage: tokens, model_type: 'expert', fragments: fragments || [] } } }),
    ''
  ];
}
function sseChunk(p, o, v) { return [line({ p: p, o: o, v: v }), '']; }
function sseAbbrev(v) { return [line({ v: v }), '']; }
function sseBatch(tokens, finished) {
  const v = [{ p: 'accumulated_token_usage', v: tokens }];
  if (finished) v.push({ p: 'quasi_status', v: 'FINISHED' });
  return [line({ p: 'response', o: 'BATCH', v: v }), ''];
}
function sseClose() { return ['event: close', 'data: {}', '']; }
function stream(lines) { return lines.join('\n'); }

// Ход 1 и 2: ответ приходит ЦЕЛИКОМ в чанке массива фрагментов (без -1/content) —
// именно этот случай v8 терял вместе с ходом ассистента.
const SSE_TURNS = [
  stream([
    ...sseReady('u1', 'a1', 1300, []),
    ...sseChunk('response/fragments', 'APPEND', [{ type: 'RESPONSE', content: 'Смотрите на экран и клавиатуру.' }]),
    ...sseBatch(1300, true),
    ...sseClose()
  ]),
  stream([
    ...sseReady('u2', 'a2', 3200, []),
    ...sseChunk('response/fragments', 'APPEND', [{ type: 'RESPONSE', content: 'Тогда важны CPU и быстрый SSD.' }]),
    ...sseBatch(3200, true),
    ...sseClose()
  ]),
  stream([
    ...sseReady('u3', 'a3', 7000, [{ type: 'THINK', content: 'Пользователь просит сравнить три модели.' }]),
    ...sseChunk('response/fragments', 'APPEND', [{ type: 'THINK', content: '\n\n' }]),
    ...sseChunk('response/fragments/-1/content', 'APPEND', 'Выполню поиск.'),
    ...sseChunk('response/fragments', 'APPEND', [{ type: 'THINK', content: 'Ре' }]),
    ...sseChunk('response/fragments/-1/content', 'APPEND', 'зультаты поиска показывают три кандидата.'),
    ...sseChunk('response/fragments', 'APPEND', [{ type: 'THINK', content: '\n\nОткрою несколько ссылок.' }]),
    ...sseChunk('response/fragments', 'APPEND', [{ type: 'THINK', content: 'Те' }]),
    ...sseAbbrev('перь у меня есть цены.'),
    ...sseChunk('response/fragments', 'APPEND', [{ type: 'SEARCH', content: 'ноутбук модель A/B/C' }]),
    ...sseChunk('response/fragments', 'APPEND', [{ type: 'THINK', content: '\n\nВыполню поиск.' }]),
    ...sseChunk('response/fragments', 'APPEND', [{ type: 'THINK', content: 'По' }]),
    ...sseChunk('response/fragments/-1/content', 'APPEND', 'хоже, лучший вариант — модель B.'),
    ...sseChunk('response/fragments', 'APPEND', [{ type: 'RESPONSE', content: 'Итог: берите модель B' }]),
    ...sseAbbrev('. Она дешевле'),
    ...sseChunk('response/fragments/-1/content', 'APPEND', ' и тише.'),
    ...sseBatch(7000, true),
    ...sseClose()
  ]),
  // Последний ход: НИ event: close, НИ quasi_status FINISHED — ход закрывает конец тела ответа.
  stream([
    ...sseReady('u4', 'a4', 9000, [{ type: 'THINK', content: 'Пользователь спрашивает про компактную модель.' }]),
    ...sseChunk('response/fragments', 'APPEND', [{ type: 'THINK', content: '\n\nПосмотрю вес.' }]),
    ...sseChunk('response/fragments', 'APPEND', [{ type: 'RESPONSE', content: 'Для поездок берите модель C.' }]),
    ...sseBatch(9000, false)
  ])
];

// Пара assi+assi: reasoning приходит ОТДЕЛЬНЫМ assistant-сообщением (только THINK).
const SPLIT_FIXTURE = {
  code: 0,
  data: {
    biz_data: {
      chat_session: { current_message_id: 'a2', model_type: 'expert', is_empty: false },
      chat_messages: [
        { message_id: 'u1', parent_id: null, role: 'USER', thinking_enabled: true, accumulated_token_usage: 300, fragments: [{ type: 'REQUEST', content: 'Почему небо синее?' }] },
        { message_id: 'a1', parent_id: 'u1', role: 'ASSISTANT', thinking_enabled: true, accumulated_token_usage: 1400, fragments: [{ type: 'THINK', content: 'Сначала вспомню про рассеяние.' }, { type: 'THINK', content: '\n\nПроверю формулу Рэлея.' }] },
        { message_id: 'a2', parent_id: 'a1', role: 'ASSISTANT', thinking_enabled: true, accumulated_token_usage: 2600, fragments: [{ type: 'RESPONSE', content: 'Из-за рэлеевского рассеяния света.' }] }
      ]
    }
  }
};

const DOM_HTML = '<!doctype html><html><body>' +
  '<div class="ds-message fbb737a4"><div class="f9bf7997">Как выбрать ноутбук?</div></div>' +
  '<div class="ds-message"><div class="ds-think-content">DeepThink · 12 с</div>' +
  '<div class="ds-markdown"><p class="ds-markdown-paragraph">Смотрите на экран и клавиатуру.</p></div></div>' +
  '<div class="ds-message fbb737a4"><div class="f9bf7997">А для монтажа видео?</div></div>' +
  '<div class="ds-message ds-think-content">Размышления: проверю цены.</div>' +
  '<div class="ds-message"><div class="ds-think-content">.</div>' +
  '<div class="ds-markdown"><p class="ds-markdown-paragraph">Тогда важны CPU и быстрый SSD.</p></div></div>' +
  '</body></html>';

// ===================== jsdom-харнесс =====================

function fakeResponse(jsonBody, textBody) {
  const cloneObj = {
    json: () => Promise.resolve(jsonBody),
    text: () => Promise.resolve(textBody || '')
  };
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(jsonBody),
    text: () => Promise.resolve(textBody || ''),
    clone: () => cloneObj
  };
}

function flush(times) {
  let p = Promise.resolve();
  for (let i = 0; i < (times || 120); i++) p = p.then(() => {});
  return p;
}

function asMessages(d) {
  return ((d && d.messages) || []).map((m, i) => ({ role: m.role, text: d.messageTexts[i] }));
}

const INTERCEPT_SRC = fs.readFileSync(INTERCEPT_PATH, 'utf8');

// jsdom-стенд: подменённый fetch играет роль сервера (истории и completion-стрима).
function makeStand(convId, historyBody) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://chat.deepseek.com/a/chat/s/' + convId,
    runScripts: 'dangerously',
    virtualConsole: new VirtualConsole()
  });
  const { window } = dom;
  const events = [];
  let completionCall = 0;
  window.fetch = (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || '');
    if (url.indexOf('completion') !== -1) {
      const idx = completionCall++;
      return Promise.resolve(fakeResponse({}, SSE_TURNS[idx] || ''));
    }
    return Promise.resolve(fakeResponse(historyBody || null, ''));
  };
  window.eval(INTERCEPT_SRC);
  window.addEventListener('ai-cm-full-history', (e) => events.push(e.detail));
  return {
    window,
    events,
    lastDetail: () => events[events.length - 1],
    close: () => { try { window.close(); } catch (e) { } }
  };
}

async function runHistory(body) {
  const stand = makeStand('convO15', body);
  await stand.window.fetch('https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=convO15&cache_version=v1');
  await flush(120);
  const d = stand.lastDetail();
  stand.close();
  return d;
}

async function runLive() {
  const stand = makeStand('convO15', null);
  const prompts = EXPECTED.filter((m) => m.role === 'user').map((m) => m.text);
  for (let i = 0; i < SSE_TURNS.length; i++) {
    await stand.window.fetch('https://chat.deepseek.com/api/v0/chat/completion?x=' + i, {
      method: 'POST',
      body: JSON.stringify({ prompt: prompts[i], chat_session_id: 'convO15', thinking_enabled: true, parent_message_id: i ? 'prev' : null })
    });
    await flush(120);
  }
  const d = stand.lastDetail();
  stand.close();
  return d;
}

describe('O-15: DeepSeek live-экспорт — парность ходов и целостность фрагментов', () => {
  test('экспорт из истории: состав ходов и байты текстов — эталон', async () => {
    const d = await runHistory(HISTORY_FIXTURE);
    expect(d).toBeDefined();
    expect(asMessages(d)).toEqual(EXPECTED);
    expect(d.messages.map((m) => m.role)).toEqual(EXPECTED.map((m) => m.role));
  });

  test('live-экспорт из сырых SSE-чанков == экспорт из истории (состав + байты)', async () => {
    const dHist = await runHistory(HISTORY_FIXTURE);
    const dLive = await runLive();
    expect(asMessages(dLive)).toEqual(asMessages(dHist));   // ИНВАРИАНТ live == history
    expect(asMessages(dLive)).toEqual(EXPECTED);
    expect(dLive.count).toBe(EXPECTED.length);
  });

  test('live: все завершённые ходы сессии — включая ответы 1–2 и последний ход', async () => {
    const d = await runLive();
    expect(d.messageTexts).toHaveLength(EXPECTED.length);
    expect(d.messageTexts[1]).toBe('Смотрите на экран и клавиатуру.');
    expect(d.messageTexts[3]).toBe('Тогда важны CPU и быстрый SSD.');
    expect(d.messageTexts[6]).toBe('А что брать для поездок?');
    expect(d.messageTexts[7]).toBe(EXPECTED[7].text);
    // ход = user + assistant, пара не сбита
    expect(d.messages.map((m) => m.role)).toEqual(EXPECTED.map((m) => m.role));
  });

  test('live: нет потери 2 символов на границах фрагментов reasoning', async () => {
    const d = await runLive();
    const turn3 = d.messageTexts[5];
    expect(turn3).toContain('Выполню поиск.Результаты поиска');
    expect(turn3).toContain('ссылок.Теперь у меня есть цены');
    expect(turn3).toContain('поиск.Похоже, лучший вариант');
    // обрезанная голова фрагмента выглядела бы как «.Те» / «…поиск.хоже»:
    expect(turn3).not.toContain('.Те\n');
    expect(turn3).not.toContain('поиск.хоже');
    // тип SEARCH в текст хода не идёт (как и в истории)
    expect(turn3).not.toContain('ноутбук модель A/B/C');
  });

  test('live: [ANSWER] без точки-паразита и без потери начала', async () => {
    const d = await runLive();
    expect(d.messageTexts[5]).toContain('[ANSWER]\nИтог: берите модель B. Она дешевле и тише.');
    for (const t of d.messageTexts) expect(t).not.toMatch(/\[ANSWER\]\n\./);
    // O-7 (OFF): секции [REASONING]…[ANSWER]… — часть БАЗЫ хода (метрики/пороги/бейдж),
    // урезаются они ТОЛЬКО на выходе экспорта — до части [ANSWER].
    expect(d.messageTexts[5]).toContain('[REASONING]');
    expect(P.stripReasoningSections(d.messageTexts[5])).toBe('Итог: берите модель B. Она дешевле и тише.');
  });

  test('пара assi+assi: reasoning — часть assistant-хода, не отдельное сообщение', async () => {
    const d = await runHistory(SPLIT_FIXTURE);
    expect(d.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(d.messageTexts).toEqual([
      'Почему небо синее?',
      '[REASONING]\nСначала вспомню про рассеяние.\n\nПроверю формулу Рэлея.\n\n[ANSWER]\nИз-за рэлеевского рассеяния света.'
    ]);
  });

  test('живой DOM-адаптер: роли не сбиты, reasoning не отдельное сообщение, без «.»', () => {
    const dom = new JSDOM(DOM_HTML, { url: 'https://chat.deepseek.com/a/chat/s/convO15', runScripts: 'dangerously', virtualConsole: new VirtualConsole() });
    const baseSrc = fs.readFileSync(path.join(ADAPTER_DIR, 'base-adapter.js'), 'utf8');
    const adapterSrc = fs.readFileSync(path.join(ADAPTER_DIR, 'deepseek-adapter.js'), 'utf8');
    dom.window.eval('var debugLog = function () {};\n' + baseSrc + '\n' + adapterSrc + '\nwindow.DeepSeekAdapter = DeepSeekAdapter;');
    const adapter = new dom.window.DeepSeekAdapter();
    const msgs = adapter.extractMessages();
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(msgs.map((m) => m.content)).toEqual([
      'Как выбрать ноутбук?',
      'Смотрите на экран и клавиатуру.',
      'А для монтажа видео?',
      'Тогда важны CPU и быстрый SSD.'
    ]);
    expect(msgs.some((m) => m.content === '.')).toBe(false);
    expect(msgs.some((m) => m.content.indexOf('DeepThink') !== -1)).toBe(false);
    expect(msgs.some((m) => m.content.indexOf('Размышления') !== -1)).toBe(false);
  });

  test('source-pin: склейка фрагментов без среза с фиксированным смещением', () => {
    const src = fs.readFileSync(INTERCEPT_PATH, 'utf8');
    // ни одного среза контента с фиксированным смещением в путях склейки фрагментов
    expect(src).not.toMatch(/content\s*\.\s*slice\(\s*\d/);
    expect(src).not.toMatch(/content\s*\.\s*substring\(\s*\d/);
    expect(src).not.toMatch(/\.replace\(\s*\/\^\\n\\n/);
    // префикс обрабатывается ТОЛЬКО проверкой начала строки (indexOf === 0)
    expect(src).toContain('if (cur && val.indexOf(cur) === 0)');
    expect(src).toContain('if (cur.indexOf(val) === 0) return');
    // контент чанков массива фрагментов не выбрасывается, а копится
    expect(src).toContain('streamPushFragment(item.type, item.content)');
    // reasoning-узел без ответа не создаёт отдельный ход
    expect(src).toContain('pendingReasoning');
    // стенд действительно грузит реальный перехватчик
    expect(src).toContain('__aiCmDeepseekInterceptInstalled');
  });
});
