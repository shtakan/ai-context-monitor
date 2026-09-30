/**
 * UI-аудит 2026-09-28, Minor-подбатч B (поверхность options), находки #19/#20/#21:
 *   #19 (WCAG 1.4.10, 2.5.3; i18n): длинные RU/EN-строки обрезались / давали layout shift.
 *   #20 (Nielsen #6, WCAG 2.5.3): кнопки экспорта md/json/pdf/txt были непонятны без контекста
 *        и неровно переносились → сетка 2×2 + короткие подписи + доступные имена, MD — primary.
 *   #21 (WCAG 3.3.2, 3.3.3): поля порогов 70/85/95 без единицы измерения и визуальной валидации
 *        → суффикс «%», inputmode="numeric", статическое сообщение о диапазоне, CSS :invalid.
 *
 * Тест статический: читает реальные options/options.html, options/options.css и обе локали
 * с диска, снимает комментарии CSS и достаёт тела правил по селектору; DOM — через DOMParser.
 * Доступность #21 сделана БЕЗ правок options.js: tests/a11y-options.test.js:340-342 допускает
 * в options.js ровно одно вхождение `aria-` (aria-pressed кнопки-глаза) и запрещает focus-visible.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OPTIONS_HTML = fs.readFileSync(path.join(ROOT, 'options', 'options.html'), 'utf8');
const OPTIONS_CSS = fs.readFileSync(path.join(ROOT, 'options', 'options.css'), 'utf8');
const OPTIONS_JS = fs.readFileSync(path.join(ROOT, 'options', 'options.js'), 'utf8');
const RU = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', 'ru', 'messages.json'), 'utf8'));
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', 'en', 'messages.json'), 'utf8'));

const doc = new DOMParser().parseFromString(OPTIONS_HTML, 'text/html');

const EXPORT_IDS = ['export-md', 'export-json', 'export-pdf', 'export-txt'];
const THRESHOLD_IDS = ['aiCmProactiveLow', 'aiCmProactiveMedium', 'aiCmProactiveHigh'];
const ADVANCED_ID = 'advanced-section';
const MSG_ID = 'proactive-threshold-msg';

/** CSS без комментариев: ключевое слово в комментарии — не объявление. */
function withoutComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

const CSS = withoutComments(OPTIONS_CSS);

/** Все пары «селектор — тело правила». */
function rulesOf(css) {
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    rules.push({ selector: m[1].trim(), body: m[2] });
  }
  return rules;
}

const RULES = rulesOf(CSS);

/**
 * Тело правила по ТОЧНОМУ селектору (как в tests/wcag-contrast.test.js: `.btn-export`
 * не должен совпасть с `.btn-export:disabled` или `.btn-export--primary`).
 */
function bodyOf(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(?:^|[};])\\s*' + escaped + '\\s*\\{([^{}]*)\\}');
  const m = css.match(re);
  // файл на диске — CRLF; для байтового сравнения тел правил нормализуем перевод строки
  return m ? m[1].replace(/\r\n/g, '\n') : '';
}

/** Объявления тела правила в виде карты «свойство → значение» (последнее побеждает). */
function declsOf(body) {
  const map = {};
  body.split(';').forEach(function (chunk) {
    const i = chunk.indexOf(':');
    if (i === -1) return;
    map[chunk.slice(0, i).trim()] = chunk.slice(i + 1).trim();
  });
  return map;
}

function decls(css, selector) {
  return declsOf(bodyOf(css, selector));
}

/** Все тела правил, у которых селектор совпал точно или входит в групповой список. */
function bodiesFor(css, selector) {
  return rulesOf(css)
    .filter(function (rule) {
      return rule.selector.split(',').map(function (s) { return s.trim(); }).indexOf(selector) !== -1;
    })
    .map(function (rule) { return rule.body; });
}

function tagOfId(id) {
  const re = new RegExp('<[a-zA-Z]+(?=[^>]*\\bid="' + id + '")[^>]*>');
  const m = OPTIONS_HTML.match(re);
  return m ? m[0] : '';
}

/* =====================================================================================
 * #19 — устойчивая раскладка RU/EN (WCAG 1.4.10 Reflow)
 * ===================================================================================== */

