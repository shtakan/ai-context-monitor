/**
 * core/qwen-intercept.js — MAIN-world перехватчик chat.qwen.ai (O-35, вариант A + C-lite).
 *
 * НАЗНАЧЕНИЕ: единственный источник ТОЧНЫХ токенов Qwen. Спека провайдера снята живым
 * сниффером (экспорт чата ai-context-monitor-deepseek-DeepSeek-R1-2026-09-18-17-53.txt):
 *   - POST https://chat.qwen.ai/api/v2/chat/completions?chat_id=<uuid> → SSE;
 *   - первый кадр: {"response.created":{chat_id,parent_id,response_id,response_index}};
 *   - контентные кадры: choices[0].delta{ phase, content, extra, status }:
 *       phase === 'thinking_summary' → extra.summary_thought.content[] — КУМУЛЯТИВНЫЙ массив
 *         (семантика REPLACE: 1 → 2 → 3… элементов; append дал бы размножение текста);
 *       phase === 'answer' (или отсутствует) → delta.content — APPEND по кускам;
 *   - usage в КАЖДОМ кадре и КУМУЛЯТИВНЫЙ (63 → 174 → 337 → 553 → 884): берём ПОСЛЕДНИЙ,
 *     суммировать нельзя. output_tokens ВКЛЮЧАЕТ reasoning_tokens
 *     (output_tokens_details.reasoning_tokens) — это отдельная цифра для тултипа.
 *
 * ТОЛЬКО ПЕРЕХВАТ НАТИВНЫХ ЗАПРОСОВ СТРАНИЦЫ:
 *   - антибот bx-ua/bx-umidtoken НЕ воспроизводится;
 *   - своих fetch к /api/v2/chats/new НЕТ (и вообще ни одного собственного сетевого вызова):
 *     перехватывается уже уходящий запрос страницы, поэтому все её заголовки/куки/антибот
 *     остаются родными (ровно этот путь рекомендован спекой как «самый надёжный»).
 *
 * РАЗБОР SSE — через utils/stream-frames.js (UMD-каркас frames/normUsage/mergeUsage);
 * формат [REASONING]/[ANSWER] — тот же контракт, что у DeepSeek (deepseek-intercept.js:543).
 *
 * ФОЛБЭК (прецедент claude-intercept.js:1481-1492 — clone() сломал чтение SSE страницей):
 *   читаем ТОЛЬКО при удачном clone(); если clone() бросил (или тело без getReader) —
 *   отвечаем «экспорт невозможен», НЕ трогая тело страницы (ответ возвращается как есть).
 *   После стрима тексты приходят из DOM-адаптера (adapters/qwen-adapter.js) — база не пустеет.
 *
 * O-39 (дефект C, вариант B): ПУТЬ ИСТОРИИ ЧАТА (SPA-переход/F5) — SSE нет вовсе, поэтому ни
 * text, ни reasoning хода не собираются, и в файле экспорта секции [REASONING] нет (в попапе
 * она есть: там источник — серверный usage). Перехватывается JSON-эндпоинт истории страницы:
 *   GET /api/v<NN>/chats/{id}?direction=up&limit=10   (application/json, измерено 2026-09-20 ~17:00);
 * reasoning в payload: content_list[] элемент phase='thinking_summary' (status='finished') →
 * extras.summary_thought.content[] — массив абзацев summary; там же role='assistant',
 * response_id и usage{input_tokens,output_tokens}. Парсер берёт ПЕРВОЕ thinking_summary-
 * вхождение (дубль каждого фрагмента в теле измеряется read-only строкой qwen-history-duplicate
 * под гейтом aiCmDebug и в текст НЕ попадает). Ходы собираются в ТО ЖЕ состояние turns и
 * публикуются ТЕМ ЖЕ emitSnapshot: detail.messages[].reasoning + секции [REASONING]/[ANSWER]
 * в тексте через composeTurnText — контракт файла ровно такой же, как у live-стрима.
 * Тело страницы не читается: только resp.clone().json(); сбой clone()/json() — тихий фолбэк
 * на DOM-базу (как в потоковой ветке: ответ возвращается странице как есть).
 *
 * O-39 (вариант B, XHR): живой прогон 2026-09-20 18:09-18:25 (чат 7fec9bd3) показал, что
 * история страницы уходит транспортом XHR (Network Type=xhr, инициатор jquery.min.js:1),
 * поэтому fetch-хук слеп. Тот же путь записи базы (parseQwenHistory → applyHistoryPayload)
 * поднят и на XMLHttpRequest: open помечает экземпляр истории, send вешает свой loadend через
 * addEventListener; тело берётся из responseText (responseType ''/text, JSON.parse) либо из
 * готового xhr.response (responseType 'json'). onreadystatechange страницы не перезаписывается,
 * XHR без флага не трогается вовсе, любое исключение внутри хука глушится.
 */
