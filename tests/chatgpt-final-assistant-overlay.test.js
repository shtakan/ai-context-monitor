/**
 * ChatGPT: сетевой снимок последнего assistant может быть снят ДО финализации ответа
 * (canvas/textdoc дописывается клиентом уже после последнего GET `/backend-api/conversation`).
 * В логе при этом «все сообщения на месте»: пара user+assistant есть, но текст ответа —
 * огрызок. `baseComplete=true` + виртуализированная лента (`tail.bounded=false`) не дают
 * добрать хвост, а сам узел уже числится в базе (id в baseIdSet), поэтому в tail он не попадает.
 *
 * ПРАВИЛО 3 (Behavior-Only): проверяется публичное API window.AiCmHybridTail; свободные
 * переменные контент-скриптов кладутся в глобальный скоуп — как в браузере.
 */

'use strict';

const loadEsmHelper = require('./helpers/load-esm.js');
const Canonical = loadEsmHelper.loadEsmModule('utils/canonical-body.ts');
const Hybrid = loadEsmHelper.loadEsmGlobal('core/hybrid-tail.ts', 'AiCmHybridTail');

const SCOPE_KEYS = [
  'baseSeen', 'baseText', 'baseCount', 'baseComplete', 'baseIdSet', 'baseSkelSet',
  'baseAnchors', 'lastBounded', 'lastTailSig', 'lastHybridTailSig', 'currentAdapter',
  'aiCmMetricBaseText', 'debugLog', 'aiCmBasePrepared', 'ANCHOR_MIN'
];

const U1 = 'Расскажи коротко про Rust и Tauri';
const A1_PART = 'Текст примерно на 500 слов. Rust — системный язык, а Tauri — фреймворк.';
const A1_FULL = A1_PART + ' Финальный абзац: вместе они дают компактные настольные приложения.';

const BASE = [
  { id: 'u1', role: 'user', text: U1 },
  { id: 'a1', role: 'assistant', text: A1_PART }
];

function installScope(over) {
  const baseText = Canonical.canonicalBodyText(BASE);
  const scope = {
    baseSeen: true,
    baseText: baseText,
    baseCount: BASE.length,
    baseComplete: true,
    baseIdSet: new Set(['u1', 'a1']),
    baseSkelSet: new Set(BASE.map(function (m) { return Hybrid.aiCmTailSkel(m.text); })),
    baseAnchors: [],
    lastBounded: null,
    lastTailSig: null,
    lastHybridTailSig: null,
    currentAdapter: { siteName: 'chatgpt' },
    aiCmMetricBaseText: undefined,
    debugLog: function () { },
    aiCmBasePrepared: BASE,
    ANCHOR_MIN: 40
  };
  Object.assign(scope, over || {});
  SCOPE_KEYS.forEach(function (k) { global[k] = scope[k]; });
  return scope;
}

function render(msgs) {
  document.body.innerHTML = '<div class="feed"></div>';
  const feed = document.querySelector('.feed');
  msgs.forEach(function (m) {
    const el = document.createElement('div');
    el.setAttribute('data-message-author-role', m.role);
    if (m.id) el.setAttribute('data-message-id', m.id);
    el.textContent = m.text || '';
    feed.appendChild(el);
  });
}

beforeEach(function () {
  document.body.innerHTML = '';
  SCOPE_KEYS.forEach(function (k) { delete global[k]; });
});

afterEach(function () {
  SCOPE_KEYS.forEach(function (k) { delete global[k]; });
});

