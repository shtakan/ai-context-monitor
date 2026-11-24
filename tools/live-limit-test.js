#!/usr/bin/env node
'use strict';

/**
 * Живой лимит-тест окна контекста для веб-модели ChatGPT (цель — gpt-6-mini).
 *
 * Зачем: `/backend-api/models` отдаёт `max_tokens` (потолок ответа), но не
 * окно контекста. Копировать окно GPT-6 без проверки нельзя. Эта программа
 * измеряет ИСПОЛЬЗУЕМОЕ окно веб-чата, то есть ровно то число, которое
 * показывает расширение.
 *
 * Измерительный прибор — само расширение: после каждого куска наполнителя
 * программа читает «Токены: N» из виджета. Оценок «символы / 4» в отчёте нет.
 *
 * Метод (подробно — acceptance/BIG-2026-11/2.2/LIVE-LIMIT-TEST-PLAN.md):
 *   1. Наполняем чат детерминированным текстом.
 *   2. В первом и последнем сообщении — разные случайные метки.
 *   3. Просим назвать обе. Первая потеряна, последняя видна => ранний
 *      контекст вытеснен, окно меньше измеренного объёма.
 *   4. Серверный баннер «Контекстное окно заполнено» — авторитетное
 *      переполнение.
 *
 * Команды:
 *   node tools/live-limit-test.js plan  [--mode quick|confirm|bracket] [--target N]
 *   node tools/live-limit-test.js recon [--session S] [--scope gpt-mini-limit]
 *   node tools/live-limit-test.js run   [--mode ...] [--confirm] [--dry-run]
 *
 * `run` без `--confirm` только печатает план: тест расходует реальные токены.
 * Программа ничего не пишет в model-config — только рекомендацию в отчёте.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const lib = require('./live-limit-test-lib.js');

const ROOT = path.resolve(__dirname, '..');
// Acceptance-дерево лежит рядом с репозиторием (рабочая область
// Prompts/): Prompts/acceptance/..., а не внутри ai-context-monitor-clean.
// При другой раскладке путь переопределяется через --out.
const DEFAULT_OUT = path.resolve(ROOT, '..', 'acceptance', 'BIG-2026-11', '2.2', 'live-limit-test');
const CHATGPT_URL = 'https://chatgpt.com/';
const WIDGET_TOOLTIP = '#ai-context-widget .ai-widget-tooltip';
const WIDGET_TEXT = '#ai-context-widget .ai-widget-text';
// ChatGPT 2026-11: #prompt-textarea больше нет, композер — div.ProseMirror.
const COMPOSER = '#prompt-textarea, div.ProseMirror[contenteditable="true"], div[contenteditable="true"][role="textbox"]';
// Старый и новый маркеры сообщений: в билде 2026-11 data-message-author-role
// отсутствует, роль видна по data-content-search-unit-key="<conv>:N:assistant".
const USER_SEL = '[data-message-author-role="user"], [data-content-search-unit-key$=":user"]';
const ASSISTANT_SEL = '[data-message-author-role="assistant"], [data-content-search-unit-key$=":assistant"]';

// ---------------------------------------------------------------------------
// Мелкие утилиты
// ---------------------------------------------------------------------------

function log(line) {
  process.stdout.write(String(line) + '\n');
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms | 0));
}

function randHex(n) {
  return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
}

function stamp() {
  const d = new Date();
  const p = function (x) { return String(x).padStart(2, '0'); };
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.indexOf('--') === 0) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.indexOf('--') === 0) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// bsk / PowerShell
// ---------------------------------------------------------------------------

function bsk(args, opts) {
  const o = opts || {};
  const full = args.slice();
  if (o.session) full.push('--session', o.session);
  if (o.json) full.push('--json');
  if (o.observation) full.push('--observation', o.observation);
  const r = spawnSync('bsk', full, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: o.timeout || 180000,
    maxBuffer: 64 * 1024 * 1024
  });
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  if (r.error) {
    const err = new Error('bsk ' + args[0] + ' не запустился: ' + r.error.message);
    err.stdout = stdout;
    err.stderr = stderr;
    throw err;
  }
  if (r.status !== 0 && !o.allowFail) {
    const err = new Error('bsk ' + args[0] + ' упал (' + r.status + '): ' +
      (stderr.trim() || stdout.trim()).slice(0, 900));
    err.stdout = stdout;
    err.stderr = stderr;
    err.status = r.status;
    throw err;
  }
  return { status: r.status, stdout: stdout, stderr: stderr, text: stdout.trim() };
}

function parseSessionId(text) {
  const m = String(text || '').match(/session=([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  try {
    const j = JSON.parse(text);
    if (j && typeof j.session_id === 'string') return j.session_id;
    if (j && j.session && typeof j.session.id === 'string') return j.session.id;
  } catch (e) { /* не JSON — это нормально */ }
  return '';
}

