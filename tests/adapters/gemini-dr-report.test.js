/**
 * Тесты D13: stateless-инъекция DR-контента Gemini (utils/gemini-batchexecute-parser.js).
 * В canonical-тексте assistant стоят голые ссылки-заглушки:
 *   http://googleusercontent.com/immersive_entry_chip/0                    → отчёт
 *   http://googleusercontent.com/deep_research_confirmation_content/0      → план
 * Инъекция детерминирована (extractDrTexts из realTurns каждого парса), без
 * синтетического хода — пересборки стабильны.
 */
const { parseGeminiHistory, extractDrTexts, injectDrLinks, splitTurnMessages, __setDrTexts } = require('../../utils/gemini-batchexecute-parser');

const REPORT_MARK = 'Настоящее экспертное заключение подготовлено в рамках комплексного анализа';
const LINK_REPORT = 'http://googleusercontent.com/immersive_entry_chip/0';
const LINK_PLAN = 'http://googleusercontent.com/deep_research_confirmation_content/0';

function makeReport() {
  const para = ' ' + REPORT_MARK + ' — анализ профессиональной пригодности работника, замещающего должность водителя трамвая, с учётом правовых и медицинских аспектов. ';
  let s = '# Экспертное заключение по оценке профессиональной пригодности\n\n';
  while (s.length < 1200) s += para;
  return s;
}

function makePlan() {
  return '(1) Провести поиск в открытых источниках актуальных нормативных документов РФ, включая Приказ Минздрава РФ № 29н, Трудовой кодекс РФ (ст. 216, 220), Федеральный закон о безопасности дорожного движения. (2) Проанализировать судебную практику по оспариванию увольнений по медицинским показаниям. (3) Подготовить итоговый отчёт с правовым заключением и рекомендациями.';
}

// Ход, где assistant-ответ = canonical box[1][0] c голой ссылкой-заглушкой.
// extraStrings — дополнительные контентные узлы в turn[3][0][0] (план/отчёт лежат отдельно).
function makeDrTurn(link, answerText, extraStrings) {
  const answerStr = answerText || ('Исследование завершено. Вы можете задать вопросы.\n\n\n' + link);
  const box = [answerStr].concat(extraStrings || []);
  return [
    ['c_conv', 'r_dr'],
    ['c_conv', 'r_dr2', 'rc_dr3'],
    [['Проведи глубокое исследование', null, null, null, null]],
    [box, null, null, null, null, null, null, null, null, null,
      null, null, null, null, null, null, null, null, null, null,
      null, null, null, null, null, null, null, null, null, null, null],
    [1780000099, 100]
  ];
}

// Ход с отчётом в контейнере [3][0][0][30][0][4] (как в семпле) + иммерсивная ссылка в box
function makeDrTurnWithReport(reportText) {
  const reportContainer = [[null, null, null, null, [reportText, null, [1, 1]]]];
  const answerStr = 'Исследование завершено.\n\n\n' + LINK_REPORT;
  return [
    ['c_conv', 'r_dr'],
    ['c_conv', 'r_dr2', 'rc_dr3'],
    [['Проведи глубокое исследование', null, null, null, null]],
    [[answerStr], null, null, null, null, null, null, null, null, null,
      null, null, null, null, null, null, null, null, null, null,
      null, null, null, null, null, null, null, null, null, reportContainer],
    [1780000099, 100]
  ];
}

function makeNormalTurn(question, answer) {
  return [
    ['c_conv', 'r_n'],
    ['c_conv', 'r_n2', 'rc_n3'],
    [[question, null, null, null, null]],
    [[answer].map(function (p) { return [p]; })],
    [1780000000, 100]
  ];
}

function buildRawPlain(turns) {
  const inner = JSON.stringify([turns]);
  return JSON.stringify([['wrb.fr', 'hNvQHb', inner, null, 'generic']]);
}

