/**
 * Тесты парсера ChatGPT conversation API.
 * Проверяет изолированный хелпер из tests/helpers/parse-chatgpt-conversation.js.
 */

const { parseChatGPTConversation } = require('../helpers/parse-chatgpt-conversation');
const fs = require('fs');
const path = require('path');

describe('ChatGPT conversation parser', () => {
  describe('parseChatGPTConversation', () => {
    it('должен возвращать объект с полями { messages, model, tokens }', () => {
      const result = parseChatGPTConversation({});
      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
      expect(Array.isArray(result.messages)).toBe(true);
      expect(typeof result.model).toBe('string');
      expect(typeof result.tokens).toBe('number');
    });

    it('должен корректно обрабатывать пустой/невалидный ввод', () => {
      const result = parseChatGPTConversation(null);
      expect(result.messages).toHaveLength(0);
      expect(result.model).toBe('gpt-4o');
      expect(result.tokens).toBe(0);
    });

    it('должен корректно обрабатывать данные из fixtures/chatgpt-conversation.json', () => {
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'chatgpt-conversation.json');
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

      expect(fixture.data).toBeDefined();

      const result = parseChatGPTConversation(fixture.data);
      expect(result).toBeDefined();
      expect(typeof result.messages).toBe('object');
      expect(typeof result.model).toBe('string');
      expect(typeof result.tokens).toBe('number');

      // Проверка соответствия expected
      if (fixture.expected) {
        expect(result.model).toBe(fixture.expected.model);
        expect(result.messages.length).toBeGreaterThanOrEqual(fixture.expected.messagesCount);
      }
    });
  });
});