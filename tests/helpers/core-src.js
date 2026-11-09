'use strict';

/**
 * Исходник core-модуля для source-level пин-тестов сьюта (Core Wave 2).
 *
 * Пин-тесты ищут в исходнике и код (`var aiCmSanitizeSkipLogged = {};`), и
 * комментарии, и режут функции по балансу скобок. После перевода
 * core/base-handler, core/hybrid-tail и core/export-manager на TypeScript
 * сырой текст содержит аннотации и EOF-блоки интерфейсов, поэтому для ЭТИХ трёх
 * модулей отдаётся текст, равный прежнему (до миграции): `stripTypesKeepComments`
 * снимает типы, СОХРАНЯЯ комментарии и модульный формат (UMD-хвост
 * `module.exports = Api` остаётся как был).
 *
 * Ранее мигрированные модули (core/state.ts, core/widget.ts, utils/*.ts) и все
 * `.js` отдаются как есть: часть тестов пиннит уже типизированные подписи.
 */
const fs = require('fs');
const path = require('path');
const { stripTypesKeepComments } = require('./read-module-source.js');

const ROOT = path.join(__dirname, '..', '..');

const STRIPPED = new Set([
  'core/base-handler.ts',
  'core/hybrid-tail.ts',
  'core/export-manager.ts'
]);

/**
 * @param {string} rel путь от корня репозитория
 * @param {string} [src] уже прочитанный исходник (вызывающий читает сам — так
 *   source-пин остаётся видимым для behavior-gate: `readFileSync` в его теле)
 */
function readCore(rel, src) {
  const text = typeof src === 'string' ? src : fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return STRIPPED.has(rel.replace(/\\/g, '/')) ? stripTypesKeepComments(text, rel) : text;
}

module.exports = { ROOT, readCore };
