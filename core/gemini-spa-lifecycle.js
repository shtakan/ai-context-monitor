// =============================================================================
// core/gemini-spa-lifecycle.js — Phase 3, шаг 3 (декомпозиция core/gemini-intercept.js).
// K: SPA-ЖИЗНЕННЫЙ ЦИКЛ ЧАТА — детектор смены conversationId (checkConvChange) и
// перехваты навигации, которые его взводят: history.pushState, history.replaceState,
// window 'popstate' и document 'scroll' (запись scrollRecentUntil). До выноса это были
// строки 1204-1256 ядра (HEAD 192ea34) плюс объявление таймера фолбэка бейджа.
//
// ПОЧЕМУ ВЫНЕСЕНО. Шаг 3 плана (DOM/видимость/оверлей-таймеры) выполнен раньше: commit
// 61457ac вынес оверлей в core/gemini-overlay.js (ядро сокращено на ~143 строки тел).
// Повторный вынос той же логики создал бы ТЕНЕВУЮ КОПИЮ core/gemini-overlay.js, поэтому
// шаг 3 закрыт следующим реальным кластером ядра — SPA-переходом. После выноса в ядре не
// остаётся ни одного патча history, а смена чата по SPA по-прежнему сбрасывает состояние.
//
// РАЗДЕЛЕНИЕ ПО SCOPE. Тела перенесены БАЙТ-В-БАЙТ и без префикса D.: они объявлены
// ВНУТРИ `with (D) { … }` BIND-зоны — как в core/gemini-oracle.js, core/gemini-ingest.js
// и core/pagination/pagination.js. Это не стилистика: функция, объявленная ВНЕ with, не
// видит bind-имена (её замыкание создано без with-окружения) и падает на первом же
// свободном имени (currentConvId, resetForNewConversation). Байтовая идентичность важна и
// для пинов: существующие сьюты режут тела из конкатенации и исполняют их в песочнице
// `with (ctx)` без ключа D — префикс D. сломал бы резолв. Единственное добавление —
// имя файла в шапке и в логах.
//
// СОСТОЯНИЕ ОСТАЁТСЯ В ЯДРЕ. resetForNewConversation (строки 1108-1202 HEAD) НЕ уехал:
// он переписывает ~70 переменных, которые читают ingest, лоадер, пагинация и оракул;
// переезд означал бы контракт на семь десятков имён и правку чужих кластеров. В ядре
// остались getConvId, currentConvId, convEpoch, captureReqTag/isStaleReqTag,
// loaderDoneMap, loaderRunningFor, scrollRecentUntil. Модуль получает:
//   • функции значением (7): getConvId, resetForNewConversation, forceRestoreVisibility,
//     notifyLoaderState, maybeStartLoader, baseSize, activeRefresh — декларации хойстятся,
//     а maybeStartLoader (поздний алиас лоадера) уже дозаполнен: блок связки лоадера стоит
//     строго ВЫШЕ места связки этого модуля;
//   • rw-пары (3): currentConvId, loaderRunningFor, scrollRecentUntil — тела их
//     ПЕРЕЗАПИСЫВАЮТ; без сеттера запись в sloppy-режиме молча терялась бы (детектор не
//     замечал бы новый чат, сброс не срабатывал бы вовсе);
//   • ro-геттер (1): loaderDoneMap — тела только удаляют ключ, мутация по ссылке видна ядру.
// loaderBadgeTimer переехал ЦЕЛИКОМ: его единственные потребители (тело checkConvChange и
// его же таймер) уехали вместе с ним, объявление в ядре удалено — теневой копии нет.
//
// ПОРЯДОК ПОДКЛЮЧЕНИЯ (core/background.js, registerSafe 'ai-cm-gemini-intercept-v15',
// document_start, world MAIN): … utils/gemini-intercept-logic.js -> core/gemini-hidden-scroll.js
// -> core/gemini-diag.js -> core/gemini-rpc.js -> core/gemini-parse.js -> core/gemini-sse.js
// -> core/pagination/pagination.js -> core/gemini-loader-scroll.js -> core/gemini-files.js
// -> core/gemini-payload.js -> core/gemini-ingest.js -> core/gemini-overlay.js
// -> core/gemini-archive.js -> core/gemini-oracle.js -> core/gemini-diag-dump.js ->
// ЭТОТ ФАЙЛ -> core/gemini-intercept.js. Ядро зовёт __bind в ТОМ ЖЕ месте, где раньше
// стоял код, поэтому патчи history ставятся в прежний момент — к первому SPA-переходу.
// checkConvChange наружу не выдаётся: его зовут только патчи и popstate-слушатель этого же
// модуля (в ядре он был локальным); Fn.checkConvChange оставлен для отладки из консоли.
// Экспорт: window.AiCmGeminiSpaLifecycle + module.exports.
// =============================================================================
(function () {
  if (typeof window !== 'undefined' && window.AiCmGeminiSpaLifecycle) return;

  // Зависимости ядра. Заполняется один раз через __bind(...) из core/gemini-intercept.js.
  var D = null;
  var Fn = {};

  // v4z: отложенный фолбэк бейджа после смены чата. Живёт здесь: в ядре объявления больше
  // нет — единственные потребители (тело checkConvChange и его таймер) уехали вместе с ним.
  var loaderBadgeTimer = null;

  function __bind(d) {
    D = d;
    with (D) {
  // ---- BIND-зона: детектор смены чата и перехваты навигации ----
  function checkConvChange() {
    var newId = getConvId();
    if (newId !== currentConvId) {
      var oldId = currentConvId;
      currentConvId = newId;
      try { forceRestoreVisibility('conv-switch'); } catch (eVis70) { swallowSoft(eVis70, 'gemini:checkConvChange-visibility-restore'); } // v70: SPA-переход не оставляет скрытый контейнер
      resetForNewConversation();
      // v4z: инвалидация done-флага покинутого чата — при возврате лоадер обязан
      // перезапуститься (DOM уничтожен, «already-done» переживать навигацию не должен)
      try { delete loaderDoneMap[oldId]; } catch (e) { /* ignore */ }
      if (loaderRunningFor === oldId) { loaderRunningFor = null; notifyLoaderState(oldId, false); }
      // v4z: SPA-переход на /app/<id> → автозапуск лоадера полной истории нового чата
      try { maybeStartLoader(); } catch (e) { swallowSoft(e, 'gemini:checkConvChange-loader-start'); }
      // v4z: фолбэк бейджа — если история за 3с не пришла (badge-recv после возврата
      // отсутствует), форсируем существующий virtual-F5/activeRefresh
      if (loaderBadgeTimer) { clearTimeout(loaderBadgeTimer); loaderBadgeTimer = null; }
      loaderBadgeTimer = setTimeout(function () {
        loaderBadgeTimer = null;
        if (getConvId() !== newId || !newId) return;
        if (baseSize() > 0) return;
        debugLog('log', '[AI CM][Gemini][loader] fallback-refresh convId=' + newId);
        try { activeRefresh('фолбэк бейджа после смены чата', false); } catch (e) { swallowSoft(e, 'gemini:checkConvChange-badge-refresh'); }
      }, 3000);
    }
  }

  // ---- установка перехватов: прежний момент, до первого SPA-перехода страницы ----
  try {
    var origPush = history.pushState;
    if (origPush) {
      history.pushState = function () {
        var r = origPush.apply(this, arguments);
        try { checkConvChange(); } catch (e) { /* ignore */ }
        return r;
      };
    }
    var origReplace = history.replaceState;
    if (origReplace) {
      history.replaceState = function () {
        var r = origReplace.apply(this, arguments);
        try { checkConvChange(); } catch (e) { /* ignore */ }
        return r;
      };
    }
    window.addEventListener('popstate', function () { try { checkConvChange(); } catch (e) { /* ignore */ } });
    // LOW-4 (аудит перед релизом): passive:true — обработчик только ЗАПИСЫВАЕТ время
    // скролла (scrollRecentUntil) и никогда не вызывает preventDefault, поэтому браузер
    // не обязан ждать его завершения перед прокруткой (нет scroll-jank). capture:true
    // сохранён: скролл контейнера ленты не всплывает до document — фаза захвата
    // единственная точка, где событие здесь видно.
    document.addEventListener('scroll', function () {
      scrollRecentUntil = Date.now() + 2000;
    }, { capture: true, passive: true });
  } catch (e) { /* ignore */ }

      Fn.checkConvChange = checkConvChange;
    }
  }
  Fn.__bind = __bind;
  if (typeof window !== 'undefined') window.AiCmGeminiSpaLifecycle = Fn;
  if (typeof module !== 'undefined' && module.exports) module.exports = Fn;
}());
