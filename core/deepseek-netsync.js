// =============================================================================
// core/deepseek-netsync.js — Step D.2 (декомпозиция core/deepseek-intercept.js).
// СЕТЕВОЙ ДОЗАПРОС ИСТОРИИ В МОМЕНТ ЭКСПОРТА: СЕКЦИЯ 9C ядра (O-18, фаза 2) —
// live-кэш ходов (liveTurnRecord), решение о дозапросе (netSyncNeeded), per-turn
// выбор live/сеть при композиции файла (exportComposeTurns), приёмка сетевого
// снимка в режиме экспорта (applyExportNetSnapshot), сам дозапрос с жёстким
// таймаутом (exportNetSync) и мост window 'ai-cm-deepseek-net-sync'.
//
// Кластер вынесен из core/deepseek-intercept.js по образцу шага D.1
// (core/deepseek-diag.js). Раньше обе части жили в ОДНОМ IIFE, поэтому кластер
// обращался к состоянию ядра по именам. Теперь у модуля свой IIFE, и состояние
// ядра приходит через __bind(deps).
//
// РАЗДЕЛЕНИЕ ПО SCOPE (важно для производительности). Тела перенесены БАЙТ-В-БАЙТ
// и без префиксов D., но лежат в ДВУХ зонах:
//   • PURE-зона (этот IIFE, до __bind) — собственное состояние модуля, ядру не
//     видимое: NET_SYNC_TIMEOUT_DEFAULT (дефолт жёсткого таймаута дозапроса) и
//     netSyncSeq (счётчик попыток дозапроса, телами не читается).
//   • BIND-зона ('with (D) { … }' внутри __bind) — тела, читающие живое состояние
//     и функции ядра: liveTurnRecord, netSyncNeeded, exportComposeTurns,
//     applyExportNetSnapshot, exportNetSync и мост 'ai-cm-deepseek-net-sync'.
// ПОЧЕМУ ТАК: внутри with каждый свободный идентификатор резолвится ДИНАМИЧЕСКИ
// (ES3 Annex B) — урок D.1: горячий цикл FNV-хеша в with деградирует ~в 40 раз
// (200×200 КБ: 81 мс вне with против 3309 мс в with; живой стенд o18-frag-resync
// 1.3 с → 5.1 с при возврате таких тел в with). В K7 перебайтовых циклов нет:
// хэширование живёт в PURE-зоне core/deepseek-diag.js (diagVerdict зовётся отсюда
// через форвардер ядра), а циклы K7 идут ПО ХОДАМ (единицы на экспорт), не по
// байтам. Поэтому все 5 тел — BIND, а PURE держит только константы модуля.
// Байтовая идентичность тел сохранена в обеих зонах.
//
// Состояние сетевого дозапроса (liveTurns, liveTurnOrder, netSnapshotAt, netTurnIds,
// lastTurnDoneAt, netSyncStats) ОСТАЛОСЬ В ЯДРЕ: его читают и пишут оставшиеся
// секции (resetForNewConversation — сброс на смену чата; ingestHistory — приёмка
// сетевого снимка; finishSseStream — lastTurnDoneAt; диагностика — ro-геттеры).
// Ядро отдаёт его rw-парами, поэтому «длиннее побеждает» (O-16) и ONE-SIDE-доливка
// видят ТОТ ЖЕ объект, что и ядро, а не копию. orderCounter (per-turn порядок в
// файле), ingestMode и exportSyncTruncated (режим экспортного ingest) — тоже rw:
// тела их перезаписывают ('orderCounter++', 'ingestMode = "export-sync"',
// 'exportSyncTruncated = false'); без сеттера запись молча терялась бы (sloppy),
// и порядок ходов в файле перестал бы расти.
//
// Порядок подключения (core/background.js, registerSafe 'ai-cm-deepseek-intercept-v4',
// document_start, world MAIN): utils/debug.js -> core/deepseek-diag.js -> ЭТОТ ФАЙЛ ->
// core/deepseek-intercept.js. До связки на window.AiCmDeepseekNetsync лежит только
// __bind; после связки Fn заполнен 5 функциями, а ядро раздаёт 2 из них
// форвардерами по прежним именам (liveTurnRecord, netSyncNeeded — function
// declaration, хойстятся). Экспорт: window.AiCmDeepseekNetsync + module.exports.
// =============================================================================

