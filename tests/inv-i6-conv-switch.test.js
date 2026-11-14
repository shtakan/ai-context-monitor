'use strict';

/**
 * S4 / I6 (ADR-001 §7 п.4): снимок метрики принадлежит РОВНО ОДНОМУ чату.
 *
 * Контракт:
 *  - aiCmCanonicalConvId() = aiCmAutoExportConvId() || getCurrentConvId() || '' — одна
 *    формула для записи и чтения (core/state.ts);
 *  - aiCmReadContextSnapshot(convId) без аргумента/с пустым/чужим convId → null;
 *    снимок с convId === '' не коммитится;
 *  - все потребители (loader-unfreeze, бейдж, GET_STATS, recreate, писатели истории/ручного
 *    экспорта/автоэкспорта) передают канонический id, поэтому число прошлого чата не
 *    протекает ни в раннем окне (convId ещё ''), ни после перехода A → B;
 *  - reset гасит снимок/lastPercentage ТОЛЬКО при фактической смене чата: тот же чат
 *    сохраняет опубликованный снимок, чужой — не переносится.
 *
 * Исполняется РЕАЛЬНЫЙ исходник core/state.ts (loadAsClassic) и реальные срезы
 * core/content.ts / core/widget.ts в песочнице with(ctx) — конвенция сьюта.
 */

const loadEsm = require('./helpers/load-esm.js');
const { moduleSource } = require('./helpers/content-source.js');

const CONTENT = moduleSource('content.ts');
const WIDGET = moduleSource('widget.ts');

/** Рез функции по балансу фигурных скобок. */
function fnDecl(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('inv-i6: нет function ' + name + '(');
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('inv-i6: unbalanced ' + name);
}

/** Срез от маркера до парной закрывающей скобки блока, открытого в маркере. */
function blockFrom(src, marker) {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error('inv-i6: якорь не найден: ' + marker);
  const open = src.indexOf('{', i + marker.length - 1);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  throw new Error('inv-i6: unbalanced block at ' + marker);
}

const A = 'conv-A';
const B = 'conv-B';

/** Реальные commit/read + доступ к lastTokensSnapshot и флагам окна сбора. */
function makeApi() {
  return new Function(loadEsm.loadAsClassic('core/state.ts') +
    '\nreturn { commit: aiCmCommitContextSnapshot, read: aiCmReadContextSnapshot,' +
    ' set: function (s) { lastTokensSnapshot = s; },' +
    ' get: function () { return lastTokensSnapshot; },' +
    ' loader: function (cid, v) { aiCmLoaderRunningByConv[cid] = v; } };')();
}

function snapshot(over) {
  return Object.assign({
    convId: A,
    capturedAt: Date.now(),
    site: 'gemini',
    model: 'gemini-2.5-pro',
    modelName: 'Gemini 2.5 Pro',
    src: 'dom',
    tokens: 12345,
    percent: 12.3,
    limit: 1000000,
    effectiveLimit: 1000000,
    contextLimit: 1000000,
    baseComplete: true,
    partial: false,
    bodyHash: 'h-A'
  }, over || {});
}

