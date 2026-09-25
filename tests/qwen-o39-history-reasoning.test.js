/**
 * O-39 (дефект C, вариант B): REASONING ПУТИ ИСТОРИИ ЧАТА ДОЕЗЖАЕТ ДО ФАЙЛА.
 *
 * Дефект (живые прогоны 14-23 vs 14-25/15-50, чаты bade310b/6ba32f54): на live-стриме секции
 * [REASONING]/[ANSWER] в файле есть (mechanism: qwen-intercept composeTurnText вшивает секции в
 * text на SSE → O-37 section parsing разбирает их на сетевом пути точки сбора), а при SPA-переходе/
 * F5 SSE нет вовсе: ходы собираются DOM-адаптером, reasoning живёт вне message-узла (scope O-41),
 * и в txt/md секции [REASONING] нет (в попапе строка reasoning есть — её источник серверный usage).
 *
 * Корень (измерение Network 2026-09-20 ~17:00, PROJECT_HANDOFF O-39): эндпоинт истории чата
 *   GET /api/v2/chats/{id}?direction=up&limit=10  (application/json)
 * несёт reasoning в payload: content_list[] элемент phase="thinking_summary" (status="finished"),
 * extras.summary_thought.content = массив абзацев summary; там же role="assistant", response_id,
 * usage{input_tokens,output_tokens}. Каждый контрольный фрагмент встречается в теле 2 раза —
 * место второго вхождения не установлено.
 *
 * Фикс (вариант B — ТОЛЬКО перехват истории, scope O-39): core/qwen-intercept.js получает
 *   - фильтр isQwenHistory (GET /api/v<NN>/chats/{id}, служебные сегменты /chats/new исключены);
 *   - JSON-ветку resp.clone().json() (тело страницы не читается вовсе, сбой — тихий фолбэк на DOM);
 *   - парсер parseQwenHistory: content_list → ПЕРВОЕ thinking_summary-вхождение, reasoning =
 *     extras.summary_thought.content.join('\n\n'), response — APPEND не-thinking элементов,
 *     usage{input_tokens,output_tokens} → normUsage, role/response_id узла;
 *   - интеграцию: ходы идут в ТО ЖЕ состояние turns (recordTurn) и публикуются ТЕМ ЖЕ
 *     emitSnapshot → detail.messages[].reasoning + detail.messageTexts[] с секциями
 *     [REASONING]/[ANSWER] через composeTurnText (контракт файла ровно как у live-стрима).
 * Дубль в payload парсер НЕ склеивает: побеждает первое вхождение, факт дубля уходит read-only
 * строкой qwen-history-duplicate под гейтом aiCmDebug (измерение, не поведение).
 *
 * R-D-контур:
 *   D1 — матчер isQwenHistory/historyChatIdFromUrl (и неизменность isQwenCompletions);
 *   D2 — payload → detail: reasoning/hiddenReasoning/messageTexts с секциями/роли/ids;
 *   D3 — payload → ФАЙЛ: реальные aiCmCollectExportSource → aiCmDedupeExportSource →
 *        buildTxtFromHistory/buildMdFromHistory, секция [REASONING] ровно одна;
 *   D4 — usage/response_id истории → qwenUsage/responseId/convId (O-47: serverTokens из снимка
 *        убран — серверное число Qwen в метрику не идёт);
 *   D5 — два хода: оба reasoning в файле, порядок ходов сохранён, usage = последний ход;
 *   D6 — дубли: узел-дубль, дубль thinking_summary, extras+content одного элемента,
 *        «первое вхождение побеждает» + строка qwen-history-duplicate под гейтом;
 *   R1 — reasoning в payload НЕТ → ни секции, ни поля; тексты/файл байтово bare-ответ;
 *   R2 — live-путь SSE (O-35/O-37) не изменён: тот же байтовый выход, одна секция на ход;
 *   R3 — границы: чужая история (other-chat) не пишется, POST /chats/{id} — не история,
 *        /chats/new — не история, isQwenCompletions не тронут;
 *   R4 — гейт: без aiCmDebug ни одной строки; байты выхода при вкл/выкл идентичны;
 *   R5 — соседние наборы O-37/O-38/O-11/O-31 на месте и исполняются npm test;
 *   S  — source-пины проводки (матчер, clone().json(), emitSnapshot-интеграция, гейт дубля).
 *
 * O-39-B (XHR-транспорт, живой прогон 18:09-18:25, чат 7fec9bd3): история страницы уходит
 * НЕ fetch-ом, а XHR (Network Type=xhr, Initiator jquery.min.js:1), поэтому fetch-хук слеп и
 * в файлах нет [REASONING]. Блок X-пинов:
 *   X-D1 — XHR-путь доводит reasoning до ФАЙЛА (стаб транспорта + shadow responseText +
 *          dispatch loadend → реальный collect→dedupe→builders, ровно одна пара секций);
 *   X-D2 — responseType='json': тело из xhr.response, responseText не читается (InvalidStateError);
 *   X-D3 — чужой чат на XHR → skip, база и снимок не меняются;
 *   X-R1 — не-исторические XHR (POST completions, latest?type=memory, /chats/new, /tags)
 *          флаг не ставят, строк qwen-history нет, база прежняя;
 *   X-R2 — битый JSON: XHR страницы завершается штатно, loadend страницы один, снимков 0,
 *          diag qwen-history event=error под гейтом;
 *   X-R3 — onPage-обработчики живы: onreadystatechange и addEventListener в прежнем порядке;
 *   X-R4 — байты выхода при гейте вкл/выкл идентичны, XHR- и fetch-пути дают один и тот же
 *          detail, соседние наборы O-37/O-38/O-11/O-31 в том же прогоне npm test;
 *   X-S1 — source-пины: prototype open/send обёрнуты, слушатель только addEventListener,
 *          ветки responseType, try/catch вокруг тела обработчика, fetch-хук прежний
 *          (кроме поля transport в диагностике).
 *
 * НЕ ТРОГАЕТСЯ: core/export-manager.js, core/base-handler.js, utils/export-text-builders.js
 * (только чтение источника), adapters/qwen-adapter.js (scope O-41), тесты прочих платформ.
 */

const fs = require('fs');
const path = require('path');

const P = require('../utils/export-emit-pipeline.js');
const Builders = require('../utils/export-text-builders.js');

const ROOT = path.join(__dirname, '..');
const INTERCEPT_SRC = fs.readFileSync(path.join(ROOT, 'core', 'qwen-intercept.js'), 'utf8');
const STREAM_FRAMES_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'stream-frames.js'), 'utf8');
const DEBUG_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'debug.js'), 'utf8');
const MGR_SRC = fs.readFileSync(path.join(ROOT, 'core', 'export-manager.js'), 'utf8');
const BASE_HANDLER_SRC = fs.readFileSync(path.join(ROOT, 'core', 'base-handler.js'), 'utf8');

// Рез по балансу фигурных скобок (конвенция сьюта: tests/qwen-o39-reasoning-passthrough.test.js).
function fnDecl(src, name) {
  const start = src.indexOf('function ' + name + '(');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced declaration: ' + name);
}

// ---- живой артефакт O-37/O-39 (chat=4cf29053): reasoning 214 знаков, ответ 277 знаков ----
const CHAT_ID = '4cf29053-7f1e-4c6a-9f2b-0f4a1c2d3e4f';
const OTHER_CHAT_ID = 'bade310b-1111-4222-8333-444455556666';
const RESPONSE_ID = '3d0a3654-aaaa-bbbb-cccc-0000000000a1';
const RESPONSE_ID_2 = '3d0a3654-aaaa-bbbb-cccc-0000000000a2';
const FID = 'e91333ae-5555-6666-7777-8888888888u1';
const FID_2 = 'e91333ae-5555-6666-7777-8888888888u2';
const MODEL = 'qwen3.8-max';

const THOUGHTS = [
  'Пользователь здоровается и просит короткий ответ без лишних деталей.',
  'Отвечу приветствием и предложу помощь — этого достаточно.'
];
const REASONING = THOUGHTS.join('\n\n');
const ANSWER = 'Привет! Чем помочь?';
const SECTIONED = '[REASONING]\n' + REASONING + '\n\n[ANSWER]\n' + ANSWER;
const QUESTION = 'привет';