describe('#19 (options): раскладка не ломается на узком окне и при длинных RU/EN-строках', () => {
  test('body: фиксированная width убрана, ширина больше не задаётся жёстко', () => {
    const body = decls(CSS, 'body');
    expect(body.width).toBeUndefined();
    expect(body['min-width']).toBe('0');
    expect(body['max-width']).toBe('100%');
  });

  test('body: overflow-wrap: anywhere — длинные строки переносятся, а не выпирают', () => {
    expect(decls(CSS, 'body')['overflow-wrap']).toBe('anywhere');
  });

  test('flex-дети инпутов получили min-width: 0 (иначе min-content перебивает сжатие)', () => {
    expect(decls(CSS, '.input-row input')['min-width']).toBe('0');
    expect(decls(CSS, '.api-key-row input')['min-width']).toBe('0');
  });

  test('у целевых текстовых блоков нет фиксированных width', () => {
    ['.label', '.hint', '.input-row', '.export-grid', '.threshold-field'].forEach(function (sel) {
      expect([sel, decls(CSS, sel).width]).toEqual([sel, undefined]);
    });
  });

  test('числовые поля порогов: размер в ch (inline-size), не в px', () => {
    const body = bodyOf(CSS, '.threshold-field input');
    const map = declsOf(body);
    expect(map['inline-size']).toMatch(/^[0-9.]+ch/);
    expect(map.width).toBeUndefined();
  });

  test('#aiCmAutoExportPct: ч-размер, но гарантия v1.8 «цифра не под спиннером» сохранена', () => {
    const map = decls(CSS, '#aiCmAutoExportPct');
    expect(map['inline-size']).toMatch(/^[0-9.]+ch/);
    expect(map.width).toBeUndefined();
    // гарантия v1.8: минимум 64px + отступ справа под стрелки спиннера
    expect(map['min-width']).toBe('64px');
    expect(map['padding-right']).toBe('20px');
    expect(map['flex']).toBe('0 0 auto');
  });
});

/* =====================================================================================
 * #20 — кнопки экспорта истории: сетка 2×2, короткие подписи, доступные имена
 * ===================================================================================== */

