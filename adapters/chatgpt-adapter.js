/**
 * Адаптер для ChatGPT (chatgpt.com).
 *
 * Типизация (шаг 4 Фазы 1): формы — из types/adapter.d.ts. Литеральный `import type`
 * невозможен (файл — классический скрипт контента плюс склейка исходника в
 * new Function()/eval песочницами тестов), поэтому типы подключены JSDoc-ссылкой import().
 */

/**
 * Сообщение в форме адаптера (types/adapter.d.ts).
 *
 * Имя с префиксом — по необходимости: файлы адаптеров не являются модулями, поэтому
 * при allowJs все typedef-имена попадают в одну общую область (одноимённые → TS2300).
 * @typedef {import('../types/adapter').ExtractedMessage} ChatGPTExtractedMessage
 */

class ChatGPTAdapter extends BaseAdapter {
constructor() {
super();
this.siteName = 'chatgpt';
this.allContentSelectors = '.whitespace-pre-wrap, .markdown';
}
/** Узлы сообщений: элементы с содержимым (markdown-рендер либо pre-wrap). */
_findMessageElements() {
return document.querySelectorAll(this.allContentSelectors);
}
/**
 * Роль по классу узла и классу предков (до 5 уровней вверх): markdown → assistant,
 * пузырь user-message-bubble-color → user, иначе 'unknown' (неизвестная роль).
 * TODO: уточнить тип в шаге 5 (контракт ролей адаптера).
 * @param {Element} element
 * @returns {string}
 */
_detectRole(element) {
const classAttr = element.className || '';
if (classAttr.includes('markdown')) {
  return 'assistant';
}
let parent = element.parentElement;
for (let i = 0; i < 5 && parent; i++) {
  const parentClass = parent.className || '';
  if (parentClass.includes('user-message-bubble-color')) {
    return 'user';
  }
  parent = parent.parentElement;
}
return 'unknown';
}
/**
 * Текст хода: у markdown-рендера — абзацы построчно, иначе клон без кнопок и svg.
 * @param {Element} element
 * @returns {string}
 */
_extractText(element) {
const classAttr = element.className || '';
if (classAttr.includes('markdown')) {
  const paragraphs = element.querySelectorAll('p');
  if (paragraphs.length > 0) {
    return Array.from(paragraphs)
      .map(p => p.textContent.trim())
      .join('\n');
  }
}
const clone = /** @type {Element} */ (element.cloneNode(true));
clone.querySelectorAll('button, [role="button"], svg').forEach(el => el.remove());
return clone.textContent.trim();
}
/**
 * Ходы диалога из DOM. Пустые тексты отбрасываются, а роль 'unknown' приводится
 * к 'user' (та же нормализация, что и раньше).
 * @returns {ChatGPTExtractedMessage[]}
 */
extractMessages() {
const elements = this._findMessageElements();
/** @type {ChatGPTExtractedMessage[]} */
const messages = [];
elements.forEach((element) => {
  const content = this._extractText(element);
  if (content && content.length > 0) {
    const role = this._detectRole(element);
    messages.push({
      role: role === 'unknown' ? 'user' : role,
      content: content
    });
  }
});
return messages;
}
/**
 * Полный текст диалога: содержимое ходов, склеенное переводом строки.
 * Явное переопределение базового (у ChatGPT свой путь отбора узлов).
 * @returns {string}
 */
getFullDialogText() {
const messages = this.extractMessages();
return messages.map(msg => msg.content).join('\n');
}
/**
 * Находимся ли мы на странице диалога: есть хотя бы один узел с содержимым.
 * @returns {boolean}
 */
isOnDialogPage() {
return document.querySelector(this.allContentSelectors) !== null;
}
// Честный детектор модели из DOM (второй слой; первый — model_slug из сети в content.js).
// Ищет имя модели в шапке/селекторе. Если шапка показывает только бренд ("ChatGPT")
// без версии — возвращает null (НЕ захардкоженное 'gpt-4o'), чтобы content.js взял
// дефолт/сеть. Лог один раз, без спама. Безопасно (try/catch).
/**
 * Имя модели из шапки/селектора; если шапка показывает только бренд — null
 * (не захардкоженное имя), иначе модель возьмётся из сети/дефолта.
 * @returns {string|null}
 */
detectModel() {
if (this._modelDetectLogged === undefined) this._modelDetectLogged = false;
let found = null;
try {
  const re = /(GPT-[\w.\-]+|Gemini[\s\d.\-A-Za-z]*|DeepSeek[\s\-A-Za-z0-9]*|Claude[\s\d.\-A-Za-z]*|o[134]-[\w.\-]*)/i;
  const selectors = [
    '[data-testid="model-switcher-dropdown-button"]',
    '[data-testid="model-switcher"]',
    'button[aria-label*="model" i]',
    'button[aria-label*="модель" i]',
    'nav button',
    'header button'
  ];
  for (let i = 0; i < selectors.length && !found; i++) {
    // innerText есть только у HTMLElement, а querySelectorAll по строке даёт Element
    // (TS2339). Уточняем форму узла: селекторы здесь кнопки/ссылки шапки.
    const els = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(selectors[i]));
    for (let j = 0; j < els.length; j++) {
      const txt = (els[j].innerText || els[j].textContent || '').trim();
      const m = txt.match(re);
      if (m) { found = m[1]; break; }
    }
  }
  if (!found) {
    const labeled = document.querySelectorAll('[aria-label],[title]');
    for (let k = 0; k < labeled.length; k++) {
      const s = (labeled[k].getAttribute('aria-label') || '') + ' ' + (labeled[k].getAttribute('title') || '');
      const m2 = s.match(re);
      if (m2) { found = m2[1]; break; }
    }
  }
} catch (e) { swallow(e, 'adapter:chatgpt:detectModel'); /* никогда не ломаем сайт */ }
if (!this._modelDetectLogged) {
  this._modelDetectLogged = true;
  debugLog('log', '[model-detect][DOM] ' + (found ? ('найдено в шапке: "' + found + '"') : 'имя модели в шапке не найдено (шапка показывает бренд — модель возьмётся из сети/дефолта)'));
}
return found; // null, если не нашли — это нормально
}
}