function openSession(url, scope, extra) {
  const args = ['open', url, '--scope', scope, '--no-focus', '--max-tokens', '80'];
  if (extra && extra.session) args.push('--session', extra.session);
  const r = bsk(args, { allowFail: true, timeout: 180000 });
  const id = parseSessionId(r.text) || (extra && extra.session) || '';
  if (!id) {
    throw new Error('bsk open не вернул session id. Вывод: ' + r.text.slice(0, 500));
  }
  return { session: id, raw: r.text };
}

function ensureSession(opts) {
  if (opts.session) {
    const chk = bsk(['sync', '--json'], { session: opts.session, allowFail: true, timeout: 60000 });
    if (chk.status !== 0) {
      throw new Error('Сессия ' + opts.session + ' недоступна (истекла?). Запустите без --session.');
    }
    return opts.session;
  }
  const st = bsk(['status'], { allowFail: true });
  if (st.status !== 0) {
    throw new Error('bsk daemon недоступен. Запустите браузер с bsk и повторите.');
  }
  const opened = openSession(CHATGPT_URL, opts.scope, null);
  log('session: ' + opened.session);
  sleep(1500);
  return opened.session;
}

function evaluate(session, expression, opts) {
  const o = opts || {};
  const r = bsk(['evaluate', expression, '--unverified', '--await-promise', 'true'], {
    session: session,
    timeout: o.timeout || 120000,
    allowFail: !!o.allowFail
  });
  const t = r.text;
  try {
    return JSON.parse(t);
  } catch (e) {
    return t;
  }
}

function readSelector(session, selector) {
  const r = bsk(['read', '--selector', selector], {
    session: session,
    json: true,
    allowFail: true,
    timeout: 60000
  });
  if (r.status !== 0) return '';
  let j;
  try {
    j = JSON.parse(r.text);
  } catch (e) {
    return r.text;
  }
  const items = j && j.items;
  if (!Array.isArray(items) || !items.length) return '';
  return items.map(function (it) {
    return (it && it.values && it.values.text) || '';
  }).join('\n').trim();
}

function consoleTexts(session, limit) {
  const r = bsk(['console', '--json', '--limit', String(limit || 200)], {
    session: session,
    allowFail: true,
    timeout: 60000
  });
  if (r.status !== 0) return [];
  try {
    const j = JSON.parse(r.text);
    const items = Array.isArray(j) ? j : (j && (j.items || j.entries)) || [];
    return items.map(function (i) { return String((i && i.text) || ''); });
  } catch (e) {
    return [];
  }
}

function composerState(session) {
  const v = evaluate(session,
    '(() => {' +
    ' const el = document.querySelector(' + JSON.stringify(COMPOSER) + ');' +
    ' return { found: !!el, len: el ? String(el.innerText || el.textContent || "").length : 0 };' +
    '})()');
  return (v && typeof v === 'object') ? v : { found: false, len: 0 };
}

function messageCounts(session) {
  const v = evaluate(session,
    '(() => ({' +
    ' user: document.querySelectorAll(' + JSON.stringify(USER_SEL) + ').length,' +
    ' assistant: document.querySelectorAll(' + JSON.stringify(ASSISTANT_SEL) + ').length' +
    '}))()');
  return (v && typeof v === 'object') ? v : { user: 0, assistant: 0 };
}

function lastAssistantText(session) {
  const v = evaluate(session,
    '(() => {' +
    ' const a = [...document.querySelectorAll(' + JSON.stringify(ASSISTANT_SEL) + ')];' +
    ' const el = a[a.length - 1];' +
    ' return el ? String(el.innerText || "").slice(-4000) : "";' +
    '})()');
  return typeof v === 'string' ? v : '';
}

function clearComposer(session) {
  evaluate(session,
    '(() => {' +
    ' const el = document.querySelector(' + JSON.stringify(COMPOSER) + ');' +
    ' if (!el) return false;' +
    ' el.focus();' +
    ' document.execCommand("selectAll", false, null);' +
    ' document.execCommand("delete", false, null);' +
    ' return true;' +
    '})()');
}

/**
 * Вставляет большой текст без clipboard и без гигантского argv:
 * сначала собираем строку в window.__ltText кусками по 20K символов,
 * потом один execCommand('insertText').
 */
