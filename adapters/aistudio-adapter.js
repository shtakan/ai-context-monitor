/**
 * Адаптер для Google AI Studio (aistudio.google.com).
 *
 * Почему отдельный класс, а не ветка GeminiAdapter: разметка реплик у AI Studio
 * другая. Ходы диалога — это <ms-cmark-node class="cmark-node v3-font-body">,
 * роль закодирована классом `user-chunk` у реплики пользователя (у ответа модели
 * этого класса нет). Селекторы Gemini (.conversation-container, turn-container,
 * .user-query, .model-response) на этой странице не находятся, поэтому штатный
 * GeminiAdapter извлекал 0 сообщений — бейдж токенов молчал.
 *
 * Наследование от GeminiAdapter даёт контракт BaseAdapter и общую нормализацию
 * текста (_cleanText); переопределено только то, что у AI Studio другое.
 *
 * Типизация (шаг 4 Фазы 1): формы — из types/adapter.d.ts. Литеральный `import type`
 * невозможен (файл — классический скрипт контента плюс склейка исходника в
 * new Function() песочницами тестов), поэтому типы подключены JSDoc-ссылкой import().
 */

/**
 * Имя с префиксом сайта — по необходимости: файлы адаптеров не являются модулями,
 * поэтому при allowJs все typedef-имена попадают в одну общую область.
 * @typedef {import('../types/adapter').ExtractedMessage} AistudioExtractedMessage
 */

class AistudioAdapter extends GeminiAdapter {
  constructor() {
    super();
    this.siteName = 'aistudio';
    this.defaultModel = 'gemini-3.1-pro';
    debugLog('log', '[AistudioAdapter] Инициализирован');
  }

  /**
   * Находимся ли мы на диалоге: признак — узлы реплик ms-cmark-node.
   * @returns {boolean}
   */
  isOnDialogPage() {
    try {
      const hasMessageNodes = document.querySelector('ms-cmark-node') !== null;
      debugLog('log', `[AistudioAdapter] isOnDialogPage: ${hasMessageNodes}`);
      if (hasMessageNodes) return true;
      // Виртуализированная лента: DOM может быть пуст, пока сеть уже отдала историю
      // ($rpc UpdatePrompt/Create → core/aistudio-intercept.js). Без этой ветки
      // processAndSend выходил по «не диалог» и бейдж молчал.
      const netCount = this._netMessages().length;
      if (netCount > 0) {
        debugLog('log', `[AistudioAdapter] isOnDialogPage: true (сеть: ${netCount} сообщений)`);
        return true;
      }
      return false;
    } catch (error) {
      debugLog('error', '[AistudioAdapter] Ошибка в isOnDialogPage:', error);
      return false;
    }
  }

  /**
   * Ходы диалога: все ms-cmark-node.v3-font-body, кроме вложенных в другой
   * ms-cmark-node (иначе текст реплики попал бы в счёт дважды — родитель и ребёнок).
   * Роль: класс user-chunk → 'user', иначе — 'assistant'.
   * @returns {AistudioExtractedMessage[]}
   */
  extractMessages() {
    try {
      // Сеть главнее DOM: полная история из $rpc (включая виртуализированные ходы).
      // DOM остаётся фолбэком — как у Claude/Perplexity, где сеть и есть источник.
      const netMessages = this._netMessages();
      if (netMessages.length > 0) {
        debugLog('log', `[AistudioAdapter] История из сети: ${netMessages.length} сообщений (DOM не читаем)`);
        return netMessages;
      }

      /** @type {AistudioExtractedMessage[]} */
      const messages = [];

      const nodes = document.querySelectorAll('ms-cmark-node.v3-font-body');

      debugLog('log', `[AistudioAdapter] Найдено узлов реплик: ${nodes.length}`);

      Array.prototype.forEach.call(nodes, (node, index) => {
        try {
          if (this._isNestedNode(node)) {
            debugLog('log', `[AistudioAdapter] Пропуск вложенного узла #${index}`);
            return;
          }

          const content = this._cleanText(this._readNodeText(node));
          if (content.length === 0) return;

          messages.push({ role: this._isUserChunk(node) ? 'user' : 'assistant', content });
        } catch (nodeError) {
          debugLog('error', `[AistudioAdapter] Ошибка обработки узла #${index}:`, nodeError);
        }
      });

      debugLog('log', `[AistudioAdapter] Всего извлечено сообщений: ${messages.length}`);
      return messages;

    } catch (error) {
      debugLog('error', '[AistudioAdapter] Ошибка в extractMessages:', error);
      return [];
    }
  }

