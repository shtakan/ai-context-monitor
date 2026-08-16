/**
 * Чистый парсер сетевой истории Gemini (batchexecute hNvQHb).
 * Работает в браузере (window.GeminiBatchexecuteParser) и в Node (module.exports).
 *
 * Назначение: привести сетевой путь (core/gemini-intercept.js) к чистому и
 * тестируемому виду. Извлекает текст ходов, исключая:
 *   - токены вложений $AXzLiR... (вырезаются по маске с схлопыванием пустот);
 *   - сегменты «мышления» (структурные блоки вида [["**Title** body"],"","","",[meta],"",""]
 *     и любые строки вида "**Title**...").
 * При этом сохраняются первый пользовательский промпт и markdown-таблицы ответа.
 *
 * Роли и порядок: каждый turn даёт ДО двух сообщений — {role:"user"} (вопрос) и
 * {role:"assistant"} (ответ). Turns приходят новые сверху, поэтому итоговый
 * массив сообщений разворачивается в хронологический порядок (от первого промпта).
 *
 * PARSER_VERSION — версия парсера; при смене версии core/gemini-intercept.js
 * принудительно пересобирает базу (инвалидация кэша старого формата).
 *
 * Функции:
 *   stripAttachmentTokens(s)  — вырезает $AXzLiR... из строки;
 *   collectTurnText(node,out)  — рекурсивный чистый сбор текста хода (в out);
 *   parseGeminiHistory(raw)    — полный разбор → { messages:{role,text}[], model, tokens, text, count }.
 */

