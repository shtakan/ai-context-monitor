/**
 * UI-аудит 2026-09-28, Major-подбатч 1 (options), находка #10:
 * редкие настройки (логи, автоэкспорт, API-ключ, точный подсчёт, экспорт, архивы)
 * свёрнуты в ОДИН <details id="advanced-section">, закрытый по умолчанию; базовые
 * настройки остаются видимыми, а #proactive-section идёт раньше Advanced.
 *
 * Плюс находки #12/#13 в той же секции: видимая подпись поля ключа, состояние
 * кнопки-глаза и пояснение про зоны кольца.
 *
 * Тест читает реальные options/options.html и options/options.css с диска.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OPTIONS_HTML = fs.readFileSync(path.join(ROOT, 'options', 'options.html'), 'utf8');
const OPTIONS_CSS = fs.readFileSync(path.join(ROOT, 'options', 'options.css'), 'utf8');
const RU = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', 'ru', 'messages.json'), 'utf8'));
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', 'en', 'messages.json'), 'utf8'));

const doc = new DOMParser().parseFromString(OPTIONS_HTML, 'text/html');

const ADVANCED_ID = 'advanced-section';

// Редкие настройки: уходят внутрь Advanced.
const INSIDE = ['debugLogs', 'aiCmAutoExport', 'api-key', 'exact-count', 'export-md',
  'aiCmIncludeHiddenInExport', 'archive-file'];

// Базовые настройки: остаются видимыми на странице.
const OUTSIDE = ['show-widget', 'aiCmProactive', 'aiCmProactiveLow', 'aiCmProactiveMedium',
  'aiCmProactiveHigh', 'model-select', 'custom-limit'];

/** Мини-парсер CSS: пары «селектор — тело правила». */
function rulesOf(css) {
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    rules.push({ selector: m[1].trim(), body: m[2] });
  }
  return rules;
}

/** CSS без комментариев — проверки «нет outline: none» смотрят на объявления, не на текст. */
function withoutComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('Major #10 (options): Advanced-секция', () => {
  test('ровно один <details id="advanced-section">, свёрнутый по умолчанию', () => {
    const detailsList = doc.querySelectorAll('details');
    expect(detailsList.length).toBe(1);

    const details = doc.getElementById(ADVANCED_ID);
    expect(details).not.toBeNull();
    expect(details.tagName.toLowerCase()).toBe('details');
    expect(details.hasAttribute('open')).toBe(false);

    // разметка: id ровно один раз и ни у одного <details> нет open
    expect((OPTIONS_HTML.match(/id="advanced-section"/g) || []).length).toBe(1);
    expect(OPTIONS_HTML).not.toMatch(/<details[^>]*\sopen\b/);
  });

  test('внутри Advanced — редкие контролы', () => {
    const details = doc.getElementById(ADVANCED_ID);
    INSIDE.forEach(function (id) {
      const el = doc.getElementById(id);
      expect([id, el !== null]).toEqual([id, true]);
      expect([id, details.contains(el)]).toEqual([id, true]);
    });
  });

  test('вне Advanced — базовые контролы (остаются видимыми)', () => {
    const details = doc.getElementById(ADVANCED_ID);
    OUTSIDE.forEach(function (id) {
      const el = doc.getElementById(id);
      expect([id, el !== null]).toEqual([id, true]);
      expect([id, details.contains(el)]).toEqual([id, false]);
    });
  });

  test('#proactive-section идёт в DOM раньше #advanced-section', () => {
    const proactive = OPTIONS_HTML.indexOf('id="proactive-section"');
    const advanced = OPTIONS_HTML.indexOf('id="advanced-section"');
    expect(proactive).toBeGreaterThan(-1);
    expect(advanced).toBeGreaterThan(-1);
    expect(proactive).toBeLessThan(advanced);
    expect(doc.getElementById('proactive-section')).not.toBeNull();
  });

  test('<summary> — первый элемент Advanced, с текстом из i18n-ключа', () => {
    const details = doc.getElementById(ADVANCED_ID);
    const summary = details.querySelector('summary');
    expect(summary).not.toBeNull();
    expect(summary.parentNode).toBe(details);
    expect(details.firstElementChild).toBe(summary);
    expect(summary.getAttribute('data-i18n')).toBe('options_advanced_summary');

    const ruText = String(RU.options_advanced_summary.message || '').trim();
    const enText = String(EN.options_advanced_summary.message || '').trim();
    expect(ruText.length).toBeGreaterThan(0);
    expect(enText.length).toBeGreaterThan(0);
    expect(summary.textContent.trim()).toBe(ruText);
  });

  test('options.css: правило для summary есть, обводку фокуса не подавляет', () => {
    const rules = rulesOf(OPTIONS_CSS).filter(function (r) {
      return r.selector.indexOf('summary') !== -1;
    });
    expect(rules.length).toBeGreaterThanOrEqual(1);
    expect(rules.some(function (r) { return /cursor\s*:\s*pointer/.test(r.body); })).toBe(true);
    expect(rules.some(function (r) {
      return r.selector.indexOf(':focus-visible') !== -1 && /outline\s*:\s*2px solid/.test(r.body);
    })).toBe(true);
    expect(withoutComments(OPTIONS_CSS)).not.toMatch(/outline\s*:\s*none/i);
  });
});

describe('Major #12/#13 (options): подпись ключа и зоны кольца', () => {
  test('#api-key: видимая подпись label[for] вместо aria-label', () => {
    const input = doc.getElementById('api-key');
    expect(input).not.toBeNull();
    expect(input.getAttribute('aria-label')).toBeNull();

    const label = doc.querySelector('label[for="api-key"]');
    expect(label).not.toBeNull();
    expect(label.getAttribute('data-i18n')).toBe('options_byok_key_label');
    expect(label.textContent.trim().length).toBeGreaterThan(0);
    expect(label.textContent.trim()).toBe(String(RU.options_byok_key_label.message).trim());
  });

  test('#toggle-api-key: стартовое aria-pressed="false" и прежний title', () => {
    const btn = doc.getElementById('toggle-api-key');
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.getAttribute('title')).toBe('Показать/скрыть ключ');
  });

  test('#proactive-section: подсказка про зоны кольца отдельно от порогов', () => {
    const section = doc.getElementById('proactive-section');
    const hint = section.querySelector('[data-i18n="options_ring_zones_hint"]');
    expect(hint).not.toBeNull();
    expect(hint.tagName.toLowerCase()).toBe('span');
    expect(hint.classList.contains('hint')).toBe(true);
    expect(hint.textContent.trim()).toBe(String(RU.options_ring_zones_hint.message).trim());

    // сами пороги не тронуты
    expect(doc.getElementById('aiCmProactiveLow').getAttribute('value')).toBe('70');
    expect(doc.getElementById('aiCmProactiveMedium').getAttribute('value')).toBe('85');
    expect(doc.getElementById('aiCmProactiveHigh').getAttribute('value')).toBe('95');
  });
});
