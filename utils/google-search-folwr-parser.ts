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
  // BUG-M: настоящий курсор истории (AUtEx…) против сессионного mstk из folif-тела.
  isHistoryCursor: typeof isHistoryCursor;
  // BUG-G: вопрос A-only хода из DOM-пузыря и fill-only добор userText по каноническому ключу.
  resolveUserQuestionForTurn: typeof resolveUserQuestionForTurn;
  fillMissingUserText: typeof fillMissingUserText;
  // BUG-J: выравнивание порядка ходов по живому DOM (old→new) и вердикт для диагностики.
  orderTurnsByDom: typeof orderTurnsByDom;
  renderCodeBlock: typeof renderCodeBlock;
  answerTextOf: typeof answerTextOf;
  answerDomNodes: typeof answerDomNodes;
  isCodeBlockElement: typeof isCodeBlockElement;
  // BUG-08/фаза 4: снятие сервисных эхо-обёрток GSA при проекции файла.
  stripGsaUserEcho: typeof stripGsaUserEcho;
  stripGsaAssistantEcho: typeof stripGsaAssistantEcho;
}

/**
 * Декодирует HTML-сущности: именованные (&quot;, &amp;, …) и числовые (&#123;).
 * @param {string} s Разметка или текст с сущностями.
 * @returns {string} Текст с раскрытыми сущностями; '' для пустого входа.
 */
