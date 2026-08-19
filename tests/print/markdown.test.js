/**
 * Юнит-тесты markdown-конвертера для печатной формы (utils/markdown.js).
 * Покрывают: таблицы, code-блоки, списки (включая «- **Метка**: текст»),
 * экранирование HTML, заголовки и инлайн-разметку.
 */

const MarkdownRenderer = require('../../utils/markdown.js');

describe('MarkdownRenderer.render — таблицы', () => {
  test('превращает markdown-таблицу в HTML-таблицу', () => {
    const md = [
      '| Колонка A | Колонка B |',
      '| --------- | --------- |',
      '| Ячейка 1  | Ячейка 2  |',
      '| Ячейка 3  | Ячейка 4  |'
    ].join('\n');
    const html = MarkdownRenderer.render(md);
    expect(html).toContain('<table><thead><tr><th>Колонка A</th><th>Колонка B</th></tr></thead>');
    expect(html).toContain('<tbody>');
    expect(html).toContain('<td>Ячейка 1</td>');
    expect(html).toContain('<td>Ячейка 4</td>');
    expect(html).toContain('</table>');
  });
});

describe('MarkdownRenderer.render — code-блоки', () => {
  test('code-ограждение с языком рендерится в pre/code с data-lang', () => {
    const md = '```js\nconst x = 1;\nconsole.log(x);\n```';
    const html = MarkdownRenderer.render(md);
    expect(html).toContain('<pre data-lang="js"><code>');
    expect(html).toContain('const x = 1;\nconsole.log(x);');
    expect(html).toContain('</code></pre>');
  });

  test('вложенный HTML внутри code-блока экранируется', () => {
    const md = '```\n<script>alert(1)</script>\n```';
    const html = MarkdownRenderer.render(md);
    expect(html).toContain('&' + 'lt;script' + '&' + 'gt;alert(1)' + '&' + 'lt;/script' + '&' + 'gt;');
    expect(html).not.toContain('<script>');
  });
});

describe('MarkdownRenderer.render — списки', () => {
  test('ненумерованный список рендерится в ul/li', () => {
    const md = '- первый\n- второй\n- третий';
    const html = MarkdownRenderer.render(md);
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>первый</li>');
    expect(html).toContain('<li>второй</li>');
    expect(html).toContain('<li>третий</li>');
    expect(html).toContain('</ul>');
  });

  test('список «- **Метка**: текст» даёт жирную метку в li', () => {
    const md = '- **Метка**: текст';
    const html = MarkdownRenderer.render(md);
    expect(html).toContain('<ul>');
    expect(html).toContain('<li><strong>Метка</strong>: текст</li>');
  });

  test('нумерованный список рендерится в ol', () => {
    const md = '1. один\n2. два';
    const html = MarkdownRenderer.render(md);
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>один</li>');
    expect(html).toContain('</ol>');
  });
});

describe('MarkdownRenderer.render — экранирование HTML', () => {
  test('произвольный HTML в тексте экранируется и не попадает в разметку', () => {
    const md = 'Тест <img src=x onerror=alert(1)> и текст';
    const html = MarkdownRenderer.render(md);
    expect(html).toContain('&' + 'lt;img src=x onerror=alert(1)' + '&' + 'gt;');
    expect(html).not.toContain('<img');
  });

  test('амперсанд и кавычки экранируются', () => {
    const html = MarkdownRenderer.render('a & b "кавычки"');
    expect(html).toContain('a &' + 'amp; b &' + 'quot;кавычки&' + 'quot;');
  });
});

describe('MarkdownRenderer.render — заголовки и инлайн', () => {
  test('заголовки H1–H2 рендерятся в h1/h2', () => {
    const md = '# Заголовок 1\n\n## Заголовок 2';
    const html = MarkdownRenderer.render(md);
    expect(html).toContain('<h1>Заголовок 1</h1>');
    expect(html).toContain('<h2>Заголовок 2</h2>');
  });

  test('жирный, курсив и инлайн-код рендерятся в strong/em/code', () => {
    const html = MarkdownRenderer.render('**жирный** и *курсив* и `код`');
    expect(html).toContain('<strong>жирный</strong>');
    expect(html).toContain('<em>курсив</em>');
    expect(html).toContain('<code>код</code>');
  });

  test('ссылки рендерятся в a с безопасным протоколом', () => {
    const html = MarkdownRenderer.render('[ссылка](https://example.com)');
    expect(html).toContain('<a href="https://example.com">ссылка</a>');
  });

  test('ссылки с javascript: не рендерятся, остаются текстом', () => {
    const md = '[вредно](javascript:alert(1))';
    const html = MarkdownRenderer.render(md);
    expect(html).not.toContain('<a href="javascript:');
  });

  test('кириллица не искажается', () => {
    const html = MarkdownRenderer.render('Привет, мир! Это сообщение на русском. Перевод: контекст, модель, токены.');
    expect(html).toContain('Привет, мир! Это сообщение на русском. Перевод: контекст, модель, токены.');
  });
});