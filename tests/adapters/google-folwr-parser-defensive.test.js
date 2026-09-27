/**
 * utils/google-search-folwr-parser.js — защитные ветки и фолбэки.
 *
 * Карта задачи 1.1 (code coverage ≥80%): дополняет tests/adapters/google-folwr-open.test.js
 * ровно теми путями, которые не встречаются в живом счастливом пути парсера:
 *   - не-узел/не-DOM вход (null, число, объект без DOM-API) → пустые результаты без падения;
 *   - строковые входы не-строкой/пустыми (String(x == null ? '' : x), !s → '');
 *   - таблица без ячеек в строке (cellTexts.length === 0 → continue);
 *   - сужение путей ответа: codeBodyElement/isCodeBlockElement/answerTextOf/renderCodeBlock;
 *   - «чужой» вопрос-х2 без контейнера хода (isForeignQuestionNode), ход без ответа;
 *   - обёртка-вопрос в тексте ответа (ok/не-ok) и остаточное эхо вопроса;
 *   - compare-функция формы хода isBetterTurn (длина ответа, затем длина вопроса);
 *   - mergeTurnsById/mergeTurnsByKey на не-массивах и ходах без id/текста.
 *
 * Гейты/поведение не меняются: тесты только вызывают публичные хелперы парсера.
 */

const P = require('../../utils/google-search-folwr-parser');

function turnHtml(id, question, answer) {
  return '<div class="CKgc1d" data-scope-id="turn" jsuid="' + id + '">' +
    '<h2 class="iMqumd">Вы сказали: "' + question + '"</h2>' +
    '</div>' +
    (answer ? '<div class="n6owBd awi2gc">' + answer + '</div>' : '');
}

describe('folwr parser — защитные ветки входа (не-DOM и не-строки)', () => {
  test('countTurnContainers: пустой/не-строковый вход → 0', () => {
    expect(P.countTurnContainers('')).toBe(0);
    expect(P.countTurnContainers(null)).toBe(0);
    expect(P.countTurnContainers(undefined)).toBe(0);
    expect(P.countTurnContainers(42)).toBe(0);
    expect(P.countTurnContainers({})).toBe(0);
  });

  test('countTurnContainers: HTML без turn-контейнеров → 0', () => {
    expect(P.countTurnContainers('<html><body><p>просто текст</p></body></html>')).toBe(0);
  });

  test('extractTurnsFromDocument: не-DOM вход → пустой массив', () => {
    expect(P.extractTurnsFromDocument(null)).toEqual([]);
    expect(P.extractTurnsFromDocument(undefined)).toEqual([]);
    expect(P.extractTurnsFromDocument(42)).toEqual([]);
    expect(P.extractTurnsFromDocument({})).toEqual([]);
  });

  test('extractContinuationToken: пустой/не-строковый вход → null', () => {
    expect(P.extractContinuationToken(null)).toBeNull();
    expect(P.extractContinuationToken(undefined)).toBeNull();
    expect(P.extractContinuationToken(7)).toBeNull();
    expect(P.extractContinuationToken('<div>нет курсора</div>')).toBeNull();
  });

  test('extractContinuationToken: пустой data-mstk пропускается, берётся следующий непустой', () => {
    const html = '<div data-mstk=""></div><div data-mstk="TOK-2"></div>';
    expect(P.extractContinuationToken(html)).toBe('TOK-2');
  });

  test('parseGoogleFolwrOpen: null/число → пустой результат без падения', () => {
    [null, undefined, 1, 0, {}].forEach(function (input) {
      const r = P.parseGoogleFolwrOpen(input);
      expect(r.messages).toEqual([]);
      expect(r.turns).toEqual([]);
      expect(r.count).toBe(0);
      expect(r.text).toBe('');
    });
  });
});

describe('folwr parser — таблицы и списки: краевые строки', () => {
  test('пустая строка таблицы (нулевые ячейки) не создаёт markdown-строку', () => {
    const html = [
      turnHtml('t1', 'Вопрос?', ''),
      '<table class="NRefec"><tr></tr><tr><td>a</td><td>b</td></tr></table>'
    ].join('');
    const r = P.parseGoogleFolwrOpen(html);
    const assistant = r.messages.find(function (m) { return m.role === 'assistant'; });
    expect(assistant).toBeTruthy();
    expect(assistant.text).toBe('| a | b |');
  });

  test('пункт списка без <strong>-метки форматируется как «- текст»', () => {
    const html = [
      turnHtml('t1', 'Дай список', ''),
      '<ul><li>Просто пункт без метки</li><li><strong>С меткой</strong> и хвостом</li></ul>'
    ].join('');
    const r = P.parseGoogleFolwrOpen(html);
    const assistant = r.messages.find(function (m) { return m.role === 'assistant'; });
    expect(assistant.text).toContain('- Просто пункт без метки');
    expect(assistant.text).toContain('- **С меткой**: и хвостом');
  });
});