function decodeEntities(s: string): string {
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
function mapOutsideFences(s: string | null | undefined, fn: (seg: string) => string): string {
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
function stripTagsSeg(seg: string): string {
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
function stripTags(html: string): string {
  if (!html) return '';
  return mapOutsideFences(html, stripTagsSeg).replace(/^\s+/, '').replace(/\s+$/, '');
}

/**
 * Сегмент ответа без тегов с сохранением переводов строк.
 * @param {string} seg Сегмент разметки (вне фенса).
 * @returns {string} Текст: строки обрезаны по краям, пустые серии схлопнуты.
 */
function sanitizeAssistantSeg(seg: string): string {
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
function sanitizeAssistant(s: string): string {
  if (!s) return '';
  return mapOutsideFences(s, sanitizeAssistantSeg).replace(/^\s+/, '').replace(/\s+$/, '');
}

// Ячейка таблицы: текст без внутренних тегов, без мусорных узлов.
/**
 * Ячейка таблицы: текст без внутренних тегов, без мусорных узлов (script/style/button/svg).
 * @param {any} cellEl Ячейка th/td.
 * @returns {string} Текст ячейки.
 */
function tableCellText(cellEl: Element): string {
  var clone = cellEl.cloneNode(true) as Element;
  clone.querySelectorAll('script, style, button, svg').forEach(function (el) { el.remove(); });
  return stripTags(decodeEntities(clone.innerHTML)).trim();
}

// Таблица → markdown-строки: каждая строка таблицы = "| ячейка | ячейка |", строки через '\n'.
/**
 * Таблица → markdown-строки вида «| ячейка | ячейка |».
 * @param {any} tableEl Элемент table.
 * @returns {string} Строки таблицы через '\n'; '' для пустой таблицы.
 */
function tableToMarkdown(tableEl: Element): string {
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
function isQuestionHeading(el: Element): boolean {
  return el.tagName === 'H2' && Boolean(el.className) && String(el.className).indexOf('iMqumd') !== -1;
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
function classOf(el: Element | null | undefined): string {
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
function isWebSearchChipNode(node: Node): boolean {
  return WEB_SEARCH_CHIP_RE.test(nodeText(node));
}

// Чужая пользовательская реплика вне turn-контейнера (настоящий вопрос — h2.iMqumd внутри turn).
/**
 * Узел — чужая пользовательская реплика вне turn-контейнера.
 * @param {any} node Проверяемый узел.
 * @returns {boolean} true — узел не относится к ответу модели.
 */
function isForeignQuestionNode(node: Node): boolean {
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
function listItemToMarkdown(liEl: Element): string {
  var clone = liEl.cloneNode(true) as Element;
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
function listToText(listEl: Element): string {
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
function gatherAnswerContentNodes(doc: Document): Element[] {
  var raw = doc.querySelectorAll('.n6owBd.awi2gc, table, [role="heading"], h2, h3, h4, ul, ol, li, [role="list"], [role="listitem"], ' + CODE_CONTAINER_SEL);
  var out: Element[] = [];
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
function assignContentToTurns(turnsArr: Element[], contentNodes: Element[]): string[][] {
  var answers: string[][] = [];
  var skipAfterChip: boolean[] = [];
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
function readThreadId(doc: Document): string {
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
  var turns: FolwrTurn[] = [];
  var messages: FolwrMessage[] = [];

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

  // BUG-O (2.1.4): направление тела folwr — НЕ константа. Серверный экспорт идёт new→old,
  // а тело треда, созданного в текущей сессии, приходит old→new (живой лог: SPA dE_8au,
  // экспорт был перевёрнут). Единственный эталон порядка — живой DOM (он хронологический).
  // При доказанном совпадении ходов выравниваем по нему; без доказательств (нет DOM, <2
  // сопоставлений, чужой тред) — прежнее поведение: реверс серверного new→old.
  if (turns.length > 1) {
    var domOrder = 'no-evidence';
    try {
      var liveDoc: any = (typeof document !== 'undefined') ? document : null;
      if (liveDoc && typeof liveDoc.querySelectorAll === 'function') {
        var domTid = readThreadId(liveDoc);
        if (!threadId || !domTid || threadId === domTid) {
          var domTurns = extractTurnsFromDocument(liveDoc);
          if (domTurns.length > 0) {
            var ordered = orderTurnsByDom(turns, domTurns);
            domOrder = ordered.verdict;
            if (ordered.verdict !== 'no-evidence') turns = ordered.turns;
          }
        }
      }
    } catch (e) { swallowSoft(e, 'gsa-utils:parseGoogleFolwrOpen-order'); }
    if (domOrder === 'no-evidence') turns.reverse();
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
 * @returns {FolwrTurn[]} Ходы в хронологическом порядке (oldest-first).
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
      } else {
        // BUG-G: h2 нет (A-only ход) — вопрос остался только в DOM-пузыре пользователя.
        // Эхо h3.iMqumd внутри хода валидирует пару; без пары вопрос не угадывается.
        q = resolveUserQuestionForTurn(doc, turnsArr[i]);
      }
      questions.push(q);
    }

    var answers: string[][] = [];
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
  // BUG-G (замер 2026-11-14, тред 8bTpaveuJtWckdUP46iumAo): в живом DOM 21 контейнер
  // [data-scope-id="turn"], document order ХРОНОЛОГИЧЕСКИЙ (c[0] — вопрос «deepseek fall down»,
  // c[20] — последний ход). Прежний reverse() разворачивал уже правильный порядок и уводил
  // свежий DOM-ход в голову треда. Реверс остаётся только у сетевого снимка folwr (:826):
  // он приходит new→old.
  return turns;
}

// =====================================================================================
// BUG-J: ВЫРАВНИВАНИЕ ПОРЯДКА ПО ЖИВОМУ DOM
// =====================================================================================
// Живой дефект (тред nOX6apueFdSqxc8P2ZzpkQY, F5): при ХОЛОДНОЙ загрузке GSA
// (`folwr-open`) счётчики снимка и DOM совпали, досбора не было, и в базу ушёл порядок
// самого снимка — new→old; messages[0] оказался последним ходом. DOM в этот момент уже
// хронологический (extractTurnsFromDocument, c[0] — самый старый ход), поэтому единственный
// достоверный эталон порядка — он. Хелпер не двигает состав ходов: только решает, развернуть
// ли список, и сообщает вердикт для диагностики.

/** Результат выравнивания порядка ходов по живому DOM. */
export interface FolwrTurnOrderResult {
  /** Ходы в нормализованном порядке (old→new). */
  turns: FolwrTurn[];
  /** 'kept' — порядок уже совпал с DOM, 'reversed' — развёрнут, 'no-evidence' — доказательств нет. */
  verdict: 'kept' | 'reversed' | 'no-evidence';
  /** Сколько ходов удалось сопоставить с ходом живого DOM. */
  matched: number;
}

/**
 * Синтетический ли id хода: позиционный 'idxN' и folif-фолбэк идентичностью не считаются —
 * они зависят от порядка обхода и совпали бы у РАЗНЫХ ходов в двух разных порядках.
 * @param {string|null|undefined} id Идентификатор хода.
 * @returns {boolean} true — id синтетический либо пустой.
 */
function isSyntheticTurnId(id: string | null | undefined): boolean {
  var s = String(id == null ? '' : id);
  if (!s) return true;
  return s.indexOf('idx') === 0 || s.indexOf('folif_') === 0;
}

/**
 * Ранг хода в живом DOM. Идентичность — по убыванию надёжности: jsuid, затем канонический
 * CONTENT-ключ (canonicalTurnKeyOf), затем тело ответа (turnIdentityParts + bodiesPrefixCompatible).
 * @param {FolwrTurn|null|undefined} turn Ход из снимка.
 * @param {FolwrTurn[]} domTurns Ходы живого DOM в хронологическом порядке.
 * @returns {number} Индекс в domTurns; -1 — соответствия нет.
 */
function domRankOfTurn(turn: FolwrTurn | null | undefined, domTurns: FolwrTurn[]): number {
  if (!turn) return -1;
  var i;
  var id = String(turn.id == null ? '' : turn.id);
  if (!isSyntheticTurnId(id)) {
    for (i = 0; i < domTurns.length; i++) {
      if (domTurns[i] && String(domTurns[i].id == null ? '' : domTurns[i].id) === id) return i;
    }
  }
  var key = canonicalTurnKeyOf(turn);
  if (key && key !== '||') {
    for (i = 0; i < domTurns.length; i++) {
      if (canonicalTurnKeyOf(domTurns[i]) === key) return i;
    }
  }
  var body = turnIdentityParts(turn).a;
  if (body) {
    for (i = 0; i < domTurns.length; i++) {
      var other = turnIdentityParts(domTurns[i]).a;
      if (other && bodiesPrefixCompatible(body, other)) return i;
    }
  }
  return -1;
}

/**
 * Выравнивает порядок ходов по хронологическому живому DOM: если у сопоставленных ходов
 * убывающих пар больше, чем возрастающих, список разворачивается. Состав не меняется.
 * @param {FolwrTurn[]|null|undefined} turns Ходы в проверяемом порядке (обычно new→old).
 * @param {FolwrTurn[]|null|undefined} domTurns Ходы живого DOM (old→new).
 * @returns {FolwrTurnOrderResult} Ходы в порядке old→new, вердикт и число сопоставлений.
 */
export function orderTurnsByDom(
  turns: FolwrTurn[] | null | undefined,
  domTurns: FolwrTurn[] | null | undefined
): FolwrTurnOrderResult {
  var list: FolwrTurn[] = Array.isArray(turns) ? turns : [];
  var dom: FolwrTurn[] = Array.isArray(domTurns) ? domTurns : [];
  var ranks: number[] = [];
  var i;
  for (i = 0; i < list.length; i++) {
    var rank = domRankOfTurn(list[i], dom);
    if (rank >= 0) ranks.push(rank);
  }
  var matched = ranks.length;
  // Меньше двух сопоставлений — направление не доказано: список остаётся как есть.
  if (matched < 2) return { turns: list, verdict: 'no-evidence', matched: matched };
  var up = 0;
  var down = 0;
  for (i = 1; i < ranks.length; i++) {
    if (ranks[i] > ranks[i - 1]) up++;
    else if (ranks[i] < ranks[i - 1]) down++;
  }
  if (down > up) return { turns: list.slice().reverse(), verdict: 'reversed', matched: matched };
  return { turns: list, verdict: 'kept', matched: matched };
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

// Признак НАСТОЯЩЕГО курсора истории («догрузить старые ходы»): токен вида AUtEx…
// Тело /async/folif ВСЕГДА несёт data-mstk, но это СЕССИОННЫЙ токен диалога, а не курсор
// истории: запрос folwr с ним отдаёт 400/пустое тело (BUG-M). Поэтому probe разрешён
// только по курсору истории (open-ответ folwr), а пассивный снимок вердикт не требует.
/** @type {RegExp} Формат курсора истории folwr. */
var HISTORY_CURSOR_RE = /^AUtEx/i;

/**
 * Курсор истории ли это (а не сессионный mstk из folif-тела).
 * @param {string|null|undefined} token Токен продолжения из тела ответа.
 * @returns {boolean} true — курсор «догрузить старые ходы».
 */
export function isHistoryCursor(token: string | null | undefined): boolean {
  if (!token || typeof token !== 'string') return false;
  return HISTORY_CURSOR_RE.test(token.trim());
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
function isAnswerWrapperTail(tail: string | null | undefined): boolean {
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
function wrapperPrefix(text: string | null | undefined): string | null {
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
function answerWrapperParts(text: unknown): { question: string; body: string } | null {
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

// =====================================================================================
// BUG-08/фаза 4: сервисные эхо-обёртки GSA не должны попадать в тело файла.
// Живой захват: user = «Вы отправили 1 изображения и сделали запрос "Q"»,
// assistant = «Ответ в режиме ИИ, исходные файлы: …, исходный запрос: "Q"\n\nA».
// Обёртки остаются в turns — на них держатся identity/полнота; чистятся только
// тексты сообщений ПРИ ПРОЕКЦИИ файла (metrics/бейдж байтово прежние).
// =====================================================================================
/**
 * Снимает пользовательскую эхо-обёртку GSA: «Вы отправили … запрос "Q"» → Q.
 * Меняет текст только при цельном совпадении (закрывающая кавычка в конце);
 * иначе возвращает вход без изменений.
 * @param {*} text Текст пользовательского хода.
 * @returns {string} Чистый вопрос либо исходный текст.
 */
export function stripGsaUserEcho(text: unknown): string {
  var t = String(text == null ? '' : text).trim();
  if (!t) return t;
  var m = /^Вы\s+отправили[\s\S]*?запрос\s*:?\s*"/i.exec(t.slice(0, 240));
  if (!m) return t;
  var rest = t.slice(m[0].length);
  var close = rest.lastIndexOf('"');
  if (close === -1) return t;
  if (rest.slice(close + 1).trim()) return t;
  var q = rest.slice(0, close).trim();
  return q || t;
}

/**
 * Разбор ответной эхо-обёртки GSA с необязательным сегментом «исходные файлы: …».
 * answerWrapperParts ищет двоеточие только в первом сегменте и на такой форме
 * останавливается; здесь опорная точка — слово «запрос" перед кавычкой вопроса.
 * @param {string} text Текст ответа.
 * @returns {{question: string, body: string}|null} Части обёртки либо null.
 */
function gsaAnswerEchoParts(text: string): { question: string; body: string } | null {
  var m = /^Ответ\s+в\s+режиме\s+ИИ(?:[\s,]|$)[\s\S]*?запрос\s*:?\s*"/i.exec(text.slice(0, 300));
  if (!m) return null;
  var rest = text.slice(m[0].length);
  var close = -1;
  // Приоритет — кавычке, после которой тело начинается с новой строки: вопрос
  // может содержать собственные кавычки («в папку "спам"…»).
  for (var i = 0; i < rest.length; i++) {
    if (rest.charAt(i) !== '"') continue;
    var tail = rest.slice(i + 1);
    if (/^[\r\n]/.test(tail) && isAnswerWrapperTail(tail)) { close = i; break; }
  }
  if (close === -1) {
    for (var j = 0; j < rest.length; j++) {
      if (rest.charAt(j) !== '"') continue;
      if (isAnswerWrapperTail(rest.slice(j + 1))) { close = j; break; }
    }
  }
  // Чистое эхо без тела: закрывающая кавычка в конце текста.
  if (close === -1) {
    var last = rest.lastIndexOf('"');
    if (last !== -1 && !rest.slice(last + 1).trim()) close = last;
  }
  if (close === -1) return null;
  var body = rest.slice(close + 1).replace(/^["»”']{0,2}/, '').replace(/^[\s.,:;-]+/, '');
  return { question: rest.slice(0, close).trim(), body: body };
}

/**
 * Снимает ответную эхо-обёртку GSA: «Ответ в режиме ИИ, … запрос: "Q"\n\nA» → A.
 * Обёртка без тела ответа (чистое эхо) даёт пустую строку; проза, похожая на
 * обёртку, но без кавычки-двоеточия, возвращается без изменений.
 * @param {*} text Текст ответа.
 * @returns {string} Тело ответа либо исходный текст.
 */
export function stripGsaAssistantEcho(text: unknown): string {
  var t = String(text == null ? '' : text).trim();
  if (!t) return t;
  var wrapper = gsaAnswerEchoParts(t);
  if (wrapper) return wrapper.body;
  if (/^Ответ\s+в\s+режиме\s+ИИ(?:[\s,]|$)/i.test(t) && wrapperPrefix(t)) return '';
  return t;
}

// =====================================================================================
// BUG-G: A-only ход GSA — пользовательская реплика есть только в DOM-пузыре, а в
// контейнере хода остался один h3.iMqumd с эхом-обёрткой («Ответ в режиме ИИ, исходный
// запрос: "Q"»). Эхо — ТОЛЬКО валидатор пары: сам userText из него не синтезируется
// (состав ходов остаётся сетевым, вопрос берётся из текста пузыря).
// =====================================================================================
/**
 * Вопрос из эха-обёртки h3.iMqumd контейнера хода (между открывающей и ПОСЛЕДНЕЙ кавычкой).
 * @param {any} turnEl Контейнер хода.
 * @returns {string|null} Вопрос эха; null — обёртки нет либо после кавычки остался текст.
 */
function extractEchoQuestion(turnEl: Element): string | null {
  try {
    if (!turnEl || typeof turnEl.querySelector !== 'function') return null;
    var h3 = turnEl.querySelector('h3.iMqumd');
    if (!h3) return null;
    var raw = String(h3.textContent == null ? '' : h3.textContent).trim();
    var prefix = wrapperPrefix(raw);
    if (!prefix) return null;
    var rest = raw.slice(prefix.length);
    var close = rest.lastIndexOf('"');
    if (close === -1) return null;
    // Цельная обёртка: после закрывающей кавычки только пробелы, иначе это не эхо.
    if (rest.slice(close + 1).replace(/\s+/g, '').length > 0) return null;
    var q = rest.slice(0, close).trim();
    return q || null;
  } catch (e) { return null; }
}

/**
 * Снимает обрамляющие кавычки (прямые, типографские, «ёлочки») и пробелы.
 * @param {string|null|undefined} text Текст кандидата.
 * @returns {string} Текст без обрамляющих кавычек.
 */
function stripBubbleQuotes(text: string | null | undefined): string {
  return String(text == null ? '' : text)
    .trim()
    .replace(/^["'«»„“”‘’]+/, '')
    .replace(/["'«»„“”‘’]+$/, '')
    .trim();
}

/**
 * Вопрос A-only хода из DOM-пузыря пользователя по эхо-валидации h3.iMqumd.
 * Кандидаты — листовые span вне контейнеров ходов; нормализация — normalizeTurnKeyPart.
 * @param {any} doc Документ живого DOM.
 * @param {any} turnEl Контейнер хода без h2.iMqumd.
 * @returns {string|null} Текст пузыря без кавычек; null — пары нет или кандидатов не ровно один.
 */
export function resolveUserQuestionForTurn(doc: any, turnEl: any): string | null {
  try {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null;
    var echoQ = extractEchoQuestion(turnEl);
    if (!echoQ) return null;
    var want = normalizeTurnKeyPart(echoQ);
    if (!want) return null;
    var spans = doc.querySelectorAll('span');
    var found: string | null = null;
    for (var i = 0; i < spans.length; i++) {
      var el = spans[i];
      if (!el || !el.textContent) continue;
      // Кандидат — ЛИСТОВОЙ span: обёртки-дубли (span внутри span) дают один лист, а не два.
      if (el.children && el.children.length > 0) continue;
      // Реплики внутри контейнеров ходов — не пузырь: это уже разобранный вопрос хода.
      if (typeof el.closest === 'function' && el.closest('[data-scope-id="turn"]')) continue;
      var text = stripBubbleQuotes(el.textContent);
      if (!text || normalizeTurnKeyPart(text) !== want) continue;
      if (found !== null) return null;   // два кандидата — пара неоднозначна, добора нет
      found = text;
    }
    return found;
  } catch (e) { return null; }
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
 * Вопрос из обёртки с учётом КАВЫЧЕК ВНУТРИ вопроса.
 * `answerWrapperParts` закрывает вопрос на ПЕРВОЙ кавычке: вопрос с цитатой
 * («в папку "спам"…», BUG-H/8bTpaveu…) обрезался до префикса, и канонизация
 * создавала дубль хода вместо склейки. Здесь закрывающая кавычка — первая,
 * после которой начинается тело ответа с новой строки (&quot;\n&quot;), с откатом на
 * прежний разбор, если такой кавычки нет.
 * @param {string|null|undefined} text Текст ответа.
 * @returns {string} Вопрос обёртки либо пустая строка.
 */
function wrapperQuestion(text: string | null | undefined): string {
  var s = String(text == null ? '' : text);
  var prefix = wrapperPrefix(s);
  if (!prefix) return '';
  var rest = s.slice(prefix.length);
  var firstWs = -1;
  for (var i = 0; i < rest.length; i++) {
    if (rest.charAt(i) !== '"') continue;
    var tail = rest.slice(i + 1);
    if (!isAnswerWrapperTail(tail)) continue;
    if (/^[\r\n]/.test(tail)) return rest.slice(0, i).trim();
    if (firstWs === -1 && /^\s/.test(tail)) firstWs = i;
  }
  if (firstWs !== -1) return rest.slice(0, firstWs).trim();
  var legacy = answerWrapperParts(s);
  return legacy ? legacy.question : '';
}

/**
 * Каноническая форма хода: вопрос из обёртки выносится в userText, текст ответа не меняется.
 * @param {FolwrTurn|null|undefined} turn Ход переписки.
 * @returns {FolwrTurn|null} Ход канонической формы (идемпотентно).
 */
export function canonicalizeTurnForThread(turn: FolwrTurn | null | undefined): FolwrTurn | null | undefined {
  if (!turn) return turn;
  var question = (turn.userText == null) ? '' : String(turn.userText).trim();
  if (!question) {
    question = wrapperQuestion(turn.assistantText);
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
function isBetterTurn(candidate: FolwrTurn | null | undefined, current: FolwrTurn | null | undefined): boolean {
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
function turnRecord(t: FolwrTurn | null | undefined, idFallback: string): FolwrTurn {
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
function isFullerTurn(candidate: FolwrTurn | null | undefined, current: FolwrTurn | null | undefined): boolean {
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
function answerBodyParagraphs(turn: FolwrTurn | null | undefined): string[] {
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
function bodiesParagraphPermutation(aTurn: FolwrTurn | null | undefined, bTurn: FolwrTurn | null | undefined): boolean {
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
function findPrefixCompatibleIndex(turns: FolwrTurn[], turn: FolwrTurn | null | undefined): number {
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
function reindexTurnKey(byKey: Record<string, number>, turns: FolwrTurn[], at: number): void {
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
  var byId: Record<string, number> = {};
  /** @type {Object<string, number>} */
  var byKey: Record<string, number> = {};
  var out: FolwrTurn[] = [];
  function add(t: FolwrTurn | null | undefined): void {
    if (!t) return;
    var id = (t.id != null) ? String(t.id) : ('x' + out.length);
    var key = canonicalTurnKeyOf(t);
    var hasId = Object.prototype.hasOwnProperty.call(byId, id);
    var hasKey = (key !== '||') && Object.prototype.hasOwnProperty.call(byKey, key);
    // O-32 (фикс A): третий путь идентичности — тот же вопрос и префикс-совместимое тело
    // (прерванный стрим / маркеры цитат): это ОДИН ход, побеждает полное тело.
    var at = hasId ? byId[id] : (hasKey ? byKey[key] : findPrefixCompatibleIndex(out, t));
    if (at !== -1) {
      // BUG-H (2.1.4): один jsuid на ДВА РАЗНЫХ ВОПРОСА — регенерация ответа переиспользовала id
      // контейнера, но это не дубль одного хода (вопросы разные), а два хода: схлопывание теряло
      // вопрос и userLen (живой дефект: 24 хода → 23, userLen 7672 → 7569, «ответ без вопроса»).
      // Разные вопросы И несовместимые тела ⇒ второй ход дописывается и индексируется по своему
      // ключу (повторное слияние находит его там и не дублирует). Рост/правка ответа того же
      // вопроса по-прежнему схлопывается до богатейшей формы.
      var otherParts = turnIdentityParts(out[at]);
      var parts = turnIdentityParts(t);
      if (hasId && !hasKey && parts.u && otherParts.u && parts.u !== otherParts.u &&
        !bodiesPrefixCompatible(otherParts.a, parts.a)) {
        byKey[key] = out.length;
        out.push(turnRecord(t, id));
        return;
      }
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
  var byKey: Record<string, number> = {};
  var out: FolwrTurn[] = [];
  function add(t: FolwrTurn | null | undefined): void {
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
    // BUG-G: вопрос, уже добытый для хода, повышением формы не теряется — переносится.
    var prevUserText = out[at].userText;
    if (richer) {
      out[at] = turnRecord(t, out[at].id);
      if (!out[at].userText && prevUserText) out[at].userText = prevUserText;
      reindexTurnKey(byKey, out, at);
    }
    // BUG-G (fill-only): пустой userText заполняется вопросом совпавшего по ключу хода.
    // assistantText/id остаются байтово прежними, новых ходов не появляется.
    if (!out[at].userText && t.userText) {
      out[at] = { id: out[at].id, userText: t.userText, assistantText: out[at].assistantText };
      delete byKey[key];
      reindexTurnKey(byKey, out, at);
    }
  }
  for (var i = 0; i < baseTurns.length; i++) add(baseTurns[i]);
  for (var j = 0; j < extraTurns.length; j++) add(extraTurns[j]);
  return out;
}

// BUG-G: УЗКИЙ ДОБОР userText (A-only ход). Никаких новых ходов: состав базы — из сети, а
// вопрос существующего хода с ПУСТЫМ userText берётся из DOM-добора по каноническому ключу.
// Порядок, длина, id и байты assistantText не меняются; два разных текста на ключ → пропуск.
// BUG-H (A-only fill): у хода без вопроса канонический ключ равен '||a', поэтому точного
// ключа 'q||a' в доборе нет и добор промахивается. Второй индекс — по ТЕЛУ ответа
// (turnIdentityParts(...).a): тело — общая часть пары 'q||a' и '||a'.
/**
 * Заполняет пустые userText ходов базы вопросами DOM-добора: точный ключ → тело ответа (A-only).
 * @param {FolwrTurn[]|null|undefined} baseTurns Ходы базы (состав — из сети).
 * @param {FolwrTurn[]|null|undefined} extraTurns Ходы DOM-добора.
 * @returns {FolwrTurn[]} База с заполненными вопросами; ходы не добавляются.
 */
export function fillMissingUserText(baseTurns: FolwrTurn[] | null | undefined,
  extraTurns: FolwrTurn[] | null | undefined): FolwrTurn[] {
  if (!Array.isArray(baseTurns) || baseTurns.length === 0) {
    return Array.isArray(baseTurns) ? baseTurns : [];
  }
  if (!Array.isArray(extraTurns) || extraTurns.length === 0) return baseTurns;
  /** @type {Object<string, string>} */
  var byKey: Record<string, string> = {};
  /** @type {Object<string, boolean>} */
  var ambiguous: Record<string, boolean> = {};
  // BUG-H: второй индекс — каноническое ТЕЛО ответа → вопрос. Пустое тело не индексируется.
  /** @type {Object<string, string>} */
  var byAnswer: Record<string, string> = {};
  /** @type {Object<string, boolean>} */
  var ambiguousAnswer: Record<string, boolean> = {};
  for (var i = 0; i < extraTurns.length; i++) {
    var t = extraTurns[i];
    if (!t || !t.userText) continue;
    var body = turnIdentityParts(t).a;
    if (body) {
      if (Object.prototype.hasOwnProperty.call(byAnswer, body)) {
        if (byAnswer[body] !== t.userText) {
          // Два РАЗНЫХ вопроса на одно тело ответа — пара неоднозначна, не заполняем.
          delete byAnswer[body];
          ambiguousAnswer[body] = true;
        }
      } else if (!ambiguousAnswer[body]) {
        byAnswer[body] = t.userText;
      }
    }
    var key = canonicalTurnKeyOf(t);
    if (key === '||' || ambiguous[key]) continue;
    if (Object.prototype.hasOwnProperty.call(byKey, key)) {
      if (byKey[key] !== t.userText) {
        // Два РАЗНЫХ вопроса на один ключ — пара неоднозначна, ход не заполняется.
        delete byKey[key];
        ambiguous[key] = true;
      }
      continue;
    }
    byKey[key] = t.userText;
  }
  var out: FolwrTurn[] = [];
  var filled = false;
  for (var j = 0; j < baseTurns.length; j++) {
    var turn = baseTurns[j];
    var fill = null;
    if (turn && !turn.userText) {
      var ownKey = canonicalTurnKeyOf(turn);
      if (ownKey !== '||' && Object.prototype.hasOwnProperty.call(byKey, ownKey)) fill = byKey[ownKey];
      // BUG-H: промах по точному ключу → добор по телу ответа (A-only ход, ключ '||a').
      if (!fill) {
        var answerBody = turnIdentityParts(turn).a;
        if (answerBody && Object.prototype.hasOwnProperty.call(byAnswer, answerBody)) {
          fill = byAnswer[answerBody];
        }
      }
    }
    if (!fill) { out.push(turn); continue; }
    out.push({ id: turn.id, userText: fill, assistantText: turn.assistantText });
    filled = true;
  }
  return filled ? out : baseTurns;
}

// O-32 (фикс C): ЧИСТКА ГОТОВОГО СПИСКА ХОДОВ перед записью в кэш треда.
// Кэш — источник базы при возврате в тред по SPA, поэтому дубли обязаны отсекаться ДО
// записи: иначе раздутая база переживает навигацию и бейдж остаётся завышенным.
// Объекты ходов не копируются и не переписываются (id и лишние поля сохраняются);
// префикс-совместимые дубли схлопываются, побеждает более полная форма.
// =====================================================================================
// BUG-E (gsa-late-question): ХВОСТ «РАЗОРВАННОГО» ПОСЛЕДНЕГО ХОДА
// =====================================================================================
// Живой дефект (GSA, SPA-возврат 2026-11-14, тред 8bTpaveuJtWckdUP46iumAo): последний
// обмен приходит двумя ходами — «только assistant» с ЭХОМ вопроса внутри текста
// («Ответ в режиме ИИ, исходный запрос: "Q" A») и «только user» с вопросом, либо
// наоборот. findPrefixCompatibleIndex требует ОБЕ части хода (u и a), поэтому склейки
// нет: вопрос остаётся в хвосте ПОСЛЕ своего ответа (11-52: 35 сообщений, …A A U;
// в базе при этом эхо-ответ лежал дважды — 36 сообщений / textLen 43797).
// Правило узкое и только для ДВУХ последних ходов; текст ответа не переписывается:
//   (1) у одной стороны пуст assistantText, вопрос другой стороны стоит побайтово сразу
//       после wrapperPrefix текста ответа (эхо без тела) → ход {id ответа, вопрос, ответ};
//   (2) оба assistantText строго равны побайтово, userText ровно у одной стороны →
//       её userText + assistantText как есть, id/позиция первого хода.
// Текст ответа не срезается и не пересобирается: байты assistantText, канонические
// ключи и направления слияний (BUG-D) остаются прежними.
/** @type {number} Минимальная длина вопроса (в байтах) для правила хвоста-эха. */
var TAIL_QUESTION_MIN = 12;

/**
 * Эхо-вопрос в тексте ответа: questionText стоит побайтово сразу после wrapperPrefix.
 * @param {string|null|undefined} assistantText Текст ответа (возможно с обёрткой-вопросом).
 * @param {string|null|undefined} questionText Текст вопроса.
 * @returns {boolean} true — ответ является эхом этого вопроса без тела.
 */
function tailEchoQuestion(assistantText: string | null | undefined, questionText: string | null | undefined): boolean {
  var q = String(questionText == null ? '' : questionText);
  if (q.length < TAIL_QUESTION_MIN) return false;
  var echo = String(assistantText == null ? '' : assistantText);
  var prefix = wrapperPrefix(echo);
  if (!prefix) return false;
  var rest = echo.slice(prefix.length).replace(/^["»”'\u00ab\u201c\u2018\s]+/, '');
  return rest.indexOf(q) === 0;
}

/**
 * Склейка хвоста «разорванного» последнего хода (не более 3 итераций).
 * @param {FolwrTurn[]} turns Ходы треда.
 * @returns {FolwrTurn[]} Ходы с одним ходом на последний обмен.
 */
function foldTailTurns(turns: FolwrTurn[]): FolwrTurn[] {
  var out = turns;
  for (var iter = 0; iter < 3; iter++) {
    if (out.length < 2) break;
    var first = out[out.length - 2];
    var second = out[out.length - 1];
    if (!first || !second) break;
    var firstA = (first.assistantText == null) ? '' : String(first.assistantText);
    var secondA = (second.assistantText == null) ? '' : String(second.assistantText);
    var firstU = (first.userText == null) ? '' : String(first.userText);
    var secondU = (second.userText == null) ? '' : String(second.userText);
    // (2) одна и та же эхо-форма ответа у двух ходов; вопрос — ровно у одной стороны.
    if (firstA && secondA && firstA === secondA && ((firstU ? 1 : 0) + (secondU ? 1 : 0) === 1)) {
      out[out.length - 2] = { id: first.id, userText: firstU || secondU, assistantText: firstA };
      out.pop();
      continue;
    }
    // (1) вопрос отдельным ходом + эхо-ответ без тела (или наоборот).
    var folded = null;
    if (!firstA && firstU && secondA && (!secondU || secondU === firstU) && tailEchoQuestion(secondA, firstU)) {
      folded = { id: second.id, userText: firstU, assistantText: secondA };
    } else if (!secondA && secondU && firstA && (!firstU || firstU === secondU) && tailEchoQuestion(firstA, secondU)) {
      folded = { id: first.id, userText: secondU, assistantText: firstA };
    }
    if (!folded) break;
    out[out.length - 2] = folded;
    out.pop();
  }
  return out;
}

/**
 * Дедуп списка ходов: одинаковые и префикс-совместимые ходы схлопываются.
 * @param {FolwrTurn[]|null|undefined} turns Ходы треда.
 * @returns {FolwrTurn[]} Список без дублей (порядок первых вхождений).
 */
export function dedupeTurns(turns: FolwrTurn[]): FolwrTurn[] {
  var list = Array.isArray(turns) ? turns : [];
  /** @type {Object<string, number>} */
  var byKey: Record<string, number> = {};
  var out: FolwrTurn[] = [];
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
      // BUG-N: замена формы НЕ теряет уже известный вопрос. Более «богатая» запись может
      // прийти без userText (DOM-форма с вопросом внутри текста ответа) — тогда переносим
      // вопрос прежней записи, как это делает mergeTurnsByKey. Копию объекта делаем только
      // ради переноса вопроса: иначе сохраняем идентичность заменяющей записи (O-32 C-dedupe).
      var prevUserText = out[at].userText;
      if (!t.userText && prevUserText) {
        out[at] = turnRecord(t, out[at].id);
        out[at].userText = prevUserText;
      } else {
        out[at] = t;
      }
      reindexTurnKey(byKey, out, at);
    }
  }
  // BUG-E: хвост «разорванного» последнего хода склеивается ПОСЛЕ основного дедупа —
  // только на двух последних ходах, текст ответа не переписывается.
  return foldTailTurns(out);
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
  var kind: FolwrContinuationKind;
  var complete: boolean, canContinue: boolean;
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
    // BUG-M: probe разрешён только по курсору истории; folif-mstk курсором не считается.
    isHistoryCursor: isHistoryCursor,
    // BUG-G: A-only ход — вопрос из DOM-пузыря (эхо-валидация) и узкий fill-only добор
    // userText по каноническому ключу; повторной копии алгоритма у адаптера/перехватчика нет.
    resolveUserQuestionForTurn: resolveUserQuestionForTurn,
    fillMissingUserText: fillMissingUserText,
    // BUG-J: порядок ходов по живому DOM — эталон направления для open-пути перехватчика.
    orderTurnsByDom: orderTurnsByDom,
    // O-45: общий рендер код-блоков (```lang … ```) и отбор узлов DOM-пути —
    // переиспользуются адаптером (adapters/google-search-adapter.js) и тестами.
    renderCodeBlock: renderCodeBlock,
    answerTextOf: answerTextOf,
    answerDomNodes: answerDomNodes,
    isCodeBlockElement: isCodeBlockElement,
    // BUG-08/фаза 4: эхо-обёртки GSA снимаются только на проекции файла.
    stripGsaUserEcho: stripGsaUserEcho,
    stripGsaAssistantEcho: stripGsaAssistantEcho
  };
}
