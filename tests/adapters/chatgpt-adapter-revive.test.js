/**
 * РЕВИВАЛ АДАПТЕРА CHATGPT: TURN-BASED ОТБОР НА [data-turn-key].
 *
 * Источник истины — закрытая диагностика 2026-10-13 (3 раунда, живой DOM chatgpt.com,
 * длинный чат, ровно 5 пар): [data-turn-key] = 5 узлов, стабильный UUID НА ХОД; внутри
 * хода [class*="bg-user-message"] = реплика пользователя (5/5), [class*="block-"]
 * (конкретно block-BQZwFn) = ответ (5/5, длины 2213/1372/1022/756/487). Прежние
 * селекторы (.markdown, assistant-message, model-response, data-message-author-role,
 * data-virtualized-turn-content) на ТОМ ЖЕ DOM дали 0 совпадений.
 *
 * Корень дефекта, который эти пины закрывают: adapters/chatgpt-adapter.js имел один
 * плоский селектор '.whitespace-pre-wrap, .markdown' (оба матчили только user) и
 * нормализацию `role === 'unknown' ? 'user' : role`, то есть ЗАПИСЫВАЛ ответ ассистента
 * в базу как реплику пользователя. Пины C-1/C-2 требуют, чтобы 'unknown' НЕ попадал
 * в результат и НЕ подменялся на 'user'.
 *
 * Песочница: изолированный jsdom (jest testEnvironment=jsdom) + tests/helpers/
 * adapter-harness.js — тот же исходник, что уезжает в бандл, без браузера. Живой
 * приёмки здесь нет (прецедент contract-*): снимок вписан в JSON ниже, руками.
 * JSON лежит ЗДЕСЬ, а не в tests/fixtures/: приёмка требует ровно два изменённых файла
 * (M adapters/chatgpt-adapter.js + A этот файл).
 */

const fs = require('fs');
const path = require('path');
const { loadAdapter } = require('../helpers/adapter-harness');

const ADAPTER_REL = 'adapters/chatgpt-adapter.js';
const BASE_REL = 'adapters/base-adapter.js';
const ADAPTER_PATH = path.join(__dirname, '..', '..', ADAPTER_REL);
const BASE_PATH = path.join(__dirname, '..', '..', BASE_REL);
const ADAPTER_SRC = fs.readFileSync(ADAPTER_PATH, 'utf8');
const BASE_SRC = fs.readFileSync(BASE_PATH, 'utf8');

const loc = { hostname: 'chatgpt.com', pathname: '/c/68f1c2a0-live-snapshot-2026-10-13' };

/** Живой снимок 2026-10-13: 5 пар (тексты — превью реальных, длины — измеренные). */
const LIVE_SNAPSHOT = {
  capturedAt: '2026-10-13',
  url: 'chatgpt.com/c/<long-chat>',
  turnKeyAttr: 'data-turn-key',
  turnKeyKind: 'uuid-per-turn',
  userMarkerClass: 'bg-user-message',
  assistantClassSample: 'block-BQZwFn',
  deadSelectors: [
    '.markdown',
    'assistant-message',
    'model-response',
    'data-message-author-role',
    'data-virtualized-turn-content'
  ],
  turns: [
    {
      key: '3f1c0d2a-5b7e-4a91-9c33-0d1e2f3a4b50',
      user: 'Перепиши адаптер под turn-based архитектуру.\nНужны маркеры хода и обеих ролей.',
      assistant: [
        'Ход — это узел [data-turn-key]; внутри него лежат обе реплики.',
        'Реплика пользователя помечена подстрокой bg-user-message, ответ — контейнером block-*.',
        'Отбор идёт от хода: плоский селектор содержимого на этой разметке даёт ноль совпадений.'
      ],
      liveLen: 2213
    },
    {
      key: '7a2b91e4-1c6d-4f80-b2aa-9e5d3c7f1a02',
      user: 'Как отличить ответ от вопроса структурно?\nВедь класс block-* — это Tailwind JIT.',
      assistant: [
        'Буквально block-BQZwFn не пинится: хеш меняется при пересборке сайта.',
        'Уровень 1 — [class*="block-"] или [class*="content-"] внутри хода без маркера пользователя.',
        'Уровень 2 — структурный: самый длинный текстовый узел хода после реплики.'
      ],
      liveLen: 1372
    },
    {
      key: 'b5e0c7d8-2f31-4a6b-8c44-71d9e0a2b3c4',
      user: 'А что с хвостом чата, который ещё не получил data-turn-key?',
      assistant: [
        'Уровень 3 — хвост и виртуализация: bg-user-message без [data-turn-key],',
        'роль user остаётся за ним, а следующий sibling с непустым текстом — это ответ.'
      ],
      liveLen: 1022
    },
    {
      key: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f',
      user: 'Старые сборки ChatGPT ломать нельзя.',
      assistant: [
        'Уровень 4 — легаси .markdown/.whitespace-pre-wrap, и только если живой отбор пуст.'
      ],
      liveLen: 756
    },
    {
      key: 'd4e5f607-1829-4a3b-9c5d-6e7f8091a2b3',
      user: 'И последнее: никакого console.log вне гейта.',
      assistant: [
        'Диагностика уходит в aiCm-строку под гейтом, вне гейта — тишина.'
      ],
      liveLen: 487
    }
  ]
};

