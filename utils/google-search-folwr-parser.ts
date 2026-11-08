/**
 * Чистая функция парсинга полной HTML-истории Google Search AI (GET /async/folwr).
 * Работает в браузере (window.parseGoogleFolwrOpen) и как ES-модуль (Roadmap Ph2):
 * для MAIN-мира build.mjs выводит classic-артефакт того же модуля.
 *
 * Маркеры (из живой диагностики google-folwr-table.txt):
 *   - Контейнер реплики: <div class="CKgc1d" data-scope-id="turn"> — содержит ТОЛЬКО вопрос
 *     (h2.iMqumd) и пустые div; сам текст ответа лежит ВНЕ turn-контейнера.
 *   - Вопрос пользователя: <h2 class="iMqumd"> (формат: Вы сказали: "...")
 *   - Ответ модели: блоки-чанки <div class="n6owBd awi2gc"> лежат ВНЕ turn,
 *     в соседних контейнерах <div data-sn-op="2" data-target-container-id="...">.
 *   - Подзаголовки: <div role="heading" aria-level="3|4"> (классы otQkpb / AdPoic) — тоже ВНЕ turn.
 *   - Таблица: <table class="NRefec"><tr><th>…</th></tr><tr><td>…</td></tr></table>, тоже ВНЕ turn.
 *   - Фолбэк ответа: <div data-subtree="aimfl">
 *   - Фолбэк вопроса: комментарии <!--TgQPHd|...-->
 *   - O-45: КОД-ОКНА (python/js) — отдельные контейнеры вне чанка прозы (или внутри него):
 *     <pre>, <code> (многострочный), блочная обёртка class …code-block…; метка языка —
 *     соседний короткий ASCII-узел («python»). Рендерятся markdown-фенсом ```lang\n<код>\n```
 *     (renderCodeBlock) — код и маркеры языка попадают в файл целиком.
 *
 * Алгоритм: контент-узлы ответа (чанки + подзаголовки + таблицы + код-окна) собираются
 * ГЛОБАЛЬНО, затем распределяются по turn-контейнерам по document-позиции
 * (compareDocumentPosition), поэтому узлы, лежащие между turn'ами, попадают в нужный ход.
 * Таблицы конвертируются в markdown-строки («| ячейка | ячейка |»), подзаголовки — в текст,
 * код-окна — в ```lang-фенсы (многострочный код не схлопывается, отступы сохраняются).
 *
 * Возврат: { threadId, turns: [{id, userText, assistantText}], messages: [{role, text}], text, count }
 * Тесты используют messages (role/text); text и count — конкатенация и число сообщений.
 */

/**
 * Ход переписки folwr: вопрос и ответ (любая часть может отсутствовать).
 */
export interface FolwrTurn {
  /** Идентификатор хода (jsuid из разметки либо синтетический 'idxN'). */
  id: string;
  /** Текст вопроса; null — вопрос не найден. */
  userText: string | null;
  /** Текст ответа; null — ответ не найден. */
  assistantText: string | null;
}

/** Сообщение для базы/экспорта; по форме совместимо с Message (types/message.d.ts). */
export interface FolwrMessage {
  /** Роль автора сообщения: user / assistant. */
  role: string;
  /** Текст сообщения. */
  text: string;
}

/** Результат разбора снимка folwr (открытие диалога и догрузка страниц). */
export interface FolwrParseResult {
  /** Идентификатор диалога из разметки; пустая строка, если не найден. */
  threadId: string;
  /** Разобранные ходы переписки. */
  turns: FolwrTurn[];
  /** Плоский список сообщений для базы/экспорта. */
  messages: FolwrMessage[];
  /** Весь текст диалога, склеенный через перевод строки. */
  text: string;
  /** Количество сообщений (messages.length). */
  count: number;
}

/** Вид страницы продолжения: что именно вернул сервер. */
export type FolwrContinuationKind = 'http-error' | 'empty-body' | 'cursor-repeat' | 'no-new-turns' | 'new-turns';

/** Классификация страницы продолжения: можно ли считать историю полной. */
export interface FolwrContinuation {
  /** Вид страницы. */
  kind: FolwrContinuationKind;
  /** true — история собрана целиком. */
  complete: boolean;
  /** true — имеет смысл запрашивать следующую страницу. */
  canContinue: boolean;
  /** HTTP-статус ответа (0, если запрос не состоялся). */
  status: number;
  /** true — запрос завершился успешно. */
  ok: boolean;
  /** Длина тела ответа в символах. */
  bodyLength: number;
  /** Сколько новых ходов принесла страница. */
  newTurns: number;
  /** Курсор продолжения со страницы; null — курсора нет. */
  cursor: string | null;
  /** true — сервер вернул тот же курсор, что мы отправляли. */
  cursorRepeated: boolean;
  /** Человекочитаемая строка для лога. */
  log: string;
}

/** Вход классификатора продолжения: сжатый итог запроса «догрузить ещё». */
export interface FolwrContinuationInput {
  /** Успешен ли запрос. */
  ok?: boolean;
  /** HTTP-статус ответа. */
  status?: number | null;
  /** Длина тела ответа. */
  bodyLength?: number;
  /** Сколько новых ходов принесла страница. */
  newTurns?: number;
  /** Курсор, полученный со страницы. */
  cursor?: string | null;
  /** Курсор, который мы отправляли. */
  sentCursor?: string | null;
}

/** Нормализованные части идентичности хода (сверка базовой записи и сети). */
export interface FolwrTurnIdentity {
  /** Нормализованный текст вопроса. */
  u: string;
  /** Нормализованный текст ответа. */
  a: string;
}

/** Публичный API, который модуль кладёт в window.GoogleFolwrUtils. */
export interface GoogleFolwrUtilsApi {
  countTurnContainers: typeof countTurnContainers;
  extractTurnsFromDocument: typeof extractTurnsFromDocument;
  mergeTurnsByKey: typeof mergeTurnsByKey;
  extractContinuationToken: typeof extractContinuationToken;
  mergeTurnsById: typeof mergeTurnsById;
  mergeTurnsMonotone: typeof mergeTurnsMonotone;
  classifyFolwrContinuation: typeof classifyFolwrContinuation;
  canonicalTurnKeyOf: typeof canonicalTurnKeyOf;
  canonicalAnswerBody: typeof canonicalAnswerBody;
  canonicalizeTurnForThread: typeof canonicalizeTurnForThread;
  normalizeTurnKeyPart: typeof normalizeTurnKeyPart;
  turnIdentityParts: typeof turnIdentityParts;
  bodiesPrefixCompatible: typeof bodiesPrefixCompatible;
  dedupeTurns: typeof dedupeTurns;
  renderCodeBlock: typeof renderCodeBlock;
  answerTextOf: typeof answerTextOf;
  answerDomNodes: typeof answerDomNodes;
  isCodeBlockElement: typeof isCodeBlockElement;
}

/**
 * Декодирует HTML-сущности: именованные (&quot;, &amp;, …) и числовые (&#123;).
 * @param {string} s Разметка или текст с сущностями.
 * @returns {string} Текст с раскрытыми сущностями; '' для пустого входа.
 */
function decodeEntities(s) {
  if (!s) return '';
  var out = String(s);
  out = out.replace(new RegExp('&' + 'quot;', 'g'), '"');
  out = out.replace(new RegExp('&' + 'amp;', 'g'), '&');
  out = out.replace(new RegExp('&' + '#39;', 'g'), "'");
  out = out.replace(new RegExp('&' + 'lt;', 'g'), '<');
  out = out.replace(new RegExp('&' + 'gt;', 'g'), '>');
  out = out.replace(new RegExp('&' + 'nbsp;', 'g'), ' ');
  out = out.replace(/&#(\d+);/g, function (m, d) {
    try { return String.fromCharCode(parseInt(d, 10)); } catch (e) { return m; }
  });
  return out;
}