function insertText(session, text) {
  const chunk = 20000;
  evaluate(session, 'window.__ltText = ""; true');
  for (let i = 0; i < text.length; i += chunk) {
    const part = text.slice(i, i + chunk);
    evaluate(session,
      'window.__ltText = (window.__ltText || "") + ' + JSON.stringify(part) + '; (window.__ltText || "").length');
  }
  const v = evaluate(session,
    '(() => {' +
    ' const el = document.querySelector(' + JSON.stringify(COMPOSER) + ') || document.querySelector(\'div[contenteditable="true"]\');' +
    ' if (!el) return { ok: false, reason: "no-composer" };' +
    ' el.focus();' +
    ' const src = window.__ltText || "";' +
    ' window.__ltText = "";' +
    ' const ok = document.execCommand("insertText", false, src);' +
    ' return { ok: !!ok, len: String(el.innerText || el.textContent || "").length, expected: src.length };' +
    '})()');
  const res = (v && typeof v === 'object') ? v : { ok: false, reason: 'bad-evaluate' };
  if (res.ok && res.len >= Math.floor(text.length * 0.9)) return res;

  // Запасной путь для небольших кусков: штатный bsk fill.
  if (text.length <= 18000) {
    if (fillComposer(session, text)) {
      const after = composerState(session);
      if (after.len >= Math.floor(text.length * 0.9)) return { ok: true, len: after.len, via: 'fill' };
    }
  }
  return { ok: false, reason: res.reason || 'insert-mismatch', len: res.len, expected: text.length };
}

function pressEnterInComposer(session) {
  const sels = ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"]'];
  for (let i = 0; i < sels.length; i++) {
    const r = bsk(['press', 'Enter', '--selector', sels[i]], { session: session, allowFail: true, timeout: 60000 });
    if (r.status === 0) return true;
  }
  return false;
}

function fillComposer(session, text) {
  const sels = ['#prompt-textarea', 'div.ProseMirror', 'div[contenteditable="true"]'];
  for (let i = 0; i < sels.length; i++) {
    const r = bsk(['fill', '--selector', sels[i], '--value', text], {
      session: session,
      allowFail: true,
      timeout: 120000
    });
    if (r.status === 0) return true;
  }
  return false;
}

function sendMessage(session, text, opts) {
  const before = messageCounts(session);
  const existing = composerState(session);
  if (existing.found && existing.len > 0) clearComposer(session);
  const ins = insertText(session, text);
  if (!ins.ok) {
    return { sent: false, tooLong: false, reason: ins.reason || 'insert-failed' };
  }
  pressEnterInComposer(session);
  sleep(800);
  let after = messageCounts(session);
  if (after.user <= before.user) {
    evaluate(session,
      '(() => {' +
      ' const b = document.querySelector(\'[data-testid="send-button"]\') ||' +
      '  [...document.querySelectorAll("button")].find(x => /отправить|send/i.test((x.getAttribute("aria-label") || "") + " " + (x.innerText || "")));' +
      ' if (b) { b.click(); return true; } return false;' +
      '})()');
    sleep(1500);
    after = messageCounts(session);
  }
  if (after.user <= before.user) {
    const alerts = evaluate(session,
      '(() => [...document.querySelectorAll(\'[role="alert"],[data-testid*="toast"]\')].map(e => e.innerText || "").join(" ").slice(0, 600))()');
    const tooLong = /слишком длин|too long|maximum length|message is too|limit/i.test(String(alerts || ''));
    return { sent: false, tooLong: tooLong, reason: tooLong ? 'too-long' : 'not-sent', alerts: alerts };
  }
  return { sent: true, tooLong: false, assistantBefore: before.assistant };
}

function waitForReply(session, beforeAssistant, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const st = evaluate(session,
      '(() => {' +
      ' const a = [...document.querySelectorAll(' + JSON.stringify(ASSISTANT_SEL) + ')];' +
      ' return {' +
      '  count: a.length,' +
      '  streaming: !!document.querySelector(\'[data-testid="stop-button"]\'),' +
      '  last: a.length ? String(a[a.length - 1].innerText || "").slice(-4000) : ""' +
      ' };' +
      '})()');
    if (st && st.count > beforeAssistant && !st.streaming && String(st.last || '').trim()) {
      return st;
    }
    last = st && st.last ? st.last : last;
    sleep(1500);
  }
  return { count: beforeAssistant, streaming: false, last: last, timeout: true };
}

function newChat(session) {
  const r = bsk(['open', CHATGPT_URL, '--session', session, '--no-focus', '--max-tokens', '40'], {
    allowFail: true,
    timeout: 180000
  });
  if (r.status !== 0) {
    bsk(['reload'], { session: session, allowFail: true, timeout: 60000 });
  }
  sleep(1800);
}

