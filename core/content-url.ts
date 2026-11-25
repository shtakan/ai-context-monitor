/**
 * core/content-url.ts — 2.3 Stage 1: URL/chatless-предикаты и сброс состояния
 * на документе GSA без чата.
 *
 * Classic-скрипт в manifest.content_scripts[0].js ПЕРЕД core/content.ts:
 * общий лексический скоуп, только объявления. Top-level кода, читающего
 * состояние content.ts до его выполнения, нет.
 */

type AiCmSwBadgeResetRequest = import('../types/messages').AiCmSwBadgeResetRequest;

/**
 * BUG-11: URL без разговора для сайтов с явной домашней формой.
 * chatgpt — по отсутствию /c/<id>; gemini — ровно /app; aistudio — /prompts
 * и /prompts/new_chat. Остальные сайты сюда не входят (поведение прежнее).
 * @param site siteName адаптера
 * @param path pathname вкладки
 * @param convIdFn функция текущего convId (вызывается только для chatgpt)
 * @returns true — это дом/новый чат, состояние прошлой сессии надо сбросить
 */
function aiCmIsChatlessUrlForSite(site: string, path: string, convIdFn: (() => string | null) | null): boolean {
  if (site === 'chatgpt') return !(typeof convIdFn === 'function' && convIdFn());
  if (site === 'gemini') return /^(?:\/u\/\d+)?\/app\/?$/.test(String(path || ''));
  if (site === 'aistudio') return /^(?:\/app)?\/prompts(?:\/new_chat)?\/?$/.test(String(path || ''));
  return false;
}

// ===== O-34 (N1): холодный вход на URL БЕЗ разговора =====
// Второй путь того же дефекта (первый — SPA-переход, см. checkConvChange в page-intercept.js).
// При прямом открытии URL без /c/<id> (корень чата, новый чат, /gpts) смены истории нет —
// событие ai-cm-conversation-changed не диспатчится, а per-tab бейдж SW и снимок попапа
// (chrome.storage.local) живут на уровне вкладки и переживают навигацию в той же вкладке:
// без явного сброса на экране остаются значения прошлой сессии. Поэтому инициализация на
// URL без разговора сама приводит виджет/бейдж в состояние «нет данных»: состояние гасит
// resetConversationState (единственный механизм сброса), бейдж — BADGE_RESET (та же точка,
// что и на SPA-переходе). Гейт — ТОЛЬКО chatgpt: у него id разговора обязателен в URL
// (getConvIdFromPath), тогда как у Gemini /app/<id> появляется после редиректа, у GSA и
// Claude/DeepSeek/Perplexity id в URL не является признаком «разговор есть» — их поведение
// остаётся байтово прежним (как и щит O-1, скоуп которого тоже chatgpt).
function aiCmResetStaleStateOnChatlessChatGptUrl(): boolean {
  try {
    if (!currentAdapter) return false; var site = currentAdapter.siteName;
    if (!aiCmIsChatlessUrlForSite(site, String((typeof location !== 'undefined' && location && location.pathname) || ''), getCurrentConvId)) return false;
    resetConversationState();
    try { chrome.runtime.sendMessage({ type: 'BADGE_RESET' } as AiCmSwBadgeResetRequest).catch(function () { }); } catch (eBr) { }
    debugLog('log', '[AI CM][spa] O-34: URL без /c/<id> — состояние виджета и бейдж сброшены');
    return true;
  } catch (eChatless) {
    // исключение не выходит за пределы хелпера: инициализация продолжается как прежде
    return false;
  }
}

// ===== O-31: сегментация базы по разговору (Google Search AI) =====
// threadId живого DOM — «какой разговор открыт сейчас» (атрибут GSA; на прочих сайтах '').
function aiCmDomThreadId(): string | null {
  try {
    var el = document.querySelector('[data-session-thread-id]');
    if (!el) return '';
    var v = el.getAttribute('data-session-thread-id');
    return v ? String(v).trim() : '';
  } catch (e) { return ''; }
}

// Снимок принадлежит ТЕКУЩЕМУ разговору? Снимок чужого треда (поздний ответ старого
// разговора после SPA-переключения) в базу не применяется: ни baseCount/baseText (pct),
// ни lastBaseTexts (экспорт), ни счётчики svc-emit-trace. Нет threadId/нет DOM-атрибута —
// прежнее поведение.
function aiCmSnapshotIsCurrentThread(emitThreadId: string | null, domThreadId: string | null): boolean {
  if (!emitThreadId) return true;
  if (!domThreadId) return true;
  return String(emitThreadId) === String(domThreadId);
}

