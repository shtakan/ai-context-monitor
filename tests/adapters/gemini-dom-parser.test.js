/**
 * Тесты чистого DOM-парсера ответа Gemini (utils/gemini-dom-parser.js).
 * Проверяет: мышление (свёрнутые/скрытые блоки) исключается из извлечённого текста,
 * таблицы конвертируются в markdown-строки и попадают в текст, count > 0.
 */

const { extractGeminiResponse } = require('../../utils/gemini-dom-parser');

describe('Gemini DOM-парсер ответа (extractGeminiResponse)', () => {
  function buildFixture() {
    const root = document.createElement('div');
    root.innerHTML = [
      // 1. скрытый блок мышления (.cdk-visually-hidden)
      '<div class="cdk-visually-hidden">Thinking process secret tokens that must be excluded</div>',
      // 2. живой анонсер (.cdk-live-announcer-element)
      '<div class="cdk-live-announcer-element cdk-visually-hidden" aria-live="polite">Assessing the structure</div>',
      // 3. сворачиваемая панель мышления (класс *think*)
      '<div class="thinking-panel"><p>Defining the Russian Table</p></div>',
      // 4. кнопка-заголовок мышления (Thought for)
      '<button aria-label="Thought for 5 seconds">Thought for 5 seconds</button>',
      // 5. обычный абзац ответа
      '<p>Обычный видимый абзац ответа.</p>',
      // 6. видимая таблица ответа
      '<table><thead><tr><th>Модель</th><th>Окно</th></tr></thead><tbody><tr><td>Gemini 1.5 Pro</td><td>2 000 000</td></tr><tr><td>GPT-4o</td><td>128 000</td></tr></tbody></table>'
    ].join('');
    document.body.appendChild(root);
    return root;
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('должен исключать текст мышления из извлечённого текста', () => {
    const root = buildFixture();
    const result = extractGeminiResponse(root);

    expect(result.text).not.toContain('Thinking process secret tokens');
    expect(result.text).not.toContain('Assessing the structure');
    expect(result.text).not.toContain('Defining the Russian Table');
    expect(result.text).not.toContain('Thought for 5 seconds');
  });

  it('должен включать строки таблицы как markdown', () => {
    const root = buildFixture();
    const result = extractGeminiResponse(root);

    expect(result.text).toContain('| Модель | Окно |');
    expect(result.text).toContain('| Gemini 1.5 Pro | 2 000 000 |');
    expect(result.text).toContain('| GPT-4o | 128 000 |');
  });

  it('должен сохранять видимый абзац и давать count > 0', () => {
    const root = buildFixture();
    const result = extractGeminiResponse(root);

    expect(result.text).toContain('Обычный видимый абзац ответа.');
    expect(result.count).toBeGreaterThan(0);
  });
});