'use strict';

/**
 * S1.3a (inv-i3): канонический массив сообщений и мемоизация тела снимка.
 *
 * Что проверяем:
 *  1. Qwen-контейнеры отбрасываются РОВНО один раз (dropContainerMessages), порядок и
 *     поля остальных сообщений сохраняются; не-qwen сайты не теряют сообщений.
 *  2. Reasoning-секции добавляются один раз: повторный проход по уже собранному массиву
 *     не дублирует [REASONING]/[ANSWER] (withReasoningSections видит фрагмент в тексте).
 *  3. extra-поля (id/reasoning/custom) не теряются: Object.assign-копия, а не голый
 *     {role,text}; схема JSON не меняется.
 *  4. canonicalBody на том же массиве с другим convId даёт другой bodyHash (иначе
 *     tests/inv-s1-2-snapshot-body.test.js:194), а с тем же convId — тот же объект body
 *     (WeakMap-мемо в utils/canonical-body.ts).
 *  5. aiCmBuildCanonicalBody мемоизирует по (массив, convId, site) и возвращает null на
 *     пустом списке; при getEffectiveMessages()===null берёт buildHistoryMessages().
 *
 * Срез core/export-manager.ts исполняется через new Function: файл — classic script без
 * import/export, в бандле его функции хойстятся в общий скоуп content-скрипта, поэтому
 * canonicalBody/AiCmExportBuilders/getEffectiveMessages/buildHistoryMessages/currentAdapter
 * инжектируются аргументами (тот же приём, что tests/helpers/content-source.js).
 */

const fs = require('fs');
const path = require('path');

const loadEsmHelper = require('./helpers/load-esm.js');

const ROOT = path.join(__dirname, '..');
const Canonical = loadEsmHelper.loadEsmModule('utils/canonical-body.ts');
const Builders = loadEsmHelper.loadEsmGlobal('utils/export-text-builders.ts', 'AiCmExportBuilders');

const EM_PATH = path.join(ROOT, 'core', 'export-manager.ts');
const EM_SRC = fs.readFileSync(EM_PATH, 'utf8');
const SLICE_START = 'var lastCanonList = null;';
const SLICE_END = '// ========== v2.0 (этап 1/3)';

function exportManagerSlice() {
  const start = EM_SRC.indexOf(SLICE_START);
  const end = EM_SRC.indexOf(SLICE_END, start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      'inv-i3: в core/export-manager.ts не найден блок S1.3 ' +
      '(маркеры ' + JSON.stringify(SLICE_START) + ' .. ' + JSON.stringify(SLICE_END) + ')'
    );
  }
  const slice = EM_SRC.slice(start, end);
  if (slice.indexOf('function aiCmCanonicalizeMessages') === -1 ||
      slice.indexOf('function aiCmBuildCanonicalBody') === -1) {
    throw new Error('inv-i3: в срезе export-manager.ts нет aiCmCanonicalizeMessages/aiCmBuildCanonicalBody');
  }
  return slice;
}

/**
 * @param {{effective?: any, history?: any, adapter?: any}} over
 */
function makeHarness(over) {
  const env = Object.assign(
    { effective: null, history: [], adapter: { siteName: 'qwen' } },
    over || {}
  );
  const factory = new Function(
    'getEffectiveMessages',
    'buildHistoryMessages',
    'canonicalBody',
    'AiCmExportBuilders',
    'currentAdapter',
    exportManagerSlice() +
      '\nreturn { aiCmCanonicalizeMessages: aiCmCanonicalizeMessages, aiCmBuildCanonicalBody: aiCmBuildCanonicalBody };'
  );
  return factory(
    function () { return env.effective; },
    function () { return env.history; },
    Canonical.canonicalBody,
    Builders,
    env.adapter
  );
}

const QWEN_MSGS = [
  { id: 'u1', role: 'user', text: 'Вопрос один' },
  { id: 'a1', role: 'assistant', text: 'Ответ один' },
  { id: 'c1', role: 'assistant', text: 'Вопрос один\nОтвет один' }
];

