/**
 * BUG-C — шов «база ↔ DOM-хвост»: ход, уже лежащий в базе, не попадает в tail.
 *
 * ЖИВОЙ ДЕФЕКТ. Ход базы и его узел в ленте приходят в РАЗНОЙ форме:
 *   • к тексту базы при эмиссии дописываются секции вложений ('\n\n[IMAGE: …]',
 *     '\n\n[FILE: …]') — core/gemini-ingest.js:908-920;
 *   • лента рендерит то же вложение карточкой: строка-превью ('image_x.png Ещё 2/1')
 *     и/или строка файла ('report.pdf 1.2 MB'), которых в базе нет.
 * Скелет хода (normalize + stripMd) у базы и у узла расходился → nodeIsBase не узнавал
 * узел базы → он попадал в tail → getEffectiveText()/getEffectiveMessages() считали
 * этот ход ВТОРОЙ раз (индикатор и тело снимка расходятся с реальной историей).
 *
 * ФИКС (три части, ровно они и пинуются):
 *   A. двусторонний скелет aiCmTailSkel = normalize(stripMd(stripChrome(stripAttach(x)))):
 *      вложения снимаются с базы, UI-хром — с DOM, сравнение идёт в одной форме;
 *   D. после сборки tail совпавший ПРЕФИКС отбрасывается: пока первый элемент хвоста
 *      по скелету равен одному из последних K сообщений базы (K ≤ длины хвоста,
 *      скелеты короче ANCHOR_MIN не участвуют) — это дубль, а не новый ход;
 *   E. UI-хром снимается с каждого узла хвоста до склейки — он не протекает ни в
 *      метрики, ни в тело снимка.
 *
 * ПРАВИЛО 3 (Behavior-Only Tests): тесты НЕ читают исходники продукта. Модуль берётся
 * через своё публичное API (window.AiCmHybridTail), utils/canonical-body.ts — через
 * статический модуль, свободные переменные контент-скриптов кладутся в глобальный
 * скоуп — ровно так они видны модулю в браузере (харнес inv-s1-2-snapshot-body).
 */

'use strict';

const loadEsmHelper = require('./helpers/load-esm.js');
const Canonical = loadEsmHelper.loadEsmModule('utils/canonical-body.ts');
const Hybrid = loadEsmHelper.loadEsmGlobal('core/hybrid-tail.ts', 'AiCmHybridTail');

// Свободные переменные общего лексического скоупа контент-скриптов.
const SCOPE_KEYS = [
  'baseSeen', 'baseText', 'baseCount', 'baseComplete', 'baseIdSet', 'baseSkelSet',
  'baseAnchors', 'lastBounded', 'lastTailSig', 'lastHybridTailSig', 'currentAdapter',
  'aiCmMetricBaseText', 'debugLog', 'aiCmBasePrepared', 'ANCHOR_MIN'
];

// ---- фикстура базы в её ЭМИТИРОВАННОЙ форме (с секциями вложений) --------------------
const U1 = 'Покажи, как устроен этот отчёт и что в нём главное';
const A1 = 'Отчёт разбит на три части: вводная, расчёты и выводы по контексту окна.';
const U2 = 'Спасибо, теперь приложи картинку и файл с расчётами';
const BODY_A2 = 'Готово: картинка приложена, файл с расчётами добавлен к ответу модели.';

const CARD_LINE = 'report.pdf 1.2 MB';   // строка карточки файла в ленте: не chrome-шаблон
const CHROME_LINE = 'image_x.png Ещё 2/1'; // строка-превью картинки: UI-хром ленты
const SEC_IMAGE = '\n\n[IMAGE: image_x.png] https://example.test/image_x.png';
const SEC_FILE = '\n\n[FILE: report.pdf (1.2 МБ)]';
const SEC_TASK = '\n\n[FILE: task.pdf (240 КБ)]';

const A2_BASE = BODY_A2 + '\n' + CARD_LINE + SEC_IMAGE + SEC_FILE;
const A2_DOM = BODY_A2 + '\n' + CARD_LINE + '\n' + CHROME_LINE;

const BASE_PREPARED = [
  { id: 'u1', role: 'user', text: U1 },
  { id: 'a1', role: 'assistant', text: A1 },
  { id: 'u2', role: 'user', text: U2 + SEC_TASK },
  { id: 'a2', role: 'assistant', text: A2_BASE }
];
const BASE_TEXT = Canonical.canonicalBodyText(BASE_PREPARED);
const BASE_COUNT = BASE_PREPARED.length;

// ---- та же лента, как её отрендерил сервис (без секций, с UI-хромом) -----------------
const DOM_BASE = [
  { id: 'u1', kind: 'user-query', text: U1 },
  { id: 'a1', kind: 'model-response', text: A1 },
  { id: 'u2', kind: 'user-query', text: U2 },
  { id: 'a2', kind: 'model-response', text: A2_DOM }
];

