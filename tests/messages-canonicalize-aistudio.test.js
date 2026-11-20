'use strict';

/**
 * messages/canonicalize + reconcile на фикстурах AI Studio (2.2, фаза 0/1).
 *
 * Поведенческий golden-тест: вход — анонимизированные снимки 2.1.4, выход —
 * CanonicalThread. Эталон (ходы, first/last hash, bodyHash, chars) лежит в
 * tests/fixtures/aistudio/expected.json и не читает исходники продукта.
 */

const fs = require('fs');
const path = require('path');

const {
  canonicalizeMessages,
  canonicalizeBatch,
  dedupeMessages,
  messageHash,
  normalizeRole,
  normalizeText
} = require('../utils/messages/canonicalize.ts');
const { reconcile } = require('../utils/messages/reconcile.ts');
const { canonicalBody } = require('../utils/canonical-body.ts');

const DIR = path.join(__dirname, 'fixtures', 'aistudio');
const expected = JSON.parse(fs.readFileSync(path.join(DIR, 'expected.json'), 'utf8'));

function docOf(file) {
  return JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
}

function batchOf(file, kind) {
  const doc = docOf(file);
  return {
    v: 1,
    platform: 'aistudio',
    kind: kind || (doc.src === 'server' ? 'net' : 'dom'),
    convId: null,
    routeKey: 'prompts/fixture',
    capturedAt: Date.parse(doc.exportedAt),
    complete: doc.partial !== true,
    messages: doc.messages.map(function (m, i) {
      return { role: m.role, text: m.text, ordinal: i, nodeType: 'message' };
    })
  };
}

function threadOf(file, kind) {
  return canonicalizeBatch(batchOf(file, kind));
}

function bodyOf(thread) {
  return canonicalBody('', thread.messages);
}

function baseOptions(overrides) {
  return Object.assign({
    platform: 'aistudio',
    convId: null,
    kind: 'net',
    capturedAt: 1,
    complete: true
  }, overrides || {});
}

describe('AI Studio golden: canonicalize', () => {
  test.each(Object.keys(expected.fixtures))('%s: ходы, first/last hash, bodyHash, chars', function (file) {
    const exp = expected.fixtures[file].canonical;
    const thread = threadOf(file);
    const body = bodyOf(thread);

    expect(thread.turns).toHaveLength(exp.turns);
    expect(thread.messages).toHaveLength(exp.messages);
    expect(thread.turns.every(function (t) { return !!t.user && !!t.assistant; })).toBe(true);
    expect(thread.messages[0].hash).toBe(exp.firstHash);
    expect(thread.messages[thread.messages.length - 1].hash).toBe(exp.lastHash);
    expect(body.bodyHash).toBe(exp.bodyHash);
    expect(body.chars).toBe(exp.chars);
    expect(thread.messages.every(function (m) { return m.kind === 'message'; })).toBe(true);
  });

  test('back/settled/export-s1/export-s3 — один и тот же канон, несмотря на src/exportedAt', function () {
    const files = ['back.json', 'settled.json', 'export-s1-cold-f5.json', 'export-s3-new-thread.json'];
    const hashes = files.map(function (file) { return bodyOf(threadOf(file)).bodyHash; });
    expect(new Set(hashes).size).toBe(1);
  });

  test('fast — тот же состав, но другая генерация: bodyHash отличается', function () {
    expect(bodyOf(threadOf('fast.json')).bodyHash).not.toBe(bodyOf(threadOf('back.json')).bodyHash);
    expect(threadOf('fast.json').turns).toHaveLength(6);
  });

  test('retest-merge: 9 assistant-сегментов склеены в 7 ответов, сегменты сохранены', function () {
    const doc = docOf('retest-merge.json');
    const thread = threadOf('retest-merge.json');
    expect(thread.turns).toHaveLength(7);
    expect(thread.turns[5].segments).toHaveLength(3);
    expect(thread.turns[6].segments).toBeUndefined();

    const rawSegments = [doc.messages[11].text, doc.messages[12].text, doc.messages[13].text];
    expect(thread.turns[5].assistant.text).toBe(rawSegments.join('\n\n'));
    expect(thread.turns[5].assistant.text.split('\n\n').length).toBeGreaterThanOrEqual(3);
  });

  test('partial-снимок 2.1.4 не выдаётся за полный: completeness=false + incomplete', function () {
    const thread = threadOf('back.json');
    expect(thread.completeness.complete).toBe(false);
    expect(thread.completeness.reasons).toContain('incomplete');
  });

  test('канонизация детерминирована: тот же вход → те же хэши', function () {
    const a = threadOf('back.json');
    const b = threadOf('back.json');
    expect(bodyOf(a).bodyHash).toBe(bodyOf(b).bodyHash);
    expect(a.messages.map(function (m) { return m.hash; })).toEqual(b.messages.map(function (m) { return m.hash; }));
  });
});

