/**
 * core/aistudio-intercept.js — сетевой перехватчик истории Google AI Studio.
 *
 * МИР: MAIN (page world). Регистрируется из core/background.js через
 * chrome.scripting.registerContentScripts({ world: 'MAIN' }) для aistudio.google.com,
 * рядом с core/gemini-intercept.js (тот подключается к AI Studio ради счётчика
 * https://aistudio.google.com/generate_204, но историю диалога не разбирает).
 *
 * ЗАЧЕМ. Бейдж AI Studio считался по DOM (adapters/aistudio-adapter.js,
 * ms-cmark-node.v3-font-body): длинные ответы виртуализированы, часть реплик в DOM
 * отсутствует, а счётчик токенов был всегда эвристическим. AI Studio грузит историю
 * диалога и токены запросами `$rpc` (UpdatePrompt / CreatePrompt / GenerateContent) —
 * ответ и тело запроса это JSON-массив протобуфера. Точные пути взяты из живого
 * захвата (октябрь 2026, чат /prompts/1sLNDy3E1UDKpOyYVg1kcWCk6PvB70rOS, 3 хода):
 *
 *   • UpdatePrompt/CreatePrompt/ResolveDriveResource, ОТВЕТ — `data[13][0]`: массив
 *     сообщений, где текст хода лежит в `msg[0]`, роль — в `msg[8]` ('user' / 'model'),
 *     а `msg[19] === 1` помечает «мысль» модели (reasoning). ResolveDriveResource —
 *     тот же Prompt-ресурс, который AI Studio читает при холодном открытии
 *     /prompts/<id>; без него после F5 в бейдже было «2 узла» из виртуализированного
 *     DOM, а полная история появлялась только после первого UpdatePrompt. Мысль — не реплика диалога: в захвате
 *     каждая пара «мысль/ответ» лежит ДВУМЯ соседними сообщениями с ролью 'model'
 *     (9 сообщений на 3 хода), поэтому reasoning отфильтровывается — иначе история
 *     удваивалась бы и в счётчик попадал текст размышлений.
 *   • GenerateContent, ТЕЛО ЗАПРОСА — `data[1]`: массив ходов вида `[[part, ...],
 *     role]`, текст каждой части — `turn[0][j][1]`, роль — `turn[1]`. У ответа
 *     модели первая часть — reasoning (последний элемент части равен 1), остальные
 *     части — куски одного текста, поэтому склеиваются БЕЗ разделителя: фрагменты
 *     «Тест 1 пройден успешно! Связь работает отлично» + «. \n\nЧем могу помочь?»
 *     дают ровно ту же строку, что и сохранённое сообщение в ответе UpdatePrompt.
 *     Это самый свежий снимок: в теле уже есть только что отправленная реплика.
 *   • GenerateContent, ОТВЕТ — токены контекста. Тело — `[ [chunk, ...] ]`, каждый
 *     chunk это `[content, null, usage, null, id]`, а usage = `[promptTokens,
 *     candidateTokens, totalTokens, ...]`. Число токенов контекста — `chunk[2][0]`;
 *     значение накапливается по потоку (219 → 486), поэтому берётся максимум —
 *     это финальный promptTokenCount (486 в захвате; 634 total = 486 + 38 ответа +
 *     110 «мыслей», в контекст бейджа total не идёт).
 *
 * ПОЧЕМУ НЕ CountTokens. `$rpc/.../CountTokens` вызывается на каждый ввод и
 * возвращает только ВХОД (в захвате 9 или 5632 токена), без ответов модели: для
 * размера контекста диалога это неверное число. Ветка удалена — серверный счётчик
 * берётся из GenerateContent (как у Gemini/Qwen/Claude берётся из ответа модели).
 *
 * КАК. Патчим fetch и XMLHttpRequest (как core/gemini-sse.js: снимок оргиналов на
 * старте ДО кода страницы, цепочка вызовов не рвётся). У fetch читаем `init.body`
 * (только строка) и `clone().text()` ответа; у XHR — аргумент `send(body)` и
 * `responseText`/`response` по событию `load`. Тело разбирается терпимо: JSON-массив
 * протобуфера, XSSI-префикс `)]}'`, ответ без массива/SSE — молча пропускаем.
 *
 * БИНАРНЫЕ ТЕЛА (v2.0.30). Живой AI Studio отдаёт GenerateContent XHR'ом с
 * `responseType='arraybuffer'` — строки `responseText` там нет, а прежний код на
 * arraybuffer/blob просто выходил из обработчика, и usage-токены не доезжали до
 * бейджа. Теперь байты декодируются TextDecoder (UTF-8) в тот же JSON-протобуфер.
 * SSE-гард остался только у не-generate URL: стрим GenerateContent — источник usage
 * (кадры `data:...`), его тело обязано читаться.
 *
 * МОСТ. Наружу (в ISOLATED, core/content.js) уходят два события, detail — СТРОКОЙ
 * JSON (Xray/Firefox, v2.0.29; приём — aiCmBridgeDetail в core/content.js):
 *   'ai-cm-aistudio-net' { kind: 'history', msgs: [{role, text}], count, url, ts }
 *   'ai-cm-aistudio-net' { kind: 'count',   serverTokens, url, ts }
 * Обратный канал (ISOLATED→MAIN) — 'ai-cm-aistudio-net-settings' { verbose: true }:
 * включает подробные строки в консоли (разбирается тем же aiCmBridgeDetail).
 *
 * CONTRACT: никаких сетевых запросов отсюда не инициируется, данные не сохраняются —
 * только чтение уже полученных/отправленных тел и передача их в ISOLATED.
 */
