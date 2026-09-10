/**
 * Тесты парсеров Claude (conversation API + SSE stream).
 * Проверяет изолированные хелперы из tests/helpers/.
 */

const { parseClaudeConversation } = require('../helpers/parse-claude-conversation');
const { parseClaudeSSE } = require('../helpers/parse-claude-sse');
const fs = require('fs');
const path = require('path');

describe('Claude conversation parser', () => {
  describe('parseClaudeConversation', () => {
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'claude-conversation.json');
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

    it('model === "claude-sonnet-4-6", messages.length === 4, роли чередуются human/assistant', () => {
      const result = parseClaudeConversation(fixture);
      expect(result.model).toBe('claude-sonnet-4-6');
      expect(result.messages).toHaveLength(4);
      expect(result.messages[0].role).toBe('human');
      expect(result.messages[1].role).toBe('assistant');
      expect(result.messages[2].role).toBe('human');
      expect(result.messages[3].role).toBe('assistant');
    });

    it('текст assistant-сообщения содержит и thinking, и text, и stringify тулз-блоков', () => {
      const result = parseClaudeConversation(fixture);

      // assistant #1 (messages[1]): thinking + text
      const assistant1 = result.messages[1];
      expect(assistant1.role).toBe('assistant');
      expect(assistant1.text).toContain('Синтетическое рассуждение');
      expect(assistant1.text).toContain('Синтетический ответ один');

      // assistant #2 (messages[3]): thinking + tool_use + tool_result + text
      const assistant2 = result.messages[3];
      expect(assistant2.role).toBe('assistant');
      expect(assistant2.text).toContain('Рассуждение два');
      expect(assistant2.text).toContain('"type":"tool_use"');
      expect(assistant2.text).toContain('"name":"web_search"');
      expect(assistant2.text).toContain('"type":"tool_result"');
      expect(assistant2.text).toContain('Синтетический ответ два с тулзами');
    });

    it('пустой chat_messages → messages.length === 0', () => {
      const result = parseClaudeConversation({ chat_messages: [] });
      expect(result.messages).toHaveLength(0);
    });
  });
});

describe('Claude SSE parser', () => {
  describe('parseClaudeSSE', () => {
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'claude-completion-sse.txt');
    const fixtureRaw = fs.readFileSync(fixturePath, 'utf8');

    it('model из message_start, text равен полной склейке кусков, stopped === true, rateLimit5h === 0.58', () => {
      const result = parseClaudeSSE(fixtureRaw);
      expect(result.model).toBe('claude-sonnet-4-6');
      // thinking_summary склеивается: "Синтетическое" + " размышление" = "Синтетическое размышление"
      // text_delta склеивается: "Синтетический" + " ответ" + " модели" + " Claude" = "Синтетический ответ модели Claude"
      // итого: "Синтетическое размышлениеСинтетический ответ модели Claude"
      expect(result.text).toBe('Синтетическое размышлениеСинтетический ответ модели Claude');
      expect(result.stopped).toBe(true);
      expect(result.rateLimit5h).toBe(0.58);
    });

    it('поток без message_stop → stopped === false', () => {
      // убираем message_stop
      var lines = fixtureRaw.split('\n');
      var filtered = lines.filter(function (line) {
        return line.indexOf('"message_stop"') === -1;
      }).join('\n');
      const result = parseClaudeSSE(filtered);
      expect(result.stopped).toBe(false);
      // остальные поля должны быть на месте
      expect(result.model).toBe('claude-sonnet-4-6');
    });
  });
});