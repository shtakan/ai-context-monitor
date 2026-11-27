/**
 * core/content-resync.ts — 2.4 Stage 2: чистое решение ресинка метрик после
 * deferred-флаша истории.
 *
 * Classic-скрипт manifest.content_scripts[0].js ПЕРЕД core/content.ts: общий
 * лексический скоуп. Чистое решение `resolveResyncDecision` не читает DOM/chrome/
 * состояние: counts, длины и ключи приходят явными входами.
 * 2.4 Stage 9: обёртка `aiCmResyncMetricsAfterFlush` перенесена сюда move-only
 * из content.ts — она собирает финальный срез, зовёт решение и применяет
 * state-записи в общем скоупе.
 *
 * Правила v95/v96/v1.9 сохранены:
 *   - финальный срез не может быть короче принятой базы (shrink);
 *   - при том же числе сообщений длина не должна падать (shrink-length, MCP);
 *   - пропуск только при неизменных histKey И сыром сетевом счётчике;
 *   - выросший сырой счётчик при том же histKey снимает ключ (resync-raw).
 */

interface AiCmResyncDecisionInput {
  /** Число сообщений в финальном срезе. */
  finalCount: number;
  /** Число сообщений уже принятой базы. */
  previousCount: number;
  /** Длина канонического текста финального среза. */
  finalLength: number;
  /** Длина уже принятой базы. */
  previousLength: number;
  /** histKey финального среза (count|length). */
  newKey: string;
  /** histKey последней записи истории (null — ключ снят). */
  lastHistoryWroteKey: string | null;
  /** Сырой счётчик сети известен (в срез-песочницах — false). */
  rawKnown: boolean;
  /** Сырой счётчик сети текущего снимка. */
  rawCount: number;
  /** Сырой счётчик сети, уже принятый прошлым срезом. */
  previousRawCount: number;
}

interface AiCmResyncDecision {
  /** Сырой сетевой счётчик не изменился (или неизвестен). */
  rawUnchanged: boolean;
  /** Финальный срез короче базы — не принимать. */
  shrinkCount: boolean;
  /** То же число сообщений, но текст короче — не принимать. */
  shrinkLength: boolean;
  /** Срез уже финальный: histKey и сырой счётчик совпали. */
  canSkip: boolean;
  /** histKey совпал с последней записью (для снятия ключа при resync-raw). */
  keyRepeated: boolean;
  /** Вердикт для o22-metrics-resync (как в живом коде). */
  verdict: 'shrink' | 'shrink-length' | 'skip' | 'resync' | 'resync-raw';
}

/** Чистое решение: принимать ли финальный срез и что писать в историю. */
function resolveResyncDecision(input: AiCmResyncDecisionInput): AiCmResyncDecision {
  var rawUnchanged = !input.rawKnown || (input.rawCount === input.previousRawCount);
  var shrinkCount = input.finalCount < input.previousCount;
  var sameCount = (input.finalCount === input.previousCount);
  var shrinkLength = input.previousLength > 0 && input.finalLength < input.previousLength;
  var canSkip = sameCount && (input.newKey === input.lastHistoryWroteKey) && rawUnchanged;
  var keyRepeated = (input.newKey === input.lastHistoryWroteKey);
  var verdict: AiCmResyncDecision['verdict'];
  if (shrinkCount) verdict = 'shrink';
  else if (shrinkLength) verdict = 'shrink-length';
  else if (canSkip) verdict = 'skip';
  else if (rawUnchanged) verdict = 'resync';
  else verdict = 'resync-raw';
  return {
    rawUnchanged: rawUnchanged,
    shrinkCount: shrinkCount,
    shrinkLength: shrinkLength,
    canSkip: canSkip,
    keyRepeated: keyRepeated,
    verdict: verdict
  };
}

