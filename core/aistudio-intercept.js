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
 * диалога запросами `$rpc` (UpdatePrompt / CreatePrompt / ListPrompts /
 * GenerateContent) — ответ это JSON-массив протобуфера. Снимок истории из Prompt
 * лежит в `data[13]` кортежами `[[null, "текст"], "role"]`, а живой ответ
 * GenerateContent приходит ВЛОЖЕННЫМ — `[[[[[null, "текст"]], "model"]]]` (текст на
 * 4 уровня глубже кортежа). Поэтому текст и роль ищутся на любой глубине
 * (findTextPart/findRole), а не по фиксированным индексам. Числовые 16-значные ID
 * (идентификаторы промптов/разговоров) за текст хода не принимаются. Отдельные
 * `$rpc`-запросы CountTokens отдают точное число токенов контекста — отдаём его как
 * serverTokens, как это делают перехватчики Gemini/Qwen/Claude.
 *
 * КАК. Патчим fetch и XMLHttpRequest (как core/gemini-sse.js: снимок оргиналов на
 * старте ДО кода страницы, цепочка вызовов не рвётся) и смотрим ТОЛЬКО тела
 * `$rpc`-ответов. Тело разбирается терпимо: JSON-массив протобуфера, XSSI-префикс
 * `)]}'`, ответ без массива — молча пропускаем.
 *
 * МОСТ. Наружу (в ISOLATED, core/content.js) уходят два события, detail — СТРОКОЙ
 * JSON (Xray/Firefox, v2.0.29; приём — aiCmBridgeDetail в core/content.js):
 *   'ai-cm-aistudio-net' { kind: 'history', msgs: [{role, text}], count, url, ts }
 *   'ai-cm-aistudio-net' { kind: 'count',   serverTokens, url, ts }
 * Обратный канал (ISOLATED→MAIN) — 'ai-cm-aistudio-net-settings' { verbose: true }:
 * включает подробные строки в консоли (разбирается тем же aiCmBridgeDetail).
 *
 * CONTRACT: никаких сетевых запросов отсюда не инициируется, данные не сохраняются —
 * только чтение уже полученных ответов и передача их в ISOLATED.
 */
