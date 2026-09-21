/**
 * O-35 (инспекция 2026-09-19, пункты C/D/B/A): ПИНЫ ГЕЙТ-ИЗМЕРЕНИЯ И МЕХАНИЗМОВ.
 *
 * Здесь ровно две группы:
 *   1) РАНТАЙМ (реальные core/qwen-intercept.js + utils/stream-frames.js на jsdom-стенде,
 *      реальный core/widget.js updateWidget): строки qwen-sse / qwen-spa / qwen-badge
 *      печатаются ТОЛЬКО под гейтом aiCmDebug, идут через канон utils/debug.js:aiCmDiagLine
 *      и НЕ меняют байты выхода (G1/G2);
 *   2) SOURCE-ПИНЫ механизмов, чтобы вердикты отчёта были привязаны к строкам:
 *      C — хук смены разговора у qwen диспатчит ai-cm-conversation-changed, а ISOLATED
 *          слушатель реактивирует контур (адаптерный пересъём базы) БЕЗ F5;
 *      D — «—» рисуется веткой stale ТОЛЬКО при отсутствии базы; при базе адаптера число
 *          сохранено, stale отмечен меткой в тултипе (D1); числа попапа живут снимком aiCmState;
 *      B — цепочка usage → detail.serverTokens → netServerTokens → бейдж; qwenUsage
 *          (reasoning/output) имеет потребителя в тултипе, метка «Источник» честна для
 *          adapter-базы (B1/B2);
 *      A — каждая запись истории qwen печатает msgs/convId/URL (артефакт вердикта).
 *
 * ПИНЫ ДЕФЕКТОВ, ФЛИПНУТЫЕ ФИКСАМИ (C: dispatched=1 + реактивация, B: потребитель qwenUsage,
 * D: «—» только без базы) — помечены ниже словами «ФЛИП ФИКСА».
 */

const fs = require('fs');
const path = require('path');
const { TextEncoder } = require('util');
const H = require('./helpers/content-source.js');

const ROOT = path.join(__dirname, '..');
const CONTENT = H.contentSource;
const WIDGET_SRC = H.moduleSource('core/widget.js');
const BASE_HANDLER_SRC = H.moduleSource('core/base-handler.js');
const INTERCEPT_SRC = fs.readFileSync(path.join(ROOT, 'core', 'qwen-intercept.js'), 'utf8');
const STREAM_FRAMES_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'stream-frames.js'), 'utf8');
const DEBUG_SRC = fs.readFileSync(path.join(ROOT, 'utils', 'debug.js'), 'utf8');
const OPTIONS_SRC = fs.readFileSync(path.join(ROOT, 'options', 'options.js'), 'utf8');
const ADAPTER_SRC = fs.readFileSync(path.join(ROOT, 'adapters', 'qwen-adapter.js'), 'utf8');
// ru-словарь M-4.2: песочницы виджета получают ТОЧНО ТУ ЖЕ подстановку, что chrome.i18n
// в браузере (иначе строки тултипа проверялись бы по фолбэку без подстановок).
const RU_MESSAGES = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', 'ru', 'messages.json'), 'utf8'));
function i18nMock(key, fallback, substitutions) {
  const rec = RU_MESSAGES[key];
  const tpl = (rec && rec.message) ? rec.message : String(fallback);
  if (!substitutions) return tpl;
  return String(tpl).replace(/\$(\d)/g, function (m, d) {
    const v = substitutions[Number(d) - 1];
    return (v === undefined || v === null) ? m : String(v);
  });
}

// Рез по балансу фигурных скобок (стиль tests/chatgpt-o1-badge-hold.test.js).
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

const DIAG_PREFIX = '[AI CM][diag] qwen-';
const CHAT_ID = 'cda86f26-0155-4243-a134-777d909a936b';
const OTHER_CHAT_ID = 'be4e7956-0000-1111-2222-333333333333';
const THIRD_CHAT_ID = 'aaaabbbb-0000-1111-2222-333333333333';
const URL_QWEN = 'https://chat.qwen.ai/api/v2/chat/completions?chat_id=' + CHAT_ID;
const USAGE = { input_tokens: 1709, output_tokens: 884, total_tokens: 2593, output_tokens_details: { reasoning_tokens: 884 } };

function sseFrames(withUsage) {
  const frames = [{ 'response.created': { chat_id: CHAT_ID, parent_id: 'p-1', response_id: 'r-1', response_index: '0' } }];
  frames.push({ choices: [{ delta: { role: 'assistant', content: 'Привет!', phase: 'answer', status: 'typing' } }], response_id: 'r-1' });
  if (withUsage !== false) {
    frames.push({ choices: [{ delta: { role: 'assistant', content: '', phase: 'answer', status: 'finished' } }], response_id: 'r-1', usage: USAGE });
  }
  return frames;
}

function sseBody(frames) {
  return frames.map(function (f) { return 'data: ' + JSON.stringify(f) + '\n\n'; }).join('') + 'data: [DONE]\n\n';
}

function makeResponse(body) {
  const enc = new TextEncoder();
  const chunks = [];
  for (let i = 0; i < body.length; i += 11) chunks.push(enc.encode(body.slice(i, i + 11)));
  return {
    ok: true,
    status: 200,
    headers: { get: function (n) { return n === 'content-type' ? 'text/event-stream' : null; } },
    body: {
      getReader: function () {
        let i = 0;
        return { read: function () { return Promise.resolve(i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }); } };
      }
    },
    clone: function () { return makeResponse(body); }
  };
}

function settle(rounds) {
  let p = Promise.resolve();
  for (let i = 0; i < (rounds || 6); i++) {
    p = p.then(function () { return new Promise(function (r) { setTimeout(r, 0); }); });
  }
  return p;
}

/** Стенд MAIN-мира: реальные utils + реальный перехватчик, «сервер» — подменённый fetch. */
function installStand(opts) {
  const o = opts || {};
  new Function('window', 'self', DEBUG_SRC)(window, window);
  new Function('window', 'self', STREAM_FRAMES_SRC)(window, window);

  const events = [];
  window.addEventListener('ai-cm-full-history', function (ev) { events.push(ev.detail); });
  window.fetch = function () { return Promise.resolve(makeResponse(sseBody(sseFrames(o.withUsage)))); };

  jest.spyOn(console, 'log').mockImplementation(function () { });
  jest.spyOn(console, 'warn').mockImplementation(function () { });

  delete window.__aiCmQwenInterceptInstalled;
  new Function(INTERCEPT_SRC)();
  return { events: events };
}

async function runTurn() {
  const body = JSON.stringify({ model: 'qwen3.8-max', messages: [{ role: 'user', fid: 'f-1', content: 'привет' }] });
  await window.fetch(URL_QWEN, { method: 'POST', body: body });
  await settle(8);
}

function diagLines() {
  const spy = console.log;
  if (!spy || !spy.mock || !spy.mock.calls) return [];
  return spy.mock.calls.map(function (a) { return String(a[0]); })
    .filter(function (s) { return s.indexOf(DIAG_PREFIX) === 0; });
}

/** Строка с данным тегом и event= (порядок полей в строке: ts идёт первым). */
function diagLine(tag, event) {
  return diagLines().filter(function (s) {
    return s.indexOf('[AI CM][diag] ' + tag + ' ') === 0 && s.indexOf('event=' + event) !== -1;
  })[0];
}

