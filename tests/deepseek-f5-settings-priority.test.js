/** @jest-environment node */
/**
 * F5 (P3-A): активная конфигурация модели из /api/v0/client/settings?scope=model
 * приоритетнее исторического chat_session.model_type при ingest истории.
 *
 * Баг: пользователь выбрал unified default (ActiveSettings.model_type="default"),
 * а chat_session.model_type в истории остался "expert" от старой модели r1 —
 * ход получал slug deepseek-r1 и окно 128k вместо v4.1-flash и окна 1M.
 *
 * Гоняется РЕАЛЬНЫЙ core/deepseek-intercept.js в jsdom (модули + ядро через
 * tests/helpers/deepseek-intercept-source.js) с подменённым window.fetch:
 *   - client/settings → ingestModelSettings → CustomEvent 'ai-cm-deepseek-model-settings';
 *   - history_messages → ingestHistory → ai-cm-full-history;
 *   - completion → realtime-финал (не должен подхватывать настройки — D4).
 *
 * Пины: D1 settings default → v4.1-flash/1M/16%; D2 settings expert → r1/128k;
 * D3 настройки не захвачены → r1/128k (регресс-поведение); D4 realtime chatMode
 * остаётся из SSE ("expert"), а не из активной настройки "default".
 */
'use strict';

const util = require('util');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

// jsdom не даёт TextEncoder/TextDecoder в глобаль, а ядро читает поток через них.
if (typeof global.TextEncoder === 'undefined') global.TextEncoder = util.TextEncoder;
if (typeof global.TextDecoder === 'undefined') global.TextDecoder = util.TextDecoder;

const INTERCEPT_SRC = require('./helpers/deepseek-intercept-source.js').deepseekSource;
const MODEL_CONFIG = require('./helpers/load-esm.js').loadEsm('utils/model-config.ts');

const V4_FLASH = 'deepseek-v4.1-flash';
const R1 = 'deepseek-r1';
const SETTINGS_URL = 'https://chat.deepseek.com/api/v0/client/settings?scope=model';
const COMPLETION_URL = 'https://chat.deepseek.com/api/v1/chat/completion?x=1';
const historyUrl = (cid) => 'https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=' + cid + '&cache_version=abc';

const USED_TOKENS = 160123;

// ===================== фикстуры =====================

/** История: chat_session.model_type — ИСТОРИЧЕСКОЕ значение (экспертная r1). */
function historyFixture(modelType, tokens) {
  return {
    code: 0,
    data: {
      biz_data: {
        chat_session: { current_message_id: 'a1', model_type: modelType, is_empty: false },
        chat_messages: [
          {
            message_id: 'u1', parent_id: null, role: 'USER', thinking_enabled: false,
            accumulated_token_usage: 100, fragments: [{ type: 'REQUEST', content: 'Вопрос' }]
          },
          {
            message_id: 'a1', parent_id: 'u1', role: 'ASSISTANT', thinking_enabled: true,
            accumulated_token_usage: tokens === undefined ? USED_TOKENS : tokens,
            fragments: [
              { type: 'THINK', content: 'думаю' },
              { type: 'RESPONSE', content: 'Ответ' }
            ]
          }
        ]
      }
    }
  };
}

/**
 * /client/settings: активная запись помечена is_default:true/enabled:true,
 * вторая запись — выключенный из выбора кандидат (как в реальном ответе).
 */
function settingsFixture(active) {
  var other = active.model_type === 'expert'
    ? { name: 'Instant', model_type: 'default', is_default: false, enabled: true, switchable: true }
    : { name: 'Expert', model_type: 'expert', is_default: false, enabled: true, switchable: true };
  return {
    code: 0,
    data: {
      biz_data: {
        settings: {
          model_configs: {
            value: [
              { name: active.name, model_type: active.model_type, is_default: true, enabled: true, switchable: true },
              other
            ]
          }
        }
      }
    }
  };
}

const ACTIVE_DEFAULT = { name: 'Instant', model_type: 'default' };
const ACTIVE_EXPERT = { name: 'Expert', model_type: 'expert' };

// ===================== jsdom-стенд =====================

function flush(times) {
  let p = Promise.resolve();
  for (let i = 0; i < (times || 120); i++) p = p.then(() => { });
  return p;
}

async function settle(times) {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await flush(times || 120);
  }
}

function fakeResponse(jsonBody, textBody) {
  const cloneObj = {
    json: () => Promise.resolve(jsonBody),
    text: () => Promise.resolve(textBody || '')
  };
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(jsonBody),
    text: () => Promise.resolve(textBody || ''),
    clone: () => cloneObj
  };
}

function makeStand(convId) {
  const logs = [];
  const vc = new VirtualConsole();
  vc.on('log', (...a) => logs.push(a.join(' ')));
  vc.on('warn', (...a) => logs.push(a.join(' ')));
  vc.on('error', (...a) => logs.push(a.join(' ')));

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://chat.deepseek.com/a/chat/s/' + convId,
    runScripts: 'dangerously',
    virtualConsole: vc
  });
  const { window } = dom;
  window.TextDecoder = TextDecoder;

  let historyBody = null;
  let settingsBody = null;
  let completionText = '';
  const emits = [];

  window.fetch = (input) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || '');
    if (url.indexOf('completion') !== -1) return Promise.resolve(fakeResponse({}, completionText));
    const body = url.indexOf('history_messages') !== -1 ? historyBody
      : url.indexOf('client/settings') !== -1 ? settingsBody : null;
    return Promise.resolve(fakeResponse(body, ''));
  };

  window.eval(INTERCEPT_SRC);
  window.addEventListener('ai-cm-full-history', (e) => emits.push(JSON.parse(JSON.stringify(e.detail))));

  return {
    window,
    logs,
    emits,
    setHistory: (v) => { historyBody = v; },
    setSettings: (v) => { settingsBody = v; },
    setCompletion: (text) => { completionText = text; },
    fireHistory: () => window.fetch(historyUrl(convId)),
    fireSettings: () => window.fetch(SETTINGS_URL),
    fireCompletion: () => window.fetch(COMPLETION_URL, {
      method: 'POST',
      body: JSON.stringify({ prompt: 'Привет', chat_session_id: convId, thinking_enabled: true })
    }),
    last: () => emits[emits.length - 1],
    close: () => { try { window.close(); } catch (e) { /* ignore */ } }
  };
}

