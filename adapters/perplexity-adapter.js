/**
 * Адаптер для Perplexity (perplexity.ai).
 * Основной источник данных — сетевой перехватчик (core/perplexity-intercept.js).
 * DOM-адаптер — запасной (страховка).
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
          var detail = ev && ev.detail;
          if (detail && detail.modelSlug && self.siteName === 'perplexity') {
            self._lastNetworkModel = detail.modelSlug;
          }
        });
      } catch (e) {}
    }
  }

  isOnDialogPage() {
    try {
      var host = window.location.hostname;
      var path = window.location.pathname;
      var result = (host === 'www.perplexity.ai' || host === 'perplexity.ai') &&
        (path.indexOf('/search/') === 0 || path.indexOf('/thread/') === 0);
      debugLog('log', '[PerplexityAdapter] isOnDialogPage: ' + result);
      return result;
    } catch (error) {
      console.error('[PerplexityAdapter] Ошибка в isOnDialogPage:', error);
      return false;
    }
  }

  extractMessages() {
    // Запасной DOM-парсинг. Основной источник — сеть (core/perplexity-intercept.js).
    debugLog('log', '[PerplexityAdapter] extractMessages: возвращаю пустой массив (основной источник — сеть)');
    return [];
  }

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

  _cleanText(text) {
    if (!text) return '';
    return text
      .replace(/\s+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}