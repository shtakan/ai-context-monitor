/**
 * WCAG 2.1 AA: контраст текста в options/options.css и print/print.html.
 *
 * Аудит доступности (часть 3/4) нашёл 6 пар «текст/фон» с контрастом ниже 4.5:1.
 * Тест читает реальные файлы с диска, извлекает ФАКТИЧЕСКИЕ значения color из
 * указанных селекторов (и фоновые значения), считает контраст по формуле WCAG 2.1
 * (sRGB → relative luminance → (L1+0.05)/(L2+0.05)) и требует порог 4.5:1
 * без скидок на кегль.
 *
 * Дополнительно пин: в исходниках не осталось литералов-нарушителей.
 *
 * Тест ничего не меняет: только чтение файлов и арифметика.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OPTIONS_CSS_PATH = path.join(ROOT, 'options', 'options.css');
const PRINT_HTML_PATH = path.join(ROOT, 'print', 'print.html');

const optionsCss = fs.readFileSync(OPTIONS_CSS_PATH, 'utf8');
const printHtml = fs.readFileSync(PRINT_HTML_PATH, 'utf8');

/* ---------- WCAG 2.1 relative luminance / contrast ratio ---------- */

function parseHex(value) {
  const v = String(value).trim().replace(/^#/, '');
  const full = v.length === 3
    ? v[0] + v[0] + v[1] + v[1] + v[2] + v[2]
    : v;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error('Не hex-цвет: ' + value);
  }
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function relativeLuminance(hex) {
  const channels = parseHex(hex).map(function (c) {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(fg, bg) {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/* ---------- Мини-парсер CSS ---------- */

/**
 * Достаёт тело правила (внутренности внешних {}) для селектора.
 * Селектор ищется как точная строка слева от «{», чтобы `.label` не совпал
 * с `.stat-label`, а `.btn-export` не совпал с `.btn-export:disabled`.
 */
function bodyOf(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const own = new RegExp('(?:^|[};])\\s*' + escaped + '\\s*\\{([^{}]*)\\}');
  const nested = new RegExp(escaped + '\\s*\\{([^{}]*)\\}');
  const m = own.exec(css) || nested.exec(css);
  if (!m) throw new Error('Правило не найдено: ' + selector);
  return m[1];
}

/**
 * Внутренности @media print { ... } (с балансировкой скобок), либо ''.
 */
function mediaPrintBlock(css) {
  const start = css.indexOf('@media print');
  if (start === -1) return '';
  const open = css.indexOf('{', start);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return '';
}

/**
 * Значение свойства (по умолчанию color) внутри тела правила.
 * Поддерживает `color: #abc`, `color:#abc;`, `color: #abc !important`.
 */
function declarationValue(body, property) {
  const prop = property || 'color';
  const re = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;}]+)', 'i');
  const m = re.exec(body);
  if (!m) throw new Error('Свойство не найдено: ' + prop);
  return m[1].replace(/!important/i, '').trim();
}

/** Вырезает содержимое <style> ... </style> из HTML (без внешних CSS). */
function styleBlocks(html) {
  const blocks = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(html)) !== null) blocks.push(m[1]);
  return blocks.join('\n');
}

const printStyle = styleBlocks(printHtml);

/* ---------- Извлечение фактических пар «текст/фон» ---------- */

// Фон вне правил (наследуется от body / области кнопки).
const optionsBodyBg = declarationValue(bodyOf(optionsCss, 'body'), 'background');
const optionsBtnBg = declarationValue(bodyOf(optionsCss, '.btn-export'), 'background');
const printBodyBg = declarationValue(
  mediaPrintBlock(printStyle) ? bodyOf(mediaPrintBlock(printStyle), 'body') : bodyOf(printStyle, 'body'),
  'background'
);

const PAIRS = [
  {
    name: '.stat-label — текст статистики (options)',
    fg: declarationValue(bodyOf(optionsCss, '.stat-label')),
    bg: optionsBodyBg,
  },
  {
    name: '.label — подпись поля (options)',
    fg: declarationValue(bodyOf(optionsCss, '.label')),
    bg: optionsBodyBg,
  },
  {
    name: '.hint — подсказка под полем (options)',
    fg: declarationValue(bodyOf(optionsCss, '.hint')),
    bg: optionsBodyBg,
  },
  {
    name: '.version — версия в футере (options)',
    fg: declarationValue(bodyOf(optionsCss, '.version')),
    bg: optionsBodyBg,
  },
  {
    name: '.btn-export:disabled — отключённая кнопка (options)',
    fg: declarationValue(bodyOf(optionsCss, '.btn-export:disabled')),
    bg: optionsBtnBg,
  },
  {
    name: '.doc-meta — метаданные печатного документа (print)',
    fg: declarationValue(bodyOf(printStyle, '.doc-meta')),
    bg: printBodyBg,
  },
  {
    name: 'pre[data-lang]::before — ярлык языка блока кода (print)',
    fg: declarationValue(bodyOf(printStyle, 'pre[data-lang]::before')),
    bg: printBodyBg,
  },
  {
    // Не входила в 6 нарушений, но использует заменённый цвет: держим её ≥4.5.
    name: '.btn-reset — сброс (options)',
    fg: declarationValue(bodyOf(optionsCss, '.btn-reset')),
    bg: declarationValue(bodyOf(optionsCss, '.btn-reset'), 'background'),
  },
];

const MIN_CONTRAST = 4.5;

