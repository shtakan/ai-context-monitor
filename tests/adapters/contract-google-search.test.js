/**
 * §п.8-B: КОНТРАКТ GOOGLESEARCHADAPTER НА ЖИВОМ СНИМКЕ DOM (формат коллектора v1).
 *
 * Источник истины — tools/ai-cm-dom-snapshot-google-search-1791904520929.json (1 345 825 Б,
 * снят 2026-10-13T15:15:20.903Z с www.google.com/search?udm=50, 6 471 узел, bodyChildCount=72).
 * Тот же формат `ai-cm-dom-snapshot-collector` v1, что и у chatgpt: ключ `bodyOuterHTML`
 * (внешний HTML элемента <body> целиком), поэтому DOM восстанавливается одной строкой:
 * `document.body.innerHTML = S.bodyOuterHTML`. Парсер в режиме «in body» вложенный <body>
 * не создаёт, а сливает его атрибуты (class="srp P4Yedd …") в существующий body.
 *
 * Пины держат ИМЕННО эти числа снимка (проверено прогоном, не пересказ):
 *   [data-scope-id="turn"] ......................... 6 ходов AI-режима
 *   h2.iMqumd (заголовок вопроса) .................. 6 — по одному на ход
 *   extractMessages() .............................. 12 сообщений: 6 user / 6 assistant
 *   порядок ролей .................................. строго user, assistant, user, …
 *   суммарная длина content ........................ 6 757 символов
 *   самый длинный content .......................... 1 047 символов
 *   самый короткий текст хода-контейнера ........... 3 495 символов
 *   узлов-кандидатов в снимке (counts.totalNodes) .. 6 471
 *
 * ВАЖНО про счётчики коллектора: S.counts.totalTurns и S.counts.totalMessages у этого
 * артефакта РАВНЫ НУЛЮ — обобщённые эвристики коллектора разметку AI-режима Google не
 * распознали (ни сообщений, ни ходов). Единственный источник истины по этой странице —
 * САМ АДАПТЕР (6 ходов / 12 реплик), и пин GS1 фиксирует это расхождение явно: если
 * коллектор когда-нибудь научится считать ходы, пин вскроет подмену артефакта.
 *
 * Не пин, а ОСТАТОК для аппендикса v74: в content ВСЕХ 6 user-реплик утекает немецкий
 * префикс UI — «Du hast Folgendes gesagt:/gesendet: …» (проверено: 6 из 6; «Вы сказали»
 * не встречается ни разу). Причина — adapters/google-search-adapter.js:164 знает только
 * русскую форму `^Вы сказали:\s*"…"$`, поэтому для немецкой локали match не срабатывает и
 * в qText уходит raw-текст заголовка. Это НЕ контракт: починка регекспа сделает пин
 * ложным, поэтому здесь префикс только задокументирован.
 */

const fs = require('fs');
const path = require('path');
const { loadAdapter } = require('../helpers/adapter-harness');
const { loadFixture } = require('../helpers/contract-fixture-loader');

jest.setTimeout(15000);

const SNAPSHOT_PATH = 'tools/ai-cm-dom-snapshot-google-search-1791904520929.json';

/** Ходы AI-режима Google: контейнер с data-scope-id="turn". */
const TURN_SEL = '[data-scope-id="turn"]';
/** Заголовок вопроса внутри хода — именно его читает адаптер (h2.iMqumd). */
const QUESTION_SEL = 'h2.iMqumd';

/** Числа снимка: проверяются и как свойства артефакта, и как результат адаптера. */
const SNAPSHOT_NODES = 6471;
const TURN_NODES = 6;
const QUESTION_HEADERS = 6;
const MESSAGES = 12;
const USER_MESSAGES = 6;
const ASSISTANT_MESSAGES = 6;
const TOTAL_CONTENT_LEN = 6757;

// При AI_CM_CONTRACT_SYNTH=1 артефакт НЕ читается: контракт требует реального снимка, а
// синтетика сделала бы property-пины вакуумными (сьюта в этом режиме пропускается).
// В CI (tools/ в .gitignore) артефакта нет — loadFixture() вызывается ТОЛЬКО когда файл
// реально присутствует, поэтому верхний уровень не бросает, а сьют уходит в skip.
const snapSynthForced = String(process.env.AI_CM_CONTRACT_SYNTH || '') === '1';
const artifactsAvailable = !snapSynthForced && fs.existsSync(path.join(__dirname, '..', '..', SNAPSHOT_PATH));
const SNAPSHOT = artifactsAvailable
  ? loadFixture(SNAPSHOT_PATH, null, { parseJson: true })
  : { json: null, synthetic: snapSynthForced, existed: false, source: SNAPSHOT_PATH };
const S = SNAPSHOT.json || null;

/** Локация берётся из меты самого снимка: фикстура ведёт тест, а не наоборот. */
const loc = {
  hostname: (S && S.meta && S.meta.hostname) || 'www.google.com',
  pathname: '/' + ((S && S.meta && String(S.meta.url).split('?')[0].split('/').slice(3).join('/')) || 'search')
};

