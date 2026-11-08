/** @jest-environment node */
/**
 * Firefox: потеря последнего сообщения при экспорте — LIVE-ANSWER-EMPTY.
 *
 * ЖИВОЙ ДЕФЕКТ: в Firefox live-ход финализируется с ПУСТЫМ answer (гонка пустого ответа:
 * поток завершился раньше, чем пришёл текст), при этом сетевой снимок истории этот текст
 * несёт. per-turn выбор в exportComposeTurns брал live по ДЛИНЕ текста: live-текст, собранный
 * из одной секции [REASONING] (reasoning + пустой [ANSWER]), длиннее сетевого ответа →
 * вердикт LIVE-EXTRA → `t.text = lv.text; t.answer = lv.answer;` затирал сетевой ответ
 * пустой строкой. В файл уезжал пустой ход, т.е. последнее сообщение терялось.
 *
 * ПРАВИЛО (шаг 1): если live-ход несёт пустой answer а сетевой ход — НЕПУСТОЙ answer, сетевой
 * текст хода НЕ затирается; случай учитывается собственным вердиктом LIVE-ANSWER-EMPTY
 * (diagVerdict при этом не зовётся — вердикт относится к паре полей answer, а не к текстам).
 *
 * Стенд: РЕАЛЬНЫЙ core/deepseek-netsync.js в vm-песочнице, probe-ядро повторяет имена
 * контракта __bind, которые читает exportComposeTurns (turnsMap/liveTurns/liveTurnOrder/
 * orderCounter/netSyncStats + diagVerdict). Тела модуля — BIND-зона (`with (D)`), поэтому
 * песочница даёт все глобусы, которые они зовут.
 */

const vm = require('vm');

const DS = require('./helpers/deepseek-intercept-source.js');
const MODULE_SRC = DS.moduleSource('deepseek-netsync.js');

const NET_TEXT = 'Сетевой ответ: последнее сообщение сохранилось.';
// live-ход без ответа: размышление + пустая часть [ANSWER] — ровно форма composeTurnText,
// когда стрим отдал reasoning, но текст ответа не пришёл (Firefox-гонка).
const LIVE_EMPTY_ANSWER_TEXT = '[REASONING]\nдлинная цепочка размышлений, которая длиннее ответа сети\n\n[ANSWER]\n';

