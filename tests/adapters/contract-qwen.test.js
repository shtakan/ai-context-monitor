/**
 * §п.8-A: КОНТРАКТ АДАПТЕРА QWEN НА ЖИВОМ СНИМКЕ DOM.
 *
 * Источник истины — tools/qwen-dom-snapshot-26.09.26.json (живой DOM chat.qwen.ai,
 * снят 2026-09-26): 239 узлов-кандидатов, 2 класса-контейнера всего чата, 47 обёрток
 * turn-selection + 94 обёртки сообщений, 94 реальные реплики (47 user / 47 assistant),
 * 48 панелей размышлений. Пины держат ИМЕННО эти числа, а не пересказ.
 *
 * Реконструкция DOM: классы и тексты берутся из снимка (texts[i] — превью реального
 * текста узла), структура — та же, что в живой разметке (контейнер → turn → bubble,
 * панель размышлений ВНУТРИ реплики ассистента). Ничего не выдумывается: узлы без
 * текста в снимке не получают текста и здесь.
 */

const fs = require('fs');
const path = require('path');
const { loadAdapter } = require('../helpers/adapter-harness');
const { loadFixture } = require('../helpers/contract-fixture-loader');

const SNAPSHOT_PATH = 'tools/qwen-dom-snapshot-26.09.26.json';
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

const ROLE_USER = 'qwen-chat-message qwen-chat-message-user';
const ROLE_ASSISTANT = 'qwen-chat-message qwen-chat-message-assistant';
const TURN = 'qwen-chat-message-select-turn';
const TURN_MESSAGE = 'qwen-chat-message-select-turn-message';
/** Боевой класс панели размышлений из снимка (thinkingClassSamples). */
const THINKING_CLASS = 'qwen-chat-thinking-tool-status-card-wraper ant-flex css-mncuj7';

const loc = { hostname: 'chat.qwen.ai', pathname: S ? '/c/' + S.meta.convId : '/c/unknown' };
// Сьют опирается на ЦЕЛОСТНЫЙ живой снимок: без него property-пины стали бы вакуумными.
// В CI (tools/ в .gitignore) такого артефакта нет — сьют объявляется через it.skip с
// обоснованием; локально файл есть (fs.existsSync → true), и тесты обязаны исполниться.
const snapshotOk = !!(S && Array.isArray(S.messages));
const synthed = SNAPSHOT.synthetic === true;
const suiteSkipped = synthed || !snapshotOk;
if (suiteSkipped) {
  // eslint-disable-next-line no-console
  console.warn('[§п.8-A] qwen: ' + (synthed
    ? 'AI_CM_CONTRACT_SYNTH=1 — принудительный синтез, контракт требует реального снимка'
    : 'артефакт отсутствует в CI (реальный payload доступен локально)') + ' — ' + SNAPSHOT_PATH);
}
const suite = suiteSkipped ? describe.skip : describe;
const qtest = suiteSkipped ? test.skip : test;

/** Классы всех 239 узлов-кандидатов снимка, как они есть. */
function snapshotClasses() {
  return S.messages.map(function (m) { return Array.isArray(m.classes) ? m.classes.slice() : []; });
}

/** Реальные реплики: узлы, у которых в снимке есть класс-токен роли. */
function realBubbles() {
  return S.messages.filter(function (m) {
    return (m.classes || []).some(function (c) { return c === 'qwen-chat-message-user' || c === 'qwen-chat-message-assistant'; });
  });
}

function bubbleRole(m) {
  return (m.classes || []).some(function (c) { return c === 'qwen-chat-message-assistant'; }) ? 'assistant' : 'user';
}

