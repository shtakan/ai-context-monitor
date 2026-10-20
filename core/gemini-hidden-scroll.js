// =============================================================================
// core/gemini-hidden-scroll.js — v2.0 (этап 2/3).
// СКРЫТЫЙ СКРОЛЛ: поиск скролл-контейнера, виртуальный скроллер (window/элемент),
// ожидание готовности DOM, цикл невидимого автоскролла вверх до стабилизации.
//
// Кластер вынесен из core/gemini-intercept.js. Раньше обе части жили в ОДНОМ IIFE,
// поэтому кластер обращался к состоянию ядра по именам. Теперь у модуля свой IIFE,
// и состояние ядра приходит через __bind(deps) — инжектируемые имена доступны как D.<имя>.
//
// Живое состояние ядра отдаётся НЕ копиями значений, а геттерами/сеттерами:
// модуль и ядро читают и пишут одни и те же переменные IIFE ядра.
//
// Тела функций перенесены без изменения логики и отступов; переписаны только ссылки
// на инжектируемые имена (D.<имя>) и ничего больше. Имена, сигнатуры и порядок
// вызовов сохранены. Связное ядро (network/parser/pagination/loader) остаётся в
// core/gemini-intercept.js — его вынос планируется на этап 3/3.
//
// Порядок подключения (core/background.js, registerSafe для перехватчика Gemini,
// document_start, world MAIN): utils/debug.js -> utils-парсеры -> ЭТОТ ФАЙЛ ->
// core/gemini-intercept.js. Экспорт: window.AiCmGeminiHiddenScroll + module.exports.
// =============================================================================

