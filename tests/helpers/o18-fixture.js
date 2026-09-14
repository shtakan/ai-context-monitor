/**
 * O-18 (фаза 2): загрузчик регресс-фикстур экспортного дозапроса и SSE-кольца.
 *
 * Приоритет — СЫРЬЁ живого прогона 19-12 из tools/fixtures/ (gitignored, генерируется
 * tools/_o18-fixture-gen.js из дампа фазы 1 и файла автоэкспорта: 400 сырых дельт кольца,
 * префикс файла до обрыва «…DEFAULT_SU», триггер «BSCRIPT»/«ION»). Так регресс-тест
 * проверяет РЕАЛЬНЫЕ байты прогона, а не пересказ.
 *
 * Если фикстур нет (чистый checkout, tools/ в .gitignore) — синтезируется эквивалентная
 * по СИГНАТУРЕ фикстура: контент-чанк из заглавных латинских букв (>= 3) после префикса,
 * обрывающегося на «…DEFAULT_SU», + сырое кольцо дельт с CAPS-словами MV3
 * (OFFSCREEN_DOCUMENT/PARSER/URL/DOM). Сигнатура воспроизводит дефект 1:1:
 * до фикса такой чанк заводил НОВЫЙ «тип» фрагмента и текст ответа обрывался.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FIX = path.join(ROOT, 'tools', 'fixtures');

const RECONSTRUCTED = {
  OFFSCREEN_DOCUMENT: ['OFF', 'SC', 'REEN', '_DOC', 'UMENT'],
  DEFAULT_SUBSCRIPTION: ['DEFAULT_SU', 'BSCRIPT', 'ION'],
  PARSER: ['P', 'ARS', 'ER'],
  URL: ['URL'],
  DOM: ['DOM']
};

function synthPrefix() {
  // Реальный live-текст прогона: JS-код с DEFAULT_SUBSCRIPTION, обрыв на «…DEFAULT_SU».
  return 'Архитектура Chrome-расширений Manifest V3: подробный обзор\n\n' +
    'Сервис-воркер не может держать состояние в памяти: браузер выгружает его между событиями, ' +
    'поэтому любая долгая операция без таймаута может зависнуть. Пример кэша подписки:\n\n' +
    'async function getSubscription() {\n' +
    '  const cache = await chrome.storage.local.get(\'subscriptionCache\');\n' +
    '  return new Promise((resolve) => {\n' +
    '    setTimeout(() => {\n' +
    '      resolve(cache.subscriptionCache || DEFAULT_SU';
}
function synthRing() {
  const text = 'BSCRIPTION);\n    }, 3000);\n  });\n}\n\n' +
    'Перехват запросов в MV3 строится на chrome.webRequest и chrome.declarativeNetRequest; ' +
    'разбор ответа — через DOMParser, а не через прямой DOM документа. Работа с URL и DOM ' +
    'требует осторожности: OFFSCREEN_DOCUMENT создаётся отдельно, PARSER живёт в воркере, ' +
    'и если worker неактивен, нужны таймауты. Поэтому примените описанные паттерны.';
  const deltas = [];
  for (let i = 0; i < text.length; i += 4) deltas.push(text.slice(i, i + 4));
  return { deltas, text };
}

function synth() {
  const answerPrefix = synthPrefix();
  const ring = synthRing();
  const trigger = ['BSCRIPT', 'ION'];
  const expectedAnswer = answerPrefix + trigger.join('') + ring.text;
  const think = 'Нужен подробный разбор MV3 с примерами кода и предупреждениями о таймаутах.';
  const sseF = {
    o18: 'sse-fragment-desync',
    synthetic: true,
    source: { dump: '(нет tools/fixtures — синтезированная фикстура)', conv: 'e2685332', turn: 4 },
    think: think,
    answerPrefix: answerPrefix,
    prefixDeltas: (() => {
      const out = [];
      for (let i = 0; i < answerPrefix.length; i += 7) out.push(answerPrefix.slice(i, i + 7));
      return out;
    })(),
    triggerChunks: trigger,
    bogusTypesFromDump: ['BSCRIPT', 'ION', 'OFF', 'REEN', 'UMENT', 'URL', 'DOM', 'ARS'],
    ringDeltas: ring.deltas,
    ringText: ring.text,
    expectedAnswer: expectedAnswer,
    manualExportIdentical: true,
    reconstructedWords: RECONSTRUCTED,
    bogusTypesAllTypeShaped: true
  };
  const netHistory = {
    code: 0,
    data: {
      biz_data: {
        chat_session: { current_message_id: '4', model_type: 'expert', is_empty: false },
        chat_messages: [
          { message_id: '3', parent_id: null, role: 'USER', thinking_enabled: true, accumulated_token_usage: 1200, fragments: [{ type: 'REQUEST', content: 'Пользователь просит пример.' }] },
          { message_id: '4', parent_id: '3', role: 'ASSISTANT', thinking_enabled: true, accumulated_token_usage: 9000, fragments: [{ type: 'THINK', content: think }, { type: 'RESPONSE', content: expectedAnswer }] }
        ]
      }
    }
  };
  return {
    sseRing: sseF,
    scenarios: {
      o18: 'export-net-sync',
      synthetic: true,
      source: { conv: 'e2685332' },
      liveTurn: { requestId: '3', responseId: '4', prompt: 'Пользователь просит пример.', think: think, answer: answerPrefix },
      netHistoryFull: netHistory,
      netHistoryEmpty: {
        code: 0,
        data: { biz_data: { chat_session: { current_message_id: null, model_type: 'expert', is_empty: true }, chat_messages: [] } }
      }
    }
  };
}

function readJson(name) {
  try {
    const p = path.join(FIX, name);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}

// AI_CM_O18_SYNTH=1 — принудительно синтезированная фикстура (проверка фолбэка чистого checkout).
const forceSynth = process.env.AI_CM_O18_SYNTH === '1';
const sseRingReal = forceSynth ? null : readJson('deepseek-o18-sse-ring.json');
const scenariosReal = forceSynth ? null : readJson('deepseek-o18-export-scenarios.json');
const fallback = (sseRingReal && scenariosReal) ? null : synth();

module.exports = {
  fromLiveRun: !!(sseRingReal && scenariosReal),
  sseRing: sseRingReal || fallback.sseRing,
  scenarios: scenariosReal || fallback.scenarios
};
