/**
 * v2.0.29 (Xray/Firefox): мосты ISOLATED→MAIN и разбор `detail`.
 *
 * ПРИЧИНА. В Firefox объект, созданный в одном компартменте (ISOLATED content-script),
 * попадает в другой (MAIN page-script) под Xray-обёрткой: своё чтение
 * `new CustomEvent(name, { detail: {...} })` ещё работает, а вот `ev.detail.convId` в
 * MAIN падает «Permission denied to access property». Мост молча терял событие —
 * отваливались сетевой дозапрос экспорта DeepSeek, догрузка файлов, архив Gemini и
 * латч автоэкспорта.
 *
 * ЧТО СДЕЛАНО (v2.0.29). `detail` всех шести мостов строится `JSON.stringify({...})` —
 * через границу компартментов идёт примитив-строка (Xray нечего оборачивать), а MAIN-мир
 * разбирает её хелпером `aiCmBridgeDetail(ev)`. Хелпер терпим к объекту: старые
 * отправители, jsdom-фикстуры и прямые вызовы слушателей в тестах продолжают работать.
 *
 * ПИНЫ. Ниже — контракт именно этого фикса, а не поведение потребителей (оно покрыто
 * отдельными наборами adapters/*):
 *   X1 шесть `CustomEvent` строят `detail` строкой JSON;
 *   X2 объектного `detail` у этих имён не осталось;
 *   X3 хелпер есть во всех пяти MAIN-мирах, тело одинаковое, catch не молчаливый;
 *   X4 потребители переведены на хелпер (ISOLATED-строку читают, объект принимают);
 *   X5 рантайм: строка→объект, объект→как есть, мусор/отсутствие→null, чужой объект
 *      не трогается полями (Xray-инвариант);
 *   X6 сквозной контракт: полезная нагрузка каждого моста переживает провод.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Переводы строк/отступы не должны ломать пины: сравниваем нормализованный текст. */
const squash = (s) => s.replace(/\s+/g, ' ');

const HELPER_SIG = 'function aiCmBridgeDetail(ev) {';
const CATCH_BODY = 'catch (eBd) { return null; }';

/** Шесть мостов ISOLATED→MAIN: имя события, файл-отправитель и форма полезной нагрузки. */
const BRIDGES = [
  {
    event: 'ai-cm-deepseek-net-sync',
    from: 'core/base-handler.js',
    payload: ['requestId: reqId, convId: convId, timeoutMs: cap'],
    key: 'convId'
  },
  {
    event: 'ai-cm-deepseek-files-drain',
    from: 'core/base-handler.js',
    payload: ['requestId: reqId, timeoutMs: cap'],
    key: 'requestId'
  },
  {
    event: 'ai-cm-archive-restore',
    from: 'core/content.js',
    payload: [
      'convId: convId,',
      'messages: rec.messages,',
      'count: (typeof rec.count === \'number\' && rec.count > 0) ? rec.count : rec.messages.length,',
      'textLen: (typeof rec.textLen === \'number\') ? rec.textLen : 0,',
      'format: rec.format || \'\',',
      'service: rec.service || \'\',',
      'title: rec.title || \'\''
    ],
    key: 'messages'
  },
  {
    event: 'ai-cm-restored-history',
    from: 'core/content.js',
    payload: ['convId: convId,', 'turns: entry.turns,', 'meta: entry.meta || {}'],
    key: 'turns'
  },
  {
    event: 'ai-cm-cache-refresh',
    from: 'core/content.js',
    payload: ['convId: convId'],
    key: 'convId'
  },
  {
    event: 'ai-cm-auto-export-fired',
    from: 'core/export-manager.js',
    payload: ["convId: cid, site: siteNameD || '', reason: reason || ''"],
    key: 'reason'
  }
];

/** Пять MAIN-миров: где лежит хелпер и как он встроен в потребителя. */
const MAIN_WORLDS = [
  { file: 'core/deepseek-netsync.js', call: 'var d = aiCmBridgeDetail(ev) || {};', count: 1, event: 'ai-cm-deepseek-net-sync' },
  { file: 'core/deepseek-files.js', call: 'filesDrainHandle(aiCmBridgeDetail(ev));', count: 1, event: 'ai-cm-deepseek-files-drain' },
  { file: 'core/gemini-archive.js', call: 'var detail = aiCmBridgeDetail(ev);', count: 3, event: 'ai-cm-archive-restore' },
  { file: 'core/gemini-hidden-scroll.js', call: 'var dFired = aiCmBridgeDetail(ev);', count: 1, event: 'ai-cm-auto-export-fired' },
  { file: 'core/gemini-loader-scroll.js', call: 'var dFired = aiCmBridgeDetail(ev);', count: 1, event: 'ai-cm-auto-export-fired' }
];