(function () {
  if (typeof window !== 'undefined' && window.AiCmGeminiHiddenScroll) return;

  // Зависимости ядра. Заполняется один раз через __bind(...) из core/gemini-intercept.js.
  var D = null;
  function __bind(d) { D = d; }

  var AUTO_STEP_WAIT = 1500;
  var AUTO_FIND_TRIES = 6;
  var AUTO_FIND_WAIT = 700;
  var AUTO_EMPTY_NEED = 3;
  var AUTO_HARD_CAP = 250;
  var AUTO_SETTLE_TRIES = 4;
  var AUTO_SETTLE_WAIT = 250;
  var DOM_READY_INTERVAL = 500;          // интервал замера стабилизации scrollHeight
  var AUTO_RETRY_MAX = 2;                // максимум повторных скроллов при недоборе
  var AUTO_RETRY_DELAY = 1500;           // пауза перед retry-скроллом

  function tagInfo(el) {
    var cn = '';
    try { cn = String(el.className || '').trim().split(/\s+/).slice(0, 2).join('.'); } catch (e) { }
    return el.tagName.toLowerCase() + (cn ? '.' + cn : '');
  }

  // ---- ВИРТУАЛЬНЫЙ СКРОЛЛ: обёртка над контейнером или window ----
  function makeScroller(el) {
    if (!el) {
      var de = document.scrollingElement || document.documentElement;
      return {
        mode: 'window', el: de, tag: 'window',
        top: function () { return de.scrollTop; },
        setTop: function (v) { de.scrollTop = v; },
        client: function () { return window.innerHeight; },
        height: function () { return de.scrollHeight; }
      };
    }
    return {
      mode: 'el', el: el, tag: tagInfo(el),
      top: function () { return el.scrollTop; },
      setTop: function (v) { el.scrollTop = v; },
      client: function () { return el.clientHeight; },
      height: function () { return el.scrollHeight; }
    };
  }

  function findScrollContainer() {
    var root = document.querySelector('main'); // v1.17: структурный обход — только поддерево main
    if (!root) { debugLog('log', '[AI CM][scroll] findScrollContainer: main отсутствует — null'); return null; }
    var HINT = /conversation|message|chat-turn|response|scroll|turn-list|infinite|virtual/i;
    var all = root.querySelectorAll('*');
    var hinted = null;
    for (var i = 0; i < all.length; i++) {
      var el = all[i], st = ''; if (el === document.body || el === document.documentElement) continue;
      try { st = getComputedStyle(el).overflowY; } catch (e) { continue; }
      if (st !== 'auto' && st !== 'scroll' && st !== 'overlay') continue;
      var sh = el.scrollHeight, ch = el.clientHeight, hay = '';
      if (!(ch > 0)) continue; // v88: скелет-обёртка (ch=0) — не скролл-контейнер
      if (sh <= ch + 50) continue; if (!el.closest('infinite-scroller.chat-history, [class*="chat-history"]')) continue;
      try { hay = el.tagName + ' ' + el.className + ' ' + el.id; } catch (e) { }
      if (HINT.test(hay)) { if (!hinted || sh > hinted.height()) hinted = makeScroller(el); }
    }
    if (hinted) return hinted;
    // v88: generic best-fallback удалён — на холодном старте он выбирал скелет-обёртку
    // (sh=884, ch=0) впереди ещё не набравшей высоту ленты. Кандидат теперь обязан быть
    // видимым (clientHeight > 0) и лежать под структурным якорем chat-history; иначе
    // возвращается null — «скроллить нечего» (document-фолбэка нет намеренно, v1.17).
    return null;
  }

  function rontgenScroll() {
    var root = document.querySelector('main'); var all = root ? root.querySelectorAll('*') : [];
    var arr = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var sh = el.scrollHeight, ch = el.clientHeight;
      if (sh > ch + 50) {
        var st = ''; try { st = getComputedStyle(el).overflowY; } catch (e) { st = '?'; }
        arr.push({ d: sh - ch, t: tagInfo(el), ov: st });
      }
    }
    arr.sort(function (a, b) { return b.d - a.d; });
    var top = arr.slice(0, 8).map(function (x) { return x.t + '(ov=' + x.ov + ',+' + x.d + ')'; });
    var de = document.scrollingElement || document.documentElement;
    debugLog('log', '[gemini-autoscroll] РЕНТГЕН скролла: windowScrollH=' + de.scrollHeight + ' innerH=' + window.innerHeight +
      ' | топ переполненных (тег ov=overflow +переполнение): ' + (top.join(' || ') || '(нет)') +
      '  ← если ov=hidden у ленты, скролл не нативный (JS) и scrollTop не сработает');
  }

  function countHistoryElements() {
    try {
      var sel = 'turn-container, [data-turn], .user-query, [data-role="user"], [data-role="model"], .model-response, .query-text, .response-content';
      return document.querySelectorAll(sel).length;
    } catch (e) { return 0; }
  }

  // Ожидание готовности DOM перед стартом скролла: ждём стабилизации scrollHeight
  // (3 замера с интервалом, разница < 100px) ИЛИ появления > MIN_HISTORY_ELEMENTS элементов.
  // Таймаут DOM_READY_MAX_WAIT. Логику стабилизации берём из чистой логики (если доступна).
  async function waitForDomReady(sc) {
    var startedAt = Date.now();
    var state = null;
    var hasLogic = typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.newDomReadiness && window.GeminiInterceptLogic.advanceReadiness;
    if (hasLogic) state = window.GeminiInterceptLogic.newDomReadiness();
    else state = { samples: [] };
    // Ожидаемое число элементов из пола (localStorage) — критерий elements==expected.
    var expected = expectedTurnsFromStorage();
    if (!expected || expected <= 0) {
      debugLog('log', '[gemini-autoscroll] ожидаемых=0 → readiness по элементам отключён (только стабилизация scrollHeight); причина=' +
        expectedFloorAbsenceReason());
    } else {
      debugLog('log', '[gemini-autoscroll] readiness: ожидаемых=' + expected + ' (пол из localStorage)');
    }
    var lastH = sc ? sc.height() : 0;
    var lastElems = 0;
    while (Date.now() - startedAt < D.DOM_READY_MAX_WAIT) {
      var h = sc ? sc.height() : (document.scrollingElement ? document.scrollingElement.scrollHeight : 0);
      var elems = countHistoryElements();
      lastH = h;
      lastElems = elems;
      var ready = false, reason = 'pending';
      if (hasLogic) {
        var r = window.GeminiInterceptLogic.advanceReadiness(state, h, elems, expected);
        ready = r.ready;
        reason = r.reason;
      } else {
        ready = elems > D.MIN_HISTORY_ELEMENTS;
        reason = ready ? ('fallback-elements:' + elems) : 'fallback-pending';
      }
      if (ready) {
        return { ok: true, reason: reason, elapsed: Date.now() - startedAt, scrollH: h, elements: elems, expected: expected };
      }
      await D.sleep(DOM_READY_INTERVAL);
    }
    return { ok: false, reason: 'timeout', elapsed: Date.now() - startedAt, scrollH: lastH, elements: lastElems, expected: expected };
  }

  function triggerUp(sc) {
    try {
      sc.setTop(0);
      var target = (sc.mode === 'el') ? sc.el : window;
      try {
        target.dispatchEvent(new WheelEvent('wheel', { deltaY: -1200, deltaMode: 0, bubbles: true, cancelable: true }));
      } catch (e) { }
      try { target.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) { }
    } catch (e) { }
  }

  async function settleBottom(sc) {
    for (var i = 0; i < AUTO_SETTLE_TRIES; i++) {
      try { sc.setTop(sc.height()); } catch (e) { }
      await D.sleep(AUTO_SETTLE_WAIT);
    }
  }

  function scheduleAutoScroll() {
    if (D.autoScrollStarted) return;
    // v20: блокировка автоскролла до первого валидного снимка нового чата
    if (D.autoScrollBlocked) {
      debugLog('log', '[gemini-autoscroll] заблокирован до первого валидного снимка нового чата');
      return;
    }
    D.autoScrollStarted = true;
    setTimeout(autoScrollCollect, 1200);
  }

  // v4x: ожидаемое число ходов из прошлых замеров (пол из localStorage, сохранённый при полной сборке).
  // Возвращает 0, если пола нет — тогда retry не задействуется (не с чем сравнивать).
  function expectedTurnsFromStorage() {
    try {
      var fid = D.getConvId();
      var sf = fid ? D.loadFloor(fid) : null;
      var n = sf ? Number(sf.count) : 0; // v86: пол обязан быть ЧИСЛОМ (undefined/мусор → 0)
      return (isFinite(n) && n > 0) ? n : 0;
    } catch (e) { return 0; }
  }

  // v86: «данные уже в базе» — гейт подавления оверлея при автоскролле. Оверлей в
  // конвейере данных НЕ участвует (сбор идёт через triggerUp/settleBottom ниже),
  // поэтому непрозрачный экран имеет смысл только пока база пуста. Три признака:
  //   1) тихая пагинация дошла до начала — база полная (historyFullByQuiet);
  //   2) начало истории уже подтверждено (reachedStart);
  //   3) пол из localStorage покрыт текущим размером базы (baseSize >= expected).
  // Окно удержания оверлея (3с) живёт не здесь, а в цикле — см. проверку после
  // settleBottom: оверлей, который уже поднят, снимается по данным ИЛИ по возрасту.
  function autoscrollDataPresent() {
    if (D.historyFullByQuiet === true) return true;
    if (D.reachedStart === true) return true;
    var expected = expectedTurnsFromStorage();
    if (expected > 0 && D.baseSize() >= expected) return true;
    return false;
  }

  // Причина нулевого пола/ожидаемых — через чистую логику (гв ключа g3 и т.п.).
  function expectedFloorAbsenceReason() {
    try {
      var fid = D.getConvId();
      if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.diagnoseFloorAbsence) {
        return window.GeminiInterceptLogic.diagnoseFloorAbsence(fid, D.parserVersion, localStorage);
      }
      return (fid ? 'no-logic' : 'no-conv');
    } catch (e) { return 'err'; }
  }

  // v4x: нужен ли повторный скролл. actualTurns/expectedTurns — число ходов (сообщений).
  function retryNeededAutoscroll(actualTurns, expectedTurns, retryCount) {
    if (typeof window !== 'undefined' && window.GeminiInterceptLogic && window.GeminiInterceptLogic.shouldRetryAutoscroll) {
      return window.GeminiInterceptLogic.shouldRetryAutoscroll(actualTurns, expectedTurns, retryCount, AUTO_RETRY_MAX);
    }
    if (!expectedTurns || expectedTurns <= 0) return false;
    if (retryCount >= AUTO_RETRY_MAX) return false;
    return actualTurns < expectedTurns;
  }

  async function autoScrollCollect() {
    // v20: двойная страховка — если флаг всё ещё взведён (например, вызвано напрямую)
    if (D.autoScrollBlocked) {
      debugLog('log', '[gemini-autoscroll] заблокирован (проверка в autoScrollCollect)');
      return;
    }
    // v75 (фаза 2): кэш-лента восстановлена (cache-complete) и новой пагинации нет —
    // hide и принудительный autoscroll полностью отключены: экран не дёргаем.
    try {
      var cid75 = D.getConvId();
      if (cid75 && D.cacheRestoredMap.has(cid75) && !D.quietActive && !D.pendingCursor) {
        debugLog('log', '[gemini-autoscroll] skip reason=cache-hit-no-pagination convId=' + cid75 +
          ' msgs=' + D.baseSize() + ' (hide и принудительный скролл отключены, v75)');
        return;
      }
    } catch (eCache75) { }
    // v33: контейнер, скрытый на время автоскролла (дозагрузка невидима для пользователя)
    var hiddenEl = null;
    var __ovShownAt = 0; // v86: момент подъёма оверлея (0 = не поднимали) — окно удержания 3с
    function __restoreAutoscrollVisibility() {
      if (hiddenEl) {
        D.aiCmSetScrollOverlay(false, 'autoscroll-done'); // v75: DOM не прятали
        debugLog('log', '[AI CM][visibility] restore reason=autoscroll-done convId=' + (D.getConvId() || '(none)'));
        hiddenEl = null;
      }
    }
    try {
      var sc = null;
      for (var attempt = 0; attempt < AUTO_FIND_TRIES; attempt++) {
        sc = findScrollContainer();
        if (sc) break;
        await D.sleep(AUTO_FIND_WAIT);
      }
      if (!sc) {
        debugLog('log', '[gemini-autoscroll] скролл-контейнер не найден за ' + AUTO_FIND_TRIES + ' попыток → автоскролл пропущен (рентген ниже)');
        rontgenScroll();
        return;
      }

      // v4x: детектор готовности DOM — ждём стабилизации scrollHeight или появления элементов истории
      // перед стартом скролла (ленивая подгрузка истории Gemini даёт растущий scrollHeight).
      var ready = await waitForDomReady(sc);
      debugLog('log', '[gemini-autoscroll] готовность DOM: ' + (ready.ok ? 'ok' : 'TIMEOUT') +
        ' reason=' + ready.reason + ' элементы=' + ready.elements + ' scrollH=' + ready.scrollH + ' elapsed=' + ready.elapsed + 'ms');

      if (sc.height() <= sc.client() + 50) {
        debugLog('log', '[gemini-autoscroll] история помещается без скролла (' + sc.tag + ' scrollH=' + sc.height() +
          ' ≈ clientH=' + sc.client() + ') → автоскролл не нужен');
        return;
      }

      var expectedTurns = expectedTurnsFromStorage();
      var openedMs = Date.now() - D.conversationOpenedAt;
      var prevSmooth = '';
      if (sc.mode === 'el') { try { prevSmooth = sc.el.style.scrollBehavior; sc.el.style.scrollBehavior = 'auto'; } catch (e) { } }

      // v33→v75: контейнер НЕ прячем — только прозрачный оверлей (DOM чата не трогается);
      // восстановление — после цикла и в catch.
      // v86: гейт «данные уже в базе» — оверлей не поднимаем, если история уже собрана
      // (тихая пагинация дошла до начала / пол покрыт). Конвейер данных не затрагивается:
      // triggerUp/settleBottom работают как прежде.
      if (sc.mode === 'el' && sc.el) {
        if (!autoscrollDataPresent()) {
          hiddenEl = true; // v75: маркер «оверлей применён»
          __ovShownAt = Date.now(); // v86: отсчёт окна удержания оверлея (3с)
          D.aiCmSetScrollOverlay(true, 'autoscroll');
          debugLog('log', '[AI CM][visibility] hide reason=autoscroll-overlay convId=' + (D.getConvId() || '(none)'));
        } else {
          debugLog('log', '[AI CM][visibility] overlay-suppressed reason=autoscroll-data-present convId=' + (D.getConvId() || '(none)'));
        }
      }

      var startSize = D.baseSize();
      var startH = sc.height();
      var startElems = countHistoryElements();
      debugLog('log', '[gemini-autoscroll] старт: элементов=' + startElems + ' scrollH=' + startH +
        ' время_открытия=' + openedMs + 'ms' + ' (ходов_в_базе=' + startSize + ', ожидаемых=' + expectedTurns + ')');

      var retry = 0;
      var scrollStartAt = Date.now();
      for (; ;) {
        var emptyStreak = 0;
        var lastH = sc.height(), lastB = D.baseSize();
        var stoppedBy = 'hard-cap';
        var i = 0;
        for (i = 0; i < AUTO_HARD_CAP; i++) {
          triggerUp(sc);
          await D.sleep(AUTO_STEP_WAIT);
          var curH = sc.height(), curB = D.baseSize();
          var grew = (curH > lastH) || (curB > lastB);
          if (grew) emptyStreak = 0; else emptyStreak++;
          if (grew) {
            debugLog('log', '[gemini-autoscroll] шаг ' + i + ': scrollH ' + lastH + '→' + curH +
              ', ходов ' + lastB + '→' + curB + ', empty=' + emptyStreak);
          }
          lastH = curH; lastB = curB;
          if (emptyStreak >= AUTO_EMPTY_NEED) { stoppedBy = 'empty*' + AUTO_EMPTY_NEED; break; }
        }

        await settleBottom(sc);

        // v86: оверлей не держим дольше 3с и снимаем сразу, как только база собрана —
        // иначе он висит поверх уже видимого чата до конца прогона (включая retry-паузы).
        if (hiddenEl && (autoscrollDataPresent() || (Date.now() - __ovShownAt > 3000))) {
          __restoreAutoscrollVisibility();
        }

        var finalSize = D.baseSize();
        var finalH = sc.height();
        var finalElems = countHistoryElements();
        var needRetry = retryNeededAutoscroll(finalSize, expectedTurns, retry);
        if (needRetry) {
          retry++;
          debugLog('log', '[gemini-autoscroll] недобор: ходов ' + finalSize + ' < ожидаемых ' + expectedTurns +
            ' → retry ' + retry + ' через ' + AUTO_RETRY_DELAY + 'ms');
          await D.sleep(AUTO_RETRY_DELAY);
          continue;
        }

        var scrollMs = Date.now() - scrollStartAt;
        if (sc.mode === 'el') { try { sc.el.style.scrollBehavior = prevSmooth; } catch (e) { } }
        __restoreAutoscrollVisibility();
        debugLog('log', '[gemini-autoscroll] конец: элементов=' + finalElems + ' scrollH=' + finalH +
          ' время_скролла=' + scrollMs + 'ms retry=' + retry + ' (ходов ' + startSize + '→' + finalSize +
          ', стоп=' + stoppedBy + '; возврат в низ)');
        break;
      }
    } catch (e) {
      __restoreAutoscrollVisibility();
      debugLog('log', '[gemini-autoscroll] ошибка автоскролла (НЕ критично, ловля работает):', e);
    }
  }

  // ---- экспорт (UMD-паттерн: браузер + Node для тестов) ----
  var Api = {
    __bind: __bind,
    tagInfo: tagInfo,
    makeScroller: makeScroller,
    findScrollContainer: findScrollContainer,
    rontgenScroll: rontgenScroll,
    countHistoryElements: countHistoryElements,
    waitForDomReady: waitForDomReady,
    triggerUp: triggerUp,
    settleBottom: settleBottom,
    scheduleAutoScroll: scheduleAutoScroll,
    expectedTurnsFromStorage: expectedTurnsFromStorage,
    autoscrollDataPresent: autoscrollDataPresent,
    expectedFloorAbsenceReason: expectedFloorAbsenceReason,
    retryNeededAutoscroll: retryNeededAutoscroll,
    autoScrollCollect: autoScrollCollect,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Api;
  if (typeof window !== 'undefined') window.AiCmGeminiHiddenScroll = Api;
})();