(function () {
  var PARSER_VERSION = 'g1';

  // ---- токены вложений ----
  var ATTACH_TOKEN_RE = /\$AXzLiR[A-Za-z0-9+\/=]+/g;
  function stripAttachmentTokens(s) {
    if (typeof s !== 'string') return s;
    return s.replace(ATTACH_TOKEN_RE, ' ').replace(/[ \t\f\v]+/g, ' ');
  }

  // ---- фильтры мусора (идентичны core/gemini-intercept.js) ----
  function isIdLike(s) { return typeof s === 'string' && /^(c_|r_|rc_|fbb[0-9a-f]|[0-9a-f]{16})/.test(s); }
  function isFileLike(s) { return typeof s === 'string' && /\.(pdf|png|jpe?g|gif|docx?|txt|webp|csv|xlsx?)(\b|$)/i.test(s); }
  function isUrlLike(s) { return typeof s === 'string' && /^https?:\/\//i.test(s); }
  function isTokenLike(s) { return typeof s === 'string' && /^\$?AVuib/.test(s); }
  function isMimeLike(s) { return typeof s === 'string' && /^(image|application|video|audio)\//i.test(s); }
  var UI_BLACKLIST = {
    'DE': 1, 'ru': 1, 'mk': 1, 'generic': 1, 'personal_context': 1, 'google': 1,
    'Ищу в интернете': 1, 'Персональный контекст': 1, 'Google Search': 1, 'true': 1, 'false': 1
  };
  function isJunk(s) {
    if (typeof s !== 'string') return true;
    var t = s.trim();
    if (t.length === 0) return true;
    if (UI_BLACKLIST[t]) return true;
    return isIdLike(t) || isFileLike(t) || isUrlLike(t) || isTokenLike(t) || isMimeLike(t);
  }

  // ---- детекция «мышления» ----
  // Тексты мышления в ответе Gemini оборачиваются в markdown-заголовок "**Title**".
  var THINKING_TITLE_RE = /^\s*\*\*[^*\n]+\*\*/;
  function isThinkingString(s) {
    if (typeof s !== 'string') return false;
    return THINKING_TITLE_RE.test(s);
  }
  // Структурный блок мышления: массив, чей ПЕРВЫЙ элемент — markdown-заголовок "**Title**...".
  // Такие блоки пропускаем целиком, чтобы не вытащить тело мышления из вложенных метаданных,
  // но при этом не потерять соседние элементы (например, таблицу) в том же родительском массиве.
  function isThoughtBlock(node) {
    if (!Array.isArray(node)) return false;
    var head = node[0];
    return typeof head === 'string' && isThinkingString(head);
  }

  // ---- рекурсивный чистый сбор текста хода ----
  function collectTurnText(node, out) {
    if (typeof node === 'string') {
      var s = stripAttachmentTokens(node);
      if (!s || !s.trim()) return;
      if (isJunk(s) || isThinkingString(s)) return;
      out.push(s);
      return;
    }
    if (!Array.isArray(node)) return;
    if (isThoughtBlock(node)) return; // пропускаем сегмент мышления вместе с потомками
    for (var k = 0; k < node.length; k++) collectTurnText(node[k], out);
  }

  // ---- вопрос пользователя: первый строковый элемент контента хода (turn[2][0]) ----
  function extractUserQuestion(turn) {
    var content = (Array.isArray(turn) && turn.length > 2) ? turn[2] : null;
    if (Array.isArray(content) && content.length) {
      var first = content[0];
      if (typeof first === 'string') {
        var q = stripAttachmentTokens(first).trim();
        if (q && !isJunk(q) && !isThinkingString(q)) return q;
      }
    }
    return '';
  }

  // ---- модель/id/ts ----
  var MODEL_NAME_RE = /^\s*(?:Gemini\s*[\d.]?|\d+(?:\.\d+)?\s+(?:Flash|Pro|Ultra|Gemini))/i;
  function extractModelName(node) {
    var found = null;
    (function walk(n) {
      if (found) return;
      if (typeof n === 'string') {
        if (n.length < 60 && n.indexOf('\n') < 0 && MODEL_NAME_RE.test(n)) { found = n.trim(); return; }
      } else if (Array.isArray(n)) { for (var i = 0; i < n.length; i++) { walk(n[i]); if (found) return; } }
    })(node);
    return found || '';
  }
  function extractTurnId(node) {
    var found = null;
    (function walk(n) {
      if (found) return;
      if (typeof n === 'string' && /^r_[0-9a-f]+$/.test(n)) { found = n; return; }
      else if (Array.isArray(n)) { for (var i = 0; i < n.length; i++) { walk(n[i]); if (found) return; } }
    })(node);
    return found;
  }
  function extractTurnTs(t) {
    try {
      if (Array.isArray(t) && Array.isArray(t[1]) && typeof t[1][0] === 'number' && t[1][0] > 1000000000) return t[1][0];
    } catch (e) { }
    return 0;
  }

  // ---- каждый turn → до двух сообщений: user (вопрос) + assistant (ответ) ----
  function buildTurnMessages(turn) {
    var question = extractUserQuestion(turn);
    var parts = [];
    collectTurnText(turn, parts);
    var full = parts.join('\n').trim();
    var answer = full;
    if (question && answer.indexOf(question) === 0) {
      answer = answer.slice(question.length).replace(/^\s*\n+/, '').trim();
    }
    var msgs = [];
    if (question) msgs.push({ role: 'user', text: question });
    if (answer) msgs.push({ role: 'assistant', text: answer });
    return msgs;
  }

  // ---- разбор batchexecute ----
  function handleOuter(outer, out) {
    try {
      if (!Array.isArray(outer) || !Array.isArray(outer[0])) return;
      if (outer[0][1] !== 'hNvQHb') return;
      var inner = outer[0][2];
      if (typeof inner !== 'string') return;
      var turns = JSON.parse(inner);
      if (!Array.isArray(turns)) return;
      var realTurns = (Array.isArray(turns[0]) && Array.isArray(turns[0][0])) ? turns[0] : turns;

      // Turns приходят новые сверху — накапливаем группы, затем разворачиваем.
      var groups = [];
      for (var i = 0; i < realTurns.length; i++) {
        var t = realTurns[i];
        if (!Array.isArray(t)) continue;
        var modelName = extractModelName(t);
        var turnId = extractTurnId(t) || ('idx' + i);
        var turnTs = extractTurnTs(t);
        var msgs = buildTurnMessages(t);
        if (msgs.length) {
          groups.push({ id: turnId, ts: turnTs, modelName: modelName, msgs: msgs });
        }
      }

      // хронологический порядок: от первого промпта к последнему
      for (var r = groups.length - 1; r >= 0; r--) {
        var g = groups[r];
        for (var m = 0; m < g.msgs.length; m++) {
          out.push({
            role: g.msgs[m].role,
            content: g.msgs[m].text,
            model: g.modelName || '',
            id: g.id,
            ts: g.ts
          });
        }
      }
    } catch (e) { /* один кривой блок не ломает остальные */ }
  }

  function parseByBytes(raw, out) {
    var bytes;
    try { bytes = new TextEncoder().encode(raw); } catch (e) { return; }
    var pos = 0;
    if (bytes.length >= 4 && bytes[0] === 0x29 && bytes[1] === 0x5D && bytes[2] === 0x7D && bytes[3] === 0x27) pos = 4;
    var dec = new TextDecoder('utf-8');
    var guard = 0;
    while (pos < bytes.length && guard++ < 200) {
      while (pos < bytes.length && (bytes[pos] < 48 || bytes[pos] > 57)) pos++;
      if (pos >= bytes.length) break;
      var n = 0;
      while (pos < bytes.length && bytes[pos] >= 48 && bytes[pos] <= 57) { n = n * 10 + (bytes[pos] - 48); pos++; }
      if (n <= 0) { pos++; continue; }
      if (pos < bytes.length && bytes[pos] === 0x0A) pos++;
      var end = pos + n; if (end > bytes.length) end = bytes.length;
      var payloadStr = dec.decode(bytes.subarray(pos, end));
      pos = end;
      if (pos < bytes.length && bytes[pos] === 0x0A) pos++;
      if (payloadStr.indexOf('hNvQHb') !== -1) {
        try { handleOuter(JSON.parse(payloadStr), out); } catch (e) { }
      }
    }
  }

  function parseByLines(raw, out) {
    var lines = raw.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (!ln || ln === ")]}'") continue;
      var c0 = ln.charAt(0);
      if (c0 !== '[' && c0 !== '{') continue;
      if (ln.indexOf('hNvQHb') === -1) continue;
      try { handleOuter(JSON.parse(ln), out); } catch (e) { }
    }
  }

  function parseGeminiHistory(raw) {
    var parsed = [];
    parseByBytes(raw, parsed);
    if (!parsed.length) parseByLines(raw, parsed);

    var model = '';
    for (var i = 0; i < parsed.length; i++) {
      if (parsed[i].model) { model = parsed[i].model; break; }
    }

    var totalChars = 0;
    var buildTexts = [];
    for (var j = 0; j < parsed.length; j++) {
      var txt = parsed[j].content || '';
      totalChars += txt.length;
      buildTexts.push(txt);
    }

    // Нормализация: messages в формате {role, text, model, id, ts}
    var messages = parsed.map(function (m) {
      return { role: m.role, text: m.content, model: m.model || '', id: m.id, ts: m.ts || 0 };
    });

    return {
      messages: messages,
      model: model || 'Gemini 2.5 Pro',
      tokens: Math.ceil(totalChars / 4),
      text: buildTexts.join('\n'),
      count: messages.length
    };
  }

  var api = {
    PARSER_VERSION: PARSER_VERSION,
    stripAttachmentTokens: stripAttachmentTokens,
    collectTurnText: collectTurnText,
    splitTurnMessages: buildTurnMessages,
    parseGeminiHistory: parseGeminiHistory
  };

  if (typeof window !== 'undefined') {
    window.GeminiBatchexecuteParser = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();