beforeAll(function () {
  window.history.replaceState({}, '', '/c/' + CHAT_ID);
});

beforeEach(function () {
  try { sessionStorage.removeItem('aiCmDebug'); } catch (e) { }
});

afterEach(function () {
  jest.restoreAllMocks();
  try { delete window.aiCmDiagLine; } catch (e) { }
  try { sessionStorage.removeItem('aiCmDebug'); } catch (e) { }
});

// =====================================================================================
// G1/G2: гейт выключен — ни строки; гейт включён — строки есть; байты выхода те же
// =====================================================================================
describe('O-35 G1/G2: строки qwen-sse/spa печатаются только под гейтом и не меняют байты', function () {
  test('G1: гейт выключен → ни одной строки, снимок публикуется', async function () {
    const st = installStand({});
    await runTurn();
    expect(st.events).toHaveLength(1);
    expect(diagLines()).toEqual([]);
  });

  test('G1: гейт включён → qwen-sse url-match / stream-end / emit с usage и serverTokens', async function () {
    sessionStorage.setItem('aiCmDebug', '1');
    const st = installStand({});
    await runTurn();
    const joined = diagLines().join('\n');
    expect(joined).toContain('qwen-sse ts=');
    expect(diagLine('qwen-sse', 'url-match')).toBeTruthy();
    expect(diagLine('qwen-sse', 'url-match')).toContain('url=' + URL_QWEN);
    const end = diagLine('qwen-sse', 'stream-end');
    expect(end).toContain('frames=3');
    expect(end).toContain('usageFrames=1');
    expect(end).toContain('hasUsage=1');
    expect(end).toContain('serverTokens=1709');
    const em = diagLine('qwen-sse', 'emit');
    expect(em).toContain('serverTokens=1709');
    expect(em).toContain('reasoningTokens=884');
    expect(em).toContain('convId=' + CHAT_ID);
    // число из строки = число в снимке (usage дошёл до detail без потерь)
    expect(st.events[0].serverTokens).toBe(1709);
  });

  test('B: поток БЕЗ usage → hasUsage=0 и serverTokens=0 (оценка токенизатора ниже по цепочке)', async function () {
    sessionStorage.setItem('aiCmDebug', '1');
    installStand({ withUsage: false });
    await runTurn();
    expect(diagLines().join('\n')).toContain('hasUsage=0');
    expect(diagLines().join('\n')).toContain('serverTokens=0');
  });

  test('G2: байты выхода (detail) при гейте вкл/выкл идентичны', async function () {
    const off = installStand({});
    await runTurn();
    const offDetail = JSON.parse(JSON.stringify(off.events[0]));
    expect(diagLines()).toEqual([]);
    jest.restoreAllMocks();

    sessionStorage.setItem('aiCmDebug', '1');
    const on = installStand({});
    await runTurn();
    const onDetail = JSON.parse(JSON.stringify(on.events[0]));
    expect(diagLines().length).toBeGreaterThan(0);
    expect(onDetail).toEqual(offDetail);
    expect(onDetail.text).toBe(offDetail.text);
    expect(onDetail.serverTokens).toBe(offDetail.serverTokens);
  });

  test('канон: строки уходят через utils/debug.js:aiCmDiagLine (MAIN-мир), формат не дублируется', async function () {
    sessionStorage.setItem('aiCmDebug', '1');
    const canon = [];
    window.aiCmDiagLine = function (tag, fields) { canon.push({ tag: tag, fields: fields }); };
    installStand({});
    await runTurn();
    const tags = canon.map(function (c) { return c.tag; });
    expect(tags).toContain('qwen-sse');
    // исторические теги перехватчика сохранили прежний вид 'qwen-<tag>'
    expect(tags).toContain('qwen-stream-end');
    expect(tags).toContain('qwen-installed');
    const emit = canon.filter(function (c) { return c.tag === 'qwen-sse' && c.fields.event === 'emit'; })[0];
    expect(emit).toBeTruthy();
    expect(emit.fields.serverTokens).toBe(1709);
    expect(emit.fields.url).toContain(URL_QWEN);
    // через канон печатает ТОЛЬКО он: собственных console.log со строкой diag нет
    expect(diagLines()).toEqual([]);
  });
});

