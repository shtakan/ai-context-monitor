/**
 * adapters/qwen-adapter.js — DOM-адаптер chat.qwen.ai (O-35, вариант A + C-lite).
 *
 * РОЛЬ: ФОЛБЭК. Основной источник — live-SSE из core/qwen-intercept.js (точные токены и
 * тексты). Адаптер включается, когда сетевого снимка нет: clone() не удался, стрим оборвался,
 * либо страница отрисовала историю без нового запроса (открытие готового чата). Даёт базу
 * текстов/ходов, чтобы бейдж и экспорт не пустели (в content.js база ставится только при
 * непустом detail.text — см. гард `if (!detail || !detail.text) return;`).
 *
 * СЕЛЕКТОРЫ — HYPOTHESIS (живой DOM chat.qwen.ai не снимался; сниффер 2026-09-18 работал
 * только по сети). Поэтому:
 *   - опорный и ЖИВОЙ признак — textarea[placeholder*="Qwen"] (подтверждён: «Спросить Qwen»)
 *     и адрес /c/<id>;
 *   - контейнеры сообщений ищутся по СПИСКУ кандидатов (data-атрибуты → aria → классы-токены
 *     qwen/message/chat-*), первый непустой набор выигрывает; роли — по data-атрибуту,
 *     иначе по порядку/признаку «пузыря пользователя»;
 *   - блок размышлений («Завершено размышление» / thinking) распознаётся по маркеру в
 *     НАЧАЛЕ текста узла (как _stripReasoningHeader у DeepSeek) и уходит в hiddenReasoning,
 *     а не в content.
 * При живой приёмке список кандидатов уточняется без смены интерфейса адаптера.
 *
 * Наследник BaseAdapter: isOnDialogPage / extractMessages / getFullDialogText обязательны
 * (базовый getFullDialogText склеивает content через '\n' — здесь явное переопределение).
 *
 * O-36.2 (ФИКС): узлы-КОНТЕЙНЕРЫ всего чата снимаются ВНУТРИ extractMessages тем же
 * правилом, что уже экспортировано сборщиками (utils/export-text-builders.js:
 * aiCmDropContainerMessages/aiCmContainerRules) — ни логика, ни её пороги здесь не
 * дублируются. Вторая ступень (та же чистка на выходе экспорта) остаётся и идемпотентна.
 */
class QwenAdapter extends BaseAdapter {
  constructor() {
    super();
    this.siteName = 'qwen';
    this.dialogContainerSelector = '#chat-container, [class*="chat-container"], main';

    // HYPOTHESIS: кандидаты контейнеров одного сообщения (порядок = приоритет).
    this.userMessageSelector = [
      '[data-message-role="user"]',
      '[data-role="user"]',
      '[class*="user-message"]',
      '[class*="message-user"]'
    ].join(', ');
    this.modelMessageSelector = [
      '[data-message-role="assistant"]',
      '[data-role="assistant"]',
      '[class*="assistant-message"]',
      '[class*="message-assistant"]'
    ].join(', ');

    // HYPOTHESIS: узлы сообщений (общий список — роли разбираются отдельно).
    this._messageSelectors = [
      '[data-message-id]',
      '[data-message-role]',
      '[data-role][data-message-index]',
      '[class*="message-row"]',
      '[class*="chat-message"]',
      '[class*="message-item"]',
      '[class*="message-bubble"]'
    ];

    // HYPOTHESIS: блок размышлений (свёрнутая панель «thinking»).
    this._reasoningSelectors = [
      '[class*="thinking"]',
      '[class*="thought"]',
      '[class*="reason"]',
      '[data-testid*="think"]'
    ].join(', ');

    // Служебные узлы интерфейса, чей текст сообщением не является.
    this._noiseSelectors = 'button, svg, textarea, [class*="toolbar"], [class*="action"],' +
      ' [class*="footer"], [class*="input"], [class*="avatar"], [class*="icon"], [class*="copy"]';
  }

  /** Живой признак ввода Qwen (подтверждён сниффером: textarea «Спросить Qwen»). */
  _hasComposer() {
    try {
      return !!document.querySelector('textarea[placeholder*="Qwen"], textarea[placeholder*="qwen"]') ||
        !!document.querySelector('textarea[placeholder*="Спросить"], textarea[placeholder*="Ask"]');
    } catch (e) { return false; }
  }

  isOnDialogPage() {
    try {
      if (!/chat\.qwen\.ai$/i.test(String(location.hostname || '')) &&
        String(location.hostname || '').indexOf('qwen.ai') === -1) return false;
      return this._hasComposer() || this._messageNodes().length > 0 || /\/c\//.test(location.pathname);
    } catch (e) { return false; }
  }

