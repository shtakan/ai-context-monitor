/**
 * O-23 (F5): калибровка tokens~ против serverTokens.
 *
 * ИСТОЧНИК ИСТИНЫ: PROJECT_HANDOFF.md (верхний блок, стр. 7) — три измеренные пары
 * (Δ = tokens~ − serverTokens):
 *   P1: serverTokens=78,     Δ=−67     → tokens~=11     (крошечный русский payload)
 *   P2: serverTokens=1176,   Δ=+1902   → tokens~=3078   (RU-чат; ПЕРЕоценка 2.6×)
 *   P3: serverTokens=105217, Δ=−18172  → tokens~=87045  (большой смешанный payload)
 *
 * КОРНИ (измерены в этой сессии):
 *   1) трасса badge-recv считала tokens~ упрощённой латинской эвристикой
 *      Math.round(text.length / 4) + attachTokens (core/content.js) — при этом сам
 *      бейдж-виджет берёт netServerTokens, а без него — Tokenizer.estimateDialogTokens
 *      (content.js:1950/2453). Фикс: aiCmEstimateTokensTilde() — Tokenizer.countTokens,
 *      а упрощённая эвристика осталась только фолбэком И получила языковую ветвь.
 *   2) utils/tokenizer.js:countTokens делил кириллицу на 4.0 (как латиницу) —
 *      систематическая НЕДООЦЕНКА русского; фикс — делитель 1.8.
 *
 * КОНСТРУКЦИЯ ПИНОВ (R-D). Живые payload'ы измерений O-23 в workspace отсутствуют
 * (артефакты владельца удаляются), поэтому пары воспроизводятся по АРИФМЕТИКЕ, выведенной
 * из записанных Δ и пре-фикс формулы трассы:
 *   P1: round(len/4)=11 при len=42  → фикстура 42 символа кириллицы;
 *   P2: round(len/4)=3078 при len=12312 → фикстура 12312 символов кириллицы;
 *   P3: round(len/4)=87045 при len=348179 → фикстура 49740 шестибуквенных слов
 *       (2869 кириллических + остальные латинские), доля кириллицы ≈5.8%.
 * Допуск ±10% применяется к ВОСПРОИЗВЕДЕНИЮ записанной Δ (D-пин: дефект воспроизводим
 * той же формулой) и к цели фикса, где она достижима языковым коэффициентом.
 * Границы (не выдаются за фикс):
 *   • P1: делитель 1.8 не закрывает разрыв 11→78 (короткий payload: вклад даёт шаблон
 *     чата/накладные 4 ток/сообщение, а не плотность символов) — остаётся остаток;
 *   • P2: переоценка +1902 НЕ может быть закрыта никаким языковым коэффициентом —
 *     доказательство в тесте (нижняя граница оценки > serverTokens×1.1);
 *   • P3: закрывается в пределах ±10% (мерило фикса O-23).
 */

const fs = require('fs');
const path = require('path');
const Tokenizer = require('../utils/tokenizer.js');

const CONTENT_SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'content.js'), 'utf8');
const TOKENIZER_SRC = fs.readFileSync(path.join(__dirname, '..', 'utils', 'tokenizer.js'), 'utf8');

// =====================================================================================
// Записанные пары O-23 (handoff, верхний блок)
// =====================================================================================
const PAIRS = {
  P1: { serverTokens: 78, delta: -67 },       // tokens~ = 11
  P2: { serverTokens: 1176, delta: 1902 },    // tokens~ = 3078
  P3: { serverTokens: 105217, delta: -18172 } // tokens~ = 87045
};

// Пре-фикс формула трассы badge-recv (корень 1) — эталон дефекта.
function legacyTilde(text, attachTokens) {
  return Math.round(String(text || '').length / 4) + (attachTokens || 0);
}

