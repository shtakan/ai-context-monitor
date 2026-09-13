/**
 * P1 (v1.18): страница политики конфиденциальности.
 *
 * Пины source-level (стиль audit-r3-silent-catch-logs / oracle-archive-complete):
 *  1) privacy/privacy.html существует, является валидным HTML и не тянет внешних ресурсов
 *     (требование MV3 CSP: только inline CSS; M-4.4 добавил ровно одно локальное
 *     подключение — ../options/i18n-apply.js, без inline-кода);
 *  2) в документе есть обязательные разделы (BYOK, хранение, отсутствие телеметрии, 6 AI-сайтов);
 *  3) manifest.json содержит homepage_url (не трогая permissions/host_permissions/CSP) и НЕ содержит
 *     служебных ключей `_comment*` (ред. 2: убран warning «Unrecognized manifest key»);
 *     TODO о замене URL и email живёт в RELEASE_CHECKLIST.md, раздел «Публикация (Edge Add-ons)»;
 *  4) options.html содержит ссылку на privacy.html с target="_blank" и rel="noopener",
 *     а options.js открывает её через chrome.tabs.create + chrome.runtime.getURL.
 *
 * M-4.4: текст политики не переписан — он обёрнут ключами privacy_* (data-i18n), строка
 * редакции обновлена до «2026-09-13 (ред. 4)» и добавлен пункт истории редакций rev. 4.
 *
 * Существующие тесты и существующий код не изменяются.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PRIVACY_PATH = path.join(ROOT, 'privacy', 'privacy.html');
const CHECKLIST_PATH = path.join(ROOT, 'RELEASE_CHECKLIST.md');

const privacyHtml = fs.existsSync(PRIVACY_PATH) ? fs.readFileSync(PRIVACY_PATH, 'utf8') : '';
const optionsHtml = fs.readFileSync(path.join(ROOT, 'options', 'options.html'), 'utf8');
const optionsJs = fs.readFileSync(path.join(ROOT, 'options', 'options.js'), 'utf8');
const optionsCss = fs.readFileSync(path.join(ROOT, 'options', 'options.css'), 'utf8');
const manifestRaw = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');
const manifest = JSON.parse(manifestRaw);
const releaseChecklist = fs.existsSync(CHECKLIST_PATH) ? fs.readFileSync(CHECKLIST_PATH, 'utf8') : '';

// Все шесть AI-сервисов, для которых работает счётчик контекста.
const AI_SITES = ['ChatGPT', 'Gemini', 'DeepSeek', 'Claude', 'Perplexity', 'Google Search AI'];

describe('P1: privacy/privacy.html — файл и валидность', () => {
  test('файл существует и не пуст', () => {
    expect(fs.existsSync(PRIVACY_PATH)).toBe(true);
    expect(privacyHtml.length).toBeGreaterThan(1000);
  });

  test('валидный HTML: DOCTYPE, lang="ru", title, закрывающий тег', () => {
    expect(privacyHtml.trim().startsWith('<!DOCTYPE html>')).toBe(true);
    expect(privacyHtml).toContain('<html lang="ru">');
    expect(privacyHtml.trim().endsWith('</html>')).toBe(true);
    expect(privacyHtml).toContain('<meta charset="UTF-8">');
    expect(privacyHtml).toContain('<meta name="viewport"');
  });

  test('DOM-разбор: заголовок и язык документа', () => {
    const doc = new DOMParser().parseFromString(privacyHtml, 'text/html');
    expect(doc.documentElement.getAttribute('lang')).toBe('ru');
    expect(doc.title).toBe('Политика конфиденциальности — AI Context Monitor');
    const h1 = doc.querySelector('h1');
    expect(h1).not.toBeNull();
    expect(h1.textContent.trim()).toBe('Политика конфиденциальности — AI Context Monitor');
  });

  test('адаптивная вёрстка: max-width 720px и центрирование', () => {
    expect(privacyHtml).toContain('max-width: 720px');
    expect(privacyHtml).toContain('margin: 0 auto');
  });

  test('M-4.4: дата редакции (ред. 4) и версия документа', () => {
    expect(privacyHtml).toContain('Дата последней редакции');
    // M-4.4: редакция обновлена; прежняя редакция осталась в шапке — пин не ослаблен
    expect(privacyHtml).toContain('2026-09-13 (ред. 4)');
    expect(privacyHtml).toContain('2026-09-12 (ред. 3)');
    expect(privacyHtml).toContain('Версия 1.1 от 2026-09-12');
  });

  test('M-4.4: история редакций — rev. 4 «добавлена английская локализация страницы»', () => {
    const doc = new DOMParser().parseFromString(privacyHtml, 'text/html');
    const rows = Array.from(doc.querySelectorAll('table.revisions tbody tr'));
    expect(rows.length).toBe(4);
    const cells = rows.map(function (row) {
      return Array.from(row.querySelectorAll('td')).map(function (td) { return td.textContent.trim(); });
    });
    expect(cells.map(function (row) { return row[0]; })).toEqual(['rev. 1', 'rev. 2', 'rev. 3', 'rev. 4']);
    expect(cells[3][1]).toBe('2026-09-13');
    expect(cells[3][2]).toBe('Добавлена английская локализация страницы.');
    // прежние редакции не переписаны
    expect(cells[2][2]).toContain('chrome.storage.session');
    expect(cells[2][2]).toContain('удаляется.');
  });

  test('навигационные комментарии <!-- Секция X: ... --> на месте', () => {
    for (let i = 1; i <= 9; i++) {
      expect(privacyHtml).toMatch(new RegExp('<!-- Секция ' + i + ': '));
    }
  });
});

describe('P1: privacy/privacy.html — обязательные разделы', () => {
  test('BYOK-ключ Google AI Studio: ключ хранения, эндпоинт, маскирование, удаление', () => {
    expect(privacyHtml).toContain('BYOK-ключ Google AI Studio');
    expect(privacyHtml).toContain('ai_cm_gemini_api_key');
    expect(privacyHtml).toContain('generativelanguage.googleapis.com');
    expect(privacyHtml).toContain('***');
    expect(privacyHtml).toContain('очисткой поля ключа');
  });

  test('обрабатываемые данные: storage, метаданные, настройки, архивы', () => {
    expect(privacyHtml).toContain('chrome.storage.local');
    expect(privacyHtml).toContain('chrome.storage.sync');
    expect(privacyHtml).toContain('convId');
    expect(privacyHtml).toContain('Gemini Takeout');
  });

  test('хранение: лимиты, автоочистка и способы удаления', () => {
    expect(privacyHtml).toContain('50 диалогов');
    expect(privacyHtml).toContain('30 дней');
    expect(privacyHtml).toContain('до 8 МБ');
    expect(privacyHtml).toContain('до 5000 сообщений');
    expect(privacyHtml).toContain('удаление самого расширения');
    expect(privacyHtml).toContain('«Удалить»');
  });

  test('ред. 2: текст соответствует ФАКТИЧЕСКОМУ UI (нет несуществующих кнопок)', () => {
    // В UI нет и не должно упоминаться кнопок, которых нет в коде:
    // удаление — только «Удалить» у архива, BYOK — очистка поля ключа, всё — удаление расширения.
    expect(privacyHtml).not.toContain('Удалить все данные');
    expect(privacyHtml).not.toContain('«Очистить»');
  });

  test('отсутствие телеметрии и передач третьим лицам', () => {
    expect(privacyHtml).toContain('Нет телеметрии, аналитики и crash-репортов');
    expect(privacyHtml).toContain('Нет передачи данных третьим лицам');
    expect(privacyHtml).toContain('Нет обращений к серверам разработчика');
  });

  test('все 6 AI-сайтов перечислены', () => {
    AI_SITES.forEach(function (site) {
      expect(privacyHtml).toContain(site);
    });
  });

  test('разрешения расширения и COPPA', () => {
    expect(privacyHtml).toContain('storage');
    expect(privacyHtml).toContain('notifications');
    expect(privacyHtml).toContain('scripting');
    expect(privacyHtml).toContain('9 host_permissions');
    expect(privacyHtml).toContain('COPPA');
    expect(privacyHtml).toContain('13 лет');
  });

  test('контакты — заглушка с TODO-комментарием', () => {
    expect(privacyHtml).toContain('support@example.com');
    expect(privacyHtml).toContain('<!-- TODO: заменить на реальный email перед публикацией -->');
  });
});

describe('P1: privacy/privacy.html — нет внешних ресурсов (MV3 CSP)', () => {
  // M-4.4: страница подключает ТОЛЬКО локальный механизм локализации
  // (options/i18n-apply.js, относительный путь внутри пакета). Внешних ресурсов и
  // inline-скриптов по-прежнему нет — требование MV3 CSP не ослаблено.
  const LOCAL_SCRIPT = '<script src="../options/i18n-apply.js"></script>';

  test('нет тегов загрузки внешних ресурсов; единственный <script> — локальный', () => {
    const lower = privacyHtml.toLowerCase();
    ['<link', '<img', '<iframe', '<object', '<embed', '@import', 'url(http'].forEach(function (needle) {
      expect([needle, lower.indexOf(needle)]).toEqual([needle, -1]);
    });
    const scripts = privacyHtml.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [];
    expect(scripts).toEqual([LOCAL_SCRIPT]);
    expect(fs.existsSync(path.join(ROOT, 'options', 'i18n-apply.js'))).toBe(true);
  });

  test('DOM-разбор: подключаемых элементов нет, кроме локального скрипта локализации', () => {
    const doc = new DOMParser().parseFromString(privacyHtml, 'text/html');
    expect(doc.querySelectorAll('link,img,iframe,object,embed,audio,video,source').length).toBe(0);
    const scripts = Array.from(doc.querySelectorAll('script'));
    expect(scripts.length).toBe(1);
    expect(scripts[0].getAttribute('src')).toBe('../options/i18n-apply.js');
    // inline-кода нет: CSP MV3 запрещает inline-скрипты
    expect(scripts[0].textContent.trim()).toBe('');
  });

  test('ни один атрибут не содержит абсолютного URL', () => {
    const attrUrls = [];
    const re = /\b(?:src|href|srcset|action|formaction|poster|data)\s*=\s*["']([^"']*)["']/gi;
    let m;
    while ((m = re.exec(privacyHtml)) !== null) attrUrls.push(m[1].trim());
    const external = attrUrls.filter(function (u) { return /^(https?:)?\/\//i.test(u); });
    expect(external).toEqual([]);
  });

  test('в тексте нет ни одной схемы http(s) — только голые упоминания доменов', () => {
    expect(privacyHtml).not.toMatch(/https?:\/\//i);
    expect(privacyHtml).toContain('generativelanguage.googleapis.com');
    expect(privacyHtml).toContain('chatgpt.com');
  });
});

describe('P1: manifest.json — homepage_url без изменения permissions/CSP', () => {
  test('homepage_url добавлен', () => {
    expect(manifest.homepage_url).toBe('https://github.com/user/ai-context-monitor');
  });

  test('в manifest.json НЕТ служебных ключей вида _comment* (ред. 2: убран warning)', () => {
    const commentKeys = Object.keys(manifest).filter(function (k) { return k.indexOf('_comment') === 0; });
    expect(commentKeys).toEqual([]);
    expect(manifestRaw).not.toContain('_comment');
    expect(manifestRaw).not.toContain('TODO');
  });

  test('TODO перенесён в RELEASE_CHECKLIST.md (если файл существует)', () => {
    if (!releaseChecklist) return; // файл в .gitignore, на чистом клоне может отсутствовать
    expect(releaseChecklist).toContain('## Публикация (Edge Add-ons)');
    expect(releaseChecklist).toMatch(/homepage_url.*github/);
    expect(releaseChecklist).toMatch(/support@example\.com/);
  });

  test('НЕ трогать: permissions, host_permissions, CSP, MV3', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(['scripting', 'storage', 'notifications']);
    expect(manifest.host_permissions.length).toBe(9);
    expect(manifest).not.toHaveProperty('content_security_policy');
    expect(manifestRaw).not.toContain('privacy/privacy.html');
  });
});

describe('P1: ссылка на политику в UI настроек', () => {
  test('options.html: ссылка в футере с target="_blank" и rel="noopener"', () => {
    expect(optionsHtml).toContain(
      // M-4.3: подпись ссылки вынесена в <span data-i18n="options_footer_privacy">:
      // сам <a> не изменён (target/_blank, rel/noopener, href), русский фолбэк байтово тот же
      '<a href="privacy/privacy.html" id="privacy-link" target="_blank" rel="noopener"><span data-i18n="options_footer_privacy">Политика конфиденциальности</span></a>'
    );
    const doc = new DOMParser().parseFromString(optionsHtml, 'text/html');
    const link = doc.querySelector('.footer #privacy-link');
    expect(link).not.toBeNull();
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener');
  });

  test('options.js: клик открывает privacy.html во внешней вкладке', () => {
    expect(optionsJs).toContain('// v1.18 (P1): открытие privacy.html во внешней вкладке');
    expect(optionsJs).toContain("document.getElementById('privacy-link')");
    expect(optionsJs).toContain("chrome.tabs.create({ url: chrome.runtime.getURL('privacy/privacy.html') })");
  });

  test('options.css: ссылка стилизована (цвет + подчёркивание при hover)', () => {
    expect(optionsCss).toContain('#privacy-link {');
    expect(optionsCss).toContain('#privacy-link:hover');
    expect(optionsCss).toContain('text-decoration: underline');
  });
});
