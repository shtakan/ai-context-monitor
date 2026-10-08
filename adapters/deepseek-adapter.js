/**
 * Адаптер для DeepSeek (chat.deepseek.com).
 *
 * Типизация (шаг 4 Фазы 1): формы — из types/adapter.d.ts. Литеральный `import type`
 * невозможен (файл — классический скрипт контента плюс склейка исходника в
 * new Function()/eval песочницами тестов), поэтому типы подключены JSDoc-ссылкой import().
 */

/**
 * Сообщение в форме адаптера (types/adapter.d.ts).
 *
 * Имя с префиксом — по необходимости: файлы адаптеров не являются модулями, поэтому
 * при allowJs все typedef-имена попадают в одну общую область (одноимённые → TS2300).
 * @typedef {import('../types/adapter').ExtractedMessage} DeepSeekExtractedMessage
 */

class DeepSeekAdapter extends BaseAdapter {
  constructor() {
    super();
    this.siteName = 'deepseek';
    debugLog('log', '[DeepSeekAdapter] Инициализирован');
  }

  /**
 * Находимся ли мы на странице диалога: есть узлы ds-message ИЛИ поле ввода.
 * @returns {boolean}
 */
isOnDialogPage() {
    const hasMessages = document.querySelectorAll('div[class*="ds-message"]').length > 0;
    const hasInput = document.querySelector('textarea') !== null;
    return hasMessages || hasInput;
  }

  // loadFullHistory удалён в v1.1 — скролл-пагинация противоречит архитектуре server-first
  // (основной источник данных — перехват сети). Метод не вызывался ни из одного файла.