describe('ChatGPT: финальный assistant из DOM (тот же ход, продолжение)', () => {
  test('сырой префикс: DOM длиннее сети → итог = DOM-текст', function () {
    render([{ id: 'u1', role: 'user', text: U1 }, { id: 'a1', role: 'assistant', text: A1_FULL }]);
    installScope({});

    const ov = Hybrid.aiCmFinalAssistantOverlay(BASE);
    expect(ov).toEqual({ index: 1, before: A1_PART, text: A1_FULL });
  });

  test('markdown в сети, текст в DOM: сравнение без разметки, разметка префикса сохранена', function () {
    const before = '**Начало** ответа про Rust и Tauri: системный язык и фреймворк.';
    const full = 'Начало ответа про Rust и Tauri: системный язык и фреймворк. Финальный абзац после снимка.';
    const base = [
      { id: 'u1', role: 'user', text: U1 },
      { id: 'a1', role: 'assistant', text: before }
    ];
    render([{ id: 'u1', role: 'user', text: U1 }, { id: 'a1', role: 'assistant', text: full }]);
    installScope({ aiCmBasePrepared: base, baseIdSet: new Set(['u1', 'a1']) });

    const ov = Hybrid.aiCmFinalAssistantOverlay(base);
    expect(ov).not.toBeNull();
    expect(ov.text).toBe(before + ' Финальный абзац после снимка.');
  });

  test('обрыв сети посреди слова: остаток слова из DOM не теряется', function () {
    const before = 'Длинный ответ подходит к концу, но не всег';
    const full = 'Длинный ответ подходит к концу, но не всегда финал виден сразу.';
    const base = [
      { id: 'u1', role: 'user', text: U1 },
      { id: 'a1', role: 'assistant', text: before }
    ];
    render([{ id: 'u1', role: 'user', text: U1 }, { id: 'a1', role: 'assistant', text: full }]);
    installScope({ aiCmBasePrepared: base, baseIdSet: new Set(['u1', 'a1']) });

    const ov = Hybrid.aiCmFinalAssistantOverlay(base);
    expect(ov).not.toBeNull();
    expect(ov.text).toBe('Длинный ответ подходит к концу, но не всегда финал виден сразу.');
  });

  test('canvas-маркер в сети не мешает якорю: база обрывается в документе, DOM продолжает', function () {
    const before = 'Вступление. :::writing{variant="document" title="Rust и Tauri"} Rust — системный язык. ' +
      'Tauri использует системный WebView. Однако механизм оказался сложным в управлении и не всегда';
    const full = 'Вступление. Rust и Tauri Rust — системный язык. Tauri использует системный WebView. ' +
      'Однако механизм оказался сложным в управлении и не всегда работает предсказуемо. Финал документа.';
    const base = [
      { id: 'u1', role: 'user', text: U1 },
      { id: 'a1', role: 'assistant', text: before }
    ];
    render([{ id: 'u1', role: 'user', text: U1 }, { id: 'a1', role: 'assistant', text: full }]);
    installScope({ aiCmBasePrepared: base, baseIdSet: new Set(['u1', 'a1']) });

    const ov = Hybrid.aiCmFinalAssistantOverlay(base);
    expect(ov).not.toBeNull();
    expect(ov.text).toBe(before + ' работает предсказуемо. Финал документа.');
  });

  test('закрывающий маркер ::: в конце сети: финальный абзац перед ним, маркер не дублируется', function () {
    const body = 'Документ про Rust. Первый абзац. Второй абзац. ' +
      'Итог: баланс между удобством разработки и безопасностью.';
    const before = body + '\n:::';
    const full = body + ' Финальный абзац, которого не было в снимке.';
    const base = [
      { id: 'u1', role: 'user', text: U1 },
      { id: 'a1', role: 'assistant', text: before }
    ];
    render([{ id: 'u1', role: 'user', text: U1 }, { id: 'a1', role: 'assistant', text: full }]);
    installScope({ aiCmBasePrepared: base, baseIdSet: new Set(['u1', 'a1']) });

    const ov = Hybrid.aiCmFinalAssistantOverlay(base);
    expect(ov).not.toBeNull();
    expect(ov.text).toBe(body + ' Финальный абзац, которого не было в снимке.\n:::');
  });

  test('новая разметка ChatGPT: текст берётся из адаптера, а не из общих селекторов', function () {
    document.body.innerHTML = '';
    installScope({
      currentAdapter: { siteName: 'chatgpt', getLastAssistantText: function () { return A1_FULL; } }
    });

    const ov = Hybrid.aiCmFinalAssistantOverlay(BASE);
    expect(ov).toEqual({ index: 1, before: A1_PART, text: A1_FULL });
  });

  test('DOM-узел с чужим id (новый ход) не подменяет базу', function () {
    render([{ id: 'u1', role: 'user', text: U1 }, { id: 'a2', role: 'assistant', text: A1_FULL }]);
    installScope({});

    expect(Hybrid.aiCmFinalAssistantOverlay(BASE)).toBeNull();
  });

  test('DOM не длиннее сети или не совпадает → перекрытия нет', function () {
    render([{ id: 'u1', role: 'user', text: U1 }, { id: 'a1', role: 'assistant', text: A1_PART }]);
    installScope({});
    expect(Hybrid.aiCmFinalAssistantOverlay(BASE)).toBeNull();

    render([{ id: 'u1', role: 'user', text: U1 }, { id: 'a1', role: 'assistant', text: 'Совсем другой ответ, который не является продолжением сетевого текста.' }]);
    expect(Hybrid.aiCmFinalAssistantOverlay(BASE)).toBeNull();
  });

  test('не ChatGPT → поведение прежнее (перекрытие выключено)', function () {
    render([{ id: 'u1', role: 'user', text: U1 }, { id: 'a1', role: 'assistant', text: A1_FULL }]);
    installScope({ currentAdapter: { siteName: 'gemini' } });

    expect(Hybrid.aiCmFinalAssistantOverlay(BASE)).toBeNull();
  });
});

describe('ChatGPT: метрики и тело снимка учитывают финальный текст', () => {
  test('getEffectiveText/getEffectiveMessages: последний assistant заменён, счётчик прежний', function () {
    render([{ id: 'u1', role: 'user', text: U1 }, { id: 'a1', role: 'assistant', text: A1_FULL }]);
    const scope = installScope({});

    const expectedText = Canonical.canonicalBodyText([
      BASE[0],
      { id: 'a1', role: 'assistant', text: A1_FULL }
    ]);
    expect(Hybrid.getEffectiveText()).toBe(expectedText);
    expect(Hybrid.getEffectiveCount(BASE.length)).toBe(BASE.length);

    const messages = Hybrid.getEffectiveMessages();
    expect(messages.length).toBe(BASE.length);
    expect(messages[1].text).toBe(A1_FULL);
    expect(messages[0]).toBe(BASE[0]); // остальные сообщения не копируются без нужды
    expect(Canonical.canonicalBodyText(messages)).toBe(Hybrid.getEffectiveText());
    expect(scope.aiCmBasePrepared).toBe(BASE);
  });

  test('aiCmApplyFinalAssistantOverlay: копия с заменой, исходный массив не мутируется', function () {
    render([{ id: 'u1', role: 'user', text: U1 }, { id: 'a1', role: 'assistant', text: A1_FULL }]);
    installScope({});

    const out = Hybrid.aiCmApplyFinalAssistantOverlay(BASE);
    expect(out).not.toBe(BASE);
    expect(out[1].text).toBe(A1_FULL);
    expect(BASE[1].text).toBe(A1_PART);

    // Без перекрытия возвращается тот же массив: экспорт не пересобирается зря.
    installScope({ currentAdapter: { siteName: 'gemini' } });
    expect(Hybrid.aiCmApplyFinalAssistantOverlay(BASE)).toBe(BASE);
  });
});
