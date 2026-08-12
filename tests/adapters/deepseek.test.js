/**
 * Тесты парсера DeepSeek API.
 * Проверяет изолированный хелпер из tests/helpers/parse-deepseek.js.
 */

const { parseDeepSeekResponse } = require('../helpers/parse-deepseek');
const fs = require('fs');
const path = require('path');

describe('DeepSeek server tokens parser', () => {
  describe('parseDeepSeekResponse', () => {
    it('должен возвращать объект с полями { messages, model, tokens }', () => {
      const result = parseDeepSeekResponse({});
      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
      expect(Array.isArray(result.messages)).toBe(true);
      expect(typeof result.model).toBe('string');
      expect(typeof result.tokens).toBe('number');
    });

    it('должен корректно обрабатывать пустой/невалидный ввод', () => {
      const result = parseDeepSeekResponse(null);
      expect(result.messages).toHaveLength(0);
      expect(result.model).toBe('DeepSeek-V3');
      expect(result.tokens).toBe(0);
    });

    it('должен извлекать серверные токены из accumulated_token_usage', () => {
      const result = parseDeepSeekResponse({
        history_messages: [],
        accumulated_token_usage: 5000
      });
      expect(result.tokens).toBe(5000);
    });

    it('должен определять модель R1 при thinking_enabled=true', () => {
      const result = parseDeepSeekResponse({
        history_messages: [
          { id: 1, parent_id: 0, role: 'user', content: 'Привет', thinking_enabled: true }
        ]
      });
      expect(result.model).toBe('DeepSeek-R1');
    });

    it('должен корректно обрабатывать данные из fixtures/deepseek-serverTokens.json', () => {
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'deepseek-serverTokens.json');
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

      expect(fixture.data).toBeDefined();

      const result = parseDeepSeekResponse(fixture.data);
      expect(result).toBeDefined();
      expect(typeof result.messages).toBe('object');
      expect(typeof result.model).toBe('string');
      expect(typeof result.tokens).toBe('number');

      // Проверка соответствия expected
      if (fixture.expected) {
        expect(result.model).toBe(fixture.expected.model);
        expect(result.tokens).toBe(fixture.expected.tokens);
        expect(result.messages.length).toBeGreaterThanOrEqual(fixture.expected.messagesCount);
      }
    });
  });
});