/**
 * Контрактный тест детекции модели DeepSeek по новому сетевому контракту (v13).
 *
 * ЗАХВАТ: 2026-10-03 ~21:12, chat.deepseek.com (координатор проекта, реальные XHR/SSE).
 * Источник правды — три payload'а ниже, усечённые до контрактных полей:
 *   1) SSE `ready` события XHR /api/v0/chat/completion;
 *   2) SSE `update_session` того же потока;
 *   3) /api/v0/client/settings?did=<uuid>&scope=model → biz_data.settings.model_configs.value[0].
 *
 * Суть контракта: имя модели в сети БОЛЬШЕ НЕ ПЕРЕДАЁТСЯ (model:"" + model_type:"default",
 * UI-имя конфигурации "Instant", show_model_name_in_session:false). Прежняя эвристика
 * (thinking_enabled → r1/v3) давала устаревший slug и лимит 15 625/65 536/128 000 вместо
 * 1 000 000. Детекция обязана вернуть 'deepseek-v4.1-flash', а виджет — считать от 1M.
 *
 * Резолвер — чистая функция __aiCmDeepseekResolveModelSlug из core/deepseek-intercept.js
 * (экспортирована через module.exports для тестов, в браузере не влияет).
 */

const path = require('path');

const DS = require('./helpers/deepseek-intercept-source.js');
// Step D.1: путь к ядру берётся из карты источников (единая точка правды). Сам ядро
// грузится БЕЗ модуля диагностики осознанно: тест проверяет чистый резолвер K0
// (module.exports не тронут декомпозицией), а diag-пути в нём не исполняются —
// связка видит aiCmDeepseekDiag === null и пропускает __bind, форвардеры не зовутся.
const INTERCEPT = require(path.join(DS.ROOT, DS.INTERCEPT_JS));
const ModelConfig = require(path.join(__dirname, '..', 'utils', 'model-config.js'));

// ---- РЕАЛЬНЫЕ ЗАХВАЧЕННЫЕ PAYLOAD'Ы (усечены до контрактных полей) ----
// 1) SSE ready (XHR /api/v0/chat/completion)
const CAPTURE_READY = JSON.parse('{"request_message_id":9,"response_message_id":10,"model_type":"default"}');
// 2) SSE update_session (тот же поток; ... — прочие поля ответа опущены)
const CAPTURE_UPDATE_SESSION = JSON.parse(
  '{"v":{"response":{"message_id":10,"parent_id":9,"model":"","role":"ASSISTANT",' +
  '"thinking_enabled":true,"status":"WIP","accumulated_token_usage":3196,"conversation_mode":"DEFAULT"}}}'
);
// 3) /api/v0/client/settings?did=<uuid>&scope=model → value[0]
const CAPTURE_SETTINGS_VALUE0 = JSON.parse(
  '{"model_type":"default","name":"Instant","is_default":true,"enabled":true,"switchable":true,' +
  '"show_model_name_in_session":false,"input_character_limit":2621440,' +
  '"file_feature":{"token_limit":890880,"token_limit_with_thinking":890880}}'
);

// Сигналы из реальных payload'ов: ready даёт model_type, update_session — model/conversation_mode.
function signalsFromCapture(ready, updateSession) {
  const resp = (updateSession && updateSession.v && updateSession.v.response) || {};
  return {
    modelPresent: Object.prototype.hasOwnProperty.call(resp, 'model'),
    model: resp.model,
    modelType: ready && ready.model_type,
    conversationMode: resp.conversation_mode
  };
}

