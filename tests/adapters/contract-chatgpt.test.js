/**
 * §п.8-B: КОНТРАКТ CHATGPTADAPTER НА ЖИВОМ СНИМКЕ DOM (формат коллектора v1).
 *
 * Источник истины — tools/ai-cm-dom-snapshot-chatgpt-1791904478076.json (1 039 083 Б,
 * снят 2026-10-13T15:14:38.056Z с chatgpt.com, 1 633 узла, bodyChildCount=22).
 * Снимок — НОВЫЙ формат `ai-cm-dom-snapshot-collector` v1: ключ `bodyOuterHTML` (внешний
 * HTML элемента <body> целиком), а не пофайловый список узлов, как в
 * tools/qwen-dom-snapshot-26.09.26.json. Поэтому DOM восстанавливается одной строкой:
 * `document.body.innerHTML = S.bodyOuterHTML`. Парсер в режиме «in body» вложенный <body>
 * не создаёт, а сливает его атрибуты в существующий body — разметка внутри сохраняется.
 *
 * Пины держат ИМЕННО эти числа снимка (проверено прогоном, не пересказ):
 *   [data-turn-key] ................................ 5 ходов (UUID на ход, все уникальны)
 *   [class*="bg-user-message"|"text-user-message"] .. 4 узла-реплики пользователя
 *   ответы ......................................... 5 (по одному на ход)
 *   extractMessages() .............................. 9 сообщений: 4 user / 5 assistant
 *   суммарная длина content ........................ 8 997 символов
 *   реплик с переводом строки ...................... 6 из 9
 *   узлов-кандидатов в снимке (counts.totalNodes) .. 1 633
 *
 * Асимметрия 4/5 — свойство снимка, а не потеря: у хода 0 узла пользователя нет вообще
 * (ход 0 — ответ ассистента). Это прямая проверка фикса fd64838: адаптер НЕ подделывает
 * user там, где узла нет, и НЕ нормализует 'unknown' → 'user' (см. пин CH7).
 *
 * Не пин, а ОСТАТОК для аппендикса v74: в content ассистента утекает видимая подпись
 * «ChatGPT сказал:\n» (9 из 9 assistant-реплик начинаются с неё). Причина — метка лежит
 * текстовым узлом внутри блока ответа, а `_extractText` срезает только button/svg
 * (adapters/chatgpt-adapter.js:301-303), не скрытые label-узлы. Это НЕ контракт: починка
 * метки сделает пин ложным, поэтому здесь она только задокументирована.
 */

const fs = require('fs');
const path = require('path');
const { loadAdapter } = require('../helpers/adapter-harness');
const { loadFixture } = require('../helpers/contract-fixture-loader');

jest.setTimeout(15000);

const SNAPSHOT_PATH = 'tools/ai-cm-dom-snapshot-chatgpt-1791904478076.json';

/** Ходы диалога: UUID на ход (стабильный, не хеш содержимого). */
const TURN_SEL = '[data-turn-key]';
/** Маркеры реплики пользователя — те же, что в _userSelectors адаптера. */
const USER_SEL = '[class*="bg-user-message"], [class*="text-user-message"]';

/** Числа снимка: проверяются и как свойства артефакта, и как результат адаптера. */
const SNAPSHOT_NODES = 1633;
const TURN_NODES = 5;
const USER_NODES = 4;
const ASSISTANT_NODES = 5;
const MESSAGES = 9;
const MESSAGES_WITH_NL = 6;
const TOTAL_CONTENT_LEN = 8997;

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
  hostname: (S && S.meta && S.meta.hostname) || 'chatgpt.com',
  pathname: '/c/' + ((S && S.meta && String(S.meta.url).split('/c/')[1]) || 'unknown')
};

// Сьют опирается на ЦЕЛОСТНЫЙ живой снимок: без него property-пины стали бы вакуумными.
// В CI (tools/ в .gitignore) такого артефакта нет — сьют объявляется через describe.skip
// с обоснованием; локально файл есть (fs.existsSync → true), и тесты обязаны исполниться.
const snapshotOk = !!(S && typeof S.bodyOuterHTML === 'string' && S.bodyOuterHTML.length > 0);
const synthed = SNAPSHOT.synthetic === true;
const suiteSkipped = synthed || !snapshotOk;
if (suiteSkipped) {
  // eslint-disable-next-line no-console
  console.warn('[§п.8-B] chatgpt: ' + (synthed
    ? 'AI_CM_CONTRACT_SYNTH=1 — принудительный синтез, контракт требует реального снимка'
    : 'артефакт отсутствует в CI (реальный payload доступен локально)') + ' — ' + SNAPSHOT_PATH);
}
const suite = suiteSkipped ? describe.skip : describe;
const ctest = suiteSkipped ? test.skip : test;