function makeSandbox() {
  const logs = [];
  const listeners = {};
  const sandbox = {
    console: {
      log: function () { logs.push(Array.prototype.map.call(arguments, String).join(' ')); },
      warn: function () { logs.push('WARN ' + Array.prototype.map.call(arguments, String).join(' ')); },
      error: function () { logs.push('ERR ' + Array.prototype.map.call(arguments, String).join(' ')); }
    },
    Math: Math, JSON: JSON, Object: Object, Array: Array, String: String, Number: Number,
    Boolean: Boolean, RegExp: RegExp, Error: Error, Promise: Promise, Date: Date,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    CustomEvent: function (n, o) { this.type = n; this.detail = (o || {}).detail; },
    addEventListener: function (name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    dispatchEvent: function () { return true; },
    // молчаливые catch модуля (Step E.2a.1) — в норме не зовутся, но обязаны существовать
    swallowSoft: function () { },
    swallow: function () { }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return { sandbox: sandbox, logs: logs, listeners: listeners };
}

/**
 * Стенд одной композиции: реальный модуль + probe-ядро с заданными turnsMap/liveTurns.
 * diagVerdict повторяет реальную классификацию «длиннее побеждает»: live длиннее → LIVE-EXTRA
 * (именно этот вердикт в живом дефекте затирал сетевой ответ).
 */
function compose(turnsMap, liveTurns) {
  const box = makeSandbox();
  vm.runInContext(MODULE_SRC, box.sandbox, { filename: 'core/deepseek-netsync.js' });
  const Fn = box.sandbox.AiCmDeepseekNetsync;
  expect(typeof Fn.__bind).toBe('function');

  const calls = { verdict: 0 };
  const st = {
    turnsMap: turnsMap,
    liveTurns: liveTurns,
    liveTurnOrder: Object.keys(liveTurns),
    orderCounter: 100,
    netSyncStats: { calls: 0, fetched: 0, ok: 0, fresh: 0, empty: 0, failed: 0, timeout: 0, oneSide: 0 }
  };
  const D = {
    // живые имена контракта, которые читает exportComposeTurns (BIND-зона, with (D))
    turnsMap: st.turnsMap,
    liveTurns: st.liveTurns,
    liveTurnOrder: st.liveTurnOrder,
    orderCounter: st.orderCounter,
    netSyncStats: st.netSyncStats,
    diagVerdict: function (lt, nt) {
      calls.verdict++;
      if (String(lt) === String(nt)) return { verdict: 'EQUAL' };
      if (String(lt).length > String(nt).length) return { verdict: 'LIVE-EXTRA' };
      return { verdict: 'TAIL-CUT' };
    },
    // остальные имена контракта exportComposeTurns не читает, но связка их объявляет
    diagMark: function () { }, diagOn: function () { return false; },
    diagHistRecord: function () { }, emitBaseSnapshot: function () { },
    ingestHistory: function () { }, historyRefetchUrl: function () { return ''; },
    getConvId: function () { return 'conv12345678'; }
  };
  Fn.__bind(D);
  const verdicts = Fn.exportComposeTurns();
  return { verdicts: verdicts, st: st, calls: calls, logs: box.logs };
}

const netTurn = (text, extra) => Object.assign({
  text: text, answer: text, reasoning: '', order: 1, ts: 1, role: 'assistant'
}, extra || {});

const liveTurn = (text, answer, extra) => Object.assign({
  text: text, answer: answer, reasoning: '', modelSlug: '', ts: 2, role: 'assistant'
}, extra || {});

describe('O-18/Firefox: LIVE-ANSWER-EMPTY — пустой live-answer не затирает сетевой ответ', () => {
  test('live answer "" + непустой сетевой ответ → побеждает СЕТЬ, вердикт LIVE-ANSWER-EMPTY', () => {
    // live-текст ДЛИННЕЕ сети (reasoning + пустой [ANSWER]) — под старым правилом это LIVE-EXTRA
    expect(LIVE_EMPTY_ANSWER_TEXT.length).toBeGreaterThan(NET_TEXT.length);
    const box = compose(
      { m1: netTurn(NET_TEXT, { modelSlug: 'deepseek-chat' }) },
      { m1: liveTurn(LIVE_EMPTY_ANSWER_TEXT, '') }
    );
    const t = box.st.turnsMap.m1;
    // сетевой текст и ответ НЕ затёрты пустым live-answer
    expect(t.text).toBe(NET_TEXT);
    expect(t.answer).toBe(NET_TEXT);
    expect(t.reasoning).toBe('');
    expect(t.modelSlug).toBe('deepseek-chat');
    // вердикт — собственный, diagVerdict по этому ходу не звался
    expect(box.verdicts).toEqual({ 'LIVE-ANSWER-EMPTY': 1 });
    expect(box.calls.verdict).toBe(0);
    // диаг-строка несёт маркер вердикта
    expect(box.logs.join('\n')).toContain('LIVE-ANSWER-EMPTY');
  });

  test('контроль: непустой live-answer — прежний путь (live длиннее → LIVE-EXTRA, live побеждает)', () => {
    const liveText = 'Живой ответ, которого нет в сети, — он заметно длиннее сетевого.';
    expect(liveText.length).toBeGreaterThan(NET_TEXT.length);
    const box = compose(
      { m1: netTurn(NET_TEXT) },
      { m1: liveTurn(liveText, liveText) }
    );
    const t = box.st.turnsMap.m1;
    expect(t.text).toBe(liveText);
    expect(t.answer).toBe(liveText);
    expect(box.verdicts).toEqual({ 'LIVE-EXTRA': 1 });
    expect(box.calls.verdict).toBe(1);
  });

  test('контроль: пустой live-answer и ПУСТОЙ сетевой ответ — правило не срабатывает', () => {
    const box = compose(
      { m1: netTurn(LIVE_EMPTY_ANSWER_TEXT, { answer: '' }) },
      { m1: liveTurn(LIVE_EMPTY_ANSWER_TEXT, '') }
    );
    expect(box.verdicts).toEqual({ EQUAL: 1 });
    expect(box.calls.verdict).toBe(1);
    expect(box.st.turnsMap.m1.text).toBe(LIVE_EMPTY_ANSWER_TEXT);
  });

  test('контроль: оба answer непустые — правило не срабатывает, live-длиннее побеждает', () => {
    const liveText = 'Живой текст, который длиннее сети, а ответ непустой.';
    const box = compose(
      { m1: netTurn('Сеть с ответом', { answer: 'сетевой-answer' }) },
      { m1: liveTurn(liveText, 'живой-answer') }
    );
    expect(box.verdicts).toEqual({ 'LIVE-EXTRA': 1 });
    expect(box.calls.verdict).toBe(1);
    expect(box.st.turnsMap.m1.text).toBe(liveText);
    expect(box.st.turnsMap.m1.answer).toBe('живой-answer');
  });

  test('per-turn: пустой live-answer одного хода не отключает выбор для остальных ходов', () => {
    const box = compose(
      {
        broken: netTurn(NET_TEXT),
        fine: netTurn('короткий сетевой текст')
      },
      {
        broken: liveTurn(LIVE_EMPTY_ANSWER_TEXT, ''),
        fine: liveTurn('живой текст, который длиннее сети', 'живой текст, который длиннее сети')
      }
    );
    expect(box.st.turnsMap.broken.text).toBe(NET_TEXT);
    expect(box.st.turnsMap.fine.text).toBe('живой текст, который длиннее сети');
    expect(box.verdicts).toEqual({ 'LIVE-ANSWER-EMPTY': 1, 'LIVE-EXTRA': 1 });
    expect(box.calls.verdict).toBe(1);
  });

  test('пробельный сетевой answer ответом не считается — LIVE-ANSWER-EMPTY не бумпается', () => {
    const box = compose(
      { m1: netTurn('короткий текст', { answer: '   ' }) },
      { m1: liveTurn(LIVE_EMPTY_ANSWER_TEXT, '') }
    );
    // сеть пуста по answer → обычный путь; live-текст длиннее → LIVE-EXTRA
    expect(box.verdicts).toEqual({ 'LIVE-EXTRA': 1 });
    expect(box.st.turnsMap.m1.answer).toBe('');
  });

  test('пробельный live-answer тоже считается пустым — сеть сохраняется', () => {
    const box = compose(
      { m1: netTurn(NET_TEXT) },
      { m1: liveTurn(LIVE_EMPTY_ANSWER_TEXT, '   ') }
    );
    expect(box.verdicts).toEqual({ 'LIVE-ANSWER-EMPTY': 1 });
    expect(box.st.turnsMap.m1.answer).toBe(NET_TEXT);
  });
});
