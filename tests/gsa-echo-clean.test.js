'use strict';

/**
 * BUG-08/фаза 4: сервисные эхо-обёртки GSA не попадают в файл.
 *
 * Живой захват (phase4-gsa): user = «Вы отправили 1 изображения и сделали
 * запрос "Q"», assistant = «Ответ в режиме ИИ, … исходный запрос: "Q"\n\nA».
 * Чистка выполняется на проекции файла (core/export-manager.ts →
 * utils/export/projection.ts), capture/turns/метрики остаются сырыми.
 */

const Parser = require('../utils/google-search-folwr-parser.ts');
const loadEsm = require('./helpers/load-esm.js');
const { moduleSource } = require('./helpers/content-source.js');
const Projection = loadEsm.loadEsmModule('utils/export/projection.ts');
const Builders = loadEsm.loadEsmGlobal('utils/export-text-builders.ts', 'AiCmExportBuilders');

const EM_SRC = moduleSource('export-manager.ts');

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

const makeProject = new Function(
  'window', 'aiCmExportProjectFileMessages', 'aiCmIncludeHiddenInExport',
  'aiCmHiddenExportEffectiveOn', 'aiCmSanitizeEmitUserTexts',
  fnDecl(EM_SRC, 'aiCmProjectFileMessages') + '\nreturn aiCmProjectFileMessages;'
);

function projectFor() {
  const windowStub = {
    GoogleFolwrUtils: {
      stripGsaUserEcho: Parser.stripGsaUserEcho,
      stripGsaAssistantEcho: Parser.stripGsaAssistantEcho
    }
  };
  const project = makeProject(windowStub, Projection.projectFileMessages, false, null, null);
  return project;
}

const Q = 'Добрый вечер. Для теста работы расширения нужна пара реплик?';
const BODY = 'Добрый вечер! Отлично, давайте проверим работу расширения.';
const ECHO_A = 'Ответ в режиме ИИ, исходные файлы: 1 изображения, исходный запрос: "' + Q + '"\n\n' + BODY;
const ECHO_U = 'Вы отправили 1 изображения и сделали запрос "' + Q + '"';

describe('GSA echo wrappers: чистые helpers', () => {
  test('user: «Вы отправили … запрос "Q"» → Q', function () {
    expect(Parser.stripGsaUserEcho(ECHO_U)).toBe(Q);
  });

  test('user: многострочный Q и хвостовые пробелы', function () {
    const q = 'Первая строка\nвторая "цитата"';
    expect(Parser.stripGsaUserEcho('Вы отправили 2 файла и сделали запрос "' + q + '"  ')).toBe(q);
  });

  test('user: обычный текст и незакрытая обёртка не меняются', function () {
    expect(Parser.stripGsaUserEcho('Просто вопрос?')).toBe('Просто вопрос?');
    expect(Parser.stripGsaUserEcho('Вы отправили файл и сделали запрос "без конца')).toBe(
      'Вы отправили файл и сделали запрос "без конца');
  });

  test('assistant: обёртка с телом → тело', function () {
    expect(Parser.stripGsaAssistantEcho(ECHO_A)).toBe(BODY);
  });

  test('assistant: чистое эхо без тела → пусто', function () {
    expect(Parser.stripGsaAssistantEcho('Ответ в режиме ИИ, исходный запрос: "Просто вопрос"')).toBe('');
  });

  test('assistant: проза без кавычки-двоеточия не меняется', function () {
    const prose = 'Ответ в режиме ИИ — это функция поиска, а не чат.';
    expect(Parser.stripGsaAssistantEcho(prose)).toBe(prose);
  });

  test('идемпотентность: повторная чистка не меняет результат', function () {
    expect(Parser.stripGsaAssistantEcho(Parser.stripGsaAssistantEcho(ECHO_A))).toBe(BODY);
    expect(Parser.stripGsaUserEcho(Parser.stripGsaUserEcho(ECHO_U))).toBe(Q);
  });
});

describe('GSA echo wrappers: проекция файла', () => {
  const RAW = [
    { role: 'user', text: ECHO_U },
    { role: 'assistant', text: ECHO_A }
  ];

  test('google_search: обёртки сняты, метрики/роли не тронуты', function () {
    const fn = projectFor();
    const out = fn(RAW, 'google_search');
    expect(out.mode).toBe('projected');
    expect(out.messages[0].text).toBe(Q);
    expect(out.messages[1].text).toBe(BODY);
    expect(out.messages.map(function (m) { return m.role; })).toEqual(['user', 'assistant']);
    // Вход не мутирован.
    expect(RAW[0].text).toBe(ECHO_U);
    expect(RAW[1].text).toBe(ECHO_A);
  });

  test('другие сайты: текст и массив без изменений', function () {
    const fn = projectFor();
    const out = fn(RAW, 'gemini');
    expect(out.mode).toBe('');
    expect(out.messages).toBe(RAW);
    expect(out.messages[0].text).toBe(ECHO_U);
  });

  test('MD/JSON из проекции не содержат эхо-обёрток', function () {
    const fn = projectFor();
    const out = fn(RAW, 'google_search');
    const h = { site: 'google_search', model: 'AI Mode', tokens: 10, limit: 1000, percent: 1, messages: out.messages };
    const md = Builders.buildMdFromHistory(h, 'Google Search AI');
    const json = Builders.buildJsonFromHistory(h, 'Google Search AI');
    expect(md).toContain(BODY);
    expect(md).not.toContain('Ответ в режиме ИИ');
    expect(md).not.toContain('Вы отправили');
    expect(json).not.toContain('Ответ в режиме ИИ');
    expect(json).not.toContain('Вы отправили');
  });
});
