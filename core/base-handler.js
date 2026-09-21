// =============================================================================
// core/base-handler.js — v2.0 (этап 1/3): декомпозиция core/content.js.
// ОБРАБОТКА БАЗЫ ИЗ СЕТИ (схлопывание, prepared-text, метрики, диагностика).
//
// Кластер сетевой базы: пер-host запись истории (M-8 ts), схлопывание базы для
// экспорта (intra/inter-dedupe), сборка сообщений истории из базы, prepared-text
// метрики, диагностические хеши и дампы turnsMap, планировщик stale-проверки.
// Сам слушатель события полной истории (ai-cm-full-history) остаётся в core/content.js:
// он source-level пинится тестом вместе с комментарием H23 (handshake самого content.js) —
// кандидат на этап 2/3 вместе с переносом пина.
//
// Порядок подключения (manifest.json, content_scripts[0].js):
//   utils/* → adapters/* → core/state.js → core/widget.js → core/base-handler.js
//   → core/hybrid-tail.js → core/export-manager.js → core/content.js
// Перенос БЕЗ изменения логики: тела функций, сигнатуры, имена и строковые
// литералы байтово прежние (декомпозиция, а не переписывание).
// =============================================================================

// M-8: TTL-метка per-host записи истории. Глобальный ключ 'aiCmHistory' пишется прежней
// формой (сам snapshot, без ts) — его семантика не меняется; поле ts аддитивно только
// для 'aiCmHistory:<host>'. По ts core/background.js удаляет записи старше 30 дней.
function aiCmHostHistoryRecord(snapshot) {
  var rec = Object.assign({}, snapshot);
  rec.ts = Date.now();
  return rec;
}