function widgetState(session) {
  const tooltip = readSelector(session, WIDGET_TOOLTIP);
  const percentText = readSelector(session, WIDGET_TEXT);
  const tokensMatch = tooltip.match(/Токены:\s*([0-9\s\u00A0\u202F]+)/);
  const tokens = tokensMatch ? Number(tokensMatch[1].replace(/[^0-9]/g, '')) : 0;
  const modelMatch = tooltip.match(/Модель:\s*(.+?)(?:Токены:|$)/);
  const limitMatch = tooltip.match(/Предел:\s*(.+?)(?:Окно модели:|Источник:|$)/);
  const pctMatch = percentText.match(/([0-9]+(?:[.,][0-9]+)?)\s*%/);
  return {
    tokens: Number.isFinite(tokens) ? tokens : 0,
    model: modelMatch ? modelMatch[1].trim() : '',
    limit: limitMatch ? limitMatch[1].trim() : '',
    percent: pctMatch ? Number(pctMatch[1].replace(',', '.')) : null,
    raw: tooltip.slice(0, 400)
  };
}

function isSaturated(session) {
  const v = evaluate(session,
    '(() => {' +
    ' const phrases = [' +
    '  "контекстное окно заполнено",' +
    '  "context window is full",' +
    '  "reached the context limit",' +
    '  "conversation is too long"' +
    ' ];' +
    ' const actions = ["новый чат", "new chat", "обновить до plus", "upgrade to plus", "upgrade plan", "обновить до бизнес"];' +
    ' const controls = document.querySelectorAll(\'button, a, [role="button"]\');' +
    ' for (let i = 0; i < controls.length; i++) {' +
    '  const label = String(controls[i].textContent || "").trim().toLowerCase();' +
    '  if (!label || !actions.some(t => label.indexOf(t) !== -1)) continue;' +
    '  let scope = controls[i].parentElement;' +
    '  for (let d = 0; d < 7 && scope; d++) {' +
    '   if (scope === document.body || scope === document.documentElement) break;' +
    '   const text = String(scope.textContent || "").toLowerCase();' +
    '   if (text.length > 0 && text.length <= 1200 && phrases.some(p => text.indexOf(p) !== -1)) return true;' +
    '   scope = scope.parentElement;' +
    '  }' +
    ' }' +
    ' return false;' +
    '})()');
  return v === true;
}

function lastModelFromConsole(session) {
  const lines = consoleTexts(session, 200);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/badge-update[^\n]*model=([^\s]+)/);
    if (m) return m[1];
  }
  return '';
}

/**
 * Какой slug реально обслужил чат. Брать из DOM нельзя: расширение само
 * схлопывает gpt-6-mini в GPT-6 по префиксу. Поэтому читаем его же
 * console-лог, где model-detect печатает сетевой raw-slug.
 *
 * В билде ChatGPT 2026-11 REST-запрос истории отдаёт 404
 * (`conversation_inaccessible`), поэтому console — основной источник.
 */
function servedModel(session) {
  const lines = consoleTexts(session, 300);
  for (let i = lines.length - 1; i >= 0; i--) {
    let m = lines[i].match(/\[model-detect\][^\n]*путь=сеть,\s*raw="([^"]+)"/);
    if (m) return { slug: m[1], source: 'console:model-detect-network' };
    m = lines[i].match(/model_slug=([A-Za-z0-9._-]+)/);
    if (m) return { slug: m[1], source: 'console:ai-cm-intercept' };
  }
  return { slug: '', source: 'none' };
}

function pickerOptions(session) {
  const v = evaluate(session,
    '(async () => {' +
    ' const controls = [...document.querySelectorAll(\'button,[role="button"],[aria-haspopup]\')];' +
    ' const modelish = controls.find(x => {' +
    '  const s = (x.innerText || "") + " " + (x.getAttribute("aria-label") || "") + " " + (x.getAttribute("data-testid") || "");' +
    '  return /gpt|модел|model/i.test(s) && !/размышл|reason|голос|voice|дикт|dikt/i.test(s);' +
    ' });' +
    ' let opener = "";' +
    ' if (modelish) { modelish.click(); opener = String(modelish.innerText || modelish.getAttribute("aria-label") || "").trim(); }' +
    ' await new Promise(r => setTimeout(r, 600));' +
    ' const nodes = [...document.querySelectorAll(\'[role="menuitemradio"],[role="menuitem"],[data-testid*="model"]\')];' +
    ' const options = [];' +
    ' const seen = {};' +
    ' for (const n of nodes) {' +
    '  const text = String(n.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 160);' +
    '  if (!text || seen[text]) continue;' +
    '  seen[text] = 1;' +
    '  options.push({' +
    '   text: text,' +
    '   testid: n.getAttribute("data-testid") || "",' +
    '   checked: n.getAttribute("aria-checked") || ""' +
    '  });' +
    ' }' +
    ' return { available: !!modelish || options.length > 0, opener: opener, options: options.slice(0, 40) };' +
    '})()');
  // закрыть меню
  bsk(['press', 'Escape'], { session: session, allowFail: true, timeout: 30000 });
  return (v && typeof v === 'object') ? v : { available: false, opener: '', options: [] };
}

