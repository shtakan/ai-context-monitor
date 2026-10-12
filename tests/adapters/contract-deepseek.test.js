/** @jest-environment node */
/**
 * §п.8-A: КОНТРАКТ DeepSeekAdapter НА ЖИВЫХ АРТЕФАКТАХ (O-15/O-7/O-21 + C1/C2/C4/C5).
 *
 * Источники (tools/o18-samples/, .gitignore — на CI отсутствуют, локально есть):
 *   live-18-19.txt        — живой экспорт беседы (244 строки / 196 голых LF);
 *   ref-18-23.txt         — экспорт той же беседы из истории (279 строк / 222 голых LF);
 *   18-full-dump-19-12.txt — дамп лога [ai-cm-debug][O18][rings] (одна строка, 590 968 символов).
 *
 * Замечание к ТЗ: в задании файлы названы `18-live-18-19.txt` / `18-ref-18-23.txt` с размерами
 * 6 602 / 11 580 Б и «243/278 голых LF». На диске лежат live-18-19.txt (38 216 Б, 196 голых LF)
 * и ref-18-23.txt (47 284 Б, 222 голых LF) — это и есть та же пара live/ref (первое расхождение
 * на смещении 7583 символов, см. tools/o18-samples/o18-diff-report.txt). Пины привязаны к
 * ИЗМЕРЕННЫМ значениям, а не к числам задания.
 *
 * Адаптер грузится через jsdom-окно (как tests/adapters/deepseek-o15-pairing.test.js:326-330),
 * потому что harness-песочница по умолчанию not-DOM. Артефакты читаются ЛЕНИВО внутри тестов.
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { loadAdapter } = require('../helpers/adapter-harness');
const { loadFixture } = require('../helpers/contract-fixture-loader');

const LIVE = 'tools/o18-samples/live-18-19.txt';
const REF = 'tools/o18-samples/ref-18-23.txt';
const DUMP = 'tools/o18-samples/18-full-dump-19-12.txt';

jest.setTimeout(5000);

/** Синтетический фолбэк — только если артефакта нет (CI); форма та же, что у живого экспорта. */
function synthExport(marker) {
  return '\uFEFFТестируем расширение до 5% - должен сработать автоэкспорт.\n\n[REASONING]\n' +
    '1.  Проанализировать ввод пользователя: ' + marker + '\n\n[ANSWER]\nТестовый ответ ' + marker + '.\n';
}

function readLive() { return loadFixture(LIVE, function () { return synthExport('live'); }); }
function readRef() { return loadFixture(REF, function () { return synthExport('ref'); }); }
function readDump() { return loadFixture(DUMP, function () { return '[ai-cm-debug][O18][rings] {"o18":"live-vs-network","ops":{}}\n'; }); }

// Артефакты загружаются лениво (внутри тестов), но факт их наличия известен на этапе
// объявления сьюты: в CI (tools/ в .gitignore) ни одного файла нет → сьюта объявляется
// через describe.skip с обоснованием, а не тихо синтезируется. AI_CM_CONTRACT_SYNTH=1 тоже
// пропускает: контракт требует реальных live/ref-экспортов (расхождение 196 vs 222 голых LF —
// это и есть проверяемый факт).
const ARTIFACTS = [LIVE, REF, DUMP];
const synthForced = String(process.env.AI_CM_CONTRACT_SYNTH || '') === '1';
const artifactsAvailable = !synthForced &&
  ARTIFACTS.every(function (p) { return fs.existsSync(path.join(__dirname, '..', '..', p)); });
const suite = artifactsAvailable ? describe : describe.skip;
if (!artifactsAvailable) {
  // eslint-disable-next-line no-console
  console.warn('[§п.8-A] deepseek: ' + (synthForced
    ? 'AI_CM_CONTRACT_SYNTH=1 — принудительный синтез, контракт требует реальных артефактов'
    : 'артефакты отсутствуют в CI (реальный payload доступен локально)') + ' — ' + ARTIFACTS.join(', '));
}

/** Инстанс РЕАЛЬНОГО адаптера в jsdom-окне (тот же путь загрузки, что у живого O-15 теста). */
function loadDs(html, url) {
  const dom = new JSDOM(html, { url: url || 'https://chat.deepseek.com/a/chat/s/convP8' });
  const res = loadAdapter('adapters/deepseek-adapter.js', {
    document: dom.window.document,
    location: dom.window.location,
    // у файла нет CJS-хвоста (класс объявлен в области IIFE бандла) — забираем имя класса
    exportExpr: 'DeepSeekAdapter'
  });
  return { dom: dom, adapter: res.Adapter, sandbox: res.sandbox };
}

const ROLE_RE = /^(?:user|assistant)$/;

