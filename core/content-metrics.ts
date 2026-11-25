/**
 * core/content-metrics.ts — 2.3 Stage 7: токен-математика и серверный счётчик.
 *
 * Classic-скрипт в manifest.content_scripts[0].js ПЕРЕД core/content.ts:
 * общий лексический скоуп. Здесь aiCmEstimateTokensTilde, канонический
 * эстиматор, пул вложений, единый aiCmTokenSnapshot и site-гейт
 * aiCmMetricServerTokens. Запись снимка/бейджа остаётся в content.ts и state.ts.
 */

// O-23 (F5, фикс корня 1): tokens~ в трассе badge-recv считался упрощённой эвристикой
// Math.round(text.length / 4) — для кириллицы это систематическая НЕДООЦЕНКА. Источник истины —
// Tokenizer.countTokens (линейная калибровка v3, utils/tokenizer.ts); упрощённая эвристика
// остаётся ТОЛЬКО фолбэком для песочниц без Tokenizer и сама получает языковую ветвь:
// кириллица ÷3.58 (калиброванный CYR v3; коэффициент обязан совпадать с
// Tokenizer.CYRILLIC_CHARS_PER_TOKEN — пин-тест калибровки), остальное ÷4.
// Для ASCII-текста фолбэк байтово равен прежнему Math.round(length/4) —
// регресс-пин R1 (tests/o23-tokens-calibration.test.js).
function aiCmEstimateTokensTilde(text: string, attachTokens?: number): number {
  var t = (typeof text === 'string') ? text : '';
  var attach = (typeof attachTokens === 'number' && attachTokens > 0) ? attachTokens : 0;
  var TK = (typeof Tokenizer !== 'undefined') ? Tokenizer : null;
  var result: number = 0;
  var tkOk = false;
  if (TK && typeof TK.countTokens === 'function') {
    try { result = TK.countTokens(t) + attach; tkOk = true; } catch (eTk) { swallowSoft(eTk, 'content:aiCmEstimateTokensTilde'); /* ниже — фолбэк */ }
  }
  if (!tkOk) {
    var cyr = (t.match(/[\u0400-\u04FF]/g) || []).length;
    result = Math.ceil(cyr / 3.58) + Math.round((t.length - cyr) / 4) + attach;
  }
  // O-23 (измерение): доля кириллицы и итог tokens~ — только под гейтом aiCmDebug.
  // Значения не влияют на возврат: строка печатается после расчёта и до return.
  if (typeof aiCmDiagOn === 'function' && aiCmDiagOn()) {
    try {
      var cyrDiag = (t.match(/[\u0400-\u04FF]/g) || []).length;
      var cyrillicPct = t.length ? (cyrDiag / t.length * 100).toFixed(1) : '0.0';
      aiCmDiagLine('o23-cyrillic-share', {
        textLen: t.length, cyrillicPct: cyrillicPct,
        attachTokens: attach, tokensTilde: result
      });
    } catch (eO23) { }
  }
  return result;
}

// v2.3 (B2): ЕДИНЫЙ канонический эстиматор токенов диалога — единственная точка,
// через которую считает и бейдж (processAndSend / GET_STATS через
// Tokenizer.estimateDialogTokens), и трасса badge-recv. Внутри — тот же
// Tokenizer.countTokens (линейная калибровка v3, см. utils/tokenizer.ts) плюс
// служебные 4 токена на ход. Латинская эвристика Math.round(length / 4) из боевых
// путей убрана: на русском тексте она систематически занижала оценку, из-за чего
// бейдж показывал заниженный процент (B2). Фолбэк для песочниц без Tokenizer —
// языковая ветвь aiCmEstimateTokensTilde (тот же CYR 3.58).
function aiCmCanonicalTokens(text: string, attachTokens?: number, messageCount?: number): number {
  var attach = (typeof attachTokens === 'number' && attachTokens > 0) ? attachTokens : 0;
  var msgs = (typeof messageCount === 'number' && messageCount > 0) ? messageCount : 0;
  if (typeof Tokenizer !== 'undefined' && Tokenizer &&
      typeof Tokenizer.estimateDialogTokens === 'function') {
    try {
      return Tokenizer.estimateDialogTokens(text, msgs) + attach;
    } catch (eCanon) {
      swallowSoft(eCanon, 'content:canonical-tokens');
    }
  }
  return aiCmEstimateTokensTilde(text, attach) + msgs * 4;
}

