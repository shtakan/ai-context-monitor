/**
 * E-2: гигиена печатной формы (print/print.html + print/print.js).
 *
 * Живые дефекты печати (Gemini Deep Research PDF):
 *   (A) диалог «Сохранить как PDF» предлагал ПУСТОЕ имя файла — document.title пуст
 *       к моменту window.print(); фикс: перед print() title явно выставляется из
 *       chrome.i18n.getMessage('print_page_title') с непустым фолбэком;
 *   (B) первое открытие сохранённого PDF — «файл используется другим приложением»:
 *       повторный автовызов print() перезаписывал файл; фикс: автопечать ровно ОДИН раз
 *       за жизненный цикл страницы (флаг + лог '[AI CM][print] duplicate print suppressed');
 *   (C) текст PDF не копировался (битая кириллица): нестандартные шрифты без корректного
 *       ToUnicode; фикс: print-CSS задаёт стандартные Arial, Helvetica, sans-serif для
 *       тела и code/pre. Экранная раскладка не меняется.
 *
 * Тест гоняет РЕАЛЬНЫЙ print/print.js в jsdom-песочнице с моками chrome.tabs/
 * chrome.storage/chrome.i18n и считает фактические вызовы window.print().
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PRINT_JS = fs.readFileSync(path.join(ROOT, 'print', 'print.js'), 'utf8');
const PRINT_HTML = fs.readFileSync(path.join(ROOT, 'print', 'print.html'), 'utf8');

const HISTORY = {
  host: 'gemini.google.com',
  convId: '72c88213f2e812e1',
  site: 'gemini',
  model: 'Gemini 2.5 Pro',
  tokens: 1234,
  limit: 1000000,
  percent: 1.2,
  updatedAt: 1780000000000,
  messages: [
    { role: 'user', text: 'Проведи глубокое исследование' },
    { role: 'assistant', text: 'Вот план исследования: цель — проверить.' }
  ]
};

function setupDom() {
  const wrap = document.createElement('div');
  wrap.className = 'print-wrap';
  wrap.innerHTML =
    '<div class="banner" id="print-banner"></div>' +
    '<div id="print-content"></div>' +
    '<div class="empty-state" id="empty-state" style="display:none;"></div>';
  document.body.innerHTML = '';
  document.body.appendChild(wrap);
  document.title = '';
}

function makeChrome(opts) {
  const o = opts || {};
  const sent = [];
  return {
    sent: sent,
    i18n: {
      getMessage: function (key) {
        if (o.i18nEmpty) return '';
        if (key === 'print_page_title') return 'AI Context Monitor — печатная форма';
        return '';
      }
    },
    tabs: {
      get: function (id, cb) { cb({ id: id, url: 'https://gemini.google.com/app/72c88213f2e812e1' }); },
      sendMessage: function (id, msg, cb) { cb({ data: o.snap === null ? null : (o.snap || HISTORY) }); }
    },
    storage: {
      local: {
        get: function (keys, cb) { cb(o.store || { aiCmHistory: HISTORY }); }
      }
    },
    runtime: {
      lastError: null,
      sendMessage: function (msg) { sent.push(msg); }
    }
  };
}

// Загрузка реального print.js в текущий jsdom-window. Скрипт — IIFE без module.exports,
// поэтому все браузерные глобалы подставляем явно. setTimeout/clearTimeout берём у
// текущего window: под jest fake timers это фейковые таймеры, которые двигает advance.
// print.html подключает utils/markdown.js ДО print.js: без window.MarkdownRenderer
// waitForRenderer крутит опрос вечно (страница так и не печатает). В песочнице ставим
// стаб-рендерер — экранирование+абзацы, достаточное для проверок гигиены печати.
function installRendererStub() {
  window.MarkdownRenderer = {
    escapeHtml: function (s) {
      return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
    render: function (text) {
      return '<p>' + window.MarkdownRenderer.escapeHtml(text) + '</p>';
    }
  };
  return function () { delete window.MarkdownRenderer; };
}

function loadPrintScript(chrome, consoleImpl) {
  // URLSearchParams подменяем на стаб: печатная форма всегда открывается как
  // print.html?tab=<id> (chrome.tabs.create), а jsdom-URL теста параметра не несёт.
  const params = { get: function (name) { return (name === 'tab') ? '4242' : null; } };
  // eslint-disable-next-line no-new-func
  const fn = new Function('window', 'document', 'chrome', 'console', 'setTimeout', 'clearTimeout', 'URLSearchParams', PRINT_JS);
  fn(window, document, chrome, consoleImpl || console, function (cb, ms) { return setTimeout(cb, ms); }, function (id) { return clearTimeout(id); }, function () { return params; });
}

async function runInit(opts) {
  jest.useFakeTimers();
  setupDom();
  const removeStub = installRendererStub();
  const chrome = makeChrome(opts);
  let printCalls = 0;
  window.print = function () { printCalls++; };
  loadPrintScript(chrome);
  // init → 50мс → print (рендерер установлен, опрос waitForRenderer не нужен)
  await jest.advanceTimersByTimeAsync(200);
  removeStub();
  return { chrome: chrome, printCalls: function () { return printCalls; } };
}

describe('E-2 (A): document.title непуст к моменту window.print()', () => {
  afterEach(() => { jest.useRealTimers(); });

  test('title выставляется из локали перед печатью', async () => {
    const r = await runInit();
    expect(r.printCalls()).toBe(1);
    expect(document.title).toBe('AI Context Monitor — печатная форма');
    expect(document.title.length).toBeGreaterThan(0);
  });

  test('chrome.i18n недоступен/пуст → непустой фолбэк', async () => {
    const r = await runInit({ i18nEmpty: true });
    expect(r.printCalls()).toBe(1);
    expect(document.title).toBe('AI Context Monitor — печатная форма');
  });

  test('форма отрисована (контент истории отрендерен)', async () => {
    await runInit();
    const content = document.getElementById('print-content').innerHTML;
    expect(content).toContain('Gemini');
    expect(content).toContain('Проведи глубокое исследование');
  });
});

describe('E-2 (B): автопечать ровно ОДИН раз за жизненный цикл', () => {
  afterEach(() => { jest.useRealTimers(); });

  test('повторные триггеры print игнорируются + лог duplicate print suppressed', async () => {
    jest.useFakeTimers();
    setupDom();
    const removeStub = installRendererStub();
    const chrome = makeChrome();
    const logs = [];
    let printCalls = 0;
    window.print = function () { printCalls++; };
    const consoleSpy = { log: function (m) { logs.push(String(m)); }, warn: function () { }, error: function () { } };
    loadPrintScript(chrome, consoleSpy);
    await jest.advanceTimersByTimeAsync(200);
    removeStub();
    expect(printCalls).toBe(1);

    // повторные вызовы точки автопечати (двойной init/перерисовка) — печати не запускают
    expect(typeof window.__aiCmPrintTrigger).toBe('function');
    window.__aiCmPrintTrigger();
    window.__aiCmPrintTrigger();
    expect(printCalls).toBe(1);
    expect(logs.filter((l) => l === '[AI CM][print] duplicate print suppressed').length).toBe(2);
    // title не слетел после подавленного повторного вызова
    expect(document.title).toBe('AI Context Monitor — печатная форма');
  });
});

describe('E-2 (C): print-CSS — стандартные шрифты для PDF (ToUnicode)', () => {
  test('в @media print задан Arial, Helvetica, sans-serif для тела и code/pre', () => {
    const i = PRINT_HTML.indexOf('@media print');
    const j = PRINT_HTML.indexOf('</style>');
    expect(i).toBeGreaterThan(-1);
    const printCss = PRINT_HTML.slice(i, j);
    expect(printCss).toMatch(/font-family:\s*Arial,\s*Helvetica,\s*sans-serif/);
    expect(printCss).toMatch(/body[^{]*\{[^}]*font-family/);
    expect(printCss).toMatch(/code[^{]*\{[^}]*font-family/);
  });

  test('экранная раскладка не тронута: правило шрифтов живёт ТОЛЬКО в print-медиа', () => {
    const i = PRINT_HTML.indexOf('@media print');
    const screenCss = PRINT_HTML.slice(0, i);
    expect(screenCss).not.toMatch(/font-family:\s*Arial,\s*Helvetica,\s*sans-serif/);
  });

  test('title в разметке остаётся i18n-ключом print_page_title (M-4 байтово)', () => {
    expect(PRINT_HTML).toContain('<title data-i18n="print_page_title">');
  });
});
