/**
 * adapters/qwen-adapter.js — DOM-адаптер chat.qwen.ai (O-35, вариант A + C-lite).
 *
 * РОЛЬ: ФОЛБЭК. Основной источник — live-SSE из core/qwen-intercept.js (точные токены и
 * тексты). Адаптер включается, когда сетевого снимка нет: clone() не удался, стрим оборвался,
 * либо страница отрисовала историю без нового запроса (открытие готового чата). Даёт базу
 * текстов/ходов, чтобы бейдж и экспорт не пустели (в content.js база ставится только при
 * непустом detail.text — см. гард `if (!detail || !detail.text) return;`).
 *
 * СЕЛЕКТОРЫ — ЖИВОЙ DOM (снимок chat.qwen.ai 2026-09-26, артефакт
 * tools/qwen-dom-snapshot-26.09.26.json; сниффер 2026-09-18 работал только по сети):
 *   - опорный признак ввода — textarea[placeholder*="Qwen"] («Спросить Qwen») и адрес /c/<id>;
 *   - реальные реплики — ТОЧНЫЕ классы `.qwen-chat-message.qwen-chat-message-user` и
 *     `.qwen-chat-message.qwen-chat-message-assistant` (по 47 узлов на снимке): они и есть
 *     первый непустой набор, поэтому широкие кандидаты (data-атрибуты → aria → *-message)
 *     остаются только наследием старых сборок и выигрывают ЛИШЬ при пустом точном наборе;
 *   - узлы-ОБЁРТКИ turn-selection (`.qwen-chat-message-select-turn`,
 *     `.qwen-chat-message-select-turn-message` — 47 + 94 узла на снимке) исключены ЯВНО
 *     (`:not()` в широком кандидате + фильтр `_dropTurnOnlyNodes`), иначе один ход давал бы
 *     до трёх «сообщений» с одним и тем же текстом;
 *   - роль реплики — ТОЛЬКО класс-токен (`qwen-chat-message-user` / `…-assistant`);
 *     data-* маркеров роли в живом DOM нет (0 совпадений в снимке), position-догадки нет;
 *   - блок размышлений («Завершено размышление» / thinking) лежит ВНУТРИ узла реплики
 *     (thinkingInsideOnlyFindable=true) и распознаётся по маркеру в НАЧАЛЕ текста (как
 *     _stripReasoningHeader у DeepSeek) → hiddenReasoning, а не content. Карточки
 *     инструментов (`qwen-chat-thinking-tool-status-card-wraper`, до 6 на реплику) — ШУМ:
 *     они несут подстроку «thinking» в классе, но размышлением не являются — исключены
 *     явно (`:not([class*="tool-status-card"])` + `_isToolStatusCard`), и их текст вырезан
 *     из реплики вместе со служебной обвязкой (`_noiseSelectors`). Селектор
 *     `[class*="reason"]` для панели не берётся: он матчит `…-card-wraper` (wraper ⊃ raper).
 *
 * Наследник BaseAdapter: isOnDialogPage / extractMessages / getFullDialogText обязательны
 * (базовый getFullDialogText склеивает content через '\n' — здесь явное переопределение).
 *
 * ДЕФЕКТ ТЕКСТА (ФИКС, снимок 2026-09-26): textContent реплики схлопнут (1-3 строки против
 * 7-85 у innerText) — многострочные ответы и код-блоки склеивались в одну строку. Текст
 * снимается `_readableText`: в браузере — живой `innerText`, в jsdom/срезе — тот же
 * алгоритм структурно (перевод строки после блочных элементов), затем нормализация
 * (пробелы перед '\n' убираются, серии '\n' схлопываются) — переводы строк СОХРАНЯЮТСЯ.
 *
 * O-36.2 (ФИКС): узлы-КОНТЕЙНЕРЫ всего чата снимаются ВНУТРИ extractMessages тем же
 * правилом, что уже экспортировано сборщиками (utils/export-text-builders.js:
 * aiCmDropContainerMessages/aiCmContainerRules) — ни логика, ни её пороги здесь не
 * дублируются. Вторая ступень (та же чистка на выходе экспорта) остаётся и идемпотентна.
 */