describe('messages: правила §3.2 на синтетике', () => {
  test('роль берётся из структуры: human/model нормализуются', function () {
    const thread = canonicalizeMessages([
      { role: 'human', text: 'вопрос', ordinal: 0 },
      { role: 'model', text: 'ответ', ordinal: 1 }
    ], baseOptions());
    expect(thread.turns).toHaveLength(1);
    expect(thread.turns[0].user.role).toBe('user');
    expect(thread.turns[0].assistant.role).toBe('assistant');
    expect(normalizeRole('AI')).toBe('assistant');
    expect(normalizeRole('tool')).toBeNull();
  });

  test('tool/file/ui/system не становятся текстом и учитываются в droppedNodes', function () {
    const thread = canonicalizeMessages([
      { role: 'user', text: 'вопрос', ordinal: 0 },
      { role: 'assistant', text: 'ответ', ordinal: 1 },
      { role: 'assistant', text: '[tool: search]', nodeType: 'tool', ordinal: 2 },
      { role: 'user', text: 'файл', nodeType: 'file', ordinal: 3 },
      { role: 'assistant', text: 'чип', nodeType: 'ui', ordinal: 4 }
    ], baseOptions());
    expect(thread.messages.map(function (m) { return m.text; })).toEqual(['вопрос', 'ответ']);
    expect(thread.completeness.droppedNodes).toBe(3);
  });

  test('reasoning — отдельное поле, в text не попадает', function () {
    const thread = canonicalizeMessages([
      { role: 'user', text: 'вопрос', ordinal: 0 },
      { nodeType: 'reasoning', text: 'думаю', ordinal: 1 },
      { role: 'assistant', text: 'ответ', ordinal: 2 }
    ], baseOptions());
    expect(thread.turns[0].assistant.text).toBe('ответ');
    expect(thread.turns[0].assistant.reasoning).toBe('думаю');
    expect(bodyOf(thread).text).toBe('вопрос\nответ');
  });

  test('ordinal задаёт порядок, когда он есть у всех', function () {
    const thread = canonicalizeMessages([
      { role: 'assistant', text: 'второй', ordinal: 2 },
      { role: 'user', text: 'вопрос', ordinal: 0 },
      { role: 'assistant', text: 'первый', ordinal: 1 }
    ], baseOptions());
    expect(thread.turns[0].assistant.text).toBe('первый\n\nвторой');
  });

  test('ordinal отсутствует хотя бы у одного — исходный порядок сохраняется', function () {
    const thread = canonicalizeMessages([
      { role: 'user', text: 'вопрос' },
      { role: 'assistant', text: 'первый', ordinal: 1 },
      { role: 'assistant', text: 'второй', ordinal: 2 }
    ], baseOptions());
    expect(thread.turns).toHaveLength(1);
    expect(thread.turns[0].user.text).toBe('вопрос');
    expect(thread.turns[0].assistant.text).toBe('первый\n\nвторой');
  });

  test('ответ без user создаёт ход с user=null и понижает полноту', function () {
    const thread = canonicalizeMessages([{ role: 'assistant', text: 'сирота' }], baseOptions());
    expect(thread.turns).toHaveLength(1);
    expect(thread.turns[0].user).toBeNull();
    expect(thread.completeness.complete).toBe(false);
    expect(thread.completeness.missingUserTurns).toBe(1);
    expect(thread.completeness.reasons).toContain('missing-user-text');
  });

  test('пустой user-ход учитывается как missingUserTurns, а не молча теряется', function () {
    const thread = canonicalizeMessages([{ role: 'user', text: '   ' }], baseOptions());
    expect(thread.turns).toHaveLength(0);
    expect(thread.completeness.missingUserTurns).toBe(1);
    expect(thread.completeness.complete).toBe(false);
  });

  test('dedupeMessages: по id и по (turnId, role, текст)', function () {
    const first = { id: 'm1', turnId: 't1', seq: 0, role: 'user', kind: 'message', text: 'a', provenance: [], hash: 'h1' };
    const sameId = Object.assign({}, first, { id: 'm1', text: 'другой', hash: 'h2' });
    const sameTuple = Object.assign({}, first, { id: 'm2', hash: 'h3' });
    const result = dedupeMessages([first, sameId, sameTuple]);
    expect(result.messages).toHaveLength(1);
    expect(result.skipped).toBe(2);
  });

  test('messageHash чувствителен к роли и тексту', function () {
    expect(messageHash('user', 'x')).not.toBe(messageHash('assistant', 'x'));
    expect(messageHash('user', 'x')).not.toBe(messageHash('user', 'y'));
    expect(normalizeText('a\r\nb\rc')).toBe('a\nb\nc');
  });
});

