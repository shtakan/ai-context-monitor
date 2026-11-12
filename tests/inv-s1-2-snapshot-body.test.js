/**
 * ADR-001 / S1.2 — тело снимка: chars/msgs/bodyHash/baseComplete из ТОГО ЖЕ массива,
 * из которого построен effective-текст метрик.
 *
 * ЧТО ПИНУЕТСЯ:
 *   1. canonicalBodyText(getEffectiveMessages()) побайтово равен getEffectiveText()
 *      (база + учтённый хвост), а роли хвоста — user/assistant;
 *   2. пустой/неучитываемый хвост не добавляет сообщений — отдаётся ровно база;
 *   3. нет канонического тела (baseSeen=false / пустая база) — getEffectiveMessages()=null;
 *   4. canonicalBody.chars === text.length, bodyHash меняется от convId и воспроизводим;
 *   5. аддитивные поля снимка публикуются только при body.text === effective.
 *
 * ПРАВИЛО 3 (Behavior-Only Tests): тест НЕ читает исходники продукта. core/hybrid-tail.ts
 * берётся через своё публичное API (window.AiCmHybridTail), utils/canonical-body.ts — через
 * статический модуль; свободные переменные контент-скриптов кладутся в глобальный скоуп —
 * ровно так они видны модулю в браузере (харнес gemini-live-tail-after-complete.test.js).
 */

'use strict';

const loadEsmHelper = require('./helpers/load-esm.js');
const Canonical = loadEsmHelper.loadEsmModule('utils/canonical-body.ts');
const Hybrid = loadEsmHelper.loadEsmGlobal('core/hybrid-tail.ts', 'AiCmHybridTail');

// Свободные переменные общего лексического скоупа контент-скриптов.
const SCOPE_KEYS = [
  'baseSeen', 'baseText', 'baseCount', 'baseComplete', 'baseIdSet', 'baseSkelSet',
  'baseAnchors', 'lastBounded', 'lastTailSig', 'lastHybridTailSig', 'currentAdapter',
  'aiCmMetricBaseText', 'debugLog', 'aiCmBasePrepared'
];

// ---- подготовленная база: тот же массив, что в жизни лежит в aiCmBasePrepared ----------
const BASE_PREPARED = [
  { id: 'u1', role: 'user', text: 'Первый вопрос' },
  { id: 'a1', role: 'assistant', text: 'Первый ответ' },
  { id: 'u2', role: 'user', text: 'Второй вопрос' },
  { id: 'a2', role: 'assistant', text: 'Второй ответ' }
];
const BASE_TEXT = Canonical.canonicalBodyText(BASE_PREPARED);
const BASE_COUNT = BASE_PREPARED.length;

// ---- DOM-фикстура ленты: база + новые ходы после обмена --------------------------------
const DOM_BASE = [
  { id: 'u1', kind: 'user-query' },
  { id: 'a1', kind: 'model-response' },
  { id: 'u2', kind: 'user-query' },
  { id: 'a2', kind: 'model-response' }
];
const NEW_MSGS = [
  { id: 'u3', kind: 'user-query', text: 'Третий вопрос после обмена' },
  { id: 'a3', kind: 'model-response', text: 'Свежий ответ модели, которого ещё нет в базе.' }
];
const NEW_TEXT = NEW_MSGS.map(function (m) { return m.text; }).join('\n');

function renderFeed(msgs) {
  document.body.innerHTML = '<div class="conversation-container"></div>';
  const feed = document.querySelector('.conversation-container');
  msgs.forEach(function (m) {
    const el = document.createElement('div');
    el.className = m.kind;
    el.setAttribute('data-message-id', m.id);
    if (m.attrRole) el.setAttribute('data-message-author-role', m.attrRole);
    el.textContent = m.text || '';
    feed.appendChild(el);
  });
}

function installScope(over) {
  const scope = {
    baseSeen: true,
    baseText: BASE_TEXT,
    baseCount: BASE_COUNT,
    baseComplete: true,
    // База узнаётся по id сообщений — как data-message-id в живом DOM.
    baseIdSet: new Set(DOM_BASE.map(function (m) { return m.id; })),
    baseSkelSet: new Set(),
    baseAnchors: [],
    lastBounded: null,
    lastTailSig: null,
    lastHybridTailSig: null,
    currentAdapter: { siteName: 'gemini' },
    aiCmMetricBaseText: undefined, // в песочнице — фолбэк на baseText (как aiCmTailMetricBase)
    debugLog: function () { },
    aiCmBasePrepared: BASE_PREPARED
  };
  Object.assign(scope, over || {});
  SCOPE_KEYS.forEach(function (k) { global[k] = scope[k]; });
  return scope;
}

beforeEach(function () {
  document.body.innerHTML = '';
  SCOPE_KEYS.forEach(function (k) { delete global[k]; });
});

afterEach(function () {
  SCOPE_KEYS.forEach(function (k) { delete global[k]; });
});