describe('DeepSeek v4.1-flash: контракт детекции модели от 2026-10-03', () => {
  test('резолвер экспортирован (jest) и совпадает с window-экспортом перехватчика', () => {
    expect(typeof INTERCEPT.resolveNetworkModelSlug).toBe('function');
    expect(INTERCEPT.DEEPSEEK_V4_FLASH_SLUG).toBe('deepseek-v4.1-flash');
    expect(window.__aiCmDeepseekResolveModelSlug).toBe(INTERCEPT.resolveNetworkModelSlug);
  });

  test('ready(model_type=default) + update_session(model="", conversation_mode=DEFAULT) → deepseek-v4.1-flash', () => {
    const signals = signalsFromCapture(CAPTURE_READY, CAPTURE_UPDATE_SESSION);
    expect(signals.modelType).toBe('default');
    expect(signals.model).toBe('');
    expect(signals.conversationMode).toBe('DEFAULT');
    expect(INTERCEPT.resolveNetworkModelSlug(signals)).toBe('deepseek-v4.1-flash');
  });

  test('settings value[0] (name="Instant", model_type="default") → deepseek-v4.1-flash', () => {
    expect(CAPTURE_SETTINGS_VALUE0.name).toBe('Instant');
    expect(
      INTERCEPT.resolveNetworkModelSlug({
        modelType: CAPTURE_SETTINGS_VALUE0.model_type,
        configName: CAPTURE_SETTINGS_VALUE0.name
      })
    ).toBe('deepseek-v4.1-flash');
  });

  test('model="" + conversation_mode=DEFAULT без model_type — тоже новый контракт', () => {
    expect(
      INTERCEPT.resolveNetworkModelSlug({ modelPresent: true, model: '', conversationMode: 'DEFAULT' })
    ).toBe('deepseek-v4.1-flash');
  });

  test('(a) явное непустое имя модели из сети приоритетнее сигналов контракта', () => {
    expect(
      INTERCEPT.resolveNetworkModelSlug({
        modelPresent: true, model: 'deepseek-v3', modelType: 'default', conversationMode: 'DEFAULT'
      })
    ).toBe('deepseek-v3');
  });

  test('(c) старые сигналы (expert / пустой набор) резолвер не маппит — прежний фолбэк сохранён', () => {
    expect(INTERCEPT.resolveNetworkModelSlug({ modelType: 'expert' })).toBe('');
    expect(INTERCEPT.resolveNetworkModelSlug({})).toBe('');
    expect(INTERCEPT.resolveNetworkModelSlug(undefined)).toBe('');
    // history chat_session без model/conversation_mode (старые фикстуры) — не трогаем
    expect(INTERCEPT.resolveNetworkModelSlug({ modelType: 'default' })).toBe('');
  });

  test('ModelConfig: ключ есть, окно 1M, послабление потолка только у нового ключа', () => {
    const model = ModelConfig.getModel('deepseek-v4.1-flash');
    expect(model).toBeTruthy();
    expect(model.name).toBe('DeepSeek V4.1 Flash');
    expect(model.contextLimit).toBe(1000000);
    expect(ModelConfig.getEffectiveLimit('deepseek-v4.1-flash')).toBe(1000000);
    // прежние ключи не изменились
    expect(ModelConfig.getEffectiveLimit('deepseek-v3')).toBe(128000);
    expect(ModelConfig.getEffectiveLimit('deepseek-r1')).toBe(128000);
    // siteDefaults.deepseek НЕ тронут (иначе падает qwen-provider-wiring)
    expect(ModelConfig.getDefaultModel('deepseek')).toBe('deepseek-v3');
  });

  test('процент при serverTokens=3476 и лимите 1M ≈ 0.35 (2 знака), сырая доля в допуске 0.01', () => {
    const limit = ModelConfig.getEffectiveLimit('deepseek-v4.1-flash');
    const rawPct = (3476 / limit) * 100;
    expect(rawPct).toBeCloseTo(0.35, 2);                       // сырая доля
    expect(Math.round(rawPct * 100) / 100).toBe(0.35);         // 2 знака
    // виджет округляет до 1 знака (tests/popup-overrides-display.test.js) → 0.3
    expect(ModelConfig.calculatePercentage(3476, limit)).toBe(0.3);
  });
});
