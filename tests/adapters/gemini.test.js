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

  // ---- v52: stream-ingest walker'ы (фикстуры из probe-логов, урезаны до 300 символов) ----
  describe('Gemini stream walkers', () => {
    const L = require('../../utils/gemini-intercept-logic.js');

    // I4z33b — user turn: [[[["me",1,["117554108543990917097", ...]]]]] (probe-sample)
    const userInner = JSON.stringify([
      [['me', 1, ['117554108543990917097', null, 'Проверка стрим-инжеста пользователя']]]
    ]);
    const userLine = JSON.stringify([['wrb.fr', 'I4z33b', userInner, null, null, null, 'generic']]);
    const userRaw = ")]}'\n12\n" + userLine + '\n';

    // Bsxleb — model turn с временным rc_* (probe-sample)
    const modelRcInner = JSON.stringify([null, null, [
      ['c_f47e2edd3b51953a', ['Ответ модели в стриме', '$AVuibgToken'], 'rc_c9396ed660e63e2a']
    ]]);
    const modelRcLine = JSON.stringify([['wrb.fr', 'Bsxleb', modelRcInner, null, null, null, 'generic']]);
    const modelRcRaw = ")]}'\n9\n" + modelRcLine + '\n';

    // другой запрос — model turn, снапшотный r_* уже в стриме
    const modelRInner = JSON.stringify([null, null, [
      ['c_0362260dfd6b7882', ['Другой ответ модели'], 'r_a45b970914710bd8']
    ]]);
    const modelRLine = JSON.stringify([['wrb.fr', 'Bsxleb', modelRInner, null, null, null, 'generic']]);
    const modelRRaw = ")]}'\n7\n" + modelRLine + '\n';

    it('extractStreamUserTurn: извлекает роль=me, ID и текст из I4z33b', () => {
      const t = L.extractStreamUserTurn(userRaw);
      expect(t).not.toBeNull();
      expect(t.role).toBe('me');
      expect(t.id).toBe('117554108543990917097');
      expect(t.text).toBe('Проверка стрим-инжеста пользователя');
    });

    it('extractStreamModelTurn: Bsxleb возвращает rc_* как id и c_* как turnId', () => {
      const t = L.extractStreamModelTurn(modelRcRaw);
      expect(t).not.toBeNull();
      expect(t.role).toBe('model');
      expect(t.id).toBe('rc_c9396ed660e63e2a');
      expect(t.turnId).toBe('c_f47e2edd3b51953a');
      expect(t.text).toBe('Ответ модели в стриме');
    });

    it('extractStreamModelTurn: вариант с r_* и фильтрацией $AVuibg-токенов', () => {
      const t = L.extractStreamModelTurn(modelRRaw);
      expect(t).not.toBeNull();
      expect(t.id).toBe('r_a45b970914710bd8');
      expect(t.turnId).toBe('c_0362260dfd6b7882');
      expect(t.text).toBe('Другой ответ модели');

      const tc = L.extractStreamModelTurn(modelRcRaw);
      expect(tc.text).not.toMatch(/\$AVuibg/);
    });

    it('walker\'ы устойчивы к мусорному вводу (мусор → null)', () => {
      expect(L.extractStreamUserTurn('')).toBeNull();
      expect(L.extractStreamModelTurn(')]}\'\ngarbage\n')).toBeNull();
      expect(L.extractStreamUserTurn(modelRcRaw)).toBeNull();
      expect(L.extractStreamModelTurn(userRaw)).toBeNull();
    });
  });
});