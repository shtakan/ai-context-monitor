/**
 * core/content-manual-export.ts — 2.4 Stage 5: ручной экспорт текущего чата.
 *
 * Classic-скрипт manifest.content_scripts[0].js ПЕРЕД core/content.ts: общий
 * лексический скоуп. Здесь слушатель aiCmExportCurrent: снимок ТОЛЬКО текущего
 * convId, синхронный flush незакрытого стрима, ожидание очереди вложений /
 * сетевого дозапроса, канонизация массива, проекция файла и dedupe.
 *
 * Состояние, adapter и host-API приходят через dependency object AiCmManualExportHost:
 * модуль не читает DOM/chrome/state напрямую. Точки вызова (chrome.runtime.onMessage)
 * и побочные эффекты (sendResponse, drain/net-sync) остаются в content.ts и
 * base-handler/export-manager.
 */

type AiCmManualExportMessage = import('../types/export').ExportMessage;
type AiCmManualSnapshot = import('../types/messages').AiCmManualSnapshot;
type AiCmExportCurrentResponse = import('../types/messages').AiCmExportCurrentResponse;

/** Снимок контекста: та же форма, что читает бейдж/попап (core/state.ts). */
interface AiCmManualExportSnapshot {
  modelName?: string;
  limit?: number;
  contextLimit?: number;
  windowLimit?: number;
  accountLimit?: number | null;
  limitPlan?: string | null;
  limitWarnings?: string[];
  saturated?: boolean;
  partial?: boolean;
  partialReason?: string;
}

/** Последний снимок токенов: только поля, которые нужны ручному файлу. */
interface AiCmManualExportTokenSnapshot {
  src?: string;
  saturated?: boolean;
}

/**
 * Dependency object ручного экспорта. Значения, которые могут измениться за время
 * ожидания file-drain/net-sync, читаются лениво — геттерами; функции-хелперы
 * необязательны ровно там, где в прежнем коде стоял typeof-гард.
 */
interface AiCmManualExportHost {
  getCurrentConvId(): string;
  getHostname(): string;
  getSiteName(): string;
  getResolvedModelId(): string;
  getSnapshotModelName(): string;
  getTokenCount(): number;
  getPercentage(): number;
  getTokenSnapshot(): AiCmManualExportTokenSnapshot | null;
  isBaseComplete(): boolean;
  getMessages(): AiCmManualExportMessage[];
  getLastDetailMessages(): AiCmManualExportMessage[] | null;
  getEffectiveLimit(modelId: string): number;

  flushLiveStream(convId: string): void;
  dumpTurnsSnapshot(tag: string, convId: string, messages: AiCmManualExportMessage[]): void;
  swallowSoft(error: unknown, reason: string): void;
  debugLog(level: string, message: string): void;

  getCanonicalConvId?: (fallback: string) => string;
  readSnapshot?: (convId: string) => AiCmManualExportSnapshot | null;
  getSourceTier?: () => string | undefined;
  partialView?: (snapshot: AiCmManualExportSnapshot | null) => { partial?: true; partialReason?: string };
  isQwenExportBaseTrusted?: () => boolean;
  unionFileMessages?: (convId: string, messages: AiCmManualExportMessage[], lowConfidence: boolean) => AiCmManualExportMessage[];
  canonicalizeMessages?: (messages: AiCmManualExportMessage[], site: string) => AiCmManualExportMessage[];
  projectFileMessages?: (messages: AiCmManualExportMessage[], site: string) => { messages: AiCmManualExportMessage[]; mode: string };
  buildCanonicalBody?: (convId: string) => { messages: AiCmManualExportMessage[] } | null;
  dedupeInfo?: (detail: AiCmManualExportMessage[] | null, messages: AiCmManualExportMessage[]) => AiCmManualSnapshot['dedupe'];

  isNetSyncSite?: () => boolean;
  filesThenNetSync?: (convId: string, cb: () => void) => void;
  netSyncThen?: (convId: string, cb: () => void) => void;
  isFilesDrainSite?: () => boolean;
  filesDrainThen?: (convId: string, cb: () => void, timeoutMs: number) => void;
}

type AiCmManualExportRoute = 'files-then-net' | 'net' | 'files-drain' | 'direct';

interface AiCmManualExportRouteInput {
  netSyncSite: boolean;
  hasFilesThenNetSync: boolean;
  hasNetSyncThen: boolean;
  filesDrainSite: boolean;
  hasFilesDrainThen: boolean;
}