// ---- настоящие новые ходы после полной базы ------------------------------------------
const NEW_U3 = 'А теперь сделай короткое резюме отчёта для коллег из другой команды';
const NEW_A3 = 'Резюме: три части отчёта, ключевые расчёты и вывод по контексту окна модели.';
const NEW_MSGS = [
  { id: 'u3', kind: 'user-query', text: NEW_U3 },
  { id: 'a3', kind: 'model-response', text: NEW_A3 }
];
const NEW_TEXT = NEW_U3 + '\n' + NEW_A3;

// ---- хелперы харнеса ----------------------------------------------------------------
function renderFeed(msgs) {
  document.body.innerHTML = '<div class="conversation-container"></div>';
  const feed = document.querySelector('.conversation-container');
  msgs.forEach(function (m) {
    const el = document.createElement('div');
    el.className = m.kind;
    if (m.id) el.setAttribute('data-message-id', m.id);
    el.textContent = m.text || '';
    feed.appendChild(el);
  });
}

function skels(msgs) {
  return new Set(msgs.map(function (m) { return Hybrid.aiCmTailSkel(m.text); }));
}

function installScope(over) {
  const scope = {
    baseSeen: true,
    baseText: BASE_TEXT,
    baseCount: BASE_COUNT,
    baseComplete: true,
    // Как в content.js (после BUG-C): кэш скелетов базы строится тем же aiCmTailSkel.
    baseIdSet: new Set(DOM_BASE.map(function (m) { return m.id; })),
    baseSkelSet: skels(BASE_PREPARED),
    baseAnchors: [],
    lastBounded: null,
    lastTailSig: null,
    lastHybridTailSig: null,
    currentAdapter: null, // не Gemini: текст берётся из innerText узла
    aiCmMetricBaseText: undefined, // в песочнице — фолбэк на baseText (как aiCmTailMetricBase)
    debugLog: function () { },
    aiCmBasePrepared: BASE_PREPARED,
    ANCHOR_MIN: 40 // product-значение (core/state.ts); при отсутствии хелпер берёт 40 сам
  };
  Object.assign(scope, over || {});
  SCOPE_KEYS.forEach(function (k) { global[k] = scope[k]; });
  return scope;
}

function textsOf(list) {
  return list.map(function (m) { return m.text; });
}

/** Уникальные вхождения подстроки: дубль хода базы виден как 2. */
function occurrences(haystack, needle) {
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) { n++; at = haystack.indexOf(needle, at + needle.length); }
  return n;
}

beforeEach(function () {
  document.body.innerHTML = '';
  SCOPE_KEYS.forEach(function (k) { delete global[k]; });
});

afterEach(function () {
  SCOPE_KEYS.forEach(function (k) { delete global[k]; });
});

describe('BUG-C (A): скелет базы и DOM совпадает в одной форме', () => {
  test('(b) aiCmTailSkel(база) === aiCmTailSkel(DOM) — user (файл) и assistant (картинка+файл)', function () {
    const domUser = DOM_BASE[2];
    const domAssistant = DOM_BASE[3];

    // user: в базе дописана секция файла, в DOM — чистый текст хода.
    expect(Hybrid.aiCmTailSkel(BASE_PREPARED[2].text)).toBe(Hybrid.aiCmTailSkel(domUser.text));
    // assistant: в базе секции IMAGE/FILE, в DOM — строка карточки файла + chrome-превью.
    expect(Hybrid.aiCmTailSkel(BASE_PREPARED[3].text)).toBe(Hybrid.aiCmTailSkel(domAssistant.text));
    // контроль: без нормализации текст РАЗНЫЙ, т.е. пинуется именно скелет, а не равенство текстов.
    expect(BASE_PREPARED[3].text).not.toBe(domAssistant.text);
  });

  test('(a) база с вложениями, DOM без секций и с chrome-строкой → хвост пуст', function () {
    renderFeed(DOM_BASE);
    const scope = installScope({});

    const tail = Hybrid.computeTailFromDom();
    expect(tail.count).toBe(0);
    expect(tail.messages.length).toBe(0);
    expect(tail.bounded).toBe(true);
    // Метрики и тело снимка — ровно база, без второго счёта последнего хода.
    expect(Hybrid.getEffectiveText()).toBe(BASE_TEXT);
    expect(Hybrid.getEffectiveCount(BASE_COUNT)).toBe(BASE_COUNT);
    const messages = Hybrid.getEffectiveMessages();
    expect(messages).toBe(scope.aiCmBasePrepared);
    expect(messages.length).toBe(BASE_COUNT);
    expect(Canonical.canonicalBodyText(messages)).toBe(Hybrid.getEffectiveText());
  });
});

