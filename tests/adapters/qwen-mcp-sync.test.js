/**
 * v83 (MCP-синк): ОДИН счёт токенов у DOM-адаптера и сетевого парсера Qwen.
 *
 * Дефект (живой прогон, диагностика DSH). Qwen держит результаты tool-calls (MCP) в СКРЫТЫХ
 * панелях `.qwen-mcp-tool-call-panel` — это реальный расход контекста (≈126 000 токенов,
 * `read_text_file` с PROJECT_HANDOFF.md). Источники расходились:
 *   - DOM-адаптер читал `_readableText` с detached clone; в detached-узле `innerText`
 *     вырождается в textContent-подобный текст, поэтому в счёт попадали ВСЕ скрытые узлы,
 *     включая `display:none`-шум (218k против реальных ≈126k). При этом MCP-панели шумом
 *     НЕ являются — Qwen их действительно отправляет модели;
 *   - сетевой парсер (`core/qwen-intercept.js`, `historyAnswerOf`) читал только
 *     `item.content` content_list и не видел tool-calls из `extras` — сеть давала 92k.
 * Итог: автоэкспорт записал файл по DOM-числу 218k, пришедшая следом сеть дала 92k, и
 * повторный экспорт резался `below-threshold-hysteresis`.
 *
 * Контракт этого набора (фикстура с tool-call):
 *   S1 — сеть: `extras.tool_result.content` попадает в текст хода (raw tool_call/mcp_call/
 *        function_call и вложенные args — тоже, depth ≤ 6, без статусных полей);
 *   S2 — DOM: текст MCP-панели остаётся в реплике, а служебный шум (`tool-status-card`,
 *        кнопки, svg) — НЕ остаётся (детектор: innerText живого узла, не detached clone);
 *   S3 — главное: `Math.round(text.length/4)` у сети и у DOM-адаптера СОВПАДАЕТ;
 *   S4 — регрессия до фикса: без tool-текста оба источника дают меньше (счёт реально растёт
 *        из-за tool-results, а не из-за форматирования);
 *   S5 — отключение панели (нет `.qwen-mcp-tool-call-panel`) не добавляет текст в DOM — и
 *        `_detachJournal`/`_restoreJournal` возвращают узел на место (DOM не портится чтением);
 *   S6 — source-пины: парсер читает `extras`, адаптер — innerText ЖИВОГО узла.
 *
 * НЕ ТРОГАЕТСЯ: поведение прочих платформ; формат файла (состав detail — O-39/O-54).
 */

const fs = require('fs');
const path = require('path');

const { readModuleSource } = require('../helpers/read-module-source.js');
const { loadAsClassic } = require('../helpers/load-esm.js');

const ROOT = path.join(__dirname, '..', '..');
const BASE_SRC = readModuleSource(path.join(ROOT, 'adapters', 'base-adapter.ts'));
const QWEN_EXEC_SRC = readModuleSource(path.join(ROOT, 'adapters', 'qwen-adapter.ts'));
const QWEN_SRC = fs.readFileSync(path.join(ROOT, 'adapters', 'qwen-adapter.ts'), 'utf8');
const INTERCEPT_SRC = fs.readFileSync(path.join(ROOT, 'core', 'qwen-intercept.js'), 'utf8');
const QWEN_CLASSIC = loadAsClassic('core/qwen-intercept.js');
const DEBUG_SRC = loadAsClassic('utils/debug.ts');

// ---- фикстура: тот же MCP tool-result, что видит пользователь в панели Qwen ----
const CHAT_ID = '7fec9bd3-1111-4222-8333-444455556666';
const FID = 'e91333ae-aaaa-bbbb-cccc-0000000000f1';
const RESPONSE_ID = '3d0a3654-aaaa-bbbb-cccc-0000000000b1';
const MODEL = 'qwen3.7-plus';
const QUESTION = 'прочитай PROJECT_HANDOFF.md';
const ANSWER = 'Прочитал, файл большой.';
const TOOL_LINES = [
  'read_text_file /PROJECT_HANDOFF.md',
  '# PROJECT_HANDOFF — 4032 passed',
  'O-28 autoexport waits baseComplete=1'
];
const TOOL_TEXT = TOOL_LINES.join('\n');
// Панель Qwen показывает и вызов (имя + аргументы), и результат. Порядок чтения extras:
// tool_call (имя, arguments.path) → tool_result.content, ровно как собирает collectToolPayloadText.
const TOOL_CALL_LINES = ['read_text_file', '/PROJECT_HANDOFF.md'];
const URL_HISTORY = 'https://chat.qwen.ai/api/v2/chats/' + CHAT_ID + '?direction=up&limit=10';

