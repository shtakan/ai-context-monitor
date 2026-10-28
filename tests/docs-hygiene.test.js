/**
 * C-8 / C-11 (M-6, v1.19): гигиена документации и доступность руководства из расширения.
 *
 * Пины source-level (стиль privacy.test.js / audit-r3-silent-catch-logs):
 *  1) README.md — датированный снимок тестов, 5 живых превью из docs/screenshots/,
 *     раздел «Microsoft Edge (Chromium)», ссылка на privacy/privacy.html;
 *  1a) README.en.md — полная английская версия README и взаимные ссылки в шапке
 *     (A-1, вариант A: два файла в корне) — блок пинов в конце файла;
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
const readmeEn = read('README.en.md');   // A-1 (вариант A): EN-версия в корне
const testsDoc = read('docs/TESTS.md');
const indexHtml = read('docs/index.html');
const optionsHtml = read('options/options.html');
const optionsJs = read('options/options.js');
const optionsCss = read('options/options.css');
const releaseYml = read('.github/workflows/release.yml');
const manifest = JSON.parse(read('manifest.json'));
const pkg = JSON.parse(read('package.json'));

// O-53: PROJECT_HANDOFF.md — главный документ состояния, который до сих пор не
// покрывала ни одна проверка (CRLF-предупреждения, BOM и loneLF ловились руками).
// Здесь только чтение: сам handoff и код продукта не меняются.
const handoffBuf = fs.readFileSync(abs('PROJECT_HANDOFF.md'));   // Buffer — для BOM и размера
const handoff = handoffBuf.toString('utf8');

// O-53 (split handoff): аппендиксы v1–v89 вынесены в docs/HANDOFF_ARCHIVE.md
// байт-в-байт. Статусные строки живут в РАЗНЫХ файлах (текущий прогон — активный,
// исторический максимум — архив), поэтому проверки «ровно одна» считаются по
// corpus. Склейка handoff + '\n' + archive не создаёт ложных форм счётчиков:
// каждая строка остаётся целой и обе границы индексов берутся из corpus.
const archiveBuf = fs.readFileSync(abs('docs/HANDOFF_ARCHIVE.md'));   // Buffer — для BOM и размера
const archive = archiveBuf.toString('utf8');
const corpus = handoff + '\n' + archive;

// O-53 (вариант б1): две независимые сущности счётчиков handoff —
//   «текущий прогон» (обновляется синхронно с фактом) и
//   «исторический максимум» (рекорд зелёных прогонов, не падает при удалении тестов).
// Исторический максимум НЕ обязан быть ≤ текущего: удаление тестов снижает текущее
// число и регрессом не является — прежнее сравнение current >= max снято осознанно.
// TESTS_RE/HIST_MAX_RE — без флага `g` (извлечение единственного совпадения);
// *_G-копии — только для подсчёта вхождений.
const TESTS_RE = /- \*\*Тесты:\s*(\d+) suites \/ (\d+) passed \/ (\d+) skipped \/ (\d+) failed\*\*/;
const HIST_MAX_RE = /- \*\*Исторический максимум:\s*(\d+) suites \/ (\d+) passed \/ (\d+) skipped \/ (\d+) failed\*\*/;
const TESTS_RE_G = new RegExp(TESTS_RE.source, 'g');
const HIST_MAX_RE_G = new RegExp(HIST_MAX_RE.source, 'g');