  // ===== v2 (O-15): reasoning DeepSeek — ЧАСТЬ assistant-хода, а не отдельное сообщение =====
  // Панель размышлений в DOM живёт отдельным узлом с классом ds-message* — в живом прогоне
  // это давало «Извлечено 2 сообщений, роли: assi, assi»: пузыри пользователя отбрасывались
  // (роль 'unknown'), а reasoning и ответ уходили двумя assistant-сообщениями (пара
  // user→assistant рвалась, а «.» свёрнутой панели попадала в текст хода как [ANSWER]).
  // Классы DeepSeek ротируются, поэтому признак — комбинация: маркер reasoning + ОТСУТСТВИЕ
  // markdown-рендера ответа (.ds-markdown) внутри узла.
  /** Селекторы узлов панели размышлений (thinking) — классы DeepSeek ротируются. */
  _thinkSelector() {
    return '[class*="ds-think"], [class*="think-content"], [class*="ds-reason"], [data-testid*="think"]';
  }
  /**
   * Признак панели размышлений: класс узла, вложенный think-узел либо маркер в начале текста.
   * @param {Element} element
   * @returns {boolean}
   */
  _hasThinkMarker(element) {
    try {
      if (!element) return false;
      const cls = String(element.className || '');
      if (/ds-think|think-content|ds-reason/i.test(cls)) return true;
      if (typeof element.querySelector === 'function' && element.querySelector(this._thinkSelector())) return true;
      const txt = String(element.textContent || '').trim();
      return /^(?:deepthink|deep\s*think|thought|thinking|размышлен|думаю|思考)/i.test(txt);
    } catch (e) { return false; }
  }
  /**
   * Узел markdown-рендера ответа (сам узел либо вложенный .ds-markdown), иначе null.
   * @param {Element} element
   * @returns {Element|null}
   */
  _answerMarkdown(element) {
    try {
      if (!element) return null;
      if (String(element.className || '').includes('ds-markdown')) return element;
      const md = (typeof element.querySelector === 'function') ? element.querySelector('.ds-markdown') : null;
      return md || null;
    } catch (e) { return null; }
  }
  // Узел — ТОЛЬКО панель размышлений (ответа в нём нет): сообщением хода не является.
  /**
   * Узел — только панель размышлений (ответа в нём нет): сообщением хода не является.
   * @param {Element} element
   * @returns {boolean}
   */
  _isReasoningOnly(element) {
    try {
      if (!element) return false;
      if (this._answerMarkdown(element)) return false;
      return this._hasThinkMarker(element);
    } catch (e) { return false; }
  }
  /**
   * Находится ли узел внутри панели размышлений (сам think-класс либо ближайший think-предок).
   * @param {Element} element
   * @returns {boolean}
   */
  _isInsideReasoning(element) {
    try {
      if (!element) return false;
      if (/ds-think|think-content|ds-reason/i.test(String(element.className || ''))) return true;
      return (typeof element.closest === 'function') && !!element.closest(this._thinkSelector());
    } catch (e) { return false; }
  }
  /**
   * Текст элемента БЕЗ панелей размышлений и служебных кнопок/иконок.
   * @param {Element} element
   * @returns {string}
   */
  _textWithoutReasoning(element) {
    try {
      const clone = /** @type {Element} */ (element.cloneNode(true));
      Array.prototype.slice.call(clone.querySelectorAll(this._thinkSelector())).forEach(el => el.remove());
      clone.querySelectorAll('button, svg, [class*="avatar"], [class*="icon"], [class*="toolbar"]')
        .forEach(el => el.remove());
      return clone.textContent.trim();
    } catch (e) { return ''; }
  }
  // ===== O-7 (hidden-захват): текст панели размышлений ОТДЕЛЬНЫМ полем =====
  // Базовый текст хода панель reasoning НЕ несёт (_textWithoutReasoning её вырезает,
  // _isReasoningOnly такие узлы вовсе пропускает) — в DOM-ветке reasoning исторически
  // терялся на ЗАХВАТЕ. Здесь он сохраняется рядом с текстом (hiddenReasoning) и НЕ
  // попадает ни в content, ни в метрики/токены: базовый текст байтово прежний, а в
  // экспорт блок уходит только при включённом тумблере aiCmIncludeHiddenInExport
  // (сырой режим, utils/export-emit-pipeline.js:includeHiddenExportBlocks).
  // Служебная шапка свёрнутой панели («DeepThink · 12 с», «Размышления:», «Thought for 3s») —
  /**
   * Снимает служебную шапку панели в начале текста («DeepThink · 12 с», «Размышления:»).
   * @param {string} text
   * @returns {string}
   */
  _stripReasoningHeader(text) {
    try {
      const s = String(text == null ? '' : text).trim();
      return s.replace(
        /^(?:deepthink|deep\s?think|thought|thinking|размышлен[а-яё]*|思考)\s*(?:[·:•\-–—]\s*\d+\s*(?:с|s|sec|сек|seconds?)?)?\s*[:·]?\s*/i,
        ''
      ).trim();
    } catch (e) { return String(text == null ? '' : text).trim(); }
  }
  /**
   * Текст панели размышлений узла (сама панель либо вложенные think-узлы),
   * склеенный пустой строкой; пустые/служебные части отброшены.
   * @param {Element} element
   * @returns {string}
   */
  _reasoningText(element) {
    try {
      if (!element) return '';
      /** @type {Node[]} */
      const nodes = [];
      if (this._isInsideReasoning(element)) {
        nodes.push(element);
      } else if (typeof element.querySelectorAll === 'function') {
        const found = element.querySelectorAll(this._thinkSelector());
        for (let i = 0; i < found.length; i++) nodes.push(found[i]);
      }
      const parts = [];
      for (let j = 0; j < nodes.length; j++) {
        const text = this._stripReasoningHeader(nodes[j].textContent);
        if (text && this._hasRealContent(text)) parts.push(text);
      }
      return parts.join('\n\n').trim();
    } catch (e) { return ''; }
  }
  // Артефакт интерфейса («.» свёрнутой панели) — не сообщение: в сообщении должна быть
  // хотя бы одна буква или цифра. Формат текста при этом не трогаем.
  /**
   * Есть ли в тексте реальные символы (буква/цифра), а не только артефакт интерфейса
   * вроде «.» свёрнутой панели.
   * @param {string} text
   * @returns {boolean}
   */
  _hasRealContent(text) {
    return /[0-9A-Za-z\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF]/.test(String(text == null ? '' : text));
  }
  /**
   * Первый дочерний узел с текстом, годный как текст хода (без avatar/button/icon,
   * без панелей размышлений), иначе null.
   * @param {Element} element
   * @returns {Element|null}
   */
  _firstContentChild(element) {
    try {
      const candidates = element.querySelectorAll(
        'div:not([class*="avatar"]):not([class*="button"]):not([class*="icon"])'
      );
      for (let i = 0; i < candidates.length; i++) {
        if (this._isInsideReasoning(candidates[i])) continue;
        return candidates[i];
      }
    } catch (e) { swallow(e, 'adapter:deepseek:firstContentChild'); }
    return null;
  }

