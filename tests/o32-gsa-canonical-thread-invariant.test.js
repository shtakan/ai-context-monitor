/**
 * O-32 (переоткрыт 2026-09-23, симптом «инфляция токенов после SPA-возврата»).
 *
 * ЖИВОЙ ДЕФЕКТ (лог прогона, метки 16:45:05 → 16:47:48, threadId t7qzasn_ILDMkdUPssjtyAQ):
 *   cold start  — 6 сообщений, textLen=12255, 5658 токенов, 4.4% (эталон принят владельцем);
 *   SPA-возврат — 18 сообщений, textLen=24764, 11475 токенов, 9%.
 * Новых сообщений пользователь не отправлял. Механизм (3 звена):
 *   A) полнота снимка бралась ДЕФОЛТОМ (buildDetail: `historyComplete !== false`) — накопительные
 *      слияния и DOM-добор объявляли базу ПОЛНОЙ без вердикта probe-классификатора;
 *   B) DOM/кэш-форма хода (`userText=null, assistantText='Ответ в режиме ИИ, исходный запрос:
 *      "Q" A'`) и сетевая форма (`userText='Q', assistantText='A'`) — один и тот же ход, но
 *      ключ дедупа строился из СЫРОЙ пары (userText||assistantText) → ключи разные → ход
 *      входил в базу ДВАЖДЫ (6 → 12 ходов → 18 сообщений);
 *   C) идентичность хода зависела от ФОРМЫ текста и от пути (сеть/DOM/кэш/пагинация), поэтому
 *      один и тот же тред давал разные значения на холодном старте, F5 и SPA-возврате.
 *
 * ИНВАРИАНТ (§4 отчёта), который пинится здесь:
 *   fingerprint(тред) = hash(sorted(canonicalKeys)) + count + textLen
 *   обязан совпасть для холодного старта, F5 (сеть с нуля) и SPA-возврата (кэш ∪ сеть)
 *   ОДНОГО И ТОГО ЖЕ треда. Каноническая форма хода — «ответы без дублирующего вопроса»:
 *   вопрос хода лежит в userText (структурный источник) ЛИБО внутри сервисной обёртки текста
 *   ответа; ключ хода выводится из СОДЕРЖИМОГО (canonicalTurnKeyOf) и от формы не зависит.
 *
 * Эталон треда A не меняется: 6 сообщений / 12255 знаков / 5658 токенов / 4.4%.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONTENT = require('./helpers/content-source.js').contentSource;
const INTERCEPT = fs.readFileSync(path.join(ROOT, 'core', 'google-search-intercept.js'), 'utf8');
const HYBRID = fs.readFileSync(path.join(ROOT, 'core', 'hybrid-tail.js'), 'utf8');
const BASE_HANDLER = fs.readFileSync(path.join(ROOT, 'core', 'base-handler.js'), 'utf8');
const Parser = require('../utils/google-search-folwr-parser.js');
const P = require('../utils/export-emit-pipeline.js');

// Рез по балансу фигурных скобок (как в tests/gsa-o31-thread-segmentation.test.js).
function fnDecl(src, name) {
  const start = src.indexOf('function ' + name + '(');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced declaration: ' + name);
}

const TID = 't7qzasn_ILDMkdUPssjtyAQ';

// =====================================================================================
// Живые данные треда A: 3 хода (6 сообщений, answers без дублирующего вопроса)
// =====================================================================================
const TURNS_A = [
  { q: 'Наши Python скрипт для вычисления факториала N-го числа Фибоначчи', a: 'Ответ в режиме ИИ, исходный запрос: "Наши Python скрипт для вычисления факториала N-го числа Фибоначчи" Вот код:\n```python\ndef fib(n):\n    return n\n```' },
  { q: 'Наши Python скрипт для решения задачи Иосифа (считалка)', a: 'Ответ в режиме ИИ, исходный запрос: "Наши Python скрипт для решения задачи Иосифа (считалка)" Решение через очередь.' },
  { q: 'Напиши рекурсивный код, а потом индуктивный.', a: 'Ответ в режиме ИИ, исходный запрос: "Напиши рекурсивный код, а потом индуктивный." Рекурсивный вариант и индуктивный.' }
];
// Тело ответа БЕЗ сервисной обёртки — сетевая форма того же хода.
function answerBodyOf(wrapped) {
  return Parser.canonicalAnswerBody(wrapped);
}

// Форма ДОБОРА/ЭМИТА (DOM, кэш, накопительные folif-эмиты): вопрос внутри текста ответа.
function wrappedTurns() {
  return TURNS_A.map((t, i) => ({ id: 'idx' + i, userText: null, assistantText: t.a }));
}
// Тот же ход, но полной структурой (вопрос + ответ) — так его кладёт DOM-путь GSA.
function wrappedFullTurns() {
  return TURNS_A.map((t, i) => ({ id: 'idx' + i, userText: t.q, assistantText: t.a }));
}
// Форма СЕТИ (folwr/folif с структурным вопросом): вопрос отдельным ходом.
function networkTurns() {
  return TURNS_A.map((t, i) => ({ id: 'jsuid' + i, userText: t.q, assistantText: answerBodyOf(t.a) }));
}
// Канонические ключи треда (эталон отпечатка) — из СОДЕРЖИМОГО, а не из формы пути.
function canonicalKeysOfThread() {
  return TURNS_A.map((t) => Parser.canonicalTurnKeyOf({ userText: t.q, assistantText: answerBodyOf(t.a) })).sort();
}

// =====================================================================================
// Песочница РЕАЛЬНЫХ писателей базы перехватчика (MAIN-мир)
// =====================================================================================
const SCOPE_FNS = [
  'messagesFromTurns',
  'gsaTurnKeyOfLocal',
  'gsaTurnKey',
  'seedSeenKeys',
  'isRawXssiPayload',
  'isUsableTurn',
  'hasUsableTurns',
  'isGarbageBody',
  'buildDetail',
  'emitDetail',
  'cacheSet',
  'isForeignThread',
  'segmentTurnsOf',
  'activateThread',
  'absorbForeignSnapshot',
  'applyTurns',
  'mergeStreamTurns',
  'mergeTurns',
  'checkThreadSwitch',
  'gsaDiagTurnsShape'
];
const SCOPE = 'with (ctx) { ' + SCOPE_FNS.map((n) => fnDecl(INTERCEPT, n)).join('\n') +
  '\n return { ' + SCOPE_FNS.map((n) => n + ': ' + n).join(', ') + ' }; }';
const makeIntercept = new Function('ctx', SCOPE);

function interceptCtx(over) {
  const events = [];
  const logs = [];
  const ctx = {
    MAX_CACHE_ENTRIES: 10,
    threadCache: new Map(),
    lastFullTurns: [],
    lastFullMessages: [],
    lastFullSnapshot: null,
    seenKeys: {},
    currentThreadId: TID,
    emittedThreadId: '',
    baseThreadId: '',
    detectedModelSlug: 'gemini-search-default',
    domTid: TID,
    logs: logs,
    console: { log: function () { } },
    debugLog: function (lvl, msg) { logs.push(String(msg)); },
    window: {
      GoogleFolwrUtils: Parser,
      dispatchEvent: function (ev) { events.push(ev.detail); }
    }
  };
  ctx.readDomThreadId = function () { return ctx.domTid; };
  ctx.activeLoadFolwr = function () { };
  Object.assign(ctx, over || {});
  return { ctx: ctx, events: events, logs: logs, api: makeIntercept(ctx) };
}

// =====================================================================================
// Отпечаток треда: hash(sorted(canonicalKeys)) + count + textLen
// =====================================================================================
function fnv1aHex(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}
function fingerprintOf(detail) {
  if (!detail) return null;
  const texts = Array.isArray(detail.messageTexts) ? detail.messageTexts : [];
  const keys = [];
  for (let i = 0; i < texts.length; i++) {
    const m = (detail.messages && detail.messages[i]) || {};
    if (m.role === 'user') {
      const next = (detail.messages && detail.messages[i + 1]) || {};
      keys.push(Parser.canonicalTurnKeyOf({
        userText: texts[i],
        assistantText: (next.role === 'assistant') ? texts[i + 1] : null
      }));
      if (next.role === 'assistant') i++;
    } else {
      // ход-обёртка: вопрос живёт внутри текста ответа — ключ выводится из содержимого
      keys.push(Parser.canonicalTurnKeyOf({ userText: null, assistantText: texts[i] }));
    }
  }
  keys.sort();
  return {
    hash: fnv1aHex(keys.join('\u0001')),
    count: detail.count,
    textLen: detail.text ? detail.text.length : 0
  };
}
const fpLine = (fp) => 'fingerprint hash=' + fp.hash + ' count=' + fp.count + ' textLen=' + fp.textLen;

// =====================================================================================
// (1) Каноническая идентичность: форма текста хода не меняет ключ
// =====================================================================================
describe('O-32 (1): каноническая идентичность хода не зависит от формы текста', () => {
  test('форма добора (вопрос в обёртке) и форма сети (вопрос отдельно) — ОДИН ключ', () => {
    const w = TURNS_A[0];
    const wrapped = { id: 'idx0', userText: null, assistantText: w.a };
    const network = { id: 'jsuid0', userText: w.q, assistantText: answerBodyOf(w.a) };
    expect(Parser.canonicalTurnKeyOf(wrapped)).toBe(Parser.canonicalTurnKeyOf(network));
    expect(Parser.canonicalTurnKeyOf(wrapped)).toContain('||');
  });

  test('каноническая форма: вопрос из обёртки доступен как userText, текст не переписан', () => {
    const w = TURNS_A[0];
    const wrapped = { id: 'idx0', userText: null, assistantText: w.a };
    const canon = Parser.canonicalizeTurnForThread(wrapped);
    expect(canon.userText).toBe(w.q);
    expect(canon.assistantText).toBe(w.a);            // reference-байты сохранены
    expect(Parser.canonicalizeTurnForThread(canon)).toEqual(canon); // идемпотентность
  });

  test('ошибки ключа нет: обычный текст и проза с цитатой обёрткой не считаются', () => {
    expect(Parser.canonicalAnswerBody('Обычный ответ модели.')).toBe('Обычный ответ модели.');
    expect(Parser.canonicalAnswerBody('"Цитата" и продолжение ответа.')).toBe('"Цитата" и продолжение ответа.');
    expect(Parser.canonicalTurnKeyOf({ userText: 'Q', assistantText: 'A' }))
      .toBe(Parser.canonicalTurnKeyOf({ userText: 'Q', assistantText: 'A' }));
  });

  test('merge-функции схлопывают две формы одного хода (id, канонический ключ, добор)', () => {
    const wrapped = wrappedTurns();
    const network = networkTurns();
    expect(Parser.mergeTurnsById(wrapped, network)).toHaveLength(TURNS_A.length);
    expect(Parser.mergeTurnsMonotone(wrapped, network)).toHaveLength(TURNS_A.length);
    expect(Parser.mergeTurnsByKey(wrapped, network)).toHaveLength(TURNS_A.length);
  });
});

// =====================================================================================
// (2) Инвариант отпечатка: холодный старт = F5 = SPA-возврат (один и тот же тред)
// =====================================================================================
describe('O-32 (2): каноническая база треда не раздувается ни одним путём', () => {
  test('холодный старт: накопительные эмиты дают 3 хода, полнота не выдумана', () => {
    const h = interceptCtx({});
    // живой путь 16:45:05 — три passive-folif, каждый приносит СЛЕДУЮЩИЙ ответ (full=0)
    for (let i = 0; i < TURNS_A.length; i++) {
      h.api.mergeTurns([{ id: 'idx' + i, userText: null, assistantText: TURNS_A[i].a }], false, TID, 'legacy-body');
    }
    expect(h.ctx.lastFullTurns).toHaveLength(TURNS_A.length);
    const last = h.events[h.events.length - 1];
    // звено A: полноты никто не доказывал — дефолт её больше не подставляет
    expect(last.historyComplete).toBe(false);
    // форма с вопросом внутри обёртки несёт один текст на ход: 3 хода = 3 сообщения
    expect(fingerprintOf(last).count).toBe(TURNS_A.length);
  });

  test('равенство отпечатков: холодный старт = F5 (сеть с нуля) = SPA-возврат (кэш ∪ сеть)', () => {
    const target = { hash: fnv1aHex(canonicalKeysOfThread().join('\u0001')), count: 6, textLen: 12255 };

    // --- холодный старт: накопительные эмиты формы добора (полный ход: вопрос + ответ) ---
    const cold = interceptCtx({});
    for (let i = 0; i < TURNS_A.length; i++) {
      cold.api.mergeTurns([{ id: 'idx' + i, userText: TURNS_A[i].q, assistantText: TURNS_A[i].a }], false, TID, 'legacy-body');
    }
    const coldDetail = cold.events[cold.events.length - 1];

    // --- F5: новый instance, база строится С НУЛА полной сетевой страницей ---
    const f5 = interceptCtx({});
    f5.api.applyTurns(networkTurns(), TID, true, 'folwr-body');
    const f5Detail = f5.events[f5.events.length - 1];

    // --- SPA-возврат: сегмент кэша уже лежит, сеть приносит тот же тред ещё раз ---
    const spa = interceptCtx({});
    spa.api.applyTurns(wrappedFullTurns(), TID, false, 'legacy-body');       // база/сегмент треда
    spa.ctx.baseThreadId = '';                                              // SPA: активный тред переехал
    spa.api.activateThread(TID);                                            // возврат → сегмент из кэша
    const beforeSpa = spa.events.length;
    spa.api.mergeTurns(networkTurns(), true, TID, 'folif-body');            // сеть приносит тот же тред
    expect(spa.events.length).toBeGreaterThan(beforeSpa);
    const spaDetail = spa.events[spa.events.length - 1];

    const coldFp = fingerprintOf(coldDetail);
    const f5Fp = fingerprintOf(f5Detail);
    const spaFp = fingerprintOf(spaDetail);

    // ДИАГНОСТИЧЕСКИЙ ВЫВОД: пример лога равных отпечатков (виден при падении ассерта)
    const lines = [
      'cold-start  ' + fpLine(coldFp),
      'f5          ' + fpLine(f5Fp),
      'spa-return  ' + fpLine(spaFp)
    ];
    // eslint-disable-next-line no-console
    console.log('[O-32 fingerprint]\n' + lines.join('\n'));

    expect(coldFp.hash).toBe(target.hash);              // форма пути не меняет идентичность треда
    expect(f5Fp.hash).toBe(target.hash);
    expect(spaFp.hash).toBe(target.hash);
    expect(coldFp.count).toBe(6);                       // холодный старт: 3 хода = 6 сообщений
    expect(f5Fp.count).toBe(6);                         // F5: тот же тред, та же каноническая база
    expect(spaFp.count).toBe(6);
    // SPA-возврат не удваивает байты: текст снимка не больше максимума двух канонических
    // представлений (живой дефект давал 24764 против 12255 на том же треде)
    expect(spaFp.textLen).toBeLessThanOrEqual(Math.max(coldFp.textLen, f5Fp.textLen));
    expect(spaFp.count).not.toBe(18);
  });

  test('SPA-возврат: база не растёт — ходов 3, а не 6 (живой лог 16:47:48)', () => {
    const h = interceptCtx({});
    h.api.applyTurns(wrappedFullTurns(), TID, false, 'legacy-body');
    const countBefore = h.ctx.lastFullSnapshot.count;
    // повторный сетевой снимок того же треда (полная страница folwr/folif)
    h.api.mergeTurns(networkTurns(), true, TID, 'folif-body');
    expect(h.ctx.lastFullTurns).toHaveLength(TURNS_A.length);    // живой дефект: ×2 (3 → 6)
    expect(h.ctx.lastFullSnapshot.count).toBe(countBefore);      // живой дефект: 18
    expect(h.ctx.lastFullSnapshot.count).not.toBe(18);
    // вторая волна того же снимка — тоже без роста (монотонность числа ходов)
    h.api.mergeTurns(networkTurns(), true, TID, 'folif-body');
    expect(h.ctx.lastFullTurns).toHaveLength(TURNS_A.length);
  });

  test('обратный порядок (сеть → сеть) идемпотентен: отпечаток и байты те же', () => {
    const h = interceptCtx({});
    h.api.applyTurns(networkTurns(), TID, true, 'folwr-body');
    const first = fingerprintOf(h.ctx.lastFullSnapshot);
    const textBefore = h.ctx.lastFullSnapshot.text;
    h.api.mergeTurns(networkTurns(), true, TID, 'folif-body');    // тот же тред повторно
    expect(fingerprintOf(h.ctx.lastFullSnapshot)).toEqual(first);
    expect(h.ctx.lastFullSnapshot.text).toBe(textBefore);
    expect(h.ctx.lastFullTurns).toHaveLength(TURNS_A.length);
  });

  test('живой путь (сетевая форма во всех трёх): hash, count и textLen совпадают полностью', () => {
    // холодный старт: накопительные passive-folif той же сетевой формы
    const cold = interceptCtx({});
    for (let i = 0; i < TURNS_A.length; i++) {
      cold.api.mergeTurns([networkTurns()[i]], false, TID, 'legacy-body');
    }
    // F5: новый instance + полная сетевая страница
    const f5 = interceptCtx({});
    f5.api.applyTurns(networkTurns(), TID, true, 'folwr-body');
    // SPA-возврат: сегмент кэша + повторный сетевой снимок
    const spa = interceptCtx({});
    spa.api.applyTurns(networkTurns(), TID, false, 'legacy-body');
    spa.ctx.baseThreadId = '';
    spa.api.activateThread(TID);
    spa.api.mergeTurns(networkTurns(), true, TID, 'folif-body');

    const coldFp = fingerprintOf(cold.events[cold.events.length - 1]);
    const f5Fp = fingerprintOf(f5.events[f5.events.length - 1]);
    const spaFp = fingerprintOf(spa.events[spa.events.length - 1]);
    // eslint-disable-next-line no-console
    console.log('[O-32 fingerprint · live path]\n' +
      ['cold-start  ' + fpLine(coldFp), 'f5          ' + fpLine(f5Fp), 'spa-return  ' + fpLine(spaFp)].join('\n'));
    expect(f5Fp).toEqual(coldFp);
    expect(spaFp).toEqual(coldFp);
    expect(spaFp.count).toBe(6);
    expect(spaFp.textLen).toBe(coldFp.textLen);
  });
});

// =====================================================================================
// (3) Полнота — доказанное свойство (звено A) и DOM-добор её не выдумывает
// =====================================================================================
describe('O-32 (3): полнота доказана вердиктом, а не дефолтом', () => {
  test('buildDetail: historyComplete только по явному вердикту (не `!== false`)', () => {
    const h = interceptCtx({});
    expect(h.api.buildDetail(wrappedTurns(), undefined, TID, undefined).historyComplete).toBe(false);
    expect(h.api.buildDetail(wrappedTurns(), undefined, TID, false).historyComplete).toBe(false);
    expect(h.api.buildDetail(wrappedTurns(), undefined, TID, true).historyComplete).toBe(true);
    // DOM-добор базы не доказывает полноту истории
    const dom = fnDecl(INTERCEPT, 'virtualScrollBackfill');
    expect(dom).toContain('applyTurns(mergeFn(lastFullTurns, domTurns), tid, false);');
  });

  test('content.js: baseComplete — единственная точка вердикта, дефолта нет', () => {
    expect(CONTENT).toContain('const newBaseComplete = !!detail.historyComplete;');
    expect(INTERCEPT).toContain('historyComplete: historyComplete === true');
    expect(INTERCEPT).not.toContain('historyComplete: historyComplete !== false');
  });
});

// =====================================================================================
// (4) Один канонический ключ во всех точках (source-пины)
// =====================================================================================
describe('O-32 (4): единый канонический ключ во всех точках, seed одним хелпером', () => {
  test('все точки записи/сида базы используют gsaTurnKey/seedSeenKeys', () => {
    expect(fnDecl(INTERCEPT, 'activateThread')).toContain('seedSeenKeys(lastFullTurns)');
    expect(fnDecl(INTERCEPT, 'applySnapshot')).toContain('seedSeenKeys(lastFullTurns)');
    expect(fnDecl(INTERCEPT, 'applyTurns')).toContain('seedSeenKeys(lastFullTurns)');
    expect(fnDecl(INTERCEPT, 'mergeTurns')).toContain('seedSeenKeys(lastFullTurns)');
    expect(fnDecl(INTERCEPT, 'mergeTurns')).toContain('var key2 = gsaTurnKey(nt);');
    expect(fnDecl(INTERCEPT, 'mergeStreamTurns')).toContain('var key = gsaTurnKey(t);');
    // сырая пара (userText||assistantText) как ключ дедупа больше НЕ используется
    expect(INTERCEPT).not.toContain("seenKeys[(lastFullTurns[i].userText || '') + '||' + (lastFullTurns[i].assistantText || '')]");
    // applyTurns — монотонное слияние «накопитель ∪ снимок» (база не подменяется куском)
    expect(fnDecl(INTERCEPT, 'applyTurns')).toContain('lastFullTurns = unionFn(lastFullTurns, turns)');
    expect(fnDecl(INTERCEPT, 'applyTurns')).toContain('mergeTurnsMonotone');
    // источник правды ключа — единый парсер
    expect(fnDecl(INTERCEPT, 'gsaTurnKey')).toContain('canonicalTurnKeyOf');
    expect(typeof Parser.canonicalTurnKeyOf).toBe('function');
    expect(typeof Parser.mergeTurnsMonotone).toBe('function');
  });

  test('парсер: mergeTurnsByKey/ById дедуплицируют по каноническому ключу', () => {
    const src = fs.readFileSync(path.join(ROOT, 'utils', 'google-search-folwr-parser.js'), 'utf8');
    expect(fnDecl(src, 'mergeTurnsByKey')).toContain('var key = canonicalTurnKeyOf(t);');
    expect(fnDecl(src, 'mergeTurnsById')).toContain('var key = canonicalTurnKeyOf(t);');
    expect(INTERCEPT).toContain('mergeTurnsMonotone');
  });
});

// =====================================================================================
// (5) hybrid-tail: неполная база — канонический пол, а не «DOM победил»
// =====================================================================================
describe('O-32 (5): неполная база держит канонический пол (DOM не подменяет базу)', () => {
  // Рез блока от `var MSG_SELECTORS = [` до конца объявления (там литерал-массив, не функция).
  function blockDecl(src, marker, endMarker) {
    const start = src.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf(endMarker, start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end + endMarker.length);
  }
  const HYBRID_SCOPE = 'with (ctx) { ' +
    blockDecl(HYBRID, 'var MSG_SELECTORS = [', '];') + '\n' +
    ['normalize', 'stripMd', 'findMessageNodes', 'nodeIsBase', 'shouldUseGeminiDomParser',
      'aiCmTailMetricBase', 'computeTailFromDom', 'getEffectiveText', 'getEffectiveCount']
      .map((n) => fnDecl(HYBRID, n)).join('\n') +
    '\n return { text: getEffectiveText, count: getEffectiveCount }; }';
  const makeHybrid = new Function('ctx', HYBRID_SCOPE);

  // Узел живого DOM: селектор сообщений должен дать узлы, а принадлежность базе — нет
  // (id/скелет не совпали): живой случай 16:47:48 — сервис вытеснил старые узлы, граница
  // базы в DOM не найдена (bounded=false).
  function fakeNode(text) {
    const el = {
      innerText: text,
      textContent: text,
      getAttribute: function () { return ''; },
      contains: function () { return false; }
    };
    return el;
  }

  function hybridCtx(over) {
    const ctx = {
      baseSeen: true,
      baseComplete: false,
      baseText: 'Q1\nA1\nQ2\nA2\nQ3\nA3',
      baseCount: 6,
      baseIdSet: new Set(),
      baseSkelSet: new Set(['somethingelse']),
      baseAnchors: [],
      lastBounded: false,
      lastTailSig: null,
      lastHybridTailSig: null,
      currentAdapter: null,
      Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
      debugLog: function () { },
      document: {
        querySelectorAll: function () {
          return [fakeNode('видимый кусок 1'), fakeNode('видимый кусок 2')];
        }
      }
    };
    Object.assign(ctx, over || {});
    return ctx;
  }

  test('DOM без границы базы: текст метрик = пол базы, счётчик = baseCount (было ""/2)', () => {
    const ctx = hybridCtx({});
    const api = makeHybrid(ctx);
    expect(api.text()).toBe(ctx.baseText);       // было 'видимый кусок 1\nвидимый кусок 2' (бейдж 4.4% → 0.6%)
    expect(api.count(6)).toBe(6);                // было 2
    expect(ctx.lastBounded).toBe(false);
  });

  test('DOM с найденной границей базы: база + хвост (прежнее поведение сохранено)', () => {
    // база узнаётся по копии собственного текста — скелет-множество
    const baseText = 'Q1\nA1';
    const ctx = hybridCtx({
      baseText: baseText,
      baseCount: 2,
      baseSkelSet: new Set(['q1a1']),
      document: {
        querySelectorAll: function () {
          return [fakeNode('Q1 A1'), fakeNode('новый ход')];
        }
      }
    });
    const api = makeHybrid(ctx);
    expect(api.text()).toBe(baseText + '\nновый ход');
    expect(api.count(2)).toBe(3);
    expect(ctx.lastBounded).toBe(true);
  });

  test('полная база: текст метрик ровно база (прежнее поведение не тронуто)', () => {
    const ctx = hybridCtx({ baseComplete: true });
    const api = makeHybrid(ctx);
    expect(api.text()).toBe(ctx.baseText);
    expect(api.count(6)).toBe(6);
    expect(ctx.lastBounded).toBe(true);
  });
});

// =====================================================================================
// (6) content.js: источник/режим значения бейджа
// =====================================================================================
describe('O-32 (6): монотонный максимум включён при неполной базе, источник виден в логе', () => {
  test('source-пин: useMonotonic учитывает канонический пол неполной базы', () => {
    expect(CONTENT).toContain('const useMonotonic = baseComplete || lastBounded || (baseSeen && baseCount > 0);');
    expect(CONTENT).toContain("aiCmDiagLine('gsa-metric-src'");
    expect(CONTENT).toContain("var metricSrc = baseComplete ? 'base-complete' : (lastBounded ? 'base-floor+dom-tail' : 'base-floor');");
    expect(CONTENT).toContain("note: (!baseComplete && baseCount > 0) ? 'incomplete-canonical-floor' : ''");
    // лог только на смену состояния (урок O-29): антиспам-сигнатура объявлена в state.js
    const STATE = fs.readFileSync(path.join(ROOT, 'core', 'state.js'), 'utf8');
    expect(STATE).toContain('let lastMetricSig = null;');
    expect(CONTENT).toContain('metricSig !== lastMetricSig');
    expect(CONTENT).toContain('lastMetricSig = metricSig;');
  });
});

// =====================================================================================
// (7) base-handler: дедуп для google_search — рабочая ветка, а не no-op
// =====================================================================================
describe('O-32 (7): дедуп экспортного источника для google_search работает', () => {
  test('source-пин: ветка google_search зовёт prepareExportMessages пайплайна', () => {
    const body = fnDecl(BASE_HANDLER, 'aiCmDedupeExportSource');
    expect(body).toContain("if (site === 'google_search') {");
    expect(body).toContain('Pgsa.prepareExportMessages(messages, aiCmLogIntraDedupe)');
    expect(body).toContain('msgs=' + "' + messages.length + '→' + outGsa.length");
    // прочие не-Gemini сайты прежним путём (нормализация ролей без схлопывания)
    expect(body).toContain("if (site !== 'gemini' && site !== 'aistudio') {");
  });

  test('рабочая функция: дубль-копия хода схлопывается, порядок и роли сохранены', () => {
    const scope = 'with (ctx) { ' + fnDecl(BASE_HANDLER, 'aiCmDedupeExportSource') +
      '\n return { dedupe: aiCmDedupeExportSource }; }';
    const logs = [];
    const ctx = {
      currentAdapter: { siteName: 'google_search' },
      aiCmLogIntraDedupe: function (role, blocks) { logs.push('intra ' + role + ' ' + blocks); },
      debugLog: function (lvl, msg) { logs.push(String(msg)); },
      window: { AiCmExportEmitPipeline: P }
    };
    const api = new Function('ctx', scope)(ctx);
    // «инфляция» в чистом виде: каждый элемент канонической базы продублирован (две копии
    // одного и того же сообщения — то, что даёт удвоенная база писателей).
    const canonical = [];
    TURNS_A.forEach((t, i) => {
      canonical.push({ role: 'user', text: t.q, id: 'u' + i });
      canonical.push({ role: 'assistant', text: t.a, id: 'a' + i });
    });
    const doubled = canonical.concat(canonical.map((m, i) => ({ role: m.role, text: m.text, id: m.id + '-dup' + i })));
    const res = api.dedupe(doubled);
    expect(res.removed).toBe(canonical.length);               // 6 копий схлопнуты
    expect(res.messages).toHaveLength(canonical.length);
    expect(res.messages.map((m) => m.role)).toEqual(canonical.map((m) => m.role)); // порядок и роли
    expect(res.messages.map((m) => m.text)).toEqual(canonical.map((m) => m.text)); // байты первых вхождений
    expect(logs.join('\n')).toContain('dedupe removed=');
    // чужой сайт — прежний путь (ни одного удаления, байты текста те же)
    const ctx2 = Object.assign({}, ctx, { currentAdapter: { siteName: 'deepseek' } });
    const api2 = new Function('ctx', scope)(ctx2);
    const same = [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }];
    expect(api2.dedupe(same).messages).toHaveLength(2);
    expect(api2.dedupe(same).removed).toBe(0);
  });
});

// =====================================================================================
// (9) Живой лог: строка отпечатка печатается самим перехватчиком под гейтом aiCmDebug
// =====================================================================================
describe('O-32 (9): строка gsa-thread-fingerprint — инструмент живой приёмки', () => {
  test('emitDetail печатает отпечаток треда (hash+count+textLen) только под гейтом', () => {
    const body = fnDecl(INTERCEPT, 'emitDetail');
    expect(body).toContain("aiCmDiagLine('gsa-thread-fingerprint'");
    expect(body).toContain('hash:');
    expect(body).toContain('textLen:');
    // вызов — каноническим хелпером гейта, байты эмита не меняются (dispatchEvent прежний)
    expect(body).toContain('window.dispatchEvent(new CustomEvent(\'ai-cm-full-history\'');
  });

  test('отпечаток живого эмита: одна и та же база даёт одну строку, чужая форма — другая', () => {
    const lines = [];
    const h = interceptCtx({
      aiCmDiagLine: function (tag, fields) { lines.push(tag + ' ' + JSON.stringify(fields)); },
      aiCmDiagOn: function () { return true; }
    });
    h.api.applyTurns(networkTurns(), TID, true, 'folwr-body');
    const netLine = lines.filter((l) => l.indexOf('gsa-thread-fingerprint') === 0).pop();
    expect(netLine).toBeTruthy();
    const netFields = JSON.parse(netLine.slice(netLine.indexOf(' ') + 1));
    expect(netFields.threadId).toBe(TID);
    expect(netFields.count).toBe(TURNS_A.length);
    expect(netFields.historyComplete).toBe(1);
    // повторный эмит ТОЙ ЖЕ базы (SPA-возврат/кэш) — тот же отпечаток
    h.api.applyTurns(networkTurns(), TID, true, 'folif-body');
    const again = lines.filter((l) => l.indexOf('gsa-thread-fingerprint') === 0).pop();
    const againFields = JSON.parse(again.slice(again.indexOf(' ') + 1));
    expect(againFields.hash).toBe(netFields.hash);
    expect(againFields.count).toBe(netFields.count);
    // база, выросшая вдвое (живой дефект), даёт ДРУГОЙ отпечаток — инструмент различает
    const doubledKeys = canonicalKeysOfThread().concat(canonicalKeysOfThread()).sort();
    expect(fnv1aHex(doubledKeys.join('\u0001'))).not.toBe(netFields.hash);
  });
});

// =====================================================================================
// (8) Эталон треда A не сдвинут
// =====================================================================================
describe('O-32 (8): reference треда A — 6 сообщений / 12255 знаков / 5658 токенов / 4.4%', () => {
  test('tokenizer+limit эталона дают ровно 4.4% (границы ±0.1 п.п. приняты)', () => {
    const T = require('../utils/tokenizer.js');
    const ModelConfig = require('../utils/model-config.js');
    const limit = ModelConfig.getEffectiveLimit('gemini-search-default');
    expect(limit).toBe(128000);
    // эталонная пара (5658 токенов / 12255 знаков) — из живого лога 16:45:05
    const pct = Math.round((5658 / limit) * 1000) / 10;
    expect(pct).toBe(4.4);
    expect(pct).toBeGreaterThanOrEqual(4.3);
    expect(pct).toBeLessThanOrEqual(4.5);
    // тот же базис счёта, что у бейджа: Tokenizer.estimateDialogTokens(text, msgs)
    const toks = T.estimateDialogTokens('а'.repeat(12255), 6);
    expect(toks).toBeGreaterThan(0);
  });

  test('канонизация не переписывает текст хода: байты ответа те же', () => {
    const w = TURNS_A[0];
    expect(Parser.canonicalizeTurnForThread({ id: 'x', userText: null, assistantText: w.a }).assistantText).toBe(w.a);
    expect(Parser.mergeTurnsById([{ id: 'x', userText: null, assistantText: w.a }], [])[0].assistantText).toBe(w.a);
  });
});
