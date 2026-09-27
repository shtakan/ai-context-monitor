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

// =====================================================================================
// Карта задачи 1.1: добивание branches utils/markdown.js (H3–H6, пустая таблица,
// не-строка, пустой URL, подчёркивание, прерывание параграфа блоком).
// =====================================================================================
describe('MarkdownRenderer.render — заголовки H3–H6', () => {
  test('заголовки H3–H6 рендерятся корректно', () => {
    const html = MarkdownRenderer.render('### H3\n\n#### H4\n\n##### H5\n\n###### H6');
    expect(html).toContain('<h3>H3</h3>');
    expect(html).toContain('<h4>H4</h4>');
    expect(html).toContain('<h5>H5</h5>');
    expect(html).toContain('<h6>H6</h6>');
  });

  test('заголовок с инлайн-разметкой обрабатывается как инлайн', () => {
    const html = MarkdownRenderer.render('### Заголовок с `кодом`');
    expect(html).toContain('<h3>Заголовок с <code>кодом</code></h3>');
  });
});

describe('MarkdownRenderer.render — таблицы (краевые случаи)', () => {
  test('таблица без строк тела → нет tbody', () => {
    const md = '| A | B |\n| - | - |';
    const html = MarkdownRenderer.render(md);
    expect(html).toContain('<table><thead>');
    expect(html).not.toContain('<tbody>');
    expect(html).toContain('<th>A</th><th>B</th>');
  });

  test('таблица с выравниванием (:---:) распознаётся как таблица', () => {
    const md = '| A | B |\n| :--- | ---: |\n| 1 | 2 |';
    const html = MarkdownRenderer.render(md);
    expect(html).toContain('<table><thead>');
    expect(html).toContain('<tbody>');
    expect(html).toContain('<td>1</td>');
  });

  test('строка без | завершает таблицу, дальше идёт параграф', () => {
    const md = '| A |\n| - |\n| 1 |\nобычный текст';
    const html = MarkdownRenderer.render(md);
    expect(html).toContain('<tbody><tr><td>1</td></tr></tbody>');
    expect(html).toContain('<p>обычный текст</p>');
  });

  test('строка, начинающаяся с |, но без строки-разделителя ниже — не таблица', () => {
    const html = MarkdownRenderer.render('| не таблица |');
    expect(html).not.toContain('<table>');
    expect(html).toContain('<p>| не таблица |</p>');
  });
});

describe('MarkdownRenderer.render — вход не-строка', () => {
  test('render(не-строка) → пустая строка', () => {
    expect(MarkdownRenderer.render(null)).toBe('');
    expect(MarkdownRenderer.render(undefined)).toBe('');
    expect(MarkdownRenderer.render(123)).toBe('');
    expect(MarkdownRenderer.render({})).toBe('');
    expect(MarkdownRenderer.render([])).toBe('');
    expect(MarkdownRenderer.render(true)).toBe('');
  });

  test('пустая строка и строка из пробелов → пустой HTML', () => {
    expect(MarkdownRenderer.render('')).toBe('');
    expect(MarkdownRenderer.render('   \n\t ')).toBe('');
  });
});

describe('MarkdownRenderer.render — ссылки и подчёркивание', () => {
  test('ссылка с пустым URL остаётся текстом', () => {
    const html = MarkdownRenderer.render('[текст]()');
    expect(html).not.toContain('<a');
    expect(html).toContain('[текст]');
  });

  test('ссылка с относительным и mailto-протоколом рендерится', () => {
    expect(MarkdownRenderer.render('[путь](/docs/a)')).toContain('<a href="/docs/a">путь</a>');
    expect(MarkdownRenderer.render('[почта](mailto:a@b.c)')).toContain('<a href="mailto:a@b.c">почта</a>');
    expect(MarkdownRenderer.render('[якорь](#top)')).toContain('<a href="#top">якорь</a>');
  });

  test('подчёркивание _текст_ рендерится в em', () => {
    const html = MarkdownRenderer.render('_курсив подчёркиванием_');
    expect(html).toContain('<em>курсив подчёркиванием</em>');
  });

  test('двойное подчёркивание __текст__ не создаёт пустой em', () => {
    const html = MarkdownRenderer.render('__текст__');
    expect(html).not.toContain('<em></em>');
  });
});

describe('MarkdownRenderer.render — параграф, прерванный блоком', () => {
  test('параграф прерывается заголовком', () => {
    const md = 'Строка параграфа\n\n## Заголовок\n\nЕщё параграф';
    const html = MarkdownRenderer.render(md);
    expect(html).toContain('<p>Строка параграфа</p>');
    expect(html).toContain('<h2>Заголовок</h2>');
    expect(html).toContain('<p>Ещё параграф</p>');
  });

  test('заголовок прерывает параграф без пустой строки между ними', () => {
    const html = MarkdownRenderer.render('Текст абзаца\n## Заголовок');
    expect(html).toContain('<p>Текст абзаца</p>');
    expect(html).toContain('<h2>Заголовок</h2>');
  });

  test('параграф прерывается code-блоком', () => {
    const md = 'Текст до\n\n```\nкод\n```\n\nТекст после';
    const html = MarkdownRenderer.render(md);
    expect(html).toContain('<p>Текст до</p>');
    expect(html).toContain('<pre');
    expect(html).toContain('<p>Текст после</p>');
  });

  test('code-блок прерывает параграф без пустой строки', () => {
    const html = MarkdownRenderer.render('Текст\n```\nкод\n```');
    expect(html).toContain('<p>Текст</p>');
    expect(html).toContain('<pre><code>код</code></pre>');
  });

  test('параграф прерывается списком', () => {
    const md = 'Текст\n\n- пункт';
    const html = MarkdownRenderer.render(md);
    expect(html).toContain('<p>Текст</p>');
    expect(html).toContain('<ul>');
  });

  test('список прерывает параграф без пустой строки', () => {
    const html = MarkdownRenderer.render('Текст\n- пункт');
    expect(html).toContain('<p>Текст</p>');
    expect(html).toContain('<ul><li>пункт</li></ul>');
  });

  test('таблица прерывает параграф без пустой строки', () => {
    const html = MarkdownRenderer.render('Текст абзаца\n| A |\n| - |\n| 1 |');
    expect(html).toContain('<p>Текст абзаца</p>');
    expect(html).toContain('<table><thead>');
    expect(html).toContain('<td>1</td>');
  });

  test('многострочный абзац остаётся одним <p> с переводами строк', () => {
    const html = MarkdownRenderer.render('Первая строка\nВторая строка\nТретья строка');
    expect(html).toBe('<p>Первая строка\nВторая строка\nТретья строка</p>');
  });

  test('список «- **Метка**: текст» внутри абзаца прерывает его', () => {
    const html = MarkdownRenderer.render('Абзац\n- **Метка**: текст');
    expect(html).toContain('<p>Абзац</p>');
    expect(html).toContain('<li><strong>Метка</strong>: текст</li>');
  });
});