/** Тело хелпера из реального файла (единственный источник правды для рантайм-проверок). */
function helperBody(rel) {
  const text = read(rel);
  const i = text.indexOf(HELPER_SIG);
  expect(i).toBeGreaterThan(-1);
  const j = text.indexOf('\n  }', i);
  expect(j).toBeGreaterThan(i);
  return text.slice(i, j + 4);
}

function helperOf(rel) {
  // eslint-disable-next-line no-new-func
  return new Function('return (' + helperBody(rel) + ');')();
}

/** Полезная нагрузка моста в том виде, в каком её кладёт отправитель. */
const PAYLOADS = {
  'ai-cm-deepseek-net-sync': { requestId: 'r-ns-1', convId: 'c-1', timeoutMs: 12000 },
  'ai-cm-deepseek-files-drain': { requestId: 'r-fd-1', timeoutMs: 8000 },
  'ai-cm-archive-restore': {
    convId: 'c-1',
    messages: [{ role: 'user', text: 'привет' }, { role: 'assistant', text: 'ответ' }],
    count: 2,
    textLen: 12,
    format: 'json',
    service: 'gemini',
    title: 'чат'
  },
  'ai-cm-restored-history': { convId: 'c-1', turns: [{ role: 'user', text: 'привет' }], meta: { tier: 2 } },
  'ai-cm-cache-refresh': { convId: 'c-1' },
  'ai-cm-auto-export-fired': { convId: 'c-1', site: 'gemini', reason: 'data-complete' }
};

describe('v2.0.29 Xray: X1 — все шесть мостов строят detail строкой JSON', () => {
  BRIDGES.forEach((b) => {
    test(`${b.event}: ${b.from} — detail через JSON.stringify`, () => {
      const s = squash(read(b.from));
      expect(s).toContain(`new CustomEvent('${b.event}', { detail: JSON.stringify({`);
      b.payload.forEach((fragment) => expect(s).toContain(fragment));
    });
  });

  test('JSON.stringify обёрнут вокруг полезной нагрузки, а не вокруг всего dispatch', () => {
    // иначе `new CustomEvent(...)` перестал бы совпадать с пинами адаптеров (d2/o18)
    BRIDGES.forEach((b) => {
      const s = squash(read(b.from));
      expect(s).not.toContain(`JSON.stringify(new CustomEvent('${b.event}'`);
      expect(s).toContain(`window.dispatchEvent(new CustomEvent('${b.event}'`);
    });
  });
});

describe('v2.0.29 Xray: X2 — объектного detail у этих имён не осталось', () => {
  BRIDGES.forEach((b) => {
    test(`${b.event}: нет detail: {`, () => {
      const s = squash(read(b.from));
      expect(s).not.toContain(`new CustomEvent('${b.event}', { detail: {`);
      expect(s).not.toContain(`detail: ({`);
    });
  });

  test('в мостах не осталось ни одного `detail: {` (всегда строка)', () => {
    BRIDGES.forEach((b) => {
      const m = squash(read(b.from)).match(new RegExp(`new CustomEvent\\('${b.event}'[^)]{0,40}detail:\\s*\\{`, 'g'));
      expect(m).toBeNull();
    });
  });
});

describe('v2.0.29 Xray: X3 — хелпер aiCmBridgeDetail в пяти MAIN-мирах', () => {
  test('тело хелпера одинаковое во всех файлах', () => {
    const bodies = MAIN_WORLDS.map((m) => helperBody(m.file));
    bodies.forEach((b) => expect(b).toBe(bodies[0]));
    expect(bodies[0]).toContain("var raw = (ev && ev.detail !== undefined) ? ev.detail : null;");
    expect(bodies[0]).toContain("if (typeof raw !== 'string') return raw || null;");
    expect(bodies[0]).toContain('try { return JSON.parse(raw); }');
  });

  test('catch хелпера не молчаливый (иначе новый незаявленный silent catch)', () => {
    MAIN_WORLDS.forEach((m) => expect(read(m.file)).toContain(CATCH_BODY));
  });

  test('хелпер определён в PURE-зоне: до первого window.addEventListener', () => {
    MAIN_WORLDS.forEach((m) => {
      const text = read(m.file);
      const helperAt = text.indexOf(HELPER_SIG);
      const listenAt = text.indexOf("window.addEventListener('");
      expect(helperAt).toBeGreaterThan(-1);
      expect(listenAt).toBeGreaterThan(-1);
      expect(helperAt).toBeLessThan(listenAt);
    });
  });
});