const THOUGHTS_2 = ['Второй ход: продолжаю разговор.', 'Отвечаю коротко.'];
const REASONING_2 = THOUGHTS_2.join('\n\n');
const ANSWER_2 = 'Дальше — по шагам.';
const SECTIONED_2 = '[REASONING]\n' + REASONING_2 + '\n\n[ANSWER]\n' + ANSWER_2;
const QUESTION_2 = 'а что дальше?';

const URL_HISTORY = 'https://chat.qwen.ai/api/v2/chats/' + CHAT_ID + '?direction=up&limit=10';
const URL_HISTORY_OTHER = 'https://chat.qwen.ai/api/v2/chats/' + OTHER_CHAT_ID + '?direction=up&limit=10';
const URL_COMPLETIONS = 'https://chat.qwen.ai/api/v2/chat/completions?chat_id=' + CHAT_ID;

function usageOf(input, output) {
  return {
    input_tokens: input, output_tokens: output, total_tokens: input + output,
    output_tokens_details: { reasoning_tokens: output },
    prompt_tokens_details: { cached_tokens: 0 }
  };
}
const USAGE_1 = usageOf(1709, 884);
const USAGE_2 = usageOf(2000, 900);

// ---- фикстура payload истории (форма измерена 2026-09-20 ~17:00) ----
function thinkingItem(thoughts, opts) {
  const o = opts || {};
  const item = {
    phase: 'thinking_summary',
    status: o.status || 'finished',
    extras: {
      summary_title: { contents: ['Размышление'] },
      summary_thought: { content: thoughts }
    }
  };
  // Дубль «2 of 2»: тот же текст лежит ещё и полем content того же элемента.
  if (o.duplicateInContent === true) item.content = thoughts.join('\n\n');
  return item;
}
function assistantNode(opts) {
  const o = opts || {};
  const list = [];
  if (o.reasoning !== false) {
    const thoughts = o.thoughts || THOUGHTS;
    if (o.firstDraftThinking) list.push(thinkingItem(o.firstDraftThinking, { status: 'typing' }));
    if (o.emptyThinkingFirst === true) {
      list.push({ phase: 'thinking_summary', status: 'typing', extras: { summary_thought: { content: [] } } });
    }
    list.push(thinkingItem(thoughts, { duplicateInContent: o.duplicateInContent === true }));
    if (o.extraThinking) list.push(thinkingItem(o.extraThinking));
  }
  list.push({ phase: 'answer', status: 'finished', content: o.answer || ANSWER });
  return {
    id: o.id || ('msg-a-' + (o.n || 1)),
    response_id: o.responseId || RESPONSE_ID,
    role: 'assistant',
    model: MODEL,
    usage: o.usage || USAGE_1,
    content_list: list
  };
}
function userNode(fid, text) {
  return {
    id: 'msg-' + fid,
    fid: fid,
    role: 'user',
    content_list: [{ phase: 'answer', status: 'finished', content: text }]
  };
}
function historyPayload(opts) {
  const o = opts || {};
  const messages = [];
  messages.push(userNode(FID, QUESTION));
  messages.push(assistantNode({
    reasoning: o.reasoning !== false,
    usage: USAGE_1,
    responseId: RESPONSE_ID,
    duplicateInContent: o.duplicateInContent === true,
    extraThinking: o.extraThinking,
    firstDraftThinking: o.firstDraftThinking,
    emptyThinkingFirst: o.emptyThinkingFirst === true
  }));
  if (o.twoTurns) {
    messages.push(userNode(FID_2, QUESTION_2));
    messages.push(assistantNode({
      n: 2, responseId: RESPONSE_ID_2, thoughts: THOUGHTS_2,
      answer: ANSWER_2, usage: USAGE_2
    }));
  }
  const payload = { data: { chat_id: CHAT_ID, chat: { history: { messages: messages } } } };
  if (o.duplicateNode) {
    // Измеренный дубль тела («1 of 2 / 2 of 2»): та же запись приходит вторым узлом. После
    // JSON.parse это ОТДЕЛЬНЫЙ объект (не общая ссылка) — воспроизводим глубокой копией.
    payload.data.chat.last_response = { message: JSON.parse(JSON.stringify(messages[1])) };
  }
  return payload;
}

// ---- стенд: РЕАЛЬНЫЙ перехватчик + реальные utils в jsdom, «сервер» — подменённый fetch ----
function jsonResponse(payload, opts) {
  const o = opts || {};
  const body = JSON.stringify(payload);
  function make() {
    const r = {
      ok: true,
      status: 200,
      headers: { get: function (n) { return n === 'content-type' ? 'application/json' : null; } },
      text: function () { return Promise.resolve(body); },
      clone: function () { return make(); }
    };
    if (o.noJson !== true) {
      r.json = function () {
        return o.jsonRejects === true
          ? Promise.reject(new Error('Unexpected token (битый JSON)'))
          : Promise.resolve(JSON.parse(body));
      };
    }
    return r;
  }
  return make();
}

function installStand(opts) {
  const o = opts || {};
  new Function('window', 'self', DEBUG_SRC)(window, window);
  new Function('window', 'self', STREAM_FRAMES_SRC)(window, window);

  const events = [];
  const calls = [];
  window.addEventListener('ai-cm-full-history', function (ev) { events.push(ev.detail); });

  window.fetch = function (input, init) {
    const url = String(typeof input === 'string' ? input : (input && input.url) || '');
    const method = String((init && init.method) || 'GET').toUpperCase();
    calls.push({ url: url, method: method });
    if (o.historyOk === false) return Promise.resolve({ ok: false, status: 500, clone: function () { return jsonResponse(o.payload || historyPayload()); } });
    if (o.cloneThrows === true) {
      return Promise.resolve({
        ok: true, status: 200,
        clone: function () { throw new TypeError('clone failed (stream locked)'); }
      });
    }
    if (o.cloneNoJson === true) return Promise.resolve(jsonResponse(o.payload, { noJson: true }));
    if (o.jsonRejects === true) return Promise.resolve(jsonResponse(o.payload, { jsonRejects: true }));
    return Promise.resolve(jsonResponse(o.payload === undefined ? historyPayload() : o.payload));
  };

  jest.spyOn(console, 'log').mockImplementation(function () { });
  jest.spyOn(console, 'warn').mockImplementation(function () { });

  // O-39-B: XHR-транспорт ставится ДО загрузки перехватчика — хук оборачивает именно
  // prototype стаба (боевой порядок тот же: registerContentScripts world=MAIN, runAt=document_start).
  const xhrTr = o.xhr ? installXhrTransport(o.xhr) : null;

  delete window.__aiCmQwenInterceptInstalled;
  new Function(INTERCEPT_SRC)();
  return { events: events, calls: calls, xhr: xhrTr };
}

// =====================================================================================
// XHR-ТРАНСПОРТ (O-39-B). Живой прогон 18:09-18:25 (чат 7fec9bd3): Network Type=xhr,
// Initiator jquery.min.js:1 — история уходит через XMLHttpRequest, fetch-хук слеп.
// Стаб воспроизводит порядок настоящего XHR: open (хук ставит флаг истории на ЭКЗЕМПЛЯРЕ),
// send → readyState=4, onreadystatechange страницы, 'readystatechange'-слушатели,
// 'loadend'-слушатели (среди них наш), затем onload.
// =====================================================================================
function installXhrTransport(opts) {
  const o = opts || {};
  const sent = [];
  const instances = [];
  const state = { responseTextReads: 0 };

  function FakeXHR() {
    this.listeners = { readystatechange: [], loadend: [] };
    this.readyState = 0;
    this.status = 0;
    this.responseType = '';
    this.response = null;
    this.responseURL = '';
    this.onreadystatechange = null;
    this.onload = null;
    this.__method = '';
    this.__url = '';
    instances.push(this);
  }
  FakeXHR.prototype.open = function (method, url) {
    this.__method = String(method);
    this.__url = String(url);
    this.readyState = 1;
  };
  FakeXHR.prototype.setRequestHeader = function () { };
  FakeXHR.prototype.addEventListener = function (type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  };
  FakeXHR.prototype.removeEventListener = function (type, fn) {
    const arr = this.listeners[type] || [];
    const i = arr.indexOf(fn);
    if (i !== -1) arr.splice(i, 1);
  };
  FakeXHR.prototype.abort = function () { };
  FakeXHR.prototype.send = function () {
    const self = this;
    sent.push({ url: self.__url, method: self.__method, hist: self.__aiCmQwenHist || null });
    const fire = function (type) {
      const arr = (self.listeners[type] || []).slice();
      for (let i = 0; i < arr.length; i++) arr[i].call(self, { type: type });
    };
    self.readyState = 4;
    self.status = (o.status === undefined) ? 200 : o.status;
    self.responseURL = self.__url;
    if (String(self.responseType) === 'json' && o.jsonPayload !== undefined) self.response = o.jsonPayload;
    if (typeof self.onreadystatechange === 'function') self.onreadystatechange.call(self, { type: 'readystatechange' });
    fire('readystatechange');
    fire('loadend');
    if (typeof self.onload === 'function') self.onload.call(self, { type: 'load' });
  };
  window.XMLHttpRequest = FakeXHR;
  return { sent: sent, instances: instances, state: state };
}

