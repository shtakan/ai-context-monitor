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
      // v2.0.34: виртуализированная лента после схлопывания короче уже виденного
      // пика. Пик пишет core/content.js (dom-peak/сетевой кэш) — берём его, иначе
      // экспорт теряет начало разговора.
      const peak = this._domPeakMessages();
      if (peak.length > messages.length) {
        debugLog('log', `[AistudioAdapter] DOM короче пика: ${messages.length} < ${peak.length} — берём sessionStorage`);
        return peak;
      }
      return messages;

    } catch (error) {
      debugLog('error', '[AistudioAdapter] Ошибка в extractMessages:', error);
      return [];
    }
  }

  /**
   * Модель AI Studio (v2.0.32).
   *
   * ДО ЧЕГО БЫЛО: константа 'gemini-3.1-pro'. Бейдж называл её и после того, как студия
   * переключилась на 'Gemini 3.8 Flash' — расхождение с самой студией читается как дефект.
   *
   * ОТКУДА ТЕПЕРЬ. Тело запроса GenerateContent всегда несёт model: models/<slug>, поэтому
   * перехватчик (core/aistudio-intercept.js:modelFromBody) присылает его мостом
   * ai-cm-model-slug, а core/content.js кладёт в window.__aiCmNetModelSlug (ISOLATED-мир
   * один, отдельного канала не нужно) и в кэш истории — значит после F5 фолбэка в константу
   * уже не будет.
   *
   * ПОЧЕМУ НЕ DOM. Индикатор модели в панели Run settings не имеет стабильного класса, а
   * текстовая догадка по «Gemini <версия> <семейство>» ловила бы упоминания модели в самой
   * реплике и подписывала чат чужой моделью. Сеть — единственный недвусмысленный источник.
   * @returns {string}
   */
  detectModel() {
    try {
      const slug = (typeof window !== 'undefined') ? window.__aiCmNetModelSlug : '';
      if (typeof slug === 'string' && slug) {
        debugLog('log', `[AistudioAdapter] Модель из сети: ${slug}`);
        return slug;
      }
    } catch (error) {
      debugLog('error', '[AistudioAdapter] Ошибка чтения модели из сети:', error);
    }
    // Фолбэк прежний (ключ есть в utils/model-config.js, окно 128k): сеть ещё не говорила.
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
        // sections/files не входят в ambient-тип __aiCmNetMsgs (types/ не трогаем).
        const rec = /** @type {any} */ (m);
        if (!rec || typeof rec.text !== 'string') return;
        const sections = (typeof rec.sections === 'string') ? rec.sections : '';
        // Секции дописываются ПОСЛЕ _cleanText: иначе он схлопнет переводы
        // строк в теле markdown-файла (plan-aistudio-files.md §4).
        const content = this._cleanText(rec.text) + sections;
        if (content.length === 0) return;
        messages.push({ role: (rec.role === 'assistant' || rec.role === 'model') ? 'assistant' : 'user', content });
      });
      return messages;
    } catch (error) {
      debugLog('error', '[AistudioAdapter] Ошибка чтения сетевой истории:', error);
      return [];
    }
  }

  /**
   * Пик истории из sessionStorage (v2.0.34): после схлопывания виртуализированной
   * ленты DOM короче уже виденного снимка. core/content.js пишет пик в
   * ai_cm_aistudio_history_<convId> ({ v, href, msgs, count, ... }) — читаем его
   * только для ТЕКУЩЕГО пути (SPA-гард, как у _netMessages) и только как фолбэк.
   * @returns {AistudioExtractedMessage[]}
   */
  _domPeakMessages() {
    try {
      const storage = (typeof sessionStorage !== 'undefined' && sessionStorage)
        ? sessionStorage
        : ((typeof window !== 'undefined' && window && window.sessionStorage) ? window.sessionStorage : null);
      if (!storage) return [];
      const here = String((window.location && window.location.pathname) || '');
      const m = /\/prompts\/([^\/?#]+)/.exec(here);
      if (!m || !m[1]) return [];
      const raw = storage.getItem('ai_cm_aistudio_history_' + m[1]);
      if (!raw) return [];
      const cached = JSON.parse(raw);
      if (!cached || cached.v !== 1 || !Array.isArray(cached.msgs) || cached.msgs.length === 0) return [];
      // Запись обязана относиться к текущему пути, а не к прошлому чату (SPA).
      const there = String(cached.href || '');
      if (there && typeof URL === 'function') {
        let therePath = there;
        try { therePath = new URL(there).pathname; } catch (eUrl) { therePath = there; }
        if (therePath && here && therePath !== here) return [];
      }
      /** @type {AistudioExtractedMessage[]} */
      const messages = [];
      Array.prototype.forEach.call(cached.msgs, (msg) => {
        // Пик истории — тот же формат, что и сетевой снимок: sections/files
        // не входят в ambient-тип, поэтому локальный any-каст.
        const rec = /** @type {any} */ (msg);
        if (!rec || typeof rec.text !== 'string') return;
        const sections = (typeof rec.sections === 'string') ? rec.sections : '';
        const content = this._cleanText(rec.text) + sections;
        if (content.length === 0) return;
        messages.push({ role: (rec.role === 'assistant' || rec.role === 'model') ? 'assistant' : 'user', content });
      });
      return messages;
    } catch (error) {
      debugLog('error', '[AistudioAdapter] Ошибка чтения пика истории:', error);
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