// v1.18 (E-2.1): ВНУТРИ-сообщенческая дедупликация. Deep Research с вложениями кладёт в
// ОДИН ход и отрендеренный текст, и сырой markdown-блок ('### ROLE& OBJECTIVE') — чистую
// функцию dedupeIntraMessage зовёт пайплайн (prepareExportMessages) на КАЖДОЕ сообщение ДО
// меж-сообщенческого dedupeMessages. Лог ниже — гейт сервиса + антиспам по подписи снимка.
function aiCmLogIntraDedupe(role, blocks) {
  if (!(blocks > 0)) return;
  var sig = 'intra|' + (baseCount || 0) + '|' + (baseText ? baseText.length : 0);
  if (sig === lastDedupeLogSig) return;
  lastDedupeLogSig = sig;
  debugLog('log', '[AI CM][gemini] intra-dedupe removed=' + blocks + ' blocks in message role=' + role);
}
// v1.18 (E-2): схлопывание дублей собранного массива сообщений для Gemini/AI Studio.
// Deep Research отдаёт один и тот же текст пользователя несколько раз (пузырь реплики,
// карточка плана, узлы шагов) — история, идущая в бейдж/токены/экспорт/print, обязана
// содержать первое вхождение. Чистые функции — utils/export-emit-pipeline.js
// (dedupeIntraMessage → dedupeMessages, порядок задан prepareExportMessages); здесь
// только гейт сервиса (прочие адаптеры не трогаем) и лог внутри-сообщенческих удалений.
function aiCmDedupeExportSource(messages) {
  try {
    var site = (currentAdapter && currentAdapter.siteName) || '';
    if (site !== 'gemini' && site !== 'aistudio') {
      var keep = [];
      for (var p = 0; p < messages.length; p++) {
        var mp = messages[p] || {};
        // FIX (Claude md): ход пользователя парсера Claude приходит ролью 'human' —
        // нормализуем её в 'user' здесь же, у входа в md (см. buildMdFromHistory).
        var msg = { role: (mp.role === 'user' || mp.role === 'human') ? 'user' : 'assistant', text: (typeof mp.text === 'string') ? mp.text : '' };
        // Claude md (ДИАГНОСТИКА — только измерение под гейтом aiCmDebug): роль хода на входе
        // точки и после нормализации. Маркер claude-role-* SCOPED по сайту: живой замер идёт по
        // Claude-цепочке, а на прочих сайтах роль хода — не предмет этого маркера (чужие строки
        // под именем claude-role-* вводили бы в заблуждение). Печать — каноническим хелпером
        // utils/debug.js:aiCmDiagLine; хелпера нет (Node/срез-песочницы тестов) или гейт выключен
        // → НИ ОДНОЙ строки. Читаются только уже посчитанные значения: байты не меняются.
        if (typeof aiCmDiagLine === 'function' && site === 'claude') {
          aiCmDiagLine('claude-role-dedupe', { site: site, mpRole: mp.role, normalizedRole: msg.role });
        }
        // O-39: сохраняем поле reasoning для не-Gemini сайтов, чтобы рендер мог добавить
        // секции [REASONING]/[ANSWER] контрактом O-35. Без этого поле терялось бы на
        // выходе buildHistoryMessages и размышление не доезжало до файла экспорта.
        if (typeof mp.reasoning === 'string' && mp.reasoning) msg.reasoning = mp.reasoning;
        keep.push(msg);
      }
      return { messages: keep, removed: 0 };
    }
    var P = (typeof window !== 'undefined' && window.AiCmExportEmitPipeline) ? window.AiCmExportEmitPipeline : null;
    if (!P) return { messages: messages, removed: 0 };
    // E-2.1: внутри-сообщенческая дедупликация идёт ПЕРВОЙ, меж-сообщенческая — второй;
    // порядок задан prepareExportMessages (единая точка входа пайплайна).
    if (typeof P.prepareExportMessages === 'function') {
      var res18 = P.prepareExportMessages(messages, aiCmLogIntraDedupe);
      return { messages: res18.messages, removed: res18.removed };
    }
    if (typeof P.dedupeMessages === 'function') return P.dedupeMessages(messages);
  } catch (eDed) { }
  return { messages: messages, removed: 0 };
}
// v1.18 (E-2): лог схлопывания печатаем ОДИН раз на снимок базы (сигнатура count|textLen),
// а не на каждый processAndSend.
var lastDedupeLogSig = null;
function aiCmLogDedupeRemoved(removed) {
  if (!(removed > 0)) return;
  var sig = baseCount + '|' + (baseText ? baseText.length : 0);
  if (sig === lastDedupeLogSig) return;
  lastDedupeLogSig = sig;
  debugLog('log', '[AI CM][gemini] dedupe removed=' + removed);
}
function buildHistoryMessages() {
  // v81: поведение для Gemini побитово прежнее (detail.messages/lastBaseTexts — приоритет);
  // для не-Gemini добавлен источник DOM-адаптера с нормализацией и чередованием.
  // E-2: собранный массив схлопывается от дублей (Gemini/AI Studio) ПЕРЕД потребителями —
  // ручной экспорт попапа/print/автофайл получают историю без повторов.
  // v1.18 (E-2.3): это ТА ЖЕ схлопнутая база, что питает метрики (см. aiCmBasePrepared):
  // источник — те же lastBaseTexts/lastDetailMessages (выход prepareExportMessages), а
  // повторный прогон чистой подготовки идемпотентен — второго вердикта дедупа нет.
  return aiCmDedupeExportSource(aiCmCollectExportSource()).messages;
}
// v1.18 (E-2.3): ЕДИНЫЙ источник правды для метрик и файла экспорта. Схлопнутая база
// текущего снимка живёт ОДНИМ массивом — выходом prepareExportMessages (нормализация →
// intra → inter → cross-raw → гигиена остатков разметки). baseText/baseCount — производные
// ЭТОГО массива, в файл уходит та же база (lastBaseTexts → aiCmCollectExportSource →
// buildHistoryMessages). Второй копии базы и второго вердикта дедупа НЕ существует.
var aiCmBasePrepared = null; // [{role,text,id}] | null — схлопнутая база последнего снимка
function aiCmPreparedText(messages) {
  var src = Array.isArray(messages) ? messages : [];
  var out = [];
  for (var i = 0; i < src.length; i++) out.push(String((src[i] && src[i].text) || ''));
  return out.join('\n');
}
// Текст метрик (getEffectiveText → pct/токены/бейдж) — РОВНО схлопнутая база, не её копия.
function aiCmMetricBaseText(fallback) {
  if (Array.isArray(aiCmBasePrepared) && aiCmBasePrepared.length > 0) return aiCmPreparedText(aiCmBasePrepared);
  return fallback;
}
// ================= v61diag: диагностика холодного старта (ТОЛЬКО логи, логика не тронута) =================
// FNV-1a 32-bit от id||text → 6 hex-символов (отпечаток хода для сравнения краёв ленты).
function aiCmDiagHash6(id, text) {
  try {
    var s = String(id || '') + '\u0000' + String(text || '');
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('000000' + h.toString(16)).slice(-6);
  } catch (e) { return '000000'; }
}
// Синхронный запрос сводки turnsMap у MAIN-перехватчика (Gemini) через CustomEvent-мост.
function aiCmGeminiTurnsSnapshotSync() {
  try {
    var resp = null;
    var h = function (ev) { resp = ev.detail; };
    window.addEventListener('ai-cm-turns-snap-response', h, { once: true });
    window.dispatchEvent(new CustomEvent('ai-cm-turns-snap-request'));
    window.removeEventListener('ai-cm-turns-snap-response', h);
    return resp;
  } catch (e) { return null; }
}
// ================= O-18 (фаза 2): сетевой дозапрос истории в момент экспорта =================
// Перед КОМПОЗИЦИЕЙ файла (автоэкспорт и ручной экспорт) DeepSeek-перехватчик в MAIN-мире
// получает шанс дозапросить history_messages текущего чата. Решение «нужен ли дозапрос» и
// per-turn выбор текста (EQUAL → live, MIDDLE-HOLE/TAIL-CUT → сеть, ONE-SIDE → live + маркер)
// принимаются ТАМ: только MAIN-мир знает и live-базу (SSE), и время приёмки сетевого снимка.
// Здесь — ожидание ответа с жёстким таймаутом: не дождались (сеть/страница/старая версия
// перехватчика) — экспорт идёт ПРЕЖНИМ live-путём, байты файла не меняются.
// Мост — те же window-CustomEvent, что у probe/flush O-16 (изоляция миров не нарушена).
var aiCmNetSyncSeq = 0;
function aiCmExportNetSyncSite() {
  try {
    return (typeof currentAdapter !== 'undefined' && currentAdapter && currentAdapter.siteName === 'deepseek');
  } catch (eSite) { return false; }
}
function aiCmExportNetSyncThen(convId, cb, timeoutMs) {
  var cap = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : 3000;
  var done = false;
  var timer = null;
  var handler = null;
  function finish(info) {
    if (done) return;
    done = true;
    if (timer) { try { clearTimeout(timer); } catch (eT) { } timer = null; }
    if (handler) { try { window.removeEventListener('ai-cm-deepseek-net-sync-done', handler); } catch (eR) { } handler = null; }
    try { aiCmLogNetSyncResult(convId, info || {}); } catch (eL) { }
    try { if (cb) cb(info || {}); } catch (eCb) { }
  }
  try {
    if (!convId) { finish({ ok: false, reason: 'no-conv' }); return; }
    var reqId = 'netsync-' + Date.now() + '-' + (++aiCmNetSyncSeq);
    handler = function (ev) {
      var d = ev && ev.detail;
      if (!d || String(d.requestId || '') !== reqId) return;
      finish(d);
    };
    window.addEventListener('ai-cm-deepseek-net-sync-done', handler);
    timer = setTimeout(function () { finish({ ok: false, reason: 'timeout' }); }, cap);
    window.dispatchEvent(new CustomEvent('ai-cm-deepseek-net-sync', {
      detail: { requestId: reqId, convId: convId, timeoutMs: cap }
    }));
  } catch (eBridge) { finish({ ok: false, reason: 'bridge-error' }); }
}
// Маркер в логе: видно КАЖДЫЙ экспорт DeepSeek — был ли дозапрос, чем закончился, какой
// текст пошёл в файл (verdicts) и сколько ходов пришло из live.
function aiCmLogNetSyncResult(convId, info) {
  try {
    var v = info && info.verdicts ? JSON.stringify(info.verdicts) : '{}';
    var line = '[AI CM][net-sync] convId=' + String(convId || '').slice(0, 8) +
      ' ok=' + (info && info.ok === true ? 1 : 0) +
      ' reason=' + ((info && info.reason) || '-') +
      ' refetched=' + (info && info.refetched === true ? 1 : 0) +
      ' netTurns=' + ((info && info.netTurns) || 0) +
      ' liveTurns=' + ((info && info.liveTurns) || 0) +
      ' verdicts=' + v;
    debugLog('log', line);
  } catch (eLog) { }
}
// ================= конец O-18 (фаза 2) =================

