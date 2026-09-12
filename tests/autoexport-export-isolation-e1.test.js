/**
 * E-1 (v1.19): изоляция тела автоэкспорта по вкладке.
 *
 * LIVE-дефект: GSA-вкладка стреляла (fired, file=ai-context-monitor-google_search-…),
 * а в файл уходила история ChatGPT-разговора из параллельной вкладки (глобальный
 * ключ 'aiCmHistory' — last-writer-wins между вкладками).
 *
 * Контракт фикса (ЕДИНСТВЕННАЯ точка записи файла — doAutoExportDownload):
 *   1. тело файла собирается ТОЛЬКО из in-memory истории стреляющей вкладки
 *      (тот же массив, что питает бейдж и pct); глобальный ключ aiCmHistory для тела
 *      не читается никогда;
 *   2. provenance-гард: перед записью convId истории сверяется с cid стреляющей вкладки,
 *      site истории — с currentAdapter.siteName; несовпадение → abort
 *      reason=history-source-mismatch (файла нет, латч не ставится);
 *   3. фолбэк — ТОЛЬКО при пустой in-memory истории: per-host ключ 'aiCmHistory:<host>'
 *      СВОЕЙ вкладки, с тем же provenance-гардом;
 *   4. fired-строка несёт histSource=memory|storage-host и histConvId=<id>.
 *
 * НЕ ТРОГАЕТСЯ: latch (site+convId), пороги, имена файлов, resolveExportSource,
 * T1-архивы (archive-only-base), классификаторы GSA.
 */

const fs = require('fs');
const path = require('path');

const P = require('../utils/export-emit-pipeline.js');
const Builders = require('../utils/export-text-builders.js');

const ROOT = path.join(__dirname, '..');
const CONTENT = fs.readFileSync(path.join(ROOT, 'core', 'content.js'), 'utf8');

// Рез по балансу фигурных скобок (как в tests/gsa-autoexport.test.js).
function fnDecl(src, name) {
  const start = src.indexOf('function ' + name + '(');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced declaration: ' + name);
}

const SCOPE = 'with (ctx) { ' +
  fnDecl(CONTENT, 'aiCmExportBaseSource') + '\n' +
  fnDecl(CONTENT, 'doAutoExportDownload') + '\n' +
  ' return { dl: doAutoExportDownload }; }';
const makeContent = new Function('ctx', SCOPE);

const GSA = 'google_search';
const TID = 'THREAD-1';

const OWN = [
  { role: 'user', text: 'СВОЙ вопрос GSA' },
  { role: 'assistant', text: 'СВОЙ ответ GSA' }
];
const FOREIGN = [
  { role: 'user', text: 'ЧУЖОЙ вопрос ChatGPT' },
  { role: 'assistant', text: 'ЧУЖОЙ ответ ChatGPT' }
];

function ctxFor(memory, over) {
  const downloads = [];
  const logs = [];
  const storageReads = [];
  const ctx = {
    currentAdapter: { siteName: GSA },
    autoExportSettings: { fmt: 'txt', enabled: true },
    aiCmLowConfidenceByConv: {},
    baseSeen: false,
    baseComplete: true,
    lastBaseTexts: memory.map(function (m) { return m.text; }),
    lastEmitConvId: '',
    lastThreadId: TID,
    lastResolvedModelId: 'gemini-2.5-flash',
    lastSnapshotModelName: 'Gemini (Search AI)',
    maxTokenCount: 1000,
    sessionFiredCache: {},
    autoExportFired: {},
    aiCmCursorLiveByConv: {},
    aiCmDumpTurnsSnapshot: function () { },
    aiCmCancelDeferredHistWrite: function () { },
    debugLog: function (lvl, msg) { logs.push(String(msg)); },
    console: { error: function () { } },
    ModelConfig: { getModel: function () { return { name: 'Gemini (Search AI)' }; } },
    buildHistoryMessages: function () { return memory.slice(); },
    aiCmGeminiTurnsSnapshotSync: function () { return null; },
    __store: {},
    chrome: {
      storage: {
        session: { set: function () { }, remove: function () { } },
        local: {
          get: function (keys, cb) {
            storageReads.push(Array.isArray(keys) ? keys.slice() : keys);
            if (typeof cb === 'function') cb(ctx.__store || {});
            return undefined;
          }
        }
      }
    },
    window: {
      location: { hostname: 'www.google.com' },
      AiCmExportBuilders: {
        buildTxtFromHistory: function (hist) { return hist.messages.map(function (m) { return m.role + '::' + m.text; }).join('\n'); },
        buildMdFromHistory: function (hist) { return hist.messages.map(function (m) { return m.text; }).join('\n'); },
        buildJsonFromHistory: Builders.buildJsonFromHistory,
        downloadBlob: function (content, file, mime) { downloads.push({ content: content, file: file, mime: mime }); }
      },
      AiCmExportEmitPipeline: P
    }
  };
  Object.assign(ctx, over || {});
  return { ctx: ctx, downloads: downloads, logs: logs, storageReads: storageReads, api: makeContent(ctx) };
}