/** Блочные теги: на их границах структурный фолбэк innerText ставит перевод строки. */
const QWEN_BLOCK_TAGS = {
  ADDRESS: true, ARTICLE: true, ASIDE: true, BLOCKQUOTE: true, DD: true, DETAILS: true,
  DIALOG: true, DIV: true, DL: true, DT: true, FIELDSET: true, FIGCAPTION: true,
  FIGURE: true, FOOTER: true, FORM: true, H1: true, H2: true, H3: true, H4: true,
  H5: true, H6: true, HEADER: true, HR: true, LI: true, MAIN: true, NAV: true,
  OL: true, P: true, PRE: true, SECTION: true, TABLE: true, TD: true, TH: true,
  TR: true, UL: true
};

/** Маркер-комментарий на месте снятого служебного узла (граница текста не теряется). */
const QWEN_CUT_MARKER = 'ai-cm-qwen-cut';

/*
 * Типизация (шаг 4 Фазы 1): формы — из types/adapter.d.ts. Литеральный `import type`
 * невозможен: файл — классический скрипт контента (manifest.json) плюс склейка исходника
 * в new Function()/eval песочницами тестов, а `import type` там — SyntaxError.
 * Поэтому типы подключены JSDoc-ссылкой import() (одна истина — types/adapter.d.ts).
 *
 * Имя с префиксом — по необходимости: файлы адаптеров не являются модулями, поэтому при
 * allowJs все typedef-имена попадают в одну общую область (одноимённые → TS2300).
 */

/**
 * Сообщение в форме адаптера (types/adapter.d.ts).
 * @typedef {import('../types/adapter').ExtractedMessage} QwenExtractedMessage
 */

/**
 * Функция отбрасывания узлов-контейнеров из utils/export-text-builders.js
 * (aiCmDropContainerMessages). Резолвится лениво, пороги живут в aiCmContainerRules.
 * @typedef {function(Array<T>): Array<T>} QwenContainerDrop
 * @template T
 */

class QwenAdapter extends BaseAdapter {
  constructor() {
    super();
    this.siteName = 'qwen';
    this.dialogContainerSelector = '#chat-container, [class*="chat-container"], main';

    // Фолбэк-маркеры роли (наследие старых сборок): используются только как признак
    // assistant-контейнера в _detectRole, когда класс-токена живой разметки нет.
    this.userMessageSelector = [
      '[data-message-role="user"]',
      '[data-role="user"]',
      '[class*="user-message"]',
      '[class*="message-user"]'
    ].join(', ');
    this.modelMessageSelector = [
      '[data-message-role="assistant"]',
      '[data-role="assistant"]',
      '[class*="assistant-message"]',
      '[class*="message-assistant"]'
    ].join(', ');

    // Узлы сообщений: список кандидатов, первый непустой набор выигрывает.
    // ПЕРВЫЙ (подтверждён снимком 2026-09-26) — ТОЧНЫЕ классы реплик; широкий
    // `[class*="chat-message"]` оставлен ПОСЛЕДНИМ и с явным исключением обёрток
    // turn-selection (`:not(.qwen-chat-message-select-turn)`): без исключения широкий
    // кандидат перекрывает живые контейнеры `chat-messages-container`/`chat-messages`
    // (O-39 16:53) и отдаёт по 3 узла на один ход с одинаковым текстом.
    this._messageSelectors = [
      '.qwen-chat-message.qwen-chat-message-user, .qwen-chat-message.qwen-chat-message-assistant',
      '[data-message-id]',
      '[data-message-role]',
      '[data-role][data-message-index]',
      '[class*="message-row"]',
      '[class*="message-item"]',
      '[class*="message-bubble"]',
      '[class*="chat-message"]:not(.qwen-chat-message-select-turn)'
    ];

    // Блок размышлений (панель «thinking» лежит ВНУТРИ узла реплики — снимок 2026-09-26).
    // Guard на карточки инструментов (`qwen-chat-thinking-tool-status-card-wraper`, до 6 на
    // реплику): их класс содержит подстроку «thinking», но размышлением они НЕ являются —
    // исключены ЯВНО (`:not()`), поэтому текст карточки не уезжает в hiddenReasoning.
    // Селектор `[class*="reason"]` НЕ берётся: он матчит `…-card-WRAPER` (wraper ⊃ raper),
    // то есть ту же карточку другим путём — панель размышления ищется по `thinking`/`thought`.
    this._reasoningSelectors = [
      '[class*="thinking"]:not([class*="tool-status-card"])',
      '[class*="thought"]:not([class*="tool-status-card"])',
      '[data-testid*="think"]:not([class*="tool-status-card"])'
    ].join(', ');

    // Служебные узлы интерфейса, чей текст сообщением не является. Карточки инструментов
    // Qwen сюда же: это UI-обвязка вызова инструмента, а не текст реплики.
    this._noiseSelectors = 'button, svg, textarea, [class*="toolbar"], [class*="action"],' +
      ' [class*="footer"], [class*="input"], [class*="avatar"], [class*="icon"], [class*="copy"],' +
      ' [class*="tool-status-card"]';
  }