// Дамп turnsMap в момент экспорта: авто-fired и ручной (md/txt).
function aiCmDumpTurnsSnapshot(tag, cid, msgs) {
  try {
    var snap = aiCmGeminiTurnsSnapshotSync();
    var msgsN = (snap && snap.msgs) || 0;
    var firstHash = '-', lastHash = '-', firstText = '', lastText = '';
    var bc = null, rs = null, cbs = null;
    if (snap && typeof snap === 'object') {
      firstHash = snap.firstMsgHash || '-';
      lastHash = snap.lastMsgHash || '-';
      firstText = snap.firstText || '';
      lastText = snap.lastText || '';
      bc = snap.baseComplete;
      rs = snap.reachedStart;
      cbs = snap.confirmedByScroll;
    }
    if (!msgsN && Array.isArray(msgs) && msgs.length > 0) {
      // фолбэк: перехватчик недоступен (не Gemini) — считаем по экспортируемым сообщениям
      msgsN = msgs.length;
      firstHash = aiCmDiagHash6('', msgs[0] && msgs[0].text);
      lastHash = aiCmDiagHash6('', msgs[msgs.length - 1] && msgs[msgs.length - 1].text);
      firstText = String((msgs[0] && msgs[0].text) || '').slice(0, 80).replace(/\s+/g, ' ');
      lastText = String((msgs[msgs.length - 1] && msgs[msgs.length - 1].text) || '').slice(0, 80).replace(/\s+/g, ' ');
    }
    if (bc === null) bc = (baseComplete === true);
    if (rs === null || cbs === null) {
      var conf = (aiCmBaseConfirmedByConv[cid] === 1);
      if (rs === null) rs = conf;
      if (cbs === null) cbs = conf;
    }
    debugLog('log', '[AI CM][turnsMap] ' + tag + ' convId=' + (cid || (snap && snap.convId) || '(none)') +
      ' msgs=' + msgsN +
      ' firstMsgHash=' + firstHash + ' lastMsgHash=' + lastHash +
      ' firstText="' + firstText + '" lastText="' + lastText + '"' +
      ' baseComplete=' + (bc ? 1 : 0) +
      ' reachedStart=' + (rs ? 'true' : 'false') +
      ' confirmedByScroll=' + (cbs ? 'true' : 'false') +
      ' scrollEngaged=' + (snap && snap.scrollEngaged ? 'true' : 'false')); // v66
  } catch (e) { }
}
// ==== конец v61diag ====