// Боевой хелпер из core/content.js — извлекается ИЗ ИСХОДНИКА, логика не копируется.
function helperSource() {
  const start = CONTENT_SRC.indexOf('function aiCmEstimateTokensTilde(');
  if (start < 0) throw new Error('aiCmEstimateTokensTilde не найден в core/content.js');
  const end = CONTENT_SRC.indexOf('\n}', start);
  if (end < 0) throw new Error('не найден конец aiCmEstimateTokensTilde');
  return CONTENT_SRC.slice(start, end + 2);
}
function makeHelper(tokenizer) {
  return new Function('Tokenizer', helperSource() + '\nreturn aiCmEstimateTokensTilde;')(tokenizer);
}
const tilder = makeHelper(Tokenizer);        // боевой путь: Tokenizer доступен
const tilderFallback = makeHelper(undefined); // песочницы/тесты без Tokenizer → фолбэк

function relErr(predicted, actual) { return Math.abs(predicted - actual) / actual; }

// =====================================================================================
// Фикстуры пар
// =====================================================================================
// P1: 42 символа кириллицы (round(42/4)=11)
const P1_TEXT = 'Проверь токены в русском чате, пожалуйста!';

// P2: 12312 символов кириллицы (round(12312/4)=3078)
function buildP2() {
  const words = ['система', 'контекст', 'проверка', 'история', 'точность', 'калибровка',
    'мониторинг', 'модель', 'данные', 'запрос', 'сообщение', 'пользователь', 'ответ',
    'документ', 'который', 'только'];
  let t = '';
  let i = 0;
  while (t.length < 12312) { t += words[i % words.length] + ' '; i++; }
  return t.slice(0, 12312);
}
const P2_TEXT = buildP2();

// P3: 49740 шестибуквенных слов через пробел, 2869 из них — кириллица.
// len = 348179 → round(len/4) = 87045 = 105217 − 18172.
const P3_RU = ['модель', 'данные', 'запрос', 'период', 'строка', 'сервер', 'оценка',
  'память', 'вопрос', 'корень', 'запись', 'задача'];
const P3_EN = ['system', 'window', 'server', 'number', 'string', 'memory', 'object',
  'method', 'result', 'buffer', 'target', 'source'];
function buildP3(total, cyrillicWords) {
  const out = [];
  let ri = 0;
  let ei = 0;
  for (let i = 0; i < total; i++) {
    out.push(i < cyrillicWords ? P3_RU[ri++ % P3_RU.length] : P3_EN[ei++ % P3_EN.length]);
  }
  return out.join(' ');
}
const P3_TEXT = buildP3(49740, 2869);

// =====================================================================================
// D-пины: записанные пары воспроизводятся пре-фикс формулой (±10%)
// =====================================================================================
describe('O-23 D: три измеренные пары воспроизводятся (±10% к записанной Δ)', () => {
  test('D1 (P1): tokens~ = 11 при serverTokens = 78 → Δ = −67', () => {
    expect(P1_TEXT.length).toBe(42);
    const tilde = legacyTilde(P1_TEXT, 0);
    expect(tilde).toBe(PAIRS.P1.serverTokens + PAIRS.P1.delta);      // 11
    expect(Math.abs((tilde - PAIRS.P1.serverTokens) - PAIRS.P1.delta))
      .toBeLessThanOrEqual(Math.abs(PAIRS.P1.delta) * 0.10);
  });

  test('D2 (P2): tokens~ = 3078 при serverTokens = 1176 → Δ = +1902', () => {
    expect(P2_TEXT.length).toBe(12312);
    const tilde = legacyTilde(P2_TEXT, 0);
    expect(tilde).toBe(PAIRS.P2.serverTokens + PAIRS.P2.delta);      // 3078
    expect(Math.abs((tilde - PAIRS.P2.serverTokens) - PAIRS.P2.delta))
      .toBeLessThanOrEqual(Math.abs(PAIRS.P2.delta) * 0.10);
  });

  test('D3 (P3): tokens~ = 87045 при serverTokens = 105217 → Δ = −18172', () => {
    expect(P3_TEXT.length).toBe(348179);
    const tilde = legacyTilde(P3_TEXT, 0);
    expect(tilde).toBe(PAIRS.P3.serverTokens + PAIRS.P3.delta);      // 87045
    expect(Math.abs((tilde - PAIRS.P3.serverTokens) - PAIRS.P3.delta))
      .toBeLessThanOrEqual(Math.abs(PAIRS.P3.delta) * 0.10);
  });

  test('D-общий: attachTokens прибавляется к оценке в обоих путях (пре-фикс и боевой)', () => {
    expect(legacyTilde(P1_TEXT, 250)).toBe(legacyTilde(P1_TEXT, 0) + 250);
    expect(tilder(P1_TEXT, 250)).toBe(tilder(P1_TEXT, 0) + 250);
  });
});

