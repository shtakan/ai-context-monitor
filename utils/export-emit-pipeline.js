/**
 * Общий EMIT-пайплайн экспорта (v81, Задача A).
 * Чистые функции для 6 адаптеров (chatgpt, gemini, deepseek, google_search, claude, perplexity):
 *   - buildExportFileName(service, convId, reason, isLowConfidence, fmt)
 *   - shouldSkipAutoExport(state) — чистый гейт автоэкспорта
 *   - resolveExportSource(state) — T1-fix#3: источник файла (объединённая база архив+live /
 *     локальный снимок EMIT / запрет при базе «только архив»)
 *   - markAutoExportFired / getAutoExportFired / resetAutoExportFired — латч per service+convId
 *   - extractConvIdFromUrl(pathname) — идентификатор диалога из URL (без выдумывания)
 *   - normalizeExportMessages(raw) — нормализация к {role, text}
 * Паттерн как у export-text-builders.js: window.AiCmExportEmitPipeline + module.exports.
 * Логика оракула полноты, ленты, пола, виджета и Gemini-гейтов НЕ тронута.
 */
(function () {
  'use strict';

  // Санация сегмента имени файла (как в options.js)
  function safeSeg(s) {
    return String(s == null ? '' : s).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  }

  // Идентификатор диалога из pathname. Возвращает '' если надёжного id нет —
  // идентификаторы НЕ выдумываем.
  function extractConvIdFromUrl(pathname) {
    try {
      var p = String(pathname || '');
      // Gemini (и AI Studio): /app/<id>
      var mApp = p.match(/\/app\/([A-Za-z0-9_-]+)/);
      if (mApp) return mApp[1];
      // chat.deepseek.com: /a/chat/s/<id> — ДО общего /chat/ (иначе вернётся 's')
      var mDs = p.match(/\/a\/chat\/s\/([A-Za-z0-9_-]+)/);
      if (mDs) return mDs[1];
      // claude.ai: /chat/<uuid> (или /project/<pid>/chat/<uuid>)
      var parts = p.split('/');
      var chatIdx = parts.indexOf('chat');
      if (chatIdx !== -1 && chatIdx + 1 < parts.length && parts[chatIdx + 1]) return parts[chatIdx + 1];
      // chatgpt.com: /c/<uuid>
      var mC = p.match(/\/c\/([A-Za-z0-9_-]+)/);
      if (mC) return mC[1];
      // perplexity.ai: /thread/<slug>
      var mP = p.match(/\/thread\/([A-Za-z0-9_-]+)/);
      if (mP) return mP[1];
      // google.com (Search AI) и прочие — надёжного идентификатора в URL нет
      return '';
    } catch (e) { return ''; }
  }

  /**
   * Имя файла автоэкспорта:
   *   [LOW CONFIDENCE]_<service>-<convId slice 0,8 | 'noconv'>-<YYYY-MM-DD_HH-MM>[-pretrim|-base-complete].<fmt>
   * Префикс [LOW CONFIDENCE]_ — ТОЛЬКО при isLowConfidence=true (baseComplete=0).
   * reason: 'threshold' (без суффикса) | 'pre-trim' → -pretrim | 'base-complete' → -base-complete.
   */
  function buildExportFileName(service, convId, reason, isLowConfidence, fmt) {
    var f = (fmt === 'md') ? 'md' : 'txt';
    var d = new Date();
    function ap2(n) { return (n < 10 ? '0' : '') + n; }
    var stamp = d.getFullYear() + '-' + ap2(d.getMonth() + 1) + '-' + ap2(d.getDate()) +
      '_' + ap2(d.getHours()) + '-' + ap2(d.getMinutes());
    var cidSeg = safeSeg(String(convId || '').slice(0, 8)) || 'noconv';
    var svcSeg = safeSeg(service) || 'chat';
    var suffix = '';
    if (reason === 'pre-trim') suffix = '-pretrim';
    else if (reason === 'base-complete') suffix = '-base-complete';
    var lowConfPrefix = (isLowConfidence === true) ? '[LOW CONFIDENCE]_' : '';
    return lowConfPrefix + svcSeg + '-' + cidSeg + '-' + stamp + suffix + '.' + f;
  }

  /**
   * v82 (D2): выбор источника экспорта. baseSeen=true → 'network' (ЕДИНСТВЕННЫЙ
   * источник; пустые сетевые тексты дают [] — потребители skip), baseSeen=false →
   * 'adapter'. hasNetworkTexts нужен только для читаемости/диагностики.
   */
  function pickExportSource(hasBaseSeen, hasNetworkTexts) {
    return (hasBaseSeen === true) ? 'network' : 'adapter';
  }

  /**
   * T1-fix#3 (v1.16.3): ОТКУДА экспорт берёт сообщения.
   * Последний EMIT (lastBaseTexts в content.js) может не совпадать с ОБЪЕДИНЁННОЙ базой
   * (архив + live): архив вливается в turnsMap первым (читается из chrome.storage сразу
   * при page-load), а живая история приходит позже — файл уходил одной архивной частью
   * (live-прогон: 4 архивных хода в файле при базе 114).
   * Решение (чистая функция — вызывается из doAutoExportDownload, единственной точки
   * записи файла, поэтому покрывает и порог, и триггер base-complete, и pre-trim):
   *   { action:'block', reason:'archive-only-base' } — в базе ТОЛЬКО архив (живых ходов 0):
   *       пол/полнота первого яруса права на файл не даёт, латч fired НЕ ставится;
   *   { action:'union', reason:'stale-local-source' } — объединённая база (архив + live)
   *       больше локального снимка → источником файла становится она;
   *   { action:'local', reason } — прежнее поведение 1:1 (не Gemini / моста нет /
   *       архив не импортирован / объединённая база не больше локального снимка).
   * state: { isGemini, bridge, archiveCount, liveCount, baseCount, localCount }.
   * Обратная совместимость: без архива (archiveCount=0) всегда 'local'.
   */
  function resolveExportSource(state) {
    var s = state || {};
    if (s.isGemini !== true) return { action: 'local', reason: 'non-gemini' };
    if (s.bridge !== true) return { action: 'local', reason: 'no-bridge' };
    var arch = (typeof s.archiveCount === 'number' && s.archiveCount > 0) ? s.archiveCount : 0;
    if (arch <= 0) return { action: 'local', reason: 'no-archive' };
    var live = (typeof s.liveCount === 'number') ? s.liveCount : null;
    if (live === 0) return { action: 'block', reason: 'archive-only-base' };
    var base = (typeof s.baseCount === 'number') ? s.baseCount : 0;
    var local = (typeof s.localCount === 'number') ? s.localCount : 0;
    if (live !== null && live > 0 && base > local) return { action: 'union', reason: 'stale-local-source' };
    return { action: 'local', reason: 'in-sync' };
  }

  /**
   * Чистый гейт автоэкспорта. state:
   *   { enabled, percentage, threshold, baseComplete, baseSeen, loaderRunning, fired, isGemini,
   *     archiveCount, baseCount }
   * archiveCount/baseCount (T1-fix#2, v1.16.2) опциональны: не переданы — прежнее поведение.
   * Возвращает { skip, reason, resetFired }. Порядок гейтов повторяет
   * существующий maybeAutoExport (v30.5/v42/гистерезис −10 п.п.).
   */
  function shouldSkipAutoExport(state) {
    var s = state || {};
    if (s.enabled !== true) return { skip: true, reason: 'not-enabled', resetFired: false };
    if (typeof s.percentage !== 'number' || !(s.percentage >= 0)) return { skip: true, reason: 'no-pct', resetFired: false };
    var threshold = (typeof s.threshold === 'number' && s.threshold >= 1 && s.threshold <= 100) ? s.threshold : 90;
    // Гейт полноты: для Gemini — только по сети (baseComplete); для не-Gemini
    // неполная сетевая база тоже блокирует, но полный DOM-адаптер (baseSeen=false)
    // сигнала полноты не требует.
    var completeOk = (s.isGemini === true)
      ? (s.baseComplete === true)
      : (!s.baseSeen || s.baseComplete === true);
    if (!completeOk) return { skip: true, reason: 'not-complete', resetFired: false };
    // T1-fix#2 (v1.16.2): пол первого яруса (архив) не даёт права на автоэкспорт, пока
    // живая история не влилась. Архивные ходы лежат в ТОЙ ЖЕ базе (same-conv-union),
    // поэтому «count дорос до архива» выполняется вкладом самого архива — база из одного
    // архива (baseCount <= archiveCount) полнотой живого яруса НЕ является.
    // Латч fired не ставится (resetFired=false): поздний честный экспорт остаётся возможен.
    // Гейт включается только при переданных archiveCount/baseCount (обратная совместимость).
    if (s.isGemini === true && typeof s.archiveCount === 'number' && s.archiveCount > 0 &&
        typeof s.baseCount === 'number' && s.baseCount <= s.archiveCount) {
      return { skip: true, reason: 'archive-pending-live', resetFired: false };
    }
    if (s.isGemini === true && s.loaderRunning) return { skip: true, reason: 'loader-running', resetFired: false };
    // Гистерезис: ниже порога на 10 п.п. — сброс латча ТОЛЬКО по достоверному pct.
    // v82 (D5): для не-Gemini при baseSeen=false pct — транзиентное DOM-окно (виртуализация),
    // латч НЕ трогаем (иначе повторный fired на том же convId); Gemini — прежнее поведение 1:1.
    if (s.percentage < threshold - 10) {
      if (s.isGemini === true || s.baseSeen === true) return { skip: true, reason: 'below-threshold-hysteresis', resetFired: true };
      return { skip: true, reason: 'below-threshold-unreliable', resetFired: false };
    }
    if (s.percentage < threshold) return { skip: true, reason: 'below-threshold', resetFired: false };
    if (s.fired) return { skip: true, reason: 'already-fired', resetFired: false };
    return { skip: false, reason: null, resetFired: false };
  }

  /**
   * S2: эффективный порог автоэкспорта с учётом per-site оверрайда.
   * Приоритет: per-site ('aiCmAutoExportPct_<site>') → глобальный → 90.
   * per-site значение клампится в [1,100]; нечисловой/пустой per-site — фолбэк на
   * глобальный; невалидный глобальный — дефолт 90 (поведение глобального пути 1:1).
   */
  function effectiveAutoExportThreshold(globalPct, perSitePct) {
    function clampPerSite(v) {
      var n = parseInt(v, 10);
      if (isNaN(n)) return null;
      if (n < 1) return 1;
      if (n > 100) return 100;
      return n;
    }
    if (perSitePct !== undefined && perSitePct !== null && String(perSitePct).trim() !== '') {
      var per = clampPerSite(perSitePct);
      if (per != null) return per;
    }
    var g = (typeof globalPct === 'number' && globalPct >= 1 && globalPct <= 100) ? globalPct : null;
    return (g == null) ? 90 : g;
  }

  // Латч «один раз на чат» — per service+convId (изоляция по сервису: одинаковый
  // формальный идентификатор у разных сервисов НЕ блокирует друг друга).
  function latchKey(service, convId) {
    return safeSeg(service) + '|' + String(convId || '');
  }
  function markAutoExportFired(store, service, convId) {
    try { store[latchKey(service, convId)] = 1; } catch (e) { }
  }
  function getAutoExportFired(store, service, convId) {
    try { return store[latchKey(service, convId)] === 1; } catch (e) { return false; }
  }
  function resetAutoExportFired(store, service, convId) {
    try { delete store[latchKey(service, convId)]; } catch (e) { }
  }

  // v1.14.1 (O3): кросс-табовый латч already-fired поверх in-memory autoExportFired.
  // chrome.storage.session общий для всех вкладок профиля — двойной экспорт одного
  // чата из двух окон (наблюдался 2026-09-02, файлы …22-12.txt и …22-12(1).txt)
  // становится невозможным: вторая вкладка видит session-латч первой.
  var FIRED_SESSION_PREFIX = 'aiCmFired:';
  function firedSessionKey(service, convId) {
    return FIRED_SESSION_PREFIX + latchKey(service, convId);
  }
  function isFiredInSession(sessionMap, service, convId) {
    try {
      return !!sessionMap && sessionMap[firedSessionKey(service, convId)] === 1;
    } catch (e) { return false; }
  }
  function sessionFiredPatch(service, convId) {
    var patch = {};
    try { patch[firedSessionKey(service, convId)] = 1; } catch (e) { }
    return patch;
  }

  /**
   * Нормализация источника сообщений к [{role, text}]:
   *   - роли: raw[i].role ('user' → user, иначе assistant);
   *   - текст: raw[i].text || raw[i].content; пустые отбрасываются.
   */
  function normalizeExportMessages(raw) {
    var out = [];
    try {
      if (!Array.isArray(raw)) return out;
      for (var i = 0; i < raw.length; i++) {
        var m = raw[i] || {};
        var text = (typeof m.text === 'string') ? m.text : (typeof m.content === 'string' ? m.content : '');
        if (!text) continue;
        out.push({ role: (m.role === 'user') ? 'user' : 'assistant', text: text });
      }
    } catch (e) { }
    return out;
  }

  /**
   * v1.6 (D18): объединение ходов тейпа по id — union(existing, incoming) без дублей.
   * tape-save пишет ОБЪЕДИНЕНИЕ существующего тейпа и текущей базы: msgs никогда
   * не меньше прежнего (контент старших ходов не уничтожается при хвостовом окне).
   * Порядок: сначала существующие (порядок тейпа), затем новые из базы.
   */
  function unionTurnsById(existing, incoming) {
    var seen = {};
    var out = [];
    var i, t;
    for (i = 0; existing && i < existing.length; i++) {
      t = existing[i];
      if (!t || t.id == null || seen[t.id]) continue;
      seen[t.id] = true;
      out.push(t);
    }
    for (i = 0; incoming && i < incoming.length; i++) {
      t = incoming[i];
      if (!t || t.id == null || seen[t.id]) continue;
      seen[t.id] = true;
      out.push(t);
    }
    return out;
  }

  var Api = {
    buildExportFileName: buildExportFileName,
    shouldSkipAutoExport: shouldSkipAutoExport,
    effectiveAutoExportThreshold: effectiveAutoExportThreshold,
    pickExportSource: pickExportSource,
    resolveExportSource: resolveExportSource,
    markAutoExportFired: markAutoExportFired,
    getAutoExportFired: getAutoExportFired,
    resetAutoExportFired: resetAutoExportFired,
    firedSessionKey: firedSessionKey,
    isFiredInSession: isFiredInSession,
    sessionFiredPatch: sessionFiredPatch,
    extractConvIdFromUrl: extractConvIdFromUrl,
    normalizeExportMessages: normalizeExportMessages,
    unionTurnsById: unionTurnsById,
    latchKey: latchKey
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Api;
  if (typeof window !== 'undefined') window.AiCmExportEmitPipeline = Api;
})();