// ===== O-27 (b): признак ЧАТ-страницы GSA для гейта автоэкспорта =====
// Чат-страница Google Search AI определяется ровно двумя признаками: threadId снаффнут
// в DOM ([data-session-thread-id]) ИЛИ в DOM есть чат-контейнер (turn/aimfl). Сервисная
// страница Google (captcha / «подозрительный трафик» /sorry) не содержит ни того, ни
// другого — там база/pct прошлого документа права на файл не дают.
function aiCmGsaChatPageMarker(): boolean {
  try {
    if (typeof aiCmDomThreadId === 'function' && aiCmDomThreadId()) return true;
    if (document.querySelector('[data-scope-id="turn"]')) return true;
    if (document.querySelector('[data-subtree="aimfl"]')) return true;
  } catch (e) { swallowSoft(e, 'content:aiCmGsaChatPageMarker'); }
  return false;
}

// ===== O-27 (c): состояние ПРОШЛОГО документа не переживает не-чат документ GSA =====
// Полная навигация даёт новый экземпляр (состояние и так пусто), но подмена документа
// сервисной страницей (captcha) в живом SPA/документе оставляла базу, pct и pct-latch
// прошлого разговора. Здесь они гасятся — до следующего сетевого EMIT базы нет, гейт
// автоэкспорта молчит. Чат-страница (threadId/контейнер в DOM) не трогается вовсе:
// байты и маска экспорта чат-страниц прежние.
//
// O-27/O-32 (диагностика, только измерение): aiCmGsaDiagState печатает тип документа
// (captcha/чат/поиск) и причину сброса/несброса под гейтом aiCmDebug. Строки «несброс»
// с антиспамом (одна на комбинацию причин за страницу), «сброс» — всегда (событие редкое).
// Поведение не меняется: функция только читает уже посчитанное состояние.
var aiCmGsaDiagNoResetLogged: Record<string, number> = {};
function aiCmGsaDiagState(point: string, verdict: string, reason: string, extra?: Record<string, unknown>) {
  try {
    var doc = (typeof aiCmDiagDocKind === 'function') ? aiCmDiagDocKind() : 'unknown';
    if (verdict === 'no-reset') {
      var key = String(point) + '|' + String(reason) + '|' + String(doc);
      if (aiCmGsaDiagNoResetLogged[key] === 1) return false;
      aiCmGsaDiagNoResetLogged[key] = 1;
    }
    var f: Record<string, unknown> = {
      point: point,
      verdict: verdict,
      reason: reason,
      doc: doc,
      site: (typeof currentAdapter !== 'undefined' && currentAdapter && currentAdapter.siteName) || '',
      baseSeen: (typeof baseSeen !== 'undefined' && baseSeen === true) ? 1 : 0,
      baseComplete: (typeof baseComplete !== 'undefined' && baseComplete === true) ? 1 : 0,
      baseCount: (typeof baseCount === 'number') ? baseCount : 0,
      threadId: (typeof aiCmDomThreadId === 'function') ? aiCmDomThreadId() : ''
    };
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) f[k] = extra[k];
      }
    }
    if (typeof aiCmDiagLine === 'function') aiCmDiagLine('gsa-state', f);
    return true;
  } catch (eDiagState) { return false; }
}
function aiCmGsaResetStaleStateOnChatlessDoc(): boolean {
  try {
    if (!currentAdapter || currentAdapter.siteName !== 'google_search') return false;
    if (typeof document === 'undefined' || document.readyState !== 'complete') {
      aiCmGsaDiagState('reset-stale', 'no-reset', 'doc-not-complete');
      return false;
    }
    if (aiCmGsaChatPageMarker()) {
      aiCmGsaDiagState('reset-stale', 'no-reset', 'chat-page');
      return false;
    }
    var hasState = (baseSeen === true) || (baseComplete === true) || (baseCount > 0);
    if (!hasState) {
      aiCmGsaDiagState('reset-stale', 'no-reset', 'no-stale-state');
      return false;
    }
    resetConversationState();
    aiCmGsaDiagState('reset-stale', 'reset', 'chatless-doc (captcha/search)');
    debugLog('log', '[AI CM][auto-export] site=google_search O-27: документ без чата — ' +
      'база/pct прошлого документа сброшены');
    return true;
  } catch (e) { return false; }
}