// v2.3 (B1): сколько токенов пула вложений ЕЩЁ НЕ отрендерено в fullText.
// Раньше при наличии любой секции [FILE: …] сбрасывался ВЕСЬ пул netAttachTokens,
// поэтому файл, который ещё качался, не попадал в метрику вовсе (D3: один файл
// уже отрендерен, второй висит — пул обнулялся). Теперь из пула вычитаются
// только токены отрендеренных файлов с ТЕЛОМ: «[FILE: имя]» + '\n' + текст.
// Метки «[FILE: имя (размер)]», «[FILE: имя — …]» и «[IMAGE: имя]» — label-only:
// содержимого в тексте нет, поэтому их вес 2500/516 из пула НЕ вычитается.
function aiCmAttachPendingTokens(fullText: string, attachTokens?: number, attachBreak?: any): number {
  var pool = (typeof attachTokens === 'number' && attachTokens > 0) ? attachTokens : 0;
  if (pool <= 0) return 0;
  var text = (typeof fullText === 'string') ? fullText : '';
  var hasSections = (text.indexOf('[FILE: ') !== -1) || (text.indexOf('[IMAGE: ') !== -1);
  if (!hasSections) return pool;
  var br = (attachBreak && typeof attachBreak === 'object') ? attachBreak : {};
  var imgTotal = (typeof br.imgCount === 'number' && br.imgCount > 0) ? br.imgCount : 0;
  var docTotal = (typeof br.docCount === 'number' && br.docCount > 0) ? br.docCount : 0;
  var total = imgTotal + docTotal;
  if (total <= 0) return 0; // дробление неизвестно: секции уже в тексте — не добавляем
  var docRendered = (text.match(/(?:^|\n\n)\[FILE: (?!.* — )(?!.* \([\d.,]+ ?(?:B|KB|MB|GB|Б)\)\])[^\]\n]*\]/g) || []).length;
  var done = Math.min(docRendered, docTotal);
  if (done >= total) return 0;
  return Math.round(pool * (total - done) / total);
}

// v2.6 (R1): ЕДИНЫЙ расчёт метрики токенов диалога. Единственное место, где складываются
// серверный счётчик (aiCmMetricServerTokens), канонический эстиматор (aiCmCanonicalTokens →
// Tokenizer.estimateDialogTokens), масштаб по effectiveLen (только на ПОЛНОЙ базе) и доля пула
// неотрендеренных вложений (aiCmAttachPendingTokens). Оба пути метрики — бейдж
// (processAndSend) и панель (GET_STATS) — берут число ОТСЮДА, поэтому расхождение R1
// (81 токен между счётчиком панели файла и бейджем сразу после F5) закрывается на корне, а не
// подгонкой одного из путей. Функция ЧИСТАЯ: только читает состояние, никуда не пишет; запись
// снимка (state.js:lastTokensSnapshot) — в точке фиксации maxTokenCount/percentage.
function aiCmTokenSnapshot(baseText: string, baseCount: number, attach?: number, attachBreak?: any): { tokens: number; percent: number; limit: number; serverTokens: number } {
  var text = (typeof baseText === 'string') ? baseText : '';
  var msgs = (typeof baseCount === 'number' && baseCount > 0) ? baseCount : 0;
  // svc — тот же ключ сервиса, что у processAndSend (getServiceKey), а не siteName адаптера:
  // гейты Qwen (0 серверных токенов) и AI Studio (счётчик шапки) смотрят ровно на него.
  var svc = (typeof getServiceKey === 'function')
    ? getServiceKey()
    : ((typeof currentAdapter !== 'undefined' && currentAdapter) ? currentAdapter.siteName : null);
  var serverTokens = aiCmMetricServerTokens(svc, text);
  var tokens = serverTokens > 0 ? serverTokens : aiCmCanonicalTokens(text, 0, msgs);
  // Поднятый полом effectiveLen (Gemini): доля применима ТОЛЬКО к полной базе — netEffectiveLen
  // относится к полному сетевому снимку, а text при baseComplete=false — канонический пол базы
  // (v98: иначе бейдж «взлетал» до перезаписи полной базой).
  if ((typeof baseComplete !== 'undefined' && baseComplete === true) && serverTokens === 0 &&
      (typeof netEffectiveLen === 'number') && netEffectiveLen > 0 &&
      text.length > 0 && netEffectiveLen > text.length) {
    tokens = Math.round(tokens * (netEffectiveLen / text.length));
  }
  // v2.3 (B1): секции [FILE: …]/[IMAGE: …] уже посчитаны эстиматором в составе text —
  // добавляется ТОЛЬКО доля пула неотрендеренных вложений (см. aiCmAttachPendingTokens).
  var attachAdd = aiCmAttachPendingTokens(text, attach, attachBreak);
  if (attachAdd > 0) tokens += attachAdd;
  // v2.0.32: счётчик шапки AI Studio считает промпт целиком (вложения в нём уже есть) —
  // вычитаем ровно ту же добавку, иначе метрика складывала бы их дважды.
  if (svc === 'aistudio' && typeof aiCmAistudioNativePromptTokens === 'function' && aiCmAistudioNativePromptTokens() > 0 && attachAdd > 0) {
    tokens -= attachAdd;
  }
  var modelId = (typeof resolveCurrentModel === 'function')
    ? resolveCurrentModel()
    : ((typeof lastResolvedModelId === 'string' && lastResolvedModelId) ? lastResolvedModelId : '');
  var limit = (typeof computeEffectiveLimit === 'function') ? computeEffectiveLimit(modelId) : 0;
  var percent = limit > 0 ? Math.round((tokens / limit) * 1000) / 10 : 0;
  return { tokens: tokens, percent: percent, limit: limit, serverTokens: serverTokens };
}

