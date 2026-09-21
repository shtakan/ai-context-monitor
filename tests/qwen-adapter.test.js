/**
 * O-35: adapters/qwen-adapter.js — DOM-фолбэк chat.qwen.ai.
 *
 * Адаптер включается, когда живой SSE-снимок недоступен (clone() не удался, стрим оборвался,
 * открыт готовый чат): он даёт базу текстов/ходов, чтобы бейдж и экспорт не пустели.
 *
 * Селекторы Qwen — HYPOTHESIS (живой DOM не снимался), поэтому проверяется не «магия
 * конкретного класса», а КОНТРАКТ BaseAdapter + устойчивость к кандидатам:
 *   - isOnDialogPage: композер «Спросить Qwen» / узлы сообщений / путь /c/<id>;
 *   - extractMessages: пары role/content, reasoning («Завершено размышление») — в
 *     hiddenReasoning, а не в content; служебные узлы и «.» свёрнутой панели не сообщения;
 *   - getFullDialogText: склейка content через '\n' (как у BaseAdapter/DeepSeek);
 *   - detectModel: канонический qwen3.8-max по умолчанию.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE_SRC = fs.readFileSync(path.join(ROOT, 'adapters', 'base-adapter.js'), 'utf8');
const QWEN_SRC = fs.readFileSync(path.join(ROOT, 'adapters', 'qwen-adapter.js'), 'utf8');

// jsdom не даёт менять origin через replaceState → location подставляется объектом
// (hostname+pathname читает адаптер; живой браузер даёт то же самое).
let FAKE_LOCATION = { hostname: 'chat.qwen.ai', pathname: '/' };
function setUrl(url) {
  const m = /^https?:\/\/([^/]+)(\/.*)?$/.exec(url);
  FAKE_LOCATION = m
    ? { hostname: m[1], pathname: m[2] || '/' }
    : { hostname: 'chat.qwen.ai', pathname: url };
}

function loadAdapter() {
  const debugLog = function () { };
  // Классы обоих файлов объявляются в одной песочнице: base-adapter.js первым (как в
  // manifest.json), qwen-adapter.js наследует BaseAdapter из этой же области.
  const sandbox = new Function(
    'document', 'location', 'debugLog', 'console',
    BASE_SRC.replace(/if \(typeof module[\s\S]*$/, '') + '\n' +
    QWEN_SRC.replace(/if \(typeof module[\s\S]*$/, '') + '\nreturn QwenAdapter;'
  );
  const QwenAdapterClass = sandbox(document, FAKE_LOCATION, debugLog, console);
  return new QwenAdapterClass();
}

beforeEach(function () {
  document.body.innerHTML = '';
  setUrl('/');
});

describe('O-35: QwenAdapter — isOnDialogPage', function () {
  test('композер Qwen (textarea «Спросить Qwen») — страница диалога', function () {
    document.body.innerHTML = '<textarea placeholder="Спросить Qwen"></textarea>';
    const a = loadAdapter();
    expect(a.siteName).toBe('qwen');
    expect(a.isOnDialogPage()).toBe(true);
  });

  test('узлы сообщений без композера — тоже диалог', function () {
    document.body.innerHTML = '<div data-message-id="m1" data-message-role="user">привет</div>';
    expect(loadAdapter().isOnDialogPage()).toBe(true);
  });

  test('путь /c/<id> без разметки — диалог', function () {
    setUrl('/c/cda86f26-0155-4243-a134-777d909a936b');
    expect(loadAdapter().isOnDialogPage()).toBe(true);
  });

  test('пустая страница без композера и без /c/ — не диалог', function () {
    document.body.innerHTML = '<div>ничего</div>';
    expect(loadAdapter().isOnDialogPage()).toBe(false);
  });

  test('чужой хост — не диалог Qwen (адаптер не срабатывает на других сайтах)', function () {
    setUrl('https://chatgpt.com/');
    document.body.innerHTML = '<textarea placeholder="Спросить Qwen"></textarea>';
    expect(loadAdapter().isOnDialogPage()).toBe(false);
  });
});

describe('O-35: QwenAdapter — extractMessages', function () {
  test('пары user/assistant по data-атрибутам роли', function () {
    document.body.innerHTML =
      '<div data-message-id="u1" data-message-role="user">привет</div>' +
      '<div data-message-id="a1" data-message-role="assistant">Привет! Чем помочь?</div>';
    const msgs = loadAdapter().extractMessages();
    expect(msgs.map(function (m) { return [m.role, m.content]; })).toEqual([
      ['user', 'привет'],
      ['assistant', 'Привет! Чем помочь?']
    ]);
  });

  test('reasoning-панель уходит в hiddenReasoning, а не в content', function () {
    document.body.innerHTML =
      '<div data-message-id="u1" data-message-role="user">привет</div>' +
      '<div data-message-id="a1" data-message-role="assistant">' +
      '<div class="thinking">Завершено размышление\nПользователь здоровается.</div>' +
      '<div class="answer-body">Привет!</div>' +
      '</div>';
    const msgs = loadAdapter().extractMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[1].content).toBe('Привет!');
    expect(msgs[1].content).not.toContain('Завершено размышление');
    expect(msgs[1].hiddenReasoning).toBe('Пользователь здоровается.');
  });

  test('служебная шапка панели снимается, но сам текст размышления сохраняется', function () {
    document.body.innerHTML =
      '<div data-message-role="assistant"><div class="thinking">Thinking… 3s\nПроверяю варианты.</div>' +
      '<div>Ответ</div></div>';
    const msgs = loadAdapter().extractMessages();
    expect(msgs[0].hiddenReasoning).toBe('Проверяю варианты.');
  });

  test('служебные узлы (кнопки/иконки) и «.» свёрнутой панели сообщением не становятся', function () {
    document.body.innerHTML =
      '<div data-message-role="user"><span>привет</span><button class="copy">Копировать</button></div>' +
      '<div data-message-role="assistant">.</div>';
    const msgs = loadAdapter().extractMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('привет');
  });

  test('пустой DOM → пустой массив (адаптер не выдумывает сообщения)', function () {
    expect(loadAdapter().extractMessages()).toEqual([]);
  });

  test('getFullDialogText склеивает content через \\n', function () {
    document.body.innerHTML =
      '<div data-message-role="user">привет</div>' +
      '<div data-message-role="assistant">Привет!</div>';
    expect(loadAdapter().getFullDialogText()).toBe('привет\nПривет!');
  });
});

describe('O-35: QwenAdapter — detectModel', function () {
  test('нет модели в разметке → канонический qwen3.8-max (не выдуманный ярлык)', function () {
    document.body.innerHTML = '<textarea placeholder="Спросить Qwen"></textarea>';
    expect(loadAdapter().detectModel()).toBe('qwen3.8-max');
  });

  test('id из разметки распознаётся', function () {
    document.body.innerHTML = '<div class="model-name">Qwen3.8-Max</div>';
    expect(loadAdapter().detectModel()).toBe('qwen3.8-max');
  });
});