suite('§п.8-A: DeepSeekAdapter — контракт на живых артефактах o18-samples', function () {
  test('D1 (C1): роль каждой реплики ∈ {user, assistant}; пары ходов чередуются', function () {
    const html =
      '<div class="ds-message"><div class="d29f3d7d">Вопрос пользователя</div></div>' +
      '<div class="ds-message ds-assistant-message">' +
      '<div class="ds-think">Размышление ассистента</div>' +
      '<div class="ds-markdown"><p class="ds-markdown-paragraph">Ответ ассистента</p></div>' +
      '</div>';
    const ctx = loadDs(html);
    const msgs = ctx.adapter.extractMessages();

    expect(msgs.length).toBeGreaterThan(0);              // невакуумный страж
    msgs.forEach(function (m) { expect(ROLE_RE.test(m.role)).toBe(true); });
    expect(msgs.map(function (m) { return m.role; })).toEqual(['user', 'assistant']);
    // роль 'unknown' выведена из контракта (v2/O-15) — регресс должен ломать пин
    msgs.forEach(function (m) { expect(m.role).not.toBe('unknown'); });
  });

  test('D2 (C2): перевод строки сохранён — абзацы ответа и реальные экспорты live/ref', function () {
    const live = readLive();
    const ref = readRef();
    expect(live.existed).toBe(true);
    expect(ref.existed).toBe(true);
    expect(live.fromLiveRun).toBe(true);
    expect(ref.fromLiveRun).toBe(true);

    // реальные артефакты: живой экспорт короче эталонного (расхождение зафиксировано в o18-diff-report)
    const lf = function (s) { return (s.match(/\n/g) || []).length; };
    expect(lf(ref.text)).toBeGreaterThan(lf(live.text));
    expect(lf(live.text)).toBeGreaterThan(0);
    expect(lf(ref.text)).toBeGreaterThan(0);

    // адаптер: абзацы ответа склеиваются построчно ('.ds-markdown-paragraph' → '\n')
    const html =
      '<div class="ds-message ds-assistant-message"><div class="ds-markdown">' +
      '<p class="ds-markdown-paragraph">Первый абзац ответа</p>' +
      '<p class="ds-markdown-paragraph">Второй абзац ответа</p>' +
      '</div></div>';
    const ctx = loadDs(html);
    const msgs = ctx.adapter.extractMessages();
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[0].role).toBe('assistant');
    expect(msgs[0].content).toContain('\n');
    expect(msgs[0].content.split('\n').length).toBe(2);
  });

  test('D3 (C4): вложенный div[class*="ds-message"] не удваивает реплику', function () {
    const html =
      '<div class="ds-message ds-assistant-message"><div class="ds-markdown ds-message">' +
      '<p class="ds-markdown-paragraph">Единственный ответ</p>' +
      '</div></div>';
    const ctx = loadDs(html);
    const msgs = ctx.adapter.extractMessages();

    // два узла попадают в выборку 'div[class*="ds-message"]', но вложенный отброшен гардом
    expect(ctx.dom.window.document.querySelectorAll('div[class*="ds-message"]').length).toBe(2);
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe('Единственный ответ');
  });

  test('D4 (C5): число реплик ≤ числа узлов-кандидатов; дамп-артефакт не создаёт реплик', function () {
    const html =
      '<div class="ds-message"><div class="d29f3d7d">Вопрос</div></div>' +
      '<div class="ds-message ds-assistant-message"><div class="ds-markdown">' +
      '<p class="ds-markdown-paragraph">Ответ</p></div></div>' +
      '<div class="ds-message"><span class="ds-think">Только размышление</span></div>' +
      '<div class="ds-message"><span>&nbsp;</span></div>';
    const ctx = loadDs(html);
    const candidates = ctx.dom.window.document.querySelectorAll('div[class*="ds-message"]').length;
    const msgs = ctx.adapter.extractMessages();

    expect(candidates).toBe(4);
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.length).toBeLessThanOrEqual(candidates);
    // живой дамп-артефакт реален и не содержит разметки ходов (реплик из него быть не может)
    const dump = readDump();
    expect(dump.existed).toBe(true);
    expect(dump.bytes).toBeGreaterThan(100000);
    expect(dump.text).not.toContain('ds-message');
    expect(dump.text).toContain('[ai-cm-debug][O18][rings]');
  });

  test('D5 (O-15): «висячий» reasoning привязывается к соседнему ходу, не становясь репликой', function () {
    const html =
      '<div class="ds-message"><div class="d29f3d7d">Вопрос</div></div>' +
      '<div class="ds-message ds-assistant-message"><span class="ds-think">Висячее размышление</span></div>' +
      '<div class="ds-message ds-assistant-message"><div class="ds-markdown">' +
      '<p class="ds-markdown-paragraph">Ответ после размышления</p></div></div>';
    const ctx = loadDs(html);
    const msgs = ctx.adapter.extractMessages();

    // узел-панель reasoning не стал отдельным сообщением (два узла-панели схлопнуты в один ход)
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.filter(function (m) { return /Висячее размышление/.test(m.content); }).length).toBe(0);
    // текст панели НЕ потерян: приклеен к соседнему assistant-ходу в hiddenReasoning
    const assistants = msgs.filter(function (m) { return m.role === 'assistant'; });
    expect(assistants.length).toBe(1);
    expect(String(assistants[0].hiddenReasoning || '')).toContain('Висячее размышление');
    // reasoning остаётся ВНЕ content (базовый текст хода байтово прежний)
    expect(assistants[0].content).not.toContain('Висячее размышление');
  });

  test('D6 (невакуумный): реплики извлечены, обе роли в наличии — заглушка не закрывает контракт', function () {
    const html =
      '<div class="ds-message"><div class="d29f3d7d">Вопрос пользователя</div></div>' +
      '<div class="ds-message ds-assistant-message"><div class="ds-markdown">' +
      '<p class="ds-markdown-paragraph">Ответ ассистента</p></div></div>';
    const ctx = loadDs(html);
    const msgs = ctx.adapter.extractMessages();

    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.some(function (m) { return m.role === 'user'; })).toBe(true);
    expect(msgs.some(function (m) { return m.role === 'assistant'; })).toBe(true);
    expect(typeof ctx.adapter.isOnDialogPage).toBe('function');
    expect(ctx.adapter.isOnDialogPage()).toBe(true);
    expect(ctx.sandbox.errors.length).toBe(0);
  });
});
