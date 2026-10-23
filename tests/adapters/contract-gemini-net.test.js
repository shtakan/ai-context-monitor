/**
 * §п.8-A: КОНТРАКТ ПАРСЕРНОГО СЛОЯ GEMINI (batchexecute) НА ЖИВОМ КАДРЕ.
 *
 * Источник истины — tools/dr-sample.txt.txt (2 346 764 байта / 2 124 128 JS-символов):
 * реальный ответ `batchexecute` с XSSI-префиксом `)]}'`, объявленной длиной кадра
 * 2 124 014 и тройками id c_, r_, rc_. Адаптера `gemini-net-adapter.js` в репозитории НЕТ:
 * контракт держит парсерный слой — core/gemini-parse.js (разбор кадра) и
 * utils/gemini-batchexecute-parser.js (извлечение истории). Поэтому загрузка идёт через
 * loadSource, а не loadAdapter (у второго файла нет класса-адаптера).
 *
 * ГЛАВНЫЙ ФАКТ АРТЕФАКТА: кадр ОБРЕЗАН (объявлено 2 124 014 символов, фактический payload
 * hNvQHb — 2 103 041; разбор обрывается на позиции ~1 912 896 «Unterminated string in JSON»).
 * Отсюда инварианты: парсер обязан НЕ падать, не тащить XSSI-мусор в messages и извлечь
 * роли/тексты/идентификаторы из уцелевшей части. Живая история при этом восстанавливается
 * (6 реплик: 3 user + 3 assistant), т.е. артефакт репрезентативен.
 */

const fs = require('fs');
const path = require('path');
const { loadSource } = require('../helpers/adapter-harness');
const { loadFixture } = require('../helpers/contract-fixture-loader');

const DR = 'tools/dr-sample.txt.txt';
/** Объявленная длина кадра из шапки XSSI-обёртки. */
const DECLARED_FRAME_LEN = 2124014;

jest.setTimeout(5000);

// Артефакт живого кадра обязателен: без него property-пины (объявленная длина, id-тройки,
// XSSI-шапка) стали бы вакуумными. В CI (tools/ в .gitignore) файла нет → тесты объявляются
// через test.skip с обоснованием; локально файл есть (fs.existsSync → true), и они обязаны
// исполниться. AI_CM_CONTRACT_SYNTH=1 тоже пропускает сьют: контракт требует реального payload.
const drExists = fs.existsSync(path.join(__dirname, '..', '..', DR));
const synthForced = String(process.env.AI_CM_CONTRACT_SYNTH || '') === '1';
const suiteSkipped = !drExists || synthForced;
if (suiteSkipped) {

  console.warn('[§п.8-A] gemini: ' + (synthForced
    ? 'AI_CM_CONTRACT_SYNTH=1 — принудительный синтез, контракт требует реального payload'
    : 'артефакт отсутствует в CI (реальный payload доступен локально)') + ' — ' + DR);
}
const gtest = suiteSkipped ? test.skip : test;

/** Ленивая загрузка тяжёлого артефакта — только внутри теста, не на верхнем уровне. */
function readDr() {
  return loadFixture(DR, function () {
    return ')]}\'\r\n\r\n' + DECLARED_FRAME_LEN + '\r\n[["wrb.fr","hNvQHb","[]"]]\r\n';
  }, { forceSynthetic: synthForced });
}

/** Парсерный слой в песочнице: оба файла — самодостаточные IIFE на window.*. */
function parsers() {
  const res = loadSource(['core/gemini-parse.js', 'utils/gemini-batchexecute-parser.js'], { returnExpr: 'null' });
  const win = res.sandbox.window;
  expect(typeof win.AiCmGeminiParse.parseBatchExecute).toBe('function');
  expect(typeof win.GeminiBatchexecuteParser.parseGeminiHistory).toBe('function');
  // ядро — модуль с явной связкой диагностики (паттерн core/gemini-diag.js)
  win.AiCmGeminiParse.__bind({});
  return win;
}

/** Шапка XSSI: `)]}'` + пустая строка + объявленная длина. */
function xsiiHead(text) {
  const m = /^\s*\)\]\}'\s*\r?\n\r?\n(\d+)\r?\n/.exec(text);
  return m ? { ok: true, declared: Number(m[1]) } : { ok: false };
}

