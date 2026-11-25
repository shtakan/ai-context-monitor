/**
 * core/content-aistudio.ts — 2.3 Stage 4: AI Studio.
 *
 * Classic-скрипт в manifest.content_scripts[0].js ПЕРЕД core/content.ts:
 * общий лексический скоуп. Здесь живут сетевая история AI Studio, кэш
 * sessionStorage, нативный счётчик шапки и ingest сетевых detail.
 * Apply/After и слушатель ai-cm-aistudio-net остаются в content.ts и
 * вызывают эти функции в рантайме.
 */

interface AiCmNetMsgsAistudio {
  msgs: Array<{ role: string; text: string; sections?: string; files?: any[] }>;
  count: number;
  ts: number;
  href: string;
  historyComplete?: boolean;
}

// Последняя сетевая история AI Studio: { msgs: [{role,text}], count, ts }.
// Читается adapters/aistudio-adapter.ts через window.__aiCmNetMsgs (тот же ISOLATED-мир).
/** @type {{ msgs: Array<{role: string, text: string}>, count: number, ts: number, href: string, historyComplete?: boolean } | null} */
var aiCmNetMsgsAistudio: AiCmNetMsgsAistudio | null = null;
// Последний promptTokenCount AI Studio: точный размер контекста (0 — ещё не приходил).
var aiCmNetCountAistudio: number = 0;
// v2.0.32: слаг модели AI Studio из тела GenerateContent ('' — сеть ещё не называла модель).
// Зачем отдельная переменная: detectedModelSlug — общий для всех сервисов и сбрасывается
// чужим сайтом/навигацией, а кэшу истории и адаптеру нужно именно «модель этого чата».
var aiCmNetModelSlugAistudio: string = '';
// v2.0.34 (fix base-pending): признак «сеть отдала ПОЛНУЮ историю этого чата».
// Карта по ключу чата (см. aiCmNetReadyKey), а не boolean: доверие обязано не перетекать
// в другой разговор и сбрасываться в resetConversationState. Почему не baseSeen: ось
// baseSeen/baseComplete — сетевой снимок пяти других платформ (он же пишет aiCmHistory
// в storage и участвует в бейдже); AI Studio живёт на adapter-записи (adapterBaseSeen),
// поэтому общую ось не трогаем (R1). Читает ровно один предикат —
// aiCmAutoExportTrustedBase (ветка aistudio); пишет — aiCmIngestAistudioNet.
/** @type {Record<string, boolean>} */
var aiCmNetReadyAistudio: Record<string, any> = {};

/**
 * Ключ готовности сети AI Studio: convId текущего чата (в браузере всегда есть),
 * а в срезах-песочницах без getCurrentConvId — путь '/prompts/<id>'.
 * @returns {string}
 */
function aiCmNetReadyKey(): string {
  try {
    var cid = (typeof getCurrentConvId === 'function') ? (getCurrentConvId() || '') : '';
    if (cid) return cid;
    var p = (typeof aiCmAistudioPathOf === 'function')
      ? aiCmAistudioPathOf(window.location && window.location.href) : '';
    return p ? ('path:' + p) : '';
  } catch (eNrk) { return ''; }
}

/** Сброс признака полноты сети AI Studio (вызов из resetConversationState). */
function aiCmNetReadyAistudioReset(): boolean {
  try {
    if (!aiCmNetReadyAistudio || typeof aiCmNetReadyAistudio !== 'object') return false;
    for (var k in aiCmNetReadyAistudio) {
      if (Object.prototype.hasOwnProperty.call(aiCmNetReadyAistudio, k)) {
        delete aiCmNetReadyAistudio[k];
      }
    }
    return true;
  } catch (eNrReset) {
    swallowSoft(eNrReset, 'content:aistudio-net-ready-reset');
    return false;
  }
}
function aiCmIsAistudioHost(): boolean {
  try {
    return String((window.location && window.location.hostname) || '').indexOf('aistudio.google.com') !== -1;
  } catch (eAih) {
    swallowSoft(eAih, 'content:aistudio-net-host');
    return false;
  }
}