// «as of v2.0.8 (2026-09-17): 90 suites / 1535 tests» — формат пина без точных чисел.
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
    // A-1: README.md — русский основной файл, поэтому заголовок секции локализован.
    // Пин не ослаблен: секция и ссылка на политику обязательны в любом из двух языков.
    expect(readme).toMatch(/## (Privacy|Приватность)/);
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

describe('O-53: PROJECT_HANDOFF.md — гигиена кодировки и статусных чисел', () => {
  test('кодировка: без BOM, переводы строк нормализуются без одиночных CR', () => {
    expect(handoffBuf.length).toBeGreaterThan(100000);   // осмысленный объём, а не заглушка
    expect(archiveBuf.length).toBeGreaterThan(100000);   // архив — тоже содержательный файл
    const hasBom = handoffBuf[0] === 0xEF && handoffBuf[1] === 0xBB && handoffBuf[2] === 0xBF;
    expect(hasBom).toBe(false);
    const archiveHasBom = archiveBuf[0] === 0xEF && archiveBuf[1] === 0xBB && archiveBuf[2] === 0xBF;
    expect(archiveHasBom).toBe(false);
    // EOL намеренно НЕ пинится жёстко: .gitattributes держит eol=lf, поэтому в рабочей
    // копии Windows файл честно CRLF, а на Linux/CI — LF. Пин на loneLF/loneCR фиксировал
    // бы средство (рабочую копию), а не требование, и падал бы на CI при зелёном локально.
    // corpus покрывает оба файла: одиночный CR недопустим ни в активном, ни в архиве.
    expect(corpus.replace(/\r\n/g, '\n')).not.toContain('\r');
  });

  test('статусные строки «- **Тесты:» и «- **Исторический максимум:» — ровно по одной', () => {
    const currentLines = corpus.split(/\r?\n/).filter(function (l) {
      return l.indexOf('- **Тесты:') === 0;
    });
    const histMaxLines = corpus.split(/\r?\n/).filter(function (l) {
      return l.indexOf('- **Исторический максимум:') === 0;
    });
    expect(currentLines).toHaveLength(1);   // текущий прогон ровно один
    expect(histMaxLines).toHaveLength(1);   // исторический максимум ровно один
    expect(currentLines[0]).toMatch(TESTS_RE);
    expect(histMaxLines[0]).toMatch(HIST_MAX_RE);
    // и нигде больше полной формы этих двух строк нет (одна — текущая, одна — рекорд)
    expect(corpus.match(TESTS_RE_G) || []).toHaveLength(1);
    expect(corpus.match(HIST_MAX_RE_G) || []).toHaveLength(1);
  });

  test('семантика: «текущий прогон» и «исторический максимум» — независимые сущности (O-53)', () => {
    // б1: текущий счётчик синхронен факту, исторический максимум — рекорд зелёных
    // прогонов. Рекорд НЕ является полом для текущего: удаление тестов снижает
    // текущее число, и это не регресс (прежнее сравнение current >= max штрафовало
    // работу). Здесь проверяются формат, валидность чисел и непустота истории.
    const currentMatch = TESTS_RE.exec(corpus);
    expect(currentMatch).not.toBeNull();
    const histMaxMatch = HIST_MAX_RE.exec(corpus);
    expect(histMaxMatch).not.toBeNull();

    const current = currentMatch.slice(1).map(Number);
    const histMax = histMaxMatch.slice(1).map(Number);
    expect(current).toHaveLength(4);
    expect(histMax).toHaveLength(4);
    current.concat(histMax).forEach(function (n) {
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);   // валидное неотрицательное число
    });

    // История для пола — все прочие полные формы счётчиков по телу handoff,
    // КРОМЕ обеих исключённых строк: текущей «- **Тесты:» (обновляемой) и
    // рекорда «- **Исторический максимум:». Обе строки уникальны.
    const excluded = [
      [currentMatch.index, currentMatch.index + currentMatch[0].length],
      [histMaxMatch.index, histMaxMatch.index + histMaxMatch[0].length]
    ];
    // Захватываем ЧЕТЫРЕ группы: без `failed` нельзя отличить зелёный прогон
    // от прогона с падениями, а именно это и отделяет cleanHistory ниже.
    const history = [];
    const counterRe = /(\d+) suites \/ (\d+) passed \/ (\d+) skipped \/ (\d+) failed/g;
    let m;
    while ((m = counterRe.exec(corpus)) !== null) {
      const inExcluded = excluded.some(function (r) { return m.index >= r[0] && m.index < r[1]; });
      if (inExcluded) continue;   // текущее и рекорд — не история
      history.push([Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]);
    }
    expect(history.length).toBeGreaterThanOrEqual(20);   // история счётчиков не вычищена

    // Пол берётся ТОЛЬКО по зелёным прогонам (failed === 0). Осознанно упавший
    // прогон не должен задавать планку: иначе осознанное падение пина роняет
    // O-53 повторно. Не-зелёные прогоны остаются в истории (и в инварианте >= 20).
    const cleanHistory = history.filter(function (c) { return c[3] === 0; });
    expect(cleanHistory.length).toBeGreaterThanOrEqual(20);   // зелёных прогонов достаточно для пола
  });

  test('версия: handoff === manifest.json === package.json, упоминание ровно одно', () => {
    const mentions = handoff.match(/Версия:\s*\d+\.\d+\.\d+/g) || [];
    expect(mentions).toHaveLength(1);
    const handoffVersion = mentions[0].match(/Версия:\s*(\d+\.\d+\.\d+)/)[1];
    expect(handoffVersion).toBe(manifest.version);
    expect(handoffVersion).toBe(pkg.version);
  });
});