  /**
   * Роль хода по разметке узла.
   *
   * Возвращаем string, а не литеральный union 'user'|'assistant': пока тип узкий,
   * tsc (TS2367) считает проверки `role !== 'unknown'` в extractMessages
   * (строки 219 и 236) заведомо ложными. Эти проверки — НАМЕРЕННЫЙ детектор дрейфа
   * предиката (см. комментарий O-21 у них), и удалять их нельзя: они должны
   * «ожить», если _detectRole снова начнёт отдавать 'unknown'. Тип string оставляет
   * гейт живым и типизирует функцию честно — она отдаёт произвольную строку роли.
   * TODO: уточнить тип в шаге 5 (контракт ролей адаптера).
   * @param {Element} element
   * @returns {string}
   */
  _detectRole(element) {
    const classes = element.className || '';
    if (classes.includes('d29f3d7d')) return 'user';
    if (classes.includes('ds-markdown') || classes.includes('ds-assistant-message')) return 'assistant';
    try {
      if (element.querySelector && element.querySelector('.ds-markdown, .ds-markdown-paragraph')) return 'assistant';
      if (this._isReasoningOnly(element)) return 'assistant';
    } catch (e) { swallow(e, 'adapter:deepseek:detectRole'); }
    // v2 (O-15): хеш-класс пузыря пользователя ротируется (d29f3d7d устарел), а роль
    // 'unknown' отбрасывалась в extractMessages — реплики пользователя исчезали из
    // live-экспорта. Не-assistant-подобный пузырь — реплика пользователя.
    return 'user';
  }

  /**
   * Текст хода: markdown-абзацы ответа построчно, иначе первый текстовый узел
   * пузыря без панелей размышлений.
   * @param {Element} element
   * @returns {string}
   */
  _extractText(element) {
    // Ответ ассистента — markdown-рендер (абзацы построчно; панель размышлений внутри
    // того же пузыря в текст не входит).
    const markdown = this._answerMarkdown(element);
    if (markdown) {
      const paragraphs = markdown.querySelectorAll('.ds-markdown-paragraph, p');
      if (paragraphs.length > 0) {
        return Array.from(paragraphs).map(p => p.textContent.trim()).filter(Boolean).join('\n');
      }
    }
    const textChild = this._firstContentChild(element);
    if (textChild) return this._textWithoutReasoning(textChild);
    return this._textWithoutReasoning(element);
  }