/* ============================================================================================
 * AI Studio: нативный счётчик промпта из шапки чата (v2.0.32)
 *
 * ПОЧЕМУ СВОЙ СЧЁТ НЕ ГОДИТСЯ. AI Studio рисует рядом с названием чата СВОЁ число токенов
 * промпта («9,637 tokens» в живом замере). Оно посчитано движком студии и включает то, чего
 * в DOM реплик НЕТ ВООБЩЕ: системные инструкции/шаблон промпта, схемы включённых инструментов
 * (Grounding with Google Search, Code execution) и всю историю диалога. Наша эвристика видит
 * только реплики — в том же чате 2 узла = 5 353 символа → 1 560 токенов, то есть в 6 раз
 * меньше шапки. Бейдж, который расходится с числом самой студии, читается как дефект, поэтому
 * при наличии шапки берём ЕЁ значение (гейт ниже — строго svc === 'aistudio').
 *
 * КАК ИЩЕМ (без классов Angular — их переименование не должно ломать счётчик).
 * Якорь — <h1> с названием чата: счётчик живёт в том же блоке заголовка. Поднимаемся от h1 на
 * 1–3 уровня и в каждом блоке ищем ЛИСТ с текстом-меткой («tokens» / «токенов»), а число
 * берём у предыдущего соседа (разметка «<span>9,637</span><span>tokens</span>»). Фолбэк —
 * регулярка по тексту блока целиком: «9,637 tokens» / «9 637 токенов». Ограничители:
 * блок заголовка короткий (<= 4000 символов, иначе это уже лента — пропускаем) и число
 * обязано иметь вид целого с разбивкой по три разряда («1.2» — проценты, не токены).
 * ============================================================================================ */

// Метки счётчика в шапке. Русские метки записаны escape-последовательностями: это НЕ
// пользовательские строки интерфейса (M-4.2 их справедливо запрещает), а шаблоны распознавания
// текста, который рисует сам AI Studio в русской локали — они не переводятся и не фолбэкаются.
var AI_CM_AISTUDIO_TOKENS_LABELS: string[] = [
  'tokens', 'token',
  '\u0442\u043e\u043a\u0435\u043d\u043e\u0432', // «токенов»
  '\u0442\u043e\u043a\u0435\u043d\u0430',       // «токена»
  '\u0442\u043e\u043a\u0435\u043d'              // «токен»
];
// Кэш последнего прочитанного значения шапки (троттлинг обхода поддерева заголовка).
var aiCmAistudioNativeTs: number = 0;
var aiCmAistudioNativeValue: number = 0;

/** «9,637» / «1.234.567» / «9 637» → число; проценты и мусор → 0. */
function aiCmAistudioParseCount(s: string): number {
  var raw = String(s == null ? '' : s).replace(/[\u00a0\u202f]/g, ' ').trim();
  if (!raw) return 0;
  // Тысячи группируются по три разряда; «1.2»/«0,5» (проценты) под это правило не попадают.
  if (!/^\d+$/.test(raw) && !/^\d{1,3}(?:[\s.,]\d{3})+$/.test(raw)) return 0;
  var digits = raw.replace(/[^\d]/g, '');
  if (!digits) return 0;
  var v = parseInt(digits, 10);
  if (!isFinite(v) || v <= 0 || v >= 1e8) return 0;
  return v;
}

/** Число токенов внутри блока: пара «метка + соседнее число» либо текст «N tokens». */
function aiCmAistudioTokensInBox(box: Element): number {
  if (!box || typeof box.querySelectorAll !== 'function') return 0;
  var nodes = box.querySelectorAll('*');
  var limit = nodes.length > 400 ? 400 : nodes.length;
  for (var i = 0; i < limit; i++) {
    var el = nodes[i];
    if (el.children && el.children.length > 0) continue; // только листья
    var raw = String(el.textContent || '').trim();
    var txt = raw.toLowerCase();
    // Комбинированный лист «9,637 tokens»: число и метка в одном тексте.
    var comb = /(?:^|[^\d.,])(\d{1,3}(?:[\s.,]\d{3})+|\d+)\s*(?:tokens?|токен\w*)/i.exec(raw);
    if (comb && AI_CM_AISTUDIO_TOKENS_LABELS.indexOf(txt) === -1) {
      var cv = aiCmAistudioParseCount(comb[1]);
      if (cv > 0) return cv;
    }
    if (AI_CM_AISTUDIO_TOKENS_LABELS.indexOf(txt) === -1) continue;
    var prev = el.previousElementSibling;
    var v = aiCmAistudioParseCount(prev ? prev.textContent : '');
    if (v > 0) return v;
    var pText = String((el.parentElement && el.parentElement.textContent) || '')
      .replace(/[\u00a0\u202f]/g, ' ');
    // Число не должно «отрезаться» от десятичной дроби: «1.2 tokens» — это проценты,
    // поэтому перед числом допускается всё, кроме цифры/точки/запятой.
    var m = /(?:^|[^\d.,])(\d{1,3}(?:[\s.,]\d{3})+|\d+)\s*(?:tokens?|токен\w*)/i.exec(pText);
    var pv = m ? aiCmAistudioParseCount(m[1]) : 0;
    if (pv > 0) return pv;
  }
  return 0;
}