function chatgpt() {
  return loadAdapter('adapters/chatgpt-adapter.js', {
    document: document,
    location: loc,
    exportExpr: 'ChatGPTAdapter'
  });
}

function rolesOf(msgs) {
  return msgs.reduce(function (acc, m) { acc[m.role] = (acc[m.role] || 0) + 1; return acc; }, {});
}

/** Снимок разметки, посчитанный ОДИН раз: 1 МБ innerHTML на каждый тест — лишняя работа. */
let domTurns = [];
let domTurnKeys = [];
let domTurnTexts = [];
let domUserNodes = 0;
let perTurnUserNodes = [];

suite('§п.8-B: ChatGPTAdapter — контракт на живом DOM-снимке 2026-10-13', function () {
  beforeAll(function () {
    document.body.innerHTML = String(S.bodyOuterHTML);
    domTurns = Array.prototype.slice.call(document.querySelectorAll(TURN_SEL));
    domTurnKeys = domTurns.map(function (t) { return String(t.getAttribute('data-turn-key') || ''); });
    domTurnTexts = domTurns.map(function (t) { return String(t.textContent || '').trim(); });
    domUserNodes = document.querySelectorAll(USER_SEL).length;
    perTurnUserNodes = domTurns.map(function (t) { return t.querySelectorAll(USER_SEL).length; });
  });

  ctest('CH0 (невакуумный): снимок — настоящий артефакт коллектора v1, а не синтетика', function () {
    expect(SNAPSHOT.existed).toBe(true);
    expect(SNAPSHOT.fromLiveRun).toBe(true);
    expect(synthed).toBe(false);

    // формат и происхождение артефакта
    expect(S.meta.tool).toBe('ai-cm-dom-snapshot-collector');
    expect(S.meta.version).toBe(1);
    expect(S.meta.platform).toBe('chatgpt');
    expect(S.meta.hostname).toBe('chatgpt.com');
    expect(S.counts.totalNodes).toBe(SNAPSHOT_NODES);
    expect(S.counts.totalTurns).toBe(TURN_NODES);

    // payload непуст и DOM реально собран из него
    expect(S.bodyOuterHTML.length).toBeGreaterThan(100000);
    expect(domTurns.length).toBeGreaterThan(0);
  });

  ctest('CH1 (C1): роль каждой реплики ∈ {user, assistant}, ровно 4 user / 5 assistant', function () {
    const msgs = chatgpt().Adapter.extractMessages();
    const roles = rolesOf(msgs);

    msgs.forEach(function (m) { expect(['user', 'assistant']).toContain(m.role); });
    expect(Object.keys(roles).sort()).toEqual(['assistant', 'user']);
    expect(roles.user).toBe(USER_NODES);
    expect(roles.assistant).toBe(ASSISTANT_NODES);
    expect(msgs.length).toBe(MESSAGES);

    // C3 (id реплики) НЕПРИМЕНИМ: DOM-путь ChatGPT id не отдаёт — форма записи пинится
    // как контракт, чтобы молчаливое добавление поля не прошло незамеченным.
    msgs.forEach(function (m) {
      expect(Object.keys(m).sort()).toEqual(['content', 'role']);
      expect(m.id).toBeUndefined();
    });
  });

  ctest('CH2 (C2): content — непустая строка; перевод строки сохранён там, где он есть в снимке', function () {
    const msgs = chatgpt().Adapter.extractMessages();

    msgs.forEach(function (m) {
      expect(typeof m.content).toBe('string');
      expect(m.content.trim().length).toBeGreaterThan(0);
      // адаптер отдаёт текст без обрамляющих переводов строки
      expect(m.content.charAt(0)).not.toBe('\n');
      expect(m.content.charAt(m.content.length - 1)).not.toBe('\n');
    });

    // ChatGPT, в отличие от qwen, НЕ обязан давать многострочность в каждой реплике:
    // многострочных ровно 6 из 9 — это свойство снимка, а не нормализация адаптера.
    const withNl = msgs.filter(function (m) { return m.content.indexOf('\n') !== -1; });
    expect(withNl.length).toBe(MESSAGES_WITH_NL);

    const totalLen = msgs.reduce(function (a, m) { return a + m.content.length; }, 0);
    expect(totalLen).toBe(TOTAL_CONTENT_LEN);
  });

  ctest('CH3 (C4): контейнеры ходов отброшены — ни один ход не стал репликой', function () {
    const msgs = chatgpt().Adapter.extractMessages();

    // ходы на месте и опознаются стабильными UUID (снимок: 5 уникальных)
    expect(domTurnKeys).toHaveLength(TURN_NODES);
    expect(domTurnKeys.filter(function (k) { return k.length > 0; })).toHaveLength(TURN_NODES);
    expect(new Set(domTurnKeys).size).toBe(TURN_NODES);

    // (а) идентичность контейнера не утекает в текст реплик
    msgs.forEach(function (m) {
      domTurnKeys.forEach(function (k) {
        expect(m.content.indexOf(k)).toBe(-1);
      });
    });

    // (б) ни одна реплика не равна ходу целиком: текст хода — это ход, а не сообщение
    const turnTexts = domTurnTexts;
    expect(turnTexts.filter(function (t) { return t.length > 0; })).toHaveLength(TURN_NODES);
    msgs.forEach(function (m) {
      expect(turnTexts).not.toContain(m.content.trim());
    });

    // (в) контейнеров МЕНЬШЕ, чем реплик: адаптер спускается ВНУТРЬ хода, а не эмитит ход
    expect(msgs.length).toBeGreaterThan(domTurns.length);
  });

  ctest('CH4 (C5): число реплик не превышает ёмкость снимка (число узлов и слоты ходов)', function () {
    const msgs = chatgpt().Adapter.extractMessages();

    // честная координата «узлов-кандидатов»: 5 ходов и 4 узла пользователя
    expect(domTurns.length).toBe(TURN_NODES);
    expect(domUserNodes).toBe(USER_NODES);

    // 9 реплик против 1 633 узлов снимка — реплики не «выдуманы из воздуха»
    expect(msgs.length).toBeLessThanOrEqual(S.counts.totalNodes);
    // верхняя граница по структуре: ход даёт максимум 2 реплики (вопрос + ответ)
    expect(msgs.length).toBeLessThanOrEqual(2 * domTurns.length);
    expect(msgs.length).toBe(MESSAGES);
    expect(2 * domTurns.length).toBe(2 * TURN_NODES);
  });

  ctest('CH5 (асимметрия fd64838): ход 0 без узла пользователя — реплика user НЕ подделана', function () {
    const msgs = chatgpt().Adapter.extractMessages();

    // в снимке у первого хода узла пользователя нет вообще, у остальных — по одному
    expect(perTurnUserNodes).toEqual([0, 1, 1, 1, 1]);
    expect(domUserNodes).toBe(USER_NODES);

    // следовательно роли не чередуются: диалог открывает ассистент
    expect(msgs[0].role).toBe('assistant');
    expect(msgs[0].content.trim().length).toBeGreaterThan(0);
    const roles = rolesOf(msgs);
    expect(roles.user).toBe(USER_NODES);
    expect(roles.assistant).toBe(ASSISTANT_NODES);
    // и user-реплик ровно столько, сколько узлов-маркеров в DOM
    expect(roles.user).toBe(domUserNodes);
  });

  ctest('CH6: extractMessages дважды на одном DOM даёт тот же результат (нет скрытого состояния)', function () {
    const adapter = chatgpt().Adapter;
    const first = adapter.extractMessages();
    const second = adapter.extractMessages();
    expect(second).toEqual(first);
    expect(second).toHaveLength(MESSAGES);
  });

  ctest('CH7 (source-пин): нормализация unknown → user не вернулась', function () {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'adapters', 'chatgpt-adapter.js'), 'utf8');

    // корень дефекта fd64838 — именно эта нормализация; сейчас узел ПРОПУСКАЕТСЯ
    expect(src).toContain("if (role === 'unknown') continue;");
    expect(src).not.toMatch(/unknown'\s*\)?\s*\?\s*'user'/);
    expect(src).not.toMatch(/'unknown'\s*\?/);
    // и детектор роли не переводит неопознанное в пользователя
    expect(src).not.toMatch(/return\s+'user';\s*\/\/\s*unknown/);
  });

  ctest('CH8 (невакуумный): обе роли в наличии, ошибок нет, диагностический гейт закрыт', function () {
    const res = chatgpt();
    const msgs = res.Adapter.extractMessages();

    expect(msgs.length).toBeGreaterThan(0);
    expect(res.Adapter.isOnDialogPage()).toBe(true);
    const roles = rolesOf(msgs);
    expect(roles.user).toBeGreaterThan(0);
    expect(roles.assistant).toBeGreaterThan(0);

    // жёсткие ошибки песочницы (swallow бросает) — контракт нарушен
    expect(res.sandbox.errors.filter(function (e) { return !e.soft; })).toHaveLength(0);

    // гейт спрашивали, но он молчал: диагностика не подменяет контракт
    expect(res.sandbox.called.aiCmDiagOn).toBeGreaterThanOrEqual(1);
    expect(res.sandbox.called.aiCmDiagLine).toBeUndefined();
  });
});
