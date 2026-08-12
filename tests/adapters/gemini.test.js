/**
 * Тесты парсера batchexecute Gemini.
 * Проверяет изолированный хелпер из tests/helpers/parse-batchexecute.js.
 */

const { parseBatchExecute } = require('../helpers/parse-batchexecute');
const fs = require('fs');
const path = require('path');

describe('Gemini batchexecute parser', () => {
  describe('parseBatchExecute', () => {
    it('должен возвращать объект с полями { messages, model, tokens }', () => {
      const result = parseBatchExecute('');
      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
      expect(Array.isArray(result.messages)).toBe(true);
      expect(typeof result.model).toBe('string');
      expect(typeof result.tokens).toBe('number');
    });

    it('должен корректно обрабатывать пустой ввод', () => {
      const result = parseBatchExecute('');
      expect(result.messages).toHaveLength(0);
      expect(result.model).toBe('Gemini 2.5 Pro');
      expect(result.tokens).toBe(0);
    });

    it('должен корректно обрабатывать данные из fixtures/gemini-batchexecute.json', () => {
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'gemini-batchexecute.json');
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

      // Проверка, что fixture.raw не пустой
      expect(fixture.raw).toBeDefined();
      expect(typeof fixture.raw).toBe('string');
      expect(fixture.raw.length).toBeGreaterThan(0);

      const result = parseBatchExecute(fixture.raw);
      expect(result).toBeDefined();
      expect(typeof result.messages).toBe('object');
      expect(typeof result.model).toBe('string');
      expect(typeof result.tokens).toBe('number');

      // Проверка соответствия expected
      if (fixture.expected) {
        expect(result.model).toBe(fixture.expected.model);
        expect(Array.isArray(result.messages)).toBe(true);
      }
    });
  });
});