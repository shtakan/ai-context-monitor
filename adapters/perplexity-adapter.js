/**
 * Адаптер для Perplexity (perplexity.ai).
 * Основной источник данных — сетевой перехватчик (core/perplexity-intercept.js).
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
 * @typedef {import('../types/adapter').ExtractedMessage} PerplexityExtractedMessage
 */

class PerplexityAdapter extends BaseAdapter {
  constructor() {
    super();
    this.siteName = 'perplexity';
    this.defaultModel = 'turbo';
    debugLog('log', '[PerplexityAdapter] Инициализирован');

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
          if (detail && detail.modelSlug && self.siteName === 'perplexity') {
            self._lastNetworkModel = detail.modelSlug;
          }
        });
      } catch (e) {}
    }
  }

  /**
   * Находимся ли мы на диалоге perplexity.ai (хост + префикс /search/ или /thread/).
   * @returns {boolean}
   */
  isOnDialogPage() {
    try {
      var host = window.location.hostname;
      var path = window.location.pathname;
      var result = (host === 'www.perplexity.ai' || host === 'perplexity.ai') &&
        (path.indexOf('/search/') === 0 || path.indexOf('/thread/') === 0);
      debugLog('log', '[PerplexityAdapter] isOnDialogPage: ' + result);
      return result;
    } catch (error) {
      debugLog('error', '[PerplexityAdapter] Ошибка в isOnDialogPage:', error);
      return false;
    }
  }

  /**
   * Запасной DOM-парсинг: всегда пустой (основной источник — сеть).
   * @returns {PerplexityExtractedMessage[]}
   */
  extractMessages() {
    // Запасной DOM-парсинг. Основной источник — сеть (core/perplexity-intercept.js).
    debugLog('log', '[PerplexityAdapter] extractMessages: возвращаю пустой массив (основной источник — сеть)');
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
          debugLog('log', '[PerplexityAdapter] модель из сети: ' + this._lastNetworkModel);
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