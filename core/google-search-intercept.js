// core/google-search-intercept.js
// Перехватчик Google Search AI (udm=50) в MAIN world.
// Регистрируется через background.js.
//
// v6: поддержка folwr (полная история) + folif (realtime), модель из сети,
//     фолбэк вопросов из TgQPHd, полные ответы через compareDocumentPosition.
// v7: единый источник правды — window.parseGoogleFolwrOpen. detail.text и
//     detail.messages строятся из одних данных (parser.messages), поэтому таблицы
//     и подзаголовки попадают и в расчёт, и в экспорт одинаково.
// v8: кэш полных снимков по threadId (Map ≤ 10 записей) + опрос DOM раз в 1000мс.
//     При SPA-возврате на уже посещённый тред сайт отдаёт его из памяти без сетевого
//     folwr — перехватчик эмитит кэшированный снимок по threadId, а content.js
//     по смене threadId сначала сбрасывает состояние виджета.
// v1.27 (O-31): сетевая база СЕГМЕНТИРОВАНА по разговору (threadId). Смена треда
//     сбрасывает накопитель, ответ чужого треда не дописывается в активную базу
//     (см. activateThread/absorbForeignSnapshot).

(function () {
  if (window.__aiCmGoogleSearchInterceptInstalled) return;
  window.__aiCmGoogleSearchInterceptInstalled = true;

  // v31: флаг «Подробные логи» транслируется из content.js (ISOLATED) через CustomEvent
  try { window.addEventListener('ai-cm-debug-logs', function (ev) { __aiCmSetDebugLogs(!!(ev && ev.detail)); }); } catch (e) {}

  var MAX_CACHE_ENTRIES = 10;

  // ---- хранилище ----
  var seenKeys = {};
  var detectedModelSlug = null;
  var lastFullTurns = [];       // turns последнего активного снимка
  var lastFullMessages = [];    // messages последнего активного снимка
  var lastFullSnapshot = null;  // detail последнего активного снимка
  var currentThreadId = '';     // threadId активного треда (по DOM)
  var emittedThreadId = '';     // threadId, на котором зафиксирована база
  var baseThreadId = '';        // v1.27 (O-31): разговор, которому принадлежит активная база
  var lastFolwrOpenUrl = '';    // полный URL последнего GET /async/folwr (шаблон для активной загрузки)
  var activeFolwrBusy = false;  // защита от параллельной активной загрузки
  // v1.5.2: сериализация активных folwr и дедуп пассивных по ключу threadId|authuser.
  var activeFolwrInFlight = {}; // ключ -> true, пока активная загрузка этого threadId|authuser в полёте
  var lastPassiveFolwrTs = {};  // ключ -> ts последнего пассивного folwr (для защиты от гонки <3с)
  var lastFolwrSig = '';        // сигнатура последнего напечатанного folwr-open (антиспам)

  // v1.24: circuit-breaker антилимита Google (429 + редирект /sorry/index).
  // До sorryCooldownUntil собственные запросы расширения (досбор по курсору,
  // рефетч folwr) отключены; пассивный перехват и EMIT/DRAW работают как раньше.
  var SORRY_COOLDOWN_MS = 10 * 60 * 1000;
  var FOLWR_PAGE_DELAY_MS = 400; // вежливость досбора: пауза между страничными запросами
  var FOLWR_MAX_PAGES = 12;      // не более 12 страниц за одно открытие
  var sorryCooldownUntil = 0;    // timestamp, до которого свои запросы запрещены

  function ownRequestsAllowed() {
    return Date.now() > sorryCooldownUntil;
  }

  function triggerSorryCooldown() {
    var wasActive = Date.now() <= sorryCooldownUntil;
    sorryCooldownUntil = Date.now() + SORRY_COOLDOWN_MS;
    if (!wasActive) {
      console.log('[ai-cm-google-search] 429/sorry → cooldown 10min: свои запросы отключены');
    }
  }

  // Детект антилимита на любом перехваченном ответе: status 429 или итоговый URL /sorry/.
  function isSorryResponse(status, finalUrl) {
    try {
      if (status === 429) return true;
      return String(finalUrl || '').indexOf('/sorry/') !== -1;
    } catch (e) { return false; }
  }

  // кэш полных снимков по threadId (порядок вставки сохраняем для вытеснения)
  var threadCache = new Map(); // threadId -> { turns, messages, snapshot }

  function cacheSet(threadId, entry) {
    if (!threadId) return;
    if (threadCache.has(threadId)) {
      threadCache.delete(threadId);
    }
    threadCache.set(threadId, entry);
    // вытесняем старейшие сверх лимита
    while (threadCache.size > MAX_CACHE_ENTRIES) {
      var oldestKey = threadCache.keys().next().value;
      threadCache.delete(oldestKey);
    }
  }

  // ---- диагностика ----
  function isDiagTarget(rawUrl) {
    if (!rawUrl) return false;
    try {
      var u = new URL(rawUrl, location.href);
      var host = u.hostname.toLowerCase();
      if (host !== 'google.com' && host !== 'www.google.com') return false;
      var s = u.href;
      if (s.indexOf('.js') !== -1) return false;
      if (s.indexOf('.css') !== -1) return false;
      if (s.indexOf('.png') !== -1) return false;
      if (s.indexOf('.svg') !== -1) return false;
      if (s.indexOf('.woff') !== -1) return false;
      if (s.indexOf('gstatic') !== -1) return false;
      if (s.indexOf('googleapis') !== -1) return false;
      if (s.indexOf('_next/static') !== -1) return false;
      return true;
    } catch (e) { return false; }
  }

  function diagPreview(txt) {
    if (!txt) return '';
    if (txt.indexOf(")]}'") === 0) {
      var rest = txt.slice(4).replace(/^\s+/, '');
      var idx = -1;
      for (var i = 0; i < rest.length; i++) {
        if (rest[i] === '{' || rest[i] === '[') { idx = i; break; }
      }
      if (idx >= 0) rest = rest.slice(idx);
      return rest.slice(0, 300);
    }
    return txt.slice(0, 300);
  }

  // v1.17: короткое превью тела для строки лога (схлопываем переводы строк).
  function rawSnippet(txt, limit) {
    var n = (typeof limit === 'number' && limit > 0) ? limit : 120;
    if (!txt) return '';
    var s = String(txt).replace(/\s+/g, ' ').trim();
    return s.length > n ? (s.slice(0, n) + '…') : s;
  }

  // ---- O-27/O-32 (ДИАГНОСТИКА, только измерение): точки записи базы и сброса состояния ----
  // Гейт — aiCmDebug: sessionStorage 'aiCmDebug' === '1' или чекбокс «Подробные логи»
  // (utils/debug.js: aiCmDiagOn/aiCmDiagLine/aiCmDiagDocKind, тот же MAIN-мир).
  // Функции только ЧИТАЮТ turns/счётчики/threadId и печатают строку: база, эмит,
  // baseComplete и байты экспорта не меняются. В срез-песочницах тестов этих хелперов
  // нет — вызовы в пиннутых функциях защищены typeof-гардом.
  function gsaDiagTurnsShape(turns) {
    var n = 0, empty = 0, userLen = 0, asstLen = 0, maxLen = 0;
    try {
      n = (turns && turns.length) ? turns.length : 0;
      for (var i = 0; i < n; i++) {
        var t = turns[i] || {};
        var u = (t.userText == null) ? '' : String(t.userText).trim();
        var a = (t.assistantText == null) ? '' : String(t.assistantText).trim();
        if (!u && !a) empty++;
        userLen += u.length;
        asstLen += a.length;
        if (u.length > maxLen) maxLen = u.length;
        if (a.length > maxLen) maxLen = a.length;
      }
    } catch (eShape) { }
    return 'turns=' + n + ' empty=' + empty + ' userLen=' + userLen +
      ' asstLen=' + asstLen + ' maxLen=' + maxLen;
  }

  // Строка о попытке записи базы: путь (open/чанк/pagination/XHR/probe), форма хода,
  // результат валидации (isUsableTurn/hasUsableTurns), активный и DOM threadId.
  function gsaDiagBaseWrite(path, turns, verdict, tid, extra) {
    try {
      if (typeof aiCmDiagOn !== 'function' || !aiCmDiagOn()) return false;
      if (typeof aiCmDiagLine !== 'function') return false;
      var f = {
        path: path,
        verdict: verdict,
        tid: tid || '(пусто)',
        doc: (typeof aiCmDiagDocKind === 'function') ? aiCmDiagDocKind() : 'unknown',
        shape: gsaDiagTurnsShape(turns),
        activeTid: baseThreadId || '',
        domTid: readDomThreadId() || '',
        baseTurns: lastFullTurns.length
      };
      if (extra) {
        for (var k in extra) {
          if (Object.prototype.hasOwnProperty.call(extra, k)) f[k] = extra[k];
        }
      }
      return aiCmDiagLine('gsa-base-write', f);
    } catch (eDiagWrite) { return false; }
  }

  // Строка о сбросе/несбросе состояния: тип документа (captcha/чат/поиск) и причина.
  function gsaDiagState(point, verdict, reason, extra) {
    try {
      if (typeof aiCmDiagOn !== 'function' || !aiCmDiagOn()) return false;
      if (typeof aiCmDiagLine !== 'function') return false;
      var f = {
        point: point,
        verdict: verdict,
        reason: reason,
        doc: (typeof aiCmDiagDocKind === 'function') ? aiCmDiagDocKind() : 'unknown',
        activeTid: baseThreadId || '',
        domTid: readDomThreadId() || '',
        baseTurns: lastFullTurns.length
      };
      if (extra) {
        for (var k in extra) {
          if (Object.prototype.hasOwnProperty.call(extra, k)) f[k] = extra[k];
        }
      }
      return aiCmDiagLine('gsa-state', f);
    } catch (eDiagStateG) { return false; }
  }
  // Антиспам диагностических строк опроса DOM (checkThreadSwitch зовётся раз в 1с).
  var lastDiagSwitchSig = '';

  // v1.17: единая диагностика страницы ПРОДОЛЖЕНИЯ folwr. Классификация — по содержимому
  // (utils/google-search-folwr-parser.classifyFolwrContinuation), НЕ по длине тела.
  // Возврат: { cls, line } — line всегда печатается (status/ok/len/ходы/курсор + raw-превью),
  // полное raw-превью уходит в ring-буфер через debugLog у вызывающего кода.
  function describeFolwrPage(resp, txt, newTurns, cursor, sentCursor) {
    var body = (txt == null) ? '' : String(txt);
    var cls = null;
    try {
      if (window.GoogleFolwrUtils && window.GoogleFolwrUtils.classifyFolwrContinuation) {
        cls = window.GoogleFolwrUtils.classifyFolwrContinuation({
          ok: !!(resp && resp.ok),
          status: (resp && resp.status) || 0,
          bodyLength: body.length,
          newTurns: newTurns,
          cursor: cursor,
          sentCursor: sentCursor
        });
      }
    } catch (e) { }
    if (!cls) {
      cls = {
        kind: 'no-classifier', complete: false, canContinue: false,
        log: 'kind=no-classifier status=' + ((resp && resp.status) || 0) +
          ' ok=' + ((resp && resp.ok) ? 1 : 0) + ' len=' + body.length + 'B ходов=+' + (newTurns || 0)
      };
    }
    var line = cls.log + ' raw="' + rawSnippet(body, 120) + '"' +
      (resp && resp.url ? ' finalUrl="' + rawSnippet(resp.url, 160) + '"' : '');
    return { cls: cls, line: line };
  }

  // ---- модель из сетевого ответа ----
  function extractModel(htmlText) {
    try {
      var re = new RegExp('model:\\s*&' + 'quot;([A-Za-z0-9.\\-]+)&' + 'quot;', 'g');
      var match;
      var lastModel = null;
      while ((match = re.exec(htmlText)) !== null) {
        lastModel = match[1];
      }
      return lastModel;
    } catch (e) {
      return null;
    }
  }

  // ---- чтение threadId из DOM ----
  function readDomThreadId() {
    try {
      var el = document.querySelector('[data-session-thread-id]');
      if (el) {
        var v = el.getAttribute('data-session-thread-id');
        return v ? v.trim() : '';
      }
    } catch (e) { }
    return '';
  }

  // ---- O-27: валидация сетевого тела перед записью базы (защитный фикс по форме мусора) ----
  // Живой артефакт (GSA, captcha-страница): файл `f.txt` = `)]}'\n[""]\n` — XSSI-префикс
  // Google с ПУСТЫМ payload; парсер извлекает из такого тела 0 ходов. Живые логи (прогон
  // 18:47) доказывают, что на легитимном теле GSA гард не отклоняет НИ ОДНОГО хода ни на
  // одном пути (open / applyTurns / probe: shape=turns=5 empty=0, validation=hasUsableTurns=true),
  // поэтому критерий СУЖЕН до точной формы мусора и не зависит от типа документа/страницы:
  //   (1) ход пригоден, если в нём есть непустой текст (userText ИЛИ assistantText) —
  //       контейнер без содержимого (пустой payload, интерстишиал) ходом не считается;
  //   (2) форма мусора решается ТЕЛОМ (а не текстом отдельного хода): тело начинается
  //       четырёхсимвольным XSSI-префиксом `)]}'` И не распарсилось ни в один непустой ход.
  // Легитимный ответ, который сам начинается тем же префиксом, но содержит ходы, гардом НЕ
  // отклоняется: префикс и результат разбора решаются ВМЕСТЕ (isGarbageBody). Снимок без
  // ходов не строится вовсе — значит и baseComplete (buildDetail.historyComplete, по
  // умолчанию true) по мусору не взводится.
  //
  // Сравнение префикса — по кодам символов: исходник функции не должен содержать фигурной
  // скобки в литерале (source-пин-тесты режут функции по балансу скобок).
  function isRawXssiPayload(s) {
    if (!s || s.length < 4) return false;
    return s.charCodeAt(0) === 41 && s.charCodeAt(1) === 93 &&
      s.charCodeAt(2) === 125 && s.charCodeAt(3) === 39;
  }

  function isUsableTurn(t) {
    if (!t) return false;
    var u = (t.userText == null) ? '' : String(t.userText).trim();
    var a = (t.assistantText == null) ? '' : String(t.assistantText).trim();
    return !!(u || a);
  }

  function hasUsableTurns(turns) {
    if (!turns || !turns.length) return false;
    for (var i = 0; i < turns.length; i++) {
      if (isUsableTurn(turns[i])) return true;
    }
    return false;
  }

  // Точная форма мусора: тело с XSSI-префиксом и НУЛЁМ непустых ходов. bodyText — сырое
  // тело ответа; на путях без тела (DOM-добор, кэш, повторный эмит) он undefined → формы
  // мусора нет, поведение прежнее.
  function isGarbageBody(bodyText, turns) {
    if (!isRawXssiPayload(bodyText)) return false;
    return !hasUsableTurns(turns);
  }

  // ---- плоские messages из turns (fallback) ----
  function messagesFromTurns(turns) {
    var msgs = [];
    for (var i = 0; i < turns.length; i++) {
      var t = turns[i];
      if (t.userText) msgs.push({ role: 'user', text: t.userText });
      if (t.assistantText) msgs.push({ role: 'assistant', text: t.assistantText });
    }
    return msgs;
  }

  // ---- сборка detail снимка ----
  function buildDetail(turns, messages, threadId, historyComplete) {
    if (!messages) messages = messagesFromTurns(turns);
    var messageTexts = messages.map(function (m) { return m.text; });
    var messageIds = [];
    for (var i = 0; i < turns.length; i++) {
      var t = turns[i];
      if (t.userText) messageIds.push(t.id + '_user');
      if (t.assistantText) messageIds.push(t.id + '_assistant');
    }
    var text = messageTexts.join('\n');
    return {
      convId: '',
      threadId: threadId || '',
      text: text,
      count: messageTexts.length,
      effectiveLen: text.length,
      lastMessageText: messageTexts.length ? messageTexts[messageTexts.length - 1] : '',
      modelSlug: detectedModelSlug || '',
      messageTexts: messageTexts,
      messageIds: messageIds,
      messages: messages,
      attachTokens: 0,
      attachBreak: { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 },
      historyComplete: historyComplete !== false
    };
  }

  function emitDetail(detail) {
    try {
      window.dispatchEvent(new CustomEvent('ai-cm-full-history', { detail: detail }));
    } catch (e) { }
  }

  // ---- v1.27 (O-31): сегментация сетевой базы по разговору (threadId) ----
  // Живой дефект (GSA, прогон 2026-09-16 12:15): сетевой ответ СТАРОГО разговора,
  // пришедший после SPA-переключения, дописывался в базу НОВОГО — mergeTurns/applyTurns
  // брали currentThreadId||emittedThreadId, а threadId самого ответа не сверяли. Итог:
  // netMsgs рос 8→10→18→20 при domMsgs 8↔2, а файл экспорта B нёс хвост разговора A.
  // Теперь база принадлежит РОВНО одному разговору: активный сегмент — ходы своего
  // threadId; снимок чужого треда пишется ТОЛЬКО в свой сегмент (threadCache) и не
  // трогает lastFull*/seenKeys/baseText/pct/экспорт.
  function isForeignThread(tid) {
    if (!tid) return false; // тело без threadId — атрибуцию не выдумываем (прежнее поведение)
    var domTid = readDomThreadId();
    if (domTid) return tid !== domTid;       // живой DOM — источник правды о текущем разговоре
    if (currentThreadId) return tid !== currentThreadId;
    if (baseThreadId) return tid !== baseThreadId;
    return false;
  }

  function segmentTurnsOf(tid) {
    var seg = tid ? threadCache.get(tid) : null;
    return (seg && Array.isArray(seg.turns)) ? seg.turns : [];
  }

  // Активный разговор: база становится сегментом ровно этого threadId (или пустой, если
  // сегмента нет). Возврат true — активный разговор сменился (накопитель сброшен).
  function activateThread(tid) {
    tid = tid || '';
    if (tid === baseThreadId) return false;
    var prevBaseTid = baseThreadId;
    baseThreadId = tid;
    var seg = tid ? threadCache.get(tid) : null;
    lastFullTurns = (seg && Array.isArray(seg.turns)) ? seg.turns.slice() : [];
    lastFullMessages = (seg && Array.isArray(seg.messages)) ? seg.messages.slice() : [];
    lastFullSnapshot = (seg && seg.snapshot) ? seg.snapshot : null;
    seenKeys = {};
    for (var i = 0; i < lastFullTurns.length; i++) {
      seenKeys[(lastFullTurns[i].userText || '') + '||' + (lastFullTurns[i].assistantText || '')] = true;
    }
    emittedThreadId = lastFullSnapshot ? tid : '';
    // O-27/O-32 (диагностика): сброс накопителя при смене активного разговора + тип документа.
    if (typeof gsaDiagState === 'function') gsaDiagState('activateThread', 'reset', 'active-thread-switch', { from: prevBaseTid || '(пусто)', to: tid || '(пусто)', segTurns: lastFullTurns.length, emitted: emittedThreadId || '(пусто)' });
    debugLog('log', '[ai-cm-google-search] активный разговор → ' + (tid || '(пусто)') +
      ', ходов=' + lastFullTurns.length);
    return true;
  }

  // Снимок чужого разговора: пишем ТОЛЬКО в его сегмент (пригодится при возврате в тред),
  // активную базу/эмит/экспорт не трогаем. Возврат true — снимок поглощён (вызывающий выходит).
  function absorbForeignSnapshot(tid, turns, complete) {
    if (!isForeignThread(tid)) return false;
    if (turns && turns.length > 0) {
      var mergeFn = (window.GoogleFolwrUtils && window.GoogleFolwrUtils.mergeTurnsById) ||
        function (a, b) { return a.concat(b); };
      var segTurns = mergeFn(segmentTurnsOf(tid), turns);
      var segMsgs = messagesFromTurns(segTurns);
      cacheSet(tid, {
        turns: segTurns,
        messages: segMsgs,
        snapshot: buildDetail(segTurns, segMsgs, tid, complete === true)
      });
    }
    debugLog('log', '[ai-cm-google-search] снимок чужого разговора не применён: tid=' + tid +
      ', ходов=' + ((turns && turns.length) || 0) + ', активный=' + (baseThreadId || '(пусто)'));
    return true;
  }

  // ---- установка активной базы из готового снимка (для сетевого и кэш-эмита) ----
  function applySnapshot(parsed, threadId) {
    if (!parsed || !parsed.turns || parsed.turns.length === 0) return;
    lastFullTurns = parsed.turns.slice();
    lastFullMessages = Array.isArray(parsed.messages) ? parsed.messages.slice() : messagesFromTurns(lastFullTurns);
    seenKeys = {};
    for (var si = 0; si < lastFullTurns.length; si++) {
      var st = lastFullTurns[si];
      seenKeys[(st.userText || '') + '||' + (st.assistantText || '')] = true;
    }
    lastFullSnapshot = buildDetail(lastFullTurns, lastFullMessages, threadId);
    emittedThreadId = threadId || '';
    if (threadId) cacheSet(threadId, { turns: lastFullTurns, messages: lastFullMessages, snapshot: lastFullSnapshot });
  }

  // ---- слияние стрим-ходов с полной базой (без уменьшения) ----
  function mergeStreamTurns(streamTurns, threadId) {
    var merged = [];
    var seen = {};
    function addTurn(t) {
      var key = (t && t.userText ? t.userText : '') + '||' + (t && t.assistantText ? t.assistantText : '');
      if (key !== '||' && seen[key]) return;
      seen[key] = true;
      merged.push({ id: (t && t.id) || ('x' + merged.length), userText: t ? t.userText : null, assistantText: t ? t.assistantText : null });
    }
    for (var i = 0; i < lastFullTurns.length; i++) addTurn(lastFullTurns[i]);
    for (var j = 0; j < streamTurns.length; j++) addTurn(streamTurns[j]);
    lastFullTurns = merged;
    lastFullMessages = messagesFromTurns(lastFullTurns);
    lastFullSnapshot = buildDetail(lastFullTurns, lastFullMessages, threadId || currentThreadId || emittedThreadId);
    emittedThreadId = lastFullSnapshot.threadId || '';
    if (emittedThreadId) cacheSet(emittedThreadId, { turns: lastFullTurns, messages: lastFullMessages, snapshot: lastFullSnapshot });
    emitDetail(lastFullSnapshot);
  }

  // ---- слияние новых ходов ----
  // tidOfResponse — threadId из ТЕЛА ответа (parseWithParser), если он там есть.
  // bodyText — СЫРОЕ тело ответа (O-27): по нему решается, что тело — форма мусора.
  function mergeTurns(newTurns, isFull, tidOfResponse, bodyText) {
    // O-27 (защитный фикс): тело ТОЧНОЙ формы мусора (XSSI-префикс Google + 0 непустых
    // ходов) базой не является — ни запись, ни эмит, ни baseComplete. Причина видна в
    // диаг-строке (reason=xssi-prefix); живой путь — captcha-страница GSA (`f.txt`).
    if (isGarbageBody(bodyText, newTurns)) {
      if (typeof gsaDiagBaseWrite === 'function') gsaDiagBaseWrite('mergeTurns', newTurns, 'reject', tidOfResponse, { full: (isFull === true) ? 1 : 0, validation: 'hasUsableTurns=false', reason: 'xssi-prefix' });
      debugLog('log', '[ai-cm-google-search] O-27: форма мусора (XSSI-префикс без полезного payload) — база не тронута' +
        ' (merge, ходов=' + ((newTurns && newTurns.length) || 0) + ')');
      return;
    }
    // O-27: тело, не распарсившееся в ≥1 НЕПУСТОЙ ход, базой не является — ни запись,
    // ни эмит, ни baseComplete (снимок не строится вовсе).
    if (!hasUsableTurns(newTurns)) {
      if (typeof gsaDiagBaseWrite === 'function') gsaDiagBaseWrite('mergeTurns', newTurns, 'reject', tidOfResponse, { full: (isFull === true) ? 1 : 0, validation: 'hasUsableTurns=false' });
      debugLog('log', '[ai-cm-google-search] O-27: тело без непустых ходов — база не тронута' +
        ' (merge, ходов=' + ((newTurns && newTurns.length) || 0) + ')');
      return;
    }
    // v1.27 (O-31): разговор ответа — threadId тела, фолбэк — живой DOM. Ответ чужого
    // разговора не дописывается в активную базу (absorbForeignSnapshot).
    var threadId = tidOfResponse || readDomThreadId() || currentThreadId || emittedThreadId;
    if (absorbForeignSnapshot(threadId, newTurns, false)) {
      if (typeof gsaDiagBaseWrite === 'function') gsaDiagBaseWrite('mergeTurns', newTurns, 'foreign-not-applied', threadId, { full: (isFull === true) ? 1 : 0 });
      return;
    }
    activateThread(threadId);
    if (isFull) {
      if (lastFullTurns.length > 0 && newTurns.length < lastFullTurns.length) {
        mergeStreamTurns(newTurns, threadId);
        return;
      }
      lastFullTurns = newTurns.slice();
      seenKeys = {};
      for (var i = 0; i < newTurns.length; i++) {
        var t = newTurns[i];
        var key = (t.userText || '') + '||' + (t.assistantText || '');
        seenKeys[key] = true;
      }
    } else {
      for (var j = 0; j < newTurns.length; j++) {
        var nt = newTurns[j];
        var key2 = (nt.userText || '') + '||' + (nt.assistantText || '');
        if (!seenKeys[key2]) {
          seenKeys[key2] = true;
          lastFullTurns.push(nt);
        }
      }
    }
    lastFullMessages = messagesFromTurns(lastFullTurns);
    if (lastFullTurns.length > 0) {
      lastFullSnapshot = buildDetail(lastFullTurns, lastFullMessages, threadId);
      emittedThreadId = lastFullSnapshot.threadId || '';
      if (emittedThreadId) cacheSet(emittedThreadId, { turns: lastFullTurns, messages: lastFullMessages, snapshot: lastFullSnapshot });
      if (typeof gsaDiagBaseWrite === 'function') gsaDiagBaseWrite('mergeTurns', lastFullTurns, 'accept', threadId, { full: (isFull === true) ? 1 : 0, incoming: (newTurns && newTurns.length) || 0, emitted: emittedThreadId || '' });
      emitDetail(lastFullSnapshot);
    } else if (typeof gsaDiagBaseWrite === 'function') {
      gsaDiagBaseWrite('mergeTurns', newTurns, 'accept-empty-base', threadId, { full: (isFull === true) ? 1 : 0, incoming: (newTurns && newTurns.length) || 0 });
    }
  }

  // ---- парсинг через единый парсер ----
  function parseWithParser(htmlText) {
    try {
      if (window.parseGoogleFolwrOpen) {
        var p = window.parseGoogleFolwrOpen(htmlText);
        if (p && p.turns && p.turns.length > 0) {
          return p;
        }
      }
    } catch (e) { }
    var turns = parseTurns(htmlText);
    var messages = messagesFromTurns(turns);
    return {
      threadId: readDomThreadId(),
      turns: turns,
      messages: messages,
      text: messages.map(function (m) { return m.text; }).join('\n'),
      count: messages.length
    };
  }

  function parseTurns(htmlText) {
    var doc;
    try {
      doc = new DOMParser().parseFromString(htmlText, 'text/html');
    } catch (e) {
      return [];
    }
    var turns = doc.querySelectorAll('[data-scope-id="turn"]');
    var allAimfl = doc.querySelectorAll('[data-subtree="aimfl"]');
    var allN6 = doc.querySelectorAll('.n6owBd.awi2gc');

    var questions = [];
    for (var i = 0; i < turns.length; i++) {
      var h2 = turns[i].querySelector('h2.iMqumd');
      var questionText = null;
      if (h2) {
        var raw = h2.textContent.trim();
        var match = raw.match(/^Вы сказали:\s*"([\s\S]*)"$/);
        questionText = match ? match[1].trim() : raw;
      }
      questions.push(questionText);
    }

    var answers = [];
    for (var ti = 0; ti < turns.length; ti++) answers[ti] = [];
    var blocks = doc.querySelectorAll('.n6owBd.awi2gc');
    for (var b = 0; b < blocks.length; b++) {
      var block = blocks[b];
      var assignedIdx = -1;
      for (var ti2 = 0; ti2 < turns.length; ti2++) {
        if (turns[ti2].compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING) {
          assignedIdx = ti2;
        } else break;
      }
      if (assignedIdx >= 0 && assignedIdx < turns.length) {
        var cloneBlock = block.cloneNode(true);
        cloneBlock.querySelectorAll('script, style, button, svg').forEach(function (el) { el.remove(); });
        var blockText = cloneBlock.textContent.trim();
        if (blockText) answers[assignedIdx].push(blockText);
      }
    }

    var assistantTexts = [];
    for (var ti3 = 0; ti3 < turns.length; ti3++) {
      var joined = answers[ti3].length > 0 ? answers[ti3].join('\n\n') : null;
      if (!joined && allAimfl[ti3]) {
        var aimText = allAimfl[ti3].textContent.trim();
        if (aimText) joined = aimText;
      }
      assistantTexts.push(joined);
    }

    var result = [];
    var count = questions.length;
    for (var k = 0; k < count; k++) {
      result.push({
        id: (turns[k] && turns[k].getAttribute('jsuid')) || ('idx' + k),
        userText: questions[k] || null,
        assistantText: assistantTexts[k] || null
      });
    }

    // Фолбэк вопросов из TgQPHd
    var needTgBackfill = false;
    for (var bi = 0; bi < result.length; bi++) {
      if (!result[bi].userText) { needTgBackfill = true; break; }
    }
    if (needTgBackfill) {
      var commentQuestions = [];
      try {
        var tgReB = /<!--TgQPHd\|[\s\S]*?-->/g;
        var tgMatchB;
        while ((tgMatchB = tgReB.exec(htmlText)) !== null) {
          var commentB = tgMatchB[0];
          commentB = commentB.replace(new RegExp('&' + 'quot;', 'g'), '"');
          commentB = commentB.replace(new RegExp('&' + 'amp;', 'g'), '&');
          var longStrReB = /"([^"]{20,})"/g;
          var longMatchB, foundB = null;
          while ((longMatchB = longStrReB.exec(commentB)) !== null) {
            var candidateB = longMatchB[1];
            if (candidateB.indexOf('\\u0026') !== -1) continue;
            if (candidateB.indexOf('OLOoOd') !== -1) continue;
            if (candidateB.indexOf('dRog6c') !== -1) continue;
            if (candidateB.indexOf('TgQPHd') !== -1) continue;
            if (!/[а-яёА-ЯЁ]/.test(candidateB) && candidateB.indexOf(' ') === -1) continue;
            foundB = candidateB;
            break;
          }
          commentQuestions.push(foundB);
        }
      } catch (e) { }
      var cqi = 0;
      for (var bi2 = 0; bi2 < result.length; bi2++) {
        if (!result[bi2].userText && cqi < commentQuestions.length && commentQuestions[cqi]) {
          result[bi2].userText = commentQuestions[cqi];
          cqi++;
        }
      }
    }

    // Фолбэк folif
    if (result.length === 0) {
      try {
        var tgRe2 = /<!--TgQPHd\|[\s\S]*?-->/g;
        var tgMatch2;
        var folifQuestion = null;
        while ((tgMatch2 = tgRe2.exec(htmlText)) !== null) {
          var comment = tgMatch2[0];
          comment = comment.replace(new RegExp('&' + 'quot;', 'g'), '"');
          comment = comment.replace(new RegExp('&' + 'amp;', 'g'), '&');
          var longStrRe2 = /"([^"]{20,})"/g;
          var longMatch2;
          while ((longMatch2 = longStrRe2.exec(comment)) !== null) {
            var candidate = longMatch2[1];
            if (candidate.indexOf('\\u0026') !== -1) continue;
            if (candidate.indexOf('OLOoOd') !== -1) continue;
            if (candidate.indexOf('dRog6c') !== -1) continue;
            if (candidate.indexOf('TgQPHd') !== -1) continue;
            if (!/[а-яёА-ЯЁ]/.test(candidate) && candidate.indexOf(' ') === -1) continue;
            folifQuestion = candidate;
            break;
          }
        }
        var folifAnswer = null;
        if (allAimfl.length > 0) {
          for (var aa = 0; aa < allAimfl.length; aa++) {
            var atext = allAimfl[aa].textContent.trim();
            if (atext) { folifAnswer = atext; break; }
          }
        }
        if (!folifAnswer && allN6.length > 0) {
          for (var bb = 0; bb < allN6.length; bb++) {
            var clone2 = allN6[bb].cloneNode(true);
            clone2.querySelectorAll('script, style, button, svg').forEach(function (el) { el.remove(); });
            var ntext = clone2.textContent.trim();
            if (ntext) { folifAnswer = ntext; break; }
          }
        }
        if (folifQuestion || folifAnswer) {
          result.push({ id: 'folif_' + Date.now(), userText: folifQuestion, assistantText: folifAnswer });
        }
      } catch (e) { }
    }

    return result;
  }

  // ---- v1.5.2: ключ threadId|authuser, гонки и пагинация курсором ----

  // Изоляция по вкладке/authuser: authuser берём из URL folwr, фолбэк — из location.
  function authUserFromUrl(rawUrl) {
    try {
      var u = new URL(rawUrl, location.href);
      var a = u.searchParams.get('authuser');
      if (a != null && a !== '') return a;
    } catch (e) { }
    try {
      return new URL(location.href).searchParams.get('authuser') || '';
    } catch (e) { return ''; }
  }

  function threadAuthKey(threadId, rawUrl) {
    return (threadId || '') + '|' + authUserFromUrl(rawUrl);
  }

  // Подстановка курсора пагинации mstk в URL folwr.
  function urlWithMstk(rawUrl, cursor) {
    if (!cursor) return rawUrl;
    try {
      var u = new URL(rawUrl, location.href);
      u.searchParams.set('mstk', cursor);
      return u.href;
    } catch (e) { return rawUrl; }
  }

  // Применяет готовые turns к базе + эмит (единая точка для folwr-open и пагинации).
  // bodyText — СЫРОЕ тело ответа (O-27): по нему решается, что тело — форма мусора.
  function applyTurns(turns, tid, historyComplete, bodyText) {
    if (!turns || turns.length === 0) {
      if (typeof gsaDiagBaseWrite === 'function') gsaDiagBaseWrite('applyTurns', turns, 'reject-empty', tid, { complete: (historyComplete === true) ? 1 : 0 });
      return;
    }
    // O-27 (защитный фикс): та же точная форма мусора, что у mergeTurns — XSSI-префикс
    // Google без полезного payload. Такое тело базой не становится и baseComplete не
    // взводит: historyComplete=true здесь означал бы «история ПОЛНАЯ по сети».
    if (isGarbageBody(bodyText, turns)) {
      if (typeof gsaDiagBaseWrite === 'function') gsaDiagBaseWrite('applyTurns', turns, 'reject', tid, { complete: (historyComplete === true) ? 1 : 0, validation: 'hasUsableTurns=false', reason: 'xssi-prefix' });
      debugLog('log', '[ai-cm-google-search] O-27: форма мусора (XSSI-префикс без полезного payload) — база не тронута' +
        ' (apply, ходов=' + turns.length + ', complete=' + (historyComplete === true ? 1 : 0) + ')');
      return;
    }
    // O-27: контейнеры без содержимого (captcha / «подозрительный трафик» / пустой payload)
    // базой не становятся и baseComplete не взводят.
    if (!hasUsableTurns(turns)) {
      if (typeof gsaDiagBaseWrite === 'function') gsaDiagBaseWrite('applyTurns', turns, 'reject', tid, { complete: (historyComplete === true) ? 1 : 0, validation: 'hasUsableTurns=false' });
      debugLog('log', '[ai-cm-google-search] O-27: тело без непустых ходов — база не тронута' +
        ' (apply, ходов=' + turns.length + ', complete=' + (historyComplete === true ? 1 : 0) + ')');
      return;
    }
    // v1.27 (O-31): поздний ответ чужого разговора (probe/пагинация, стартовавшие до
    // SPA-переключения) в базу текущего не дописывается — только в свой сегмент.
    if (absorbForeignSnapshot(tid, turns, historyComplete)) {
      if (typeof gsaDiagBaseWrite === 'function') gsaDiagBaseWrite('applyTurns', turns, 'foreign-not-applied', tid, { complete: (historyComplete === true) ? 1 : 0 });
      return;
    }
    activateThread(tid);
    lastFullTurns = turns.slice();
    lastFullMessages = messagesFromTurns(lastFullTurns);
    seenKeys = {};
    for (var i = 0; i < lastFullTurns.length; i++) {
      var t = lastFullTurns[i];
      seenKeys[(t.userText || '') + '||' + (t.assistantText || '')] = true;
    }
    lastFullSnapshot = buildDetail(lastFullTurns, lastFullMessages, tid, historyComplete);
    emittedThreadId = tid || '';
    if (tid) cacheSet(tid, { turns: lastFullTurns, messages: lastFullMessages, snapshot: lastFullSnapshot });
    if (typeof gsaDiagBaseWrite === 'function') gsaDiagBaseWrite('applyTurns', lastFullTurns, 'accept', tid, { complete: (historyComplete === true) ? 1 : 0, emitted: emittedThreadId || '', baseComplete: (lastFullSnapshot && lastFullSnapshot.historyComplete === true) ? 1 : 0, validation: 'hasUsableTurns=true' });
    emitDetail(lastFullSnapshot);
  }

  // Пагинация folwr курсором при открытии: ≤12 страниц, merge по id ходов, лог досбор=N.
  // Первая страница уже применена вызывающим кодом (applyTurns); здесь догружаем хвост по cursor.
  function followFolwrPagination(startUrl, startTurns, tid, firstCursor) {
    if (!startUrl || !firstCursor) return;
    var key = threadAuthKey(tid, startUrl);
    var merged = Array.isArray(startTurns) ? startTurns.slice() : [];
    var mergeFn = (window.GoogleFolwrUtils && window.GoogleFolwrUtils.mergeTurnsById) ||
      function (a, b) { return a.concat(b); };
    var extractToken = (window.GoogleFolwrUtils && window.GoogleFolwrUtils.extractContinuationToken) ||
      function () { return null; };

    var added = 0;
    var pages = 0;

    function finish() {
      activeFolwrInFlight[key] = false;
      if (added > 0) {
        console.log('[ai-cm-google-search] пагинация folwr: досбор=' + added +
          ' ходов, страниц=' + pages + ', итого=' + lastFullTurns.length);
      } else {
        // v1.25: API-пагинация не добавила ходов → фолбэк Вариант Б.
        virtualScrollBackfill('pagination-empty');
      }
    }

    function step(nextCursor) {
      if (!nextCursor) { finish(); return; }
      // v1.24: circuit-breaker — во время cooldown свои запросы запрещены.
      if (!ownRequestsAllowed()) {
        console.log('[ai-cm-google-search] досбор пропущен: cooldown 429/sorry активен');
        activeFolwrInFlight[key] = false;
        return; // во время cooldown сетевой фолбэк невозможен
      }
      // v1.24: ≤12 страниц за одно открытие (первая уже применена вызывающим кодом).
      if (pages >= FOLWR_MAX_PAGES - 1) {
        if (added > 0) {
          console.log('[ai-cm-google-search] пагинация folwr: лимит страниц, досбор=' + added +
            ', итого=' + lastFullTurns.length);
        }
        activeFolwrInFlight[key] = false;
        return;
      }
      if (activeFolwrInFlight[key]) return; // не слать параллельно тот же тред
      activeFolwrInFlight[key] = true;
      pages++;
      window.fetch(urlWithMstk(startUrl, nextCursor), { credentials: 'include' })
        .then(function (resp) {
          // v1.24: 429//sorry/ → cooldown и немедленный выход из цикла, БЕЗ ретраев.
          if (isSorryResponse(resp && resp.status, resp && resp.url)) {
            triggerSorryCooldown();
            activeFolwrInFlight[key] = false;
            return null;
          }
          if (!resp) return { resp: null, txt: '' };
          // v1.17: тело читаем ВСЕГДА (в т.ч. при не-ok и на коротком ответе) — иначе
          // «пустая страница» неотличима от ошибки, а фолбэк Вариант Б не запускается.
          return resp.text().then(function (t) {
            return { resp: resp, txt: t || '' };
          }, function () { return { resp: resp, txt: '' }; });
        })
        .then(function (page) {
          activeFolwrInFlight[key] = false;
          if (!page) return; // 429//sorry/ → cooldown, цикл уже остановлен
          var txt = page.txt;
          var parsed = parseWithParser(txt);
          var before = merged.length;
          merged = mergeFn(merged, parsed.turns);
          var gained = merged.length - before;
          added += gained;
          var cursor = extractToken(txt);
          var pageInfo = describeFolwrPage(page.resp, txt, gained, cursor, nextCursor);
          console.log('[ai-cm-google-search] пагинация folwr шаг ' + pages + ': ' + pageInfo.line);
          debugLog('log', '[ai-cm-google-search] пагинация folwr шаг ' + pages +
            ' raw(' + txt.length + 'B): ' + diagPreview(txt));
          if (gained > 0) {
            if (typeof gsaDiagBaseWrite === 'function') gsaDiagBaseWrite('pagination', merged, 'submit', tid, { page: pages, gained: gained, kind: pageInfo.cls.kind, cursor: (cursor ? cursor.slice(0, 12) : 'нет') });
            applyTurns(merged, tid, false, txt);
          } else if (typeof gsaDiagBaseWrite === 'function') {
            gsaDiagBaseWrite('pagination', parsed.turns, 'skip-no-gain', tid, { page: pages, gained: 0, kind: pageInfo.cls.kind, cursor: (cursor ? cursor.slice(0, 12) : 'нет') });
          }
          // v1.17: продолжаем, только если страница дала НОВЫЕ ходы и НОВЫЙ курсор.
          if (pageInfo.cls.canContinue) {
            setTimeout(function () { step(cursor); }, FOLWR_PAGE_DELAY_MS);
          } else {
            finish();
          }
        })
        .catch(function () { activeFolwrInFlight[key] = false; finish(); });
    }

    step(firstCursor);
  }

  // v1.25: Вариант Б — фолбэк «невидимого виртуального скролла». Если API-пагинация
  // не дала результата (курсор не извлечён / пустые страницы), прокручиваем
  // scrollable-контейнер чата к началу (scrollTop = 0), пока растёт scrollHeight.
  // Контейнер на время скролла делается прозрачным (opacity: 0). Новые ходы
  // мержатся в базу по ключу (дедуп), эмит после каждого пополнения.
  var VS_MAX_ITERATIONS = 20;
  var VS_STEP_WAIT_MS = 800;
  var VS_STALL_LIMIT = 3; // итераций без роста scrollHeight = конец истории

  function findChatScroller() {
    try {
      var turns = document.querySelectorAll('[data-scope-id="turn"]');
      var anchor = turns.length ? turns[0] : document.querySelector('[data-session-thread-id]');
      var el = anchor;
      while (el && el !== document.body) {
        if (el.scrollHeight > el.clientHeight + 50) return el;
        el = el.parentElement;
      }
    } catch (e) { }
    return null;
  }

  function virtualScrollBackfill(reason) {
    if (!ownRequestsAllowed()) {
      console.log('[ai-cm-google-search] виртуальный скролл пропущен: cooldown (' + reason + ')');
      return;
    }
    var scroller = findChatScroller();
    if (!scroller) {
      console.log('[ai-cm-google-search] виртуальный скролл: контейнер не найден (' + reason + ')');
      return;
    }
    var tid = currentThreadId || emittedThreadId || readDomThreadId();
    var iterations = 0;
    var stalls = 0;
    var lastScrollHeight = scroller.scrollHeight;
    var prevOpacity = scroller.style.opacity;
    var prevScrollTop = scroller.scrollTop;
    scroller.style.opacity = '0';
    console.log('[ai-cm-google-search] виртуальный скролл запущен (' + reason + ')');

    function restore() {
      scroller.style.opacity = prevOpacity;
      scroller.scrollTop = prevScrollTop;
    }

    function tick() {
      if (iterations >= VS_MAX_ITERATIONS) {
        restore();
        console.log('[ai-cm-google-search] виртуальный скролл: лимит итераций, итого=' + lastFullTurns.length);
        return;
      }
      iterations++;
      scroller.scrollTop = 0; // сайт подгружает старые сообщения при подходе к верху
      setTimeout(function () {
        try {
          var h = scroller.scrollHeight;
          if (window.GoogleFolwrUtils && window.GoogleFolwrUtils.extractTurnsFromDocument) {
            var domTurns = window.GoogleFolwrUtils.extractTurnsFromDocument(document);
            if (domTurns.length > lastFullTurns.length) {
              var mergeFn = window.GoogleFolwrUtils.mergeTurnsByKey || function (a, b) { return a.concat(b); };
              if (typeof gsaDiagBaseWrite === 'function') gsaDiagBaseWrite('scroll-backfill', domTurns, 'submit', tid, { iterations: iterations, stalls: stalls, domTurns: domTurns.length, baseTurns: lastFullTurns.length });
              applyTurns(mergeFn(lastFullTurns, domTurns), tid, false);
              stalls = 0;
            } else {
              stalls++;
            }
          } else {
            stalls++;
          }
          if (h === lastScrollHeight && stalls >= VS_STALL_LIMIT) {
            restore();
            console.log('[ai-cm-google-search] виртуальный скролл завершён: итого=' + lastFullTurns.length + ' ходов');
            return;
          }
          if (h !== lastScrollHeight) stalls = 0;
          lastScrollHeight = h;
          tick();
        } catch (e) { restore(); }
      }, VS_STEP_WAIT_MS);
    }
    tick();
  }

  // v1.26: probe-полнота. Если распарсено == DOM-контейнеров и курсор есть — тихий
  // probe-шаг пагинации с курсором (без скролла, по аналогии с тихим циклом Gemini).
  // v1.17: полнота решается по СОДЕРЖИМОМУ страницы (describeFolwrPage), а не по её длине:
  // новых ходов нет / тот же курсор / пустое тело при ok → ПОЛНАЯ=true и baseComplete=true
  // (итог виден в обычной строке folwr-open, которая печатается всегда); +ходов>0 и новый
  // курсор → продолжать тихий цикл (кап 10 шагов). Детальные логи probe — под debugLog.
  var FOLWR_PROBE_MAX_STEPS = 10;
  var probedTids = {}; // v43: гард «один probe на threadId» (handshake-реэмит / собственный probe-запрос не перезапускают probe)

  // v1.18 (F5): состояние probe-полноты наружу (MAIN → ISOLATED через CustomEvent, как
  // у ai-cm-full-history). Нужен ровно для ярлыка причины skip автоэкспорта: пока probe
  // в полёте, у GSA нет вердикта полноты → 'probe-running', а не общий 'not-complete'.
  // Сам вердикт полноты по-прежнему один — historyComplete снимка.
  function emitProbeState(running, tid) {
    try {
      window.dispatchEvent(new CustomEvent('ai-cm-gsa-probe-state', {
        detail: { running: running === true, threadId: tid || '' }
      }));
    } catch (e) { }
  }

  function probeFolwrCompleteness(startUrl, startTurns, tid, firstCursor) {
    if (probedTids[tid]) {
      debugLog('log', '[ai-cm-google-search] probe пропущен: уже выполнялся для threadId=' + tid);
      return;
    }
    probedTids[tid] = true;
    console.log('[ai-cm-google-search] probe запущен: threadId=' + tid);
    emitProbeState(true, tid); // v1.18: probe в полёте — content.js отличает probe-running от not-complete
    var key = threadAuthKey(tid, startUrl);
    var merged = Array.isArray(startTurns) ? startTurns.slice() : [];
    var mergeFn = (window.GoogleFolwrUtils && window.GoogleFolwrUtils.mergeTurnsById) ||
      function (a, b) { return a.concat(b); };
    var extractToken = (window.GoogleFolwrUtils && window.GoogleFolwrUtils.extractContinuationToken) ||
      function () { return null; };
    var steps = 0;
    var addedTotal = 0;
    var done = false;
    // O-27 (защитный фикс): тело последнего шага probe — для проверки формы мусора на
    // финальном applyTurns (в probe этот путь всегда завершает базу вердиктом ПОЛНАЯ).
    var lastBody = '';

    // v43: итоговая строка folwr-open печатается на ВСЕХ выходах.
    // complete=true → applyTurns(..., true) (baseComplete=true); иначе база не трогается.
    function finish(reason, complete) {
      if (done) return;
      done = true;
      activeFolwrInFlight[key] = false;
      if (complete) {
        if (typeof gsaDiagBaseWrite === 'function') gsaDiagBaseWrite('probe', merged, 'submit-final', tid, { complete: 1, addedTotal: addedTotal, steps: steps, reason: reason });
        applyTurns(merged.length > 0 ? merged : lastFullTurns, tid, true, lastBody);
      } else if (typeof gsaDiagBaseWrite === 'function') {
        gsaDiagBaseWrite('probe', merged, 'skip-incomplete', tid, { complete: 0, addedTotal: addedTotal, steps: steps, reason: reason });
      }
      // v1.18 (F1): вердикт probe-классификатора уходит в content.js ОДНОЙ точкой —
      // applyTurns(..., true) → buildDetail(historyComplete=true) → событие
      // ai-cm-full-history → content.js baseComplete=1 (гейт shouldSkipAutoExport).
      // Отдельного дублирующего вердикта у content.js нет.
      emitProbeState(false, tid);
      console.log('[ai-cm-google-search] folwr-open: ходов=' + lastFullTurns.length +
        ', DOM-контейнеров=' + document.querySelectorAll('[data-scope-id="turn"]').length +
        ', probe +ходов=' + addedTotal +
        ', шагов=' + steps +
        ', ПОЛНАЯ=' + !!complete +
        ', threadId=' + tid);
      debugLog('log', '[ai-cm-google-search] probe завершён: reason=' + reason);
    }

    function step(cursor) {
      if (!cursor) { finish('курсор исчерпан', true); return; }
      if (steps >= FOLWR_PROBE_MAX_STEPS) { finish('лимит шагов', true); return; }
      // v1.24: circuit-breaker — во время cooldown свои запросы запрещены.
      if (!ownRequestsAllowed()) {
        debugLog('log', '[ai-cm-google-search] probe прерван: cooldown 429/sorry');
        finish('cooldown-429-sorry', false);
        return;
      }
      if (activeFolwrInFlight[key]) return; // не слать параллельно тот же тред
      activeFolwrInFlight[key] = true;
      steps++;
      var pageUrl = urlWithMstk(startUrl, cursor);
      window.fetch(pageUrl, { credentials: 'include' })
        .then(function (resp) {
          if (isSorryResponse(resp && resp.status, resp && resp.url)) {
            triggerSorryCooldown();
            activeFolwrInFlight[key] = false;
            finish('429/sorry', false);
            return null;
          }
          if (!resp) return { resp: null, txt: '' };
          // v1.17: тело читаем ВСЕГДА — и при не-ok, и на коротком ответе. Прежний гейт
          // `txt.length <= 100000` объявлял короткую страницу «пустой» до разбора.
          return resp.text().then(function (t) {
            return { resp: resp, txt: t || '' };
          }, function () { return { resp: resp, txt: '' }; });
        })
        .then(function (page) {
          if (!page) return; // 429//sorry/ → cooldown, probe уже завершён
          activeFolwrInFlight[key] = false;
          var txt = page.txt;
          lastBody = txt; // O-27: тело шага probe — вход проверки формы мусора
          var parsed = parseWithParser(txt);
          var before = merged.length;
          merged = mergeFn(merged, parsed.turns);
          var added = merged.length - before;
          addedTotal += added;
          var next = extractToken(txt);
          var pageInfo = describeFolwrPage(page.resp, txt, added, next, cursor);
          // v1.17: детальный лог ответа страницы продолжения: статус, ok, длина, разбор,
          // число новых ходов, курсор (новый/повтор) и raw-превью тела + finalUrl.
          console.log('[ai-cm-google-search] probe шаг ' + steps + ': ' + pageInfo.line);
          debugLog('log', '[ai-cm-google-search] probe шаг ' + steps + ': +ходов=' + added +
            ' всего=' + merged.length + ' raw(' + txt.length + 'B): ' + diagPreview(txt));
          if (added > 0) {
            if (typeof gsaDiagBaseWrite === 'function') gsaDiagBaseWrite('probe', merged, 'submit', tid, { step: steps, added: added, kind: pageInfo.cls.kind, cursor: (next ? next.slice(0, 12) : 'нет') });
            applyTurns(merged, tid, false, txt);
          } else if (typeof gsaDiagBaseWrite === 'function') {
            gsaDiagBaseWrite('probe', parsed.turns, 'skip-no-gain', tid, { step: steps, added: 0, kind: pageInfo.cls.kind, cursor: (next ? next.slice(0, 12) : 'нет') });
          }
          // v1.17: полнота по содержимому. Нет новых ходов / тот же курсор / пустое тело при
          // ok → истории больше нет → ПОЛНАЯ=true. Продолжаем только при новых ходах и НОВОМ курсоре.
          if (pageInfo.cls.complete) { finish('probe-' + pageInfo.cls.kind, true); return; }
          if (!pageInfo.cls.canContinue) { finish('probe-' + pageInfo.cls.kind, false); return; }
          setTimeout(function () { step(next); }, FOLWR_PAGE_DELAY_MS);
        })
        .catch(function () { activeFolwrInFlight[key] = false; finish('ошибка сети', false); });
    }

    step(firstCursor);
  }

  // Активная загрузка истории: пассивный folwr при открытии старого чата в Network не
  // ловится (фильтр пуст) — расширение пере-запрашивает последний зафиксированный шаблон
  // GET /async/folwr. Ответ обработается тем же перехваченным обработчиком folwr-open.
  function activeLoadFolwr(reason) {
    if (!lastFolwrOpenUrl) return;
    // v1.24: circuit-breaker — рефетч истории запрещён во время cooldown 429/sorry.
    if (!ownRequestsAllowed()) {
      console.log('[ai-cm-google-search] активная загрузка пропущена: cooldown 429/sorry (' + reason + ')');
      return;
    }
    var tid = readDomThreadId() || currentThreadId || emittedThreadId;
    var key = threadAuthKey(tid, lastFolwrOpenUrl);
    // сериализация активных folwr по threadId|authuser: не слать параллельно тот же тред.
    if (activeFolwrInFlight[key]) return;
    // гонка: если пассивный folwr того же threadId|authuser пришёл <3с назад — не дёргаем активный.
    if (Date.now() - (lastPassiveFolwrTs[key] || 0) < 3000) {
      console.log('[ai-cm-google-search] активная загрузка пропущена: пассивный folwr <3с (' + reason + ')');
      return;
    }
    activeFolwrInFlight[key] = true;
    console.log('[ai-cm-google-search] активная загрузка истории по шаблону folwr (' + reason + ')');
    try {
      window.fetch(lastFolwrOpenUrl, { credentials: 'include' })
        .catch(function () { })
        .then(function () { activeFolwrInFlight[key] = false; });
    } catch (e) { activeFolwrInFlight[key] = false; }
  }

  // ---- применение кэша при смене threadId (SPA-возврат без сети) ----
  function checkThreadSwitch() {
    var tid = readDomThreadId();
    if (!tid) {
      // O-27/O-32 (диагностика): несброс — в DOM нет threadId (сервисная страница/поиск).
      // Антиспам: опрос идёт раз в 1с, строка печатается только на смену сигнатуры.
      var sigNoDom = 'no-thread-dom|' + (baseThreadId || '');
      if (typeof lastDiagSwitchSig === 'string' && sigNoDom !== lastDiagSwitchSig) {
        lastDiagSwitchSig = sigNoDom;
        if (typeof gsaDiagState === 'function') gsaDiagState('checkThreadSwitch', 'no-reset', 'no-thread-dom', {});
      }
      return;
    }
    // v1.27 (O-31): «без смены» — только когда и активный тред, и принадлежность базы
    // совпадают с DOM. Иначе (база осталась у другого разговора) — ре-синхронизация.
    if (tid === currentThreadId && tid === baseThreadId) {
      var sigSame = 'same|' + tid;
      if (typeof lastDiagSwitchSig === 'string' && sigSame !== lastDiagSwitchSig) {
        lastDiagSwitchSig = sigSame;
        if (typeof gsaDiagState === 'function') gsaDiagState('checkThreadSwitch', 'no-reset', 'same-thread', { from: tid, to: tid });
      }
      return false;
    }
    // threadId сменился
    var prevSwitchTid = currentThreadId || '';
    currentThreadId = tid;
    probedTids = {}; // v43: сброс гарда «один probe на threadId» при смене треда
    // O-27/O-32 (диагностика): причина сброса — смена threadId в DOM; cache — был ли сегмент.
    if (typeof gsaDiagState === 'function') gsaDiagState('checkThreadSwitch', 'switching', 'thread-id-switch', { from: prevSwitchTid || '(пусто)', to: tid, cache: threadCache.has(tid) ? 1 : 0 });
    // v1.27 (O-31): смена разговора → активная база переключается на сегмент нового
    // threadId (или сбрасывается, если сегмента нет). Ходы прежнего разговора в новый
    // не переносятся и в экспорт/pct не попадают.
    activateThread(tid);
    var cached = threadCache.get(tid);
    if (cached && cached.snapshot) {
      lastFullTurns = (cached.turns || []).slice();
      lastFullMessages = (cached.messages || []).slice();
      lastFullSnapshot = cached.snapshot;
      emittedThreadId = tid;
      console.log('[ai-cm-google-search] threadId сменился → эмит кэша (' + tid + ')');
      emitDetail(lastFullSnapshot);
    } else {
      // нет кэша — сбрасываем базу и пытаемся активно догрузить историю
      lastFullTurns = [];
      lastFullMessages = [];
      lastFullSnapshot = null;
      seenKeys = {};
      emittedThreadId = '';
      console.log('[ai-cm-google-search] threadId сменился → кэша нет (' + tid + ')');
      activeLoadFolwr('thread-switch:' + tid);
    }
    return true;
  }

  // ---- инициализация/опрос threadId ----
  currentThreadId = readDomThreadId();
  baseThreadId = currentThreadId; // v1.27 (O-31): база с самого старта привязана к разговору страницы
  // v1.13.1 (R2): guard-поллинг через aiCmCommon.setIntervalVisible — skip при
  // скрытой вкладке; фолбэк на plain setInterval, если window.aiCmCommon недоступен.
  var aiCmPoll = (typeof window !== 'undefined' && window.aiCmCommon && window.aiCmCommon.setIntervalVisible)
    ? function (f, m) { return window.aiCmCommon.setIntervalVisible(f, m); }
    : setInterval;
  aiCmPoll(function () {
    checkThreadSwitch();
  }, 1000);

  // ---- 1. Перехват window.fetch ----
  var origFetch = window.fetch;

  window.fetch = function (input, init) {
    var url = '';
    try { url = (typeof input === 'string') ? input : (input && input.url) || ''; } catch (e) { }
    var method = '';
    try { method = (init && init.method) ? String(init.method).toUpperCase() : 'GET'; } catch (e) { }

    var isFolwr = url.indexOf('/folwr') !== -1;
    var isFolif = url.indexOf('/folif') !== -1;
    var isOpenFolwr = url.indexOf('/async/folwr') !== -1;

    var promise;
    try { promise = origFetch.apply(this, arguments); } catch (e) { return Promise.reject(e); }

    // v1.24: детект антилимита на ЛЮБОМ перехваченном ответе (страницы или нашем):
    // status 429 или итоговый URL содержит /sorry/ → cooldown собственных запросов.
    try {
      promise.then(function (resp) {
        try {
          if (isSorryResponse(resp && resp.status, resp && resp.url)) triggerSorryCooldown();
        } catch (e) { }
      }, function () { });
    } catch (e) { }

    if ((isFolwr || isFolif) && !isOpenFolwr) {
      var isFull = isFolwr;
      promise.then(function (resp) {
        try {
          if (resp && resp.ok) {
            // v1.5.2: фиксируем время пассивного folwr/folif (ключ threadId|authuser),
            // чтобы активная загрузка не дёргалась сразу после него (<3с).
            lastPassiveFolwrTs[threadAuthKey(currentThreadId || emittedThreadId, url)] = Date.now();
            resp.clone().text().then(function (txt) {
              var model = extractModel(txt);
              if (model) detectedModelSlug = model;
              var parsed = parseWithParser(txt);
              if (parsed.turns.length > 0) {
                // O-27/O-32 (диагностика): путь записи — пассивный folwr (полный) / folif (чанк).
                if (typeof gsaDiagBaseWrite === 'function') gsaDiagBaseWrite(isFull ? 'passive-folwr' : 'passive-folif', parsed.turns, 'submit', parsed.threadId, { url: rawSnippet(url, 80), bodyLen: (txt ? txt.length : 0) });
                mergeTurns(parsed.turns, isFull, parsed.threadId, txt);
              } else if (typeof gsaDiagBaseWrite === 'function') {
                gsaDiagBaseWrite(isFull ? 'passive-folwr' : 'passive-folif', parsed.turns, 'skip-no-turns', parsed.threadId, { url: rawSnippet(url, 80), bodyLen: (txt ? txt.length : 0) });
              }
            }).catch(function () { });
          }
        } catch (e) { }
        return resp;
      }, function () { });
    }

    // GET /async/folwr — полная история
    if (isOpenFolwr && method !== 'POST') {
      try { lastFolwrOpenUrl = url; } catch (e) { }
      promise.then(function (resp) {
        if (resp && resp.ok) {
          resp.clone().text().then(function (txt) {
            // v1.17: гейт по длине (было `txt.length > 100000`) убран — короткий ответ folwr
            // тоже разбирается, иначе «пустая страница» неотличима от «ходов нет».
            if (txt) {
              var model = extractModel(txt);
              if (model) detectedModelSlug = model;
              try {
                var parsed = parseWithParser(txt);
                var tid = parsed.threadId || readDomThreadId();
                // v1.27 (O-31): чужой ответ не подменяет активный разговор даже своим tid
                if (tid && !isForeignThread(tid)) currentThreadId = tid;
                if (parsed && parsed.turns && parsed.turns.length > 0) {
                  // v1.5.2: полнота folwr vs DOM. Сравниваем счётчик turn-контейнеров
                  // снимка folwr с числом turn-контейнеров в живом DOM. Если DOM больше —
                  // folwr обрезан → досбор: merge хвоста/головы из DOM. Критерий «ПОЛНАЯ» —
                  // только при совпадении счётчиков.
                  var folwrTurnCount = 0;
                  if (window.GoogleFolwrUtils && window.GoogleFolwrUtils.countTurnContainers) {
                    folwrTurnCount = window.GoogleFolwrUtils.countTurnContainers(txt);
                  }
                  var domTurnCount = 0;
                  try { domTurnCount = document.querySelectorAll('[data-scope-id="turn"]').length; } catch (e) { }
                  var domTurns = [];
                  if (window.GoogleFolwrUtils && window.GoogleFolwrUtils.extractTurnsFromDocument) {
                    domTurns = window.GoogleFolwrUtils.extractTurnsFromDocument(document);
                  }
                  var baseTurns = parsed.turns;
                  var mergedTurns = baseTurns;
                  var dopasbor = 0;
                  if (domTurnCount > folwrTurnCount && domTurns.length > 0) {
                    var mergeFn = (window.GoogleFolwrUtils && window.GoogleFolwrUtils.mergeTurnsByKey) || function (a, b) { return a.concat(b); };
                    mergedTurns = mergeFn(baseTurns, domTurns);
                    dopasbor = mergedTurns.length - baseTurns.length;
                  }
                  // v1.5.2+ «ПОЛНАЯ» только при «курсора нет И folwr>=DOM».
                  // Курсор — скрытый div data-mstk (старый формат) / srtst-подобный токен.
                  var folwrCursor = null;
                  if (window.GoogleFolwrUtils && window.GoogleFolwrUtils.extractContinuationToken) {
                    folwrCursor = window.GoogleFolwrUtils.extractContinuationToken(txt);
                  }
                  var historyComplete = (!folwrCursor) && (domTurnCount <= folwrTurnCount);

                  // v1.5.2: guard от сжатия базы — floor по threadId, union вместо замены.
                  // Повторный folwr-open того же threadId не должен уменьшать уже
                  // накопленную базу (например, урезанный ответ активной загрузки).
                  if (emittedThreadId === tid && lastFullTurns.length > mergedTurns.length) {
                    var unionFn = (window.GoogleFolwrUtils && window.GoogleFolwrUtils.mergeTurnsById) ||
                      function (a, b) { return a.concat(b); };
                    mergedTurns = unionFn(lastFullTurns, mergedTurns);
                    console.log('[ai-cm-google-search] база сжата — сохранён максимум (' +
                      mergedTurns.length + ' ходов)');
                  }

                  // O-27/O-32 (диагностика): путь записи — folwr-open (GET /async/folwr):
                  // распарсено, контейнеры folwr/DOM, досбор, курсор, вердикт ПОЛНАЯ.
                  if (typeof gsaDiagBaseWrite === 'function') gsaDiagBaseWrite('open', mergedTurns, 'submit', tid, { parsed: baseTurns.length, folwrContainers: folwrTurnCount, domContainers: domTurnCount, dopasbor: dopasbor, complete: historyComplete ? 1 : 0, cursor: (folwrCursor ? folwrCursor.slice(0, 12) : 'нет'), bodyLen: (txt ? txt.length : 0) });
                  applyTurns(mergedTurns, tid, historyComplete, txt);

                  // v1.5.2: антиспам — печатаем folwr-open только при изменении сигнатуры.
                  var sig = [baseTurns.length, folwrTurnCount, domTurnCount, dopasbor,
                  lastFullTurns.length, (folwrCursor ? folwrCursor.slice(0, 12) : 'нет'),
                    historyComplete, tid].join('|');
                  if (sig !== lastFolwrSig) {
                    lastFolwrSig = sig;
                    console.log('[ai-cm-google-search] folwr-open: распарсено=' + baseTurns.length +
                      ', folwr-контейнеров=' + folwrTurnCount +
                      ', DOM-контейнеров=' + domTurnCount +
                      ', досбор=' + dopasbor +
                      ', видимых ходов=' + lastFullTurns.length +
                      ', курсор=' + (folwrCursor ? folwrCursor.slice(0, 12) : 'нет') +
                      ', ПОЛНАЯ=' + historyComplete +
                      ', threadId=' + tid);
                  }

                  // v1.26: если распарсено == DOM-контейнеров и курсор есть — тихий probe
                  // полноты (без скролла). Иначе — прежняя пагинация курсором.
                  if (folwrCursor) {
                    if (baseTurns.length === domTurnCount) {
                      probeFolwrCompleteness(url, mergedTurns, tid, folwrCursor);
                    } else {
                      followFolwrPagination(url, mergedTurns, tid, folwrCursor);
                    }
                  }
                } else {
                  // v1.17: страница без ходов — печатаем фактическое содержимое (статус, длина,
                  // курсор, raw-превью), чтобы отличать «истории нет» от ошибки/смены формата.
                  var openPageInfo = describeFolwrPage(resp, txt, 0, null, null);
                  console.log('[ai-cm-google-search] folwr-open: ходов не распарсено, ' + openPageInfo.line);
                  debugLog('log', '[ai-cm-google-search] folwr-open raw(' + txt.length + 'B): ' + diagPreview(txt));
                  // O-27/O-32 (диагностика): тело folwr-open БЕЗ ходов — первый байтовый след
                  // мусора captcha (`)]}' [""]`): путь, вердикт парсера и первые 100 символов.
                  if (typeof gsaDiagBaseWrite === 'function') gsaDiagBaseWrite('open', [], 'no-turns-parsed', tid, { bodyLen: (txt ? txt.length : 0), head: (typeof aiCmDiagHead === 'function') ? aiCmDiagHead(txt, 100) : String(txt || '').slice(0, 100), kind: openPageInfo.cls.kind, status: (resp && resp.status) || 0, ok: (resp && resp.ok) ? 1 : 0 });
                }
              } catch (e) {
                console.log('[ai-cm-google-search] folwr-open: ошибка:', e && e.message);
              }
            }
          }).catch(function () { });
        }
      }).catch(function () { });
    }

    return promise;
  };

  // ---- 2. Перехват XMLHttpRequest ----
  var OrigXHR = window.XMLHttpRequest;
  if (OrigXHR) {
    var origOpen = OrigXHR.prototype.open;
    var origSend = OrigXHR.prototype.send;

    OrigXHR.prototype.open = function (method, url) {
      try {
        this.__aiCmUrl = String(url || '');
        this.__aiCmMethod = String(method || 'GET');
      } catch (e) {
        this.__aiCmUrl = '';
        this.__aiCmMethod = 'GET';
      }
      return origOpen.apply(this, arguments);
    };

    OrigXHR.prototype.send = function (body) {
      var url = '';
      try { url = this.__aiCmUrl || ''; } catch (e) { }
      var method = '';
      try { method = (this.__aiCmMethod || 'GET').toUpperCase(); } catch (e) { }

      var isFolwr = url.indexOf('/folwr') !== -1;
      var isFolif = url.indexOf('/folif') !== -1;

      // v1.24: детект антилимита на любом XHR-ответе (status 429 или итоговый URL /sorry/).
      this.addEventListener('load', function () {
        try {
          if (isSorryResponse(this.status, this.responseURL)) triggerSorryCooldown();
        } catch (e) { }
      });

      if (isFolwr || isFolif) {
        var isFullXhr = isFolwr;
        var self = this;
        this.addEventListener('load', function () {
          try {
            if (self.status >= 200 && self.status < 300 && self.responseText) {
              // v1.5.2: фиксируем время пассивного folwr/folif (XHR) для защиты от гонки <3с.
              lastPassiveFolwrTs[threadAuthKey(currentThreadId || emittedThreadId, url)] = Date.now();
              var txt = self.responseText;
              var modelXhr = extractModel(txt);
              if (modelXhr) detectedModelSlug = modelXhr;
              var parsed = parseWithParser(txt);
              if (parsed.turns.length > 0) {
                // O-27/O-32 (диагностика): путь записи — XHR (folwr полный / folif чанк).
                if (typeof gsaDiagBaseWrite === 'function') gsaDiagBaseWrite('xhr', parsed.turns, 'submit', parsed.threadId, { full: (isFullXhr === true) ? 1 : 0, url: rawSnippet(url, 80), bodyLen: (txt ? txt.length : 0) });
                mergeTurns(parsed.turns, isFullXhr, parsed.threadId, txt);
              } else if (typeof gsaDiagBaseWrite === 'function') {
                gsaDiagBaseWrite('xhr', parsed.turns, 'skip-no-turns', parsed.threadId, { full: (isFullXhr === true) ? 1 : 0, url: rawSnippet(url, 80), bodyLen: (txt ? txt.length : 0) });
              }
            }
          } catch (e) { }
        });
      }

      return origSend.apply(this, arguments);
    };
  }

  // Handshake
  window.addEventListener('ai-cm-google-search-ready', function () {
    if (lastFullSnapshot) {
      console.log('[ai-cm-google-search] folwr-open: повторный эмит по handshake');
      emitDetail(lastFullSnapshot);
    } else {
      activeLoadFolwr('handshake');
    }
  });

  console.log('[ai-cm-google-search] Перехватчик установлен');
  console.log('[ai-cm-google-search] parser available: ' + typeof window.parseGoogleFolwrOpen);
})();