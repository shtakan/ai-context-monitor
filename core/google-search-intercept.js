// core/google-search-intercept.js
// Перехватчик Google Search AI (udm=50) в MAIN world.
// Регистрируется через background.js.
//
// v6: поддержка folwr (полная история) + folif (realtime), модель из сети,
//     фолбэк вопросов из TgQPHd, полные ответы через compareDocumentPosition.

(function () {
  if (window.__aiCmGoogleSearchInterceptInstalled) return;
  window.__aiCmGoogleSearchInterceptInstalled = true;

  // ---- модульное хранилище базы ----
  var baseTurns = [];
  var seenKeys = {};
  var detectedModelSlug = null;
  var lastFullTurns = [];       // полная база последнего folwr-open снимка (turns)
  var lastFullMessages = [];    // плоские messages полного снимка
  var lastFullSnapshot = null;  // detail (payload) последнего полного снимка

  // ---- диагностика: какие запросы Google Search AI поднимает историю ----
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

  // ---- извлечение модели из сетевого ответа ----
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

  // ---- пересборка плоских messages из полной базы ----
  function rebuildLastFullMessages() {
    var msgs = [];
    for (var i = 0; i < lastFullTurns.length; i++) {
      var t = lastFullTurns[i];
      if (t.userText) msgs.push({ role: 'user', text: t.userText });
      if (t.assistantText) msgs.push({ role: 'assistant', text: t.assistantText });
    }
    lastFullMessages = msgs;
  }

  // ---- слияние стрим-ходов с полной базой (без уменьшения) ----
  function mergeStreamTurns(streamTurns) {
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
    rebuildLastFullMessages();
    lastFullSnapshot = buildDetail(lastFullTurns);
    console.log('[ai-cm-google-search] стрим: слияние с полной базой, всего сообщений:', lastFullMessages.length);
    emitDetail(lastFullSnapshot);
  }

  // ---- слияние новых ходов и эмит ----
  function mergeTurns(newTurns, isFull) {
    if (isFull) {
      // Защитный merge: не перезаписываем базу меньшим снимком (стрим-гонка).
      if (lastFullTurns.length > 0 && newTurns.length < lastFullTurns.length) {
        mergeStreamTurns(newTurns);
        return;
      }
      // folwr: полная перезапись базы
      lastFullTurns = newTurns.slice();
      seenKeys = {};
      for (var i = 0; i < newTurns.length; i++) {
        var t = newTurns[i];
        var key = (t.userText || '') + '||' + (t.assistantText || '');
        seenKeys[key] = true;
      }
    } else {
      // folif: добавление новых ходов
      for (var j = 0; j < newTurns.length; j++) {
        var nt = newTurns[j];
        var key2 = (nt.userText || '') + '||' + (nt.assistantText || '');
        if (!seenKeys[key2]) {
          seenKeys[key2] = true;
          lastFullTurns.push(nt);
        }
      }
    }
    rebuildLastFullMessages();
    if (lastFullTurns.length > 0) {
      lastFullSnapshot = buildDetail(lastFullTurns);
      emitDetail(lastFullSnapshot);
    }
  }

  // ---- сборка detail снимка (без dispatch) ----
  function buildDetail(turns) {
    var messageTexts = [];
    var messageIds = [];
    var messages = [];
    for (var i = 0; i < turns.length; i++) {
      var t = turns[i];
      if (t.userText) {
        messageTexts.push(t.userText);
        messageIds.push(t.id + '_user');
        messages.push({ role: 'user', text: t.userText });
      }
      if (t.assistantText) {
        messageTexts.push(t.assistantText);
        messageIds.push(t.id + '_assistant');
        messages.push({ role: 'assistant', text: t.assistantText });
      }
    }
    var text = messageTexts.join('\n');
    return {
      convId: '',
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
      historyComplete: true
    };
  }

  function emitDetail(detail) {
    try {
      window.dispatchEvent(new CustomEvent('ai-cm-full-history', { detail: detail }));
    } catch (e) { }
  }

  // ---- эмит базы в content.js ----
  function emitBaseSnapshot(turns) {
    emitDetail(buildDetail(turns));
  }

  // ---- парсинг HTML-ответа ----
  function parseTurns(htmlText) {
    var doc;
    try {
      doc = new DOMParser().parseFromString(htmlText, 'text/html');
    } catch (e) {
      console.warn('[ai-cm-google-search] DOMParser не сработал:', e);
      return [];
    }

    var turns = doc.querySelectorAll('[data-scope-id="turn"]');
    var allAimfl = doc.querySelectorAll('[data-subtree="aimfl"]');
    var allN6 = doc.querySelectorAll('.n6owBd.awi2gc');

    // Извлечь вопросы из turn-контейнеров (h2.iMqumd)
    var questions = [];
    for (var i = 0; i < turns.length; i++) {
      var h2 = turns[i].querySelector('h2.iMqumd');
      var questionText = null;
      if (h2) {
        var raw = h2.textContent.trim();
        var match = raw.match(/^Вы сказали:\s*"([\s\S]*)"$/);
        if (match) {
          questionText = match[1].trim();
        } else {
          questionText = raw;
        }
      }
      questions.push(questionText);
    }

    // Распределить блоки .n6owBd.awi2gc по turn'ам через compareDocumentPosition
    var answers = [];
    for (var ti = 0; ti < turns.length; ti++) {
      answers[ti] = [];
    }
    var blocks = doc.querySelectorAll('.n6owBd.awi2gc');
    for (var b = 0; b < blocks.length; b++) {
      var block = blocks[b];
      var assignedIdx = -1;
      for (var ti2 = 0; ti2 < turns.length; ti2++) {
        if (turns[ti2].compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING) {
          assignedIdx = ti2;
        } else {
          break;
        }
      }
      if (assignedIdx >= 0 && assignedIdx < turns.length) {
        var cloneBlock = block.cloneNode(true);
        cloneBlock.querySelectorAll('script, style, button, svg').forEach(function(el) { el.remove(); });
        var blockText = cloneBlock.textContent.trim();
        if (blockText) {
          answers[assignedIdx].push(blockText);
        }
      }
    }

    // Собрать ответы для каждого turn + фолбэк из allAimfl
    var assistantTexts = [];
    for (var ti3 = 0; ti3 < turns.length; ti3++) {
      var joined = answers[ti3].length > 0 ? answers[ti3].join('\n\n') : null;
      if (!joined && allAimfl[ti3]) {
        var aimText = allAimfl[ti3].textContent.trim();
        if (aimText) joined = aimText;
      }
      assistantTexts.push(joined);
    }

    // Сопоставить вопросы и ответы по индексу
    var result = [];
    var count = questions.length;
    for (var k = 0; k < count; k++) {
      result.push({
        id: (turns[k] && turns[k].getAttribute('jsuid')) || ('idx' + k),
        userText: questions[k] || null,
        assistantText: assistantTexts[k] || null
      });
    }

    // Фолбэк вопросов из TgQPHd для ходов с userText === null (folif)
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
          var longMatchB;
          var foundB = null;
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
      } catch (e) { /* тихо */ }

      var cqi = 0;
      for (var bi2 = 0; bi2 < result.length; bi2++) {
        if (!result[bi2].userText && cqi < commentQuestions.length && commentQuestions[cqi]) {
          result[bi2].userText = commentQuestions[cqi];
          cqi++;
        }
      }
    }

    // Фолбэк для folif: если turn-контейнеров не нашлось совсем
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
          if (folifQuestion) break;
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
            clone2.querySelectorAll('script, style, button, svg').forEach(function(el) { el.remove(); });
            var ntext = clone2.textContent.trim();
            if (ntext) { folifAnswer = ntext; break; }
          }
        }

        if (folifQuestion || folifAnswer) {
          result.push({
            id: 'folif_' + Date.now(),
            userText: folifQuestion,
            assistantText: folifAnswer
          });
        }
      } catch (e) { /* тихо */ }
    }

    return result;
  }

  // ---- 1. Перехват window.fetch ----
  var origFetch = window.fetch;

  window.fetch = function (input, init) {
    var url = '';
    try { url = (typeof input === 'string') ? input : (input && input.url) || ''; } catch (e) { }
    var method = '';
    try { method = (init && init.method) ? String(init.method).toUpperCase() : 'GET'; } catch (e) { }

    if (isDiagTarget(url)) {
      console.log('[ai-cm-google-search] diag: fetch', method, url.slice(0, 160));
    }

    var isFolwr = url.indexOf('/folwr') !== -1;
    var isFolif = url.indexOf('/folif') !== -1;
    var isOpenFolwr = url.indexOf('/async/folwr') !== -1;

    var promise;
    try { promise = origFetch.apply(this, arguments); } catch (e) { return Promise.reject(e); }

    if (isDiagTarget(url) && method !== 'POST') {
      promise.then(function (resp) {
        try {
          if (resp && typeof resp.clone === 'function') {
            resp.clone().text().then(function (txt) {
              if (txt && txt.length > 2000) {
                console.log('[ai-cm-google-search] diag: большой ответ', url.slice(0, 160), txt.length, diagPreview(txt));
              }
            }).catch(function () { });
          }
        } catch (e) { }
      }).catch(function () { });
    }

    if ((isFolwr || isFolif) && !isOpenFolwr) {
      var isFull = isFolwr;
      promise.then(function (resp) {
        try {
          if (resp && resp.ok) {
            resp.clone().text().then(function (txt) {
              var model = extractModel(txt);
              if (model) detectedModelSlug = model;

              var turns = parseTurns(txt);
              if (turns.length > 0) {
                mergeTurns(turns, isFull);
              }
            }).catch(function () { });
          }
        } catch (e) { }
        return resp;
      }, function () { });
    }

    // GET /async/folwr при открытии треда: полная история (~1 МБ HTML-поток).
    // Извлекаем ВСЕ ходы и эмитим полный снимок (historyComplete: true).
    if (isOpenFolwr && method !== 'POST') {
      promise.then(function (resp) {
        if (resp && resp.ok) {
          resp.clone().text().then(function (txt) {
            if (txt && txt.length > 100000) {
              console.log('[ai-cm-google-search] folwr-open: ветка сработала, длина =', txt.length);

              var model = extractModel(txt);
              if (model) detectedModelSlug = model;

              try {
                var parsed = window.parseGoogleFolwrOpen
                  ? window.parseGoogleFolwrOpen(txt)
                  : {
                      turns: parseTurns(txt),
                      messages: [],
                      text: '',
                      count: 0
                    };

                if (parsed && parsed.turns && parsed.turns.length > 0) {
                  // сохраняем полный снимок для handshake и защиты от стрим-сжатия
                  lastFullTurns = parsed.turns.slice();
                  rebuildLastFullMessages();
                  seenKeys = {};
                  for (var si = 0; si < lastFullTurns.length; si++) {
                    var st = lastFullTurns[si];
                    seenKeys[(st.userText || '') + '||' + (st.assistantText || '')] = true;
                  }
                  lastFullSnapshot = buildDetail(lastFullTurns);
                  console.log('[ai-cm-google-search] folwr-open: распарсено сообщений:',
                    parsed.turns.length, ', text len =', (parsed.text ? parsed.text.length : 0));
                  console.log('[ai-cm-google-search] folwr-open: эмит полного снимка');
                  emitDetail(lastFullSnapshot);
                } else {
                  console.log('[ai-cm-google-search] folwr-open: пустой результат парсинга (turns =',
                    (parsed && parsed.turns) ? parsed.turns.length : 'n/a') + ')';
                }
              } catch (e) {
                console.log('[ai-cm-google-search] folwr-open: ошибка:', e && e.message);
              }
            } else {
              console.log('[ai-cm-google-search] folwr-open: ответ короткий, пропуск (длина =', txt ? txt.length : 0, ')');
            }
          }).catch(function (err) {
            console.log('[ai-cm-google-search] folwr-open: ошибка чтения текста:', err && err.message);
          });
        }
      }).catch(function (err) {
        console.log('[ai-cm-google-search] folwr-open: ошибка fetch:', err && err.message);
      });
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

      if (isDiagTarget(url)) {
        console.log('[ai-cm-google-search] diag: xhr', method, url.slice(0, 160));
      }

      if (isDiagTarget(url) && method !== 'POST') {
        var xhrDiag = this;
        this.addEventListener('load', function () {
          try {
            var txt = xhrDiag.responseText;
            if (txt && txt.length > 2000) {
              console.log('[ai-cm-google-search] diag: большой ответ', url.slice(0, 160), txt.length, diagPreview(txt));
            }
          } catch (e) { }
        });
      }

      var isFolwr = url.indexOf('/folwr') !== -1;
      var isFolif = url.indexOf('/folif') !== -1;

      if (isFolwr || isFolif) {
        var isFullXhr = isFolwr;
        var self = this;
        this.addEventListener('load', function () {
          try {
            if (self.status >= 200 && self.status < 300 && self.responseText) {
              var txt = self.responseText;

              var modelXhr = extractModel(txt);
              if (modelXhr) detectedModelSlug = modelXhr;

              var turns = parseTurns(txt);
              if (turns.length > 0) {
                mergeTurns(turns, isFullXhr);
              }
            }
          } catch (e) { }
        });
      }

      return origSend.apply(this, arguments);
    };
  }

  // Handshake: адаптер присылает ready после подписки content.js — повторно эмитим полный снимок.
  window.addEventListener('ai-cm-google-search-ready', function () {
    if (lastFullSnapshot) {
      console.log('[ai-cm-google-search] folwr-open: повторный эмит по handshake');
      emitDetail(lastFullSnapshot);
    }
  });

  console.log('[ai-cm-google-search] Перехватчик установлен');
  console.log('[ai-cm-google-search] parser available: ' + typeof window.parseGoogleFolwrOpen);
})();