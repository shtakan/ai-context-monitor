/**
 * РЕГРЕССИЯ «бейдж Gemini замирает после обмена репликами» (Phase 3).
 *
 * ЖИВОЙ ДЕФЕКТ (воспроизведён на Gemini 2026-11-08, тред 32cdd7e3977def19):
 *   бейдж 44.8% (Токены: 57 654) не меняется после отправки сообщения и получения ответа;
 *   значения обновляются ТОЛЬКО после F5. В логе на каждый ответ:
 *     [content-trace] EMIT принят … baseComplete=true baseCount=70 textLen=197439
 *     [AI CM][realtime] dom-emit pct=44.8 tokens=57387      ← проход БЫЛ, значения те же
 *     o22-histkey-dedup … histKey=70|197439 … verdict=dedup-skip
 *   т.е. ISOLATED получал запрос на пересчёт, но effective-текст не менялся.
 *
 * МЕХАНИЗМ (корень): `historyFullByQuiet` → emit-поле `historyComplete` — это вердикт о
 * ПОЛНОТЕ ЗАГРУЖЕННОЙ ИСТОРИИ (пагинация + oracle на момент загрузки). Он живёт в общем
 * состоянии Phase 3 и НЕ инвалидируется, когда разговор продолжается: новый ход приходит
 * только в DOM (Gemini стримит ответ вне перехваченных batchexecute-RPC, а активный
 * vf5-дозапрос падал с Illegal invocation → activeDisabled=true). Но
 * `getEffectiveText()` при `baseComplete=true` возвращал РОВНО `baseText`, а
 * `getEffectiveCount()` — `baseCount` (core/hybrid-tail.js), поэтому DOM-emit после ответа
 * давал те же цифры → дедуп → бейдж замерзал до перезагрузки (F5 ингестит новые ходы в базу).
 *
 * ЧТО ПИНУЕТСЯ: при полной базе ОГРАНИЧЕННЫЙ (bounded) DOM-хвост — сообщения НОВЕЕ
 * последнего сообщения базы — обязан учитываться в метриках. Полнота базы удостоверяет
 * историю на момент загрузки, а не текущее состояние разговора. Инварианты O-32 при этом
 * сохраняются: неполный (unbounded) DOM базу не подменяет, пустой DOM не добавляет ничего.
 *
 * ПРАВИЛО 3 (Behavior-Only Tests): тест НЕ читает исходники продукта. Модуль берётся через
 * своё публичное API (`window.AiCmHybridTail`, его ставит сам core/hybrid-tail.js), а
 * свободные переменные контент-скриптов (база/адаптер/логгер) кладутся в глобальный скоуп —
 * ровно так они и видны модулю в браузере. Вход теста — DOM-фикстура и снимок базы, выход —
 * текст/счётчик метрик и пересчёт ISOLATED.
 */

'use strict';

const loadEsmHelper = require('./helpers/load-esm.js');
const Tokenizer = loadEsmHelper.loadEsm('utils/tokenizer.js');
const GEMINI_LIMIT = 128000; // ModelConfig.getEffectiveLimit('gemini-search-default')

// Публичное API модуля (window.AiCmHybridTail): сборка ставит его сама.
const Hybrid = loadEsmHelper.loadEsmGlobal('core/hybrid-tail.js', 'AiCmHybridTail');

// Свободные переменные общего лексического скоупа контент-скриптов, которыми живёт модуль.
const SCOPE_KEYS = [
  'baseSeen', 'baseText', 'baseCount', 'baseComplete', 'baseIdSet', 'baseSkelSet',
  'baseAnchors', 'lastBounded', 'lastTailSig', 'lastHybridTailSig', 'currentAdapter',
  'aiCmMetricBaseText', 'debugLog'
];

function readScope(key) { return global[key]; }

// ---- DOM-фикстура: лента Gemini (сообщения базы + новые после обмена) ----------------
const BASE_MSGS = [
  { id: 'u1', kind: 'user-query', text: 'Первый вопрос' },
  { id: 'a1', kind: 'model-response', text: 'Первый ответ' },
  { id: 'u2', kind: 'user-query', text: 'Второй вопрос' },
  { id: 'a2', kind: 'model-response', text: 'Второй ответ' }
];
const LONG_ANSWER = 'Свежий ответ, который ещё не в базе. ' +
  ('Ответ модели продолжается: разбор вариантов, ограничения подхода и примеры кода, ' +
    'которые проверяют гипотезу и показывают, как метрика должна отреагировать на новый ход. ').repeat(4);

const NEW_MSGS = [
  { id: 'u3', kind: 'user-query', text: 'Третий вопрос после обмена' },
  { id: 'a3', kind: 'model-response', text: LONG_ANSWER.trim() }
];

const BASE_TEXT = BASE_MSGS.map((m) => m.text).join('\n');
const BASE_COUNT = BASE_MSGS.length;

function renderFeed(msgs) {
  document.body.innerHTML = '<div class="conversation-container"></div>';
  const feed = document.querySelector('.conversation-container');
  msgs.forEach(function (m) {
    const el = document.createElement('div');
    el.className = m.kind;
    el.setAttribute('data-message-id', m.id);
    el.textContent = m.text;
    feed.appendChild(el);
  });
}