(function () {
  if (window.__aiCmQwenInterceptInstalled) return;
  window.__aiCmQwenInterceptInstalled = true;

  // ---- флаг «Подробные логи» из content.js (ISOLATED) — как у DeepSeek/Claude ----
  var DEBUG_LOGS = false;
  var GATE_SEEN = false;
  try {
    window.addEventListener('ai-cm-debug-logs', function (ev) {
      DEBUG_LOGS = !!(ev && ev.detail);
      GATE_SEEN = true;
      // O-35 (ДИАГНОСТИКА, только измерение): канон utils/debug.js получает флаг тем же
      // способом, что у шести существующих перехватчиков (claude-intercept.js:18 и др.) —
      // иначе aiCmDiagOn() в MAIN-мире не увидел бы чекбокс «Подробные логи» и канонический
      // принтер молчал бы при включённом гейте. Поведение продукта не меняется.
      try { if (typeof __aiCmSetDebugLogs === 'function') __aiCmSetDebugLogs(!!(ev && ev.detail)); } catch (eCanon) { }
      flushDiagRing();
    });
  } catch (eGate) { }

  var originalFetch = window.fetch;

  // ---- константы протокола ----
  var REASONING_TAG = '[REASONING]';
  var ANSWER_TAG = '[ANSWER]';
  var MODEL_DEFAULT = 'qwen3.8-max';           // id подтверждён в теле /chats/new (живой сниффер)
  var PHASE_THINKING = 'thinking_summary';
  var PHASE_ANSWER = 'answer';

  // ===== ДИАГНОСТИКА: строки ТОЛЬКО под гейтом aiCmDebug =====
  // Гейт — тот же, что у utils/debug.js: sessionStorage 'aiCmDebug' === '1' ИЛИ флаг
  // window.__aiCmDebugLogs (его присылает content.js событием 'ai-cm-debug-logs').
  // Пока гейт неизвестен (событие не пришло), строки копятся в маленьком кольце и
  // печатаются ТОЛЬКО если гейт в итоге оказался включён. Выключенный гейт → ни одной
  // новой строки и ноль влияния на байты/состояние (G1/G2).
  function diagOn() {
    try {
      if (typeof sessionStorage !== 'undefined' && sessionStorage &&
        sessionStorage.getItem('aiCmDebug') === '1') return true;
    } catch (eSess) { }
    return DEBUG_LOGS === true;
  }
  var DIAG_RING_MAX = 50;
  var diagRing = [];
  var diagLineCount = 0;
  // Исторические теги перехватчика: полный тег = 'qwen-' + tag. Форма вызова НЕ меняется —
  // она прошита пинами (tests/qwen-provider-wiring.test.js:214-229).
  function diagLine(tag, fields) { emitDiag('qwen-' + tag, fields); }
  // Строки с ПОЛНЫМ тегом (qwen-sse / qwen-spa / qwen-badge / qwen-adapter): префикс
  // 'qwen-' не добавляется, тег задан целиком. Гейт и кольцо — те же, что у diagLine.
  function diagTag(fullTag, fields) { emitDiag(fullTag, fields); }
  function emitDiag(fullTag, fields) {
    if (diagOn()) { printDiag(fullTag, fields); return; }
    if (GATE_SEEN) return;                       // гейт выключен — молчим
    try {
      diagRing.push([fullTag, fields]);
      if (diagRing.length > DIAG_RING_MAX) diagRing.shift();
    } catch (eRing) { }
  }
  function printDiag(fullTag, fields) {
    try {
      var f = fields || {};
      diagLineCount++;
      // Канон utils/debug.js:aiCmDiagLine (в MAIN-мир файл приходит первым —
      // core/background.js:173): тот же префикс '[AI CM][diag] ', та же форма k=v и тот же
      // гейт aiCmDebug. Хелпер может отсутствовать (срез-песочницы тестов) — тогда строчку
      // печатает локальный принтер в ТОЧНО таком же формате.
      if (typeof aiCmDiagLine === 'function') { aiCmDiagLine(fullTag, f); return; }
      var parts = [];
      for (var k in f) {
        if (!Object.prototype.hasOwnProperty.call(f, k)) continue;
        var v = f[k];
        parts.push(k + '=' + ((v === undefined || v === null) ? '(нет)' : String(v)));
      }
      console.log('[AI CM][diag] ' + fullTag + ' ' + parts.join(' '));
    } catch (ePrint) { }
  }
  function flushDiagRing() {
    if (!diagOn()) { diagRing = []; return; }
    try {
      for (var i = 0; i < diagRing.length; i++) printDiag(diagRing[i][0], diagRing[i][1]);
    } catch (eFlush) { }
    diagRing = [];
  }
  // URL документа одной строкой (диагностика точек смены чата/записи базы).
  function diagUrl() {
    try { return String((typeof location !== 'undefined' && location && location.href) || ''); } catch (eU) { return ''; }
  }

  // ===== URL-детект (приоритет qwen > openai: см. tests/qwen-*.test.js, пин D7) =====
  function urlOf(input) {
    try {
      if (typeof input === 'string') return input;
      if (input && typeof input.url === 'string') return input.url;
    } catch (eUrl) { }
    return '';
  }
  function methodOf(init, input) {
    try {
      if (init && init.method) return String(init.method).toUpperCase();
      if (input && typeof input.method === 'string') return String(input.method).toUpperCase();
    } catch (eM) { }
    return 'GET';
  }
  // Qwen-эндпоинт: /api/v2/chat/completions (версия — любая v<N>).
  // HYPOTHESIS: форма пути подтверждена живым сниффером 2026-09-18 для /api/v2/…
  var QWEN_COMPLETIONS_RE = /\/api\/v\d+\/chat\/completions(\?|$|\/)/;
  function isQwenCompletions(url, method) {
    if (method !== 'POST') return false;
    return QWEN_COMPLETIONS_RE.test(url);
  }

  // ---- O-39: эндпоинт ИСТОРИИ чата (JSON, не SSE) ----
  // Измерено 2026-09-20 ~17:00 (PROJECT_HANDOFF, O-39): GET /api/v2/chats/{id}?direction=up&limit=10,
  // application/json. Reasoning в payload: content_list[] элемент phase='thinking_summary'
  // (status='finished') → extras.summary_thought.content = массив абзацев summary. Здесь только
  // матчер и id чата; разбор payload — parseQwenHistory ниже.
  var QWEN_HISTORY_RE = /\/api\/v\d+\/chats\/([A-Za-z0-9_-]+)(?:[?#]|$)/;
  // Служебные сегменты того же префикса (POST /chats/new — создание чата) историей не являются:
  // GET-матчер их и так не увидит, но id-литерал исключаем явно — «шестой чат» не должен
  // подменить базу снимком создания чата.
  var QWEN_HISTORY_NOT_ID = { 'new': true, 'list': true, 'folders': true, 'tags': true, 'models': true };
  function isQwenHistory(url, method) {
    if (method !== 'GET') return false;
    var id = historyChatIdFromUrl(url);
    return !!id && QWEN_HISTORY_NOT_ID[id] !== true;
  }
  function historyChatIdFromUrl(url) {
    try {
      var m = QWEN_HISTORY_RE.exec(String(url || ''));
      if (m && m[1]) return decodeURIComponent(m[1]);
    } catch (eQh) { }
    return '';
  }

  function chatIdFromUrl(url) {
    try {
      var m = /[?&]chat_id=([^&]+)/.exec(url);
      if (m) return decodeURIComponent(m[1]);
    } catch (eQ) { }
    return '';
  }
  function chrOf(url) {
    try {
      var m = /\/c\/([A-Za-z0-9_-]+)/.exec(String(location.pathname || ''));
      if (m) return m[1];
    } catch (eC) { }
    return '';
  }
  // Текущий чат: id из пути /c/<id> (SPA-адрес) либо из query последнего запроса страницы.
  var currentChatId = chrOf();
  var lastReqChatId = '';

  // ===== Состояние разбора одного потока =====
  var sse = null;                 // активный стрим или null
  var turns = [];                 // assistant-ходы: [{key, order, model, answer, reasoning, text, userKey}]
  var userTurns = [];             // user-ходы: [{key, text}] — пары по parentId/fid запроса
  var turnSeq = 0;
  var dispatchSig = null;
  var lastDispatchResult = false;

  function beginStream(meta) {
    sse = {
      chatId: meta.chatId || '',
      url: meta.url || '',        // только для диагностики qwen-sse (в detail не уходит)
      userPrompt: meta.userPrompt || '',
      userKey: meta.userKey || '',
      parentId: meta.parentId || '',
      model: meta.model || '',
      responseId: '',
      reasoning: '',
      answer: '',
      usage: null,                // нормализованный, кумулятивный → mergeUsage(prev,next,true)
      rawUsage: null,             // последний сырой usage-объект кадра (для серверных полей)
      usageFrames: 0,
      frames: 0,
      reasoningFrames: 0,
      answerFrames: 0,
      ended: false,
      finished: false
    };
  }

  // ===== Приёмка кадра =====
  function applyMeta(obj) {
    if (!sse) return;
    var meta = obj['response.created'];
    if (!meta || typeof meta !== 'object') return;
    if (typeof meta.response_id === 'string' && meta.response_id) sse.responseId = meta.response_id;
    if (typeof meta.chat_id === 'string' && meta.chat_id) sse.chatId = meta.chat_id;
    if (typeof meta.parent_id === 'string') sse.parentId = meta.parent_id;
    diagLine('response-created', {
      chat: String(sse.chatId || '').slice(0, 8),
      response: String(sse.responseId || '').slice(0, 8),
      parent: String(sse.parentId || '').slice(0, 8)
    });
  }

  function applyUsage(obj) {
    if (!sse || !obj || !obj.usage || typeof obj.usage !== 'object') return;
    var SF = (typeof window !== 'undefined' && window.aiCmStreamFrames) ? window.aiCmStreamFrames : null;
    var next = SF && typeof SF.normUsage === 'function' ? SF.normUsage(obj.usage) : null;
    if (!next) return;
    // КУМУЛЯТИВНЫЙ usage Qwen: cumulative=true → ПЕРЕЗАПИСЬ последним кадром.
    // Сумма 63+174+337+553+884 = 2011 — неверно (антипод-пин D4).
    sse.usage = (SF && typeof SF.mergeUsage === 'function')
      ? SF.mergeUsage(sse.usage, next, true)
      : next;
    sse.rawUsage = obj.usage;
    sse.usageFrames++;
    diagLine('usage', {
      frame: sse.usageFrames,
      input: next.input, output: next.output, total: next.total,
      reasoning: next.reasoning, cached: next.cached
    });
  }

  function applyDelta(obj) {
    if (!sse) return;
    var choices = obj.choices;
    var d = (choices && choices[0] && choices[0].delta) ? choices[0].delta : null;
    if (!d || typeof d !== 'object') return;
    if (d.phase === PHASE_THINKING) {
      var extra = d.extra;
      var thought = extra && extra.summary_thought ? extra.summary_thought.content : null;
      if (Array.isArray(thought)) {
        // REPLACE, НЕ append: массив кумулятивный (1 → 2 → 3… элементов).
        sse.reasoning = thought.join('');
        sse.reasoningFrames++;
        diagLine('reasoning-replace', { items: thought.length, len: sse.reasoning.length });
      }
      return;
    }
    // phase === 'answer' (или фаза не указана — спека допускает оба варианта)
    if (typeof d.content === 'string' && d.content) {
      sse.answer += d.content;                 // APPEND
      sse.answerFrames++;
    }
  }

  function feedFrame(f) {
    if (!sse || f.data == null) return;
    var raw = String(f.data).trim();
    if (!raw) return;
    if (raw === '[DONE]') { endStream('done-marker'); return; }
    var obj = null;
    try { obj = JSON.parse(raw); } catch (eParse) { return; }
    if (!obj || typeof obj !== 'object') return;
    sse.frames++;
    applyMeta(obj);
    applyUsage(obj);
    applyDelta(obj);
  }

  // ---- чтение потока: ТОЛЬКО через clone(); фолбэк без чтения тела ----
  // Утилита разрешается ЛЕНИВО на каждом кадре: порядок двух MAIN-скриптов
  // (utils/stream-frames.js и core/qwen-intercept.js) в js[] не должен быть критичен.
  function streamFrames() {
    try {
      var api = (typeof window !== 'undefined') ? window.aiCmStreamFrames : null;
      return (api && typeof api.frames === 'function') ? api : null;
    } catch (eSf) { return null; }
  }

  function consumeStream(resp, meta) {
    beginStream(meta);
    diagLine('consume-enter', { chat: String(meta.chatId || '').slice(0, 8) });
    if (!streamFrames()) {
      // Утилита не подключена вовсе — тихо: DOM-фолбэк (база не пустеет).
      diagLine('stream-skip', { reason: 'stream-frames-missing', fallback: 'dom' });
      sse = null;
      return;
    }
    var clone = null;
    try { clone = resp.clone(); } catch (eClone) { clone = null; }
    if (!clone) {
      // ФОЛБЭК (прецедент claude-intercept.js:1481-1492): клонирование недоступно —
      // тело страницы НЕ трогаем вовсе (никаких text()/Response()/reader'ов). Экспорт
      // получит DOM-базу из adapters/qwen-adapter.js.
      diagLine('stream-skip', { reason: 'clone-failed', fallback: 'dom' });
      sse = null;
      return;
    }
    if (!clone.body || typeof clone.body.getReader !== 'function') {
      diagLine('stream-skip', { reason: 'no-reader', fallback: 'dom' });
      sse = null;
      return;
    }
    Promise.resolve()
      .then(function () { return readFrames(clone); })
      .then(function () { endStream('body-end'); })
      .catch(function (eRead) {
        diagLine('stream-error', { err: String(eRead && eRead.message || eRead).slice(0, 80) });
        endStream('read-error');
      });
  }

  function readFrames(resp) {
    var api = streamFrames();
    if (!api) return Promise.resolve();
    var iterator = api.frames(resp);
    if (!iterator || typeof iterator.next !== 'function') return Promise.resolve();
    var stopped = false;
    function step() {
      if (stopped) return Promise.resolve();
      return iterator.next().then(function (r) {
        if (!r || r.done) return;
        feedFrame(r.value);
        // Терминальный маркер потока ([DONE]): дальше кадры не нужны, чтение прекращаем —
        // у итератора вызывается return(), тело не «течёт» зря (страница читает свой клон).
        if (sse === null || (sse && sse.ended)) {
          stopped = true;
          if (typeof iterator.return === 'function') { try { iterator.return(); } catch (eRet) { } }
          return;
        }
        return step();
      });
    }
    return step();
  }

  // ===== Завершение потока (идемпотентно — пин D6) =====
  function endStream(reason) {
    if (!sse || sse.ended) return;
    sse.ended = true;
    var s = sse;
    sse = null;
    diagLine('stream-end', {
      reason: reason,
      frames: s.frames, answerFrames: s.answerFrames, reasoningFrames: s.reasoningFrames,
      answerLen: s.answer.length, reasoningLen: s.reasoning.length
    });
    // O-35 (ДИАГНОСТИКА, только измерение): qwen-sse — итог разбора потока: сколько кадров
    // принято, был ли в них usage и какое серверное число из него вышло (это ровно то число,
    // которое уедет в detail.serverTokens → netServerTokens).
    diagTag('qwen-sse', {
      ts: Date.now(), event: 'stream-end', reason: reason, url: s.url || '',
      frames: s.frames, usageFrames: s.usageFrames,
      hasUsage: (s.usage && typeof s.usage.input === 'number') ? 1 : 0,
      serverTokens: (s.usage && typeof s.usage.input === 'number') ? s.usage.input : 0,
      output: (s.usage && typeof s.usage.output === 'number') ? s.usage.output : 0,
      total: (s.usage && typeof s.usage.total === 'number') ? s.usage.total : 0,
      reasoning: (s.usage && typeof s.usage.reasoning === 'number') ? s.usage.reasoning : 0
    });
    if (!s.answer && !s.reasoning) {
      // Пустой поток (обрыв/ретрай/не тот чат): состояние ходов не меняем.
      diagLine('emit-skip', { reason: 'empty-stream' });
      return;
    }
    try { recordTurn(s); } catch (eRec) {
      diagLine('record-error', { err: String(eRec && eRec.message || eRec).slice(0, 80) });
      return;
    }
    emitSnapshot(s);
  }

  function composeTurnText(answer, reasoning) {
    if (!reasoning) return answer;
    return REASONING_TAG + '\n' + reasoning + '\n\n' + ANSWER_TAG + '\n' + answer;
  }

  function recordTurn(s) {
    var chatId = s.chatId || lastReqChatId || currentChatId || '';
    var userKey = s.userKey || (s.parentId ? ('p:' + s.parentId) : '');
    if (s.userPrompt && userKey) {
      var known = false;
      for (var u = 0; u < userTurns.length; u++) {
        if (userTurns[u].key === userKey) { known = true; break; }
      }
      if (!known) userTurns.push({ key: userKey, text: s.userPrompt });
    }
    var key = s.responseId || (chatId + '#' + turnSeq);
    turnSeq++;
    var existing = null;
    for (var i = 0; i < turns.length; i++) {
      if (turns[i].key === key) { existing = turns[i]; break; }
    }
    var model = s.model || MODEL_DEFAULT;
    if (existing) {
      existing.answer = s.answer;
      existing.reasoning = s.reasoning;
      existing.text = composeTurnText(s.answer, s.reasoning);
      existing.userKey = existing.userKey || userKey;
      return;
    }
    turns.push({
      key: key,
      order: turns.length,
      model: model,
      userKey: userKey,
      answer: s.answer,
      reasoning: s.reasoning,
      text: composeTurnText(s.answer, s.reasoning)
    });
  }

  // =====================================================================================
  // O-39: ПАРСЕР ИСТОРИИ (JSON-ветка). Единственный источник reasoning на пути истории:
  // SSE на SPA-переходе/F5 нет вовсе, поэтому ходы собираются из payload эндпоинта истории.
  // Форма (измерена): узел-сообщение = { role, content_list:[ {phase, status, extras} ], usage,
  // response_id }. Reasoning — extras.summary_thought.content[] ПЕРВОГО phase='thinking_summary'
  // элемента (абзацы склеиваются через '\n\n'); response — content не-thinking элементов (APPEND,
  // как delta.content живого стрима). Дубль в теле (каждый фрагмент встречается дважды) в текст
  // НЕ попадает: побеждает первое вхождение, факт дубля уходит read-only строкой
  // qwen-history-duplicate (под гейтом aiCmDebug) — это ИЗМЕРЕНИЕ, а не ветка поведения.
  // =====================================================================================
  function contentListOf(node) {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node.content_list)) return node.content_list;
    if (Array.isArray(node.contentList)) return node.contentList;
    return null;
  }
  // Узел-сообщение истории: роль хода И содержимое (content_list[] либо строковый content/text).
  function isHistoryMessageNode(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    var role = node.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') return false;
    var list = contentListOf(node);
    if (list && list.length) return true;
    return typeof node.content === 'string' || typeof node.text === 'string';
  }
  // Обход payload: сообщения собираются в порядке ПОЯВЛЕНИЯ (порядок ключей JSON сохраняется).
  // Повторный обход той же ссылки не выполняется (защита от цикла и от общего поддерева).
  function walkHistoryMessages(node, out, depth, visited) {
    if (!node || typeof node !== 'object' || depth > 12) return;
    for (var v = 0; v < visited.length; v++) { if (visited[v] === node) return; }
    visited.push(node);
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) walkHistoryMessages(node[i], out, depth + 1, visited);
      return;
    }
    if (isHistoryMessageNode(node)) out.push(node);
    for (var key in node) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
      var child = node[key];
      if (child && typeof child === 'object') walkHistoryMessages(child, out, depth + 1, visited);
    }
  }
  function historyMessageId(node, role) {
    if (!node || typeof node !== 'object') return '';
    // У хода пользователя «свой» идентификатор запроса (fid — тот же ключ, что у live-хода:
    // meta.userKey собирается из payload.messages[].fid), у ответа — response_id (key хода).
    var keys = (role === 'user')
      ? ['fid', 'id', 'message_id', 'msg_id', 'uuid']
      : ['response_id', 'responseId', 'message_id', 'msg_id', 'uuid', 'id', 'fid'];
    for (var i = 0; i < keys.length; i++) {
      var v = node[keys[i]];
      if (typeof v === 'string' && v) return v;
      if (typeof v === 'number') return String(v);
    }
    return '';
  }
  // ПЕРВОЕ thinking_summary-вхождение списка (спека O-39 п.5) + счётчик ВСЕХ вхождений: второе
  // в текст не идёт — это и есть граница «дубль reasoning в payload» (измеряется read-only).
  // Уточнение первого вхождения: берётся первое вхождение, у которого ЕСТЬ текст (в истории
  // рядом с status='finished' встречается служебная запись с пустым summary_thought — терять
  // из-за неё размышление нельзя); если текста нет ни у одного — первое вхождение как есть.
  function thinkingTextOf(item) {
    var extras = item.extras || item.extra || null;
    var thought = extras && extras.summary_thought ? extras.summary_thought.content : null;
    if (Array.isArray(thought)) {
      var parts = [];
      for (var j = 0; j < thought.length; j++) {
        var p = thought[j];
        if (typeof p === 'string' && p) parts.push(p);
        else if (p && typeof p === 'object' && typeof p.content === 'string' && p.content) parts.push(p.content);
      }
      return parts.join('\n\n');           // абзацы summary — разделитель '\n\n' (спека O-39 п.2)
    }
    if (typeof thought === 'string' && thought) return thought;
    // Фолбэк: у thinking_summary-элемента нет extras.summary_thought.content. Только здесь
    // читаем item.content — иначе один и тот же текст склеился бы сам с собой (граница «дубль»).
    if (typeof item.content === 'string' && item.content) return item.content;
    return '';
  }
  function historyThinkingOf(list) {
    var first = null;
    var firstWithText = '';
    var occurrences = 0;
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item || typeof item !== 'object') continue;
      if (item.phase !== PHASE_THINKING) continue;
      occurrences++;
      if (!first) first = item;
      if (!firstWithText) firstWithText = thinkingTextOf(item);
    }
    if (!first) return { text: '', occurrences: 0 };
    return { text: firstWithText || thinkingTextOf(first), occurrences: occurrences };
  }
  // Ответ хода истории: не-thinking элементы content_list клеятся APPEND (как delta.content SSE).
  function historyAnswerOf(list) {
    var out = '';
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item || typeof item !== 'object') continue;
      if (item.phase === PHASE_THINKING) continue;
      if (typeof item.content === 'string' && item.content) out += item.content;
    }
    return out;
  }
  // usage хода истории (спека: usage{input_tokens,output_tokens}) — та же нормализация, что у
  // кадров стрима (utils/stream-frames.js:normUsage); утилиты нет — читаем измеренные поля сами.
  function historyUsageOf(node) {
    var raw = (node && node.usage && typeof node.usage === 'object') ? node.usage : null;
    if (!raw) return null;
    var SF = (typeof window !== 'undefined' && window.aiCmStreamFrames) ? window.aiCmStreamFrames : null;
    var norm = (SF && typeof SF.normUsage === 'function') ? SF.normUsage(raw) : null;
    if (norm) return norm;
    return {
      input: (typeof raw.input_tokens === 'number') ? raw.input_tokens : null,
      output: (typeof raw.output_tokens === 'number') ? raw.output_tokens : null,
      total: (typeof raw.total_tokens === 'number') ? raw.total_tokens : null,
      reasoning: null,
      cached: null
    };
  }
  function historyChatIdOf(node) {
    if (!node || typeof node !== 'object') return '';
    var keys = ['chat_id', 'chatId'];
    for (var i = 0; i < keys.length; i++) {
      if (typeof node[keys[i]] === 'string' && node[keys[i]]) return node[keys[i]];
    }
    return '';
  }
  // chat_id может лежать и на верхнем уровне payload, и внутри вложенной обёртки — ограниченный
  // обход в глубину (URL даёт id в любом случае: historyChatIdFromUrl).
  function findHistoryChatId(node, depth, visited) {
    if (!node || typeof node !== 'object' || depth > 4) return '';
    for (var v = 0; v < visited.length; v++) { if (visited[v] === node) return ''; }
    visited.push(node);
    var direct = historyChatIdOf(node);
    if (direct) return direct;
    for (var key in node) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
      var child = node[key];
      if (child && typeof child === 'object') {
        var found = findHistoryChatId(child, depth + 1, visited);
        if (found) return found;
      }
    }
    return '';
  }
  /**
   * payload истории → { chatId, messages[], nodes, duplicates, thinkingDuplicates, reasoningMessages }.
   * messages[] — ходы role user/assistant в порядке появления; повтор узла с тем же id
   * отбрасывается (первое вхождение побеждает — спека O-39 п.5).
   */
  function parseQwenHistory(payload) {
    var nodes = [];
    try { walkHistoryMessages(payload, nodes, 0, []); } catch (eWalk) { nodes = []; }
    var messages = [];
    var seen = {};
    var chatId = '';
    var duplicates = 0;
    var thinkingDuplicates = 0;
    var reasoningMessages = 0;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var role = (node.role === 'user') ? 'user' : ((node.role === 'assistant') ? 'assistant' : '');
      if (!role) continue;
      if (!chatId) chatId = historyChatIdOf(node);
      var list = contentListOf(node) || [];
      var thinking = historyThinkingOf(list);
      if (thinking.occurrences > 1) thinkingDuplicates++;
      var text = historyAnswerOf(list);
      if (!text && typeof node.content === 'string') text = node.content;
      if (!text && typeof node.text === 'string') text = node.text;
      var id = historyMessageId(node, role);
      var dedupeKey = id || (role + '\u0000' + text + '\u0000' + thinking.text);
      if (seen[dedupeKey] === 1) { duplicates++; continue; }   // первое вхождение побеждает
      seen[dedupeKey] = 1;
      if (thinking.text) reasoningMessages++;
      messages.push({
        key: id,
        role: role,
        text: text,
        reasoning: thinking.text,
        usage: historyUsageOf(node),
        model: (typeof node.model === 'string') ? node.model : '',
        parentId: (typeof node.parent_id === 'string') ? node.parent_id
          : ((typeof node.parentId === 'string') ? node.parentId : '')
      });
    }
    if (!chatId) chatId = findHistoryChatId(payload, 0, []) || '';
    return {
      chatId: chatId,
      messages: messages,
      nodes: nodes.length,
      duplicates: duplicates,
      thinkingDuplicates: thinkingDuplicates,
      reasoningMessages: reasoningMessages
    };
  }

  // Ходы истории → то же состояние turns (recordTurn) и ТОТ ЖЕ снимок (emitSnapshot): reasoning
  // уезжает в detail.messages[].reasoning и в текст хода секциями [REASONING]/[ANSWER].
  // usage для снимка — usage ПОСЛЕДНЕГО assistant-хода (как у стрима: последний кумулятивный).
  function applyHistoryPayload(payload, meta) {
    var m = meta || {};
    var parsed = parseQwenHistory(payload);
    if (!parsed.messages.length) {
      diagTag('qwen-history', { ts: Date.now(), event: 'skip', reason: 'no-messages', url: m.url || '' });
      return false;
    }
    var chatId = m.chatId || parsed.chatId || currentChatId || lastReqChatId || '';
    if (chatId) {
      lastReqChatId = chatId;
      if (!currentChatId) currentChatId = chatId;
    }
    if (currentChatId && m.chatId && m.chatId !== currentChatId) {
      // История ДРУГОГО чата (SPA-переход): в текущую базу не подмешивается — та же граница,
      // что у потоковой ветки (skip-request reason=other-chat).
      diagLine('skip-request', { reason: 'other-chat', req: String(m.chatId).slice(0, 8) });
      diagTag('qwen-history', { ts: Date.now(), event: 'skip', reason: 'other-chat', url: m.url || '' });
      return false;
    }
    var pendingUserKey = '';
    var pendingUserText = '';
    var lastUsage = null;
    var lastResponseId = '';
    var lastModel = '';
    var applied = 0;
    for (var i = 0; i < parsed.messages.length; i++) {
      var msg = parsed.messages[i];
      if (msg.role === 'user') {
        pendingUserKey = msg.key || ('h:u:' + i);
        pendingUserText = msg.text || '';
        continue;
      }
      if (msg.role !== 'assistant') continue;
      if (!msg.text && !msg.reasoning) continue;    // пустой ход в базу не пишется (как empty-stream)
      if (msg.usage) lastUsage = msg.usage;
      if (msg.key) lastResponseId = msg.key;
      if (msg.model) lastModel = msg.model;
      recordTurn({
        chatId: chatId,
        url: m.url || '',
        // responseId — ключ хода (как у стрима: response.created.response_id).
        responseId: msg.key || '',
        userPrompt: pendingUserText,
        userKey: pendingUserKey || (msg.key ? ('h:' + msg.key) : ('h:a:' + i)),
        parentId: msg.parentId || '',
        model: msg.model || '',
        reasoning: msg.reasoning || '',
        answer: msg.text || '',
        usage: msg.usage || null,
        rawUsage: null,
        usageFrames: msg.usage ? 1 : 0,
        frames: 1,
        reasoningFrames: msg.reasoning ? 1 : 0,
        answerFrames: msg.text ? 1 : 0,
        ended: true,
        finished: true
      });
      applied++;
    }
    if (!applied) {
      diagTag('qwen-history', { ts: Date.now(), event: 'skip', reason: 'no-turns', url: m.url || '' });
      return false;
    }
    // Дубль reasoning в payload — ИЗМЕРЕНИЕ, не поведение: парсер уже взял первое вхождение,
    // второй копии в тексте нет. Строка живёт только под гейтом aiCmDebug (канон diagTag).
    if (parsed.duplicates > 0 || parsed.thinkingDuplicates > 0) {
      diagTag('qwen-history-duplicate', {
        ts: Date.now(), event: 'duplicate', url: m.url || '',
        messages: parsed.duplicates, thinking: parsed.thinkingDuplicates,
        nodes: parsed.nodes, taken: 'first'
      });
    }
    var emitted = emitSnapshot({
      chatId: chatId,
      url: m.url || '',
      model: lastModel,
      responseId: lastResponseId,
      usage: lastUsage,
      rawUsage: null,
      frames: applied,
      usageFrames: lastUsage ? 1 : 0,
      reasoningFrames: 0,
      answerFrames: 0,
      reasoning: '',
      answer: '',
      ended: true,
      finished: true
    });
    diagTag('qwen-history', {
      ts: Date.now(), event: 'emit', url: m.url || '', chat: String(chatId || '').slice(0, 8),
      nodes: parsed.nodes, messages: parsed.messages.length, turns: applied,
      reasonings: parsed.reasoningMessages, duplicates: parsed.duplicates,
      thinking: parsed.thinkingDuplicates,
      hasUsage: (lastUsage && typeof lastUsage.input === 'number') ? 1 : 0,
      serverTokens: (lastUsage && typeof lastUsage.input === 'number') ? lastUsage.input : 0,
      emitted: emitted ? 1 : 0
    });
    return emitted;
  }

  // ---- O-39: чтение истории — ТОЛЬКО через clone() (тело страницы не трогаем) ----
  // Тело истории — JSON: resp.clone().json() (эквивалент потоковой ветки с clone()): страница
  // читает свой ответ, мы — свой клон. Сбой clone()/json() — тихий фолбэк на DOM-базу.
  function consumeHistory(resp, meta) {
    var clone = null;
    try { clone = resp.clone(); } catch (eClone) { clone = null; }
    if (!clone) {
      diagTag('qwen-history', { ts: Date.now(), event: 'skip', reason: 'clone-failed', url: meta.url || '' });
      return;
    }
    var parsedPromise = null;
    try {
      if (typeof clone.json === 'function') parsedPromise = clone.json();
      else if (typeof clone.text === 'function') {
        parsedPromise = clone.text().then(function (t) { return JSON.parse(String(t == null ? '' : t)); });
      }
    } catch (eJson) { parsedPromise = null; }
    if (!parsedPromise || typeof parsedPromise.then !== 'function') {
      diagTag('qwen-history', { ts: Date.now(), event: 'skip', reason: 'no-json', url: meta.url || '' });
      return;
    }
    Promise.resolve(parsedPromise).then(function (payload) {
      try {
        applyHistoryPayload(payload, meta);
      } catch (eApply) {
        diagTag('qwen-history', {
          ts: Date.now(), event: 'error', url: meta.url || '',
          err: String(eApply && eApply.message || eApply).slice(0, 80)
        });
      }
    }, function (eRead) {
      diagTag('qwen-history', {
        ts: Date.now(), event: 'skip', reason: 'json-error', url: meta.url || '',
        err: String(eRead && eRead.message || eRead).slice(0, 80)
      });
    });
  }

  // ---- O-39 (вариант B, XHR-транспорт): чтение истории из XMLHttpRequest ----
  // Живой прогон 2026-09-20 18:09-18:25 (чат 7fec9bd3): Network Type=xhr,
  // Initiator jquery.min.js:1 — история ходит ЧЕРЕЗ XHR, и fetch-хук её не видит вовсе.
  // Поэтому тот же контракт поднимается на XHR-транспорт: тела страницы не трогаем,
  // читаем УЖЕ готовое (responseText/response), своих запросов не делаем.
  // Любое исключение здесь ловится и глушится: ответ, статус, события и порядок
  // колбэков страницы не меняются.
  function consumeHistoryXhr(xhr, meta) {
    var m = meta || {};
    try {
      var status = 0;
      try { status = Number(xhr.status) || 0; } catch (eXSt) { status = 0; }
      if (status && (status < 200 || status >= 300)) {
        diagLine('response-skip', { reason: 'http', status: status });
        diagTag('qwen-history', {
          ts: Date.now(), event: 'skip', reason: 'http', status: status,
          url: m.url || '', transport: 'xhr'
        });
        return;
      }
      var rt = '';
      try { rt = (xhr.responseType == null) ? '' : String(xhr.responseType); } catch (eXRt) { rt = ''; }
      var payload = null;
      if (rt === '' || rt === 'text') {
        var raw = '';
        try { raw = xhr.responseText; } catch (eXBody) {
          diagTag('qwen-history', {
            ts: Date.now(), event: 'skip', reason: 'body-unreadable', url: m.url || '', transport: 'xhr'
          });
          return;
        }
        try {
          payload = JSON.parse(String(raw == null ? '' : raw));
        } catch (eXParse) {
          diagLine('response-error', { err: String(eXParse && eXParse.message || eXParse).slice(0, 80) });
          diagTag('qwen-history', {
            ts: Date.now(), event: 'error', url: m.url || '', transport: 'xhr',
            err: String(eXParse && eXParse.message || eXParse).slice(0, 80)
          });
          return;
        }
      } else if (rt === 'json') {
        // responseText при responseType='json' не читается (в браузере/ jsdom бросает
        // InvalidStateError): тело уже разобрано движком — берём готовый объект xhr.response.
        try { payload = xhr.response; } catch (eXJson) { payload = null; }
        if (payload === null || payload === undefined) {
          diagTag('qwen-history', {
            ts: Date.now(), event: 'skip', reason: 'no-json', url: m.url || '', transport: 'xhr'
          });
          return;
        }
      } else {
        // Прочие responseType (blob/arraybuffer/document/stream) — тихий skip: истории там нет.
        diagTag('qwen-history', {
          ts: Date.now(), event: 'skip', reason: 'response-type', responseType: rt,
          url: m.url || '', transport: 'xhr'
        });
        return;
      }
      // ТОТ ЖЕ путь, что у fetch-ветки (consumeHistory → applyHistoryPayload): парсер не дублируется.
      applyHistoryPayload(payload, { chatId: m.chatId, url: m.url });
    } catch (eXConsume) {
      diagTag('qwen-history', {
        ts: Date.now(), event: 'error', url: m.url || '', transport: 'xhr',
        err: String(eXConsume && eXConsume.message || eXConsume).slice(0, 80)
      });
    }
  }

  // ===== EMIT: контракт ai-cm-full-history (как у DeepSeek, только нужные Qwen поля) =====
  function buildSignature(serverTokens) {
    try {
      var parts = [String(currentChatId || ''), String(turns.length), String(serverTokens || 0)];
      for (var i = 0; i < turns.length; i++) {
        var t = turns[i];
        parts.push(t.key + ':' + t.userKey + ':' + t.order + ':' +
          (t.text || '').length + ':' + (t.reasoning || '').length);
      }
      return parts.join('|');
    } catch (eSig) { return null; }
  }

  function userTextOf(key) {
    if (!key) return '';
    for (var i = 0; i < userTurns.length; i++) {
      if (userTurns[i].key === key) return userTurns[i].text;
    }
    return '';
  }

  function emitSnapshot(s) {
    var usage = s.usage || {};
    var serverTokens = (typeof usage.input === 'number' && usage.input > 0) ? usage.input : 0;
    var sig = buildSignature(serverTokens);
    if (sig !== null && dispatchSig !== null && sig === dispatchSig) {
      diagLine('emit-skip', { reason: 'same-signature' });
      return lastDispatchResult;
    }
    var pieces = [];
    var messages = [];
    var reasonings = [];
    var ids = [];
    var reasoningTurns = 0;
    var lastModel = '';
    for (var i = 0; i < turns.length; i++) {
      var t = turns[i];
      var userText = userTextOf(t.userKey);
      if (userText) {
        pieces.push(userText);
        ids.push('u:' + t.userKey);
        messages.push({ role: 'user', text: userText, reasoning: '' });
        reasonings.push('');
      }
      pieces.push(t.text);
      ids.push(t.key);
      var msg = { role: 'assistant', text: t.text, reasoning: t.reasoning || '' };
      // hiddenReasoning — та же пометка, что у DeepSeek: сырой режим экспорта
      // (utils/export-emit-pipeline.js:includeHiddenExportBlocks) читает её,
      // обычный режим урезает секции до [ANSWER] (stripReasoningSections).
      if (t.reasoning) { msg.hiddenReasoning = t.reasoning; reasoningTurns++; }
      messages.push(msg);
      reasonings.push(t.reasoning || '');
      if (t.model) lastModel = t.model;
    }
    var text = pieces.join('\n');
    if (!text) { diagLine('emit-skip', { reason: 'empty-text' }); return false; }
    var detail = {
      convId: currentChatId || lastReqChatId || '',
      text: text,
      count: pieces.length,
      lastMessageText: pieces.length ? pieces[pieces.length - 1] : '',
      modelSlug: lastModel || MODEL_DEFAULT,
      messageTexts: pieces,
      messageIds: ids,
      messages: messages,
      reasoningTexts: reasonings,
      reasoningTurns: reasoningTurns,
      attachTokens: 0,
      attachBreak: { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 },
      // Живой SSE — авторитетный серверный источник: база полная по построению
      // (страница прислала ровно тот ход, который показан в UI).
      historyComplete: true,
      reachedRoot: true,
      baseEmpty: false,
      serverTokens: serverTokens,
      // O-35: поля серверного usage Qwen — тултип берёт их как источник истины.
      // output ВКЛЮЧАЕТ reasoning (output_tokens_details.reasoning_tokens), поэтому
      // reasoningTokens идёт отдельной строкой и поясняет состав output.
      qwenUsage: {
        inputTokens: (typeof usage.input === 'number') ? usage.input : 0,
        outputTokens: (typeof usage.output === 'number') ? usage.output : 0,
        totalTokens: (typeof usage.total === 'number') ? usage.total : 0,
        reasoningTokens: (typeof usage.reasoning === 'number') ? usage.reasoning : 0,
        cachedTokens: (typeof usage.cached === 'number') ? usage.cached : 0
      },
      responseId: s.responseId || '',
      chatId: s.chatId || ''
    };
    try {
      window.dispatchEvent(new CustomEvent('ai-cm-full-history', { detail: detail }));
      dispatchSig = sig;
      lastDispatchResult = true;
      diagLine('emit', {
        conv: String(detail.convId || '').slice(0, 8),
        count: detail.count,
        serverTokens: detail.serverTokens,
        reasoningTokens: detail.qwenUsage.reasoningTokens,
        responseId: String(detail.responseId || '').slice(0, 8)
      });
      // O-35 (ДИАГНОСТИКА, только измерение): qwen-sse — серверный usage ФАКТИЧЕСКИ ушёл
      // в снимок (это и есть точка «usage дошёл до бейджа», см. дефект B). serverTokens
      // здесь — ровно detail.serverTokens = usage.input последнего кадра.
      diagTag('qwen-sse', {
        ts: Date.now(), event: 'emit', convId: String(detail.convId || ''),
        url: s.url || diagUrl(), serverTokens: detail.serverTokens,
        inputTokens: detail.qwenUsage.inputTokens,
        outputTokens: detail.qwenUsage.outputTokens,
        reasoningTokens: detail.qwenUsage.reasoningTokens,
        count: detail.count
      });
    } catch (eEmit) {
      lastDispatchResult = false;
      diagLine('emit-error', { err: String(eEmit && eEmit.message || eEmit).slice(0, 80) });
    }
    return lastDispatchResult;
  }

  // ===== Перехват fetch (обёртка по образцу core/deepseek-intercept.js:1861-1945) =====
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      var url = urlOf(input);
      var method = methodOf(init, input);
      var hit = false;
      try { hit = isQwenCompletions(url, method); } catch (eDet) { hit = false; }
      // O-39: JSON-эндпоинт истории чата (SPA-переход/F5) — второй путь записи базы.
      var histHit = false;
      try { histHit = isQwenHistory(url, method); } catch (eDetH) { histHit = false; }
      // O-35 (ДИАГНОСТИКА, только измерение): qwen-sse — матчинг URL эндпоинта стрима.
      // Печатается ДО гарда чужого чата ниже: видно и сам матч, и (отдельной строкой
      // skip-request) случай «запрос ушёл в другой чат».
      if (hit) diagTag('qwen-sse', { ts: Date.now(), event: 'url-match', method: method, url: url });
      // O-39 (ДИАГНОСТИКА, только измерение): qwen-history — матчинг эндпоинта истории.
      // transport — какой транспорт страницы поймал историю (fetch/XHR): живой прогон
      // 2026-09-20 18:09-18:25 показал XHR (jQuery.ajax), где fetch-хук слеп.
      if (histHit) diagTag('qwen-history', { ts: Date.now(), event: 'url-match', method: method, url: url, transport: 'fetch' });

      if (hit) {
        var reqChatId = chatIdFromUrl(url);
        if (reqChatId) {
          lastReqChatId = reqChatId;
          if (!currentChatId) currentChatId = reqChatId;
        }
        if (currentChatId && reqChatId && reqChatId !== currentChatId) {
          // Ход ушёл в ДРУГОЙ чат (SPA-переход): не подмешиваем его в текущую базу.
          diagLine('skip-request', { reason: 'other-chat', req: String(reqChatId).slice(0, 8) });
          hit = false;
        }
      }

      var meta = null;
      var histMeta = null;
      if (hit) {
        meta = { chatId: reqChatId || currentChatId || '', url: url, userPrompt: '', userKey: '', parentId: '', model: '' };
        try {
          var bodyStr = (init && typeof init.body === 'string') ? init.body : '';
          // Тело Request читается асинхронно; синхронный путь его не трогает — ход без
          // текста пользователя не смертелен (assistant-часть и токены всё равно придут).
          if (bodyStr) {
            var payload = JSON.parse(bodyStr);
            meta.parentId = payload.parentId || payload.parent_id || '';
            meta.model = (typeof payload.model === 'string') ? payload.model : '';
            var msgs = payload.messages;
            if (Array.isArray(msgs)) {
              for (var i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i] && msgs[i].role === 'user' && typeof msgs[i].content === 'string') {
                  meta.userPrompt = msgs[i].content;
                  meta.userKey = (typeof msgs[i].fid === 'string' && msgs[i].fid) ? msgs[i].fid : '';
                  break;
                }
              }
            }
          }
        } catch (eBody) { }
        if (!meta.userKey) {
          meta.userKey = meta.parentId ? ('p:' + meta.parentId) : ('l:' + turnSeq);
        }
        diagLine('request', {
          chat: String(meta.chatId || '').slice(0, 8),
          parent: String(meta.parentId || '').slice(0, 8),
          promptLen: meta.userPrompt.length
        });
      } else if (histHit) {
        // O-39: id чата истории берётся из URL (payload — второй источник, parseQwenHistory).
        var histChatId = historyChatIdFromUrl(url);
        if (histChatId) {
          lastReqChatId = histChatId;
          if (!currentChatId) currentChatId = histChatId;
        }
        if (currentChatId && histChatId && histChatId !== currentChatId) {
          // История ДРУГОГО чата (SPA-переход): в текущую базу не подмешивается.
          diagLine('skip-request', { reason: 'other-chat', req: String(histChatId).slice(0, 8) });
          diagTag('qwen-history', { ts: Date.now(), event: 'skip-request', reason: 'other-chat', url: url });
          histHit = false;
        } else {
          histMeta = { chatId: histChatId || currentChatId || '', url: url };
        }
      }

      var promise;
      try { promise = originalFetch.apply(this, arguments); } catch (eCall) { return Promise.reject(eCall); }
      // Тихий catch — снимаем ложный unhandled rejection для чужих прерванных запросов
      // (Failed to fetch при навигации/обрыве стрима), не меняя поведения страницы.
      if (promise && typeof promise.catch === 'function') promise.catch(function () { });

      if (hit) {
        promise.then(function (resp) {
          try {
            if (!resp || !resp.ok) {
              diagLine('response-skip', { reason: 'http', status: resp ? resp.status : 'none' });
              return resp;
            }
            consumeStream(resp, meta);
          } catch (eResp) {
            diagLine('response-error', { err: String(eResp && eResp.message || eResp).slice(0, 80) });
          }
          return resp;
        }, function () { /* тихо: не создаём висячий Promise.reject */ });
      } else if (histHit && histMeta) {
        // O-39: тот же контракт фолбэка — тело страницы не трогаем, читаем только clone().
        promise.then(function (resp) {
          try {
            if (!resp || !resp.ok) {
              diagLine('response-skip', { reason: 'http', status: resp ? resp.status : 'none' });
              diagTag('qwen-history', { ts: Date.now(), event: 'skip', reason: 'http', status: resp ? resp.status : 'none', url: histMeta.url || '' });
              return resp;
            }
            consumeHistory(resp, histMeta);
          } catch (eResp) {
            diagLine('response-error', { err: String(eResp && eResp.message || eResp).slice(0, 80) });
          }
          return resp;
        }, function () { /* тихо: не создаём висячий Promise.reject */ });
      }

      return promise;
    };
  }

  // ===== Перехват XHR (O-39 вариант B: история чата; Type=xhr, инициатор jquery) =====
  // Обёртка строго по образцу perplexity-intercept.js:465-490 / deepseek-intercept.js:1963-1980:
  //   - open запоминает method+url и флаг истории НА ЭКЗЕМПЛЯРЕ (this.__aiCmQwenHist);
  //   - send на экземпляре С ФЛАГОМ добавляет СВОЙ слушатель loadend через addEventListener
  //     (onreadystatechange страницы не перезаписывается и readystatechange не используется);
  //   - XHR без флага не трогается вовсе — ни слушателей, ни чтения тела.
  // Исключение внутри обёртки не выходит наружу: страница получает свой ответ, статус и
  // события как есть, своих запросов перехватчик не делает.
  try {
    if (typeof XMLHttpRequest === 'function' && XMLHttpRequest.prototype) {
      var origXHROpen = XMLHttpRequest.prototype.open;
      var origXHRSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url) {
        try {
          // Сброс флага на экземпляре: повторный open() того же XHR не наследует старую историю.
          this.__aiCmQwenHist = null;
          var xMethod = String(method == null ? 'GET' : method).toUpperCase();
          var xUrl = String(url == null ? '' : url);
          var xHit = false;
          try { xHit = isQwenHistory(xUrl, xMethod); } catch (eXDet) { xHit = false; }
          if (xHit) {
            diagTag('qwen-history', {
              ts: Date.now(), event: 'url-match', method: xMethod, url: xUrl, transport: 'xhr'
            });
            // Гард чужого чата — тот же, что в fetch-ветке (skip-request reason=other-chat).
            var xChatId = historyChatIdFromUrl(xUrl);
            if (xChatId) {
              lastReqChatId = xChatId;
              if (!currentChatId) currentChatId = xChatId;
            }
            if (currentChatId && xChatId && xChatId !== currentChatId) {
              diagLine('skip-request', { reason: 'other-chat', req: String(xChatId).slice(0, 8) });
              diagTag('qwen-history', {
                ts: Date.now(), event: 'skip-request', reason: 'other-chat', url: xUrl, transport: 'xhr'
              });
            } else {
              // Флаг истории на ЭКЗЕМПЛЯРЕ: method+url запоминаются, chatId — из URL (payload второй).
              this.__aiCmQwenHist = { chatId: xChatId || currentChatId || '', url: xUrl, method: xMethod };
            }
          }
        } catch (eXOpen) { }
        return origXHROpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        try {
          var xMeta = this.__aiCmQwenHist;
          if (xMeta) {
            var xSelf = this;
            xSelf.addEventListener('loadend', function () {
              try { consumeHistoryXhr(xSelf, xMeta); } catch (eXLoad) { }
            });
          }
        } catch (eXSend) { }
        return origXHRSend.apply(this, arguments);
      };
    }
  } catch (eXhrHook) { }

  // ===== SPA: смена чата по pathname =====
  function checkChatChange() {
    try {
      var next = chrOf();
      if (next === currentChatId) return;
      var prev = currentChatId;
      currentChatId = next;
      if (sse) { sse.ended = true; sse = null; }   // ход старого чата не дописывается в новый
      turns = [];
      userTurns = [];
      turnSeq = 0;
      dispatchSig = null;
      diagLine('chat-change', { chat: String(next || '').slice(0, 8) });
      // O-35 C (ФИКС): трансляция смены разговора в ISOLATED-сторону. До фикса событие
      // здесь НЕ диспатчилось (dispatched=0): content.js не делал resetConversationState,
      // контур ISOLATED оставался на покинутом чате, и SPA-открытый чат жил без базы,
      // попапа и кнопок ручного экспорта до F5. Форма вызова — ровно как у шести
      // существующих перехватчиков (page/gemini/deepseek/claude/perplexity): CustomEvent
      // без detail; слушатель content.js:246 делает полный сброс + адаптерный пересъём.
      var dispatched = 0;
      try {
        window.dispatchEvent(new CustomEvent('ai-cm-conversation-changed'));
        dispatched = 1;
      } catch (eDispatch) { }
      // O-35 (ДИАГНОСТИКА, только измерение): qwen-spa — хук смены разговора в MAIN-мире.
      // dispatched=1 — событие ушло в ISOLATED (ISOLATED-сторона отвечает строками
      // conv-changed-recv / reset-done / reshoot, затем qwen-adapter с sinceSpaResetMs>=0).
      // reset=1 — состояние ПЕРЕХВАТЧИКА (turns/userTurns/dispatchSig) сброшено этим же вызовом.
      diagTag('qwen-spa', {
        ts: Date.now(), event: 'chat-change', from: String(prev || '').slice(0, 8),
        to: String(next || '').slice(0, 8), convId: String(next || ''),
        url: diagUrl(), reset: 1, dispatched: dispatched
      });
    } catch (eCh) { }
  }
  try {
    var origPushState = history.pushState;
    if (origPushState) {
      history.pushState = function () {
        var r = origPushState.apply(this, arguments);
        try { checkChatChange(); } catch (eP) { }
        return r;
      };
    }
    var origReplaceState = history.replaceState;
    if (origReplaceState) {
      history.replaceState = function () {
        var r = origReplaceState.apply(this, arguments);
        try { checkChatChange(); } catch (eR) { }
        return r;
      };
    }
    window.addEventListener('popstate', function () { try { checkChatChange(); } catch (ePop) { } });
  } catch (eHist) { }

  // ===== Мосты для тестов/диагностики (только чтение, побочных эффектов нет) =====
  // Тесты гоняют РЕАЛЬНЫЙ файл и проверяют счётчики/состояние через эти ссылки;
  // боевой путь их не использует.
  window.__aiCmQwenBridge = {
    isQwenCompletions: isQwenCompletions,
    isQwenHistory: isQwenHistory,
    chatIdFromUrl: chatIdFromUrl,
    historyChatIdFromUrl: historyChatIdFromUrl,
    composeTurnText: composeTurnText,
    // O-39: чистый разбор payload истории и его применение к состоянию (тесты гоняют РЕАЛЬНЫЙ
    // файл; боевой путь вызывает то же самое из consumeHistory).
    parseQwenHistory: parseQwenHistory,
    applyHistory: function (payload, meta) { return applyHistoryPayload(payload, meta || {}); },
    turns: function () { return turns; },
    usage: function () { return sse ? sse.usage : null; },
    diagLines: function () { return diagLineCount; },
    diagOn: diagOn,
    applyFrames: function (objects) {
      if (!sse) beginStream({ chatId: currentChatId, userPrompt: '', parentId: '' });
      for (var i = 0; i < objects.length; i++) feedFrame({ data: JSON.stringify(objects[i]) });
      endStream('bridge');
    }
  };

  diagLine('installed', { chat: String(currentChatId || '').slice(0, 8), model: MODEL_DEFAULT });
  console.log('[qwen-intercept] перехватчик Qwen установлен (только нативные запросы страницы, ' +
    'SSE через utils/stream-frames.js, usage кумулятивный → последний кадр, ' +
    'фазы thinking_summary(REPLACE)/answer(APPEND), фолбэк — DOM-адаптер, ' +
    'O-39: JSON-история GET /api/v*N*/chats/{id} через resp.clone().json() (fetch) ' +
    'и XMLHttpRequest loadend (XHR/jQuery)');
})();