  /**
   * Блочные теги для структурного фолбэка innerText (перевод строки после элемента).
   * @returns {Record<string, boolean>}
   */
  static get _BLOCK_TAGS() {
    return QWEN_BLOCK_TAGS;
  }

  /**
   * Живой признак ввода Qwen (подтверждён сниффером: textarea «Спросить Qwen»).
   * @returns {boolean}
   */
  _hasComposer() {
    try {
      return !!document.querySelector('textarea[placeholder*="Qwen"], textarea[placeholder*="qwen"]') ||
        !!document.querySelector('textarea[placeholder*="Спросить"], textarea[placeholder*="Ask"]');
    } catch (e) { return false; }
  }

  /**
   * Находимся ли мы на странице чата Qwen: хост qwen.ai И (поле ввода ИЛИ узлы реплик
   * ИЛИ адрес вида /c/<id>). Иначе адаптер не считается активным.
   * @returns {boolean}
   */
  isOnDialogPage() {
    try {
      if (!/chat\.qwen\.ai$/i.test(String(location.hostname || '')) &&
        String(location.hostname || '').indexOf('qwen.ai') === -1) return false;
      return this._hasComposer() || this._messageNodes().length > 0 || /\/c\//.test(location.pathname);
    } catch (e) { return false; }
  }

  /**
   * Узлы сообщений: первый непустой набор кандидатов (точные классы — первым, см. шапку),
   * с отсевом обёрток turn-selection. Пусто, если не отрисовано ни одной реплики.
   * @returns {Element[]}
   */
  _messageNodes() {
    for (let i = 0; i < this._messageSelectors.length; i++) {
      const nodes = this._safeQuerySelectorAll(this._messageSelectors[i]);
      if (nodes && nodes.length > 0) return this._dropTurnOnlyNodes(Array.prototype.slice.call(nodes));
    }
    return [];
  }

  /**
   * Обёртки turn-selection сообщениями НЕ являются (снимок 2026-09-26: 47 узлов
   * `.qwen-chat-message-select-turn` + 94 `.qwen-chat-message-select-turn-message` вокруг 94
   * реальных реплик). Широкий кандидат исключает их через `:not()`; здесь — второй,
   * класс-независимый барьер (страховка на случай смены класса обёртки): узлом-обёрткой
   * считается ТОЛЬКО тот, чей класс содержит `select-turn`, — реальные реплики
   * (`.qwen-chat-message.qwen-chat-message-user/assistant`) не содержат его никогда.
   * @param {Element[]} nodes
   * @returns {Element[]}
   */
  _dropTurnOnlyNodes(nodes) {
    return nodes.filter(function (el) {
      const cls = String((el && el.className) || '').toLowerCase();
      return cls.indexOf('select-turn') === -1;
    });
  }

