/**
 * Тесты чистого сетевого парсера Gemini (utils/gemini-batchexecute-parser.js).
 * Синтетическая фикстура моделирует СЫРОЙ порядок batchexecute «новые сверху»:
 *   turns[0] — самый НОВЫЙ ход, turns[1] — более старый.
 * Парсер должен вернуть хронологический порядок (messages[0] = самый старый).
 * Assert: нет $AXzLiR, нет мышления, таблица есть в assistant, роли user/assistant разделены.
 */

const { parseGeminiHistory, stripAttachmentTokens } = require('../../utils/gemini-batchexecute-parser');

describe('Gemini batchexecute history parser (parseGeminiHistory)', () => {
  function buildRaw() {
    // НОВЫЙ ход (идёт ПЕРВЫМ в сыром массиве): вопрос «Сделай таблицу…» + таблица-ответ.
    const newTurn = [
      ["c_conv", "r_new"],
      ["c_conv", "r_new_rc", "rc_new"],
      [
        "Сделай таблицу 3×3: столбцы Модель, Окно, Пример $AXzLiRyoZUKbH3HKgyvk1WLLC",
        [
          "**Defining the Russian Table**\n\nI'm now zeroing in on defining the structure.",
          "",
          "",
          "",
          [[['Defining the Russian Table', [[0, 24, [[null, null, null, null, 2]]]]]]],
          "",
          ""
        ],
        "| Модель | Окно | Пример |\n| :--- | :--- | :--- |\n| **Gemini 1.5 Pro** | 2 000 000 токенов | Анализ видео |"
      ]
    ];

    // СТАРЫЙ ход (идёт ПОСЛЕ в сыром массиве): вопрос «Привет» + текстовый ответ.
    const oldTurn = [
      ["c_conv", "r_old"],
      ["c_conv", "r_old_rc", "rc_old"],
      [
        "Привет",
        "Привет! Чем могу помочь?"
      ]
    ];

    // Реальный формат: turns = [[turn0, turn1, ...]] — внешний массив с одним массивом ходов.
    // Сырой порядок: новые сверху (newTurn первым).
    const turns = [[newTurn, oldTurn]];
    const inner = JSON.stringify(turns);
    // Реальный формат outer: [["wrb.fr","hNvQHb",<inner>,null,"generic"]]
    return JSON.stringify([["wrb.fr", "hNvQHb", inner, null, "generic"]]);
  }

  it('должен вырезать токены $AXzLiR из всех сообщений', () => {
    const r = parseGeminiHistory(buildRaw());
    const all = r.messages.map(m => m.text).join('\n');
    expect(/\$AXzLiR/.test(all)).toBe(false);
  });

  it('должен исключать сегмент мышления', () => {
    const r = parseGeminiHistory(buildRaw());
    const all = r.messages.map(m => m.text).join('\n');
    expect(all.indexOf('Defining the Russian Table')).toBe(-1);
    expect(all.indexOf("I'm now zeroing in")).toBe(-1);
  });

  it('должен разворачивать к хронологии: messages[0] = самый старый ход', () => {
    const r = parseGeminiHistory(buildRaw());
    expect(r.messages[0].text).toBe('Привет');
    // Последнее сообщение — assistant с таблицей; user-вопрос «Сделай…» идёт перед ним.
    expect(r.messages[r.messages.length - 1].text.indexOf('| Модель | Окно | Пример |')).not.toBe(-1);
    const userTexts = r.messages.filter(m => m.role === 'user').map(m => m.text).join('\n');
    expect(userTexts.indexOf('Сделай таблицу 3×3')).not.toBe(-1);
  });

  it('должен разделять роли user и assistant', () => {
    const r = parseGeminiHistory(buildRaw());
    const roles = r.messages.map(m => m.role);
    // Хронологический порядок: user(Привет) → assistant(Привет!) → user(Сделай…) → assistant(таблица)
    expect(roles[0]).toBe('user');
    expect(roles[1]).toBe('assistant');
    expect(roles[2]).toBe('user');
    expect(roles[3]).toBe('assistant');
  });

  it('должен помещать markdown-таблицу в assistant-сообщение', () => {
    const r = parseGeminiHistory(buildRaw());
    const assistant = r.messages.filter(m => m.role === 'assistant');
    const all = assistant.map(m => m.text).join('\n');
    expect(all.indexOf('| Модель | Окно | Пример |')).not.toBe(-1);
    expect(all.indexOf('| **Gemini 1.5 Pro** | 2 000 000 токенов |')).not.toBe(-1);
  });
});

describe('stripAttachmentTokens', () => {
  it('должен вырезать токен и схлопывать пустоты', () => {
    const out = stripAttachmentTokens('текст $AXzLiRabc123+/= конец');
    expect(out.indexOf('$AXzLiR')).toBe(-1);
    expect(out).toContain('текст');
    expect(out).toContain('конец');
  });
});