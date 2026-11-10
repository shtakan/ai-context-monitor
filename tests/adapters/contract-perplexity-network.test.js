/**
 * §8: КОНТРАКТ СЕТЕВОГО PAYLOAD PERPLEXITY НА РЕАЛЬНОМ ОТВЕТЕ GET /rest/thread/{slug}.
 *
 * Источник истины — tools/perplexity-network-dump.json: реальный ответ
 * `GET /rest/thread/{slug}?with_parent_info=true&supported_block_use_cases=true`,
 * снятый перехватом BSK debug на perplexity.ai (Free, модель turbo). Конверт режется:
 * author_*, avatar, read_write_token и веб-источники удалены как персональные/неконтрактные,
 * а форма `entries[]` оставлена как на проводе.
 *
 * ГЛАВНЫЙ ФАКТ ПРОВОДА: в живом REST-ответе нет `blocks` (их отдаёт только DOM/внутренний
 * формат), поэтому ответ ассистента лежит в `entries[i].text` — JSON-строке массива шагов,
 * где FINAL.content.answer — ЕЩЁ ОДНА JSON-строка с полем answer. Парсер
 * utils/perplexity-parser.ts обязан пройти эту двойную вложенность (пин P4), иначе на живом
 * ответе получится пустая реплика ассистента.
 */

const fs = require('fs');
const path = require('path');
const { loadFixture, REPO_ROOT } = require('../helpers/contract-fixture-loader');
const { loadEsmModule } = require('../helpers/load-esm.js');
const { parsePerplexityThread } = loadEsmModule('utils/perplexity-parser.ts');

jest.setTimeout(5000);

const DUMP = 'tools/perplexity-network-dump.json';

// Артефакт обязателен: без него инварианты проводного формата стали бы вакуумными.
// Оба дампа §8 внесены в исключения .gitignore (`!tools/*-network-dump.json`), поэтому
// файл обязан быть и в CI; отсутствие — skip с предупреждением, а не синтетика молча.
const dumpExists = fs.existsSync(path.join(REPO_ROOT, DUMP));
const synthForced = String(process.env.AI_CM_CONTRACT_SYNTH || '') === '1';
const suiteSkipped = !dumpExists || synthForced;
if (suiteSkipped) {
  console.warn('[§8] perplexity-network: ' + (synthForced
    ? 'AI_CM_CONTRACT_SYNTH=1 — принудительный синтез, контракт требует реального payload'
    : 'дамп отсутствует (реальный payload коммитится в tools/)') + ' — ' + DUMP);
}
const ptest = suiteSkipped ? test.skip : test;

/**
 * Ленивая загрузка дампа: JSON разбирается лоадером, битый JSON падает явно.
 * @returns {{text: string, json: object, bytes: number, fromLiveRun: boolean, sha1: string}}
 */
function readDump() {
  return loadFixture(DUMP, function () {
    return { source: 'live-network', body: { status: 'success', entries: [] } };
  }, { parseJson: true, forceSynthetic: synthForced });
}

/** Тело проводного ответа внутри конверта. */
function wireBody(dump) {
  return dump.json && dump.json.body;
}

/** Единственная запись диалога из реального ответа. */
function firstEntry(body) {
  return body.entries[0];
}

