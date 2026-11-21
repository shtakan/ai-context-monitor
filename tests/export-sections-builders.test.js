'use strict';

/**
 * Фаза 4: artifacts/sources в файлах — аддитивно.
 * Пустые секции не меняют байты; непустые добавляют JSON-поля и MD/TXT-блоки.
 */

const loadEsm = require('./helpers/load-esm.js');
const Builders = loadEsm.loadEsmGlobal('utils/export-text-builders.ts', 'AiCmExportBuilders');

function history(messages) {
  return {
    site: 'claude',
    model: 'Claude',
    tokens: 100,
    limit: 200000,
    percent: 0.1,
    messages: messages
  };
}

const WITH_SECTIONS = [
  { role: 'user', text: 'вопрос' },
  {
    role: 'assistant',
    text: 'ответ',
    artifact: { name: 'report.md', mime: 'text/markdown', content: '# отчёт' },
    sources: [{ title: 'Пример', url: 'https://example.com', snippet: 'фрагмент' }]
  }
];

describe('export builders: sections', () => {
  test('JSON: artifacts/sources появляются только при непустых секциях', function () {
    const doc = JSON.parse(Builders.buildJsonFromHistory(history(WITH_SECTIONS), 'claude'));
    expect(doc.artifacts).toEqual([{ name: 'report.md', mime: 'text/markdown', content: '# отчёт' }]);
    expect(doc.sources).toEqual([{ title: 'Пример', url: 'https://example.com', snippet: 'фрагмент' }]);

    const empty = JSON.parse(Builders.buildJsonFromHistory(history([{ role: 'user', text: 'q' }]), 'claude'));
    expect('artifacts' in empty).toBe(false);
    expect('sources' in empty).toBe(false);
  });

  test('MD: блоки ARTIFACTS/SOURCES после сообщений', function () {
    const md = Builders.buildMdFromHistory(history(WITH_SECTIONS), 'Claude');
    expect(md).toContain('## ARTIFACTS');
    expect(md).toContain('### report.md (text/markdown)');
    expect(md).toContain('# отчёт');
    expect(md).toContain('## SOURCES');
    expect(md).toContain('[Пример](https://example.com)');
    expect(md).toContain('фрагмент');
  });

  test('TXT: блоки [ARTIFACTS]/[SOURCES] после сообщений', function () {
    const txt = Builders.buildTxtFromHistory(history(WITH_SECTIONS));
    expect(txt).toContain('[ARTIFACTS]');
    expect(txt).toContain('report.md (text/markdown)');
    expect(txt).toContain('[SOURCES]');
    expect(txt).toContain('- Пример — https://example.com — фрагмент');
  });

  test('пустые секции не добавляют ни одного байта', function () {
    const h = history([{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }]);
    const md = Builders.buildMdFromHistory(h, 'Claude');
    const txt = Builders.buildTxtFromHistory(h);
    expect(md).not.toContain('## ARTIFACTS');
    expect(md).not.toContain('## SOURCES');
    expect(txt).not.toContain('[ARTIFACTS]');
    expect(txt).not.toContain('[SOURCES]');
  });
});
