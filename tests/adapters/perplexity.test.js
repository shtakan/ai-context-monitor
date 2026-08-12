/**
 * Тесты парсера Perplexity (thread API).
 * Проверяет изолированный хелпер из tests/helpers/parse-perplexity-thread.js.
 */

const { parsePerplexityThread } = require('../helpers/parse-perplexity-thread');
const fs = require('fs');
const path = require('path');

describe('Perplexity thread parser', () => {
  describe('parsePerplexityThread', () => {
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'perplexity-thread.json');
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

    it('model === "turbo", messages.length === 4, роли чередуются user/assistant', () => {
      const result = parsePerplexityThread(fixture);
      expect(result.model).toBe('turbo');
      expect(result.messages).toHaveLength(4);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[1].role).toBe('assistant');
      expect(result.messages[2].role).toBe('user');
      expect(result.messages[3].role).toBe('assistant');
    });

    it('текст пользователя равен query_str; текст ассистента содержит и текст ответа, и snippet источника', () => {
      const result = parsePerplexityThread(fixture);

      // user #1
      expect(result.messages[0].text).toBe('Синтетический вопрос один?');

      // assistant #1: текст ответа + сниппет источника
      const assistant1 = result.messages[1];
      expect(assistant1.role).toBe('assistant');
      expect(assistant1.text).toContain('Синтетический ответ один.');
      expect(assistant1.text).toContain('[source] Синтетический источник: Синтетический сниппет источника.');

      // user #2
      expect(result.messages[2].text).toBe('Синтетический вопрос два?');

      // assistant #2: две части текста + два источника
      const assistant2 = result.messages[3];
      expect(assistant2.role).toBe('assistant');
      expect(assistant2.text).toContain('Синтетический ответ два (часть 1).');
      expect(assistant2.text).toContain('Синтетический ответ два (часть 2).');
      expect(assistant2.text).toContain('[source] Второй источник: Сниппет второго источника.');
      expect(assistant2.text).toContain('[source] Третий источник: Сниппет третьего источника.');
    });

    it('пустые entries → messages.length === 0', () => {
      // фикстура с пробельным ключом "entries " и пустым массивом
      const result = parsePerplexityThread({ "entries ": [] });
      expect(result.messages).toHaveLength(0);
    });

    it('trim-эквивалентность: пробельные ключи дают тот же результат, что чистые ключи', () => {
      // Создаём копию фикстуры с чистыми ключами (без пробелов на конце)
      var clean = JSON.parse(JSON.stringify(fixture));

      function trimKeys(obj) {
        if (Array.isArray(obj)) {
          for (var i = 0; i < obj.length; i++) trimKeys(obj[i]);
          return;
        }
        if (typeof obj !== 'object' || obj === null) return;
        var keys = Object.keys(obj);
        for (var k = 0; k < keys.length; k++) {
          var key = keys[k];
          var trimmed = key.trim();
          if (trimmed !== key) {
            obj[trimmed] = obj[key];
            delete obj[key];
          }
          trimKeys(obj[trimmed]);
        }
      }

      trimKeys(clean);

      var resultWithSpaces = parsePerplexityThread(fixture);
      var resultClean = parsePerplexityThread(clean);

      expect(resultClean.model).toBe(resultWithSpaces.model);
      expect(resultClean.messages).toHaveLength(resultWithSpaces.messages.length);
      for (var i = 0; i < resultClean.messages.length; i++) {
        expect(resultClean.messages[i].role).toBe(resultWithSpaces.messages[i].role);
        expect(resultClean.messages[i].text).toBe(resultWithSpaces.messages[i].text);
      }
    });
  });
});