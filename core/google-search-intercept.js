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

(function () {
  if (window.__aiCmGoogleSearchInterceptInstalled) return;
  window.__aiCmGoogleSearchInterceptInstalled = true;

  var MAX_CACHE_ENTRIES = 10;

  // ---- хранилище ----
  var seenKeys = {};
  var detectedModelSlug = null;
  var lastFullTurns = [];       // turns последнего активного снимка
  var lastFullMessages = [];    // messages последнего активного снимка
  var lastFullSnapshot = null;  // detail последнего активного снимка
  var currentThreadId = '';     // threadId активного треда (по DOM)
  var emittedThreadId = '';     // threadId, на котором зафиксирована база
  var lastFolwrOpenUrl = '';    // полный URL последнего GET /async/folwr (шаблон для активной загрузки)
  var activeFolwrBusy = false;  // защита от параллельной активной загрузки
  // v1.5.2: сериализация активных folwr и дедуп пассивных по ключу threadId|authuser.
  var activeFolwrInFlight = {}; // ключ -> true, пока активная загрузка этого threadId|authuser в полёте
  var lastPassiveFolwrTs = {};  // ключ -> ts последнего пассивного folwr (для защиты от гонки <3с)

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
  function mergeTurns(newTurns, isFull) {
    var threadId = currentThreadId || emittedThreadId;
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
      emitDetail(lastFullSnapshot);
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
  function applyTurns(turns, tid, historyComplete) {
    if (!turns || turns.length === 0) return;
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
    emitDetail(lastFullSnapshot);
  }

  // Пагинация folwr курсором при открытии: до <10 страниц, merge по id ходов, лог досбор=N.
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

    function step(nextCursor) {
      if (!nextCursor) {
        activeFolwrInFlight[key] = false;
        if (added > 0) {
          console.log('[ai-cm-google-search] пагинация folwr: досбор=' + added +
            ' ходов, страниц=' + pages + ', итого=' + lastFullTurns.length);
        }
        return;
      }
      if (pages >= 9) { // <10 страниц (первая уже применена)
        activeFolwrInFlight[key] = false;
        if (added > 0) {
          console.log('[ai-cm-google-search] пагинация folwr: лимит страниц, досбор=' + added +
            ', итого=' + lastFullTurns.length);
        }
        return;
      }
      if (activeFolwrInFlight[key]) return; // не слать параллельно тот же тред
      activeFolwrInFlight[key] = true;
      pages++;
      window.fetch(urlWithMstk(startUrl, nextCursor), { credentials: 'include' })
        .then(function (resp) {
          return resp && resp.ok ? resp.text() : '';
        })
        .then(function (txt) {
          activeFolwrInFlight[key] = false;
          if (!txt || txt.length <= 100000) return;
          var parsed = parseWithParser(txt);
          var before = merged.length;
          merged = mergeFn(merged, parsed.turns);
          added += (merged.length - before);
          if (merged.length > before) {
            applyTurns(merged, tid, false);
          }
          var cursor = extractToken(txt);
          step(cursor);
        })
        .catch(function () { activeFolwrInFlight[key] = false; });
    }

    step(firstCursor);
  }

  // Активная загрузка истории: пассивный folwr при открытии старого чата в Network не
  // ловится (фильтр пуст) — расширение пере-запрашивает последний зафиксированный шаблон
  // GET /async/folwr. Ответ обработается тем же перехваченным обработчиком folwr-open.
  function activeLoadFolwr(reason) {
    if (!lastFolwrOpenUrl) return;
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
    if (!tid) return;
    if (tid === currentThreadId) return false; // без смены
    // threadId сменился
    currentThreadId = tid;
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
  setInterval(function () {
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
                mergeTurns(parsed.turns, isFull);
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
            if (txt && txt.length > 100000) {
              var model = extractModel(txt);
              if (model) detectedModelSlug = model;
              try {
                  var parsed = parseWithParser(txt);
                var tid = parsed.threadId || readDomThreadId();
                if (tid) currentThreadId = tid;
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

                  applyTurns(mergedTurns, tid, historyComplete);

                  console.log('[ai-cm-google-search] folwr-open: распарсено=' + baseTurns.length +
                    ', folwr-контейнеров=' + folwrTurnCount +
                    ', DOM-контейнеров=' + domTurnCount +
                    ', досбор=' + dopasbor +
                    ', видимых ходов=' + lastFullTurns.length +
                    ', курсор=' + (folwrCursor ? folwrCursor.slice(0, 12) : 'нет') +
                    ', ПОЛНАЯ=' + historyComplete +
                    ', threadId=' + tid);

                  // v1.5.2: пагинация курсором при открытии (страниц <10, merge по id ходов).
                  if (folwrCursor) {
                    followFolwrPagination(url, mergedTurns, tid, folwrCursor);
                  }
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
                mergeTurns(parsed.turns, isFullXhr);
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