// =====================================================================================
// (а) кросс-таб: чужой глобальный aiCmHistory телом не становится
// =====================================================================================
describe('E-1 (а): тело файла — история стреляющей вкладки, глобальный aiCmHistory игнорируется', () => {
  test('чужой convId/site в глобальном aiCmHistory → в файле своя история, хранилище не читается', () => {
    const foreignRec = { host: 'chatgpt.com', convId: 'chatgpt-6a59cfa1', site: 'chatgpt', messages: FOREIGN };
    const h = ctxFor(OWN, {
      __store: {
        aiCmHistory: foreignRec,
        'aiCmHistory:chatgpt.com': foreignRec
      }
    });
    h.api.dl(TID, 95, 'threshold');

    expect(h.downloads.length).toBe(1);
    expect(h.downloads[0].content).toContain('СВОЙ вопрос GSA');
    expect(h.downloads[0].content).toContain('СВОЙ ответ GSA');
    expect(h.downloads[0].content).not.toContain('ЧУЖОЙ');
    // in-memory история непустая → фолбэк-хранилище не читается вовсе (ни глобальный ключ, ни per-host)
    expect(h.storageReads.length).toBe(0);
    expect(h.logs.join('\n')).toContain('histSource=memory histConvId=' + TID);
  });

  test('файл GSA сохраняет прежнее имя (ручной шаблон) — фикс тела имя не трогает', () => {
    const h = ctxFor(OWN, {});
    h.api.dl(TID, 95, 'threshold');
    expect(h.downloads[0].file)
      .toMatch(/^ai-context-monitor-google_search-Gemini-Search-AI-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.txt$/);
  });
});

// =====================================================================================
// (б) provenance-гард: чужая история не скачивается
// =====================================================================================
describe('E-1 (б): provenance-гард — несовпадение convId/site → abort без файла', () => {
  test('фолбэк-хранилище с чужим convId → abort reason=history-source-mismatch, скачивания нет', () => {
    const h = ctxFor([], {
      __store: {
        'aiCmHistory:www.google.com': {
          host: 'www.google.com', convId: 'chatgpt-6a59cfa1', site: 'chatgpt', messages: FOREIGN
        }
      }
    });
    h.api.dl(TID, 95, 'threshold');

    expect(h.downloads.length).toBe(0);
    // читается РОВНО per-host ключ своей вкладки; глобальный aiCmHistory не запрашивается
    expect(h.storageReads).toEqual([['aiCmHistory:www.google.com']]);
    expect(h.logs.join('\n'))
      .toContain('[AI CM][auto-export] abort reason=history-source-mismatch histConvId=chatgpt-6a59cfa1 site=chatgpt');
    // латч НЕ поставлен: поздний честный экспорт этого чата остаётся возможен
    expect(P.getAutoExportFired(h.ctx.autoExportFired, GSA, TID)).toBe(false);
    expect(h.logs.join('\n')).not.toContain('fired convId=');
  });

  test('фолбэк-хранилище с чужим site (convId совпал) → abort', () => {
    const h = ctxFor([], {
      __store: {
        'aiCmHistory:www.google.com': { host: 'www.google.com', convId: TID, site: 'chatgpt', messages: FOREIGN }
      }
    });
    h.api.dl(TID, 95, 'threshold');
    expect(h.downloads.length).toBe(0);
    expect(h.logs.join('\n')).toContain('abort reason=history-source-mismatch histConvId=' + TID + ' site=chatgpt');
  });

  test('in-memory гард: снимок чужого чата (lastEmitConvId ≠ cid) → abort без файла', () => {
    const h = ctxFor(OWN, { lastEmitConvId: 'gemini-OLD-CONV' });
    h.api.dl('gemini-NEW-CONV', 95, 'threshold');
    expect(h.downloads.length).toBe(0);
    expect(h.logs.join('\n'))
      .toContain('abort reason=history-source-mismatch histConvId=gemini-OLD-CONV site=' + GSA);
    expect(P.getAutoExportFired(h.ctx.autoExportFired, GSA, 'gemini-NEW-CONV')).toBe(false);
  });

  test('фолбэк-хранилище с совпавшим provenance → файл из per-host, histSource=storage-host', () => {
    const h = ctxFor([], {
      __store: {
        'aiCmHistory:www.google.com': { host: 'www.google.com', convId: TID, site: GSA, messages: OWN }
      }
    });
    h.api.dl(TID, 95, 'threshold');
    expect(h.downloads.length).toBe(1);
    expect(h.downloads[0].content).toContain('СВОЙ вопрос GSA');
    expect(h.downloads[0].content).not.toContain('ЧУЖОЙ');
    expect(h.logs.join('\n')).toContain('histSource=storage-host histConvId=' + TID);
  });

  test('фолбэк без записи per-host → прежний skip reason=empty-history, файла нет', () => {
    const h = ctxFor([], { __store: {} });
    h.api.dl(TID, 95, 'threshold');
    expect(h.downloads.length).toBe(0);
    expect(h.logs.join('\n')).toContain('skip reason=empty-history convId=' + TID + ' histSource=storage-host');
  });
});