  /** Узлы сообщений: первый непустой набор кандидатов (HYPOTHESIS-селекторы выше). */
  _messageNodes() {
    for (let i = 0; i < this._messageSelectors.length; i++) {
      const nodes = this._safeQuerySelectorAll(this._messageSelectors[i]);
      if (nodes && nodes.length > 0) return Array.prototype.slice.call(nodes);
    }
    return [];
  }

  /** Текст узла БЕЗ служебных элементов и БЕЗ блока размышлений. */
  _textWithoutReasoning(element) {
    try {
      const clone = element.cloneNode(true);
      Array.prototype.slice.call(clone.querySelectorAll(this._noiseSelectors)).forEach(el => el.remove());
      Array.prototype.slice.call(clone.querySelectorAll(this._reasoningSelectors)).forEach(el => el.remove());
      return String(clone.textContent || '').replace(/\s+\n/g, '\n').trim();
    } catch (e) { return ''; }
  }

  /** Служебная шапка свёрнутой панели («Завершено размышление», «Thinking… 3s») — не текст. */
  _stripReasoningHeader(text) {
    try {
      var s = String(text == null ? '' : text).trim();
      // Маркер панели в НАЧАЛЕ текста (у Qwen — «Завершено размышление», у англ. UI —
      // «Thinking…»/«Thought for 3s»). Многоточие и скобки/длительность — часть шапки,
      // а не рассуждения. Снимается ТОЛЬКО шапка, текст размышления остаётся как есть.
      var re = /^(?:завершено\s+размышлени[ея]|размышлени[ея]|размышляю|thinking|thought|思考)[\s.…·:•\-–—]*[\[(]?\s*(?:\d+\s*(?:с|s|sec|сек|seconds?)?)?\s*[\])]?\s*[·:•\-–—]?\s*/i;
      return s.replace(re, '').trim();
    } catch (e) { return String(text == null ? '' : text).trim(); }
  }

  _reasoningText(element) {
    try {
      if (!element) return '';
      const nodes = [];
      if (typeof element.matches === 'function' && element.matches(this._reasoningSelectors)) {
        nodes.push(element);
      } else if (typeof element.querySelectorAll === 'function') {
        const found = element.querySelectorAll(this._reasoningSelectors);
        for (let i = 0; i < found.length; i++) nodes.push(found[i]);
      }
      const parts = [];
      for (let j = 0; j < nodes.length; j++) {
        const node = nodes[j];
        const text = this._stripReasoningHeader(String(node.textContent || '').trim());
        if (text && /[0-9A-Za-z\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF]/.test(text)) parts.push(text);
      }
      return parts.join('\n\n').trim();
    } catch (e) { return ''; }
  }

  /** Роль узла: data-атрибут, затем класс-токен, затем «не-assistant → user» (как DeepSeek). */
  _detectRole(element) {
    try {
      const attr = element.getAttribute && (element.getAttribute('data-message-role') ||
        element.getAttribute('data-role'));
      if (attr) {
        const a = String(attr).toLowerCase();
        if (a.indexOf('user') !== -1) return 'user';
        if (a.indexOf('assistant') !== -1 || a.indexOf('model') !== -1 || a.indexOf('bot') !== -1) return 'assistant';
      }
      const cls = String(element.className || '').toLowerCase();
      if (/user/.test(cls)) return 'user';
      if (/assistant|model|bot|answer/.test(cls)) return 'assistant';
      if (element.querySelector && element.querySelector(this.modelMessageSelector)) return 'assistant';
      if (element.querySelector && element.querySelector('[class*="markdown"], [class*="prose"]')) return 'assistant';
    } catch (e) { }
    return 'user';
  }

  /**
   * O-36.2 (ФИКС): контейнер-чистка базы адаптера. Живой артефакт 20-50: 75 узлов, из них
   * ДВА — узлы-КОНТЕЙНЕРЫ всего чата (по 91 595 знаков, cover=0.9999, внутри все 73 реплики):
   * база раздувалась до tokens=81672 / pct=63.8 при реальном тексте ~27-33k (~21-26%).
   * Правило — ОБЩЕЕ со сборщиками экспорта (utils/export-text-builders.js):
   * aiCmDropContainerMessages (пороги — в aiCmContainerRules, здесь НЕ повторяются).
   * Хелпер резолвится ЛЕНИВО на каждом вызове: файл сборщиков подключён в manifest.json ПОСЛЕ
   * адаптера, но к моменту extractMessages он уже загружен (общий ISOLATED-мир контент-скриптов).
   * Хелпера нет (Node/срез-песочница) → массив возвращается КАК ЕСТЬ: поведение 1:1, никакой
   * второй копии правил здесь нет.
   */
  _dropContainerNodes(messages) {
    try {
      var drop = this._containerDrop();
      if (typeof drop === 'function') return drop(messages);
    } catch (eDrop) { }
    return messages;
  }