describe('inv-i3: канонический массив сообщений (S1.3a)', function () {
  test('Qwen-контейнеры отбрасываются один раз, порядок и поля сохраняются', function () {
    const harness = makeHarness({ effective: QWEN_MSGS });

    const canon = harness.aiCmCanonicalizeMessages(QWEN_MSGS, 'qwen');
    expect(canon.map(function (m) { return m.id; })).toEqual(['u1', 'a1']);
    expect(canon.map(function (m) { return m.role; })).toEqual(['user', 'assistant']);

    // Исходный массив не мутирован.
    expect(QWEN_MSGS.length).toBe(3);
    expect(QWEN_MSGS[0].text).toBe('Вопрос один');

    // Повторный проход по уже отфильтрованному массиву ничего не выкидывает и не меняет.
    const again = harness.aiCmCanonicalizeMessages(canon, 'qwen');
    expect(again.map(function (m) { return m.id; })).toEqual(['u1', 'a1']);
    expect(again[0]).not.toBe(canon[0]); // всегда новый объект, но те же поля
    expect(again[0].id).toBe('u1');
    expect(again[0].text).toBe('Вопрос один');

    // Не-qwen сайт контейнеры не трогает (drop включается только по siteName).
    const gemini = harness.aiCmCanonicalizeMessages(QWEN_MSGS, 'gemini');
    expect(gemini.length).toBe(3);
  });

  test('reasoning-секции добавляются один раз и не дублируются при повторном вызове', function () {
    const harness = makeHarness();
    const src = [{ id: 'u1', role: 'user', text: 'Вопрос', reasoning: 'Думал так' }];

    const once = harness.aiCmCanonicalizeMessages(src, 'qwen');
    expect(once[0].text).toBe('[REASONING]\nДумал так\n\n[ANSWER]\nВопрос');

    const twice = harness.aiCmCanonicalizeMessages(once, 'qwen');
    expect(twice[0].text).toBe(once[0].text);
    expect(twice[0].text.split('[REASONING]').length - 1).toBe(1);
    expect(twice[0].text.split('[ANSWER]').length - 1).toBe(1);
  });

  test('extra-поля (id/reasoning/custom) не теряются, role нормализуется', function () {
    const harness = makeHarness();
    const src = [
      { id: 'u9', role: 'human', text: 'Привет', reasoning: 'r', custom: { x: 1 } },
      { id: 'a9', role: 'assistant', text: 'Здравствуй', reasoning: '' }
    ];

    const canon = harness.aiCmCanonicalizeMessages(src, 'qwen');
    expect(canon[0]).not.toBe(src[0]);
    expect(canon[0].id).toBe('u9');
    expect(canon[0].role).toBe('user');
    expect(canon[0].reasoning).toBe('r');
    expect(canon[0].custom).toEqual({ x: 1 });
    expect(canon[0].text).toBe('[REASONING]\nr\n\n[ANSWER]\nПривет');

    // Пустой reasoning не добавляет секций и не превращает текст в '[ANSWER]...'.
    expect(canon[1].text).toBe('Здравствуй');
    expect(canon[1].role).toBe('assistant');
    expect(canon[1].id).toBe('a9');

    // Неизвестная роль нормализуется в 'assistant', text всегда строка.
    const weird = harness.aiCmCanonicalizeMessages([{ role: 'tool', text: 42 }], 'gemini');
    expect(weird[0].role).toBe('assistant');
    expect(weird[0].text).toBe('42');
  });

  test('canonicalBody: тот же массив + другой convId => другой hash; тот же convId => тот же объект', function () {
    const msgs = [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }];

    const one = Canonical.canonicalBody('conv-1', msgs);
    expect(one.messages).toBe(msgs); // ссылка сохраняется (inv-i2)
    const oneAgain = Canonical.canonicalBody('conv-1', msgs);
    expect(oneAgain).toBe(one); // WeakMap-мемо: не пересчитываем

    const other = Canonical.canonicalBody('conv-2', msgs);
    expect(other.text).toBe(one.text);
    expect(other.bodyHash).not.toBe(one.bodyHash); // :194 в inv-s1-2
    expect(other.messages).toBe(msgs);
  });

  test('aiCmBuildCanonicalBody: тело из канонического массива, мемо по (list, convId, site)', function () {
    const harness = makeHarness({ effective: QWEN_MSGS, adapter: { siteName: 'qwen' } });

    const body = harness.aiCmBuildCanonicalBody('conv-1');
    expect(body).not.toBeNull();
    expect(body.messages.map(function (m) { return m.id; })).toEqual(['u1', 'a1']);
    expect(body.text).toBe(Canonical.canonicalBodyText(body.messages));
    expect(body.chars).toBe(body.text.length);
    expect(body.msgs).toBe(body.messages.length);
    expect(body.bodyHash).toMatch(/^[0-9a-f]{8}:\d+$/);
    expect(body.bodyHash.split(':')[1]).toBe(String(body.chars));

    // canonicalBody уже закэшировал тело по этой ссылке и этому чату.
    expect(Canonical.canonicalBody('conv-1', body.messages)).toBe(body);

    const again = harness.aiCmBuildCanonicalBody('conv-1');
    expect(again).toBe(body);

    const otherConv = harness.aiCmBuildCanonicalBody('conv-2');
    expect(otherConv.text).toBe(body.text);
    expect(otherConv.bodyHash).not.toBe(body.bodyHash);
  });

  test('aiCmBuildCanonicalBody: пустой список => null; fallback на buildHistoryMessages', function () {
    expect(makeHarness({ effective: [] }).aiCmBuildCanonicalBody('c')).toBeNull();
    expect(makeHarness({ effective: null, history: [] }).aiCmBuildCanonicalBody('c')).toBeNull();

    const fromHistory = makeHarness({
      effective: null,
      history: [{ id: 'h1', role: 'user', text: 'Из истории' }],
      adapter: { siteName: 'gemini' }
    });
    const body = fromHistory.aiCmBuildCanonicalBody('c');
    expect(body).not.toBeNull();
    expect(body.text).toBe('Из истории');
    expect(body.messages.length).toBe(1);
  });
});