describe('folwr parser — фолбэк ответа, когда ходов в снимке нет', () => {
  test('нет turn-контейнеров, но есть глобальный aimfl → ответ берётся из него', () => {
    const html = '<html><body><div data-subtree="aimfl">Глобальный ответ фолиф</div></body></html>';
    const r = P.parseGoogleFolwrOpen(html);
    const assistant = r.messages.find(function (m) { return m.role === 'assistant'; });
    expect(assistant).toBeTruthy();
    expect(assistant.text).toContain('Глобальный ответ фолиф');
  });

  test('нет ходов и нет aimfl, первый контент-узел — таблица → ответ из таблицы', () => {
    const html = '<html><body><table class="NRefec"><tr><td>x</td><td>y</td></tr></table></body></html>';
    const r = P.parseGoogleFolwrOpen(html);
    const assistant = r.messages.find(function (m) { return m.role === 'assistant'; });
    expect(assistant).toBeTruthy();
    expect(assistant.text).toContain('| x | y |');
  });

  test('нет ходов и нет aimfl, первый контент-узел — заголовок → ответ из заголовка', () => {
    const html = '<html><body><div role="heading" aria-level="3">Заголовок ответа</div></body></html>';
    const r = P.parseGoogleFolwrOpen(html);
    const assistant = r.messages.find(function (m) { return m.role === 'assistant'; });
    expect(assistant).toBeTruthy();
    expect(assistant.text).toContain('Заголовок ответа');
  });

  test('ход без ответа → assistantText null, но вопрос сохранён', () => {
    const r = P.parseGoogleFolwrOpen(turnHtml('t1', 'Вопрос без ответа?', ''));
    const turn = r.turns.find(function (t) { return t.userText === 'Вопрос без ответа?'; });
    expect(turn).toBeTruthy();
    expect(turn.assistantText).toBeNull();
  });

  test('вложенный aimfl внутри хода отдаёт ответ, когда ответных чанков нет', () => {
    const html = '<html><body><div data-scope-id="turn" jsuid="t1">' +
      '<h2 class="iMqumd">Вы сказали: "Вопрос?"</h2>' +
      '<div data-subtree="aimfl">Вложенный ответ</div></div></body></html>';
    const r = P.parseGoogleFolwrOpen(html);
    const assistant = r.messages.find(function (m) { return m.role === 'assistant'; });
    expect(assistant).toBeTruthy();
    expect(assistant.text).toContain('Вложенный ответ');
  });
});