// =====================================================================================
// C: qwen-spa — смена разговора транслируется в ISOLATED, контур поднимается без F5
// =====================================================================================
describe('O-35 C: qwen-spa — событие смены разговора доходит до ISOLATED и реактивирует контур', function () {
  test('ФЛИП ФИКСА C: qwen-spa: chat-change печатает from/to/convId/url и dispatched=1', function () {
    sessionStorage.setItem('aiCmDebug', '1');
    installStand({});
    window.history.pushState({}, '', '/c/' + OTHER_CHAT_ID);
    const line = diagLine('qwen-spa', 'chat-change');
    expect(line).toBeTruthy();
    expect(line).toContain('from=' + CHAT_ID.slice(0, 8));
    expect(line).toContain('to=' + OTHER_CHAT_ID.slice(0, 8));
    expect(line).toContain('convId=' + OTHER_CHAT_ID);
    expect(line).toContain('reset=1');
    expect(line).toContain('dispatched=1');
    expect(line).toContain('url=');
  });

  test('ФЛИП ФИКСА C: checkChatChange ДИСПАТЧИТ ai-cm-conversation-changed (форма как у шести)', function () {
    sessionStorage.setItem('aiCmDebug', '1');
    installStand({});
    const seen = [];
    window.addEventListener('ai-cm-conversation-changed', function (ev) { seen.push(ev); });
    // свой id: тест не зависит от навигации соседних тестов (ранний выход при том же convId)
    window.history.pushState({}, '', '/c/' + THIRD_CHAT_ID);
    // стенд ставит перехватчик заново на каждый installStand (обёртки pushState стекаются),
    // поэтому считаем ФАКТ трансляции, а не ровно один вызов: dispatched=1 пинуется выше
    expect(seen.length).toBeGreaterThan(0);
    // состояние перехватчика всё так же сброшено, и форма вызова — та же строка, что у шести
    const body = fnDecl(INTERCEPT_SRC, 'checkChatChange');
    expect(body).toContain('turns = [];');
    expect(body).toContain("window.dispatchEvent(new CustomEvent('ai-cm-conversation-changed'))");
    // dispatched=1 в строке не «пришит» литералом: он отражает факт диспатча
    expect(body).toContain('var dispatched = 0;');
    // G2 (байты): событие без detail — трансляция не может изменить ни detail снимка,
    // ни байты экспорта (форма ровно как у шести существующих перехватчиков)
    expect(body).not.toContain("new CustomEvent('ai-cm-conversation-changed', {");
  });

  test('C: у шести существующих перехватчиков dispatch на месте (R-пин регресс-поверхности)', function () {
    ['core/page-intercept.js', 'core/gemini-intercept.js', 'core/deepseek-intercept.js',
      'core/claude-intercept.js', 'core/perplexity-intercept.js'].forEach(function (rel) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(src).toContain("window.dispatchEvent(new CustomEvent('ai-cm-conversation-changed'))");
    });
  });

  test('C: ISOLATED-слушатель на событие делает полный сброс и запускает реактивацию qwen', function () {
    const iL = CONTENT.indexOf("window.addEventListener('ai-cm-conversation-changed'");
    expect(iL).toBeGreaterThan(-1);
    const listener = CONTENT.slice(iL, CONTENT.indexOf('// v30.8: сигнал лоадера', iL));
    expect(listener).toContain('resetConversationState();');
    expect(listener).toContain("chrome.runtime.sendMessage({ type: 'BADGE_RESET' })");
    expect(listener).toContain("aiCmDiagLine('qwen-spa'");
    // ФЛИП ФИКСА C: после сброса — адаптерный пересъём базы нового convId (без F5)
    expect(listener).toContain('aiCmQwenSpaReshoot();');
    expect(listener.indexOf('aiCmQwenSpaReshoot();')).toBeGreaterThan(listener.indexOf('resetConversationState();'));
    // строка реактивации — под тем же гейтом и с тем же тегом qwen-spa
    expect(listener).toContain("event: 'reshoot'");
    // метка времени сброса объявлена рядом с трекером convId (виджет/адаптер читают её)
    expect(CONTENT).toContain('var aiCmQwenSpaResetAt = 0;');
  });

  test('C: resetConversationState обнуляет базу/pct старого чата и ставит «—»', function () {
    const reset = WIDGET_SRC.slice(WIDGET_SRC.indexOf('function resetConversationState('));
    expect(reset).toContain('baseSeen = false;');
    expect(reset).toContain('maxTokenCount = 0;');
    expect(reset).toContain("netServerTokens = 0;");
    expect(reset).toContain("if (pt) pt.textContent = '—';");
    expect(reset).toContain('badgeSuppressed = true;');
  });

  test('C: адаптерный пересъём qwen — реальная aiCmQwenSpaReshoot (песочница + фейковые таймеры)', function () {
    jest.useFakeTimers();
    function runReshoot(opts) {
      const o = opts || {};
      const calls = { detect: 0, init: 0, send: 0 };
      const ctx = {
        window: window,
        currentAdapter: { siteName: o.site || 'qwen' },
        isInitialized: !!o.initialized,
        aiCmAssignAdapterByHost: function () { calls.detect++; },
        tryInit: function () { calls.init++; if (o.initialized) ctx.isInitialized = true; },
        processAndSend: function () { calls.send++; }
      };
      const fn = new Function('ctx', 'with (ctx) { ' + fnDecl(CONTENT, 'aiCmQwenSpaReshoot') +
        '\n return aiCmQwenSpaReshoot; }')(ctx);
      const ret = fn();
      return { calls: calls, ctx: ctx, ret: ret };
    }
    // контур «спал» (SPA-открытый чат): tryInit + три ретрая, повторный детект адаптера
    const asleep = runReshoot({ initialized: false });
    expect(asleep.ret).toBe(true);
    expect(asleep.calls.detect).toBe(1);
    expect(asleep.calls.init).toBe(1);
    jest.advanceTimersByTime(3000);
    expect(asleep.calls.init).toBe(4);          // 0мс + 500 + 1500 + 3000 (все попытки)
    // контур уже поднят: пересъём базы штатным processAndSend, без лишних tryInit
    const awake = runReshoot({ initialized: true });
    expect(awake.calls.send).toBe(1);
    expect(awake.calls.init).toBe(0);
    // прочие платформы фикс не задевает — реактивации нет вовсе
    const other = runReshoot({ site: 'chatgpt' });
    expect(other.ret).toBe(false);
    expect(other.calls).toEqual({ detect: 0, init: 0, send: 0 });
    jest.useRealTimers();
  });

  test('C: base-write и кнопки ручного экспорта оживают без F5 (цепочка записи базы)', function () {
    const reshoot = fnDecl(CONTENT, 'aiCmQwenSpaReshoot');
    // 1) реактивация зовёт tryInit (он ставит isInitialized и зовёт processAndSend)
    expect(reshoot).toContain('tryInit();');
    expect(reshoot).toContain('processAndSend();');
    const init = fnDecl(CONTENT, 'tryInit');
    expect(init).toContain('isInitialized = true;');
    expect(init).toContain('processAndSend();');
    // 2) адаптерная ветка пишет aiCmHistory ПО НОВОМУ convId текущего документа (F5 не нужен)
    const iAd = CONTENT.indexOf('var cidS24 = getCurrentConvId()');
    expect(iAd).toBeGreaterThan(-1);
    // окно блока — с запасом на комментарий v54 (взвод adapterBaseSeen), ~2.8k символов
    const block = CONTENT.slice(iAd, iAd + 3400);
    expect(block).toContain("history-write source=adapter site=");
    expect(block).toContain("histPatchS24['aiCmHistory:' + window.location.hostname]");
    expect(block).toContain('messages: msgsS24');
    // v54: та же ветка — единственная точка взвода «база принята по convId» (adapter)
    expect(block).toContain('adapterBaseSeen = true;');
    // 3) кнопки ручного экспорта включаются наличием записи aiCmHistory текущего хоста
    expect(OPTIONS_SRC).toContain('var enabled = !!(cachedHistory && cachedHistory.host === currentTabHost);');
    // 4) сброс счётчика адаптерной базы прошлого чата — метка «Источник» не перетекает
    expect(CONTENT).toContain('aiCmAdapterBaseCount = 0;');
  });
});

