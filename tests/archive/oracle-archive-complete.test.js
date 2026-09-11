/**
 * T1 (v1.16): оракул archive-complete (легитимный ТЕРМИНАЛЬНЫЙ источник) и пины
 * того, что H9/H10-гейты НЕ ослаблены.
 *
 * Разделы:
 *   А) единичные гейты вердикта архива (convId / count / пол);
 *   Б) композиция первого яруса ровно как в core: merge → пол → вердикт;
 *   В) H9/H10 авторитетны и не тронуты архивом (поведенческие + source-level пины);
 *   Г) пины проводки: content.js (ISOLATED) → ai-cm-archive-restore → Gemini MAIN,
 *      options.js (FileReader, оба ключа, без fetch), manifest.json не изменён;
 *   Д) jsdom-интеграция: импорт файла через FileReader и индикатор источника.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const Logic = require('../../utils/gemini-intercept-logic.js');
const AI = require('../../utils/archive-import.js');

const CORE_CONTENT = fs.readFileSync(path.join(ROOT, 'core', 'content.js'), 'utf8');
const CORE_GEMINI = fs.readFileSync(path.join(ROOT, 'core', 'gemini-intercept.js'), 'utf8');
const OPTIONS_JS = fs.readFileSync(path.join(ROOT, 'options', 'options.js'), 'utf8');
const OPTIONS_HTML = fs.readFileSync(path.join(ROOT, 'options', 'options.html'), 'utf8');
const MANIFEST = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');

function fnSource(src, name) {
  const start = src.indexOf('function ' + name + '(');
  expect(start).toBeGreaterThan(-1);
  // до следующей функции/закрытия IIFE — достаточно длинный срез для проверки тела
  const rest = src.slice(start);
  const nextFn = rest.indexOf('\n  function ', 10);
  return nextFn === -1 ? rest : rest.slice(0, nextFn);
}

// =====================================================================================
// А) единичные гейты
// =====================================================================================
describe('T1: archive-complete — гейты вердикта', () => {
  const base = { archiveConvId: 'c1', currentConvId: 'c1', archiveCount: 50, baseCount: 50, floorCount: 0 };

  test('архив своего чата + база доросла до count → complete: archive-complete', () => {
    expect(Logic.archiveCompleteVerdict(base)).toEqual({ complete: true, reason: 'archive-complete' });
  });

  test('архива нет → no-archive', () => {
    expect(Logic.archiveCompleteVerdict(Object.assign({}, base, { archiveConvId: '' })).reason).toBe('no-archive');
  });

  test('неизвестен текущий чат → no-conv', () => {
    expect(Logic.archiveCompleteVerdict(Object.assign({}, base, { currentConvId: '' })).reason).toBe('no-conv');
  });

  test('архив ЧУЖОГО чата → conv-mismatch (чужой архив не даёт полноту)', () => {
    expect(Logic.archiveCompleteVerdict(Object.assign({}, base, { archiveConvId: 'other' })))
      .toEqual({ complete: false, reason: 'conv-mismatch' });
  });

  test('пустой архив → archive-empty', () => {
    expect(Logic.archiveCompleteVerdict(Object.assign({}, base, { archiveCount: 0 })).reason).toBe('archive-empty');
  });

  test('база НЕ доросла до архивного count → below-archive-count (ложная полнота запрещена)', () => {
    expect(Logic.archiveCompleteVerdict(Object.assign({}, base, { baseCount: 49 })))
      .toEqual({ complete: false, reason: 'below-archive-count' });
  });

  test('база ниже пола → below-floor (H10-инвариант сохранён и для архива)', () => {
    expect(Logic.archiveCompleteVerdict(Object.assign({}, base, { baseCount: 50, floorCount: 60 })))
      .toEqual({ complete: false, reason: 'below-floor' });
  });

  test('мусорные входы (undefined/строки) не дают complete', () => {
    expect(Logic.archiveCompleteVerdict().complete).toBe(false);
    expect(Logic.archiveCompleteVerdict({ archiveConvId: 'c1', currentConvId: 'c1' }).complete).toBe(false);
    expect(Logic.archiveCompleteVerdict({ archiveConvId: 'c1', currentConvId: 'c1', archiveCount: '50', baseCount: '50' }).complete).toBe(false);
  });
});

// =====================================================================================
// Б) композиция яруса: merge → пол → вердикт
// =====================================================================================
describe('T1: композиция первого яруса (merge → пол → вердикт)', () => {
  function archiveConversation(n, offset) {
    const messages = [];
    for (let i = 0; i < n; i++) {
      messages.push({ id: 'a:' + (offset + i) + ':' + i, role: i % 2 ? 'assistant' : 'user', text: 'ход ' + (offset + i) });
    }
    return messages;
  }
  function liveBase(n, offset) {
    const items = [];
    for (let i = 0; i < n; i++) {
      items.push({ id: 'net' + (offset + i), role: i % 2 ? 'assistant' : 'user', text: 'ход ' + (offset + i) });
    }
    return items;
  }

  test('архив старше базы: вливаются недостающие ходы, пол = архивный count, вердикт complete', () => {
    const live = liveBase(20, 30);                 // живой хвост: ходы 30..49
    const archive = archiveConversation(50, 0);    // архив: ходы 0..49 (пересечение 30..49)
    const merged = Logic.archiveMergeTurns(live, archive);
    expect(merged.addedCount).toBe(30);            // добавлены только старшие 0..29
    expect(merged.duplicateCount).toBe(20);        // живые 30..49 схлопнуты по контенту
    const baseCount = live.length + merged.addedCount;

    const floor = Logic.archiveFloorRecord(null, archive.length, 5000);
    expect(floor).toEqual({ count: 50, effectiveLen: 5000, source: 'archive' });

    expect(Logic.archiveCompleteVerdict({
      archiveConvId: 'c1', currentConvId: 'c1',
      archiveCount: archive.length, baseCount: baseCount, floorCount: floor.count
    })).toEqual({ complete: true, reason: 'archive-complete' });
  });

  test('база ещё не доросла: вердикт withheld, и это НЕ ломает пол (он уже архивный)', () => {
    const floor = Logic.archiveFloorRecord(null, 50, 5000);
    const v = Logic.archiveCompleteVerdict({
      archiveConvId: 'c1', currentConvId: 'c1', archiveCount: 50, baseCount: 20, floorCount: floor.count
    });
    expect(v).toEqual({ complete: false, reason: 'below-archive-count' });
    expect(floor.count).toBe(50);
  });

  test('архив меньше живого пола: пол не опускается, вердикт не выдумывает полноту', () => {
    const floor = Logic.archiveFloorRecord({ count: 80, effectiveLen: 9000 }, 12, 500);
    expect(floor).toBeNull();
    expect(Logic.archiveCompleteVerdict({
      archiveConvId: 'c1', currentConvId: 'c1', archiveCount: 12, baseCount: 80, floorCount: 80
    })).toEqual({ complete: true, reason: 'archive-complete' }); // база ≥ архива и ≥ пола — честно
  });
});

// =====================================================================================
// В) H9/H10 не ослаблены
// =====================================================================================
describe('T1: H9/H10-гейты НЕ ослаблены архивом', () => {
  test('H10 probeTerminalGate: база ниже пола по-прежнему блокирует probe-terminal', () => {
    expect(Logic.probeTerminalGate({ floorCount: 108, baseCount: 80, pbError: false }))
      .toEqual({ block: true, reason: 'below-floor-probe-terminal' });
  });

  test('H10 probeTerminalGate: pb-ошибка по-прежнему блокирует', () => {
    expect(Logic.probeTerminalGate({ floorCount: 0, baseCount: 80, pbError: true }))
      .toEqual({ block: true, reason: 'pb-error-page' });
  });

  test('H10 probeTerminalGate: floor=0 и база есть → не блокирует (поведение 1:1)', () => {
    expect(Logic.probeTerminalGate({ floorCount: 0, baseCount: 80, pbError: false })).toBeNull();
  });

  test('H9 untrustedTopVerdict: floor=0 + был курсор + нет роста → top недостоверен', () => {
    expect(Logic.untrustedTopVerdict({ floorCount: 0, hadCursor: true, anyGrowth: false, maxScrollHSeen: 500, viewportH: 700 }))
      .toEqual({ untrusted: true, reason: 'no-floor-no-growth' });
  });

  test('H9 pagStepBroken: оборванный финальный шаг остаётся сломанным', () => {
    expect(Logic.pagStepBroken({ added: 0, nextCursor: false, failedSkeleton: false, opaqueCandidates: 0 })).toBe(true);
    expect(Logic.pagStepBroken({ added: 3, nextCursor: true, failedSkeleton: false, opaqueCandidates: 2 })).toBe(false);
  });

  test('source-level: тела H9/H10-гейтов не знают про архив (архив их не подменяет)', () => {
    ['probeTerminalGate', 'untrustedTopVerdict', 'pagStepBroken', 'collapseGuardVerdict'].forEach((name) => {
      const body = fnSource(fs.readFileSync(path.join(ROOT, 'utils', 'gemini-intercept-logic.js'), 'utf8'), name);
      expect(body.toLowerCase()).not.toContain('archive');
    });
  });

  test('source-level: archive-complete — ОТДЕЛЬНАЯ функция, а не правка существующих', () => {
    const src = fs.readFileSync(path.join(ROOT, 'utils', 'gemini-intercept-logic.js'), 'utf8');
    expect(src).toContain('function archiveCompleteVerdict(');
    expect(src).toContain('archiveCompleteVerdict: archiveCompleteVerdict');
    // существенные прежние экспорты на месте (контракт модуля не сужен)
    ['probeTerminalGate', 'untrustedTopVerdict', 'pagStepBroken', 'completenessOracle', 'saveFloor', 'loadFloor']
      .forEach((n) => expect(src).toContain(n + ': ' + n));
  });
});

// =====================================================================================
// Г) пины проводки
// =====================================================================================
describe('T1: проводка ISOLATED → MAIN и запрет внешних запросов', () => {
  test('content.js: ключи T1 и диспатч ai-cm-archive-restore', () => {
    expect(CORE_CONTENT).toContain("var AI_ARCHIVE_PREFIX = 'aiCmArchive:'");
    expect(CORE_CONTENT).toContain("var AI_CONV_SOURCE_PREFIX = 'aiCmConvSource:'");
    expect(CORE_CONTENT).toContain("new CustomEvent('ai-cm-archive-restore'");
    expect(CORE_CONTENT).toContain('[AI CM][archive-restore]');
  });

  test('content.js: архив читается из chrome.storage.local (а не из сети)', () => {
    expect(CORE_CONTENT).toContain('chrome.storage.local.get([archKey, srcKey], function (data)');
    expect(CORE_CONTENT).toContain('aiCmLoadArchiveTier(');
  });

  test('content.js: индикатор источника попапа/виджета', () => {
    expect(CORE_CONTENT).toContain('sourceKind: ');
    expect(CORE_CONTENT).toContain('sourceLabel: ');
    expect(CORE_CONTENT).toContain("el.className = 'ai-cm-source'");
  });

  test('gemini-intercept.js (MAIN): слушатель архива, пол и вердикт', () => {
    expect(CORE_GEMINI).toContain("window.addEventListener('ai-cm-archive-restore'");
    expect(CORE_GEMINI).toContain('logic.archiveMergeTurns(netItems, messages)');
    expect(CORE_GEMINI).toContain('logic.archiveFloorRecord(');
    expect(CORE_GEMINI).toContain('logic.archiveCompleteVerdict({');
    expect(CORE_GEMINI).toContain('reason=archive-complete');
    expect(CORE_GEMINI).toContain('aiCmArchiveTierApply');
  });

  test('gemini-intercept.js (MAIN): вердикт переоценивается на каждом EMIT', () => {
    const emitSrc = fnSource(CORE_GEMINI, 'emitBaseSnapshot');
    expect(emitSrc).toContain('aiCmArchiveTierApply()');
  });

  test('мировая изоляция: MAIN-перехватчик Gemini chrome.* НЕ использует (проверка КОДА, не комментариев)', () => {
    const codeOnly = CORE_GEMINI
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(codeOnly).not.toContain('chrome.');
  });

  test('SPA-возврат: дедуп архива сбрасывается вместе с лентой (иначе архив не вернётся в базу)', () => {
    const resetSrc = fnSource(CORE_CONTENT, 'resetConversationState');
    expect(resetSrc).toContain('aiCmArchiveLoadStarted = {}');
    expect(resetSrc).toContain('aiCmArchiveRestoredDispatched = {}');
    const geminiReset = fnSource(CORE_GEMINI, 'resetForNewConversation');
    expect(geminiReset).toContain('archiveMergedMap.clear()');
    expect(geminiReset).toContain('completeApplied = false');
  });

  test('options.js: FileReader и оба ключа T1, внешних fetch нет', () => {
    expect(OPTIONS_JS).toContain('new FileReader()');
    expect(OPTIONS_JS).toContain('reader.readAsText(file)');
    expect(OPTIONS_JS).toContain('API.archiveStorageKey(rec.convId)');
    expect(OPTIONS_JS).toContain('API.convSourceStorageKey(rec.convId)');
    expect(OPTIONS_JS).not.toContain('fetch(');
  });

  test('options.html: секция «Архивы» + строка источника + скрипты парсеров', () => {
    expect(OPTIONS_HTML).toContain('id="archive-file"');
    expect(OPTIONS_HTML).toContain('id="archive-import"');
    expect(OPTIONS_HTML).toContain('id="archive-list"');
    expect(OPTIONS_HTML).toContain('id="stat-source"');
    expect(OPTIONS_HTML).toContain('../utils/archive-import.js');
    expect(OPTIONS_HTML).toContain('../utils/chatgpt-conversation-parser.js');
    expect(OPTIONS_HTML).toContain('../utils/perplexity-parser.js');
  });

  test('manifest.json НЕ изменён: архив не добавлен в content_scripts/host_permissions', () => {
    expect(MANIFEST).not.toContain('archive');
    const m = JSON.parse(MANIFEST);
    expect(m.version).toBe('1.16.0');
    expect(m.content_scripts[0].js).not.toContain('utils/archive-import.js');
    expect(m.host_permissions.length).toBe(9);
    expect(m.host_permissions).toContain('https://gemini.google.com/*');
  });
});

// =====================================================================================
// Д) jsdom-интеграция: FileReader-импорт и индикатор источника
// =====================================================================================
describe('T1: options.js — импорт архива и индикатор источника (jsdom)', () => {
  const DOM_IDS = [
    'stat-site', 'stat-model', 'stat-tokens', 'stat-limit', 'stat-percent', 'stat-source',
    'model-select', 'custom-limit', 'show-widget', 'api-key', 'toggle-api-key',
    'exact-count', 'debugLogs', 'export-md', 'export-json', 'export-pdf', 'export-txt',
    'export-hint', 'stale-warning', 'export-diag', 'reset-limit',
    'aiCmAutoExport', 'aiCmAutoExportPct', 'aiCmAutoExportFmt',
    'aiCmProactive', 'aiCmProactiveNotify',
    'aiCmProactiveLow', 'aiCmProactiveMedium', 'aiCmProactiveHigh',
    'archive-file', 'archive-import', 'archive-refresh', 'archive-status', 'archive-list'
  ];

  function setupDom() {
    const versionEl = document.createElement('span');
    versionEl.className = 'version';
    document.body.appendChild(versionEl);
    DOM_IDS.forEach(function (id) {
      const el = document.createElement('div');
      el.id = id;
      document.body.appendChild(el);
    });
  }

  function createChromeMock(store) {
    const listeners = [];
    return {
      store: store,
      listeners: listeners,
      chrome: {
        runtime: {
          getManifest: function () { return { version: '1.15.3' }; },
          getURL: function () { return 'print.html'; },
          lastError: null,
          sendMessage: function () { }
        },
        storage: {
          sync: { get: function (keys, cb) { cb({}); }, set: function () { } },
          local: {
            get: function (keys, cb) {
              const out = {};
              if (keys === null || keys === undefined) {
                Object.keys(store).forEach(function (k) { out[k] = store[k]; });
              } else {
                (typeof keys === 'string' ? [keys] : keys).forEach(function (k) {
                  if (Object.prototype.hasOwnProperty.call(store, k)) out[k] = store[k];
                });
              }
              cb(out);
            },
            getKeys: function (cb) { cb(Object.keys(store)); },
            set: function (obj, cb) { Object.assign(store, obj); if (cb) cb(); },
            remove: function (keys, cb) {
              (typeof keys === 'string' ? [keys] : keys || []).forEach(function (k) { delete store[k]; });
              if (cb) cb();
            }
          },
          onChanged: { addListener: function (fn) { listeners.push(fn); } }
        },
        tabs: {
          query: function (q, cb) {
            cb([{ id: 1, url: 'https://gemini.google.com/app/7c1f4a9b2e8d3a05' }]);
          }
        }
      }
    };
  }

  let mod;
  let mock;

  beforeEach(() => {
    jest.resetModules();
    document.body.innerHTML = '';
    setupDom();
    window.AiCmArchiveImport = require('../../utils/archive-import.js');
    window.AiCmExportBuilders = require('../../utils/export-text-builders.js');
    window.buildReferenceText = require('../../utils/buildReferenceText.js');
    mock = createChromeMock({});
    global.chrome = mock.chrome;
    mod = require('../../options/options.js');
  });

  afterEach(() => {
    delete global.chrome;
    delete window.AiCmArchiveImport;
    delete window.AiCmExportBuilders;
    delete window.buildReferenceText;
  });

  test('buildArchiveStoragePatch пишет ОБА ключа T1 на каждый диалог', () => {
    const rec = AI.buildArchiveRecord({
      convId: 'abc123', service: 'gemini', format: AI.FORMATS.GEMINI_TAKEOUT,
      title: 'T', messages: [{ role: 'user', text: 'привет' }]
    }, { fileName: 'MyActivity.json', importedAt: 5 });
    const patch = mod.buildArchiveStoragePatch([rec], 'MyActivity.json');
    expect(Object.keys(patch).sort()).toEqual(['aiCmArchive:abc123', 'aiCmConvSource:abc123']);
    expect(patch['aiCmArchive:abc123'].count).toBe(1);
    expect(patch['aiCmConvSource:abc123'].kind).toBe('archive');
    expect(patch['aiCmConvSource:abc123'].label).toBe('архив: Gemini Takeout · 1 сообщ.');
  });

  test('FileReader-импорт файла Gemini Takeout → патч для оба диалогов фикстуры', (done) => {
    const text = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'archive', 'gemini-takeout.json'), 'utf8');
    const file = new File([text], 'MyActivity.json', { type: 'application/json' });
    mod.aiCmImportArchiveFiles([file], function (err, report) {
      try {
        expect(err).toBeNull();
        expect(report.files).toBe(1);
        expect(report.conversations).toBe(2);
        expect(report.accepted).toBe(2);
        expect(report.errors).toEqual([]);
        expect(Object.keys(report.patch).sort()).toEqual([
          'aiCmArchive:7c1f4a9b2e8d3a05', 'aiCmArchive:9ab31d77c0f2e614',
          'aiCmConvSource:7c1f4a9b2e8d3a05', 'aiCmConvSource:9ab31d77c0f2e614'
        ]);
        expect(report.patch['aiCmArchive:7c1f4a9b2e8d3a05'].count).toBe(4);
        expect(report.patch['aiCmArchive:9ab31d77c0f2e614'].count).toBe(2);
        done();
      } catch (eAssert) { done(eAssert); }
    });
  });

  test('битый файл → ошибка в отчёте, а не исключение', (done) => {
    const file = new File(['{ это не json'], 'bad.json', { type: 'application/json' });
    mod.aiCmImportArchiveFiles([file], function (err, report) {
      try {
        expect(err).toBeNull();
        expect(report.accepted).toBe(0);
        expect(report.errors[0]).toEqual({ fileName: 'bad.json', error: 'invalid-json' });
        done();
      } catch (eAssert) { done(eAssert); }
    });
  });

  test('отчёт об импорте читаем и содержит счётчики', () => {
    const txt = mod.formatArchiveReport({
      files: 2, conversations: 3, accepted: 3, bytes: 2048,
      skipped: [{ reason: 'too-large', convId: 'x' }],
      errors: [{ fileName: 'f.json', error: 'invalid-json' }]
    });
    expect(txt).toContain('файлов: 2');
    expect(txt).toContain('диалогов: 3');
    expect(txt).toContain('импортировано: 3');
    expect(txt).toContain('too-large×1');
    expect(txt).toContain('f.json (invalid-json)');
  });

  test('попап показывает ярлык источника из aiCmState хоста', () => {
    require('../../options/options.js');
    // состояние активной вкладки Gemini с архивным источником
    mock.store['aiCmState:gemini.google.com'] = {
      host: 'gemini.google.com',
      site: 'gemini',
      model: 'Gemini 2.5 Flash',
      tokens: 1000,
      limit: 1000000,
      percent: 0.1,
      updatedAt: Date.now(),
      stale: false,
      sourceKind: 'archive',
      sourceLabel: 'архив: Gemini Takeout · 4 сообщ.'
    };
    // DOMContentLoaded уже мог отработать при require — триггерим обработчик явно
    document.dispatchEvent(new Event('DOMContentLoaded'));
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        try {
          expect(document.getElementById('stat-source').textContent).toBe('архив: Gemini Takeout · 4 сообщ.');
          resolve();
        } catch (e) { reject(e); }
      }, 0);
    });
  });
});
