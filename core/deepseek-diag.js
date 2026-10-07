// =============================================================================
// core/deepseek-diag.js — Step D.1 (декомпозиция core/deepseek-intercept.js).
// ДИАГНОСТИКА DEEPSEEK: СЕКЦИИ 13/13D/13B ядра — диагностический дамп снапшота
// (dumpHistorySnapshot, маркеры o22-dispatch/ingest-branch), вербатим-дамп usage по
// ходам при загрузке истории (O-26) и измерение live vs network с кольцами сырья (O-18).
//
// Кластер вынесен из core/deepseek-intercept.js. Раньше обе части жили в ОДНОМ IIFE,
// поэтому кластер обращался к состоянию ядра по именам. Теперь у модуля свой IIFE,
// и состояние ядра приходит через __bind(deps).
//
// РАЗДЕЛЕНИЕ ПО SCOPE (важно для производительности). Тела перенесены БАЙТ-В-БАЙТ и без
// префиксов D., но лежат в ДВУХ зонах:
//   • PURE-зона (этот IIFE, до __bind) — 8 DIAG_*-констант, 11 diag-переменных (diagSeq,
//     diagOps, diagSseRing, diagHistRing, diagMarks, diagLiveTurns, diagLiveOrder,
//     diagNetTurns, diagEnrich, diagFlag, diagExports), USAGE_FIELD_RE и функции, которым
//     состояние ядра НЕ нужно: isDebugEnabled, getNavigationType, normalizeRole,
//     buildMessagesFromRaw, collectUsageFieldsVerbatim, fragContentLength, diagOn,
//     diagHash6, diagClip, diagPushRing, diagStat, diagFirstDiff, diagVerdict,
//     diagLiveTurnRecord.
//   • BIND-зона ('with (D) { … }' внутри __bind) — тела, читающие состояние/функции ядра:
//     determineState, buildMessagesFromTurnsMap, dumpTurnUsageAtHistoryLoad,
//     dumpHistorySnapshot, diagFragState, diagMark, diagChunkRecord, diagHistRecord,
//     diagSnapshotNetTurns, diagDumpRings, diagExportHook, diagResetForConv, мосты O-18.
// ПОЧЕМУ ТАК: внутри with каждый свободный идентификатор резолвится ДИНАМИЧЕСКИ (ES3
// Annex B), и горячий цикл FNV-хеша деградирует ~в 40 раз (микробенчмарк: 200×200 КБ —
// 81 мс вне with против 3309 мс в with). Тела, которым нужен только собственный scope,
// обязаны жить вне with — иначе O-18-прогон frag-resync растёт с 1.3 с до 5.1 с и
// упирается в таймаут jest. Байтовая идентичность тел сохранена в обеих зонах.
//
// Живое состояние ядра отдаётся геттерами (ro) и геттерами+сеттерами (rw): модуль и
// ядро работают с ОДНИМИ И ТЕМИ ЖЕ переменными IIFE, а не с копиями значений. rw —
// ровно те имена, что модуль перезаписывает: sseFragments/sseFragmentTypes (seed-мост
// O-18 подменяет буфер фрагментов) и lastDiagConvId (кольца O-18 живут в пределах одного
// convId; переменная осталась в ядре — её читает и пишет resetForNewConversation).
//
// Порядок подключения (core/background.js, registerSafe 'ai-cm-deepseek-intercept-v4',
// document_start, world MAIN): utils/debug.js -> ЭТОТ ФАЙЛ -> core/deepseek-netsync.js
// (Step D.2) -> core/deepseek-intercept.js.
// До связки на window.AiCmDeepseekDiag лежит только __bind; после связки Fn заполнен
// значениями 26 диагностических функций, а ядро раздаёт их 16 форвардерами по прежним
// именам. Экспорт: window.AiCmDeepseekDiag + module.exports.
// =============================================================================