// =====================================================================================
// D: «—» на бейдже = ветка stale (12с без сетевого снимка), числа попапа — снимок aiCmState
// =====================================================================================
describe('O-35 D: плейсхолдер «—» ставит ветка stale, попап держит числа', function () {
  function runUpdateWidget(opts) {
    const o = opts || {};
    const el = document.createElement('div');
    el.innerHTML = '<div class="ai-widget-fill"></div><div class="ai-widget-text">—</div><div class="ai-widget-tooltip"></div>';
    const ctx = {
      document: document,
      window: window,
      widgetElement: el,
      stale: !!o.stale,
      currentAdapter: { siteName: o.site || 'qwen' },
      location: window.location,
      baseSeen: o.baseSeen === true,
      // D1: база DOM-адаптера (baseCount>0 / lastBaseTexts.length>0) — вход ветки «число не стираем»
      baseCount: o.baseCount,
      lastBaseTexts: o.lastBaseTexts || [],
      // O-35 (v54): третий вход D1 — «база принята по convId» для adapter-пути (state.js)
      adapterBaseSeen: o.adapterBaseSeen === true,
      // B1: серверный usage Qwen живёт в общем скоупе контент-скрипта (state.js:netQwenUsage)
      netQwenUsage: o.qwenUsage || null,
      getCurrentConvId: function () { return OTHER_CHAT_ID; },
      zoneColor: function () { return '#000'; },
      aiCmRefreshThemeIfNeeded: function () { },
      aiCmUpdateSourceIndicator: function () { },
      aiCmRevealWidget: function () { },
      aiCmActivePct: function () { return null; },
      aiCmSourceLabelNow: o.label || '',
      aiCmI18nMessage: i18nMock,
      debugLog: function () { }
    };
    const scope = 'with (ctx) { ' + fnDecl(DEBUG_SRC, 'aiCmDiagOn') + '\n' +
      fnDecl(DEBUG_SRC, 'aiCmDiagLine') + '\n' + fnDecl(WIDGET_SRC, 'updateWidget') +
      '\n return updateWidget; }';
    const fn = new Function('ctx', scope)(ctx);
    // Живые числа скриншота-2 (бейдж-строка 14:49:03.583)
    fn(158.8, 203274, 128000, 128000, 128000, 'Qwen3.8-Max', null, o.qwenUsage || null);
    return { el: el, ctx: ctx };
  }

  test('D: stale=true БЕЗ базы → в подписи «—», и это ТА ЖЕ отрисовка, где напечатан badge-update', function () {
    sessionStorage.setItem('aiCmDebug', '1');
    jest.spyOn(console, 'log').mockImplementation(function () { });
    const r = runUpdateWidget({ stale: true });
    expect(r.el.querySelector('.ai-widget-text').textContent).toBe('—');
    const line = diagLine('qwen-badge', 'placeholder');
    expect(line).toBeTruthy();
    expect(line).toContain('reason=stale');
    expect(line).toContain('pct=158.8');
    expect(line).toContain('tokens=203274');
    expect(line).toContain('baseSeen=0');
    expect(line).toContain('adapterBase=0');
  });

  test('ФЛИП ФИКСА D1: stale=true + база адаптера → число СОХРАНЕНО, «—» нет (живой скрин №2)', function () {
    sessionStorage.setItem('aiCmDebug', '1');
    jest.spyOn(console, 'log').mockImplementation(function () { });
    // живая фактура: бейдж 158.8% / 203274, база адаптера (156 сообщений), сети нет
    const byCount = runUpdateWidget({ stale: true, baseCount: 156, label: 'live (сеть/DOM)' });
    expect(byCount.el.querySelector('.ai-widget-text').textContent).toBe('158.8%');
    expect(diagLine('qwen-badge', 'placeholder')).toBeUndefined();   // подмены числа нет — нет и строки
    // неполнота источника помечена меткой в ТУЛТИПЕ (D1), метка ASCII — новых ru-литералов нет
    expect(byCount.el.querySelector('.ai-widget-tooltip').textContent).toContain('Источник: live (сеть/DOM) · stale');
    // тот же вход через lastBaseTexts (второе условие D1)
    const byTexts = runUpdateWidget({ stale: true, lastBaseTexts: ['a', 'b'], label: 'live (сеть/DOM)' });
    expect(byTexts.el.querySelector('.ai-widget-text').textContent).toBe('158.8%');
    // stale=false → метки нет вовсе (строка источника байтово прежняя)
    const fresh = runUpdateWidget({ stale: false, baseCount: 156, label: 'live (сеть/DOM)' });
    expect(fresh.el.querySelector('.ai-widget-tooltip').textContent).toContain('Источник: live (сеть/DOM)');
    expect(fresh.el.querySelector('.ai-widget-tooltip').textContent).not.toContain(' · stale');
    // без stale-условия (stale=false) и без базы (stale=true) — метки тоже нет
    const noLabel = runUpdateWidget({ stale: true });
    expect(noLabel.el.querySelector('.ai-widget-tooltip').textContent).not.toContain(' · stale');
  });

  test('B1/G2: строки reasoning и output из qwenUsage — реальный тултип, гейт байты не меняет', function () {
    // живой usage «привет» (input 1709 / output 884 / reasoning 884; output ВКЛЮЧАЕТ reasoning)
    const usage = { inputTokens: 1709, outputTokens: 884, totalTokens: 2593, reasoningTokens: 884, cachedTokens: 0 };
    jest.spyOn(console, 'log').mockImplementation(function () { });
    const off = runUpdateWidget({ stale: false, qwenUsage: usage });
    const offText = off.el.querySelector('.ai-widget-tooltip').textContent;
    expect(offText).toContain('Токены: output 884');
    expect(offText).toContain('Токены: reasoning 884');
    expect(diagLines()).toEqual([]);                       // гейт выключен — ни строки
    sessionStorage.setItem('aiCmDebug', '1');
    const on = runUpdateWidget({ stale: false, qwenUsage: usage });
    expect(on.el.textContent).toBe(off.el.textContent);    // G2: байты тултипа те же
    // нет usage (шесть прежних платформ / стрим без кадра usage) → строк нет вовсе
    jest.restoreAllMocks();
    jest.spyOn(console, 'log').mockImplementation(function () { });
    const none = runUpdateWidget({ stale: false });
    expect(none.el.querySelector('.ai-widget-tooltip').textContent).not.toContain('output');
    expect(none.el.querySelector('.ai-widget-tooltip').textContent).not.toContain('reasoning');
  });

  test('D: stale=false → процент в подписи, строки-плейсхолдера нет', function () {
    sessionStorage.setItem('aiCmDebug', '1');
    jest.spyOn(console, 'log').mockImplementation(function () { });
    const r = runUpdateWidget({ stale: false });
    expect(r.el.querySelector('.ai-widget-text').textContent).toBe('158.8%');
    expect(diagLine('qwen-badge', 'placeholder')).toBeUndefined();
  });

  test('D/G2: гейт выключен → ни строки, DOM виджета байтово тот же (обе ветки stale)', function () {
    jest.spyOn(console, 'log').mockImplementation(function () { });
    const off = runUpdateWidget({ stale: true });
    expect(diagLines()).toEqual([]);
    sessionStorage.setItem('aiCmDebug', '1');
    const on = runUpdateWidget({ stale: true });
    expect(on.el.textContent).toBe(off.el.textContent);
    expect(on.el.querySelector('.ai-widget-text').textContent).toBe('—');
    expect(diagLine('qwen-badge', 'placeholder')).toBeTruthy();
    // G2 на НОВОЙ ветке D1 (stale + база адаптера): байты DOM при гейте вкл/выкл идентичны
    jest.restoreAllMocks();
    jest.spyOn(console, 'log').mockImplementation(function () { });
    sessionStorage.removeItem('aiCmDebug');
    const offD1 = runUpdateWidget({ stale: true, baseCount: 156, label: 'live (сеть/DOM)' });
    expect(diagLines()).toEqual([]);
    sessionStorage.setItem('aiCmDebug', '1');
    const onD1 = runUpdateWidget({ stale: true, baseCount: 156, label: 'live (сеть/DOM)' });
    expect(onD1.el.textContent).toBe(offD1.el.textContent);
    expect(onD1.el.querySelector('.ai-widget-text').textContent).toBe('158.8%');
    expect(diagLine('qwen-badge', 'placeholder')).toBeUndefined();
  });

  test('D: щит O-1 — только chatgpt, на qwen он не срабатывает (не он ставит «—»)', function () {
    expect(fnDecl(CONTENT, 'aiCmBadgeHoldActive')).toContain("currentAdapter.siteName !== 'chatgpt'");
    // второй путь «—» (ветка RESET) на qwen — тот же сигнал смены разговора (фикс C его доставляет)
    expect(WIDGET_SRC).toContain("reason: 'reset-conversation'");
  });

  test('D: механизм stale — 12с без сетевого снимка при сообщениях в DOM', function () {
    const sched = fnDecl(BASE_HANDLER_SRC, 'scheduleStaleCheck');
    expect(sched).toContain('if (isInitialized && !baseSeen) {');
    expect(sched).toContain('stale = true;');
    expect(sched).toContain('processAndSend();');
    expect(BASE_HANDLER_SRC).toContain('}, 12000);');
    expect(CONTENT).toContain('scheduleStaleCheck(); // фиксируем момент загрузки страницы для 12с-проверки');
    // ФЛИП ФИКСА D1: «—» ставит ТОЛЬКО stale при отсутствии базы (число при базе адаптера цело)
    expect(WIDGET_SRC).toContain("var aiCmStalePlaceholder = (stale === true) && !aiCmAdapterBasePresent;");
    expect(WIDGET_SRC).toContain("percentText.textContent = aiCmStalePlaceholder ? '—' : (percentage.toFixed(1) + '%');");
    // вход ветки — ровно три условия базы адаптера (v54: третье — признак «база принята
    // по convId» адаптерной записью, он же отпускает SPA-супрессию в content.js)
    expect(WIDGET_SRC).toContain('var aiCmAdapterBasePresent = ((typeof baseCount === \'number\' && baseCount > 0) ||');
    expect(WIDGET_SRC).toContain('(typeof lastBaseTexts !== \'undefined\' && lastBaseTexts && lastBaseTexts.length > 0) ||');
    expect(WIDGET_SRC).toContain('(typeof adapterBaseSeen !== \'undefined\' && adapterBaseSeen === true));');
    // норма stale зафиксирована комментарием на трёх точках (D1)
    expect(fs.readFileSync(path.join(ROOT, 'core', 'state.js'), 'utf8')).toContain('систематичен');
    expect(BASE_HANDLER_SRC).toContain('СИСТЕМАТИЧЕСКОЕ');
    expect(WIDGET_SRC).toContain('систематическое состояние');
  });

  test('D/B2: попап держит числа, метка источника честна для базы адаптера (ФЛИП ФИКСА B2)', function () {
    // снимок для попапа (content.js) — tokens/percent и sourceLabel из aiCmSourceInfo
    expect(CONTENT).toContain('var statePatch = { aiCmState: stateSnapshot };');
    expect(CONTENT).toContain("statePatch['aiCmState:' + window.location.hostname] = stateSnapshot;");
    // aiCmSourceInfo: сеть → live; база DOM-адаптера (baseSeen=false, msgs>0) → тот же live,
    // а не «—»; данных нет вовсе → прежний null
    const info = fnDecl(CONTENT, 'aiCmSourceInfo');
    expect(info).toContain("if (baseSeen) return { kind: 'live'");
    expect(info).toContain('if (aiCmAdapterBaseSeen()) return { kind: \'live\'');
    expect(info).toContain('return null;');
    // реальная функция в песочнице: три вердикта
    function runSourceInfo(state) {
      const ctx = {
        getCurrentConvId: function () { return OTHER_CHAT_ID; },
        aiCmConvSourceByConv: {},
        baseSeen: !!state.baseSeen,
        baseCount: state.baseCount || 0,
        lastBaseTexts: state.lastBaseTexts || [],
        aiCmAdapterBaseCount: state.adapterCount || 0,
        aiCmI18nMessage: function (k, f) { return f; }
      };
      const fn = new Function('ctx', 'with (ctx) { ' + fnDecl(CONTENT, 'aiCmAdapterBaseSeen') + '\n' +
        fnDecl(CONTENT, 'aiCmSourceInfo') + '\n return aiCmSourceInfo; }')(ctx);
      return fn();
    }
    expect(runSourceInfo({ baseSeen: true })).toEqual({ kind: 'live', label: 'live (сеть/DOM)' });
    expect(runSourceInfo({ adapterCount: 156 })).toEqual({ kind: 'live', label: 'live (сеть/DOM)' });
    expect(runSourceInfo({ lastBaseTexts: ['a'] })).toEqual({ kind: 'live', label: 'live (сеть/DOM)' });
    expect(runSourceInfo({})).toBeNull();      // ни сети, ни адаптерной базы → прежний null
    // база адаптера считается БЕЗ лишнего прохода extractMessages — из уже посчитанного count
    expect(CONTENT).toContain('aiCmAdapterBaseCount = messageCount;');
    // читатель попапа: числа печатает; «—» только когда метки нет вовсе
    expect(OPTIONS_SRC).toContain("sourceEl.textContent = fromCache");
    expect(OPTIONS_SRC).toContain(": (state.sourceLabel || '—');");
    expect(OPTIONS_SRC).toContain("tokensEl.textContent = (typeof state.tokens === 'number') ? state.tokens.toLocaleString() : '—';");
    // предупреждение stale у qwen не показывается: chat.qwen.ai нет в detectChatSite → isChatHome=false
    expect(OPTIONS_SRC).not.toContain("host.indexOf('chat.qwen.ai')");
    expect(OPTIONS_SRC).toContain("var showStale = !!(state && state.stale === true && isChatHome(tabHost, tabPath));");
    // «нет данных» (O-14 removed) на qwen не срабатывал: попап показывал числа, а не showNoData
    expect(OPTIONS_SRC).toContain("function showNoData(message) {");
    expect(OPTIONS_SRC).toContain("event: 'showNoData', reason: String(message || '-')");
  });
});