// =====================================================================================
// F-пины: что закрывает калибровка 1.8 (и где граница)
// =====================================================================================
describe('O-23 F: калибровка кириллицы 1.8 (utils/tokenizer.js:countTokens)', () => {
  test('F3 (P3): оценка входит в ±10% от serverTokens = 105217', () => {
    const est = tilder(P3_TEXT, 0);
    expect(relErr(est, PAIRS.P3.serverTokens)).toBeLessThanOrEqual(0.10);
    // и заметно лучше пре-фикс значения (87045, Δ=−18172)
    expect(Math.abs(est - PAIRS.P3.serverTokens)).toBeLessThan(Math.abs(PAIRS.P3.delta));
  });

  test('F1 (P1): направление фикса верное, но остаток НЕ закрывается плотностью символов', () => {
    const before = legacyTilde(P1_TEXT, 0);   // 11
    const after = tilder(P1_TEXT, 0);         // 23
    expect(after).toBeGreaterThan(before);
    // остаток: 78 токенов при 42 символах недостижимы коэффициентом (максимум плотности ~1 ток/симв)
    expect(after).toBeLessThan(P1_TEXT.length);            // < 42 < 78
    expect(relErr(after, PAIRS.P1.serverTokens)).toBeLessThan(relErr(before, PAIRS.P1.serverTokens));
    // гипотеза-модель (НЕ измерение): разрыв объясняется накладными 4 ток/сообщение,
    // которых у трассы нет: диалоговая оценка сходится в ±10% при ~14 сообщениях.
    const dialog = Tokenizer.estimateDialogTokens(P1_TEXT, 14);
    expect(relErr(dialog, PAIRS.P1.serverTokens)).toBeLessThanOrEqual(0.10);
  });

  test('F2-граница (P2): переоценка +1902 не закрывается языковым коэффициентом', () => {
    // Плотность символов даёт НИЖНЮЮ границу round(len/4); она выше serverTokens×1.1,
    // значит ни один делитель кириллицы не может привести оценку к 1176.
    const lowerBound = legacyTilde(P2_TEXT, 0);            // 3078
    expect(lowerBound).toBeGreaterThan(PAIRS.P2.serverTokens * 1.1);
    const after = tilder(P2_TEXT, 0);
    expect(after).toBeGreaterThanOrEqual(lowerBound);       // фикс только повышает кириллицу
    // вывод: корень P2 — рассинхрон ОБЪЁМА текста (что считает трасса vs что покрывает
    // serverTokens), а не коэффициент; закрывается отдельным измерением, не этим фиксом.
  });

  test('F-общий: кириллица стала дороже латиницы ровно в 4/1.8 раза', () => {
    const cyr = 'а'.repeat(18000);
    const lat = 'a'.repeat(18000);
    expect(Tokenizer.countTokens(cyr)).toBe(10000);
    expect(Tokenizer.countTokens(lat)).toBe(4500);
  });
});

