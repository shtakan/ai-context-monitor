/**
 * Патч `innerText` в харнессе (tests/helpers/adapter-harness.js): свойство должно реально
 * стоять и отдавать текст в семантике браузера, а не оставаться мёртвым no-op.
 *
 * Контракт:
 *   1. `window.HTMLElement.prototype.innerText` песочницы существует;
 *   2. на плоском тексте `innerText === textContent` (приёмочный критерий задачи);
 *   3. на блочной вёрстке `innerText` сохраняет переводы строк (`<p>`/`<br>`/маркер снятого
 *      узла), а не схлопывает их как `textContent` — иначе теряется смысл пинов
 *      многострочности Qwen (`textContent` и был тем дефектом);
 *   4. адаптер читает ИМЕННО `innerText`, когда окружение его отдаёт.
 */

const { loadAdapter } = require('./adapter-harness');

const QWEN_LOCATION = { hostname: 'chat.qwen.ai', pathname: '/' };

function loadQwen(documentImpl) {
  return loadAdapter('adapters/qwen-adapter.js', {
    document: documentImpl,
    location: QWEN_LOCATION,
    exportExpr: 'QwenAdapter'
  });
}

describe('харнесс: патч innerText', () => {
  test('в окне песочницы есть HTMLElement и innerText', () => {
    const { sandbox } = loadQwen(document);
    expect(typeof sandbox.window.HTMLElement).toBe('function');
    expect('innerText' in sandbox.window.HTMLElement.prototype).toBe(true);

    const stub = new sandbox.window.HTMLElement();
    stub.textContent = 'плоский текст';
    expect(stub.innerText).toBe('плоский текст');
  });

  test('notes фиксируют, что патч встал в оба окна', () => {
    const { sandbox } = loadQwen(document);
    const stubNote = sandbox.notes.find((n) => 'innerTextPatched' in n);
    const viewNote = sandbox.notes.find((n) => 'innerTextViewPatched' in n);
    expect(stubNote.innerTextPatched).toBe(true);
    expect(viewNote.innerTextViewPatched).toBe(true);
  });

  test('реальный jsdom-document получает рабочий innerText', () => {
    loadQwen(document);
    const el = document.createElement('div');
    el.textContent = 'Привет! Чем помочь?';
    expect('innerText' in document.defaultView.HTMLElement.prototype).toBe(true);
    expect(el.innerText).toBe(el.textContent);
  });

  test('innerText сохраняет переводы строк блоков, <br> и маркер снятого узла', () => {
    loadQwen(document);
    const el = document.createElement('div');
    el.innerHTML = 'Коротко:<p>первый пункт</p><p>второй пункт</p><span>хвост</span><br>код';
    // textContent здесь склеил бы всё в одну строку — это и есть проверяемый дефект.
    expect(el.textContent).toBe('Коротко:первый пунктвторой пунктхвосткод');
    expect(el.innerText).toBe('Коротко:\nпервый пункт\nвторой пункт\nхвост\nкод');

    const cut = document.createElement('div');
    cut.appendChild(document.createTextNode('первая часть'));
    cut.appendChild(document.createComment('ai-cm-qwen-cut'));
    cut.appendChild(document.createTextNode('вторая часть'));
    expect(cut.innerText).toBe('первая часть\nвторая часть');
  });

  test('адаптер предпочитает innerText, когда он есть', () => {
    const { Adapter } = loadQwen(document);
    const el = document.createElement('div');
    el.innerHTML = '<p>из textContent</p>';
    Object.defineProperty(el, 'innerText', {
      value: 'из innerText',
      configurable: true
    });
    expect(Adapter._readableText(el)).toBe('из innerText');
  });
});
