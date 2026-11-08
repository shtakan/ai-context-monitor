/**
 * Регрессия: позиция метки [Image: src] в экспорте Perplexity.
 * Картинка-вложение пользователя должна помечаться в сообщении пользователя
 * (в UI это чип под текстом), а не всплывать строкой [source] image.jpg:
 * в конце ответа ассистента.
 */

const { parsePerplexityThread } = require('../helpers/parse-perplexity-thread');
const Builders = require('../helpers/load-esm.js').loadEsmGlobal('utils/export-text-builders.js', 'AiCmExportBuilders');
const fs = require('fs');
const path = require('path');

const IMAGE_SRC = 'https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/images/900001/00000000-0000-4000-8000-000000000001/image.jpg';

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8'));
}

describe('Perplexity: метка [Image] остаётся в сообщении пользователя', () => {
  describe('shape с blocks (web_result_block)', () => {
    const fixture = readFixture('perplexity-thread-image.json');

    it('метка [Image: src] добавлена в user-сообщение, query_str сохранён', () => {
      const result = parsePerplexityThread(fixture);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].text).toBe(
        'Синтетический вопрос с картинкой?\n[Image: ' + IMAGE_SRC + ']'
      );
    });

    it('дубль одного вложения (разные подписи URL) даёт одну метку', () => {
      const result = parsePerplexityThread(fixture);
      const matches = result.messages[0].text.match(/\[Image:/g) || [];
      expect(matches).toHaveLength(1);
    });

    it('в ответе ассистента нет [source] image.jpg (вложение — не веб-источник)', () => {
      const result = parsePerplexityThread(fixture);
      const assistant = result.messages[1].text;
      expect(assistant).toContain('Ответ с картинкой. [1]');
      expect(assistant).not.toContain('image.jpg');
      expect(assistant).not.toContain('[source] image.jpg');
    });

    it('настоящий веб-источник по-прежнему в конце ответа ассистента', () => {
      const result = parsePerplexityThread(fixture);
      expect(result.messages[1].text).toContain('[source] Источник примера: Сниппет примера.');
    });

    it('соседний обмен без картинок не меняется', () => {
      const result = parsePerplexityThread(fixture);
      expect(result.count).toBe(4);
      expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(result.messages[2].text).toBe('Синтетический вопрос без картинки?');
      expect(result.messages[3].text).toBe('Ответ без картинки.');
    });
  });

  describe('REST-shape (blocks отсутствуют, ответ в entry.text)', () => {
    const fixture = readFixture('perplexity-thread-image-rest.json');

    it('метка [Image: src] добавлена в user-сообщение', () => {
      const result = parsePerplexityThread(fixture);
      expect(result.messages[0].text).toBe(
        'Синтетический вопрос с картинкой (REST)?\n[Image: ' + IMAGE_SRC + ']'
      );
    });

    it('ответ ассистента из FINAL-шага не получает [source] image.jpg', () => {
      const result = parsePerplexityThread(fixture);
      expect(result.messages[1].role).toBe('assistant');
      expect(result.messages[1].text).toBe('Ответ из REST-снимка.');
      expect(result.messages[1].text).not.toContain('[source]');
    });
  });

  it('не-картинка (pdf) в attachments не получает метку [Image]', () => {
    const result = parsePerplexityThread({
      entries: [{
        query_str: 'Вопрос с документом?',
        attachments: ['https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/files/900001/doc.pdf?X-Amz-Signature=TEST'],
        blocks: [{
          web_result_block: {
            web_results: [
              { name: 'doc.pdf', snippet: '', url: 'https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/files/900001/doc.pdf' }
            ]
          }
        }]
      }]
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].text).toBe('Вопрос с документом?');
    expect(result.messages[0].text).not.toContain('[Image');
  });

  it('md-экспорт: метка [Image] в блоке «## Пользователь», не в «## Ассистент»', () => {
    const fixture = readFixture('perplexity-thread-image.json');
    const parsed = parsePerplexityThread(fixture);
    const md = Builders.buildMdFromHistory({
      messages: parsed.messages,
      model: 'Perplexity Sonar'
    }, 'Perplexity');

    const userStart = md.indexOf('## Пользователь');
    const assistantStart = md.indexOf('## Ассистент');
    const secondUserStart = md.indexOf('## Пользователь', userStart + 1);

    expect(userStart).toBeGreaterThan(-1);
    expect(assistantStart).toBeGreaterThan(userStart);
    expect(secondUserStart).toBeGreaterThan(assistantStart);
    // метка в первом блоке пользователя (вместе с его текстом)
    expect(md.slice(userStart, assistantStart)).toContain('[Image: ' + IMAGE_SRC + ']');
    // и ни одной метки в блоке ответа модели
    expect(md.slice(assistantStart, secondUserStart)).not.toContain('[Image:');
  });
});
