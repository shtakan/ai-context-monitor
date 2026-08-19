/**
 * Тесты функции извлечения полной HTML-истории Google Search AI (GET /async/folwr).
 * Проверяет изолированный хелпер utils/google-search-folwr-parser.js.
 */

const {
  parseGoogleFolwrOpen,
  countTurnContainers,
  extractTurnsFromDocument,
  mergeTurnsByKey,
  extractContinuationToken,
  mergeTurnsById
} = require('../../utils/google-search-folwr-parser');
const fs = require('fs');
const path = require('path');

describe('Google Search AI folwr-open parser', () => {
  describe('parseGoogleFolwrOpen', () => {
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'google-folwr-open.html');
    const fixture = fs.readFileSync(fixturePath, 'utf8');

    it('извлекает роли и тексты пользователя и модели в порядке диалога', () => {
      const result = parseGoogleFolwrOpen(fixture);
      expect(result.messages.length).toBe(4);

      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].text).toBe('Сколько будет два плюс два?');

      expect(result.messages[1].role).toBe('assistant');
      expect(result.messages[1].text).toContain('Четыре.');
      expect(result.messages[1].text).toContain('база арифметики');

      expect(result.messages[2].role).toBe('user');
      expect(result.messages[2].text).toBe('А если умножить?');

      expect(result.messages[3].role).toBe('assistant');
      expect(result.messages[3].text).toBe('Будет то же число в этом случае.');
    });

    it('текст ассистента содержит подзаголовок и ячейки таблицы (markdown-строки)', () => {
      const result = parseGoogleFolwrOpen(fixture);
      const assistant = result.messages[1];
      expect(assistant.role).toBe('assistant');
      expect(assistant.text).toContain('Сводка по арифметике');
      expect(assistant.text).toContain('| Операция | Результат |');
      expect(assistant.text).toContain('| 2 + 2 | 4 |');
      expect(assistant.text).toContain('| 2 * 2 | 4 |');
    });

    it('messages (а не только text) содержат markdown-строки таблицы', () => {
      const result = parseGoogleFolwrOpen(fixture);
      // ищем сообщение ассистента, содержащее таблицу
      const withTable = result.messages.find(function (m) {
        return m.role === 'assistant' && m.text.indexOf('| Операция |') !== -1;
      });
      expect(withTable).toBeTruthy();
      expect(withTable.text).toContain('| Операция | Результат |');
      expect(withTable.text).toContain('| 2 + 2 | 4 |');
    });

    it('возвращает threadId из data-session-thread-id', () => {
      const result = parseGoogleFolwrOpen(fixture);
      expect(result.threadId).toBe('SYNTHETIC-THREAD-1');
    });

    it('собирает конкатенированный text и корректный count', () => {
      const result = parseGoogleFolwrOpen(fixture);
      expect(result.count).toBe(4);
      expect(result.text).toContain('Сколько будет два плюс два?');
      expect(result.text).toContain('Будет то же число в этом случае.');
    });

    it('пустой/невалидный ввод → пустые messages и count 0', () => {
      const result = parseGoogleFolwrOpen(null);
      expect(result.messages).toHaveLength(0);
      expect(result.count).toBe(0);
      expect(result.text).toBe('');
    });

    it('не теряет маркированный список между заголовком и финальным абзацем (все узлы в исходном порядке)', () => {
      const html = [
        '<div class="CKgc1d" data-scope-id="turn" jsuid="turn-list">',
        '  <h2 class="iMqumd">Вы сказали: "Почему веб-интерфейсы эффективнее API?"</h2>',
        '</div>',
        '<div role="heading" aria-level="3">Почему веб-интерфейсы и Cline эффективнее</div>',
        '<ul>',
        '  <li>Специализация инструментов для VS Code</li>',
        '  <li>Экономика бесплатного API Gemini 1.5 Pro</li>',
        '  <li>Использование токенизатора</li>',
        '</ul>',
        '<div class="n6owBd awi2gc">Финальный абзац ответа.</div>'
      ].join('');
      const result = parseGoogleFolwrOpen(html);
      const assistant = result.messages.find(function (m) { return m.role === 'assistant'; });
      expect(assistant).toBeTruthy();
      expect(assistant.text).toContain('Почему веб-интерфейсы и Cline эффективнее');
      expect(assistant.text).toContain('Специализация инструментов для VS Code');
      expect(assistant.text).toContain('Экономика бесплатного API Gemini 1.5 Pro');
      expect(assistant.text).toContain('Использование токенизатора');
      expect(assistant.text).toContain('Финальный абзац ответа.');
      // порядок: заголовок → пункт 1 → ... → финальный абзац
      expect(assistant.text.indexOf('Специализация')).toBeGreaterThan(assistant.text.indexOf('эффективнее'));
      expect(assistant.text.indexOf('Использование')).toBeGreaterThan(assistant.text.indexOf('Экономика'));
      expect(assistant.text.indexOf('Финальный абзац')).toBeGreaterThan(assistant.text.indexOf('Использование'));
    });

    it('не теряет вложенный/нумерованный список в ответе ассистента', () => {
      const html = [
        '<div class="CKgc1d" data-scope-id="turn" jsuid="turn-ol">',
        '  <h2 class="iMqumd">Вы сказали: "Дай шаги"</h2>',
        '</div>',
        '<ol>',
        '  <li>Первый шаг</li>',
        '  <li>Второй шаг</li>',
        '</ol>'
      ].join('');
      const result = parseGoogleFolwrOpen(html);
      const assistant = result.messages.find(function (m) { return m.role === 'assistant'; });
      expect(assistant).toBeTruthy();
      expect(assistant.text).toContain('Первый шаг');
      expect(assistant.text).toContain('Второй шаг');
    });

    it('не вклеивает чип веб-поиска и чужую пользовательскую реплику в ответ ассистента', () => {
      const html = [
        '<div data-session-thread-id="SYNTHETIC-THREAD-2" style="display:none"></div>',
        '<div class="CKgc1d" data-scope-id="turn" jsuid="turn-1">',
        '  <h2 class="iMqumd">Вы сказали: "Сколько будет два плюс два?"</h2>',
        '</div>',
        '<div class="n6owBd awi2gc">Четыре.</div>',
        '<div role="heading" aria-level="3">Самые популярные результаты веб-поиска по этой теме:</div>',
        '<div class="n6owBd awi2gc">Ссылка на сайт про арифметику</div>',
        '<h2 class="iMqumd">Вы сказали: "А сколько будет три плюс три?"</h2>'
      ].join('');
      const result = parseGoogleFolwrOpen(html);
      const assistant = result.messages.find(function (m) { return m.role === 'assistant'; });
      expect(assistant).toBeTruthy();
      expect(assistant.text).toBe('Четыре.');
      expect(assistant.text).not.toContain('Самые популярные результаты');
      expect(assistant.text).not.toContain('Ссылка на сайт');
      expect(assistant.text).not.toContain('А сколько будет три плюс три');
    });

    it('извлекает текст абзаца целиком, не обрывая на инлайн bold/ссылке/картинке в середине', () => {
      const html = [
        '<div data-session-thread-id="INLINE-THREAD" style="display:none"></div>',
        '<div class="CKgc1d" data-scope-id="turn" jsuid="turn-inline">',
        '  <h2 class="iMqumd">Вы сказали: "Опиши настройку"</h2>',
        '</div>',
        '<div class="n6owBd awi2gc">Начинаем настройку <strong>параметра bold</strong>, далее ' +
          '<a href="https://example.com">ссылка-якорь</a> и <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="> ' +
          'картинка, после чего идёт хвост абзаца, который не должен теряться.</div>'
      ].join('');
      const result = parseGoogleFolwrOpen(html);
      const assistant = result.messages.find(function (m) { return m.role === 'assistant'; });
      expect(assistant).toBeTruthy();
      expect(assistant.text).toContain('Начинаем настройку');
      expect(assistant.text).toContain('параметра bold');
      expect(assistant.text).toContain('ссылка-якорь');
      // хвост после инлайн-узлов извлечён полностью
      expect(assistant.text).toContain('хвост абзаца, который не должен теряться.');
      expect(assistant.text.indexOf('хвост абзаца')).toBeGreaterThan(assistant.text.indexOf('картинка'));
    });

    it('список в ответе форматируется markdown-пунктами «- **Метка**: текст»', () => {
      const html = [
        '<div data-session-thread-id="LIST-THREAD" style="display:none"></div>',
        '<div class="CKgc1d" data-scope-id="turn" jsuid="turn-mdlist">',
        '  <h2 class="iMqumd">Вы сказали: "Дай шаги"</h2>',
        '</div>',
        '<ul>',
        '  <li><strong>Первый шаг</strong> сделать настройку</li>',
        '  <li><strong>Второй шаг</strong> проверить</li>',
        '</ul>'
      ].join('');
      const result = parseGoogleFolwrOpen(html);
      const assistant = result.messages.find(function (m) { return m.role === 'assistant'; });
      expect(assistant).toBeTruthy();
      expect(assistant.text).toContain('- **Первый шаг**: сделать настройку');
      expect(assistant.text).toContain('- **Второй шаг**: проверить');
    });
  });

  describe('продолжение folwr (курсор) и слияние по id', () => {
    it('extractContinuationToken достаёт data-mstk из скрытого контейнера', () => {
      const html = '<div data-mstk="AUtExfTOKEN123" style="display:none"></div><div>хвост</div>';
      expect(extractContinuationToken(html)).toBe('AUtExfTOKEN123');
    });

    it('extractContinuationToken возвращает null без data-mstk', () => {
      const html = '<div>нет курсора</div>';
      expect(extractContinuationToken(html)).toBeNull();
    });

    it('mergeTurnsById дедуплицирует по id и не теряет ходы', () => {
      const base = [
        { id: 't1', userText: 'Вопрос 1', assistantText: 'Ответ 1' },
        { id: 't2', userText: 'Вопрос 2', assistantText: 'Ответ 2' }
      ];
      const extra = [
        { id: 't2', userText: 'Вопрос 2', assistantText: 'Ответ 2 (дубль)' },
        { id: 't3', userText: 'Вопрос 3', assistantText: 'Ответ 3' }
      ];
      const merged = mergeTurnsById(base, extra);
      expect(merged.map(t => t.id)).toEqual(['t1', 't2', 't3']);
      // дубль по id не перезаписывает первый ход
      expect(merged.find(t => t.id === 't2').assistantText).toBe('Ответ 2');
    });
  });

  describe('полнота folwr vs DOM (досбор обрезанного folwr)', () => {
    function turnHtml(id, question, answer) {
      var a = answer
        ? '<div class="n6owBd awi2gc">' + answer + '</div>'
        : '';
      return '<div class="CKgc1d" data-scope-id="turn" jsuid="' + id + '">' +
        '<h2 class="iMqumd">Вы сказали: "' + question + '"</h2>' +
        '</div>' + a;
    }

    it('считает turn-контейнеры в HTML-снимке folwr', () => {
      const html = [
        turnHtml('t1', 'Первый вопрос', 'Первый ответ'),
        turnHtml('t2', 'Второй вопрос', 'Второй ответ')
      ].join('');
      expect(countTurnContainers(html)).toBe(2);
    });

    it('extractTurnsFromDocument извлекает ходы из живого DOM', () => {
      const doc = new DOMParser().parseFromString(
        turnHtml('t1', 'Первый вопрос', 'Первый ответ') +
        turnHtml('t2', 'Второй вопрос', 'Второй ответ'),
        'text/html'
      );
      const turns = extractTurnsFromDocument(doc);
      expect(turns).toHaveLength(2);
      expect(turns[0].userText).toBe('Первый вопрос');
      expect(turns[0].assistantText).toBe('Первый ответ');
      expect(turns[1].userText).toBe('Второй вопрос');
      expect(turns[1].assistantText).toBe('Второй ответ');
    });

    it('mergeTurnsByKey досбирает хвост из DOM без дублей', () => {
      // folwr отдал только первый ход (обрезан), DOM содержит 3 хода.
      const folwrTurns = [{ id: 't1', userText: 'Первый вопрос', assistantText: 'Первый ответ' }];
      const domTurns = [
        { id: 't1', userText: 'Первый вопрос', assistantText: 'Первый ответ' },
        { id: 't2', userText: 'Второй вопрос', assistantText: 'Второй ответ' },
        { id: 't3', userText: 'Третий вопрос', assistantText: 'Третий ответ' }
      ];
      const merged = mergeTurnsByKey(folwrTurns, domTurns);
      expect(merged).toHaveLength(3);
      expect(merged[0].userText).toBe('Первый вопрос');
      expect(merged[1].userText).toBe('Второй вопрос');
      expect(merged[2].userText).toBe('Третий вопрос');
    });
  });
});
