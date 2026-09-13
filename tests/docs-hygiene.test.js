/**
 * C-8 / C-11 (M-6, v1.19): гигиена документации и доступность руководства из расширения.
 *
 * Пины source-level (стиль privacy.test.js / audit-r3-silent-catch-logs):
 *  1) README.md — датированный снимок тестов, 5 живых превью из docs/screenshots/,
 *     раздел «Microsoft Edge (Chromium)», ссылка на privacy/privacy.html;
 *  2) docs/TESTS.md — тот же датированный снимок, что в README (без старых 14/159);
 *  3) docs/index.html — футер с версией из manifest.json (без «1.0.0»), все 5 <img>
 *     указывают на реально существующие файлы по относительным путям;
 *  4) options — ссылка «Помощь» (id="help-link") рядом с политикой: разметка
 *     target="_blank"/rel="noopener", chrome.tabs.create(getURL('docs/index.html')),
 *     preventDefault, стиль как у #privacy-link, маркер // v1.19 (M-6);
 *  5) release.yml — docs/ больше не исключается, есть пост-шаг проверки состава ZIP
 *     (печать листинга + падение на tests/, node_modules/, .git/, package-lock.json).
 *
 * Существующие тесты и код расширения (core/, utils/, adapters/, manifest.json,
 * privacy/privacy.html) не изменяются — здесь только чтение.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const abs = function (rel) { return path.join(ROOT, rel); };
const read = function (rel) { return fs.readFileSync(abs(rel), 'utf8'); };

const readme = read('README.md');
const testsDoc = read('docs/TESTS.md');
const indexHtml = read('docs/index.html');
const optionsHtml = read('options/options.html');
const optionsJs = read('options/options.js');
const optionsCss = read('options/options.css');
const releaseYml = read('.github/workflows/release.yml');
const manifest = JSON.parse(read('manifest.json'));
const pkg = JSON.parse(read('package.json'));

// «as of v1.18.0 (2026-09-12): 61 suites / 1037 tests» — формат пина без точных чисел.
const SNAPSHOT_RE = /as of v\d+\.\d+\.\d+ \(\d{4}-\d{2}-\d{2}\): \d+ suites \/ \d+ tests/;
const STALE_COUNTERS = ['14 suites / 159 tests', '14 suites/159 tests'];

const countOccurrences = function (haystack, needle) {
  return haystack.split(needle).length - 1;
};

describe('C-8: README.md — актуальная документация', () => {
  test('датированный снимок тестов вместо устаревших счётчиков 14/159', () => {
    expect(readme).toMatch(SNAPSHOT_RE);
    STALE_COUNTERS.forEach(function (stale) {
      expect(readme).not.toContain(stale);
    });
  });

  test('секция Screenshots: не менее 5 относительных ссылок docs/screenshots/', () => {
    expect(countOccurrences(readme, 'docs/screenshots/')).toBeGreaterThanOrEqual(5);
  });

  test('все 5 превью подключены относительным путём и файлы существуют', () => {
    const images = [];
    const re = /!\[[^\]]*\]\(([^)]+)\)/g;
    let m;
    while ((m = re.exec(readme)) !== null) {
      if (m[1].indexOf('docs/screenshots/') === 0) images.push(m[1].trim());
    }
    const expected = [
      'docs/screenshots/gemini-yellow.png',
      'docs/screenshots/chatgpt-red.png',
      'docs/screenshots/google-search-popup.png',
      'docs/screenshots/claude.png',
      'docs/screenshots/perplexity.png'
    ];
    expected.forEach(function (rel) {
      expect(images).toContain(rel);
      expect(fs.existsSync(abs(rel))).toBe(true);
      expect(fs.statSync(abs(rel)).size).toBeGreaterThan(10000);
    });
    expect(images.length).toBeGreaterThanOrEqual(5);
    // никаких абсолютных/внешних URL среди превью
    expect(images.filter(function (src) { return /^(https?:)?\/\//i.test(src); })).toEqual([]);
  });

  test('есть раздел «Microsoft Edge (Chromium)» с edge://extensions и Edge Add-ons', () => {
    expect(readme).toMatch(/^##\s+Microsoft Edge \(Chromium\)\s*$/m);
    expect(readme).toContain('edge://extensions');
    expect(readme).toContain('Edge Add-ons');
    expect(readme).toContain('Manifest V3');
  });

  test('секция Privacy ссылается на privacy/privacy.html', () => {
    expect(readme).toMatch(/## Privacy/);
    expect(readme).toContain('(privacy/privacy.html)');
    expect(fs.existsSync(abs('privacy/privacy.html'))).toBe(true);
  });
});

describe('C-11: docs/TESTS.md — тот же датированный снимок', () => {
  test('снимок совпадает по формату с README и не содержит старых чисел', () => {
    expect(testsDoc).toMatch(SNAPSHOT_RE);
    STALE_COUNTERS.forEach(function (stale) {
      expect(testsDoc).not.toContain(stale);
    });
    const readmeSnapshot = readme.match(SNAPSHOT_RE)[0];
    expect(testsDoc).toContain(readmeSnapshot);
  });
});

describe('C-11: docs/index.html — версия футера и живые скриншоты', () => {
  test('футер содержит версию manifest.json и не содержит «1.0.0»', () => {
    const doc = new DOMParser().parseFromString(indexHtml, 'text/html');
    const footer = doc.querySelector('.footer');
    expect(footer).not.toBeNull();
    const text = footer.textContent;
    expect(text).not.toContain('1.0.0');
    expect(text).toContain('Версия ' + manifest.version);
    expect(indexHtml).not.toContain('Версия 1.0.0');
  });

  test('версия согласована: manifest.json === package.json', () => {
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('все 5 <img> указывают на существующие файлы (relative paths)', () => {
    const doc = new DOMParser().parseFromString(indexHtml, 'text/html');
    const imgs = Array.from(doc.querySelectorAll('.screenshots img'));
    expect(imgs.length).toBe(5);
    imgs.forEach(function (img) {
      const src = (img.getAttribute('src') || '').trim();
      expect(src).toMatch(/^screenshots\/[a-z0-9-]+\.png$/);
      expect(/^(https?:)?\/\//i.test(src)).toBe(false);
      expect(src.indexOf('../')).toBe(-1);
      expect(fs.existsSync(path.join(ROOT, 'docs', src))).toBe(true);
      expect((img.getAttribute('alt') || '').length).toBeGreaterThan(0);
    });
    const captions = Array.from(doc.querySelectorAll('.screenshots .caption'))
      .map(function (el) { return el.textContent.trim(); })
      .filter(Boolean);
    expect(captions.length).toBe(5);
  });
});

describe('M-6: options — руководство доступно из установленного расширения', () => {
  test('options.html: id="help-link" рядом с id="privacy-link" в футере', () => {
    expect(optionsHtml).toContain('id="help-link"');
    expect(optionsHtml).toContain('id="privacy-link"');
    const doc = new DOMParser().parseFromString(optionsHtml, 'text/html');
    const help = doc.querySelector('.footer #help-link');
    expect(help).not.toBeNull();
    expect(help.getAttribute('target')).toBe('_blank');
    expect(help.getAttribute('rel')).toBe('noopener');
    expect(help.textContent.trim()).toBe('Помощь');
    expect(help.getAttribute('href')).toBe('../docs/index.html');
    // политика конфиденциальности не тронута
    const privacy = doc.querySelector('.footer #privacy-link');
    expect(privacy).not.toBeNull();
    expect(privacy.getAttribute('href')).toBe('privacy/privacy.html');
  });

  test('options.html: файл руководства реально лежит в пакете по пути из getURL', () => {
    expect(fs.existsSync(abs(path.join('docs', 'index.html')))).toBe(true);
    expect(optionsHtml).toContain('../docs/index.html');
  });

  test('options.js: клик открывает docs/index.html через chrome.tabs.create + getURL', () => {
    expect(optionsJs).toContain('// v1.19 (M-6)');
    expect(optionsJs).toContain("document.getElementById('help-link')");
    expect(optionsJs).toContain("chrome.tabs.create({ url: chrome.runtime.getURL('docs/index.html') })");
    expect(optionsJs).toContain('e.preventDefault();');
    // обработчик политики не изменён
    expect(optionsJs).toContain("chrome.tabs.create({ url: chrome.runtime.getURL('privacy/privacy.html') })");
  });

  test('options.css: #help-link стилизован как #privacy-link (цвет + hover-подчёркивание)', () => {
    const block = optionsCss.match(/#help-link\s*\{[^}]*\}/);
    expect(block).not.toBeNull();
    expect(block[0]).toContain('font-size: 11px');
    expect(block[0]).toContain('color: #a78bfa');
    expect(block[0]).toContain('text-decoration: none');
    const hover = optionsCss.match(/#help-link:hover\s*\{[^}]*\}/);
    expect(hover).not.toBeNull();
    expect(hover[0]).toContain('text-decoration: underline');
    expect(optionsCss).toContain('#privacy-link {');
  });
});

describe('M-6: release.yml — руководство в ZIP и контроль состава пакета', () => {
  test('docs/ убран из исключающего grep, служебные пути остались', () => {
    const excludeLines = releaseYml.split(/\r?\n/).filter(function (l) {
      return l.indexOf('grep -zvE') !== -1;
    });
    expect(excludeLines.length).toBe(1);
    const line = excludeLines[0];
    expect(line).not.toContain('docs/');
    ['tests/', 'tools/', 'coverage/', '.github/', 'package(-lock)?\\.json$', '\\.md$'].forEach(function (needle) {
      expect(line).toContain(needle);
    });
  });

  test('пост-шаг печатает состав ZIP и падает на tests/, node_modules/, .git/, package-lock.json', () => {
    expect(releaseYml).toContain('Verify ZIP contents');
    const start = releaseYml.indexOf('Verify ZIP contents');
    const end = releaseYml.indexOf('Upload to release');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const step = releaseYml.slice(start, end);

    expect(step).toContain('unzip -l');          // листинг состава пакета
    expect(step).toContain('unzip -Z1');         // машинный список путей для проверки
    expect(step).toContain('exit 1');            // падение
    expect(step).toContain('::error::');
    expect(step).toMatch(/\(tests\|node_modules\|\\\.git\)\//);   // запрещённые каталоги
    expect(step).toContain('package-lock\\.json');                 // запрещённый lock-файл
    expect(step).toContain("grep -qx 'docs/index.html'");          // руководство обязано быть в пакете
  });

  test('порядок шагов: Create ZIP -> Verify ZIP contents -> Upload to release', () => {
    const create = releaseYml.indexOf('name: Create ZIP');
    const verify = releaseYml.indexOf('Verify ZIP contents');
    const upload = releaseYml.indexOf('Upload to release');
    expect(create).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(create);
    expect(upload).toBeGreaterThan(verify);
  });

  // LOW-5 (аудит перед релизом): решение по README.md в ZIP зафиксировано —
  // вариант Б: README в пакет НЕ входит. Магазин (Edge Add-ons) берёт описание из
  // листинга Partner Center, а служебные .md (архитектура/протокол/чеклист) в
  // пользовательском пакете не нужны. Офлайн-руководство — docs/index.html.
  test('LOW-5 (вариант Б): README.md исключён из ZIP осознанно, решение зафиксировано в release.yml', () => {
    const line = releaseYml.split(/\r?\n/).filter(function (l) {
      return l.indexOf('grep -zvE') !== -1;
    })[0];
    expect(line).toContain('\\.md$');            // фильтр .md на месте
    expect(releaseYml).toContain('LOW-5');       // решение в коде, а не только в голове
    expect(releaseYml).toContain('README.md в ZIP НЕ включается');
    expect(releaseYml).toContain('docs/index.html');
  });
});
