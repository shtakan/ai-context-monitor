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

  // ---- слияние новых ходов и эмит ----
  function mergeTurns(newTurns, isFull) {
    if (isFull) {
      // folwr: полная перезапись базы
      baseTurns = newTurns;
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
          baseTurns.push(nt);
        }
      }
    }
    if (baseTurns.length > 0) {
      emitBaseSnapshot(baseTurns);
    }
  }

  // ---- эмит базы в content.js ----
  function emitBaseSnapshot(turns) {
    var messageTexts = [];
    var messageIds = [];
    for (var i = 0; i < turns.length; i++) {
      var t = turns[i];
      if (t.userText) {
        messageTexts.push(t.userText);
        messageIds.push(t.id + '_user');
      }
      if (t.assistantText) {
        messageTexts.push(t.assistantText);
        messageIds.push(t.id + '_assistant');
      }
    }
    var text = messageTexts.join('\n');
    var count = messageTexts.length;

    try {
      window.dispatchEvent(new CustomEvent('ai-cm-full-history', {
        detail: {
          convId: '',
          text: text,
          count: count,
          effectiveLen: text.length,
          lastMessageText: messageTexts.length ? messageTexts[messageTexts.length - 1] : '',
          modelSlug: detectedModelSlug || '',
          messageTexts: messageTexts,
          messageIds: messageIds,
          attachTokens: 0,
          attachBreak: { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 },
          historyComplete: true
        }
      }));
    } catch (e) { }
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

    var isFolwr = url.indexOf('/folwr') !== -1;
    var isFolif = url.indexOf('/folif') !== -1;

    var promise;
    try { promise = origFetch.apply(this, arguments); } catch (e) { return Promise.reject(e); }

    if (isFolwr || isFolif) {
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
      } catch (e) {
        this.__aiCmUrl = '';
      }
      return origOpen.apply(this, arguments);
    };

    OrigXHR.prototype.send = function (body) {
      var url = '';
      try { url = this.__aiCmUrl || ''; } catch (e) { }

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

  console.log('[ai-cm-google-search] Перехватчик установлен');
})();