describe('#20 (options): кнопки экспорта истории', () => {
  const grid = doc.getElementById('export-history-grid');

  test('существует сетка #export-history-grid, содержащая ровно четыре кнопки в порядке MD/JSON/PDF/TXT', () => {
    expect(grid).not.toBeNull();
    const ids = Array.prototype.map.call(grid.querySelectorAll('button'), function (b) { return b.id; });
    expect(ids).toEqual(EXPORT_IDS);
  });

  test('CSS: сетка 2×2 (grid + repeat(2, minmax(72px, 1fr)))', () => {
    const map = decls(CSS, '.export-grid');
    expect(map.display).toBe('grid');
    expect(map['grid-template-columns']).toBe('repeat(2, minmax(72px, 1fr))');
    expect(map['min-width']).toBe('0');
  });

  test('#export-diag (экспорт диагностики) остался ВНЕ сетки истории', () => {
    const diag = doc.getElementById('export-diag');
    expect(diag).not.toBeNull();
    expect(grid.contains(diag)).toBe(false);
  });

  test('короткие визуальные подписи: MD / JSON / PDF / TXT', () => {
    const texts = EXPORT_IDS.map(function (id) { return doc.getElementById(id).textContent.trim(); });
    expect(texts).toEqual(['MD', 'JSON', 'PDF', 'TXT']);
  });

  test('локализованные строки действий сохранены в title через data-i18n-title', () => {
    [['export-md', 'options_export_md'], ['export-json', 'options_export_json'],
      ['export-pdf', 'options_export_pdf'], ['export-txt', 'options_export_txt']].forEach(function (pair) {
      const btn = doc.getElementById(pair[0]);
      expect([pair[0], btn.getAttribute('data-i18n-title')]).toEqual([pair[0], pair[1]]);
      expect([pair[0], btn.getAttribute('title')]).toEqual([pair[0], RU[pair[1]].message]);
      expect([pair[0], typeof EN[pair[1]]]).toEqual([pair[0], 'object']);
      // «токен подписи» обязан входить в доступное имя — WCAG 2.5.3 Label in Name
      expect([pair[0], btn.getAttribute('aria-label').indexOf(btn.textContent.trim())]).toEqual([pair[0], 0]);
    });
    // смысл «эталон» у TXT не потерян: и в title, и в доступном имени
    expect(RU.options_export_txt.message).toMatch(/эталон/i);
    expect(EN.options_export_txt.message).toMatch(/reference/i);
  });

  test('у каждой кнопки непустое доступное имя и парный ключ в ОБЕИХ локалях', () => {
    EXPORT_IDS.forEach(function (id) {
      const btn = doc.getElementById(id);
      const key = btn.getAttribute('data-i18n-aria-label');
      expect([id, typeof key === 'string' && key.length > 0]).toEqual([id, true]);
      expect([id, typeof btn.getAttribute('aria-label')]).toEqual([id, 'string']);
      expect([id, btn.getAttribute('aria-label').trim().length > 0]).toEqual([id, true]);
      // ключ есть в обеих локалях и ru-значение совпадает с fallback-разметкой
      expect([id, typeof RU[key]]).toEqual([id, 'object']);
      expect([id, typeof EN[key]]).toEqual([id, 'object']);
      expect([id, RU[key].message]).toEqual([id, btn.getAttribute('aria-label')]);
    });
  });

  test('«эталон» для TXT не потерян — перенесён в доступное имя', () => {
    expect(RU.options_export_txt_aria.message).toMatch(/эталон/i);
    expect(EN.options_export_txt_aria.message).toMatch(/reference/i);
  });

  test('primary-вид применён ровно к одной кнопке — MD', () => {
    const primary = Array.prototype.filter.call(grid.querySelectorAll('button'), function (b) {
      return b.classList.contains('btn-export--primary');
    });
    expect(primary.length).toBe(1);
    expect(primary[0].id).toBe('export-md');
  });

  test('CSS: правило primary существует и задаёт фон/цвет; у disabled — свой вид', () => {
    const map = decls(CSS, '.export-grid .btn-export--primary');
    expect(map.background).toMatch(/^#[0-9a-f]{6}$/i);
    expect(map.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(map.border || map['border-color']).toBeTruthy();
    const disabled = bodyOf(CSS, '.export-grid .btn-export--primary:disabled');
    expect(disabled).toMatch(/background:\s*#16213e/);
    expect(disabled).toMatch(/color:\s*#9a9ab0/);
  });
});

/* =====================================================================================
 * #21 — поля порогов: единица измерения, inputmode, сообщение о диапазоне, :invalid
 * ===================================================================================== */

describe('#21 (options): поля порогов 70/85/95', () => {
  test('у всех трёх полей: inputmode="numeric" и диапазон min/max/step сохранены', () => {
    THRESHOLD_IDS.forEach(function (id) {
      const tag = tagOfId(id);
      expect([id, /inputmode="numeric"/.test(tag)]).toEqual([id, true]);
      expect([id, /min="1"/.test(tag)]).toEqual([id, true]);
      expect([id, /max="100"/.test(tag)]).toEqual([id, true]);
      expect([id, /step="1"/.test(tag)]).toEqual([id, true]);
    });
  });

  test('каждое поле обёрнуто в .threshold-field с видимым суффиксом «%»', () => {
    THRESHOLD_IDS.forEach(function (id) {
      const input = doc.getElementById(id);
      const field = input.parentElement;
      expect([id, field.className]).toEqual([id, 'threshold-field']);
      const unit = field.querySelector('.threshold-unit');
      expect([id, unit !== null]).toEqual([id, true]);
      expect([id, unit.textContent.trim()]).toEqual([id, '%']);
      // «%» — языконейтральный токен-литерал: ключ локали с совпадающими ru/en-значениями
      // нарушил бы пин tests/i18n-locales.test.js:187-204 (совпадать могут только бренд
      // и options_info_separator), а править этот пин задание запрещает.
      expect([id, unit.getAttribute('data-i18n')]).toEqual([id, null]);
    });
    expect(RU.options_proactive_unit).toBeUndefined();
    expect(EN.options_proactive_unit).toBeUndefined();
  });

  test('статические подсказки о диапазоне связаны с полями через aria-describedby', () => {
    const msg = doc.getElementById(MSG_ID);
    expect(msg).not.toBeNull();
    expect(msg.tagName.toLowerCase()).toBe('span');
    THRESHOLD_IDS.forEach(function (id) {
      const described = doc.getElementById(id).getAttribute('aria-describedby');
      expect([id, described]).toEqual([id, MSG_ID]);
      expect([id, doc.getElementById(described) !== null]).toEqual([id, true]);
    });
    // текст сообщения: диапазон + фактическое поведение при неверном значении
    expect(msg.getAttribute('data-i18n')).toBe('options_proactive_hint');
    expect(RU.options_proactive_hint.message).toMatch(/1[–-]100/);
    expect(RU.options_proactive_hint.message).toMatch(/70\/85\/95/);
    expect(RU.options_proactive_hint.message).toBe(msg.textContent.trim());
    expect(EN.options_proactive_hint.message).toMatch(/1[–-]100/);
    expect(EN.options_proactive_hint.message).toMatch(/70\/85\/95/);
  });

  test('CSS: визуальная инвалидация — правило :invalid для трёх полей порогов', () => {
    const rule = RULES.filter(function (r) {
      return /:invalid/.test(r.selector) && THRESHOLD_IDS.every(function (id) {
        return r.selector.indexOf('#' + id) !== -1;
      });
    });
    expect(rule.length).toBeGreaterThanOrEqual(1);
    expect(rule[0].body).toMatch(/border-color:\s*#ef4444/);
  });
});

/* =====================================================================================
 * R-инварианты: числовые пины соседних находок не ослаблены
 * ===================================================================================== */

describe('R-инварианты Minor-подбатча B', () => {
  test('options.js: ровно одно `aria-` (aria-pressed) и ноль focus-visible', () => {
    // пин tests/a11y-options.test.js:340-342
    expect(OPTIONS_JS.match(/setAttribute\(\s*'aria-[a-z-]*'/g)).toEqual(["setAttribute('aria-pressed'"]);
    expect((OPTIONS_JS.match(/aria-/g) || []).length).toBe(1);
    expect(OPTIONS_JS).not.toMatch(/focus-visible/);
  });

  test('тела правил .btn-export и .btn-export:disabled байтово прежние', () => {
    const btnExport = ['',
      '  flex: 1;',
      '  padding: 8px 10px;',
      '  border-radius: 8px;',
      '  border: 1px solid #2a2a4a;',
      '  background: #16213e;',
      '  color: #ffffff;',
      '  font-size: 12px;',
      '  cursor: pointer;',
      '  white-space: nowrap;',
      ''].join('\n');
    const btnExportDisabled = ['',
      '  color: #9a9ab0;',
      '  cursor: not-allowed;',
      ''].join('\n');
    expect(bodyOf(CSS, '.btn-export')).toBe(btnExport);
    expect(bodyOf(CSS, '.btn-export:disabled')).toBe(btnExportDisabled);
  });

  test('словарь: ru = en и паритет ключей key-in-key', () => {
    const ru = Object.keys(RU).sort();
    const en = Object.keys(EN).sort();
    expect(ru.length).toBe(en.length);
    expect(ru).toEqual(en);
    // четыре ключа Minor-подбатча B на месте (доступные имена кнопок экспорта)
    ['options_export_md_aria', 'options_export_json_aria', 'options_export_pdf_aria',
      'options_export_txt_aria'].forEach(function (key) {
      expect([key, typeof RU[key], typeof EN[key]]).toEqual([key, 'object', 'object']);
    });
  });

  test('в словаре нет новых ru/en-совпадений вне разрешённого allowlist', () => {
    // языконейтральные токены (MD/JSON/PDF/TXT, «%») заведены литералами, а не ключами:
    // совпадать в ru/en могут только брендовые строки и разделитель (пин i18n :187-204)
    const allowed = ['ext_name', 'options_page_title', 'options_header_title', 'docs_h1',
      'options_info_separator'];
    const identical = Object.keys(RU).filter(function (key) {
      return RU[key].message === EN[key].message;
    });
    expect(identical.filter(function (key) { return allowed.indexOf(key) === -1; })).toEqual([]);
    // и прежние длинные значения строк экспорта не подменены токенами
    expect(RU.options_export_md.message).toMatch(/\.md$/);
    expect(RU.options_export_txt.message).toMatch(/\(эталон\)$/);
  });

  test('все 4 id кнопок экспорта и 3 id порогов на месте', () => {
    EXPORT_IDS.concat(THRESHOLD_IDS).forEach(function (id) {
      expect([id, (OPTIONS_HTML.match(new RegExp('id="' + id + '"', 'g')) || []).length]).toEqual([id, 1]);
    });
  });

  test('границы Advanced-секции не сдвинуты: export-md внутри, поля порогов — снаружи', () => {
    const advanced = doc.getElementById(ADVANCED_ID);
    expect(advanced).not.toBeNull();
    expect(advanced.contains(doc.getElementById('export-md'))).toBe(true);
    THRESHOLD_IDS.forEach(function (id) {
      expect([id, advanced.contains(doc.getElementById(id))]).toEqual([id, false]);
    });
  });

  test('новые id (#21) не подменяют прежние id кнопок и полей', () => {
    const ids = Array.prototype.map.call(doc.querySelectorAll('[id]'), function (el) { return el.id; });
    const dupes = ids.filter(function (id, i) { return ids.indexOf(id) !== i; });
    expect(dupes).toEqual([]);
  });
});