/**
 * Порядок ожиданий перед сборкой файла (прежний, R2):
 * net-sync (файлы + сеть) → сеть → дренаж файлов → сразу.
 */
function resolveManualExportRoute(input: AiCmManualExportRouteInput): AiCmManualExportRoute {
  if (input.netSyncSite === true) {
    if (input.hasFilesThenNetSync === true) return 'files-then-net';
    if (input.hasNetSyncThen === true) return 'net';
  }
  if (input.filesDrainSite === true && input.hasFilesDrainThen === true) return 'files-drain';
  return 'direct';
}

/**
 * Ручной/принудительный экспорт — снимок ТОЛЬКО текущего convId.
 * После SPA-перехода lastBaseTexts сброшены (resetConversationState) → messages=[]
 * (файл-заглушка); НИКОГДА не отдаём историю предыдущего разговора.
 */
function aiCmHandleManualExport(
  sendResponse: (response: AiCmExportCurrentResponse) => void,
  host: AiCmManualExportHost
): void {
  var curCidExp = host.getCurrentConvId() || '';
  // O-16: если у DeepSeek прямо сейчас читается тело ответа (SSE ещё не закрыт),
  // сначала СИНХРОННО сбрасываем незакрытый буфер потока в memory-базу — иначе в
  // файл уйдёт ход ассистента, обрезанный на текущем чанке. Мост синхронный:
  // flush → finalizeRealtimeTurn → EMIT ai-cm-full-history → lastBaseTexts обновлены
  // ДО buildHistoryMessages() ниже.
  try { host.flushLiveStream(curCidExp); } catch (eFlushExp) { host.swallowSoft(eFlushExp, 'content:aiCmAutoExportTrustedBaseDiag-flush'); }
  var pctRaw = host.getPercentage();
  var pctExp = (typeof pctRaw === 'number' && pctRaw >= 0) ? pctRaw : 0;
  // v61diag: дамп turnsMap в момент ручного экспорта (md/txt из options).
  // O-9-подпись: источник подписи — КАНОНИЧЕСКАЯ база текущего снимка, ровно тот же
  // массив, что уходит в файл (buildHistoryMessages() → detail.messages/lastBaseTexts).
  // Раньше третьим аргументом шёл null, и у сервисов без MAIN-моста turns-snap
  // (Perplexity: перехватчик на ai-cm-turns-snap-request не отвечает) подпись печатала
  // msgs=0 firstText="" при живой истории. Приоритет моста не тронут: ответил MAIN
  // (Gemini/DeepSeek O-17) — печатаются ЕГО числа, фолбэк не подставляется.
  try { host.dumpTurnsSnapshot('snapshot-at-manual', curCidExp, host.getMessages()); } catch (eDumpM) { }
  // O-18 (фаза 2): ПЕРЕД композицией файла — сетевой дозапрос истории текущего чата
  // (только DeepSeek; таймаут 3 с внутри aiCmExportNetSyncThen). Перехватчик сам решает,
  // нужен ли запрос, и сам выбирает текст по ходам (EQUAL → live, MIDDLE-HOLE/TAIL-CUT →
  // сеть, ONE-SIDE → live + маркер). Не дождались/сети нет → прежний live-путь БЕЗ
  // изменения байтов файла; isLowConfidenceBase и порядок [REASONING]/[ANSWER] не тронуты.
  var replyManualExport = function () {
    var site = host.getSiteName() || '';
    var snapConvId = (typeof host.getCanonicalConvId === 'function') ? host.getCanonicalConvId(curCidExp) : curCidExp;
    // S2.3 (ADR-001, I4): ручной файл (MD/JSON) несёт те же метки, что и авто-путь —
    // из того же снимка. typeof-гард: срез-песочницы без state.ts → меток нет.
    var snapPartMan = (typeof host.readSnapshot === 'function') ? host.readSnapshot(snapConvId) : null;
    // 2.2/шаг 5: ручной файл печатает ТОТ ЖЕ порог, что бейдж/попап.
    // snapPartMan.limit уже учитывает тариф каталога (Gemini Free 32K) и
    // ручной процент; computeEffectiveLimit — запасной путь без снимка.
    var manualDisplayLimit = (snapPartMan && typeof snapPartMan.limit === 'number' && snapPartMan.limit > 0)
      ? snapPartMan.limit
      : host.getEffectiveLimit(host.getResolvedModelId());
    var tokenSnapshot = host.getTokenSnapshot();
    var partialView = (typeof host.partialView === 'function') ? host.partialView(snapPartMan) : null;
    var manualSnapshot: AiCmManualSnapshot = /** @type {AiCmManualSnapshot} */
      ({
        host: host.getHostname(),
        convId: curCidExp,
        site: site,
        model: (snapPartMan && snapPartMan.modelName) ? snapPartMan.modelName : (host.getSnapshotModelName() || (host.getResolvedModelId() || '')),
        tokens: host.getTokenCount(),
        limit: manualDisplayLimit,
        percent: pctExp,
        // BIG-02: платформенный сигнал едет в файл тем же снимком, что у бейджа.
        // Без него MD заново считал 68 893/128 000 = 53.8 % и терял метку.
        saturated: ((snapPartMan && snapPartMan.saturated === true) ||
          (tokenSnapshot && tokenSnapshot.saturated === true))
          ? true : undefined,
        // 2.2/фаза 5: те же три факта лимита, что у авто-пути.
        windowLimit: (snapPartMan && typeof snapPartMan.windowLimit === 'number' && snapPartMan.windowLimit > 0)
          ? snapPartMan.windowLimit
          : ((snapPartMan && typeof snapPartMan.contextLimit === 'number' && snapPartMan.contextLimit > 0) ? snapPartMan.contextLimit : undefined),
        displayLimit: (snapPartMan && typeof snapPartMan.limit === 'number' && snapPartMan.limit > 0)
          ? snapPartMan.limit : undefined,
        accountLimit: (snapPartMan && typeof snapPartMan.accountLimit !== 'undefined') ? snapPartMan.accountLimit : undefined,
        limitPlan: (snapPartMan && typeof snapPartMan.limitPlan === 'string' && snapPartMan.limitPlan) ? snapPartMan.limitPlan : undefined,
        limitWarnings: (snapPartMan && Array.isArray(snapPartMan.limitWarnings)) ? snapPartMan.limitWarnings : undefined,
        // v1.9 (qwen): источник числа (dom|net|max|server|hold) — тот же снимок,
        // что у бейджа/истории. Без него ручной MD/JSON терял metric-src/src.
        src: (tokenSnapshot && tokenSnapshot.src) ? tokenSnapshot.src : undefined,
        updatedAt: Date.now(),
        // v1.14.1: живой флаг — ручной as-is экспорт при baseComplete=0 получает
        // префикс [LOW CONFIDENCE]_ (options.js:378), после base-complete — без префикса.
        isLowConfidenceBase: (host.isBaseComplete() !== true),
        // Two-Tier (v89): метка достоверности источника — рядом с прочими метаданными
        // снимка. undefined у прочих сервисов/без моста → в storage ключ не появляется,
        // файл и ручной экспорт байтово прежние.
        sourceTier: (typeof host.getSourceTier === 'function') ? host.getSourceTier() : undefined,
        // S2.3 (I4): частичность ручного файла; при partial !== true ключи не появляются.
        partial: partialView ? partialView.partial : ((snapPartMan && snapPartMan.partial === true) ? true : undefined),
        partialReason: partialView
          ? partialView.partialReason : ((snapPartMan && snapPartMan.partial === true) ? ((snapPartMan.partialReason) || 'incomplete') : undefined),
        messages: host.getMessages()
      });
    // BUG-J: у GSA холодная загрузка отдавала порядок new→old, а baseComplete при этом
    // уже 1 — префикс врал бы вместе с телом файла. Для GSA достоверность ручного файла
    // определяется partial снимка (тот же источник, что у метки partial выше); прочие
    // сайты видят БАЙТОВО прежнее живое значение baseComplete (v1.14.1).
    if (site === 'google_search' && snapPartMan) {
      manualSnapshot.isLowConfidenceBase = (snapPartMan.partial === true);
    }
    // O-36 (D1): у сервиса без сети (qwen) база подтверждена записью DOM-адаптера —
    // префикс низкой достоверности ей не полагается (см. aiCmQwenExportBaseTrusted).
    // Прочие сайты: флаг остаётся живым значением baseComplete (байтово прежнее имя).
    // typeof-гард: срез-песочницы тестов ручного экспорта (MANUAL-регион без этого
    // хелпера) видят прежнее поведение 1:1 — как у прочих точек контура qwen.
    if (typeof host.isQwenExportBaseTrusted === 'function' && host.isQwenExportBaseTrusted()) {
      manualSnapshot.isLowConfidenceBase = false;
    }
    // O-49: при низкой достоверности базы (isLowConfidenceBase=true) локальный снимок
    // EMIT может нести только последние ходы (as-is/таймаут, tolerant-salvage O-48) —
    // добираем объединённой базой (архив + live) через ту же точку, что и снимок истории
    // (aiCmUnionFileMessages: гард «строго полнее» внутри, не-Gemini → без изменений).
    // При baseComplete=1 (обычный чат) вызов не делает ничего — байты снимка прежние (R3).
    try {
      if (typeof host.unionFileMessages === 'function') {
        manualSnapshot.messages = host.unionFileMessages(curCidExp, manualSnapshot.messages,
          manualSnapshot.isLowConfidenceBase === true);
      }
    } catch (eO49m) { host.debugLog('log', '[AI CM][export] silent-catch replyManualExport(O-49 union): ' + ((eO49m instanceof Error && eO49m.message) || String(eO49m))); }
    // S1.3 (inv-i3) + S5 (I3c'): файл ручного экспорта строится из ОДНОГО канонического
    // массива — drop контейнеров и reasoning применяются РОВНО один раз, на этапе массива,
    // поэтому MD-тело и JSON-тело одного нажатия равны (tests/inv-i3-manual-md-json.test.js).
    if (manualSnapshot.isLowConfidenceBase === true) {
      // Union-путь (объединение архив+live): канонизируем сам массив объединения, затем
      // применяем проекцию файла (S5.1); файл остаётся исключением только из I3a (partial).
      if (typeof host.canonicalizeMessages === 'function') {
        manualSnapshot.messages = host.canonicalizeMessages(manualSnapshot.messages, site);
      }
      if (typeof host.projectFileMessages === 'function') {
        var projMU = host.projectFileMessages(manualSnapshot.messages, site);
        manualSnapshot.messages = projMU.messages;
        manualSnapshot.bodyProjection = projMU.mode;
      }
    } else if (typeof host.buildCanonicalBody === 'function') {
      // Обычный чат: массив файла = массив тела снимка ([ctx-snap]); проекция — только файл.
      var canonManual = host.buildCanonicalBody(curCidExp);
      if (canonManual && canonManual.messages.length) manualSnapshot.messages = canonManual.messages;
      if (typeof host.projectFileMessages === 'function') {
        var projMn = host.projectFileMessages(manualSnapshot.messages, site);
        manualSnapshot.messages = projMn.messages;
        manualSnapshot.bodyProjection = projMn.mode;
      }
    }
    manualSnapshot.dedupe = (typeof host.dedupeInfo === 'function')
      ? host.dedupeInfo(host.getLastDetailMessages(), manualSnapshot.messages) : undefined;
    sendResponse({ data: manualSnapshot } as AiCmExportCurrentResponse);
  };
  // R2: площадки с очередью вложений (DeepSeek — свой модуль, Qwen — core/qwen-files.js)
  // дожидаются текста файлов ДО композиции: у Qwen это только дренаж (6000 мс: файлы
  // качаются по одному, конкурентность 2, кап 10 с на файл), у DeepSeek порядок прежний —
  // дренаж, затем net-sync. Дренажные хелперы живут в base-handler; host решает,
  // доступны ли они в текущем срезе.
  var route = resolveManualExportRoute({
    netSyncSite: (typeof host.isNetSyncSite === 'function') ? host.isNetSyncSite() === true : false,
    hasFilesThenNetSync: typeof host.filesThenNetSync === 'function',
    hasNetSyncThen: typeof host.netSyncThen === 'function',
    filesDrainSite: (typeof host.isFilesDrainSite === 'function') ? host.isFilesDrainSite() === true : false,
    hasFilesDrainThen: typeof host.filesDrainThen === 'function'
  });
  if (route === 'files-then-net') {
    host.filesThenNetSync!(curCidExp, replyManualExport);
  } else if (route === 'net') {
    host.netSyncThen!(curCidExp, replyManualExport);
  } else if (route === 'files-drain') {
    host.filesDrainThen!(curCidExp, replyManualExport, 6000);
  } else {
    replyManualExport();
  }
}

// Глобальный мост для content.ts и срез-песочниц.
(function () {
  var Api: any = {};
  Api.aiCmHandleManualExport = aiCmHandleManualExport;
  Api.resolveManualExportRoute = resolveManualExportRoute;
  if (typeof window !== 'undefined') {
    (window as any).AiCmContentManualExport = Api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Api;
  }
})();