// =====================================================================================
// B: цепочка usage → detail.serverTokens → netServerTokens → бейдж; qwenUsage без читателя
// =====================================================================================
describe('O-35 B: проводка серверного usage до бейджа', function () {
  test('B: шаг 1 — перехватчик берёт usage.input как serverTokens (без гейта по сервису)', function () {
    expect(INTERCEPT_SRC).toContain("var serverTokens = (typeof usage.input === 'number' && usage.input > 0) ? usage.input : 0;");
    expect(INTERCEPT_SRC).toContain('serverTokens: serverTokens,');
    expect(INTERCEPT_SRC).toContain("diagTag('qwen-sse', {");
  });

  test('B: шаг 2 — content.js присваивает netServerTokens БЕЗ site-гейта (строка 555-окрестность)', function () {
    expect(CONTENT).toContain('netServerTokens = detail.serverTokens || 0;');
    // обе точки расчёта pct читают netServerTokens первым приоритетом
    const hits = CONTENT.match(/let tokenEstimate = netServerTokens > 0 \? netServerTokens : Tokenizer\.estimateDialogTokens\(/g) || [];
    expect(hits.length).toBe(2);
  });

  test('B: шаг 3 — бейдж: serverTokens авторитетен и сбрасывает монотонный максимум', function () {
    expect(CONTENT).toContain('if (netServerTokens > 0) {');
    expect(CONTENT).toContain('maxTokenCount = tokenEstimate;');
    expect(CONTENT).toContain("(netServerTokens > 0 ? ' · serverTokens' : '')");
  });

  test('B: шаг 4 — Qwen НЕ в isGeminiSvc: countTokens BYOK не перезаписывает usage стрима', function () {
    const m = /const isGeminiSvc = \(([^)]*)\);/.exec(CONTENT);
    expect(m[1]).toBe("svc === 'gemini' || svc === 'aistudio' || svc === 'google_search'");
    expect(m[1]).not.toContain('qwen');
  });

  test('B: метка «Источник» в попапе берётся из яруса базы, а НЕ из serverTokens (проводка метки)', function () {
    expect(CONTENT).toContain('netServerTokens = detail.serverTokens || 0;');
    const info = fnDecl(CONTENT, 'aiCmSourceInfo');
    expect(info).not.toContain('netServerTokens');
    expect(info).toContain('if (baseSeen) return { kind: \'live\'');
    // ФЛИП ФИКСА B2: ярус DOM-адаптера (сети нет) — тоже live, а не «—»
    expect(info).toContain('if (aiCmAdapterBaseSeen()) return { kind: \'live\'');
  });

  test('ФЛИП ФИКСА B1: qwenUsage (output/reasoning) имеет потребителя — отдельные строки тултипа', function () {
    expect(INTERCEPT_SRC).toContain('qwenUsage: {');
    // content.js доводит поле до общего скоупа контент-скрипта (state.js:netQwenUsage)…
    expect(CONTENT).toContain('netQwenUsage = (detail.qwenUsage && typeof detail.qwenUsage === \'object\') ? detail.qwenUsage : null;');
    expect(fs.readFileSync(path.join(ROOT, 'core', 'state.js'), 'utf8')).toContain('let netQwenUsage = null;');
    // …а виджет читает его напрямую (как stale/baseSeen/baseCount) — подпись updateWidget прежняя
    expect(WIDGET_SRC).toContain('netQwenUsage.outputTokens');
    expect(WIDGET_SRC).toContain('netQwenUsage.reasoningTokens');
    expect(WIDGET_SRC).toContain('updateWidget(percentage, tokens, effectiveLimit, contextLimit, displayLimit, modelName, attachBreak)');
    // новых ru-литералов не введено: ключ/формат тултипа — существующий content_tooltip_tokens
    expect(WIDGET_SRC).toContain("i18n('content_tooltip_tokens', `Токены: ${qOut.toLocaleString()}`, ['output ' + qOut.toLocaleString()])");
    expect(WIDGET_SRC).toContain("i18n('content_tooltip_tokens', `Токены: ${qRea.toLocaleString()}`, ['reasoning ' + qRea.toLocaleString()])");
    // строки живут ровно на тултипе виджета: попап их не дублирует
    expect(OPTIONS_SRC).not.toContain('qwenUsage');
  });
});