// ===================== SSE-чанки realtime =====================

function sseLine(obj) { return 'data: ' + JSON.stringify(obj); }
function sseStream(modelType, tokens) {
  return [
    'event: ready',
    sseLine({ request_message_id: 'u9', response_message_id: 'a9', model_type: modelType }),
    '',
    'event: message',
    sseLine({ v: { response: { accumulated_token_usage: 500, model_type: modelType, fragments: [{ type: 'THINK', content: 'думаю' }] } } }),
    '',
    sseLine({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: 'Ответ' }] }),
    '',
    sseLine({ p: 'response', o: 'BATCH', v: [{ p: 'accumulated_token_usage', v: tokens }, { p: 'quasi_status', v: 'FINISHED' }] }),
    '',
    'event: close',
    'data: {}',
    ''
  ].join('\n');
}

// ===================== тесты =====================

describe('F5: живые настройки модели приоритетнее исторического chat_session.model_type', () => {
  test('D1: settings {is_default:true, enabled:true, model_type:"default"} + history expert → v4.1-flash, окно 1M, 16%', async () => {
    // (a) настройки пришли ДО истории: приоритет применяется на пути ingest.
    const before = makeStand('f5d1a');
    before.setSettings(settingsFixture(ACTIVE_DEFAULT));
    before.setHistory(historyFixture('expert'));
    await before.fireSettings();
    await settle();
    expect(before.emits.length).toBe(0);
    await before.fireHistory();
    await settle();

    expect(before.emits.length).toBe(1);
    const a = before.last();
    expect(a.modelSlug).toBe(V4_FLASH);
    expect(a.serverTokens).toBe(USED_TOKENS);
    expect(MODEL_CONFIG.getContextLimit(a.modelSlug)).toBe(1000000);
    expect(MODEL_CONFIG.calculatePercentage(a.serverTokens, 1000000)).toBe(16);
    before.close();

    // (b) история пришла ДО настроек: ре-эмит E3 обязан пересчитать slug на flash.
    const after = makeStand('f5d1b');
    after.setHistory(historyFixture('expert'));
    after.setSettings(settingsFixture(ACTIVE_DEFAULT));
    await after.fireHistory();
    await settle();
    expect(after.emits.length).toBe(1);
    expect(after.last().modelSlug).toBe(R1);           // до настроек исторический сигнал даёт r1

    await after.fireSettings();
    await settle();
    expect(after.emits.length).toBe(2);                // E3: первый захват конфигурации → ре-эмит
    const b = after.last();
    expect(b.modelSlug).toBe(V4_FLASH);
    expect(b.serverTokens).toBe(USED_TOKENS);
    expect(MODEL_CONFIG.getContextLimit(b.modelSlug)).toBe(1000000);
    expect(MODEL_CONFIG.calculatePercentage(b.serverTokens, 1000000)).toBe(16);
    after.close();
  });

  test('D2: settings {is_default:true, enabled:true, model_type:"expert"} → deepseek-r1, окно 128k', async () => {
    const stand = makeStand('f5d2');
    stand.setSettings(settingsFixture(ACTIVE_EXPERT));
    stand.setHistory(historyFixture('expert'));
    await stand.fireSettings();
    await settle();
    await stand.fireHistory();
    await settle();

    expect(stand.emits.length).toBe(1);
    const d = stand.last();
    expect(d.modelSlug).toBe(R1);
    expect(MODEL_CONFIG.getEffectiveLimit(d.modelSlug)).toBe(128000);
    // 160123/128000 ≈ 125% → calculatePercentage клампит на 100: окно 128k, а не 1M.
    expect(MODEL_CONFIG.calculatePercentage(d.serverTokens, 128000)).toBe(100);
    expect(d.modelMode).toBe('expert');
    stand.close();
  });

  test('D3: настройки не захвачены (sseConfigIsDefault undefined) + history expert → deepseek-r1', async () => {
    const stand = makeStand('f5d3');
    stand.setHistory(historyFixture('expert'));
    await stand.fireHistory();   // /client/settings не запрашивали вовсе
    await settle();

    expect(stand.emits.length).toBe(1);
    const d = stand.last();
    expect(d.modelSlug).toBe(R1);
    expect(MODEL_CONFIG.getContextLimit(d.modelSlug)).toBe(128000);
    stand.close();
  });

  test('D4: realtime chatMode из SSE остаётся "expert" при активной настройке "default"', async () => {
    const stand = makeStand('f5d4');
    stand.setSettings(settingsFixture(ACTIVE_DEFAULT));
    await stand.fireSettings();
    await settle();
    expect(stand.emits.length).toBe(0);

    stand.setCompletion(sseStream('expert', 9000));
    await stand.fireCompletion();
    await settle();

    expect(stand.emits.length).toBe(1);
    const d = stand.last();
    // chatMode realtime = sseModelType (живой SSE), а не активная настройка "default".
    expect(d.modelMode).toBe('expert');
    // slug realtime — из живых сигналов потока (thinking → r1), настройка сюда не протекает.
    expect(d.modelSlug).toBe(R1);
    expect(d.serverTokens).toBe(9000);
    stand.close();
  });
});