(function () {
  'use strict';

  // Идемпотентность: повторная инъекция (импорт ×2, повторный registerContentScripts)
  // не должна навешивать вторую обёртку на fetch/XHR.
  if (window.AiCmAistudioIntercept) return;

  var LOG_TAG = '[aistudio-intercept]';
  var RPC_MARK = '$rpc';
  // Роли протобуфера AI Studio: 'user' у хода пользователя, 'model' у ответа
  // (встречается и 'assistant' — нормализуем обе формы к контракту адаптеров).
  var ROLE_USER = 'user';
  var ROLE_AI = 'assistant';

  var verbose = false;    // 'ai-cm-aistudio-net-settings' { verbose: true }
  var lastCount = 0;      // последнее CountTokens (дедуп лога)
  var lastHistorySig = ''; // подпись последнего снимка истории (дедуп лога)

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

  /** CountTokens: `$rpc/.../CountTokens` — точное число токенов контекста. */
  function isCountRpc(url) {
    return !!url && url.indexOf(RPC_MARK) !== -1 && /counttokens/i.test(url);
  }

  /**
   * История диалога под тем же `$rpc`:
   *   UpdatePrompt / CreatePrompt — полный снимок `data[13]` после смены ходов;
   *   ListPrompts  — история библиотеки промптов (снимок без новых чанков);
   *   GenerateContent — ответ модели (вложенная форма, см. findTextPart).
   * `create` покрывает `CreatePrompt` (и `Create*`), отдельно перечислять его не надо.
   * CountTokens сюда не попадает — у него своя ветка в handleResponse.
   */
  function isHistoryRpc(url) {
    if (!url || url.indexOf(RPC_MARK) === -1) return false;
    return /updateprompt|create|listprompts|generatecontent/i.test(url);
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
    if (c !== '[' && c !== '{') return null; // SSE-поток GenerateContent и text/plain
    try { return JSON.parse(s); } catch (ePj) { return null; }
  }

  /** Роли ответа модели в протобуфере AI Studio (всё остальное — ход человека). */
  var ROLES_AI = { model: 1, assistant: 1, ai: 1, system: 1, gemini: 1 };

  /** Роль хода из кортежа протобуфера → контракт адаптеров. */
  function normRole(role) {
    if (typeof role === 'string') {
      var r = role.toLowerCase();
      if (r === ROLE_USER || r === 'human') return ROLE_USER;
      if (ROLES_AI[r]) return ROLE_AI;
    }
    // Подавляющее большинство кортежей AI Studio — [[null, "текст"], "user"];
    // отсутствие роли трактуем как реплику пользователя (первая строка диалога).
    return ROLE_USER;
  }

  /** Максимальная глубина спуска при поиске текста/роли в протобуфере. */
  var MAX_TURN_DEPTH = 12;

  /** Строка — известная роль протобуфера ('user', 'model', 'assistant', ...). */
  function isRoleString(s) {
    if (typeof s !== 'string') return false;
    var r = s.toLowerCase();
    return r === ROLE_USER || r === 'human' || !!ROLES_AI[r];
  }

  /**
   * Числовой ID вместо текста. AI Studio кладёт в протобуфер 16-значные
   * идентификаторы промптов/разговоров (такие строки видны в логах `$rpc`), и
   * наивный обход принимал их за реплику. Число — не текст хода.
   */
  function isNumericId(s) {
    return typeof s === 'string' && /^\d{16}$/.test(s);
  }

  /** Строка годится в текст хода: не роль и не числовой ID. */
  function isUsableText(s) {
    return typeof s === 'string' && !isRoleString(s) && !isNumericId(s);
  }

  /**
   * TextPart протобуфера `[null, "текст"]` (поле 1 — номер части, поле 2 — текст)
   * на ЛЮБОЙ глубине. Реальный ответ GenerateContent — `[[[[[null, "текст"]],
   * "model"]]]`: текст лежит на четыре уровня глубже кортежа, поэтому поиск по
   * фиксированным индексам (item[0][1]) его не находил. Числовые ID пропускаем и
   * продолжаем поиск — иначе ID из служебного поля стал бы репликой.
   */
  function findTextPart(node, depth) {
    if (depth > MAX_TURN_DEPTH || !Array.isArray(node)) return null;
    if (node.length >= 2 && node[0] === null && isUsableText(node[1])) return node[1];
    for (var i = 0; i < node.length; i++) {
      var t = findTextPart(node[i], depth + 1);
      if (t !== null) return t;
    }
    return null;
  }

  /**
   * Роль хода на любой глубине. В разобранной форме GenerateContent роль стоит
   * рядом с TextPart, но не в item[1] — поэтому ищем её отдельным обходом.
   */
  function findRole(node, depth) {
    if (depth > MAX_TURN_DEPTH) return null;
    if (typeof node === 'string') return isRoleString(node) ? node : null;
    if (!Array.isArray(node)) return null;
    for (var i = 0; i < node.length; i++) {
      var r = findRole(node[i], depth + 1);
      if (r !== null) return r;
    }
    return null;
  }

  /** Текст без TextPart-обёртки (`["текст", "user"]`) — только при известной роли. */
  function findPlainText(node, depth) {
    if (depth > MAX_TURN_DEPTH) return null;
    if (typeof node === 'string') return isUsableText(node) ? node : null;
    if (!Array.isArray(node)) return null;
    for (var i = 0; i < node.length; i++) {
      var t = findPlainText(node[i], depth + 1);
      if (t !== null) return t;
    }
    return null;
  }

  /**
   * Один ход из элемента массива (вложенность произвольная) → {role, text}.
   * Голую строку без TextPart принимаем ТОЛЬКО в паре с ролью: иначе обход дерева
   * собирал бы «сообщения» из названий промптов и служебных полей ListPrompts.
   */
  function turnFromItem(item) {
    if (!Array.isArray(item) || item.length === 0) return null;
    var role = findRole(item, 0);
    var text = findTextPart(item, 0);
    if (text === null && role !== null) text = findPlainText(item, 0);
    if (text === null) return null;
    return { role: normRole(role), text: text };
  }

  /**
   * Кандидат-массив → сообщения. Формы элемента, которые понимаем:
   *   [[null, "текст"], "model"]        — кортеж Prompt (data[13]);
   *   [[[[[null, "текст"]], "model"]]]  — реальный ответ GenerateContent;
   *   [null, "текст"]                   — одиночный TextPart без роли (→ user);
   *   [["user", "текст"], "model"]      — терпимый вариант.
   */
  function msgsFromCandidate(arr) {
    var out = [];
    if (!Array.isArray(arr)) return out;
    for (var i = 0; i < arr.length; i++) {
      var turn = turnFromItem(arr[i]);
      if (turn === null) continue;
      var text = turn.text;
      var role = turn.role;
      var t = text.replace(/\r\n?/g, '\n').trim();
      if (!t) continue;
      out.push({ role: normRole(role), text: t });
    }
    return out;
  }

  /**
   * Массив сообщений истории из разобранного ответа. Приоритет — data[13]
   * (протобуфер Prompt: поле 13 = массив ходов), иначе обход в ширину по всему
   * дереву с выбором самого длинного валидного кандидата.
   */
  function findMessageArray(root) {
    var direct = (root && root[13]) ? msgsFromCandidate(root[13]) : [];
    if (direct.length > 0) return { msgs: direct, path: '13' };

    var best = { msgs: [], path: '' };
    var queue = [root];
    var guard = 0;
    while (queue.length > 0 && guard < 4000) {
      var node = queue.shift();
      guard++;
      if (Array.isArray(node)) {
        var m = msgsFromCandidate(node);
        if (m.length > best.msgs.length) best = { msgs: m, path: 'scan' };
        for (var i = 0; i < node.length; i++) {
          var ch = node[i];
          if (ch && typeof ch === 'object' && queue.length < 4000) queue.push(ch);
        }
      } else if (node && typeof node === 'object') {
        for (var k in node) {
          if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
          var v = node[k];
          if (v && typeof v === 'object' && queue.length < 4000) queue.push(v);
        }
      }
    }
    return best;
  }

  /** Число токенов из ответа CountTokens (форма `[5632]`): первое целое > 0. */
  function findCountNumber(root) {
    var queue = [root];
    var guard = 0;
    var local = [];
    while (queue.length > 0 && guard < 500) {
      var node = queue.shift();
      guard++;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) {
          var v = node[i];
          if (typeof v === 'number') local.push(v);
          else if (v && typeof v === 'object' && local.length === 0) queue.push(v);
        }
      } else if (node && typeof node === 'object') {
        for (var k in node) {
          if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
          var w = node[k];
          if (typeof w === 'number') local.push(w);
          else if (w && typeof w === 'object' && local.length === 0) queue.push(w);
        }
      }
      if (local.length > 0) break;
    }
    for (var j = 0; j < local.length; j++) {
      var n = local[j];
      if (isFinite(n) && n > 0 && n < 1e9 && n === Math.floor(n)) return n;
    }
    return 0;
  }

  /** История из тела ответа → [{role, text}] (пустой массив, если не наш формат). */
  function parseHistory(text) {
    var j = parseJsonText(text);
    if (j === null) return [];
    return findMessageArray(j).msgs;
  }

  /** CountTokens из тела ответа → число (0, если не наш формат). */
  function parseCountTokens(text) {
    var j = parseJsonText(text);
    if (j === null) return 0;
    return findCountNumber(j);
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

  /** Разбор одного ответа: классификация по URL, затем извлечение полезной нагрузки. */
  function handleResponse(url, text) {
    if (isCountRpc(url)) {
      var n = parseCountTokens(text);
      if (n <= 0 || n === lastCount) return;
      lastCount = n;
      if (verbose) console.log(LOG_TAG + ' serverTokens=' + n);
      emit({ kind: 'count', serverTokens: n, url: url });
      return;
    }
    if (!isHistoryRpc(url)) return;
    var msgs = parseHistory(text);
    if (msgs.length === 0) return;
    var lens = [];
    for (var i = 0; i < msgs.length; i++) lens.push(msgs[i].text.length);
    var sig = url + '|' + lens.join(',');
    if (sig === lastHistorySig) return;
    lastHistorySig = sig;
    // Критерий приёмки задачи: строка видна в консоли страницы при загрузке AI Studio.
    console.log(LOG_TAG + ' history loaded msgs=' + msgs.length);
    emit({ kind: 'history', msgs: msgs, count: msgs.length, url: url });
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
      var p = prevFetch.apply(this, arguments);
      if (!url || (!isCountRpc(url) && !isHistoryRpc(url))) return p;
      // Тело читаем с КЛОНА: оригинальный Response уходит странице нетронутым.
      return p.then(function (resp) {
        try {
          var ct = '';
          try { ct = String((resp.headers && resp.headers.get('content-type')) || ''); } catch (eH) { ct = ''; }
          if (ct.indexOf('event-stream') === -1 && typeof resp.clone === 'function') {
            resp.clone().text().then(function (txt) {
              try {
                handleResponse(url, txt);
              } catch (eP) {
                soft(eP, 'aistudio-intercept:fetch-body');
              }
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

    var send = function () {
      try {
        var self = this;
        self.addEventListener('load', function () {
          try {
            var url = self.__aiCmAistudioUrl || '';
            if (!url || (!isCountRpc(url) && !isHistoryRpc(url))) return;
            var ct = '';
            try { ct = String(self.getResponseHeader('content-type') || ''); } catch (eH) { ct = ''; }
            if (ct.indexOf('event-stream') !== -1) return;
            var rt = self.responseType;
            var text;
            if (rt === 'json') text = JSON.stringify(self.response);
            else if (rt === 'arraybuffer' || rt === 'blob' || rt === 'document') return;
            else text = self.responseText;
            handleResponse(url, text);
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
    version: 1,
    __handlers: {
      parseJsonText: parseJsonText,
      msgsFromCandidate: msgsFromCandidate,
      findMessageArray: findMessageArray,
      findCountNumber: findCountNumber,
      parseHistory: parseHistory,
      parseCountTokens: parseCountTokens,
      isCountRpc: isCountRpc,
      isHistoryRpc: isHistoryRpc,
      handleResponse: handleResponse
    },
    reset: function () {
      lastCount = 0;
      lastHistorySig = '';
    },
    stats: function () {
      return { lastCount: lastCount, lastHistorySig: lastHistorySig, verbose: verbose };
    }
  };
})();
