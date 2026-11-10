/**
 * §8: КОНТРАКТ СЕТЕВОГО PAYLOAD CLAUDE НА РЕАЛЬНОМ ОТВЕТЕ GET /chat_conversations.
 *
 * Источник истины — tools/claude-network-dump.json: реальный ответ
 * `GET /api/organizations/{org}/chat_conversations/{id}?tree=True&rendering_mode=messages…`,
 * снятый перехватом BSK debug на claude.ai (Free, claude-haiku-5-5, диалог из 4 реплик).
 * В конверте лежит проводной JSON без правок (organization/conversation UUID не являются
 * персональными данными), поэтому тест проверяет РОВНО ту форму, которую читает
 * core/claude-intercept.js:parseHistory (tests/helpers/parse-claude-conversation.js — его
 * извлечённая копия).
 *
 * ГЛАВНЫЙ ФАКТ ПРОВОДА: поле `chat_messages[i].text` приходит ПУСТОЙ строкой, а текст реплики
 * лежит в блоках `content[]` с `type: "text"`. Парсер обязан читать блоки: пин C4 держит
 * именно это, иначе на живом ответе получились бы пустые сообщения при непустом JSON.
 *
 * Роли на проводе — `human`/`assistant` (не `user`): нормализация в `user` происходит выше,
 * в core/content.ts, поэтому контракт фиксирует проводные значения, а не UI-представление.
 */

const fs = require('fs');
const path = require('path');
const { loadFixture, REPO_ROOT } = require('../helpers/contract-fixture-loader');
const { parseClaudeConversation } = require('../helpers/parse-claude-conversation');

jest.setTimeout(5000);

const DUMP = 'tools/claude-network-dump.json';
const WIRE_ROLES = ['human', 'assistant'];

// Артефакт обязателен: без него инварианты проводного формата стали бы вакуумными.
// В CI каталог tools/ gitignored, но оба дампа §8 внесены в исключения .gitignore
// (`!tools/*-network-dump.json`), поэтому файл обязан быть и в CI; отсутствие — повод
// объявить skip с предупреждением, а не молча подсунуть синтетику.
const dumpExists = fs.existsSync(path.join(REPO_ROOT, DUMP));
const synthForced = String(process.env.AI_CM_CONTRACT_SYNTH || '') === '1';
const suiteSkipped = !dumpExists || synthForced;
if (suiteSkipped) {
  console.warn('[§8] claude-network: ' + (synthForced
    ? 'AI_CM_CONTRACT_SYNTH=1 — принудительный синтез, контракт требует реального payload'
    : 'дамп отсутствует (реальный payload коммитится в tools/)') + ' — ' + DUMP);
}
const ctest = suiteSkipped ? test.skip : test;

/**
 * Ленивая загрузка дампа: JSON разбирается лоадером, битый JSON падает явно.
 * @returns {{text: string, json: object, bytes: number, fromLiveRun: boolean, sha1: string}}
 */
function readDump() {
  return loadFixture(DUMP, function () {
    return { source: 'live-network', body: { chat_messages: [] } };
  }, { parseJson: true, forceSynthetic: synthForced });
}

/** Тело проводного ответа внутри конверта. */
function wireBody(dump) {
  return dump.json && dump.json.body;
}