// ---- O-45: markdown-фенсы ```…``` (окна кода) ----
// Всё, что ВНУТРИ фенса, — это код: его нельзя схлопывать по пробелам и срезать отступы по
// строкам, иначе многострочное окно кода превратится в одну строку и форматирование погибнет.
// Фенс может быть ДЛИННЕЕ трёх кавычек (если внутри кода есть ```), поэтому квантификатор
// {3,} и обратная ссылка: закрывающий фенс — ровно той же длины, что открывающий.
/** @type {RegExp} Фенс markdown-кода: открывающий и закрывающий одинаковой длины ({3,}). */
var FENCE_RE = /(`{3,})[\s\S]*?\1/g;

// Применяет fn к сегментам ВНЕ фенсов; сами фенсы возвращаются байтово как есть.
/**
 * Применяет fn к сегментам ВНЕ фенсов; сами фенсы возвращаются байтово как есть.
 * @param {string|null|undefined} s Исходный текст.
 * @param {(seg: string) => string} fn Обработчик сегмента вне фенса.
 * @returns {string} Текст с обработанными сегментами.
 */
function mapOutsideFences(s, fn) {
  var str = String(s == null ? '' : s);
  var out = '';
  var last = 0;
  var m;
  FENCE_RE.lastIndex = 0;
  while ((m = FENCE_RE.exec(str)) !== null) {
    out += fn(str.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + fn(str.slice(last));
}

/**
 * Сегмент без тегов: script/style вырезаются, теги → пробел, пробелы схлопываются.
 * @param {string} seg Сегмент разметки (вне фенса).
 * @returns {string} Текст без тегов в одну строку.
 */
function stripTagsSeg(seg) {
  return String(seg)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

// O-45: текст без тегов, но фенсы (окна кода) не трогаются — раньше `\s+` → ' ' схлопывал
// многострочный код в одну строку. Для строки без фенсов результат байтово прежний.
/**
 * Текст без тегов; фенсы (окна кода) не трогаются — O-45.
 * @param {string} html Разметка с возможными фенсами.
 * @returns {string} Текст без тегов и краевых пробелов.
 */
function stripTags(html) {
  if (!html) return '';
  return mapOutsideFences(html, stripTagsSeg).replace(/^\s+/, '').replace(/\s+$/, '');
}

/**
 * Сегмент ответа без тегов с сохранением переводов строк.
 * @param {string} seg Сегмент разметки (вне фенса).
 * @returns {string} Текст: строки обрезаны по краям, пустые серии схлопнуты.
 */
function sanitizeAssistantSeg(seg) {
  return String(seg)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .split('\n')
    .map(function (ln) { return ln.trim(); })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

// Очистка текста ответа с сохранением переводов строк (markdown-строки таблиц не схлопываются).
// O-45: сегменты внутри фенсов (окна кода) проходят КАК ЕСТЬ — построчный trim и схлопывание
// пробелов уничтожили бы отступы кода; для текста без фенсов результат байтово прежний.
/**
 * Очистка текста ответа с сохранением переводов строк; сегменты внутри фенсов — как есть.
 * @param {string} s Текст ответа (возможно с разметкой).
 * @returns {string} Очищенный текст; '' для пустого входа.
 */
function sanitizeAssistant(s) {
  if (!s) return '';
  return mapOutsideFences(s, sanitizeAssistantSeg).replace(/^\s+/, '').replace(/\s+$/, '');
}

// Ячейка таблицы: текст без внутренних тегов, без мусорных узлов.
/**
 * Ячейка таблицы: текст без внутренних тегов, без мусорных узлов (script/style/button/svg).
 * @param {any} cellEl Ячейка th/td.
 * @returns {string} Текст ячейки.
 */
function tableCellText(cellEl) {
  var clone = cellEl.cloneNode(true);
  clone.querySelectorAll('script, style, button, svg').forEach(function (el) { el.remove(); });
  return stripTags(decodeEntities(clone.innerHTML)).trim();
}

// Таблица → markdown-строки: каждая строка таблицы = "| ячейка | ячейка |", строки через '\n'.
/**
 * Таблица → markdown-строки вида «| ячейка | ячейка |».
 * @param {any} tableEl Элемент table.
 * @returns {string} Строки таблицы через '\n'; '' для пустой таблицы.
 */
function tableToMarkdown(tableEl) {
  var rows = tableEl.querySelectorAll('tr');
  var lines = [];
  for (var r = 0; r < rows.length; r++) {
    var cells = rows[r].querySelectorAll('th, td');
    var cellTexts = [];
    for (var c = 0; c < cells.length; c++) {
      cellTexts.push(tableCellText(cells[c]));
    }
    if (cellTexts.length === 0) continue;
    lines.push('| ' + cellTexts.join(' | ') + ' |');
  }
  return lines.join('\n');
}

/**
 * Заголовок-вопрос пользователя (h2 с классом iMqumd).
 * @param {any} el Проверяемый элемент.
 * @returns {boolean} true — это заголовок вопроса, а не контент ответа.
 */
function isQuestionHeading(el) {
  return el.tagName === 'H2' && el.className && String(el.className).indexOf('iMqumd') !== -1;
}

// ---- O-45: КОД-БЛОКИ (окна кода) в ответе ----
// Спецификация: файл экспорта содержит полный текст код-блока ВМЕСТЕ с маркерами языка
// (```lang\n<код>\n```). Дефект (живой прогон GSA, threadId gGezatSZK426i-gPxITekAw):
// база = 796 знаков прозы, код (python/js), его метка языка и кнопка «Скопировать код»
// отсутствовали — в отборе контент-узлов ответа код-контейнеров не было ВООБЩЕ, а
// generic-ветка читала textContent (многострочный код схлопнулся бы в одну строку и
// потерял бы маркеры языка). Здесь: отбор код-контейнеров + рендер в фенс ОДНИМ хелпером,
// который переиспользуют сетевой путь (parseGoogleFolwrOpen), DOM-добор (extractTurnsFromDocument)
// и DOM-путь адаптера (adapters/google-search-adapter.js).
/** @type {string} Селектор код-контейнеров: pre/code и блочные обёртки окна кода. */
var CODE_CONTAINER_SEL = 'pre, code, [class*="code-block"], [class*="codeBlock"], [class*="codeblock"]';
// Метка языка — ASCII-токен (python, js, bash, c++…). Кириллическая проза меткой не является,
// иначе соседний абзац («Пример:») уехал бы в маркер языка.
/** @type {RegExp} Метка языка: короткий ASCII-токен, кириллическая проза меткой не является. */
var CODE_LANG_RE = /^[A-Za-z][A-Za-z0-9+#._-]{0,19}$/;

/**
 * Строка классов узла (className как строка; '' для узла без классов).
 * @param {any} el Проверяемый узел.
 * @returns {string} Классы через пробел.
 */
function classOf(el) {
  try { return String((el && el.className) || ''); } catch (e) { return ''; }
}

// Узел ПОХОЖ на код по тегу/классу (без решения «блок это или инлайн»).
/**
 * Узел ПОХОЖ на код по тегу/классу (без решения «блок это или инлайн»).
 * @param {any} el Проверяемый узел.
 * @returns {boolean} true — pre/code либо класс …code-block….
 */
function isCodeLikeNode(el: any): boolean {
  if (!el || !el.tagName) return false;
  var tag = String(el.tagName).toUpperCase();
  return tag === 'PRE' || tag === 'CODE' || /code-?block/i.test(classOf(el));
}

// Текст кода: textContent с СОХРАНЕНИЕМ переносов строк; сервисная обвязка окна кода
// (кнопка «Скопировать код», script/style/svg) снимается, <br> становится переносом строки,
// а если переносов нет и строк-детей несколько (в живом DOM строки кода — отдельные div'ы) —
// собираем по строке на элемент. Краевые пустые строки и хвостовые пробелы не значимы.
/**
 * Текст кода с сохранением переносов строк и отступов.
 * @param {any} el Код-контейнер.
 * @returns {string} Код без сервисной обвязки; '' для узла без DOM-API.
 */
function codeTextOf(el: any): string {
  if (!el || typeof el.cloneNode !== 'function') return '';
  var clone;
  try { clone = el.cloneNode(true); } catch (e) { return ''; }
  try {
    var junk = clone.querySelectorAll('script, style, button, svg');
    for (var i = 0; i < junk.length; i++) {
      if (junk[i].parentNode) junk[i].parentNode.removeChild(junk[i]);
    }
    var brs = clone.querySelectorAll('br');
    var doc = clone.ownerDocument || (typeof document !== 'undefined' ? document : null);
    for (var b = 0; b < brs.length; b++) {
      if (brs[b].parentNode && doc && doc.createTextNode) {
        brs[b].parentNode.replaceChild(doc.createTextNode('\n'), brs[b]);
      }
    }
  } catch (e2) { /* узел без DOM-API (срез-песочница) */ }
  var txt = '';
  try { txt = String(clone.textContent || ''); } catch (e3) { txt = ''; }
  // Переносов нет, но дети — БЛОЧНЫЕ элементы (в живом DOM строка кода бывает отдельным div):
  // собираем по строке на элемент. Инлайновые дети (подсветка синтаксиса в span'ах) строк
  // не образуют — однострочный код со span'ами остаётся одной строкой.
  if (txt.indexOf('\n') === -1 && clone.children && clone.children.length > 1) {
    var allBlock = true;
    for (var k = 0; k < clone.children.length; k++) {
      if (!/^(DIV|P|LI|TR|SECTION|ARTICLE|FIGURE|BLOCKQUOTE|H[1-6])$/.test(String(clone.children[k].tagName || '').toUpperCase())) {
        allBlock = false;
        break;
      }
    }
    if (allBlock) {
      var lines = [];
      for (var k2 = 0; k2 < clone.children.length; k2++) {
        lines.push(String(clone.children[k2].textContent || ''));
      }
      var joined = lines.join('\n');
      if (joined.replace(/\s+/g, '')) txt = joined;
    }
  }
  return txt.replace(/[ \t]+$/gm, '').replace(/^\n+/, '').replace(/\s+$/, '');
}

// Носитель текста кода: самый глубокий <pre>/<code> внутри контейнера — обёртка окна кода
// может нести ещё и метку языка, и обвязку, в тело кода они попадать не должны.
/**
 * Носитель текста кода: самый глубокий pre/code внутри контейнера (иначе сам узел).
 * @param {any} el Код-контейнер.
 * @returns {any} Узел, из которого читается текст кода.
 */
function codeBodyElement(el: any): any {
  try {
    var inner = el.querySelectorAll ? el.querySelectorAll('pre, code') : null;
    if (inner && inner.length) return inner[inner.length - 1];
  } catch (e) { }
  return el;
}

// Метка языка окна кода: (1) явный аргумент, (2) атрибут/класс контейнера (language-python,
// code-lang="python"), (3) СОСЕДНИЙ узел-метка ПЕРЕД окном кода — так устроен живой DOM GSA:
// отдельный StaticText «python» → узел code с текстом кода. Меткой считается только короткий
// ASCII-токен (CODE_LANG_RE): прозаический сосед метку не подменяет.
/**
 * Метка языка окна кода: явный аргумент → атрибут/класс контейнера → соседний узел-метка.
 * @param {any} el Код-контейнер.
 * @param {string|null|undefined} [langHint] Явная метка языка, если известна.
 * @returns {string} Метка языка либо '' (без метки).
 */
function detectCodeLang(el: any, langHint?: string | null): string {
  if (langHint != null && CODE_LANG_RE.test(String(langHint).trim())) return String(langHint).trim();
  var attrNames = ['code-lang', 'data-lang', 'data-code-lang'];
  try {
    for (var a = 0; a < attrNames.length; a++) {
      var v = (el && el.getAttribute) ? el.getAttribute(attrNames[a]) : null;
      if (v && CODE_LANG_RE.test(String(v).trim())) return String(v).trim();
    }
  } catch (e) { }
  var m = classOf(el).match(/(?:^|[\s_-])(?:language|lang)[-_]([A-Za-z][A-Za-z0-9+#._-]{0,19})/);
  if (m && CODE_LANG_RE.test(m[1])) return m[1];
  var cur = el;
  for (var up = 0; cur && up < 4; up++) {
    var prev = cur.previousSibling;
    for (var hops = 0; prev && hops < 3; hops++) {
      var t = '';
      try { t = String(prev.textContent || '').trim(); } catch (e2) { t = ''; }
      if (t) {
        if (CODE_LANG_RE.test(t)) return t;
        break;
      }
      prev = prev.previousSibling;
    }
    cur = cur.parentNode;
  }
  return '';
}

// Код-БЛОК, а не инлайн-фрагмент: <pre>; <code> с переносом строки или меткой языка; блочная
// обёртка окна кода (class …code-block…). Инлайн <code> в прозе («Код <code>nums.sort()</code>»)
// блоком НЕ считается — он остаётся инлайн-текстом, а не превращается в фенс.
/**
 * Код-БЛОК, а не инлайн-фрагмент: pre; code с переносом строки или меткой языка; блочная обёртка.
 * @param {any} el Проверяемый узел.
 * @returns {boolean} true — узел рендерится фенсом.
 */
export function isCodeBlockElement(el: any): boolean {
  if (!el || !el.tagName) return false;
  var tag = String(el.tagName).toUpperCase();
  if (/code-?block/i.test(classOf(el))) return true;
  if (tag === 'PRE') return true;
  if (tag !== 'CODE') return false;
  if (/(?:^|[\s_-])(?:language|lang)[-_]/.test(classOf(el))) return true;
  return codeTextOf(el).indexOf('\n') !== -1;
}

// Код-блок → markdown-фенс СО ЗНАКОМ ЯЗЫКА (спецификация O-45): ```lang\n<код>\n```.
// Без метки — пустой язык: ```\n<код>\n```. Если внутри кода есть тройные кавычки, фенс
// удлиняется (CommonMark), иначе окно кода развалилось бы на середине.
/**
 * Код-блок → markdown-фенс со знаком языка: ```lang\n<код>\n``` (O-45).
 * @param {any} node Код-блок.
 * @param {string|null|undefined} [langHint] Явная метка языка.
 * @returns {string} Фенс с кодом; '' для пустого кода.
 */
export function renderCodeBlock(node: any, langHint?: string | null): string {
  if (!node) return '';
  var body = codeBodyElement(node);
  var text = codeTextOf(body);
  if (!text) text = codeTextOf(node);
  if (!text) return '';
  var lang = detectCodeLang(node, langHint) || detectCodeLang(body, langHint);
  var fence = '```';
  while (text.indexOf(fence) !== -1) fence += '`';
  return fence + lang + '\n' + text + '\n' + fence;
}

