/**
 * Юнит-тесты сборки plain-text «эталона» (utils/buildReferenceText.js).
 * Покрывают: порядок сообщений, разделитель ровно одной пустой строкой,
 * LF-переводы, отсутствие BOM и консервативную зачистку markdown-разметки:
 * заголовки, списки, жирность/курсив, цитаты, разделители "---",
 * ссылки, обратные кавычки.
 */

const buildReferenceText = require('../../utils/buildReferenceText.js');

describe('buildReferenceText — порядок и содержимое', () => {
  test('сообщения идут строго по порядку исходного массива', () => {
    const messages = [
      { role: 'user', text: 'первое' },
      { role: 'assistant', text: 'второе' },
      { role: 'user', text: 'третье' }
    ];
    const out = buildReferenceText(messages);
    expect(out.indexOf('первое')).toBe(0);
    expect(out.indexOf('второе')).toBeGreaterThan(out.indexOf('первое'));
    expect(out.indexOf('третье')).toBeGreaterThan(out.indexOf('второе'));
  });

  test('текст сообщений без ролевых заголовков', () => {
    const messages = [
      { role: 'user', text: 'Привет' },
      { role: 'assistant', text: 'Здравствуйте' }
    ];
    const out = buildReferenceText(messages);
    expect(out).toContain('Привет');
    expect(out).toContain('Здравствуйте');
    expect(out).not.toContain('## Пользователь');
    expect(out).not.toContain('## Ассистент');
  });
});

describe('buildReferenceText — зачистка markdown', () => {
  test('заголовки: маркеры #{1,6} в начале строки убираются', () => {
    const out = buildReferenceText([
      { role: 'assistant', text: '# Заголовок 1\n## Заголовок 2\n###### Шестой' }
    ]);
    expect(out).toBe('Заголовок 1\nЗаголовок 2\nШестой');
  });

  test('неупорядоченные списки: "* ", "- ", "+ " в начале строки убираются', () => {
    const out = buildReferenceText([
      { role: 'assistant', text: '* первый\n- второй\n+ третий' }
    ]);
    expect(out).toBe('первый\nвторой\nтретий');
  });

  test('нумерованные списки "N. " сохраняются', () => {
    const out = buildReferenceText([
      { role: 'assistant', text: '1. первый\n2. второй' }
    ]);
    expect(out).toBe('1. первый\n2. второй');
  });

  test('жирность и курсив: **, __, одиночные * и _ убираются', () => {
    const out = buildReferenceText([
      { role: 'assistant', text: '**жирный** и __тоже__, *курсив* и _так_ и mix**bold**_italic_' }
    ]);
    expect(out).not.toContain('**');
    expect(out).not.toContain('__');
    expect(out).not.toContain('*курсив*');
    expect(out).not.toContain('_так_');
    expect(out).toContain('жирный');
    expect(out).toContain('тоже');
    expect(out).toContain('курсив');
    expect(out).toContain('так');
  });

  test('цитата: "> " в начале строки убирается, символ вроде ⚠ остаётся', () => {
    const out = buildReferenceText([
      { role: 'assistant', text: '> цитата\n> ⚠ предупреждение' }
    ]);
    expect(out).not.toContain('> ');
    expect(out).toContain('цитата');
    expect(out).toContain('⚠ предупреждение');
  });

  test('строки-разделители "---" удаляются целиком', () => {
    const out = buildReferenceText([
      { role: 'assistant', text: 'до\n---\nпосле' }
    ]);
    expect(out).toBe('до\nпосле');
    expect(out).not.toContain('-');
  });

  test('ссылки [text](url) заменяются на text', () => {
    const out = buildReferenceText([
      { role: 'assistant', text: 'смотри [документацию](https://example.com/doc) и ещё раз' }
    ]);
    expect(out).toBe('смотри документацию и ещё раз');
    expect(out).not.toContain('https://example.com');
  });

  test('обратные кавычки убираются', () => {
    const out = buildReferenceText([
      { role: 'assistant', text: 'код `const x = 1;` и `инлайн`' }
    ]);
    expect(out).toBe('код const x = 1; и инлайн');
    expect(out).not.toContain('`');
  });

  test('комбинированный пример: все правила вместе', () => {
    const out = buildReferenceText([
      {
        role: 'assistant',
        text: '# Итог\n\n- **ключ**: значение `важное`\n\n> ⚠ Внимание\n\n---\nСмотри [тут](https://example.com).'
      }
    ]);
    expect(out).toBe('Итог\n\nключ: значение важное\n\n⚠ Внимание\n\nСмотри тут.');
  });

  test('регресс: текст без markdown не меняется', () => {
    const plain = 'Простое сообщение без разметки.\nВторая строка.';
    const out = buildReferenceText([{ role: 'user', text: plain }]);
    expect(out).toBe(plain);
  });
});

describe('buildReferenceText — разделители и кодировка', () => {
  test('сообщения разделяются ровно одной пустой строкой', () => {
    const out = buildReferenceText([
      { role: 'user', text: 'а' },
      { role: 'assistant', text: 'б' },
      { role: 'user', text: 'в' }
    ]);
    expect(out.split('\n\n').length).toBe(3);
    expect(out).toBe('а\n\nб\n\nв');
  });

  test('переводы строк LF, без CRLF', () => {
    const out = buildReferenceText([
      { role: 'user', text: 'а' },
      { role: 'assistant', text: 'б' }
    ]);
    expect(out).not.toContain('\r');
  });

  test('без BOM в начале файла', () => {
    const out = buildReferenceText([
      { role: 'user', text: 'первое сообщение' }
    ]);
    expect(out.charCodeAt(0)).not.toBe(0xFEFF);
  });
});