// Сьют опирается на ЦЕЛОСТНЫЙ живой снимок: без него property-пины стали бы вакуумными.
// В CI (tools/ в .gitignore) такого артефакта нет — сьют объявляется через describe.skip
// с обоснованием; локально файл есть (fs.existsSync → true), и тесты обязаны исполниться.
const snapshotOk = !!(S && typeof S.bodyOuterHTML === 'string' && S.bodyOuterHTML.length > 0);
const synthed = SNAPSHOT.synthetic === true;
const suiteSkipped = synthed || !snapshotOk;
if (suiteSkipped) {
  // eslint-disable-next-line no-console
  console.warn('[§п.8-B] google-search: ' + (synthed
    ? 'AI_CM_CONTRACT_SYNTH=1 — принудительный синтез, контракт требует реального снимка'
    : 'артефакт отсутствует в CI (реальный payload доступен локально)') + ' — ' + SNAPSHOT_PATH);
}
const suite = suiteSkipped ? describe.skip : describe;
const gtest = suiteSkipped ? test.skip : test;

function gsa() {
  return loadAdapter('adapters/google-search-adapter.js', {
    document: document,
    location: loc,
    exportExpr: 'GoogleSearchAdapter'
  });
}

function rolesOf(msgs) {
  return msgs.reduce(function (acc, m) { acc[m.role] = (acc[m.role] || 0) + 1; return acc; }, {});
}

/** Снимок разметки, посчитанный ОДИН раз: 1,3 МБ innerHTML на каждый тест — лишняя работа. */
let domTurns = [];
let domTurnTexts = [];
let domQuestionHeaders = 0;
let logSpy = null;
let errSpy = null;

