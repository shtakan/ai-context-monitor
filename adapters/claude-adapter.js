/**
 * Адаптер для Claude (claude.ai).
 * Основной источник данных — сетевой перехватчик (core/claude-intercept.js).
 * DOM-адаптер — запасной (страховка).
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
          var detail = ev && ev.detail;
          if (detail && detail.modelSlug && self.siteName === 'claude') {
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
      var result = host === 'claude.ai' && path.indexOf('/chat/') === 0;
      debugLog('log', '[ClaudeAdapter] isOnDialogPage: ' + result);
      return result;
    } catch (error) {
      console.error('[ClaudeAdapter] Ошибка в isOnDialogPage:', error);
      return false;
    }
  }

  extractMessages() {
    // Запасной DOM-парсинг. Селекторы claude.ai нестабильны (React, нет data-testid).
    // Основной источник — сеть (core/claude-intercept.js).
    debugLog('log', '[ClaudeAdapter] extractMessages: возвращаю пустой массив (основной источник — сеть)');
    return [];
  }

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

  _cleanText(text) {
    if (!text) return '';
    return text
      .replace(/\s+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}