describe('§8: Perplexity — контракт сетевого payload GET /rest/thread/{slug}', function () {
  ptest('P1: артефакт живой, а не синтетика (fromLiveRun, sha1, размер)', function () {
    const dump = readDump();
    expect(dump.existed).toBe(true);
    expect(dump.fromLiveRun).toBe(true);
    expect(dump.synthetic).toBe(false);
    expect(dump.bytes).toBeGreaterThan(500);
    expect(dump.sha1).toMatch(/^[0-9a-f]{40}$/);
    expect(dump.json).toBeTruthy();
  });

  ptest('P2: конверт фиксирует происхождение ответа (метод, адрес, статус)', function () {
    const env = readDump().json;
    expect(env.source).toBe('live-network');
    expect(env.method).toBe('GET');
    expect(env.status).toBe(200);
    expect(env.url).toContain('/rest/thread/');
    expect(env.url).toContain('with_parent_info=true');
    expect(typeof env.note).toBe('string');
    expect(env.note.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(env.captured_at))).toBe(false);
  });

  ptest('P3: проводной формат — entries[] с query_str, slug и status success', function () {
    const body = wireBody(readDump());
    expect(body.status).toBe('success');
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeGreaterThan(0);

    body.entries.forEach(function (entry) {
      expect(typeof entry.uuid).toBe('string');
      expect(entry.uuid.length).toBeGreaterThan(0);
      expect(typeof entry.query_str).toBe('string');
      expect(entry.query_str.trim().length).toBeGreaterThan(0);
      expect(typeof entry.thread_url_slug).toBe('string');
      expect(entry.thread_url_slug).toMatch(/^[0-9a-f-]{36}$/);
      expect(typeof entry.display_model).toBe('string');
      expect(entry.display_model.length).toBeGreaterThan(0);
      expect(entry.step_type).toBe('FINAL');
      expect(entry.status).toBe('completed');
      // в живом REST-ответе нет blocks: иначе парсер пошёл бы другим путём
      expect(entry.blocks).toBeUndefined();
    });
  });

  ptest('P4: entry.text — двойной JSON (шаги → FINAL → answer), ответ читается', function () {
    const entry = firstEntry(wireBody(readDump()));
    expect(typeof entry.text).toBe('string');

    const steps = JSON.parse(entry.text);
    expect(Array.isArray(steps)).toBe(true);

    const initial = steps.filter(function (s) { return s && s.step_type === 'INITIAL_QUERY'; });
    expect(initial.length).toBe(1);
    expect(initial[0].content.query).toBe(entry.query_str);

    const finals = steps.filter(function (s) { return s && s.step_type === 'FINAL'; });
    expect(finals.length).toBe(1);
    const answerRaw = finals[0].content.answer;
    expect(typeof answerRaw).toBe('string');

    const answerObj = JSON.parse(answerRaw);
    expect(typeof answerObj.answer).toBe('string');
    expect(answerObj.answer.trim().length).toBeGreaterThan(0);
    expect(answerObj.answer.toLowerCase()).toContain('contract');
    expect(Array.isArray(answerObj.chunks)).toBe(true);
    expect(answerObj.chunks.length).toBeGreaterThan(0);
  });

  ptest('P5: parsePerplexityThread извлекает пару user/assistant с ролями и id', function () {
    const body = wireBody(readDump());
    const result = parsePerplexityThread(body);

    // одна запись = одна пара реплик; ни одна не потеряна и не задвоена
    expect(result.messages.length).toBe(body.entries.length * 2);
    const roles = result.messages.map(function (m) { return m.role; });
    expect(roles).toEqual(['user', 'assistant']);
    expect(result.ids.length).toBe(result.messages.length);

    const slug = firstEntry(body).thread_url_slug;
    expect(result.ids).toEqual([slug + '_user', slug + '_assistant']);

    result.messages.forEach(function (m) {
      expect(typeof m.text).toBe('string');
      expect(m.text.length).toBeGreaterThan(0);
      expect(m.text.length).toBe(m.text.trim().length);
    });

    expect(result.count).toBe(result.messages.length);
    expect(result.pieces.length).toBeGreaterThan(0);
    expect(result.model).toBe('turbo');
    expect(result.lastText.toLowerCase()).toContain('contract');
  });

  ptest('P6: в дампе нет персональных данных, а парсер — не заглушка', function () {
    const dump = readDump();
    const raw = JSON.stringify(wireBody(dump));
    // персональные поля аккаунта и токены не должны попадать в контрактную фикстуру
    expect(raw).not.toMatch(/author_username|author_name|read_write_token|googleusercontent\.com/);
    expect(raw).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);

    // невакуумность: разбор реального тела даёт непустой текст, содержащий ответ
    const result = parsePerplexityThread(wireBody(dump));
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text.toLowerCase()).toContain('contract');
  });
});