(function () {
  'use strict';

  // Идемпотентность: повторная инъекция (импорт ×2, повторный registerContentScripts)
  // не должна навешивать вторую обёртку на fetch/XHR.
  if (window.AiCmAistudioIntercept) return;

  var LOG_TAG = '[aistudio-intercept]';
  var RPC_MARK = '$rpc';
  // Роли протобуфера AI Studio: 'user' у хода пользователя, 'model' у ответа.
  // В контракт адаптеров модель уходит как 'assistant'.
  var ROLE_USER = 'user';
  var ROLE_AI = 'assistant';

  var verbose = false;     // 'ai-cm-aistudio-net-settings' { verbose: true }
  var lastTokens = 0;      // последний promptTokenCount (дедуп лога/события)
  var lastHistorySig = ''; // подпись последнего снимка истории (дедуп)

  /* ================================================================== *
   * 0. Мост detail (Xray/Firefox): тело одинаковое во всех мирах
   *    (tests/firefox-xray-bridge.test.js: X3) — строка JSON разбирается,
   *    объект проходит как есть, мусор → null.
   * ================================================================== */

  function aiCmBridgeDetail(ev) {
    var raw = (ev && ev.detail !== undefined) ? ev.detail : null;
    if (typeof raw !== 'string') return raw || null;
    try { return JSON.parse(raw); } catch (eBd) { return null; }
  }

  function soft(e, tag) {
    if (typeof swallowSoft === 'function') { swallowSoft(e, tag); return; }
    // source-песочницы тестов грузят файл без utils/debug.js — тогда молчим:
    // консольный канал в MAIN-мире принадлежит aiCmDiagWarn (канал B, под гейтом).
    if (typeof aiCmDiagWarn !== 'function') return;
    // eslint-disable-next-line no-restricted-syntax
    aiCmDiagWarn('aistudio-intercept', tag + ': ' + ((e && e.message) ? e.message : String(e)));
  }

  // ISOLATED→MAIN: единственная настройка — подробные логи (по умолчанию молчим,
  // кроме обязательной строки 'history loaded msgs=N').
  window.addEventListener('ai-cm-aistudio-net-settings', function (ev) {
    var d = aiCmBridgeDetail(ev);
    if (d && typeof d.verbose === 'boolean') verbose = d.verbose;
  });

  /* ================================================================== *
   * 1. Классификация URL
   * ================================================================== */

  /**
   * GenerateContent под `$rpc`: тело запроса несёт историю (`data[1]`), ответ —
   * usage токенов (`[0][last][2][0]`). Оба потока разбираются в hooks.
   */
  function isGenerateRpc(url) {
    return !!url && url.indexOf(RPC_MARK) !== -1 && /generatecontent/i.test(url);
  }

  /**
   * История диалога под тем же `$rpc`: UpdatePrompt / CreatePrompt — ответ это
   * полный снимок `data[13][0]` после смены ходов; ResolveDriveResource — тот же
   * Prompt-ресурс, который AI Studio читает при холодном открытии /prompts/<id>
   * (до него в DOM лежат 1-2 виртуализированных узла, и бейдж показывал «2 узла»).
   *   ListPrompts сюда НЕ входит: это библиотека промптов, `data[13]` в её ответе нет
   *   (в живом захвате ответ ListPrompts — список карточек, не диалог).
   *   CountTokens сюда тоже не входит — счётчик берётся из GenerateContent.
   */
  function isHistoryRpc(url) {
    if (!url || url.indexOf(RPC_MARK) === -1) return false;
    return /updateprompt|createprompt|resolvedriveresource/i.test(url);
  }

  /* ================================================================== *
   * 2. Разбор тел (чистые функции — их пинует
   *    tests/adapters/aistudio-network.test.js)
   * ================================================================== */

  /** Тело ответа → значение JSON, либо null (не наш формат / SSE / мусор). */
  function parseJsonText(text) {
    if (typeof text !== 'string' || text.length === 0) return null;
    // XSSI-префикс Google: )]}' — и BOM на всякий случай.
    var s = text.replace(/^\uFEFF/, '').replace(/^\)\]\}'[^\n]*\n?/, '').trim();
    if (!s) return null;
    var c = s.charAt(0);
    if (c !== '[' && c !== '{') return null; // SSE-поток и text/plain
    try { return JSON.parse(s); } catch (ePj) { return null; }
  }

  /** Строка — известная роль протобуфера AI Studio (`msg[8]`, `turn[1]`). */
  function isRoleName(role) {
    return role === 'user' || role === 'model' || role === 'assistant' || role === 'human';
  }

  /** Роль хода протобуфера → контракт адаптеров ('user' | 'assistant'). */
  function normRole(role) {
    if (role === 'user' || role === 'human') return ROLE_USER;
    return ROLE_AI;
  }

  /**
   * Снимок из ОТВЕТА UpdatePrompt/CreatePrompt → сообщения.
   *
   * Точный путь: `root[13][0]` — массив сообщений, текст `msg[0]`, роль `msg[8]`,
   * `msg[19] === 1` — «мысль» модели (reasoning). Сообщения без строкового текста и
   * без известной роли отбрасываются: в `root[13]` рядом с историей встречаются
   * служебные кортежи (в запросе GenerateContent `root[13]` — таймзона, а не ходы),
   * и по индексам без проверки формы они стали бы «репликами».
   */
  function msgsFromSnapshot(root) {
    var out = [];
    if (!Array.isArray(root) || !Array.isArray(root[13]) || !Array.isArray(root[13][0])) return out;
    var msgs = root[13][0];
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (!Array.isArray(m)) continue;
      if (m[19] === 1) continue;                       // reasoning, не реплика
      if (typeof m[0] !== 'string' || !isRoleName(m[8])) continue;
      var text = m[0].replace(/\r\n?/g, '\n').trim();
      if (!text) continue;
      out.push({ role: normRole(m[8]), text: text });
    }
    return out;
  }

  /**
   * Reasoning-часть в теле запроса GenerateContent: у «мысли» последний элемент
   * части равен 1 (`[null, "**Interpreting…**", null, …, 1]`), у обычного текста
   * часть короче (`[null, "текст"]`) либо несёт подпись мысли строкой.
   */
  function isReasoningPart(part) {
    return part.length > 2 && part[part.length - 1] === 1;
  }

  /**
   * Снимок из ТЕЛА ЗАПРОСА GenerateContent → сообщения.
   *
   * Точный путь: `root[1]` — массив ходов `[[part, ...], role]`, текст части
   * `turn[0][j][1]`, роль `turn[1]`. Части одного хода склеиваются БЕЗ разделителя
   * (модель стримит ответ кусками, а storage хранит уже склеенную строку), reasoning
   * пропускается. Снимок самый свежий: в теле запроса уже есть отправленная реплика,
   * которой ещё нет в сохранённой истории (UpdatePrompt приходит после ответа).
   */
  function msgsFromRequest(root) {
    var out = [];
    if (!Array.isArray(root) || !Array.isArray(root[1])) return out;
    var turns = root[1];
    for (var i = 0; i < turns.length; i++) {
      var turn = turns[i];
      if (!Array.isArray(turn) || !Array.isArray(turn[0]) || !isRoleName(turn[1])) continue;
      var parts = turn[0];
      var buf = [];
      for (var j = 0; j < parts.length; j++) {
        var part = parts[j];
        if (!Array.isArray(part) || isReasoningPart(part)) continue;
        if (typeof part[1] !== 'string' || part[1].length === 0) continue;
        buf.push(part[1]);
      }
      var text = buf.join('').replace(/\r\n?/g, '\n').trim();
      if (!text) continue;
      out.push({ role: normRole(turn[1]), text: text });
    }
    return out;
  }

  /**
   * Массив сообщений истории из разобранного JSON. Приоритет — снимок ответа
   * (`data[13][0]`), затем тело запроса (`data[1]`). Возвращает ещё и путь —
   * он виден в диагностике/тестах, поэтому расхождение формы сразу заметно.
   */
  function findMessageArray(root) {
    var snap = msgsFromSnapshot(root);
    if (snap.length > 0) return { msgs: snap, path: '13[0]' };
    var req = msgsFromRequest(root);
    if (req.length > 0) return { msgs: req, path: '1' };
    return { msgs: [], path: '' };
  }

  /** История из тела (ответа UpdatePrompt/CreatePrompt либо запроса GenerateContent). */
  function parseHistory(text) {
    var root = parseJsonText(text);
    if (root === null) return [];
    return findMessageArray(root).msgs;
  }

  /**
   * Токены из одного элемента ответа GenerateContent. Чанк потока —
   * `[content, null, usage, null, id]`, usage — `[prompt, candidates, total, …]`;
   * в бейдж идёт prompt (размер контекста), не total: total включает ответ и
   * «мысли», и на следующем ходе он был бы уже про другой контекст.
   */
  function tokensFromChunk(chunk) {
    if (!Array.isArray(chunk) || !Array.isArray(chunk[2])) return 0;
    var n = chunk[2][0];
    if (typeof n !== 'number' || !isFinite(n) || n <= 0 || n >= 1e9) return 0;
    return Math.floor(n);
  }

  /**
   * Токены контекста из ответа GenerateContent → promptTokenCount (0 — нет данных).
   *
   * Основной путь: `root[0][last][2][0]`. Значение накапливается по потоку
   * (219 → 486 в захвате), поэтому берётся максимум — это финальный счётчик.
   * Обход ограничен (guard/глубина 2): форма с единственным чанком и вариант
   * `[chunk, chunk]` без внешнего массива тоже разбираются, а чужие тела — нет.
   */
  /**
   * Разобранные корни тела ответа: один JSON-массив протобуфера либо кадры
   * `data:` генеративного стрима (AI Studio отдаёт GenerateContent и так).
   * Пустой массив — тело не нашего формата.
   */
  function jsonRoots(text) {
    var root = parseJsonText(text);
    if (root !== null) return [root];
    if (typeof text !== 'string' || text.length === 0) return [];
    var out = [];
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf('data:') !== 0) continue;
      var payload = parseJsonText(line.slice(5).trim());
      if (payload !== null) out.push(payload);
    }
    return out;
  }

  function parseUsageTokens(text) {
    var roots = jsonRoots(text);
    if (roots.length === 0) return 0;
    var best = 0;
    var queue = roots.slice();
    var guard = 0;
    while (queue.length > 0 && guard < 200) {
      var node = queue.shift();
      guard++;
      if (!Array.isArray(node)) continue;
      var n = tokensFromChunk(node);
      if (n > best) best = n;
      for (var i = 0; i < node.length; i++) {
        var child = node[i];
        if (Array.isArray(child) && queue.length < 200) queue.push(child);
      }
    }
    return best;
  }

  /* ================================================================== *
   * 2b. Бинарные тела ответа (responseType = 'arraybuffer' | 'blob')
   *
   * ПОЧЕМУ. GenerateContent в живом AI Studio приходит XHR'ом с
   * `responseType='arraybuffer'` (в Playwright/Chrome тело лежит байтами, а не
   * строкой). Прежний код выходил из обработчика load на arraybuffer/blob/document —
   * usage-токены не доезжали до бейджа вообще. Декодирование в UTF-8 возвращает тот
   * же JSON-массив протобуфера, который дальше разбирают те же parse* функции.
   * ================================================================== */

  /** ArrayBuffer / view (Uint8Array, Buffer) → строка UTF-8; иначе '' (молча). */
  function decodeBinaryBody(raw) {
    if (!raw) return '';
    try {
      if (typeof raw === 'string') return raw;
      var bytes = null;
      if (typeof ArrayBuffer !== 'undefined' && raw instanceof ArrayBuffer) {
        bytes = new Uint8Array(raw);
      } else if (raw && typeof raw.byteLength === 'number' && typeof ArrayBuffer !== 'undefined'
        && raw.buffer instanceof ArrayBuffer) {
        // View с ненулевым смещением (Buffer из пула) — берём ровно свой диапазон.
        bytes = new Uint8Array(raw.buffer, raw.byteOffset || 0, raw.byteLength);
      }
      if (!bytes || bytes.length === 0) return '';
      if (typeof TextDecoder === 'function') return new TextDecoder('utf-8').decode(bytes);
      return '';
    } catch (eDec) {
      soft(eDec, 'aistudio-intercept:decode-body');
      return '';
    }
  }

  /** Blob → строка: blob.text() (браузер/Node) либо FileReader; иначе молчим. */
  function decodeBlobBody(blob, cb) {
    if (!blob || typeof cb !== 'function') return;
    try {
      if (typeof blob.text === 'function') {
        blob.text().then(cb, function () { /* тело недоступно — не ошибка перехватчика */ });
        return;
      }
    } catch (eBt) {
      soft(eBt, 'aistudio-intercept:blob-text');
      return;
    }
    if (typeof FileReader !== 'function') return;
    try {
      var fr = new FileReader();
      fr.onload = function () { cb(typeof fr.result === 'string' ? fr.result : ''); };
      fr.readAsText(blob);
    } catch (eFr) {
      soft(eFr, 'aistudio-intercept:blob-reader');
    }
  }

  /* ================================================================== *
   * 3. Передача в ISOLATED (detail — строка JSON, Xray/Firefox)
   * ================================================================== */

  function emit(payload) {
    try {
      payload.site = 'aistudio';
      payload.ts = Date.now();
      window.dispatchEvent(new CustomEvent('ai-cm-aistudio-net', {
        detail: JSON.stringify(payload)
      }));
    } catch (eEm) {
      soft(eEm, 'aistudio-intercept:emit');
    }
  }

  /** djb2: подпись снимка, чтобы не гонять один и тот же массив в ISOLATED. */
  function hashText(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  function historySig(msgs) {
    var parts = [];
    for (var i = 0; i < msgs.length; i++) {
      parts.push((msgs[i].role === ROLE_AI ? 'a' : 'u') + msgs[i].text.length + ':' + hashText(msgs[i].text));
    }
    return parts.join('|');
  }

  /** Отправка снимка истории в мост с дедупом по содержимому. */
  function emitHistory(msgs, url) {
    if (!msgs || msgs.length === 0) return;
    var sig = String(url || '') + '|' + historySig(msgs);
    if (sig === lastHistorySig) return;
    lastHistorySig = sig;
    // Критерий приёмки задачи: строка видна в консоли страницы при загрузке AI Studio.
    console.log(LOG_TAG + ' history loaded msgs=' + msgs.length);
    emit({ kind: 'history', msgs: msgs, count: msgs.length, url: url });
  }

  /** Тело ЗАПРОСА: у GenerateContent это свежий снимок диалога (`data[1]`). */
  function handleRequest(url, text) {
    if (!isGenerateRpc(url)) return;
    try {
      emitHistory(parseHistory(text), url);
    } catch (eHQ) {
      soft(eHQ, 'aistudio-intercept:request-parse');
    }
  }

  /** Тело ОТВЕТА: GenerateContent — usage токенов, UpdatePrompt/CreatePrompt — история. */
  function handleResponse(url, text) {
    try {
      if (isGenerateRpc(url)) {
        var tokens = parseUsageTokens(text);
        if (tokens <= 0 || tokens === lastTokens) return;
        lastTokens = tokens;
        if (verbose) console.log(LOG_TAG + ' serverTokens=' + tokens);
        emit({ kind: 'count', serverTokens: tokens, url: url });
        return;
      }
      if (!isHistoryRpc(url)) return;
      emitHistory(parseHistory(text), url);
    } catch (eHR) {
      soft(eHR, 'aistudio-intercept:response-parse');
    }
  }

  /* ================================================================== *
   * 4. Патчи fetch и XMLHttpRequest
   * ================================================================== */

  function urlOfFetchInput(input) {
    try {
      if (typeof input === 'string') return input;
      if (input && typeof input.url === 'string') return input.url;
      return String(input == null ? '' : input);
    } catch (eU) {
      return '';
    }
  }

  function installFetchHook() {
    if (typeof window.fetch !== 'function') return;
    var prevFetch = window.fetch;
    if (!prevFetch || prevFetch.__aiCmAistudioWrapped) return;

    var wrapped = function fetch(input, init) {
      var url = urlOfFetchInput(input);
      var interesting = !!url && (isGenerateRpc(url) || isHistoryRpc(url));
      var p = prevFetch.apply(this, arguments);
      if (!interesting) return p;

      // Тело запроса доступно только строкой (Request читается асинхронно, а
      // FormData/Blob/ArrayBuffer нам не нужны): живой ввод AI Studio — строка JSON.
      try {
        if (init && typeof init.body === 'string' && init.body) handleRequest(url, init.body);
      } catch (eQ) {
        soft(eQ, 'aistudio-intercept:fetch-request');
      }

      // Тело ответа читаем с КЛОНА: оригинальный Response уходит странице нетронутым.
      // SSE-гард — только для не-generate URL: у UpdatePrompt тело это повтор истории,
      // который читать незачем, а стрим GenerateContent несёт usage (кадры `data:`)
      // и обязан доехать до бейджа.
      return p.then(function (resp) {
        try {
          var ct = '';
          try { ct = String((resp.headers && resp.headers.get('content-type')) || ''); } catch (eH) { ct = ''; }
          var sse = ct.indexOf('event-stream') !== -1;
          if ((!sse || isGenerateRpc(url)) && typeof resp.clone === 'function') {
            resp.clone().text().then(function (txt) {
              handleResponse(url, txt);
            }, function () {
              // тело уже занято страницей — это не ошибка перехватчика
            });
          }
        } catch (eR) {
          soft(eR, 'aistudio-intercept:fetch-clone');
        }
        return resp;
      });
    };
    wrapped.__aiCmAistudioWrapped = true;
    window.fetch = wrapped;
  }

  function installXhrHook() {
    var Xhr = window.XMLHttpRequest;
    if (!Xhr || !Xhr.prototype) return;
    var proto = Xhr.prototype;
    var prevOpen = proto.open;
    var prevSend = proto.send;
    if (typeof prevOpen !== 'function' || typeof prevSend !== 'function') return;
    if (prevSend.__aiCmAistudioWrapped) return;

    proto.open = function (method, url) {
      try {
        this.__aiCmAistudioUrl = (url === undefined || url === null) ? '' : String(url);
      } catch (eO) {
        this.__aiCmAistudioUrl = '';
      }
      return prevOpen.apply(this, arguments);
    };

    var send = function (body) {
      // Тело запроса нужно раньше ответа: снимок истории отправляется сразу в send(),
      // ещё до того как придут чанки (в теле уже есть только что отправленная реплика).
      try {
        var urlNow = this.__aiCmAistudioUrl || '';
        if (typeof body === 'string' && body && urlNow && isGenerateRpc(urlNow)) {
          handleRequest(urlNow, body);
        }
      } catch (eQ) {
        soft(eQ, 'aistudio-intercept:xhr-request');
      }
      try {
        var self = this;
        self.addEventListener('load', function () {
          try {
            var url = self.__aiCmAistudioUrl || '';
            if (!url || (!isGenerateRpc(url) && !isHistoryRpc(url))) return;
            var ct = '';
            try { ct = String(self.getResponseHeader('content-type') || ''); } catch (eH) { ct = ''; }
            // Не-generate SSE — повтор истории/служебный стрим: тело не читаем.
            if (ct.indexOf('event-stream') !== -1 && !isGenerateRpc(url)) return;
            var rt = self.responseType || '';
            // GenerateContent в живом AI Studio: байты, а не строка (см. 2b).
            if (rt === 'arraybuffer') {
              var fromBuffer = decodeBinaryBody(self.response);
              if (fromBuffer) handleResponse(url, fromBuffer);
              return;
            }
            if (rt === 'blob') {
              decodeBlobBody(self.response, function (fromBlob) {
                if (fromBlob) handleResponse(url, fromBlob);
              });
              return;
            }
            if (rt === 'document') return;
            if (rt === 'json') handleResponse(url, JSON.stringify(self.response));
            else handleResponse(url, self.responseText);
          } catch (eL) {
            soft(eL, 'aistudio-intercept:xhr-load');
          }
        });
      } catch (eS) {
        soft(eS, 'aistudio-intercept:xhr-send');
      }
      return prevSend.apply(this, arguments);
    };
    send.__aiCmAistudioWrapped = true;
    proto.send = send;
  }

  installFetchHook();
  installXhrHook();

  window.AiCmAistudioIntercept = {
    version: 3,
    __handlers: {
      parseJsonText: parseJsonText,
      jsonRoots: jsonRoots,
      decodeBinaryBody: decodeBinaryBody,
      msgsFromSnapshot: msgsFromSnapshot,
      msgsFromRequest: msgsFromRequest,
      findMessageArray: findMessageArray,
      parseHistory: parseHistory,
      parseUsageTokens: parseUsageTokens,
      isGenerateRpc: isGenerateRpc,
      isHistoryRpc: isHistoryRpc,
      handleRequest: handleRequest,
      handleResponse: handleResponse
    },
    reset: function () {
      lastTokens = 0;
      lastHistorySig = '';
    },
    stats: function () {
      return { lastTokens: lastTokens, lastHistorySig: lastHistorySig, verbose: verbose };
    }
  };
})();