  /**
   * Ходы диалога из DOM (v2/O-15 + O-7 + O-21).
   *
   * Узлы-панели reasoning сообщениями НЕ являются: их текст переносится в
   * hiddenReasoning ближайшего assistant-хода (висячий — предыдущего, иначе
   * последнего). Возвращает пустой массив при ошибке.
   * @returns {DeepSeekExtractedMessage[]}
   */
  extractMessages() {
    try {
      /**
       * Накопленные ходы. Поля hiddenReasoning нет в контракте ExtractedMessage
       * (types/adapter.d.ts — форма {role, content}), поэтому элементы здесь
       * расширяют её на поле захвата reasoning.
       * @type {(DeepSeekExtractedMessage & {hiddenReasoning?: string})[]}
       */
      const messages = [];
      const messageElements = document.querySelectorAll('div[class*="ds-message"]');
      // ===== O-21 (ДИАГНОСТИКА, только измерение): усечение DOM-экстрактора DeepSeek =====
      // Живой симптом: под соседним расширением (Better DeepSeek) DOM отдавал msgs=3 при
      // сетевых msgs=6. Живые артефакты утеряны, механизм — неподтверждённая гипотеза,
      // поэтому здесь ТОЛЬКО счётчики и сэмплы: ни одна ветка extractMessages не меняется,
      // messages/роли/hiddenReasoning побайтово прежние. Гейт — канонический
      // utils/debug.js:aiCmDiagOn (sessionStorage 'aiCmDebug' === '1' ИЛИ чекбокс «Подробные
      // логи» → window.__aiCmDebugLogs). Гейт выключен → счётчики не считаются вовсе
      // (нулевой оверхед) и не печатается ни одной строки.
      // typeof-гарды — конвенция срез-песочниц тестов: адаптер грузится без utils/debug.js,
      // там хелперов нет → o21Stats === null → поведение прежнее 1:1.
      const o21DiagOn = (typeof aiCmDiagOn === 'function') ? aiCmDiagOn() : false;
      const o21Stats = o21DiagOn ? {
        totalFound: messageElements.length,
        extracted: 0,
        skippedNested: 0,
        skippedReasoningOnly: 0,
        skippedEmpty: 0,
        skippedUnknown: 0,
        skippedNoRealContent: 0,
        classesSample: [],
        neighborInjections: []
      } : null;
      if (o21Stats) {
        // Детекция инъекций соседа (Better DeepSeek): только наличие маркеров в первых 50 КБ
        // HTML документа. В текст/базу/экспорт значение не идёт — это измерение факта.
        try {
          const o21Markers = ['BetterDeepSeek', 'BDS:', 'better-deepseek', 'bds-'];
          const o21Root = (typeof document !== 'undefined') ? (document.documentElement || document.body) : null;
          const o21Html = o21Root ? String(o21Root.innerHTML || '').slice(0, 50000) : '';
          for (let m = 0; m < o21Markers.length; m++) {
            if (o21Html.indexOf(o21Markers[m]) !== -1) o21Stats.neighborInjections.push(o21Markers[m]);
          }
        } catch (eO21inj) { }
      }
      // O-7: «висячий» reasoning отдельного узла (assistant-узел только с THINK) — не
      // сообщение (v2/O-15), но его текст НЕ теряется: приклеивается к следующему
      // assistant-ходу, а если следующего нет — к предыдущему. Та же парность, что у
      // сетевого перехватчика (v9/O-15: pendingReasoning), и только в hiddenReasoning —
      // базовый текст/роли/состав сообщений не меняются.
      let pendingReasoning = '';
      messageElements.forEach((element, idx) => {
        // O-21: сэмпл классов первых трёх узлов — классы DeepSeek ротируются, сэмпл нужен,
        // чтобы по живому логу увидеть, что именно попало в выборку. Чтение, без записи.
        if (o21Stats && idx < 3) {
          o21Stats.classesSample.push(String(element.className || '').slice(0, 60));
        }
        if (element.className?.includes('ds-markdown') && element.parentElement?.className?.includes('ds-message')) {
          if (o21Stats) o21Stats.skippedNested++;
          return;
        }
        // v2 (O-15): панель reasoning — не сообщение хода (текст reasoning приходит
        // секцией [REASONING] из сетевого перехватчика вместе с ответом).
        if (this._isReasoningOnly(element)) {
          if (o21Stats) o21Stats.skippedReasoningOnly++;
          const orphanReasoning = this._reasoningText(element);
          if (orphanReasoning) {
            pendingReasoning = pendingReasoning ? (pendingReasoning + '\n\n' + orphanReasoning) : orphanReasoning;
          }
          return;
        }
        const role = this._detectRole(element);
        const content = this._extractText(element);
        if (content && content.length > 0 && role !== 'unknown' && this._hasRealContent(content)) {
          const msg = { role, content };
          // O-7: hidden-захват reasoning — рядом с текстом, в content НЕ входит.
          if (role === 'assistant') {
            const ownReasoning = this._reasoningText(element);
            const hiddenReasoning = [pendingReasoning, ownReasoning].filter(Boolean).join('\n\n').trim();
            if (hiddenReasoning) msg.hiddenReasoning = hiddenReasoning;
            pendingReasoning = '';
          }
          messages.push(msg);
          if (o21Stats) o21Stats.extracted++;
        } else if (o21Stats) {
          // O-21: причина пропуска — ПОВТОР предиката, только ради счётчика. Ветка недостижима
          // при true-предикате и ничего не делает с messages: поток не меняется. Конъюнкт
          // role !== 'unknown' оставлен зеркалом предиката (сейчас _detectRole 'unknown' не
          // возвращает — счётчик работает детектором дрейфа предиката).
          if (!content || content.length === 0) o21Stats.skippedEmpty++;
          else if (role === 'unknown') o21Stats.skippedUnknown++;
          else o21Stats.skippedNoRealContent++;
        }
      });
      // Висячий reasoning в конце ленты — к последнему assistant-ходу (отдельного хода нет).
      if (pendingReasoning) {
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role !== 'assistant') continue;
          messages[i].hiddenReasoning = messages[i].hiddenReasoning
            ? (messages[i].hiddenReasoning + '\n\n' + pendingReasoning)
            : pendingReasoning;
          break;
        }
      }
      if (messages.length > 0) {
        debugLog('log', `[DeepSeekAdapter] Извлечено ${messages.length} сообщений, роли: ${messages.map(m => m.role.substring(0, 4)).join(', ')}`);
      }
      // O-21: печать счётчиков каноническим хелпером utils/debug.js:aiCmDiagLine — тот же
      // гейт aiCmDebug, та же форма k=v, канон-префикс '[AI CM][diag] o21-dom-extract'.
      // Хелпера нет (срез-песочница тестов) → ни одной строки, поведение прежнее 1:1.
      if (o21Stats && typeof aiCmDiagLine === 'function') {
        try {
          aiCmDiagLine('o21-dom-extract', {
            site: this.siteName || 'deepseek',
            totalFound: o21Stats.totalFound,
            extracted: o21Stats.extracted,
            skipNested: o21Stats.skippedNested,
            skipReasoningOnly: o21Stats.skippedReasoningOnly,
            skipEmpty: o21Stats.skippedEmpty,
            skipUnknown: o21Stats.skippedUnknown,
            skipNoRealContent: o21Stats.skippedNoRealContent,
            classesSample: o21Stats.classesSample.join(' | ') || '(нет)',
            neighborInjections: o21Stats.neighborInjections.join(',') || '(нет)'
          });
        } catch (eO21line) { }
      }
      return messages;
    } catch (error) {
      debugLog('error', '[DeepSeekAdapter] Ошибка:', error);
      return [];
    }
  }

  /**
   * Полный текст диалога: содержимое ходов, склеенное переводом строки.
   * @returns {string}
   */
  getFullDialogText() {
    return this.extractMessages().map(msg => msg.content).join('\n');
  }

  /**
   * Модель: DeepThink (R1) по aria-pressed, затем UI-селекторы, затем localStorage,
   * иначе 'deepseek-v3'.
   * @returns {string}
   */
  detectModel() {
    try {
      // Проверяем активность DeepThink (R1) по aria-pressed
      const deepThinkBtn = document.querySelector(
        'div.ds-toggle-button[aria-pressed="true"], div[class*="toggle-button"][aria-pressed="true"]'
      );
      if (deepThinkBtn && deepThinkBtn.textContent.includes('DeepThink')) {
        debugLog('log', '[DeepSeekAdapter] DeepThink активен → R1');
        return 'deepseek-r1';
      }

      // Проверяем модель в интерфейсе
      const modelSelectors = [
        '.model-selector', '.current-model', '[class*="model-switch"]',
        '.model-name', 'select[name="model"]', '[aria-label*="model"]'
      ];
      for (const selector of modelSelectors) {
        const el = document.querySelector(selector);
        if (el) {
          // options/selectedIndex есть только у HTMLSelectElement, а querySelector
          // по строке даёт Element (TS2339). Тег уже проверен выше, поэтому
          // сужаем форму узла до SELECT — поведение рантайма не меняется.
          let text = el.tagName === 'SELECT'
            ? (/** @type {HTMLSelectElement} */ (el).options[/** @type {HTMLSelectElement} */ (el).selectedIndex]?.text || '')
            : el.textContent.trim();
          if (text) {
            debugLog('log', '[DeepSeekAdapter] Модель из UI:', text);
            if (text.toLowerCase().includes('r1')) return 'deepseek-r1';
            if (text.toLowerCase().includes('v3')) return 'deepseek-v3';
          }
        }
      }

      // Проверяем localStorage
      const savedModel = localStorage.getItem('deepseek-selected-model') ||
        localStorage.getItem('selected-model');
      if (savedModel) {
        debugLog('log', '[DeepSeekAdapter] Модель из localStorage:', savedModel);
        if (savedModel.toLowerCase().includes('r1')) return 'deepseek-r1';
        if (savedModel.toLowerCase().includes('v3')) return 'deepseek-v3';
      }

      return 'deepseek-v3';
    } catch (error) {
      debugLog('error', '[DeepSeekAdapter] Ошибка в detectModel:', error);
      return 'deepseek-v3';
    }
  }
}