/**
 * Нативное число токенов промпта из шапки чата AI Studio; 0 — шапки/числа нет
 * (не AI Studio, библиотека промптов, ещё не отрисовано).
 * @returns {number}
 */
function aiCmAistudioNativePromptTokens(): number {
  try {
    if (!aiCmIsAistudioHost()) return 0;
    // Троттлинг: processAndSend зовётся на каждую мутацию ленты, а здесь обход поддерева
    // заголовка. 400 мс — шапка перерисовывается реже, чем идут мутации, значение то же.
    var nowTs = Date.now();
    if (nowTs - aiCmAistudioNativeTs < 400) return aiCmAistudioNativeValue;
    aiCmAistudioNativeTs = nowTs;
    var found = aiCmAistudioNativeProbe();
    aiCmAistudioNativeValue = found;
    return found;
  } catch (eNat) {
    swallowSoft(eNat, 'content:aistudio-native-tokens');
    return 0;
  }
}

/** Один проход поиска нативного счётчика (без троттлинга — для тестов и троттлера). */
function aiCmAistudioNativeProbe(): number {
  try {
    if (!aiCmIsAistudioHost()) return 0;
    var h1 = document.querySelector('h1');
    if (!h1) return (typeof aiCmAistudioNativeProbeFallback === 'function') ? aiCmAistudioNativeProbeFallback() : 0;
    var box = h1.parentElement;
    for (var up = 0; up < 3 && box; up++) {
      var boxLen = String(box.textContent || '').length;
      // Короткий блок = строка заголовка; длинный — уже лента реплик (там «tokens» в тексте).
      if (boxLen > 0 && boxLen <= 4000) {
        var v = aiCmAistudioTokensInBox(box);
        if (v > 0) return v;
      }
      box = box.parentElement;
    }
  } catch (eNatProbe) {
    swallowSoft(eNatProbe, 'content:aistudio-native-probe');
  }
  return (typeof aiCmAistudioNativeProbeFallback === 'function') ? aiCmAistudioNativeProbeFallback() : 0;
}

/* ============================================================================================
 * AI Studio: кэш разобранной истории в sessionStorage (v2.0.30)
 *
 * ПОЧЕМУ. Холодное открытие /prompts/<id> показывает «2 узла»: DOM AI Studio
 * виртуализирован, а полная история приходит только с ResolveDriveResource /
 * UpdatePrompt (сеть — сотни миллисекунд). Разобранный снимок уже лежал в
 * sessionStorage этой вкладки при прошлой загрузке — отдаём его ДО первого DOM-замера
 * (initialize() стартует через 1.5 с после content.js), а сеть затем перезапишет снимок
 * свежим через тот же ingest.
 *
 * КЛЮЧ. Одна запись на разговор: ai_cm_aistudio_history_<convId> (id из /prompts/<id>),
 * на прочих страницах AI Studio — ai_cm_aistudio_history_href. Значение — строка JSON
 * { v, href, msgs, count, serverTokens, ts }.
 * СБРОС. При смене чата (core/widget.js: resetConversationState) удаляется запись
 * ПРЕДЫДУЩЕГО разговора; «холостой» reset на том же пути кэш не трогает — иначе
 * только что восстановленный снимок стирался бы до первого замера.
 * ============================================================================================ */

var AI_CM_AISTUDIO_CACHE_PREFIX: string = 'ai_cm_aistudio_history_';
var AI_CM_AISTUDIO_CACHE_VERSION: number = 1;
// Ключ, который записали/восстановили последним: сброс при смене чата удаляет именно его.
var aiCmAistudioCacheKeyLast: string = '';
// High-water mark кэша: ключ + максимальный count, который УЖЕ лежит в sessionStorage.
// Зачем: кэш хранит ПИК истории. Живой UpdatePrompt после F5 приходит с коллапсированной
// лентой (2 хода) и без этого отметчика перезаписал бы снимок из 6 ходов — ровно то,
// из-за чего бейдж и показывал «2 узла».
var aiCmAistudioPeakKey: string = '';
var aiCmAistudioPeakCount: number = 0;

