/**
 * Тесты чистого сетевого парсера Gemini (utils/gemini-batchexecute-parser.js).
 * Фикстура моделирует СЫРОЙ порядок batchexecute «новые сверху» и реальную структуру хода:
 *   turn = [metaA, metaB, [[question, ...]], answerArr, [ts, ...]]
 *   question = turn[2][0][0], answer = turn[3]
 * Проверки: хронология (messages[0] = самый старый), роли user/assistant, нет мышления,
 * нет $AXzLiR, таблица — в assistant-сообщении.
 */

const { parseGeminiHistory, stripAttachmentTokens, splitTurnMessages, collectTurnText, stripLeadingThinking } = require('../../utils/gemini-batchexecute-parser');

describe('Gemini batchexecute history parser (parseGeminiHistory)', () => {
  function makeTurn(question, answerParts) {
    // answerParts — массив элементов answer-контента; парсер обходит turn[3] и собирает
    // строки, пропуская блоки мышления. Таблица — строка "| ..." в answer[1].
    return [
      ['c_conv', 'r_x'],
      ['c_conv', 'r_y', 'rc_z'],
      [[question, null, null, null, null]],
      [
        answerParts.map(function (p) { return Array.isArray(p) ? p : [p]; })
      ],
      [1780000000, 100]
    ];
  }

  function buildRaw() {
    // НОВЫЙ ход (идёт ПЕРВЫМ в сыром массиве): вопрос + таблица-ответ + сегмент мышления.
    const thinkingBlock = [
      '**Defining the Russian Table**\n\nI\'m now zeroing in on defining the structure.',
      '',
      '',
      '',
      [[['Defining the Russian Table', [[0, 24, [[null, null, null, null, 2]]]]]]],
      '',
      ''
    ];
    const newTurn = makeTurn(
      'Сделай таблицу 3×3: столбцы Модель, Окно, Пример $AXzLiRyoZUKbH3HKgyvk1WLLC',
      [
        'rc_abcdef1234567890',
        '| Модель | Окно | Пример |\n| :--- | :--- | :--- |\n| **Gemini 1.5 Pro** | 2 000 000 токенов | Анализ видео |',
        thinkingBlock
      ]
    );

    // СТАРЫЙ ход (идёт ПОСЛЕ): вопрос «Привет» + текстовый ответ.
    const oldTurn = makeTurn(
      'Привет',
      ['Привет! Чем могу помочь?']
    );

    // Сырой порядок: от новых к старым (реверс применяется парсером).
    const turns = [[newTurn, oldTurn]];
    const inner = JSON.stringify(turns);
    return JSON.stringify([['wrb.fr', 'hNvQHb', inner, null, 'generic']]);
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

  it('должен разворачивать к хронологии (raw новые→старые): messages[0] = самый старый ход', () => {
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
    // user(Привет) → assistant(Привет!) → user(Сделай…) → assistant(таблица)
    expect(roles[0]).toBe('user');
    expect(roles[1]).toBe('assistant');
    expect(roles[2]).toBe('user');
    expect(roles[roles.length - 1]).toBe('assistant');
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

describe('Gemini thinking-run: голые продолжения и системная строка', () => {
  function makeTurnWithAnswer(answerParts) {
    return [
      ['c_conv', 'r_x'],
      ['c_conv', 'r_y', 'rc_z'],
      [['Вопрос пользователя', null, null, null, null]],
      [ answerParts.map(function (p) { return Array.isArray(p) ? p : [p]; }) ],
      [1780000000, 100]
    ];
  }

  it('thinking-run с голыми продолжениями → всё пропущено, ответ с таблицей сохранён', () => {
    const thinkingBlock = [
      '**Defining the Russian Table**\n\nI\'m now zeroing in on defining the structure.',
      '',
      '',
      '',
      [[['Defining the Russian Table', [[0, 24, [[null, null, null, null, 2]]]]]]],
      '',
      ''
    ];
    const turn = makeTurnWithAnswer([
      '| Модель | Окно |\n| :--- | :--- |\n| **Gemini 2.5 Pro** | 1 000 000 |',
      thinkingBlock,
      "I'm now zeroing in on the finer details",
      'Assessing the Core Task',
      'Defining the Scope',
      'Refining the Audit\'s Purpose',
      "I've shifted focus to the next step",
      'My focus is on consolidating the findings'
    ]);

    const msgs = splitTurnMessages(turn);
    const assistant = msgs.filter(m => m.role === 'assistant').map(m => m.text).join('\n');

    // ответ с таблицей сохранён
    expect(assistant).toContain('| Модель | Окно |');
    expect(assistant).toContain('| **Gemini 2.5 Pro** | 1 000 000 |');
    // голые продолжения мышления вычищены
    expect(assistant).not.toContain('Defining the Russian Table');
    expect(assistant).not.toContain("I'm now zeroing in");
    expect(assistant).not.toContain('Assessing the Core Task');
    expect(assistant).not.toContain('Defining the Scope');
    expect(assistant).not.toContain('Refining the Audit');
    expect(assistant).not.toContain("I've shifted focus");
    expect(assistant).not.toContain('My focus is on');
  });

  it('strip "File attachment was not previously registered"', () => {
    const turn = makeTurnWithAnswer([
      'Реальный ответ модели.',
      'File attachment was not previously registered',
      'Ещё один кусок ответа.'
    ]);
    const out = [];
    try { collectTurnText(turn[3], out); } catch (e) { }
    const text = out.join('\n');
    expect(text).not.toContain('File attachment');
    expect(text).toContain('Реальный ответ модели.');
    expect(text).toContain('Ещё один кусок ответа.');
  });

  it('run-skip: [**Title**, англ. тело, **Title2**, англ. тело, русский ответ с таблицей] → остаётся только русский ответ с таблицей', () => {
    const turn = makeTurnWithAnswer([
      '**Considering the Scenario**',
      'I am currently focused on dissecting the requirements and mapping out the exact structure.',
      '**Identifying the Constraints**',
      'I have been analyzing the constraints and the relevant edge cases in detail.',
      'Вот итоговая таблица соответствий:\n| Критерий | Статус |\n| :--- | :--- |\n| Порядок | выполнен |'
    ]);
    const msgs = splitTurnMessages(turn);
    const assistant = msgs.filter(m => m.role === 'assistant').map(m => m.text).join('\n');

    // остаётся только русский ответ с таблицей
    expect(assistant).toContain('Вот итоговая таблица соответствий');
    expect(assistant).toContain('| Критерий | Статус |');
    // титулы и англ. тела мышления вычищены
    expect(assistant).not.toContain('Considering the Scenario');
    expect(assistant).not.toContain('Identifying the Constraints');
    expect(assistant).not.toContain('I am currently focused');
    expect(assistant).not.toContain('I have been analyzing');
  });

  it('новые стартовые маркеры (Considering|Structuring|Reconstructing) — голые титулы мышления вычищаются', () => {
    const turn = makeTurnWithAnswer([
      'Considering the Scenario',
      'Structuring the Output',
      'Reconstructing the Flow',
      'Вот готовый ответ.'
    ]);
    const msgs = splitTurnMessages(turn);
    const assistant = msgs.filter(m => m.role === 'assistant').map(m => m.text).join('\n');
    expect(assistant).toBe('Вот готовый ответ.');
    expect(assistant).not.toContain('Considering');
    expect(assistant).not.toContain('Structuring');
    expect(assistant).not.toContain('Reconstructing');
  });

  it('чисто английский thinking-assistant исключается из messages', () => {
    // ответ без кириллицы, начинается с герундия → весь assistant-блок мышление → исключается.
    const turn = makeTurnWithAnswer([
      'Assessing the Core Task',
      'I\'m now focusing on the approach.'
    ]);
    const msgs = splitTurnMessages(turn);
    // user-вопрос остаётся, assistant отсутствует
    expect(msgs.filter(m => m.role === 'user').length).toBe(1);
    expect(msgs.filter(m => m.role === 'assistant').length).toBe(0);
  });

  it('смешанный блок (с кириллицей) не исключается', () => {
    const turn = makeTurnWithAnswer([
      'Assessing the Core Task',
      'Вот итоговый ответ.'
    ]);
    const msgs = splitTurnMessages(turn);
    const assistant = msgs.filter(m => m.role === 'assistant').map(m => m.text).join('\n');
    expect(assistant).toContain('Вот итоговый ответ.');
  });

  it('stripLeadingThinking: смешанный блок → только кириллическая часть', () => {
    expect(stripLeadingThinking('Assessing the Core Task\nВот итоговый ответ.')).toBe('Вот итоговый ответ.');
    expect(stripLeadingThinking("I'm now focusing.\nВот результат.")).toBe('Вот результат.');
    expect(stripLeadingThinking("sr Analyzing\nВот итог.")).toBe('Вот итог.');
    // чисто английский (без кириллицы) → пусто
    expect(stripLeadingThinking('Assessing the Core Task')).toBe('');
    // русский с таблицей — не трогаем
    const table = 'Вот итоговая таблица:\n| Критерий | Статус |';
    expect(stripLeadingThinking(table)).toBe(table);
  });

  it('канонический markdown-ответ: три сегмента хода (md / thinking-саммари / plain-копия) схлопываются в один markdown-ответ', () => {
    // Реальная структура хода из gemini-network-sample.txt:
    //   markdown-ответ = turn[3][0][0][1][0]
    //   thinking-саммари = turn[3][0][0][37][0][0] (маркер "Assessing the Claim", "I'm now zeroing in")
    //   plain-копия = turn[3][12][0][0][i][1][2] (тот же ответ без markdown)
    const md = '## Итоговый ответ\n\n**Ключевой вывод:** это markdown-ответ.\n\n| Пункт | Значение |\n| :--- | :--- |\n| A | 1 |';
    const thinkingTitle = '**Assessing the Claim**\n\nI\'m now zeroing in on the claim structure.';
    const plainCopy = 'Итоговый ответ: это plain-копия без markdown, та же суть другими словами.';

    // turn[3][0][0] — контейнер из 38 элементов: [0]=rc, [1]=markdown, [9]='ru', [37]=thinking.
    const innerAnswer = [];
    innerAnswer[0] = 'rc_abc1234567890';
    innerAnswer[1] = [md];
    innerAnswer[9] = 'ru';
    innerAnswer[37] = [thinkingTitle, []];

    // turn[3][12] = [ [ plain-блоки ] ]; plain-блок = [null, [null, n, text], ...].
    const plainBlocks = [plainCopy].map(function (t) { return [null, [null, 0, t], null, null]; });

    const answer = [];
    answer[0] = [innerAnswer];
    for (var pad = 1; pad <= 11; pad++) answer[pad] = null;
    answer[12] = [[plainBlocks]];
    for (pad = 13; pad <= 25; pad++) answer[pad] = null;

    const turn = [
      ['c_conv', 'r_old'],
      ['c_conv', 'r_new', 'rc_zzz'],
      [['Вопрос пользователя', null, null, null, null]],
      answer,
      [1780000000, 100]
    ];

    const msgs = splitTurnMessages(turn);
    const assistant = msgs.filter(m => m.role === 'assistant').map(m => m.text).join('\n');

    // канон: один assistant, содержащий только markdown-ответ
    expect(msgs.filter(m => m.role === 'assistant').length).toBe(1);
    expect(assistant).toContain('Ключевой вывод');
    expect(assistant).toContain('| Пункт | Значение |');
    // без thinking
    expect(assistant).not.toContain('Assessing the Claim');
    expect(assistant).not.toContain('zeroing in');
    // без plain-копии (второй копии)
    expect(assistant).not.toContain('plain-копия');
  });

  it('при отсутствии markdown-разметки ответ возвращается как есть (фолбэк)', () => {
    // контейнер turn[3][0][0][1] отсутствует или пуст → фолбэк на collectTurnText.
    const turn = makeTurnWithAnswer([
      'Обычный текстовый ответ без разметки и таблицы.'
    ]);
    const msgs = splitTurnMessages(turn);
    const assistant = msgs.filter(m => m.role === 'assistant').map(m => m.text).join('\n');
    expect(assistant).toBe('Обычный текстовый ответ без разметки и таблицы.');
  });

  it('тела мышления БЕЗ титулов полностью вычищаются, русский ответ с таблицей после них сохраняется', () => {
    const turn = makeTurnWithAnswer([
      'Considering the Scenario',
      "I'm currently focused on dissecting the requirements and mapping out the exact structure.",
      "I've been analyzing the constraints and the relevant edge cases in detail.",
      'My goal is to produce a clear, comprehensive final answer.',
      "Specifically, I've outlined the key constraints before finalizing.",
      'File attachment was not previously registered',
      'Вот итоговая таблица соответствий:\n| Критерий | Статус |\n| :--- | :--- |\n| Порядок | выполнен |'
    ]);
    const msgs = splitTurnMessages(turn);
    const assistant = msgs.filter(m => m.role === 'assistant').map(m => m.text).join('\n');

    // остаётся только русский ответ с таблицей
    expect(assistant).toContain('Вот итоговая таблица соответствий');
    expect(assistant).toContain('| Критерий | Статус |');
    // тела мышления без титулов и системная строка-заглушка вычищены
    expect(assistant).not.toContain('Considering the Scenario');
    expect(assistant).not.toContain("I'm currently focused");
    expect(assistant).not.toContain("I've been analyzing");
    expect(assistant).not.toContain('My goal is');
    expect(assistant).not.toContain("Specifically, I've");
    expect(assistant).not.toContain('File attachment');
  });
});
