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
 * РАЗБОР SSE — через utils/stream-frames.ts (ESM-модуль frames/normalizeUsage/mergeUsage,
 * вшит в этот бандл статическим import'ом — Ph2);
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
 *
 * Ph2 (ESM): каркас кадров — настоящий модуль; esbuild вшивает его в ЭТОТ бандл MAIN-перехватчика
 * (build.mjs, mainInterceptOptions). Отдельным script'ом из js[] он больше не грузится, поэтому
 * ленивого разрешения через window нет: функции доступны статически.
 */
import { frames as framesApi, normalizeUsage, mergeUsage } from '../utils/stream-frames.ts';
import { fetchGuarded } from '../utils/intercept-common.ts';
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
      // O-35 (ДИАГНОСТИКА, только измерение): канон utils/debug.ts получает флаг тем же
      // способом, что у шести существующих перехватчиков (claude-intercept.js:18 и др.) —
      // иначе aiCmDiagOn() в MAIN-мире не увидел бы чекбокс «Подробные логи» и канонический
      // принтер молчал бы при включённом гейте. Поведение продукта не меняется.
      try { if (typeof __aiCmSetDebugLogs === 'function') __aiCmSetDebugLogs(!!(ev && ev.detail)); } catch (eCanon) { /* ignore */ }
      flushDiagRing();
    });
  } catch (eGate) { /* ignore */ }

  var originalFetch = window.fetch;

  // ---- константы протокола ----
  var REASONING_TAG = '[REASONING]';
  var ANSWER_TAG = '[ANSWER]';
  // R4: текст-заместитель для хода, у которого есть вложение, но нет текста вопроса.
  // Это ДАННЫЕ (как [FILE: ...]/[REASONING]), не UI-перевод: по строке экспорт отличает
  // пользовательский ход от пустого assistant и строит user-блок без «висячего» ASSISTANT.
  var FILE_ONLY_PLACEHOLDER = '[Вложение]';
  // Прежний дефолт модели удалён: 'qwen3.8-max' из тела /chats/new нельзя подставлять как id модели.
  var PHASE_THINKING = 'thinking_summary';
  var PHASE_ANSWER = 'answer';

  // ===== ДИАГНОСТИКА: строки ТОЛЬКО под гейтом aiCmDebug =====
  // Гейт — тот же, что у utils/debug.ts: sessionStorage 'aiCmDebug' === '1' ИЛИ флаг
  // window.__aiCmDebugLogs (его присылает content.js событием 'ai-cm-debug-logs').
  // Пока гейт неизвестен (событие не пришло), строки копятся в маленьком кольце и
  // печатаются ТОЛЬКО если гейт в итоге оказался включён. Выключенный гейт → ни одной
  // новой строки и ноль влияния на байты/состояние (G1/G2).
  function diagOn() {
    try {
      if (typeof sessionStorage !== 'undefined' && sessionStorage &&
        sessionStorage.getItem('aiCmDebug') === '1') return true;
    } catch (eSess) { /* ignore */ }
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
    } catch (eRing) { /* ignore */ }
  }
  function printDiag(fullTag, fields) {
    try {
      var f = fields || {};
      diagLineCount++;
      // Канон utils/debug.ts:aiCmDiagLine (в MAIN-мир файл приходит первым —
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
    } catch (ePrint) { /* ignore */ }
  }
  function flushDiagRing() {
    if (!diagOn()) { diagRing = []; return; }
    try {
      for (var i = 0; i < diagRing.length; i++) printDiag(diagRing[i][0], diagRing[i][1]);
    } catch (eFlush) { /* ignore */ }
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
    } catch (eUrl) { /* ignore */ }
    return '';
  }
  function methodOf(init, input) {
    try {
      if (init && init.method) return String(init.method).toUpperCase();
      if (input && typeof input.method === 'string') return String(input.method).toUpperCase();
    } catch (eM) { /* ignore */ }
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
    } catch (eQh) { /* ignore */ }
    return '';
  }

  function chatIdFromUrl(url) {
    try {
      var m = /[?&]chat_id=([^&]+)/.exec(url);
      if (m) return decodeURIComponent(m[1]);
    } catch (eQ) { /* ignore */ }
    return '';
  }
  function chrOf(url) {
    try {
      var m = /\/c\/([A-Za-z0-9_-]+)/.exec(String(location.pathname || ''));
      if (m) return m[1];
    } catch (eC) { /* ignore */ }
    return '';
  }
  // Текущий чат: id из пути /c/<id> (SPA-адрес) либо из query последнего запроса страницы.
  var currentChatId = chrOf();
  var lastReqChatId = '';

  // R2: модуль вложений (core/qwen-files.js грузится ПЕРЕД перехватчиком). null — срезанная
  // сборка без модуля/старый манифест: каждое касание ниже проверяет наличие и молчит.
  var aiCmQwenFiles = (typeof window !== 'undefined' && window.AiCmQwenFiles) ? window.AiCmQwenFiles : null;
  // Ph2: каркас кадров импортирован статически. Фасад повторяет прежний контракт вызовов
  // (SF.frames / SF.normUsage / SF.mergeUsage), чтобы остальная логика не менялась.
  var SF = { frames: framesApi, normUsage: normalizeUsage, mergeUsage: mergeUsage };
  // R2: метаданные ПОСЛЕДНЕГО снимка. Ре-эмит после прихода текста вложения повторяет прежние
  // serverTokens/complete: токены не пересчитываются, а незавершённая пагинация не «закрывается».
  var lastEmitMeta = { tokens: 0, complete: true, chatId: '', responseId: '' };

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
    var next = normalizeUsage(obj.usage);
    if (!next) return;
    // КУМУЛЯТИВНЫЙ usage Qwen: cumulative=true → ПЕРЕЗАПИСЬ последним кадром.
    // Сумма 63+174+337+553+884 = 2011 — неверно (антипод-пин D4).
    sse.usage = mergeUsage(sse.usage, next, true);
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
    try { obj = JSON.parse(raw); } catch (eParse) { swallow(eParse, 'qwen:feed-frame-parse'); return; }
    if (!obj || typeof obj !== 'object') return;
    sse.frames++;
    applyMeta(obj);
    applyUsage(obj);
    applyDelta(obj);
  }

  // ---- чтение потока: ТОЛЬКО через clone(); фолбэк без чтения тела ----
  // Ph2: каркас кадров вшит в бандл статическим import'ом — разрешать его лениво не нужно,
  // поэтому ветка «stream-frames-missing» удалена (модуль есть всегда, если собрался бандл).
  function consumeStream(resp, meta) {
    beginStream(meta);
    diagLine('consume-enter', { chat: String(meta.chatId || '').slice(0, 8) });
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
    var iterator = SF.frames(resp);
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
          if (typeof iterator.return === 'function') { try { iterator.return(); } catch (eRet) { /* ignore */ } }
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

  // O-53: возвращает { turn, created } — пагинации нужно знать, какие ходы добавлены
  // ИМЕННО этой страницей (их order перенумеровывается под более старую страницу).
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
    var model = s.model || '';
    if (existing) {
      existing.answer = s.answer;
      existing.reasoning = s.reasoning;
      existing.text = composeTurnText(s.answer, s.reasoning);
      existing.userKey = existing.userKey || userKey;
      // R4: повторное применение той же страницы не должно оставлять на ходе флаг
      // «только вложение», если настоящий ответ уже пришёл.
      existing.filesOnly = (s.filesOnly === true && !s.answer && !s.reasoning);
      return { turn: existing, created: false };
    }
    // R4: заглушка «только вложение» (file-only:...), созданная на прошлой странице,
    // дожидается настоящего ответа. Пришёл assistant с тем же userKey — заполняем заглушку
    // и забираем реальный ключ: второго user-блока с тем же вопросом не появляется.
    var fileOnly = null;
    if (userKey) {
      for (var fi = 0; fi < turns.length; fi++) {
        var fc = turns[fi];
        if (fc && fc.filesOnly === true && typeof fc.key === 'string' &&
          fc.key.indexOf('file-only:') === 0 && fc.userKey === userKey) {
          fileOnly = fc;
          break;
        }
      }
    }
    if (fileOnly) {
      fileOnly.key = key;
      fileOnly.model = model || fileOnly.model;
      fileOnly.answer = s.answer || '';
      fileOnly.reasoning = s.reasoning || '';
      fileOnly.text = composeTurnText(fileOnly.answer, fileOnly.reasoning);
      fileOnly.filesOnly = (s.filesOnly === true && !s.answer && !s.reasoning);
      return { turn: fileOnly, created: false };
    }
    // R4: ту же страницу «только вложение» могли применить ПОВТОРНО уже после того,
    // как заглушка забрала реальный ключ. Второй file-only ход для того же userKey
    // не нужен: иначе в экспорте появится второй user-блок с тем же вопросом.
    if (s.filesOnly === true && userKey && key.indexOf('file-only:') === 0) {
      for (var fj = 0; fj < turns.length; fj++) {
        var fd = turns[fj];
        if (fd && fd.filesOnly === true && fd.userKey === userKey) {
          return { turn: fd, created: false };
        }
      }
    }
    // O-54: order — строго больше максимального уже выданного. `turns.length` ломается после
    // перенумерации пагинацией: старые страницы получают отрицательные order, и живой ход,
    // добавленный следом, обязан встать в конец (max + 1), а не по счётчику элементов.
    var maxOrder = -1;
    for (var oi = 0; oi < turns.length; oi++) {
      if (typeof turns[oi].order === 'number' && turns[oi].order > maxOrder) maxOrder = turns[oi].order;
    }
    var added = {
      key: key,
      order: maxOrder + 1,
      model: model,
      userKey: userKey,
      answer: s.answer,
      reasoning: s.reasoning,
      text: composeTurnText(s.answer, s.reasoning),
      filesOnly: s.filesOnly === true
    };
    turns.push(added);
    return { turn: added, created: true };
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
    // R4: сообщение, состоящее ТОЛЬКО из вложений (content_list пуст), тоже ход:
    // иначе его files[] не доходят до разбора и файл теряется вместе с сообщением.
    if (Array.isArray(node.files) && node.files.length) return true;
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
      var item = (typeof qwenThinkingItem === 'function') ? qwenThinkingItem(list[i]) : list[i];
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
    var out = '', fallbackAnswer = '';
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item || typeof item !== 'object') continue;
      if (item.phase === PHASE_THINKING || item.phase === 'thinking') continue;
      if (typeof item.content === 'string' && item.content) { if (item.phase === 'answer') out += item.content; else fallbackAnswer += item.content; }
    }
    return out || fallbackAnswer;
  }
  // usage хода истории (спека: usage{input_tokens,output_tokens}) — та же нормализация, что у
  // кадров стрима (utils/stream-frames.ts:normalizeUsage); её null — читаем измеренные поля сами.
  function historyUsageOf(node) {
    var raw = (node && node.usage && typeof node.usage === 'object') ? node.usage : null;
    if (!raw) return null;
    var norm = normalizeUsage(raw);
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
   * R2: вложения сообщения истории. Живой протокол Qwen кладёт их в node.files[]
   * (объект: id/name/url/file_type/size/status/type/file_class); встречается и форма, где
   * ссылка лежит прямо в content_list элементе с url. Разбор защитный: берём всё, что похоже
   * на файл, а нормализацию/отсев мусора делает core/qwen-files.js (qfRefFromEntry).
   * Пустой массив — вложений нет (поле остаётся, чтобы форма сообщения была стабильной).
   */
  function historyFilesOf(node) {
    var out = [];
    try {
      if (!node || typeof node !== 'object') return out;
      var list = Array.isArray(node.files) ? node.files : [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && typeof list[i] === 'object') out.push(list[i]);
      }
      if (!out.length) {
        var cl = contentListOf(node) || [];
        for (var j = 0; j < cl.length; j++) {
          var c = cl[j];
          if (c && typeof c === 'object' && typeof c.url === 'string' && c.url) out.push(c);
        }
      }
    } catch (eFiles) { swallow(eFiles, 'qwen:history-files'); }
    return out;
  }

  /**
   * payload истории → { chatId, messages[], nodes, duplicates, thinkingDuplicates, reasoningMessages }.
   * messages[] — ходы role user/assistant в порядке появления; повтор узла с тем же id
   * отбрасывается (первое вхождение побеждает — спека O-39 п.5).
   */
  function parseQwenHistory(payload) {
    var nodes = [], chain = false, fullParsed = (typeof qwenParseFullChain === 'function') ? qwenParseFullChain(payload) : null;
    if (fullParsed && fullParsed.nodes && fullParsed.nodes.length) { nodes = fullParsed.nodes; chain = true; } else { try { walkHistoryMessages(payload, nodes, 0, []); } catch (eWalk) { nodes = []; } }
    var messages = [];
    var seen = {};
    var chatId = '';
    var duplicates = 0;
    var thinkingDuplicates = 0;
    var reasoningMessages = 0;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i]; if (node.offChain === true) continue;   // O-61: abandoned — не в messages, но в nodes (диагностика)
      var role = (node.role === 'user') ? 'user' : ((node.role === 'assistant') ? 'assistant' : '');
      if (!role) continue;
      if (!chatId) chatId = historyChatIdOf(node);
      var list = contentListOf(node) || [];
      var thinking = historyThinkingOf(list); var nodeReasoning = (typeof qwenReasoningOf === 'function') ? qwenReasoningOf(node) : '';
      if (thinking.occurrences > 1) thinkingDuplicates++;
      var text = historyAnswerOf(list);
      if (!text && typeof node.content === 'string') text = node.content;
      if (!text && typeof node.text === 'string') text = node.text;
      var id = historyMessageId(node, role);
      var dedupeKey = id || (role + '\u0000' + text + '\u0000' + (nodeReasoning || thinking.text));
      if (seen[dedupeKey] === 1) { duplicates++; continue; }   // первое вхождение побеждает
      seen[dedupeKey] = 1;
      if (nodeReasoning || thinking.text) reasoningMessages++;
      messages.push({
        key: id,
        role: role,
        text: text,
        reasoning: nodeReasoning || thinking.text,
        usage: historyUsageOf(node),
        model: (typeof node.model === 'string') ? node.model : '',
        parentId: (typeof node.parent_id === 'string') ? node.parent_id
          : ((typeof node.parentId === 'string') ? node.parentId : ''),
        // R2: вложения хода. Уходят в core/qwen-files.js уже на recordTurn (ниже).
        files: historyFilesOf(node)
      });
    }
    if (!chatId) chatId = findHistoryChatId(payload, 0, []) || ((payload && payload.data && payload.data.id) || '');
    return {
      chatId: chatId,
      messages: messages,
      nodes: nodes.length,
      duplicates: duplicates,
      thinkingDuplicates: thinkingDuplicates,
      reasoningMessages: reasoningMessages, chain: chain
    };
  }

  // Ходы истории → то же состояние turns (recordTurn) и ТОТ ЖЕ снимок (emitSnapshot): reasoning
  // уезжает в detail.messages[].reasoning и в текст хода секциями [REASONING]/[ANSWER].
  // usage для снимка — usage ПОСЛЕДНЕГО assistant-хода (как у стрима: последний кумулятивный).
  function applyHistoryPayload(payload, meta) {
    var m = meta || {}; var pgRaw = payload && payload.data && payload.data.chat && payload.data.chat.history ? payload.data.chat.history.pagination : null; var fullDoc = (m.full === true) || (typeof isFullHistoryUrl === 'function' && isFullHistoryUrl(m.url) && !pgRaw); /* O-57: полная история принята → страницу пагинации не применяем (до парсинга и recordTurn) */ if (fullHistoryBlocksPage(m.chatId || currentChatId || lastReqChatId, m.url, m)) return skipFullHistoryPage(m);
    var parsed = parseQwenHistory(payload);
    if (!parsed.messages.length) {
      diagTag('qwen-history', { ts: Date.now(), event: 'skip', reason: 'no-messages', url: m.url || '' });
      return { added: 0, foreign: false };
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
      return { added: 0, foreign: true };
    }
    var pendingUserKey = '';
    var pendingUserText = '';
    // R2: вложения ТЕКУЩЕГО вопроса. Очередь вложений ставится после recordTurn: только там
    // появляется userKey хода, по которому экспорт ищет секции файлов (qfSectionsFor).
    var pendingUserFiles = [];
    var lastUsage = null;
    var lastResponseId = '';
    var lastModel = '';
    var applied = 0;
    var created = [], pageTurns = [];   // O-55: pageTurns — все ходы страницы (и новые, и adopted)
    var filesOnlyTurns = 0;
    // R4: вложения могут прийти и в user-узле, и в assistant-узле (наблюдённые формы).
    // В очередь ставим ОБЪЕДИНЕНИЕ, а источник пишем в диагностику (без имён/URL).
    function enqueueHistoryFiles(pendingUserFiles, rec, source) {
      if (!pendingUserFiles || !pendingUserFiles.length) return;
      if (!rec || !rec.turn || !rec.turn.userKey) return;
      // typeof-гард: срез-песочницы тестов (O-54) исполняют только эти функции, без
      // объявления aiCmQwenFiles в скоупе — там очередь вложений просто выключена.
      if (typeof aiCmQwenFiles !== 'undefined' && aiCmQwenFiles) {
        try { aiCmQwenFiles.qfEnqueueUserFiles(chatId, rec.turn.userKey, pendingUserFiles); }
        catch (eQf) { swallow(eQf, 'qwen:files-enqueue'); }
      }
      diagTag('qwen-history-files', {
        ts: Date.now(), event: 'enqueue', chat: String(chatId || '').slice(0, 8),
        source: source, files: pendingUserFiles.length
      });
    }
    for (var i = 0; i < parsed.messages.length; i++) {
      var msg = parsed.messages[i];
      if (msg.role === 'user') {
        pendingUserKey = msg.key || ('h:u:' + i);
        pendingUserText = msg.text || '';
        pendingUserFiles = Array.isArray(msg.files) ? msg.files : [];
        // R4: ход без текста, но с вложениями. Placeholder — данные, не перевод: без него
        // userTurns не получит запись, а buildSignature не отличит такой ход от пустого.
        if (!pendingUserText.trim() && pendingUserFiles.length) {
          pendingUserText = FILE_ONLY_PLACEHOLDER;
        }
        continue;
      }
      if (msg.role !== 'assistant') continue;
      var msgFiles = Array.isArray(msg.files) ? msg.files : [];
      var turnFiles = pendingUserFiles.concat(msgFiles);
      var filesOnly = !msg.text && !msg.reasoning;
      // R4: пустой ход по-прежнему не пишется, НО вложения — достаточная причина для хода
      // (раньше безусловный continue терял и файл, и user-блок).
      if (filesOnly && !turnFiles.length) continue;
      var fileSource = (pendingUserFiles.length && msgFiles.length) ? 'both'
        : (msgFiles.length ? 'assistant' : 'user');
      if (msg.usage) lastUsage = msg.usage;
      if (msg.key) lastResponseId = msg.key;
      if (msg.model) lastModel = msg.model;
      var rec = recordTurn({
        chatId: chatId,
        url: m.url || '',
        // responseId — ключ хода (как у стрима: response.created.response_id).
        responseId: msg.key || '',
        userPrompt: pendingUserText || (turnFiles.length ? FILE_ONLY_PLACEHOLDER : ''),
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
        finished: true,
        filesOnly: filesOnly
      });
      // R2/R4: вложения хода — в очередь core/qwen-files.js. Ключ — userKey ИМЕННО
      // этого хода (rec.turn.userKey): emitSnapshot достаёт пользовательский блок
      // через userTextOf, а filesOnly-ход ассистента подавляется при сборке снимка.
      if (rec && rec.turn && rec.turn.userKey) {
        enqueueHistoryFiles(turnFiles, rec, fileSource);
      }
      if (filesOnly) filesOnlyTurns++;
      // Ход обработан — pending относится ровно к нему. Без сброса хвост вложений
      // уезжал бы в следующий assistant.
      pendingUserKey = '';
      pendingUserText = '';
      pendingUserFiles = [];
      // O-53: ходы этой страницы — в created (их order перенумеровывает пагинация).
      if (rec && rec.turn) { pageTurns.push(rec.turn); if (rec.created) created.push(rec); }
      applied++;
    }
    // R4: сообщение только с вложениями БЕЗ ответа assistant. Отдельного хода-ответа нет,
    // поэтому заводим пользовательский ход-заглушку: файл получает userKey и попадает
    // в базу (а при приходе настоящего ответа заглушку заберёт adoption в recordTurn).
    if (pendingUserKey && pendingUserFiles.length) {
      var recU = recordTurn({
        chatId: chatId,
        url: m.url || '',
        responseId: 'file-only:' + pendingUserKey,
        userPrompt: pendingUserText || FILE_ONLY_PLACEHOLDER,
        userKey: pendingUserKey,
        parentId: '',
        model: '',
        reasoning: '',
        answer: '',
        usage: null,
        rawUsage: null,
        usageFrames: 0,
        frames: 0,
        reasoningFrames: 0,
        answerFrames: 0,
        ended: true,
        finished: true,
        filesOnly: true
      });
      if (recU && recU.turn && recU.turn.userKey) {
        enqueueHistoryFiles(pendingUserFiles, recU, 'user');
      }
      if (recU && recU.turn) { pageTurns.push(recU.turn); if (recU.created) created.push(recU); }
      filesOnlyTurns++;
      applied++;
      pendingUserKey = '';
      pendingUserText = '';
      pendingUserFiles = [];
    }
    if (!applied) {
      diagTag('qwen-history', { ts: Date.now(), event: 'skip', reason: 'no-turns', url: m.url || '' });
      return { added: 0, foreign: false };
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
    // O-53/O-55: страница истории (цикл ИЛИ публичный ?cursor=) — ПЕРЕД собранными, все ходы.
    if (created.length) renumberHistoryPage(pageTurns, m.paginate, m.url); if (fullDoc && parsed.chain === true && typeof reindexByChain === 'function') reindexByChain(pageTurns); if (fullDoc && pq && typeof pqAbort === 'function') pqAbort('full-history');
    // O-53: пагинация стартует ДО emit — первый снимок сразу честно неполный
    // (historyComplete=false), а не «полный, но потом вдруг нет» (дефект базовой страницы).
    var paginating = false, fullPending = false;
    if (!m.paginate && !fullDoc) {
      var fullStatus = (typeof ensureFullHistory === 'function') ? ensureFullHistory(chatId, m.url, payload, m, created.length) : false; fullPending = (fullStatus === 'pending'); if (!fullStatus) { try { paginating = startQwenPagination(m, payload, created.length); }
      catch (eStart) { swallow(eStart, 'qwen:paginate-start'); } }
    }
    var partialFlag = (m.paginate || paginating || fullPending);
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
      finished: true,
      // O-53: неполнота ТОЛЬКО у промежуточной страницы; финал взводит pqFinish.
      complete: !partialFlag,
      partial: partialFlag ? { pages: (pq ? pq.pages : 0), reason: 'in-progress' } : null
    });
    diagTag('qwen-history', {
      ts: Date.now(), event: 'emit', url: m.url || '', chat: String(chatId || '').slice(0, 8),
      nodes: parsed.nodes, messages: parsed.messages.length, turns: applied,
      reasonings: parsed.reasoningMessages, duplicates: parsed.duplicates,
      thinking: parsed.thinkingDuplicates, filesOnly: filesOnlyTurns,
      hasUsage: (lastUsage && typeof lastUsage.input === 'number') ? 1 : 0,
      serverTokens: (lastUsage && typeof lastUsage.input === 'number') ? lastUsage.input : 0,
      emitted: emitted ? 1 : 0
    });
    // O-53: added — сколько ходов добавила ИМЕННО эта страница (для pqStep), foreign=false.
    return { added: created.length, foreign: false };
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
    try { /* O-57: полная история уже в базе → пагинацию сайта не читаем и не применяем (до разбора тела) */ if (fullHistoryBlocksPage(m.chatId || currentChatId || lastReqChatId, m.url, m)) return skipFullHistoryPage(m, 'xhr');
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
      // O-53: заголовки этого XHR (setRequestHeader) — для реплея старых страниц. meta остаётся
      // литералом (байтовый пин O-39), заголовки читает только старт цикла пагинации.
      lastHistoryHeaders = (xhr && xhr.__aiCmQwenHistHeaders) ? xhr.__aiCmQwenHistHeaders : null;
      if (isFullHistoryUrl(m.url)) noteNativeFullHistory(m.chatId); applyHistoryPayload(payload, { chatId: m.chatId, url: m.url });
      lastHistoryHeaders = null;
    } catch (eXConsume) {
      diagTag('qwen-history', {
        ts: Date.now(), event: 'error', url: m.url || '', transport: 'xhr',
        err: String(eXConsume && eXConsume.message || eXConsume).slice(0, 80)
      });
    }
  }

  // ===== EMIT: контракт ai-cm-full-history (как у DeepSeek, только нужные Qwen поля) =====
  function buildSignature(serverTokens, complete, soft) {
    try {
      var parts = [String(currentChatId || ''), String(turns.length), String(serverTokens || 0)];
      // O-53: полнота — часть сигнатуры. Иначе промежуточный (complete=false) и финальный
      // (complete=true) снимки одной базы дедупятся и финальный emit теряется.
      parts.push('c:' + (complete === false ? 0 : 1));
      // R1: мягкий финал с тем же complete=false и набором ходов дедупился бы без s-слагаемого.
      // П1: |u:сумма длин вопросов — потеря вопроса не меняет turns/serverTokens, без агрегата
      // ре-эмит глушится дедупом; typeof-гард O-54, 'na' в срез-песочницах.
      parts.push('s:' + (soft === true ? 1 : 0)); if (typeof userTurns !== 'undefined' && userTurns) parts.push('u:' + userTurns.reduce(function (n, u) { return n + ((u && typeof u.text === 'string') ? u.text.length : 0); }, 0));
      for (var i = 0; i < turns.length; i++) {
        var t = turns[i];
        parts.push(t.key + ':' + t.userKey + ':' + t.order + ':' +
          (t.text || '').length + ':' + (t.reasoning || '').length);
        // R2: длина секций вложений — часть сигнатуры. Текст файла живёт ВНЕ turns (у
        // пользовательского блока), поэтому без этого слагаемого приход текста не меняет
        // подпись, и ре-эмит глушится дедупом same-signature (файл уходил бы без содержимого).
        // typeof-гард — для срез-песочниц тестов (O-54): без модуля слагаемого просто нет.
        if (typeof aiCmQwenFiles !== 'undefined' && aiCmQwenFiles && t.userKey) {
          try { parts.push('f:' + aiCmQwenFiles.qfSectionLength(currentChatId, t.userKey)); }
          catch (eSigSec) { parts.push('f:0'); }
        }
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
    // O-53: полнота приходит из источника снимка. Дефолт — true: живой SSE авторитетен
    // (контракт O-35/O-39 не меняется), неполноту объявляет только пагинация истории.
    var complete = (s.complete !== false);
    var sig = buildSignature(serverTokens, s.complete, (s.partialSoft === true && complete === false));
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
    // O-54: пагинация перенумеровывает старые страницы в отрицательные order (assignPageOrders),
    // поэтому порядок добавления в turns уже НЕ равен хронологии: снимок собираем по order
    // (старые → новые). Без сортировки файл начинался с 10 последних турнов, а старые
    // страницы дописывались в конец — ходы в файле шли не по времени.
    var sortedTurns = turns.slice().sort(function (a, b) { return a.order - b.order; });
    for (var i = 0; i < sortedTurns.length; i++) {
      var t = sortedTurns[i];
      var userText = userTextOf(t.userKey);
      // R2: секции вложений вопроса — ТОЛЬКО в пользовательский блок (не в текст ответа):
      // в экспорте файл стоит рядом с сообщением, к которому он приложен. Ход из одних
      // вложений (без текста вопроса) тоже попадает в базу — ради этого файла он и нужен.
      var fileSec = '';
      if (typeof aiCmQwenFiles !== 'undefined' && aiCmQwenFiles && t.userKey) {
        try { fileSec = aiCmQwenFiles.qfSectionsFor(currentChatId, t.userKey) || ''; }
        catch (eFileSec) { swallow(eFileSec, 'qwen:files-sections'); }
      }
      if (userText || fileSec) {
        var userBlock = userText ? (userText + fileSec) : fileSec.replace(/^\n\n/, '');
        pieces.push(userBlock);
        ids.push('u:' + t.userKey);
        messages.push({ role: 'user', text: userBlock, reasoning: '' });
        reasonings.push('');
      }
      // R4: у filesOnly-хода ответа нет — пустой assistant-блок не пишем (иначе в MD
      // висел бы «### ASSISTANT» без текста, а в TXT — пустая роль). Модель хода при
      // этом не теряем: она нужна шапке экспорта, хотя текста ответа нет.
      if (t.model) lastModel = t.model;
      if (!t.filesOnly || t.text) {
        pieces.push(t.text);
        ids.push(t.key);
        var msg = { role: 'assistant', text: t.text, reasoning: t.reasoning || '' };
        // hiddenReasoning — та же пометка, что у DeepSeek: сырой режим экспорта
        // (utils/export-emit-pipeline.ts:includeHiddenExportBlocks) читает её,
        // обычный режим урезает секции до [ANSWER] (stripReasoningSections).
        if (t.reasoning) { msg.hiddenReasoning = t.reasoning; reasoningTurns++; }
        messages.push(msg);
        reasonings.push(t.reasoning || '');
      }
    }
    var text = pieces.join('\n');
    if (!text) { diagLine('emit-skip', { reason: 'empty-text' }); return false; }
    var detail = {
      convId: currentChatId || lastReqChatId || '',
      text: text,
      count: pieces.length,
      lastMessageText: pieces.length ? pieces[pieces.length - 1] : '',
      modelSlug: lastModel || '',
      messageTexts: pieces,
      messageIds: ids,
      messages: messages,
      reasoningTexts: reasonings,
      reasoningTurns: reasoningTurns,
      attachTokens: 0,
      attachBreak: { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 },
      // O-53: полнота снимка. Живой SSE — полная база по построению (контракт O-35/O-39);
      // история может быть НЕПОЛНОЙ: базовая страница Qwen — это 10 последних турнов, старше
      // которых сервер отдаёт только по курсору (O-53 добирает их и объявляет конец сам).
      historyComplete: complete,
      reachedRoot: complete,
      // partial — диагностика неполной базы для UI/экспорта: сколько страниц добрано и почему
      // остановились (in-progress/error/no-gain/page-cap/time-cap/cursor-loop).
      partial: complete ? null : (s.partial || { pages: 0, reason: 'in-progress' }),
      // R1: мягкий финал (time-cap/page-cap/no-gain) — база неполная, но продолжать нечем:
      // автоэкспорт разрешён с префиксом [LOW CONFIDENCE]_. Аддитивное булево: у прочих
      // сайтов и у честного/промежуточного снимка — false (O-54 не ослабляется).
      partialSoft: complete ? false : (s.partialSoft === true),
      baseEmpty: false,
      // ===== O-47 (badge-метрика Qwen): serverTokens В detail НЕ УЕЗЖАЕТ =====
      // Корень дефекта: usage.input из SSE — КУМУЛИРУЕМОЕ сервисом потребление API (input
      // текущего запроса + накопленный на его стороне контекст), а НЕ размер текущего контекста
      // диалога: число растёт от хода к ходу и не описывает ни окно, ни базу (в фикстурах O-35 —
      // 1709 при двух сообщениях). У DeepSeek аналог (accumulated_token_usage) авторитетен по
      // решению O-23 — у Qwen нет. Поэтому поле не публикуется вовсе: badge/pct Qwen считаются
      // ТОЛЬКО эвристикой Tokenizer.estimateDialogTokens (tokens~), а content.js дополнительно
      // гасит серверный счётчик для site=qwen (core/content.js:aiCmMetricServerTokens).
      // Диагностика числа не теряется: локальная переменная serverTokens уходит в строки
      // 'emit' (diagLine) и qwen-sse (diagTag) ниже, а также в сигнатуру дедупа снимка.
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
      // R2: запоминаем аргументы снимка — ре-эмит вложений повторит ровно их.
      // typeof-гард: срез-песочницы тестов (O-54) не объявляют lastEmitMeta.
      if (typeof lastEmitMeta !== 'undefined') {
        lastEmitMeta = {
          tokens: serverTokens,
          complete: complete,
          chatId: s.chatId || '',
          responseId: s.responseId || ''
        };
      }
      diagLine('emit', {
        conv: String(detail.convId || '').slice(0, 8),
        count: detail.count,
        serverTokens: serverTokens,
        reasoningTokens: detail.qwenUsage.reasoningTokens,
        responseId: String(detail.responseId || '').slice(0, 8)
      });
      // O-35 (ДИАГНОСТИКА, только измерение): qwen-sse — серверный usage ФАКТИЧЕСКИ ушёл
      // в снимок (это и есть точка «usage дошёл до бейджа», см. дефект B). serverTokens
      // здесь — ровно локальное usage.input последнего кадра; O-47: в detail это число больше
      // не публикуется (badge Qwen считает только tokens~), строка остаётся ИЗМЕРЕНИЕМ.
      diagTag('qwen-sse', {
        ts: Date.now(), event: 'emit', convId: String(detail.convId || ''),
        url: s.url || diagUrl(), serverTokens: serverTokens,
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

  // =====================================================================================
  // O-53: КУРСОРНАЯ ПАГИНАЦИЯ ИСТОРИИ (вариант B). Базовая страница Qwen — 10 последних
  // турнов; всё, что старше, сервер отдаёт ТОЛЬКО по курсору pagination.oldest_id.
  // Цикл дозапрашивает страницы, пока сервер не скажет has_more_older=false (или не
  // сработает страховочный потолок). Запросы идут своим originalFetch (мимо обёртки),
  // с заголовками исходного запроса страницы (auth/anti-bot) и credentials:'include'.
  // =====================================================================================
  var PQ_PAGE_CAP = 10;            // страховочный потолок страниц на прогон
  var PQ_TIME_CAP_MS = 30000;      // страховочный потолок времени на прогон
  var PQ_ERR_RETRY_CAP = 3;        // подряд ошибок сети/HTTP до остановки
  var PQ_ERR_BACKOFF_MS = 2000;    // пауза перед повтором после ошибки
  var PQ_PACE_MS = 200;            // пауза между страницами (не долбим сервер)
  var pq = null;                   // состояние прогона (null — пагинация не запущена)
  var lastHistoryHeaders = null;   // заголовки XHR-страницы для реплея (мост из consumeHistoryXhr)

  function qwenPaginationApi() {
    try {
      var api = (typeof window !== 'undefined') ? window.AiCmQwenPagination : null;
      return (api && typeof api.historyPageUrl === 'function') ? api : null;
    } catch (eApi) { return null; }
  }

  // Копия заголовков запроса страницы (fetch: Headers | [[k,v]] | {k:v}; плюс Request.headers).
  function collectRequestHeaders(input, init) {
    var out = {};
    try {
      var src = (init && init.headers) || (input && typeof input === 'object' ? input.headers : null);
      if (!src) return out;
      if (typeof src.forEach === 'function' && !Array.isArray(src)) {
        src.forEach(function (v, k) { if (k) out[String(k)] = String(v); });
      } else if (Array.isArray(src)) {
        for (var i = 0; i < src.length; i++) {
          if (src[i] && src[i].length >= 2) out[String(src[i][0])] = String(src[i][1]);
        }
      } else if (typeof src === 'object') {
        var keys = Object.keys(src);
        for (var j = 0; j < keys.length; j++) out[keys[j]] = String(src[keys[j]]);
      }
    } catch (eHdr) { swallow(eHdr, 'qwen:headers-collect'); }
    return out;
  }

  // O-53/O-55: страница (наш цикл или публичный ?cursor=) — все её ходы ниже пола, блок цел.
  function renumberHistoryPage(pageTurns, fromCycle, url) {
    var api = qwenPaginationApi(); if (!api || !pageTurns || !pageTurns.length) return;
    if (!fromCycle && !(api.isOlderPageUrl && api.isOlderPageUrl(url))) return;
    try { var base = api.assignPageOrders(pageTurns, api.floorOf(turns, pageTurns)); if (pq) pq.orderFloor = base; }
    catch (eOrd) { swallow(eOrd, 'qwen:page-orders'); }
  }

  // Старт пагинации по базовой странице. true — пагинация активна (снимок неполный).
  function startQwenPagination(meta, payload, createdCount) {
    var api = qwenPaginationApi();
    if (!api) return false;                       // модуль не подключён — поведение O-39 как было
    var m = meta || {};
    var chatId = String(m.chatId || currentChatId || '');
    if (!chatId) return false;
    if (pq && pq.running) {
      // Страница сайта во время прогона: свой цикл не плодим, курсор не откатываем назад.
      if (pq.chatId === chatId) {
        var alive = api.nextCursorOf(payload);
        if (alive && !pq.usedCursors[alive]) pq.cursor = alive;
      }
      return true;
    }
    var info = api.paginationInfo(payload);
    var cursor = api.nextCursorOf(payload);
    var cursorSrc = 'field';
    if (!cursor) {
      if (info && info.found && info.hasMoreOlder === false) return false;  // сервер: старше нет
      if (info && info.found && info.hasMoreOlder !== true) return false;   // флаг невнятный
      // Поля нет/не UUID, но сервер говорит «старше есть» — осторожная догадка по id.
      if (createdCount >= api.PAGE_LIMIT) {
        var guess = api.oldestMessageId(payload);
        if (guess) { cursor = guess; cursorSrc = 'id-guess'; }
      }
      if (!cursor) return false;
    }
    pq = {
      chatId: chatId,
      url: String(m.url || ''),
      headers: (m.headers && typeof m.headers === 'object') ? m.headers : lastHistoryHeaders,
      cursor: cursor,
      cursorSrc: cursorSrc,
      pages: 0,
      startTs: Date.now(),
      orderFloor: 0,
      usedCursors: {},
      lastAdded: 0,
      errStreak: 0,
      running: true,
      aborted: false,
      partialReason: ''
    };
    pq.usedCursors[cursor] = 1;
    diagTag('qwen-history', {
      ts: Date.now(), event: 'paginate-start', chat: String(chatId).slice(0, 8),
      url: pq.url, cursor: String(cursor).slice(0, 8), src: cursorSrc
    });
    setTimeout(pqStep, PQ_PACE_MS);
    return true;
  }

  // Один шаг: решение (потолки) → запрос страницы originalFetch → pqApplyPage.
  function pqStep() {
    if (!pq || !pq.running || pq.aborted) return;
    var api = qwenPaginationApi();
    if (!api) { pqAbort('module-missing'); return; }
    var decision = api.pageStepDecision({
      hasCursor: !!pq.cursor,
      pages: pq.pages,
      elapsedMs: Date.now() - pq.startTs,
      added: pq.lastAdded
    }, { pageCap: PQ_PAGE_CAP, timeCapMs: PQ_TIME_CAP_MS });
    if (decision.action === 'cap') { pqFinish(decision.reason); return; }
    if (!pq.cursor) { pqFinish('end'); return; }
    var url;
    try { url = api.historyPageUrl(pq.url, pq.cursor); } catch (eUrl) { pqFinish('error'); return; }
    if (!url) { pqFinish('end'); return; }
    diagTag('qwen-history', {
      ts: Date.now(), event: 'paginate-request', chat: String(pq.chatId).slice(0, 8),
      page: pq.pages + 1, cursor: String(pq.cursor).slice(0, 8), src: pq.cursorSrc
    });
    var opts = { method: 'GET', credentials: 'include' };
    if (pq.headers) opts.headers = pq.headers;
    var promise;
    try { promise = originalFetch.call(window, url, opts); }
    catch (eFetch) { pqFail(eFetch); return; }
    Promise.resolve(promise).then(function (resp) {
      if (!pq || !pq.running || pq.aborted) return null;
      if (!resp || !resp.ok) {
        var eHttp = new Error('http ' + (resp ? resp.status : 'none'));
        eHttp.status = resp ? resp.status : 0;
        throw eHttp;
      }
      return resp.json().then(function (json) { pqApplyPage(json); });
    }).catch(function (eStep) {
      if (!pq || !pq.running || pq.aborted) return;
      pqFail(eStep);
    });
  }

  // Страница добрана: применить её и решить, идти ли глубже.
  function pqApplyPage(json) {
    if (!pq || !pq.running || pq.aborted) return;
    if (currentChatId && pq.chatId && currentChatId !== pq.chatId) { pqAbort('chat-changed'); return; }
    var api = qwenPaginationApi();
    var res = null;
    try {
      res = applyHistoryPayload(json, { chatId: pq.chatId, url: pq.url, paginate: true });
    } catch (eApply) {
      diagTag('qwen-history', {
        ts: Date.now(), event: 'paginate-error', reason: 'apply',
        err: String(eApply && eApply.message || eApply).slice(0, 80)
      });
      pqFail(eApply);
      return;
    }
    if (!res || res.foreign) { pqAbort('foreign-chat'); return; }
    pq.pages++;
    pq.errStreak = 0;
    var added = res.added || 0;
    pq.lastAdded = added;
    var next = api ? api.nextCursorOf(json) : '';
    // Порядок важен: корень (has_more_older=false) может не добавить НИ ОДНОГО хода,
    // но это честный конец; отсутствие курсора БЕЗ флага «старше нет» — не конец (П1).
    if (!next) { pqFinish((api && typeof api.paginationInfo === 'function' && api.paginationInfo(json).hasMoreOlder === false) ? 'end' : 'no-cursor'); return; }
    if (!added) { pqFinish('no-gain'); return; }
    if (pq.usedCursors[next]) { pqFinish('cursor-loop'); return; }
    pq.cursor = next;
    pq.cursorSrc = 'field';
    pq.usedCursors[next] = 1;
    setTimeout(pqStep, PQ_PACE_MS);
  }

  // Ошибка шага: id-догадка → fail-open (end), иначе ретраи с бэкоффом, потом error.
  function pqFail(err) {
    if (!pq || !pq.running || pq.aborted) return;
    pq.errStreak++;
    var status = (err && typeof err.status === 'number') ? err.status : 0;
    diagTag('qwen-history', {
      ts: Date.now(), event: 'paginate-error', chat: String(pq.chatId).slice(0, 8),
      page: pq.pages + 1, status: status, err: String(err && err.message || err).slice(0, 80)
    });
    if (pq.cursorSrc === 'id-guess' && status >= 400 && status < 500) { pqFinish('end'); return; }
    if (pq.errStreak >= PQ_ERR_RETRY_CAP) { pqFinish('error'); return; }
    setTimeout(pqStep, PQ_ERR_BACKOFF_MS);
  }

  // Финал прогона: honest end — только исчерпание серверного курсора (reason='end').
  function pqFinish(reason) {
    if (!pq) return;
    var st = pq;
    st.running = false;
    st.partialReason = (reason === 'end') ? '' : reason;
    // R1: классификация «мягкого финала» живёт только в чистом модуле пагинации
    // (isSoftPartialReason); сюда уходит булев. В срез-песочницах тестов модуля нет —
    // тогда soft=false (поведение O-54 сохраняется).
    var pqApi = qwenPaginationApi();
    var soft = (pqApi && typeof pqApi.isSoftPartialReason === 'function')
      ? pqApi.isSoftPartialReason(reason) === true : false;
    diagTag('qwen-history', {
      ts: Date.now(), event: 'paginate', chat: String(st.chatId || '').slice(0, 8),
      pages: st.pages, reason: reason, soft: soft ? 1 : 0, added: turns.length,
      elapsed: Date.now() - st.startTs, cursorSrc: st.cursorSrc
    });
    var honest = (reason === 'end');
    try {
      emitSnapshot({
        chatId: st.chatId,
        url: st.url,
        complete: honest,
        partial: honest ? null : { pages: st.pages, reason: reason },
        partialSoft: (!honest && soft)
      });
    } catch (eFin) { swallow(eFin, 'qwen:paginate-finish'); }
  }

  // Прерывание без emit (сменился чат / ответ чужого чата): база не объявляется ни полной,
  // ни неполной — при смене чата снимок и так сбрасывается.
  function pqAbort(reason) {
    if (!pq) return;
    diagTag('qwen-history', {
      ts: Date.now(), event: 'paginate-abort', chat: String(pq.chatId || '').slice(0, 8),
      pages: pq.pages, reason: reason
    });
    pq.running = false;
    pq.aborted = true;
    pq = null;
  }

  // ===== Перехват fetch (обёртка по образцу core/deepseek-intercept.js:1861-1945) =====
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      var url = urlOf(input); try { if (typeof rememberFetchHeaders === 'function') rememberFetchHeaders(url, input, init); } catch (eRh) { swallow(eRh, 'qwen:auth-headers'); }
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
        } catch (eBody) { swallow(eBody, 'qwen:fetch-body-parse'); }
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
          // O-53: заголовки исходного запроса страницы — для реплея старых страниц
          // (source/version/anti-bot; cookies добавит credentials:'include').
          histMeta.headers = collectRequestHeaders(input, init);
        }
      }

      var promise;
      // onfreeze: синхронный бросок нативного fetch гасится в fetchGuarded
      try { promise = fetchGuarded(originalFetch, this, arguments); } catch (eCall) { return Promise.reject(eCall); }
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
            if (isFullHistoryUrl(histMeta.url)) noteNativeFullHistory(histMeta.chatId); consumeHistory(resp, histMeta);
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
  // события как есть. O-53: собственные запросы делает ТОЛЬКО цикл пагинации истории —
  // он идёт мимо этих обёрток (originalFetch), а страничные XHR не трогаются.
  try {
    if (typeof XMLHttpRequest === 'function' && XMLHttpRequest.prototype) {
      var origXHROpen = XMLHttpRequest.prototype.open;
      var origXHRSend = XMLHttpRequest.prototype.send;
      var origXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;
      XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        try { if (typeof isQwenApiUrl === 'function' && isQwenApiUrl(this.__aiCmQwenUrl)) { var oneHdr = {}; oneHdr[String(name)] = String(value); mergeQwenHeaders(oneHdr); }
          // O-53: копилка заголовков запроса страницы (auth/anti-bot) — для реплея страниц.
          if (this.__aiCmQwenHist) {
            if (!this.__aiCmQwenHistHeaders) this.__aiCmQwenHistHeaders = {};
            this.__aiCmQwenHistHeaders[String(name)] = String(value);
          }
        } catch (eXHdr) { /* ignore */ }
        return origXHRSetHeader.apply(this, arguments);
      };
      XMLHttpRequest.prototype.open = function (method, url) {
        try {
          // Сброс флага на экземпляре: повторный open() того же XHR не наследует старую историю.
          this.__aiCmQwenHist = null;
          this.__aiCmQwenHistHeaders = null; this.__aiCmQwenUrl = null;
          var xMethod = String(method == null ? 'GET' : method).toUpperCase();
          var xUrl = String(url == null ? '' : url); this.__aiCmQwenUrl = xUrl;
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
        } catch (eXOpen) { /* ignore */ }
        return origXHROpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        try {
          var xMeta = this.__aiCmQwenHist;
          if (xMeta) {
            var xSelf = this;
            xSelf.addEventListener('loadend', function () {
              try { consumeHistoryXhr(xSelf, xMeta); } catch (eXLoad) { swallow(eXLoad, 'qwen:xhr-loadend-history'); }
            });
          }
        } catch (eXSend) { /* ignore */ }
        return origXHRSend.apply(this, arguments);
      };
    }
  } catch (eXhrHook) { swallow(eXhrHook, 'qwen:install-network-hooks'); }

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
      // R2: файловое состояние принадлежит ОДНОМУ чату — очередь и тексты вложений не
      // переезжают в следующий разговор (SPA-переход не тащит секции покинутого чата).
      // typeof-гард — тот же приём, что у остальных точек контура: без модуля сброса нет.
      if (typeof aiCmQwenFiles !== 'undefined' && aiCmQwenFiles) {
        try { aiCmQwenFiles.qfReset(next); } catch (eQfReset) { swallow(eQfReset, 'qwen:files-reset'); }
      }
      // O-53: незавершённый прогон пагинации покинутого чата не продолжается.
      if (pq) pqAbort('chat-changed'); if (prev && fh[prev]) delete fh[prev]; fhFallback = null;
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
      } catch (eDispatch) { /* ignore */ }
      // O-35 (ДИАГНОСТИКА, только измерение): qwen-spa — хук смены разговора в MAIN-мире.
      // dispatched=1 — событие ушло в ISOLATED (ISOLATED-сторона отвечает строками
      // conv-changed-recv / reset-done / reshoot, затем qwen-adapter с sinceSpaResetMs>=0).
      // reset=1 — состояние ПЕРЕХВАТЧИКА (turns/userTurns/dispatchSig) сброшено этим же вызовом.
      diagTag('qwen-spa', {
        ts: Date.now(), event: 'chat-change', from: String(prev || '').slice(0, 8),
        to: String(next || '').slice(0, 8), convId: String(next || ''),
        url: diagUrl(), reset: 1, dispatched: dispatched
      });
    } catch (eCh) { swallow(eCh, 'qwen:checkChatChange'); }
  }
  try {
    var origPushState = history.pushState;
    if (origPushState) {
      history.pushState = function () {
        var r = origPushState.apply(this, arguments);
        try { checkChatChange(); } catch (eP) { /* ignore */ }
        return r;
      };
    }
    var origReplaceState = history.replaceState;
    if (origReplaceState) {
      history.replaceState = function () {
        var r = origReplaceState.apply(this, arguments);
        try { checkChatChange(); } catch (eR) { /* ignore */ }
        return r;
      };
    }
    window.addEventListener('popstate', function () { try { checkChatChange(); } catch (ePop) { /* ignore */ } });
  } catch (eHist) { /* ignore */ }

  // ===== R2: связка с модулем вложений (core/qwen-files.js) =====
  // Ядро отдаёт модулю два форвардера (emitSnapshot/diagLine) и три геттера
  // (currentChatId/originalFetch/lastEmitMeta). Обратных записей в состояние
  // перехватчика модуль не делает: секции вложений он отдаёт функциями qfSectionsFor /
  // qfSectionLength, а очередь наполняется вызовом qfEnqueueUserFiles из applyHistoryPayload.
  if (aiCmQwenFiles) {
    try {
      aiCmQwenFiles.__bind({
        emitSnapshot: emitSnapshot,
        diagLine: diagLine,
        get currentChatId() { return currentChatId; },
        get originalFetch() { return originalFetch; },
        get lastEmitMeta() { return lastEmitMeta; }
      });
    } catch (eBind) { swallow(eBind, 'qwen:files-bind'); }
  }

  // ===== Мосты для тестов/диагностики (только чтение, побочных эффектов нет) =====
  // Тесты гоняют РЕАЛЬНЫЙ файл и проверяют счётчики/состояние через эти ссылки;
  // боевой путь их не использует.
  window.__aiCmQwenBridge = {
    isQwenCompletions: isQwenCompletions,
    isQwenHistory: isQwenHistory, isFullHistoryUrl: isFullHistoryUrl,
    chatIdFromUrl: chatIdFromUrl,
    historyChatIdFromUrl: historyChatIdFromUrl,
    composeTurnText: composeTurnText,
    // O-39: чистый разбор payload истории и его применение к состоянию (тесты гоняют РЕАЛЬНЫЙ
    // файл; боевой путь вызывает то же самое из consumeHistory).
    parseQwenHistory: parseQwenHistory,
    applyHistory: function (payload, meta) { return applyHistoryPayload(payload, meta || {}); },
    // O-53: состояние прогона пагинации (null — не запущена) и ручной старт для тестов.
    paginateState: function () {
      if (!pq) return null;
      return {
        running: !!pq.running, chatId: pq.chatId, cursor: pq.cursor, cursorSrc: pq.cursorSrc,
        pages: pq.pages, orderFloor: pq.orderFloor, partialReason: pq.partialReason,
        usedCursors: Object.keys(pq.usedCursors)
      };
    },
    startPagination: function (payload, meta) { return startQwenPagination(meta || {}, payload, 0); },
    turns: function () { return turns; },
    // R2: снимок файлового состояния (очередь/тексты вложений) — только чтение.
    files: function () { return aiCmQwenFiles ? aiCmQwenFiles.qfStats() : null; },
    usage: function () { return sse ? sse.usage : null; },
    diagLines: function () { return diagLineCount; },
    diagOn: diagOn,
    applyFrames: function (objects) {
      if (!sse) beginStream({ chatId: currentChatId, userPrompt: '', parentId: '' });
      for (var i = 0; i < objects.length; i++) feedFrame({ data: JSON.stringify(objects[i]) });
      endStream('bridge');
    }
  };

  diagLine('installed', { chat: String(currentChatId || '').slice(0, 8) });
  console.log('[qwen-intercept] перехватчик Qwen установлен (только нативные запросы страницы, ' +
    'SSE через utils/stream-frames.ts, usage кумулятивный → последний кадр, ' +
    'фазы thinking_summary(REPLACE)/answer(APPEND), фолбэк — DOM-адаптер, ' +
    'O-39: JSON-история GET /api/v*N*/chats/{id} через resp.clone().json() (fetch) ' +
    'и XMLHttpRequest loadend (XHR/jQuery); ' +
    'O-53: курсорная пагинация истории (pagination.oldest_id, limit=10, до has_more_older=false)');

  // ===== O-56: нативная ПОЛНАЯ история (GET /api/v\d+/chats/{id} без query) =====
  // Сайт делает такой запрос только при экспорте (artifacts/qwen-native-export-network.json,
  // seq 319); на загрузке чата — курсорную страницу (seq 94). Если полный ответ сайта поймали
  // хуки выше — он просто разбирается. Иначе повторяем запрос сами, перенося заголовки живых
  // запросов страницы (authorization/bx-ua/bx-umidtoken/bx-v снимаются fetch init/Request.headers
  // и XHR setRequestHeader), cookies добавляет credentials:'include'. Провал → фолбэк на
  // прежнюю курсорную пагинацию по базовой странице.
  function qwenContentText(raw) {
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw)) {
      var parts = [];
      for (var i = 0; i < raw.length; i++) {
        var p = raw[i];
        if (typeof p === 'string' && p) parts.push(p);
        else if (p && typeof p === 'object' && typeof p.content === 'string' && p.content) parts.push(p.content);
      }
      return parts.join('\n\n');
    }
    if (raw && typeof raw === 'object' && typeof raw.content === 'string') return raw.content;
    return '';
  }
  // phase='thinking' полного ответа приводим к канонической фазе thinking_summary.
  function qwenThinkingItem(item) {
    if (!item || typeof item !== 'object') return item;
    if (item.phase !== 'thinking') return item;
    return {
      phase: PHASE_THINKING,
      content: (typeof item.content === 'string' && item.content) ? item.content
        : ((typeof item.reasoning_content === 'string') ? item.reasoning_content : ''),
      extras: item.extras || item.extra || null
    };
  }
  // reasoning полного ответа: отдельное поле reasoning_content (строка/массив) приоритетнее
  // content_list phase='thinking' — оно не зависит от разметки.
  function qwenReasoningOf(node) {
    if (!node || typeof node !== 'object') return '';
    var raw = node.reasoning_content;
    if (raw == null) raw = node.reasoningContent;
    return qwenContentText(raw);
  }
  // chat.history.messages (словарь) + currentId → цепочка предков от корня к currentId.
  // Узлы вне цепочки не теряем: дописываем в порядке ключей словаря.
  function qwenParseFullChain(payload) {
    function nodeIdOf(node) {
      if (!node || typeof node !== 'object') return '';
      var keys = ['id', 'message_id', 'msg_id', 'uuid', 'response_id', 'fid'];
      for (var i = 0; i < keys.length; i++) {
        var v = node[keys[i]];
        if (typeof v === 'string' && v) return v;
        if (typeof v === 'number') return String(v);
      }
      return '';
    }
    function parentIdOf(node) {
      if (!node || typeof node !== 'object') return '';
      if (typeof node.parentId === 'string') return node.parentId;
      if (typeof node.parent_id === 'string') return node.parent_id;
      return '';
    }
    var found = null;
    var seenRoots = [];
    function scan(node, depth) {
      if (found || !node || typeof node !== 'object' || depth > 6) return;
      for (var v = 0; v < seenRoots.length; v++) { if (seenRoots[v] === node) return; }
      seenRoots.push(node);
      var hist = node.history;
      if (hist && typeof hist === 'object' && hist.messages &&
        typeof hist.messages === 'object' && !Array.isArray(hist.messages)) {
        var cid = (typeof hist.currentId === 'string' && hist.currentId)
          ? hist.currentId
          : ((typeof hist.current_id === 'string' && hist.current_id) ? hist.current_id : '');
        if (cid) { found = { messages: hist.messages, currentId: cid }; return; }
      }
      for (var key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        var child = node[key];
        if (child && typeof child === 'object') scan(child, depth + 1);
      }
    }
    try { scan(payload, 0); } catch (eScan) { swallow(eScan, 'qwen:full-chain-scan'); }
    if (!found) return { nodes: [] };
    var byKey = {}, byId = {}, keys = [];
    for (var key in found.messages) {
      if (!Object.prototype.hasOwnProperty.call(found.messages, key)) continue;
      var node = found.messages[key];
      if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
      byKey[key] = node;
      var id = nodeIdOf(node);
      if (id && !byId[id]) byId[id] = node;
      keys.push(key);
    }
    function resolve(ref) { return ref ? (byKey[ref] || byId[ref] || null) : null; }
    // O-61: узел вне цепочки — копия с offChain:true, а не мутация payload (тело ответа
    // может разбираться повторно). Флаг переживает разбор и режет messages (parseQwenHistory).
    function markOffChain(node) {
      var copy = {};
      for (var k in node) {
        if (Object.prototype.hasOwnProperty.call(node, k)) copy[k] = node[k];
      }
      copy.offChain = true;
      return copy;
    }
    var seq = [], visited = [], cur = found.currentId, truncated = false;
    while (cur) {
      var curNode = resolve(cur);
      // Битый parentId / цикл: цепочка не дошла до корня. Ветвление тогда недоказано —
      // R1: НИЧЕГО не помечаем off-chain (все узлы остаются в messages, потери нет).
      if (!curNode || visited.indexOf(curNode) !== -1) { truncated = true; break; }
      visited.push(curNode); seq.push(curNode); cur = parentIdOf(curNode);
    }
    if (!seq.length) return { nodes: [] };
    seq.reverse();
    for (var i = 0; i < keys.length; i++) {
      var extra = byKey[keys[i]];
      if (visited.indexOf(extra) === -1) {
        visited.push(extra);
        seq.push(truncated ? extra : markOffChain(extra));
      }
    }
    return { nodes: seq };
  }
  // Полный документ: order = позиция в цепочке; ходы вне цепочки — после неё.
  function reindexByChain(pageTurns) {
    if (!pageTurns || !pageTurns.length) return;
    try {
      var inChain = {};
      for (var i = 0; i < pageTurns.length; i++) {
        if (!pageTurns[i]) continue;
        pageTurns[i].order = i;
        inChain[pageTurns[i].key] = 1;
      }
      var rest = [];
      for (var j = 0; j < turns.length; j++) {
        if (!turns[j] || inChain[turns[j].key]) continue;
        rest.push(turns[j]);
      }
      rest.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
      for (var k = 0; k < rest.length; k++) rest[k].order = pageTurns.length + k;
      if (pq) pq.orderFloor = 0;
    } catch (eReindex) { swallow(eReindex, 'qwen:reindex-chain'); }
  }
  // Полная форма URL: нет query либо в ней нет direction/limit/cursor.
  function isFullHistoryUrl(url) {
    try {
      var s = String(url || '');
      var q = s.indexOf('?');
      if (q === -1) return true;
      var query = s.slice(q + 1).split('#')[0];
      if (!query) return true;
      var parts = query.split('&');
      for (var i = 0; i < parts.length; i++) {
        var k = parts[i].split('=')[0];
        if (k === 'direction' || k === 'limit' || k === 'cursor') return false;
      }
      return true;
    } catch (eFull) { return false; }
  }

  // O-57: полная история чата уже принята (нативный GET /api/v2/chats/{id}) — страница
  // пагинации (direction/limit/cursor), которой сайт отвечает на прокрутку вверх, её больше
  // не перезаписывает. Наш собственный полный GET идёт мимо хуков (originalFetch) и помечен
  // m.full; полная форма URL распознаётся isFullHistoryUrl — оба случая гард пропускает.
  function fullHistoryBlocksPage(chatId, url, meta) {
    var m = meta || {};
    if (m.full === true) return false;                                  // наш полный GET
    if (typeof isFullHistoryUrl !== 'function') return false;            // срез-песочница
    if (isFullHistoryUrl(url)) return false;                            // сам полный документ
    if (typeof fh === 'undefined' || !fh) return false;
    var id = String(chatId || '');
    return !!id && fh[id] === 'done';
  }

  // O-57: единая точка пропуска страницы, когда полная история уже принята (диагностика
  // и форма ответа applyHistoryPayload — в одном месте).
  function skipFullHistoryPage(meta, transport) {
    var m = meta || {};
    var ev = { ts: Date.now(), event: 'skip', reason: 'full-history-applied', url: m.url || '' };
    if (transport) ev.transport = transport;
    diagTag('qwen-history', ev);
    return { added: 0, foreign: false, blocked: 'full-history' };
  }

  var FH_HEADER_NAMES = ['authorization', 'bx-ua', 'bx-umidtoken', 'bx-v', 'accept'];
  var qwenAuthHeaders = {};        // последние увиденные заголовки qwen API (lowercase-ключи)
  var fh = {};                     // chatId → 'pending' | 'done' | 'failed'
  var fhFallback = null;           // базовая страница на случай провала своего запроса

  function isQwenApiUrl(url) {
    try {
      var s = String(url || '');
      if (!/\/api\/v\d+\//.test(s)) return false;
      if (/^https?:\/\//i.test(s) && !/qwen\.ai/i.test(s)) return false;
      return true;
    } catch (eQa) { return false; }
  }
  function mergeQwenHeaders(src) {
    if (!src) return;
    try {
      for (var k in src) {
        if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
        var lk = String(k).toLowerCase();
        if (FH_HEADER_NAMES.indexOf(lk) === -1) continue;
        var v = src[k];
        if (v == null || v === '') continue;
        qwenAuthHeaders[lk] = String(v);
      }
    } catch (eMerge) { swallow(eMerge, 'qwen:auth-headers'); }
  }
  function rememberFetchHeaders(url, input, init) {
    if (!isQwenApiUrl(url)) return;
    mergeQwenHeaders(collectRequestHeaders(input, init));
  }
  function nativeFullHeaders() {
    var out = {};
    for (var k in qwenAuthHeaders) {
      if (Object.prototype.hasOwnProperty.call(qwenAuthHeaders, k)) out[k] = qwenAuthHeaders[k];
    }
    if (!out.accept) out.accept = 'application/json, text/plain, */*';
    return out;
  }
  function fullHistoryUrlOf(pageUrl, chatId) {
    try {
      var s = String(pageUrl || '');
      var q = s.indexOf('?');
      var noQuery = q === -1 ? s : s.slice(0, q);
      var h = noQuery.indexOf('#');
      if (h !== -1) noQuery = noQuery.slice(0, h);
      if (/\/api\/v\d+\/chats\/[A-Za-z0-9_-]+$/.test(noQuery)) return noQuery;
      var u = (typeof URL === 'function')
        ? new URL(s, (typeof location !== 'undefined' ? location.href : undefined)) : null;
      if (u && /\/api\/v\d+\/chats\//.test(u.pathname)) return u.origin + u.pathname;
      if (u) return u.origin + '/api/v2/chats/' + encodeURIComponent(chatId);
    } catch (eFullUrl) { swallow(eFullUrl, 'qwen:full-history-url'); }
    return '';
  }
  function noteNativeFullHistory(chatId) {
    if (chatId) fh[chatId] = 'done';
  }
  function ensureFullHistory(chatId, pageUrl, payload, meta, createdCount) {
    if (!chatId) return false;
    if (pq && pq.running) return false;                     // курсорный цикл уже идёт
    var state = fh[chatId];
    if (state === 'pending') return 'pending';
    if (state === 'done') return 'done';
    if (state === 'failed') return false;                   // уже пробовали — старый путь
    if (!qwenAuthHeaders['authorization']) return false;    // заголовков ещё нет
    var url = fullHistoryUrlOf(pageUrl, chatId);
    if (!url) return false;
    fh[chatId] = 'pending';
    fhFallback = { chatId: chatId, payload: payload, meta: meta, count: createdCount };
    var promise = null;
    try {
      promise = originalFetch.call(window, url, {
        method: 'GET',
        credentials: 'include',
        headers: nativeFullHeaders()
      });
    } catch (eCall) { fh[chatId] = 'failed'; return false; }
    Promise.resolve(promise).then(function (resp) {
      if (!resp || !resp.ok) throw new Error('http ' + (resp ? resp.status : 'none'));
      return resp.json();
    }).then(function (json) {
      fh[chatId] = 'done';
      fhFallback = null;
      diagTag('qwen-history', {
        ts: Date.now(), event: 'full-history', chat: String(chatId).slice(0, 8), url: url
      });
      try { applyHistoryPayload(json, { chatId: chatId, url: url, full: true }); }
      catch (eApplyFull) { swallow(eApplyFull, 'qwen:full-history-apply'); }
    }).catch(function (eFull) {
      if (fh[chatId] === 'done') return;
      if (currentChatId && String(currentChatId) !== String(chatId)) return;
      fh[chatId] = 'failed';
      diagTag('qwen-history', {
        ts: Date.now(), event: 'full-history-fail', chat: String(chatId).slice(0, 8),
        err: String(eFull && eFull.message || eFull).slice(0, 80)
      });
      var fb = fhFallback;
      fhFallback = null;
      if (!fb || fb.chatId !== chatId) return;
      var started = false;
      try { started = startQwenPagination(fb.meta || {}, fb.payload, fb.count); }
      catch (eFb) { swallow(eFb, 'qwen:full-history-fallback'); }
      if (!started) {
        try { emitSnapshot({ chatId: chatId, url: (fb.meta && fb.meta.url) || url, complete: true }); }
        catch (eFbEmit) { swallow(eFbEmit, 'qwen:full-history-fallback-emit'); }
      }
    });
    return 'pending';
  }
})();
