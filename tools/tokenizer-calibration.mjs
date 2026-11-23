#!/usr/bin/env node
/**
 * Калибровка Tokenizer по точным ответам Gemini countTokens.
 *
 * Вход: один или несколько .log-файлов (или каталог), где есть строки
 * `[AI CM][diag] o23-calibration ...` (пишется core/content.ts при каждом
 * успешном BYOK countTokens). Одна строка = один и тот же fullText:
 * точное число API и эвристика Tokenizer.
 *
 * Запуск:
 *   node tools/tokenizer-calibration.mjs <log|dir> [ещё...]
 *
 * Что печатает:
 *   - по каждому замеру: chars, cyr%, exact, heuristic, ошибка эвристики;
 *   - сводку: сколько замеров, суммарные chars/exact, медиану/перцентили ошибки;
 *   - МНК-подгонку коэффициентов по классам символов и предлагаемые константы;
 *   - holdout-проверку подгонки (чётные замеры → нечётные).
 */
import fs from 'node:fs';
import path from 'node:path';

const TAG = 'o23-calibration ';
const FEATURES = ['cyr', 'latin', 'digit', 'punct', 'cjk', 'other', 'const'];

function collectFiles(input) {
  const out = [];
  const st = fs.statSync(input);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(input)) {
      if (/\.log$/i.test(name)) out.push(path.join(input, name));
    }
  } else {
    out.push(input);
  }
  return out;
}

function parseLine(line) {
  const at = line.indexOf(TAG);
  if (at === -1) return null;
  const fields = {};
  const re = /([A-Za-z][A-Za-z0-9_]*)=([^\s]+)/g;
  let m;
  const tail = line.slice(at + TAG.length);
  while ((m = re.exec(tail)) !== null) fields[m[1]] = m[2];
  const need = ['chars', 'cyr', 'latin', 'digit', 'cjk', 'punct', 'other', 'space', 'heuristic', 'exact'];
  for (const k of need) if (!(k in fields)) return null;
  const sample = {
    model: fields.model || '(unknown)',
    convId: fields.convId || '',
    chars: Number(fields.chars),
    cyr: Number(fields.cyr),
    latin: Number(fields.latin),
    digit: Number(fields.digit),
    punct: Number(fields.punct),
    cjk: Number(fields.cjk),
    other: Number(fields.other),
    space: Number(fields.space),
    img: Number(fields.img || 0),
    doc: Number(fields.doc || 0),
    attach: Number(fields.attach || 0),
    heuristic: Number(fields.heuristic),
    v2: Number.isFinite(Number(fields.v2)) ? Number(fields.v2) : null,
    exact: Number(fields.exact)
  };
  if (!Number.isFinite(sample.chars) || sample.chars < 200) return null;
  if (!(sample.exact > 0) || !(sample.heuristic > 0)) return null;
  sample.err = (sample.heuristic - sample.exact) / sample.exact;
  return sample;
}

function quantile(values, q) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function pct(x) {
  return (x * 100).toFixed(2) + '%';
}

/** Решение A*x=b методом Гаусса с выбором главного элемента; null при вырожденности. */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => row.concat([b[i]]));
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const div = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (!f) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map(row => row[n]);
}

function vectorOf(s) {
  return [s.cyr, s.latin, s.digit, s.punct, s.cjk, s.other, 1];
}

function fit(samples) {
  const n = FEATURES.length;
  const A = Array.from({ length: n }, () => Array(n).fill(0));
  const b = Array(n).fill(0);
  for (const s of samples) {
    const f = vectorOf(s);
    for (let j = 0; j < n; j++) {
      b[j] += f[j] * s.exact;
      for (let k = 0; k < n; k++) A[j][k] += f[j] * f[k];
    }
  }
  // Ridge: при вырожденных/нулевых классах (нет CJK и т.п.) обычный МНК не решается.
  const meanDiag = A.reduce((acc, row, i) => acc + row[i], 0) / n;
  const lambda = Math.max(1e-9, meanDiag * 1e-8);
  for (let i = 0; i < n; i++) A[i][i] += lambda;
  const w = solve(A, b);
  if (!w) return null;
  return {
    w,
    predict(s) {
      const f = vectorOf(s);
      return f.reduce((acc, v, i) => acc + v * w[i], 0);
    }
  };
}

function mae(model, samples) {
  if (!samples.length) return 0;
  return mean(samples.map(s => Math.abs((model.predict(s) - s.exact) / s.exact)));
}

const inputs = process.argv.slice(2);
if (!inputs.length) {
  console.error('usage: node tools/tokenizer-calibration.mjs <log|dir> [more...]');
  process.exit(2);
}

const files = inputs.flatMap(collectFiles);
const byKey = new Map();
for (const file of files) {
  const buf = fs.readFileSync(file);
  let text = buf.toString('utf8');
  if (!text.includes(TAG)) {
    const utf16 = buf.toString('utf16le');
    if (utf16.includes(TAG)) text = utf16;
  }
  for (const line of text.split(/\r?\n/)) {
    const s = parseLine(line);
    if (!s) continue;
    const key = [s.model, s.chars, s.cyr, s.latin, s.digit, s.cjk, s.punct, s.other, s.space, s.exact].join('|');
    const prev = byKey.get(key);
    // Тот же замер из старого лога (без v2) и нового (с v2) — оставляем с v2.
    if (!prev || (prev.v2 === null && s.v2 !== null)) byKey.set(key, s);
  }
}
const samples = [...byKey.values()];

if (!samples.length) {
  console.error('o23-calibration: замеров не найдено (нужен включённый Подробный лог + BYOK).');
  process.exit(1);
}

samples.sort((a, b) => a.chars - b.chars);

