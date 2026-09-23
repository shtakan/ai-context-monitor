// =============================================================================
// core/hybrid-tail.js — v2.0 (этап 1/3): декомпозиция core/content.js.
// ГИБРИДНЫЙ ХВОСТ DOM (нормализация, поиск узлов, tail, effective-текст).
//
// Кластер DOM-хвоста гибрида: нормализация текста, селекторы сообщений, поиск узлов
// и проверка принадлежности базе, выбор Gemini DOM-парсера, вычисление длины хвоста
// и эффективного текста/счётчика (при baseComplete база приоритетнее DOM).
// Тела функций перенесены байтово — правила выбора источника не менялись.
//
// Порядок подключения (manifest.json, content_scripts[0].js):
//   utils/* → adapters/* → core/state.js → core/widget.js → core/base-handler.js
//   → core/hybrid-tail.js → core/export-manager.js → core/content.js
// Перенос БЕЗ изменения логики: тела функций, сигнатуры, имена и строковые
// литералы байтово прежние (декомпозиция, а не переписывание).
// =============================================================================

function normalize(s) { return (s || '').toLowerCase().replace(/[^a-zа-яё0-9]+/g, ''); }
function stripMd(s) {
  if (!s) return '';
  return s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/`+/g, '');
}
var MSG_SELECTORS = [
  '[data-message-author-role]',
  '[data-message-id]',
  '.user-query, .model-response, .query-text, .response-content, [data-role="user"], [data-role="model"]'
];
function findMessageNodes() {
  for (var i = 0; i < MSG_SELECTORS.length; i++) {
    var nodes = document.querySelectorAll(MSG_SELECTORS[i]);
    if (nodes && nodes.length > 0) return { nodes: Array.prototype.slice.call(nodes), sel: MSG_SELECTORS[i] };
  }
  return { nodes: [], sel: '(none)' };
}
function nodeIsBase(node, skel) {
  if (baseIdSet && baseIdSet.size > 0) {
    var id = '';
    try { id = (node.getAttribute && node.getAttribute('data-message-id')) || ''; } catch (e) { }
    if (id && baseIdSet.has(String(id).trim())) return true;
  }
  if (!skel) return false;
  if (baseSkelSet && baseSkelSet.has(skel)) return true;
  if (baseAnchors) {
    for (var i = 0; i < baseAnchors.length; i++) {
      if (skel.indexOf(baseAnchors[i]) !== -1) return true;
    }
  }
  return false;
}
// Gemini: DOM-хвост собираем через чистый парсер utils/gemini-dom-parser.js,
// чтобы исключить блоки мышления и включить HTML-таблицы как markdown.
function shouldUseGeminiDomParser() {
  try {
    if (currentAdapter && currentAdapter.siteName === 'gemini') return true;
  } catch (e) { }
  return false;
}
function computeTailFromDom() {
  var found = findMessageNodes();
  var nodes = found.nodes;
  if (!baseSeen || !baseText) return { text: '', count: 0, bounded: false, sel: found.sel, diag: 'нет базы' };
  if (nodes.length === 0) return { text: '', count: 0, bounded: false, sel: found.sel, diag: 'селектор не дал узлов: ' + found.sel };
  if ((!baseIdSet || baseIdSet.size === 0) && (!baseSkelSet || baseSkelSet.size === 0)) {
    return { text: '', count: 0, bounded: false, sel: found.sel, diag: 'кэш базы пуст → фолбэк по базе' };
  }

  var tailNodes = [];
  var stopAt = -1;
  var stopFound = false;
  for (var k = nodes.length - 1; k >= 0; k--) {
    var raw = nodes[k].innerText || nodes[k].textContent || '';
    var skel = normalize(raw);
    if (nodeIsBase(nodes[k], skel)) { stopFound = true; stopAt = k; break; }
    if (skel.length > 0) tailNodes.unshift(nodes[k]);
  }

  var pieces = [];
  for (var j = 0; j < tailNodes.length; j++) {
    var txt = '';
    if (shouldUseGeminiDomParser()) {
      try {
        txt = (typeof GeminiDomParser !== 'undefined' && GeminiDomParser)
          ? GeminiDomParser.extractGeminiResponse(tailNodes[j]).text
          : '';
      } catch (e) {
        txt = (tailNodes[j].innerText || tailNodes[j].textContent || '').trim();
      }
    } else {
      txt = (tailNodes[j].innerText || tailNodes[j].textContent || '').trim();
    }
    if (txt) pieces.push(txt);
  }
  return {
    text: pieces.join('\n'),
    count: tailNodes.length,
    bounded: stopFound,
    sel: found.sel,
    diag: 'sel=' + found.sel + ' узлов=' + nodes.length +
      ' стоп=' + (stopFound ? ('@' + stopAt) : 'нет(все в окне — новые)') +
      ' хвост=' + tailNodes.length + ' bdd=' + (stopFound ? 'да' : 'нет')
  };
}
// Если сеть дала полную историю (baseComplete) — индикатор берёт число ИЗ БАЗЫ (baseText), а НЕ из DOM.
//   Это и есть фикс расхождения 20.3% vs 34.8%: при тихой пагинации DOM не дорендеривается (в этом её
//   смысл), поэтому в нём только видимый кусок; база же держит всю историю детерминированно. Раньше строка,
//   взводящая baseComplete из события, была потеряна при переписывании под сброс чата → виджет всегда считал
//   по DOM. Теперь при baseComplete=true возвращаем baseText, и скролл вверх число не меняет (сеть от скролла
//   не зависит). Иначе (база неполная) — прежняя логика: bounded ? база+хвост : только DOM.
//
// O-32: неполная база — это КАНОНИЧЕСКИЙ пол базы, а не «сеть победила / DOM победил».
//   Живой дефект (16:47:48): «частичная» DOM-выборка (bounded=false — границы базы в DOM уже
//   нет, сервис вытеснил старые сообщения) отдавалась как ВЕСЬ текст метрик, и база в 6
//   сообщений подменялась куском в 2 сообщения (бейдж 4.4% → 0.6% на том же треде).
//   Правило: при неполной базе берётся ОБЪЕДИНЕНИЕ (канонический выбор): база ∧ DOM —
//   граница базы видна → база + хвост; DOM неполон → остаётся БАЗА (пол базы неизменен),
//   а не более слабый DOM-кусок. Полная база (baseComplete) — по-прежнему ровно база.
// O-32: канонический текст метрик неполной базы — ровно схлопнутая база (aiCmMetricBaseText,
// core/base-handler.js). Хелпер объявлен в общем лексическом скоупе контент-скриптов; в
// срез-песочницах тестов его может не быть — typeof-гард, значение то же (baseText).
function aiCmTailMetricBase(fallback) {
  return (typeof aiCmMetricBaseText === 'function') ? aiCmMetricBaseText(fallback) : fallback;
}
function getEffectiveText() {
  if (baseSeen && baseText) {
    if (baseComplete) {
      lastBounded = true; // источник = сеть, стабилен → монотонный максимум безвреден
      // v1.18 (E-2.3): текст метрик (pct/токены/бейдж) — РОВНО схлопнутая база текущего
      // снимка (выход prepareExportMessages), тот же массив, что уходит в файл экспорта.
      return aiCmTailMetricBase(baseText);
    }
    var tail = computeTailFromDom();
    var sig = (tail.sel || '') + '|' + (tail.bounded ? '1' : '0');
    if (sig !== lastTailSig) {
      lastTailSig = sig;
      // Антиспам: печатаем hybrid-tail только если текст изменился относительно последней печати.
      if (tail.diag !== lastHybridTailSig) {
        lastHybridTailSig = tail.diag;
        debugLog('log', '[hybrid-tail] ' + tail.diag);
      }
    }
    lastBounded = tail.bounded;
    if (!tail.text) return aiCmTailMetricBase(baseText); // хвоста нет — метрики по канонической базе
    if (tail.bounded) return aiCmTailMetricBase(baseText) + '\n' + tail.text;
    // DOM неполон: его видимый кусок НЕ заменяет базу (было `return tail.text`).
    return aiCmTailMetricBase(baseText);
  }
  return '';
}
function getEffectiveCount(fallbackCount) {
  if (baseSeen && baseText) {
    if (baseComplete) return baseCount;
    var tail = computeTailFromDom();
    if (!tail.count) return baseCount;
    if (tail.bounded) return baseCount + tail.count;
    return baseCount; // O-32: неполный DOM не сокращает счётчик канонической базы
  }
  return fallbackCount;
}

// ========== v2.0 (этап 1/3): UMD-экспорт модуля ==========
// Паттерн как у utils/export-emit-pipeline.js: window.<Api> + module.exports.
// Рабочий путь ничего не импортирует: content-скрипты манифеста делят один
// глобальный лексический скоуп, поэтому объявления выше видны всем модулям и
// content.js по прежним именам. Api — для инструментов, отладки и тестов.
(function () {
  var Api = {};
  Api.normalize = normalize;
  Api.stripMd = stripMd;
  Api.MSG_SELECTORS = MSG_SELECTORS;
  Api.findMessageNodes = findMessageNodes;
  Api.nodeIsBase = nodeIsBase;
  Api.shouldUseGeminiDomParser = shouldUseGeminiDomParser;
  Api.computeTailFromDom = computeTailFromDom;
  Api.aiCmTailMetricBase = aiCmTailMetricBase;
  Api.getEffectiveText = getEffectiveText;
  Api.getEffectiveCount = getEffectiveCount;
  if (typeof module !== 'undefined' && module.exports) module.exports = Api;
  if (typeof window !== 'undefined') window.AiCmHybridTail = Api;
})();
