/**
 * Изолированный хелпер парсера batchexecute Gemini для тестов.
 * Выделен из core/gemini-intercept.js, не зависит от DOM/браузерного API.
 * Функции: parseBatchExecute(raw) → { messages: [...], model: string, tokens: number }
 */

// ---- фильтры мусора (из gemini-intercept.js) ----
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
  if (s.length === 0) return true;
  if (UI_BLACKLIST[s]) return true;
  return isIdLike(s) || isFileLike(s) || isUrlLike(s) || isTokenLike(s) || isMimeLike(s);
}
function isThinking(s) {
  if (typeof s !== 'string' || s.length < 30) return false;
  var cyr = 0, lat = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c >= 0x0400 && c <= 0x04FF) cyr++;
    else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) lat++;
  }
  if (cyr > 0) return false;
  if (lat < 30) return false;
  return s.indexOf('**') !== -1;
}

// ---- рекурсивный сбор текста хода ----
function collectContent(node, out) {
  if (typeof node === 'string') {
    if (!isJunk(node) && !isThinking(node) && !isMimeLike(node)) out.push(node);
    return;
  }
  if (!Array.isArray(node)) return;
  for (var k = 0; k < node.length; k++) collectContent(node[k], out);
}

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

// ---- байтовый парсер (длина в байтах UTF-8) ----
function handleOuter(outer, out, src) {
  try {
    if (!Array.isArray(outer) || !Array.isArray(outer[0])) return;
    if (outer[0][1] !== 'hNvQHb') return;
    var inner = outer[0][2];
    if (typeof inner !== 'string') return;
    var turns = JSON.parse(inner);
    if (!Array.isArray(turns)) return;
    var realTurns = (Array.isArray(turns[0]) && Array.isArray(turns[0][0])) ? turns[0] : turns;
    for (var i = 0; i < realTurns.length; i++) {
      var t = realTurns[i];
      if (!Array.isArray(t)) continue;
      var pieces = []; collectContent(t, pieces);
      var text = pieces.join('\n').trim();
      var modelName = extractModelName(t);
      if (text) out.push({ role: 'assistant', content: text, model: modelName || '' });
    }
  } catch (e) { /* один кривой блок не ломает остальные */ }
}

function parseByBytes(raw, out, src) {
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
      try { handleOuter(JSON.parse(payloadStr), out, src); } catch (e) { }
    }
  }
}

function parseByLines(raw, out, src) {
  var lines = raw.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    if (!ln || ln === ")]}'") continue;
    var c0 = ln.charAt(0);
    if (c0 !== '[' && c0 !== '{') continue;
    if (ln.indexOf('hNvQHb') === -1) continue;
    try { handleOuter(JSON.parse(ln), out, src); } catch (e) { }
  }
}

/**
 * Парсит сырой ответ batchexecute Gemini.
 * @param {string} raw - сырой текст ответа
 * @returns {{ messages: Array<{role:string, content:string, model:string}>, model: string, tokens: number }}
 */
function parseBatchExecute(raw) {
  var messages = [];
  var parsed = [];
  parseByBytes(raw, parsed, 'test');
  if (!parsed.length) parseByLines(raw, parsed, 'test');
  messages = parsed;

  var model = '';
  for (var i = 0; i < messages.length; i++) {
    if (messages[i].model) { model = messages[i].model; break; }
  }

  // Оценка токенов: суммарная длина всех сообщений / 4 (грубая оценка)
  var totalChars = 0;
  for (var j = 0; j < messages.length; j++) {
    totalChars += messages[j].content.length;
  }
  var tokens = Math.ceil(totalChars / 4);

  return { messages: messages, model: model || 'Gemini 2.5 Pro', tokens: tokens };
}

module.exports = { parseBatchExecute };