describe('§8: Claude — контракт сетевого payload GET /chat_conversations', function () {
  ctest('C1: артефакт живой, а не синтетика (fromLiveRun, sha1, размер)', function () {
    const dump = readDump();
    expect(dump.existed).toBe(true);
    expect(dump.fromLiveRun).toBe(true);
    expect(dump.synthetic).toBe(false);
    expect(dump.bytes).toBeGreaterThan(1000);
    expect(dump.sha1).toMatch(/^[0-9a-f]{40}$/);
    // json-ветка лоадера разбирает файл как JSON: битый дамп сюда не пройдёт
    expect(dump.json).toBeTruthy();
  });

  ctest('C2: конверт фиксирует происхождение ответа (метод, адрес, статус)', function () {
    const dump = readDump();
    const env = dump.json;
    expect(env.source).toBe('live-network');
    expect(env.method).toBe('GET');
    expect(env.status).toBe(200);
    expect(env.url).toContain('/chat_conversations/');
    expect(env.url).toContain('rendering_mode=messages');
    expect(typeof env.note).toBe('string');
    expect(env.note.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(env.captured_at))).toBe(false);
  });

  ctest('C3: проводной формат — chat_messages с проводными ролями и блоками content[]', function () {
    const body = wireBody(readDump());
    expect(Array.isArray(body.chat_messages)).toBe(true);
    expect(body.chat_messages.length).toBeGreaterThan(0);

    const ids = [];
    body.chat_messages.forEach(function (msg) {
      expect(WIRE_ROLES).toContain(msg.sender);
      expect(Array.isArray(msg.content)).toBe(true);
      expect(msg.content.length).toBeGreaterThan(0);
      const block = msg.content[0];
      expect(block.type).toBe('text');
      expect(typeof block.text).toBe('string');
      expect(block.text.trim().length).toBeGreaterThan(0);
      expect(typeof msg.uuid).toBe('string');
      expect(msg.uuid.length).toBeGreaterThan(0);
      ids.push(msg.uuid);
    });

    // uuid — идентификатор реплики: дубли сломали бы индексацию uuidIdx в перехватчике
    expect(new Set(ids).size).toBe(ids.length);
    expect(typeof body.model).toBe('string');
    expect(body.model.length).toBeGreaterThan(0);
  });

  ctest('C4: `chat_messages[i].text` пуст на проводе — текст обязан браться из content[]', function () {
    const body = wireBody(readDump());
    expect(body.chat_messages.length).toBeGreaterThan(0);
    body.chat_messages.forEach(function (msg) {
      // провод не заполняет msg.text; если это изменится, парсер получит дубль текста
      expect(msg.text).toBe('');
      const blockText = msg.content
        .filter(function (b) { return b && b.type === 'text'; })
        .map(function (b) { return String(b.text || ''); })
        .join('\n');
      expect(blockText.trim().length).toBeGreaterThan(0);
    });
  });

  ctest('C5: parseHistory-копия извлекает все реплики: роли, тексты, модель', function () {
    const body = wireBody(readDump());
    const hist = parseClaudeConversation(body);

    // невакуумность: ни одна непустая реплика провода не потеряна
    expect(hist.messages.length).toBe(body.chat_messages.length);
    expect(hist.messages.length).toBeGreaterThan(0);

    const roles = hist.messages.map(function (m) { return m.role; });
    roles.forEach(function (r) { expect(WIRE_ROLES).toContain(r); });
    expect(roles.filter(function (r) { return r === 'human'; }).length).toBeGreaterThan(0);
    expect(roles.filter(function (r) { return r === 'assistant'; }).length).toBeGreaterThan(0);

    hist.messages.forEach(function (m) {
      expect(String(m.text).trim().length).toBeGreaterThan(0);
      expect(String(m.text).length).toBe(String(m.text).trim().length);
      // служебные обёртки ответа не должны утекать в текст реплики
      expect(String(m.text)).not.toContain('chat_messages');
    });

    expect(hist.model).toBe(body.model);
    expect(hist.model.length).toBeGreaterThan(0);
    // контрольная реплика живого диалога: assistant ответил одним словом contract
    const assistantText = hist.messages
      .filter(function (m) { return m.role === 'assistant'; })
      .map(function (m) { return String(m.text); })
      .join(' ');
    expect(assistantText.toLowerCase()).toContain('contract');
  });

  ctest('C6: в дампе нет персональных данных, а парсер — не заглушка', function () {
    const dump = readDump();
    const raw = JSON.stringify(wireBody(dump));
    // персональные поля аккаунта, токены и адреса не должны попадать в контрактную фикстуру
    expect(raw).not.toMatch(/author_username|author_name|read_write_token|googleusercontent\.com/);
    expect(raw).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    // невакуумность: дамп несёт именно диалог, а разбор даёт ровно столько же реплик
    expect(raw).toContain('chat_messages');
    const body = wireBody(dump);
    expect(parseClaudeConversation(body).messages.length).toBe(body.chat_messages.length);
  });
});