(function () {
  if (typeof window !== 'undefined' && window.AiCmDeepseekNetsync) return;

  // Зависимости ядра. Заполняется один раз через __bind(...) из core/deepseek-intercept.js.
  var D = null;
  var Fn = {};

  // ---- PURE-зона: собственное состояние модуля, ядру не видимое ----
  // ===== СЕКЦИЯ 9C (O-18, ФАЗА 2): СЕТЕВОЙ ДОЗАПРОС ИСТОРИИ В МОМЕНТ ЭКСПОРТА =====
  // Мост: ISOLATED (core/base-handler.js: aiCmExportNetSyncThen) →
  //   'ai-cm-deepseek-net-sync' {requestId, convId, timeoutMs}
  //   ← 'ai-cm-deepseek-net-sync-done' {requestId, ok, reason, refetched, netTurns, verdicts}
  // Правило: ПЕРЕД композицией файла (авто и ручной экспорт) история текущего чата
  // запрашивается по сети, если снимок сети пуст ИЛИ старше последнего завершённого хода.
  // Таймаут (по умолчанию 3 с) — жёсткий: не дождались/сети нет → прежний live-путь.
  var NET_SYNC_TIMEOUT_DEFAULT = 3000;

  var netSyncSeq = 0;

  function __bind(d) {
    D = d;
    with (D) {
      // ---- BIND-зона: тела, читающие живое состояние/функции ядра через with (D) ----

  // LIVE-текст хода: пишется на КАЖДОЙ финализации потока (не только под флагом диагностики).
  // «Длиннее побеждает» — та же монотонность, что у обогащения хода (O-16): усечённая
  // ревизия не может вытеснить полную.
  function liveTurnRecord(id, role, text, answer, reasoning, modelSlug) {
    try {
      var key = String(id || '');
      if (!key || !text) return;
      var prev = liveTurns[key];
      if (!prev) liveTurnOrder.push(key);
      if (prev && String(prev.text || '').length > String(text).length) return;
      liveTurns[key] = {
        role: role, text: String(text), answer: String(answer || ''), reasoning: String(reasoning || ''),
        modelSlug: modelSlug || '', ts: Date.now() / 1000
      };
    } catch (e) { }
  }
  // Нужен ли сетевой дозапрос: сети не было / снимок старше последнего завершённого хода /
  // снимок не покрывает live-ходы.
  function netSyncNeeded() {
    try {
      if (!liveTurnOrder.length) return false;        // live-ходов нет: база и так сетевая
      if (!netSnapshotAt) return true;                // сети не было вовсе
      if (netSnapshotAt < lastTurnDoneAt) return true; // снимок старше последнего хода
      for (var i = 0; i < liveTurnOrder.length; i++) {
        if (!netTurnIds[liveTurnOrder[i]]) return true;   // хода нет в снимке сети
      }
      return false;
    } catch (e) { return false; }
  }
  // Per-turn выбор текста: EQUAL → live (байт-в-байт то же); MIDDLE-HOLE*/TAIL-CUT → сетевой
  // (он полнее: live потерял середину/хвост — сигнатура O-18); LIVE-EXTRA/DIFF-OTHER → live
  // (сеть короче либо различие не классифицировано — молча не заменяем); ONE-SIDE → live.
  function exportComposeTurns() {
    var verdicts = {};
    var bump = function (v) { verdicts[v] = (verdicts[v] || 0) + 1; };
    try {
      var ids = Object.keys(turnsMap);
      var i, id, t, lv, v;
      for (i = 0; i < ids.length; i++) {
        id = ids[i]; t = turnsMap[id]; lv = liveTurns[id];
        if (!t) continue;
        if (!lv) { bump('ONE-SIDE'); continue; }                    // ход только из сети
        v = diagVerdict(lv.text, t.text);                            // lt=live, nt=net
        bump(v.verdict);
        if (v.verdict === 'MIDDLE-HOLE' || v.verdict === 'MIDDLE-HOLE-PARTIAL' || v.verdict === 'TAIL-CUT') {
          console.log('[deepseek-intercept] экспорт: ход ' + String(id).slice(0, 8) + ' — сетевой текст полнее live (' +
            v.verdict + ', live=' + lv.text.length + ' net=' + t.text.length + '), берём сеть');
          continue;                                                  // остаётся сетевой текст
        }
        t.text = lv.text; t.answer = lv.answer; t.reasoning = lv.reasoning;
        if (lv.modelSlug) t.modelSlug = lv.modelSlug;
      }
      // Ходы, которых в сети НЕТ вовсе (ONE-SIDE): доливаем live-текст в конец базы.
      for (i = 0; i < liveTurnOrder.length; i++) {
        id = liveTurnOrder[i];
        if (turnsMap[id]) continue;
        lv = liveTurns[id];
        if (!lv) continue;
        bump('ONE-SIDE'); netSyncStats.oneSide++;
        turnsMap[id] = {
          text: lv.text, answer: lv.answer, reasoning: lv.reasoning, modelSlug: lv.modelSlug,
          order: orderCounter++, ts: lv.ts, role: lv.role
        };
        console.log('[deepseek-intercept] экспорт: ход ' + String(id).slice(0, 8) +
          ' есть только в live-базе (ONE-SIDE, сети нет) — в файл идёт live-текст ' + lv.text.length + ' симв.');
      }
    } catch (e) { }
    return verdicts;
  }
  // Приёмка сетевого снимка в режиме экспорта: форсированный ingestHistory + per-turn выбор.
  function applyExportNetSnapshot(json, convId) {
    var res = { ok: false, reason: 'rejected', verdicts: {} };
    try {
      if (!json || json.code !== 0) return res;
      var bd = json.data && json.data.biz_data;
      var cms = bd && Array.isArray(bd.chat_messages) ? bd.chat_messages : null;
      if (!bd || !bd.chat_session || !cms) return res;
      diagHistRecord(json, 'export-net-sync');
      if (!cms.length) {
        // Сети нет: авторитетно пустая история (SPA-созданный чат) — базу НЕ трогаем,
        // файл собирается live-путём, как и раньше. Маркер — в лог.
        netSyncStats.empty++;
        console.log('[deepseek-intercept] экспорт: history_messages пуста (чат без истории в сети) → ' +
          'файл из live-базы, ходов live=' + liveTurnOrder.length + ' (ONE-SIDE)');
        res.ok = false; res.reason = 'empty';
        res.verdicts = { 'ONE-SIDE': liveTurnOrder.length };
        return res;
      }
      var prevComplete = histCompletion.historyComplete === true;
      var prevReached = histCompletion.reachedRoot === true;
      ingestMode = 'export-sync';
      exportSyncTruncated = false;
      try { ingestHistory(json); } finally { ingestMode = ''; }
      if (exportSyncTruncated) {
        // Усечённый снимок не принят (см. ingestHistory): база осталась live-базой.
        netSyncStats.failed++;
        res.ok = false; res.reason = 'truncated';
        res.verdicts = { 'ONE-SIDE': liveTurnOrder.length };
        return res;
      }
      // Дозапрос в момент экспорта не ПОНИЖАЕТ вердикт полноты (O-17): база уже была
      // признана полной — сеть здесь лишь уточняет тексты ходов.
      if (prevComplete && !histCompletion.historyComplete) {
        histCompletion.historyComplete = true;
        histCompletion.reachedRoot = prevReached || histCompletion.reachedRoot;
      }
      res.verdicts = exportComposeTurns();
      var turns = Object.keys(turnsMap).length;
      // O-22 (ИЗМЕРЕНИЕ-2): маркер ТОЧКИ диспатча ai-cm-full-history (site=S1467).
      try {
        if (typeof diagMark === 'function' && typeof diagOn === 'function' && diagOn()) {
          diagMark('o22-dispatch-site', {
            site: 'S1467', ts: Date.now(),
            count: turns, textLen: '(вне области)'
          });
        }
      } catch (eO22s1467) { }
      emitBaseSnapshot(Math.max(lastBaseServerTokens || 0, sseRealtimeFinalTokens || 0), sseModelType || lastBaseChatMode);
      res.ok = turns > 0; res.reason = 'merged';
      console.log('[deepseek-intercept] экспорт: сетевой дозапрос применён — ходов в базе=' + turns +
        ', вердикты=' + JSON.stringify(res.verdicts));
    } catch (e) {
      res.ok = false; res.reason = 'error';
    }
    return res;
  }
  function exportNetSync(requestId, convId, timeoutMs) {
    var cap = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : NET_SYNC_TIMEOUT_DEFAULT;
    var done = false;
    var timer = null;
    netSyncStats.calls++;
    diagMark('export-net-sync', {
      conv: String(convId || '').slice(0, 8), needed: netSyncNeeded(),
      live: liveTurnOrder.length, netAt: netSnapshotAt
    });
    function reply(status) {
      if (done) return;
      done = true;
      try { clearTimeout(timer); } catch (eT) { }
      try {
        window.dispatchEvent(new CustomEvent('ai-cm-deepseek-net-sync-done', {
          detail: {
            requestId: String(requestId || ''), convId: String(convId || ''),
            ok: status.ok === true, reason: String(status.reason || ''),
            refetched: status.refetched === true,
            netTurns: Object.keys(netTurnIds).length,
            liveTurns: liveTurnOrder.length,
            verdicts: status.verdicts || {}
          }
        }));
      } catch (eD) { }
    }
    timer = setTimeout(function () { netSyncStats.timeout++; reply({ ok: false, reason: 'timeout' }); }, cap);
    try {
      if (!convId || convId !== currentConvId) { reply({ ok: false, reason: 'conv-mismatch' }); return; }
      if (!netSyncNeeded()) {
        netSyncStats.fresh++;
        reply({ ok: true, reason: 'fresh' });      // снимок сети свежий и покрывает live-ходы
        return;
      }
      var url = historyRefetchUrl();
      netSyncStats.fetched++;
      console.log('[deepseek-intercept] экспорт: сетевой дозапрос истории (convId=' +
        String(convId).slice(0, 8) + ', live-ходов=' + liveTurnOrder.length + ', снимок сети=' +
        (netSnapshotAt ? 'старше хода' : 'отсутствует') + ')');
      var p;
      try {
        p = originalFetch.call(window, url, { method: 'GET', headers: lastAuthHeaders || {} });
      } catch (eF) { netSyncStats.failed++; reply({ ok: false, reason: 'fetch-throw' }); return; }
      p.then(function (r) { return (r && r.ok) ? r.json() : null; })
        .then(function (json) {
          if (done) return;
          if (!json) { netSyncStats.failed++; reply({ ok: false, reason: 'http' }); return; }
          var applied = applyExportNetSnapshot(json, convId);
          if (applied.ok) netSyncStats.ok++;
          reply({ ok: applied.ok, reason: applied.reason, refetched: true, verdicts: applied.verdicts });
        })
        .catch(function () {
          if (done) return;
          netSyncStats.failed++;
          console.warn('[deepseek-intercept] экспорт: сетевой дозапрос не удался → прежний live-путь');
          reply({ ok: false, reason: 'error' });
        });
    } catch (e0) {
      reply({ ok: false, reason: 'error' });
    }
  }
  try {
    window.addEventListener('ai-cm-deepseek-net-sync', function (ev) {
      try {
        var d = (ev && ev.detail) || {};
        exportNetSync(d.requestId, d.convId || currentConvId || getConvId() || '', d.timeoutMs);
      } catch (eNs) { }
    });
  } catch (eNetBridge) { }

      Fn.liveTurnRecord = liveTurnRecord;
      Fn.netSyncNeeded = netSyncNeeded;
      Fn.exportComposeTurns = exportComposeTurns;
      Fn.applyExportNetSnapshot = applyExportNetSnapshot;
      Fn.exportNetSync = exportNetSync;
    }
  }
  Fn.__bind = __bind;
  if (typeof window !== 'undefined') window.AiCmDeepseekNetsync = Fn;
  if (typeof module !== 'undefined' && module.exports) module.exports = Fn;
}());