/** Абзацы ответа, добитые до ИЗМЕРЕННОЙ длины снимка (liveLen) — так пин держит числа. */
function assistantParas(turn) {
  const joined = turn.assistant.join('\n');
  if (joined.length > turn.liveLen) {
    throw new Error('фикстура длиннее живого снимка: ' + turn.key + ' (' + joined.length + ' > ' + turn.liveLen + ')');
  }
  const pad = turn.liveLen - joined.length;
  if (pad === 0) return turn.assistant.slice();
  const last = turn.assistant[turn.assistant.length - 1] + '·'.repeat(pad);
  return turn.assistant.slice(0, -1).concat([last]);
}

function expectedAssistant(turn) {
  return assistantParas(turn).join('\n');
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Дистрактор уровня 1: длинная панель размышлений внутри хода (в живом DOM тоже есть). */
function reasoningPanel(turn) {
  const panel = el('div', 'o1-prose-panel', 'РАЗМЫШЛЕНИЕ:' + 'р'.repeat(turn.liveLen));
  return panel;
}

/**
 * Разметка ровно по снимку 2026-10-13: ход → реплика пользователя (bg-user-message,
 * текст в .whitespace-pre-wrap, кнопка Edit) → ответ (block-*, абзацы в <p>, кнопка Copy)
 * → панель размышлений. Класса .markdown у ответа НЕТ — в снимке этот селектор дал 0.
 */
function buildLiveDom() {
  document.body.innerHTML = '';
  const shell = el('main', 'flex flex-col');
  const container = el('div', 'chat-shell flex flex-col text-base');
  shell.appendChild(container);
  document.body.appendChild(shell);

  LIVE_SNAPSHOT.turns.forEach(function (turn) {
    const turnEl = el('div', 'group-turn-messages flex flex-col');
    turnEl.setAttribute(LIVE_SNAPSHOT.turnKeyAttr, turn.key);

    const userEl = el('div', 'flex justify-end bg-user-message-color-' + turn.key.slice(0, 4));
    userEl.appendChild(el('div', 'whitespace-pre-wrap', turn.user));
    userEl.appendChild(el('button', '', 'Edit'));
    turnEl.appendChild(userEl);

    const answerEl = el('div', 'block-' + turn.key.slice(0, 6) + ' answer-body');
    assistantParas(turn).forEach(function (para) {
      answerEl.appendChild(el('p', '', para));
    });
    answerEl.appendChild(el('div', '', 'Copy')).setAttribute('role', 'button');
    turnEl.appendChild(answerEl);

    turnEl.appendChild(reasoningPanel(turn));
    container.appendChild(turnEl);
  });
  return container;
}

/** Для тестов фолбэков: один ход с произвольным содержимым. */
function buildSingleTurn(userText, answerNode) {
  document.body.innerHTML = '';
  const turnEl = el('div', 'group-turn-messages');
  turnEl.setAttribute(LIVE_SNAPSHOT.turnKeyAttr, 'single-turn-key-0001');
  if (userText !== null) {
    const userEl = el('div', 'flex bg-user-message-color-abcd');
    userEl.appendChild(el('div', 'whitespace-pre-wrap', userText));
    turnEl.appendChild(userEl);
  }
  if (answerNode) turnEl.appendChild(answerNode);
  document.body.appendChild(turnEl);
  return turnEl;
}

/** Песочница harness: гейт диагностики ЗАКРЫТ (aiCmDiagOn → false). */
function revive() {
  return loadAdapter(ADAPTER_REL, { document: document, location: loc, exportExpr: 'ChatGPTAdapter' });
}

/**
 * Песочница с ОТКРЫТЫМ гейтом: заглушка harness жёстко возвращает false, поэтому
 * диагностический путь проверяется отдельной мини-песочницей (тот же приём, что в
 * tests/qwen-adapter.test.js): new Function отдаёт класс, aiCmDiagOn → true.
 */
function reviveWithOpenGate() {
  const calls = [];
  const factory = new Function(
    'document', 'location', 'debugLog', 'console', 'swallowSoft',
    'aiCmDiagWarn', 'aiCmDiagOn', 'aiCmDiagLine',
    BASE_SRC + '\n' + ADAPTER_SRC + '\nreturn ChatGPTAdapter;'
  );
  const Ctor = factory(
    document, loc, function () { }, console,
    function () { }, function () { },
    function () { return true; },
    function (marker, data) { calls.push({ marker: marker, data: data }); }
  );
  return { Adapter: new Ctor(), calls: calls };
}

describe('chatgpt-adapter revive: turn-based отбор на [data-turn-key] (снимок 2026-10-13)', function () {
  beforeEach(function () { document.body.innerHTML = ''; });
  afterEach(function () { jest.restoreAllMocks(); });

  // ---------- P1: N ходов снимка → 2N записей ----------
  test('P1: 5 ходов снимка → ровно 2N = 10 записей (и liveLen фикстуры не выдуманы)', function () {
    LIVE_SNAPSHOT.turns.forEach(function (turn) {
      expect(expectedAssistant(turn).length).toBe(turn.liveLen);
      expect(turn.user.length).toBeGreaterThan(0);
    });
    buildLiveDom();
    const msgs = revive().Adapter.extractMessages();
    expect(LIVE_SNAPSHOT.turns).toHaveLength(5);
    expect(msgs).toHaveLength(2 * LIVE_SNAPSHOT.turns.length);
    expect(msgs).toHaveLength(10);
  });

  // ---------- P2: роли чередуются, обе присутствуют 5+5 ----------
  test('P2: роли строго чередуются {user, assistant} — 5+5, без третьей роли', function () {
    buildLiveDom();
    const msgs = revive().Adapter.extractMessages();
    const roles = msgs.map(function (m) { return m.role; });
    const expected = [];
    LIVE_SNAPSHOT.turns.forEach(function () { expected.push('user', 'assistant'); });
    expect(roles).toEqual(expected);
    expect(roles.filter(function (r) { return r === 'user'; })).toHaveLength(5);
    expect(roles.filter(function (r) { return r === 'assistant'; })).toHaveLength(5);
    roles.forEach(function (r) { expect(['user', 'assistant']).toContain(r); });
  });

  // ---------- P3: content непуст и равен тексту снимка ----------
  test('P3: content всех 10 непуст и совпадает с текстом снимка (абзацы через \\n)', function () {
    buildLiveDom();
    const msgs = revive().Adapter.extractMessages();
    const expected = [];
    LIVE_SNAPSHOT.turns.forEach(function (turn) {
      expected.push(turn.user, expectedAssistant(turn));
    });
    msgs.forEach(function (m, i) {
      expect(typeof m.content).toBe('string');
      expect(m.content.trim().length).toBeGreaterThan(0);
      expect(m.content).toBe(expected[i]);
    });
    // кнопки (Edit/Copy) и панели размышлений в текст не протекли
    msgs.forEach(function (m) {
      expect(m.content).not.toContain('Copy');
      expect(m.content).not.toContain('Edit');
      expect(m.content).not.toContain('РАЗМЫШЛЕНИЕ');
    });
  });

  // ---------- P4: нет дублей ----------
  test('P4: 10 уникальных текстов (loose-уровень не удваивает реплики)', function () {
    buildLiveDom();
    const msgs = revive().Adapter.extractMessages();
    const uniq = new Set(msgs.map(function (m) { return m.content; }));
    expect(uniq.size).toBe(msgs.length);
    expect(uniq.size).toBe(10);
    expect(msgs.filter(function (m) { return m.role === 'user'; })).toHaveLength(5);
  });

  // ---------- P5: приоритет уровней ----------
  test('P5-1: приоритет 1 — [class*="block-"] выигрывает у более длинной панели в том же ходе', function () {
    buildLiveDom();
    const turn = LIVE_SNAPSHOT.turns[0];
    const msgs = revive().Adapter.extractMessages();
    const answer = msgs[1];
    expect(answer.role).toBe('assistant');
    expect(answer.content).toBe(expectedAssistant(turn));
    // структурный уровень 2 (самый длинный узел) ответ не подменил
    expect(answer.content).not.toContain('РАЗМЫШЛЕНИЕ');
    expect(answer.content.length).toBeLessThan(turn.liveLen + 200);
  });

  test('P5-2: приоритет 2 — структурный фолбэк, когда block-/content- внутри хода пусто', function () {
    const answerEl = el('div', 'answer-shell-plain');
    answerEl.appendChild(el('p', '', 'Структурный уровень: класс ответа не опознан.'));
    buildSingleTurn('Вопрос при неизвестном классе ответа.', answerEl);
    const msgs = revive().Adapter.extractMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('user');
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].content).toBe('Структурный уровень: класс ответа не опознан.');
  });

  test('P5-3: приоритет 3 — хвост/виртуализация: bg-user-message без [data-turn-key]', function () {
    document.body.innerHTML = '';
    const tail = el('div', 'flex flex-col');
    tail.appendChild(el('div', 'bg-user-message-color-ffff', 'Хвостовая реплика без атрибута хода.'));
    const next = el('div', 'answer-tail');
    next.appendChild(el('p', '', 'Ответ на хвостовую реплику.'));
    tail.appendChild(next);
    document.body.appendChild(tail);

    expect(document.querySelectorAll(LIVE_SNAPSHOT.turnKeyAttr)).toHaveLength(0);
    const msgs = revive().Adapter.extractMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs.map(function (m) { return m.role; })).toEqual(['user', 'assistant']);
    expect(msgs[1].content).toBe('Ответ на хвостовую реплику.');
  });

  test('P5-4: приоритет 4 — легаси .markdown/.whitespace-pre-wrap работает, но block-BQZwFn НЕ пиннится', function () {
    // 4а: буквальный класс ответа с живого снимка в селекторы не вписан
    const A = revive().Adapter;
    expect(A._assistantSelectors).not.toContain('block-BQZwFn');
    expect(A._assistantSelectors.join(' ')).not.toContain('block-BQZwFn');
    expect(ADAPTER_SRC).toContain('block-BQZwFn'); // класс описан в комментарии-дизайне
    expect(A._turnSelectors).toEqual(['[data-turn-key]']);

    // 4б: древняя сборка — маркеров хода и bg-user-message нет, роли только по классам
    document.body.innerHTML = '';
    const bubble = el('div', 'user-message-bubble-color-1234');
    bubble.appendChild(el('div', 'whitespace-pre-wrap', 'Легаси-вопрос.'));
    document.body.appendChild(bubble);
    document.body.appendChild(el('div', 'markdown', 'Легаси-ответ.'));

    const msgs = revive().Adapter.extractMessages();
    expect(msgs.map(function (m) { return m.role; })).toEqual(['user', 'assistant']);
    expect(msgs[0].content).toBe('Легаси-вопрос.');
    expect(msgs[1].content).toBe('Легаси-ответ.');
    expect(A.isOnDialogPage()).toBe(true);
  });

  // ---------- CORE: нормализация 'unknown' → 'user' удалена ----------
  test('C-1 (корень дефекта): узел без маркера роли НЕ записывается как user', function () {
    document.body.innerHTML = '';
    document.body.appendChild(el('div', 'whitespace-pre-wrap', 'Одинокий узел без маркеров роли.'));
    const msgs = revive().Adapter.extractMessages();
    // прежняя версия вернула бы [{role:'user'}]; теперь — ничего
    expect(msgs).toHaveLength(0);
  });

  test('C-2 (корень дефекта): в смешанной легаси-разметке unknown отсечён, ответ остаётся ответом', function () {
    document.body.innerHTML = '';
    document.body.appendChild(el('div', 'whitespace-pre-wrap', 'Узел без маркеров роли.'));
    document.body.appendChild(el('div', 'markdown', 'Настоящий ответ ассистента.'));
    const msgs = revive().Adapter.extractMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('assistant');
    expect(msgs[0].content).toBe('Настоящий ответ ассистента.');
    // нормализация вырезана из исходника целиком
    expect(ADAPTER_SRC).not.toContain("role === 'unknown' ? 'user' : role");
    expect(ADAPTER_SRC).not.toContain("'unknown' ? 'user'");
  });

  test('C-3: ход без реплики пользователя не угадывает ответ по длине текста', function () {
    buildSingleTurn(null, el('div', 'answer-shell-plain', 'Длинный текст, но роль недоказуема.'));
    const msgs = revive().Adapter.extractMessages();
    expect(msgs).toHaveLength(0);
  });

  // ---------- S-1: селекторы в конструкторе + комментарий-дизайн ----------
  test('S-1 (C5): селекторы объявлены в конструкторе, дата и счётчики снимка — в комментарии', function () {
    const A = revive().Adapter;
    expect(A._turnSelectors).toEqual(['[data-turn-key]']);
    expect(A._userSelectors).toContain('[class*="bg-user-message"]');
    expect(A._userSelectors).toContain('[class*="text-user-message"]');
    expect(A._assistantSelectors).toContain('[class*="block-"]');
    expect(A._assistantSelectors).toContain('[class*="content-"]');
    const ctorSrc = ADAPTER_SRC.slice(0, ADAPTER_SRC.indexOf('_extractText('));
    expect(ctorSrc).toContain('2026-10-13');
    expect(ctorSrc).toContain('5/5');
    expect(ctorSrc).toContain('2213');
    expect(ctorSrc).toContain('3 раунда');
    // мёртвые селекторы снимка не остались рабочими путями отбора
    LIVE_SNAPSHOT.deadSelectors.forEach(function (sel) {
      expect(ADAPTER_SRC).toContain(sel); // перечислены как отброшенные
    });
  });

  // ---------- R-1: _extractText не сломан ----------
  test('R-1: _extractText держит многострочность и не склеивает абзацы', function () {
    const A = revive().Adapter;
    const two = el('div', 'block-zzz');
    two.appendChild(el('p', '', 'первый абзац'));
    two.appendChild(el('p', '', 'второй абзац'));
    const twoText = A._extractText(two);
    expect(twoText).toBe('первый абзац\nвторой абзац');
    expect(twoText).not.toBe('первый абзацвторой абзац');

    const raw = el('div', 'block-yyy', 'строка 1\nстрока 2\n\nстрока 3');
    expect(A._extractText(raw)).toBe('строка 1\nстрока 2\n\nстрока 3');

    // кнопки/svg/role=button вырезаются, края обрезаны, внутренние \n целы
    const dirty = el('div', 'block-xxx');
    dirty.appendChild(el('p', '', '  тело ответа  '));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.textContent = 'SVGLEAK';
    dirty.appendChild(svg);
    const btn = el('div', '', 'COPYLEAK');
    btn.setAttribute('role', 'button');
    dirty.appendChild(btn);
    const dirtyText = A._extractText(dirty);
    expect(dirtyText).toBe('тело ответа');
    expect(dirtyText).not.toContain('SVGLEAK');
    expect(dirtyText).not.toContain('COPYLEAK');
  });

  // ---------- R-2: detectModel не сломан ----------
  test('R-2: detectModel находит модель в шапке и не выдумывает её из бренда', function () {
    document.body.innerHTML = '';
    document.body.appendChild(el('button', '', 'GPT-4o')).setAttribute('data-testid', 'model-switcher-dropdown-button');
    expect(revive().Adapter.detectModel()).toBe('GPT-4o');

    document.body.innerHTML = '';
    document.body.appendChild(el('button', '', 'ChatGPT')).setAttribute('data-testid', 'model-switcher-dropdown-button');
    expect(revive().Adapter.detectModel()).toBeNull();
  });

  // ---------- Диагностика под гейтом ----------
  test('D-1: гейт ЗАКРЫТ — aiCmDiagLine не вызван, console.log молчит', function () {
    const spyLog = jest.spyOn(console, 'log');
    buildLiveDom();
    const res = revive();
    const msgs = res.Adapter.extractMessages();
    expect(msgs).toHaveLength(10);
    expect(res.sandbox.called.aiCmDiagOn).toBe(1);
    expect(res.sandbox.called.aiCmDiagLine).toBeUndefined();
    expect(spyLog).not.toHaveBeenCalled();
    expect(res.sandbox.errors.filter(function (e) { return !e.soft; })).toHaveLength(0);
  });

  test('D-2: гейт ОТКРЫТ — строка chatgpt-adapter-turn с counters снимка', function () {
    buildLiveDom();
    const open = reviveWithOpenGate();
    const msgs = open.Adapter.extractMessages();
    expect(msgs).toHaveLength(10);
    const line = open.calls.filter(function (c) { return c.marker === 'chatgpt-adapter-turn'; });
    expect(line).toHaveLength(1);
    expect(line[0].data.turns).toBe(5);
    expect(line[0].data.users).toBe(5);
    expect(line[0].data.assistants).toBe(5);
    expect(line[0].data.msgs).toBe(10);
    expect(open.calls.filter(function (c) { return c.marker === 'chatgpt-roles-miss'; })).toHaveLength(0);
  });

  test('D-3: гейт ОТКРЫТ — ходы есть, ответа нет → chatgpt-roles-miss', function () {
    buildSingleTurn('Вопрос без ответа в ходе.', null);
    const open = reviveWithOpenGate();
    const msgs = open.Adapter.extractMessages();
    expect(msgs).toHaveLength(1);
    const line = open.calls.filter(function (c) { return c.marker === 'chatgpt-adapter-turn'; });
    expect(line[0].data.turns).toBe(1);
    expect(line[0].data.assistants).toBe(0);
    const miss = open.calls.filter(function (c) { return c.marker === 'chatgpt-roles-miss'; });
    expect(miss).toHaveLength(1);
    expect(miss[0].data.turns).toBe(1);
    expect(miss[0].data.userSel).toContain('bg-user-message');
    expect(miss[0].data.assistantSel).toContain('block-');
  });

  // ---------- Совместимость с контрактом BaseAdapter ----------
  test('G-1: контракт BaseAdapter не нарушен (isOnDialogPage/счётчики/полный текст)', function () {
    buildLiveDom();
    const res = revive();
    const A = res.Adapter;
    expect(A.siteName).toBe('chatgpt');
    expect(A).toBeInstanceOf(res.Ctor);
    expect(A.isOnDialogPage()).toBe(true);
    expect(A.getMessageCount()).toBe(10);
    const full = A.getFullDialogText();
    const expected = [];
    LIVE_SNAPSHOT.turns.forEach(function (turn) { expected.push(turn.user, expectedAssistant(turn)); });
    expect(full).toBe(expected.join('\n'));
    expect(res.sandbox.errors.filter(function (e) { return !e.soft; })).toHaveLength(0);

    document.body.innerHTML = '';
    expect(A.isOnDialogPage()).toBe(false);
    expect(A.extractMessages()).toHaveLength(0);
  });
});