/**
 * Экземпляр истории: тело видно как responseText через shadow на ЭКЗЕМПЛЯРЕ (Object.defineProperty),
 * как у настоящего XHR. Геттер считает чтения и при responseType='json' бросает InvalidStateError —
 * ровно поведение движка (пин гарда D2): читать responseText при json нельзя.
 */
function historyXhr(tr, url, payload, opts) {
  const o = opts || {};
  const xhr = new window.XMLHttpRequest();
  xhr.open(o.method || 'GET', url, o.async === undefined ? true : o.async);
  if (o.responseType) xhr.responseType = o.responseType;
  if (o.jsonPayload !== undefined) xhr.response = o.jsonPayload;
  const body = (typeof o.rawBody === 'string') ? o.rawBody : JSON.stringify(payload);
  Object.defineProperty(xhr, 'responseText', {
    configurable: true,
    get: function () {
      tr.state.responseTextReads++;
      if (String(xhr.responseType) === 'json') {
        const err = new Error("Failed to read the 'responseText' property from 'XMLHttpRequest': " +
          "The value is only accessible if the object's 'responseType' is '' or 'text' (was 'json').");
        err.name = 'InvalidStateError';
        throw err;
      }
      return body;
    }
  });
  return xhr;
}

function qwenHistoryLines() {
  return diagLines().filter(function (s) { return s.indexOf('qwen-history') !== -1; });
}

// Прокрутка асинхронного разбора (JSON-ветка): реальные макротаски, а не цепочка микротасок.
function settle(rounds) {
  let p = Promise.resolve();
  for (let i = 0; i < (rounds || 6); i++) {
    p = p.then(function () { return new Promise(function (r) { setTimeout(r, 0); }); });
  }
  return p;
}

async function runHistory(opts) {
  const st = installStand(opts || {});
  const resp = window.fetch(URL_HISTORY, { method: 'GET' });
  await resp;
  await settle(6);
  return st;
}

function diagLines() {
  return console.log.mock.calls.map(function (a) { return String(a[0]); })
    .filter(function (s) { return s.indexOf('[AI CM][diag] qwen-') === 0; });
}

// =====================================================================================
// Песочница ПУТИ ЗАПИСИ БАЗЫ (та же, что в tests/qwen-o39-reasoning-passthrough.test.js):
// РЕАЛЬНЫЕ aiCmCollectExportSource (export-manager) + aiCmDedupeExportSource (base-handler)
// в одном скоупе + единая точка выхода (сборщики txt/md). Нужна для D3/D5/R1-R2: файл
// собирается из РЕАЛЬНОГО detail перехватчика, а не из синтетического массива.
// =====================================================================================
const COLLECT_SRC = MGR_SRC.slice(
  MGR_SRC.indexOf('function sanitizeGeminiText(s)'),
  MGR_SRC.indexOf('// T1-fix#3')
);

function makeBaseWriter(opts) {
  const o = opts || {};
  const site = o.site || 'qwen';
  const ctx = {
    window: { AiCmExportEmitPipeline: P },
    sessionStorage: {
      getItem: function () { return null; },
      setItem: function () { },
      removeItem: function () { }
    },
    console: { log: function () { }, warn: function () { }, error: function () { }, info: function () { }, debug: function () { } },
    lastBaseTexts: [],
    lastDetailMessages: null,
    baseSeen: o.baseSeen === true,
    currentAdapter: { siteName: site, extractMessages: function () { return []; } },
    aiCmLogIntraDedupe: function () { }
  };
  const src = COLLECT_SRC + '\n' +
    fnDecl(BASE_HANDLER_SRC, 'aiCmDedupeExportSource') + '\n' +
    'ctx.__collect = aiCmCollectExportSource;\n' +
    'ctx.__dedupe = aiCmDedupeExportSource;\n' +
    'ctx.__history = function () { return aiCmDedupeExportSource(aiCmCollectExportSource()).messages; };\n' +
    // O-7 (тумблер): в песочнице переменная локальна — переключатель наружу.
    'ctx.__setHidden = function (v) { aiCmIncludeHiddenInExport = (v === true); };';
  // eslint-disable-next-line no-new-func
  const fn = new Function('ctx', 'with (ctx) { (function () {\n' + src + '\n})(); }');
  fn(ctx);
  // hidden: true — песочница в режиме ON. Пины «reasoning доезжает до файла» живут на ON-пути:
  // OFF-путь теперь очищает поле reasoning (O-7, aiCmCollectExportSource);
  // OFF-контракт покрыт tests/qwen-o7-reasoning-toggle.test.js.
  if (o.hidden === true) ctx.__setHidden(true);
  return {
    history: function (texts, detail) {
      ctx.lastBaseTexts = texts || [];
      ctx.lastDetailMessages = detail || null;
      return ctx.__history();
    },
    txt: function (messages) {
      return Builders.buildTxtFromHistory({ site: site, messages: messages });
    },
    md: function (messages) {
      return Builders.buildMdFromHistory({ site: site, messages: messages }, 'Qwen');
    }
  };
}

/** РЕАЛЬНЫЙ detail перехватчика → РЕАЛЬНЫЙ путь записи → файл (txt и md).
 *  Тумблер ON: инвариант этих пинов — «размышление payload доезжает до ФАЙЛА»
 *  (live-приёмка O-39 18:53). На OFF-пути поле reasoning снимается (O-7) — OFF-контракт
 *  запинен отдельно в tests/qwen-o7-reasoning-toggle.test.js. */