describe('S1.2: сообщения эффективного текста = тело снимка', () => {
  test('canonicalBodyText(messages) побайтово равен getEffectiveText()', function () {
    renderFeed(DOM_BASE.concat(NEW_MSGS));
    installScope({});

    // В песочнице нет aiCmMetricBaseText → getEffectiveText() = baseText + '\n' + хвост,
    // и baseText здесь сам равен canonicalBodyText(aiCmBasePrepared) — как в продукте.
    const effective = Hybrid.getEffectiveText();
    const messages = Hybrid.getEffectiveMessages();

    expect(messages).not.toBeNull();
    expect(Canonical.canonicalBodyText(messages)).toBe(effective);
    expect(Canonical.canonicalBodyText(messages)).toBe(BASE_TEXT + '\n' + NEW_TEXT);
    expect(messages.length).toBe(BASE_COUNT + NEW_MSGS.length);
    expect(messages.map(function (m) { return m.text; }))
      .toEqual(BASE_PREPARED.map(function (m) { return m.text; })
        .concat(NEW_MSGS.map(function (m) { return m.text; })));
  });

  test('роли: база сохраняет свои, хвост получает user/assistant', function () {
    renderFeed(DOM_BASE.concat(NEW_MSGS));
    installScope({});

    const messages = Hybrid.getEffectiveMessages();
    expect(messages.map(function (m) { return m.role; }))
      .toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  });

  test('роль хвоста: data-message-author-role приоритетнее класса узла', function () {
    // Атрибут есть у ВСЕХ узлов (иначе селектор [data-message-author-role] нашёл бы только
    // часть ленты и граница базы потерялась бы). Класс ответа, но явный атрибут
    // пользователя — роль берётся из атрибута.
    renderFeed(DOM_BASE.map(function (m) {
      return { id: m.id, kind: m.kind, attrRole: m.kind === 'user-query' ? 'user' : 'assistant' };
    }).concat([
      { id: 'u9', kind: 'model-response', attrRole: 'user', text: 'Вопрос в чужой разметке' }
    ]));
    installScope({});

    const messages = Hybrid.getEffectiveMessages();
    expect(messages.length).toBe(BASE_COUNT + 1);
    expect(messages[messages.length - 1].role).toBe('user');
    expect(Canonical.canonicalBodyText(messages)).toBe(Hybrid.getEffectiveText());
  });

  test('пустой хвост: только база (тот же массив, без копии)', function () {
    renderFeed(DOM_BASE);
    const scope = installScope({});

    const messages = Hybrid.getEffectiveMessages();
    expect(messages).toBe(scope.aiCmBasePrepared);
    expect(messages.length).toBe(BASE_COUNT);
    expect(Canonical.canonicalBodyText(messages)).toBe(Hybrid.getEffectiveText());
    expect(Hybrid.getEffectiveText()).toBe(BASE_TEXT);
  });

  test('неучитываемый (unbounded) хвост базу не дополняет: только база', function () {
    // Сервис вытеснил узлы базы: границы нет, хвост не входит в effective-текст.
    renderFeed(NEW_MSGS);
    installScope({});

    const messages = Hybrid.getEffectiveMessages();
    expect(messages).toBe(BASE_PREPARED);
    expect(Canonical.canonicalBodyText(messages)).toBe(Hybrid.getEffectiveText());
    expect(Hybrid.getEffectiveText()).toBe(BASE_TEXT);
  });

  test('нет канонического тела: baseSeen=false или пустая база → null', function () {
    renderFeed(DOM_BASE.concat(NEW_MSGS));
    installScope({ baseSeen: false });
    expect(Hybrid.getEffectiveMessages()).toBeNull();

    installScope({ baseText: '' });
    expect(Hybrid.getEffectiveMessages()).toBeNull();

    installScope({ aiCmBasePrepared: null });
    expect(Hybrid.getEffectiveMessages()).toBeNull();
  });

  test('canonicalBody: chars === text.length, msgs === длина, bodyHash от convId', function () {
    renderFeed(DOM_BASE.concat(NEW_MSGS));
    installScope({});
    const messages = Hybrid.getEffectiveMessages();
    const effective = Hybrid.getEffectiveText();

    const body = Canonical.canonicalBody('conv-1', messages);
    expect(body.text).toBe(effective);
    expect(body.chars).toBe(body.text.length);
    expect(body.chars).toBe(effective.length);
    expect(body.msgs).toBe(messages.length);

    // Детерминированность и чувствительность к чату.
    const again = Canonical.canonicalBody('conv-1', messages);
    expect(again.bodyHash).toBe(body.bodyHash);
    const otherConv = Canonical.canonicalBody('conv-2', messages);
    expect(otherConv.text).toBe(body.text);
    expect(otherConv.bodyHash).not.toBe(body.bodyHash);
  });

  test('снимок: аддитивные поля публикуются только при body.text === effective', function () {
    renderFeed(DOM_BASE.concat(NEW_MSGS));
    installScope({});
    const messages = Hybrid.getEffectiveMessages();
    const effective = Hybrid.getEffectiveText();

    // Ровно условие content.js: body && body.text === effective.
    const body = Canonical.canonicalBody('conv-1', messages);
    expect(body.text).toBe(effective);
    const published = body.text === effective
      ? { chars: body.chars, msgs: body.msgs, bodyHash: body.bodyHash, baseComplete: true }
      : null;
    expect(published).not.toBeNull();
    expect(published.chars).toBe(effective.length);
    expect(published.msgs).toBe(messages.length);
    expect(typeof published.bodyHash).toBe('string');
    expect(published.bodyHash).toContain(':' + published.chars);
    expect(published.baseComplete).toBe(true);

    // Отрицательный контроль: пустое тело не совпадает с effective — поля не пишутся.
    const empty = Canonical.canonicalBody('conv-2', []);
    expect(empty.text === effective).toBe(false);
    const notPublished = empty.text === effective
      ? { chars: empty.chars, msgs: empty.msgs, bodyHash: empty.bodyHash, baseComplete: true }
      : null;
    expect(notPublished).toBeNull();
  });
});
