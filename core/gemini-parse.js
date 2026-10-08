// core/gemini-parse.js — Phase 3 шаг 6: кластер парсеров кадра batchexecute вынесен из
// core/gemini-intercept.js (строки 1468–1865 на момент выноса) в отдельный модуль.
//
// ЧТО ЗДЕСЬ: парсер кадров batchexecute (parseByBytes / parseByLines / parseBatchExecute) вместе
// с tolerant-salvage обрезанного кадра (isTurnLikeSpan / noteJsonChild / closeTruncatedJson /
// unescapeJsonLiteralPrefix / extractTruncatedInner / handleSalvagedOuter / salvagePartialFrame).
// Вложенные помощники parseByBytes (utf8Len / reEncodedLenOfRaw / charCodeView / framingStrictScore /
// jsonValueEnd / jsonTailIsBlank / extractJsonPayload и константа JSON_FRAME_OVERRUN_MAX) остались
// ВНУТРИ parseByBytes намеренно: песочницы тестов (O-48 / O-50 / O-52 / gemini-partial-frame-parse)
// собирают parseByBytes изолированно по имени (конвенция fnDecl), и верхнеуровневые имена им не видны.
//
// ПОЧЕМУ ВЫНЕСЕНО: ядро ~5.2k строк; парсеры — автономный слой «входные байты → ходы», который не
// оркестрирует сеть и не держит состояние сам: он лишь зовёт handleOuter (оркестрация хода остаётся
// в ядре) и пишет 5 переменных полноты.
//
// СВЯЗКА (паттерн core/gemini-diag.js и core/gemini-rpc.js): ядро зовёт __bind(...) и передаёт
//   - handleOuter — функция ядра (оркестрация хода: turnsMap / курсор / диагностика);
//   - lastFrameParseFail — геттер+сеттер (его читают ingest и диагностика ядра);
//   - historyFullByQuiet / reachedStart / quietDecisionMade / quietIncompleteNoStart
//                        — геттеры+сеттеры (их читает и пишет оркестрация пагинации в ядре).
// Именно геттеры/сеттеры, а не значения: эти переменные живут в ядре и меняются из ядра, копия
// значения разошлась бы с оригиналом. Если модуль не подключён, ядро ставит мягкие заглушки.
//
// ПОРЯДОК ПОДКЛЮЧЕНИЯ: core/background.js, js[] — сразу после core/gemini-rpc.js и ПЕРЕД
// core/gemini-intercept.js (модуль обязан существовать к моменту bind в ядре).
//
// PUBLIC API: window.AiCmGeminiParse = { __bind, parseByBytes, parseByLines, parseBatchExecute,
// isTurnLikeSpan, noteJsonChild, closeTruncatedJson, unescapeJsonLiteralPrefix, extractTruncatedInner,
// handleSalvagedOuter, salvagePartialFrame }. Ядро напрямую использует только parseBatchExecute;
// остальное экспортировано для паритета с исходником и для поштучных песочниц тестов.

