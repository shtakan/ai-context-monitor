/**
 * Адаптер для Claude (claude.ai).
 * Основной источник данных — сетевой перехватчик (core/claude-intercept.js).
 * DOM-адаптер — запасной (страховка).
 *
 * Типизация (шаг 4 Фазы 1): формы — из types/adapter.d.ts. Литеральный `import type`
 * невозможен (файл — классический скрипт контента плюс склейка исходника в
 * new Function() песочницами тестов), поэтому типы подключены JSDoc-ссылкой import().
 */

/**
 * Сообщение в форме адаптера (types/adapter.d.ts).
 *
 * Имя с префиксом сайта — НЕ по вкусу, а по необходимости: файлы адаптеров не
 * являются модулями (обычные скрипты, склеиваемые исходником), поэтому при allowJs
 * все typedef-имена попадают в одну общую область и одноимённые дают TS2300.
 * Настоящее имя типа хранится в types/adapter.d.ts, здесь только ссылка на него.
 * @typedef {import('../types/adapter').ExtractedMessage} ClaudeExtractedMessage
 */

class ClaudeAdapter extends BaseAdapter {
  constructor() {
    super();
    this.siteName = 'claude';
    this.defaultModel = 'claude-sonnet-4-6';
    debugLog('log', '[ClaudeAdapter] Инициализирован');

    // Последняя модель из сетевого ответа (заполняется событием из перехватчика)
    this._lastNetworkModel = '';
    this._modelLogSent = false;

    // Слушаем модель из сетевого перехватчика
    if (typeof window !== 'undefined') {
      var self = this;
      try {
        window.addEventListener('ai-cm-full-history', function (ev) {
          // detail есть только у CustomEvent, а addEventListener типизирует аргумент
          // как Event (TS2339) — сужаем форму через промежуточную переменную, сохраняя
          // прежнюю null-защиту (событие без detail обязано остаться безопасным).
          var evt = /** @type {CustomEvent} */ (ev);
          var detail = evt && evt.detail;
          if (detail && detail.modelSlug && self.siteName === 'claude') {
            self._lastNetworkModel = detail.modelSlug;
          }
        });
      } catch (e) {}
    }
  }

  /**
   * Находимся ли мы на диалоге claude.ai (хост + префикс пути /chat/).
   * @returns {boolean}
   */
  isOnDialogPage() {
    try {
      var host = window.location.hostname;
      var path = window.location.pathname;
      var result = host === 'claude.ai' && path.indexOf('/chat/') === 0;
      debugLog('log', '[ClaudeAdapter] isOnDialogPage: ' + result);
      return result;
    } catch (error) {
      debugLog('error', '[ClaudeAdapter] Ошибка в isOnDialogPage:', error);
      return false;
    }
  }

  /**
   * Запасной DOM-парсинг: всегда пустой (основной источник — сеть).
   * @returns {ClaudeExtractedMessage[]}
   */
  extractMessages() {
    // Запасной DOM-парсинг. Селекторы claude.ai нестабильны (React, нет data-testid).
    // Основной источник — сеть (core/claude-intercept.js).
    debugLog('log', '[ClaudeAdapter] extractMessages: возвращаю пустой массив (основной источник — сеть)');
    return [];
  }

  /**
   * Модель: сначала последняя из сети (точнее), иначе this.defaultModel.
   * @returns {string}
   */
  detectModel() {
    try {
      // Модель из последнего сетевого ответа (наиболее точный источник)
      if (this._lastNetworkModel) {
        if (!this._modelLogSent) {
          this._modelLogSent = true;
          debugLog('log', '[ClaudeAdapter] модель из сети: ' + this._lastNetworkModel);
        }
        return this._lastNetworkModel;
      }
    } catch (e) {}

    return this.defaultModel;
  }

  /**
   * Нормализация текста хода (схлопывание пробелов и пустых строк).
   * @param {string} text
   * @returns {string}
   */
  _cleanText(text) {
    if (!text) return '';
    return text
      .replace(/\s+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}