describe('D13: stateless-инъекция DR (extractDrTexts + injectDrLinks)', () => {
  test('(1) ход со ссылкой + payload → текст вместо ссылки', () => {
    const report = makeReport();
    const raw = buildRawPlain([makeDrTurnWithReport(report)]);
    const r = parseGeminiHistory(raw);
    const all = r.messages.map(m => m.text).join('\n');
    // отчёт инжектирован вместо иммерсивной ссылки
    expect(all).not.toContain('immersive_entry_chip');
    expect(all).toContain(REPORT_MARK.slice(0, 40));
    // нет синтетического хода dr-report-*
    expect(r.messages.some(m => String(m.id).indexOf('dr-report-') === 0)).toBe(false);
    // textLen вырос за счёт отчёта
    expect(r.text.length).toBeGreaterThan(report.length / 2);
  });

  test('(1b) план инжектируется вместо deep_research_confirmation_content', () => {
    const plan = makePlan();
    const report = makeReport();
    // canonical-текст: «Вот план исследования.» + голая ссылка; план-текст — отдельный узел
    const turnPlan = makeDrTurn(LINK_PLAN, 'Вот план исследования.\n' + LINK_PLAN, [plan]);
    const raw = buildRawPlain([turnPlan, makeDrTurnWithReport(report)]);
    const r = parseGeminiHistory(raw);
    const all = r.messages.map(m => m.text).join('\n');
    expect(all).not.toContain('deep_research_confirmation_content');
    expect(all).toContain('(1) Провести поиск');
  });

  test('(2) payload без плана → ссылка плана остаётся, отчёт заменён', () => {
    const report = makeReport();
    const turn = makeDrTurnWithReport(report); // отчёт есть, плана нет
    const turnPlan = makeDrTurn(LINK_PLAN, 'Вот план исследования.\n' + LINK_PLAN);
    const drs = extractDrTexts([turn]);
    expect(drs.reportText.length).toBeGreaterThan(1000);
    expect(drs.planText).toBe('');
    // живой путь: splitTurnMessages + __setDrTexts
    __setDrTexts(drs);
    const segs = splitTurnMessages(turn);
    const reportSeg = segs.find(s => s.role === 'assistant');
    expect(reportSeg.text).toContain(REPORT_MARK.slice(0, 40));
    expect(reportSeg.text).not.toContain('immersive_entry_chip');
    // ссылка плана без плана НЕ заменяется
    const segsPlan = splitTurnMessages(turnPlan);
    const planSeg = segsPlan.find(s => s.role === 'assistant');
    expect(planSeg.text).toContain('deep_research_confirmation_content');
  });

  test('(3) два последовательных парса → msgs и тексты стабильны (stateless, нет 7→6)', () => {
    const report = makeReport();
    const raw = buildRawPlain([
      makeDrTurnWithReport(report),
      makeNormalTurn('Привет', 'Привет! Чем могу помочь?')
    ]);
    const r1 = parseGeminiHistory(raw);
    const r2 = parseGeminiHistory(raw); // второй парс — тот же результат
    expect(r1.count).toBe(r2.count);
    expect(r1.text).toBe(r2.text);
    expect(r1.count).toBeGreaterThan(0);
    expect(r1.text).toContain(REPORT_MARK.slice(0, 40));
  });

  test('(4) голова = первый реальный user-ход (никакого синтетики в голове)', () => {
    const report = makeReport();
    const raw = buildRawPlain([
      makeDrTurnWithReport(report),
      makeNormalTurn('Первый вопрос пользователя', 'Ответ ассистента')
    ]);
    const r = parseGeminiHistory(raw);
    expect(r.messages[0].role).toBe('user');
    expect(r.messages[0].text).toContain('Первый вопрос пользователя');
    expect(r.messages.some(m => String(m.id).indexOf('dr-report-') === 0)).toBe(false);
  });

  test('(5-деградация) нет DR-контента → ссылки остаются, парс побайтово прежний', () => {
    const raw = buildRawPlain([makeNormalTurn('Привет', 'Привет! Чем могу помочь?')]);
    const r = parseGeminiHistory(raw);
    expect(r.count).toBe(2); // user + assistant
    expect(r.text).toBe('Привет\nПривет! Чем могу помочь?');
    expect(r.messages.some(m => String(m.id).indexOf('dr-report-') === 0)).toBe(false);
  });

  test('injectDrLinks: замена только при наличии payload', () => {
    expect(injectDrLinks('a ' + LINK_REPORT + ' b', { reportText: 'ОТЧЁТ', planText: '' })).toBe('a ОТЧЁТ b');
    expect(injectDrLinks('a ' + LINK_PLAN + ' b', { reportText: '', planText: 'ПЛАН' })).toBe('a ПЛАН b');
    expect(injectDrLinks('a ' + LINK_PLAN + ' b', { reportText: '', planText: '' })).toBe('a ' + LINK_PLAN + ' b');
    expect(injectDrLinks(null, {})).toBe(null);
  });
});