(function () {
  if (typeof window !== 'undefined' && window.AiCmGeminiParse) return;
  var D = null;
  function __bind(d) { D = d; }
  // ---- парсер кадров batchexecute (O-50: единица префикса длины — СИМВОЛ декодированной строки) ----
  // O-50 (лог-свидетель 2026-09-25 15:20:35): префикс длины кадра дан в СИМВОЛАХ payload'а
  // (`declaredN=1093974` = `rawLen(1094077)` минус заголовок, `clamped=0`), а legacy-код
  // перекодировал raw в UTF-8-байты (TextEncoder) и резал n БАЙТ: на кириллице n символов не
  // равно n байт (`reEncodedLen(1258177)` / `rawLen(1094077)` ~ 1.15), срез уезжал ВЛЕВО и
  // JSON.parse получал обрезанный кадр при clamped=0 («Unterminated string»). Вариант «сеть
  // отдала обрыв» опровергнут числами. Теперь границы кадров — В СИМВОЛЬНОМ пространстве:
  // `bytes` ниже на основном пути — вид КОДОВ символов (Uint16Array, длина == raw.length),
  // payload берётся `raw.slice(pos, end)`; TextEncoder на этом пути не участвует вовсе.
  // Совместимость: тела, размеченные в БАЙТАХ (legacy-сборки/фикстуры), распознаются
  // СТРУКТУРНОЙ проверкой разметки (framingStrictScore, без JSON.parse) ДО цикла: если она
  // подтверждает в байтовом пространстве БОЛЬШЕ кадров, чем в символьном, пространство
  // переключается на UTF-8-байты (TextEncoder/TextDecoder — только там, только чтение; при
  // недоступности глобалов остаётся символьное). Иначе — символьное (приоритет O-50: обрыв
  // последнего кадра и ASCII-тела дают равные счёты, выбор остаётся символьным).
  // Диаг-числа O-48 (declaredN/availableBytes/reEncodedLen/rawLen/clamped/salvagedTurns)
  // считаются в БАЙТАХ: availableBytes/reEncodedLen — арифметикой utf8Len (без перекодировки
  // кадра), поэтому пины O-48 (16) и gemini-partial-frame-parse остаются целыми.
  function parseByBytes(raw, out, src) {
    if (typeof raw !== 'string') raw = '';
    var rawLen = raw.length;
    var reEncodedLenMemo = -1;
    // O-52: safety_margin добивания границы кадра — не больше стольких СИМВОЛОВ за объявленный
    // конец (declaredN) и никогда дальше конца тела: защита от O-50-регресса и от «убегающего»
    // скана. Внутри функции, а не на верхнем уровне: песочницы тестов собирают parseByBytes
    // изолированно (конвенция fnDecl) и верхнеуровневые имена им не видны.
    var JSON_FRAME_OVERRUN_MAX = 256;
    // Длина строки в байтах UTF-8 — арифметика по кодам символов (без TextEncoder).
    function utf8Len(s) {
      if (typeof s !== 'string' || !s) return 0;
      var total = 0;
      for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c < 0x80) total += 1;
        else if (c < 0x800) total += 2;
        else if (c >= 0xD800 && c <= 0xDBFF && (i + 1) < s.length) {
          var d = s.charCodeAt(i + 1);
          if (d >= 0xDC00 && d <= 0xDFFF) { total += 4; i++; } else total += 3;
        } else total += 3;
      }
      return total;
    }
    function reEncodedLenOfRaw() {
      if (reEncodedLenMemo < 0) reEncodedLenMemo = utf8Len(raw);
      return reEncodedLenMemo;
    }
    // Вид кодов символов: длина равна числу символов строки (СИМВОЛЬНОЕ пространство среза).
    function charCodeView(s) {
      var a = new Uint16Array(s.length);
      for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
      return a;
    }
    // Структурная проверка разметки БЕЗ JSON.parse: кадры идут «цифры длины, LF, payload, LF,
    // ...» и объявленные длины сходятся с границами. Возвращает {score: число подтверждённых
    // кадров, complete: разметка сошлась до конца тела}; обрыв тела или разъезд единиц
    // останавливают счёт. По паре этих чисел выбирается пространство среза.
    function framingStrictScore(seq) {
      var res = { score: 0, complete: false };
      if (!seq || !seq.length) return res;
      var p = 0;
      if (seq.length >= 4 && seq[0] === 0x29 && seq[1] === 0x5D && seq[2] === 0x7D && seq[3] === 0x27) p = 4;
      var g = 0;
      while (p < seq.length && g++ < 200) {
        while (p < seq.length && (seq[p] < 48 || seq[p] > 57)) p++;
        if (p >= seq.length) break;
        var m = 0;
        while (p < seq.length && seq[p] >= 48 && seq[p] <= 57) { m = m * 10 + (seq[p] - 48); p++; }
        if (m <= 0) return res;
        if (p >= seq.length || seq[p] !== 0x0A) return res;
        p++;
        if ((p + m) > seq.length) return res;
        p += m;
        res.score++;
        if (p < seq.length) {
          if (seq[p] !== 0x0A) return res;
          p++;
        }
      }
      res.complete = (p >= seq.length);
      return res;
    }
    var charCodes = charCodeView(raw);
    var charFit = framingStrictScore(charCodes);
    var bytes = charCodes;
    var hasUtf8 = false;
    var dec = null;
    if (!charFit.complete) {
      var utf8Try = null;
      var utf8Dec = null;
      try { utf8Try = new TextEncoder().encode(raw); utf8Dec = new TextDecoder('utf-8'); } catch (eLegacy) { utf8Try = null; utf8Dec = null; }
      if (utf8Try && utf8Dec && framingStrictScore(utf8Try).score > charFit.score) {
        bytes = utf8Try; hasUtf8 = true; dec = utf8Dec;
      }
    }
    // ---- O-52: умное добивание границ кадра (символьное пространство) ----
    // Объявленная длина кадра может НЕ совпасть с концом JSON-значения:
    //   • перебег — срез `[pos, end)` захватывает trailing-разделители и префикс длины
    //     СЛЕДУЮЩЕГО кадра → разбор JSON падает «Unexpected non-whitespace character after
    //     JSON at position …» (живой прогон 2026-09-25, чат 8f1343975188be5d), при этом сам
    //     JSON в теле ЦЕЛ, а кадр после перебега теряется вместе с префиксом;
    //   • недобор — значение не закрывается внутри среза → обрыв на ровном месте.
    // `extractJsonPayload` возвращает РОВНО одно сбалансированное JSON-значение:
    //   (а) срез как объявлен, если после значения идут только пробелы — БЫСТРЫЙ путь,
    //       поведение и байты payload'а прежние (O-50 не затронут);
    //   (б) срез, обрезанный по концу первого сбалансированного значения, — убраны
    //       trailing-разделители и префикс следующего кадра (номер кадра не теряется:
    //       цикл продолжается с конца значения и читает длину следующего кадра);
    //   (в) недобор — граница добирается за `end` в пределах safety_margin
    //       `maxOverrun` СИМВОЛОВ от объявленной длины кадра и НЕ дальше конца тела;
    //   (г) значение не закрылось и в доборе (реальный обрыв тела/сети) — возвращается
    //       исходный срез БЕЗ изменений: диаг-числа O-48 и tolerant-salvage получают
    //       ровно тот же вход, что и до O-52.
    // Маркер `hNvQHb` в результате обязателен (иначе кадр отбрасывается по строке ниже, и
    // настоящий конверт потерялся бы) — при его отсутствии возвращается исходный срез.
    // Скан структурный (строковая маска экранирования), без разбора JSON: единственная точка
    // разбора кадра ниже не дублируется.
    function jsonValueEnd(str, from) {
      var i = from;
      while (i < str.length) {
        var w = str.charCodeAt(i);
        if (w !== 0x20 && w !== 0x09 && w !== 0x0A && w !== 0x0D) break;
        i++;
      }
      if (i >= str.length) return -1;
      var open = str.charCodeAt(i);
      if (open !== 0x5B && open !== 0x7B) return -1; // форма batchexecute: массив/объект
      var depth = 0;
      var inStr = false;
      var esc = false;
      for (; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (inStr) {
          if (esc) { esc = false; continue; }
          if (c === 0x5C) { esc = true; continue; }
          if (c === 0x22) inStr = false;
          continue;
        }
        if (c === 0x22) { inStr = true; continue; }
        if (c === 0x5B || c === 0x7B) { depth++; continue; }
        if (c === 0x5D || c === 0x7D) {
          depth--;
          if (depth === 0) return i + 1;
          if (depth < 0) return -1;
        }
      }
      return -1;
    }
    function jsonTailIsBlank(str, from) {
      for (var i = from; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (c !== 0x20 && c !== 0x09 && c !== 0x0A && c !== 0x0D) return false;
      }
      return true;
    }
    function extractJsonPayload(slice, rawStr, start, stop, maxOverrun) {
      var limit = (typeof maxOverrun === 'number' && maxOverrun >= 0) ? maxOverrun : JSON_FRAME_OVERRUN_MAX;
      var from = start > 0 ? start : 0;
      var to = stop < rawStr.length ? stop : rawStr.length;
      if (to < from) to = from;
      if (typeof slice !== 'string') slice = rawStr.slice(from, to);
      var res = { text: slice, end: to };
      var q = jsonValueEnd(slice, 0);
      if (q > 0) {
        if (jsonTailIsBlank(slice, q)) return res; // (а) быстрый путь: кадр размечен верно
        var cut = slice.slice(0, q);               // (б) перебег: режем по концу значения
        if (cut.indexOf('hNvQHb') !== -1) { res.text = cut; res.end = from + q; }
        return res;
      }
      var hard = to + limit; if (hard > rawStr.length) hard = rawStr.length; // (в) добор границы
      if (hard > to) {
        var wide = rawStr.slice(from, hard);
        var q2 = jsonValueEnd(wide, 0);
        var wideCut = (q2 > 0) ? wide.slice(0, q2) : '';
        if (q2 > (to - from) && wideCut.indexOf('hNvQHb') !== -1) { res.text = wideCut; res.end = from + q2; }
      }
      return res; // (г) обрыв — исходный срез без изменений (O-48)
    }
    var pos = 0;
    if (bytes.length >= 4 && bytes[0] === 0x29 && bytes[1] === 0x5D && bytes[2] === 0x7D && bytes[3] === 0x27) pos = 4;
    var guard = 0;
    while (pos < bytes.length && guard++ < 200) {
      while (pos < bytes.length && (bytes[pos] < 48 || bytes[pos] > 57)) pos++;
      if (pos >= bytes.length) break;
      var n = 0;
      while (pos < bytes.length && bytes[pos] >= 48 && bytes[pos] <= 57) { n = n * 10 + (bytes[pos] - 48); pos++; }
      if (n <= 0) { pos++; continue; }
      if (pos < bytes.length && bytes[pos] === 0x0A) pos++;
      var posPayload = pos;                    // O-48: начало payload'а (для availableBytes)
      var clamped = (pos + n) > bytes.length;  // O-48: объявленная длина больше доступного — клэмп
      var end = pos + n; if (end > bytes.length) end = bytes.length;
      // O-50: срез кадра в СИМВОЛЬНОМ пространстве (string.slice) — основной путь;
      // legacy-разметка в байтах (hasUtf8) берёт срез из UTF-8-вида (её разметка байтовая,
      // добивание границ O-52 к ней не применяется — единица среза там БАЙТ).
      var payloadStr = hasUtf8 ? dec.decode(bytes.subarray(pos, end)) : raw.slice(pos, end);
      pos = end;
      // O-52: на символьном пути граница кадра доводится до конца JSON-значения —
      // trailing-разделители/префикс следующего кадра в payload не попадают, недобор
      // добирается в пределах safety_margin от объявленной длины (быстрый путь (а)
      // возвращает тот же срез: поведение и байты O-50 не меняются).
      if (!hasUtf8) {
        var frame = extractJsonPayload(payloadStr, raw, posPayload, pos, JSON_FRAME_OVERRUN_MAX);
        payloadStr = frame.text;
        pos = frame.end;
      }
      if (pos < bytes.length && bytes[pos] === 0x0A) pos++;
      if (payloadStr.indexOf('hNvQHb') !== -1) {
        try { D.handleOuter(JSON.parse(payloadStr), out, src); } catch (e) {
          // O-48: tolerant-salvage — завершённые ходы и курсор из обрезанного текста ДО
          // JSON.parse failure (штатный handleOuter, только по восстановленному префиксу).
          var salvaged = 0;
          if (typeof salvagePartialFrame === 'function') { try { salvaged = salvagePartialFrame(payloadStr, out, src); } catch (eSv) { salvaged = 0; } }
          var availBytes = hasUtf8 ? (bytes.length - posPayload) : utf8Len(raw.slice(posPayload));
          D.lastFrameParseFail = {
            where: 'parseByBytes', msg: (e && e.message || String(e)),
            declaredN: n, availableBytes: availBytes, reEncodedLen: reEncodedLenOfRaw(),
            rawLen: rawLen, clamped: clamped === true, salvaged: salvaged
          };
          debugLog('log', '[gemini-intercept] parse-top fail (parseByBytes): ' + (e && e.message || e) +
            ' declaredN=' + n + ' availableBytes=' + availBytes + ' reEncodedLen=' + reEncodedLenOfRaw() +
            ' rawLen=' + rawLen + ' clamped=' + (clamped ? 1 : 0) + ' salvagedTurns=' + salvaged);
        }
      }
    }
  }
  function parseByLines(raw, out, src) {
    var lines = raw.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (!ln || ln === ')]}\'') continue;
      var c0 = ln.charAt(0);
      if (c0 !== '[' && c0 !== '{') continue;
      if (ln.indexOf('hNvQHb') === -1) continue;
      try { D.handleOuter(JSON.parse(ln), out, src); } catch (e) {
        D.lastFrameParseFail = {
          where: 'parseByLines', msg: (e && e.message || String(e)),
          declaredN: ln.length, availableBytes: ln.length, reEncodedLen: 0,
          rawLen: (typeof raw === 'string') ? raw.length : 0, clamped: false, salvaged: 0
        };
        debugLog('log', '[gemini-intercept] parse-top fail (parseByLines): ' + (e && e.message || e));
      }
    }
  }
  function parseBatchExecute(raw, src) {
    var out = { turns: [], total: 0 };
    D.lastFrameParseFail = null; // O-48: обрыв фиксируется НА КАЖДЫЙ парс — читает вызвавший
    parseByBytes(raw, out, src);
    if (!out.turns.length) parseByLines(raw, out, src);
    return out.turns;
  }

  // ================= O-48: tolerant-salvage обрезанного кадра =================
  // Кадр, оборванный КЛЭМПОМ объявленной длины (или сетью на середине строки), JSON.parse
  // не проходит целиком — но завершённые ходы уже лежат в его тексте ДО точки обрыва.
  // Восстанавливаем максимальный СИНТАКСИЧЕСКИ ЦЕЛЫЙ префикс: незавершённый элемент
  // отбрасывается ЦЕЛИКОМ, открытые контейнеры закрываются. Гарантия «нет частичных ходов»:
  // точка отреза — граница последнего ПОЛНОСТЬЮ закрытого элемента СПИСКА ХОДОВ
  // (turn-like: массив минимум из 3 полей, первое поле — не строка). Завершённых ходов нет —
  // возвращаем '' (ничего не рвём, поведение прежнее). Лимиты парсера НЕ поднимаются:
  // кадр обрезан на входе, а не отброшен потолком.
  // Форма хода Gemini (utils/gemini-batchexecute-parser.js): [null, [ids…], [[вопрос]],
  // [[[ответ]]], [ts]] — inner-массивы хода этому предикату не удовлетворяют (короче или
  // начинаются со строки), поэтому список ходов читается однозначно.
  function isTurnLikeSpan(span) {
    if (!span || span.kind !== 'arr' || span.closed !== true) return false;
    if (!(span.count >= 3)) return false;
    return span.firstIsString !== true;
  }
  // Учёт ЗАВЕРШЁННОГО значения на верхушке стека открытых контейнеров.
  function noteJsonChild(stack, endIdx, child) {
    var top = stack[stack.length - 1];
    if (!top) return;
    top.count++;
    top.lastEnd = endIdx;
    if (top.count === 1) top.firstIsString = (child.kind === 'str');
    if (top.kind === 'arr' && isTurnLikeSpan(child)) top.lastTurnEnd = endIdx;
  }
  function closeTruncatedJson(s) {
    if (typeof s !== 'string' || s.length < 2) return '';
    var stack = [];
    var inStr = false, esc = false;
    for (var i = 0; i < s.length; i++) {
      var cc = s.charCodeAt(i); // 34 '"', 91 '[', 123 '{', 92 '\\', 93 ']', 125 '}'
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (cc === 92) { esc = true; continue; }
        if (cc === 34) { inStr = false; noteJsonChild(stack, i, { kind: 'str' }); }
        continue;
      }
      if (cc === 34) { inStr = true; continue; }
      if (cc === 91 || cc === 123) {
        stack.push({ kind: (cc === 91 ? 'arr' : 'obj'), at: i, closeCode: (cc === 91 ? 93 : 125),
          closed: false, count: 0, firstIsString: null, lastEnd: -1, lastTurnEnd: -1 });
        continue;
      }
      if (cc === 93 || cc === 125) {
        if (!stack.length) return ''; // несогласованная скобка — не чиним
        var doneSpan = stack.pop();
        doneSpan.closed = true;
        doneSpan.end = i;
        noteJsonChild(stack, i, doneSpan);
        continue;
      }
      if (cc === 58 || cc === 44 || cc === 32 || cc === 9 || cc === 10 || cc === 13) continue; // : , \s
      // литерал (число/true/false/null): тянем до ближайшего разделителя
      var j = i;
      while (j + 1 < s.length && /[0-9A-Za-z+\-.]/.test(s.charAt(j + 1))) j++;
      if (j + 1 >= s.length) { i = j; break; } // литерал у самого обрыва — НЕ завершён
      noteJsonChild(stack, j, { kind: 'lit' });
      i = j;
    }
    // Список ходов — самый ВНЕШНИЙ открытый контейнер, у которого есть завершённый ход.
    var cut = -1, cutDepth = -1;
    for (var f = 0; f < stack.length; f++) {
      if (stack[f].kind === 'arr' && stack[f].lastTurnEnd >= 0) { cut = stack[f].lastTurnEnd + 1; cutDepth = f; break; }
    }
    if (cut < 0 || cutDepth < 0) return '';
    var repaired = s.slice(0, cut).replace(/[\s,]+$/, '');
    for (var k = cutDepth; k >= 0; k--) repaired += String.fromCharCode(stack[k].closeCode);
    return repaired;
  }
  // Терпимый разархиватор JSON-литерала: обрыв внутри \uXXXX или одиночный '\' в хвосте
  // отбрасываются (не бросаем), кавычка-терминатор не обязательна.
  function unescapeJsonLiteralPrefix(raw) {
    var res = '';
    for (var i = 0; i < raw.length; i++) {
      var c = raw.charAt(i);
      if (c !== '\\') { res += c; continue; }
      if (i + 1 >= raw.length) break;
      var e = raw.charAt(i + 1); i++;
      if (e === 'n') res += '\n';
      else if (e === 't') res += '\t';
      else if (e === 'r') res += '\r';
      else if (e === 'b') res += '\b';
      else if (e === 'f') res += '\f';
      else if (e === 'u') {
        if (i + 4 >= raw.length) break;
        var hex = raw.substr(i + 1, 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
        res += String.fromCharCode(parseInt(hex, 16));
        i += 4;
      } else res += e; // \" \\ \/ и прочие однобайтовые escape'ы
    }
    return res;
  }
  // Inner-строка ходов (outer[0][2]) из ЧАСТИЧНОГО кадра: маркер "hNvQHb", затем ровно `,"`
  // (никаких догадок — при иной форме возвращаем ''), затем до кавычки-терминатора или конца.
  function extractTruncatedInner(payloadStr) {
    var marker = payloadStr.indexOf('"hNvQHb"');
    if (marker === -1) return '';
    var q = payloadStr.indexOf('"', marker + 8);
    if (q === -1) return '';
    if (!/^\s*,\s*$/.test(payloadStr.slice(marker + 8, q))) return '';
    var raw = '';
    for (var i = q + 1; i < payloadStr.length; i++) {
      var c = payloadStr.charAt(i);
      if (c === '\\') { raw += c; if (i + 1 < payloadStr.length) { raw += payloadStr.charAt(i + 1); i++; } continue; }
      if (c === '"') break;
      raw += c;
    }
    return unescapeJsonLiteralPrefix(raw);
  }
  // Штатный handleOuter на ВОССТАНОВЛЕННОМ кадре + сохранение честности полноты: кадр обрезан,
  // поэтому флаги полноты откатываются к состоянию до вызова (страховка к v74-гарду выше).
  // Всё остальное (pendingCursor/olderHistorySeen/cursorEpoch/диагностика) — штатный путь.
  function handleSalvagedOuter(outer, out, src) {
    var wasFull = D.historyFullByQuiet, wasReached = D.reachedStart;
    var wasQuiet = D.quietDecisionMade, wasNoStart = D.quietIncompleteNoStart;
    try { D.handleOuter(outer, out, src); } catch (eSalv) { swallow(eSalv, 'gemini:handleSalvagedOuter'); }
    // Кадр обрезан → его «нет курсора» и «нет старших» НЕ доказывают терминальную страницу:
    // откатываем все четыре флага полноты к состоянию до вызова (v74-ветка handleOuter
    // остаётся байтово нетронутой — гарантия держится на откате, а не на её правке).
    D.historyFullByQuiet = wasFull;
    D.reachedStart = wasReached;
    D.quietDecisionMade = wasQuiet;
    D.quietIncompleteNoStart = wasNoStart;
    debugLog('log', '[AI CM][salvage] обрезанный кадр: handleOuter вызван на восстановленном префиксе' +
      ' (ходов в out=' + out.turns.length + ', src=' + src + ') — полнота НЕ взводится');
  }
  // Возвращает число восстановленных ходов (0 — ничего не восстановлено, поведение прежнее).
  function salvagePartialFrame(payloadStr, out, src) {
    if (typeof payloadStr !== 'string' || payloadStr.indexOf('hNvQHb') === -1) return 0;
    var before = out.turns.length;
    // (1) обрыв в служебной части кадра (inner цел, оборваны rest/хвост) — чиним сам кадр
    var outerText = closeTruncatedJson(payloadStr);
    if (outerText) {
      var outerVal = null;
      try { outerVal = JSON.parse(outerText); } catch (eOuter) { outerVal = null; }
      if (outerVal) handleSalvagedOuter(outerVal, out, src);
    }
    // (2) обрыв ВНУТРИ строки ходов — восстанавливаем список завершённых ходов и отдаём
    //     штатному handleOuter (курсор/ids/r1/model извлекаются тем же путём, что у целого)
    if (out.turns.length === before) {
      var innerFixed = closeTruncatedJson(extractTruncatedInner(payloadStr));
      if (!innerFixed) return 0;
      handleSalvagedOuter([['wrb.fr', 'hNvQHb', innerFixed]], out, src);
    }
    return out.turns.length - before;
  }

  // ---- API модуля (фасад для ядра и тестов) ----
  var Api = {
    __bind: __bind,
    parseByBytes: parseByBytes,
    parseByLines: parseByLines,
    parseBatchExecute: parseBatchExecute,
    isTurnLikeSpan: isTurnLikeSpan,
    noteJsonChild: noteJsonChild,
    closeTruncatedJson: closeTruncatedJson,
    unescapeJsonLiteralPrefix: unescapeJsonLiteralPrefix,
    extractTruncatedInner: extractTruncatedInner,
    handleSalvagedOuter: handleSalvagedOuter,
    salvagePartialFrame: salvagePartialFrame
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Api;
  if (typeof window !== 'undefined') window.AiCmGeminiParse = Api;
})();
