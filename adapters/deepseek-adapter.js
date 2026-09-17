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

  // ===== v2 (O-15): reasoning DeepSeek — ЧАСТЬ assistant-хода, а не отдельное сообщение =====
  // Панель размышлений в DOM живёт отдельным узлом с классом ds-message* — в живом прогоне
  // это давало «Извлечено 2 сообщений, роли: assi, assi»: пузыри пользователя отбрасывались
  // (роль 'unknown'), а reasoning и ответ уходили двумя assistant-сообщениями (пара
  // user→assistant рвалась, а «.» свёрнутой панели попадала в текст хода как [ANSWER]).
  // Классы DeepSeek ротируются, поэтому признак — комбинация: маркер reasoning + ОТСУТСТВИЕ
  // markdown-рендера ответа (.ds-markdown) внутри узла.
  _thinkSelector() {
    return '[class*="ds-think"], [class*="think-content"], [class*="ds-reason"], [data-testid*="think"]';
  }
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
  _answerMarkdown(element) {
    try {
      if (!element) return null;
      if (String(element.className || '').includes('ds-markdown')) return element;
      const md = (typeof element.querySelector === 'function') ? element.querySelector('.ds-markdown') : null;
      return md || null;
    } catch (e) { return null; }
  }
  // Узел — ТОЛЬКО панель размышлений (ответа в нём нет): сообщением хода не является.
  _isReasoningOnly(element) {
    try {
      if (!element) return false;
      if (this._answerMarkdown(element)) return false;
      return this._hasThinkMarker(element);
    } catch (e) { return false; }
  }
  _isInsideReasoning(element) {
    try {
      if (!element) return false;
      if (/ds-think|think-content|ds-reason/i.test(String(element.className || ''))) return true;
      return (typeof element.closest === 'function') && !!element.closest(this._thinkSelector());
    } catch (e) { return false; }
  }
  // Текст элемента БЕЗ панелей размышлений и служебных кнопок/иконок.
  _textWithoutReasoning(element) {
    try {
      const clone = element.cloneNode(true);
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
  // интерфейс, а не reasoning: снимается ТОЛЬКО в начале текста панели (сам текст остаётся).
  _stripReasoningHeader(text) {
    try {
      const s = String(text == null ? '' : text).trim();
      return s.replace(
        /^(?:deepthink|deep\s?think|thought|thinking|размышлен[а-яё]*|思考)\s*(?:[·:•\-–—]\s*\d+\s*(?:с|s|sec|сек|seconds?)?)?\s*[:·]?\s*/i,
        ''
      ).trim();
    } catch (e) { return String(text == null ? '' : text).trim(); }
  }
  _reasoningText(element) {
    try {
      if (!element) return '';
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
  _hasRealContent(text) {
    return /[0-9A-Za-z\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF]/.test(String(text == null ? '' : text));
  }
  _firstContentChild(element) {
    try {
      const candidates = element.querySelectorAll(
        'div:not([class*="avatar"]):not([class*="button"]):not([class*="icon"])'
      );
      for (let i = 0; i < candidates.length; i++) {
        if (this._isInsideReasoning(candidates[i])) continue;
        return candidates[i];
      }
    } catch (e) { }
    return null;
  }

  _detectRole(element) {
    const classes = element.className || '';
    if (classes.includes('d29f3d7d')) return 'user';
    if (classes.includes('ds-markdown') || classes.includes('ds-assistant-message')) return 'assistant';
    try {
      if (element.querySelector && element.querySelector('.ds-markdown, .ds-markdown-paragraph')) return 'assistant';
      if (this._isReasoningOnly(element)) return 'assistant';
    } catch (e) { }
    // v2 (O-15): хеш-класс пузыря пользователя ротируется (d29f3d7d устарел), а роль
    // 'unknown' отбрасывалась в extractMessages — реплики пользователя исчезали из
    // live-экспорта. Не-assistant-подобный пузырь — реплика пользователя.
    return 'user';
  }

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

  extractMessages() {
    try {
      const messages = [];
      const messageElements = document.querySelectorAll('div[class*="ds-message"]');
      // O-7: «висячий» reasoning отдельного узла (assistant-узел только с THINK) — не
      // сообщение (v2/O-15), но его текст НЕ теряется: приклеивается к следующему
      // assistant-ходу, а если следующего нет — к предыдущему. Та же парность, что у
      // сетевого перехватчика (v9/O-15: pendingReasoning), и только в hiddenReasoning —
      // базовый текст/роли/состав сообщений не меняются.
      let pendingReasoning = '';
      messageElements.forEach((element) => {
        if (element.className?.includes('ds-markdown') && element.parentElement?.className?.includes('ds-message')) return;
        // v2 (O-15): панель reasoning — не сообщение хода (текст reasoning приходит
        // секцией [REASONING] из сетевого перехватчика вместе с ответом).
        if (this._isReasoningOnly(element)) {
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
