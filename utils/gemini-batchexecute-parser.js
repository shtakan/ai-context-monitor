/**
 * Чистый парсер сетевой истории Gemini (batchexecute hNvQHb).
 * Работает в браузере (window.GeminiBatchexecuteParser) и в Node (module.exports).
 *
 * Структура хода (из живого образца):
 *   turn = [metaA, metaB, questionArr, answerArr, [ts, ...]]
 *   question = turn[2][0][0]  (строка)
 *   answer   = turn[3] (массив: видимая markdown-таблица + сегменты мышления)
 *
 * Извлекаемый текст хода НЕ содержит:
 *   - токены вложений $AXzLiR...;
 *   - сегменты мышления (структурные блоки с markdown-заголовком "**Title**...").
 *
 * Роли и порядок: каждый turn даёт до ДВУХ сообщений — {role:'user'} (вопрос) и
 * {role:'assistant'} (ответ). Turns в batchexecute приходят «новые сверху», поэтому
 * final-порядок разворачивается к хронологии. user ставится перед assistant внутри хода.
 * Каждый ход хранит r1 = id соседа НОВЕЕ (для связного списка порядка в intercept-logic).
 *
 * PARSER_VERSION — версия логики парсинга (экспортируется для диагностики).
 */

(function () {
  var PARSER_VERSION = 'g3';

  // ---- токены вложений ----
  var ATTACH_TOKEN_RE = /\$AXzLiR[A-Za-z0-9+\/=]+/g;
  function stripAttachmentTokens(s) {
    if (typeof s !== 'string') return s;
    return s.replace(ATTACH_TOKEN_RE, ' ').replace(/[ \t\f\v]+/g, ' ');
  }

  // Единая санация текста Gemini: токены вложений $AXzLiR, системная строка-заглушка
  // "File attachment was not previously registered" и [cite:N].
  function sanitizeGeminiText(s) {
    if (typeof s !== 'string') return s;
    return s
      .replace(/\$AXzLiR[A-Za-z0-9+\/=\s]+/g, ' ')
      .replace(/File attachment was not previously registered/g, '')
      .replace(/\[cite:\s*\d+\]/g, '');
  }

  // ---- фильтры мусора ----
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

  // ---- детекция мышления ----
  // (a) markdown-заголовок мышления: строка начинается с "**Title**".
  var THINKING_TITLE_RE = /^\s*\*\*[^*\n]{1,120}\*\*/;
  // Страховочные first-person вводные мышления Gemini (голое тело без **Title**).
  var THINKING_BODY_RE = /^(I'm now|I've been|I am going|I'm currently|I'm focusing|I'm working|I will now|I've fleshed|I've got|I need to|I'm going to|I've shifted|My focus is|I've settled|I've outlined|I've started|I'm aiming|My approach is|I'm leaning|I'm choosing|I'm prioritizing)\b/i;
  // Дополнительные стартовые тела мышления (голые first-person вводные без **Title**).
  var THINKING_BODY_EXTRA_RE = /^(I'm (?:currently|now|also|still) (?:focused|zeroing|analyzing|integrating|identifying|assessing|refining|evaluating|structuring|addressing|considering|formulating|prioritizing|parsing)|I've (?:been|now) (?:analyzing|noted|shifted|outlined|fleshed)|My (?:focus|goal) is|Specifically, I've)\b/i;
  // Герундийные титулы мышления, приходящие «голыми», без **Title**:
  // "Assessing the Core Task", "Defining the Scope", "Outlining the Procedure" и т.п.
  var THINKING_GERUND_RE = /^(Assessing|Defining|Refining|Outlining|Constructing|Uncovering|Tracing|Confirming|Reassuring|Clarifying|Deepening|Integrating|Evaluating|Formulating|Focusing|Prioritizing|Solidifying|Exploring|Analyzing|Reviewing|Validating|Synthesizing|Considering|Identifying|Structuring|Addressing|Reconstructing)\b/;
  // Системная строка вложения-заглушки — не должна попадать в историю.
  var FILE_ATTACHMENT_RE = /File attachment was not previously registered/;

  function hasCyrillic(s) {
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0x0400 && c <= 0x04FF) return true;
    }
    return false;
  }

  // Единый предикат «начала мышления»: **Title**, first-person вводная или герундий.
  // Кириллица всегда считается ответом (никогда мышлением).
  function isThinkingStart(s) {
    if (typeof s !== 'string') return false;
    var t = s.trim();
    if (!t) return false;
    if (hasCyrillic(t)) return false;
    if (THINKING_TITLE_RE.test(t)) return true;
    if (THINKING_BODY_RE.test(t)) return true;
    if (THINKING_BODY_EXTRA_RE.test(t)) return true;
    if (THINKING_GERUND_RE.test(t)) return true;
    return false;
  }

  // Предикат «ответного» сегмента (выход из режима скипа мышления):
  // сегмент считается ответом только если содержит кириллицу, markdown-таблицу
  // или code fence. Чисто английские тела мышления ответом НЕ являются.
  function isResponseSegment(s) {
    if (typeof s !== 'string') return false;
    var t = s.trim();
    if (!t) return false;
    if (hasCyrillic(t)) return true;
    if (/```/.test(t)) return true; // code fence
    if (/^\s*\|.+\|\s*$/m.test(t)) return true; // markdown-таблица
    return false;
  }

  // Блок мышления: массив, чей ПЕРВЫЙ элемент является маркером мышления —
  // либо строкой-началом мышления, либо вложенным массивом, у которого
  // глубже лежит такая строка. Проверяем только голову (не рекурсивно по всему
  // поддереву), чтобы не зацепить таблицу-соседку в одном родителе с мышлением.
  function headIsThinking(node, depth) {
    if (typeof node === 'string') return isThinkingStart(node);
    if (Array.isArray(node)) {
      if (depth > 4) return false;
      return headIsThinking(node[0], depth + 1);
    }
    return false;
  }
  function isThoughtBlock(node) {
    if (!Array.isArray(node)) return false;
    return headIsThinking(node[0], 0);
  }

  // ---- stateful-сбор текста ответа: run-skip мышления ----
  // После срабатывания маркера мышления пропускаем последующие сегменты, пока
  // не встретится «ответный» (кириллица/таблица/code fence). Это ловит
  // голые продолжения мышления ("I'm now zeroing in…", "Assessing the Core Task"),
  // приходящие отдельными строками без **Title**.
  function collectTurnText(node, out, state) {
    state = state || { inThinking: false };
    if (typeof node === 'string') {
      var s = sanitizeGeminiText(node);
      var t = s.trim();
      if (!t) return;
      if (FILE_ATTACHMENT_RE.test(t)) return; // системная строка-заглушка
      if (isJunk(t)) return;
      if (state.inThinking) {
        // v34: в режиме скипа пропускаем сегмент, пока в нём НЕТ кириллицы
        // И НЕТ markdown-таблицы/code fence. Выход только на ответном сегменте
        // (кириллица ИЛИ таблица ИЛИ code fence). Чисто английские тела мышления
        // (без маркера) больше не завершают скип.
        if (!isResponseSegment(t)) return;
        state.inThinking = false;
        out.push(s);
        return;
      }
      if (isThinkingStart(t)) { state.inThinking = true; return; }
      out.push(s);
      return;
    }
    if (!Array.isArray(node)) return;
    for (var k = 0; k < node.length; k++) collectTurnText(node[k], out, state);
  }

  // ---- вопрос пользователя: turn[2][0][0] ----
  function extractUserQuestion(turn) {
    var q = '';
    try { q = turn[2][0][0]; } catch (e) { q = ''; }
    if (typeof q === 'string') {
      var s = sanitizeGeminiText(q).trim();
      if (s && !isJunk(s) && !isThinkingStart(s)) return s;
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
  // r1 = id соседа НОВЕЕ (подтверждено логами idmap: t[1][1]).
  function extractTurnR1(t) {
    try {
      if (Array.isArray(t) && Array.isArray(t[1]) && typeof t[1][1] === 'string') return t[1][1];
    } catch (e) { }
    return null;
  }
  function extractTurnTs(t) {
    try {
      if (Array.isArray(t) && Array.isArray(t[4]) && typeof t[4][0] === 'number' && t[4][0] > 1000000000) return t[4][0];
    } catch (e) { }
    return 0;
  }

  // Чисто английский блок-мышление assistant (без кириллицы, начинающийся с герундия /
  // first-person вводной / префиксов "sr "/"Ev "). Смешанные блоки (с кириллицей) не трогаем.
  var THINKING_ASSISTANT_RE = /^([A-Z][a-z]+ing\b|I'm\b|I've\b|My (?:focus|goal)\b|sr |Ev )/;
  // Ведущий thinking-фрагмент (с необязательными ведущими * / **) — для среза в смешанных блоках.
  var LEADING_THINKING_RE = /^\s*\*?\*?([A-Z][a-z]+ing\b|I'm|I've|My (focus|goal)|sr |Ev )/;

  function isThinkingAssistant(s) {
    if (typeof s !== 'string') return false;
    var t = s.trim();
    if (!t) return false;
    if (hasCyrillic(t)) return false;
    return THINKING_ASSISTANT_RE.test(t);
  }

  function firstCyrillicIndex(s) {
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0x0400 && c <= 0x04FF) return i;
    }
    return -1;
  }

  // Срез ведущего thinking-фрагмента (до первого кириллического символа).
  // Чисто английский блок обрабатывается isThinkingAssistant отдельно.
  function stripLeadingThinking(s) {
    if (typeof s !== 'string') return s;
    var t = s.trim();
    if (!LEADING_THINKING_RE.test(t)) return s;
    var idx = firstCyrillicIndex(t);
    if (idx < 0) return ''; // нет кириллицы — мышление целиком
    return t.slice(idx);
  }

  // Маркеры markdown-разметки для выбора канонического сегмента ответа.
  // В одном ходе batchexecute лежат ТРИ копии ответа: канонический markdown-ответ
  // (turn[3][0][0][1][0]), англ. thinking-саммари (turn[3][0][0][37]) и plain-копия
  // без markdown (turn[3][12][0][0]). Канон — сегмент с markdown-разметкой.
  function hasMarkdownMarkup(t) {
    if (typeof t !== 'string') return false;
    if (/\*\*[^*\n]+\*\*/.test(t)) return true; // **жирный**
    if (/^\s*#{1,6}\s/m.test(t)) return true;   // заголовок
    if (/^\s*\|.+\|\s*$/m.test(t)) return true; // markdown-таблица
    if (/```/.test(t)) return true;             // code fence
    if (/^\s*[-*+]\s/m.test(t)) return true;    // пункт списка
    if (/^\s*>\s/m.test(t)) return true;        // цитата
    if (/\[[^\]]+\]\([^)]+\)/.test(t)) return true; // ссылка
    if (/^\s*(---+|\*\*\*+|___+)\s*$/m.test(t)) return true; // горизонтальная линия
    return false;
  }

  // Канонический сегмент ответа: первый сегмент с markdown-разметкой;
  // при отсутствии разметки — первый сегмент-ответ (фолбэк).
  function pickCanonicalAnswer(parts) {
    if (!parts || !parts.length) return '';
    for (var i = 0; i < parts.length; i++) {
      if (hasMarkdownMarkup(parts[i])) return parts[i];
    }
    return parts[0];
  }

  // Извлечение канонического ответа хода. В batchexecute ход несёт ТРИ копии ответа:
  //   - markdown-ответ: turn[3][0][0][1][0] (канон, с разметкой);
  //   - англ. thinking-саммари: turn[3][0][0][37];
  //   - plain-копия без разметки: turn[3][12][0][0].
  // Берём сегменты из контейнера turn[3][0][0][1] (не через collectTurnText, т.к. его
  // isFileLike отбрасывает markdown-ответ, содержащий ".docx" в списке файлов) и выбираем
  // первый markdown-сегмент. Фолбэк — прежний run-skip сбор collectTurnText (страховка).
  function extractCanonicalAnswer(turn) {
    var cands = [];
    try {
      var box = (Array.isArray(turn[3]) && Array.isArray(turn[3][0]) && Array.isArray(turn[3][0][0])) ? turn[3][0][0][1] : null;
      if (Array.isArray(box)) {
        for (var i = 0; i < box.length; i++) cands.push(box[i]);
      } else if (typeof box === 'string') {
        cands.push(box);
      }
    } catch (e) { }
    if (!cands.length) {
      try { collectTurnText(turn[3], cands); } catch (e) { }
    }
    var cleaned = [];
    for (var i = 0; i < cands.length; i++) {
      if (typeof cands[i] !== 'string') continue;
      var s = sanitizeGeminiText(cands[i]).trim();
      if (s) cleaned.push(s);
    }
    return pickCanonicalAnswer(cleaned);
  }

  // ---- turn → до двух сообщений ----
  function buildTurnMessages(turn) {
    var question = extractUserQuestion(turn);
    // Канон: только markdown-сегмент ответа; thinking-саммари и plain-копию не конкатенируем.
    var answer = extractCanonicalAnswer(turn).replace(/\n{3,}/g, '\n\n').trim();

    var msgs = [];
    if (question) msgs.push({ role: 'user', text: question });
    if (answer) {
      if (isThinkingAssistant(answer)) {
        // чисто английский thinking-блок assistant — исключаем целиком.
      } else {
        // смешанный: срезаем ведущий thinking-фрагмент до кириллицы.
        var kept = stripLeadingThinking(answer);
        if (kept) msgs.push({ role: 'assistant', text: kept });
      }
    }
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

      var rawCount = realTurns.length;
      // v35: raw внутри страницы идёт «новые→старые»; обходим от конца к началу,
      // чтобы порядок был хронологическим (фолбэк). Первичный порядок сборки —
      // связный список r1 в gemini-intercept-logic.js (не зависит от raw-порядка).
      for (var i = rawCount - 1; i >= 0; i--) {
        var t = realTurns[i];
        if (!Array.isArray(t)) continue;
        var modelName = extractModelName(t);
        var turnId = extractTurnId(t) || ('idx' + i);
        var turnTs = extractTurnTs(t);
        var r1 = extractTurnR1(t);
        var msgs = buildTurnMessages(t);
        for (var m = 0; m < msgs.length; m++) {
          var role = (msgs[m].role === 'user') ? 'user' : 'assistant';
          out.push({
            role: role,
            content: msgs[m].text,
            model: modelName || '',
            id: turnId + '_' + role,
            ts: turnTs,
            r1: r1
          });
        }
      }
    } catch (e) { /* кривой блок не ломает остальные */ }
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
    var messages = []; var texts = [];
    for (var j = 0; j < parsed.length; j++) {
      var txt = parsed[j].content || '';
      totalChars += txt.length;
      messages.push({ role: parsed[j].role, text: txt, model: parsed[j].model || '', id: parsed[j].id, ts: parsed[j].ts || 0, r1: parsed[j].r1 || null });
      texts.push(txt);
    }

    return {
      messages: messages,
      model: model || 'Gemini 2.5 Pro',
      tokens: Math.ceil(totalChars / 4),
      text: texts.join('\n'),
      count: messages.length
    };
  }

  var api = {
    PARSER_VERSION: PARSER_VERSION,
    stripAttachmentTokens: stripAttachmentTokens,
    sanitizeGeminiText: sanitizeGeminiText,
    collectTurnText: collectTurnText,
    isThinkingAssistant: isThinkingAssistant,
    firstCyrillicIndex: firstCyrillicIndex,
    stripLeadingThinking: stripLeadingThinking,
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