  /**
   * Модель AI Studio: в DOM нет стабильного индикатора, распознавание не делаем —
   * возвращаем фолбэк (ключ есть в utils/model-config.js, окно 128k). Заглушка:
   * при появлении разметки переключателя модели сюда добавляется разбор DOM.
   * @returns {string}
   */
  detectModel() {
    return 'gemini-3.1-pro';
  }

  /**
   * Сетевая история AI Studio: снимок, который MAIN-перехватчик
   * (core/aistudio-intercept.js) положил в ISOLATED-мир через core/content.js
   * (window.__aiCmNetMsgs = { msgs: [{role, text}], count, ts, href }).
   *
   * Снимок принимается только для ТЕКУЩЕГО пути (SPA: AI Studio меняет /prompts/<id>
   * без перезагрузки) — иначе история прошлого разговора питала бы счётчик нового.
   * Нет снимка/путь не тот → [] и обычный DOM-парсинг.
   * @returns {AistudioExtractedMessage[]}
   */
  _netMessages() {
    try {
      const raw = (typeof window !== 'undefined') ? window.__aiCmNetMsgs : null;
      if (!raw || !Array.isArray(raw.msgs) || raw.msgs.length === 0) return [];
      const here = String((window.location && window.location.pathname) || '');
      const there = String(raw.href || '');
      if (there && typeof URL === 'function') {
        let therePath = there;
        try { therePath = new URL(there).pathname; } catch (eUrl) { therePath = there; }
        if (therePath && here && therePath !== here) return [];
      }
      /** @type {AistudioExtractedMessage[]} */
      const messages = [];
      Array.prototype.forEach.call(raw.msgs, (m) => {
        if (!m || typeof m.text !== 'string') return;
        const content = this._cleanText(m.text);
        if (content.length === 0) return;
        messages.push({ role: (m.role === 'assistant' || m.role === 'model') ? 'assistant' : 'user', content });
      });
      return messages;
    } catch (error) {
      debugLog('error', '[AistudioAdapter] Ошибка чтения сетевой истории:', error);
      return [];
    }
  }

  /**
   * Текст узла реплики. innerText предпочтителен (видимый текст, как в браузере);
   * textContent — фолбэк для окружений без innerText (jsdom, песочницы тестов).
   * @param {Element} node
   * @returns {string}
   */
  _readNodeText(node) {
    try {
      // innerText объявлен только у HTMLElement, а JSDoc-тип параметра — Element
      // (node приходит из querySelectorAll по ms-cmark-node): приводим тип, не меняя рантайм.
      const inner = (/** @type {HTMLElement} */ (node)).innerText;
      if (typeof inner === 'string' && inner.length > 0) return inner;
      return typeof node.textContent === 'string' ? node.textContent : '';
    } catch (error) {
      debugLog('error', '[AistudioAdapter] Ошибка чтения текста узла:', error);
      return '';
    }
  }

  /**
   * Вложенный ли узел: у него есть предок ms-cmark-node (текст уже учтён предком).
   * @param {Element} node
   * @returns {boolean}
   */
  _isNestedNode(node) {
    try {
      const parent = node && node.parentElement;
      if (!parent || typeof parent.closest !== 'function') return false;
      return parent.closest('ms-cmark-node') !== null;
    } catch (error) {
      debugLog('error', '[AistudioAdapter] Ошибка проверки вложенности:', error);
      return false;
    }
  }

  /**
   * Реплика пользователя? В AI Studio её единственный признак — класс user-chunk.
   * @param {Element} node
   * @returns {boolean}
   */
  _isUserChunk(node) {
    try {
      return !!(node && node.classList && node.classList.contains('user-chunk'));
    } catch (error) {
      debugLog('error', '[AistudioAdapter] Ошибка чтения classList:', error);
      return false;
    }
  }
}

// Экспортируем для использования в других скриптах
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AistudioAdapter;
}
