/**
 * П3-A (v95): живые сигналы модели DeepSeek приоритетнее исторического chat_session.model.
 *
 * ДЕФЕКТ (живой лог, convId 24d43019): payload chat_history_messages приносил
 * chat_session.model="deepseek-r1" (слаг, с которым чат был создан), и резолвер
 * __aiCmDeepseekResolveModelSlug возвращал его ДО анализа живых model_type /
 * conversation_mode. Снимок уходил с окном 128 000, а serverTokens=160123 давал
 * 125.1% вместо ~16%.
 *
 * ИСПРАВЛЕНИЕ: живые сигналы (model_type / conversation_mode / configName) анализируются
 * раньше исторического s.model; исторический слаг — фолбэк в самом конце, с маркером
 * historical в диаг-строке.
 *
 * D1 — дефект: исторический r1 + живые unified-сигналы → v4.1-flash и окно 1M.
 * D2 — регресс: исторический r1 + живые сигналы R1 → r1 и окно 128k (поведение прежнее).
 * D3 — фолбэк: живых сигналов нет → используется s.model, в диаг-строке маркер historical.
 */

const path = require('path');

const DS = require('./helpers/deepseek-intercept-source.js');
const INTERCEPT = require(path.join(DS.ROOT, DS.INTERCEPT_JS));
const ModelConfig = require('./helpers/load-esm.js').loadEsm('utils/model-config.ts');

const resolve = INTERCEPT.resolveNetworkModelSlug;

// Payload из chat_session: model — историческая запись чата,
// живые поля model_type / conversation_mode приходят из того же ответа/SSE.
function chatSessionSignals(over) {
  return Object.assign({
    modelPresent: true,
    model: 'deepseek-r1'
  }, over || {});
}

describe('DeepSeek: приоритет живых сигналов модели над историческим chat_session.model', () => {
  test('D1 (дефект): исторический r1 + живые unified-сигналы → v4.1-flash, окно 1 000 000, pct ~16%', () => {
    const signals = chatSessionSignals({ modelType: 'default', conversationMode: 'DEFAULT' });
    expect(resolve(signals)).toBe('deepseek-v4.1-flash');

    const ctx = ModelConfig.getContextLimit('deepseek-v4.1-flash');
    const eff = ModelConfig.getEffectiveLimit('deepseek-v4.1-flash');
    expect(ctx).toBe(1000000);
    expect(eff).toBe(1000000);

    // 160123 / 1 000 000 = 16.01%, а не 125% от 128 000
    const rawPct = (160123 / eff) * 100;
    expect(rawPct).toBeCloseTo(16.01, 1);
    expect(ModelConfig.calculatePercentage(160123, eff)).toBe(16);
  });

  test('D2 (регресс): исторический r1 + живые сигналы R1 → deepseek-r1, окно 128 000', () => {
    const signals = chatSessionSignals({ modelType: 'expert', conversationMode: '' });
    expect(resolve(signals)).toBe('deepseek-r1');
    expect(ModelConfig.getEffectiveLimit('deepseek-r1')).toBe(128000);

    const rawPct = (160123 / ModelConfig.getEffectiveLimit('deepseek-r1')) * 100;
    expect(rawPct).toBeCloseTo(125.1, 1); // прежнее поведение сохранено
  });

  test('D3 (фолбэк): живых сигналов нет → s.model, в диаг-строке маркер historical', () => {
    const marks = [];
    const prevDiag = window.AiCmDeepseekDiag;
    window.AiCmDeepseekDiag = {
      diagOn: () => true,
      diagMark: (kind, data) => marks.push({ kind: kind, data: data })
    };
    try {
      expect(resolve(chatSessionSignals())).toBe('deepseek-r1');
      expect(marks.length).toBe(1);
      expect(marks[0].kind).toContain('historical');
      expect(marks[0].data.model).toBe('deepseek-r1');
    } finally {
      if (prevDiag === undefined) delete window.AiCmDeepseekDiag;
      else window.AiCmDeepseekDiag = prevDiag;
    }

    // и без диага фолбэк тот же — исторический слаг не теряется
    expect(resolve(chatSessionSignals())).toBe('deepseek-r1');
  });
});
