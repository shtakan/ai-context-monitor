/**
 * Qwen: тело документа в экспорт не попадает — только метка вложения.
 *
 * Контекст: core/qwen-files.js дописывает к пользовательскому ходу секцию
 * «[FILE: имя]\n<полный текст документа>». Полный текст нужен метрике токенов
 * (он входит в контекст), но в экспортном файле он не нужен: пользователь может
 * открыть/скачать документ в самом чате. Поэтому на выходе экспорта
 * (aiCmCollectExportSource -> aiCmFinalizeExportMessages) тело заменяется
 * меткой; baseText/detail.text и токен-метрика не затрагиваются.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { readCore } = require('./helpers/core-src.js');

const ROOT = path.join(__dirname, '..');
const SRC = readCore('core/export-manager.ts', fs.readFileSync(path.join(ROOT, 'core', 'export-manager.ts'), 'utf8'));

function fnDecl(src, name) {
  const start = src.indexOf('function ' + name + '(');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced declaration: ' + name);
}

function strip(messages) {
  const helper = fnDecl(SRC, 'aiCmStripQwenAttachmentBodies');
  const fn = new Function('messages', helper + '\n return aiCmStripQwenAttachmentBodies(messages);');
  return fn(messages);
}

function finalize(messages, siteName) {
  const stripSrc = fnDecl(SRC, 'aiCmStripQwenAttachmentBodies');
  const helper = fnDecl(SRC, 'aiCmFinalizeExportMessages');
  const fn = new Function('messages', 'currentAdapter', 'aiCmSanitizeEmitUserTexts',
    stripSrc + '\n' + helper + '\n return aiCmFinalizeExportMessages(messages);');
  return fn(messages, { siteName: siteName }, function (m) { return m; });
}

const BODY = 'x'.repeat(5000);

describe('Qwen export: вложение — метка, без тела документа', () => {
  test('полное тело заменяется меткой, вопрос пользователя сохраняется', () => {
    const out = strip([{ role: 'user', text: 'Прочитай PDF\n\n[FILE: pdf-fixture.pdf]\n' + BODY }]);
    expect(out[0].text).toBe('Прочитай PDF\n\n[FILE: pdf-fixture.pdf — вложение; текст не включён в экспорт]');
    expect(out[0].text).not.toContain('xxxxx');
  });

  test('несколько вложений подряд: каждое тело заменено, границы секций сохранены', () => {
    const text = 'Вопрос\n\n[FILE: a.txt]\n' + 'a'.repeat(1200) +
      '\n\n[FILE: b.txt]\n' + 'b'.repeat(1300);
    const out = strip([{ role: 'user', text: text }]);
    expect(out[0].text).toContain('[FILE: a.txt — вложение; текст не включён в экспорт]');
    expect(out[0].text).toContain('[FILE: b.txt — вложение; текст не включён в экспорт]');
    expect(out[0].text).not.toContain('aaaa');
    expect(out[0].text).not.toContain('bbbb');
  });

  test('метки с готовой причиной (404, mime/size) не переписываются', () => {
    const text = 'Вопрос\n\n[FILE: doc.txt — текст не получен: http-404]' +
      '\n\n[FILE: img.png — image/png, 10 Б; изображение не выгружается]';
    const out = strip([{ role: 'user', text: text }]);
    expect(out[0].text).toBe(text);
  });

  test('секция в начале сообщения (файл без текста вопроса) тоже заменяется', () => {
    const out = strip([{ role: 'user', text: '[FILE: only.txt]\n' + 'z'.repeat(700) }]);
    expect(out[0].text).toBe('[FILE: only.txt — вложение; текст не включён в экспорт]');
  });

  test('пустое тело и сообщения без [FILE:] не меняются', () => {
    const empty = '[FILE: empty.txt]\n';
    const plain = 'обычный текст без вложений';
    const out = strip([
      { role: 'user', text: empty },
      { role: 'assistant', text: plain }
    ]);
    expect(out[0].text).toBe(empty);
    expect(out[1].text).toBe(plain);
  });

  test('не-строковый text и пустой массив не ломают helper', () => {
    const messages = [{ role: 'user', text: null }, { role: 'assistant' }];
    expect(strip(messages)).toBe(messages);
  });

  test('source-пин: collect использует единый finalize, finalize знает про qwen', () => {
    const collect = SRC.slice(SRC.indexOf('function aiCmCollectExportSource()'), SRC.indexOf('function aiCmExportBaseSource('));
    expect(collect).toContain('aiCmFinalizeExportMessages');
    expect(collect).toContain('finalizeExport(');
    expect(collect).not.toContain('return aiCmSanitizeEmitUserTexts(');
    const finalizeSrc = fnDecl(SRC, 'aiCmFinalizeExportMessages');
    expect(finalizeSrc).toContain("currentAdapter.siteName === 'qwen'");
    expect(finalizeSrc).toContain('aiCmStripQwenAttachmentBodies');
  });

  test('finalize применяет проекцию только к Qwen, другие сайты не трогает', () => {
    const text = 'Вопрос\n\n[FILE: doc.txt]\n' + 'q'.repeat(400);
    expect(finalize([{ role: 'user', text: text }], 'qwen')[0].text)
      .toContain('вложение; текст не включён в экспорт');
    expect(finalize([{ role: 'user', text: text }], 'gemini')[0].text).toBe(text);
  });
});
