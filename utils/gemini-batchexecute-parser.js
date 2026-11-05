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
  /**
   * Сообщение хода, собранное из turn. Текст лежит в content (сетевой ключ, не text).
   * @typedef {Object} GeminiTurnEntry
   * @property {string} role Роль сообщения: user/assistant.
   * @property {string} content Текст сообщения.
   * @property {string} model Модель хода ('' если не найдена).
   * @property {string} id Идентификатор сообщения (turnId_role).
   * @property {number} ts Время хода в секундах (0 если нет).
   * @property {string|null} r1 id соседа НОВЕЕ (связный список порядка).
   */

  /**
   * Сообщение итоговой истории Gemini; по role/text совместимо с ExportMessage
   * (types/export.d.ts).
   * @typedef {Object} GeminiHistoryMessage
   * @property {string} role Роль: user/assistant.
   * @property {string} text Текст сообщения.
   * @property {string} model Модель хода ('' если не найдена).
   * @property {string} id Идентификатор сообщения.
   * @property {number} ts Время хода в секундах.
   * @property {string|null} r1 id соседа НОВЕЕ.
   */

  /**
   * Результат parseGeminiHistory.
   * @typedef {Object} GeminiHistoryResult
   * @property {GeminiHistoryMessage[]} messages Сообщения в хронологическом порядке.
   * @property {string} model Модель (фолбэк 'Gemini 2.5 Pro').
   * @property {number} tokens Оценка токенов: ceil(символы / 4).
   * @property {string} text Все тексты через перевод строки.
   * @property {number} count Число сообщений.
   */

  /**
   * Нормализованное вложение хода Gemini.
   * @typedef {Object} GeminiFileRef
   * @property {string} name Имя файла.
   * @property {string} mime MIME-тип ('' если нет).
   * @property {number} type Код типа: 1=image, 10=docx, 11=pdf.
   * @property {string} token Токен файла.
   * @property {string} img CDN-ссылка изображения ('' для документов).
   * @property {string} dl Ссылка скачивания ('' если нет).
   * @property {string[]} urls Все строковые ссылки узла.
   * @property {boolean} isImage true — изображение (type=1 или mime image/*).
   * @property {number} [size] Размер в байтах (не задан — ещё неизвестен).
   * @property {number} [pos] Позиция узла в накопительном пуле хода (0…).
   */

  /**
   * Тексты Deep Research, извлечённые из хода.
   * @typedef {Object} GeminiDrTexts
   * @property {string} planText Текст плана ('' если не найден).
   * @property {string} reportText Текст отчёта ('' если не найден).
   */

  /** @type {string} Версия логики парсинга (экспортируется для диагностики). */
  var PARSER_VERSION = 'g3';

  /**
   * Локальный лог-хелпер «вершины» JSON.parse сегментов. Чистый модуль без debugLog —
   * guard-нутый console.log (в try/catch), срабатывает ТОЛЬКО при реальном провале парса.
   * @param {any} e Ошибка парсинга.
   * @param {string} where Метка места вызова.
   * @returns {void}
   */
  function logSegmentParseFail(e, where) {
    try {
      console.log('[AI CM][batchexecute] segment parse fail ' + where + ': ' + (e && e.message || e));
    } catch (e2) { /* проглат сохранён */ }
  }

  // ---- токены вложений ----

  /** @type {RegExp} Токен вложения Gemini ($AXzLiR…). */
  var ATTACH_TOKEN_RE = /\$AXzLiR[A-Za-z0-9+\/=]+/g;
  /**
   * Вырезает токены вложений $AXzLiR… и схлопывает пробельные символы.
   * @param {string} s Текст с токенами вложений.
   * @returns {string} Текст без токенов.
   */
  function stripAttachmentTokens(s) {
    if (typeof s !== 'string') return s;
    return s.replace(ATTACH_TOKEN_RE, ' ').replace(/[ \t\f\v]+/g, ' ');
  }

  /**
   * Единая санация текста Gemini: токены вложений $AXzLiR, системная строка-заглушка
   * "File attachment was not previously registered" и [cite:N].
   * @param {string} s Сырой текст сегмента.
   * @returns {string} Санированный текст.
   */
  function sanitizeGeminiText(s) {
    if (typeof s !== 'string') return s;
    return s
      .replace(/\$AXzLiR[A-Za-z0-9+\/=\s]+/g, ' ')
      .replace(/File attachment was not previously registered/g, '')
      .replace(/\[cite:\s*\d+\]/g, '');
  }

  // ---- фильтры мусора ----
  /** @param {unknown} s Проверяемое значение. @returns {boolean} true — похоже на внутренний id. */
  function isIdLike(s) { return typeof s === 'string' && /^(c_|r_|rc_|fbb[0-9a-f]|[0-9a-f]{16})/.test(s); }
  /** @param {unknown} s Проверяемое значение. @returns {boolean} true — похоже на имя файла. */
  function isFileLike(s) { return typeof s === 'string' && /\.(pdf|png|jpe?g|gif|docx?|txt|webp|csv|xlsx?)(\b|$)/i.test(s); }
  /** @param {unknown} s Проверяемое значение. @returns {boolean} true — похоже на URL. */
  function isUrlLike(s) { return typeof s === 'string' && /^https?:\/\//i.test(s); }
  /** @param {unknown} s Проверяемое значение. @returns {boolean} true — похоже на токен ($?AVuib…). */
  function isTokenLike(s) { return typeof s === 'string' && /^\$?AVuib/.test(s); }
  /** @param {unknown} s Проверяемое значение. @returns {boolean} true — похоже на MIME-тип. */
  function isMimeLike(s) { return typeof s === 'string' && /^(image|application|video|audio)\//i.test(s); }
  /** @type {Record<string, number>} UI-строки и служебные значения, не являющиеся контентом. */
  var UI_BLACKLIST = {
    'DE': 1, 'ru': 1, 'mk': 1, 'generic': 1, 'personal_context': 1, 'google': 1,
    'Ищу в интернете': 1, 'Персональный контекст': 1, 'Google Search': 1, 'true': 1, 'false': 1
  };
  /**
   * Мусорный сегмент: пустой, UI-строка или id/файл/URL/токен/MIME.
   * @param {unknown} s Проверяемый сегмент.
   * @returns {boolean} true — сегмент не является контентом.
   */
  function isJunk(s) {
    if (typeof s !== 'string') return true;
    var t = s.trim();
    if (t.length === 0) return true;
    if (UI_BLACKLIST[t]) return true;
    return isIdLike(t) || isFileLike(t) || isUrlLike(t) || isTokenLike(t) || isMimeLike(t);
  }

  /**
   * Мусор именно для поля вопроса пользователя (turn[2][0][0]). В отличие от
   * collectTurnText (свалка сегментов), здесь НЕ применяем isFileLike: валидный
   * пользовательский промпт может содержать имена файлов (.pdf/.docx/.txt) —
   * терять из-за этого весь вопрос-инструкцию нельзя (терялся user-блок r_f6c).
   * @param {unknown} s Кандидат в вопрос.
   * @returns {boolean} true — кандидат непригоден как вопрос.
   */
  function isUserQuestionJunk(s) {
    if (typeof s !== 'string') return true;
    var t = s.trim();
    if (!t) return true;
    if (UI_BLACKLIST[t]) return true;
    return isIdLike(t) || isUrlLike(t) || isTokenLike(t) || isMimeLike(t);
  }

  // ---- детекция мышления ----
  // (a) markdown-заголовок мышления: строка начинается с "**Title**".
  /** @type {RegExp} markdown-заголовок мышления: строка начинается с "**Title**". */
  var THINKING_TITLE_RE = /^\s*\*\*[^*\n]{1,120}\*\*/;
  // Страховочные first-person вводные мышления Gemini (голое тело без **Title**).
  /** @type {RegExp} Страховочные first-person вводные мышления Gemini (голое тело без **Title**). */
  var THINKING_BODY_RE = /^(I'm now|I've been|I am going|I'm currently|I'm focusing|I'm working|I will now|I've fleshed|I've got|I need to|I'm going to|I've shifted|My focus is|I've settled|I've outlined|I've started|I'm aiming|My approach is|I'm leaning|I'm choosing|I'm prioritizing)\b/i;
  // Дополнительные стартовые тела мышления (голые first-person вводные без **Title**).
  /** @type {RegExp} Дополнительные стартовые тела мышления (голые first-person вводные). */
  var THINKING_BODY_EXTRA_RE = /^(I'm (?:currently|now|also|still) (?:focused|zeroing|analyzing|integrating|identifying|assessing|refining|evaluating|structuring|addressing|considering|formulating|prioritizing|parsing)|I've (?:been|now) (?:analyzing|noted|shifted|outlined|fleshed)|My (?:focus|goal) is|Specifically, I've)\b/i;
  // Герундийные титулы мышления, приходящие «голыми», без **Title**:
  // "Assessing the Core Task", "Defining the Scope", "Outlining the Procedure" и т.п.
  /** @type {RegExp} Герундийные титулы мышления, приходящие «голыми», без **Title**. */
  var THINKING_GERUND_RE = /^(Assessing|Defining|Refining|Outlining|Constructing|Uncovering|Tracing|Confirming|Reassuring|Clarifying|Deepening|Integrating|Evaluating|Formulating|Focusing|Prioritizing|Solidifying|Exploring|Analyzing|Reviewing|Validating|Synthesizing|Considering|Identifying|Structuring|Addressing|Reconstructing)\b/;
  // Системная строка вложения-заглушки — не должна попадать в историю.
  /** @type {RegExp} Системная строка вложения-заглушки — не должна попадать в историю. */
  var FILE_ATTACHMENT_RE = /File attachment was not previously registered/;

  /**
   * Есть ли в строке кириллица (U+0400..U+04FF).
   * @param {string} s Проверяемая строка.
   * @returns {boolean} true — кириллица найдена.
   */
  function hasCyrillic(s) {
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0x0400 && c <= 0x04FF) return true;
    }
    return false;
  }

  /**
   * Единый предикат «начала мышления»: **Title**, first-person вводная или герундий.
   * Кириллица всегда считается ответом (никогда мышлением).
   * @param {unknown} s Проверяемый сегмент.
   * @returns {boolean} true — сегмент открывает блок мышления.
   */
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

  /**
   * Предикат «ответного» сегмента (выход из режима скипа мышления):
   * сегмент считается ответом только если содержит кириллицу, markdown-таблицу
   * или code fence. Чисто английские тела мышления ответом НЕ являются.
   * @param {unknown} s Проверяемый сегмент.
   * @returns {boolean} true — сегмент завершает блок мышления.
   */
  function isResponseSegment(s) {
    if (typeof s !== 'string') return false;
    var t = s.trim();
    if (!t) return false;
    if (hasCyrillic(t)) return true;
    if (/```/.test(t)) return true; // code fence
    if (/^\s*\|.+\|\s*$/m.test(t)) return true; // markdown-таблица
    return false;
  }

  /**
   * Блок мышления: массив, чей ПЕРВЫЙ элемент является маркером мышления —
   * либо строкой-началом мышления, либо вложенным массивом, у которого
   * глубже лежит такая строка. Проверяем только голову (не рекурсивно по всему
   * поддереву), чтобы не зацепить таблицу-соседку в одном родителе с мышлением.
   * @param {any} node Проверяемый узел.
   * @param {number} depth Текущая глубина рекурсии (защита от переполнения).
   * @returns {boolean} true — голова узла является маркером мышления.
   */
  function headIsThinking(node, depth) {
    if (typeof node === 'string') return isThinkingStart(node);
    if (Array.isArray(node)) {
      if (depth > 4) return false;
      return headIsThinking(node[0], depth + 1);
    }
    return false;
  }
  /**
   * Массив-блок мышления (голова — маркер мышления).
   * @param {any} node Проверяемый узел.
   * @returns {boolean} true — узел является блоком мышления.
   */
  function isThoughtBlock(node) {
    if (!Array.isArray(node)) return false;
    return headIsThinking(node[0], 0);
  }

  /**
   * Stateful-сбор текста ответа: run-skip мышления. После срабатывания маркера мышления
   * пропускаем последующие сегменты, пока не встретится «ответный» (кириллица/таблица/code
   * fence). Это ловит голые продолжения мышления ("I'm now zeroing in…", "Assessing the
   * Core Task"), приходящие отдельными строками без **Title**.
   * @param {any} node Узел дерева ответа (строка или массив).
   * @param {string[]} out Накопитель текстовых сегментов.
   * @param {{inThinking: boolean}} [state] Состояние прохода (создаётся при отсутствии).
   * @returns {void}
   */
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

  /**
   * Вопрос пользователя хода: turn[2][0][0] после санации и фильтра мусора.
   * @param {any} turn Ход batchexecute.
   * @returns {string} Текст вопроса или '' (нет/мусор/похоже на мышление).
   */
  function extractUserQuestion(turn) {
    var q = '';
    try { q = turn[2][0][0]; } catch (e) { q = ''; }
    if (typeof q === 'string') {
      var s = sanitizeGeminiText(q).trim();
      if (s && !isUserQuestionJunk(s) && !isThinkingStart(s)) return s;
    }
    return '';
  }

  // ---- модель/id/ts ----
  /** @type {RegExp} Имя модели Gemini в строке хода. */
  var MODEL_NAME_RE = /^\s*(?:Gemini\s*[\d.]?|\d+(?:\.\d+)?\s+(?:Flash|Pro|Ultra|Gemini))/i;
  /**
   * Имя модели хода (первая короткая строка, похожая на "Gemini 2.5 Pro").
   * @param {any} node Узел хода.
   * @returns {string} Имя модели или ''.
   */
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
  /**
   * Идентификатор хода (первая строка вида r_<hex>).
   * @param {any} node Узел хода.
   * @returns {string|null} id хода или null.
   */
  function extractTurnId(node) {
    var found = null;
    (function walk(n) {
      if (found) return;
      if (typeof n === 'string' && /^r_[0-9a-f]+$/.test(n)) { found = n; return; }
      else if (Array.isArray(n)) { for (var i = 0; i < n.length; i++) { walk(n[i]); if (found) return; } }
    })(node);
    return found;
  }
  /**
   * r1 = id соседа НОВЕЕ (подтверждено логами idmap: t[1][1]).
   * @param {any} t Ход batchexecute.
   * @returns {string|null} id более нового хода или null.
   */
  function extractTurnR1(t) {
    try {
      if (Array.isArray(t) && Array.isArray(t[1]) && typeof t[1][1] === 'string') return t[1][1];
    } catch (e) { }
    return null;
  }
  /**
   * Время хода (t[4][0]) в секундах.
   * @param {any} t Ход batchexecute.
   * @returns {number} Секунды эпохи или 0 (нет/некорректно).
   */
  function extractTurnTs(t) {
    try {
      if (Array.isArray(t) && Array.isArray(t[4]) && typeof t[4][0] === 'number' && t[4][0] > 1000000000) return t[4][0];
    } catch (e) { }
    return 0;
  }

  // ---- вложения хода: turn[2][0][4][0][4] ----
  // Форма узла (см. plan-gemini-attachments.md): [null, type, name, imgCdn, null,
  // token, null, [thumb, download, upload], 1, [sec, nanos], null, mime, ...].
  // type: 1=image, 10=docx, 11=pdf; у документов imgCdn=null, у изображений urls=null.
  /**
   * Нормализованный ref вложения либо null. Функция не бросает.
   * @param {any} n Узел вложения из turn[2][0][4][0][4].
   * @returns {GeminiFileRef|null} ref вложения или null (не массив / нет имени).
   */
  function fileRefFromNode(n) {
    try {
      if (!Array.isArray(n)) return null;
      var name = (typeof n[2] === 'string') ? n[2].trim() : '';
      if (!name) return null;
      var mime = (typeof n[11] === 'string') ? n[11] : '';
      var type = (typeof n[1] === 'number') ? n[1] : 0;
      var token = (typeof n[5] === 'string') ? n[5] : '';
      var img = (typeof n[3] === 'string') ? n[3] : '';
      // Размер (Фикс B): у изображений хвост узла — [width, height, bytes].
      // У документов размера в узле нет (PDF узнаётся Range-пробой) → 0.
      var tail = n ? n[15] : null;
      var size = (Array.isArray(tail) && typeof tail[2] === 'number' && isFinite(tail[2]) && tail[2] > 0) ? tail[2] : 0;
      var dl = '';
      var urls = [];
      (function walk(v) {
        if (typeof v === 'string') {
          if (v) urls.push(v);
          if (!dl && v.indexOf('contribution.usercontent.google.com/download') !== -1) dl = v;
        } else if (Array.isArray(v)) {
          for (var i = 0; i < v.length; i++) walk(v[i]);
        }
      })(n[7]);
      return {
        name: name,
        mime: mime,
        type: type,
        token: token,
        size: size,
        img: img,
        dl: dl,
        urls: urls,
        isImage: (type === 1) || /^image\//i.test(mime)
      };
    } catch (e) { return null; }
  }

  /**
   * Вложения хода.
   *
   * v2.6 (позиционная дельта): каждому ref проставляется `pos` — индекс узла в
   * кумулятивном списке разговора. Список Gemini только дописывает в ХВОСТ
   * (проверено на 60 переходах реального чата: пул старого хода всегда префикс
   * пула нового), поэтому позиция — устойчивая идентичность загрузки: переподпись
   * URL/токена её не меняет, а повторная загрузка с тем же именем занимает новую
   * позицию и не схлопывается с прежней.
   * @param {any} turn Ход batchexecute.
   * @returns {GeminiFileRef[]} Нормализованные вложения (пусто, если их нет).
   */
  function collectTurnFiles(turn) {
    var out = [];
    try {
      var arr = turn[2][0][4][0][4];
      if (!Array.isArray(arr)) return out;
      for (var i = 0; i < arr.length; i++) {
        var ref = fileRefFromNode(arr[i]);
        if (ref) {
          ref.pos = i;
          out.push(ref);
        }
      }
    } catch (e) { }
    return out;
  }

  /**
   * Запись пула хода: снимок накопительного списка.
   * @typedef {Object} GeminiFilePoolTurn
   * @property {string} turnId Id хода.
   * @property {number} ts Время хода (0 = неизвестно).
   * @property {number} order Хронологический индекс (-1 = неизвестно).
   * @property {number} seq Порядок регистрации в реестре.
   * @property {GeminiFileRef[]} [refs] Полный пул хода (нет до регистрации).
   */

  /**
   * Реестр пулов вложений по разговору:
   * convId → { turns: { [turnId]: GeminiFilePoolTurn }, seq }.
   *
   * Gemini повторяет НАКОПИТЕЛЬНЫЙ список `turn[2][0][4][0][4]` в нескольких
   * ходах, поэтому сам пул не говорит, что загружено именно в этом ходе.
   * Собственные файлы хода — ХВОСТ пула после общего префикса с пулом
   * предшествующего хода:
   *   k = длина общего префикса по именам записей;
   *   own(k) = pool(k)[k..]  (пул только растёт в хвост).
   * Позиционное сравнение не зависит от переподписываемых URL и токенов, поэтому
   * одна и та же загрузка, вернувшаяся в другом ответе с новым токеном, не
   * превращается в дубль, а две загрузки с одинаковым именем сидят на разных
   * позициях и остаются разными файлами.
   * @type {Record<string, {turns: Record<string, GeminiFilePoolTurn>, seq: number}>}
   */
  var filePoolsByConv = {};

  /**
   * Нормализует timestamp хода: нечисло/0/отрицательное → 0 (неизвестно).
   * @param {unknown} ts Время хода.
   * @returns {number} Секунды эпохи или 0.
   */
  function fileOwnerTs(ts) {
    return (typeof ts === 'number' && isFinite(ts) && ts > 0) ? ts : 0;
  }

  /**
   * Нормализует хронологический индекс: 0 — самый старый в кадре, -1 — нет.
   * @param {unknown} order Индекс хода.
   * @returns {number} Неотрицательный индекс или -1.
   */
  function fileOwnerOrder(order) {
    return (typeof order === 'number' && isFinite(order) && order >= 0) ? order : -1;
  }

  /**
   * Пул ходов разговора; при `create` заводится пустой.
   * @param {unknown} convId Id разговора.
   * @param {boolean=} create Создать запись, если её нет.
   * @returns {{turns: Record<string, GeminiFilePoolTurn>, seq: number}|null} Пул.
   */
  function filePoolForConv(convId, create) {
    var cid = (typeof convId === 'string') ? convId : '';
    var pool = filePoolsByConv[cid];
    if (!pool && create) {
      pool = { turns: {}, seq: 0 };
      filePoolsByConv[cid] = pool;
    }
    return pool || null;
  }

  /**
   * Имя записи пула — единственный устойчивый признак порядка: Gemini
   * переподписывает dl/img/urls и токен, но имя и место в списке не меняет.
   * @param {GeminiFileRef} ref Нормализованный ref вложения.
   * @returns {string} Имя записи.
   */
  function fileRefPoolName(ref) {
    return (ref && typeof ref.name === 'string') ? ref.name : '';
  }

  /**
   * Длина общего префикса двух пулов по именам записей.
   * @param {GeminiFileRef[]} a Первый пул.
   * @param {GeminiFileRef[]} b Второй пул.
   * @returns {number} Число совпавших с начала записей.
   */
  function poolSharedPrefixLen(a, b) {
    var n = Math.min(a.length, b.length);
    var k = 0;
    while (k < n && fileRefPoolName(a[k]) === fileRefPoolName(b[k])) k++;
    return k;
  }

  /**
   * Хронологический порядок ходов: сначала известный ts, затем turnId
   * (детерминированный тай-брейк равных ts), затем индекс кадра, затем
   * порядок регистрации (предварительный проход ingest идёт старые→новые).
   * @param {GeminiFilePoolTurn} a Первый ход.
   * @param {GeminiFilePoolTurn} b Второй ход.
   * @returns {boolean} true, если `a` хронологически раньше `b`.
   */
  function isTurnBefore(a, b) {
    var aTs = fileOwnerTs(a.ts);
    var bTs = fileOwnerTs(b.ts);
    if (aTs > 0 && bTs > 0 && aTs !== bTs) return aTs < bTs;
    if (aTs > 0 && bTs === 0) return true;
    if (aTs === 0 && bTs > 0) return false;
    // Равные ts: сначала вложенность пулов — более короткий префиксный пул
    // хронологически раньше (пул растёт только в хвост), затем turnId (он
    // одинаков на любой странице), затем индекс кадра и порядок регистрации.
    var aRefs = Array.isArray(a.refs) ? a.refs : null;
    var bRefs = Array.isArray(b.refs) ? b.refs : null;
    if (aRefs && bRefs && aRefs.length !== bRefs.length) {
      var nest = poolSharedPrefixLen(aRefs, bRefs);
      if (nest === Math.min(aRefs.length, bRefs.length)) return aRefs.length < bRefs.length;
    }
    var aTid = (typeof a.turnId === 'string') ? a.turnId : '';
    var bTid = (typeof b.turnId === 'string') ? b.turnId : '';
    if (aTid && bTid && aTid !== bTid) return aTid < bTid;
    var aOrd = fileOwnerOrder(a.order);
    var bOrd = fileOwnerOrder(b.order);
    if (aOrd >= 0 && bOrd >= 0 && aOrd !== bOrd) return aOrd < bOrd;
    return a.seq < b.seq;
  }

  /**
   * Идентичность файла без скоупа разговора: имя + размер.
   *
   * Фикс B1 (Xray/дедупликация): URL в ключ НЕ входит. `dl` переподписывается
   * на каждый ответ batchexecute, поэтому одинаковый файл получал новый ключ и
   * эмитился повторно — текст вложения размножался. `img`/`urls[0]` тоже не
   * годится в опору: drive-thumb переподписывается, а lh3-ссылка у документа
   * одна и та же для всех копий. Имя и размер стабильны между ответами.
   * @param {GeminiFileRef} ref Нормализованный ref вложения.
   * @returns {string} Ключ идентичности.
   */
  function fileRefIdentityKey(ref) {
    var name = (ref && typeof ref.name === 'string') ? ref.name : '';
    var size = (ref && typeof ref.size === 'number' && isFinite(ref.size)) ? ref.size : 0;
    return name + '|' + size;
  }

  /**
   * Ключ файла в мультимножестве пула: разговор + имя + размер.
   * Токен и URL в ключ НЕ входят (v2.5, Фикс D1/B1): они переподписываются в
   * каждом ответе, из-за чего одинаковые файлы с разных страниц не схлопывались.
   * @param {unknown} convId Id разговора.
   * @param {GeminiFileRef} ref Нормализованный ref вложения.
   * @returns {string} Ключ мультимножества.
   */
  function fileOwnerKey(convId, ref) {
    var cid = (typeof convId === 'string') ? convId : '';
    return cid + '|' + fileRefIdentityKey(ref);
  }

  /**
   * Регистрирует пул хода, не отдавая файлы.
   * Нужен для предварительного прохода ingest: дельта считается по пулам всех
   * ходов, поэтому пул должен быть известен ДО эмиссии. Ходы с пустым пулом
   * (assistant) не регистрируются — иначе они разрывали бы дельту.
   * Повторный разбор того же хода идемпотентно обновляет снимок пула.
   * @param {any} turn Ход batchexecute.
   * @param {string} convId Id разговора (скоуп реестра).
   * @param {string} turnId Id хода.
   * @param {number=} ts Время хода (секунды эпохи).
   * @param {number=} order Хронологический индекс (0 = самый старый).
   * @returns {number} Сколько файлов в пуле хода.
   */
  function registerTurnFileOwner(turn, convId, turnId, ts, order) {
    var own = (typeof turnId === 'string') ? turnId : '';
    if (!own) return 0;
    var all = collectTurnFiles(turn);
    var pool = filePoolForConv(convId, true);
    if (!all.length) {
      if (pool && pool.turns[own]) delete pool.turns[own];
      return 0;
    }
    var nTs = fileOwnerTs(ts);
    var nOrd = fileOwnerOrder(order);
    var prev = pool.turns[own];
    if (prev) {
      // Повторный разбор того же хода: обновляем снимок, не плодя записи.
      prev.refs = all;
      if (nTs > 0) prev.ts = nTs;
      if (nOrd >= 0) prev.order = nOrd;
      return all.length;
    }
    pool.seq++;
    pool.turns[own] = { turnId: own, ts: nTs, order: nOrd, seq: pool.seq, refs: all };
    return all.length;
  }

  /**
   * Предшественник хода: ближайший хронологически, а если такого нет — самый
   * глубокий зарегистрированный ПРЕФИКС текущего пула. Второе правило работает
   * без дат: у накопительного списка старый пул всегда префикс нового, поэтому
   * ближайший по глубине префикс и есть предыдущее состояние разговора.
   * @param {{turns: Record<string, GeminiFilePoolTurn>, seq: number}} pool Реестр.
   * @param {GeminiFilePoolTurn} rec Текущий ход.
   * @param {GeminiFileRef[]} all Текущий пул.
   * @returns {GeminiFilePoolTurn|null} Предшественник или null.
   */
  function previousPoolTurn(pool, rec, all) {
    var ids = Object.keys(pool.turns);
    var chrono = null;
    var i;
    for (i = 0; i < ids.length; i++) {
      if (ids[i] === rec.turnId) continue;
      var cand = pool.turns[ids[i]];
      if (!cand || !Array.isArray(cand.refs)) continue;
      if (!isTurnBefore(cand, rec)) continue;
      if (!chrono || isTurnBefore(chrono, cand)) chrono = cand;
    }
    var donor = null;
    for (i = 0; i < ids.length; i++) {
      if (ids[i] === rec.turnId) continue;
      var reg = pool.turns[ids[i]];
      if (!reg || !Array.isArray(reg.refs)) continue;
      var len = reg.refs.length;
      // Строгий префикс: пул-«донор» короче текущего и совпадает с началом.
      if (!len || len >= all.length) continue;
      if (poolSharedPrefixLen(reg.refs, all) !== len) continue;
      if (!donor || len > donor.refs.length) donor = reg;
    }
    if (donor && (!chrono || donor.refs.length > chrono.refs.length)) return donor;
    return chrono;
  }

  /**
   * Дельта пула: записи, которых не было у предшественника.
   *
   * Основной путь — позиционный: пул растёт только в хвост, поэтому дельта это
   * `all[k..]`, где k — общий префикс. Сравнение по именам, а не по токенам:
   * переподпись URL не меняет ни порядок, ни имена.
   * Резерв (пулы не вложены — в ходе другой набор файлов): вычитание
   * мультимножества по имени+размеру, как раньше.
   * @param {GeminiFileRef[]} prevRefs Пул предшественника.
   * @param {GeminiFileRef[]} all Текущий пул.
   * @returns {GeminiFileRef[]} Собственные файлы хода в порядке пула.
   */
  function poolDelta(prevRefs, all) {
    var k = poolSharedPrefixLen(prevRefs, all);
    if (k === prevRefs.length || k === all.length) return all.slice(k);
    var spent = {};
    var i;
    for (i = 0; i < prevRefs.length; i++) {
      var pk = fileRefIdentityKey(prevRefs[i]);
      spent[pk] = (spent[pk] || 0) + 1;
    }
    var out = [];
    for (i = 0; i < all.length; i++) {
      var ck = fileRefIdentityKey(all[i]);
      if (spent[ck] > 0) { spent[ck]--; continue; }
      out.push(all[i]);
    }
    return out;
  }

  /**
   * Вложения, загруженные ИМЕННО в этом ходе: хвост кумулятивного пула после
   * общего префикса с пулом предшествующего хода. Порядок записей сохраняется.
   * Без `ownerId` поведение прежнее (весь список) — обратная совместимость.
   * @param {any} turn Ход batchexecute.
   * @param {string} convId Id разговора.
   * @param {string} ownerId Id хода (turnId).
   * @param {number=} ts Время хода (секунды эпохи).
   * @param {number=} order Хронологический индекс (0 = самый старый).
   * @returns {GeminiFileRef[]} Файлы, загруженные в этом ходе.
   */
  function collectTurnFilesForOwner(turn, convId, ownerId, ts, order) {
    var all = collectTurnFiles(turn);
    var own = (typeof ownerId === 'string') ? ownerId : '';
    if (!own) return all;
    if (!all.length) return [];
    var pool = filePoolForConv(convId, true);
    var rec = pool.turns[own];
    if (!rec) {
      // Ход ещё не проходил предварительную регистрацию — регистрируем на месте.
      pool.seq++;
      rec = { turnId: own, ts: fileOwnerTs(ts), order: fileOwnerOrder(order), seq: pool.seq, refs: all };
      pool.turns[own] = rec;
    }
    rec.refs = all;
    if (fileOwnerTs(ts) > 0) rec.ts = fileOwnerTs(ts);
    if (fileOwnerOrder(order) >= 0) rec.order = fileOwnerOrder(order);
    var prev = previousPoolTurn(pool, rec, all);
    if (!prev) return all;
    return poolDelta(prev.refs, all);
  }

  /**
   * Сброс реестра пулов (SPA-переход/смена разговора).
   * @param {string=} convId Разговор; без него чистится весь реестр.
   * @returns {void}
   */
  function __resetFileOwners(convId) {
    if (convId === undefined || convId === null || convId === '') {
      filePoolsByConv = {};
      return;
    }
    delete filePoolsByConv[(typeof convId === 'string') ? convId : String(convId)];
  }

  // Чисто английский блок-мышление assistant (без кириллицы, начинающийся с герундия /
  // first-person вводной / префиксов "sr "/"Ev "). Смешанные блоки (с кириллицей) не трогаем.
  /** @type {RegExp} Чисто английский блок-мышление assistant (герундий/first-person/"sr "/"Ev "). */
  var THINKING_ASSISTANT_RE = /^([A-Z][a-z]+ing\b|I'm\b|I've\b|My (?:focus|goal)\b|sr |Ev )/;
  // Ведущий thinking-фрагмент (с необязательными ведущими * / **) — для среза в смешанных блоках.
  /** @type {RegExp} Ведущий thinking-фрагмент (с необязательными ведущими * / **). */
  var LEADING_THINKING_RE = /^\s*\*?\*?([A-Z][a-z]+ing\b|I'm|I've|My (focus|goal)|sr |Ev )/;

  /**
   * Чисто английский блок-мышление assistant: без кириллицы, начинается с герундия,
   * first-person вводной или префиксов "sr "/"Ev ".
   * @param {unknown} s Проверяемый текст ответа.
   * @returns {boolean} true — блок целиком является мышлением.
   */
  function isThinkingAssistant(s) {
    if (typeof s !== 'string') return false;
    var t = s.trim();
    if (!t) return false;
    if (hasCyrillic(t)) return false;
    return THINKING_ASSISTANT_RE.test(t);
  }

  /**
   * Индекс первого кириллического символа.
   * @param {string} s Проверяемая строка.
   * @returns {number} Индекс символа или -1.
   */
  function firstCyrillicIndex(s) {
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0x0400 && c <= 0x04FF) return i;
    }
    return -1;
  }

  /**
   * Срез ведущего thinking-фрагмента (до первого кириллического символа).
   * Чисто английский блок обрабатывается isThinkingAssistant отдельно.
   * @param {string} s Текст ответа.
   * @returns {string} Текст без ведущего мышления ('' — мышление целиком).
   */
  function stripLeadingThinking(s) {
    if (typeof s !== 'string') return s;
    var t = s.trim();
    if (!LEADING_THINKING_RE.test(t)) return s;
    var idx = firstCyrillicIndex(t);
    if (idx < 0) return ''; // нет кириллицы — мышление целиком
    return t.slice(idx);
  }

  /**
   * Маркеры markdown-разметки для выбора канонического сегмента ответа.
   * В одном ходе batchexecute лежат ТРИ копии ответа: канонический markdown-ответ
   * (turn[3][0][0][1][0]), англ. thinking-саммари (turn[3][0][0][37]) и plain-копия
   * без markdown (turn[3][12][0][0]). Канон — сегмент с markdown-разметкой.
   * @param {unknown} t Проверяемый текст сегмента.
   * @returns {boolean} true — в сегменте есть markdown-разметка.
   */
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

  /**
   * Канонический сегмент ответа: первый сегмент с markdown-разметкой;
   * при отсутствии разметки — первый сегмент-ответ (фолбэк).
   * @param {string[]} parts Санированные сегменты ответа.
   * @returns {string} Канонический текст ('' для пустого списка).
   */
  function pickCanonicalAnswer(parts) {
    if (!parts || !parts.length) return '';
    for (var i = 0; i < parts.length; i++) {
      if (hasMarkdownMarkup(parts[i])) return parts[i];
    }
    return parts[0];
  }

  /**
   * Извлечение канонического ответа хода. В batchexecute ход несёт ТРИ копии ответа:
   *   - markdown-ответ: turn[3][0][0][1][0] (канон, с разметкой);
   *   - англ. thinking-саммари: turn[3][0][0][37];
   *   - plain-копия без разметки: turn[3][12][0][0].
   * Берём сегменты из контейнера turn[3][0][0][1] (не через collectTurnText, т.к. его
   * isFileLike отбрасывает markdown-ответ, содержащий ".docx" в списке файлов) и выбираем
   * первый markdown-сегмент. Фолбэк — прежний run-skip сбор collectTurnText (страховка).
   * v1.5.2: канонический ответ не трогаем thinking-эвристиками.
   * @param {any} turn Ход batchexecute.
   * @returns {{text: string, isFallback: boolean}} Текст ответа и признак fallback-пути
   *   (isFallback=true — текст добыт через collectTurnText).
   */
  function extractCanonicalAnswer(turn) {
    var cands = [];
    var isFallback = false;
    try {
      var box = (Array.isArray(turn[3]) && Array.isArray(turn[3][0]) && Array.isArray(turn[3][0][0])) ? turn[3][0][0][1] : null;
      if (Array.isArray(box)) {
        for (var i = 0; i < box.length; i++) cands.push(box[i]);
      } else if (typeof box === 'string') {
        cands.push(box);
      }
    } catch (e) { }
    if (!cands.length) {
      isFallback = true;
      try { collectTurnText(turn[3], cands); } catch (e) { swallowSoft(e, 'gemini-utils:extractCanonicalAnswer-fallback'); }
    }
    var cleaned = [];
    for (i = 0; i < cands.length; i++) {
      if (typeof cands[i] !== 'string') continue;
      var s = sanitizeGeminiText(cands[i]).trim();
      if (s) cleaned.push(s);
    }
    return { text: pickCanonicalAnswer(cleaned), isFallback: isFallback };
  }

  // ---- v1.6 (D13): Deep Research — итоговый отчёт и план, stateless-инъекция ----
  // DR-отчёт лежит внутри хода отдельным контейнером ([3][0][0][N][0][4]) и НЕ является
  // каноническим ответом (box = [3][0][0][1]); план — контейнер [3][0][0][N][0][55] рядом
  // с ссылкой deep_research_confirmation_content. В canonical-тексте assistant стоят ГОЛЫЕ
  // ссылки-заглушки:
  //   http://googleusercontent.com/immersive_entry_chip/0   (отчёт)
  //   http://googleusercontent.com/deep_research_confirmation_content/0 (план)
  // Инъекция stateless: при КАЖДОМ парсе (handleOuter) вычисляем {planText,reportText}
  // детерминированно из realTurns и в buildTurnMessages заменяем ссылку на текст.
  /** @type {number} Минимальная длина строки-отчёта Deep Research. */
  var DR_REPORT_MIN_LEN = 1000;
  /** @type {number} Минимальная длина строки-плана Deep Research. */
  var DR_PLAN_MIN_LEN = 60;

  /**
   * Сбор длинных строковых кандидатов DR (глубже minLen символов).
   * @param {any} node Узел дерева хода.
   * @param {string[]} out Накопитель строк.
   * @param {number} minLen Минимальная длина строки.
   * @param {number} depth Текущая глубина рекурсии.
   * @returns {void}
   */
  function collectDrStrings(node, out, minLen, depth) {
    try {
      if (typeof node === 'string') {
        if (node.length >= minLen) out.push(node);
        return;
      }
      if (Array.isArray(node) && depth < 40) {
        for (var i = 0; i < node.length; i++) collectDrStrings(node[i], out, minLen, depth + 1);
      }
    } catch (e) { swallowSoft(e, 'gemini-utils:collectDrStrings'); }
  }
  /**
   * Санированный текст строки (trim).
   * @param {string} s Сырая строка.
   * @returns {string} Санированный текст.
   */
  function ctText(s) { return sanitizeGeminiText(s).trim(); }

  /**
   * Извлечение текстов Deep Research из ходов.
   * report: самая длинная контентная строка (>=1000), не URL/junk.
   * plan: самая длинная контентная строка в промежутке [60, report.length), не URL/junk.
   * @param {any[]} realTurns Ходы разговора.
   * @returns {GeminiDrTexts} Тексты плана и отчёта ('' если не найдены).
   */
  function extractDrTexts(realTurns) {
    var res = { planText: '', reportText: '' };
    try {
      if (!Array.isArray(realTurns)) return res;
      var cands = [];
      for (var i = 0; i < realTurns.length; i++) collectDrStrings(realTurns[i], cands, DR_REPORT_MIN_LEN, 0);
      var best = '';
      for (var j = 0; j < cands.length; j++) {
        var s = cands[j];
        if (isUrlLike(s) || isJunk(s)) continue;
        if (!best || s.length > best.length) best = s;
      }
      if (best) res.reportText = ctText(best);
      // план: строки 60..report.length-1 (прочувствуем не-report)
      var pc = [];
      for (var k = 0; k < realTurns.length; k++) collectDrStrings(realTurns[k], pc, DR_PLAN_MIN_LEN, 0);
      var pbest = '';
      for (var q = 0; q < pc.length; q++) {
        var ps = pc[q];
        if (isUrlLike(ps) || isJunk(ps)) continue;
        if (res.reportText && ps === res.reportText) continue;
        if (ps.indexOf('deep_research_confirmation_content') !== -1) continue;
        if (ps.indexOf('immersive_entry_chip') !== -1) continue;
        if (res.reportText && ps.length >= res.reportText.length) continue;
        if (!pbest || ps.length > pbest.length) pbest = ps;
      }
      if (pbest) res.planText = ctText(pbest);
    } catch (e) { swallowSoft(e, 'gemini-utils:extractDrTexts'); }
    return res;
  }

  /** @type {GeminiDrTexts} State последнего handleOuter (для splitTurnMessages). */
  var lastDrTexts = { planText: '', reportText: '' };

  /**
   * Установка DR-текстов текущего парса (перед buildTurnMessages).
   * @param {GeminiDrTexts|null|undefined} d Тексты Deep Research.
   * @returns {void}
   */
  function __setDrTexts(d) { try { lastDrTexts = d || { planText: '', reportText: '' }; } catch (e) { } }

  /**
   * Замена голой ссылки-заглушки на контент DR в тексте assistant.
   * @param {string} text Текст ответа.
   * @param {GeminiDrTexts|null|undefined} dr Тексты Deep Research.
   * @returns {string} Текст с подставленными отчётом/планом.
   */
  function injectDrLinks(text, dr) {
    try {
      if (typeof text !== 'string') return text;
      var t = text;
      if (dr && dr.reportText && t.indexOf('immersive_entry_chip/0') !== -1) {
        t = t.replace(/https?:\/\/googleusercontent\.com\/immersive_entry_chip\/0/gi, dr.reportText);
      }
      if (dr && dr.planText && t.indexOf('deep_research_confirmation_content/0') !== -1) {
        t = t.replace(/https?:\/\/googleusercontent\.com\/deep_research_confirmation_content\/0/gi, dr.planText);
      }
      return t;
    } catch (e) { return text; }
  }

  // ---- turn → до двух сообщений ----

  /**
   * Ход → до двух сообщений: {role:'user'} (вопрос) и {role:'assistant'} (ответ).
   * thinking-эвристики применяются только к fallback-пути (canon.isFallback).
   * @param {any} turn Ход batchexecute.
   * @returns {Array<{role: string, text: string}>} Сообщения хода (user/assistant).
   */
  function buildTurnMessages(turn) {
    var question = extractUserQuestion(turn);
    // Канон: только markdown-сегмент ответа; thinking-саммари и plain-копию не конкатенируем.
    var canon = extractCanonicalAnswer(turn);
    var answer = canon.text.replace(/\n{3,}/g, '\n\n').trim();

    var msgs = [];
    if (question) msgs.push({ role: 'user', text: question });
    if (answer) {
      // v1.6 (D13): инъекция DR-контента — заменяем голые ссылки-заглушки
      // (immersive_entry_chip → отчёт, deep_research_confirmation_content → план)
      // на текст. Применяется на КАЖДОМ парсе (stateless): answer извлекается
      // детерминированно, lastDrTexts вычислен в handleOuter из тех же realTurns.
      var drAn = injectDrLinks(answer, lastDrTexts);
      if (canon.isFallback) {
        // thinking-эвристики применяем ТОЛЬКО к fallback-пути (collectTurnText):
        // чисто английский thinking-блок исключаем, смешанный срезаем до кириллицы.
        if (isThinkingAssistant(drAn)) {
          // чисто английский thinking-блок assistant — исключаем целиком.
        } else {
          var kept = stripLeadingThinking(drAn);
          if (kept) msgs.push({ role: 'assistant', text: kept });
        }
      } else {
        // Канонический ответ не трогаем — риск удалить английский ответ,
        // начинающийся с "I'm …".
        msgs.push({ role: 'assistant', text: drAn });
      }
    }
    return msgs;
  }

  // ---- разбор batchexecute ----

  /**
   * Разбор одного внешнего блока batchexecute (outer[0][1] === 'hNvQHb'):
   * turns → ходы → сообщения, дописываются в out. Кривой блок не ломает остальные.
   * @param {any} outer Внешний блок (JSON.parse строки ответа).
   * @param {GeminiTurnEntry[]} out Накопитель сообщений.
   * @returns {void}
   */
  function handleOuter(outer, out) {
    try {
      if (!Array.isArray(outer) || !Array.isArray(outer[0])) return;
      if (outer[0][1] !== 'hNvQHb') return;
      var inner = outer[0][2];
      if (typeof inner !== 'string') return;
      var turns = JSON.parse(inner);
      if (!Array.isArray(turns)) return;
      var realTurns = (Array.isArray(turns[0]) && Array.isArray(turns[0][0])) ? turns[0] : turns;
      // v1.6 (D13): stateless — при каждом парсе пересчитываем DR-контент из этих
      // realTurns и обновляем lastDrTexts (buildTurnMessages использует его для инъекции).
      try { lastDrTexts = extractDrTexts(realTurns); } catch (eD13) { }

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
    } catch (e) { logSegmentParseFail(e, 'handleOuter'); /* кривой блок не ломает остальные */ }
  }

  /**
   * Разбор ответа в формате byte-chunked: "<len>\n<payload>" с заголовком )]}'.
   * @param {string} raw Сырое тело ответа batchexecute.
   * @param {GeminiTurnEntry[]} out Накопитель сообщений.
   * @returns {void}
   */
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
        try { handleOuter(JSON.parse(payloadStr), out); } catch (e) { logSegmentParseFail(e, 'parseByBytes'); }
      }
    }
  }

  /**
   * Фолбэк-разбор по строкам (когда byte-chunked разбор не дал сообщений).
   * @param {string} raw Сырое тело ответа batchexecute.
   * @param {GeminiTurnEntry[]} out Накопитель сообщений.
   * @returns {void}
   */
  function parseByLines(raw, out) {
    var lines = raw.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (!ln || ln === ")]}'") continue;
      var c0 = ln.charAt(0);
      if (c0 !== '[' && c0 !== '{') continue;
      if (ln.indexOf('hNvQHb') === -1) continue;
      try { handleOuter(JSON.parse(ln), out); } catch (e) { logSegmentParseFail(e, 'parseByLines'); }
    }
  }

  /**
   * Полный разбор сетевой истории Gemini (batchexecute hNvQHb).
   * @param {string} raw Сырое тело ответа (HTML/скрипт или byte-chunked поток).
   * @returns {GeminiHistoryResult} Сообщения, модель, оценка токенов, текст и счётчик.
   */
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

  /**
   * Публичный API парсера batchexecute (window.GeminiBatchexecuteParser / module.exports).
   * @typedef {Object} GeminiBatchexecuteParserApi
   * @property {string} PARSER_VERSION Версия логики парсинга.
   * @property {typeof stripAttachmentTokens} stripAttachmentTokens Вырезание токенов вложений.
   * @property {typeof sanitizeGeminiText} sanitizeGeminiText Санация текста Gemini.
   * @property {typeof collectTurnText} collectTurnText Stateful-сбор текста ответа.
   * @property {typeof isThinkingAssistant} isThinkingAssistant Предикат чисто английского мышления.
   * @property {typeof firstCyrillicIndex} firstCyrillicIndex Индекс первого кириллического символа.
   * @property {typeof stripLeadingThinking} stripLeadingThinking Срез ведущего мышления.
   * @property {typeof buildTurnMessages} splitTurnMessages Ход → сообщения.
   * @property {typeof extractDrTexts} extractDrTexts Тексты Deep Research.
   * @property {typeof injectDrLinks} injectDrLinks Инъекция DR-контента вместо ссылок-заглушек.
   * @property {typeof __setDrTexts} __setDrTexts Установка DR-текстов текущего парса.
   * @property {typeof fileRefFromNode} fileRefFromNode Нормализованный ref вложения.
   * @property {typeof fileRefIdentityKey} fileRefIdentityKey Стабильная идентичность вложения.
   * @property {typeof collectTurnFiles} collectTurnFiles Вложения хода.
   * @property {typeof registerTurnFileOwner} registerTurnFileOwner Регистрация владельца файлов до эмиссии.
   * @property {typeof collectTurnFilesForOwner} collectTurnFilesForOwner Вложения хода-владельца.
   * @property {typeof __resetFileOwners} __resetFileOwners Сброс реестра владельцев файлов.
   * @property {typeof parseGeminiHistory} parseGeminiHistory Полный разбор истории.
   */

  /** @type {GeminiBatchexecuteParserApi} */
  var api = {
    PARSER_VERSION: PARSER_VERSION,
    stripAttachmentTokens: stripAttachmentTokens,
    sanitizeGeminiText: sanitizeGeminiText,
    collectTurnText: collectTurnText,
    isThinkingAssistant: isThinkingAssistant,
    firstCyrillicIndex: firstCyrillicIndex,
    stripLeadingThinking: stripLeadingThinking,
    splitTurnMessages: buildTurnMessages,
    extractDrTexts: extractDrTexts,
    injectDrLinks: injectDrLinks,
    __setDrTexts: __setDrTexts,
    fileRefFromNode: fileRefFromNode,
    fileRefIdentityKey: fileRefIdentityKey,
    collectTurnFiles: collectTurnFiles,
    registerTurnFileOwner: registerTurnFileOwner,
    collectTurnFilesForOwner: collectTurnFilesForOwner,
    __resetFileOwners: __resetFileOwners,
    parseGeminiHistory: parseGeminiHistory
  };

  if (typeof window !== 'undefined') {
    window.GeminiBatchexecuteParser = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();