// ===== O-47: КАКОЙ серверный счётчик идёт в МЕТРИКУ (badge/pct) =====
// Корень дефекта: у Qwen netServerTokens — это usage.input из SSE-стрима
// (core/qwen-intercept.js:emitSnapshot), то есть КУМУЛИРОВАННОЕ сервисом потребление API
// (input текущего запроса + контекст на его стороне), а НЕ размер текущего контекста диалога.
// Такое число растёт от хода к ходу и не описывает ни окно, ни базу: живой замер O-47 —
// 1709 «токенов» на диалоге из двух сообщений. Поэтому для Qwen серверный счётчик в метрике
// ИГНОРИРУЕТСЯ (эффективно 0): badge/pct считаются ТОЛЬКО эвристикой
// Tokenizer.estimateDialogTokens (tokens~) — на ОБОИХ путях метрики (processAndSend и GET_STATS),
// иначе попап и бейдж разошлись бы.
// Прочие сервисы НЕ тронуты: у DeepSeek serverTokens остаётся авторитетным (O-23), у Gemini —
// счёт BYOK countTokens (O-35). Функция только ЧИТАЕТ netServerTokens: значение остаётся как
// было, чтобы диагностическая строка ingest'а («serverTokens=N») не врала.
function aiCmMetricServerTokens(svc: string | null, text: string): number {
  if (svc === 'qwen') return 0;
  // v2.0.32 (AI Studio): студия показывает собственный счётчик промпта в шапке чата, и он
  // авторитетнее всего остального — включает системные инструкции, схемы инструментов и всю
  // историю, которых в DOM-репликах нет вовсе (см. aiCmAistudioNativePromptTokens). Возврат
  // здесь автоматически даёт правильное поведение ОБОИМ путям метрики: бейдж берёт число как
  // серверное (не удерживает завышенную эвристику и не масштабирует её), попап читает то же
  // самое. Гейт узкий: другие сервисы строку не исполняют.
  if (svc === 'aistudio' && typeof aiCmAistudioNativePromptTokens === 'function') {
    var nativeAis = aiCmAistudioNativePromptTokens();
    if (nativeAis > 0) return nativeAis;
  }
  // Шаг 3: пока для ТЕКУЩЕГО текста есть ответ API countTokens — он авторитетен и эвристику
  // в метрику не пускает (см. aiCmExactTokensFor ниже). typeof-гард: функцию исполняют
  // срез-песочницы тестов через new Function без соседних объявлений контура (пин O-47),
  // там aiCmExactTokensFor просто отсутствует.
  var exact = (typeof aiCmExactTokensFor === 'function') ? aiCmExactTokensFor(text) : 0;
  if (exact > 0) return exact;
  return (typeof netServerTokens === 'number' && netServerTokens > 0) ? netServerTokens : 0;
}
