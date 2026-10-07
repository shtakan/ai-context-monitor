// =============================================================================
// core/deepseek-conv.js — Step D.5 (декомпозиция core/deepseek-intercept.js).
// K1: CONV ID + ДЕТЕКТОР СМЕНЫ ЧАТА (СЕКЦИЯ 3 ядра, строки 244-338 HEAD 6c899fd,
// ~95 строк) — getConvId (парсер /a/chat/s/<id> и /a/chat/<id> из location.pathname),
// resetForNewConversation (полный сброс состояния перехватчика на смену разговора),
// checkConvChange (сравнение свежего convId с текущим) и патчи history.pushState /
// history.replaceState / window.popstate, которые этот детектор взводят.
//
// Кластер вынесен по образцу шагов D.1 (core/deepseek-diag.js), D.2
// (core/deepseek-netsync.js), D.3 (core/deepseek-refetch.js) и D.4
// (core/deepseek-parse.js). Раньше все части жили в ОДНОМ IIFE, поэтому кластер
// обращался к состоянию ядра по именам. Теперь у модуля свой IIFE, и зависимости ядра
// приходят через __bind(deps).
//
// РАЗДЕЛЕНИЕ ПО SCOPE. Тела перенесены БАЙТ-В-БАЙТ и без префиксов D. Все три тела
// (getConvId, resetForNewConversation, checkConvChange) и патчи pushState/replaceState/
// popstate объявлены В ОДНОЙ BIND-зоне — внутри `with (D) { … }` — и вот почему:
//   • ЛЕКСИЧЕСКИЙ СКОУП, А НЕ СКОРОСТЬ. Функция, объявленная ВНЕ `with (D)`, НЕ видит
//     bind-имена: её замыкание не включает with-окружение, созданное в __bind. Зов из
//     with-обёртки тут не спасает — резолв идёт по замыканию объявления, а не по месту
//     вызова. Репро (tools/_repro-with.js): тело, объявленное вне with, падает на первом
//     же свободном имени (ReferenceError: currentConvId is not defined), а объявленное
//     внутри — работает. Поэтому даже getConvId (ему из ядра нужен только location)
//     обязан жить в BIND: checkConvChange, объявленный рядом, зовёт его, а currentConvId
//     вообще принадлежит ядру. PURE-зона держит ровно байтовый заголовок СЕКЦИИ 3.
//   • ЦЕНА with ЗДЕСЬ НУЛЕВАЯ. Урок D.1 (81 мс вне with против 3309 мс в with на
//     200×200 КБ) касается ГОРЯЧИХ перебайтовых циклов — в K1 таких нет: парсинг пути,
//     три присваивания счётчиков и обход патчей, то есть единицы резолвов на навигацию,
//     а не на байт. Формально BIND, фактически — холодный путь.
//   • ПАТЧИ СТАВЯТСЯ НА ЗАГРУЗКЕ МОДУЛЯ. Блок `try { history.pushState = … }` лежит в
//     BIND-зоне, но BIND-зона исполняется на РАННЕЙ связке __bind({}): ядро зовёт её
//     сразу после объявления загрузчика, ещё до инициализации currentConvId (см. ниже),
//     поэтому патчи pushState/replaceState/popstate стоят уже к первому SPA-переходу
//     страницы. Ранней связки достаточно: getConvId из D не читает НИЧЕГО (location —
//     глобал), а checkConvChange и popstate-слушатель зовутся позже. ПОЛНАЯ связка — в
//     конце IIFE ядра, там же, где связки D.1-D.4.
// Байтовая идентичность тел сохранена.
//
// СОСТОЯНИЕ: currentConvId ОСТАЛСЯ В ЯДРЕ — переменная входит в контракты диагностики
// D.1 (ro) и сетевого дозапроса D.2 (ro), а читает её половина оставшихся секций
// (emit-композиция, ingest, guard-хуки K9/K11). Модуль получает её rw-парой и видит
// ТУ ЖЕ переменную, а не копию: resetForNewConversation и checkConvChange её
// ПЕРЕЗАПИСЫВАЮТ (без сеттера запись в sloppy-режиме молча терялась бы — детектор
// смены чата не замечал бы новый разговор и сброс не срабатывал бы вовсе).
// lastDiagConvId — тоже переменная ЯДРА (её объявляет связка D.1): rw-пара, потому что
// resetForNewConversation читает её как prevConv и перезаписывает текущим convId.
// Остальное состояние сброса (turnsMap/orderCounter/attach*/logged*/lastLoadedConvId/
// lastHistoryUrl/historyRefetchDone/lastBaseServerTokens/lastBaseChatMode/live*/
// netSnapshotAt/netTurnIds/lastTurnDoneAt) отдано rw-парами ровно там, где тело
// ПЕРЕЗАПИСЫВАЕТ переменную (без сеттера сброс молча терялся бы); histCompletion —
// ro-геттер: тело мутирует ПОЛЯ объекта, а не переприсваивает имя, и мутация по ссылке
// видна ядру без сеттера. diagResetForConv и resetStreamState переданы значением
// (function declaration ядра хойстятся — значения доступны на момент связки),
// scheduleHistoryRefetch — ro-геттер: в ядре это форвардер модуля D.3.
//
// ЧТО НЕ УЕХАЛО: объявления (lastAuthHeaders … histCompletion) и O-22-слушатель
// resetForNewConversation→lastDispatchSig ОСТАЛИСЬ в ядре: lastAuthHeaders/lastHistoryUrl/
// historyRefetchDone/histCompletion-флаги читают fetch-хук (K11), XHR-копилка (K9), приём
// снимка (K5) и emit-композиция (K3/K4), а lastDispatchSig/lastDispatchResult пишет сам
// emit-гард O-22. Их переезд означал бы правку K3-K11 (запрещено рамками шага).
// Порядок подключения (core/background.js, registerSafe 'ai-cm-deepseek-intercept-v7',
// document_start, world MAIN): utils/debug.js -> core/deepseek-diag.js ->
// core/deepseek-netsync.js -> core/deepseek-refetch.js -> core/deepseek-parse.js ->
// ЭТОТ ФАЙЛ -> core/deepseek-intercept.js. До связки на window.AiCmDeepseekConv лежит
// только __bind; после связки ядро раздаёт 2 из 3 тел форвардерами по прежним именам
// (getConvId, resetForNewConversation — function declaration, хойстятся: вызовы в
// emit-композиции, guard-хуках K9/K11 и сбросе чата выше по файлу не тронуты).
// checkConvChange наружу не выдаётся: его зовут только патчи и popstate-слушатель
// этого же модуля (в ядре он был локальным).
// Экспорт: window.AiCmDeepseekConv + module.exports.
// =============================================================================
(function () {
  if (typeof window !== 'undefined' && window.AiCmDeepseekConv) return;

  // Зависимости ядра. Заполняется один раз через __bind(...) из core/deepseek-intercept.js.
  var D = null;
  var Fn = {};

  // ---- PURE-зона: тела без зависимости от ядра (состояние кластера — в ядре) ----
  // ===== СЕКЦИЯ 3: CONV ID + ДЕТЕКТОР СМЕНЫ ЧАТА (образец: gemini v17 + page-intercept v11) =====
  function getConvId() {
    try {
      var m = location.pathname.match(/\/a\/chat\/s\/([A-Za-z0-9_-]+)/);
      if (m) return m[1];
      m = location.pathname.match(/\/a\/chat\/([A-Za-z0-9_-]+)/);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }

  function __bind(d) {
    D = d;
    with (D) {
  // ---- BIND-зона: тела K1, читающие живое состояние ядра через with (D) ----

  function resetForNewConversation() {
    if (!D || Object.keys(D).length === 0) { return; }   // ранняя связка: ядро ещё не отдало состояние
    diagResetForConv('conv-change', lastDiagConvId);   // O-18 (ИЗМЕРЕНИЕ): кольца — на один convId
    lastDiagConvId = currentConvId;                    // O-18 (ИЗМЕРЕНИЕ)
    turnsMap = {};
    orderCounter = 0;
    attachTokens = 0;
    attachBreak = { imgTokens: 0, docTokens: 0, imgCount: 0, docCount: 0 };
    loggedOk = false;
    loggedHistory = false;
    loggedRealtime = false;
    lastLoadedConvId = '';
    lastHistoryUrl = '';          // v6
    historyRefetchDone = false;   // v6
    histCompletion.historyComplete = false;  // v7: новая база ещё не подтверждена
    histCompletion.reachedRoot = false;      // v7
    histCompletion.baseEmpty = false;        // v11 (O-17)
    lastBaseServerTokens = 0;                // v11 (O-17)
    lastBaseChatMode = '';                   // v11 (O-17)
    // v12 (O-18, фаза 2): live-кэш ходов и состояние сетевого дозапроса — на один чат
    liveTurns = {};
    liveTurnOrder = [];
    netSnapshotAt = 0;
    netTurnIds = {};
    lastTurnDoneAt = 0;
    resetStreamState();
    console.log('[deepseek-intercept] смена чата → состояние перехватчика сброшено (convId=' + (currentConvId || '(не чат)') + ')');
    try { window.dispatchEvent(new CustomEvent('ai-cm-conversation-changed')); } catch (e) { }
    scheduleHistoryRefetch();
  }

  function checkConvChange() {
    var newId = getConvId();
    if (newId !== currentConvId) {
      currentConvId = newId;
      resetForNewConversation();
    }
  }

  try {
    var origPush = history.pushState;
    if (origPush) {
      history.pushState = function () {
        var r = origPush.apply(this, arguments);
        try { checkConvChange(); } catch (e) { }
        return r;
      };
    }
    var origReplace = history.replaceState;
    if (origReplace) {
      history.replaceState = function () {
        var r = origReplace.apply(this, arguments);
        try { checkConvChange(); } catch (e) { }
        return r;
      };
    }
    window.addEventListener('popstate', function () { try { checkConvChange(); } catch (e) { } });
  } catch (e) { }

      Fn.getConvId = getConvId;
      Fn.resetForNewConversation = resetForNewConversation;
      Fn.checkConvChange = checkConvChange;
    }
  }
  Fn.__bind = __bind;
  if (typeof window !== 'undefined') window.AiCmDeepseekConv = Fn;
  if (typeof module !== 'undefined' && module.exports) module.exports = Fn;
}());