describe('v2.0.29 Xray: X4 — потребители переведены на хелпер', () => {
  MAIN_WORLDS.forEach((m) => {
    test(`${m.file}: ${m.call}`, () => {
      const text = read(m.file);
      const hits = text.split(m.call).length - 1;
      expect(hits).toBe(m.count);
      expect(text).not.toContain('(ev && ev.detail)');
      expect(text).not.toContain('filesDrainHandle(ev && ev.detail)');
    });
  });

  test('слушатели остались на том же имени события (формат канала не менялся)', () => {
    MAIN_WORLDS.forEach((m) => {
      expect(read(m.file)).toContain(`window.addEventListener('${m.event}'`);
    });
  });
});

describe('v2.0.29 Xray: X5 — рантайм-контракт разбора', () => {
  const parse = helperOf('core/deepseek-netsync.js');

  test('строка JSON → объект', () => {
    expect(parse({ detail: '{"convId":"c-1","timeoutMs":5000}' })).toEqual({ convId: 'c-1', timeoutMs: 5000 });
  });

  test('объект проходит как есть (старые отправители и jsdom-фикстуры)', () => {
    const obj = { convId: 'c-1', turns: [] };
    expect(parse({ detail: obj })).toBe(obj);
  });

  test('нет detail / нет события / null → null', () => {
    expect(parse(null)).toBeNull();
    expect(parse(undefined)).toBeNull();
    expect(parse({})).toBeNull();
    expect(parse({ detail: null })).toBeNull();
    expect(parse({ detail: undefined })).toBeNull();
  });

  test('битый JSON → null, без throw (мост не должен падать от чужой строки)', () => {
    expect(() => parse({ detail: '{' })).not.toThrow();
    expect(parse({ detail: '{' })).toBeNull();
    expect(parse({ detail: '' })).toBeNull();
  });

  test('примитив-не-строка проходит как есть (совместимость с legacy)', () => {
    expect(parse({ detail: 0 })).toBeNull();          // 0 || null → null
    expect(parse({ detail: 7 })).toBe(7);
  });

  test('Xray-инвариант: чужой объект не трогается чтением полей', () => {
    // ровно так ведёт себя Xray-обёртка: любое чтение свойства чужого объекта бросает
    const hostile = new Proxy({}, {
      get() { throw new Error('Permission denied to access property'); },
      has() { throw new Error('Permission denied to access property'); },
      getPrototypeOf() { throw new Error('Permission denied to access property'); }
    });
    expect(() => parse({ detail: hostile })).not.toThrow();
    expect(parse({ detail: hostile })).toBe(hostile);
  });

  test('детерминированность: два разбора одной строки дают равные объекты', () => {
    const wire = JSON.stringify(PAYLOADS['ai-cm-archive-restore']);
    expect(parse({ detail: wire })).toEqual(parse({ detail: wire }));
  });
});

describe('v2.0.29 Xray: X6 — сквозной контракт «отправитель→провод→получатель»', () => {
  const parsers = {
    'core/deepseek-netsync.js': helperOf('core/deepseek-netsync.js'),
    'core/deepseek-files.js': helperOf('core/deepseek-files.js'),
    'core/gemini-archive.js': helperOf('core/gemini-archive.js'),
    'core/gemini-hidden-scroll.js': helperOf('core/gemini-hidden-scroll.js'),
    'core/gemini-loader-scroll.js': helperOf('core/gemini-loader-scroll.js')
  };

  BRIDGES.forEach((b) => {
    test(`${b.event}: строка переживает границу и разбирается любым MAIN-миром`, () => {
      const wire = JSON.stringify(PAYLOADS[b.event]);
      expect(typeof wire).toBe('string');            // примитив, а не объект компартмента
      Object.keys(parsers).forEach((file) => {
        const got = parsers[file]({ detail: wire });
        expect(got).toEqual(PAYLOADS[b.event]);
        expect(got[b.key]).toEqual(PAYLOADS[b.event][b.key]);
      });
    });
  });

  test('escaped-текст и вложенные структуры не искажаются на проводе', () => {
    const wire = JSON.stringify({
      convId: 'c-"1"',
      messages: [{ role: 'user', text: 'строка\nс переводом "и" кавычками \\ и юникодом \u00A7' }],
      count: 1
    });
    const got = parsers['core/gemini-archive.js']({ detail: wire });
    expect(got.messages[0].text).toBe('строка\nс переводом "и" кавычками \\ и юникодом \u00A7');
    expect(got.convId).toBe('c-"1"');
  });
});