function installScope(over) {
  const scope = {
    baseSeen: true,
    baseText: BASE_TEXT,
    baseCount: BASE_COUNT,
    baseComplete: true,
    // База узнаётся по id сообщений — как data-message-id в живом DOM Gemini.
    baseIdSet: new Set(BASE_MSGS.map((m) => m.id)),
    baseSkelSet: new Set(),
    baseAnchors: [],
    lastBounded: null,
    lastTailSig: null,
    lastHybridTailSig: null,
    currentAdapter: { siteName: 'gemini' },
    aiCmMetricBaseText: undefined,
    debugLog: function () { }
  };
  Object.assign(scope, over || {});
  SCOPE_KEYS.forEach(function (k) { global[k] = scope[k]; });
  return scope;
}

// Пересчёт ISOLATED по контракту content.js:434-453 + processAndSend (2534-2768):
// запрос DOM-emit принимается, только пока база «полная» ИЛИ найдена её граница;
// значение бейджа — эвристика по effective-тексту.
function isolatedRecount(scope, state) {
  const probe = Hybrid.getEffectiveText(); // обновляет lastBounded
  const sig = aiCmDomRealTextLen() + '|' + (probe ? probe.length : 0);
  if (sig === state.lastDomEmitSig) return { skipped: true, tokens: state.tokens };
  state.lastDomEmitSig = sig;
  const effective = Hybrid.getEffectiveText();
  const countForTokens = Hybrid.getEffectiveCount(scope.baseCount);
  const tokens = Tokenizer.estimateDialogTokens(effective, countForTokens);
  state.tokens = tokens;
  return {
    skipped: false,
    effective: effective,
    count: countForTokens,
    tokens: tokens,
    pct: Math.round((tokens / GEMINI_LIMIT) * 1000) / 10
  };
}

function aiCmDomRealTextLen() {
  const nodes = document.querySelectorAll('.user-query, .model-response');
  let sum = 0;
  for (let i = 0; i < nodes.length; i++) sum += (nodes[i].innerText || nodes[i].textContent || '').length;
  return sum;
}

beforeEach(function () {
  document.body.innerHTML = '';
  SCOPE_KEYS.forEach(function (k) { delete global[k]; });
});

afterEach(function () {
  SCOPE_KEYS.forEach(function (k) { delete global[k]; });
});

describe('Регрессия «бейдж Gemini замирает после обмена» (полная база + живой ход)', () => {
  test('полная база НЕ скрывает bounded-хвост: effective-текст включает новый ход', () => {
    renderFeed(BASE_MSGS.concat(NEW_MSGS));
    installScope({});

    // Живой дефект: бейдж держал ровно базу (baseComplete → return baseText),
    // поэтому ответ модели не попадал в метрики до перезагрузки.
    expect(Hybrid.getEffectiveText()).toBe(BASE_TEXT + '\n' + NEW_MSGS[0].text + '\n' + NEW_MSGS[1].text);
    expect(Hybrid.getEffectiveCount(BASE_COUNT)).toBe(BASE_COUNT + NEW_MSGS.length);
  });

  test('полная база: новые ходы учитываются и по отдельности (только ответ модели)', () => {
    renderFeed(BASE_MSGS.concat([NEW_MSGS[1]]));
    installScope({});

    expect(Hybrid.getEffectiveText()).toBe(BASE_TEXT + '\n' + NEW_MSGS[1].text);
    expect(Hybrid.getEffectiveCount(BASE_COUNT)).toBe(BASE_COUNT + 1);
  });

  test('песочница MAIN→ISOLATED: после ответа tokens/pct растут БЕЗ F5 (живой обмен)', () => {
    renderFeed(BASE_MSGS);
    const scope = installScope({});
    const state = { lastDomEmitSig: null, tokens: 0 };

    const before = isolatedRecount(scope, state);
    expect(before.skipped).toBe(false);

    // MAIN-мир: ответ модели отрендерился в ленту (обмен репликами) — ровно тот момент,
    // когда startRefreshObserver шлёт ai-cm-dom-emit-request.
    renderFeed(BASE_MSGS.concat(NEW_MSGS));
    const after = isolatedRecount(scope, state);

    expect(after.skipped).toBe(false);
    expect(after.tokens).toBeGreaterThan(before.tokens);
    expect(after.pct).toBeGreaterThan(before.pct);
  });

  test('O-32 сохранён: неполный (unbounded) DOM при полной базе базу не подменяет', () => {
    // Сервис вытеснил старые узлы: границы базы в DOM нет (bounded=false) —
    // видимый кусок НЕ становится текстом метрик.
    renderFeed(NEW_MSGS);
    installScope({});

    expect(Hybrid.getEffectiveText()).toBe(BASE_TEXT);
    expect(Hybrid.getEffectiveCount(BASE_COUNT)).toBe(BASE_COUNT);
    expect(readScope('lastBounded')).toBe(true); // источник = сеть, стабилен
  });

  test('пустой DOM при полной базе: ровно база (прежнее поведение не тронуто)', () => {
    document.body.innerHTML = '';
    installScope({});

    expect(Hybrid.getEffectiveText()).toBe(BASE_TEXT);
    expect(Hybrid.getEffectiveCount(BASE_COUNT)).toBe(BASE_COUNT);
    expect(readScope('lastBounded')).toBe(true);
  });

  test('неполная база (baseComplete=false) + bounded-хвост: база + хвост (как и было)', () => {
    renderFeed(BASE_MSGS.concat(NEW_MSGS));
    installScope({ baseComplete: false });

    expect(Hybrid.getEffectiveText()).toBe(BASE_TEXT + '\n' + NEW_MSGS[0].text + '\n' + NEW_MSGS[1].text);
    expect(Hybrid.getEffectiveCount(BASE_COUNT)).toBe(BASE_COUNT + NEW_MSGS.length);
    expect(readScope('lastBounded')).toBe(true);
  });
});