  /** Ленивый резолв общего хелпера контейнер-чистки (боевой путь — window сборщиков). */
  _containerDrop() {
    try {
      if (typeof window !== 'undefined' && window && window.AiCmExportBuilders &&
        typeof window.AiCmExportBuilders.aiCmDropContainerMessages === 'function') {
        return window.AiCmExportBuilders.aiCmDropContainerMessages;
      }
    } catch (eWin) { }
    try {
      var hasNodeModule = (typeof module !== 'undefined') && !!module && (typeof require === 'function');
      if (hasNodeModule) {
        var builders = require('../utils/export-text-builders.js');
        if (builders && typeof builders.aiCmDropContainerMessages === 'function') {
          return builders.aiCmDropContainerMessages;
        }
      }
    } catch (eReq) { }
    return null;
  }

  extractMessages() {
    // O-35 C (ФИКС, пункт «в»): пересъём БЕЗ F5. Метод stateless: ни кэша, ни латча
    // «одного раза на документ» здесь нет — каждый вызов заново обходит узлы DOM. Поэтому
    // SPA-смена разговора (content.js: aiCmQwenSpaReshoot после сигнала
    // ai-cm-conversation-changed) получает базу НОВОГО чата тем же вызовом, что и холодное
    // открытие: перезагрузка страницы для повторного extractMessages() не нужна.
    try {
      const messages = [];
      const nodes = this._messageNodes();
      for (let i = 0; i < nodes.length; i++) {
        const element = nodes[i];
        const role = this._detectRole(element);
        const content = this._textWithoutReasoning(element);
        if (!content || content.length === 0) continue;
        if (!/[0-9A-Za-z\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF]/.test(content)) continue;   // «.» свёрнутой панели
        const msg = { role, content };
        if (role === 'assistant') {
          const reasoning = this._reasoningText(element);
          if (reasoning) msg.hiddenReasoning = reasoning;
        }
        messages.push(msg);
      }
      // O-36.2 (ФИКС, см. шапку файла): контейнер-узлы снимаются ЗДЕСЬ, до базы/бейджа/файла —
      // общим правилом сборщиков (логика не дублируется). Массив базы остаётся ОДНИМ объектом
      // (in-place), поэтому счётчик, лог и потребители (buildHistoryMessages → экспорт) видят
      // ровно реплики; вторая ступень в сборщиках идемпотентна.
      const keptNodes = this._dropContainerNodes(messages);
      const droppedContainers = messages.length - keptNodes.length;
      if (droppedContainers > 0) {
        messages.length = 0;
        Array.prototype.push.apply(messages, keptNodes);
      }
      if (messages.length > 0) {
        debugLog('log', `[QwenAdapter] Извлечено ${messages.length} сообщений, контейнеров отброшено: ${droppedContainers}, роли: ${messages.map(m => String(m.role).substring(0, 4)).join(', ')}`);
      }
      return messages;
    } catch (error) {
      console.error('[QwenAdapter] Ошибка:', error);
      return [];
    }
  }

  getFullDialogText() {
    try {
      return this.extractMessages().map(msg => msg.content).join('\n');
    } catch (e) { return ''; }
  }

  /**
   * Модель из UI. HYPOTHESIS: живой id — qwen3.8-max (подтверждён в теле /chats/new).
   * Если в разметке модели нет — возвращаем канонический id, а не выдуманный ярлык.
   */
  detectModel() {
    try {
      const selectors = ['[class*="model"] [class*="name"]', '[class*="model-select"]', '[class*="modelName"]'];
      for (let i = 0; i < selectors.length; i++) {
        const el = this._safeQuerySelector(selectors[i]);
        if (!el) continue;
        const text = String(el.textContent || '').trim();
        if (!text) continue;
        const m = /qwen[0-9.]*-[a-z]+/i.exec(text);
        if (m) return m[0].toLowerCase();
      }
    } catch (e) { }
    return 'qwen3.8-max';
  }
}

// Экспорт как у BaseAdapter: браузер — глобальный класс, Node/jest — module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = QwenAdapter;
}
