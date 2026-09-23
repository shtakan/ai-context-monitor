// ===== O-45: КОД-БЛОКИ (окна кода python/js) в DOM-пути адаптера =====
// Единственный источник правды — utils/google-search-folwr-parser.js (renderCodeBlock /
// answerTextOf / answerDomNodes): сетевой путь, DOM-добор перехватчика и DOM-путь адаптера
// обязаны давать ОДИН и тот же текст по коду, поэтому собственных правил адаптер не держит
// (тот же паттерн ленивого резолва общего хелпера, что у Qwen-адаптера в O-37). Хелпер
// резолвится лениво, на каждом вызове:
//   1) общий ISOLATED-мир — window.GoogleFolwrUtils (парсер загружен в этот мир);
//   2) Node-путь (require) — тесты и Node-песочницы;
//   3) ничего из этого нет → поведение ровно как до O-45: .n6owBd.awi2gc + голый textContent.
function gsaFolwrUtils() {
  try {
    if (typeof window !== 'undefined' && window.GoogleFolwrUtils &&
        typeof window.GoogleFolwrUtils.answerTextOf === 'function' &&
        typeof window.GoogleFolwrUtils.answerDomNodes === 'function') {
      return window.GoogleFolwrUtils;
    }
  } catch (e) { }
  try {
    if (typeof require === 'function') {
      var mod = require('../utils/google-search-folwr-parser.js');
      if (mod && typeof mod.answerTextOf === 'function' && typeof mod.answerDomNodes === 'function') {
        return mod;
      }
    }
  } catch (e2) { }
  return null;
}

// Текст узла ответа общим рендером парсера (код-окна → ```lang … ```); без хелпера — прежний
// textContent, то есть байты DOM-пути не меняются.
function gsaAnswerText(el) {
  var util = gsaFolwrUtils();
  if (util) {
    try { return String(util.answerTextOf(el) || ''); } catch (e) { }
  }
  try {
    var clone = el.cloneNode(true);
    clone.querySelectorAll('script, style, button, svg').forEach(function(n) { n.remove(); });
    return String(clone.textContent || '');
  } catch (e2) { return ''; }
}

// Узлы ответа общим отбором парсера (чанки прозы + САМОСТОЯТЕЛЬНЫЕ код-окна между ними);
// без хелпера — только чанки .n6owBd.awi2gc, как раньше.
function gsaAnswerNodes(root) {
  var util = gsaFolwrUtils();
  if (util) {
    try {
      var nodes = util.answerDomNodes(root);
      if (nodes) return nodes;
    } catch (e) { }
  }
  try { return root.querySelectorAll('.n6owBd.awi2gc'); } catch (e2) { return []; }
}

class GoogleSearchAdapter extends BaseAdapter {
  constructor() {
    super();
    this.siteName = 'google_search';
    this._lastNetworkModel = '';
    this._lastExtractedCount = null; // антиспам: последнее N в «Извлечено N сообщений»
    this._lastCodeBlockSig = null;   // O-45 (ДИАГНОСТИКА): антиспам строки структуры код-блока
    console.log('[GoogleSearchAdapter] Инициализирован (v2: AI-режим)');

    if (typeof window !== 'undefined') {
      var self = this;
      try {
        window.addEventListener('ai-cm-full-history', function (ev) {
          var detail = ev && ev.detail;
          if (detail && detail.modelSlug) {
            self._lastNetworkModel = detail.modelSlug;
          }
        });
        // handshake: сигналим перехватчику (MAIN world), что content.js уже подписан на ai-cm-full-history
        window.dispatchEvent(new CustomEvent('ai-cm-google-search-ready'));
      } catch (e) {}
    }
  }

  isOnDialogPage() {
    var hasTurns = document.querySelector('[data-scope-id="turn"]') !== null;
    var hasAimfl = document.querySelector('[data-subtree="aimfl"]') !== null;
    var hasInput = document.querySelector('textarea, [contenteditable="true"]') !== null;
    var result = hasTurns || hasAimfl || hasInput;
    console.log('[GoogleSearchAdapter] Страница диалога: ' + result);
    return result;
  }

  extractMessages() {
    try {
      var turns = document.querySelectorAll('[data-scope-id="turn"]');
      if (!turns || turns.length === 0) {
        console.log('[GoogleSearchAdapter] Turn-контейнеров не найдено');
        return [];
      }

      // Собираем вопросы из h2.iMqumd внутри turn'ов
      var questions = [];
      for (var i = 0; i < turns.length; i++) {
        var h2 = turns[i].querySelector('h2.iMqumd');
        var qText = null;
        if (h2) {
          var raw = h2.textContent.trim();
          var match = raw.match(/^Вы сказали:\s*"([\s\S]*)"$/);
          if (match) {
            qText = match[1].trim();
          } else {
            qText = raw;
          }
        }
        questions.push(qText);
      }

      // Распределяем блоки .n6owBd.awi2gc по turn'ам
      var answerBlocks = [];
      for (var ti = 0; ti < turns.length; ti++) {
        answerBlocks[ti] = [];
      }

      // O-45: узлы ответа — чанки прозы + САМОСТОЯТЕЛЬНЫЕ код-окна между ними (общий отбор
      // парсера answerDomNodes), текст узла — общим рендером answerTextOf: окно кода уезжает
      // в ```lang\n<код>\n``` целиком. Без доступного хелпера — прежний путь (только
      // .n6owBd.awi2gc и голый textContent), байты DOM-пути не меняются.
      var blocks = gsaAnswerNodes(document);
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
          var blockText = gsaAnswerText(block).trim();
          if (blockText) {
            answerBlocks[assignedIdx].push(blockText);
          }
        }
      }

