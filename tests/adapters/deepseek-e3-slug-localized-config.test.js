// E3 (2026-10-11): slug модели DeepSeek на ПЕРВОМ рендере виджета.
// Окружение — jsdom (как в tests/deepseek-v4-slug-contract.test.js): резолвер импортируется
// через module.exports ядра, а IIFE ядра поднимается только при наличии window.
//
// Дефект живого измерения: резолвер матчил активную конфигурацию по ЛОКАЛИЗОВАННОМУ имени
// (configName === 'instant'), а в ru-локали name = "Быстрый" — матч не срабатывал, и первый
// снимок уходил с фолбэком deepseek-v3 (до обмена) / deepseek-r1 (после). Ни одного вызова
// ingestModelSettings/sseConfigName в логе не было видно — сигнал настроек просто не матчился.
//
// Пины: P1/P2/P3 — дефект (структурный матч), R1/R2/R3 — старый контракт цел,
// S1 — ре-эмит снимка ровно один раз на переход sseConfigName «пусто → значение»,
// S2 — первый снимок при уже захваченных настройках несёт flash (сам дефект),
// S3 — статическая проводка ре-эмита (без неё S1 проходит вхолостую).
const fs = require('fs');
const path = require('path');
const util = require('util');

// jsdom-окружение jest не выставляет TextEncoder/TextDecoder, а их требует whatwg-url
// (зависимость пакета jsdom) — полифилл обязан стоять ДО require('jsdom').
if (typeof global.TextEncoder === 'undefined') global.TextEncoder = util.TextEncoder;
if (typeof global.TextDecoder === 'undefined') global.TextDecoder = util.TextDecoder;

const { JSDOM, VirtualConsole } = require('jsdom');

const INTERCEPT = require('../../core/deepseek-intercept.js');
const INTERCEPT_SRC = require('../helpers/deepseek-intercept-source.js').deepseekSource;

const V4_FLASH = 'deepseek-v4.1-flash';
const KERNEL_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'core', 'deepseek-intercept.js'), 'utf8');
const SSE_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'core', 'deepseek-sse.js'), 'utf8');

describe('E3: резолвер — структурный матч активной конфигурации (P1/P2/P3 дефект, R1/R2/R3 регрессия)', () => {
  const resolve = INTERCEPT.resolveNetworkModelSlug;

  test('P1 (дефект, ru): name:"Быстрый" + model_type:"default" + is_default:true → deepseek-v4.1-flash', () => {
    expect(INTERCEPT.DEEPSEEK_V4_FLASH_SLUG).toBe(V4_FLASH);
    expect(resolve({ modelType: 'default', isDefault: true, configName: 'Быстрый' })).toBe(V4_FLASH);
    // имя в матче не участвует: структурная пара матчится и без него
    expect(resolve({ modelType: 'default', isDefault: true })).toBe(V4_FLASH);
  });

  test('P2 (дефект, en): name:"Fast" → deepseek-v4.1-flash (локализация на матч не влияет)', () => {
    expect(resolve({ modelType: 'default', isDefault: true, configName: 'Fast' })).toBe(V4_FLASH);
  });

  test('P3 (дефект, живая форма сигналов): model_type:"default" + захваченная активная конфигурация', () => {
    // Именно эта форма приходит в резолвер в бою: chatModelSignals/sseModelSignals несут configName
    // (имя активной записи), а is_default наружу не отдают — модуль D.9 отбирает запись по нему сам.
    expect(resolve({ modelType: 'default', configName: 'Быстрый' })).toBe(V4_FLASH);
    expect(resolve({ modelType: 'default', configName: 'Instant' })).toBe(V4_FLASH);
  });

  test('R1 (v94): {model_type:"default"} без захваченной конфигурации — это unified default, а не ""', () => {
    // Было "" (фолбэк deepseek-v3/128K): у старых чатов нет conversation_mode, и структурный
    // матч по паре (default, DEFAULT) не срабатывал. Теперь пустой режим при model_type:"default"
    // = unified-модель (1M), поэтому конфигурация для матча не требуется.
    expect(resolve({ modelType: 'default' })).toBe(V4_FLASH);
    expect(resolve({ modelType: 'default', configName: null, conversationMode: '' })).toBe(V4_FLASH);
    // непустой не-DEFAULT режим по-прежнему не маппится: пины новых чатов целы
    expect(resolve({ modelType: 'default', conversationMode: 'EXPERT' })).toBe('');
  });

  test('R2 (регрессия): пустые сигналы → "" → фолбэк (c) по thinking_enabled', () => {
    expect(resolve({})).toBe('');
    expect(resolve()).toBe('');
    expect(resolve(undefined)).toBe('');
  });

  test('R3 (регрессия): неполная структурная пара (mode=expert) имя не подменяет', () => {
    expect(resolve({ modelType: 'expert', isDefault: true, configName: 'Быстрый' })).toBe('');
    expect(resolve({ modelType: 'expert' })).toBe('');
  });

  test('S0 (пин кода): локализованного имени в матче нет, структурная пара и комментарий контракта — на месте', () => {
    expect(KERNEL_SRC).toContain("(isDefaultType && (s.isDefault === true || configName !== ''))");
    expect(KERNEL_SRC).not.toContain("configName === 'instant'");
    expect(KERNEL_SRC).toContain('Контракт сети 2026-10-11: name локализуется (Instant / Быстрый / Fast)');
  });
});

// ---------------------------------------------------------------------------
// Стенд: конкатенация модулей + ядро (js[] одного registration) в jsdom.
// fetch-мок отдаёт тело истории и тело /client/settings (как живой перехватчик D.7).
// ---------------------------------------------------------------------------
function settingsFixture(name, isDefault) {
  return {
    code: 0,
    data: {
      biz_data: {
        settings: {
          model_configs: {
            value: [
              { name: name, model_type: 'default', is_default: isDefault === true, enabled: true, switchable: true },
              { name: 'Expert', model_type: 'expert', is_default: false, enabled: true }
            ]
          }
        }
      }
    }
  };
}

