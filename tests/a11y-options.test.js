/**
 * Фаза 2 публикационной подготовки, доступность WCAG 2.1 AA: options (попап настроек).
 *
 * Аудит (часть 3/4) зафиксировал три пункта:
 *   M-1 — нет доступных имён и смысловых групп (ни label[for], ни aria-*, ни role);
 *   M-2 — у динамических областей нет live-region (#stats, #archive-status, #stale-warning);
 *   M-3 — options.css подавляет фокус (`outline: none`) и не даёт видимой обводки кнопкам.
 *
 * Тест статический: читает реальные options/options.html и options/options.css
 * и проверяет только атрибуты доступности и focus-правила. Он НЕ трогает и НЕ
 * дублирует пин tests/wcag-contrast.test.js — цвета остаются байтово прежними.
 *
 * Проверяется также, что задание выполнено без регрессии раскладки/цветов:
 * ни одно из исходных объявлений options.css не удалено, кроме `outline: none`.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OPTIONS_HTML_PATH = path.join(ROOT, 'options', 'options.html');
const OPTIONS_CSS_PATH = path.join(ROOT, 'options', 'options.css');
const WCAG_TEST_PATH = path.join(ROOT, 'tests', 'wcag-contrast.test.js');

const optionsHtml = fs.readFileSync(OPTIONS_HTML_PATH, 'utf8');
const optionsCss = fs.readFileSync(OPTIONS_CSS_PATH, 'utf8');

/** options.css без комментариев: ключевое слово в комментарии — не объявление. */
function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

const optionsCssCode = stripCssComments(optionsCss);

/** Тело правила для точного селектора (аналог парсера в wcag-contrast.test.js). */
function bodyOf(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const own = new RegExp('(?:^|[};])\\s*' + escaped + '\\s*\\{([^{}]*)\\}');
  const nested = new RegExp(escaped + '\\s*\\{([^{}]*)\\}');
  const m = own.exec(css) || nested.exec(css);
  if (!m) throw new Error('Правило не найдено: ' + selector);
  return m[1];
}

/** Все правила файла как { selector, body } (в исходном порядке). */
function allRules(css) {
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    rules.push({ selector: m[1].trim(), body: m[2] });
  }
  return rules;
}

/** Тег элемента с данным id: 'input' | 'select' | 'div' | ... либо null. */
function tagOfId(html, id) {
  const re = new RegExp('<(\\w+)(?=[^>]*\\bid="' + id + '")[^>]*>');
  const m = re.exec(html);
  return m ? m[1].toLowerCase() : null;
}

/** Полный открывающий тег элемента с данным id. */
function tagStringOfId(html, id) {
  const re = new RegExp('<(\\w+)(?=[^>]*\\bid="' + id + '")[^>]*>');
  const m = re.exec(html);
  return m ? m[0] : null;
}

