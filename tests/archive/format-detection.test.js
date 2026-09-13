/**
 * T1 (v1.16): первый ярус — определение формата архива, ключи хранилища и ярлыки
 * источника (utils/archive-import.js).
 *
 * Проверяется контракт импорта:
 *   - detectArchiveFormat распознаёт все 4 поддерживаемых экспорта и НЕ угадывает
 *     неизвестный вход (null, а не «первый попавшийся» формат);
 *   - ключи chrome.storage.local: aiCmArchive:<convId>, aiCmConvSource:<convId>;
 *   - нормализация ролей/текста и детерминированный id (идемпотентность импорта);
 *   - ярлыки источника для попапа/виджета (архив vs live).
 */

const path = require('path');
const fs = require('fs');
const AI = require('../../utils/archive-import.js');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'archive');
function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

describe('T1: определение формата архива', () => {
  test('Gemini Takeout (MyActivity.json) → gemini-takeout', () => {
    expect(AI.detectArchiveFormat(loadFixture('gemini-takeout.json'))).toBe(AI.FORMATS.GEMINI_TAKEOUT);
  });

  test('ChatGPT conversations.json (mapping) → chatgpt-conversations', () => {
    expect(AI.detectArchiveFormat(loadFixture('chatgpt-conversations.json'))).toBe(AI.FORMATS.CHATGPT_CONVERSATIONS);
  });

  test('Claude conversations.json (chat_messages) → claude-conversations', () => {
    expect(AI.detectArchiveFormat(loadFixture('claude-conversations.json'))).toBe(AI.FORMATS.CLAUDE_CONVERSATIONS);
  });

  test('Perplexity threads (entries) → perplexity-threads', () => {
    expect(AI.detectArchiveFormat(loadFixture('perplexity-threads.json'))).toBe(AI.FORMATS.PERPLEXITY_THREADS);
  });

  test('одиночный объект (не массив) распознаётся так же', () => {
    const claude = loadFixture('claude-conversations.json')[0];
    expect(AI.detectArchiveFormat(claude)).toBe(AI.FORMATS.CLAUDE_CONVERSATIONS);
    const gpt = loadFixture('chatgpt-conversations.json')[0];
    expect(AI.detectArchiveFormat(gpt)).toBe(AI.FORMATS.CHATGPT_CONVERSATIONS);
  });

  test('обёртка {conversations:[...]} распознаётся', () => {
    const gpt = loadFixture('chatgpt-conversations.json');
    expect(AI.detectArchiveFormat({ conversations: gpt })).toBe(AI.FORMATS.CHATGPT_CONVERSATIONS);
  });

  test('неизвестный формат → null (архив НЕ угадывается)', () => {
    expect(AI.detectArchiveFormat([])).toBeNull();
    expect(AI.detectArchiveFormat(null)).toBeNull();
    expect(AI.detectArchiveFormat({ foo: 'bar' })).toBeNull();
    expect(AI.detectArchiveFormat([{ foo: 1 }, { bar: 2 }])).toBeNull();
    expect(AI.detectArchiveFormat('[1,2,3]')).toBeNull();
    expect(AI.detectArchiveFormat([{ titleUrl: 'https://example.com/app/x' }])).toBeNull();
  });

  test('serviceOfFormat: формат → сервис', () => {
    expect(AI.serviceOfFormat(AI.FORMATS.GEMINI_TAKEOUT)).toBe('gemini');
    expect(AI.serviceOfFormat(AI.FORMATS.CHATGPT_CONVERSATIONS)).toBe('chatgpt');
    expect(AI.serviceOfFormat(AI.FORMATS.CLAUDE_CONVERSATIONS)).toBe('claude');
    expect(AI.serviceOfFormat(AI.FORMATS.PERPLEXITY_THREADS)).toBe('perplexity');
    expect(AI.serviceOfFormat('nope')).toBe('');
  });
});