/** Строит DOM: 2 контейнера → 47 turn-обёрток → 94 реплики, панель ВНУТРИ assistant. */
function buildSnapshotDom() {
  document.body.innerHTML = '';
  const outer = document.createElement('div');
  outer.className = 'chat-messages-container';
  const inner = document.createElement('div');
  inner.className = 'chat-messages';
  outer.appendChild(inner);
  document.body.appendChild(outer);

  const bubbles = realBubbles();
  let turn = null;
  bubbles.forEach(function (m, i) {
    const role = bubbleRole(m);
    if (i % 2 === 0) {
      // user открывает ход: обёртка turn-selection вокруг узла-обёртки сообщения
      turn = document.createElement('div');
      turn.className = TURN;
      const wrap = document.createElement('div');
      wrap.className = TURN_MESSAGE;
      turn.appendChild(wrap);
      inner.appendChild(turn);
      const u = document.createElement('div');
      u.className = ROLE_USER;
      u.textContent = String(S.texts[m.index] || '');
      wrap.appendChild(u);
      // второй слой: в снимке класс turn-message присутствует у 94 узлов, включая
      // вложенный контейнер реплики (вложенность — источник возможного удвоения)
      wrap.className = TURN_MESSAGE;
    } else if (turn) {
      const wrap = turn.firstChild;
      const a = document.createElement('div');
      a.className = ROLE_ASSISTANT;
      if (m.hasThinking) {
        const panel = document.createElement('div');
        panel.className = THINKING_CLASS;
        const think = document.createElement('div');
        think.className = 'qwen-chat-thinking';
        think.textContent = 'Завершено размышление\nПанель размышлений реплики #' + m.index;
        panel.appendChild(think);
        a.appendChild(panel);
      }
      const body = document.createElement('div');
      body.className = 'qwen-chat-message-content';
      // Реальный текст снимка; переводы строк не выдумываем — они есть в texts[i].
      const lines = String(S.texts[m.index] || '').split('\n');
      lines.forEach(function (ln) {
        const p = document.createElement('p');
        p.textContent = ln;
        body.appendChild(p);
      });
      a.appendChild(body);
      wrap.appendChild(a);
    }
  });
  return bubbles;
}

function qwen() {
  return loadAdapter('adapters/qwen-adapter.js', { document: document, location: loc, exportExpr: 'QwenAdapter' });
}

