/**
 * O-35: adapters/qwen-adapter.js — DOM-фолбэк chat.qwen.ai.
 *
 * Адаптер включается, когда живой SSE-снимок недоступен (clone() не удался, стрим оборвался,
 * открыт готовый чат): он даёт базу текстов/ходов, чтобы бейдж и экспорт не пустели.
 *
 * Селекторы Qwen — больше НЕ гипотеза: живой DOM chat.qwen.ai снят 2026-09-26 (артефакт
 * tools/qwen-dom-snapshot-26.09.26.json). Пины держат ровно то, что подтвердил снимок:
 *   - реальные реплики — ТОЧНЫЕ классы `.qwen-chat-message.qwen-chat-message-user/assistant`
 *     (по 47 узлов), а не широкий `[class*="chat-message"]`;
 *   - обёртки turn-selection (`.qwen-chat-message-select-turn` — 47 узлов,
 *     `.qwen-chat-message-select-turn-message` — 94) в базу НЕ попадают: ни через точный
 *     набор, ни через широкий кандидат (`:not()`), ни через фильтр `_dropTurnOnlyNodes`;
 *   - роль — только класс-токен: data-* маркеров роли в живом DOM нет (0 совпадений);
 *   - панель размышлений лежит ВНУТРИ реплики и уходит в hiddenReasoning, а текст карточек
 *     инструментов (`qwen-chat-thinking-tool-status-card-wraper`) — служебный шум;
 *   - текст снимается `_readableText`: innerText/структурный фолбэк + нормализация, поэтому
 *     переводы строк сохраняются (дефект textContent: 1-3 строки вместо 7-85).
 * Плюс неизменный контракт BaseAdapter: isOnDialogPage / extractMessages / getFullDialogText
 * / detectModel.
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

// ---------------------------------------------------------------------------------
// Живая разметка снимка 2026-09-26 (усечённая до двух ходов): обёртки turn-selection
// вокруг реальных реплик + панель thinking ВНУТРИ реплики ассистента.
// ---------------------------------------------------------------------------------
function qwenTurn(role, inner) {
  return '<div class="qwen-chat-message-select-turn">' +
    '<div class="qwen-chat-message-select-turn-message">' +
    '<div class="qwen-chat-message qwen-chat-message-' + role + '">' + inner + '</div>' +
    '</div></div>';
}
const LIVE_DOM = '<div class="chat-messages-container"><div class="chat-messages">' +
  qwenTurn('user', '<div class="chat-user-message-container">привет</div>') +
  qwenTurn('assistant',
    '<div class="qwen-chat-thinking-tool-status-card-wraper ant-flex css-mncuj7">' +
    '<div class="qwen-chat-thinking">Завершено размышление\nПользователь здоровается.</div></div>' +
    '<div class="qwen-chat-message-content"><p>Привет!</p><p>Чем помочь?</p></div>') +
  '</div></div>';

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

  test('точные классы реплик без композера — тоже диалог', function () {
    document.body.innerHTML = '<div class="qwen-chat-message qwen-chat-message-user">привет</div>';
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

describe('O-35: QwenAdapter — extractMessages (живая разметка 2026-09-26)', function () {
  test('Д1: реплики берутся ТОЧНЫМИ классами — роли чередуются user/assistant', function () {
    document.body.innerHTML = LIVE_DOM;
    const msgs = loadAdapter().extractMessages();
    expect(msgs.map(function (m) { return m.role; })).toEqual(['user', 'assistant']);
    expect(msgs[0].content).toBe('привет');
  });

  test('Д2: обёртки turn-selection не становятся сообщениями (дублей-контейнеров нет)', function () {
    // 7 узлов с «chat-message» в классе: 2 контейнера чата + 1 turn-selection + 1
    // turn-selection-message + 2 реальные реплики + … — на выходе РОВНО 2 реплики
    document.body.innerHTML = LIVE_DOM;
    const wide = document.querySelectorAll('[class*="chat-message"]:not(.qwen-chat-message-select-turn)');
    expect(wide.length).toBeGreaterThan(2);                     // широкий кандидат их видит
    const msgs = loadAdapter().extractMessages();
    expect(msgs).toHaveLength(2);                               // а адаптер — нет
    expect(msgs.map(function (m) { return m.content; })).toEqual(['привет', 'Привет!\nЧем помочь?']);
  });

  test('Д3: роль — класс-токен; data-* маркеров роли в разметке НЕТ (снимок: 0 совпадений)', function () {
    document.body.innerHTML = LIVE_DOM;
    expect(document.querySelectorAll('[data-message-role], [data-role]')).toHaveLength(0);
    // узлы-кандидаты наследия (data-*) роли больше не решают: класс-токен первичен
    document.body.innerHTML = '<div data-message-role="assistant" ' +
      'class="qwen-chat-message qwen-chat-message-user">вопрос</div>';
    expect(loadAdapter().extractMessages()[0].role).toBe('user');
  });

  test('Д4: текст многострочный — переводы строк сохранены (дефект textContent)', function () {
    document.body.innerHTML = qwenTurn('assistant',
      '<div class="qwen-chat-message-content">Коротко:' +
      '<p>первый пункт</p><p>второй пункт</p>' +
      '<pre>def is_prime(n):\n    return n &gt; 1</pre></div>');
    const content = loadAdapter().extractMessages()[0].content;
    // textContent дал бы одну строку: "Коротко:первый пунктвторой пунктdef is_prime(n):..."
    expect(content.split('\n').length).toBeGreaterThan(3);
    // блоки разведены переводом строки (textContent склеил бы их без разделителя)
    expect(content).toContain('\nпервый пункт');
    expect(content).toContain('первый пункт\nвторой пункт');
    expect(content).toContain('def is_prime(n):\n    return n > 1');
  });

  test('Д5: одна длинная реплика ассистента — не склейка: каждый ход ровно один раз', function () {
    document.body.innerHTML = LIVE_DOM;
    const msgs = loadAdapter().extractMessages();
    expect(msgs).toHaveLength(2);
    // «дублей-контейнеров» нет: текст реплики ассистента в базе РОВНО один раз
    expect(msgs.filter(function (m) { return m.content === 'Привет!\nЧем помочь?'; })).toHaveLength(1);
  });

  test('Д7: снятый служебный узел оставляет границу строки (соседний текст не склеивается)', function () {
    document.body.innerHTML = qwenTurn('assistant',
      '<div class="qwen-chat-message-content">первая часть<button class="copy">Копировать</button>' +
      'вторая часть</div>');
    const content = loadAdapter().extractMessages()[0].content;
    expect(content).not.toContain('Копировать');   // кнопка — служебный узел
    expect(content).not.toBe('первая частьвторая часть');
    expect(content).toContain('первая часть');
    expect(content).toContain('вторая часть');
    expect(content.split('\n').length).toBe(2);
  });

  test('reasoning-панель уходит в hiddenReasoning, а не в content', function () {
    document.body.innerHTML = LIVE_DOM;
    const msgs = loadAdapter().extractMessages();
    expect(msgs[1].content).not.toContain('Завершено размышление');
    expect(msgs[1].hiddenReasoning).toBe('Пользователь здоровается.');
  });

  test('Д6: текст карточки инструмента (tool-status-card) в reasoning НЕ попадает', function () {
    document.body.innerHTML = qwenTurn('assistant',
      '<div class="qwen-chat-thinking-tool-status-card-wraper">Ищу в интернете…</div>' +
      '<div class="qwen-chat-message-content">Ответ</div>');
    const msgs = loadAdapter().extractMessages();
    expect(msgs[0].content).toBe('Ответ');
    expect(msgs[0].hiddenReasoning).toBeUndefined();
  });

  test('R1: панель ВНУТРИ карточки инструмента по-прежнему находится (guard не режет размышление)', function () {
    document.body.innerHTML = qwenTurn('assistant',
      '<div class="qwen-chat-thinking-tool-status-card-wraper">' +
      '<div class="qwen-chat-thinking">Thinking… 3s\nПроверяю варианты.</div></div>' +
      '<div class="qwen-chat-message-content">Ответ</div>');
    const msgs = loadAdapter().extractMessages();
    expect(msgs[0].hiddenReasoning).toBe('Проверяю варианты.');
  });

  test('R2: узлы-КОНТЕЙНЕРЫ всего чата (широкий кандидат) в базу не проходят', function () {
    document.body.innerHTML = LIVE_DOM;
    const msgs = loadAdapter().extractMessages();
    // текст всего чата как отдельного сообщения (artefact O-36.2) отсутствует
    expect(msgs.some(function (m) { return m.content.indexOf('Привет!') !== -1 && m.content.indexOf('привет') !== -1; }))
      .toBe(false);
  });

  test('служебные узлы (кнопки/иконки) и «.» свёрнутой панели сообщением не становятся', function () {
    document.body.innerHTML =
      qwenTurn('user', '<span>привет</span><button class="copy">Копировать</button>') +
      qwenTurn('assistant', '.');
    const msgs = loadAdapter().extractMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('привет');
  });

  test('R3: наследники старых сборок (data-message-id) читаются, если точных классов нет', function () {
    document.body.innerHTML =
      '<div data-message-id="u1" data-message-role="user">привет</div>' +
      '<div data-message-id="a1" data-message-role="assistant">Привет! Чем помочь?</div>';
    const msgs = loadAdapter().extractMessages();
    expect(msgs.map(function (m) { return m.content; })).toEqual(['привет', 'Привет! Чем помочь?']);
  });

  test('пустой DOM → пустой массив (адаптер не выдумывает сообщения)', function () {
    expect(loadAdapter().extractMessages()).toEqual([]);
  });

  test('getFullDialogText склеивает content через \\n', function () {
    document.body.innerHTML =
      qwenTurn('user', 'привет') + qwenTurn('assistant', 'Привет!');
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

describe('O-39-план замены (qwen-селекторы): source-пины точки правки', function () {
  test('точные классы стоят ПЕРВЫМ кандидатом, широкий — последним и с :not() обёртки', function () {
    const exact = QWEN_SRC.indexOf(
      "'.qwen-chat-message.qwen-chat-message-user, .qwen-chat-message.qwen-chat-message-assistant',");
    const wide = QWEN_SRC.indexOf("'[class*=\"chat-message\"]:not(.qwen-chat-message-select-turn)'");
    expect(exact).toBeGreaterThan(-1);
    expect(wide).toBeGreaterThan(exact);
    // data-* кандидаты наследия сохранены, но идут ПОСЛЕ точного набора
    expect(QWEN_SRC.indexOf("'[data-message-id]',")).toBeGreaterThan(exact);
  });

  test('data-* путь определения роли удалён, класс-токен — первым', function () {
    expect(QWEN_SRC).not.toContain("element.getAttribute('data-message-role')");
    expect(QWEN_SRC).not.toContain("element.getAttribute('data-role')");
    const body = QWEN_SRC.slice(QWEN_SRC.indexOf('_detectRole(element)'));
    expect(body.indexOf("cls.indexOf('qwen-chat-message-user')"))
      .toBeLessThan(body.indexOf('return \'user\';'));
    expect(body).toContain("cls.indexOf('qwen-chat-message-assistant')");
  });

  test('guard карточек инструментов и фильтр обёрток — в точке правки', function () {
    expect(QWEN_SRC).toContain('[class*="thinking"]:not([class*="tool-status-card"])');
    expect(QWEN_SRC).toContain('[class*="thought"]:not([class*="tool-status-card"])');
    // селектор `[class*="reason"]` убран: он матчил `…-card-wraper` (wraper ⊃ raper)
    expect(QWEN_SRC).not.toContain("'[class*=\"reason\"]");
    expect(QWEN_SRC).toContain('_isToolStatusCard(node)');
    // карточки инструментов — служебный шум и в тексте реплики
    expect(QWEN_SRC).toContain('[class*="tool-status-card"]\'');
    expect(QWEN_SRC).toContain("cls.indexOf('select-turn') === -1");
    expect(QWEN_SRC).toContain('_dropTurnOnlyNodes');
  });

  test('дефект текста: textContent реплики больше не источник, многострочность через _readableText', function () {
    expect(QWEN_SRC).toContain('_readableText(clone)');
    expect(QWEN_SRC).toContain('element.innerText');
    expect(QWEN_SRC).toContain('_innerTextFallback');
    // снятие служебных узлов оставляет маркер-границу (иначе соседний текст склеивается)
    expect(QWEN_SRC).toContain('_removeKeepingCut(clone.querySelectorAll(this._noiseSelectors))');
    expect(QWEN_SRC).toContain('QWEN_CUT_MARKER');
    expect(QWEN_SRC).not.toContain('clone.textContent');
  });
});
