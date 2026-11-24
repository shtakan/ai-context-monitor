'use strict';

/**
 * Чистая логика живого лимит-теста (см. tools/live-limit-test.js).
 *
 * Здесь нет браузера и файловой системы: только генерация наполнителя,
 * разбор ответа-пробы, классификация попытки и бинарный поиск окна.
 * Поэтому всё это покрыто обычными unit-тестами.
 *
 * Идея теста:
 *   1. Наполняем чат детерминированным текстом, пока виджет расширения не
 *      покажет нужное число токенов (расширение — измерительный прибор,
 *      а не наша оценка).
 *   2. В самом первом и самом последнем сообщении лежат уникальные метки.
 *   3. Спрашиваем обе метки. Если первая потеряна, а последняя видна —
 *      ранний контекст вытеснен, то есть окно меньше измеренного объёма.
 *      Если видны обе — окно не меньше измеренного объёма.
 *   4. Серверный баннер «Контекстное окно заполнено» — авторитетный
 *      признак переполнения.
 */

/**
 * Слова намеренно только латиница: предсказуемая токенизация, никаких
 * сюрпризов с кодировкой при передаче в браузер.
 */
const WORDS = [
  'amber', 'anchor', 'arrow', 'atlas', 'bamboo', 'barrel', 'beacon', 'birch',
  'boulder', 'bracket', 'bridge', 'bronze', 'cabin', 'cactus', 'candle', 'canvas',
  'canyon', 'carbon', 'castle', 'cedar', 'cement', 'cipher', 'circle', 'clover',
  'copper', 'coral', 'cotton', 'crater', 'crystal', 'dahlia', 'delta', 'desert',
  'diamond', 'dolphin', 'dragon', 'drift', 'eagle', 'echo', 'ember', 'emerald',
  'engine', 'falcon', 'fathom', 'feather', 'fennel', 'ferry', 'fiber', 'fjord',
  'flint', 'forest', 'fossil', 'fountain', 'galaxy', 'garden', 'garlic', 'ginger',
  'glacier', 'granite', 'gravel', 'harbor', 'hazel', 'heron', 'hickory', 'hollow',
  'indigo', 'island', 'ivory', 'jasper', 'jungle', 'juniper', 'kernel', 'kettle',
  'lagoon', 'lantern', 'lattice', 'lava', 'lemon', 'lichen', 'lilac', 'linen',
  'lobster', 'lotus', 'magnet', 'mango', 'maple', 'marble', 'meadow', 'mesa',
  'meteor', 'mint', 'mirror', 'monsoon', 'moss', 'nectar', 'nickel', 'north',
  'oasis', 'obsidian', 'ocean', 'olive', 'onyx', 'opal', 'orbit', 'orchid',
  'otter', 'paddle', 'pebble', 'pepper', 'petal', 'pillar', 'pine', 'planet',
  'plasma', 'plum', 'prairie', 'prism', 'quartz', 'quill', 'raven', 'reef',
  'ridge', 'river', 'robin', 'saffron', 'sage', 'sail', 'sequoia', 'shale',
  'silver', 'slate', 'solar', 'sparrow', 'spruce', 'stellar', 'stone', 'summit',
  'sunset', 'tundra', 'turtle', 'umber', 'valley', 'velvet', 'violet', 'walnut',
  'willow', 'winter', 'wolf', 'yarrow', 'zephyr', 'zinc'
];

/** Детерминированный PRNG: одинаковый seed — одинаковый текст. */
function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function next() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Собирает наполнитель заданной длины (в символах).
 * Первые символы — метка `[[NID-<firstId>]]`, последние — `[[NID-<lastId>]]`.
 *
 * @param {{chars:number, seed:number, firstId:string, lastId:string, runId?:string}} opts
 * @returns {{text:string, chars:number, firstId:string, lastId:string, sentences:number}}
 */
function buildFiller(opts) {
  const target = Math.max(400, Number(opts.chars) || 0);
  const rand = mulberry32(Number(opts.seed) || 1);
  const firstId = String(opts.firstId || '');
  const lastId = String(opts.lastId || '');
  const runId = String(opts.runId || '');
  const head = '[[NID-' + firstId + ']]' + (runId ? ' LIMIT-TEST ' + runId : '');
  const tail = '[[NID-' + lastId + ']]';
  const body = [];
  let len = head.length + tail.length + 2;
  while (len <= target) {
    const n = 8 + Math.floor(rand() * 9);
    const words = [];
    for (let i = 0; i < n; i++) {
      words.push(WORDS[Math.floor(rand() * WORDS.length)]);
    }
    const sentence = words.join(' ') + '.';
    body.push(sentence);
    len += sentence.length + 1;
  }
  const text = head + ' ' + body.join(' ') + ' ' + tail;
  return { text: text, chars: text.length, firstId: firstId, lastId: lastId, sentences: body.length };
}

