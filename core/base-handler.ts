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
// для 'aiCmHistory:<host>'. По ts core/background.ts удаляет записи старше 30 дней.
function aiCmHostHistoryRecord(snapshot: AiCmHashMap): AiCmHashMap {
  var rec = Object.assign({}, snapshot);
  rec.ts = Date.now();
  return rec;
}

// v1.18 (E-2.1): ВНУТРИ-сообщенческая дедупликация. Deep Research с вложениями кладёт в
// ОДИН ход и отрендеренный текст, и сырой markdown-блок ('### ROLE& OBJECTIVE') — чистую
// функцию dedupeIntraMessage зовёт пайплайн (prepareExportMessages) на КАЖДОЕ сообщение ДО
// меж-сообщенческого dedupeMessages. Лог ниже — гейт сервиса + антиспам по подписи снимка.
function aiCmLogIntraDedupe(role: string, blocks: number): void {
  if (!(blocks > 0)) return;
  var sig = 'intra|' + (baseCount || 0) + '|' + (baseText ? baseText.length : 0);
  if (sig === lastDedupeLogSig) return;
  lastDedupeLogSig = sig;
  debugLog('log', '[AI CM][gemini] intra-dedupe removed=' + blocks + ' blocks in message role=' + role);
}
// v1.18 (E-2): схлопывание дублей собранного массива сообщений для Gemini/AI Studio.
// Deep Research отдаёт один и тот же текст пользователя несколько раз (пузырь реплики,
// карточка плана, узлы шагов) — история, идущая в бейдж/токены/экспорт/print, обязана
// содержать первое вхождение. Чистые функции — utils/export-emit-pipeline.ts
// (dedupeIntraMessage → dedupeMessages, порядок задан prepareExportMessages); здесь
// только гейт сервиса (прочие адаптеры не трогаем) и лог внутри-сообщенческих удалений.
function aiCmDedupeExportSource(messages: AiCmExportMessage[]): AiCmDedupeResult {
  try {
    var site = (currentAdapter && currentAdapter.siteName) || '';
    // O-32 (google_search): схлопывание на выходе сбора базы — РАБОЧЕЕ, а не no-op.
    // Живой дефект (лог 2026-09-23 16:47:48): один и тот же ход треда лежал в базе двумя
    // формами текста, file/метрики получали 18 сообщений вместо 12 (textLen 24764 против
    // reference 12255, бейдж 9% против 4.4%). Идентичность ходов чинится в писателях базы
    // (core/google-search-intercept.js + utils/google-search-folwr-parser.js: canonicalTurnKey),
    // а здесь — ПОСЛЕДНИЙ рубеж: та же подготовка пайплайна, что у Gemini (intra → inter →
    // cross-raw → гигиена остатков разметки), поэтому дубль-копия одного хода до потребителей
    // (метрики/бейдж/pct/экспорт) не доезжает. Для прочих не-Gemini сайтов путь прежний.
    if (site === 'google_search') {
      var Pgsa = (typeof AiCmExportEmitPipeline !== 'undefined' && AiCmExportEmitPipeline) ? AiCmExportEmitPipeline : ((typeof window !== 'undefined' && window.AiCmExportEmitPipeline) ? window.AiCmExportEmitPipeline : null);
      if (Pgsa && typeof Pgsa.prepareExportMessages === 'function') {
        var resGsa = Pgsa.prepareExportMessages(messages, aiCmLogIntraDedupe);
        var outGsa = Array.isArray(resGsa.messages) ? resGsa.messages : messages;
        if (resGsa.removed > 0 || resGsa.intraRemoved > 0) {
          debugLog('log', '[AI CM][google_search] dedupe removed=' + resGsa.removed +
            ' intra=' + resGsa.intraRemoved + ' msgs=' + messages.length + '→' + outGsa.length);
        }
        return { messages: outGsa, removed: resGsa.removed };
      }
      return { messages: messages, removed: 0 };
    }
    if (site !== 'gemini' && site !== 'aistudio') {
      var keep = [];
      for (var p = 0; p < messages.length; p++) {
        var mp = messages[p] || {};
        // FIX (Claude md): ход пользователя парсера Claude приходит ролью 'human' —
        // нормализуем её в 'user' здесь же, у входа в md (см. buildMdFromHistory).
        var msg: AiCmExportMessage = { role: (mp.role === 'user' || mp.role === 'human') ? 'user' : 'assistant', text: (typeof mp.text === 'string') ? mp.text : '' };
        // Claude md (ДИАГНОСТИКА — только измерение под гейтом aiCmDebug): роль хода на входе
        // точки и после нормализации. Маркер claude-role-* SCOPED по сайту: живой замер идёт по
        // Claude-цепочке, а на прочих сайтах роль хода — не предмет этого маркера (чужие строки
        // под именем claude-role-* вводили бы в заблуждение). Печать — каноническим хелпером
        // utils/debug.ts:aiCmDiagLine; хелпера нет (Node/срез-песочницы тестов) или гейт выключен
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
    var P = (typeof AiCmExportEmitPipeline !== 'undefined' && AiCmExportEmitPipeline) ? AiCmExportEmitPipeline : ((typeof window !== 'undefined' && window.AiCmExportEmitPipeline) ? window.AiCmExportEmitPipeline : null);
    if (!P) return { messages: messages, removed: 0 };
    // E-2.1: внутри-сообщенческая дедупликация идёт ПЕРВОЙ, меж-сообщенческая — второй;
    // порядок задан prepareExportMessages (единая точка входа пайплайна).
    if (typeof P.prepareExportMessages === 'function') {
      var res18 = P.prepareExportMessages(messages, aiCmLogIntraDedupe);
      return { messages: res18.messages, removed: res18.removed };
    }
    if (typeof P.dedupeMessages === 'function') return P.dedupeMessages(messages);
  } catch (eDed) { swallow(eDed, 'base-handler:dedupeExportSource'); }
  return { messages: messages, removed: 0 };
}
// v1.18 (E-2): лог схлопывания печатаем ОДИН раз на снимок базы (сигнатура count|textLen),
// а не на каждый processAndSend.
var lastDedupeLogSig: string | null = null;
function aiCmLogDedupeRemoved(removed: number): void {
  if (!(removed > 0)) return;
  var sig = baseCount + '|' + (baseText ? baseText.length : 0);
  if (sig === lastDedupeLogSig) return;
  lastDedupeLogSig = sig;
  debugLog('log', '[AI CM][gemini] dedupe removed=' + removed);
}
function buildHistoryMessages(): AiCmExportMessage[] {
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
var aiCmBasePrepared: AiCmExportMessage[] | null = null; // [{role,text,id}] | null — схлопнутая база последнего снимка
function aiCmPreparedText(messages: AiCmExportMessage[] | null): string {
  var src = Array.isArray(messages) ? messages : [];
  var out = [];
  for (var i = 0; i < src.length; i++) out.push(String((src[i] && src[i].text) || ''));
  return out.join('\n');
}
// Текст метрик (getEffectiveText → pct/токены/бейдж) — РОВНО схлопнутая база, не её копия.
function aiCmMetricBaseText(fallback: string): string {
  if (Array.isArray(aiCmBasePrepared) && aiCmBasePrepared.length > 0) return aiCmPreparedText(aiCmBasePrepared);
  return fallback;
}
// ================= v61diag: диагностика холодного старта (ТОЛЬКО логи, логика не тронута) =================
// FNV-1a 32-bit от id||text → 6 hex-символов (отпечаток хода для сравнения краёв ленты).
function aiCmDiagHash6(id: string, text: string): string {
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
function aiCmGeminiTurnsSnapshotSync(): AiCmTurnsSnapshot | null {
  try {
    var resp: any = null;
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
function aiCmExportNetSyncSite(): boolean {
  try {
    return (typeof currentAdapter !== 'undefined' && currentAdapter && currentAdapter.siteName === 'deepseek');
  } catch (eSite) { return false; }
}
// R2 (Qwen): площадки, у которых в MAIN-мире есть ОЧЕРЕДЬ текста вложений. DeepSeek — свой
// модуль (Step D.10, core/deepseek-files.js), Qwen — core/qwen-files.js (R2). Протокол
// ожидания общий: имена событий ai-cm-deepseek-files-* исторические, поэтому различается
// только сайт — экспорт получает шанс дождаться текста вложения до композиции файла.
function aiCmFilesDrainSite(): boolean {
  try {
    if (typeof currentAdapter === 'undefined' || !currentAdapter) return false;
    var site = currentAdapter.siteName;
    return site === 'deepseek' || site === 'qwen' || site === 'aistudio' || site === 'gemini';
  } catch (eSiteF) { return false; }
}
function aiCmExportNetSyncThen(convId: string | null, cb: ((info: AiCmNetSyncInfo) => void) | null, timeoutMs?: number): void {
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
    try { if (cb) cb(info || {}); } catch (eCb) { swallowSoft(eCb, 'base-handler:netSync-finish-callback'); }
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
    // v2.0.29 (Xray/Firefox): detail — СТРОКОЙ JSON. Объект из ISOLATED-компартмента MAIN-мир
    // в Firefox видит только через Xray-обёртку, и чтение его полей падает
    // «Permission denied to access property» → мост терял событие. Строка границу миров
    // пересекает примитивом; MAIN разбирает её aiCmBridgeDetail (core/deepseek-netsync.js).
    window.dispatchEvent(new CustomEvent('ai-cm-deepseek-net-sync', {
      detail: JSON.stringify({ requestId: reqId, convId: convId, timeoutMs: cap })
    }));
  } catch (eBridge) { finish({ ok: false, reason: 'bridge-error' }); }
}
// Маркер в логе: видно КАЖДЫЙ экспорт DeepSeek — был ли дозапрос, чем закончился, какой
// текст пошёл в файл (verdicts) и сколько ходов пришло из live.
function aiCmLogNetSyncResult(convId: string | null, info: AiCmNetSyncInfo): void {
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
function aiCmDumpTurnsSnapshot(tag: string, cid: string | null, msgs: AiCmExportMessage[]): void {
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
function scheduleStaleCheck(): void {
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

// ================= Step D.10 (Вариант B + A-лайт): очередь вложений DeepSeek =================
// Текст вложения догружается асинхронно в MAIN-мире (core/deepseek-files.js). Здесь — только
// ожидание опустошения очереди ПЕРЕД композицией файла: очередь пуста (или модуля нет) —
// экспорт идёт НЕМЕДЛЕННО прежним путём; не пуста — ждём до 2000 мс, затем пишем файл и
// фиксируем в логе reason=file-queue-timeout. Ожидание лишь даёт догрузке шанс доехать до
// turnsMap: состав/байты уже снятой базы от него не меняются, а «дождались» и «не дождались»
// различимы в логе. Мост — те же window-CustomEvent, что у probe/flush O-16 и net-sync O-18.
var aiCmFilesDrainSeq = 0;
function aiCmFilesQueuePending(): number {
  var pending = -1;
  var handler = null;
  try {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return 0;
    handler = function (ev) {
      var d = ev && ev.detail;
      if (d && typeof d.pending === 'number') pending = d.pending;
    };
    window.addEventListener('ai-cm-deepseek-files-state-response', handler);
    window.dispatchEvent(new CustomEvent('ai-cm-deepseek-files-state-request'));
  } catch (eState) {
    debugLog('log', '[AI CM][file-queue] state bridge: ' + ((eState && eState.message) || eState));
  } finally {
    try {
      if (handler) window.removeEventListener('ai-cm-deepseek-files-state-response', handler);
    } catch (eOff) {
      debugLog('log', '[AI CM][file-queue] state listener off: ' + ((eOff && eOff.message) || eOff));
    }
  }
  return pending;
}
// Маркер в логе: видно КАЖДЫЙ экспорт DeepSeek — ждали ли очередь, чем закончилось ожидание
// и сколько файлов осталось в полёте к моменту записи файла.
function aiCmLogFilesDrain(convId: string | null, info: AiCmFilesDrainInfo): void {
  try {
    var line = '[AI CM][file-queue] convId=' + String(convId || '').slice(0, 8) +
      ' ok=' + (info && info.ok === true ? 1 : 0) +
      ' reason=' + ((info && info.reason) || '-') +
      ' drained=' + (info && info.drained === true ? 1 : 0) +
      ' pending=' + ((info && typeof info.pending === 'number') ? info.pending : 0) +
      ' waitedMs=' + ((info && info.waitedMs) || 0);
    debugLog('log', line);
  } catch (eLog) {
    debugLog('log', '[AI CM][file-queue] log failed: ' + ((eLog && eLog.message) || eLog));
  }
}
function aiCmExportFilesDrainThen(convId: string | null, cb: ((info: AiCmFilesDrainInfo) => void) | null, timeoutMs?: number): void {
  var cap = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : 2000;
  var pending = aiCmFilesQueuePending();
  if (pending <= 0) {
    // Очередь пуста либо модуль не загружен (старая версия перехватчика) — не тормозим.
    try { if (cb) cb({ ok: true, drained: true, reason: 'idle-or-absent', pending: 0, waitedMs: 0 }); } catch (eCb0) { swallowSoft(eCb0, 'base-handler:filesDrain-idle-cb'); }
    return;
  }
  var done = false;
  var timer = null;
  var handler = null;
  var startedAt = Date.now();
  function finish(info) {
    if (done) return;
    done = true;
    if (timer) { try { clearTimeout(timer); } catch (eT) { debugLog('log', '[AI CM][file-queue] timer off: ' + ((eT && eT.message) || eT)); } timer = null; }
    if (handler) { try { window.removeEventListener('ai-cm-deepseek-files-drain-done', handler); } catch (eR) { debugLog('log', '[AI CM][file-queue] listener off: ' + ((eR && eR.message) || eR)); } handler = null; }
    aiCmLogFilesDrain(convId, info || {});
    try { if (cb) cb(info || {}); } catch (eCb) { swallowSoft(eCb, 'base-handler:filesDrain-finish-callback'); }
  }
  try {
    var reqId = 'files-' + Date.now() + '-' + (++aiCmFilesDrainSeq);
    handler = function (ev) {
      var d = ev && ev.detail;
      if (!d || String(d.requestId || '') !== reqId) return;
      finish(d);
    };
    window.addEventListener('ai-cm-deepseek-files-drain-done', handler);
    // Страховка сверх таймаута модуля: он отвечает сам, но если ответ потерян — экспорт не
    // имеет права висеть. reason тот же, чтобы лог не различал источник таймаута.
    timer = setTimeout(function () {
      finish({ ok: false, drained: false, reason: 'file-queue-timeout', pending: aiCmFilesQueuePending(), waitedMs: Date.now() - startedAt });
    }, cap + 250);
    // v2.0.29 (Xray/Firefox): detail — СТРОКОЙ JSON (тот же Xray-барьер, что у net-sync выше);
    // MAIN разбирает её aiCmBridgeDetail (core/deepseek-files.js).
    window.dispatchEvent(new CustomEvent('ai-cm-deepseek-files-drain', {
      detail: JSON.stringify({ requestId: reqId, timeoutMs: cap })
    }));
  } catch (eBridge) {
    finish({ ok: false, drained: false, reason: 'bridge-error', pending: pending, waitedMs: Date.now() - startedAt });
  }
}
// Полная цепочка экспорта DeepSeek: дождаться текста вложений (A-лайт) → сетевой дозапрос
// истории (O-18) → композиция файла. Старый порядок «сеть → файл» сохранён, ожидание
// вложений добавлено ПЕРЕД ним: текст вложения нужен той же базе, что уйдёт в файл.
function aiCmExportFilesThenNetSync(convId: string | null, cb: (() => void) | null, netTimeoutMs?: number): void {
  var next = function () {
    try { if (cb) cb(); } catch (eCb) { swallowSoft(eCb, 'base-handler:filesThenNet-callback'); }
  };
  aiCmExportFilesDrainThen(convId, function () {
    if (typeof aiCmExportNetSyncThen === 'function' && aiCmExportNetSyncSite()) {
      aiCmExportNetSyncThen(convId, next, netTimeoutMs);
      return;
    }
    next();
  }, 2000);
}
// ===== v2.0.35: AI Studio — ожидание очереди файлов ПЕРЕД записью файла =====
// Живой дефект приёмки: автоэкспорт AI Studio срабатывал (base-complete) раньше, чем
// MAIN-мир (core/aistudio-files.js) догружал текст вложений — ResolveDriveResource
// отдаёт только Drive file id, — и в файл уходила заглушка вместо `[FILE: <имя>]`.
// Очередь спрашиваем у модуля страницы напрямую: pending > 0 → откладываем файр на шаг
// 500 мс и перепроверяем (суммарно не дольше 5000 мс), затем пишем файл по актуальному
// снимку. Пока ждём — повторные триггеры не плодят файлы (per-cid реестр таймеров).
// Гейт узкий: только siteName === 'aistudio'; дренаж DeepSeek/Qwen (выше) не тронут.
var AI_CM_AISTUDIO_DRAIN_STEP_MS = 500;
var AI_CM_AISTUDIO_DRAIN_CAP_MS = 5000;
var aiCmAistudioDrainTimers = Object.create(null);
var aiCmAistudioDrainDeadlines = Object.create(null);

function aiCmAistudioFilesApi(): any {
  try {
    if (typeof window === 'undefined') return null;
    // Очередь публикует MAIN-мир (core/aistudio-files.js), в types/ её нет
    // (types/ — запрещённая зона правки), поэтому доступ к Window — через any-каст
    // (прецедент: core/background.ts:176). Псевдоним из тикета (AiCmAiStudioFiles,
    // с большой S) читается первым: имя могло быть закреплено в проде раньше.
    var w: any = (window as any);
    return w.AiCmAiStudioFiles || w.AiCmAistudioFiles || null;
  } catch (e) { return null; }
}
function aiCmAistudioFilesPending(): number {
  var api = aiCmAistudioFilesApi();
  if (!api || typeof api.pending !== 'function') return 0;
  try {
    var n = api.pending();
    return (typeof n === 'number' && n > 0) ? n : 0;
  } catch (e) { return 0; }
}
// true — файр отложен (повторный вход придёт по таймеру), false — можно писать файл.
function aiCmFilesDrainDefer(cid: string | null, percentage: number, reason: string, netSynced: boolean): boolean {
  try {
    if (typeof currentAdapter === 'undefined' || !currentAdapter || currentAdapter.siteName !== 'aistudio') return false;
    var pending = aiCmAistudioFilesPending();
    var key = String(cid || '');
    if (pending <= 0) { delete aiCmAistudioDrainDeadlines[key]; return false; }
    var now = Date.now();
    if (!aiCmAistudioDrainDeadlines[key]) aiCmAistudioDrainDeadlines[key] = now + AI_CM_AISTUDIO_DRAIN_CAP_MS;
    if (aiCmAistudioDrainTimers[key]) {
      debugLog('log', '[AI CM][auto-export] files-drain: файр уже ждёт очередь файлов convId=' + key + ' pending=' + pending);
      return true;
    }
    if (now >= aiCmAistudioDrainDeadlines[key]) {
      // Потолок ожидания: догрузка не успела — пишем файл, чтобы не потерять экспорт
      // (поздний ре-эмит снимка придёт следующим проходом).
      delete aiCmAistudioDrainDeadlines[key];
      debugLog('log', '[AI CM][auto-export] files-drain: потолок ожидания — пишем файл convId=' + key + ' pending=' + pending);
      return false;
    }
    debugLog('log', '[AI CM][auto-export] files-drain: ждём очередь файлов convId=' + key +
      ' pending=' + pending + ' step=' + AI_CM_AISTUDIO_DRAIN_STEP_MS + 'ms');
    aiCmAistudioDrainTimers[key] = setTimeout(function () {
      delete aiCmAistudioDrainTimers[key];
      try {
        // any-каст: types/core-globals.d.ts объявляет doAutoExportDownload с 3
        // параметрами, а фактическая функция принимает 4 (netSynced) — types/ не
        // правим (запрещённая зона), поэтому вызов идёт через локальный any.
        var redo = (typeof doAutoExportDownload === 'function') ? /** @type {any} */ (doAutoExportDownload) : null;
        if (redo) redo(cid, percentage, reason, netSynced);
      } catch (eRe) {
        debugLog('log', '[AI CM][auto-export] files-drain: повторный вход упал: ' + ((eRe && eRe.message) || eRe));
      }
    }, AI_CM_AISTUDIO_DRAIN_STEP_MS);
    return true;
  } catch (e) { return false; }
}
// ================= конец Step D.10 =================

// ========== v2.0 (этап 1/3): UMD-экспорт модуля ==========
// Паттерн как у utils/export-emit-pipeline.ts: window.<Api> + module.exports.
// Рабочий путь ничего не импортирует: content-скрипты манифеста делят один
// глобальный лексический скоуп, поэтому объявления выше видны всем модулям и
// content.js по прежним именам. Api — для инструментов, отладки и тестов.
(function () {
  var Api: any = {};
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
  Api.aiCmFilesDrainSite = aiCmFilesDrainSite;            // R2 (Qwen)
  Api.aiCmExportNetSyncThen = aiCmExportNetSyncThen;      // O-18 (фаза 2)
  Api.aiCmLogNetSyncResult = aiCmLogNetSyncResult;        // O-18 (фаза 2)
  Api.aiCmFilesQueuePending = aiCmFilesQueuePending;      // Step D.10 (A-лайт)
  Api.aiCmLogFilesDrain = aiCmLogFilesDrain;              // Step D.10 (A-лайт)
  Api.aiCmExportFilesDrainThen = aiCmExportFilesDrainThen;    // Step D.10 (A-лайт)
  Api.aiCmExportFilesThenNetSync = aiCmExportFilesThenNetSync; // Step D.10 (A-лайт)
  Api.aiCmFilesDrainDefer = aiCmFilesDrainDefer;               // v2.0.35 (задержка файлов)
  Api.aiCmDumpTurnsSnapshot = aiCmDumpTurnsSnapshot;
  Api.scheduleStaleCheck = scheduleStaleCheck;
  if (typeof module !== 'undefined' && module.exports) module.exports = Api;
  if (typeof window !== 'undefined') window.AiCmBaseHandler = Api;
})();

// ========== Core Wave 2: типы модуля (EOF-блок) ==========
// Общие структуры волны живут здесь, в базовом модуле кластера: base-handler и
// export-manager — оба classic-скрипты (нет import/export), поэтому их объявления
// глобальны и видны друг другу. Типы вынесены в хвост файла, чтобы аннотации не
// сдвигали строки выше (line-числа catch-whitelist и source-пины тестов прежние).

/** Разреженная карта произвольных значений (снимок истории, verdicts, patch-объекты). */
interface AiCmHashMap {
  [key: string]: any;
}

/** Сообщение экспорта: роль/текст + необязательное reasoning и служебные поля захвата. */
interface AiCmExportMessage {
  role?: string;
  text?: string;
  reasoning?: string;
  id?: unknown;
  [key: string]: any;
}

/** Выход схлопывания базы (E-2): сообщения + число удалённых. */
interface AiCmDedupeResult {
  messages: AiCmExportMessage[];
  removed: number;
}

/** Сводка turnsMap, которую отдаёт MAIN-перехватчик (диагностика и ярусы источника). */
interface AiCmTurnsSnapshot {
  convId?: string;
  messages?: AiCmExportMessage[] | null;
  archiveCount?: number;
  liveCount?: number;
  baseMsgs?: number;
  msgs?: number;
  firstMsgHash?: string;
  lastMsgHash?: string;
  firstText?: string;
  lastText?: string;
  baseComplete?: boolean | null;
  reachedStart?: boolean | null;
  confirmedByScroll?: boolean | null;
  scrollEngaged?: boolean;
  [key: string]: any;
}

/** Ответ моста O-18 (сетевой дозапрос истории перед экспортом). */
interface AiCmNetSyncInfo {
  ok?: boolean;
  reason?: string;
  refetched?: boolean;
  netTurns?: number;
  liveTurns?: number;
  verdicts?: unknown;
  requestId?: string;
  [key: string]: any;
}

/** Ответ моста Step D.10 / R2 (очередь текста вложений перед композицией файла). */
interface AiCmFilesDrainInfo {
  ok?: boolean;
  reason?: string;
  drained?: boolean;
  pending?: number;
  waitedMs?: number;
  requestId?: string;
  [key: string]: any;
}