// Текст контент-узла ответа: код-контейнер → фенс; обычный узел (чанк прозы, заголовок…) —
// его текст, в котором код-окна ПОДМЕНЕНЫ фенсами: окно кода, лежащее внутри чанка,
// не теряется и не схлопывается. Инлайн <code> не трогаем.
/**
 * Текст контент-узла ответа: код-контейнер → фенс, обычный узел → текст с фенсами вместо кода.
 * @param {any} node Контент-узел ответа.
 * @returns {string} Текст узла без краевых пробелов.
 */
export function answerTextOf(node: any): string {
  if (!node) return '';
  if (isCodeBlockElement(node)) return renderCodeBlock(node);
  if (typeof node.cloneNode !== 'function') return '';
  var clone;
  try { clone = node.cloneNode(true); } catch (e) { return ''; }
  try {
    var junk = clone.querySelectorAll('script, style, button, svg');
    for (var i = 0; i < junk.length; i++) {
      if (junk[i].parentNode) junk[i].parentNode.removeChild(junk[i]);
    }
    var found = clone.querySelectorAll ? clone.querySelectorAll(CODE_CONTAINER_SEL) : [];
    var outer = [];
    for (var f = 0; f < found.length; f++) {
      if (!isCodeBlockElement(found[f])) continue;
      var nested = false;
      for (var o = 0; o < outer.length; o++) {
        if (outer[o].contains && outer[o].contains(found[f])) { nested = true; break; }
      }
      if (!nested) outer.push(found[f]);
    }
    var doc = clone.ownerDocument || (typeof document !== 'undefined' ? document : null);
    // С конца: после подмены внешнего контейнера вложенные уже неактуальны.
    for (var c = outer.length - 1; c >= 0; c--) {
      var fenced = renderCodeBlock(outer[c]);
      if (!fenced || !outer[c].parentNode || !doc || !doc.createTextNode) continue;
      outer[c].parentNode.replaceChild(doc.createTextNode('\n' + fenced + '\n'), outer[c]);
    }
  } catch (e2) { /* узел без DOM-API (срез-песочница) */ }
  var txt = '';
  try { txt = String(clone.textContent || ''); } catch (e3) { txt = ''; }
  return txt.trim();
}

// Узлы ответа DOM-пути в document-порядке: чанки прозы .n6owBd.awi2gc + САМОСТОЯТЕЛЬНЫЕ
// код-окна между ними (вложенные и инлайн <code> отбрасываются). Один и тот же отбор
// используют DOM-добор перехватчика (extractTurnsFromDocument) и адаптер — иначе сетевой
// и DOM-пути разошлись бы по составу кода.
/**
 * Узлы ответа DOM-пути в document-порядке: чанки прозы + самостоятельные код-окна (O-45).
 * @param {any} root Корень поиска (документ живого DOM).
 * @returns {any[]} Контент-узлы без вложенных дублей.
 */
export function answerDomNodes(root?: any): any[] {
  var doc = root || (typeof document !== 'undefined' ? document : null);
  if (!doc || typeof doc.querySelectorAll !== 'function') return [];
  var nodes = doc.querySelectorAll('.n6owBd.awi2gc, ' + CODE_CONTAINER_SEL);
  var out = [];
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    if (isCodeLikeNode(el) && !isCodeBlockElement(el)) continue;
    var nested = false;
    for (var j = 0; j < out.length; j++) {
      if (out[j].contains && out[j].contains(el)) { nested = true; break; }
    }
    if (nested) continue;
    out.push(el);
  }
  return out;
}

// v1.5.2: чип «Самые популярные результаты веб-поиска по этой теме:» и связанные
// запросы (чужая пользовательская реплика) приходят ПОСЛЕ последнего ответа и раньше
// приклеивались к ходу ассистента через assignContentToTurns. Отсекаем их по тексту:
// заголовок чипа веб-поиска и «Вы сказали:»-реплику, не привязанную к turn-контейнеру
// (настоящий вопрос всегда h2.iMqumd внутри turn, поэтому в contentNodes он не попадает).
/** @type {RegExp} Заголовок чипа веб-поиска: начало блока «связанных запросов» (v1.5.2). */
var WEB_SEARCH_CHIP_RE = /(?:Самые популярные результаты веб-поиска по этой теме|People also search|Related searches|Похожие запросы|Связанные запросы)/i;
/** @type {RegExp} Чужая реплика «Вы сказали: "…"» вне turn-контейнера. */
var FOREIGN_QUESTION_RE = /^Вы сказали:\s*"/;

/**
 * Текст узла без краевых пробелов (устойчиво к узлам без DOM-API).
 * @param {any} node Проверяемый узел.
 * @returns {string} Текст узла либо ''.
 */
function nodeText(node: any): string {
  try { return (node.textContent || '').trim(); } catch (e) { return ''; }
}

// v1.5.2: заголовок чипа веб-поиска в folwr начинает блок «связанных запросов»,
// который идёт ПОСЛЕ последнего ответа модели и ранее приклеивался к ходу ассистента.
/**
 * Узел — заголовок чипа веб-поиска (артефакт UI, а не ответ модели).
 * @param {any} node Проверяемый узел.
 * @returns {boolean} true — узел начинает блок связанных запросов.
 */
function isWebSearchChipNode(node) {
  return WEB_SEARCH_CHIP_RE.test(nodeText(node));
}

// Чужая пользовательская реплика вне turn-контейнера (настоящий вопрос — h2.iMqumd внутри turn).
/**
 * Узел — чужая пользовательская реплика вне turn-контейнера.
 * @param {any} node Проверяемый узел.
 * @returns {boolean} true — узел не относится к ответу модели.
 */
function isForeignQuestionNode(node) {
  return FOREIGN_QUESTION_RE.test(nodeText(node));
}