// =====================================================================================
// (в) fired-строки Gemini и GSA несут histSource/histConvId
// =====================================================================================
describe('E-1 (в): fired-строка несёт histSource и histConvId', () => {
  test('GSA: cid = threadId, histSource=memory, histConvId=threadId (общая и tagged строки)', () => {
    const h = ctxFor(OWN, { lastEmitConvId: '', lastThreadId: TID });
    h.api.dl(TID, 95, 'threshold');
    const joined = h.logs.join('\n');
    expect(joined).toContain('[AI CM][auto-export] fired convId=' + TID);
    expect(joined).toContain('histSource=memory histConvId=' + TID);
    expect(joined).toContain('[AI CM][auto-export] site=google_search fired convId=' + TID);
    expect(joined).toContain('baseComplete=1 histSource=memory histConvId=' + TID);
  });

  test('Gemini: cid = URL-convId, histSource=memory, histConvId=convId снимка', () => {
    const h = ctxFor(OWN, {
      currentAdapter: { siteName: 'gemini' },
      lastEmitConvId: '0362260d',
      lastThreadId: null
    });
    h.api.dl('0362260d', 95, 'threshold');
    const joined = h.logs.join('\n');
    expect(joined).toContain('[AI CM][auto-export] fired convId=0362260d');
    expect(joined).toContain('histSource=memory histConvId=0362260d');
    expect(joined).not.toContain('site=google_search');
  });
});

// =====================================================================================
// Source-level пины контракта изоляции
// =====================================================================================
describe('E-1: пины исходника (единственная точка записи файла)', () => {
  const body = fnDecl(CONTENT, 'doAutoExportDownload');

  test('глобальный ключ aiCmHistory для тела не читается; фолбэк — только per-host', () => {
    expect(body).not.toContain("chrome.storage.local.get(['aiCmHistory']");
    // в теле нет строкового литерала ровно глобального ключа
    expect(body).not.toContain("'aiCmHistory'");
    expect(body).toContain("'aiCmHistory:' + hostFb");
    expect(body).toContain("chrome.storage.local.get([hostKeyFb], onHostHistFb)");
  });

  test('provenance-гард стоит ДО скачивания и ДО установки латча', () => {
    expect(body).toContain("'[AI CM][auto-export] abort reason=history-source-mismatch histConvId='");
    expect(body).toContain("' site=' + histSite");
    const iGuard = body.indexOf('history-source-mismatch');
    expect(iGuard).toBeLessThan(body.indexOf('B.downloadBlob(content, file'));
    expect(iGuard).toBeLessThan(body.indexOf('markAutoExportFired'));
  });

  test('in-memory — основной источник; фолбэк вынесен в ветку пустой истории', () => {
    expect(body).toContain("aiCmWriteAutoExportFile(msgs, 'memory', histConvIdMem, histSiteMem);");
    expect(body).toContain("aiCmWriteAutoExportFile(rec.messages, 'storage-host', rec.convId || '', rec.site || '');");
    expect(body.indexOf('msgs.length === 0')).toBeLessThan(body.indexOf("'storage-host'"));
    // имена файлов, латч и T1-гейт не тронуты
    expect(body).toContain('P.buildGsaExportFileName(siteNameD, gsaModelD, lowConfD, fmt);');
    expect(body).toContain('P.buildExportFileName(siteNameD, cid, reason, lowConfD, fmt);');
    expect(body).toContain('var baseSrc = aiCmExportBaseSource(cid, msgs);');
    expect(body).toContain('source=archive-only-base');
  });

  test('не тронуто: resolveExportSource и GSA-архив (Gemini-only) прежние', () => {
    expect(P.resolveExportSource({ isGemini: false })).toEqual({ action: 'local', reason: 'non-gemini' });
    expect(P.resolveExportSource({ isGemini: true, bridge: true, archiveCount: 4, liveCount: 0 }))
      .toEqual({ action: 'block', reason: 'archive-only-base' });
    expect(fnDecl(CONTENT, 'aiCmExportBaseSource')).toContain("site !== 'gemini'");
  });
});