describe('folwr parser — чужой вопрос и код-контейнеры (answerTextOf / isCodeBlockElement)', () => {
  test('h2.iMqumd без контейнера хода не заводит новый ход между ходами', () => {
    const html = [
      turnHtml('t1', 'Первый вопрос', 'Первый ответ'),
      '<h2 class="iMqumd">Вы сказали: "Чужая реплика"</h2>',
      '<div class="n6owBd awi2gc">Второй ответ</div>'
    ].join('');
    const r = P.parseGoogleFolwrOpen(html);
    const all = r.messages.map(function (m) { return m.text; }).join('\n');
    expect(all).not.toContain('Чужая реплика');
  });

  test('answerTextOf: не-узел вход → пустая строка', () => {
    expect(P.answerTextOf(null)).toBe('');
    expect(P.answerTextOf(undefined)).toBe('');
    expect(P.answerTextOf(42)).toBe('');
    expect(P.answerTextOf({})).toBe('');
  });

  test('answerTextOf: сервисный <button> вырезается, инлайн <br> не рождает пустых строк', () => {
    const doc = new DOMParser().parseFromString(
      '<html><body><div><button>Скопировать код</button>line1<br>line2</div></body></html>', 'text/html');
    const text = P.answerTextOf(doc.querySelector('div'));
    // <br> — инлайн-разрыв: textContent даёт склейку, ложных пустых строк не появляется
    expect(text).toBe('line1line2');
    expect(text).not.toContain('Скопировать код');
  });

  test('answerTextOf: обвязка окна кода с <br> и кнопкой сохраняет переносы строк кода', () => {
    const doc = new DOMParser().parseFromString(
      '<html><body><div class="code-block"><button>Скопировать код</button>' +
      '<pre>line1<br>line2</pre></div></body></html>', 'text/html');
    const text = P.answerTextOf(doc.querySelector('div.code-block'));
    expect(text).toContain('line1');
    expect(text).toContain('line2');
    expect(text).not.toContain('Скопировать код');
  });

  test('answerTextOf: вложенный код-окно внутри чанка подменяется фенсом', () => {
    const doc = new DOMParser().parseFromString(
      '<html><body><div>Текст до<pre>const x = 1;</pre>Текст после</div></body></html>', 'text/html');
    const text = P.answerTextOf(doc.querySelector('div'));
    expect(text).toContain('```');
    expect(text).toContain('const x = 1;');
    expect(text).toContain('Текст до');
    expect(text).toContain('Текст после');
  });

  test('isCodeBlockElement: не-узел → false; <pre> → true; инлайн <code> → false', () => {
    expect(P.isCodeBlockElement(null)).toBe(false);
    expect(P.isCodeBlockElement(42)).toBe(false);
    expect(P.isCodeBlockElement({})).toBe(false);

    const doc = new DOMParser().parseFromString(
      '<html><body><pre>a</pre><code>nums.sort()</code>' +
      '<code class="language-python">print(1)</code><div class="code-block">x</div></body></html>', 'text/html');
    expect(P.isCodeBlockElement(doc.querySelector('pre'))).toBe(true);
    expect(P.isCodeBlockElement(doc.querySelector('code'))).toBe(false);
    expect(P.isCodeBlockElement(doc.querySelector('code.language-python'))).toBe(true);
    expect(P.isCodeBlockElement(doc.querySelector('div.code-block'))).toBe(true);
  });

  test('renderCodeBlock: пустой/без текста узел → пустая строка', () => {
    expect(P.renderCodeBlock(null)).toBe('');
    const doc = new DOMParser().parseFromString('<html><body><pre>   </pre></body></html>', 'text/html');
    expect(P.renderCodeBlock(doc.querySelector('pre'))).toBe('');
  });

  test('renderCodeBlock: многострочный код не схлопывается, метка языка сохраняется', () => {
    const doc = new DOMParser().parseFromString(
      '<html><body><pre class="language-python">def f():\n    return 1</pre></body></html>', 'text/html');
    const out = P.renderCodeBlock(doc.querySelector('pre'));
    expect(out).toContain('def f():');
    expect(out).toContain('    return 1');
    expect(out.indexOf('```')).toBe(0);
  });

  test('renderCodeBlock: код с тройными кавычками внутри получает удлинённый фенс', () => {
    const doc = new DOMParser().parseFromString(
      '<html><body><pre>a ``` b</pre></body></html>', 'text/html');
    const out = P.renderCodeBlock(doc.querySelector('pre'));
    expect(out.indexOf('````')).toBe(0);
  });
});

