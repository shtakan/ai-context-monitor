class GeminiAdapter extends BaseAdapter {
  constructor() {
    super();
    this.siteName = 'gemini';
    this.defaultModel = 'Gemini 2.5 Pro';
    debugLog('log', '[GeminiAdapter] Инициализирован');
  }

  isOnDialogPage() {
    try {
      const hasMessages = document.querySelector('.conversation-container') !== null;
      const hasInput = document.querySelector('rich-textarea, .input-area') !== null;
      const result = hasMessages || hasInput;
      debugLog('log', `[GeminiAdapter] isOnDialogPage: ${result}`);
      return result;
    } catch (error) {
      console.error('[GeminiAdapter] Ошибка в isOnDialogPage:', error);
      return false;
    }
  }

  extractMessages() {
    try {
      const messages = [];

      const turnContainers = document.querySelectorAll('turn-container, .turn-container, [data-turn]');

      debugLog('log', `[GeminiAdapter] Найдено turn-контейнеров: ${turnContainers.length}`);

      if (turnContainers.length > 0) {
        turnContainers.forEach((turn, index) => {
          try {
            const userMessage = turn.querySelector('.user-query, [data-role="user"], .user-turn .query-text');
            if (userMessage) {
              const content = this._cleanText(userMessage.textContent);
              if (content.length > 0) {
                messages.push({ role: 'user', content });
              }
            }

            const assistantMessage = turn.querySelector('.model-response, [data-role="model"], .response-content, .assistant-turn .markdown');
            if (assistantMessage) {
              const content = this._cleanText(assistantMessage.textContent);
              if (content.length > 0) {
                messages.push({ role: 'assistant', content });
              }
            }
          } catch (turnError) {
            console.error(`[GeminiAdapter] Ошибка обработки turn #${index}:`, turnError);
          }
        });
      }

      if (messages.length === 0) {
        debugLog('log', '[GeminiAdapter] Использую запасной метод поиска сообщений');

        const userMessages = document.querySelectorAll('.user-query, .query-text, [data-role="user"]');
        userMessages.forEach(msg => {
          const content = this._cleanText(msg.textContent);
          if (content.length > 0) {
            messages.push({ role: 'user', content });
          }
        });

        const assistantMessages = document.querySelectorAll('.model-response, .response-content, [data-role="model"]');
        assistantMessages.forEach(msg => {
          const content = this._cleanText(msg.textContent);
          if (content.length > 0) {
            messages.push({ role: 'assistant', content });
          }
        });
      }

      debugLog('log', `[GeminiAdapter] Всего извлечено сообщений: ${messages.length}`);
      return messages;

    } catch (error) {
      console.error('[GeminiAdapter] Ошибка в extractMessages:', error);
      return [];
    }
  }

  detectModel() {
    try {
      const modelIndicator = document.querySelector('.model-name, .current-model, [aria-label*="model"]');

      if (modelIndicator) {
        const modelText = modelIndicator.textContent.trim();
        debugLog('log', `[GeminiAdapter] Обнаружена модель: ${modelText}`);
        return modelText || this.defaultModel;
      }

      const savedModel = localStorage.getItem('gemini-selected-model');
      if (savedModel) {
        debugLog('log', `[GeminiAdapter] Модель из localStorage: ${savedModel}`);
        return savedModel;
      }

      debugLog('log', `[GeminiAdapter] Использую модель по умолчанию: ${this.defaultModel}`);
      return this.defaultModel;

    } catch (error) {
      console.error('[GeminiAdapter] Ошибка в detectModel:', error);
      return this.defaultModel;
    }
  }

  _cleanText(text) {
    if (!text) return '';
    return text
      .replace(/\s+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}