describe('BUG-C (D): совпавший префикс хвоста отбрасывается', () => {
  test('(c) настоящий новый ход после полной базы учтён', function () {
    renderFeed(DOM_BASE.concat(NEW_MSGS));
    const scope = installScope({});

    const messages = Hybrid.getEffectiveMessages();
    expect(messages.length).toBe(BASE_COUNT + NEW_MSGS.length);
    expect(textsOf(messages).slice(BASE_COUNT)).toEqual([NEW_U3, NEW_A3]);
    expect(Hybrid.getEffectiveText()).toBe(BASE_TEXT + '\n' + NEW_TEXT);
    expect(Hybrid.getEffectiveCount(BASE_COUNT)).toBe(BASE_COUNT + NEW_MSGS.length);
    expect(scope.aiCmBasePrepared).toBe(BASE_PREPARED);
  });

  test('(d) D-only: нераспознанная строка карточки в DOM-ходе базы — дубля нет, новый ход на месте', function () {
    // Скелетный кэш отстал: последнего хода базы в нём ещё нет, id в DOM перевыпущены.
    // Поэтому граница базы находится на предпоследнем ходе, а последний ход базы
    // оказывается в хвосте. Спасает только D: строка 'report.pdf 1.2 MB' есть и в базе,
    // и в DOM (её не снимают ни A, ни E), поэтому скелеты совпадают.
    renderFeed([
      DOM_BASE[0], DOM_BASE[1], DOM_BASE[2],
      { id: 'a2', kind: 'model-response', text: A2_DOM },
      { id: 'u3', kind: 'user-query', text: NEW_U3 }
    ]);
    installScope({
      baseIdSet: new Set(['old-1', 'old-2', 'old-3', 'old-4']),
      baseSkelSet: skels(BASE_PREPARED.slice(0, 3)),
      baseAnchors: []
    });

    const tail = Hybrid.computeTailFromDom();
    expect(tail.bounded).toBe(true);
    expect(tail.count).toBe(1);
    expect(tail.messages.map(function (m) { return m.text; })).toEqual([NEW_U3]);

    const messages = Hybrid.getEffectiveMessages();
    expect(messages.length).toBe(BASE_COUNT + 1);
    // Ход базы ровно один раз, а не «база + его же DOM-копия».
    expect(occurrences(Hybrid.getEffectiveText(), A2_DOM)).toBe(0);
    expect(occurrences(Hybrid.getEffectiveText(), BODY_A2)).toBe(1);
    expect(textsOf(messages).slice(BASE_COUNT)).toEqual([NEW_U3]);
    expect(Canonical.canonicalBodyText(messages)).toBe(Hybrid.getEffectiveText());
  });

  test('(e) негатив: несвязанный новый ход ≥ ANCHOR_MIN не отбрасывается', function () {
    const longTurn = 'Совершенно другой вопрос про планирование релиза и порядок задач в очереди';
    expect(Hybrid.aiCmTailSkel(longTurn).length).toBeGreaterThanOrEqual(40);
    renderFeed(DOM_BASE.concat([
      { id: 'u7', kind: 'user-query', text: longTurn }
    ]));
    installScope({});

    const tail = Hybrid.computeTailFromDom();
    expect(tail.count).toBe(1);
    expect(tail.messages[0].text).toBe(longTurn);
    expect(Hybrid.getEffectiveText()).toBe(BASE_TEXT + '\n' + longTurn);
    expect(Hybrid.getEffectiveCount(BASE_COUNT)).toBe(BASE_COUNT + 1);
  });
});

describe('BUG-C (E): UI-хром ленты не протекает в хвост', () => {
  test('(f) chrome-строка снята: messages/text без «Ещё», тело снимка = effective-текст', function () {
    const tailTurn = 'Смотри, что получилось на скриншоте';
    renderFeed(DOM_BASE.concat([
      { id: 'a4', kind: 'model-response', text: tailTurn + '\n' + 'image_x.png Ещё 1/1' }
    ]));
    installScope({});

    const tail = Hybrid.computeTailFromDom();
    expect(tail.count).toBe(1);
    expect(tail.messages[0].text).toBe(tailTurn);
    expect(tail.text).toBe(tailTurn);

    const messages = Hybrid.getEffectiveMessages();
    expect(messages.length).toBe(BASE_COUNT + 1);
    expect(messages[messages.length - 1].text).toBe(tailTurn);
    expect(Hybrid.getEffectiveText()).not.toContain('Ещё');
    expect(Hybrid.getEffectiveText()).toBe(BASE_TEXT + '\n' + tailTurn);
    expect(tail.text.split('\n').filter(function (l) { return /^\s*image_/.test(l); })).toEqual([]);
    expect(Canonical.canonicalBodyText(messages)).toBe(Hybrid.getEffectiveText());
  });
});
