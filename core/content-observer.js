/**
 * core/content-observer.js — 2.4 Stage 9: MutationObserver контент-скрипта.
 *
 * Перенесено move-only из core/content.ts: общий лексический скоуп, тело
 * функции байтово прежнее. Classic-скрипт manifest.content_scripts[0].js
 * ПЕРЕД core/content.ts.
 */
// ========== НАБЛЮДЕНИЕ ==========
function startObserving() {
  if (observer) observer.disconnect();
  let mutationCount = 0;
  observer = new MutationObserver((mutations) => {
    const hasNewText = mutations.some(mutation => {
      // O-24: мутации внутри виджета расширения — НЕ новый текст чата. Виджет пишет себе
      // textContent (percentText, тултип, статус) в том же кадре, что и observer, — раньше
      // каждая такая запись взводила следующий processAndSend (самоподхват).
      if (aiCmIsWidgetNode(mutation.target)) return false;
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (aiCmIsWidgetNode(node)) continue; // O-24: узлы виджета не считаем текстом чата
          if (node.nodeType === 1 && (node.textContent?.trim()?.length ?? 0) > 10) return true;
        }
      }
      return mutation.type === 'characterData';
    });
    if (hasNewText) {
      // O-24 (F6): сигнатурный гард. Сигнатура кэшируется по чату (site|convId), поэтому
      // SPA-возврат в тот же разговор видит СВОЮ сигнатуру, а смена модели/порога на том же
      // тексте проходит (см. ai-cm-dom-emit-request и пути настроек).
      const sigConvId = (typeof getCurrentConvId === 'function') ? (getCurrentConvId() || '') : '';
      if (aiCmLastDomEmitConvId !== sigConvId) {
        aiCmLastDomEmitConvId = sigConvId;
        aiCmLastDomEmitSig = null;
      }
      const sig = aiCmDomTextSig();
      // База не изменилась С МОМЕНТА последнего прохода И автоэкспорт этого чата уже снят
      // (already-fired) → холостой прогон не нужен. Новый ход меняет базу → sig меняется →
      // легитимные эмиты (в т.ч. повторный файл после SPA-возврата/F5) целы.
      if (sig === aiCmLastDomEmitSig && aiCmSiteConvFired()) {
        if (typeof aiCmDiagLine === 'function') {
          aiCmDiagLine('o24-dom-emit-guard', {
            verdict: 'skip-sig-unchanged',
            sig: sig,
            convId: sigConvId || '(none)',
            ms: mutations.length,
            t: Date.now()
          });
        }
        return;
      }
      aiCmLastDomEmitSig = sig;
      mutationCount++;
      if (updateTimer !== null) clearTimeout(updateTimer);
      const delay = Math.min(800 + (mutationCount * 300), 3000);
      updateTimer = setTimeout(() => {
        mutationCount = 0;
        // До инициализации DOM-мутации — единственный сигнал, что в чате появились ходы
        // (живой дефект 2026-11-23: новый чат Gemini, loader ушёл в no-older-history,
        // сетевой парсер ходов не нашёл, isInitialized остался false → бейджа нет).
        if (!isInitialized) {
          if (typeof tryInit === 'function') {
            try { tryInit(); } catch (eInitObs) { swallowSoft(eInitObs, 'content:observer-tryinit'); }
          }
          return;
        }
        processAndSend();
      }, delay);
    }
  });
  observer.observe(document.body, {
    childList: true, subtree: true, characterData: true, attributes: false
  });
  // v48: subtree-наблюдение покрывает и кнопку button.input-area-switch — смена
  // выбранной модели меняет её текст (childList/characterData) → пересчёт pct.
}