describe('§п.8-A: Gemini batchexecute — контракт на живом кадре dr-sample', function () {
  gtest('G1 (C3*): id-поля r_*/rc_* извлечены из живого кадра и уникальны', function () {
    const dr = readDr();
    expect(dr.existed).toBe(true);
    expect(dr.fromLiveRun).toBe(true);

    const win = parsers();
    const core = win.AiCmGeminiParse;
    // Низкоуровневый слой на ОБРЕЗАННОМ кадре честно возвращает 0 ходов (payload не собирается),
    // поэтому id-контракт держит парсерный слой, который восстанавливает историю из того же сырья.
    expect(core.parseBatchExecute(dr.text, 'history')).toEqual([]);
    expect(core.parseByBytes(dr.text, [], 'history') || '').toBe('');
    expect(core.parseByLines(dr.text, [], 'history') || '').toBe('');

    const hist = win.GeminiBatchexecuteParser.parseGeminiHistory(dr.text);
    const ids = hist.messages.map(function (m) { return m.id; });
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBe(hist.messages.length);
    ids.forEach(function (id) {
      // id имеет вид r_<hex>_<role>; база r_<hex> присутствует в живом кадре
      expect(id).toMatch(/^r_[0-9a-f]{6,}_(?:user|assistant)$/);
      expect(dr.text.indexOf(id.replace(/_(?:user|assistant)$/, '')) !== -1).toBe(true);
    });
    // уникальность: каждый ход-пара (user/assistant) несёт свой id, дублей нет
    expect(new Set(ids).size).toBe(ids.length);
  });

  gtest('G2 (C1): роли из живого кадра ∈ {user, assistant}, обе роли присутствуют', function () {
    const dr = readDr();
    const win = parsers();
    const hist = win.GeminiBatchexecuteParser.parseGeminiHistory(dr.text);
    expect(Array.isArray(hist.messages)).toBe(true);
    expect(hist.messages.length).toBeGreaterThan(0);

    const roles = hist.messages.map(function (m) { return m.role; });
    roles.forEach(function (r) { expect(['user', 'assistant']).toContain(r); });
    expect(roles.filter(function (r) { return r === 'user'; }).length).toBeGreaterThan(0);
    expect(roles.filter(function (r) { return r === 'assistant'; }).length).toBeGreaterThan(0);
    // ключ реплики — `text` (парсерный слой), а не `content`: контракт адаптера начинается выше
    expect(typeof hist.messages[0].text).toBe('string');
  });

  gtest('G3 (C2): текст реплик непуст, мусор-обёртки в него не утекает', function () {
    const dr = readDr();
    const win = parsers();
    const hist = win.GeminiBatchexecuteParser.parseGeminiHistory(dr.text);
    expect(hist.messages.length).toBeGreaterThan(0);
    hist.messages.forEach(function (m) {
      expect(String(m.text).trim().length).toBeGreaterThan(0);
      expect(String(m.text)).not.toContain('wrb.fr');
      expect(String(m.text)).not.toContain(')]}\'');
    });
    expect(String(hist.text || '').length).toBeGreaterThan(0);
  });

  gtest('G4 (I-8): XSSI-префикс `)]}\'` обработан и не попадает в экспорт истории', function () {
    const dr = readDr();
    expect(dr.text.slice(0, 4)).toBe(')]}\'');
    expect(xsiiHead(dr.text)).toEqual({ ok: true, declared: DECLARED_FRAME_LEN });

    const win = parsers();
    const hist = win.GeminiBatchexecuteParser.parseGeminiHistory(dr.text);
    expect(hist.messages.length).toBeGreaterThan(0);
    hist.messages.forEach(function (m) { expect(String(m.text)).not.toContain(')]}\''); });
    expect(String(dr.text).split(')]}\'').length - 1).toBe(1); // префикс ровно один
  });

  gtest('G5 (C5): число реплик ≤ объявленной длины кадра из шапки', function () {
    const dr = readDr();
    const declared = xsiiHead(dr.text).declared;
    const win = parsers();
    const hist = win.GeminiBatchexecuteParser.parseGeminiHistory(dr.text);
    expect(declared).toBe(DECLARED_FRAME_LEN);
    expect(hist.messages.length).toBeGreaterThan(0);
    expect(hist.messages.length).toBeLessThanOrEqual(declared);
    // кадр обрезан внутри третьего хода: объявленный payload (2 124 014) больше
    // фактически восстановленного парсерным слоем текста истории
    expect(hist.text.length).toBeLessThan(declared);
  });

  gtest('G6 (невакуумный): парсерный слой извлекает сообщения — заглушка не закрывает контракт молча', function () {
    const dr = readDr();
    const win = parsers();
    const hist = win.GeminiBatchexecuteParser.parseGeminiHistory(dr.text);
    expect(hist.messages.length).toBeGreaterThan(0);
    expect(hist.count).toBe(hist.messages.length);
    expect(typeof hist.model).toBe('string');
    expect(hist.text.trim().length).toBeGreaterThan(0);
    // низкоуровневый парсер на обрезанном кадре не бросает и честно отдаёт 0 ходов
    const core = win.AiCmGeminiParse;
    expect(core.parseBatchExecute(dr.text, 'history')).toEqual([]);
  });
});
