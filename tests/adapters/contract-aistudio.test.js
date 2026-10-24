/**
 * tests/adapters/contract-aistudio.test.js — контракт DOM-адаптера Google AI Studio.
 *
 * Живая разметка AI Studio (снимок пользователя, 2026-10-24; Вариант B Plan-отчёта):
 * реплики — <ms-cmark-node class="cmark-node v3-font-body">, у пользовательской
 * добавлен класс user-chunk, у ответа модели его нет. Отсюда контракт адаптера:
 * 1 user + 1 assistant → ровно 2 сообщения, порядок реплик сохранён.
 *
 * Исполняется РЕАЛЬНЫЙ adapters/aistudio-adapter.js в песочнице харнесса, поверх
 * настоящего jsdom-документа (querySelectorAll/closest работают как в браузере).
 * gemini-adapter.js грузится ПЕРЕД aistudio, как в manifest.json: AistudioAdapter
 * наследует GeminiAdapter.
 */
const { loadSource } = require('../helpers/adapter-harness');

const AISTUDIO_LOC = {
  hostname: 'aistudio.google.com',
  pathname: '/prompts/new_chat',
  href: 'https://aistudio.google.com/prompts/new_chat'
};

const ADAPTER_FILES = [
  'adapters/base-adapter.js',
  'adapters/gemini-adapter.js',
  'adapters/aistudio-adapter.js'
];

function loadAistudio(doc) {
  const res = loadSource(ADAPTER_FILES, {
    document: doc,
    location: AISTUDIO_LOC,
    exportExpr: 'AistudioAdapter'
  });
  const Adapter = new res.value();
  return { adapter: Adapter, sandbox: res.sandbox };
}

function mount(html) {
  document.body.innerHTML = html;
  return document;
}

describe('AistudioAdapter: контракт extractMessages на живой разметке', () => {
  test('1 user (user-chunk) + 1 assistant → 2 сообщения с верными ролями и текстом', () => {
    const doc = mount(
      '<div class="chat-container">' +
        '<ms-cmark-node class="cmark-node v3-font-body user-chunk"><p>Сколько токенов в этом диалоге?</p></ms-cmark-node>' +
        '<ms-cmark-node class="cmark-node v3-font-body"><p>Сейчас в контексте около 1 200 токенов.</p></ms-cmark-node>' +
      '</div>'
    );

    const { adapter } = loadAistudio(doc);

    expect(adapter.siteName).toBe('aistudio');
    expect(adapter.isOnDialogPage()).toBe(true);

    const messages = adapter.extractMessages();
    expect(messages).toHaveLength(2);
    expect(messages.map(function (m) { return m.role; })).toEqual(['user', 'assistant']);
    expect(messages[0].content).toContain('Сколько токенов в этом диалоге?');
    expect(messages[1].content).toContain('около 1 200 токенов');
    // текст реплики пользователя не переехал в ответ модели и наоборот
    expect(messages[0].content).not.toContain('1 200');
    expect(messages[1].content).not.toContain('Сколько токенов');
    expect(adapter.detectModel()).toBe('gemini-3.1-pro');
  });

  test('вложенный ms-cmark-node не дублирует текст родителя', () => {
    const doc = mount(
      '<ms-cmark-node class="cmark-node v3-font-body user-chunk">' +
        '<ms-cmark-node class="cmark-node v3-font-body snippet"><p>вложенный фрагмент</p></ms-cmark-node>' +
        '<p>внешняя реплика</p>' +
      '</ms-cmark-node>'
    );

    const { adapter } = loadAistudio(doc);

    const messages = adapter.extractMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toContain('внешняя реплика');
    expect(messages[0].content.match(/вложенный фрагмент/g)).toHaveLength(1);
  });

  test('страница без ms-cmark-node — не диалог, сообщений нет', () => {
    const doc = mount('<div class="prompts-gallery"><p>New chat</p></div>');

    const { adapter } = loadAistudio(doc);

    expect(adapter.isOnDialogPage()).toBe(false);
    expect(adapter.extractMessages()).toEqual([]);
  });
});