// Текст маркированного/нумерованного списка: каждый li — markdown-пунктом.
// Формат: «- **Метка**: текст» (метка — первый bold/strong в пункте), без метки — «- текст».
// Вложенные списки превращаются в текст родительского li, поэтому все пункты
// входят в итоговый текст в исходном порядке.
/**
 * Пункт списка → markdown-строка «- **Метка**: текст» либо «- текст».
 * @param {any} liEl Элемент li.
 * @returns {string} Markdown-строка пункта; '' для пустого пункта.
 */
function listItemToMarkdown(liEl) {
  var clone = liEl.cloneNode(true);
  clone.querySelectorAll('script, style, button, svg').forEach(function (el) { el.remove(); });
  var label = null;
  var b = clone.querySelector('strong, b');
  if (b) {
    label = (b.textContent || '').replace(/\s+/g, ' ').trim();
    b.remove();
  }
  var rest = stripTags(decodeEntities(clone.innerHTML)).trim();
  if (label) {
    return '- **' + label + '**' + (rest ? ': ' + rest : '');
  }
  return rest ? '- ' + rest : '';
}
/**
 * Список (ul/ol) → markdown-пункты через '\n'.
 * @param {any} listEl Элемент списка.
 * @returns {string} Текст списка; '' для пустого списка.
 */
function listToText(listEl) {
  var items = listEl.querySelectorAll('li');
  var lines = [];
  for (var r = 0; r < items.length; r++) {
    var t = listItemToMarkdown(items[r]);
    if (t) lines.push(t);
  }
  return lines.join('\n');
}

// ВСЕ контент-узлы ответа в document-порядке, включая маркированные/нумерованные списки
// и вложенные блоки. Вложенные узлы отбрасываем (дедуп по вложенности), чтобы текст не
// дублировался: если список лежит ВНУТРИ чанка .n6owBd.awi2gc — чанк уже содержит его текст;
// если список — самостоятельный узел между заголовком и финальным абзацем — он попадает сюда
// как отдельный контент-узел и больше не теряется.
/**
 * ВСЕ контент-узлы ответа в document-порядке (чанки, таблицы, заголовки, списки, код-окна).
 * @param {any} doc Документ снимка folwr.
 * @returns {any[]} Узлы без вложенных дублей; заголовки вопросов исключены.
 */
function gatherAnswerContentNodes(doc) {
  var raw = doc.querySelectorAll('.n6owBd.awi2gc, table, [role="heading"], h2, h3, h4, ul, ol, li, [role="list"], [role="listitem"], ' + CODE_CONTAINER_SEL);
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var el = raw[i];
    if (isQuestionHeading(el)) continue;
    // O-45: самостоятельным контент-узлом становится только КОД-БЛОК; одиночный инлайн <code>
    // блоком не является (в прозе он уже покрыт родительским чанком) — поведение прежнее.
    if (isCodeLikeNode(el) && !isCodeBlockElement(el)) continue;
    var nested = false;
    for (var j = 0; j < out.length; j++) {
      if (out[j].contains && out[j].contains(el)) { nested = true; break; }
    }
    if (nested) continue;
    out.push(el);
  }
  return out;
}

// Распределяем глобальные контент-узлы ответа по turn-контейнерам: узел относится к последнему
// предшествующему ему ходу (compareDocumentPosition FOLLOWING). Возвращает массив answerParts по turn.
/**
 * Распределяет глобальные контент-узлы по turn-контейнерам (последний предшествующий ход).
 * @param {any[]} turnsArr Turn-контейнеры в document-порядке.
 * @param {any[]} contentNodes Контент-узлы ответа в document-порядке.
 * @returns {string[][]} Части ответа по индексу хода.
 */
function assignContentToTurns(turnsArr, contentNodes) {
  var answers = [];
  var skipAfterChip = [];
  for (var ti = 0; ti < turnsArr.length; ti++) { answers[ti] = []; skipAfterChip[ti] = false; }

  for (var n = 0; n < contentNodes.length; n++) {
    var node = contentNodes[n];
    var assigned = -1;
    for (var t2 = 0; t2 < turnsArr.length; t2++) {
      if (turnsArr[t2].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) {
        assigned = t2;
      } else {
        break;
      }
    }
    if (assigned < 0) continue;
    // v1.5.2: не вклеиваем чужую пользовательскую реплику.
    if (isForeignQuestionNode(node)) continue;
    // v1.5.2: чип веб-поиска («Самые популярные результаты…») начинает блок связанных
    // запросов текущего хода; сам чип и следующие за ним связанные запросы — UI-артефакты,
    // а не ответ модели. Закрываем этот ход до следующего turn-контейнера, НО не обрезаем
    // остальные ходы (глобальный cutoff раньше терял все ответы, когда чип шёл в начале).
    if (isWebSearchChipNode(node)) { skipAfterChip[assigned] = true; continue; }
    if (skipAfterChip[assigned]) continue;

    var part = null;
    if (node.tagName === 'TABLE') {
      var md = tableToMarkdown(node);
      if (md) part = md;
    } else if (node.tagName === 'UL' || node.tagName === 'OL') {
      var lt = listToText(node);
      if (lt) part = lt;
    } else {
      // O-45: код-окно → фенс ```lang … ``` (и код ВНУТРИ чанка тоже), иначе textContent.
      // Многострочный код не схлопывается и не теряет маркеры языка.
      var ct = answerTextOf(node).trim();
      if (ct) part = ct;
    }
    if (part) answers[assigned].push(part);
  }

  return answers;
}

/**
 * Идентификатор треда из разметки (data-session-thread-id).
 * @param {any} doc Документ снимка folwr.
 * @returns {string} Идентификатор треда либо ''.
 */
function readThreadId(doc) {
  try {
    var el = doc.querySelector('[data-session-thread-id]');
    if (el) {
      var v = el.getAttribute('data-session-thread-id');
      return v ? v.trim() : '';
    }
  } catch (e) { }
  return '';
}

/**
 * Разбор снимка folwr: threadId, ходы, сообщения, склеенный текст.
 * @param {string} htmlText HTML-снимок страницы folwr.
 * @returns {FolwrParseResult} Результат разбора; пустой результат для не-строки.
 */
export function parseGoogleFolwrOpen(htmlText: string): FolwrParseResult {
  var turns = [];
  var messages = [];

  if (!htmlText || typeof htmlText !== 'string') {
    return { threadId: '', turns: turns, messages: messages, text: '', count: 0 };
  }

  var doc;
  try {
    doc = new DOMParser().parseFromString(htmlText, 'text/html');
  } catch (e) {
    return { threadId: '', turns: turns, messages: messages, text: '', count: 0 };
  }

  var threadId = readThreadId(doc);
  var turnEls = doc.querySelectorAll('[data-scope-id="turn"]');
  var allAimfl = doc.querySelectorAll('[data-subtree="aimfl"]');
  var turnsArr = Array.prototype.slice.call(turnEls);

  // Фолбэк вопросов из комментариев TgQPHd
  var tgQuestions = [];
  try {
    var tgRe = /<!--TgQPHd\|[\s\S]*?-->/g;
    var m;
    while ((m = tgRe.exec(htmlText)) !== null) {
      var c = decodeEntities(m[0]);
      var longRe = /"([^"]{20,})"/g;
      var lm;
      var found = null;
      while ((lm = longRe.exec(c)) !== null) {
        var cand = lm[1];
        if (cand.indexOf('\\u0026') !== -1) continue;
        if (cand.indexOf('OLOoOd') !== -1) continue;
        if (cand.indexOf('dRog6c') !== -1) continue;
        if (cand.indexOf('TgQPHd') !== -1) continue;
        if (!/[а-яёА-ЯЁ]/.test(cand) && cand.indexOf(' ') === -1) continue;
        found = cand;
        break;
      }
      tgQuestions.push(found);
    }
  } catch (e) { swallowSoft(e, 'gsa-utils:parseGoogleFolwrOpen-tgqphd'); /* тихо */ }

  // Глобальный список контент-узлов ответа (в document-порядке), включая списки и вложенные блоки.
  // Вопросы h2.iMqumd исключаем; вложенные узлы дедуплицируем, чтобы не дублировать текст.
  var contentNodes = gatherAnswerContentNodes(doc);

  var answers = assignContentToTurns(turnsArr, contentNodes);

  for (var i = 0; i < turnsArr.length; i++) {
    var turn = turnsArr[i];

    // Вопрос пользователя из h2.iMqumd
    var question = null;
    var h2 = turn.querySelector('h2.iMqumd');
    if (h2) {
      var raw = (h2.textContent || '').trim();
      var qm = raw.match(/^Вы сказали:\s*"([\s\S]*)"$/);
      question = qm ? qm[1].trim() : raw;
    }

    var assistantText = answers[i].length > 0 ? answers[i].join('\n\n') : null;

    // Фолбэк ответа из aimfl: сначала вложенный в ход, затем глобальный по индексу
    if (!assistantText) {
      var nestedAimfl = turn.querySelector('[data-subtree="aimfl"]');
      if (nestedAimfl) {
        var nat = (nestedAimfl.textContent || '').trim();
        if (nat) assistantText = nat;
      }
    }
    if (!assistantText && allAimfl[i]) {
      var at = (allAimfl[i].textContent || '').trim();
      if (at) assistantText = at;
    }

    // Фолбэк вопроса из TgQPHd
    if (!question && tgQuestions[i]) question = tgQuestions[i];

    turns.push({
      id: (turn.getAttribute && turn.getAttribute('jsuid')) || ('idx' + i),
      userText: question || null,
      assistantText: assistantText || null
    });
  }

  // Если turn-контейнеров нет вовсе — фолбэк folif-стиля
  if (turns.length === 0) {
    var folifAnswer = null;
    for (var aa = 0; aa < allAimfl.length; aa++) {
      var at2 = (allAimfl[aa].textContent || '').trim();
      if (at2) { folifAnswer = at2; break; }
    }
    if (!folifAnswer && contentNodes.length > 0) {
      // используем первый контент-узел (чанк/заголовок/таблица/код-окно)
      var firstNode = contentNodes[0];
      if (firstNode.tagName === 'TABLE') {
        folifAnswer = tableToMarkdown(firstNode);
      } else {
        // O-45: общий рендер узла (код-окно → фенс), как в assignContentToTurns.
        folifAnswer = answerTextOf(firstNode).trim() || null;
      }
    }
    var folifQuestion = tgQuestions.length > 0 ? tgQuestions[0] : null;
    if (folifQuestion || folifAnswer) {
      turns.push({ id: 'folif_' + Date.now(), userText: folifQuestion, assistantText: folifAnswer });
    }
  }

  // Собрать messages + text
  for (var t = 0; t < turns.length; t++) {
    var t2 = turns[t];
    if (t2.userText) messages.push({ role: 'user', text: stripTags(decodeEntities(t2.userText)) });
    if (t2.assistantText) messages.push({ role: 'assistant', text: sanitizeAssistant(t2.assistantText) });
  }

  var text = '';
  for (var mi = 0; mi < messages.length; mi++) {
    text += (mi > 0 ? '\n' : '') + messages[mi].text;
  }

  return { threadId: threadId, turns: turns, messages: messages, text: text, count: messages.length };
}