suite('§п.8-B: GoogleSearchAdapter — контракт на живом DOM-снимке 2026-10-13', function () {
  beforeAll(function () {
    // Адаптер печатает «Инициализирован» и «Извлечено N сообщений» в console.log —
    // глушим ТОЛЬКО log (warn/error остаются): вывод сьюта не должен тонуть в шуме адаптера.
    logSpy = jest.spyOn(console, 'log').mockImplementation(function () { });

    // Google отдаёт минифицированный <style>, который cssom/jsdom разобрать не может, и
    // jest-environment-jsdom льёт это в console.error как «css parsing». Это шум ПАРСЕРА
    // разметки, а не ошибка контракта: глушим ровно его, всё остальное пропускаем дальше.
    const realError = console.error;
    errSpy = jest.spyOn(console, 'error').mockImplementation(function () {
      const parts = Array.prototype.map.call(arguments, function (a) {
        if (a && typeof a === 'object') return String(a.type || '') + ' ' + String(a.message || '');
        return String(a);
      }).join(' ');
      if (/css parsing|CSS stylesheet|Could not parse CSS/i.test(parts)) return;
      realError.apply(console, arguments);
    });

    document.body.innerHTML = String(S.bodyOuterHTML);
    domTurns = Array.prototype.slice.call(document.querySelectorAll(TURN_SEL));
    domTurnTexts = domTurns.map(function (t) { return String(t.textContent || '').trim(); });
    domQuestionHeaders = document.querySelectorAll(QUESTION_SEL).length;
  });

  afterAll(function () {
    if (logSpy) logSpy.mockRestore();
    if (errSpy) errSpy.mockRestore();
  });

  gtest('GS0 (невакуумный): снимок — настоящий артефакт коллектора v1, а не синтетика', function () {
    expect(SNAPSHOT.existed).toBe(true);
    expect(SNAPSHOT.fromLiveRun).toBe(true);
    expect(synthed).toBe(false);

    // формат и происхождение артефакта
    expect(S.meta.tool).toBe('ai-cm-dom-snapshot-collector');
    expect(S.meta.version).toBe(1);
    expect(S.meta.platform).toBe('google-search');
    expect(S.meta.hostname).toBe('www.google.com');
    expect(String(S.meta.url)).toContain('udm=50');
    expect(S.counts.totalNodes).toBe(SNAPSHOT_NODES);

    // payload непуст и DOM реально собран из него
    expect(S.bodyOuterHTML.length).toBeGreaterThan(100000);
    expect(domTurns.length).toBeGreaterThan(0);
  });

  gtest('GS1 (C5): адаптер видит 6 ходов там, где обобщённые счётчики коллектора видят 0', function () {
    const msgs = gsa().Adapter.extractMessages();

    // расхождение зафиксировано: у этого артефакта счётчики коллектора пусты
    expect(S.counts.totalTurns).toBe(0);
    expect(S.counts.totalMessages).toBe(0);
    // а структура в DOM есть, и её видит именно адаптер
    expect(domTurns.length).toBe(TURN_NODES);
    expect(msgs.length).toBe(MESSAGES);

    // ёмкость: ход даёт максимум 2 реплики (вопрос + ответ) — и здесь оба слота заняты
    expect(msgs.length).toBe(2 * domTurns.length);
    expect(msgs.length).toBeGreaterThan(domTurns.length);
    expect(msgs.length).toBeLessThanOrEqual(S.counts.totalNodes);
  });

  gtest('GS2 (C4): контейнеры ходов отброшены — каждый ход длиннее любой реплики', function () {
    const msgs = gsa().Adapter.extractMessages();

    // заголовки вопросов на месте: по одному на ход (адаптер читает именно h2.iMqumd)
    expect(domQuestionHeaders).toBe(QUESTION_HEADERS);
    expect(domTurnTexts).toHaveLength(TURN_NODES);
    expect(domTurnTexts.filter(function (t) { return t.length > 0; })).toHaveLength(TURN_NODES);

    // (а) ни одна реплика не равна ходу целиком: текст хода — это контейнер, а не сообщение
    msgs.forEach(function (m) {
      expect(domTurnTexts).not.toContain(m.content.trim());
    });

    // (б) и это не случайность: САМЫЙ КОРОТКИЙ ход-контейнер длиннее САМОЙ ДЛИННОЙ реплики,
    //     то есть ни один контейнер не мог уехать в content по недосмотру
    const minTurnLen = Math.min.apply(null, domTurnTexts.map(function (t) { return t.length; }));
    const maxMsgLen = Math.max.apply(null, msgs.map(function (m) { return m.content.length; }));
    expect(minTurnLen).toBeGreaterThan(maxMsgLen);
    expect(minTurnLen).toBeGreaterThan(1000);
    expect(maxMsgLen).toBeLessThan(2000);
  });

  gtest('GS3 (C1): роль каждой реплики ∈ {user, assistant}, ровно 6 user / 6 assistant', function () {
    const msgs = gsa().Adapter.extractMessages();
    const roles = rolesOf(msgs);

    msgs.forEach(function (m) { expect(['user', 'assistant']).toContain(m.role); });
    expect(Object.keys(roles).sort()).toEqual(['assistant', 'user']);
    expect(roles.user).toBe(USER_MESSAGES);
    expect(roles.assistant).toBe(ASSISTANT_MESSAGES);

    // C3 (id реплики) НЕПРИМЕНИМ: GSA id не отдаёт — форма записи пинится как контракт,
    // чтобы молчаливое добавление поля не прошло незамеченным.
    msgs.forEach(function (m) {
      expect(Object.keys(m).sort()).toEqual(['content', 'role']);
      expect(m.id).toBeUndefined();
    });
  });

  gtest('GS4 (roles-alt): порядок ролей детерминирован и строго чередуется, начиная с user', function () {
    const msgs = gsa().Adapter.extractMessages();
    const order = msgs.map(function (m) { return m.role; });

    expect(order).toHaveLength(MESSAGES);
    expect(order[0]).toBe('user');
    expect(order[order.length - 1]).toBe('assistant');
    order.forEach(function (r, i) {
      expect(r).toBe(i % 2 === 0 ? 'user' : 'assistant');
    });
    // чередование — следствие структуры: каждый ход даёт пару вопрос→ответ
    expect(order.filter(function (r) { return r === 'user'; })).toHaveLength(domTurns.length);
  });

  gtest('GS5 (C2): content — непустая строка без обрамляющих переводов строки', function () {
    const msgs = gsa().Adapter.extractMessages();

    msgs.forEach(function (m) {
      expect(typeof m.content).toBe('string');
      expect(m.content.trim().length).toBeGreaterThan(0);
      expect(m.content.charAt(0)).not.toBe('\n');
      expect(m.content.charAt(m.content.length - 1)).not.toBe('\n');
    });

    const totalLen = msgs.reduce(function (a, m) { return a + m.content.length; }, 0);
    expect(totalLen).toBe(TOTAL_CONTENT_LEN);
    // см. шапку файла: немецкий префикс «Du hast Folgendes …» в user-репликах — ОСТАТОК,
    // а не пин. Здесь он намеренно не проверяется, чтобы починка регекспа не ломала контракт.
  });

  gtest('GS6 (невакуумный): обе роли в наличии, ошибок нет, диагностический гейт закрыт', function () {
    const res = gsa();
    const msgs = res.Adapter.extractMessages();

    expect(msgs.length).toBeGreaterThan(0);
    expect(res.Adapter.isOnDialogPage()).toBe(true);
    const roles = rolesOf(msgs);
    expect(roles.user).toBeGreaterThan(0);
    expect(roles.assistant).toBeGreaterThan(0);
    msgs.forEach(function (m) { expect(m.content.trim().length).toBeGreaterThan(0); });

    // жёсткие ошибки песочницы (swallow бросает) — контракт нарушен
    expect(res.sandbox.errors.filter(function (e) { return !e.soft; })).toHaveLength(0);

    // гейт спрашивали, но он молчал: диагностика не подменяет контракт
    expect(res.sandbox.called.aiCmDiagOn).toBeGreaterThanOrEqual(1);
    expect(res.sandbox.called.aiCmDiagLine).toBeUndefined();
  });
});