// =====================================================================================
// A: msgs/convId/URL на каждой записи истории — материал для вердикта по счётчику 156
// =====================================================================================
describe('O-35 A: счётчик msgs привязан к convId и URL на каждой записи истории', function () {
  test('A: запись сетевой базы печатает qwen-adapter source=network msgs/convId/url', function () {
    const i = CONTENT.indexOf("debugLog('log', '[AI CM][trace] history-write source=network convId='");
    expect(i).toBeGreaterThan(-1);
    const block = CONTENT.slice(i, i + 1400);
    expect(block).toContain("aiCmDiagLine('qwen-adapter'");
    expect(block).toContain("source: 'network'");
    expect(block).toContain('msgs: baseCount');
    expect(block).toContain('convId: (emitConvA');
    expect(block).toContain("url: String((typeof location !== 'undefined' && location && location.href) || '')");
    expect(block).toContain('sinceSpaResetMs');
  });

  test('A: запись DOM-адаптера (msgs=156 из консоли 14:48:51.318) печатает роли и convId', function () {
    const i = CONTENT.indexOf("history-write source=adapter site=");
    expect(i).toBeGreaterThan(-1);
    const block = CONTENT.slice(i, i + 1600);
    expect(block).toContain("aiCmDiagLine('qwen-adapter'");
    expect(block).toContain("source: 'adapter'");
    expect(block).toContain('roles: qUsers');
    expect(block).toContain('convId: cidS24 ||');
    expect(block).toContain('adapterMsgs: msgsS24.length');
  });

  test('A: счётчик — это выход extractMessages() → buildHistoryMessages() адаптера', function () {
    expect(CONTENT).toContain('var msgsS24 = buildHistoryMessages();');
    expect(ADAPTER_SRC).toContain('const messages = [];');
    expect(ADAPTER_SRC).toContain('[QwenAdapter] Извлечено ${messages.length} сообщений');
    // один проход по узлам: кандидаты селекторов — первый непустой набор
    expect(ADAPTER_SRC).toContain('_messageNodes()');
    expect(ADAPTER_SRC).toContain("'[data-message-id]',");
    expect(ADAPTER_SRC).toContain("'[class*=\"message-bubble\"]'");
  });

  test('A: convId берётся из URL (/c/<id>) — привязка числа к разговору проверяема', function () {
    const P = require('../utils/export-emit-pipeline.js');
    expect(P.extractConvIdFromUrl('/c/' + OTHER_CHAT_ID)).toBe(OTHER_CHAT_ID);
    expect(CONTENT).toContain('var cidS24 = getCurrentConvId()');
  });
});

