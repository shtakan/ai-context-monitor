/**
 * core/content-process-prelude.js — 2.4 Stage 8: прелюдия processAndSend.
 *
 * Вынесено БЕЗ изменения логики: GSA-reset на chatless-документе, svc-emit-trace,
 * DOM-кэш AI Studio и чтение архивного яруса. Все зависимости — module-scope
 * globals общего content-бандла; возвращает список DOM-адаптера для метрики.
 */
function aiCmProcessPrelude() {
  // O-27 (c): на не-чат документе GSA (captcha/«подозрительный трафик») база/pct прошлого
  // документа гасятся ДО расчёта pct и вызова автоэкспорта — прошлое состояние вердикта
  // не даёт. На чат-странице вызов — no-op (threadId/контейнер в DOM есть).
  try { aiCmGsaResetStaleStateOnChatlessDoc(); } catch (eO27c) { swallowSoft(eO27c, 'content:processAndSend-gsa-stale-reset'); }

  // v81 Step1: диагностический trace для не-Gemini адаптеров (поведение не меняется):
  // факты — у каких сервисов база заполняется через EMIT-канал, у каких история только из адаптера.
  var aiCmDomListS1 = null; // v2.0.31: тот же список адаптера, что у msgs (для DOM-пика AI Studio)
  try {
    var siteNameS1 = currentAdapter.siteName || '';
    if (siteNameS1 && siteNameS1 !== 'gemini') {
      // v82 (D2): baseSeen && тексты → network; !baseSeen → adapter; база есть, текстов нет → none
      var histWritePathS1 = (baseSeen && lastBaseTexts.length > 0) ? 'network'
        : (!baseSeen ? 'adapter' : 'none');
      // O-26 (только диагностика): два счётчика РЯДОМ с msgs — измерение расхождения
      // «msgs в svc-emit ≠ сетевая база». Поведение эмита не меняется: оба считаются из уже
      // существующих переменных, новых источников/кэшей/веток нет, печатаются в ту же
      // debugLog-строку (гейт подробных логов прежний).
      //   netMsgs — размер СЕТЕВОЙ базы: turnsMap перехватчика, доехавший EMIT-ом
      //             (lastBaseTexts = texts18 из detail.messageTexts, тот же массив, что у baseCount);
      //   domMsgs — размер извлечения DOM-адаптера (тот же единственный вызов, что и у msgs).
      var netMsgsS1 = lastBaseTexts.length;
      aiCmDomListS1 = (typeof currentAdapter.extractMessages === 'function') ? currentAdapter.extractMessages() : [];
      var domMsgsS1 = aiCmDomListS1.length;
      // v2.0.34: у Claude/Perplexity DOM-адаптер — намеренная заглушка (источник — сеть).
      // Флаг рядом с msgs=0 объясняет, что это by design, а не сломанный парсер.
      var adapterFlagS1 = (siteNameS1 === 'claude' || siteNameS1 === 'perplexity') ? 'stub' : 'dom';
      debugLog('log', '[AI CM][svc-emit-trace] site=' + siteNameS1 +
        ' convId=' + (getCurrentConvId() || '') +
        ' msgs=' + domMsgsS1 +
        ' domMsgs=' + domMsgsS1 +
        ' netMsgs=' + netMsgsS1 +
        ' histWritePath=' + histWritePathS1 +
        ' adapter=' + adapterFlagS1);
    }
  } catch (eS1) { /* best-effort */ }

  // v2.0.31 (AI Studio): снапшот адаптера в sessionStorage на КАЖДОМ росте msgs.
  // Пик DOM (в замере — 6 реплик) живёт мгновение: лента схлопывается до 2 узлов, и
  // без этой записи после F5 бейдж снова видит 2 хода. Список — тот же, что в trace
  // выше (нового прохода по DOM нет); на прочих сайтах функция выходит по хосту.
  if (aiCmDomListS1 && aiCmDomListS1.length > 0) {
    try { aiCmAistudioDomCacheSave(aiCmDomListS1); } catch (eDomS1) { swallowSoft(eDomS1, 'content:processAndSend-aistudio-dom-cache'); }
  }

  // T1 (v1.16): первый ярус — архив. Читаем импортированный архив для ТЕКУЩЕГО convId
  // (один раз на convId за сессию страницы) и отдаём его в MAIN. Не зависит от
  // tape/лоадера: архив — независимый источник (для не-Gemini сервисов он пока
  // только индикатор источника — оракул/пол живут в Gemini-перехватчике).
  try {
    var cidArc = getCurrentConvId() || '';
    if (cidArc && !aiCmArchiveLoadStarted[cidArc]) {
      aiCmArchiveLoadStarted[cidArc] = true;
      aiCmLoadArchiveTier(cidArc, 'page-load');
    }
  } catch (eArcInit) { swallowSoft(eArcInit, 'content:processAndSend-archive-init'); }

  // 2.4 Stage 8: восстановление ленты Gemini — core/content-tape-restore.js.
  return aiCmDomListS1;
}