function fileOfDetail(detail) {
  const w = makeBaseWriter({ site: 'qwen', baseSeen: true, hidden: true });
  const msgs = w.history(detail.messageTexts, detail.messages);
  return { messages: msgs, txt: w.txt(msgs), md: w.md(msgs) };
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

// =====================================================================================
// D1: МАТЧЕР ИСТОРИИ
// =====================================================================================
describe('O-39 D1: isQwenHistory — GET /api/v<NN>/chats/{id} (и isQwenCompletions не тронут)', () => {
  test('D1 измеренный URL опознан, служебные и чужие эндпоинты — нет', () => {
    installStand({});
    const B = window.__aiCmQwenBridge;
    expect(B.isQwenHistory(URL_HISTORY, 'GET')).toBe(true);
    expect(B.isQwenHistory('https://chat.qwen.ai/api/v3/chats/' + CHAT_ID, 'GET')).toBe(true);
    expect(B.historyChatIdFromUrl(URL_HISTORY)).toBe(CHAT_ID);

    expect(B.isQwenHistory(URL_HISTORY, 'POST')).toBe(false);             // история — только GET
    expect(B.isQwenHistory(URL_COMPLETIONS, 'GET')).toBe(false);          // стрим — POST-эндпоинт
    expect(B.isQwenHistory('https://chat.qwen.ai/api/v2/chats/new', 'GET')).toBe(false);
    expect(B.isQwenHistory('https://chat.qwen.ai/api/v2/chats', 'GET')).toBe(false);
    expect(B.isQwenHistory('https://chat.qwen.ai/api/v2/chats/new?x', 'GET')).toBe(false);

    // R-пин границы: потоковый матчер байтово прежний (POST completions, GET — нет)
    expect(B.isQwenCompletions(URL_COMPLETIONS, 'POST')).toBe(true);
    expect(B.isQwenCompletions(URL_COMPLETIONS, 'GET')).toBe(false);
    expect(B.isQwenCompletions('https://api.openai.com/v1/chat/completions', 'POST')).toBe(false);
  });
});

// =====================================================================================
// D2/D4: PAYLOAD → DETAIL
// =====================================================================================
describe('O-39 D2/D4: payload истории → detail (reasoning, секции, usage, response_id)', () => {
  test('D2 reasoning из extras.summary_thought.content (join \\n\\n) доезжает полями detail', async () => {
    const st = await runHistory({ payload: historyPayload() });
    expect(st.calls).toHaveLength(1);
    expect(st.calls[0]).toEqual({ url: URL_HISTORY, method: 'GET' });
    expect(st.events).toHaveLength(1);

    const d = st.events[0];
    expect(d.count).toBe(2);
    expect(d.messages.map(function (m) { return m.role; })).toEqual(['user', 'assistant']);
    expect(d.messages[0].text).toBe(QUESTION);
    expect(d.messages[0].reasoning).toBe('');
    // Абзацы summary склеены '\n\n' (спека O-39 п.2), а не ''/'\n' и без удвоения.
    expect(d.messages[1].reasoning).toBe(REASONING);
    expect(d.messages[1].reasoning).toBe(THOUGHTS[0] + '\n\n' + THOUGHTS[1]);
    expect(d.messages[1].hiddenReasoning).toBe(REASONING);
    expect(d.reasoningTurns).toBe(1);
    expect(d.reasoningTexts[1]).toBe(REASONING);
    // Секции в тексте хода — тот же контракт, что у live-стрима (composeTurnText).
    expect(d.messageTexts[1]).toBe(SECTIONED);
    expect(d.messageTexts[0]).toBe(QUESTION);
    expect(d.text).toBe(QUESTION + '\n' + SECTIONED);
    expect(d.messageIds).toEqual(['u:' + FID, RESPONSE_ID]);
    expect(d.historyComplete).toBe(true);
    expect(d.baseEmpty).toBe(false);
    expect(d.modelSlug).toBe(MODEL);
  });

  test('D4 usage{input_tokens,output_tokens} истории → qwenUsage/responseId (O-47: не serverTokens)', async () => {
    const st = await runHistory({ payload: historyPayload() });
    const d = st.events[0];
    // O-47: серверное число истории в detail НЕ публикуется (usage.input у Qwen — кумулятив
    // API-потребления, а не размер контекста); серверный usage остаётся полем qwenUsage для
    // тултипа, а badge/pct считаются только эвристикой tokens~.
    expect('serverTokens' in d).toBe(false);
    expect(d.qwenUsage.inputTokens).toBe(1709);
    expect(d.qwenUsage.outputTokens).toBe(884);
    expect(d.qwenUsage.totalTokens).toBe(2593);
    expect(d.qwenUsage.reasoningTokens).toBe(884);   // output ВКЛЮЧАЕТ reasoning (семантика O-35)
    expect(d.qwenUsage.cachedTokens).toBe(0);
    expect(d.responseId).toBe(RESPONSE_ID);
    expect(d.chatId).toBe(CHAT_ID);
    expect(d.convId).toBe(CHAT_ID);
  });
});

// =====================================================================================
// D3/D5: PAYLOAD → ФАЙЛ (реальный путь записи базы)
// =====================================================================================
describe('O-39 D3: payload истории → файл экспорта (collect → dedupe → txt/md)', () => {
  test('D3 txt: секция [REASONING] в файле ровно одна, состав ходов прежний', async () => {
    const st = await runHistory({ payload: historyPayload() });
    const f = fileOfDetail(st.events[0]);
    expect(f.messages).toHaveLength(2);
    expect(f.messages[1].reasoning).toBe(REASONING);      // поле, которое читает рендер
    // ON (тумблер ВКЛ): поле reasoning снимка уже на месте → текст хода не переупаковывается
    // (секции остаются в тексте, рендер их не дублирует). OFF-путь (поле снимается, секции
    // урезаются до [ANSWER]) запинен в tests/qwen-o7-reasoning-toggle.test.js.
    expect(f.messages[1].text).toBe(SECTIONED);
    expect(f.messages[1].text).toContain('[REASONING]');
    expect(f.txt).toBe('USER:\n' + QUESTION + '\n\nASSISTANT:\n' + SECTIONED);
    expect((f.txt.match(/\[REASONING\]/g) || [])).toHaveLength(1);
    expect((f.txt.match(/\[ANSWER\]/g) || [])).toHaveLength(1);
    expect(f.txt.indexOf('[REASONING]')).toBeLessThan(f.txt.indexOf('[ANSWER]'));
  });

  test('D3 md: та же пара секций под маркером роли', async () => {
    const st = await runHistory({ payload: historyPayload() });
    const f = fileOfDetail(st.events[0]);
    expect(f.md).toContain('### ASSISTANT\n\n' + SECTIONED);
    expect((f.md.match(/\[REASONING\]/g) || [])).toHaveLength(1);
    expect(f.md).not.toContain('hiddenReasoning');
  });
});

describe('O-39 D5: два хода истории — оба reasoning в файле, порядок и usage последнего хода', () => {
  test('D5 файл несёт обе секции [REASONING] в порядке ходов, usage — последний ход', async () => {
    const st = await runHistory({ payload: historyPayload({ twoTurns: true }) });
    const d = st.events[0];
    expect(d.count).toBe(4);
    expect(d.messages.map(function (m) { return m.role; }))
      .toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(d.reasoningTexts[1]).toBe(REASONING);
    expect(d.reasoningTexts[3]).toBe(REASONING_2);
    expect(d.reasoningTurns).toBe(2);
    expect(d.messageIds).toEqual(['u:' + FID, RESPONSE_ID, 'u:' + FID_2, RESPONSE_ID_2]);
    // O-47: серверного числа в снимке нет; usage последнего хода виден полем qwenUsage
    expect('serverTokens' in d).toBe(false);
    expect(d.qwenUsage.outputTokens).toBe(900);
    expect(d.responseId).toBe(RESPONSE_ID_2);

    const f = fileOfDetail(d);
    expect(f.messages).toHaveLength(4);
    expect(f.txt).toBe('USER:\n' + QUESTION + '\n\nASSISTANT:\n' + SECTIONED +
      '\n\nUSER:\n' + QUESTION_2 + '\n\nASSISTANT:\n' + SECTIONED_2);
    expect((f.txt.match(/\[REASONING\]/g) || [])).toHaveLength(2);
    expect(f.txt.indexOf(REASONING)).toBeLessThan(f.txt.indexOf(REASONING_2));
    expect((f.md.match(/\[REASONING\]/g) || [])).toHaveLength(2);
  });
});

// =====================================================================================
// D6: ГРАНИЦА «ДУБЛЬ REASONING В PAYLOAD» (первое вхождение побеждает, дубль — read-only лог)
// =====================================================================================
describe('O-39 D6: дубль в payload не удваивает reasoning (измерение read-only)', () => {
  test('D6 узел-дубль (та же запись вторым узлом тела) → один ход, одна секция', async () => {
    sessionStorage.setItem('aiCmDebug', '1');
    const st = await runHistory({ payload: historyPayload({ duplicateNode: true }) });
    expect(st.events).toHaveLength(1);
    const d = st.events[0];
    expect(d.count).toBe(2);                                  // дубль узла в базу не попал
    expect((d.text.match(/\[REASONING\]/g) || [])).toHaveLength(1);
    expect(d.messages[1].reasoning).toBe(REASONING);          // текст НЕ удвоен
    const lines = diagLines().join('\n');
    expect(lines).toContain('qwen-history-duplicate');
    expect(lines).toContain('taken=first');
  });

  test('D6 дубль thinking_summary внутри content_list → reasoning не склеивается', async () => {
    sessionStorage.setItem('aiCmDebug', '1');
    // Второй такой же элемент (та же текстовая пара) — измеренный «2 of 2».
    const st = await runHistory({ payload: historyPayload({ extraThinking: THOUGHTS.slice() }) });
    const d = st.events[0];
    expect(d.messages[1].reasoning).toBe(REASONING);
    expect((d.text.match(/\[REASONING\]/g) || [])).toHaveLength(1);
    expect(d.messages[1].reasoning).not.toBe(REASONING + '\n\n' + REASONING);
    expect(diagLines().join('\n')).toContain('qwen-history-duplicate');
  });

  test('D6 extras и content одного элемента (дубль «1 of 2 / 2 of 2») → одна копия', async () => {
    const st = await runHistory({ payload: historyPayload({ duplicateInContent: true }) });
    const d = st.events[0];
    expect(d.messages[1].reasoning).toBe(REASONING);
    expect((d.text.match(/\[REASONING\]/g) || [])).toHaveLength(1);
    expect(fileOfDetail(d).txt).toBe('USER:\n' + QUESTION + '\n\nASSISTANT:\n' + SECTIONED);
  });

  test('D6 «первое вхождение побеждает»: два РАЗНЫХ thinking_summary — берём первый с текстом', async () => {
    const DRAFT = 'ЧЕРНОВИК: первое thinking_summary-вхождение списка.';
    const st = await runHistory({
      payload: historyPayload({ firstDraftThinking: [DRAFT] })
    });
    const d = st.events[0];
    expect(d.messages[1].reasoning).toBe(DRAFT);              // первое вхождение, а не склейка
    expect(d.text).toContain(DRAFT);
    expect(d.messages[1].reasoning).not.toBe(REASONING);      // второе вхождение НЕ добавлено
    expect((d.text.match(/\[REASONING\]/g) || [])).toHaveLength(1);
  });

  test('D6 пустое первое вхождение не теряет размышление (берётся первое С ТЕКСТОМ)', async () => {
    const st = await runHistory({ payload: historyPayload({ emptyThinkingFirst: true }) });
    const d = st.events[0];
    expect(d.messages[1].reasoning).toBe(REASONING);
    expect(d.messageTexts[1]).toBe(SECTIONED);
  });
});

// =====================================================================================
// R1: REASONING В PAYLOAD НЕТ — БАЙТЫ ПРЕЖНИЕ
// =====================================================================================
describe('O-39 R1: история без thinking_summary — ни секции, ни поля', () => {
  test('R1 detail и файл байтово равны bare-паре вопрос/ответ, [REASONING] нет', async () => {
    const st = await runHistory({ payload: historyPayload({ reasoning: false }) });
    const d = st.events[0];
    expect(d.count).toBe(2);
    expect(d.messages[1].reasoning).toBe('');
    expect(d.messages[1].hiddenReasoning).toBeUndefined();
    expect(d.reasoningTurns).toBe(0);
    expect(d.messageTexts[1]).toBe(ANSWER);                    // composeTurnText без reasoning = ответ
    expect(d.text).toBe(QUESTION + '\n' + ANSWER);

    const f = fileOfDetail(d);
    expect(f.messages[1].reasoning).toBeUndefined();
    expect(f.txt).toBe('USER:\n' + QUESTION + '\n\nASSISTANT:\n' + ANSWER);
    expect(f.txt).not.toContain('[REASONING]');
    expect(f.md).not.toContain('[REASONING]');

    // Детерминизм: тот же payload вторым прогоном — те же байты (и один emit, а не два).
    const again = await runHistory({ payload: historyPayload({ reasoning: false }) });
    expect(again.events).toHaveLength(1);
    expect(again.events[0].text).toBe(d.text);
    expect(fileOfDetail(again.events[0]).txt).toBe(f.txt);
  });

  test('R1 пустой/битый ответ истории: ни одного снимка (база не подменяется)', async () => {
    const st = await runHistory({ payload: { data: { chat_id: CHAT_ID, chat: { history: { messages: [] } } } } });
    expect(st.events).toHaveLength(0);
  });
});

// =====================================================================================
// R2: LIVE-ПУТЬ SSE (O-35/O-37) НЕ ИЗМЕНЁН
// =====================================================================================
describe('O-39 R2: живой SSE-путь не изменён перехватом истории', () => {
  const LIVE_REASONING = 'Живое размышление стрима.';
  const LIVE_ANSWER = 'Живой ответ.';
  const LIVE_ID = 'live-response-0001';

  function liveFrames() {
    return [
      { 'response.created': { chat_id: CHAT_ID, parent_id: '', response_id: LIVE_ID, response_index: '0' } },
      {
        choices: [{
          delta: {
            role: 'assistant', content: '', phase: 'thinking_summary',
            extra: { summary_thought: { content: [LIVE_REASONING] } }, status: 'typing'
          }
        }],
        usage: USAGE_1
      },
      { choices: [{ delta: { role: 'assistant', content: LIVE_ANSWER, phase: 'answer', status: 'typing' } }], usage: USAGE_1 }
    ];
  }

  test('R2 ход стрима байтово тот же, что без перехвата истории; секции — по одной', async () => {
    // (а) только стрим
    const liveOnly = installStand({});
    window.__aiCmQwenBridge.applyFrames(liveFrames());
    expect(liveOnly.events).toHaveLength(1);
    const liveMsg = liveOnly.events[0].messages[liveOnly.events[0].messages.length - 1];
    expect(liveMsg.reasoning).toBe(LIVE_REASONING);
    const liveText = liveMsg.text;

    // (б) сначала история чата (SPA-перезагрузка), затем ход стрима
    const st = await runHistory({ payload: historyPayload() });
    expect(st.events).toHaveLength(1);
    window.__aiCmQwenBridge.applyFrames(liveFrames());
    expect(st.events).toHaveLength(2);

    const d = st.events[1];
    const merged = d.messages[d.messages.length - 1];
    expect(merged.reasoning).toBe(LIVE_REASONING);
    expect(merged.text).toBe(liveText);                        // байтовый паритет live-хода
    expect(d.reasoningTexts.filter(function (r) { return r === LIVE_REASONING; })).toHaveLength(1);
    expect((d.text.match(/\[REASONING\]/g) || [])).toHaveLength(2);   // история + стрим
    expect('serverTokens' in d).toBe(false);                          // O-47: серверное число не в снимке
    expect(d.messageIds[d.messageIds.length - 1]).toBe(LIVE_ID);
  });
});

// =====================================================================================
// R3: ГРАНИЦЫ ПУТИ ИСТОРИИ (чужой чат, HTTP-сбой, клон/JSON недоступны, прочие платформы)
// =====================================================================================
describe('O-39 R3: границы — чужой чат, HTTP-сбой и снятый клон не подменяют базу', () => {
  test('R3 история ДРУГОГО чата не пишется в текущую базу', async () => {
    const st = installStand({ payload: historyPayload() });
    window.fetch(URL_HISTORY_OTHER, { method: 'GET' });
    await settle(6);
    expect(st.events).toHaveLength(0);
    expect(window.__aiCmQwenBridge.turns()).toHaveLength(0);
  });

  test('R3 HTTP-сбой / снятый clone() / битый JSON → ни снимка, ни исключения', async () => {
    const bad = await runHistory({ historyOk: false });
    expect(bad.events).toHaveLength(0);
    const locked = await runHistory({ cloneThrows: true });
    expect(locked.events).toHaveLength(0);
    const broken = await runHistory({ jsonRejects: true });
    expect(broken.events).toHaveLength(0);
  });

  test('R3 клон без json() читается через text()+JSON.parse (фолбэк, байты те же)', async () => {
    const st = await runHistory({ cloneNoJson: true, payload: historyPayload() });
    expect(st.events).toHaveLength(1);
    expect(st.events[0].messages[1].reasoning).toBe(REASONING);
  });

  test('R3 чистая функция парсера: посторонние role/узлы и прочие платформы не задеты', () => {
    installStand({});
    const B = window.__aiCmQwenBridge;
    const parsed = B.parseQwenHistory({
      data: {
        chat_id: CHAT_ID,
        messages: [
          { role: 'system', content: 'you are a helpful assistant' },
          userNode(FID, QUESTION),
          assistantNode({})
        ]
      }
    });
    expect(parsed.messages.map(function (m) { return m.role; })).toEqual(['user', 'assistant']);
    expect(parsed.reasoningMessages).toBe(1);
    expect(parsed.duplicates).toBe(0);
    expect(parsed.thinkingDuplicates).toBe(0);
    expect(parsed.chatId).toBe(CHAT_ID);
    // Рендер прочих платформ по-прежнему не создаёт секций без поля reasoning (R-пин O-39).
    expect(Builders.buildTxtFromHistory({
      messages: [{ role: 'assistant', text: ANSWER }]
    })).toBe(ANSWER);
  });
});

// =====================================================================================
// R4: ГЕЙТ (диагностика только под aiCmDebug; байты от гейта не зависят)
// =====================================================================================
describe('O-39 R4: строки истории только под гейтом, байты выхода от гейта не зависят', () => {
  test('R4 гейт выключен → ни одной строки qwen-; включён → qwen-history есть', async () => {
    const off = await runHistory({ payload: historyPayload() });
    expect(off.events).toHaveLength(1);
    expect(diagLines()).toEqual([]);

    jest.restoreAllMocks();
    sessionStorage.setItem('aiCmDebug', '1');
    const on = installStand({ payload: historyPayload() });
    window.fetch(URL_HISTORY, { method: 'GET' });
    await settle(6);
    const lines = diagLines().join('\n');
    expect(lines).toContain('qwen-history');
    expect(on.events).toHaveLength(1);

    // G2-пин: байты снимка при гейте вкл/выкл идентичны.
    expect(JSON.parse(JSON.stringify(on.events[0]))).toEqual(JSON.parse(JSON.stringify(off.events[0])));
  });
});

// =====================================================================================
// R5: СОСЕДНИЕ НАБОРЫ (O-37 / O-38 / O-11 / O-31) НА МЕСТЕ
// =====================================================================================
describe('O-39 R5: регресс-контур O-37/O-38/O-11/O-31 исполняется npm test', () => {
  test('R5 файлы наборов и их опорные маркеры не тронуты', () => {
    const suites = [
      'tests/qwen-reasoning-export-o37.test.js',            // O-37: reasoning сервиса без сети
      'tests/qwen-container-drop-o37.test.js',              // O-37: контейнеры/склейка (сосед O-41)
      'tests/o38-autoexport-once-latch.test.js',            // O-38: модульный латч автоэкспорта
      'tests/gsa-autoexport-o11-name-collision.test.js',    // O-11: имена файлов
      'tests/gsa-o31-thread-segmentation.test.js'           // O-31: сегментация разговора
    ];
    suites.forEach(function (rel) {
      expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
    });
    expect(typeof P.splitReasoningSections).toBe('function');            // O-37
    expect(typeof P.applyReasoningExportFields).toBe('function');        // O-37/O-39
    expect(typeof P.shouldSkipAutoExport).toBe('function');              // O-11/O-38
    expect(typeof P.latchKey).toBe('function');                          // O-11
    const content = fs.readFileSync(path.join(ROOT, 'core', 'content.js'), 'utf8');
    expect(content).toContain('function aiCmSnapshotIsCurrentThread(');  // O-31
  });
});

// =====================================================================================
// S: SOURCE-ПИНЫ ПРОВОДКИ (матчер, JSON-ветка, интеграция, гейт дубля)
// =====================================================================================
describe('O-39 S: пины проводки перехватчика', () => {
  test('S1 матчер истории: GET-гард, регексп /api/v<NN>/chats/{id}, список служебных id', () => {
    expect(INTERCEPT_SRC).toContain('function isQwenHistory(url, method)');
    const fn = fnDecl(INTERCEPT_SRC, 'isQwenHistory');
    expect(fn).toContain("if (method !== 'GET') return false;");
    expect(fn).toContain('historyChatIdFromUrl(url)');
    expect(INTERCEPT_SRC).toContain('var QWEN_HISTORY_RE = /\\/api\\/v\\d+\\/chats\\/([A-Za-z0-9_-]+)(?:[?#]|$)/;');
    expect(INTERCEPT_SRC).toContain("'new': true, 'list': true");
  });

  test('S2 JSON-ветка: только resp.clone().json(), тело страницы не читается', () => {
    const fn = fnDecl(INTERCEPT_SRC, 'consumeHistory');
    expect(fn).toContain('resp.clone()');
    expect(fn).toContain('clone.json()');
    expect(fn).toContain("reason: 'clone-failed'");
    expect(fn).toContain("reason: 'json-error'");
    expect(INTERCEPT_SRC).toContain('resp.clone().json()');
    // страница получает свой ответ как есть (обёртка fetch возвращает тот же promise)
    expect(INTERCEPT_SRC).toContain('consumeHistory(resp, histMeta);');
    expect(INTERCEPT_SRC).toContain("consumeStream(resp, meta);");
  });

  test('S3 парсер: content_list → первое thinking_summary, абзацы join("\\n\\n"), не-thinking — APPEND', () => {
    const think = fnDecl(INTERCEPT_SRC, 'historyThinkingOf');
    expect(think).toContain('if (item.phase !== PHASE_THINKING) continue;');
    expect(think).toContain('if (!first) first = item;');
    expect(think).toContain('if (!firstWithText) firstWithText = thinkingTextOf(item);');
    const textOf = fnDecl(INTERCEPT_SRC, 'thinkingTextOf');
    expect(textOf).toContain('extras.summary_thought');
    expect(textOf).toContain("parts.join('\\n\\n')");
    expect(fnDecl(INTERCEPT_SRC, 'historyAnswerOf')).toContain('out += item.content;');
    expect(fnDecl(INTERCEPT_SRC, 'parseQwenHistory')).toContain('if (seen[dedupeKey] === 1) { duplicates++; continue; }');
  });

  test('S4 интеграция: ходы истории идут в recordTurn/emitSnapshot, секции — composeTurnText', () => {
    const apply = fnDecl(INTERCEPT_SRC, 'applyHistoryPayload');
    expect(apply).toContain('recordTurn({');
    expect(apply).toContain('emitSnapshot({');
    expect(apply).toContain('reasoning: msg.reasoning ||');
    expect(fnDecl(INTERCEPT_SRC, 'composeTurnText'))
      .toContain("return REASONING_TAG + '\\n' + reasoning + '\\n\\n' + ANSWER_TAG + '\\n' + answer;");
  });

  test('S5 дубль — read-only: строка qwen-history-duplicate через diagTag (гейт aiCmDebug)', () => {
    const apply = fnDecl(INTERCEPT_SRC, 'applyHistoryPayload');
    expect(apply).toContain("diagTag('qwen-history-duplicate'");
    expect(apply).toContain("taken: 'first'");
    expect(fnDecl(INTERCEPT_SRC, 'diagTag')).toContain('emitDiag(fullTag, fields)');
    expect(fnDecl(INTERCEPT_SRC, 'emitDiag')).toContain('if (diagOn())');
    expect(fnDecl(INTERCEPT_SRC, 'diagOn')).toContain("sessionStorage.getItem('aiCmDebug') === '1'");
    // измерение не меняет байты: ни одного влияния на turns/текст в ветке дубля
    const dupBlock = apply.slice(apply.indexOf("diagTag('qwen-history-duplicate'"));
    expect(dupBlock).not.toContain('sse.reasoning');
    expect(dupBlock).not.toContain('turns.push');
  });
});

// =====================================================================================
// O-39-B: XHR-ТРАНСПОРТ ИСТОРИИ (живой прогон 18:09-18:25 — Type=xhr, инициатор jquery)
// =====================================================================================
const URL_HISTORY_LATEST_MEMORY = 'https://chat.qwen.ai/api/v2/chats/' + CHAT_ID + '/latest?type=memory';
const URL_CHATS_NEW = 'https://chat.qwen.ai/api/v2/chats/new';
const URL_TAGS = 'https://chat.qwen.ai/api/v2/tags';

describe('O-39-B X-D1: XHR-путь доводит reasoning до файла', () => {
  test('X-D1 loadend XHR-истории → detail.messages[].reasoning, в txt/md ровно одна пара секций', () => {
    const st = installStand({ xhr: {} });
    const xhr = historyXhr(st.xhr, URL_HISTORY, historyPayload());
    xhr.send();

    expect(st.xhr.sent).toHaveLength(1);
    expect(st.xhr.sent[0]).toEqual({
      url: URL_HISTORY, method: 'GET', hist: { chatId: CHAT_ID, url: URL_HISTORY, method: 'GET' }
    });
    expect(st.xhr.state.responseTextReads).toBe(1);        // тело прочитано ровно один раз

    expect(st.events).toHaveLength(1);
    const d = st.events[0];
    expect(d.messages).toHaveLength(2);
    expect(d.messages[1].role).toBe('assistant');
    expect(d.messages[1].reasoning).toBe(REASONING);       // НЕПУСТОЙ reasoning из XHR-тела
    expect(d.messages[1].hiddenReasoning).toBe(REASONING);
    expect(d.messageTexts[1]).toBe(SECTIONED);
    expect('serverTokens' in d).toBe(false);               // O-47: usage в снимок не публикуется
    expect(d.qwenUsage.inputTokens).toBe(1709);
    expect(d.responseId).toBe(RESPONSE_ID);
    expect(d.chatId).toBe(CHAT_ID);

    // Реальный путь записи базы (collect → dedupe → builders): ровно одна пара секций.
    const f = fileOfDetail(d);
    expect(f.messages).toHaveLength(2);
    expect(f.messages[1].reasoning).toBe(REASONING);
    expect(f.txt).toBe('USER:\n' + QUESTION + '\n\nASSISTANT:\n' + SECTIONED);
    expect((f.txt.match(/\[REASONING\]/g) || [])).toHaveLength(1);
    expect((f.txt.match(/\[ANSWER\]/g) || [])).toHaveLength(1);
    expect(f.md).toContain('### ASSISTANT\n\n' + SECTIONED);
    expect((f.md.match(/\[REASONING\]/g) || [])).toHaveLength(1);
    expect((f.md.match(/\[ANSWER\]/g) || [])).toHaveLength(1);
  });
});

describe('O-39-B X-D2: responseType=json — тело из xhr.response', () => {
  test('X-D2 responseText при json НЕ читается (InvalidStateError), payload берётся из xhr.response', () => {
    const payload = historyPayload();
    const st = installStand({ xhr: {} });
    const xhr = historyXhr(st.xhr, URL_HISTORY, payload, { responseType: 'json', jsonPayload: payload });
    xhr.send();

    expect(st.events).toHaveLength(1);
    expect(st.events[0].messages[1].reasoning).toBe(REASONING);
    expect('serverTokens' in st.events[0]).toBe(false);   // O-47: usage в снимок не публикуется
    expect(st.events[0].qwenUsage.inputTokens).toBe(1709);
    expect(st.xhr.state.responseTextReads).toBe(0);       // гард: ветка json responseText не трогает

    // Сам стенд воспроизводит поведение движка (jsdom/браузер): чтение responseText при
    // responseType='json' бросает InvalidStateError — значит пин выше действительно про гард.
    let thrown = null;
    try { void xhr.responseText; } catch (e) { thrown = e; }
    expect(thrown && thrown.name).toBe('InvalidStateError');
    expect(st.xhr.state.responseTextReads).toBe(1);       // счётчик видит только тестовое чтение
  });
});

describe('O-39-B X-D3: чужой чат на XHR в базу не пишется', () => {
  test('X-D3 история другого чата → skip-request other-chat, база и снимок не меняются', async () => {
    sessionStorage.setItem('aiCmDebug', '1');
    const st = installStand({ xhr: {} });
    // База уже непустая: свой чат пришёл fetch-веткой (регресс fetch-пути попутно).
    window.fetch(URL_HISTORY, { method: 'GET' });
    await settle(6);
    expect(st.events).toHaveLength(1);
    const turnsBefore = JSON.stringify(window.__aiCmQwenBridge.turns());
    const linesBefore = diagLines().length;

    const xhr = historyXhr(st.xhr, URL_HISTORY_OTHER, historyPayload());
    xhr.send();

    expect(st.events).toHaveLength(1);                       // нового снимка нет
    expect(JSON.stringify(window.__aiCmQwenBridge.turns())).toBe(turnsBefore);
    expect(st.xhr.sent[0].hist).toBeNull();                  // флаг истории не поставлен
    expect(st.xhr.state.responseTextReads).toBe(0);           // тело чужого чата не читалось

    const lines = diagLines().slice(linesBefore).join('\n');
    expect(lines).toContain('qwen-history');
    expect(lines).toContain('event=skip-request');
    expect(lines).toContain('reason=other-chat');
    expect(lines).toContain('transport=xhr');
    expect(lines).toContain('qwen-skip-request reason=other-chat');
  });
});

describe('O-39-B X-R1: не-исторические XHR перехватчик не трогает', () => {
  test('X-R1 POST completions / latest?type=memory / chats/new / tags → флага нет, строк нет, база прежняя', async () => {
    sessionStorage.setItem('aiCmDebug', '1');
    const st = installStand({ xhr: {} });
    window.fetch(URL_HISTORY, { method: 'GET' });
    await settle(6);
    expect(st.events).toHaveLength(1);
    const turnsBefore = JSON.stringify(window.__aiCmQwenBridge.turns());
    const linesBefore = diagLines().length;
    const histLinesBefore = qwenHistoryLines().length;

    const probes = [
      ['POST', URL_COMPLETIONS],
      ['GET', URL_HISTORY_LATEST_MEMORY],
      ['GET', URL_CHATS_NEW],
      ['GET', URL_TAGS]
    ];
    probes.forEach(function (p) {
      const xhr = historyXhr(st.xhr, p[1], historyPayload(), { method: p[0] });
      xhr.send();
    });

    expect(st.xhr.instances).toHaveLength(probes.length);
    st.xhr.instances.forEach(function (xhr) {
      expect(xhr.__aiCmQwenHist).toBeNull();                 // флаг isHist не поставлен
      expect(xhr.listeners.loadend).toHaveLength(0);         // своих слушателей нет вовсе
      expect(xhr.listeners.readystatechange).toHaveLength(0);
    });
    st.xhr.sent.forEach(function (s) { expect(s.hist).toBeNull(); });
    expect(diagLines().slice(linesBefore)).toEqual([]);      // ни одной новой qwen-строки
    expect(qwenHistoryLines()).toHaveLength(histLinesBefore);
    expect(st.events).toHaveLength(1);                       // база прежняя
    expect(JSON.stringify(window.__aiCmQwenBridge.turns())).toBe(turnsBefore);
  });
});

describe('O-39-B X-R2: битый JSON в теле истории', () => {
  test('X-R2 XHR страницы завершается штатно, loadend страницы один, снимков 0, diag event=error', () => {
    sessionStorage.setItem('aiCmDebug', '1');
    const st = installStand({ xhr: {} });
    const xhr = historyXhr(st.xhr, URL_HISTORY, null, { rawBody: '{"data": {"chat_id": "4cf29053"' });
    let pageLoadend = 0;
    xhr.addEventListener('loadend', function () { pageLoadend++; });

    expect(function () { xhr.send(); }).not.toThrow();       // исключение наружу не выходит
    expect(pageLoadend).toBe(1);                             // у страницы ровно один loadend
    expect(xhr.readyState).toBe(4);                          // XHR страницы завершён штатно
    expect(xhr.status).toBe(200);
    expect(st.events).toHaveLength(0);                       // снимков 0
    expect(window.__aiCmQwenBridge.turns()).toHaveLength(0);

    const lines = diagLines().join('\n');
    expect(lines).toContain('qwen-history');
    expect(lines).toContain('event=error');
    expect(lines).toContain('transport=xhr');
  });
});

describe('O-39-B X-R3: обработчики страницы живы поверх хука', () => {
  test('X-R3 onreadystatechange и addEventListener страницы вызываются в прежнем порядке', () => {
    const st = installStand({ xhr: {} });
    const seq = [];
    const xhr = historyXhr(st.xhr, URL_HISTORY, historyPayload());
    const pageRs = function () { seq.push('onreadystatechange'); };
    xhr.onreadystatechange = pageRs;
    xhr.addEventListener('readystatechange', function () { seq.push('rs-listener'); });
    xhr.addEventListener('loadend', function () { seq.push('page-loadend-1'); });
    xhr.addEventListener('loadend', function () { seq.push('page-loadend-2'); });
    xhr.send();

    expect(seq).toEqual(['onreadystatechange', 'rs-listener', 'page-loadend-1', 'page-loadend-2']);
    expect(xhr.onreadystatechange).toBe(pageRs);             // свойство страницы не подменено
    expect(xhr.onload).toBeNull();                           // onload страницы не трогаем
    expect(xhr.listeners.readystatechange).toHaveLength(1);  // чужих readystatechange нет
    expect(xhr.listeners.loadend).toHaveLength(3);           // 2 страницы + наш loadend
    expect(st.events).toHaveLength(1);                       // и история при этом дошла
    expect(st.events[0].messages[1].reasoning).toBe(REASONING);
  });
});

describe('O-39-B X-R4: гейт не влияет на байты; XHR и fetch дают один detail; соседи на месте', () => {
  test('X-R4 байты XHR-снимка вкл/выкл идентичны, detail = fetch-detail, наборы O-37/O-38/O-11/O-31', async () => {
    // (а) гейт ВЫКЛ: XHR-путь
    const off = installStand({ xhr: {} });
    const xhrOff = historyXhr(off.xhr, URL_HISTORY, historyPayload());
    xhrOff.send();
    expect(off.events).toHaveLength(1);
    expect(diagLines()).toEqual([]);                         // без aiCmDebug ни одной строки

    // (б) гейт ВКЛ: те же байты снимка + диагностика transport=xhr / transport=fetch
    jest.restoreAllMocks();
    sessionStorage.setItem('aiCmDebug', '1');
    const on = installStand({ xhr: {} });
    const xhrOn = historyXhr(on.xhr, URL_HISTORY, historyPayload());
    xhrOn.send();
    window.fetch(URL_HISTORY, { method: 'GET' });             // тот же payload: снимок уже тот же (signature)
    await settle(6);
    expect(on.events).toHaveLength(1);
    const lines = diagLines().join('\n');
    expect(lines).toContain('qwen-history');
    expect(lines).toContain('transport=xhr');
    expect(lines).toContain('transport=fetch');
    expect(JSON.parse(JSON.stringify(on.events[0]))).toEqual(JSON.parse(JSON.stringify(off.events[0])));

    // (в) fetch-путь на том же payload (отдельный стенд): detail байтово тот же, что у XHR.
    const fst = installStand({});
    window.fetch(URL_HISTORY, { method: 'GET' });
    await settle(6);
    expect(fst.events).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(fst.events[0]))).toEqual(JSON.parse(JSON.stringify(off.events[0])));

    // (г) соседние наборы исполняются в том же прогоне npm test.
    [
      'tests/qwen-reasoning-export-o37.test.js',
      'tests/qwen-container-drop-o37.test.js',
      'tests/o38-autoexport-once-latch.test.js',
      'tests/gsa-autoexport-o11-name-collision.test.js',
      'tests/gsa-o31-thread-segmentation.test.js'
    ].forEach(function (rel) {
      expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
    });
  });
});

