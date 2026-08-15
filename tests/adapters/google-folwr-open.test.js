/**
 * Тесты функции извлечения полной HTML-истории Google Search AI (GET /async/folwr).
 * Проверяет изолированный хелпер utils/google-search-folwr-parser.js.
 */

const { parseGoogleFolwrOpen } = require('../../utils/google-search-folwr-parser');
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
  });
});