(function () {
  if (typeof window !== 'undefined' && window.AiCmDeepseekDiag) return;

  // Зависимости ядра. Заполняется один раз через __bind(...) из core/deepseek-intercept.js.
  var D = null;
  var Fn = {};

  // ---- PURE-зона: собственное состояние модуля и функции без зависимости от ядра ----
  // ===== СЕКЦИЯ 13: ДИАГНОСТИЧЕСКИЙ ДАМП (только при sessionStorage aiCmDebug === '1') =====

  function isDebugEnabled() {
    try {
      return sessionStorage.getItem('aiCmDebug') === '1';
    } catch (e) { return false; }
  }

  function getNavigationType() {
    try {
      var entries = performance.getEntriesByType('navigation');
      if (entries && entries.length > 0) {
        return entries[0].type || '';
      }
    } catch (e) { }
    return '';
  }

  // Нормализация роли: USER→user, ASSISTANT→assistant, иначе→unknown
  function normalizeRole(rawRole) {
    if (!rawRole) return 'unknown';
    if (rawRole === 'USER') return 'user';
    if (rawRole === 'ASSISTANT') return 'assistant';
    return 'unknown';
  }

  function buildMessagesFromRaw(chatMessages, chain) {
    var chainIds = {};
    for (var ci = 0; ci < chain.length; ci++) {
      chainIds[String(chain[ci].message_id)] = true;
    }

    var messages = [];
    for (var i = 0; i < chatMessages.length; i++) {
      var msg = chatMessages[i];
      var mid = String(msg.message_id || '');
      var totalLen = 0;
      var thinkLen = 0;   // v8 (O-7): длина reasoning-фрагментов (type === 'THINK')
      var hasContent = false;
      var frags = Array.isArray(msg.fragments) ? msg.fragments : [];
      for (var fi = 0; fi < frags.length; fi++) {
        if (typeof frags[fi].content === 'string') {
          totalLen += frags[fi].content.length;
        }
        if (frags[fi] && frags[fi].type === 'THINK' && typeof frags[fi].content === 'string') {
          thinkLen += frags[fi].content.length;
        }
      }
      if (totalLen > 0) hasContent = true;

      var atts = Array.isArray(msg.attachments) ? msg.attachments : [];
      var attCount = atts.length;
      var attTokens = null;
      if (attCount > 0) {
        attTokens = 0;
        for (var ai = 0; ai < atts.length; ai++) {
          var a = atts[ai];
          if (a && typeof a.token_count === 'number') attTokens += a.token_count;
        }
        if (attTokens === 0) attTokens = null;
      }

      messages.push({
        index: i,
        messageIdPrefix: mid.slice(0, 8),
        role: normalizeRole(msg.role),
        hasContent: hasContent,
        contentLength: totalLen,
        reasoningLength: thinkLen,        // v8 (O-7): символов reasoning (THINK) в сообщении
        hasReasoning: thinkLen > 0,       // v8
        inActiveChain: !!chainIds[mid],
        hasTokenField: typeof msg.accumulated_token_usage === 'number',
        tokenFieldName: 'accumulated_token_usage',
        tokenValue: typeof msg.accumulated_token_usage === 'number' ? msg.accumulated_token_usage : null,
        hasParentId: !!msg.parent_id,
        parentIdPrefix: msg.parent_id ? String(msg.parent_id).slice(0, 8) : null,
        hasAttachments: attCount > 0,
        attachmentCount: attCount,
        attachmentTokens: attTokens,
        hasThinkingEnabled: typeof msg.thinking_enabled === 'boolean',
        thinkingEnabled: typeof msg.thinking_enabled === 'boolean' ? msg.thinking_enabled : null
      });
    }
    return messages;
  }

  // ===== СЕКЦИЯ 13D (O-26): ВЕРБАТИМ-ДАМП USAGE ПО ХОДАМ ПРИ ЗАГРУЗКЕ ИСТОРИИ =====
  // ИЗМЕРЕНИЕ (поведение НЕ меняется). Мотив O-26: на длинном чате бейдж DeepSeek растёт
  // сверхлинейно (151.3% → 396.3% при +3 коротких ходах). Подозрение — семантика поля
  // accumulated_token_usage в payload: это не «токены хода», а НАКОПИТЕЛЬ (сумма по ходам),
  // поэтому походовое чтение даёт квадратичный рост. Проверяется ТОЛЬКО фактами payload:
  // дамп печатает usage-поля КАЖДОГО сообщения цепочки ровно так, как они пришли —
  // без суммирования, приведения типов, агрегации и без правок расчёта pct/serverTokens.
  // Гейт: sessionStorage aiCmDebug === '1' (тот же, что у всей СЕКЦИИ 13); при выключенном
  // флаге функция выходит ПЕРВОЙ строкой — ни строки лога, ни работы с данными.
  // Однократность: вызов стоит в блоке `if (!loggedHistory)` ingestHistory — один дамп на
  // загрузку истории чата (loggedHistory сбрасывается сменой чата).
  // Ключи usage собираются по имени (token/usage/prompt/completion/cache/credit/cost) —
  // набор «соседних» ключей заранее неизвестен, поэтому печатается их фактический состав.
  var USAGE_FIELD_RE = /(token|usage|prompt|completion|cache|credit|cost)/i;
  function collectUsageFieldsVerbatim(msg) {
    var out = {};
    if (!msg || typeof msg !== 'object') return out;
    for (var k in msg) {
      if (!Object.prototype.hasOwnProperty.call(msg, k)) continue;
      if (k === 'fragments') continue;              // контент хода, не usage
      if (!USAGE_FIELD_RE.test(k)) continue;
      out[k] = msg[k];                              // значение КАК ЕСТЬ (включая вложенный объект usage)
    }
    return out;
  }
  function fragContentLength(frags) {
    var total = 0;
    for (var i = 0; i < frags.length; i++) {
      if (typeof frags[i].content === 'string') total += frags[i].content.length;
    }
    return total;
  }

  // ===== СЕКЦИЯ 13B (O-18, ФАЗА 1): ИЗМЕРЕНИЕ live vs network =====
  // Правило фазы: ПОВЕДЕНИЕ НЕ МЕНЯЕТСЯ. Всё ниже — либо чтение уже существующего
  // состояния, либо запись в СОБСТВЕННЫЕ буферы и console.log. Включается ТОЛЬКО флагом
  // sessionStorage aiCmDebug === '1': при выключенном флаге ни один буфер не наполняется и
  // ни одна строка не логируется, а вызовы в горячих путях сводятся к одному кэшированному
  // чтению sessionStorage раз в секунду (diagOn). Ни одна diag-функция не пишет в turnsMap,
  // не трогает гейты/латчи/экспорт/формат файла.
  //   diagSseRing   — кольцо сырых SSE-чанков (response/fragments*, o=APPEND/SET) + состояние
  //                   буфера фрагментов ДО и ПОСЛЕ обработки чанка (len/hash по фрагментам);
  //   diagHistRing  — кольцо ответов history_messages текущего convId (сырьё + состав
  //                   фрагментов по каждому сообщению: type/len/hash/head);
  //   diagMarks     — маркеры веток ingestHistory (MERGE/EMPTY-AUTH/EMPTY-NONAUTH/TRUNCATED/
  //                   ACCEPT/дозапрос) и фаз потока (begin/reset/end/finish);
  //   diagLiveTurns — per-turn текст, собранный LIVE-путём (SSE), с ревизиями;
  //   diagNetTurns  — per-turn текст последнего ПРИНЯТОГО снимка history_messages (network);
  //   diagEnrich    — ревизии live-текста, где вердикт не EQUAL (кандидат «длиннее побеждает»).
  // Дамп на КАЖДЫЙ экспорт: мост ai-cm-turns-snap-request уже вызывается экспортёром в обеих
  // точках записи файла (snapshot-at-fired / snapshot-at-manual) — здесь только читаем.
  var DIAG_SSE_RING_MAX = 400;
  var DIAG_HIST_RING_MAX = 3;
  var DIAG_MARK_MAX = 40;
  var DIAG_ENRICH_MAX = 60;
  var DIAG_REV_MAX = 8;
  var DIAG_RAW_CAP = 240;
  var DIAG_HIST_RAW_CAP = 200000;
  var DIAG_SEAM_MIN = 48;      // мин. длина «шва» для вердикта MIDDLE-HOLE
  var diagSeq = 0;
  var diagOps = { APPEND: 0, SET: 0, other: 0 };
  var diagSseRing = [];
  var diagHistRing = [];
  var diagMarks = [];
  var diagLiveTurns = {};
  var diagLiveOrder = [];
  var diagNetTurns = null;
  var diagEnrich = [];
  var diagFlag = { v: false, at: 0 };
  var diagExports = 0;

  function diagOn() {
    var now = Date.now();
    if (now - diagFlag.at < 1000) return diagFlag.v;
    diagFlag.at = now;
    diagFlag.v = isDebugEnabled();
    return diagFlag.v;
  }
  // FNV-1a 32-bit → 6 hex (тот же отпечаток, что aiCmDiagHash6 в base-handler.js)
  function diagHash6(s) {
    try {
      var str = String(s === null || s === undefined ? '' : s);
      var h = 0x811c9dc5;
      for (var i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return ('000000' + h.toString(16)).slice(-6);
    } catch (e) { return '000000'; }
  }
  function diagClip(s, cap) {
    try {
      var str = String(s === null || s === undefined ? '' : s);
      return str.length > cap ? str.slice(0, cap) : str;
    } catch (e) { return ''; }
  }
  function diagPushRing(arr, item, max) {
    try {
      arr.push(item);
      while (arr.length > max) arr.shift();
    } catch (e) { }
  }
  function diagStat(t) {
    if (t === null || t === undefined) return '(none)';
    var s = String(t);
    return s.length + ':' + diagHash6(s);
  }
  function diagFirstDiff(a, b) {
    try {
      var A = String(a === null || a === undefined ? '' : a);
      var B = String(b === null || b === undefined ? '' : b);
      var n = Math.min(A.length, B.length);
      for (var i = 0; i < n; i++) { if (A.charAt(i) !== B.charAt(i)) return i; }
      return A.length === B.length ? -1 : n;
    } catch (e) { return 0; }
  }
  // Вердикт «live-текст против network-текста»: что именно потерял/приобрел live.
  //   EQUAL / TAIL-CUT (live — префикс net) / MIDDLE-HOLE (live потерял срединный кусок и
  //   СШИЛСЯ с net дальше — точная сигнатура O-18) / MIDDLE-HOLE-PARTIAL / LIVE-EXTRA / DIFF-OTHER
  function diagVerdict(lt, nt) {
    var out = { verdict: 'ONE-SIDE', firstDiff: null, lost: 0, resync: null };
    try {
      if (lt === null || lt === undefined || nt === null || nt === undefined) return out;
      var L = String(lt), N = String(nt);
      var fd = diagFirstDiff(L, N);
      out.firstDiff = fd;
      if (fd === -1) { out.verdict = 'EQUAL'; return out; }
      if (fd === L.length && L === N.slice(0, L.length)) {
        out.verdict = 'TAIL-CUT'; out.lost = N.length - L.length; return out;
      }
      if (fd < L.length) {
        var tail = L.slice(fd);
        var seam = (tail.length >= DIAG_SEAM_MIN) ? N.indexOf(tail, fd + 1) : -1;
        if (seam > fd) {
          out.resync = seam;
          out.lost = seam - fd;
          out.verdict = (seam + tail.length === N.length) ? 'MIDDLE-HOLE' : 'MIDDLE-HOLE-PARTIAL';
          return out;
        }
      }
      if (fd === N.length && N === L.slice(0, N.length)) {
        out.verdict = 'LIVE-EXTRA'; out.lost = L.length - N.length; return out;
      }
    } catch (e) { }
    out.verdict = 'DIFF-OTHER';
    return out;
  }
  // Per-turn LIVE-текст (SSE-путь) + ревизии: видно, КАК менялся ход от финала к финалу.
  function diagLiveTurnRecord(id, role, text, reason) {
    try {
      if (!diagOn()) return;
      var key = String(id);
      var txt = (typeof text === 'string') ? text : '';
      var rec = diagLiveTurns[key];
      if (!rec) {
        rec = { id: key, role: String(role || ''), len: 0, hash: '', revs: [] };
        diagLiveTurns[key] = rec;
        diagLiveOrder.push(key);
      }
      var prev = rec.lastText || '';
      // Первая ревизия хода: сравнивать не с чем (prev пуст) — вердикт не выносим.
      var v = (prev.length > 0) ? diagVerdict(prev, txt) : { verdict: 'FIRST', firstDiff: null, lost: 0, resync: null };
      rec.revs.push({
        seq: ++diagSeq, t: Date.now(), reason: String(reason || ''), len: txt.length, hash: diagHash6(txt),
        prevLen: prev.length, firstDiff: v.firstDiff, verdict: v.verdict, lost: v.lost, resync: v.resync
      });
      while (rec.revs.length > DIAG_REV_MAX) rec.revs.shift();
      if (v.verdict !== 'EQUAL' && v.verdict !== 'ONE-SIDE') {
        diagPushRing(diagEnrich, {
          seq: ++diagSeq, t: Date.now(), id: key, role: String(role || ''), reason: String(reason || ''),
          prevLen: prev.length, newLen: txt.length, prevHash: diagHash6(prev), newHash: diagHash6(txt),
          firstDiff: v.firstDiff, verdict: v.verdict, lost: v.lost, resync: v.resync
        }, DIAG_ENRICH_MAX);
        console.log('[ai-cm-debug][O18][live-rev] id=' + key.slice(0, 8) + ' role=' + (role || '-') +
          ' reason=' + reason + ' prevLen=' + prev.length + ' newLen=' + txt.length +
          ' firstDiff=' + (v.firstDiff === null ? '-' : v.firstDiff) + ' verdict=' + v.verdict +
          ' lost=' + v.lost + ' resync=' + (v.resync === null ? '-' : v.resync));
      }
      rec.role = String(role || rec.role || '');
      rec.lastText = txt;
      rec.len = txt.length;
      rec.hash = diagHash6(txt);
    } catch (e) { }
  }

  function __bind(d) {
    D = d;
    with (D) {
      // ---- BIND-зона: тела, читающие живое состояние/функции ядра через with (D) ----

  function determineState() {
    var navType = getNavigationType();
    var convPrefix = '';
    try { convPrefix = (currentConvId || '').slice(0, 8); } catch (e) { }
    var visitedKey = '';
    var wasVisited = false;
    if (convPrefix) {
      visitedKey = 'aiCmVisited:' + convPrefix;
      try { wasVisited = sessionStorage.getItem(visitedKey) === '1'; } catch (e) { }
    }

    if (navType === 'reload' || navType === 'back_forward') {
      return { state: 'after_f5', reason: 'navigationType=' + navType + ', convId=' + convPrefix, navType: navType };
    }
    if (wasVisited) {
      return { state: 'after_f5', reason: 'sessionStorage marker found for ' + convPrefix, navType: navType };
    }
    if (convPrefix) {
      try { sessionStorage.setItem(visitedKey, '1'); } catch (e) { }
    }
    return { state: 'open', reason: 'first visit (nav=' + (navType || 'unknown') + ', convId=' + convPrefix + ')', navType: navType };
  }

  function buildMessagesFromTurnsMap() {
    var ids = Object.keys(turnsMap);
    // Сортируем по order, при одинаковом — по ts
    var orderSource = 'order';
    var hasOrder = true;
    var hasTs = true;
    for (var k = 0; k < ids.length; k++) {
      var t = turnsMap[ids[k]];
      if (typeof t.order !== 'number') { hasOrder = false; }
      if (typeof t.ts !== 'number') { hasTs = false; }
    }
    if (!hasOrder) orderSource = 'keys_unknown';

    ids.sort(function (a, b) {
      var oa = turnsMap[a].order;
      var ob = turnsMap[b].order;
      if (typeof oa === 'number' && typeof ob === 'number') {
        if (oa !== ob) return oa - ob;
        // при одинаковом order — по ts
        var tsa = turnsMap[a].ts;
        var tsb = turnsMap[b].ts;
        if (typeof tsa === 'number' && typeof tsb === 'number') return tsa - tsb;
        return 0;
      }
      if (typeof oa === 'number') return -1;
      if (typeof ob === 'number') return 1;
      // оба без order — по ts если доступно
      var tsa2 = turnsMap[a].ts;
      var tsb2 = turnsMap[b].ts;
      if (typeof tsa2 === 'number' && typeof tsb2 === 'number') return tsa2 - tsb2;
      return 0;
    });

    var messages = [];
    for (var i = 0; i < ids.length; i++) {
      var ti = turnsMap[ids[i]];
      var role = (ti.role === 'user' || ti.role === 'assistant') ? ti.role : 'unknown';

      messages.push({
        index: i,
        messageIdPrefix: ids[i].slice(0, 8),
        role: role,
        hasContent: !!ti.text && ti.text.length > 0,
        contentLength: ti.text ? ti.text.length : 0,
        inActiveChain: null,
        hasTokenField: false,
        tokenFieldName: null,
        tokenValue: null,
        hasParentId: null,
        parentIdPrefix: null,
        hasAttachments: null,
        attachmentCount: null,
        attachmentTokens: null,
        hasThinkingEnabled: null,
        thinkingEnabled: null,
        modelSlug: ti.modelSlug || null,
        hasReasoning: !!ti.reasoning,               // v8 (O-7)
        reasoningLength: ti.reasoning ? ti.reasoning.length : 0   // v8
      });
    }

    return { messages: messages, orderSource: orderSource };
  }
  function dumpTurnUsageAtHistoryLoad(chain, chatMessages, chatSession) {
    try {
      if (!isDebugEnabled()) return;                // без флага — молчание
      var list = Array.isArray(chain) ? chain : [];
      var all = Array.isArray(chatMessages) ? chatMessages : [];
      var usageKeys = [];
      var seenKeys = {};
      // Шапка: сколько сообщений в цепочке/снимке и какой состав usage-полей найден.
      for (var p = 0; p < list.length; p++) {
        var u0 = collectUsageFieldsVerbatim(list[p]);
        for (var k0 in u0) {
          if (!Object.prototype.hasOwnProperty.call(u0, k0)) continue;
          if (seenKeys[k0]) continue;
          seenKeys[k0] = 1;
          usageKeys.push(k0);
        }
      }
      console.log('[ai-cm-debug][O26][usage] turns=' + list.length +
        ' chatMessages=' + all.length +
        ' modelType=' + ((chatSession && chatSession.model_type) || '(default)') +
        ' usageKeys=' + (usageKeys.length ? usageKeys.join(',') : '(none)'));
      for (var i = 0; i < list.length; i++) {
        var msg = list[i] || {};
        var frags = Array.isArray(msg.fragments) ? msg.fragments : [];
        var rec = {
          index: i,
          messageIdPrefix: String(msg.message_id == null ? '' : msg.message_id).slice(0, 8),
          role: normalizeRole(msg.role),
          fragments: frags.length,
          contentLength: fragContentLength(frags),
          answerLength: collectTurnText(frags, msg.role).length,
          reasoningLength: collectTurnReasoning(frags, msg.role).length,
          usage: collectUsageFieldsVerbatim(msg)     // ВЕРБАТИМ: значения как в payload
        };
        var line = '';
        try { line = JSON.stringify(rec); } catch (eSer) { line = '(несериализуемо)'; }
        console.log('[ai-cm-debug][O26][turn] ' + line);
      }
    } catch (e) { }
  }

  function dumpHistorySnapshot(state, stateReason, ctx) {
    // Вызывается ТОЛЬКО после проверки isDebugEnabled() в точках вызова
    try {
      ctx = ctx || {};
      var nowTs = Date.now();
      var convPrefix = '';
      try { convPrefix = (currentConvId || '').slice(0, 8); } catch (e) { }

      // Виджет-процент из DOM
      var widgetPercent = null;
      var widgetPercentRaw = null;
      var widgetPercentSource = 'none';
      try {
        var widgetEl = document.querySelector('.ai-widget-text');
        if (widgetEl) {
          widgetPercentRaw = widgetEl.textContent || '';
          var pctMatch = widgetPercentRaw.match(/([0-9]+(?:\.[0-9]+)?)/);
          if (pctMatch) {
            widgetPercent = parseFloat(pctMatch[1]);
            widgetPercentSource = 'dom';
          }
        }
      } catch (e) { }

      // Модель — по последнему ходу по order (упорядоченный turnsMap)
      var lastModel = '';
      var tmIds = Object.keys(turnsMap).sort(function (a, b) {
        return (turnsMap[a].order || 0) - (turnsMap[b].order || 0);
      });
      for (var j = 0; j < tmIds.length; j++) {
        var t = turnsMap[tmIds[j]];
        if (t.modelSlug) lastModel = t.modelSlug;
      }

      var modelMode = '';
      if (typeof ctx.chatMode === 'string') modelMode = ctx.chatMode;
      if (typeof ctx.modelType === 'string' && ctx.modelType) modelMode = ctx.modelType;

      // serverTokens
      var stUsed = null;
      var stSource = 'none';
      var stAccumulated = null;
      var stSseEntry = null;
      var stSseFinal = null;

      if (ctx.lastAccumulated !== undefined) {
        stAccumulated = (typeof ctx.lastAccumulated === 'number' && ctx.lastAccumulated > 0) ? ctx.lastAccumulated : null;
        stUsed = stAccumulated;
        stSource = 'accumulated_last_message';
      }
      if (ctx.sseEntry !== undefined) {
        stSseEntry = (typeof ctx.sseEntry === 'number' && ctx.sseEntry > 0) ? ctx.sseEntry : null;
      }
      if (ctx.sseFinal !== undefined) {
        stSseFinal = (typeof ctx.sseFinal === 'number' && ctx.sseFinal > 0) ? ctx.sseFinal : null;
      }
      // SSE приоритетнее — перезаписывает used/source
      if (stSseFinal !== null) {
        stUsed = stSseFinal;
        stSource = 'sse_final_batch';
      } else if (stSseEntry !== null) {
        stUsed = stSseEntry;
        stSource = 'sse_entry_response';
      }

      // Сообщения
      var messages;
      var messagesSource;
      var messagesOrderSource = null;
      var rawMessagesCount = null;
      var activeChainCount = null;
      if (Array.isArray(ctx.chatMessages)) {
        var chain = Array.isArray(ctx.chain) ? ctx.chain : [];
        messages = buildMessagesFromRaw(ctx.chatMessages, chain);
        messagesSource = 'chat_messages_raw';
        messagesOrderSource = 'raw_array_order';
        rawMessagesCount = ctx.chatMessages.length;
        activeChainCount = chain.length;
      } else {
        var tmResult = buildMessagesFromTurnsMap();
        messages = tmResult.messages;
        messagesSource = 'turns_map';
        messagesOrderSource = tmResult.orderSource;
      }

      var turnsMapSize = Object.keys(turnsMap).length;

      // Статистика
      var userCount = 0;
      var assistantCount = 0;
      var unknownCount = 0;
      var totalContentLength = 0;
      var reasoningMessages = 0;        // v8 (O-7)
      var totalReasoningLength = 0;     // v8
      var maxTokenValue = null;
      var lastTokenValue = null;
      for (var mi = 0; mi < messages.length; mi++) {
        var m = messages[mi];
        if (m.role === 'user') userCount++;
        else if (m.role === 'assistant') assistantCount++;
        else unknownCount++;
        if (typeof m.contentLength === 'number') totalContentLength += m.contentLength;
        if (m.hasReasoning) { reasoningMessages++; totalReasoningLength += (m.reasoningLength || 0); }   // v8
        if (typeof m.tokenValue === 'number') {
          lastTokenValue = m.tokenValue;
          if (maxTokenValue === null || m.tokenValue > maxTokenValue) {
            maxTokenValue = m.tokenValue;
          }
        }
      }

      // historyFullByNetwork: только для ingestHistory и только если реально дошли до корня
      var capPoint = ctx.capturePoint || 'unknown';
      var hfbn = null;
      if (capPoint === 'ingestHistory') {
        hfbn = histCompletion.historyComplete;
      }

      var dump = {
        ai: 'deepseek',
        state: state,
        stateReason: stateReason || '',
        navigationType: ctx.navType || '',
        capturedAt: nowTs,
        capturePoint: capPoint,
        convIdPrefix: convPrefix || null,
        widgetPercent: widgetPercent,
        widgetPercentRaw: widgetPercentRaw,
        widgetPercentSource: widgetPercentSource,
        model: lastModel || null,
        modelMode: modelMode || null,
        flags: {
          historyFullByNetwork: hfbn,
          historyComplete: histCompletion.historyComplete,   // v7: честная полнота
          reachedRoot: histCompletion.reachedRoot,           // v7: доказан ли корень
          loggedHistory: loggedHistory,
          loggedRealtime: loggedRealtime,
          reasoningEnabled: REASONING_ENABLED    // v8 (O-7)
        },
        serverTokens: {
          used: stUsed,
          source: stSource,
          accumulatedFromLastMessage: stAccumulated,
          sseEntryTokens: stSseEntry,
          sseFinalTokens: stSseFinal
        },
        messages: messages,
        summary: {
          totalMessages: messages.length,
          userMessages: userCount,
          assistantMessages: assistantCount,
          unknownMessages: unknownCount,
          totalContentLength: totalContentLength,
          reasoningMessages: reasoningMessages,           // v8 (O-7): сообщений с непустым reasoning
          totalReasoningLength: totalReasoningLength,     // v8 (O-7)
          sumTokenFields: null,
          maxTokenValue: maxTokenValue,
          lastTokenValue: lastTokenValue,
          tokenFieldPolicy: 'cumulative_not_summable',
          rawMessagesCount: rawMessagesCount,
          activeChainCount: activeChainCount,
          turnsMapSize: turnsMapSize,
          historyLoadedTurns: turnsMapSize,
          messagesSource: messagesSource,
          messagesOrderSource: messagesOrderSource
        }
      };

      try {
        console.log('[ai-cm-debug] DEEPSEEK_STRUCT_DUMP\n' + JSON.stringify(dump, null, 2));
      } catch (jsonErr) {
        console.warn('[ai-cm-debug] DEEPSEEK_STRUCT_DUMP ошибка сериализации:', jsonErr);
      }
    } catch (e) {
      console.warn('[ai-cm-debug] DEEPSEEK_STRUCT_DUMP ошибка дампа:', e);
    }
  }
  var lastDiagConvId = currentConvId;   // O-18: кольца живут в пределах одного convId
  // Срез буфера фрагментов потока: состав, длина и отпечаток контента каждого фрагмента.
  function diagFragState() {
    var out = [];
    try {
      for (var i = 0; i < sseFragments.length; i++) {
        var f = sseFragments[i] || {};
        var c = (typeof f.content === 'string') ? f.content : '';
        out.push({ i: i, type: String(f.type || ''), len: c.length, hash: diagHash6(c) });
      }
    } catch (e) { }
    return out;
  }
  function diagMark(kind, data) {
    try {
      if (!diagOn()) return;
      var m = { seq: ++diagSeq, t: Date.now(), kind: String(kind || ''), conv: (currentConvId || '').slice(0, 8) };
      if (data) {
        for (var k in data) { if (Object.prototype.hasOwnProperty.call(data, k)) m[k] = data[k]; }
      }
      m.ops = { APPEND: diagOps.APPEND, SET: diagOps.SET, other: diagOps.other };
      m.frags = diagFragState();
      diagPushRing(diagMarks, m, DIAG_MARK_MAX);
      console.log('[ai-cm-debug][O18][mark] ' + JSON.stringify(m));
    } catch (e) { }
  }
  // Запись чанка SSE в кольцо + детектор СЖАТИЯ уже собранного контента (прямая улика потери).
  function diagChunkRecord(path, op, val, before, after) {
    try {
      var p = String(path === null || path === undefined ? '' : path);
      if (p.indexOf('fragments') === -1) { diagOps.other++; return; }
      if (op === 'APPEND') diagOps.APPEND++;
      else if (op === 'SET') diagOps.SET++;
      else diagOps.other++;
      var entry = {
        seq: ++diagSeq, t: Date.now(), conv: (currentConvId || '').slice(0, 8),
        path: p, op: String(op === null || op === undefined ? '' : op), kind: '',
        types: [], contentLens: [], rawLen: 0, raw: '', rawCut: false,
        before: before, after: after, changed: false
      };
      if (typeof val === 'string') {
        entry.kind = 'string';
        entry.rawLen = val.length;
        entry.raw = diagClip(val, DIAG_RAW_CAP);
        entry.rawCut = val.length > DIAG_RAW_CAP;
      } else if (Array.isArray(val)) {
        entry.kind = 'array';
        var js = '';
        try { js = JSON.stringify(val); } catch (eJs) { js = ''; }
        entry.rawLen = js.length;
        entry.raw = diagClip(js, DIAG_RAW_CAP);
        entry.rawCut = js.length > DIAG_RAW_CAP;
        for (var i = 0; i < val.length; i++) {
          var it = val[i];
          if (typeof it === 'string') { entry.types.push(it); entry.contentLens.push(0); }
          else if (it && typeof it === 'object') {
            entry.types.push(String(it.type || ''));
            entry.contentLens.push(typeof it.content === 'string' ? it.content.length : 0);
          } else { entry.types.push('?'); entry.contentLens.push(0); }
        }
      } else if (val !== undefined && val !== null) {
        entry.kind = typeof val;
        entry.rawLen = String(val).length;
        entry.raw = diagClip(String(val), DIAG_RAW_CAP);
      } else {
        entry.kind = 'empty';
      }
      try { entry.changed = JSON.stringify(before) !== JSON.stringify(after); } catch (eCh) { entry.changed = true; }
      diagPushRing(diagSseRing, entry, DIAG_SSE_RING_MAX);
      // Улика: контент уже собранного фрагмента УМЕНЬШИЛСЯ или фрагмент пропал из буфера.
      var shrink = [];
      if (before && after) {
        for (var q = 0; q < before.length && q < after.length; q++) {
          if (after[q].len < before[q].len) {
            shrink.push({ i: q, type: before[q].type, from: before[q].len, to: after[q].len, fromHash: before[q].hash, toHash: after[q].hash });
          }
        }
        if (after.length < before.length) shrink.push({ droppedFragments: before.length - after.length });
      }
      if (shrink.length) {
        console.warn('[ai-cm-debug][O18][SHRINK] op=' + entry.op + ' path=' + entry.path +
          ' types=' + JSON.stringify(entry.types) + ' shrink=' + JSON.stringify(shrink) +
          ' before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after));
      }
    } catch (e) { }
  }
  // Сырой ответ history_messages: сводка + состав фрагментов по каждому сообщению.
  function diagHistRecord(json, src) {
    try {
      if (!diagOn()) return;
      var raw = '';
      try { raw = JSON.stringify(json); } catch (eR) { raw = ''; }
      var bd = json && json.data && json.data.biz_data;
      var cs = bd && bd.chat_session;
      var cms = (bd && Array.isArray(bd.chat_messages)) ? bd.chat_messages : [];
      var rec = {
        seq: ++diagSeq, t: Date.now(), src: String(src || ''),
        conv: (currentConvId || '').slice(0, 8),
        url: diagClip(lastHistoryUrl || '', 140),
        code: (json && json.code),
        rawLen: raw.length, rawCut: raw.length > DIAG_HIST_RAW_CAP,
        chatMessages: cms.length,
        isEmpty: cs ? cs.is_empty : null,
        currentMessageId: (cs && cs.current_message_id != null) ? String(cs.current_message_id).slice(0, 8) : null,
        modelType: cs ? cs.model_type : null,
        fragTotal: 0,
        messages: []
      };
      var cap = Math.min(cms.length, 300);
      for (var i = 0; i < cap; i++) {
        var msg = cms[i] || {};
        var fr = Array.isArray(msg.fragments) ? msg.fragments : [];
        var frags = [];
        for (var j = 0; j < fr.length; j++) {
          var f = fr[j] || {};
          var c = (typeof f.content === 'string') ? f.content : '';
          frags.push({ type: String(f.type || ''), len: c.length, hash: diagHash6(c), head: diagClip(c, 80) });
        }
        rec.fragTotal += frags.length;
        rec.messages.push({
          i: i, id: String(msg.message_id || '').slice(0, 8), role: String(msg.role || ''),
          parent: msg.parent_id != null ? String(msg.parent_id).slice(0, 8) : null,
          insertedAt: msg.inserted_at || null,
          accumulated: (typeof msg.accumulated_token_usage === 'number') ? msg.accumulated_token_usage : null,
          thinkingEnabled: (typeof msg.thinking_enabled === 'boolean') ? msg.thinking_enabled : null,
          frags: frags
        });
      }
      rec.raw = diagClip(raw, DIAG_HIST_RAW_CAP);
      diagPushRing(diagHistRing, rec, DIAG_HIST_RING_MAX);
      console.log('[ai-cm-debug][O18][history] src=' + rec.src + ' conv=' + rec.conv +
        ' chatMessages=' + rec.chatMessages + ' is_empty=' + rec.isEmpty +
        ' current=' + rec.currentMessageId + ' rawLen=' + rec.rawLen + ' frags=' + rec.fragTotal +
        ' refetchDone=' + (historyRefetchDone === true ? 1 : 0));
    } catch (e) { }
  }
  // Снимок NETWORK-текста по ходам: ровно то, что принятый ingestHistory положил в turnsMap.
  function diagSnapshotNetTurns(reason) {
    try {
      if (!diagOn()) return;
      var ids = Object.keys(turnsMap).sort(function (a, b) {
        return (turnsMap[a].order || 0) - (turnsMap[b].order || 0);
      });
      var map = {}, order = [], lens = [];
      for (var i = 0; i < ids.length; i++) {
        var t = turnsMap[ids[i]] || {};
        var txt = (typeof t.text === 'string') ? t.text : '';
        map[ids[i]] = { role: t.role || '', len: txt.length, hash: diagHash6(txt), text: txt };
        order.push(ids[i]);
        lens.push(txt.length);
      }
      diagNetTurns = { conv: (currentConvId || '').slice(0, 8), t: Date.now(), reason: String(reason || ''), order: order, map: map };
      console.log('[ai-cm-debug][O18][net] snapshot reason=' + reason + ' turns=' + order.length + ' lens=' + lens.join(','));
    } catch (e) { }
  }
  function diagDumpRings(trigger) {
    try {
      var payload = {
        o18: 'live-vs-network', trigger: String(trigger || ''), at: Date.now(),
        conv: (currentConvId || '').slice(0, 8), convFull: currentConvId || '',
        ops: diagOps, exports: diagExports,
        flags: {
          historyComplete: histCompletion.historyComplete, reachedRoot: histCompletion.reachedRoot,
          baseEmpty: histCompletion.baseEmpty, historyRefetchDone: historyRefetchDone,
          streamActive: sseStreamActive === true, turnFinished: sseTurnFinished === true,
          requestMessageId: sseRequestMessageId ? String(sseRequestMessageId).slice(0, 8) : null,
          responseMessageId: sseResponseMessageId ? String(sseResponseMessageId).slice(0, 8) : null
        },
        netSnapshot: diagNetTurns ? { conv: diagNetTurns.conv, t: diagNetTurns.t, reason: diagNetTurns.reason, turns: diagNetTurns.order.length } : null,
        // v12 (O-18, фаза 2): ресинхрон парсера (сколько раз, сколько байт восстановлено)
        // и состояние экспортного сетевого дозапроса — прямо в дампе приёмки.
        resync: {
          count: sseResyncCount, bytes: sseResyncBytes, ring: sseResyncRing.length,
          unknown: sseUnknownCount, unknownChars: sseUnknownChars, types: Object.keys(SSE_FRAGMENT_TYPES).join(',')
        },
        netSync: {
          stats: netSyncStats, needed: netSyncNeeded(), liveTurns: liveTurnOrder.length,
          netAt: netSnapshotAt, lastTurnDoneAt: lastTurnDoneAt, netTurnIds: Object.keys(netTurnIds).length
        },
        liveOrder: diagLiveOrder,
        liveTurns: {},
        enrich: diagEnrich, marks: diagMarks, sse: diagSseRing, history: diagHistRing
      };
      for (var i = 0; i < diagLiveOrder.length; i++) {
        var id = diagLiveOrder[i], r = diagLiveTurns[id];
        if (r) payload.liveTurns[id] = { role: r.role, len: r.len, hash: r.hash, revs: r.revs };
      }
      console.log('[ai-cm-debug][O18][rings] ' + JSON.stringify(payload));
    } catch (e) { console.warn('[ai-cm-debug][O18] ошибка дампа колец:', e); }
  }
  // Дамп на КАЖДЫЙ экспорт: per-turn сравнение live(SSE) vs network(history_messages) vs
  // текущий turnsMap (то, что реально уйдёт в файл) + кольца сырья.
  function diagExportHook(trigger) {
    try {
      if (!diagOn()) return;
      diagExports++;
      var net = diagNetTurns;
      var ids = [], seen = {}, i, id;
      if (net && net.order) {
        for (i = 0; i < net.order.length; i++) { id = net.order[i]; if (!seen[id]) { seen[id] = 1; ids.push(id); } }
      }
      for (i = 0; i < diagLiveOrder.length; i++) { id = diagLiveOrder[i]; if (!seen[id]) { seen[id] = 1; ids.push(id); } }
      var tally = {};
      console.log('[ai-cm-debug][O18][export] ==== EXPORT SNAPSHOT #' + diagExports + ' trigger=' + trigger +
        ' conv=' + (currentConvId || '').slice(0, 8) + ' liveTurns=' + diagLiveOrder.length +
        ' netTurns=' + (net ? net.order.length : 0) + ' netAgeMs=' + (net ? (Date.now() - net.t) : -1) +
        ' netReason=' + (net ? net.reason : '-') + ' ====');
      for (i = 0; i < ids.length; i++) {
        id = ids[i];
        var lv = diagLiveTurns[id] || null;
        var nv = (net && net.map[id]) || null;
        var cv = turnsMap[id] || null;
        var curText = (cv && typeof cv.text === 'string') ? cv.text : null;
        var vLN = diagVerdict(lv ? lv.lastText : null, nv ? nv.text : null);
        var vCN = diagVerdict(curText, nv ? nv.text : null);
        tally[vLN.verdict] = (tally[vLN.verdict] || 0) + 1;
        console.log('[ai-cm-debug][O18][turn] #' + i + ' role=' + ((lv && lv.role) || (nv && nv.role) || (cv && cv.role) || '-') +
          ' id=' + String(id).slice(0, 8) +
          ' live=' + diagStat(lv ? lv.lastText : null) +
          ' net=' + diagStat(nv ? nv.text : null) +
          ' cur=' + diagStat(curText) +
          ' live_vs_net[firstDiff=' + (vLN.firstDiff === null ? '-' : vLN.firstDiff) + ' verdict=' + vLN.verdict +
          ' lost=' + vLN.lost + ' resync=' + (vLN.resync === null ? '-' : vLN.resync) + ']' +
          ' cur_vs_net[firstDiff=' + (vCN.firstDiff === null ? '-' : vCN.firstDiff) + ' verdict=' + vCN.verdict +
          ' lost=' + vCN.lost + ' resync=' + (vCN.resync === null ? '-' : vCN.resync) + ']');
      }
      console.log('[ai-cm-debug][O18][summary] turns=' + ids.length + ' verdicts=' + JSON.stringify(tally) +
        ' ops=' + JSON.stringify(diagOps) + ' sseRing=' + diagSseRing.length + ' histRing=' + diagHistRing.length +
        ' marks=' + diagMarks.length + ' enrich=' + diagEnrich.length +
        ' resync=' + sseResyncCount + '/' + sseResyncBytes + 'b' +
        ' netSync=' + JSON.stringify(netSyncStats));
      // v12 (O-18, фаза 2): приёмка «типов вне белого списка в буфере нет» видна прямо здесь.
      var outside = [];
      for (i = 0; i < sseFragments.length; i++) {
        var ft = String((sseFragments[i] || {}).type || '');
        if (ft && !streamKnownType(ft)) outside.push(ft);
      }
      if (outside.length) console.warn('[ai-cm-debug][O18][WHITELIST] типы вне белого списка: ' + JSON.stringify(outside));
      else console.log('[ai-cm-debug][O18][WHITELIST] frags вне белого списка: нет (типы=' +
        sseFragmentTypes.join(',') + ')');
      diagDumpRings(trigger);
    } catch (e) { console.warn('[ai-cm-debug][O18] ошибка сравнения на экспорте:', e); }
  }
  // Смена чата: кольца и per-turn базы относятся к ОДНОМУ convId — начинаем заново.
  function diagResetForConv(reason, prevConv) {
    try {
      if (!diagOn()) return;
      console.log('[ai-cm-debug][O18][reset] reason=' + reason + ' prevConv=' + String(prevConv || '').slice(0, 8) +
        ' newConv=' + (currentConvId || '').slice(0, 8) + ' dropped: sse=' + diagSseRing.length +
        ' history=' + diagHistRing.length + ' marks=' + diagMarks.length + ' liveTurns=' + diagLiveOrder.length);
      diagSseRing = []; diagHistRing = []; diagMarks = [];
      diagLiveTurns = {}; diagLiveOrder = []; diagNetTurns = null; diagEnrich = [];
      diagOps = { APPEND: 0, SET: 0, other: 0 };
    } catch (e) { }
  }
  // Ручной дамп из консоли: window.__aiCmDebug.dumpDeepSeekO18('tag')
  try {
    if (!window.__aiCmDebug) window.__aiCmDebug = {};
    window.__aiCmDebug.dumpDeepSeekO18 = function (tag) {
      if (!isDebugEnabled()) {
        console.log('[ai-cm-debug][O18] флаг выключен: sessionStorage.aiCmDebug !== "1"');
        return null;
      }
      diagExportHook('manual:' + (tag || 'dump'));
      return {
        sse: diagSseRing.length, history: diagHistRing.length, marks: diagMarks.length,
        liveTurns: diagLiveOrder.length, netTurns: diagNetTurns ? diagNetTurns.order.length : 0
      };
    };
    // v12 (O-18, фаза 2): воспроизведение состояния буфера СТАРОЙ версии (мусорные «типы»,
    // в которые ушёл контент) — только под aiCmDebug=1. Нужно регресс-фикстурам: они
    // проверяют, что буфер лечится ресинком из сырого кольца, а не остаётся обрезанным.
    // При выключенном флаге функции нет — поведение страницы не меняется.
    window.__aiCmDebug.seedDeepSeekFragmentsO18 = function (frags) {
      if (!isDebugEnabled()) {
        console.log('[ai-cm-debug][O18] флаг выключен: sessionStorage.aiCmDebug !== "1"');
        return null;
      }
      var list = Array.isArray(frags) ? frags : [];
      sseFragments = [];
      sseFragmentTypes = [];
      for (var si = 0; si < list.length; si++) {
        var it = list[si] || {};
        sseFragments.push({ type: String(it.type || ''), content: String(it.content || '') });
        sseFragmentTypes.push(String(it.type || ''));
      }
      return { frags: sseFragments.length, types: sseFragmentTypes.join(',') };
    };
  } catch (e) { }

      // ---- экспорт: все 26 функций кластера (16 из них ядро зовёт форвардерами) ----
      Fn.isDebugEnabled = isDebugEnabled;
      Fn.getNavigationType = getNavigationType;
      Fn.determineState = determineState;
      Fn.normalizeRole = normalizeRole;
      Fn.buildMessagesFromRaw = buildMessagesFromRaw;
      Fn.buildMessagesFromTurnsMap = buildMessagesFromTurnsMap;
      Fn.collectUsageFieldsVerbatim = collectUsageFieldsVerbatim;
      Fn.fragContentLength = fragContentLength;
      Fn.dumpTurnUsageAtHistoryLoad = dumpTurnUsageAtHistoryLoad;
      Fn.dumpHistorySnapshot = dumpHistorySnapshot;
      Fn.diagOn = diagOn;
      Fn.diagHash6 = diagHash6;
      Fn.diagClip = diagClip;
      Fn.diagPushRing = diagPushRing;
      Fn.diagStat = diagStat;
      Fn.diagFirstDiff = diagFirstDiff;
      Fn.diagVerdict = diagVerdict;
      Fn.diagFragState = diagFragState;
      Fn.diagMark = diagMark;
      Fn.diagChunkRecord = diagChunkRecord;
      Fn.diagHistRecord = diagHistRecord;
      Fn.diagSnapshotNetTurns = diagSnapshotNetTurns;
      Fn.diagLiveTurnRecord = diagLiveTurnRecord;
      Fn.diagDumpRings = diagDumpRings;
      Fn.diagExportHook = diagExportHook;
      Fn.diagResetForConv = diagResetForConv;
    }
  }
  Fn.__bind = __bind;
  if (typeof window !== 'undefined') window.AiCmDeepseekDiag = Fn;
  if (typeof module !== 'undefined' && module.exports) module.exports = Fn;
}());