function aiCmAistudioSessionStorage(): Storage | null {
  try {
    return (typeof sessionStorage !== 'undefined') ? sessionStorage : null;
  } catch (eSs) {
    swallowSoft(eSs, 'content:aistudio-cache-storage');
    return null;
  }
}

/** pathname из абсолютного href (SPA-гард тот же, что у адаптера); иначе — как есть. */
function aiCmAistudioPathOf(href: string): string {
  var s = String(href || '');
  if (!s) return '';
  try {
    return (typeof URL === 'function') ? new URL(s).pathname : s;
  } catch (eUp) {
    return s;
  }
}

/** Ключ кэша текущего (или переданного) разговора. */
function aiCmAistudioCacheKey(href?: string): string {
  var h = String(href || (window.location && window.location.href) || '');
  var p = aiCmAistudioPathOf(h);
  var m = /\/prompts\/([^\/?#]+)/.exec(p);
  if (m && m[1]) return AI_CM_AISTUDIO_CACHE_PREFIX + m[1];
  return h ? AI_CM_AISTUDIO_CACHE_PREFIX + 'href' : '';
}

/** Пик для ключа: при смене разговора отметка обнуляется (кэш у каждого свой). */
function aiCmAistudioPeakOf(key: string): number {
  if (key !== aiCmAistudioPeakKey) {
    aiCmAistudioPeakKey = key;
    aiCmAistudioPeakCount = 0;
  }
  return aiCmAistudioPeakCount;
}

/** Запись снимка в sessionStorage; ошибки хранилища (quota/private) — не фатальны. */
function aiCmAistudioHistoryCacheSave(): boolean {
  try {
    if (!aiCmNetMsgsAistudio || !Array.isArray(aiCmNetMsgsAistudio.msgs)
      || aiCmNetMsgsAistudio.msgs.length === 0) return false;
    var ss = aiCmAistudioSessionStorage();
    if (!ss) return false;
    var key = aiCmAistudioCacheKey(aiCmNetMsgsAistudio.href);
    if (!key) return false;
    // Сжатие истории (коллапс ленты после F5) кэш-пик не перезаписывает.
    if (aiCmNetMsgsAistudio.msgs.length < aiCmAistudioPeakOf(key)) return false;
    ss.setItem(key, JSON.stringify({
      v: AI_CM_AISTUDIO_CACHE_VERSION,
      href: aiCmNetMsgsAistudio.href,
      msgs: aiCmNetMsgsAistudio.msgs,
      count: aiCmNetMsgsAistudio.count,
      serverTokens: (typeof aiCmNetCountAistudio === 'number') ? aiCmNetCountAistudio : 0,
      // v2.0.32: модель чата — иначе после F5 бейдж показывал дефолт ('Gemini 3.1 Pro')
      // при живом 'gemini-3.8-flash' (слаг приходит только с тела GenerateContent).
      model: aiCmNetModelSlugAistudio || '',
      ts: aiCmNetMsgsAistudio.ts
    }));
    aiCmAistudioCacheKeyLast = key;
    aiCmAistudioPeakCount = aiCmNetMsgsAistudio.msgs.length;
    return true;
  } catch (eSave) {
    swallowSoft(eSave, 'content:aistudio-cache-save');
    return false;
  }
}

/** Восстановление кэша текущего разговора в тот же ingest, что и живая сеть. */
function aiCmAistudioHistoryCacheRestore(): boolean {
  try {
    if (!aiCmIsAistudioHost()) return false;
    var ss = aiCmAistudioSessionStorage();
    if (!ss) return false;
    var key = aiCmAistudioCacheKey();
    if (!key) return false;
    // Ключ запоминаем ДО чтения: сброс при смене чата должен знать, что удалять.
    aiCmAistudioCacheKeyLast = key;
    var raw = ss.getItem(key);
    if (!raw) return false;
    var cached = null;
    try { cached = JSON.parse(raw); } catch (ePc) { cached = null; }
    if (!cached || cached.v !== AI_CM_AISTUDIO_CACHE_VERSION) return false;
    if (!Array.isArray(cached.msgs) || cached.msgs.length === 0) return false;
    // Кэш другого разговора (SPA-подмена пути) не берём — инвариант адаптера.
    var here = aiCmAistudioPathOf(window.location && window.location.href);
    var there = aiCmAistudioPathOf(cached.href);
    if (here && there && here !== there) return false;
    aiCmAistudioPeakOf(key);
    aiCmAistudioPeakCount = cached.msgs.length;
    // v2.0.32: модель из прошлой загрузки — до первого GenerateContent адаптер иначе
    // отдавал дефолт ('gemini-3.1-pro') и бейдж называл не ту модель.
    if (typeof cached.model === 'string' && cached.model) {
      aiCmNetModelSlugAistudio = cached.model;
      window.__aiCmNetModelSlug = cached.model;
      detectedModelSlug = cached.model;
    }
    return aiCmIngestAistudioNet({
      kind: 'history',
      msgs: cached.msgs,
      count: cached.count,
      serverTokens: cached.serverTokens,
      ts: cached.ts,
      href: cached.href,
      cached: true
    });
  } catch (eRestore) {
    swallowSoft(eRestore, 'content:aistudio-cache-restore');
    return false;
  }
}

/** Сброс кэша предыдущего разговора при смене чата (вызов из resetConversationState). */
function aiCmAistudioHistoryCacheClear(): boolean {
  try {
    if (!aiCmIsAistudioHost()) return false;
    var prev = aiCmAistudioCacheKeyLast;
    if (!prev) return false;
    var now = aiCmAistudioCacheKey();
    if (prev === now) return false; // тот же разговор: снимать нечего
    var ss = aiCmAistudioSessionStorage();
    if (ss) ss.removeItem(prev);
    aiCmAistudioCacheKeyLast = '';
    aiCmAistudioPeakKey = '';
    aiCmAistudioPeakCount = 0;
    // v2.0.32: модель ПРЕДЫДУЩЕГО чата не должна подписывать новый (SPA-подмена пути).
    aiCmNetModelSlugAistudio = '';
    window.__aiCmNetModelSlug = '';
    return true;
  } catch (eClear) {
    swallowSoft(eClear, 'content:aistudio-cache-clear');
    return false;
  }
}

/**
 * ДОМ-пик: снимок адаптера в sessionStorage на КАЖДОМ росте msgs (v2.0.31).
 *
 * ПОЧЕМУ НЕ ХВАТАЛО СЕТЕВОГО СОХРАНЕНИЯ. Сеть приходит не всегда: ResolveDriveResource
 * на холодном открытии /prompts/<id> отдаёт не ту форму, которую ждёт msgsFromSnapshot
 * (разбор — 0 сообщений), а UpdatePrompt до первого хода вообще не вызывается. При этом
 * сам DOM в момент роста отрисовки содержит историю (в замере — 6 реплик), а через
 * мгновение схлопывается до 2 виртуализированных узлов. Раньше кэш писался только из
 * сетевого снимка, поэтому этот пик терялся и после F5 бейдж снова видел «2 узла».
 *
 * КОГДА. Вызывается из processAndSend() с уже извлечённым списком адаптера (отдельного
 * прохода по DOM эта функция не добавляет). Пишется только РОСТ: count больше, чем
 * high-water mark этого разговора (restore и сетевое сохранение его поднимают).
 * Значение — та же схема { v, href, msgs, count, serverTokens, ts }, что у сетевого
 * кэша, поэтому читается тем же aiCmAistudioHistoryCacheRestore при следующей загрузке.
 * @param {Array<{role: string, text?: string, content?: string}>|null} list — extractMessages()
 * @returns {boolean} true, если снимок записан
 */
function aiCmAistudioDomCacheSave(list: any[]): boolean {
  try {
    if (!aiCmIsAistudioHost()) return false;
    if (!Array.isArray(list) || list.length === 0) return false;
    var ss = aiCmAistudioSessionStorage();
    if (!ss) return false;
    var href = String((window.location && window.location.href) || '');
    var key = aiCmAistudioCacheKey(href);
    if (!key) return false;
    if (list.length <= aiCmAistudioPeakOf(key)) return false;
    var msgs = [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (!m) continue;
      var text = (typeof m.text === 'string') ? m.text
        : ((typeof m.content === 'string') ? m.content : '');
      if (text.length === 0) continue;
      msgs.push({ role: (m.role === 'assistant' || m.role === 'model') ? 'assistant' : 'user', text: text });
    }
    if (msgs.length === 0) return false;
    ss.setItem(key, JSON.stringify({
      v: AI_CM_AISTUDIO_CACHE_VERSION,
      href: href,
      msgs: msgs,
      count: msgs.length,
      serverTokens: (typeof aiCmNetCountAistudio === 'number') ? aiCmNetCountAistudio : 0,
      model: aiCmNetModelSlugAistudio || '',
      ts: Date.now()
    }));
    aiCmAistudioCacheKeyLast = key;
    aiCmAistudioPeakCount = msgs.length;
    debugLog('log', '[AI CM][aistudio-cache] dom-peak key=' + key + ' msgs=' + msgs.length);
    return true;
  } catch (eDomSave) {
    swallowSoft(eDomSave, 'content:aistudio-dom-cache-save');
    return false;
  }
}

/**
 * Единая точка приёма сетевого detail: живое событие моста и восстановление из кэша.
 * Возвращает true, если счётчик/история реально сменились (нужно для пересчёта бейджа).
 * @param {object|null} detail
 * @returns {boolean}
 */
function aiCmIngestAistudioNet(detail: any): boolean {
  if (!detail) return false;
  var changed = false;
  if (detail.kind === 'count') {
    var serverTokens = (typeof detail.serverTokens === 'number')
      ? detail.serverTokens
      : parseInt(detail.serverTokens, 10);
    if (isFinite(serverTokens) && serverTokens > 0 && serverTokens !== aiCmNetCountAistudio) {
      aiCmNetCountAistudio = serverTokens;
      // Та же переменная состояния, что у сетевого снимка (state.js): серверный
      // счётчик главнее эвристики, пока новая сеть его не перезапишет.
      netServerTokens = serverTokens;
      changed = true;
    }
  } else if (detail.kind === 'history' && Array.isArray(detail.msgs) && detail.msgs.length > 0) {
    /** @type {any[]} */
    var msgs = [];
    for (var i = 0; i < detail.msgs.length; i++) {
      var m = detail.msgs[i];
      if (!m || typeof m.text !== 'string') continue;
      var sections = (typeof m.sections === 'string') ? m.sections : '';
      // Секции вложений (plan-aistudio-files.md): текст может быть пустым,
      // если у хода был только файл — пустой USER: без секций недопустим.
      if (m.text.length === 0 && sections.length === 0) continue;
      /** @type {any} */
      var rec: any = { role: (m.role === 'assistant' || m.role === 'model') ? 'assistant' : 'user', text: m.text };
      if (sections) rec.sections = sections;
      if (Array.isArray(m.files) && m.files.length > 0) rec.files = m.files;
      msgs.push(rec);
    }
    if (msgs.length > 0) {
      var prev = aiCmNetMsgsAistudio;
      var href = String(detail.href || window.location.href || '');
      var shrunk = false;
      // v2.0.34: живой UpdatePrompt после F5 приходит коллапсированной лентой (2 хода).
      // Снимок того же разговора меньшего размера не затирает уже увиденный полный:
      // иначе window.__aiCmNetMsgs схлопывался до 2 узлов и адаптер отдавал обрезок.
      if (prev && Array.isArray(prev.msgs) && prev.msgs.length > msgs.length
        && aiCmAistudioPathOf(prev.href) === aiCmAistudioPathOf(href)) {
        msgs = prev.msgs;
        shrunk = true;
      }
      aiCmNetMsgsAistudio = {
        msgs: msgs,
        count: msgs.length,
        ts: (shrunk && prev) ? prev.ts : ((typeof detail.ts === 'number') ? detail.ts : Date.now()),
        href: href,
        historyComplete: !shrunk
      };
      // Общая точка для адаптера: ISOLATED-мир один, отдельного канала не нужно.
      window.__aiCmNetMsgs = aiCmNetMsgsAistudio; if (typeof aiCmApplyAistudioNetBase === 'function') aiCmApplyAistudioNetBase();
      // v2.0.34 (fix base-pending): взводим доверие к базе ТОЛЬКО на полном снимке
      // (historyComplete === true, т.е. !shrunk) и только если снимок относится к
      // текущему пути: поздний ответ чужого чата не должен открыть экспорт этого.
      if (!shrunk) {
        var readyKey = (typeof aiCmNetReadyKey === 'function') ? (aiCmNetReadyKey() || '') : '';
        var herePath = aiCmAistudioPathOf(window.location && window.location.href);
        var netPath = aiCmAistudioPathOf(href);
        if (readyKey && (!herePath || !netPath || herePath === netPath)) {
          aiCmNetReadyAistudio[readyKey] = true;
        }
      }
      changed = !prev || prev.count !== msgs.length || prev.ts !== aiCmNetMsgsAistudio.ts;
      // Кэш хранит и точный promptTokenCount: после F5 бейдж считает pct от него,
      // не дожидаясь нового GenerateContent.
      var cachedTokens = (typeof detail.serverTokens === 'number')
        ? detail.serverTokens
        : parseInt(detail.serverTokens, 10);
      if (isFinite(cachedTokens) && cachedTokens > 0 && cachedTokens !== aiCmNetCountAistudio) {
        aiCmNetCountAistudio = cachedTokens;
        netServerTokens = cachedTokens;
      }
    }
  }
  if (!changed) return false;
  debugLog('log', '[AI CM][aistudio-net] kind=' + detail.kind +
    ' msgs=' + (aiCmNetMsgsAistudio ? aiCmNetMsgsAistudio.count : 0) +
    ' serverTokens=' + aiCmNetCountAistudio +
    (detail.cached ? ' source=session-cache' : ''));
  // Пересчёт бейджа/pct тем же путём, что и приход сетевого снимка у других сервисов.
  if (typeof aiCmAfterAistudioNetKick === 'function') {
    aiCmAfterAistudioNetKick();
  }
  return true;
}

// Восстановление ДО initialize() (setTimeout 1500 выше): первый DOM-замер обязан
// увидеть полную историю из прошлой загрузки, а не 1-2 виртуализированных узла.
aiCmAistudioHistoryCacheRestore();

// [aistudio-bridge:end]

/**
 * BIG-27 (2.1.5): запасной путь нативного счётчика AI Studio для нового UI (нет h1 или
 * заголовок переехал). Платформа печатает «2,752 tokens» под названием чата; берём ПЕРВОЕ
 * совпадение в верхней части main (до 1 500 символов), чтобы не поймать «tokens» из текста
 * ответа ниже. Это авторитетное число: включает системные инструкции, thinking и схемы
 * инструментов, которых в DOM-репликах нет.
 */
function aiCmAistudioNativeProbeFallback(): number {
  try {
    if (!aiCmIsAistudioHost()) return 0;
    // Точный узел счётчика в текущем UI: <span class="… v3-token-count-value …">4,533  tokens</span>.
    var direct = document.querySelector('.v3-token-count-value');
    if (direct) {
      var dt = String(direct.textContent || '').trim();
      var dm = dt.match(/([\d][\d\s.,]*)\s*tokens?/i);
      if (dm) {
        var dn = parseInt(String(dm[1]).replace(/[^\d]/g, ''), 10);
        if (isFinite(dn) && dn > 0 && dn < 100000000) return dn;
      }
    }
    var root = document.querySelector('main') || document.body;
    if (!root) return 0;
    // Новый UI печатает «4,533 tokens» отдельным коротким элементом; классы/иерархия
    // меняются от сборки к сборке. Ищем ЛИСТОВОЙ узел, весь текст которого — число+tokens.
    var nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (var i = 0; i < nodes.length && i < 4000; i++) {
      var el = nodes[i];
      if (el.children && el.children.length > 0) continue;
      var t = String(el.textContent || '').trim();
      if (!t || t.length > 24) continue;
      var m = t.match(/^([\d][\d\s.,]*)\s*tokens?$/i);
      if (!m) continue;
      var num = parseInt(String(m[1]).replace(/[^\d]/g, ''), 10);
      if (!isFinite(num) || num <= 0 || num > 100000000) continue;
      return num;
    }
    return 0;
  } catch (eFb) { return 0; }
}

/**
 * BIG-17 (2.1.5): для AI Studio модель берём из DOM (Run settings: slug `gemini-4-hydrogen`)
 * раньше сети: сетевой slug мог остаться от прошлого запроса. Прочие сайты — прежняя
 * лестница попап → DOM-адаптер → сеть.
 */
function aiCmAistudioDomSlug(): string {
  try {
    if (!aiCmIsAistudioHost()) return '';
    if (typeof currentAdapter === 'undefined' || !currentAdapter) return '';
    if (typeof currentAdapter.detectModel !== 'function') return '';
    var m = currentAdapter.detectModel() || '';
    return (typeof m === 'string') ? m : '';
  } catch (eDomSlug) { return ''; }
}
