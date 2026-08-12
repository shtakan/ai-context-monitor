/**
 * Тесты парсера Google Search AI (folwr).
 * Проверяет изолированный хелпер из tests/helpers/parse-searchai-folwr.js.
 */

const { parseSearchAIFolwr } = require('../helpers/parse-searchai-folwr');
const fs = require('fs');
const path = require('path');

describe('SearchAI folwr parser', () => {
  describe('parseSearchAIFolwr', () => {
    it('должен возвращать объект с полями { messages, model, tokens }', () => {
      const result = parseSearchAIFolwr({});
      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
      expect(Array.isArray(result.messages)).toBe(true);
      expect(typeof result.model).toBe('string');
      expect(typeof result.tokens).toBe('number');
    });

    it('должен корректно обрабатывать пустой/невалидный ввод', () => {
      const result = parseSearchAIFolwr(null);
      expect(result.messages).toHaveLength(0);
      expect(result.model).toBe('gemini-1.5-flash');
      expect(result.tokens).toBe(0);
    });

    it('должен извлекать модель из поля model', () => {
      const result = parseSearchAIFolwr({ model: 'gemini-2.5-pro' });
      expect(result.model).toBe('gemini-2.5-pro');
    });

    it('должен корректно обрабатывать данные из fixtures/searchai-folwr.json', () => {
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'searchai-folwr.json');
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

      expect(fixture.data).toBeDefined();

      const result = parseSearchAIFolwr(fixture.data);
      expect(result).toBeDefined();
      expect(typeof result.messages).toBe('object');
      expect(typeof result.model).toBe('string');
      expect(typeof result.tokens).toBe('number');

      // Проверка соответствия expected
      if (fixture.expected) {
        expect(result.model).toBe(fixture.expected.model);
        expect(result.tokens).toBeGreaterThan(0);
        expect(result.messages.length).toBeGreaterThanOrEqual(fixture.expected.messagesCount);
      }
    });
  });
});