// ---------------------------------------------------------------------------
// A-1 (v-README-i18n): двуязычный README — ЗАФИКСИРОВАННЫЙ ВАРИАНТ A.
//
// Пины ниже закрывают решение, принятое явно и осознанно: в корне лежат ДВА
// файла — README.md (русский, основной: GitHub рендерит именно его) и
// README.en.md (полная английская версия), со взаимными ссылками в шапке.
// Альтернативы отклонены: вариант Б (один файл с языковым переключателем на
// docs/index.html) отправляет англоязычного читателя в HTML-фолбэк, а вариант В
// (перевод всего в _locales) не покрывает corpus README на GitHub.
//
// Источник данных — только ROOT-относительные пути: read()/abs() из шапки файла
// (fs.readFileSync(__dirname/..)), никаких абсолютных URL, сети и загрузок.
// Скриншоты/видео проверяются на существование по тем же относительным путям,
// поэтому пин самодостаточен и одинаково работает в офлайне на Linux и Windows.
// ---------------------------------------------------------------------------
describe('A-1: README.md + README.en.md — вариант A (два файла в корне)', () => {
  const FENCED_RE = /^```[\s\S]*?^```/gm;
  const INLINE_RE = /`([^`\n]+)`/g;

  const fencedBlocks = function (text) { return text.match(FENCED_RE) || []; };
  const inlineSpans = function (text) {
    const out = [];
    let m;
    INLINE_RE.lastIndex = 0;
    while ((m = INLINE_RE.exec(text)) !== null) out.push(m[1]);
    return Array.from(new Set(out)).sort();
  };
  const relativeAssetLinks = function (text) {
    return (text.match(/\]\(([^)#]+)\)/g) || [])
      .map(function (s) { return s.slice(2, -1); })
      .filter(function (s) { return /^(docs|privacy|LICENSE|\.\.\/)/.test(s); })
      .sort();
  };

  test('P1/P2: взаимные ссылки в шапке каждого файла, ровно по одной', () => {
    const head = function (text) { return text.split(/\r?\n/).slice(0, 4).join('\n'); };
    expect(readme).toContain('](README.en.md)');
    expect(head(readme)).toContain('**Русский**');
    expect(readmeEn).toContain('](README.md)');
    expect(head(readmeEn)).toContain('**English**');
    expect(countOccurrences(readme, '](README.en.md)')).toBe(1);
    expect(countOccurrences(readmeEn, '](README.md)')).toBe(1);
  });

  test('P3: критичные секции есть в обоих файлах (RU либо EN)', () => {
    const SECTIONS = [
      /^##\s+(Install|Установка|Manual install)\s*$/m,
      /^##\s+(Privacy|Приватность)\s*$/m,
      /^##\s+(License|Лицензия)\s*$/m
    ];
    [readme, readmeEn].forEach(function (text) {
      SECTIONS.forEach(function (re) { expect(text).toMatch(re); });
    });
  });

  test('P3: docs/screenshots/ — по 5 ссылок в каждом файле, все 5 файлов существуют', () => {
    const PREVIEWS = [
      'docs/screenshots/gemini-yellow.png',
      'docs/screenshots/chatgpt-red.png',
      'docs/screenshots/google-search-popup.png',
      'docs/screenshots/claude.png',
      'docs/screenshots/perplexity.png'
    ];
    [readme, readmeEn].forEach(function (text) {
      expect(countOccurrences(text, 'docs/screenshots/')).toBeGreaterThanOrEqual(5);
      const images = [];
      const re = /!\[[^\]]*\]\(([^)]+)\)/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m[1].indexOf('docs/screenshots/') === 0) images.push(m[1].trim());
      }
      PREVIEWS.forEach(function (rel) { expect(images).toContain(rel); });
      expect(images.filter(function (src) { return /^(https?:)?\/\//i.test(src); })).toEqual([]);
    });
    PREVIEWS.forEach(function (rel) {
      expect(fs.existsSync(abs(rel))).toBe(true);
      expect(fs.statSync(abs(rel)).size).toBeGreaterThan(10000);
    });
  });

  test('P4: fenced-блоки, архитектурная диаграмма и inline-команды байт-идентичны', () => {
    // код-блоки — в том же порядке и посимвольно одинаковы в RU и EN
    expect(fencedBlocks(readme).length).toBe(2);            // bash + диаграмма
    expect(fencedBlocks(readmeEn)).toEqual(fencedBlocks(readme));

    // архитектурная диаграмма совпадает байт-в-байт с прежним текстом
    const pick = function (text) {
      return fencedBlocks(text).filter(function (b) {
        return b.indexOf('MAIN world interceptors') !== -1;
      });
    };
    expect(pick(readme)).toHaveLength(1);
    expect(pick(readme)).toEqual(pick(readmeEn));
    expect(pick(readme)[0]).toContain('MAIN world interceptors (fetch/XHR)');
    expect(pick(readme)[0]).toContain('ISOLATED content script  -->  badge / auto-export / invisible loader');
    expect(pick(readme)[0]).toContain('service worker (core/background.js)');
    expect(pick(readme)[0]).not.toContain('\r');            // LF-блок, переносы не разъехались

    // inline-команды и пути в бэктиках — один и тот же набор
    expect(inlineSpans(readmeEn)).toEqual(inlineSpans(readme));
    expect(inlineSpans(readme)).toContain('chrome://extensions');
    expect(inlineSpans(readme)).toContain('edge://extensions');
    expect(inlineSpans(readme)).toContain('npm test');

    // относительные ссылки на ассеты/документы — те же пути
    expect(relativeAssetLinks(readmeEn)).toEqual(relativeAssetLinks(readme));
  });

  test('P6: README.en.md без кириллицы, кроме шапки-переключателя и «Помощь / Help»', () => {
    // Конвенция docs/TESTS.md:56-61: англоязычным считается файл, в котором
    // кириллица встречается только в интерфейсных подписях, а не в прозе.
    // Шапка исключена намеренно: это языковой переключатель, метка «Русский»
    // в нём — ссылка на RU-версию, а не русскоязычный текст документа.
    const body = readmeEn.split(/\r?\n/).slice(4).join('\n');
    const uiLabels = /Помощь \/ Help/g;   // подпись ссылки в подвале настроек (UI продукта)
    expect(body.replace(uiLabels, '').match(/[\u0400-\u04FF]/g) || []).toEqual([]);
  });

  test('S-1: живая версия совпадает с manifest.json, датированный снимок — история', () => {
    // Живая ссылка на релиз (канал распространения) обязана совпадать с манифестом.
    expect(readme.match(/ai-context-monitor-v\d+\.\d+\.\d+\.zip/g))
      .toEqual(['ai-context-monitor-v' + manifest.version + '.zip']);
    expect(readme.match(/releases\/tag\/v\d+\.\d+\.\d+/g))
      .toEqual(['releases/tag/v' + manifest.version]);
    expect(readmeEn.match(/releases\/tag\/v\d+\.\d+\.\d+/g))
      .toEqual(['releases/tag/v' + manifest.version]);

    // Датированный снимок тестов синхронизирован НЕ с манифестом, а с docs/TESTS.md
    // (он описывает прошлое дерево и перепинивается отдельно — см. C-11).
    const snapshot = readme.match(SNAPSHOT_RE);
    expect(snapshot).not.toBeNull();
    expect(testsDoc).toContain(snapshot[0]);
    expect(readmeEn).toContain(snapshot[0]);

    // Демо-видео: ссылка ведёт на реально существующий файл, а не на выдуманный путь.
    const video = readme.match(/docs\/videos\/[a-z0-9.-]+\.mp4/);
    expect(video).not.toBeNull();
    expect(fs.existsSync(abs(video[0]))).toBe(true);
  });
});
