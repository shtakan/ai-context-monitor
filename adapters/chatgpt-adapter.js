class ChatGPTAdapter extends BaseAdapter {
constructor() {
super();
this.siteName = 'chatgpt';
this.allContentSelectors = '.whitespace-pre-wrap, .markdown';
}
_findMessageElements() {
return document.querySelectorAll(this.allContentSelectors);
}
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
const clone = element.cloneNode(true);
clone.querySelectorAll('button, [role="button"], svg').forEach(el => el.remove());
return clone.textContent.trim();
}
extractMessages() {
const elements = this._findMessageElements();
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
getFullDialogText() {
const messages = this.extractMessages();
return messages.map(msg => msg.content).join('\n');
}
isOnDialogPage() {
return document.querySelector(this.allContentSelectors) !== null;
}
// Честный детектор модели из DOM (второй слой; первый — model_slug из сети в content.js).
// Ищет имя модели в шапке/селекторе. Если шапка показывает только бренд ("ChatGPT")
// без версии — возвращает null (НЕ захардкоженное 'gpt-4o'), чтобы content.js взял
// дефолт/сеть. Лог один раз, без спама. Безопасно (try/catch).
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
    const els = document.querySelectorAll(selectors[i]);
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
} catch (e) { /* никогда не ломаем сайт */ }
if (!this._modelDetectLogged) {
  this._modelDetectLogged = true;
  debugLog('log', '[model-detect][DOM] ' + (found ? ('найдено в шапке: "' + found + '"') : 'имя модели в шапке не найдено (шапка показывает бренд — модель возьмётся из сети/дефолта)'));
}
return found; // null, если не нашли — это нормально
}
}