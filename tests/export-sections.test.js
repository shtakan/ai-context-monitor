'use strict';

/**
 * Фаза 4: чистый сбор секций (artifacts Claude, sources Perplexity).
 * Рендер в файлы — следующий шаг; здесь только данные и дедуп.
 */

const { messageSections, threadSections } = require('../utils/export/sections.ts');

describe('export/sections: одно сообщение', () => {
  test('artifact + reasoning + sources читаются как данные', function () {
    const sec = messageSections({
      role: 'assistant',
      text: 'ответ',
      reasoning: '  думаю  ',
      turnId: 't1',
      artifact: { name: 'report.md', mime: 'text/markdown', content: '# отчёт' },
      sources: [
        { title: 'Пример', url: 'https://example.com', snippet: 'фрагмент' },
        { url: 'https://no-title.example' }
      ]
    });
    expect(sec.reasoning).toBe('думаю');
    expect(sec.artifacts).toEqual([{ name: 'report.md', mime: 'text/markdown', content: '# отчёт', turnId: 't1' }]);
    expect(sec.sources).toHaveLength(2);
    expect(sec.sources[0]).toEqual({ title: 'Пример', url: 'https://example.com', snippet: 'фрагмент', turnId: 't1' });
    expect(sec.sources[1].title).toBe('https://no-title.example');
  });

  test('массив artifacts и мусор: пустые/не-объекты игнорируются', function () {
    const sec = messageSections({
      artifacts: [
        { name: 'a.txt', content: 'A' },
        { name: '  ' },
        null,
        'строка'
      ]
    });
    expect(sec.artifacts.map(function (a) { return a.name; })).toEqual(['a.txt']);
  });

  test('не-объект/пустое сообщение → пустые секции', function () {
    expect(messageSections(null)).toEqual({ artifacts: [], sources: [] });
    expect(messageSections({ role: 'user', text: 'q' })).toEqual({ artifacts: [], sources: [] });
  });
});

describe('export/sections: тред и дедуп', () => {
  test('артефакты и источники собираются по порядку и дедуплицируются', function () {
    const out = threadSections([
      { role: 'assistant', text: 'a', artifact: { name: 'a.txt', content: 'A' }, reasoning: 'r1' },
      { role: 'assistant', text: 'b', artifact: { name: 'a.txt', content: 'A' }, sources: [{ title: 'S', url: 'u' }] },
      { role: 'assistant', text: 'c', artifacts: [{ name: 'b.txt', content: 'B' }], sources: [{ title: 'S', url: 'u' }], reasoning: 'r2' }
    ]);
    expect(out.artifacts.map(function (a) { return a.name; })).toEqual(['a.txt', 'b.txt']);
    expect(out.sources).toHaveLength(1);
    expect(out.reasoningCount).toBe(2);
  });

  test('пустой/не-массив → пустая сводка', function () {
    expect(threadSections(null)).toEqual({ artifacts: [], sources: [], reasoningCount: 0 });
    expect(threadSections([])).toEqual({ artifacts: [], sources: [], reasoningCount: 0 });
  });
});