      // O-45 (ДИАГНОСТИКА, только измерение): структура ПЕРВОГО найденного код-блока Gemini.
      // Гейт — aiCmDebug (utils/debug.js: aiCmDiagOn/aiCmDiagLine, тот же ISOLATED-мир).
      // Печатается ОДИН раз на блок (антиспам: extractMessages зовётся в цикле оценки токенов),
      // только ЧИТАЕТ DOM: извлечение текста, байты экспорта, пороги и латчи не меняются.
      // В срез-песочницах тестов хелперов гейта нет — вызовы защищены typeof-гардом.
      try {
        if (typeof aiCmDiagOn === 'function' && aiCmDiagOn() && typeof aiCmDiagLine === 'function') {
          var codeSels = ['.n6owBd.awi2gc pre', '.n6owBd.awi2gc code',
            '[data-subtree="aimfl"] pre', '[data-subtree="aimfl"] code', 'pre', 'code'];
          var codeEl = null, codeVia = '';
          for (var cs = 0; cs < codeSels.length && !codeEl; cs++) {
            codeEl = document.querySelector(codeSels[cs]);
            if (codeEl) codeVia = codeSels[cs];
          }
          var codeSig = codeEl
            ? (codeVia + '|' + codeEl.tagName + '|' + String(codeEl.className || '') + '|' + codeEl.textContent.length)
            : 'none';
          if (codeSig !== this._lastCodeBlockSig) {
            this._lastCodeBlockSig = codeSig;
            if (!codeEl) {
              aiCmDiagLine('gsa-code-block', { found: 0, via: '(нет)', blocks: blocks.length, turns: turns.length });
            } else {
              var codeParent = codeEl.parentElement;
              aiCmDiagLine('gsa-code-block', {
                found: 1,
                via: codeVia,
                tag: codeEl.tagName,
                cls: String(codeEl.className || '').slice(0, 120),
                childs: codeEl.childNodes.length,
                textLen: codeEl.textContent.length,
                parentTag: (codeParent && codeParent.tagName) || '',
                parentCls: (codeParent && String(codeParent.className || '').slice(0, 120)) || '',
                // outerHTML.slice(0,500); переводы строк схлопнуты, чтобы строка лога осталась одной
                html500: String(codeEl.outerHTML || '').replace(/\s+/g, ' ').slice(0, 500)
              });
            }
          }
        }
      } catch (eCodeBlock) { }

      // Собираем ответы
      var answers = [];
      for (var ti3 = 0; ti3 < turns.length; ti3++) {
        var joined = answerBlocks[ti3].length > 0 ? answerBlocks[ti3].join('\n\n') : null;
        // Фолбэк: [data-subtree="aimfl"] по индексу
        if (!joined) {
          var allAimfl = document.querySelectorAll('[data-subtree="aimfl"]');
          if (allAimfl[ti3]) {
            var aimText = allAimfl[ti3].textContent.trim();
            if (aimText) joined = aimText;
          }
        }
        answers.push(joined);
      }

      // Формируем сообщения: user → assistant, по порядку
      var messages = [];
      for (var k = 0; k < Math.min(questions.length, answers.length); k++) {
        if (questions[k]) {
          messages.push({ role: 'user', content: questions[k] });
        }
        if (answers[k]) {
          messages.push({ role: 'assistant', content: answers[k] });
        }
      }

      // Антиспам: печатаем только при изменении N сообщений.
      if (messages.length !== this._lastExtractedCount) {
        this._lastExtractedCount = messages.length;
        console.log('[GoogleSearchAdapter] Извлечено ' + messages.length + ' сообщений');
      }
      return messages;
    } catch (error) {
      console.error('[GoogleSearchAdapter] Ошибка:', error);
      return [];
    }
  }

  getFullDialogText() {
    return this.extractMessages().map(function(msg) { return msg.content; }).join('\n');
  }

  detectModel() {
    // Модель берём ТОЛЬКО из сети (активный/пассивный ответ, detail.modelSlug).
    // Дефект: раньше фолбэк отдавал DOM-догадку gemini-2.5-flash, хотя в сети
    // ходит 1.5-pro/1.5-flash. Для GSA 2.5-flash не возвращаем никогда.
    if (this._lastNetworkModel) return this._lastNetworkModel;
    return '';
  }
}