function histFixture() {
  return {
    code: 0,
    data: {
      biz_data: {
        chat_session: { current_message_id: 'a1', model_type: 'default', is_empty: false },
        chat_messages: [
          {
            message_id: 'u1', parent_id: null, role: 'USER', thinking_enabled: false,
            inserted_at: '2026-10-11T13:47:40.000Z', accumulated_token_usage: 100,
            fragments: [{ type: 'REQUEST', content: 'Вопрос' }]
          },
          {
            message_id: 'a1', parent_id: 'u1', role: 'ASSISTANT', thinking_enabled: false,
            inserted_at: '2026-10-11T13:47:41.000Z', accumulated_token_usage: 900,
            fragments: [{ type: 'RESPONSE', content: 'Ответ' }]
          }
        ]
      }
    }
  };
}

function makeStand(convId) {
  const vc = new VirtualConsole();
  const logs = [];
  ['log', 'warn', 'error'].forEach((k) => vc.on(k, (...a) => logs.push(a.map(String).join(' '))));
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://chat.deepseek.com/a/chat/s/' + convId,
    runScripts: 'dangerously',
    virtualConsole: vc
  });
  const { window } = dom;
  window.TextDecoder = TextDecoder;
  let historyBody = null;
  let settingsBody = null;
  window.fetch = (input) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || '');
    const body = (url.indexOf('history_messages') !== -1) ? historyBody
      : (url.indexOf('client/settings') !== -1) ? settingsBody : null;
    const payload = () => Promise.resolve(body);
    return Promise.resolve({
      ok: true, status: 200, json: payload, text: () => Promise.resolve(''),
      clone: () => ({ json: payload, text: () => Promise.resolve('') })
    });
  };
  window.eval(INTERCEPT_SRC);
  const emits = [];
  window.addEventListener('ai-cm-full-history', (e) => emits.push(e.detail));
  return {
    window, dom, logs, emits,
    setHistory: (b) => { historyBody = b; },
    setSettings: (b) => { settingsBody = b; },
    slugs: () => emits.map((d) => JSON.parse(JSON.stringify(d)).modelSlug)
  };
}

const SETTINGS_URL = 'https://chat.deepseek.com/api/v0/client/settings?scope=model';
const historyUrl = (cid) => 'https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=' + cid + '&cache_version=abc';
const settle = async (t) => {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    let p = Promise.resolve();
    for (let j = 0; j < (t || 120); j++) p = p.then(() => { });
    await p;
  }
};

describe('E3: ре-эмит снимка при ПЕРВОМ захвате активной конфигурации', () => {
  test('S1: история (unified default) → настройки name:"Быстрый"/is_default:true → РОВНО +1 публикация и flash в payload', async () => {
    const stand = makeStand('convE3a');
    stand.setHistory(histFixture());
    await stand.window.fetch(historyUrl('convE3a'));
    await settle(150);

    const base = stand.emits.length;                 // базовое число публикаций
    expect(base).toBe(1);
    // v94: chat_session.model_type:"default" БЕЗ conversation_mode — уже unified-модель,
    // поэтому базовый снимок несёт flash, а не прежний фолбэк deepseek-v3.
    expect(stand.slugs()).toEqual([V4_FLASH]);

    stand.setSettings(settingsFixture('Быстрый', true));
    await stand.window.fetch(SETTINGS_URL);
    await settle(150);

    expect(stand.emits.length).toBe(base + 1);        // пин ре-эмита: ровно +1
    expect(stand.slugs()[base]).toBe(V4_FLASH);       // бейдж виджета получает flash, не дожидаясь обмена

    await stand.window.fetch(SETTINGS_URL);           // повторный опрос: перехода нет
    await settle(150);
    expect(stand.emits.length).toBe(base + 1);        // ре-эмита нет — сброс дедупа только по сигналу settings

    stand.dom.window.close();
  });

  test('S2 (сам дефект): настройки захвачены ДО истории → первый же снимок несёт flash', async () => {
    const stand = makeStand('convE3b');
    stand.setSettings(settingsFixture('Быстрый', true));
    await stand.window.fetch(SETTINGS_URL);
    await settle(150);
    expect(stand.emits.length).toBe(0);               // ходов ещё нет — публиковать нечего

    stand.setHistory(histFixture());
    await stand.window.fetch(historyUrl('convE3b'));
    await settle(150);
    expect(stand.emits.length).toBe(1);
    expect(stand.slugs()).toEqual([V4_FLASH]);

    stand.dom.window.close();
  });

  test('S3 (пин проводки): обёртка D.9 шлёт событие только на переходе, ядро публикует через алиас единой точки', () => {
    expect(SSE_SRC).toContain('var e3IngestSettings = ingestModelSettings;');
    expect(SSE_SRC).toContain('if (!e3HadConfig && sseConfigName)');
    expect(SSE_SRC).toContain("window.dispatchEvent(new CustomEvent('ai-cm-deepseek-settings-captured'))");
    expect(KERNEL_SRC).toContain("window.addEventListener('ai-cm-deepseek-settings-captured', __aiCmDeepseekReemitAfterSettings)");
    expect(KERNEL_SRC).toContain('publishBaseSnapshot(lastBaseServerTokens, lastBaseChatMode)');
    // дедуп O-22 снимается только в ре-эмите по сигналу settings
    expect(KERNEL_SRC).toContain('lastDispatchSig = null; publishBaseSnapshot');
  });
});
