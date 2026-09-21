/**
 * O-37 (O-36.2): КОНТЕЙНЕРЫ В БАЗЕ АДАПТЕРА — чистка ВНУТРИ extractMessages.
 *
 * Основание (живой артефакт 20:50): 75 узлов базы, из них ДВА — узлы-КОНТЕЙНЕРЫ всего чата
 * (по 91 595 знаков, cover=0.9999, внутри все 73 реплики). Бейдж показывал tokens=81672 /
 * pct=63.8 при реальном тексте ~27-33k (~21-26%), файл начинался «стеной» ASSISTANT:.
 * Корень: DOM-адаптер отдавал в базу контейнерные узлы рядом с настоящими сообщениями
 * (чистка жила ТОЛЬКО на выходе экспорта — dropContainerMessages, O-36/D2.1, — то есть база,
 * бейдж и токен-оценка оставались раздутыми).
 *
 * Фикс: та же чистка исполняется ВНУТРИ adapters/qwen-adapter.js:extractMessages ОБЩИМ хелпером
 * сборщиков (aiCmDropContainerMessages / aiCmContainerRules) — логика не дублируется, хелпер
 * резолвится лениво (файл сборщиков подключён в manifest.json ПОСЛЕ адаптера). Вторая ступень
 * (чистка в сборщиках) остаётся и идемпотентна; селекторы адаптера (строки 46-66) не тронуты.
 *
 * Исполняется РЕАЛЬНЫЙ adapters/qwen-adapter.js в песочнице jsdom + РЕАЛЬНЫЕ сборщики
 * (utils/export-text-builders.js) и токен-оценка (utils/tokenizer.js).
 */

const fs = require('fs');
const path = require('path');

const Builders = require('../utils/export-text-builders.js');
const Tokenizer = require('../utils/tokenizer.js');

const ROOT = path.join(__dirname, '..');
const BASE_SRC = fs.readFileSync(path.join(ROOT, 'adapters', 'base-adapter.js'), 'utf8');
const QWEN_SRC = fs.readFileSync(path.join(ROOT, 'adapters', 'qwen-adapter.js'), 'utf8');
const ADAPTER_FILES = ['chatgpt-adapter.js', 'gemini-adapter.js', 'deepseek-adapter.js',
  'google-search-adapter.js', 'claude-adapter.js', 'perplexity-adapter.js'];

const FAKE_LOCATION = { hostname: 'chat.qwen.ai', pathname: '/c/cda86f26-0155-4243-a134-777d909a936b' };

/**
 * Песочница адаптера (как в tests/qwen-adapter.test.js): base-adapter.js + qwen-adapter.js в
 * одном лексическом скоупе. window/require передаются ЯВНО, чтобы пинить пути резолва общего
 * хелпера: боевой (window.AiCmExportBuilders), Node-фолбэк (require) и отсутствие обоих.
 */