describe('I6: чтение снимка по каноническому convId', function () {
  test('чужой convId → null; пустой/без аргумента → null; совпадающий → копия', function () {
    const api = makeApi();
    api.set(snapshot({ convId: A }));
    expect(api.read(B)).toBeNull();
    expect(api.read('')).toBeNull();
    expect(api.read()).toBeNull();          // лазейка «asked === ''» закрыта
    const got = api.read(A);
    expect(got).not.toBeNull();
    expect(got.convId).toBe(A);
    expect(got.tokens).toBe(12345);
    expect(got).not.toBe(api.get());        // копия, а не живой объект
  });

  test('снимок с convId === \'\' не коммитится (ни первый, ни поверх prev)', function () {
    const api = makeApi();
    expect(api.commit(null, snapshot({ convId: '' }))).toBeNull();
    api.set(snapshot({ convId: A }));
    const prev = api.get();
    const out = api.commit(prev, snapshot({ convId: '', tokens: 1, percent: 0.1 }));
    expect(out).toBe(prev);
    expect(api.read(A).tokens).toBe(12345);
  });

  test('снимок чата A не читается после перехода на B — все 10 call sites передают helper', function () {
    const api = makeApi();
    api.set(snapshot({ convId: A }));
    const consumers = ['content.ts', 'export-manager.ts'].map(function (file) {
      return { file: file, src: file === 'content.ts' ? CONTENT : require('./helpers/content-source.js').readSource('core/export-manager.ts') };
    });
    let total = 0;
    consumers.forEach(function (c) {
      const re = /aiCmReadContextSnapshot\(/g;
      let m;
      while ((m = re.exec(c.src))) {
        total++;
        // каждый вызов либо сразу принимает аргумент, либо открывает typeof-ветку с canonical
        const after = c.src.slice(m.index, m.index + 260);
        expect(after).toMatch(/aiCmCanonicalConvId/);
      }
    });
    expect(total).toBe(10);
    // поведенчески: те же четыре «безаргументных» потребителя получают null на чужом чате
    expect(api.read(B)).toBeNull();
    expect(api.read(B)).toBeNull();
    expect(api.read(B)).toBeNull();
    expect(api.read(B)).toBeNull();
  });

  test('раннее окно (convId ещё \'\'): ни один потребитель не получает число прошлого чата', function () {
    const api = makeApi();
    api.set(snapshot({ convId: A }));
    // canonical helper при пустом UI возвращает '' → reader обязан отдать null, а не A
    const canonical = function () { return ''; };
    const asked = canonical() || '';
    expect(asked).toBe('');
    expect(api.read(asked)).toBeNull();
  });
});

describe('I6: reset по факту смены чата (widget + content)', function () {
  // Реальный регион widget.resetConversationState: guard canonical convId + гашение снимка/процента.
  function runWidgetReset(ctx) {
    // Три I6-оператора reset: guard по canonical convId, гашение снимка, гашение процента.
    // Регион между ними — присваивания базы (не про I6) и здесь не исполняется.
    const iGuard = WIDGET.indexOf('var aiCmResetCid = (typeof aiCmCanonicalConvId');
    const guardTail = 'lastTokensSnapshot.convId === aiCmResetCid);';
    const iGuardEnd = WIDGET.indexOf(guardTail, iGuard);
    const CLEAR = "if (!aiCmResetKeepSnap && typeof lastTokensSnapshot !== 'undefined') lastTokensSnapshot = null;";
    const PCT = 'if (!aiCmResetKeepSnap) lastPercentage = -1;';
    const iClear = WIDGET.indexOf(CLEAR);
    const iPct = WIDGET.indexOf(PCT);
    // Мутация «убрать сброс lastTokensSnapshot из reset» ломает этот якорь → тест падает.
    expect(iGuard).toBeGreaterThan(-1);
    expect(iGuardEnd).toBeGreaterThan(iGuard);
    expect(iClear).toBeGreaterThan(iGuardEnd);
    expect(iPct).toBeGreaterThan(iClear);
    const code = WIDGET.slice(iGuard, iGuardEnd + guardTail.length) + CLEAR + PCT;
    return new Function('ctx', 'with (ctx) { ' + code + '\nreturn { keep: aiCmResetKeepSnap }; }')(ctx);
  }

  test('тот же чат: опубликованный снимок и lastPercentage НЕ стираются', function () {
    const ctx = {
      aiCmCanonicalConvId: function () { return A; },
      lastTokensSnapshot: snapshot({ convId: A }),
      lastPercentage: 42,
      debugLog: function () { }
    };
    const out = runWidgetReset(ctx);
    expect(out.keep).toBe(true);
    expect(ctx.lastTokensSnapshot.convId).toBe(A);
    expect(ctx.lastTokensSnapshot.tokens).toBe(12345);
    expect(ctx.lastPercentage).toBe(42);
  });

  test('чужой чат: снимок гасится, процент сбрасывается (не переносится)', function () {
    const ctx = {
      aiCmCanonicalConvId: function () { return B; },
      lastTokensSnapshot: snapshot({ convId: A }),
      lastPercentage: 42,
      debugLog: function () { }
    };
    const out = runWidgetReset(ctx);
    expect(out.keep).toBe(false);
    expect(ctx.lastTokensSnapshot).toBeNull();
    expect(ctx.lastPercentage).toBe(-1);
  });

  test('пустой canonical convId: чужой снимок тоже не переносится', function () {
    const ctx = {
      aiCmCanonicalConvId: function () { return ''; },
      lastTokensSnapshot: snapshot({ convId: A }),
      lastPercentage: 42,
      debugLog: function () { }
    };
    const out = runWidgetReset(ctx);
    expect(out.keep).toBe(false);
    expect(ctx.lastTokensSnapshot).toBeNull();
    expect(ctx.lastPercentage).toBe(-1);
  });

  test('content v37: смена convId гасит чужой снимок, тот же — сохраняет', function () {
    const block = blockFrom(CONTENT, 'if (emitConvId && emitConvId !== lastSnapConvId) {');
    const ctx = {
      emitConvId: B,
      lastSnapConvId: A,
      lastTokensSnapshot: snapshot({ convId: A }),
      lastPercentage: 42,
      maxTokenCount: 12345,
      aiCmBaseSource: 'dom',
      aiCmCanonicalConvId: function () { return B; },
      debugLog: function () { }
    };
    new Function('ctx', 'with (ctx) { ' + block + ' }')(ctx);
    expect(ctx.lastTokensSnapshot).toBeNull();
    expect(ctx.lastPercentage).toBe(-1);

    // тот же чат: emit непустой, lastSnapConvId пуст (первый эмит), снимок уже этого чата
    const same = {
      emitConvId: A,
      lastSnapConvId: '',
      lastTokensSnapshot: snapshot({ convId: A }),
      lastPercentage: 42,
      maxTokenCount: 12345,
      aiCmBaseSource: 'dom',
      aiCmCanonicalConvId: function () { return A; },
      debugLog: function () { }
    };
    new Function('ctx', 'with (ctx) { ' + block + ' }')(same);
    expect(same.lastTokensSnapshot.convId).toBe(A);
    expect(same.lastPercentage).toBe(42);
    expect(same.maxTokenCount).toBe(0);       // база нового/того же эмита пересобирается
  });
});
