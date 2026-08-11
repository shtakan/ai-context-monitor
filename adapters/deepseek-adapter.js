class DeepSeekAdapter extends BaseAdapter {
  constructor() {
    super();
    this.siteName = 'deepseek';
    debugLog('log', '[DeepSeekAdapter] Инициализирован');
  }

  isOnDialogPage() {
    const hasMessages = document.querySelectorAll('div[class*="ds-message"]').length > 0;
    const hasInput = document.querySelector('textarea') !== null;
    return hasMessages || hasInput;
  }

  // loadFullHistory удалён в v1.1 — скролл-пагинация противоречит архитектуре server-first
  // (основной источник данных — перехват сети). Метод не вызывался ни из одного файла.

  _detectRole(element) {
    const classes = element.className || '';
    if (classes.includes('d29f3d7d')) return 'user';
    if (classes.includes('ds-message') && !classes.includes('d29f3d7d')) return 'assistant';
    if (classes.includes('ds-markdown') || classes.includes('ds-assistant-message')) return 'assistant';
    return 'unknown';
  }

  _extractText(element) {
    if (element.className?.includes('ds-markdown')) {
      const paragraphs = element.querySelectorAll('.ds-markdown-paragraph, p');
      if (paragraphs.length > 0) {
        return Array.from(paragraphs).map(p => p.textContent.trim()).join('\n');
      }
    }
    const textChild = element.querySelector('div:not([class*="avatar"]):not([class*="button"]):not([class*="icon"])');
    if (textChild) return textChild.textContent.trim();
    const clone = element.cloneNode(true);
    clone.querySelectorAll('button, svg, [class*="avatar"], [class*="icon"], [class*="toolbar"]')
      .forEach(el => el.remove());
    return clone.textContent.trim();
  }

  extractMessages() {
    try {
      const messages = [];
      const messageElements = document.querySelectorAll('div[class*="ds-message"]');
      messageElements.forEach((element) => {
        if (element.className?.includes('ds-markdown') && element.parentElement?.className?.includes('ds-message')) return;
        const role = this._detectRole(element);
        const content = this._extractText(element);
        if (content && content.length > 0 && role !== 'unknown') {
          messages.push({ role, content });
        }
      });
      if (messages.length > 0) {
        debugLog('log', `[DeepSeekAdapter] Извлечено ${messages.length} сообщений, роли: ${messages.map(m => m.role.substring(0, 4)).join(', ')}`);
      }
      return messages;
    } catch (error) {
      console.error('[DeepSeekAdapter] Ошибка:', error);
      return [];
    }
  }

  getFullDialogText() {
    return this.extractMessages().map(msg => msg.content).join('\n');
  }

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
          let text = el.tagName === 'SELECT'
            ? el.options[el.selectedIndex]?.text || ''
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
      console.error('[DeepSeekAdapter] Ошибка в detectModel:', error);
      return 'deepseek-v3';
    }
  }
}