function chatgptModels(session) {
  const v = evaluate(session,
    '(async () => {' +
    ' const r = await fetch("/backend-api/models", { credentials: "include" });' +
    ' if (!r.ok) return { status: r.status, models: [] };' +
    ' const j = await r.json();' +
    ' const list = Array.isArray(j.models) ? j.models : [];' +
    ' return {' +
    '  status: r.status,' +
    '  models: list.filter(m => /^gpt-6/.test(String(m.slug || ""))).map(m => ({' +
    '   slug: m.slug, title: m.title, max_tokens: m.max_tokens,' +
    '   reasoning_type: m.reasoning_type, tags: m.tags' +
    '  }))' +
    ' };' +
    '})()', { timeout: 60000, allowFail: true });
  return (v && typeof v === 'object') ? v : { status: 0, models: [] };
}

function inferSeparable(recon, models) {
  const options = (recon && recon.options) || [];
  if (options.some(function (o) { return /mini/i.test(o.text); })) return true;
  const hasMiniSlug = (models || []).some(function (m) { return m.slug === 'gpt-6-mini'; });
  // В меню вообще нет управляющего элемента модели => выбрать mini нельзя.
  if (recon && recon.available === false && hasMiniSlug) return false;
  if (!options.length) return null;
  const gpt6 = options.filter(function (o) { return /gpt-?6/i.test(o.text); });
  if (gpt6.length >= 2) return null; // два пункта GPT-6 — нужны testid/описания
  // Один пункт GPT-6, отдельного mini в меню нет => выбрать mini нельзя.
  if (gpt6.length === 1 && hasMiniSlug) return false;
  return null;
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

function buildPlan(opts) {
  const points = lib.planPoints({
    mode: opts.mode,
    target: opts.target,
    point: opts.point
  });
  const chunkTokens = Math.round(opts.chunkChars / opts.charsPerToken);
  return {
    mode: opts.mode,
    target: opts.target,
    tolerance: opts.tolerance,
    budgetTokens: opts.budget,
    chunkChars: opts.chunkChars,
    estimatedChunkTokens: chunkTokens,
    points: points,
    estimatedMessagesPerTrial: points.map(function (p) {
      return Math.ceil(p / Math.max(1, chunkTokens)) + 2;
    }),
    note: 'Точки — в токенах по виджету расширения. Фактический объём измеряется после каждой отправки.'
  };
}

function printPlan(plan) {
  log('Режим: ' + plan.mode);
  log('Цель: ' + plan.target + ' токенов; допуск интервала: ' + Math.round(plan.tolerance * 100) + '%');
  log('Бюджет: ' + plan.budgetTokens + ' токенов (сумма замеров по попыткам)');
  log('Кусок: ' + plan.chunkChars + ' символов (~' + plan.estimatedChunkTokens + ' токенов, оценка только для планирования)');
  log('Стартовые точки: ' + plan.points.join(', '));
  log('Оценка сообщений на попытку: ' + plan.estimatedMessagesPerTrial.join(', '));
  log(plan.note);
}

// ---------------------------------------------------------------------------
// recon
// ---------------------------------------------------------------------------

function cmdRecon(opts) {
  const session = ensureSession(opts);
  const models = chatgptModels(session);
  log('GET /backend-api/models -> ' + models.status);
  for (const m of models.models) {
    log('  ' + m.slug + ' | ' + m.title + ' | max_tokens=' + m.max_tokens + ' | reasoning=' + m.reasoning_type);
  }
  const picker = pickerOptions(session);
  log('picker available: ' + picker.available + '; opener: ' + (picker.opener || '(не найден)'));
  for (const o of picker.options) {
    log('  option: ' + o.text + (o.testid ? ' [' + o.testid + ']' : '') + (o.checked ? ' checked=' + o.checked : ''));
  }
  const served = servedModel(session);
  log('served (последний model-detect в табе): ' + (served.slug || '(n/a)') + ' [' + served.source + ']');
  const recon = {
    ts: new Date().toISOString(),
    session: session,
    models: models,
    picker: picker,
    served: served,
    separable: inferSeparable(picker, models.models),
    note: 'separable=true — в меню есть отдельный пункт mini; false — управляющего элемента модели нет; null — по DOM не доказать, нужен прогон.'
  };
  const out = path.join(opts.out, 'recon-' + stamp() + '.json');
  ensureDir(opts.out);
  fs.writeFileSync(out, JSON.stringify(recon, null, 2), 'utf8');
  log('recon -> ' + out);
  return 0;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

function runTrial(session, point, opts, n) {
  log('');
  log('=== Попытка ' + n + ': цель ~' + point + ' токенов ===');
  newChat(session);
  if (opts.modelOption) selectModelOption(session, opts.modelOption);
  sleep(800);

  const firstId = randHex(8);
  const lastId = randHex(8);
  const charsTarget = Math.min(opts.maxChars, Math.round(point * opts.charsPerToken + opts.chunkChars));
  const filler = lib.buildFiller({
    chars: charsTarget,
    seed: opts.seed + n,
    firstId: firstId,
    lastId: lastId,
    runId: opts.runId + '-t' + n
  });
  const chunks = lib.splitIntoChunks(filler.text, opts.chunkChars);
  if (chunks.length < 2) throw new Error('Наполнитель не разбился на куски: ' + chunks.length);
  const body = chunks.slice(0, chunks.length - 1);
  const tail = chunks[chunks.length - 1];

  let tokens = 0;
  let sent = 0;
  let inputRejected = false;
  let sendFailed = false;
  for (let i = 0; i < body.length; i++) {
    if (tokens >= point) break;
    if (i >= opts.maxMessages) break;
    const r = sendMessage(session, body[i], opts);
    if (!r.sent) {
      inputRejected = !!r.tooLong;
      sendFailed = true;
      log('  стоп на куске ' + (i + 1) + ': ' + (r.reason || 'not-sent'));
      break;
    }
    sent++;
    waitForReply(session, r.assistantBefore, opts.replyTimeout);
    const w = widgetState(session);
    if (w.tokens) tokens = w.tokens;
    log('  кусок ' + (i + 1) + '/' + body.length + ': токены=' + tokens);
  }

  if (!inputRejected && !sendFailed) {
    const r = sendMessage(session, tail, opts);
    if (r.sent) {
      sent++;
      waitForReply(session, r.assistantBefore, opts.replyTimeout);
    } else {
      inputRejected = !!r.tooLong;
      sendFailed = true;
    }
  }

  const saturated = isSaturated(session);
  const w = widgetState(session);
  if (w.tokens) tokens = w.tokens;

  let answer = '';
  let probe = { first: false, last: false, verdict: 'skipped', empty: true };
  if (!saturated && !inputRejected && !sendFailed && tokens > 0) {
    const before = messageCounts(session);
    const r = sendMessage(session, lib.probeMessage(), opts);
    if (r.sent) {
      const st = waitForReply(session, before.assistant, opts.replyTimeout);
      if (st.timeout) {
        probe = { first: false, last: false, verdict: 'timeout', empty: true };
      } else {
        answer = String(st.last || '');
        probe = lib.parseProbeAnswer(answer, firstId, lastId);
      }
    }
  }

  const served = servedModel(session);
  log('  итог: tokens=' + tokens + ' saturation=' + saturated +
    ' probe=' + probe.verdict + ' served=' + (served.slug || '(n/a)') + ' [' + served.source + ']');

  return {
    n: n,
    point: point,
    plannedChars: charsTarget,
    chunks: sent,
    tokens: tokens,
    model: w.model,
    limit: w.limit,
    percent: w.percent,
    saturation: saturated,
    inputRejected: inputRejected,
    sendFailed: sendFailed,
    probe: probe,
    probeAnswer: answer.slice(-1500),
    firstId: firstId,
    lastId: lastId,
    served: served
  };
}

function selectModelOption(session, label) {
  const v = evaluate(session,
    '(async () => {' +
    ' const btns = [...document.querySelectorAll("button")];' +
    ' const b = btns.find(x => /^(chatgpt|gpt|выбрать модель|select model|модель)/i.test(String(x.innerText || "").trim()));' +
    ' if (!b) return { ok: false, reason: "no-model-button" };' +
    ' b.click();' +
    ' await new Promise(r => setTimeout(r, 700));' +
    ' const want = ' + JSON.stringify(String(label).toLowerCase()) + ';' +
    ' const nodes = [...document.querySelectorAll(\'[role="menuitemradio"],[role="menuitem"],[data-testid*="model"]\')];' +
    ' const hit = nodes.find(n => String(n.innerText || "").toLowerCase().indexOf(want) !== -1);' +
    ' if (!hit) return { ok: false, reason: "option-not-found", seen: nodes.map(n => String(n.innerText || "").trim()).slice(0, 20) };' +
    ' hit.click();' +
    ' await new Promise(r => setTimeout(r, 500));' +
    ' return { ok: true, picked: String(hit.innerText || "").replace(/\\s+/g, " ").trim() };' +
    '})()', { allowFail: true });
  if (v && v.ok) log('  модель выбрана: ' + v.picked);
  else log('  модель не выбрана: ' + JSON.stringify(v).slice(0, 300));
  return v;
}

function warnIfWrongModel(trial, opts) {
  const served = trial.served || {};
  if (!served.slug) {
    log('  ВНИМАНИЕ: slug обслужившей модели не получен; проверьте вручную, что это gpt-6-mini.');
    return;
  }
  if (served.slug !== 'gpt-6-mini') {
    log('  ВНИМАНИЕ: чат обслужил ' + served.slug +
      ', а не gpt-6-mini. Замер относится не к mini.');
    if (!opts.modelOption) {
      log('  Укажите --model-option "<пункт меню>" или выберите mini вручную перед прогоном.');
    }
  }
}

function cmdRun(opts) {
  const plan = buildPlan(opts);
  if (opts.dryRun) {
    printPlan(plan);
    log('');
    log('dry-run: браузер не трогаем. Для запуска добавьте --confirm.');
    const sample = lib.buildFiller({ chars: 1200, seed: 1, firstId: 'aaaaaaaa', lastId: 'bbbbbbbb', runId: 'dry' });
    log('Пример начала: ' + sample.text.slice(0, 160));
    log('Пример конца:  ' + sample.text.slice(-160));
    return 0;
  }
  if (!opts.confirm) {
    printPlan(plan);
    log('');
    log('Остановлено: живые попытки тратят токены аккаунта.');
    log('Повторите с --confirm, когда бюджет и время согласованы.');
    return 2;
  }

  const session = ensureSession(opts);
  const widget = readSelector(session, WIDGET_TOOLTIP);
  if (!widget) {
    throw new Error('Виджет расширения не найден (' + WIDGET_TOOLTIP + '). Загружен ли dist/ и открыт ли chatgpt.com?');
  }

  const reconFile = opts.recon ? path.resolve(opts.recon) : '';
  let recon = reconFile ? (readJsonFile(reconFile) || {}) : {};
  if (!reconFile) {
    const models = chatgptModels(session);
    const picker = pickerOptions(session);
    recon = { models: models, picker: picker, separable: inferSeparable(picker, models.models) };
  }
  log('recon: separable=' + String(recon.separable));
  if (recon.separable === false && !opts.force) {
    log('');
    log('Остановлено до трат: recon говорит, что отдельного выбора gpt-6-mini в UI нет.');
    log('Это и есть ответ «не разделимо» — окно mini мерить не на чем.');
    log('Если хотите всё равно прогнать (проверить, какой slug обслуживает чат), добавьте --force.');
    return 3;
  }

  let state = lib.createState({ low: opts.low, high: opts.high });
  let spent = 0;
  let n = 0;
  const queue = plan.points.slice();
  const trials = [];

  while (true) {
    let point = queue.shift();
    if (point === undefined) {
      if (opts.mode !== 'bracket') break;
      point = lib.nextPoint(state, opts.tolerance);
    }
    if (!point) break;
    if (n >= opts.maxTrials) break;
    if (spent >= opts.budget) {
      log('Бюджет исчерпан: ' + spent + ' >= ' + opts.budget);
      break;
    }
    if (point > opts.budget - spent) {
      log('Точка ' + point + ' не влезает в остаток бюджета ' + (opts.budget - spent) +
        '. Увеличьте --budget (минимум ' + (point + spent) + ').');
      break;
    }
    n++;
    const trial = runTrial(session, point, opts, n);
    spent += trial.tokens || 0;
    const cls = lib.classifyTrial(trial);
    trial.kind = cls.kind;
    trial.relation = cls.relation;
    trials.push(trial);
    state = lib.applyTrial(state, trial);
    if (n === 1) warnIfWrongModel(trial, opts);
    log('  интервал: [' + state.low + ', ' + (Number.isFinite(state.high) ? state.high : '?') + ']  (' + cls.kind + ')');
    writeRunReport(opts, state, trials, recon, false);
    if (opts.mode !== 'bracket') break;
    if (cls.relation === 'ge' && trial.tokens >= opts.target) break;
    if (lib.bracketDone(state, opts.tolerance)) break;
  }

  const decision = lib.decide(state, recon);
  const file = writeRunReport(opts, state, trials, recon, true, decision);
  log('');
  log('Решение: ' + decision.code);
  if (decision.interval) {
    log('Интервал: [' + decision.interval[0] + ', ' + (decision.interval[1] === null ? '?' : decision.interval[1]) + ']');
  }
  if (decision.suggestedContextLimit) log('Консервативное окно: ' + decision.suggestedContextLimit);
  log(decision.note);
  log('Отчёт: ' + file);
  return 0;
}

function hashFile(file) {
  try {
    const buf = fs.readFileSync(file);
    return { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
  } catch (e) {
    return null;
  }
}

function writeRunReport(opts, state, trials, recon, final, decision) {
  ensureDir(opts.out);
  const base = path.join(opts.out, 'run-' + opts.runId);
  const payload = {
    runId: opts.runId,
    ts: new Date().toISOString(),
    final: !!final,
    mode: opts.mode,
    target: opts.target,
    tolerance: opts.tolerance,
    budgetTokens: opts.budget,
    spentTokens: trials.reduce(function (s, t) { return s + (t.tokens || 0); }, 0),
    build: hashFile(path.join(ROOT, 'dist', 'content.js')),
    recon: recon,
    trials: trials,
    interval: {
      low: state.low,
      high: Number.isFinite(state.high) ? state.high : null
    },
    decision: decision || null
  };
  fs.writeFileSync(base + '.json', JSON.stringify(payload, null, 2), 'utf8');

  const md = [];
  md.push('# Живой лимит-тест: ' + opts.runId);
  md.push('');
  md.push('- Режим: `' + opts.mode + '`, цель: ' + opts.target + ' токенов, допуск: ' + Math.round(opts.tolerance * 100) + '%');
  md.push('- Потрачено (сумма замеров): ' + payload.spentTokens + ' токенов');
  if (payload.build) md.push('- `dist/content.js`: ' + payload.build.bytes + ' B, sha256 `' + payload.build.sha256 + '`');
  md.push('- Recon: separable=`' + String(recon && recon.separable) + '`');
  md.push('');
  md.push('| # | Цель | Измерено | Slug | Метки | Вердикт |');
  md.push('|---|---|---|---|---|---|');
  for (const t of trials) {
    const slugs = (t.served && t.served.slug) || '-';
    md.push('| ' + t.n + ' | ' + t.point + ' | ' + t.tokens + ' | ' + slugs + ' | ' +
      (t.probe && t.probe.verdict) + ' | ' + t.kind + ' (' + t.relation + ') |');
  }
  md.push('');
  md.push('Интервал: [' + state.low + ', ' + (Number.isFinite(state.high) ? state.high : '?') + ']');
  if (decision) {
    md.push('');
    md.push('Решение: **' + decision.code + '**');
    if (decision.suggestedContextLimit) md.push('Консервативное окно: ' + decision.suggestedContextLimit);
    md.push(decision.note);
  }
  fs.writeFileSync(base + '.md', md.join('\n') + '\n', 'utf8');
  return base + '.md';
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function normalizeOpts(args) {
  return {
    session: args.session && args.session !== true ? String(args.session) : '',
    scope: args.scope && args.scope !== true ? String(args.scope) : 'gpt-mini-limit',
    out: args.out && args.out !== true ? path.resolve(String(args.out)) : DEFAULT_OUT,
    runId: args['run-id'] && args['run-id'] !== true ? String(args['run-id']) : stamp(),
    mode: args.mode && args.mode !== true ? String(args.mode) : 'confirm',
    target: num(args.target, 1050000),
    point: num(args.point, 32000),
    tolerance: num(args.tolerance, 0.1),
    budget: num(args.budget, 150000),
    chunkChars: num(args['chunk-chars'], 60000),
    charsPerToken: num(args['chars-per-token'], 4.2),
    maxChars: num(args['max-chars'], 6000000),
    maxMessages: num(args['max-messages'], 400),
    maxTrials: num(args['max-trials'], 6),
    replyTimeout: num(args['reply-timeout'], 240000),
    seed: num(args.seed, 20261124),
    low: num(args.low, 0),
    high: args.high === undefined ? Infinity : num(args.high, Infinity),
    modelOption: args['model-option'] && args['model-option'] !== true ? String(args['model-option']) : '',
    recon: args.recon && args.recon !== true ? String(args.recon) : '',
    confirm: args.confirm === true,
    force: args.force === true,
    dryRun: args['dry-run'] === true
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';
  const opts = normalizeOpts(args);

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    log('Команды: plan | recon | run');
    log('  plan  [--mode quick|confirm|bracket] [--target N]');
    log('  recon [--session S] [--scope gpt-mini-limit] [--out DIR]');
    log('  run   --mode ... [--confirm] [--dry-run] [--budget N] [--chunk-chars N]');
    log('Подробности: acceptance/BIG-2026-11/2.2/LIVE-LIMIT-TEST-PLAN.md');
    return 0;
  }
  if (cmd === 'plan') {
    printPlan(buildPlan(opts));
    return 0;
  }
  if (cmd === 'recon') {
    return cmdRecon(opts);
  }
  if (cmd === 'run') {
    return cmdRun(opts);
  }
  log('Неизвестная команда: ' + cmd);
  return 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (e) {
    log('ОШИБКА: ' + (e && e.message ? e.message : String(e)));
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs: parseArgs,
  parseSessionId: parseSessionId,
  buildPlan: buildPlan,
  normalizeOpts: normalizeOpts,
  inferSeparable: inferSeparable
};