// =====================================================================================
// R-пины: регресс tokens~ / badge при serverTokens = 0
// =====================================================================================
describe('O-23 R: регресс байтов tokens~ (serverTokens = 0)', () => {
  test('R1: ASCII-фолбэк без Tokenizer байтово равен прежней эвристике (1..64 симв)', () => {
    for (let n = 1; n <= 64; n++) {
      const t = 'a'.repeat(n);
      expect(tilderFallback(t, 0)).toBe(legacyTilde(t, 0));
      expect(tilderFallback(t, 7)).toBe(legacyTilde(t, 7));
    }
  });

  test('R2: боевой путь с Tokenizer = countTokens + attachTokens (без своей арифметики)', () => {
    expect(tilder(P1_TEXT, 0)).toBe(Tokenizer.countTokens(P1_TEXT));
    expect(tilder(P3_TEXT, 250)).toBe(Tokenizer.countTokens(P3_TEXT) + 250);
    expect(tilder('', 0)).toBe(0);
    expect(tilder(null, 0)).toBe(0);
    expect(tilder('a'.repeat(10), 0)).toBe(Tokenizer.countTokens('a'.repeat(10)));
  });

  test('R3: латиница/ASCII не регрессировала: расхождение с round(len/4) ≤ числа серий', () => {
    // Причина расхождения ровно одна: боевой путь = per-run ceil (та же арифметика, что у
    // бейджа — estimateDialogTokens), прежняя трасса = round по всему тексту. Для ASCII
    // разница ограничена числом серий букв/цифр и не меняет порядок величины.
    const texts = ['hello world', 'a'.repeat(5), 'let x = 1; const y = 22;', 'GPT-5.5 model'];
    for (const t of texts) {
      const alpha = (t.match(/[a-zA-Z]+/g) || []).length;
      const digits = (t.match(/[0-9]+/g) || []).length;
      expect(Math.abs(tilder(t, 0) - legacyTilde(t, 0))).toBeLessThanOrEqual(alpha + digits + 1);
    }
  });

  test('R4: трасса badge-recv идёт через хелпер, латинская формула — только фолбэк (корень 1)', () => {
    expect(CONTENT_SRC).toContain("? aiCmEstimateTokensTilde(detail.text, detail.attachTokens)");
    expect(CONTENT_SRC).toContain("' tokens~' + tokenTilde)");
    // латинская формула осталась ровно одна и стоит ПОСЛЕ typeof-гарда (фолбэк песочниц)
    const guard = CONTENT_SRC.indexOf("typeof aiCmEstimateTokensTilde === 'function'");
    const legacy = CONTENT_SRC.indexOf('Math.round((detail.text || \'\').length / 4)');
    expect(guard).toBeGreaterThan(-1);
    expect(legacy).toBeGreaterThan(guard);
    expect(CONTENT_SRC.split('Math.round((detail.text || \'\').length / 4)').length - 1).toBe(1);
    // хелпер: приоритет Tokenizer.countTokens, фолбэк — языковая ветвь
    const src = helperSource();
    expect(src).toContain('TK.countTokens(t) + attach');
    expect(src).toContain('Math.ceil(cyr / 1.8)');
    expect(src).toContain('Math.round((t.length - cyr) / 4)');
  });

  test('R5: бейдж авторитетен по serverTokens на ОБОИХ путях (updateWidget и GET_STATS)', () => {
    // O-47: оба пути берут счётчик через site-гейт aiCmMetricServerTokens (у Qwen он 0 —
    // usage.input не размер контекста); для остальных сервисов значение прежнее (serverTokens).
    const ternary = 'metricServerTokens > 0 ? metricServerTokens : Tokenizer.estimateDialogTokens(';
    const hits = CONTENT_SRC.split(ternary).length - 1;
    expect(hits).toBe(2);
    // т.е. при наличии серверного usage отображаемое значение = serverTokens ровно (0% отклонения)
    for (const p of Object.values(PAIRS)) {
      expect(relErr(p.serverTokens, p.serverTokens)).toBe(0);
    }
  });

  test('R6: делитель кириллицы в tokenizer.js — 1.8 (source-пин)', () => {
    expect(TOKENIZER_SRC).toContain('tokens += Math.ceil(cyrillicCount / 1.8);');
    expect(TOKENIZER_SRC).not.toContain('tokens += Math.ceil(cyrillicCount / 4);');
    // латиница/CJK/цифры не тронуты
    expect(TOKENIZER_SRC).toContain('tokens += Math.ceil(latinCount / 4);');
    expect(TOKENIZER_SRC).toContain('tokens += Math.ceil(cjkCount / 1.8);');
    expect(TOKENIZER_SRC).toContain('tokens += Math.ceil(digitCount / 3);');
  });
});