describe('folwr parser — форма хода: обёртка-вопрос и выбор богатейшей формы', () => {
  test('canonicalAnswerBody: обёртка-вопрос снимается, тело возвращается', () => {
    const text = 'Ответ в режиме ИИ, исходный запрос: "Как дела?" Всё хорошо.';
    expect(P.canonicalAnswerBody(text)).toBe('Всё хорошо.');
  });

  test('canonicalAnswerBody: null/число → строка без падения', () => {
    expect(P.canonicalAnswerBody(null)).toBe('');
    expect(P.canonicalAnswerBody(undefined)).toBe('');
    expect(P.canonicalAnswerBody(42)).toBe('42');
  });

  test('canonicalAnswerBody: одиночная закрывающая кавычка (без тела) обёрткой не считается', () => {
    const text = 'вопрос: "Как дела?"';
    expect(P.canonicalAnswerBody(text)).toBe(text);
  });

  test('canonicalAnswerBody: остаточное эхо вопроса снимается один раз', () => {
    // Маркер вопроса + закрытая кавычка + служебный разделитель (". ") перед телом ответа
    expect(P.canonicalAnswerBody('вопрос: "Старый вопрос". Новое тело ответа.'))
      .toBe('Новое тело ответа.');
  });

  test('canonicalAnswerBody: маркер вопроса без закрывающей кавычки НЕ режется (текст байтово цел)', () => {
    const text = 'вопрос: 42 ответ без кавычек';
    expect(P.canonicalAnswerBody(text)).toBe(text);
  });

  test('canonicalAnswerBody: маркер вопроса без кавычек остаётся как есть', () => {
    expect(P.canonicalAnswerBody('вопрос: без кавычек')).toBe('вопрос: без кавычек');
    expect(P.canonicalAnswerBody('нет маркера тут')).toBe('нет маркера тут');
  });

  test('canonicalTurnKeyOf: null → пустая строка; ход без id берёт вопрос из обёртки', () => {
    expect(P.canonicalTurnKeyOf(null)).toBe('');
    const wrapped = { id: 'idx0', userText: null, assistantText: 'Ответ в режиме ИИ, исходный запрос: "Q" A' };
    const network = { id: 'j1', userText: 'Q', assistantText: 'A' };
    expect(P.canonicalTurnKeyOf(wrapped)).toBe(P.canonicalTurnKeyOf(network));
  });

  test('canonicalizeTurnForThread: null возвращается как есть; null-тексты остаются null', () => {
    expect(P.canonicalizeTurnForThread(null)).toBeNull();
    const out = P.canonicalizeTurnForThread({ id: 'i', userText: null, assistantText: null });
    expect(out.userText).toBeNull();
    expect(out.assistantText).toBeNull();
  });

  test('canonicalizeTurnForThread: вопрос из обёртки выносится в userText, текст не переписывается', () => {
    const wrapped = { id: 'idx0', userText: '   ', assistantText: 'Ответ в режиме ИИ, исходный запрос: "Q" A' };
    const out = P.canonicalizeTurnForThread(wrapped);
    expect(out.userText).toBe('Q');
    expect(out.assistantText).toBe(wrapped.assistantText);
  });

  test('isBetterTurn: при равной длине ответа сравнивается длина вопроса', () => {
    const base = [{ id: 'k', userText: 'короткий', assistantText: 'Ответ' }];
    const extra = [{ id: 'k', userText: 'гораздо более длинный вопрос', assistantText: 'Ответ' }];
    const merged = P.mergeTurnsById(base, extra);
    expect(merged).toHaveLength(1);
    expect(merged[0].userText).toBe('гораздо более длинный вопрос');
  });

  test('mergeTurnsMonotone: null-ход игнорируется, богатейшая форма побеждает', () => {
    const base = [{ id: 't1', userText: 'В', assistantText: 'Коротко' }];
    const extra = [null, undefined, { id: 't1', userText: 'В', assistantText: 'Гораздо более длинный ответ' }];
    const merged = P.mergeTurnsMonotone(base, extra);
    expect(merged).toHaveLength(1);
    expect(merged[0].assistantText).toBe('Гораздо более длинный ответ');
  });
});

describe('folwr parser — слияния на не-массивах и ходах без id', () => {
  test('mergeTurnsById / mergeTurnsByKey: не-массивы трактуются как пустые', () => {
    expect(P.mergeTurnsById(null, null)).toEqual([]);
    expect(P.mergeTurnsById(undefined, undefined)).toEqual([]);
    expect(P.mergeTurnsByKey(null, null)).toEqual([]);
    expect(P.mergeTurnsByKey('нет', 42)).toEqual([]);
  });

  test('mergeTurnsById: null-ходы пропускаются, ход без id получает синтетический ключ', () => {
    const merged = P.mergeTurnsById([null], [{ userText: 'Вопрос', assistantText: 'Ответ' }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].userText).toBe('Вопрос');
    expect(merged[0].assistantText).toBe('Ответ');
  });

  test('mergeTurnsByKey: ход без ключа (пустой вопрос+ответ) пропускается', () => {
    const merged = P.mergeTurnsByKey([{ id: 'a', userText: '', assistantText: '' }], []);
    expect(merged).toEqual([]);
  });

  test('mergeTurnsByKey: ходы с разными ключами дополняют друг друга', () => {
    const merged = P.mergeTurnsByKey(
      [{ id: 'a', userText: 'Вопрос A', assistantText: 'Ответ A' }],
      [{ id: 'b', userText: 'Вопрос B', assistantText: 'Ответ B' }]
    );
    expect(merged).toHaveLength(2);
  });

  test('normalizeTurnKeyPart: null/число/пробелы → строка без падения', () => {
    expect(typeof P.normalizeTurnKeyPart(null)).toBe('string');
    expect(typeof P.normalizeTurnKeyPart(42)).toBe('string');
    expect(typeof P.normalizeTurnKeyPart('   ')).toBe('string');
  });
});