/**
 * Режет текст на куски не длиннее chunkChars, по границам предложений.
 * Первая метка остаётся в первом куске, последняя — в последнем.
 *
 * @param {string} text
 * @param {number} chunkChars
 * @returns {string[]}
 */
function splitIntoChunks(text, chunkChars) {
  const size = Math.max(1000, Number(chunkChars) || 0);
  const source = String(text || '');
  if (source.length <= size) return source ? [source] : [];

  const sentences = source.split(/(?<=\.)\s+/);
  const chunks = [];
  let current = '';
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i];
    if (current && current.length + 1 + sentence.length > size) {
      chunks.push(current);
      current = sentence;
    } else {
      current = current ? current + ' ' + sentence : sentence;
    }
    // Предложение само может быть длиннее лимита — режем жёстко.
    while (current.length > size) {
      chunks.push(current.slice(0, size));
      current = current.slice(size);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Текст пробы. Важно: идентификаторы в пробу НЕ попадают, иначе модель
 * может просто переписать их из вопроса и тест станет бессмысленным.
 */
function probeMessage() {
  return [
    'Не пересказывай предыдущий текст.',
    'Назови дословно два идентификатора в двойных квадратных скобках:',
    'FIRST — из самого первого сообщения этого чата,',
    'LAST — из последнего сообщения перед этим вопросом.',
    'Формат ответа ровно такой: FIRST=<идентификатор> LAST=<идентификатор>.',
    'Если идентификатор недоступен, напиши NOTFOUND вместо него.'
  ].join(' ');
}

/**
 * Разбирает ответ на пробу. Совпадение только точное: 8 hex-символов
 * случайно не угадать, поэтому «эхо из вопроса» исключено.
 *
 * @param {string} answer
 * @param {string} firstId
 * @param {string} lastId
 * @returns {{first:boolean, last:boolean, verdict:string, empty:boolean}}
 */
function parseProbeAnswer(answer, firstId, lastId) {
  const raw = String(answer || '');
  const low = raw.toLowerCase();
  const first = String(firstId || '').toLowerCase();
  const last = String(lastId || '').toLowerCase();
  const hasFirst = !!first && low.indexOf(first) !== -1;
  const hasLast = !!last && low.indexOf(last) !== -1;
  let verdict;
  if (hasFirst && hasLast) verdict = 'both';
  else if (hasLast && !hasFirst) verdict = 'first-lost';
  else if (hasFirst && !hasLast) verdict = 'last-lost';
  else if (/notfound|not\s+found|не\s+вижу|недоступ/i.test(raw)) verdict = 'notfound';
  else verdict = 'none';
  return { first: hasFirst, last: hasLast, verdict: verdict, empty: raw.trim() === '' };
}

/**
 * Классифицирует попытку.
 * relation: 'ge' — окно не меньше измеренного объёма, 'lt' — меньше,
 * 'unknown' — попытка ничего не доказывает.
 *
 * @param {{tokens:number, saturation?:boolean, inputRejected?:boolean, probe?:object}} trial
 * @returns {{kind:string, relation:string}}
 */
function classifyTrial(trial) {
  const t = trial || {};
  if (t.saturation) return { kind: 'saturated', relation: 'lt' };
  if (t.sendFailed) return { kind: 'send-failed', relation: 'unknown' };
  if (t.inputRejected) return { kind: 'input-rejected', relation: 'unknown' };
  if (!Number(t.tokens)) return { kind: 'no-measurement', relation: 'unknown' };
  const p = t.probe || {};
  if (p.verdict === 'timeout' || p.verdict === 'skipped') return { kind: 'probe-missing', relation: 'unknown' };
  if (p.first && p.last) return { kind: 'recall-ok', relation: 'ge' };
  if (!p.first && p.last) return { kind: 'early-truncated', relation: 'lt' };
  if (p.first && !p.last) return { kind: 'recent-missing', relation: 'unknown' };
  if (p.verdict === 'notfound' || p.verdict === 'none') return { kind: 'no-recall', relation: 'unknown' };
  return { kind: 'inconclusive', relation: 'unknown' };
}

/** Начальное состояние бинарного поиска. high=Infinity — верхняя граница неизвестна. */
function createState(opts) {
  const o = opts || {};
  return {
    low: Number(o.low) || 0,
    high: Number.isFinite(Number(o.high)) && Number(o.high) > 0 ? Number(o.high) : Infinity,
    trials: []
  };
}

/**
 * Применяет попытку к интервалу. trial.tokens — измеренное число токенов
 * (из виджета), а не оценка по символам.
 */
function applyTrial(state, trial) {
  const s = {
    low: state.low,
    high: state.high,
    trials: state.trials.concat([trial])
  };
  const x = Number(trial && trial.tokens) || 0;
  if (x > 0 && (trial.relation === 'ge' || trial.relation === 'lt')) {
    if (trial.relation === 'ge') s.low = Math.max(s.low, x);
    else s.high = Math.min(s.high, x);
  }
  return s;
}

/**
 * Пора ли остановить бинарный поиск.
 * tolerance — относительная ширина интервала (0.1 = 10 %).
 */
function bracketDone(state, tolerance) {
  const tol = Number(tolerance) > 0 ? Number(tolerance) : 0.1;
  const high = state.high;
  if (!Number.isFinite(high) || high <= 0) return false;
  if (state.low <= 0) return false;
  return (high - state.low) <= high * tol;
}

/** Следующая точка замера (в токенах) или null, если интервал закрыт. */
function nextPoint(state, tolerance) {
  if (bracketDone(state, tolerance)) return null;
  if (!Number.isFinite(state.high)) return null;
  if (state.low <= 0) return Math.max(16000, Math.round(state.high / 2));
  return Math.round((state.low + state.high) / 2);
}

/**
 * Список стартовых точек для режима.
 *  quick   — дешёвая проверка «окно хотя бы 32K»;
 *  confirm — одна попытка на заявленном окне (например, 1 050 000);
 *  bracket — начать с заявленного окна и дальше сужать автоматически.
 */
function planPoints(opts) {
  const o = opts || {};
  const mode = o.mode || 'confirm';
  const target = Number(o.target) || 1050000;
  if (mode === 'quick') return [Number(o.point) || 32000];
  if (mode === 'confirm') return [target];
  if (mode === 'bracket') return [target];
  throw new Error('unknown mode: ' + mode);
}

/**
 * Итоговое решение по конфигу. Программа ничего не пишет в model-config
 * сама: она выдаёт рекомендацию, решение принимает владелец.
 *
 * @param {{low:number, high:number, trials:object[]}} state
 * @param {{separable:boolean|null}|null} recon
 */
function decide(state, recon) {
  const r = recon || {};
  if (r.separable === false) {
    return {
      code: 'not-separable',
      interval: null,
      suggestedContextLimit: null,
      note: 'В UI нет отдельного выбора gpt-6-mini: чат обслуживается как GPT-6. Отдельная запись не нужна, схлопывание оставить.'
    };
  }
  const low = Math.max(0, Number(state.low) || 0);
  const high = Number.isFinite(state.high) ? Number(state.high) : null;
  if (low > 0 && high !== null && (high - low) <= high * 0.1) {
    return {
      code: 'measured',
      interval: [low, high],
      suggestedContextLimit: Math.floor(low / 1000) * 1000,
      note: 'Интервал уже 10 %. Консервативная рекомендация — нижняя граница: она гарантированно достигается и не завышает процент.'
    };
  }
  if (low > 0 && high === null) {
    return {
      code: 'at-least',
      interval: [low, null],
      suggestedContextLimit: Math.floor(low / 1000) * 1000,
      note: 'Достигнут только нижний предел. Для отдельной записи можно использовать его как консервативное окно; верхняя граница не измерена.'
    };
  }
  if (low <= 0 && high !== null) {
    return {
      code: 'below',
      interval: [0, high],
      suggestedContextLimit: null,
      note: 'Ни один замер не подтвердил окно: ранний контекст терялся уже на этом объёме. Верхняя граница известна, нижняя — нет; отдельную запись с большим окном добавлять нельзя.'
    };
  }
  return {
    code: 'unresolved',
    interval: null,
    suggestedContextLimit: null,
    note: 'Замеры не дали однозначного результата. Решение по умолчанию — оставить схлопывание в GPT-6 и зафиксировать это в документации.'
  };
}

module.exports = {
  WORDS: WORDS,
  mulberry32: mulberry32,
  buildFiller: buildFiller,
  splitIntoChunks: splitIntoChunks,
  probeMessage: probeMessage,
  parseProbeAnswer: parseProbeAnswer,
  classifyTrial: classifyTrial,
  createState: createState,
  applyTrial: applyTrial,
  bracketDone: bracketDone,
  nextPoint: nextPoint,
  planPoints: planPoints,
  decide: decide
};