describe('O-39-B X-S1: source-пины XHR-транспорта (fetch-ветка прежняя)', () => {
  test('X-S1 prototype open/send обёрнуты, loadend только addEventListener, ветки responseType, try/catch', () => {
    expect(INTERCEPT_SRC).toContain('XMLHttpRequest.prototype.open = function (method, url)');
    expect(INTERCEPT_SRC).toContain('XMLHttpRequest.prototype.send = function ()');

    // Код патча (без комментариев секции) — от проверки наличия XMLHttpRequest до SPA-секции.
    const patch = INTERCEPT_SRC.slice(
      INTERCEPT_SRC.indexOf("if (typeof XMLHttpRequest === 'function' && XMLHttpRequest.prototype) {"),
      INTERCEPT_SRC.indexOf('===== SPA: смена чата по pathname ====='));
    expect(patch.length).toBeGreaterThan(200);
    expect(patch).toContain('this.__aiCmQwenHist = null;');                    // сброс флага в open
    expect(patch).toContain("isQwenHistory(xUrl, xMethod)");
    expect(patch).toContain("diagTag('qwen-history', {");
    expect(patch).toContain("transport: 'xhr'");
    expect(patch).toContain("diagLine('skip-request', { reason: 'other-chat'");
    expect(patch).toContain("event: 'skip-request', reason: 'other-chat'");
    expect(patch).toContain("this.__aiCmQwenHist = { chatId: xChatId || currentChatId || '', url: xUrl, method: xMethod };");
    expect(patch).toContain("xSelf.addEventListener('loadend', function () {");
    expect(patch).toContain('if (xMeta) {');                                   // без флага XHR не трогаем
    // Наши слушатели — ТОЛЬКО addEventListener: onreadystatechange/readystatechange не используются.
    expect(patch).not.toContain('readystatechange');
    expect(patch).toContain('return origXHROpen.apply(this, arguments);');
    expect(patch).toContain('return origXHRSend.apply(this, arguments);');

    // Обработчик тела: try/catch вокруг ВСЕГО тела, ветки responseType, единый путь с fetch.
    const consume = fnDecl(INTERCEPT_SRC, 'consumeHistoryXhr');
    expect(consume).toMatch(/var m = meta \|\| \{\};\s*\n\s*try \{/);
    expect(consume).toContain('} catch (eXConsume) {');
    expect(consume).toContain("if (rt === '' || rt === 'text')");
    expect(consume).toContain("} else if (rt === 'json') {");
    expect(consume).toContain('payload = xhr.response;');
    expect(consume).toContain("payload = JSON.parse(String(raw == null ? '' : raw));");
    expect(consume).toContain("reason: 'no-json'");
    expect(consume).toContain("reason: 'response-type'");
    expect(consume).toContain("reason: 'body-unreadable'");
    expect(consume).toContain("event: 'error'");
    expect(consume).toContain('applyHistoryPayload(payload, { chatId: m.chatId, url: m.url });');
    // Порядок веток: responseText только для ''/text, json — из готового xhr.response.
    expect(consume.indexOf('xhr.responseText')).toBeLessThan(consume.indexOf("} else if (rt === 'json') {"));
    expect(consume.indexOf("} else if (rt === 'json') {")).toBeLessThan(consume.indexOf('payload = xhr.response;'));
  });

  test('X-S1 fetch-хук истории прежний: единственное изменение — поле transport в url-match', () => {
    const fetchRegion = INTERCEPT_SRC.slice(
      INTERCEPT_SRC.indexOf('===== Перехват fetch'),
      INTERCEPT_SRC.indexOf('===== Перехват XHR'));
    expect(fetchRegion.length).toBeGreaterThan(500);
    // Ровно одно поле transport во всей fetch-ветке — в строке url-match.
    expect((fetchRegion.match(/transport:/g) || [])).toHaveLength(1);
    expect(fetchRegion).toContain("event: 'url-match', method: method, url: url, transport: 'fetch'");
    // Байтово прежние опорные строки fetch-ветки истории (O-39 вариант B).
    expect(fetchRegion).toContain('try { histHit = isQwenHistory(url, method); } catch (eDetH) { histHit = false; }');
    expect(fetchRegion).toContain("histMeta = { chatId: histChatId || currentChatId || '', url: url };");
    expect(fetchRegion).toContain('if (currentChatId && histChatId && histChatId !== currentChatId) {');
    expect(fetchRegion).toContain("diagTag('qwen-history', { ts: Date.now(), event: 'skip-request', reason: 'other-chat', url: url });");
    expect(fetchRegion).toContain('consumeHistory(resp, histMeta);');
    expect(fetchRegion).toContain("diagTag('qwen-history', { ts: Date.now(), event: 'skip', reason: 'http', status: resp ? resp.status : 'none', url: histMeta.url || '' });");
    expect(fetchRegion).toContain('try { promise = originalFetch.apply(this, arguments); } catch (eCall) { return Promise.reject(eCall); }');
    // consumeHistory (fetch-ветка чтения тела) байтово прежний.
    const consume = fnDecl(INTERCEPT_SRC, 'consumeHistory');
    expect(consume).toContain('clone = resp.clone();');
    expect(consume).toContain('Promise.resolve(parsedPromise).then(function (payload) {');
    expect(consume).toContain("reason: 'clone-failed'");
    expect(consume).toContain("reason: 'json-error'");
    // SSE-ветка не тронута: единственный живой путь стрима.
    expect(INTERCEPT_SRC).toContain('consumeStream(resp, meta);');
  });
});
