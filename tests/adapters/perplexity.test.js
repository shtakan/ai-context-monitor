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

  describe('parsePerplexityThread — REST /rest/thread/{slug} (без blocks, ответ в entry.text)', () => {
    const restFixturePath = path.join(__dirname, '..', 'fixtures', 'perplexity-thread-rest.json');
    // фикстура изъята из репозитория по приватности (H26) — REST-тесты пропускаются, если файла нет
    const hasRestFixture = fs.existsSync(restFixturePath);
    if (!hasRestFixture) {
      console.info('perplexity-thread-rest.json: фикстура отсутствует — пропуск');
    }
    const restIt = hasRestFixture ? it : it.skip;
    const restFixture = hasRestFixture ? JSON.parse(fs.readFileSync(restFixturePath, 'utf8')) : null;

    restIt('count=4 (2 user + 2 assistant), роли чередуются user/assistant', () => {
      const result = parsePerplexityThread(restFixture);
      expect(result.count).toBe(4);
      expect(result.messages).toHaveLength(4);
      expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    });

    restIt('текст ассистента извлекается из FINAL-шага entry.text (content.answer → поле answer)', () => {
      const result = parsePerplexityThread(restFixture);
      expect(result.messages[0].text).toBe('Тест. Напиши ответ в 10 полных строк длиной.');
      expect(result.messages[1].text).toContain('Это тестовое сообщение, состоящее ровно из десяти полных строк');
      expect(result.messages[2].text).toBe('Тест. Напиши ответ в 30 полных строк длиной.');
      expect(result.messages[3].text).toContain('Это тестовое сообщение, состоящее ровно из тридцати полных строк');
    });

    restIt('textLen включает тексты ответов: 89 (user) + 4375 (assistant) + 2 разделителя = 4466', () => {
      const result = parsePerplexityThread(restFixture);
      expect(result.text.length).toBe(4466);
      // ассистентские тексты действительно попали в общий текст
      expect(result.text).toContain('Это тестовое сообщение, состоящее ровно из десяти полных строк');
      expect(result.text).toContain('Это тестовое сообщение, состоящее ровно из тридцати полных строк');
    });

    it('blocks-приоритет: при наличии blocks fallback из entry.text не дублирует сообщение', () => {
      // копия blocks-фикстуры, в каждый entry добавлен REST-текст с «дублем» ответа
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'perplexity-thread.json');
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
      const merged = JSON.parse(JSON.stringify(fixture));
      // фикстура использует пробельные ключи ("entries ") — находим массив по trim
      const entriesKey = Object.keys(merged).find((k) => k.trim() === 'entries');
      merged[entriesKey].forEach((entry) => {
        const fakeSteps = [
          { step_type: 'INITIAL_QUERY', content: { query: entry.query_str } },
          { step_type: 'FINAL', content: { answer: JSON.stringify({ answer: 'СИНТЕТИКА-ДУБЛЬ-FALLBACK' }) } }
        ];
        entry.text = JSON.stringify(fakeSteps);
      });

      const result = parsePerplexityThread(merged);
      expect(result.messages).toHaveLength(4);
      expect(result.messages[1].text).toContain('Синтетический ответ один.');
      expect(result.messages[1].text).not.toContain('СИНТЕТИКА-ДУБЛЬ-FALLBACK');
      expect(result.messages[3].text).toContain('Синтетический ответ два (часть 1).');
    });
  });

  // ===================================================================================
  // Защитные ветки парсера (карта задачи 1.1: branches utils/perplexity-parser.js).
  // Фикстура REST изъята из репозитория (H26), поэтому fallback entry.text проверяется
  // синтетическими входами той же формы, что отдаёт живой /rest/thread/{slug}.
  // ===================================================================================
  describe('Perplexity thread parser — защитные ветки', () => {
    it('entries не массив → пустой результат', () => {
      const result = parsePerplexityThread({ 'entries ': 'не массив' });
      expect(result.messages).toHaveLength(0);
      expect(result.count).toBe(0);
    });

    it('entries undefined → пустой результат', () => {
      const result = parsePerplexityThread({});
      expect(result.messages).toHaveLength(0);
      expect(result.count).toBe(0);
    });

    it('json не объект (null/строка/число) → пустой результат без исключения', () => {
      expect(parsePerplexityThread(null).messages).toHaveLength(0);
      expect(parsePerplexityThread(undefined).messages).toHaveLength(0);
      expect(parsePerplexityThread('строка').messages).toHaveLength(0);
      expect(parsePerplexityThread(42).messages).toHaveLength(0);
    });

    it('entry не объект → пропускается', () => {
      const result = parsePerplexityThread({ 'entries ': [null, 'строка', 42, { 'query_str ': 'ok' }] });
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].text).toBe('ok');
    });

    it('query_str не строка → user-сообщение не добавляется', () => {
      const result = parsePerplexityThread({ 'entries ': [{ 'query_str ': 12345 }] });
      expect(result.messages).toHaveLength(0);
    });

    it('query_str из пробелов → user-сообщение не добавляется', () => {
      const result = parsePerplexityThread({ 'entries ': [{ 'query_str ': '    ' }] });
      expect(result.messages).toHaveLength(0);
    });

    it('blocks не массив → fallback на entry.text (только user, без ответа)', () => {
      const result = parsePerplexityThread({ 'entries ': [{ 'query_str ': 'q', 'blocks ': 'не массив' }] });
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('user');
    });

    it('block не объект → пропускается', () => {
      const result = parsePerplexityThread({ 'entries ': [{ 'query_str ': 'q', 'blocks ': [null, 'строка', 42] }] });
      expect(result.messages).toHaveLength(1);
    });

    it('step не объект → пропускается', () => {
      const result = parsePerplexityThread({
        'entries ': [{ 'query_str ': 'q', 'blocks ': [{ 'workflow_block ': { 'steps ': [null, 42] } }] }]
      });
      expect(result.messages).toHaveLength(1);
    });

    it('steps не массив → пропускается', () => {
      const result = parsePerplexityThread({
        'entries ': [{ 'query_str ': 'q', 'blocks ': [{ 'workflow_block ': { 'steps ': 'не массив' } }] }]
      });
      expect(result.messages).toHaveLength(1);
    });

    it('items не массив → пропускается', () => {
      const result = parsePerplexityThread({
        'entries ': [{ 'query_str ': 'q', 'blocks ': [{ 'workflow_block ': { 'steps ': [{ 'items ': 'не массив' }] } }] }]
      });
      expect(result.messages).toHaveLength(1);
    });

    it('item без type=WORKFLOW_ITEM_TEXT отбрасывается, невалидный payload — тоже', () => {
      const result = parsePerplexityThread({
        'entries ': [{
          'query_str ': 'q',
          'blocks ': [{
            'workflow_block ': {
              'steps ': [{
                'items ': [
                  null,
                  42,
                  { 'type': 'OTHER', 'payload': { 'text_payload': { 'text': 'не берём' } } },
                  { 'type': 'WORKFLOW_ITEM_TEXT', 'payload': 'не объект' },
                  { 'type': 'WORKFLOW_ITEM_TEXT', 'payload': { 'text_payload': 'не объект' } },
                  { 'type': 'WORKFLOW_ITEM_TEXT', 'payload': { 'text_payload': { 'text': '   ' } } }
                ]
              }]
            }
          }]
        }]
      });
      expect(result.messages).toHaveLength(1);
    });

    it('web_results не массив → пропускается', () => {
      const result = parsePerplexityThread({
        'entries ': [{ 'query_str ': 'q', 'blocks ': [{ 'web_result_block ': { 'web_results ': 'не массив' } }] }]
      });
      expect(result.messages).toHaveLength(1);
    });

    it('wr не объект → пропускается', () => {
      const result = parsePerplexityThread({
        'entries ': [{ 'query_str ': 'q', 'blocks ': [{ 'web_result_block ': { 'web_results ': [null, 42] } }] }]
      });
      expect(result.messages).toHaveLength(1);
    });

    it('источник без name и snippet → не попадает в ответ', () => {
      const result = parsePerplexityThread({
        'entries ': [{ 'query_str ': 'q', 'blocks ': [{ 'web_result_block ': { 'web_results': [{ 'url': 'https://x' }] } }] }]
      });
      expect(result.messages).toHaveLength(1);
    });

    it('источник только со snippet → [source] без имени', () => {
      const result = parsePerplexityThread({
        'entries ': [{ 'query_str ': 'q', 'blocks ': [{ 'web_result_block ': { 'web_results': [{ 'snippet': 'сниппет' }] } }] }]
      });
      expect(result.messages).toHaveLength(2);
      expect(result.messages[1].text).toBe('[source] сниппет');
    });

    it('источник только с name → [source] с именем (хвостовой пробел срезан trim)', () => {
      const result = parsePerplexityThread({
        'entries ': [{ 'query_str ': 'q', 'blocks ': [{ 'web_result_block ': { 'web_results': [{ 'name': 'Источник' }] } }] }]
      });
      expect(result.messages[1].text).toBe('[source] Источник:');
    });

    it('источник с name и snippet → «имя: сниппет»', () => {
      const result = parsePerplexityThread({
        'entries ': [{
          'query_str ': 'q',
          'blocks ': [{ 'web_result_block ': { 'web_results': [{ 'name': 'Источник', 'snippet': 'сниппет' }] } }]
        }]
      });
      expect(result.messages[1].text).toBe('[source] Источник: сниппет');
    });

    it('блоки с не-объектными wfBlock/wrBlock → getTrim на не-объекте, ответа нет', () => {
      const result = parsePerplexityThread({
        'entries ': [{
          'query_str ': 'q',
          'blocks ': [
            { 'workflow_block ': 'не объект', 'web_result_block ': 'не объект' },
            { 'workflow_block ': null }
          ]
        }]
      });
      expect(result.messages).toHaveLength(1);
    });
  });

  describe('Perplexity thread parser — fallback entry.text (FINAL-шаг)', () => {
    // Живой REST: entry.text — JSON-строка массива шагов, FINAL-шаг несёт content.answer.
    function entryWithText(text) {
      return { 'entries ': [{ 'query_str ': 'q', 'text ': text }] };
    }

    it('stepContent строка с невалидным JSON → ответ не извлекается, остаётся только user', () => {
      const result = parsePerplexityThread(entryWithText(
        JSON.stringify([{ step_type: 'FINAL', content: 'не JSON{ строка' }])
      ));
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('user');
    });

    it('entry.text не JSON → парсер не падает, остаётся только user', () => {
      const result = parsePerplexityThread(entryWithText('это не JSON'));
      expect(result.messages).toHaveLength(1);
    });

    it('entry.text из пробелов → fallback не срабатывает', () => {
      const result = parsePerplexityThread(entryWithText('   '));
      expect(result.messages).toHaveLength(1);
    });

    it('шаги не FINAL (INITIAL_QUERY) → ответ не добавляется', () => {
      const result = parsePerplexityThread(entryWithText(
        JSON.stringify([{ step_type: 'INITIAL_QUERY', content: { answer: JSON.stringify({ answer: 'мимо' }) } }])
      ));
      expect(result.messages).toHaveLength(1);
    });

    it('шаг не объект → пропускается', () => {
      const result = parsePerplexityThread(entryWithText(JSON.stringify([null, 'строка', 7])));
      expect(result.messages).toHaveLength(1);
    });

    it('content отсутствует → ответ не добавляется', () => {
      const result = parsePerplexityThread(entryWithText(JSON.stringify([{ step_type: 'FINAL' }])));
      expect(result.messages).toHaveLength(1);
    });

    it('answerRaw не строка и не объект (число) → ответ не добавляется', () => {
      const result = parsePerplexityThread(entryWithText(
        JSON.stringify([{ step_type: 'FINAL', content: { answer: 12345 } }])
      ));
      expect(result.messages).toHaveLength(1);
    });

    it('answerRaw строка без вложенного JSON → ответ не добавляется', () => {
      const result = parsePerplexityThread(entryWithText(
        JSON.stringify([{ step_type: 'FINAL', content: { answer: 'просто текст' } }])
      ));
      expect(result.messages).toHaveLength(1);
    });

    it('answerRaw — объект с полем answer → ответ берётся напрямую', () => {
      const result = parsePerplexityThread(entryWithText(
        JSON.stringify([{ step_type: 'FINAL', content: { answer: { answer: 'объектная ветка' } } }])
      ));
      expect(result.messages).toHaveLength(2);
      expect(result.messages[1].text).toBe('объектная ветка');
    });

    it('answerObj — строка (двойное кодирование) → используется как answerText', () => {
      const result = parsePerplexityThread(entryWithText(
        JSON.stringify([{ step_type: 'FINAL', content: JSON.stringify({ answer: '"прямая строка"' }) }])
      ));
      expect(result.messages).toHaveLength(2);
      expect(result.messages[1].text).toBe('прямая строка');
    });

    it('answerObj — объект (JSON-строка внутри строки) → поле answer извлекается', () => {
      const result = parsePerplexityThread(entryWithText(
        JSON.stringify([{ step_type: 'FINAL', content: JSON.stringify({ answer: JSON.stringify({ answer: 'вложенный объект' }) }) }])
      ));
      expect(result.messages).toHaveLength(2);
      expect(result.messages[1].text).toBe('вложенный объект');
    });

    it('content — объект с полем answer (строкой JSON) → ответ извлекается', () => {
      const result = parsePerplexityThread(entryWithText(
        JSON.stringify([{ step_type: 'FINAL', content: { answer: JSON.stringify({ answer: 'из content-объекта' }) } }])
      ));
      expect(result.messages).toHaveLength(2);
      expect(result.messages[1].text).toBe('из content-объекта');
    });

    it('answerObj — пустой объект → ответа нет', () => {
      const result = parsePerplexityThread(entryWithText(
        JSON.stringify([{ step_type: 'FINAL', content: JSON.stringify({ answer: '{}' }) }])
      ));
      expect(result.messages).toHaveLength(1);
    });

    it('stepItems из объекта (не массив) → Object.keys().map', () => {
      const stepsObj = { a: { step_type: 'FINAL', content: { answer: '"из объекта"' } } };
      const result = parsePerplexityThread(entryWithText(JSON.stringify(stepsObj)));
      expect(result.messages).toHaveLength(2);
      expect(result.messages[1].text).toBe('из объекта');
    });

    it('первый FINAL без ответа, второй с ответом → берётся валидный', () => {
      const result = parsePerplexityThread(entryWithText(JSON.stringify([
        { step_type: 'FINAL', content: { answer: 'не JSON' } },
        { step_type: 'FINAL', content: { answer: JSON.stringify({ answer: 'второй шаг' }) } }
      ])));
      expect(result.messages).toHaveLength(2);
      expect(result.messages[1].text).toBe('второй шаг');
    });

    it('blocks приоритетнее entry.text: fallback не добавляет дубль', () => {
      const entry = {
        'query_str ': 'q',
        'blocks ': [{
          'workflow_block ': {
            'steps ': [{ 'items ': [{ 'type': 'WORKFLOW_ITEM_TEXT', 'payload': { 'text_payload': { 'text': 'из блоков' } } }] }]
          }
        }],
        'text ': JSON.stringify([{ step_type: 'FINAL', content: { answer: JSON.stringify({ answer: 'из текста' }) } }])
      };
      const result = parsePerplexityThread({ 'entries ': [entry] });
      expect(result.messages).toHaveLength(2);
      expect(result.messages[1].text).toBe('из блоков');
    });

    it('thread_url_slug задаёт id, display_model — модель', () => {
      const result = parsePerplexityThread({
        'entries ': [{
          'query_str ': 'q',
          'display_model': 'turbo',
          'thread_url_slug': 'slug-1',
          'text ': JSON.stringify([{ step_type: 'FINAL', content: { answer: JSON.stringify({ answer: 'ответ' }) } }])
        }]
      });
      expect(result.model).toBe('turbo');
      expect(result.ids).toEqual(['slug-1_user', 'slug-1_assistant']);
      expect(result.count).toBe(2);
    });

    it('user_selected_model используется, когда display_model пуст', () => {
      const result = parsePerplexityThread({ 'entries ': [{ 'query_str ': 'q', 'user_selected_model': 'sonar' }] });
      expect(result.modelSlug).toBe('sonar');
    });
  });
});