  /**
   * Читаемый текст узла (текст УЖЕ БЕЗ служебных элементов и без блока размышлений).
   * Живой браузер: `innerText` — 1:1 с тем, что видит пользователь (многострочность).
   * jsdom/срез: `innerText` не реализован → структурный фолбэк (тот же принцип: перевод
   * строки после блочного элемента), затем ОДНА нормализация для обоих путей.
   * @param {Element & {innerText?: string}} element
   * @returns {string}
   */
  _readableText(element) {
    try {
      if (!element) return '';
      let raw = '';
      // В живом браузере innerText есть и многострочен; в jsdom/срезе его нет (или он ''),
      // тогда срабатывает проверка typeof ниже и текст идёт через структурный фолбэк.
      try { raw = element.innerText; } catch (eInner) { raw = ''; }
      if (typeof raw !== 'string' || raw.length === 0) raw = this._innerTextFallback(element);
      return this._normalizeLines(raw);
    } catch (e) { return ''; }
  }

  /**
   * Структурный фолбэк innerText (jsdom/срез, где innerText не реализован): обход дерева,
   * перевод строки вокруг блочных элементов и на маркере среза; <br> — перевод строки.
   * @param {Element} root
   * @returns {string}
   */
  _innerTextFallback(root) {
    try {
      let out = '';
      const block = QWEN_BLOCK_TAGS;
      const walk = function (/** @type {Node} */ node) {
        const type = node.nodeType;
        if (type === 3) { out += node.nodeValue || ''; return; }
        if (type === 8) {                       // маркер снятого служебного узла → разделитель
          if (String(node.nodeValue || '') === QWEN_CUT_MARKER) out += '\n';
          return;
        }
        if (type !== 1) return;
        // nodeType === 1 — элемент, у него есть tagName (у Node в общем случае нет).
        const tag = String(/** @type {Element} */ (/** @type {unknown} */ (node)).tagName || '').toUpperCase();
        if (tag === 'BR') { out += '\n'; return; }
        // Блок начинается с новой строки (если текст уже есть) и ею же заканчивается — так
        // разделяются соседние <p>/<div> и не склеиваются текст-узел и следующий блок.
        if (block[tag] === true && out.length > 0 && out.charAt(out.length - 1) !== '\n') out += '\n';
        const kids = node.childNodes || [];
        for (let i = 0; i < kids.length; i++) walk(kids[i]);
        if (block[tag] === true && out.length > 0 && out.charAt(out.length - 1) !== '\n') out += '\n';
      };
      walk(root);
      return out;
    } catch (e) { return ''; }
  }

