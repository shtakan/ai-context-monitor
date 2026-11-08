'use strict';
/**
 * v2.6: архитектура сбора вложений Gemini — позиционная дельта пула.
 *
 * ПРОБЛЕМА (системная). Кумулятивный пул `turn[2][0][4][0][4]` повторяется в
 * каждом ходе, а прежняя реализация вычитала пулы мультимножествами по ключу
 * name|size (+token). Переподписанный токен ломал вычитание → дубли (102
 * картинки вместо 19), а две загрузки с одинаковым именем и размером
 * схлопывались в одну → потеря количества (7 файлов вместо 14).
 *
 * РЕШЕНИЕ. Пул растёт только в ХВОСТ (эмпирика: pool(older) — префикс
 * pool(newer)), поэтому собственные файлы хода — хвост после общего ПРЕФИКСА
 * по именам, а позиция узла (pos) — устойчивая идентичность. Здесь пинуется:
 *
 *   A1  переподпись ссылки и токена не создаёт дубль (позиции те же);
 *   A2  две загрузки с одинаковым именем и размером остаются разными файлами
 *       (разные позиции; identity name|size их склеила бы);
 *   A3  страницы приходят новыми→старыми: итог ровно A, B, C по ходам;
 *   A4  позиция узла проставляется в collectTurnFiles (pos = индекс в пуле).
 *
 * PDF-мусор (п.4 ТЗ): локальный разбор не должен отдавать CID-коды как текст.
 *   P1  hex-строки CID без пробелов → pdf-no-text;
 *   P2  U+FFFD / private use вычищаются из текста (в базу не попадают);
 *   P3  «слова» из мойибаке (ÿýþø) с пробелами → pdf-no-text по проверке языка;
 *   P4  обычный текстовый PDF остаётся читаемым.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { DecompressionStream } = require('stream/web');
const { TextDecoder } = require('util');

const ROOT = path.join(__dirname, '..', '..');
const PDF_PATH = path.join(ROOT, 'core', 'pdf-bytes.js');
const FILES_PATH = path.join(ROOT, 'core', 'gemini-files.js');
const P = require('../helpers/load-esm.js').loadEsmModule('utils/gemini-batchexecute-parser.ts');

// ===================== 1. Позиционная дельта пула =====================

function fileNode(name, opts) {
  const o = opts || {};
  const isImage = o.image === true;
  const node = [];
  node[1] = isImage ? 1 : 11;
  node[2] = name;
  node[3] = o.img || (isImage ? 'https://lh3.googleusercontent.com/' + name : '');
  node[5] = o.token || ('$AfW' + name);
  node[7] = o.dl ? [o.dl] : [];
  node[11] = o.mime || (isImage ? 'image/png' : (/\.pdf$/i.test(name) ? 'application/pdf' : 'text/plain'));
  node[15] = [1, 1, typeof o.size === 'number' ? o.size : 0];
  return node;
}

function turnOf(nodes) {
  const turn = [];
  turn[2] = [[null, null, null, null, [[null, null, null, null, nodes]]]];
  return turn;
}

const CONV = 'c_e1020dbabcfa5a02';

describe('v2.6: позиционная дельта кумулятивного пула вложений', () => {
  beforeEach(() => { P.__resetFileOwners(CONV); });

  test('A1: переподпись dl-ссылки и токена не создаёт дубль', () => {
    // Один и тот же файл: в новом ответе Gemini выдал другой токен и другую
    // подписанную ссылку, имя и место в пуле — прежние.
    const older = turnOf([fileNode('act.pdf', { token: '$AfW1', dl: 'https://x/download?c=t1', size: 10 })]);
    const newer = turnOf([
      fileNode('act.pdf', { token: '$AfW2', dl: 'https://x/download?c=t2', size: 10 }),
      fileNode('scan.pdf', { token: '$AfW3', dl: 'https://x/download?c=t3', size: 20 })
    ]);
    P.registerTurnFileOwner(older, CONV, 't1', 100, 0);
    P.registerTurnFileOwner(newer, CONV, 't2', 200, 1);

    const ownNewer = P.collectTurnFilesForOwner(newer, CONV, 't2', 200, 1);
    expect(ownNewer.map((r) => r.name)).toEqual(['scan.pdf']);
    const ownOlder = P.collectTurnFilesForOwner(older, CONV, 't1', 100, 0);
    expect(ownOlder.map((r) => r.name)).toEqual(['act.pdf']);

    // Повторный разбор того же хода (ещё одна переподпись) не размножает файл.
    const reSigned = turnOf([
      fileNode('act.pdf', { token: '$AfW9', dl: 'https://x/download?c=t9', size: 10 }),
      fileNode('scan.pdf', { token: '$AfW9b', dl: 'https://x/download?c=t9b', size: 20 })
    ]);
    expect(P.registerTurnFileOwner(reSigned, CONV, 't2', 200, 1)).toBe(2);
    expect(P.collectTurnFilesForOwner(reSigned, CONV, 't2', 200, 1).map((r) => r.name)).toEqual(['scan.pdf']);
  });

  test('A2: одинаковые имя и размер при разных загрузках — разные файлы', () => {
    const older = turnOf([fileNode('скан.pdf', { token: '$AfW1', dl: 'https://x/download?c=one', size: 500 })]);
    const newer = turnOf([
      fileNode('скан.pdf', { token: '$AfW2', dl: 'https://x/download?c=one2', size: 500 }),
      fileNode('скан.pdf', { token: '$AfW3', dl: 'https://x/download?c=two', size: 500 })
    ]);
    P.registerTurnFileOwner(older, CONV, 't1', 100, 0);
    P.registerTurnFileOwner(newer, CONV, 't2', 200, 1);

    const ownOlder = P.collectTurnFilesForOwner(older, CONV, 't1', 100, 0);
    const ownNewer = P.collectTurnFilesForOwner(newer, CONV, 't2', 200, 1);
    expect(ownOlder).toHaveLength(1);
    expect(ownNewer).toHaveLength(1);
    // Позиции разные → позиционный ключ их не склеит.
    expect(ownOlder[0].pos).toBe(0);
    expect(ownNewer[0].pos).toBe(1);
    // Прежний ключ (name|size) их склеил бы — в этом и была потеря количества.
    expect(P.fileRefIdentityKey(ownOlder[0])).toBe(P.fileRefIdentityKey(ownNewer[0]));
  });

  test('A3: страницы приходят новыми→старыми, итог ровно A, B, C', () => {
    const a = fileNode('A.txt', { size: 1, dl: 'https://x/download?c=A' });
    const b = fileNode('B.txt', { size: 2, dl: 'https://x/download?c=B' });
    const c = fileNode('C.txt', { size: 3, dl: 'https://x/download?c=C' });
    const t1 = turnOf([a]);
    const t2 = turnOf([a, b]);
    const t3 = turnOf([a, b, c]);
    // Порядок прихода как у Gemini: сначала самая новая страница (t3), затем старые.
    const pages = [[{ id: 't3', turn: t3, ts: 300 }], [{ id: 't2', turn: t2, ts: 200 }], [{ id: 't1', turn: t1, ts: 100 }]];
    for (const page of pages) {
      for (let pre = page.length - 1; pre >= 0; pre--) {
        const rec = page[pre];
        P.registerTurnFileOwner(rec.turn, CONV, rec.id, rec.ts, page.length - 1 - pre);
      }
    }
    const own = {};
    for (const page of pages) {
      for (let i = 0; i < page.length; i++) {
        const rec = page[i];
        own[rec.id] = P.collectTurnFilesForOwner(rec.turn, CONV, rec.id, rec.ts, page.length - 1 - i);
      }
    }
    expect(own.t1.map((r) => r.name)).toEqual(['A.txt']);
    expect(own.t2.map((r) => r.name)).toEqual(['B.txt']);
    expect(own.t3.map((r) => r.name)).toEqual(['C.txt']);
    expect(own.t1.length + own.t2.length + own.t3.length).toBe(3);
  });

  test('A4: pos проставляется по индексу узла в пуле', () => {
    const refs = P.collectTurnFiles(turnOf([
      fileNode('one.png', { image: true }),
      fileNode('two.pdf', { size: 7 }),
      fileNode('three.docx', { size: 9 })
    ]));
    expect(refs.map((r) => r.pos)).toEqual([0, 1, 2]);
  });
});

// ============ A5: владение считается на эмиссии, а не на странице ============
// Реальный чат e1020dbabcfa5a02: 59 ходов, 6 страниц (приходят новыми→старыми),
// кумулятивный пул повторяется в каждом ходе, 33 позиции = 14 файлов + 19 картинок.
// Прежний код считал дельту в момент прихода страницы: у самого старого хода
// страницы предшественника ещё нет → он забирал весь пул (в экспорте 42 [FILE:]
// и 91 [IMAGE:] вместо 14 и 19). Здесь пинуется дельта по ПОЛНОМУ списку ходов.

function attachmentsFixture() {
  const img = (name, size) => fileNode(name, { image: true, size: size });
  const doc = (name) => fileNode(name, { dl: 'https://contribution.usercontent.google.com/download?c=' + name });
  // Точная раскладка реального чата e1020dbabcfa5a02 (59 ходов, 6 страниц):
  // 33 позиции кумулятивного пула = 14 файлов + 19 картинок. Повторы имён —
  // НОВЫЕ загрузки на новых позициях (Защита.docx ×5, Досудебная..docx ×3,
  // Мед_без_укэп.pdf ×2), их нельзя склеивать.
  const nodes = [
    doc('Досудебная..docx'), doc('Мед_без_укэп.pdf'), img('Заявление_11.06.jpg', 337969), img('Направление.jpg', 354682), img('Ответ_ГКП.jpg', 245644), // t0: 0..4
    doc('Мед_без_укэп.pdf'), img('Заявление_11.06.jpg', 337969), img('Направление.jpg', 354682), img('Ответ_ГКП.jpg', 245644), doc('Досудебная..docx'), // t1: 5..9
    doc('Досудебная..docx'), doc('Мед_для_промт.pdf'), img('Заявление_11.06.jpg', 337969), img('Направление.jpg', 354682), img('Ответ_ГКП.jpg', 245644), // t2: 10..14
    doc('Аудит.docx'), // t5: 15
    img('image_d1bc35.png', 135833), // t6: 16
    img('image_d1c684.png', 152058), // t7: 17
    doc('Заявление.docx'), // t8: 18
    img('1000000818.jpg', 196034), // t20: 19
    img('1000000819.jpg', 249886), // t21: 20
    img('IMG20260707143506.jpg', 317514), // t23: 21
    img('1000000822.jpg', 190042), img('1000000821.jpg', 198961), // t25: 22..23
    img('1000000823.jpg', 82849), // t34: 24
    doc('download7.pdf'), // t35: 25
    doc('Защита.docx'), // t42: 26
    doc('Защита.docx'), // t43: 27
    doc('Защита.docx'), // t46: 28
    doc('Защита.docx'), // t50: 29
    doc('Защита.docx'), // t52: 30
    img('image_ae5923.png', 195454), // t54: 31
    img('image_844d45.png', 184424) // t57: 32
  ];
  const starts = { 0: 5, 1: 5, 2: 5, 5: 1, 6: 1, 7: 1, 8: 1, 20: 1, 21: 1, 23: 1, 25: 2, 34: 1, 35: 1, 42: 1, 43: 1, 46: 1, 50: 1, 52: 1, 54: 1, 57: 1 };
  const TOTAL_TURNS = 59;
  const turns = [];
  const expected = [];
  let pool = [];
  let at = 0;
  for (let t = 0; t < TOTAL_TURNS; t++) {
    const add = starts[t] || 0;
    const own = [];
    for (let k = 0; k < add; k++) {
      const ref = P.fileRefFromNode(nodes[at]);
      ref.pos = at;
      own.push(ref);
      at++;
    }
    pool = pool.concat(own);
    turns.push({ id: 'r_' + t, refs: pool.slice() });
    expected.push(own.map((r) => r.pos));
  }
  return { turns, expected, total: pool.length, files: pool.filter((r) => !r.isImage).length, images: pool.filter((r) => r.isImage).length };
}

describe('v2.7: владение вложениями на полном списке ходов', () => {
  test('A5: 6 страниц (новые→старые), 33 позиции = 14 файлов + 19 картинок', () => {
    const fx = attachmentsFixture();
    expect(fx.turns).toHaveLength(59);
    expect(fx.total).toBe(33);
    expect(fx.files).toBe(14);
    expect(fx.images).toBe(19);

    // Страницы приходят новыми→старыми (10,10,10,10,10,9 ходов), но раздача идёт
    // по хронологической цепочке (старые→новые), а не по страницам.
    const pages = [fx.turns.slice(0, 10), fx.turns.slice(10, 20), fx.turns.slice(20, 30), fx.turns.slice(30, 40), fx.turns.slice(40, 50), fx.turns.slice(50, 59)];
    expect(pages.map((p) => p.length)).toEqual([10, 10, 10, 10, 10, 9]);

    const chain = fx.turns;
    const assigned = P.assignPoolOwners(chain);
    expect(assigned).toHaveLength(59);
    expect(assigned.reduce((s, a) => s + a.own.length, 0)).toBe(33);
    for (let t = 0; t < chain.length; t++) {
      expect(assigned[t].own.map((r) => r.pos)).toEqual(fx.expected[t]);
    }
    // Самая старая страница: её «старый» ход получает свои 5, а не весь пул 33 —
    // именно это ломалось в экспорте (свалки по 16-24 блока).
    expect(assigned[0].own).toHaveLength(5);
    expect(assigned[58].own).toHaveLength(0);
  });

  test('A5b: повторная загрузка с тем же именем остаётся отдельным файлом', () => {
    const fx = attachmentsFixture();
    const assigned = P.assignPoolOwners(fx.turns);
    const protect = [];
    for (const a of assigned) for (const r of a.own) if (r.name === 'Защита.docx') protect.push(r.pos);
    expect(protect).toEqual([26, 27, 28, 29, 30]);
    expect(new Set(protect).size).toBe(5);
    const pretrial = [];
    for (const a of assigned) for (const r of a.own) if (r.name === 'Досудебная..docx') pretrial.push(r.pos);
    expect(pretrial).toEqual([0, 9, 10]);
  });

  test('A5c: пул перестал быть префиксом — дельта по мультимножеству', () => {
    const prev = [P.fileRefFromNode(fileNode('a.txt', { size: 1 })), P.fileRefFromNode(fileNode('b.txt', { size: 2 }))];
    const cur = [P.fileRefFromNode(fileNode('a.txt', { size: 1 })), P.fileRefFromNode(fileNode('c.txt', { size: 3 }))];
    prev.forEach((r, i) => { r.pos = i; });
    cur.forEach((r, i) => { r.pos = i; });
    const out = P.assignPoolOwners([{ id: 't1', refs: prev }, { id: 't2', refs: cur }]);
    expect(out[0].own.map((r) => r.name)).toEqual(['a.txt', 'b.txt']);
    expect(out[1].own.map((r) => r.name)).toEqual(['c.txt']);
  });

  test('A6: ingest раздаёт по пулу, а не по замороженной дельте страницы', () => {
    const src = fs.readFileSync(path.join(ROOT, 'core', 'gemini-ingest.js'), 'utf8');
    expect(src).toContain('assignPoolOwners');
    expect(src).toContain('rec.filePool');
    expect(src).not.toContain('Array.isArray(rec.files)');
  });
});

// ===================== 2. PDF-мусор (CID) =====================

function buildPdf(contentText) {
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj',
    '4 0 obj\n<< /Length ' + contentText.length + ' >>\nstream\n' + contentText + '\nendstream\nendobj'
  ];
  return '%PDF-1.4\n' + objs.join('\n') + '\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n';
}

function pdfContext() {
  const win = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; }
  };
  const sandbox = {
    window: win,
    console: { warn() {}, log() {}, error() {} },
    CustomEvent: function CustomEvent(name, init) { this.type = name; this.detail = init && init.detail; },
    TextDecoder: TextDecoder,
    DecompressionStream: DecompressionStream,
    Uint8Array: Uint8Array,
    ArrayBuffer: ArrayBuffer,
    Date: Date,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    Math: Math,
    parseInt: parseInt,
    isFinite: isFinite,
    Promise: Promise
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PDF_PATH, 'utf8'), sandbox, { filename: PDF_PATH });
  return win.AiCmPdf;
}

function toBytes(text) {
  return new Uint8Array(Buffer.from(text, 'latin1'));
}

describe('v2.6: PDF-мусор не попадает в базу', () => {
  const api = pdfContext();

  test('P1: CID-хексы без пробелов → pdf-no-text', async () => {
    const hex = new Array(200).fill('FFFD').join('');
    const res = await api.parseLocal(toBytes(buildPdf('BT /F1 12 Tf 72 720 Td <' + hex + '> Tj ET')), {});
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('pdf-no-text');
    expect(res.text).toBe('');
  });

  test('P2: U+FFFD и зона приватного использования вычищаются', async () => {
    // UTF-16BE-строка с BOM: "Report" + U+FFFD + private use + " text".
    const hex = 'FEFF' + '0052' + '0065' + '0070' + '006F' + '0072' + '0074' +
      'FFFD' + 'E000' + '0020' + '0074' + '0065' + '0078' + '0074';
    const res = await api.parseLocal(toBytes(buildPdf('BT /F1 12 Tf 72 720 Td <' + hex + '> Tj ET')), {});
    expect(res.ok).toBe(true);
    expect(res.text).toBe('Report text');
    expect(res.text.indexOf('\uFFFD')).toBe(-1);
  });

  test('P3: мойибаке с пробелами → pdf-no-text по проверке языка', async () => {
    const hex = new Array(150).fill('FFFD0020').join('');
    const res = await api.parseLocal(toBytes(buildPdf('BT /F1 12 Tf 72 720 Td <' + hex + '> Tj ET')), {});
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('pdf-no-text');
  });

  test('P4: обычный текстовый PDF читается как раньше', async () => {
    const text = 'Simple text stays intact and contains enough words to look like language';
    const res = await api.parseLocal(toBytes(buildPdf('BT /F1 12 Tf 72 720 Td (' + text + ') Tj ET')), {});
    expect(res.ok).toBe(true);
    expect(res.text).toBe(text);
  });

  test('P5: санитайзер модуля вложений — общая страховка для Chrome и Firefox', () => {
    const src = fs.readFileSync(FILES_PATH, 'utf8');
    expect(src).toContain('function gfSanitizePdfText(text)');
    expect(src).toContain("clean.garbage ? 'pdf-no-text'");
    expect(src).toContain('function gfPdfLooksLikeLanguage(text)');
    // Ключ дедупа больше не содержит токен: только позиция узла.
    expect(src).toContain('function gfDedupeKey(convId, ref)');
    expect(src).toContain("'|' + pos;");
    expect(src).not.toContain("gfStr(ref && ref.token)");
  });
});