// ---- Полнота (v1.5.2, дефект «folwr обрезан»): сравнение счётчиков + досбор из DOM ----
// folwr может вернуть меньше ходов, чем реально видно в DOM (переписка длиннее).
// Критерий «ПОЛНАЯ» — только при совпадении счётчика turn-контейнеров folwr и DOM;
// иначе — досбор: merge хвоста/головы из DOM в снимок folwr.

// Число turn-контейнеров в HTML-строке (снимок folwr).
/**
 * Число turn-контейнеров в HTML-строке снимка folwr.
 * @param {string} htmlText HTML-снимок.
 * @returns {number} Количество ходов (0 при ошибке разбора).
 */
export function countTurnContainers(htmlText: string): number {
  if (!htmlText || typeof htmlText !== 'string') return 0;
  try {
    var doc = new DOMParser().parseFromString(htmlText, 'text/html');
    return doc.querySelectorAll('[data-scope-id="turn"]').length;
  } catch (e) { return 0; }
}

// Извлекает ходы из ЖИВОГО DOM (тот же формат, что GoogleSearchAdapter.extractMessages).
// Используется для досбора, когда folwr отдал меньше ходов, чем видно на странице.
/**
 * Извлекает ходы из ЖИВОГО DOM (для досбора, когда folwr отдал меньше ходов).
 * @param {any} doc Документ живого DOM.
 * @returns {FolwrTurn[]} Ходы в document-порядке.
 */
export function extractTurnsFromDocument(doc: any): FolwrTurn[] {
  if (!doc || typeof doc.querySelectorAll !== 'function') return [];
  var turns = [];
  try {
    var turnEls = doc.querySelectorAll('[data-scope-id="turn"]');
    var allAimfl = doc.querySelectorAll('[data-subtree="aimfl"]');
    var turnsArr = Array.prototype.slice.call(turnEls);

    var questions = [];
    for (var i = 0; i < turnsArr.length; i++) {
      var h2 = turnsArr[i].querySelector('h2.iMqumd');
      var q = null;
      if (h2) {
        var raw = (h2.textContent || '').trim();
        var m = raw.match(/^Вы сказали:\s*"([\s\S]*)"$/);
        q = m ? m[1].trim() : raw;
      }
      questions.push(q);
    }

    var answers = [];
    for (var t = 0; t < turnsArr.length; t++) answers[t] = [];
    // O-45: тот же отбор, что у сетевого пути — чанки прозы + САМОСТОЯТЕЛЬНЫЕ код-окна между
    // ними (answerDomNodes); текст узла — общим хелпером answerTextOf (код → ```lang … ```).
    // Раньше окно кода ВНЕ чанка не собиралось и в DOM-доборе: код терялся и здесь.
    var blocks = answerDomNodes(doc);
    for (var b = 0; b < blocks.length; b++) {
      var blk = blocks[b];
      var assigned = -1;
      for (var t2 = 0; t2 < turnsArr.length; t2++) {
        if (turnsArr[t2].compareDocumentPosition(blk) & Node.DOCUMENT_POSITION_FOLLOWING) assigned = t2;
        else break;
      }
      if (assigned >= 0 && assigned < turnsArr.length) {
        var txt = answerTextOf(blk).trim();
        if (txt) answers[assigned].push(txt);
      }
    }

    for (var k = 0; k < turnsArr.length; k++) {
      var joined = answers[k].length ? answers[k].join('\n\n') : null;
      if (!joined && allAimfl[k]) {
        var at = (allAimfl[k].textContent || '').trim();
        if (at) joined = at;
      }
      turns.push({
        id: (turnsArr[k].getAttribute && turnsArr[k].getAttribute('jsuid')) || ('idx' + k),
        userText: questions[k] || null,
        assistantText: joined || null
      });
    }
  } catch (e) { swallowSoft(e, 'gsa-utils:extractTurnsFromDocument'); }
  return turns;
}

// Токен продолжения (курсор пагинации) в ответе folwr: атрибут data-mstk на скрытых
// div'ах-контейнерах следующих порций. Возвращает строку курсора или null.
/**
 * Токен продолжения (курсор пагинации): атрибут data-mstk на скрытых div'ах.
 * @param {string} htmlText HTML-снимок ответа folwr.
 * @returns {string|null} Курсор либо null, если его нет.
 */
export function extractContinuationToken(htmlText: string): string | null {
  if (!htmlText || typeof htmlText !== 'string') return null;
  try {
    var doc = new DOMParser().parseFromString(htmlText, 'text/html');
    var els = doc.querySelectorAll('[data-mstk]');
    var last = null;
    for (var i = 0; i < els.length; i++) {
      var v = els[i].getAttribute('data-mstk');
      if (v) last = v.trim();
    }
    return last;
  } catch (e) { return null; }
}

// =====================================================================================
// O-32: КАНОНИЧЕСКАЯ ИДЕНТИЧНОСТЬ ХОДА (не зависит от формы текста и от пути)
// =====================================================================================
// Живой дефект (GSA, лог 2026-09-23 16:47:48): один и тот же ход одного и того же треда
// приходил в базу ДВУМЯ формами текста, и дедуп по сырой паре (userText||assistantText) их
// не видел — ходы складывались, база росла 6 → 12 → 18 сообщений (textLen 12255 → 24764,
// бейдж 4.4% → 9%) без единого нового сообщения пользователя:
//   форма ДОБОРА (DOM/кэш):  userText=null, assistantText='Ответ в режиме ИИ, исходный
//                            запрос: "Q" A' — вопрос ВНУТРИ текста ответа;
//   форма СЕТИ (folif/folwr): userText='Q', assistantText='A' — вопрос отдельным ходом.
// Идентичность поэтому выводится из СОДЕРЖИМОГО, а не из формы:
//   ключ хода = normalized(userText) + '||' + normalized(answerBody),
// где answerBody — текст ответа БЕЗ сервисной обёртки-вопроса («Ответ в режиме ИИ,
// исходный запрос: "Q"»). Обе формы дают РОВНО один ключ: 'q||a'.
//
// Функции чистые и детерминированные: одинаковый вход → одинаковый ключ на любом пути
// (сеть, DOM-добор, кэш треда, SPA-возврат, F5) — это и есть инвариант §4 отчёта.
//
// ГРАНИЦЫ: ключ меняет ТОЛЬКО идентичность (дедуп/seed). Сам текст хода остаётся байтово
// прежним: reference-значение треда A (12255 знаков / 5658 токенов / 4.4%) не сдвигается.
/**
 * Нормализация части канонического ключа: нижний регистр, NBSP → пробел, только буквы и цифры.
 * @param {string|null|undefined} s Часть ключа (userText или тело ответа).
 * @returns {string} Нормализованная строка.
 */
export function normalizeTurnKeyPart(s: unknown): string {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/\u00a0/g, ' ')
    .replace(/[^a-zа-яё0-9]+/g, '');
}

// Обёртка-вопрос GSA в тексте ответа: «Ответ в режиме ИИ, исходный запрос: "Q" Ответ.»
// Разбор префикса — в wrapperPrefix/answerWrapperParts ниже.
// Хвост обёртки: закрывающая кавычка + короткий служебный суффикс («в ответе», «далее»),
// затем — тело ответа. Тело обязательно: текст, кончающийся на кавычке, обёрткой НЕ
// является, иначе вопрос-цитата в прозе принималась бы за обёртку с пустым телом ответа.
// Проверка «есть ли тело» — простым сравнением (регулярка с «хвостовым непробелом» ложно
// отклоняла тела из одного слова на коротких строках).
/**
 * Хвост обёртки-вопроса содержит тело ответа (а не только закрывающую кавычку).
 * @param {string|null|undefined} tail Текст после закрывающей кавычки обёртки.
 * @returns {boolean} true — тело ответа непустое.
 */