// Самодиагностика: через 12с после загрузки/смены диалога, если диалог с сообщениями
// в DOM есть (isInitialized=true и extractMessages()>0), но сетевой снимок не пришёл
// (baseSeen=false) — взводим stale. На пустых чатах extractMessages()=0 → не взводим.
// O-35 (D1, норма): для qwen отсутствие live-источника (сети) после F5/SPA — СИСТЕМАТИЧЕСКОЕ
// состояние, а не авария: базу снимает DOM-адаптер, и stale здесь ожидаем. Поэтому взведённый
// stale у qwen не имеет права стирать посчитанное число: подпись бейджа при непустой базе
// адаптера остаётся числом, а неполнота источника отмечается меткой в тултипе
// (core/widget.js:498). Здесь поведение самого сторожа не меняется.
function scheduleStaleCheck() {
  if (!isExtensionValid()) return;
  try { clearTimeout(staleTimer); } catch (e) { }
  stale = false;
  staleTimer = setTimeout(function () {
    staleTimer = null;
    if (isInitialized && !baseSeen) {
      var hasMessages = false;
      try {
        if (currentAdapter) {
          var msgs = currentAdapter.extractMessages();
          hasMessages = !!msgs && msgs.length > 0;
        }
      } catch (e) { hasMessages = false; }
      if (hasMessages) {
        stale = true;
        processAndSend();
      }
    }
  }, 12000);
}

// ========== v2.0 (этап 1/3): UMD-экспорт модуля ==========
// Паттерн как у utils/export-emit-pipeline.js: window.<Api> + module.exports.
// Рабочий путь ничего не импортирует: content-скрипты манифеста делят один
// глобальный лексический скоуп, поэтому объявления выше видны всем модулям и
// content.js по прежним именам. Api — для инструментов, отладки и тестов.
(function () {
  var Api = {};
  Api.aiCmHostHistoryRecord = aiCmHostHistoryRecord;
  Api.aiCmLogIntraDedupe = aiCmLogIntraDedupe;
  Api.aiCmDedupeExportSource = aiCmDedupeExportSource;
  Api.lastDedupeLogSig = lastDedupeLogSig;
  Api.aiCmLogDedupeRemoved = aiCmLogDedupeRemoved;
  Api.buildHistoryMessages = buildHistoryMessages;
  Api.aiCmBasePrepared = aiCmBasePrepared;
  Api.aiCmPreparedText = aiCmPreparedText;
  Api.aiCmMetricBaseText = aiCmMetricBaseText;
  Api.aiCmDiagHash6 = aiCmDiagHash6;
  Api.aiCmGeminiTurnsSnapshotSync = aiCmGeminiTurnsSnapshotSync;
  Api.aiCmExportNetSyncSite = aiCmExportNetSyncSite;      // O-18 (фаза 2)
  Api.aiCmExportNetSyncThen = aiCmExportNetSyncThen;      // O-18 (фаза 2)
  Api.aiCmLogNetSyncResult = aiCmLogNetSyncResult;        // O-18 (фаза 2)
  Api.aiCmDumpTurnsSnapshot = aiCmDumpTurnsSnapshot;
  Api.scheduleStaleCheck = scheduleStaleCheck;
  if (typeof module !== 'undefined' && module.exports) module.exports = Api;
  if (typeof window !== 'undefined') window.AiCmBaseHandler = Api;
})();