console.log('# Tokenizer calibration (Gemini countTokens)');
console.log('');
console.log('files: ' + files.join(', '));
console.log('samples: ' + samples.length);
const totalChars = samples.reduce((a, s) => a + s.chars, 0);
const totalExact = samples.reduce((a, s) => a + s.exact, 0);
const totalHeur = samples.reduce((a, s) => a + s.heuristic, 0);
const totalCyr = samples.reduce((a, s) => a + s.cyr, 0);
console.log('weighted chars/token: ' + (totalChars / totalExact).toFixed(4));
console.log('weighted heuristic/exact: ' + (totalHeur / totalExact).toFixed(4) + ' (error ' + pct((totalHeur - totalExact) / totalExact) + ')');
console.log('cyrillic share: ' + pct(totalCyr / totalChars));
console.log('');

const errs = samples.map(s => s.err);
console.log('heuristic error: mean ' + pct(mean(errs)) +
  ' | median ' + pct(quantile(errs, 0.5)) +
  ' | p10 ' + pct(quantile(errs, 0.1)) +
  ' | p90 ' + pct(quantile(errs, 0.9)) +
  ' | min ' + pct(Math.min(...errs)) +
  ' | max ' + pct(Math.max(...errs)));
console.log('');

// Shadow-режим v2: строки o23-calibration содержат v2= рядом с heuristic/exact.
const shadow = samples.filter(s => s.v2 !== null && s.v2 > 0);
if (shadow.length) {
  const v2err = shadow.map(s => (s.v2 - s.exact) / s.exact);
  const v2abs = v2err.map(Math.abs);
  const oldAbs = shadow.map(s => Math.abs(s.err));
  console.log('shadow v2: mean ' + pct(mean(v2err)) +
    ' | MAE ' + pct(mean(v2abs)) +
    ' | max ' + pct(Math.max(...v2abs)) +
    ' | old heuristic MAE on same points ' + pct(mean(oldAbs)));
  console.log('');
}

const models = [...new Set(samples.map(s => s.model))];
if (models.length > 1) {
  console.log('## by model');
  for (const model of models) {
    const list = samples.filter(s => s.model === model);
    const chars = list.reduce((a, s) => a + s.chars, 0);
    const exact = list.reduce((a, s) => a + s.exact, 0);
    const heur = list.reduce((a, s) => a + s.heuristic, 0);
    console.log('- ' + model + ': n=' + list.length + ', chars/token=' + (chars / exact).toFixed(4) +
      ', heuristic/exact=' + (heur / exact).toFixed(4));
  }
  console.log('');
}

const attachSamples = samples.filter(s => s.img > 0 || s.doc > 0);
if (attachSamples.length) {
  console.log('note: ' + attachSamples.length + ' замер(ов) с вложениями — точный countTokens их не считает; ' +
    'для чистых констант используйте серию без вложений (attach=0).');
  console.log('');
}

console.log('## samples');
if (shadow.length) {
  console.log('| chars | cyr% | exact | heuristic | err | v2 | err2 | img/doc |');
  console.log('|---:|---:|---:|---:|---:|---:|---:|---:|');
} else {
  console.log('| chars | cyr% | exact | heuristic | err | img/doc |');
  console.log('|---:|---:|---:|---:|---:|---:|');
}
for (const s of samples) {
  if (shadow.length) {
    const err2 = s.v2 !== null ? pct((s.v2 - s.exact) / s.exact) : '—';
    console.log('| ' + s.chars + ' | ' + (100 * s.cyr / s.chars).toFixed(1) + '% | ' +
      s.exact + ' | ' + s.heuristic + ' | ' + pct(s.err) + ' | ' +
      (s.v2 === null ? '—' : s.v2) + ' | ' + err2 + ' | ' + s.img + '/' + s.doc + ' |');
  } else {
    console.log('| ' + s.chars + ' | ' + (100 * s.cyr / s.chars).toFixed(1) + '% | ' +
      s.exact + ' | ' + s.heuristic + ' | ' + pct(s.err) + ' | ' + s.img + '/' + s.doc + ' |');
  }
}
console.log('');

const model = fit(samples);
if (!model) {
  console.log('fit: вырожденная система (нужно больше разнообразных замеров).');
  process.exit(0);
}

console.log('## OLS fit (exact = sum(coef * feature))');
FEATURES.forEach((name, i) => console.log('- ' + name + ': ' + model.w[i].toFixed(6)));
console.log('');
console.log('suggested constants:');
const w = model.w;
const inv = v => (v > 0 ? (1 / v).toFixed(4) : 'n/a');
console.log('- CYRILLIC_CHARS_PER_TOKEN = ' + inv(w[0]));
console.log('- LATIN_CHARS_PER_TOKEN    = ' + inv(w[1]));
console.log('- DIGIT_CHARS_PER_TOKEN    = ' + inv(w[2]));
console.log('- PUNCT_TOKENS_PER_CHAR    = ' + w[3].toFixed(4));
console.log('- CJK_CHARS_PER_TOKEN      = ' + inv(w[4]));
console.log('- OTHER_TOKENS_PER_CHAR    = ' + w[5].toFixed(4));
console.log('- CONST_TOKENS             = ' + w[6].toFixed(2));
console.log('- fit MAE                  = ' + pct(mae(model, samples)));
console.log('');

const train = samples.filter((_, i) => i % 2 === 0);
const test = samples.filter((_, i) => i % 2 === 1);
const holdout = train.length >= 4 ? fit(train) : null;
if (holdout && test.length) {
  console.log('holdout: train=' + train.length + ' test=' + test.length +
    ' MAE=' + pct(mae(holdout, test)) +
    ' (текущая эвристика на test: ' + pct(mean(test.map(s => Math.abs(s.err)))) + ')');
} else {
  console.log('holdout: мало замеров (нужно >= 8).');
}