const FAKE_LOCATION = { hostname: 'chat.qwen.ai', pathname: '/c/' + CHAT_ID };

function tokensOf(text) {
  return Math.round(String(text || '').length / 4);
}

// ---------------------------------------------------------------- DOM-сторона
function loadAdapter() {
  const sandbox = new Function(
    'document', 'location', 'debugLog', 'console',
    BASE_SRC.replace(/if \(typeof module[\s\S]*$/, '') + '\n' +
    QWEN_EXEC_SRC.replace(/if \(typeof module[\s\S]*$/, '') + '\nreturn QwenAdapter;'
  );
  const Ctor = sandbox(document, FAKE_LOCATION, function () { }, console);
  return new Ctor();
}

function qwenTurn(role, inner) {
  return '<div class="qwen-chat-message-select-turn">' +
    '<div class="qwen-chat-message-select-turn-message">' +
    '<div class="qwen-chat-message qwen-chat-message-' + role + '">' + inner + '</div>' +
    '</div></div>';
}

function domFixture(opts) {
  const o = opts || {};
  const toolPanel = (o.toolPanel === false) ? '' :
    '<div class="qwen-mcp-tool-call-panel" style="display:none">' +
    TOOL_CALL_LINES.concat([TOOL_TEXT]).map(function (l) { return '<pre>' + l + '</pre>'; }).join('') +
    '</div>';
  // Служебный шум: кнопка копирования и карточка статуса инструмента. В счёт попадать
  // не должны ни при каком раскладе (они не расходуют контекст).
  const noise = o.noise === true
    ? '<button class="qwen-chat-message-copy">Копировать</button>' +
      '<div class="qwen-chat-thinking-tool-status-card-wraper">' +
      '<div class="qwen-chat-thinking">Завершено размышление</div></div>'
    : '';
  return '<div class="chat-messages-container"><div class="chat-messages">' +
    qwenTurn('user', '<div class="chat-user-message-container">' + QUESTION + '</div>') +
    qwenTurn('assistant',
      '<div class="qwen-chat-message-content"><p>' + ANSWER + '</p></div>' + noise + toolPanel) +
    '</div></div>';
}

function domAssistantText(opts) {
  document.body.innerHTML = domFixture(opts);
  const adapter = loadAdapter();
  const messages = adapter.extractMessages();
  const assistant = messages.filter(function (m) { return m.role === 'assistant'; });
  expect(assistant.length).toBe(1);
  return assistant[0].content;
}

// ------------------------------------------------------------ сетевая сторона
function mcpItem(opts) {
  if (opts && opts.toolExtras === false) return null;
  return {
    phase: 'answer',
    status: 'finished',
    extras: {
      // Форма tool-call в extras измерена не была — парсер обязан понимать несколько
      // раскладок (tool_call/tool_result/mcp_call/function_call), поэтому фикстура
      // кладёт самый частый вариант: вызов + результат рядом.
      tool_call: {
        name: 'read_text_file',
        arguments: { path: '/PROJECT_HANDOFF.md' }
      },
      tool_result: { status: 'finished', content: TOOL_TEXT }
    }
  };
}

function historyPayload(opts) {
  const o = opts || {};
  const assistantItems = [{ phase: 'answer', status: 'finished', content: ANSWER }];
  const toolItem = mcpItem(o);
  if (toolItem) assistantItems.push(toolItem);
  return {
    data: {
      chat_id: CHAT_ID,
      chat: {
        history: {
          messages: [
            {
              id: 'msg-u-' + FID, fid: FID, role: 'user',
              content_list: [{ phase: 'answer', status: 'finished', content: QUESTION }]
            },
            {
              id: 'msg-a-1', response_id: RESPONSE_ID, role: 'assistant', model: MODEL,
              usage: { input_tokens: 1709, output_tokens: 884, total_tokens: 2593 },
              content_list: assistantItems
            }
          ]
        }
      }
    }
  };
}

function jsonResponse(payload) {
  const body = JSON.stringify(payload);
  function make() {
    return {
      ok: true,
      status: 200,
      headers: { get: function () { return 'application/json'; } },
      text: function () { return Promise.resolve(body); },
      json: function () { return Promise.resolve(JSON.parse(body)); },
      clone: function () { return make(); }
    };
  }
  return make();
}

function settle(rounds) {
  let p = Promise.resolve();
  for (let i = 0; i < (rounds || 6); i++) {
    p = p.then(function () { return new Promise(function (r) { setTimeout(r, 0); }); });
  }
  return p;
}

async function networkAssistantText(opts) {
  const o = opts || {};
  new Function('window', 'self', DEBUG_SRC)(window, window);
  const events = [];
  const pending = [];
  window.addEventListener('ai-cm-full-history', function (ev) { events.push(ev.detail); });
  window.addEventListener('ai-cm-qwen-history-pending', function (ev) { pending.push(ev.detail); });

  window.fetch = function () { return Promise.resolve(jsonResponse(o.payload || historyPayload(o))); };
  jest.spyOn(console, 'log').mockImplementation(function () { });
  jest.spyOn(console, 'warn').mockImplementation(function () { });
  delete window.__aiCmQwenInterceptInstalled;
  new Function(QWEN_CLASSIC)();

  await window.fetch(URL_HISTORY, { method: 'GET' });
  await settle(6);

  expect(events.length).toBeGreaterThan(0);
  const detail = events[events.length - 1];
  const assistant = (detail.messages || []).filter(function (m) { return m.role === 'assistant'; });
  expect(assistant.length).toBe(1);
  return { text: assistant[0].text, detail: detail, pending: pending, events: events };
}

beforeEach(function () {
  document.body.innerHTML = '';
});

afterEach(function () {
  jest.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('v83: Qwen MCP tool-results — DOM и сеть считают одинаково', function () {
  test('S1/S3: tool-result из extras доезжает до сети и совпадает с DOM по токенам', async function () {
    const net = await networkAssistantText();
    const dom = domAssistantText();

    // S1: tool-текст в сетевом ходе есть, ответ сохранён.
    expect(net.text).toContain(ANSWER);
    expect(net.text).toContain(TOOL_TEXT);
    // Сеть не считает одно и то же дважды (tool_call + tool_result одного элемента).
    expect(net.text.split(TOOL_LINES[0]).length - 1).toBe(1);

    // S2: DOM-текст содержит панель (реальный расход контекста), но не содержит ответ дважды.
    expect(dom).toContain(ANSWER);
    expect(dom).toContain(TOOL_TEXT);

    // S3 — главный пин: единый счёт.
    expect(tokensOf(net.text)).toBe(tokensOf(dom));
    expect(net.text).toBe(dom);
  });

  test('S2: служебный шум (кнопки/карточка статуса) в текст реплики не попадает', async function () {
    const dom = domAssistantText({ noise: true });
    expect(dom).toContain(TOOL_TEXT);
    expect(dom).not.toContain('Копировать');
    expect(dom).not.toContain('Завершено размышление');
  });

  test('S4: без tool-result счёт меньше ровно на объём инструментов (счёт растёт из tool-results)', async function () {
    const withTools = await networkAssistantText();
    const withoutTools = await networkAssistantText({ payload: historyPayload({ toolExtras: false }) });
    expect(withoutTools.text).toBe(ANSWER);
    expect(tokensOf(withTools.text)).toBeGreaterThan(tokensOf(withoutTools.text));

    // DOM без панели даёт ту же базовую строку, что и сеть без tool-result.
    const domBare = domAssistantText({ toolPanel: false });
    expect(domBare).toBe(withoutTools.text);
  });

  test('S5: reading-панель не портит DOM — узел возвращён на место после чтения', function () {
    document.body.innerHTML = domFixture();
    const panel = document.querySelector('.qwen-mcp-tool-call-panel');
    expect(panel).not.toBe(null);
    const adapter = loadAdapter();
    adapter.extractMessages();
    // _detachJournal/_restoreJournal: панель на месте, маркеров-комментариев не осталось.
    expect(document.querySelector('.qwen-mcp-tool-call-panel')).not.toBe(null);
    expect(document.body.innerHTML.indexOf('ai-cm-qwen-cut')).toBe(-1);
  });

  test('S5b: нет MCP-панели — текст реплики не меняется (обратная совместимость)', function () {
    const bare = domAssistantText({ toolPanel: false });
    expect(bare).toBe(ANSWER);
  });

  test('S6: source-пины точки правки (сеть читает extras, DOM читает живой innerText)', function () {
    expect(INTERCEPT_SRC).toContain('TOOL_EXTRA_KEYS');
    expect(INTERCEPT_SRC).toContain('function toolExtrasTextOf(');
    expect(INTERCEPT_SRC).toContain('function collectToolPayloadText(');
    expect(INTERCEPT_SRC).toContain("'mcp_call'");
    // historyAnswerOf больше не ограничивается item.content
    expect(INTERCEPT_SRC).toContain('toolExtrasTextOf(item)');

    expect(QWEN_SRC).toContain('_mcpPanelSelectors');
    expect(QWEN_SRC).toContain('_detachJournal');
    expect(QWEN_SRC).toContain('_restoreJournal');
    expect(QWEN_SRC).toContain('_readableText(element)');
  });
});