describe('messages: reconcile (I5-заготовка)', () => {
  test('net побеждает dom независимо от порядка аргументов; текст не расходится', function () {
    const net = threadOf('back.json', 'net');
    const dom = threadOf('settled.json', 'dom');
    const one = reconcile({ thread: dom, kind: 'dom' }, { thread: net, kind: 'net' });
    const two = reconcile({ thread: net, kind: 'net' }, { thread: dom, kind: 'dom' });

    expect(one.thread.completeness).toEqual(net.completeness);
    expect(bodyOf(one.thread).bodyHash).toBe(bodyOf(net).bodyHash);
    expect(bodyOf(two.thread).bodyHash).toBe(bodyOf(net).bodyHash);
    expect(one.diagnostics.filter(function (d) { return d.type === 'text-divergence'; })).toHaveLength(0);
    expect(one.diagnostics.some(function (d) { return d.type === 'source-priority'; })).toBe(true);
  });

  test('равный источник: расхождение текста фиксируется, а не смешивается', function () {
    const fast = threadOf('fast.json', 'dom');
    const settled = threadOf('settled.json', 'dom');
    const diffTurns = fast.turns.filter(function (t, i) {
      return t.assistant.hash !== settled.turns[i].assistant.hash;
    }).length;
    const result = reconcile(
      { thread: fast, kind: 'dom', capturedAt: 0 },
      { thread: settled, kind: 'dom', capturedAt: 0 }
    );
    const divergences = result.diagnostics.filter(function (d) { return d.type === 'text-divergence'; });
    expect(divergences).toHaveLength(diffTurns);
    expect(bodyOf(result.thread).bodyHash).toBe(bodyOf(fast).bodyHash);
    expect(divergences[0].chosenHash).not.toBe(divergences[0].otherHash);
  });

  test('недостающий assistant заполняется из второго представления с провенансом', function () {
    const fullBatch = batchOf('back.json', 'dom');
    fullBatch.complete = true;
    const partialBatch = batchOf('back.json', 'net');
    partialBatch.complete = true;
    partialBatch.messages = partialBatch.messages.filter(function (m, i) { return i !== 3; });

    const partial = canonicalizeBatch(partialBatch);
    const full = canonicalizeBatch(fullBatch);
    expect(partial.turns[1].assistant).toBeNull();

    const result = reconcile({ thread: partial, kind: 'net' }, { thread: full, kind: 'dom' });
    expect(result.thread.turns[1].assistant).not.toBeNull();
    expect(result.thread.turns[1].assistant.provenance.map(function (p) { return p.kind; })).toContain('dom');
    expect(result.thread.completeness.complete).toBe(false);
    expect(result.diagnostics.some(function (d) {
      return d.type === 'filled' && d.field === 'assistant';
    })).toBe(true);
    expect(partial.turns[1].assistant).toBeNull();
  });

  test('лишние ходы второго представления видны как turn-mismatch', function () {
    const backBatch = batchOf('back.json', 'net');
    backBatch.complete = true;
    const retestBatch = batchOf('retest-merge.json', 'dom');
    retestBatch.complete = false;
    const back = canonicalizeBatch(backBatch);
    const retest = canonicalizeBatch(retestBatch);

    const result = reconcile({ thread: back, kind: 'net' }, { thread: retest, kind: 'dom' });
    expect(result.thread.turns).toHaveLength(6);
    expect(result.diagnostics.some(function (d) { return d.type === 'turn-mismatch'; })).toBe(true);
  });
});