// v95 (METRICS-SYNC): после deferred flush история уже содержит ФИНАЛЬНЫЙ срез базы
// (объединённая база: архив + live, 120 msgs), а histKey/pct этого скоупа остались на
// предыдущем снимке (101 msgs) — UI показывал устаревший срез, а следующий
// processAndSend мог перезаписать свежую историю укороченной.
// Хелпер считает histKey по ТОМУ ЖЕ массиву, что ушёл в запись (aiCmCurrentBaseSnapshot
// — единая точка сбора + добор объединённой базой), принудительно принимает финальную
// базу (только рост: просадка счётчика запрещена) и один раз пересчитывает pct/бейдж.
function aiCmResyncMetricsAfterFlush(cid: string, reason?: string): boolean {
  try {
    if (baseSeen !== true) return false;
    if (typeof aiCmCurrentBaseSnapshot !== 'function') return false;
    var curCid = getCurrentConvId() || '';
    if (!cid || (curCid && cid !== curCid)) return false;
    var msgs = aiCmCurrentBaseSnapshot(cid);
    if (!Array.isArray(msgs) || msgs.length === 0) return false;
    var prevCount = (typeof baseCount === 'number') ? baseCount : 0;
    // v96 (баг 34.6%): счётчик СЕТЕВОГО снимка ДО дедупликации. Дедуп E-2 схлопывает базу
    // (120 → 101): baseCount/histKey после приёма снова те же, что у прошлого среза, и гард
    // ниже принимал новый снимок за повтор → pct/бейдж замирали. Сырой счётчик — второй
    // признак «сеть реально принесла новые ходы». В срез-песочницах тестов этих переменных
    // нет → сырой счётчик считается неизменным (поведение прежнее).
    var rawKnown = (typeof aiCmNetRawCount === 'number') && (typeof aiCmNetRawCountUsed === 'number');
    var rawCount = rawKnown ? aiCmNetRawCount : 0;
    var prevRaw = rawKnown ? aiCmNetRawCountUsed : 0;
    var texts = [];
    for (var i = 0; i < msgs.length; i++) {
      var mi = /** @type {any} */ (msgs[i]);
      texts.push(String((mi && mi.text) || ''));
    }
    var joined = texts.join('\n'); if (typeof canonicalBodyText === 'function') joined = canonicalBodyText(msgs);
    // histKey — ТА ЖЕ форма, что у штатной записи истории (content.js: baseCount + '|' + baseText.length),
    // иначе дедуп ниже сравнивал бы несравнимое и ресинк либо не срабатывал, либо дублировал запись.
    var newKey = msgs.length + '|' + joined.length;
    // v97/v1.9: длина УЖЕ ПРИНЯТОЙ базы против длины финального среза. Гард по msgs.length
    // не видит случай «столько же сообщений, но текст короче» — именно так терялся
    // вклад MCP-панелей (живой замер: 268 503 → 249 856 при 88→88).
    var prevLen = (typeof baseText === 'string') ? baseText.length : 0;
    var newLen = joined.length;
    // 2.4 Stage 2: чистое решение — в core/content-resync.ts; здесь сбор среза,
    // state-записи и processAndSend.
    var decision = resolveResyncDecision({
      finalCount: msgs.length,
      previousCount: prevCount,
      finalLength: newLen,
      previousLength: prevLen,
      newKey: newKey,
      lastHistoryWroteKey: (typeof lastHistoryWroteKey === 'string') ? lastHistoryWroteKey : null,
      rawKnown: rawKnown,
      rawCount: rawCount,
      previousRawCount: prevRaw
    });
    if (decision.shrinkCount) {
      // Финальный срез не может быть короче уже принятого — защита от просадки бейджа.
      debugLog('log', '[AI CM][export] metrics-resync skip reason=shrink convId=' + cid +
        ' final=' + msgs.length + ' current=' + prevCount);
      return false;
    }
    try {
      if (typeof aiCmDiagLine === 'function') {
        aiCmDiagLine('o22-metrics-resync', {
          ts: Date.now(), convId: cid, reason: reason || '(none)',
          finalMsgs: msgs.length, prevMsgs: prevCount,
          prevLen: prevLen, newLen: newLen,
          histKey: newKey, lastKey: (typeof lastHistoryWroteKey !== 'undefined') ? lastHistoryWroteKey : undefined,
          rawMsgs: rawCount, prevRawMsgs: prevRaw,
          verdict: decision.verdict
        });
      }
    } catch (eRsD) { swallowSoft(eRsD, 'content:metrics-resync-diag'); }
    if (decision.shrinkLength) {
      // v1.9 (ветка B): гард по ДЛИНЕ, симметричный гарду по msgs.length. Живой
      // замер 6eed4c3f: сеть принесла те же 88 сообщений, но joined.length упал
      // 268 503 → 249 856 — выпали MCP-результаты, и принятый короткий срез замораживал
      // бейдж/шапку файла на 92 197 токенов. Короткий срез не принимаем: остаётся уже
      // измеренная база, а бейдж не проседает.
      debugLog('log', '[AI CM][export] metrics-resync skip reason=shrink-length convId=' + cid +
        ' prevLen=' + prevLen + ' newLen=' + newLen);
      return false;
    }
    if (decision.canSkip) {
      debugLog('log', '[AI CM][export] metrics-resync skip reason=same convId=' + cid + ' histKey=' + newKey);
      return false; // срез уже финальный
    }
    baseCount = msgs.length;
    lastBaseTexts = texts;
    baseText = joined;
    // v1.9 (canonical): ресинк пишет ТОТ ЖЕ массив, что читают метрика (aiCmBasePrepared)
    // и файл (lastDetailMessages) — иначе после ресинка шапка/тело снова разъедутся.
    var resyncMsgs = [];
    var resyncIds = [];
    for (var rmi = 0; rmi < msgs.length; rmi++) {
      var rm = msgs[rmi] || {};
      var rt = texts[rmi];
      var rid = (rm.id != null) ? String(rm.id) : '';
      resyncIds.push(rid);
      resyncMsgs.push({ role: (rm.role === 'user') ? 'user' : 'assistant', text: rt, id: rid, ...(Array.isArray(rm.sources) ? { sources: rm.sources } : {}), ...(rm.artifact && typeof rm.artifact === 'object' ? { artifact: rm.artifact } : {}), ...(Array.isArray(rm.artifacts) ? { artifacts: rm.artifacts } : {}) });
    }
    aiCmBasePrepared = resyncMsgs;
    lastDetailMessages = resyncMsgs;
    lastBaseIds = resyncIds;
    if (typeof aiCmBaseSource !== 'undefined' && !aiCmBaseSource) aiCmBaseSource = 'net';
    // Ключ фиксирует ИМЕННО записанный срез: устаревшая (короткая) база его не сдвинет,
    // а следующая реальная запись снова сравнит живой histKey с этим ключом.
    // v96 (баг 34.6%): сырой счётчик вырос, а дедуп вернул ПРЕЖНИЙ срез (histKey совпал) —
    // ключ СНИМАЕМ, чтобы следующий processAndSend не отсеялся дедупом histKey и пересчитал
    // метрики. Для нормального роста ключ обновляется как раньше (лишней записи истории нет).
    lastHistoryWroteKey = (decision.rawUnchanged || !decision.keyRepeated) ? newKey : null;
    if (rawKnown) aiCmNetRawCountUsed = rawCount;
    debugLog('log', '[AI CM][export] metrics-resync reason=' + (reason || '(none)') + ' convId=' + cid +
      ' msgs=' + prevCount + '->' + msgs.length + ' histKey=' + newKey +
      (rawKnown ? (' raw=' + prevRaw + '->' + rawCount) : ''));
    processAndSend(); // пересчёт pct по финальной базе + перерисовка бейджа
    return true;
  } catch (eRs) { swallowSoft(eRs, 'content:metrics-resync'); return false; }
}

// Глобальный мост для content.ts и срез-песочниц.
(function () {
  var Api: any = {};
  Api.resolveResyncDecision = resolveResyncDecision;
  if (typeof window !== 'undefined') {
    (window as any).AiCmContentResync = Api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Api;
  }
})();