// =====================================================================================
// LOW-3 (аудит перед релизом): цикл «пол > msgs» — агрегат `full` не может быть
// длиннее суммы отдельных ходов `messages`. Расхождение — аномалия: она обязана
// логироваться предупреждением, а импорт — отрабатывать КОРРЕКТНО (не падать,
// источник правды остаётся messages).
// =====================================================================================
describe('LOW-3: цикл «пол > msgs» (full длиннее messages)', () => {
  const ANOMALY_FIXTURE = 'full-longer-than-messages.json';

  test('фикстура распознаётся как архив Claude (аномалия не ломает детекцию)', () => {
    expect(AI.detectArchiveFormat(loadFixture(ANOMALY_FIXTURE))).toBe(AI.FORMATS.CLAUDE_CONVERSATIONS);
  });

  test('аномальный диалог детектируется: full.length > sum(messages.text.length), поля честные', () => {
    const conv = loadFixture(ANOMALY_FIXTURE)[0];
    const a = AI.detectFullTextAnomaly(conv);
    expect(a).not.toBeNull();
    expect(a.code).toBe('full-longer-than-messages');
    expect(a.convId).toBe('aa11bb22-cc33-4d44-8e55-ff6677889900');
    expect(a.fullLen).toBe(conv.full.length);
    expect(a.fullLen).toBeGreaterThan(a.msgsLen);
    expect(a.over).toBe(a.fullLen - a.msgsLen);
    expect(a.msgCount).toBe(conv.chat_messages.length);
  });

  test('нормальный диалог (full == сумма ходов) аномалией НЕ считается', () => {
    const conv = loadFixture(ANOMALY_FIXTURE)[1];
    expect(AI.detectFullTextAnomaly(conv)).toBeNull();
  });

  test('нет поля full / не-строка / пустой full → аномалии нет (тихий no-op)', () => {
    expect(AI.detectFullTextAnomaly({ messages: [{ role: 'user', text: 'x' }] })).toBeNull();
    expect(AI.detectFullTextAnomaly({ full: 42, messages: [{ role: 'user', text: 'x' }] })).toBeNull();
    expect(AI.detectFullTextAnomaly({ full: '   ', messages: [{ role: 'user', text: 'x' }] })).toBeNull();
    expect(AI.detectFullTextAnomaly(null)).toBeNull();
  });

  test('collectFullTextAnomalies: в фикстуре ровно один аномальный диалог', () => {
    const list = AI.collectFullTextAnomalies(loadFixture(ANOMALY_FIXTURE));
    expect(list).toHaveLength(1);
    expect(list[0].convId).toBe('aa11bb22-cc33-4d44-8e55-ff6677889900');
  });

  test('reportFullTextAnomalies: пишет предупреждение (инъекция warn) и возвращает аномалии', () => {
    const logs = [];
    const anomalies = AI.reportFullTextAnomalies(loadFixture(ANOMALY_FIXTURE), {
      warn: function (m) { logs.push(m); }
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('аномалия full>messages');
    expect(logs[0]).toContain('convId=aa11bb22-cc33-4d44-8e55-ff6677889900');
    expect(anomalies).toHaveLength(1);
  });

  test('parseArchive: аномалия логируется, но импорт отрабатывает КОРРЕКТНО (messages — источник правды)', () => {
    const logs = [];
    const parsed = AI.parseArchive(loadFixture(ANOMALY_FIXTURE), { warn: function (m) { logs.push(m); } });
    expect(parsed.ok).toBe(true);
    expect(parsed.format).toBe(AI.FORMATS.CLAUDE_CONVERSATIONS);
    expect(parsed.conversations).toHaveLength(2);
    // источник правды — messages; system-ход в архив не попадает
    expect(parsed.conversations[0].count).toBe(2);
    expect(parsed.conversations[0].messages.map(function (m) { return m.role; })).toEqual(['user', 'assistant']);
    expect(logs).toHaveLength(1);
  });

  test('parseArchive БЕЗ аномалий не пишет в warn (нет ложных срабатываний)', () => {
    const logs = [];
    const parsed = AI.parseArchive(loadFixture('claude-conversations.json'), { warn: function (m) { logs.push(m); } });
    expect(parsed.ok).toBe(true);
    expect(logs).toEqual([]);
  });
});

describe('T1: ключи chrome.storage.local', () => {
  test('aiCmArchive:<convId> и aiCmConvSource:<convId>', () => {
    expect(AI.archiveStorageKey('abc123')).toBe('aiCmArchive:abc123');
    expect(AI.convSourceStorageKey('abc123')).toBe('aiCmConvSource:abc123');
    expect(AI.ARCHIVE_KEY_PREFIX).toBe('aiCmArchive:');
    expect(AI.CONV_SOURCE_KEY_PREFIX).toBe('aiCmConvSource:');
  });

  test('пустой convId не превращается в «undefined»-ключ', () => {
    expect(AI.archiveStorageKey()).toBe('aiCmArchive:');
    expect(AI.convSourceStorageKey(null)).toBe('aiCmConvSource:');
  });

  test('convId берётся из titleUrl Gemini (/app/<id>)', () => {
    expect(AI.extractConvIdFromUrl('https://gemini.google.com/app/7c1f4a9b2e8d3a05')).toBe('7c1f4a9b2e8d3a05');
    expect(AI.extractConvIdFromUrl('https://gemini.google.com/app/')).toBe('');
    expect(AI.extractConvIdFromUrl('')).toBe('');
  });
});

describe('T1: роли, текст и детерминированный id', () => {
  test('normalizeRole: user-семейство и assistant-семейство', () => {
    ['user', 'human', 'me', 'prompt', 'YOU'].forEach((r) => expect(AI.normalizeRole(r)).toBe('user'));
    ['assistant', 'model', 'bot', 'ai', 'Gemini', 'claude'].forEach((r) => expect(AI.normalizeRole(r)).toBe('assistant'));
  });

  test('normalizeRole: system/tool и мусор → пусто (ход не попадает в архив)', () => {
    ['system', 'tool', '', null, undefined, 'narrator'].forEach((r) => expect(AI.normalizeRole(r)).toBe(''));
  });

  test('normalizeMessage: пустой текст/неизвестная роль → null', () => {
    expect(AI.normalizeMessage({ role: 'user', text: '   ' }, 0)).toBeNull();
    expect(AI.normalizeMessage({ role: 'system', text: 'x' }, 0)).toBeNull();
    expect(AI.normalizeMessage(null, 0)).toBeNull();
  });

  test('normalizeMessage: id детерминирован (повторный импорт даёт те же id)', () => {
    const a = AI.normalizeMessage({ role: 'user', text: 'Привет' }, 3);
    const b = AI.normalizeMessage({ role: 'user', text: 'Привет' }, 3);
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^a:3:[0-9a-f]{6}$/);
    // разные позиции/тексты → разные id
    expect(AI.normalizeMessage({ role: 'user', text: 'Привет' }, 4).id).not.toBe(a.id);
    expect(AI.normalizeMessage({ role: 'user', text: 'Пока' }, 3).id).not.toBe(a.id);
  });

  test('normalizeMessage: ts из ISO-строки и из секунд', () => {
    expect(AI.normalizeMessage({ role: 'user', text: 'x', time: '2024-07-10T08:12:31.000Z' }, 0).ts)
      .toBe(Date.parse('2024-07-10T08:12:31.000Z'));
    expect(AI.normalizeMessage({ role: 'user', text: 'x', created_at: 1717400010 }, 0).ts).toBe(1717400010000);
  });
});

describe('T1: ярлык источника (попап/виджет)', () => {
  test('buildArchiveRecord + buildConvSourceRecord → kind=archive, ярлык формата', () => {
    const rec = AI.buildArchiveRecord({
      convId: 'c1',
      service: 'gemini',
      format: AI.FORMATS.GEMINI_TAKEOUT,
      title: 't',
      messages: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }]
    }, { fileName: 'MyActivity.json', importedAt: 111 });
    expect(rec.v).toBe(AI.ARCHIVE_RECORD_VERSION);
    expect(rec.count).toBe(2);
    expect(rec.textLen).toBe(2);
    expect(rec.importedAt).toBe(111);
    expect(rec.fileName).toBe('MyActivity.json');

    const src = AI.buildConvSourceRecord(rec, { fileName: 'MyActivity.json' });
    expect(src.kind).toBe('archive');
    expect(src.count).toBe(2);
    expect(src.label).toBe('архив: Gemini Takeout · 2 сообщ.');
    expect(AI.sourceBadge(src)).toBe('📦 архив');
  });

  test('buildLiveSourceRecord → kind=live, ярлык live', () => {
    const live = AI.buildLiveSourceRecord({ service: 'chatgpt' });
    expect(live.kind).toBe('live');
    expect(live.label).toBe('live (сеть/DOM)');
    expect(AI.sourceBadge(live)).toBe('⚡ live');
  });

  test('describeSource: отсутствие записи → прочерк, не выдуманный источник', () => {
    expect(AI.describeSource(null)).toBe('—');
    expect(AI.describeSource({ kind: 'other' })).toBe('—');
    expect(AI.sourceBadge(null)).toBe('');
  });

  test('isArchiveRecordFor: архив принимается ТОЛЬКО для своего convId', () => {
    expect(AI.isArchiveRecordFor({ convId: 'c1' }, 'c1')).toBe(true);
    expect(AI.isArchiveRecordFor({ convId: 'c1' }, 'c2')).toBe(false);
    expect(AI.isArchiveRecordFor({ convId: 'c1' }, '')).toBe(false);
    expect(AI.isArchiveRecordFor(null, 'c1')).toBe(false);
  });
});

describe('T1: JSON-запись/чтение архива', () => {
  test('запись сериализуется и читается без потерь (chrome.storage.local — JSON)', () => {
    const rec = AI.buildArchiveRecord({
      convId: 'c1', service: 'claude', format: AI.FORMATS.CLAUDE_CONVERSATIONS,
      title: 'T', messages: [{ id: 'm1', role: 'human', text: 'привет' }]
    });
    const round = JSON.parse(JSON.stringify(rec));
    expect(round).toEqual(rec);
    expect(round.messages[0].role).toBe('user');
  });
});