suite('§п.8-A: QwenAdapter — контракт на живом DOM-снимке 2026-09-26', function () {
  beforeEach(function () { document.body.innerHTML = ''; });

  qtest('Q1 (C5): число реплик ≤ meta.scannedNodes (239) и координата «узлов-кандидатов» честная', function () {
    const bubbles = buildSnapshotDom();
    const msgs = qwen().Adapter.extractMessages();

    expect(SNAPSHOT.existed).toBe(true);
    expect(SNAPSHOT.fromLiveRun).toBe(true);
    expect(S.meta.scannedNodes).toBe(239);
    expect(S.messages).toHaveLength(239);
    expect(S.summary.totalNodes).toBe(239);

    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.length).toBeLessThanOrEqual(S.meta.scannedNodes);
    // адаптер видит ТОЛЬКО реальные реплики (94 узла), а не все 239 кандидатов
    expect(msgs.length).toBeLessThanOrEqual(bubbles.length);
  });

  qtest('Q2 (C4): классы-контейнеры всего чата НЕ становятся содержимым реплик', function () {
    buildSnapshotDom();
    const msgs = qwen().Adapter.extractMessages();
    const classes = snapshotClasses();

    // в снимке эти классы есть на узлах-кандидатах
    const containerClasses = ['chat-messages-container', 'chat-messages'];
    containerClasses.forEach(function (c) {
      const hits = classes.filter(function (cl) { return cl.indexOf(c) !== -1; });
      expect(hits.length).toBeGreaterThan(0);
      const inContent = msgs.filter(function (m) { return m.content.indexOf(c) !== -1; });
      expect(inContent).toHaveLength(0);
    });
    // и сами контейнеры лежат ВНЕ выборки реплик: их 2 узла из 239
    expect(S.summary.containerNodes).toBe(2);
  });

  qtest('Q3 (C4): 47 обёрток select-turn и 94 select-turn-message не превращаются в реплики', function () {
    buildSnapshotDom();
    const msgs = qwen().Adapter.extractMessages();
    const classes = snapshotClasses();
    const countClass = function (c) {
      return classes.filter(function (cl) { return cl.indexOf(c) !== -1; }).length;
    };
    expect(countClass(TURN)).toBe(47);
    expect(countClass(TURN_MESSAGE)).toBe(94);

    // Ни один узел-обёртка не стал репликой: текст каждой реплики — начало текста
    // реального пузыря (сравнение по первой непустой строке: адаптер нормализует серии \n).
    const bubbleLines = [];
    realBubbles().forEach(function (m) {
      String(S.texts[m.index] || '').split('\n').forEach(function (ln) {
        const t = ln.trim();
        if (t) bubbleLines.push(t);
      });
    });
    expect(bubbleLines.length).toBeGreaterThan(0);
    msgs.forEach(function (m) {
      const first = String(m.content).split('\n')[0].trim();
      expect(first.length).toBeGreaterThan(0);
      expect(bubbleLines).toContain(first);
    });
    // dominantClassSets снимка подтверждают: «победитель» — узлы-обёртки, реплики — токены роли
    const sets = {};
    S.summary.dominantClassSets.forEach(function (d) { sets[d.classSet] = d.nodes; });
    expect(sets[TURN_MESSAGE]).toBe(94);
    expect(sets[TURN]).toBe(47);
    expect(sets[ROLE_USER]).toBe(47);
    expect(sets[ROLE_ASSISTANT]).toBe(47);
  });

  qtest('Q4 (C1): роль каждой реплики ∈ {user, assistant}, обе роли присутствуют', function () {
    buildSnapshotDom();
    const msgs = qwen().Adapter.extractMessages();
    const roles = msgs.map(function (m) { return m.role; });
    roles.forEach(function (r) { expect(['user', 'assistant']).toContain(r); });
    expect(roles.filter(function (r) { return r === 'user'; }).length).toBeGreaterThan(0);
    expect(roles.filter(function (r) { return r === 'assistant'; }).length).toBeGreaterThan(0);
    // снимок: роли объявлены ТОЛЬКО классом (data-* маркеров роли нет)
    expect(S.messages.filter(function (m) { return m.roleMarker === 'attribute'; })).toHaveLength(0);
  });

  qtest('Q5 (C2): многострочные узлы снимка дают многострочный content (перевод строки сохранён)', function () {
    const multiLineIdx = S.texts
      .map(function (t, i) { return { i: i, n: (String(t).match(/\n/g) || []).length }; })
      .filter(function (x) { return x.n > 0; });
    expect(multiLineIdx.length).toBeGreaterThan(0); // 26 узлов снимка

    buildSnapshotDom();
    const msgs = qwen().Adapter.extractMessages();
    let checked = 0;
    multiLineIdx.forEach(function (x) {
      const realText = String(S.texts[x.i] || '');
      const probe = realText.split('\n')[0].trim();
      if (!probe) return;
      const hit = msgs.filter(function (m) { return m.content.indexOf(probe) !== -1; })[0];
      if (!hit) return;
      checked++;
      expect(hit.content).toContain('\n');
    });
    expect(checked).toBeGreaterThan(0);
    // и обратная сторона: адаптер не теряет переводы строк даже в «схлопнутом» виде
    expect(msgs.some(function (m) { return m.content.indexOf('\n') !== -1; })).toBe(true);
  });

  qtest('Q6: 48 панелей размышлений уходят в hiddenReasoning, а не в content', function () {
    const bubbles = buildSnapshotDom();
    const msgs = qwen().Adapter.extractMessages();
    const withThinking = bubbles.filter(function (b) { return b.hasThinking; });

    expect(S.summary.thinkingPanelsFound).toBe(48);
    expect(S.summary.thinkingInsideCount).toBe(140);
    expect(S.summary.thinkingOutsideCount).toBe(0);
    expect(withThinking.length).toBeGreaterThan(0);

    const hidden = msgs.filter(function (m) { return typeof m.hiddenReasoning === 'string' && m.hiddenReasoning.length > 0; });
    expect(hidden.length).toBeGreaterThan(0);
    hidden.forEach(function (m) {
      expect(m.content.indexOf('Завершено размышление')).toBe(-1);
      expect(m.hiddenReasoning.indexOf('Завершено размышление')).toBe(-1); // шапка снимается
      expect(m.hiddenReasoning).toContain('Панель размышлений реплики');
    });
    // панель не подмешана в текст ни одной реплики
    msgs.forEach(function (m) {
      expect(m.content.indexOf('Панель размышлений реплики')).toBe(-1);
    });
  });

  qtest('Q7 (невакуумный): реплики есть, и обе роли в наличии — заглушка не закрывает контракт молча', function () {
    buildSnapshotDom();
    const res = qwen();
    const msgs = res.Adapter.extractMessages();
    expect(msgs.length).toBeGreaterThan(0);
    const roles = msgs.reduce(function (acc, m) { acc[m.role] = (acc[m.role] || 0) + 1; return acc; }, {});
    expect(roles.user).toBeGreaterThan(0);
    expect(roles.assistant).toBeGreaterThan(0);
    // вся реальная база непуста
    msgs.forEach(function (m) { expect(String(m.content).trim().length).toBeGreaterThan(0); });
    // диагностический путь не был пройден «вслепую»
    expect(res.sandbox.errors.filter(function (e) { return !e.soft; })).toHaveLength(0);
  });
});