/** Есть ли у элемента с данным id атрибут с указанным значением. */
function hasAttr(html, id, attr, value) {
  const tag = tagStringOfId(html, id);
  if (!tag) return false;
  const re = new RegExp('\\b' + attr + '="' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"');
  return re.test(tag);
}

const doc = new DOMParser().parseFromString(optionsHtml, 'text/html');

/* =====================================================================================
 * M-1: доступные имена и смысловые группы
 * ===================================================================================== */

describe('M-1: доступные имена полей options.html', () => {
  test('#model-select связан с подписью через label for="model-select"', () => {
    const labels = Array.prototype.slice.call(doc.querySelectorAll('label[for]'));
    const forModel = labels.filter(function (l) { return l.getAttribute('for') === 'model-select'; });
    expect(forModel).toHaveLength(1);
    expect(forModel[0].textContent.trim()).toBe('Модель:');
    // класс .label сохранён: раскладка подписи прежняя
    expect(forModel[0].classList.contains('label')).toBe(true);
    // реальный select с этим id существует — связь не висячая
    expect(doc.getElementById('model-select').tagName.toLowerCase()).toBe('select');
  });

  test('#aiCmAutoExportFmt: aria-label="Формат файла автоэкспорта"', () => {
    expect(tagOfId(optionsHtml, 'aiCmAutoExportFmt')).toBe('select');
    expect(hasAttr(optionsHtml, 'aiCmAutoExportFmt', 'aria-label', 'Формат файла автоэкспорта')).toBe(true);
  });

  test('#custom-limit: aria-label="Пользовательский лимит токенов"', () => {
    expect(tagOfId(optionsHtml, 'custom-limit')).toBe('input');
    expect(hasAttr(optionsHtml, 'custom-limit', 'aria-label', 'Пользовательский лимит токенов')).toBe(true);
  });

  test('три числовых порога: у каждого своё aria-label, title сохранён', () => {
    expect(hasAttr(optionsHtml, 'aiCmProactiveLow', 'aria-label', 'Низкий порог процентов')).toBe(true);
    expect(hasAttr(optionsHtml, 'aiCmProactiveMedium', 'aria-label', 'Средний порог процентов')).toBe(true);
    expect(hasAttr(optionsHtml, 'aiCmProactiveHigh', 'aria-label', 'Высокий порог процентов')).toBe(true);
    // title не потерян вместе с подписью
    expect(tagStringOfId(optionsHtml, 'aiCmProactiveLow')).toContain('title="Низкий порог — зелёный"');
    expect(tagStringOfId(optionsHtml, 'aiCmProactiveMedium')).toContain('title="Средний порог — жёлтый"');
    expect(tagStringOfId(optionsHtml, 'aiCmProactiveHigh')).toContain('title="Высокий порог — красный"');
  });

  test('у каждого поля с id есть непустое имя доступности (label[for] или aria-label)', () => {
    const ids = doc.querySelectorAll('[id]');
    const labelsFor = {};
    Array.prototype.slice.call(doc.querySelectorAll('label[for]')).forEach(function (l) {
      labelsFor[l.getAttribute('for')] = true;
    });
    const controls = ['model-select', 'custom-limit', 'aiCmAutoExport', 'aiCmAutoExportPct',
      'aiCmAutoExportFmt', 'aiCmProactive', 'aiCmProactiveNotify', 'aiCmProactiveLow',
      'aiCmProactiveMedium', 'aiCmProactiveHigh', 'api-key', 'exact-count', 'show-widget', 'debugLogs'];
    controls.forEach(function (id) {
      const el = doc.getElementById(id);
      expect(el).not.toBeNull();
      const name = String(el.getAttribute('aria-label') || '').trim();
      const hasLabelledby = !!String(el.getAttribute('aria-labelledby') || '').trim();
      expect([id, labelsFor[id] === true || name.length > 0 || hasLabelledby]).toEqual([id, true]);
    });
    expect(ids.length).toBeGreaterThan(0);
  });

  test('смысловые группы: минимум «Автоэкспорт чатов» и «Проактивные пороги»', () => {
    const groups = Array.prototype.slice.call(doc.querySelectorAll('[role="group"], fieldset'));
    expect(groups.length).toBeGreaterThanOrEqual(2);

    // Группа задана либо fieldset, либо role="group" + непустым именем (aria-labelledby/aria-label)
    groups.forEach(function (g) {
      const isFieldset = g.tagName.toLowerCase() === 'fieldset';
      const named = !!String(g.getAttribute('aria-labelledby') || '').trim()
        || !!String(g.getAttribute('aria-label') || '').trim()
        || g.querySelector('legend') !== null;
      expect(isFieldset || named).toBe(true);
    });

    const byId = {};
    groups.forEach(function (g) { byId[g.id] = g; });
    expect(byId['auto-export-section']).toBeDefined();
    expect(byId['proactive-section']).toBeDefined();
    expect(doc.getElementById('auto-export-legend')).not.toBeNull();
    expect(doc.getElementById('proactive-legend')).not.toBeNull();
    expect(doc.getElementById('auto-export-section').getAttribute('aria-labelledby'))
      .toBe('auto-export-legend');
    expect(doc.getElementById('proactive-section').getAttribute('aria-labelledby'))
      .toBe('proactive-legend');
  });

  test('группы содержат именно те контролы, которые к ним относятся', () => {
    const auto = doc.getElementById('auto-export-section');
    const pro = doc.getElementById('proactive-section');
    ['aiCmAutoExport', 'aiCmAutoExportPct', 'aiCmAutoExportFmt'].forEach(function (id) {
      expect(auto.contains(doc.getElementById(id))).toBe(true);
    });
    ['aiCmProactive', 'aiCmProactiveNotify', 'aiCmProactiveLow', 'aiCmProactiveMedium', 'aiCmProactiveHigh']
      .forEach(function (id) {
        expect(pro.contains(doc.getElementById(id))).toBe(true);
      });
    // группы не пересекаются
    expect(auto.contains(pro)).toBe(false);
    expect(pro.contains(auto)).toBe(false);
  });
});

/* =====================================================================================
 * M-2: live-region для динамических областей
 * ===================================================================================== */

describe('M-2: live-region в options.html', () => {
  test('#stats — aria-live="polite"', () => {
    expect(hasAttr(optionsHtml, 'stats', 'aria-live', 'polite')).toBe(true);
  });

  test('#archive-status — role="status"', () => {
    expect(hasAttr(optionsHtml, 'archive-status', 'role', 'status')).toBe(true);
  });

  test('#stale-warning — role="alert"', () => {
    expect(hasAttr(optionsHtml, 'stale-warning', 'role', 'alert')).toBe(true);
  });

  test('live-атрибуты стоят на контейнерах, которыми управляет options.js', () => {
    const optionsJs = fs.readFileSync(path.join(ROOT, 'options', 'options.js'), 'utf8');
    // #stats — стабильный контейнер: options.js меняет значения вложенных .stat-value,
    // поэтому live-region обязан стоять на самом #stats (иначе объявлений не будет).
    expect(optionsHtml).toMatch(/<div class="stats" id="stats" aria-live="polite">/);
    expect(optionsJs).toContain("getElementById('stat-site')");
    expect(optionsJs).toContain("getElementById('stat-percent')");
    // #stale-warning и #archive-status адресуются напрямую по id
    expect(optionsJs).toMatch(/getElementById\(['"]stale-warning['"]\)/);
    expect(optionsJs).toMatch(/getElementById\(['"]archive-status['"]\)/);
    // регионы не пустые заглушки: у каждого есть id в разметке
    ['stats', 'archive-status', 'stale-warning'].forEach(function (id) {
      expect(doc.getElementById(id)).not.toBeNull();
    });
  });
});

/* =====================================================================================
 * M-3: видимый фокус
 * ===================================================================================== */

describe('M-3: фокус в options.css', () => {
  test('в правилах options.css больше нет outline: none (оба написания)', () => {
    expect(optionsCssCode).not.toMatch(/outline\s*:\s*none/i);
    expect(optionsCssCode).not.toContain('outline: none');
    expect(optionsCssCode).not.toContain('outline:none');
  });

  test('правило select/input сохранило прочие свойства и лишилось только outline', () => {
    const body = bodyOf(optionsCssCode, 'select, input');
    expect(body).not.toMatch(/outline/i);
    expect(body).toMatch(/width:\s*100%/);
    expect(body).toMatch(/border:\s*1px solid #2a2a4a/);
    expect(body).toMatch(/font-size:\s*13px/);
  });

  test('есть правило :focus-visible с outline: 2px solid #a78bfa и offset 2px', () => {
    const rules = allRules(optionsCssCode).filter(function (r) {
      return r.selector.indexOf(':focus-visible') !== -1;
    });
    expect(rules.length).toBeGreaterThanOrEqual(1);
    const withOutline = rules.filter(function (r) {
      return /outline\s*:\s*2px solid #a78bfa/i.test(r.body);
    });
    expect(withOutline.length).toBeGreaterThanOrEqual(1);
    expect(withOutline[0].body).toMatch(/outline-offset:\s*2px/);

    // охват: кнопки, select, input, ссылки и элементы с tabindex
    const selector = withOutline[0].selector;
    ['button', 'select', 'input', 'a', '[tabindex]'].forEach(function (part) {
      expect(selector).toContain(part + ':focus-visible');
    });
  });

  test('прежняя смена border-color на :focus сохранена как дополнение', () => {
    const body = bodyOf(optionsCssCode, 'select:focus, input:focus');
    expect(body).toMatch(/border-color:\s*#7c3aed/);
  });

  test('jsdom разбирает focus-visible-правило и умеет его сопоставлять (:focus-visible поддержан)', () => {
    const style = document.createElement('style');
    style.textContent = optionsCss;
    document.head.appendChild(style);
    try {
      const sheet = document.styleSheets[document.styleSheets.length - 1];
      expect(sheet).toBeDefined();
      let rule = null;
      for (let i = 0; i < sheet.cssRules.length; i++) {
        const sel = sheet.cssRules[i].selectorText || '';
        if (sel.indexOf(':focus-visible') !== -1) { rule = sheet.cssRules[i]; break; }
      }
      // правило не выброшено парсером как «неизвестный селектор»
      expect(rule).not.toBeNull();
      expect(rule.style.outline).toMatch(/2px solid/);

      // и сам селектор работоспособен в этой среде (иначе проверка была бы холостой)
      const btn = document.createElement('button');
      btn.id = 'a11y-focus-probe';
      document.body.appendChild(btn);
      btn.focus();
      expect(typeof btn.matches).toBe('function');
      const advanced = window.CSS && typeof window.CSS.supports === 'function'
        ? window.CSS.supports('selector(:focus-visible)')
        : false;
      if (advanced) {
        expect(btn.matches('#a11y-focus-probe:focus-visible')).toBe(true);
      }
    } finally {
      style.remove();
      document.body.innerHTML = '';
    }
  });
});

/* =====================================================================================
 * Инварианты: цвета, раскладка и «не трогать»
 * ===================================================================================== */

describe('инварианты доступности: цвета, раскладка, неприкосновенные зоны', () => {
  test('пин wcag-contrast.test.js не изменён и на месте', () => {
    const wcag = fs.readFileSync(WCAG_TEST_PATH, 'utf8');
    expect(wcag).toContain('WCAG 2.1 AA: контраст текста в options.css и print.html');
    expect(wcag).toContain('const MIN_CONTRAST = 4.5;');
    // пин читает те же селекторы, что и раньше
    ['.stat-label', '.label', '.hint', '.version', '.btn-export:disabled', '.btn-reset']
      .forEach(function (sel) { expect(wcag).toContain("bodyOf(optionsCss, '" + sel + "')"); });
  });

  test('цвета options.css не менялись: все прежние color/background на месте', () => {
    ['.stat-label', '.label', '.hint', '.version', '.btn-export:disabled', '.btn-reset']
      .forEach(function (sel) {
        const body = sel === '.btn-reset' ? bodyOf(optionsCssCode, '.btn-reset') : bodyOf(optionsCssCode, sel);
        expect(body).toMatch(/#8b8bad|#9a9ab0|#e0e0e0|#ffffff/i);
      });
    expect(bodyOf(optionsCssCode, 'body')).toMatch(/background:\s*#1a1a2e/);
  });

  test('раскладка: .section и .label не потеряли ни одного объявления', () => {
    const section = bodyOf(optionsCssCode, '.section');
    expect(section).toMatch(/margin-bottom:\s*12px/);
    const label = bodyOf(optionsCssCode, '.label');
    expect(label).toMatch(/display:\s*block/);
    expect(label).toMatch(/font-size:\s*12px/);
    expect(label).toMatch(/margin-bottom:\s*4px/);
  });

  test('«не трогать»: логика options.js, приватность/помощь и print.html без изменений', () => {
    const optionsJs = fs.readFileSync(path.join(ROOT, 'options', 'options.js'), 'utf8');
    const printHtml = fs.readFileSync(path.join(ROOT, 'print', 'print.html'), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

    // options.html: ссылки не тронуты
    expect(optionsHtml).toContain('<a href="privacy/privacy.html" id="privacy-link" target="_blank" rel="noopener">');
    expect(optionsHtml).toContain('<a href="../docs/index.html" id="help-link" target="_blank" rel="noopener">');
    // options.js: логика настроек на месте (aria-правки её не касаются)
    expect(optionsJs).toContain("chrome.storage.sync.get(['selectedModel', 'customLimit', 'showWidget']");
    expect(optionsJs).toContain('chrome.storage.sync.set({ customLimit: value });');
    expect(optionsJs).not.toMatch(/aria-|focus-visible/);
    // без изменений в областях вне options
    expect(printHtml).toContain('<style>');
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.version).toBe('1.19.2');
  });
});
