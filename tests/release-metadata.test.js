/**
 * M-10 (v1.18): комплект полей листинга для Microsoft Edge Add-ons.
 *
 * Пины source-level (стиль privacy.test.js / docs-hygiene.test.js) — только чтение:
 *  1) tools/edge-listing-metadata.txt существует и содержит обязательные секции
 *     «ПОЛЕ: НАЗВАНИЕ / КРАТКОЕ ОПИСАНИЕ / ПОЛНОЕ ОПИСАНИЕ / КАТЕГОРИЯ / URL ПОЛИТИКИ /
 *     СКРИНШОТЫ / ИНСТРУКЦИИ ДЛЯ РЕВЬЮЕРА» + раздел «ЗАМЕТКИ»;
 *  2) лимиты Partner Center соблюдены: НАЗВАНИЕ ≤ 45 символов, КРАТКОЕ ОПИСАНИЕ ≤ 132
 *     символов и укладывается в одну строку (до переноса строки), ПОЛНОЕ ОПИСАНИЕ 4–6 абзацев;
 *  3) все 5 имён скриншотов из docs/screenshots/ перечислены и файлы реально существуют;
 *  4) TODO-заглушки (URL политики на GitHub Pages, homepage_url, email поддержки) помечены
 *     как TODO и согласованы с RELEASE_CHECKLIST.md п.5.1;
 *  5) инструкции для ревьюера — 4 шага + явная пометка, что BYOK-ключ НЕ обязателен.
 *
 * Код расширения, manifest.json, privacy/privacy.html, release.yml, README и docs не изменяются.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const METADATA_PATH = path.join(ROOT, 'tools', 'edge-listing-metadata.txt');
const CHECKLIST_PATH = path.join(ROOT, 'RELEASE_CHECKLIST.md');

const metadata = fs.existsSync(METADATA_PATH) ? fs.readFileSync(METADATA_PATH, 'utf8') : '';
const lines = metadata.split(/\r?\n/);
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const releaseYml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
const releaseChecklist = fs.existsSync(CHECKLIST_PATH) ? fs.readFileSync(CHECKLIST_PATH, 'utf8') : '';

// CI-хотфикс v1.19.3: tools/ — gitignored-артефакт (см. .gitignore), в чистом чекауте
// его нет. Тогда весь набор пинов листинга уходит в ЯВНЫЙ skip с причиной в выводе,
// вместо красного прогона. При наличии файла проверки ниже строгие и не ослаблены.
const HAS_LISTING = fs.existsSync(METADATA_PATH);
const describeListing = HAS_LISTING ? describe : describe.skip;

if (!HAS_LISTING) {
  console.log('[release-metadata] SKIP: tools/edge-listing-metadata.txt отсутствует ' +
    '(gitignored, чистый чекаут) — строгие пины листинга M-10 пропущены');
}

// Секции, наличие которых обязательно в комплекте листинга (имя поля после «ПОЛЕ: »).
const REQUIRED_FIELDS = [
  'НАЗВАНИЕ',
  'КРАТКОЕ ОПИСАНИЕ',
  'ПОЛНОЕ ОПИСАНИЕ',
  'КАТЕГОРИЯ',
  'URL ПОЛИТИКИ',
  'СКРИНШОТЫ',
  'ИНСТРУКЦИИ ДЛЯ РЕВЬЮЕРА'
];

const SCREENSHOTS = [
  'gemini-yellow.png',
  'chatgpt-red.png',
  'google-search-popup.png',
  'claude.png',
  'perplexity.png'
];

const KEYWORDS = [
  'context window',
  'token counter',
  'ChatGPT',
  'Gemini',
  'Claude',
  'DeepSeek',
  'Perplexity',
  'Google Search AI',
  'лимит контекста',
  'автоэкспорт'
];

const AI_SITES = ['ChatGPT', 'Gemini', 'DeepSeek', 'Claude', 'Perplexity', 'Google Search AI'];

// Индекс строки-заголовка «ПОЛЕ: <имя> ...».
const fieldStart = function (name) {
  return lines.findIndex(function (l) { return l.indexOf('ПОЛЕ: ' + name) === 0; });
};

// Тело поля: строки после заголовка до следующего «ПОЛЕ:», «ЗАМЕТКИ» или разделителя.
const fieldBody = function (name) {
  const start = fieldStart(name);
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.indexOf('ПОЛЕ: ') === 0) break;
    if (line.indexOf('ЗАМЕТКИ') === 0) break;
    if (/^=+$/.test(line.trim())) break;
    body.push(line);
  }
  while (body.length && body[body.length - 1].trim() === '') body.pop();
  return body;
};

// Значение однострочного поля — первая непустая строка тела; для многострочных полей
// первая строка осмысленна только там, где значение действительно однострочное.
const fieldValue = function (name) {
  const body = fieldBody(name);
  if (!body) return null;
  const first = body.find(function (l) { return l.trim() !== ''; });
  return first === undefined ? null : first.trim();
};

const nonEmptyLines = function (body) {
  return (body || []).filter(function (l) { return l.trim() !== ''; });
};

const paragraphs = function (name) {
  const out = [];
  let current = [];
  (fieldBody(name) || []).forEach(function (line) {
    if (line.trim() === '') {
      if (current.length) { out.push(current.join(' ')); current = []; }
    } else {
      current.push(line.trim());
    }
  });
  if (current.length) out.push(current.join(' '));
  return out;
};

describeListing('M-10: tools/edge-listing-metadata.txt — файл и обязательные секции', () => {
  test('файл существует в tools/ и не пуст', () => {
    expect(fs.existsSync(METADATA_PATH)).toBe(true);
    expect(metadata.length).toBeGreaterThan(1500);
    expect(fs.statSync(METADATA_PATH).isFile()).toBe(true);
  });

  test('содержит все обязательные секции «ПОЛЕ: ...»', () => {
    REQUIRED_FIELDS.forEach(function (name) {
      expect(fieldStart(name)).toBeGreaterThan(-1);
      expect(fieldValue(name)).toBeTruthy();
    });
  });

  test('есть раздел «ЗАМЕТКИ»', () => {
    expect(metadata).toMatch(/^ЗАМЕТКИ/m);
  });

  test('язык листинга — Russian', () => {
    expect(metadata).toContain('Russian');
    expect(metadata).toContain('Язык листинга: русский');
  });

  test('у каждого поля в скобках указана длина или лимит', () => {
    REQUIRED_FIELDS.forEach(function (name) {
      const header = lines[fieldStart(name)];
      expect(header).toMatch(/\(.*\)/);
    });
  });
});

describeListing('M-10: лимиты Partner Center — НАЗВАНИЕ и КРАТКОЕ ОПИСАНИЕ', () => {
  test('НАЗВАНИЕ: значение «AI Context Monitor» и длина ≤ 45', () => {
    const value = fieldValue('НАЗВАНИЕ');
    expect(value).toBe('AI Context Monitor');
    expect(value.length).toBeLessThanOrEqual(45);
  });

  test('КРАТКОЕ ОПИСАНИЕ: одна строка, ≤ 132 символов, до переноса строки', () => {
    const body = fieldBody('КРАТКОЕ ОПИСАНИЕ');
    expect(nonEmptyLines(body).length).toBe(1);      // значение не переносится
    const value = fieldValue('КРАТКОЕ ОПИСАНИЕ');
    expect(value.length).toBeGreaterThan(40);
    expect(value.length).toBeLessThanOrEqual(132);
    expect(value.endsWith('.')).toBe(true);
    expect(value).toMatch(/контекстн/i);
    expect(value).toMatch(/токен/i);
    expect(value).toMatch(/%|процент/i);
    expect(value).toMatch(/6 сайт/i);                // шесть поддерживаемых сайтов
  });

  test('объявленная в скобках длина НАЗВАНИЯ/КРАТКОГО совпадает с фактической', () => {
    const titleHeader = lines[fieldStart('НАЗВАНИЕ')];
    const shortHeader = lines[fieldStart('КРАТКОЕ ОПИСАНИЕ')];
    expect(titleHeader).toContain('длина: ' + fieldValue('НАЗВАНИЕ').length);
    expect(shortHeader).toContain('длина: ' + fieldValue('КРАТКОЕ ОПИСАНИЕ').length);
  });

  test('ПОЛНОЕ ОПИСАНИЕ: 4–6 абзацев и в пределах 10 000 символов', () => {
    const blocks = paragraphs('ПОЛНОЕ ОПИСАНИЕ');
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    expect(blocks.length).toBeLessThanOrEqual(6);
    blocks.forEach(function (p) {
      expect(p.length).toBeGreaterThan(100);
    });
    expect(blocks.join('\n').length).toBeLessThanOrEqual(10000);
  });

  test('ПОЛНОЕ ОПИСАНИЕ покрывает проблему, решение, 6 сайтов, экспорт/архивы, приватность и требования', () => {
    const text = paragraphs('ПОЛНОЕ ОПИСАНИЕ').join('\n');
    expect(text).toMatch(/контекстн\S* окн/i);        // проблема: лимит контекста (\w не покрывает кириллицу)
    expect(text).toMatch(/индикатор/i);               // решение: счётчик/индикатор
    expect(text).toMatch(/попап|попапе/i);            // решение: попап
    AI_SITES.forEach(function (site) {
      expect(text).toContain(site);
    });
    expect(text).toMatch(/автоматически выгружает|автоэкспорт/i);
    expect(text).toMatch(/Gemini Takeout/);
    expect(text).toMatch(/txt, md или json/);
    expect(text).toMatch(/локально/i);
    expect(text).toMatch(/телеметрии/);
    expect(text).toMatch(/политики конфиденциальности/i);
    expect(text).toMatch(/Manifest V3/);
    expect(text).toMatch(/Chromium|Edge или Google Chrome/);
    expect(text).toMatch(/70 \/ 85 \/ 95/);
  });
});

describeListing('M-10: категория, URL политики, домашняя страница, ключевые слова', () => {
  test('КАТЕГОРИЯ: Productivity с подкатегорией Developer Tools и фолбэком', () => {
    const body = (fieldBody('КАТЕГОРИЯ') || []).join('\n');
    expect(body).toContain('Productivity');
    expect(body).toContain('Developer Tools');
    expect(body).toMatch(/если подкатегория недоступна — Productivity/);
  });

  test('URL ПОЛИТИКИ: заглушка GitHub Pages с явной пометкой про включение Pages', () => {
    const header = lines[fieldStart('URL ПОЛИТИКИ')];
    const value = fieldValue('URL ПОЛИТИКИ');
    expect(value).toBe('https://<owner>.github.io/ai-context-monitor/privacy/privacy.html');
    expect(header).toContain('GitHub Pages');
    expect(header).toMatch(/TODO/);
    expect(fs.existsSync(path.join(ROOT, 'privacy', 'privacy.html'))).toBe(true);
  });

  test('ДОМАШНЯЯ СТРАНИЦА: совпадает с homepage_url из manifest.json и помечена TODO', () => {
    const header = lines[fieldStart('ДОМАШНЯЯ СТРАНИЦА')];
    expect(fieldValue('ДОМАШНЯЯ СТРАНИЦА')).toBe(manifest.homepage_url);
    expect(header).toContain('homepage_url');
    expect(header).toMatch(/TODO/);
  });

  test('КЛЮЧЕВЫЕ СЛОВА: все 10 терминов перечислены', () => {
    const value = fieldValue('КЛЮЧЕВЫЕ СЛОВА');
    KEYWORDS.forEach(function (kw) {
      expect(value).toContain(kw);
    });
    expect(value.split(',').length).toBeGreaterThanOrEqual(10);
  });
});

describeListing('M-10: скриншоты и иконка', () => {
  test('все 5 имён скриншотов перечислены и файлы существуют', () => {
    const body = (fieldBody('СКРИНШОТЫ') || []).join('\n');
    expect(nonEmptyLines(fieldBody('СКРИНШОТЫ')).length).toBe(5);
    SCREENSHOTS.forEach(function (name) {
      expect(body).toContain('docs/screenshots/' + name);
      const abs = path.join(ROOT, 'docs', 'screenshots', name);
      expect(fs.existsSync(abs)).toBe(true);
      expect(fs.statSync(abs).size).toBeGreaterThan(10000);
    });
  });

  test('скриншоты помечены как PNG ≥1280 по ширине и лежащие в репозитории', () => {
    const header = lines[fieldStart('СКРИНШОТЫ')];
    expect(header).toContain('PNG ≥1280 по ширине');
    expect(header).toContain('лежат в репозитории');
  });

  test('ИКОНКА: icons/icon128.png существует и указана', () => {
    const body = (fieldBody('ИКОНКА') || []).join('\n');
    expect(body).toContain('icons/icon128.png');
    expect(fs.existsSync(path.join(ROOT, 'icons', 'icon128.png'))).toBe(true);
  });
});

describeListing('M-10: инструкции для ревьюера', () => {
  test('ровно 4 пронумерованных шага, включая установку и проверку индикатора с попапом', () => {
    const steps = nonEmptyLines(fieldBody('ИНСТРУКЦИИ ДЛЯ РЕВЬЮЕРА')).filter(function (l) {
      return /^\d+[.)]\s/.test(l.trim());
    });
    expect(steps.length).toBe(4);
    expect(steps[0]).toMatch(/распакованн/i);
    expect(steps[0]).toContain('edge://extensions');
    expect(steps[1]).toMatch(/gemini\.google\.com|google\.com\/search/);
    expect(steps[2]).toMatch(/вопрос/i);
    expect(steps[3]).toMatch(/индикатор/i);
    expect(steps[3]).toMatch(/попап/i);
    expect(steps[3]).toMatch(/иконк/i);
  });

  test('явно указано, что BYOK-ключ НЕ обязателен для базовой работы', () => {
    const body = (fieldBody('ИНСТРУКЦИИ ДЛЯ РЕВЬЮЕРА') || []).join('\n');
    expect(body).toMatch(/BYOK-ключ Google AI Studio НЕ обязателен/);
    expect(body).toMatch(/оцениваются локально/);
  });
});

describeListing('M-10: ЗАМЕТКИ и релизная гигиена', () => {
  test('TODO из RELEASE_CHECKLIST.md п.5.1 перенесены (homepage_url, email поддержки)', () => {
    const notes = metadata.slice(metadata.indexOf('ЗАМЕТКИ'));
    expect(notes).toContain('RELEASE_CHECKLIST.md п.5.1');
    expect(notes).toContain('homepage_url');
    expect(notes).toContain('support@example.com');
    expect(notes).toMatch(/включить GitHub Pages/);
    // заголовок политики и заглушка в заметках совпадают с полем
    expect(notes).toContain(fieldValue('URL ПОЛИТИКИ'));
  });

  test('если RELEASE_CHECKLIST.md доступен, пункт 5.1 говорит о тех же заменах', () => {
    if (!releaseChecklist) return; // файл в .gitignore, на чистом клоне может отсутствовать
    expect(releaseChecklist).toContain('## Публикация (Edge Add-ons)');
    expect(releaseChecklist).toMatch(/homepage_url/);
    expect(releaseChecklist).toMatch(/support@example\.com/);
  });

  test('служебный файл не попадает в релизный ZIP: release.yml исключает tools/', () => {
    const excludeLines = releaseYml.split(/\r?\n/).filter(function (l) {
      return l.indexOf('grep -zvE') !== -1;
    });
    expect(excludeLines.length).toBe(1);
    expect(excludeLines[0]).toContain('tools/');
  });

  test('НЕ трогать: код расширения, manifest, privacy.html, release.yml, README, docs', () => {
    expect(fs.existsSync(path.join(ROOT, 'tools', 'edge-listing-metadata.txt'))).toBe(true);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.manifest_version).toBe(3);
    // Файл листинга — самостоятельный артефакт: он не подключается ни из manifest, ни из UI.
    expect(JSON.stringify(manifest)).not.toContain('edge-listing-metadata');
    expect(fs.readFileSync(path.join(ROOT, 'options', 'options.html'), 'utf8'))
      .not.toContain('edge-listing-metadata');
  });
});

// Явная запись пропуска в выводе (verbose: true печатает имя теста) — чтобы зелёный Lint
// на чистом чекауте не выглядел как «проверки прошли», когда их фактически не было.
if (!HAS_LISTING) {
  describe('M-10: skip при отсутствии gitignored-артефакта', () => {
    test.skip('tools/edge-listing-metadata.txt отсутствует в чистом чекауте ' +
      '(.gitignore: tools/) — пины листинга M-10 пропущены, а не пройдены', () => {});
  });
}