function isAnswerWrapperTail(tail) {
  var t = String(tail == null ? '' : tail);
  // Вызывающий уже снял ЗАКРЫВАЮЩУЮ кавычку обёртки; здесь допускаем её повтор
  // (двойные кавычки «""») и короткую служебную связку («: », «. », « — ») перед телом.
  var body = t.replace(/^["»”']{0,2}/, '').replace(/^[\s.,:;-]{0,4}/, '');
  return body.replace(/\s+/g, '').length > 0;
}
/** @type {RegExp} Служебная связка «вопрос:» в начале ответа (остаточное эхо). */
var QUESTION_ASK_RE = /^(?:в\s+)?(?:ответ(?:е)?(?:\s+на\s+вопрос)?|на\s+вопрос|вопрос)\s*:?\s*/i;

// Разбор ОБЁРТКИ-вопроса: {question, body} либо null (обёртки нет).
// question — текст между кавычками (он же user-реплика хода), body — ответ после обёртки.
// Кавычка обёртки ищется по ПРЕФИКСУ текста, а не первой кавычке вообще: прозаический
// ответ, начинающийся с цитаты («"Цитата" — так пишут…»), обёрткой не считается, потому
// что в префиксе до кавычки нет сервисной связки «…: "Q"» (двоеточия).
/**
 * Префикс обёртки-вопроса до открывающей кавычки включительно («…: "»).
 * @param {string|null|undefined} text Текст ответа.
 * @returns {string|null} Префикс либо null, если обёртки нет.
 */
function wrapperPrefix(text) {
  var s = String(text == null ? '' : text);
  var head = s.slice(0, 96);
  var at = head.indexOf(':');
  if (at === -1) return null;
  var after = head.slice(at + 1);
  var m = /^\s*"/.exec(after);
  if (!m) return null;
  return s.slice(0, at + 1 + m[0].length);
}

/**
 * Разбор обёртки-вопроса: {question, body} либо null (обёртки нет).
 * @param {string|null|undefined} text Текст ответа.
 * @returns {{question: string, body: string}|null} Вопрос обёртки и тело ответа.
 */
function answerWrapperParts(text) {
  var s = String(text == null ? '' : text);
  var prefix = wrapperPrefix(s);
  if (!prefix) return null;
  var rest = s.slice(prefix.length);
  var close = rest.indexOf('"');
  if (close === -1) return null;
  var tail = rest.slice(close + 1);
  if (!isAnswerWrapperTail(tail)) return null;
  var question = rest.slice(0, close).trim();
  if (!question) return null;
  var body = tail.replace(/^["»”']{0,2}/, '').replace(/^[\s.,:;-]+/, '');
  if (!body) return null;
  return { question: question, body: body };
}

// Тело ответа без сервисной обёртки. Обычный текст (обёртки нет) возвращается БАЙТОВО тем
// же: функция ничего не схлопывает и не срезает отступы — только снимает обёртку-вопрос.
/**
 * Тело ответа без сервисной обёртки-вопроса; обычный текст возвращается байтово.
 * @param {string|null|undefined} text Текст ответа.
 * @returns {string} Тело ответа.
 */
export function canonicalAnswerBody(text: unknown): string {
  var wrapper = answerWrapperParts(text);
  if (wrapper) return wrapper.body;
  var s = String(text == null ? '' : text);
  try {
    // Остаточный вопрос-эхо в начале ответа («вопрос: Q A») снимаем один раз.
    var q = QUESTION_ASK_RE.exec(s);
    if (q) {
      var rest2 = s.slice(q[0].length);
      var close2 = rest2.indexOf('"?');
      if (close2 !== -1 && close2 < 200) {
        var body2 = rest2.slice(close2 + 2).replace(/^[\s.,:;-]+/, '');
        if (body2) s = body2;
      }
    }
  } catch (e) { return String(text == null ? '' : text); }
  return s;
}

// Канонический ключ хода: CONTENT-key. userText — структурный источник (h2.iMqumd) либо
// вопрос, извлечённый из обёртки; answerBody — ответ без обёртки. Обе живые формы дают
// РОВНО один ключ: ход сети ('Q' + 'A') и ход добора/сети-эмита (null + 'Ответ в режиме ИИ,
// исходный запрос: "Q" A') → 'q||a'.
/**
 * Части канонической идентичности хода: нормализованный вопрос и нормализованное тело.
 * @param {FolwrTurn|null|undefined} turn Ход переписки.
 * @returns {{u: string, a: string}} Вопрос и тело (обе части нормализованы).
 */
export function turnIdentityParts(turn: FolwrTurn | null | undefined): FolwrTurnIdentity {
  if (!turn) return { u: '', a: '' };
  var wrapper = answerWrapperParts(turn.assistantText);
  var u = normalizeTurnKeyPart(turn.userText);
  if (!u && wrapper) u = normalizeTurnKeyPart(wrapper.question);
  var a = normalizeTurnKeyPart(wrapper ? wrapper.body : canonicalAnswerBody(turn.assistantText));
  return { u: u, a: a };
}

/**
 * Канонический CONTENT-ключ хода: normalized(userText) + '||' + normalized(answerBody).
 * @param {FolwrTurn|null|undefined} turn Ход переписки.
 * @returns {string} Ключ вида 'q||a'; '' для пустого хода.
 */
export function canonicalTurnKeyOf(turn: FolwrTurn | null | undefined): string {
  if (!turn) return '';
  var parts = turnIdentityParts(turn);
  return parts.u + '||' + parts.a;
}

// Каноническая ФОРМА хода: вопрос, живущий только внутри обёртки текста ответа, выносится
// в userText (структурный источник), сам текст ответа сохраняется БАЙТОВО. Ход уже
// канонической формы возвращается как есть — повторный проход идемпотентен.
// Формы различаются ТОЛЬКО вопросом: у хода-обёртки его в структуре нет.
/**
 * Каноническая форма хода: вопрос из обёртки выносится в userText, текст ответа не меняется.
 * @param {FolwrTurn|null|undefined} turn Ход переписки.
 * @returns {FolwrTurn|null} Ход канонической формы (идемпотентно).
 */
export function canonicalizeTurnForThread(turn: FolwrTurn | null | undefined): FolwrTurn | null | undefined {
  if (!turn) return turn;
  var question = (turn.userText == null) ? '' : String(turn.userText).trim();
  if (!question) {
    var wrapper = answerWrapperParts(turn.assistantText);
    if (wrapper) question = wrapper.question;
  }
  return {
    id: turn.id,
    userText: question || null,
    assistantText: (turn.assistantText == null) ? null : turn.assistantText
  };
}

// Предпочтение формы одного и того же хода: богатейшая (полный текст ответа, затем
// заполненный вопрос). Форма-обёртка несёт текст ответа целиком, форма сети — только тело;
// при слиянии двух форм одного хода остаётся обёртка (reference-байты базы не сдвигаются).
/**
 * Предпочтение формы одного и того же хода: длиннее ответ, затем длиннее вопрос.
 * @param {FolwrTurn|null|undefined} candidate Кандидат на замену.
 * @param {FolwrTurn|null|undefined} current Текущая сохранённая форма.
 * @returns {boolean} true — candidate богаче.
 */
function isBetterTurn(candidate, current) {
  if (!current) return true;
  var la = String((candidate && candidate.assistantText) || '').length;
  var lb = String((current && current.assistantText) || '').length;
  if (la !== lb) return la > lb;
  return String((candidate && candidate.userText) || '').length >
    String((current && current.userText) || '').length;
}
/**
 * Нормализованная запись хода: id с fallback, userText/assistantText → null для пустых.
 * @param {FolwrTurn|null|undefined} t Исходный ход.
 * @param {string} idFallback Идентификатор, если у хода его нет.
 * @returns {FolwrTurn} Запись хода.
 */
function turnRecord(t, idFallback) {
  return {
    id: (t && t.id != null) ? t.id : idFallback,
    userText: (t && t.userText) || null,
    assistantText: (t && t.assistantText) || null
  };
}

// =====================================================================================
// O-32 (фикс A): ПРЕФИКС-ТЕРПИМАЯ ИДЕНТИЧНОСТЬ ОДНОГО ХОДА
// =====================================================================================
// Живой дефект (O-32, регрессия SPA): тело ОДНОГО ответа приходило в базу двумя разными
// телами — прерванный стрим (короткая форма) и полный добор (длинная), либо тело с
// маркерами цитат в хвосте. Точный канонический ключ такие формы НЕ схлопывал: база росла
// «старый ход + его продолжение», бейдж удваивался (4.4% → 9%).
// При ОДНОМ И ТОМ ЖЕ вопросе тело одного хода отличается только степенью полноты, поэтому
// тела считаются совместимыми, если одно — префикс другого ЛИБО общий префикс ≥ 80%
// короткого тела. Порог PREFIX_MIN_CHARS отсекает короткие тела («Да» / «Да, верно»), где
// совпадение префикса ничего не доказывает и склейка потеряла бы отдельный ход.
/** @type {number} Минимальная длина тела (нормализованные знаки) для префикс-правила. */
var PREFIX_MIN_CHARS = 12;
/** @type {number} Доля общего префикса, при которой тела считаются одним ответом. */
var PREFIX_FUZZY_RATIO = 0.8;

/**
 * Совместимость тел: одно — префикс другого либо общий префикс ≥ 80% короткого тела.
 * @param {string|null|undefined} a Тело A (нормализованное).
 * @param {string|null|undefined} b Тело B (нормализованное).
 * @returns {boolean} true — тела принадлежат одному ответу разной полноты.
 */
export function bodiesPrefixCompatible(a: unknown, b: unknown): boolean {
  var x = String(a == null ? '' : a);
  var y = String(b == null ? '' : b);
  if (!x || !y) return false;
  if (x === y) return true;
  var n = Math.min(x.length, y.length);
  if (n < PREFIX_MIN_CHARS) return false;
  var common = 0;
  while (common < n && x.charCodeAt(common) === y.charCodeAt(common)) common++;
  if (common === n) return true;
  return (common / n) >= PREFIX_FUZZY_RATIO;
}

/**
 * Полнее ли тело кандидата: при префикс-совместимости решает длина ТЕЛА, не обёртки.
 * @param {FolwrTurn|null|undefined} candidate Кандидат на замену.
 * @param {FolwrTurn|null|undefined} current Текущая сохранённая форма.
 * @returns {boolean} true — тело кандидата полнее.
 */
function isFullerTurn(candidate, current) {
  var la = turnIdentityParts(candidate).a.length;
  var lb = turnIdentityParts(current).a.length;
  if (la !== lb) return la > lb;
  return isBetterTurn(candidate, current);
}

// =====================================================================================
// O-46 (фикс B): ТЕЛО ОДНОГО ОТВЕТА С ДРУГИМ ПОРЯДКОМ АБЗАЦЕВ
// =====================================================================================
// Живой дефект (SPA-возврат в тред 8bTpaveu, 2026-11-07): при возврате на тестовый чат
// пассивный снимок /async/folif приносил тот же ход с ТЕМ ЖЕ телом, но с переставленными
// абзацами (source-snippet-пункт стоял в снимке на 2-м месте, а в кэше треда — на 7-м).
// Канонический ключ порядко-зависим, префикс-правило такой ход не схлопывало (общий
// префикс 429/1865 = 0.19), mergeTurns добавлял его как НОВЫЙ ход: 12 → 14 ходов,
// 24 → 28 сообщений, textLen 34753 → 38902, бейдж 8.4% → 9.3%; на каждом SPA-возврате
// прибавлялись те же 2 хода. Правило: при ОДНОМ вопросе тела эквивалентны, если их
// мультимножества абзацев (текст абзацев без учёта порядка) совпадают. Побайтовое
// равенство упорядоченных тел уже ловит точный ключ, поэтому новый критерий не расширяет
// класс «одинаковых» ответов сверх уже схлопываемого, а только снимает зависимость от
// порядка абзацев, который меняется между снимками.
/** @type {number} Минимум непустых абзацев для правила перестановки. */
var PARAGRAPH_PERMUTATION_MIN = 2;

/**
 * Непустые нормализованные абзацы тела ответа (граница — пустая строка).
 * @param {FolwrTurn|null|undefined} turn Ход переписки.
 * @returns {string[]} Нормализованные абзацы в порядке текста.
 */
function answerBodyParagraphs(turn) {
  var wrapper = answerWrapperParts(turn && turn.assistantText);
  var body = wrapper ? wrapper.body : canonicalAnswerBody(turn && turn.assistantText);
  var lines = String(body == null ? '' : body).split(String.fromCharCode(10));
  var out = [];
  var cur = '';
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.trim() === '') {
      var p = normalizeTurnKeyPart(cur);
      if (p) out.push(p);
      cur = '';
      continue;
    }
    cur = cur ? cur + String.fromCharCode(10) + line : line;
  }
  var tail = normalizeTurnKeyPart(cur);
  if (tail) out.push(tail);
  return out;
}

/**
 * Одно ли тело у ходов A и B при разном порядке абзацев (мультимножество совпало).
 * @param {FolwrTurn|null|undefined} aTurn Ход A.
 * @param {FolwrTurn|null|undefined} bTurn Ход B.
 * @returns {boolean} true — тела различаются только порядком абзацев.
 */
function bodiesParagraphPermutation(aTurn, bTurn) {
  var pa = answerBodyParagraphs(aTurn);
  var pb = answerBodyParagraphs(bTurn);
  if (pa.length < PARAGRAPH_PERMUTATION_MIN || pa.length !== pb.length) return false;
  pa.sort();
  pb.sort();
  for (var i = 0; i < pa.length; i++) {
    if (pa[i] !== pb[i]) return false;
  }
  return true;
}

/**
 * Индекс хода с тем же вопросом и совместимым телом (линейный поиск: баз ≤ сотен).
 * @param {FolwrTurn[]} turns Список ходов.
 * @param {FolwrTurn|null|undefined} turn Проверяемый ход.
 * @returns {number} Индекс совместимого хода либо -1.
 */
function findPrefixCompatibleIndex(turns, turn) {
  var parts = turnIdentityParts(turn);
  if (!parts.u || !parts.a) return -1;
  for (var i = 0; i < turns.length; i++) {
    var other = turnIdentityParts(turns[i]);
    if (other.u !== parts.u) continue;
    if (bodiesPrefixCompatible(other.a, parts.a)) return i;
    // O-46: то же тело пришло с другим порядком абзацев — порядко-зависимый ключ и
    // префикс-правило его не видят; равенство нормализованных длин отсекает лишние
    // разборы строк, мультимножество абзацев доказывает эквивалентность тела.
    if (other.a.length === parts.a.length && bodiesParagraphPermutation(turns[i], turn)) return i;
  }
  return -1;
}

/**
 * Переиндексация канонического ключа после укрупнения хода (старый ключ удаляется).
 * @param {Object<string, number>} byKey Карта ключ → индекс.
 * @param {FolwrTurn[]} turns Список ходов.
 * @param {number} at Индекс изменённого хода.
 * @returns {void}
 */
function reindexTurnKey(byKey, turns, at) {
  var k;
  for (k in byKey) { if (byKey[k] === at) delete byKey[k]; }
  var key = canonicalTurnKeyOf(turns[at]);
  if (key !== '||') byKey[key] = at;
}

// Слияние ходов по id (turn.id) — для тихой пагинации чанков folwr, где один и тот же ход
// может повториться на границе порций. Более новый ход не перезаписывает; дубли по id убираются.
// O-32: вторая ось дедупа — КАНОНИЧЕСКИЙ ключ (canonicalTurnKeyOf): один и тот же ход,
// пришедший разными формами текста и потому с разными id (id-обёртки DOM/кэша vs id-сети),
// больше не входит в базу дважды.
/**
 * Слияние ходов по id и по каноническому ключу (O-32): дубли не входят в базу дважды.
 * @param {FolwrTurn[]|null|undefined} baseTurns Базовая база ходов.
 * @param {FolwrTurn[]|null|undefined} extraTurns Дополнительные (новые) ходы.
 * @returns {FolwrTurn[]} Слитый список в порядке базы.
 */
export function mergeTurnsById(baseTurns: FolwrTurn[], extraTurns: FolwrTurn[]): FolwrTurn[] {
  baseTurns = Array.isArray(baseTurns) ? baseTurns : [];
  extraTurns = Array.isArray(extraTurns) ? extraTurns : [];
  var byId = {};
  /** @type {Object<string, number>} */
  var byKey = {};
  var out = [];
  function add(t) {
    if (!t) return;
    var id = (t.id != null) ? String(t.id) : ('x' + out.length);
    var key = canonicalTurnKeyOf(t);
    var hasId = Object.prototype.hasOwnProperty.call(byId, id);
    var hasKey = (key !== '||') && Object.prototype.hasOwnProperty.call(byKey, key);
    // O-32 (фикс A): третий путь идентичности — тот же вопрос и префикс-совместимое тело
    // (прерванный стрим / маркеры цитат): это ОДИН ход, побеждает полное тело.
    var at = hasId ? byId[id] : (hasKey ? byKey[key] : findPrefixCompatibleIndex(out, t));
    if (at !== -1) {
      var richer = (hasId || hasKey) ? isBetterTurn(t, out[at]) : isFullerTurn(t, out[at]);
      if (richer) {
        out[at] = turnRecord(t, out[at].id);
        reindexTurnKey(byKey, out, at);
      }
      return;
    }
    byId[id] = out.length;
    if (key !== '||') byKey[key] = out.length;
    out.push(turnRecord(t, id));
  }
  var i;
  for (i = 0; i < baseTurns.length; i++) add(baseTurns[i]);
  for (i = 0; i < extraTurns.length; i++) add(extraTurns[i]);
  return out;
}

// O-32: МОНОТОННОЕ слияние по каноническому ключу — счётчик ходов не может упасть.
// Единая точка для «накопитель ∪ новая база» (activateThread/applyTurns/mergeTurns):
// дедуп по id (пагинация) И по каноническому ключу (одна и та же пара в разных формах).
// Порядок базы сохраняется; новый ход дописывается в хвост.
/**
 * Монотонное слияние по каноническому ключу: счётчик ходов не может упасть (O-32).
 * @param {FolwrTurn[]|null|undefined} baseTurns Базовая база ходов.
 * @param {FolwrTurn[]|null|undefined} extraTurns Дополнительные ходы.
 * @returns {FolwrTurn[]} Слитый список.
 */
export function mergeTurnsMonotone(baseTurns: FolwrTurn[], extraTurns: FolwrTurn[]): FolwrTurn[] {
  return mergeTurnsById(baseTurns, extraTurns);
}

// Досбор: сливает ходы folwr и DOM по КАНОНИЧЕСКОМУ ключу хода (см. O-32 выше).
// Ключ прежней формы (сырая пара userText||assistantText) здесь не годится: сетевой ход
// ('Q' + 'A') и ход DOM-добора (null + 'Ответ в режиме ИИ, исходный запрос: "Q" A') давали
// РАЗНЫЕ ключи, и один и тот же ход входил в базу дважды (живой дефект 16:47:48:
// 6 → 12 ходов, 18 сообщений, textLen 12255 → 24764, бейдж 4.4% → 9%).
// При совпадении ключа ход не дублируется: остаётся богатейшая форма (isBetterTurn).
/**
 * Досбор: сливает ходы folwr и DOM по каноническому ключу; побеждает богатейшая форма.
 * @param {FolwrTurn[]|null|undefined} baseTurns Ходы из сети.
 * @param {FolwrTurn[]|null|undefined} extraTurns Ходы DOM-добора.
 * @returns {FolwrTurn[]} Слитый список без дублей.
 */
export function mergeTurnsByKey(baseTurns: FolwrTurn[], extraTurns: FolwrTurn[]): FolwrTurn[] {
  baseTurns = Array.isArray(baseTurns) ? baseTurns : [];
  extraTurns = Array.isArray(extraTurns) ? extraTurns : [];
  /** @type {Object<string, number>} */
  var byKey = {};
  var out = [];
  function add(t) {
    if (!t) return;
    var key = canonicalTurnKeyOf(t);
    if (key === '||') return;
    var hasKey = Object.prototype.hasOwnProperty.call(byKey, key);
    // O-32 (фикс A): без точного ключа — префикс-совместимое тело того же вопроса.
    var at = hasKey ? byKey[key] : findPrefixCompatibleIndex(out, t);
    if (at === -1) {
      byKey[key] = out.length;
      out.push(turnRecord(t, 'x' + out.length));
      return;
    }
    var richer = hasKey ? isBetterTurn(t, out[at]) : isFullerTurn(t, out[at]);
    if (richer) {
      out[at] = turnRecord(t, out[at].id);
      reindexTurnKey(byKey, out, at);
    }
  }
  for (var i = 0; i < baseTurns.length; i++) add(baseTurns[i]);
  for (var j = 0; j < extraTurns.length; j++) add(extraTurns[j]);
  return out;
}

// O-32 (фикс C): ЧИСТКА ГОТОВОГО СПИСКА ХОДОВ перед записью в кэш треда.
// Кэш — источник базы при возврате в тред по SPA, поэтому дубли обязаны отсекаться ДО
// записи: иначе раздутая база переживает навигацию и бейдж остаётся завышенным.
// Объекты ходов не копируются и не переписываются (id и лишние поля сохраняются);
// префикс-совместимые дубли схлопываются, побеждает более полная форма.
/**
 * Дедуп списка ходов: одинаковые и префикс-совместимые ходы схлопываются.
 * @param {FolwrTurn[]|null|undefined} turns Ходы треда.
 * @returns {FolwrTurn[]} Список без дублей (порядок первых вхождений).
 */
export function dedupeTurns(turns: FolwrTurn[]): FolwrTurn[] {
  var list = Array.isArray(turns) ? turns : [];
  /** @type {Object<string, number>} */
  var byKey = {};
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    if (!t) continue;
    var key = canonicalTurnKeyOf(t);
    var hasKey = (key !== '||') && Object.prototype.hasOwnProperty.call(byKey, key);
    var at = hasKey ? byKey[key] : findPrefixCompatibleIndex(out, t);
    if (at === -1) {
      if (key !== '||') byKey[key] = out.length;
      out.push(t);
      continue;
    }
    var richer = hasKey ? isBetterTurn(t, out[at]) : isFullerTurn(t, out[at]);
    if (richer) {
      out[at] = t;
      reindexTurnKey(byKey, out, at);
    }
  }
  return out;
}

// ---- v1.17: классификация страницы ПРОДОЛЖЕНИЯ по СОДЕРЖИМОМУ, а не по длине ----
// Живой дефект (новый формат Google Search AI): в ответе folwr ВСЕГДА есть data-mstk,
// но это сессионный токен продолжения диалога (/async/folif), а НЕ курсор «догрузить
// старые ходы». Запрос folwr с этим mstk отдаёт короткое или пустое тело.
// Прежний гейт `txt.length <= 100000` объявлял такую страницу «пустой» ДО разбора →
// probe завершался с ПОЛНАЯ=false, а content.js навсегда оставался с baseComplete=false.
// Теперь решение принимается по факту разбора: сколько НОВЫХ ходов дал ответ и есть ли
// НОВЫЙ (отличный от отправленного) курсор.
//
// input: { ok, status, bodyLength, newTurns, cursor, sentCursor }
// Возврат: { kind, complete, canContinue, status, ok, bodyLength, newTurns, cursor,
//            cursorRepeated, log }
//   kind: 'http-error' | 'empty-body' | 'cursor-repeat' | 'no-new-turns' | 'new-turns'
//   complete=true   → истории больше нет, базу можно объявить ПОЛНОЙ;
//   canContinue=true → имеет смысл запрашивать следующую страницу (только 'new-turns').
/**
 * Классификация страницы ПРОДОЛЖЕНИЯ по содержимому, а не по длине (v1.17).
 * @param {{ok?: boolean, status?: number|null, bodyLength?: number, newTurns?: number, cursor?: string|null, sentCursor?: string|null}} input Результат запроса.
 * @returns {FolwrContinuation} Вид исхода и признаки complete/canContinue.
 */
export function classifyFolwrContinuation(input: FolwrContinuationInput | null): FolwrContinuation {
  var i = input || {};
  var ok = i.ok === true;
  var status = (i.status == null) ? 0 : i.status;
  var bodyLength = (typeof i.bodyLength === 'number' && i.bodyLength >= 0) ? i.bodyLength : 0;
  var newTurns = (typeof i.newTurns === 'number' && i.newTurns > 0) ? i.newTurns : 0;
  var cursor = i.cursor ? String(i.cursor) : null;
  var sentCursor = i.sentCursor ? String(i.sentCursor) : null;
  var cursorRepeated = !!(cursor && sentCursor && cursor === sentCursor);

  /** @type {FolwrContinuationKind} */
  var kind;
  var complete, canContinue;
  if (!ok) {
    kind = 'http-error'; complete = false; canContinue = false;
  } else if (bodyLength === 0) {
    // 200 и ноль байт — сервер не дал продолжения; повторов не делаем.
    kind = 'empty-body'; complete = true; canContinue = false;
  } else if (cursorRepeated) {
    // Тот же курсор → следующий запрос вернёт ту же страницу: гасим цикл.
    kind = 'cursor-repeat'; complete = true; canContinue = false;
  } else if (newTurns > 0) {
    kind = 'new-turns'; complete = false; canContinue = true;
  } else {
    kind = 'no-new-turns'; complete = true; canContinue = false;
  }

  return {
    kind: kind,
    complete: complete,
    canContinue: canContinue,
    status: status,
    ok: ok,
    bodyLength: bodyLength,
    newTurns: newTurns,
    cursor: cursor,
    cursorRepeated: cursorRepeated,
    log: 'kind=' + kind + ' status=' + status + ' ok=' + (ok ? 1 : 0) +
      ' len=' + bodyLength + 'B ходов=+' + newTurns +
      ' курсор=' + (cursor ? ('есть(' + (cursorRepeated ? 'повтор' : 'новый') + ')') : 'нет')
  };
}

// Универсальный экспорт: браузер (window-зеркало) и ES-модуль
if (typeof window !== 'undefined') {
  window.parseGoogleFolwrOpen = parseGoogleFolwrOpen;
  /** @type {GoogleFolwrUtilsApi} */
  window.GoogleFolwrUtils = {
    countTurnContainers: countTurnContainers,
    extractTurnsFromDocument: extractTurnsFromDocument,
    mergeTurnsByKey: mergeTurnsByKey,
    extractContinuationToken: extractContinuationToken,
    mergeTurnsById: mergeTurnsById,
    mergeTurnsMonotone: mergeTurnsMonotone,
    classifyFolwrContinuation: classifyFolwrContinuation,
    // O-32: каноническая идентичность/форма хода — ОДИН источник правды для сетевого пути,
    // DOM-добора перехватчика и DOM-пути адаптера (см. блок «O-32» ниже по файлу).
    canonicalTurnKeyOf: canonicalTurnKeyOf,
    canonicalAnswerBody: canonicalAnswerBody,
    canonicalizeTurnForThread: canonicalizeTurnForThread,
    normalizeTurnKeyPart: normalizeTurnKeyPart,
    // O-32 (фикс A/C): префикс-терпимая идентичность хода и дедуп списка перед кэшем.
    turnIdentityParts: turnIdentityParts,
    bodiesPrefixCompatible: bodiesPrefixCompatible,
    dedupeTurns: dedupeTurns,
    // O-45: общий рендер код-блоков (```lang … ```) и отбор узлов DOM-пути —
    // переиспользуются адаптером (adapters/google-search-adapter.js) и тестами.
    renderCodeBlock: renderCodeBlock,
    answerTextOf: answerTextOf,
    answerDomNodes: answerDomNodes,
    isCodeBlockElement: isCodeBlockElement
  };
}