// =====================================================================================
// E (ИЗМЕРЕНИЕ 2026-09-19, живой лог 17:49–17:50): qwen-init — ИНИЦИАЛИЗАЦИЯ контура.
// Дефект: холодный старт на пустом чате + SPA-вход в /c/<id> через 42с → isInitialized=false,
// DRAW-гард режет processAndSend до записи базы адаптером (попап «Откройте поддерживаемый
// сайт»). Живой лог не отвечал на два вопроса: (1) звался ли tryInit после SPA и что он
// находил; (2) не падал ли какой-то из путей молча (пустые catch). Здесь пин двух свойств
// инструментации: строки qwen-init печатаются ТОЛЬКО под гейтом aiCmDebug (G1) и НЕ меняют
// наблюдаемое поведение (G2), плюс исполняемый факт про аргументы setTimeout реактивации.
// =====================================================================================
describe('O-35 E: qwen-init — инициализация контура (только под гейтом, поведение 1:1)', function () {
  function initLines() {
    return diagLines().filter(function (s) { return s.indexOf('[AI CM][diag] qwen-init ') === 0; });
  }
  function initLine(event) { return diagLine('qwen-init', event); }

  /** Стенд реактивации: РЕАЛЬНАЯ aiCmQwenSpaReshoot + реальные строки qwen-init. */
  function runReshootStand(opts) {
    const o = opts || {};
    jest.useFakeTimers();
    const calls = { detect: 0, init: 0, send: 0 };
    const ctx = {
      window: window,
      location: window.location,
      currentAdapter: { siteName: o.site || 'qwen' },
      isInitialized: !!o.initialized,
      aiCmAssignAdapterByHost: function () { calls.detect++; },
      tryInit: function () { calls.init++; if (o.initialized) ctx.isInitialized = true; },
      processAndSend: function () { calls.send++; },
      getCurrentConvId: function () { return OTHER_CHAT_ID; },
      aiCmDiagStack: function () { return ''; }
    };
    const scope = 'with (ctx) { ' + fnDecl(DEBUG_SRC, 'aiCmDiagOn') + '\n' +
      fnDecl(DEBUG_SRC, 'aiCmDiagLine') + '\n' + fnDecl(CONTENT, 'aiCmQwenInitErrText') + '\n' +
      fnDecl(CONTENT, 'aiCmQwenInitDiag') + '\n' + fnDecl(CONTENT, 'aiCmQwenSpaReshoot') +
      '\n return aiCmQwenSpaReshoot; }';
    const fn = new Function('ctx', scope)(ctx);
    const ret = fn();
    return { calls: calls, ctx: ctx, ret: ret };
  }

  /** Стенд tryInit: РЕАЛЬНЫЙ tryInit (async) + реальные строки qwen-init. */
  function runTryInitStand(opts) {
    const o = opts || {};
    const state = { sends: 0, observes: 0 };
    const ctx = {
      window: window,
      document: document,
      location: window.location,
      currentAdapter: {
        siteName: 'qwen',
        extractMessages: function () {
          if (o.adapterThrows) throw new Error('adapter-boom');
          return o.adapterMsgs || [];
        }
      },
      isInitialized: false,
      findMessageNodes: function () {
        if (o.findThrows) throw new Error('find-boom');
        return { nodes: o.nodes || [], sel: o.sel || '(none)' };
      },
      processAndSend: function () { state.sends++; },
      startObserving: function () { state.observes++; },
      debugLog: function () { },
      aiCmDiagStack: function () { return ''; }
    };
    const scope = 'with (ctx) { ' + fnDecl(DEBUG_SRC, 'aiCmDiagOn') + '\n' +
      fnDecl(DEBUG_SRC, 'aiCmDiagLine') + '\n' + fnDecl(CONTENT, 'aiCmQwenInitErrText') + '\n' +
      fnDecl(CONTENT, 'aiCmQwenInitDiag') + '\n' + 'async ' + fnDecl(CONTENT, 'tryInit') +
      '\n return tryInit; }';
    const fn = new Function('ctx', scope)(ctx);
    return { run: fn, ctx: ctx, state: state };
  }

  /** Стенд initialize: РЕАЛЬНЫЙ initialize + реальные строки qwen-init (chrome не трогаем). */
  function runInitializeStand(opts) {
    const o = opts || {};
    jest.useFakeTimers();
    const calls = { init: 0, widget: 0 };
    const ctx = {
      window: window,
      document: document,
      location: window.location,
      currentAdapter: null,
      isInitialized: false,
      isExtensionValid: function () { return false; },
      aiCmAssignAdapterByHost: function () { if (!o.noAdapter) ctx.currentAdapter = { siteName: 'qwen' }; },
      debugLog: function () { },
      aiCmDispatchContentReady: function () { },
      loadAutoExportPerSitePct: function () { },
      loadByokSettings: function () { },
      loadByokCache: function () { },
      aiCmLoadPopupOverrides: function () { },
      safePctKey: function () { return 'aiCmTestPct'; },
      updatePanel: function () { },
      createWidget: function () { calls.widget++; },
      tryInit: function () {
        calls.init++;
        if (o.throwTry) return Promise.reject(new Error('tryinit-boom'));
        if (o.initialized) ctx.isInitialized = true;
        return Promise.resolve();
      },
      aiCmDiagStack: function () { return ''; }
    };
    const scope = 'with (ctx) { ' + fnDecl(DEBUG_SRC, 'aiCmDiagOn') + '\n' +
      fnDecl(DEBUG_SRC, 'aiCmDiagLine') + '\n' + fnDecl(CONTENT, 'aiCmQwenInitErrText') + '\n' +
      fnDecl(CONTENT, 'aiCmQwenInitDiag') + '\n' + 'async ' + fnDecl(CONTENT, 'initialize') +
      '\n return initialize; }';
    const fn = new Function('ctx', scope)(ctx);
    return { run: fn, ctx: ctx, calls: calls };
  }

  test('E: точки инициализации инструментированы; вызовы только через канон и под try/catch', function () {
    const diag = fnDecl(CONTENT, 'aiCmQwenInitDiag');
    expect(diag).toContain("aiCmDiagLine('qwen-init'");
    expect(diag).not.toContain('console.');                       // своей печати нет — только канон
    expect(diag).toContain("currentAdapter.siteName !== 'qwen'"); // строки только для qwen
    const init = fnDecl(CONTENT, 'tryInit');
    ['tryinit-enter', 'tryinit-nodes', 'tryinit-exit', 'tryinit-adapter-throw', 'tryinit-skip', 'tryinit-throw']
      .forEach(function (ev) { expect(init).toContain("'" + ev + "'"); });
    expect(init).toContain('throw eTryInit;');                     // исключение НЕ проглочено
    const ini = fnDecl(CONTENT, 'initialize');
    ['initialize-enter', 'initialize-after-tryinit', 'initialize-ladder', 'initialize-exit', 'initialize-throw']
      .forEach(function (ev) { expect(ini).toContain("'" + ev + "'"); });
    expect(ini).toContain('throw eInitialize;');                    // лесенка не подменяет отказ
    expect(ini).toContain("delays: '2000,4000,6000'");
    const resh = fnDecl(CONTENT, 'aiCmQwenSpaReshoot');
    ['reshoot-enter', 'reshoot-after-sync', 'reshoot-retry', 'reshoot-exit', 'reshoot-throw']
      .forEach(function (ev) { expect(resh).toContain("'" + ev + "'"); });
    // вердикт DRAW-гарда — в обеих ветвях; строка DRAW-ПРОПУСК не тронута. Условие гарда
    // расширено РОВНО на один пропускной путь — «адаптерная база готова, isInitialized ещё
    // нет» (O-35 B2-терминал, aiCmQwenTerminalReshoot): без него проход возвращался выше
    // записи адаптерной базы и снимка aiCmState. Поведенческие вердикты условия (в т.ч.
    // отсутствие изменений для F5/готового чата и пустого DOM) пинованы в
    // tests/qwen-spa-terminal-o35.test.js.
    const draw = fnDecl(CONTENT, 'processAndSend');
    expect(draw).toContain('if (!isInitialized && !(baseSeen && baseComplete) && !aiCmAdapterBaseSeen()) {');
    expect(draw).toContain("[content-trace] DRAW-ПРОПУСК (guard) seq=' + (window.__aiCmTraceSeq || 0)");
    const iSkip = draw.indexOf("aiCmQwenInitDiag('draw-guard', { verdict: 'skip'");
    expect(iSkip).toBeGreaterThan(draw.indexOf('DRAW-ПРОПУСК (guard)'));
    expect(draw.indexOf('return;', iSkip)).toBeGreaterThan(iSkip);  // вердикт — ДО возврата
    expect(draw).toContain("aiCmQwenInitDiag('draw-guard', { verdict: 'pass'");
    // ни одного незащищённого вызова: срез-песочницы без хелпера видят прежнее поведение 1:1
    const all = (CONTENT.match(/aiCmQwenInitDiag\(/g) || []).length;
    const guarded = (CONTENT.match(/try \{ aiCmQwenInitDiag\(/g) || []).length;
    expect(guarded).toBe(all - 1);                                  // -1: собственное объявление
  });

  test('E/G1/G2: реактивация — гейт выключен → ни строки; включён → вход/выход/3 ретрая; поведение 1:1', function () {
    // гейт выключен: строк qwen-init нет вовсе, поведение (detect/init/send + ret) прежнее
    jest.spyOn(console, 'log').mockImplementation(function () { });
    const off = runReshootStand({});
    expect(initLines()).toEqual([]);
    expect(off.ret).toBe(true);
    jest.advanceTimersByTime(3000);
    expect(off.calls).toEqual({ detect: 1, init: 4, send: 0 });
    expect(off.ctx.isInitialized).toBe(false);
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.spyOn(console, 'log').mockImplementation(function () { });
    // гейт включён: те же вызовы + строки инициализации
    sessionStorage.setItem('aiCmDebug', '1');
    const on = runReshootStand({});
    expect(on.ret).toBe(off.ret);                                   // G2: вердикт тот же
    expect(initLine('reshoot-enter')).toContain('branch=asleep');
    expect(initLine('reshoot-enter')).toContain('initialized=0');
    expect(initLine('reshoot-enter')).toContain('convId=' + OTHER_CHAT_ID);
    jest.advanceTimersByTime(3000);
    expect(on.calls).toEqual(off.calls);                            // G2: вызовы те же
    expect(on.ctx.isInitialized).toBe(off.ctx.isInitialized);
    expect(initLine('reshoot-after-sync')).toContain('branch=asleep');
    expect(initLines().filter(function (s) { return s.indexOf('event=reshoot-retry') !== -1; })).toHaveLength(3);
    expect(initLine('reshoot-exit')).toContain('ret=1');
    expect(initLine('reshoot-exit')).toContain('branch=asleep');
    jest.useRealTimers();
    // контур уже поднят: ветка awake — processAndSend, без tryInit и без ретраев
    jest.restoreAllMocks();
    jest.spyOn(console, 'log').mockImplementation(function () { });   // строки прошлого стенда не считаем
    const awake = runReshootStand({ initialized: true });
    expect(awake.ret).toBe(true);
    expect(awake.calls).toEqual({ detect: 1, init: 0, send: 1 });
    expect(initLine('reshoot-enter')).toContain('branch=awake');
    expect(initLine('reshoot-awake-send')).toBeTruthy();
    jest.useRealTimers();
  });

  test('E: аргументы setTimeout реактивации — 500/1500/3000 мс; дальше попыток нет (лесенка конечна)', function () {
    jest.spyOn(console, 'log').mockImplementation(function () { });
    sessionStorage.setItem('aiCmDebug', '1');
    const st = runReshootStand({});
    expect(st.calls.init).toBe(1);              // синхронная попытка сразу после события (17:50:32.552)
    jest.advanceTimersByTime(499);
    expect(st.calls.init).toBe(1);              // 499 мс — ретрая ещё НЕТ (аргумент не «0.0001 мс»)
    jest.advanceTimersByTime(1);
    expect(st.calls.init).toBe(2);              // 500 мс
    jest.advanceTimersByTime(1000);
    expect(st.calls.init).toBe(3);              // 1500 мс
    jest.advanceTimersByTime(1500);
    expect(st.calls.init).toBe(4);              // 3000 мс — последний
    jest.advanceTimersByTime(120000);
    expect(st.calls.init).toBe(4);              // и это ВСЁ: своего периодического тика у контура нет
    const retries = initLines().filter(function (s) { return s.indexOf('event=reshoot-retry') !== -1; });
    expect(retries[0]).toContain('delay=500');
    expect(retries[1]).toContain('delay=1500');
    expect(retries[2]).toContain('delay=3000');
    // три отдельных таймера, а не одно вычисленное значение
    expect(fnDecl(CONTENT, 'aiCmQwenSpaReshoot')).toContain("}, 500);");
    expect(fnDecl(CONTENT, 'aiCmQwenSpaReshoot')).toContain("}, 1500);");
    expect(fnDecl(CONTENT, 'aiCmQwenSpaReshoot')).toContain("}, 3000);");
    jest.useRealTimers();
  });

  test('E: tryInit — каждый вызов с результатом (no-found / initialized / skip) и с исключением', async function () {
    jest.spyOn(console, 'log').mockImplementation(function () { });
    sessionStorage.setItem('aiCmDebug', '1');
    // 1) узлов нет, фолбэк адаптера пуст → not-found (раньше эта ветка не логировала НИЧЕГО)
    const nf = runTryInitStand({ adapterMsgs: [] });
    await nf.run();
    expect(initLine('tryinit-enter')).toContain('nodes=0');
    const nfExit = initLine('tryinit-exit');
    expect(nfExit).toContain('action=not-found');
    expect(nfExit).toContain('adapterMsgs=0');
    expect(nf.ctx.isInitialized).toBe(false);
    expect(nf.state.sends).toBe(0);
    jest.restoreAllMocks();
    jest.spyOn(console, 'log').mockImplementation(function () { });
    // 2) узлы есть → initialized + processAndSend + startObserving; повторный вызов — skip
    const ok = runTryInitStand({ nodes: [{}, {}], sel: '[data-message-id]' });
    await ok.run();
    expect(initLine('tryinit-nodes')).toContain('action=set-initialized');
    expect(initLine('tryinit-nodes')).toContain('nodes=2');
    expect(initLine('tryinit-exit')).toContain('action=initialized');
    expect(ok.ctx.isInitialized).toBe(true);
    expect(ok.state.sends).toBe(1);
    expect(ok.state.observes).toBe(1);
    await ok.run();
    expect(initLine('tryinit-skip')).toContain('reason=already-initialized');
    expect(ok.state.observes).toBe(1);
    jest.restoreAllMocks();
    jest.spyOn(console, 'log').mockImplementation(function () { });
    // 3) исключение фолбэка адаптера — строка есть (раньше пустой catch)
    const athr = runTryInitStand({ adapterThrows: true });
    await athr.run();
    expect(initLine('tryinit-adapter-throw')).toContain('error=Error: adapter-boom');
    expect(initLine('tryinit-exit')).toContain('adapterMsgs=-2');
    // 4) исключение самого tryInit НЕ проглочено: промис отклоняется тем же отказом
    const fthr = runTryInitStand({ findThrows: true });
    await expect(fthr.run()).rejects.toThrow('find-boom');
    expect(initLine('tryinit-throw')).toContain('error=Error: find-boom');
    jest.restoreAllMocks();
    jest.spyOn(console, 'log').mockImplementation(function () { });
    // G1/G2: гейт выключен — ни строки, а наблюдаемое состояние то же
    sessionStorage.removeItem('aiCmDebug');
    const off = runTryInitStand({ nodes: [{}, {}], sel: '[data-message-id]' });
    await off.run();
    expect(initLines()).toEqual([]);
    expect([off.ctx.isInitialized, off.state.sends, off.state.observes])
      .toEqual([ok.ctx.isInitialized, ok.state.sends, ok.state.observes]);
  });

  test('E: initialize — вход/выход/лесенка; throw tryInit не проглочен и лесенку не ставит', async function () {
    jest.spyOn(console, 'log').mockImplementation(function () { });
    sessionStorage.setItem('aiCmDebug', '1');
    const awake = runInitializeStand({ initialized: true });
    await awake.run();
    expect(initLine('initialize-enter')).toContain('adapter=qwen');
    expect(initLine('initialize-after-tryinit')).toContain('initialized=1');
    expect(initLine('initialize-ladder')).toBeUndefined();   // контур поднят — лесенка не нужна
    expect(initLine('initialize-exit')).toContain('ret=1');
    expect(awake.calls.widget).toBe(1);
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.spyOn(console, 'log').mockImplementation(function () { });
    // пустой чат: tryInit ничего не нашёл → лесенка 2000/4000/6000 поставлена (истекает за 7.5с)
    const asleep = runInitializeStand({});
    await asleep.run();
    expect(initLine('initialize-after-tryinit')).toContain('initialized=0');
    expect(initLine('initialize-ladder')).toContain('delays=2000,4000,6000');
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.spyOn(console, 'log').mockImplementation(function () { });
    // исключение tryInit: initialize отклоняется (как раньше) + видно, что лесенки НЕ будет
    const bad = runInitializeStand({ throwTry: true });
    await expect(bad.run()).rejects.toThrow('tryinit-boom');
    expect(initLine('initialize-throw')).toContain('error=Error: tryinit-boom');
    expect(initLine('initialize-ladder')).toBeUndefined();
    jest.useRealTimers();
  });
});