function loadAdapter(opts) {
  const o = opts || {};
  const sandbox = new Function('document', 'location', 'debugLog', 'console', 'window', 'require', 'module',
    BASE_SRC.replace(/if \(typeof module[\s\S]*$/, '') + '\n' +
    QWEN_SRC.replace(/if \(typeof module[\s\S]*$/, '') + '\nreturn QwenAdapter;');
  const win = (o.noWindow === true) ? undefined
    : ((o.window !== undefined) ? o.window : { AiCmExportBuilders: Builders });
  const req = (o.require !== undefined) ? o.require : undefined;
  const mod = (o.module !== undefined) ? o.module : undefined;
  const QwenAdapterClass = sandbox(document, FAKE_LOCATION, function () { }, console, win, req, mod);
  return new QwenAdapterClass();
}

// ---------------------------------------------------------------------------------
// Живая фикстура 20:50: 73 реплики + 2 узла-контейнера (склейка ВСЕХ реплик).
// ---------------------------------------------------------------------------------
const REAL = [];
for (let i = 0; i < 73; i++) {
  REAL.push({
    role: (i % 2 === 0) ? 'user' : 'assistant',
    text: 'Реплика ' + (i + 1) + ': ' + 'слово' + (i + 1) + ' ' + 'текст '.repeat(4 + (i % 5)).trim()
  });
}
const WALL = REAL.map(function (m) { return m.text; }).join('\n');
const REAL_TEXTS = REAL.map(function (m) { return m.text; });

function renderFixture() {
  document.body.innerHTML = '';
  // контейнеры идут ПЕРВЫМИ (как в живом артефакте: файл начинался «стеной» ASSISTANT:)
  ['c1', 'c2'].forEach(function (id) {
    const el = document.createElement('div');
    el.setAttribute('data-message-id', id);
    el.setAttribute('data-message-role', 'assistant');
    el.textContent = WALL;
    document.body.appendChild(el);
  });
  REAL.forEach(function (m, i) {
    const el = document.createElement('div');
    el.setAttribute('data-message-id', 'm' + i);
    el.setAttribute('data-message-role', m.role);
    el.textContent = m.text;
    document.body.appendChild(el);
  });
}

beforeEach(function () {
  document.body.innerHTML = '';
  FAKE_LOCATION.pathname = '/c/cda86f26-0155-4243-a134-777d909a936b';
});

// =====================================================================================
// O36.2-D: фикстура 73 реплики + 2 контейнера
// =====================================================================================
describe('O-37 O36.2-D: extractMessages отбрасывает узлы-контейнеры (фикстура 73 + 2)', () => {
  test('75 узлов на входе → 73 реплики на выходе, порядок и роли реплик сохранены', function () {
    renderFixture();
    const msgs = loadAdapter().extractMessages();
    expect(msgs).toHaveLength(REAL.length);
    expect(msgs.map(function (m) { return m.role; })).toEqual(REAL.map(function (m) { return m.role; }));
    expect(msgs.map(function (m) { return m.content; })).toEqual(REAL_TEXTS);
    // контейнерной «стены» в базе нет ни разу
    expect(msgs.some(function (m) { return m.content === WALL; })).toBe(false);
  });

  test('текст базы без контейнерных стен: getFullDialogText = склейка ТОЛЬКО реплик', function () {
    renderFixture();
    const a = loadAdapter();
    expect(a.getFullDialogText()).toBe(REAL_TEXTS.join('\n'));
    // «стена» — это склейка ВСЕХ реплик: в базе каждая реплика встречается РОВНО один раз
    expect((a.getFullDialogText().match(/Реплика 1:/g) || [])).toHaveLength(1);
    expect((a.getFullDialogText().match(/Реплика 73:/g) || [])).toHaveLength(1);
    expect(a.getFullDialogText().length).toBeLessThan(WALL.length * 2);
  });

  test('токен-оценка падает пропорционально: 73 реплики вместо 75 узлов со «стенами»', function () {
    renderFixture();
    const filtered = loadAdapter().getFullDialogText();
    const withWalls = WALL + '\n' + WALL + '\n' + REAL_TEXTS.join('\n');
    const tokensFiltered = Tokenizer.estimateDialogTokens(filtered, REAL.length);
    const tokensWalls = Tokenizer.estimateDialogTokens(withWalls, REAL.length + 2);
    expect(tokensFiltered).toBeGreaterThan(0);
    // живой перекос: 81672 токенов при реальных ~27-33k — оценка падает более чем вдвое
    expect(tokensFiltered * 2).toBeLessThan(tokensWalls);
    // текст базы — ровно реплики (+ 72 разделителя), без двух стен по 73 реплики
    expect(filtered.length).toBe(REAL_TEXTS.join('\n').length);
  });

  test('боевой путь резолва хелпера: window.AiCmExportBuilders (общий ISOLATED-мир)', function () {
    renderFixture();
    const withHelper = loadAdapter({ window: { AiCmExportBuilders: Builders } }).extractMessages();
    expect(withHelper).toHaveLength(REAL.length);
    // хелпер подключён лениво: адаптер сам правил не держит (см. source-пин ниже)
    expect(typeof Builders.aiCmDropContainerMessages).toBe('function');
  });

  test('Node-фолбэк резолва: window нет, require/module есть → тот же результат (Node/тесты)', function () {
    renderFixture();
    const viaRequire = loadAdapter({ noWindow: true, require: require, module: { exports: {} } }).extractMessages();
    expect(viaRequire).toHaveLength(REAL.length);
    expect(viaRequire.map(function (m) { return m.content; })).toEqual(REAL_TEXTS);
  });

  test('R1: ни окна, ни require → адаптер возвращает узлы КАК ЕСТЬ (правил не дублирует)', function () {
    renderFixture();
    const raw = loadAdapter({ noWindow: true, require: undefined }).extractMessages();
    expect(raw).toHaveLength(REAL.length + 2);          // поведение 1:1 до фикса
    expect(raw[0].content).toBe(WALL);
    expect(raw.filter(function (m) { return m.content === WALL; })).toHaveLength(2);
  });
});

// =====================================================================================
// O36.2-R: новый чат (4 узла, контейнеров нет) + идемпотентность второй ступени
// =====================================================================================
describe('O-37 O36.2-R: контейнеров нет — байты прежние; экспорт идемпотентен', () => {
  const FOUR = [
    { role: 'user', text: 'привет' },
    { role: 'assistant', text: 'Привет! Чем помочь?' },
    { role: 'user', text: 'как дела?' },
    { role: 'assistant', text: 'Всё хорошо, спасибо!' }
  ];

  function renderFour() {
    document.body.innerHTML = '';
    FOUR.forEach(function (m, i) {
      const el = document.createElement('div');
      el.setAttribute('data-message-id', 'n' + i);
      el.setAttribute('data-message-role', m.role);
      el.textContent = m.text;
      document.body.appendChild(el);
    });
  }

  test('новый чат: с хелпером и без него extractMessages байтово одинаков', function () {
    renderFour();
    const withHelper = loadAdapter({ window: { AiCmExportBuilders: Builders } }).extractMessages();
    const withoutHelper = loadAdapter({ noWindow: true }).extractMessages();
    expect(withHelper).toEqual(withoutHelper);
    expect(withHelper.map(function (m) { return [m.role, m.content]; })).toEqual(
      FOUR.map(function (m) { return [m.role, m.text]; }));
  });

  test('вторая ступень идемпотентна: чистка уже очищенной базы ничего не меняет', function () {
    renderFixture();
    const msgs = loadAdapter().extractMessages();
    const again = Builders.aiCmDropContainerMessages(msgs);
    expect(again).toHaveLength(msgs.length);
    expect(again.map(function (m) { return m.content; })).toEqual(msgs.map(function (m) { return m.content; }));
  });

  test('экспорт идемпотентен: txt из базы адаптера == txt из той же базы после второй ступени', function () {
    renderFixture();
    const msgs = loadAdapter().extractMessages();
    const txt = Builders.buildTxtFromHistory({ site: 'qwen', messages: msgs });
    const txtTwice = Builders.buildTxtFromHistory({ site: 'qwen', messages: Builders.aiCmDropContainerMessages(msgs) });
    expect(txtTwice).toBe(txt);
    expect((txt.match(/USER:/g) || [])).toHaveLength(37);
    expect((txt.match(/ASSISTANT:/g) || [])).toHaveLength(36);
    expect(txt).not.toContain(WALL);
  });

  test('экспорт идемпотентен: вторая ступень даёт те же байты и на СЫРОМ (75 узлов) массиве', function () {
    renderFixture();
    const raw = loadAdapter({ noWindow: true, require: undefined }).extractMessages();
    const fromRaw = Builders.buildTxtFromHistory({ site: 'qwen', messages: raw });
    const fromAdapter = Builders.buildTxtFromHistory({ site: 'qwen', messages: loadAdapter().extractMessages() });
    expect(fromRaw).toBe(fromAdapter);
  });
});

// =====================================================================================
// Source-пины: общий хелпер, а не вторая копия правил; селекторы и соседи не тронуты
// =====================================================================================
describe('O-37 O-36.2: границы фикса (source-пины)', () => {
  test('адаптер переиспользует ОБЩИЙ хелпер и не дублирует пороги правила', function () {
    expect(QWEN_SRC).toContain('AiCmExportBuilders.aiCmDropContainerMessages');
    expect(QWEN_SRC).toContain("require('../utils/export-text-builders.js')");
    expect(QWEN_SRC).toContain('_dropContainerNodes(messages)');
    // ни одной копии правила контейнера внутри адаптера (пороги/minContained/coverMin)
    expect(QWEN_SRC).not.toContain('minContained');
    expect(QWEN_SRC).not.toContain('coverMin');
    expect(QWEN_SRC).not.toContain('indexOf(other)');
    expect(QWEN_SRC).not.toContain('0.8');
  });

  test('правило живёт РОВНО в сборщиках: шесть чужих адаптеров контейнер-чистку не зовут', function () {
    ADAPTER_FILES.forEach(function (f) {
      const src = fs.readFileSync(path.join(ROOT, 'adapters', f), 'utf8');
      expect(src).not.toContain('aiCmDropContainerMessages');
      expect(src).not.toContain('_dropContainerNodes');
    });
    expect(QWEN_SRC).toContain('aiCmDropContainerMessages');
    expect(Builders.aiCmContainerRules).toEqual({ minContained: 2, coverMin: 0.8 });
  });

  test('R-пин: селекторы-кандидаты и композер адаптера не тронуты (HYPOTHESIS, строки 46-66)', function () {
    expect(QWEN_SRC).toContain("'[data-message-id]',");
    expect(QWEN_SRC).toContain("'[class*=\"message-bubble\"]'");
    expect(QWEN_SRC).toContain("textarea[placeholder*=\"Qwen\"]");
    expect(QWEN_SRC).toContain("this._noiseSelectors = 'button, svg, textarea");
    // диагностическая строка адаптера осталась прежней и печатает ЧИСЛО БАЗЫ (после чистки)
    expect(QWEN_SRC).toContain('[QwenAdapter] Извлечено ${messages.length} сообщений');
    expect(QWEN_SRC).toContain('контейнеров отброшено: ${droppedContainers}');
  });
});
