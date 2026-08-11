/**
 * Реестр адаптеров.
 * Связывает домены сайтов с соответствующими адаптерами.
 * 
 * Паттерн: Registry (Реестр)
 * Позволяет легко добавлять новые сайты.
 */
const AdapterRegistry = {
  // Карта: домен -> класс адаптера
  _adapters: new Map(),
  
  // Зарегистрированные домены
  _domains: {
    'chatgpt': 'chatgpt.com',
    'gemini': 'gemini.google.com',
    'deepseek': 'chat.deepseek.com',
    'aistudio': 'aistudio.google.com',
    'google_search': 'google.com'
  },

  /**
   * Регистрирует адаптер для указанного сайта.
   * @param {string} siteKey - ключ сайта
   * @param {BaseAdapter} adapterInstance - экземпляр адаптера
   */
  register(siteKey, adapterInstance) {
    this._adapters.set(siteKey, adapterInstance);
    debugLog('log', 'AdapterRegistry: Зарегистрирован адаптер для', siteKey);
  },

  /**
   * Определяет ключ сайта по текущему URL.
   * @returns {string|null}
   */
  detectSite() {
    const hostname = window.location.hostname;
    
    if (hostname.includes('chatgpt.com')) return 'chatgpt';
    if (hostname.includes('gemini.google.com')) return 'gemini';
    if (hostname.includes('chat.deepseek.com')) return 'deepseek';
    if (hostname.includes('aistudio.google.com')) return 'aistudio';
    if (hostname.includes('google.com')) return 'google_search';
    
    return null;
  },

  /**
   * Возвращает адаптер для текущего сайта.
   * @returns {BaseAdapter|null}
   */
  getAdapter() {
    const site = this.detectSite();
    
    if (!site) {
      console.warn('AdapterRegistry: Сайт не поддерживается');
      return null;
    }
    
    const adapter = this._adapters.get(site);
    
    if (!adapter) {
      console.warn('AdapterRegistry: Адаптер для', site, 'не зарегистрирован');
      return null;
    }
    
    return adapter;
  },

  /**
   * Проверяет, поддерживается ли текущий сайт.
   * @returns {boolean}
   */
  isSupported() {
    return this.getAdapter() !== null;
  }
};

// Экспорт
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AdapterRegistry;
}