  /**
   * Нормализация: пробелы перед переводом строки убираются, серии '\n' схлопываются в один.
   * Схлопывание — осознанный компромисс: пустые строки верстки (`\n\n` между абзацами) не
   * размножаются, многострочность и границы блоков при этом сохраняются (дефект textContent
   * был в ПОТЕРЕ переводов строк, а не в их количестве).
   * @param {string} text
   * @returns {string}
   */
  _normalizeLines(text) {
    try {
      return String(text == null ? '' : text)
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{2,}/g, '\n')
        .trim();
    } catch (e) { return String(text == null ? '' : text).trim(); }
  }

  /**
   * Снятие служебного узла с сохранением границы: на месте узла остаётся маркер-комментарий,
   * который `_innerTextFallback` превращает в перевод строки. Без маркера соседние текст-узлы
   * склеились бы («привет» + снятая кнопка + «как дела» → «приветкак дела»).
   * @param {NodeList|Element[]} nodes
   * @returns {void}
   */
  _removeKeepingCut(nodes) {
    Array.prototype.slice.call(nodes).forEach(function (el) {
      try {
        if (el.parentNode) el.parentNode.insertBefore(document.createComment(QWEN_CUT_MARKER), el);
      } catch (eMark) { }
      el.remove();
    });
  }

  /**
   * Текст узла БЕЗ служебных элементов и БЕЗ блока размышлений (многострочность сохранена).
   * @param {Element} element
   * @returns {string}
   */
  _textWithoutReasoning(element) {
    try {
      const clone = /** @type {Element} */ (element.cloneNode(true));
      this._removeKeepingCut(clone.querySelectorAll(this._noiseSelectors));
      this._removeKeepingCut(clone.querySelectorAll(this._reasoningSelectors));
      return this._readableText(clone);
    } catch (e) { return ''; }
  }

  /**
   * Служебная шапка свёрнутой панели («Завершено размышление», «Thinking… 3s») — не текст.
   * @param {string} text
   * @returns {string}
   */
  _stripReasoningHeader(text) {
    try {
      var s = String(text == null ? '' : text).trim();
      // Маркер панели в НАЧАЛЕ текста (у Qwen — «Завершено размышление», у англ. UI —
      // «Thinking…»/«Thought for 3s»). Многоточие и скобки/длительность — часть шапки,
      // а не рассуждения. Снимается ТОЛЬКО шапка, текст размышления остаётся как есть.
      var re = /^(?:завершено\s+размышлени[ея]|размышлени[ея]|размышляю|thinking|thought|思考)[\s.…·:•\-–—]*[\[(]?\s*(?:\d+\s*(?:с|s|sec|сек|seconds?)?)?\s*[\])]?\s*[·:•\-–—]?\s*/i;
      return s.replace(re, '').trim();
    } catch (e) { return String(text == null ? '' : text).trim(); }
  }

  /**
   * Текст панели размышлений реплики (сама панель либо вложенные think-узлы), без шапки,
   * без карточек инструментов; части склеены пустой строкой.
   * @param {Element} element
   * @returns {string}
   */
  _reasoningText(element) {
    try {
      if (!element) return '';
      /** @type {Node[]} */
      const nodes = [];
      if (typeof element.matches === 'function' && element.matches(this._reasoningSelectors)) {
        nodes.push(element);
      } else if (typeof element.querySelectorAll === 'function') {
        const found = element.querySelectorAll(this._reasoningSelectors);
        for (let i = 0; i < found.length; i++) nodes.push(found[i]);
      }
      /** @type {string[]} */
      const parts = [];
      for (let j = 0; j < nodes.length; j++) {
        const node = /** @type {Element} */ (/** @type {unknown} */ (nodes[j]));
        // Guard карточек инструментов (план замены, п. 3): текст карточки — служебный шум,
        // размышлением не является. Селекторы уже несут `:not([class*="tool-status-card"])`,
        // здесь — второй барьер (страховка от смены класса обёртки карточки).
        if (this._isToolStatusCard(node)) continue;
        const text = this._stripReasoningHeader(this._readableText(node));
        if (text && /[0-9A-Za-z\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF]/.test(text)) parts.push(text);
      }
      return parts.join('\n\n').trim();
    } catch (e) { return ''; }
  }

  /**
   * Служебная карточка инструмента Qwen (не панель размышления) — по классу узла.
   * Вызывается только для элементов (узлы панели размышлений), поэтому className читаем
   * у узла как у Element.
   * @param {Node} node
   * @returns {boolean}
   */
  _isToolStatusCard(node) {
    try {
      const el = /** @type {Element} */ (/** @type {unknown} */ (node));
      const cls = String((node && el.className) || '').toLowerCase();
      return cls.indexOf('tool-status-card') !== -1;
    } catch (e) { return false; }
  }

  /**
   * Роль узла: ТОЛЬКО класс-токен живой разметки (`qwen-chat-message-user` →
   * `qwen-chat-message-assistant`), плюс классы старых сборок как фолбэк. data-* маркеров
   * роли в живом DOM нет (снимок 2026-09-26: `data-message-role`/`data-role` — 0 совпадений);
   * угадывание по позиции/«пузырю» убрано — неверная роль тише не становится.
   * Возвращаем string, а не литеральный union 'user'|'assistant': пока тип узкий,
   * tsc (TS2367) счёл бы вызовы и сверку ролей в extractMessages заведомо ложными.
   * TODO: уточнить тип в шаге 5 (контракт ролей адаптера).
   * @param {Element} element
   * @returns {string}
   */
  _detectRole(element) {
    try {
      const cls = String(element.className || '').toLowerCase();
      if (cls.indexOf('qwen-chat-message-user') !== -1) return 'user';
      if (cls.indexOf('qwen-chat-message-assistant') !== -1) return 'assistant';
      if (/user/.test(cls)) return 'user';
      if (/assistant|model|bot|answer/.test(cls)) return 'assistant';
      if (element.querySelector && element.querySelector(this.modelMessageSelector)) return 'assistant';
      if (element.querySelector && element.querySelector('[class*="markdown"], [class*="prose"]')) return 'assistant';
    } catch (e) { swallow(e, 'adapter:qwen:detectRole'); }
    return 'user';
  }

  /**
   * O-36.2 (ФИКС): контейнер-чистка базы адаптера. Живой артефакт 20-50: 75 узлов, из них
   * ДВА — узлы-КОНТЕЙНЕРЫ всего чата (по 91 595 знаков, cover=0.9999, внутри все 73 реплики):
   * база раздувалась до tokens=81672 / pct=63.8 при реальном тексте ~27-33k (~21-26%).
   * Правило — ОБЩЕЕ со сборщиками экспорта (utils/export-text-builders.js):
   * aiCmDropContainerMessages (пороги — в aiCmContainerRules, здесь НЕ повторяются).
   * Хелпер резолвится ЛЕНИВО на каждом вызове: файл сборщиков подключён в manifest.json ПОСЛЕ
   * адаптера, но к моменту extractMessages он уже загружен (общий ISOLATED-мир контент-скриптов).
   * Хелпера нет (Node/срез-песочница) → массив возвращается КАК ЕСТЬ: поведение 1:1, никакой
   * второй копии правил здесь нет.
   * @param {(QwenExtractedMessage & {hiddenReasoning?: string})[]} messages
   * @returns {(QwenExtractedMessage & {hiddenReasoning?: string})[]}
   */
  _dropContainerNodes(messages) {
    try {
      // Хелпер приходит из общего модуля без типовой информации (function(Array<any>)),
      // поэтому на границе он стирается до unknown: конкретный тип массива ходов
      // проверяет сам _dropContainerNodes по сигнатуре.
      var drop = /** @type {QwenContainerDrop<unknown>|null} */ (this._containerDrop());
      if (typeof drop === 'function') return /** @type {(QwenExtractedMessage & {hiddenReasoning?: string})[]} */ (/** @type {unknown} */ (drop(messages)));
    } catch (eDrop) { swallow(eDrop, 'adapter:qwen:dropContainerNodes'); }
    return messages;
  }

  /**
   * Ленивый резолв общего хелпера контейнер-чистки (боевой путь — window сборщиков,
   * Node-путь — require), иначе null (правила не дублируются локально).
   * TODO: уточнить тип в шаге 5 (форма window.AiCmExportBuilders без @types).
   * @returns {QwenContainerDrop<unknown>|null}
   */
  _containerDrop() {
    try {
      if (typeof window !== 'undefined' && window && window.AiCmExportBuilders &&
        typeof window.AiCmExportBuilders.aiCmDropContainerMessages === 'function') {
        return window.AiCmExportBuilders.aiCmDropContainerMessages;
      }
    } catch (eWin) { }
    try {
      var hasNodeModule = (typeof module !== 'undefined') && !!module && (typeof require === 'function');
      if (hasNodeModule) {
        var builders = require('../utils/export-text-builders.js');
        if (builders && typeof builders.aiCmDropContainerMessages === 'function') {
          return builders.aiCmDropContainerMessages;
        }
      }
    } catch (eReq) { }
    return null;
  }

  /**
   * Ходы диалога из DOM (фолбэк к live-SSE, см. шапку файла).
   *
   * Пустые и «технические» тексты (артефакт свёрнутой панели) пропускаются; текст панели
   * размышлений у assistant-хода уходит в hiddenReasoning, а не в content. Метод
   * stateless — пересъём без перезагрузки (см. комментарий O-35 C в теле).
   * @returns {QwenExtractedMessage[]}
   */
  extractMessages() {
    // O-35 C (ФИКС, пункт «в»): пересъём БЕЗ F5. Метод stateless: ни кэша, ни латча
    // «одного раза на документ» здесь нет — каждый вызов заново обходит узлы DOM. Поэтому
    // SPA-смена разговора (content.js: aiCmQwenSpaReshoot после сигнала
    // ai-cm-conversation-changed) получает базу НОВОГО чата тем же вызовом, что и холодное
    // открытие: перезагрузка страницы для повторного extractMessages() не нужна.
    try {
      /**
       * Поле hiddenReasoning нет в контракте ExtractedMessage (types/adapter.d.ts — форма
       * {role, content}), поэтому элементы накопления расширяют его на поле захвата reasoning.
       * @type {(QwenExtractedMessage & {hiddenReasoning?: string})[]}
       */
      const messages = [];
      const nodes = this._messageNodes();
      for (let i = 0; i < nodes.length; i++) {
        const element = nodes[i];
        const role = this._detectRole(element);
        const content = this._textWithoutReasoning(element);
        if (!content || content.length === 0) continue;
        if (!/[0-9A-Za-z\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF]/.test(content)) continue;   // «.» свёрнутой панели
        /** @type {QwenExtractedMessage & {hiddenReasoning?: string}} */
        const msg = { role, content };
        if (role === 'assistant') {
          const reasoning = this._reasoningText(element);
          if (reasoning) msg.hiddenReasoning = reasoning;
        }
        messages.push(msg);
      }
      // O-36.2 (ФИКС, см. шапку файла): контейнер-узлы снимаются ЗДЕСЬ, до базы/бейджа/файла —
      // общим правилом сборщиков (логика не дублируется). Массив базы остаётся ОДНИМ объектом
      // (in-place), поэтому счётчик, лог и потребители (buildHistoryMessages → экспорт) видят
      // ровно реплики; вторая ступень в сборщиках идемпотентна.
      const keptNodes = this._dropContainerNodes(messages);
      const droppedContainers = messages.length - keptNodes.length;
      if (droppedContainers > 0) {
        messages.length = 0;
        Array.prototype.push.apply(messages, keptNodes);
      }
      if (messages.length > 0) {
        debugLog('log', `[QwenAdapter] Извлечено ${messages.length} сообщений, контейнеров отброшено: ${droppedContainers}, роли: ${messages.map(m => String(m.role).substring(0, 4)).join(', ')}`);
      }
      return messages;
    } catch (error) {
      debugLog('error', '[QwenAdapter] Ошибка:', error);
      return [];
    }
  }

  /**
   * Полный текст диалога: содержимое ходов, склеенное переводом строки.
   * Явное переопределение базового (у Qwen путь отбора узлов свой).
   * @returns {string}
   */
  getFullDialogText() {
    try {
      return this.extractMessages().map(msg => msg.content).join('\n');
    } catch (e) { return ''; }
  }

  /**
   * Модель из UI. HYPOTHESIS: живой id — qwen3.8-max (подтверждён в теле /chats/new).
   * Если в разметке модели нет — возвращаем канонический id, а не выдуманный ярлык.
   * @returns {string}
   */
  detectModel() {
    try {
      const selectors = ['[class*="model"] [class*="name"]', '[class*="model-select"]', '[class*="modelName"]'];
      for (let i = 0; i < selectors.length; i++) {
        const el = this._safeQuerySelector(selectors[i]);
        if (!el) continue;
        const text = String(el.textContent || '').trim();
        if (!text) continue;
        const m = /qwen[0-9.]*-[a-z]+/i.exec(text);
        if (m) return m[0].toLowerCase();
      }
    } catch (e) { swallow(e, 'adapter:qwen:detectModel'); }
    return 'qwen3.8-max';
  }
}

// Экспорт как у BaseAdapter: браузер — глобальный класс, Node/jest — module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = QwenAdapter;
}