/* ---------- Инварианты «только цвета» ---------- */

const FORBIDDEN = [
  { literal: '#666688', re: /#666688/i },
  { literal: '#8888aa', re: /#8888aa/i },
  { literal: 'color:#555', re: /color\s*:\s*#555\b/i },
  { literal: 'color:#888', re: /color\s*:\s*#888\b/i },
];

describe('WCAG 2.1 AA: контраст текста в options.css и print.html', () => {
  test('все извлечённые пары «текст/фон» имеют контраст ≥ 4.5:1', () => {
    expect(PAIRS.length).toBeGreaterThanOrEqual(6);

    const report = PAIRS.map(function (p) {
      const ratio = contrastRatio(p.fg, p.bg);
      return p.name + ': ' + p.fg + ' на ' + p.bg + ' = ' + ratio.toFixed(2) + ':1';
    });

    PAIRS.forEach(function (p, i) {
      expect(report[i]).toBeDefined();
      expect(contrastRatio(p.fg, p.bg)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    });
  });

  test('все 8 пар посчитаны по реальным значениям из файлов (не хардкод)', () => {
    // Хардкода «ожидаемых» цветов нет: каждое значение вычитано из CSS.
    PAIRS.forEach(function (p) {
      expect(p.fg).toMatch(/^#[0-9a-fA-F]{3,6}$/);
      expect(p.bg).toMatch(/^#[0-9a-fA-F]{3,6}$/);
    });
  });

  test('конкретные ранее-нарушающие селекторы дают ≥ 4.5:1', () => {
    const byName = {};
    PAIRS.forEach(function (p) { byName[p.name.split(' — ')[0]] = p; });

    const required = ['.stat-label', '.label', '.hint', '.version', '.btn-export:disabled', '.doc-meta', 'pre[data-lang]::before'];
    required.forEach(function (sel) {
      expect(byName[sel]).toBeDefined();
      const ratio = contrastRatio(byName[sel].fg, byName[sel].bg);
      expect(ratio).toBeGreaterThanOrEqual(MIN_CONTRAST);
    });
  });

  test('фоновые значения соответствуют ожидаемым поверхностям', () => {
    expect(optionsBodyBg.toLowerCase()).toBe('#1a1a2e');
    expect(optionsBtnBg.toLowerCase()).toBe('#16213e');
    expect(printBodyBg.toLowerCase()).toBe('#ffffff');
  });

  test('в options.css не осталось литералов #666688 и #8888aa', () => {
    expect(optionsCss).not.toMatch(FORBIDDEN[0].re);
    expect(optionsCss).not.toMatch(FORBIDDEN[1].re);
  });

  test('в print.html не осталось color:#555 и color:#888', () => {
    expect(printHtml).not.toMatch(FORBIDDEN[2].re);
    expect(printHtml).not.toMatch(FORBIDDEN[3].re);
  });

  test('в обоих файлах нет ни одного из запрещённых литералов', () => {
    FORBIDDEN.forEach(function (f) {
      expect(optionsCss.match(f.re) || []).toHaveLength(0);
      expect(printHtml.match(f.re) || []).toHaveLength(0);
    });
  });

  test('замены применены: .hint/.version = #8b8bad, disabled = #9a9ab0, doc-meta = #4a4a4a, pre = #666666', () => {
    const byName = {};
    PAIRS.forEach(function (p) { byName[p.name.split(' — ')[0]] = p; });

    expect(byName['.hint'].fg.toLowerCase()).toBe('#8b8bad');
    expect(byName['.version'].fg.toLowerCase()).toBe('#8b8bad');
    expect(byName['.stat-label'].fg.toLowerCase()).toBe('#8b8bad');
    expect(byName['.label'].fg.toLowerCase()).toBe('#8b8bad');
    expect(byName['.btn-export:disabled'].fg.toLowerCase()).toBe('#9a9ab0');
    expect(byName['.doc-meta'].fg.toLowerCase()).toBe('#4a4a4a');
    expect(byName['pre[data-lang]::before'].fg.toLowerCase()).toBe('#666666');
  });

  test('замена не задела нецветовые свойства (кегль и раскладка на месте)', () => {
    expect(bodyOf(optionsCss, '.hint')).toMatch(/font-size:\s*10px/);
    expect(bodyOf(optionsCss, '.hint')).toMatch(/display:\s*block/);
    expect(bodyOf(optionsCss, '.hint')).toMatch(/margin-top:\s*4px/);
    expect(bodyOf(optionsCss, '.version')).toMatch(/font-size:\s*11px/);
    expect(bodyOf(optionsCss, '.btn-export:disabled')).toMatch(/cursor:\s*not-allowed/);
    expect(bodyOf(printStyle, '.doc-meta')).toMatch(/font-size:\s*13px/);
    expect(bodyOf(printStyle, '.doc-meta')).toMatch(/line-height:\s*1\.6/);
    expect(bodyOf(printStyle, 'pre[data-lang]::before')).toMatch(/font-size:\s*11px/);
    expect(bodyOf(printStyle, 'pre[data-lang]::before')).toMatch(/text-transform:\s*uppercase/);
    expect(bodyOf(printStyle, 'pre[data-lang]::before')).toMatch(/content:\s*attr\(data-lang\)/);
  });

  test('формула контраста самопроверяется на эталонах WCAG', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // #767676 на белом — известный порог 4.54:1 (WCAG-пример); #777777 уже 4.48:1
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(4.5);
  });
});
