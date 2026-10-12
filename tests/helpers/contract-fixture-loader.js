/**
 * §п.8-A: ЛОАДЕР КОНТРАКТНЫХ ФИКСТУР (обобщение tests/helpers/o18-fixture.js).
 *
 * Принцип «реальное сырьё, иначе синтез»: контрактный пин обязан проверять НАСТОЯЩИЙ
 * артефакт из tools/. Если артефакта нет (в CI каталог tools/ часто gitignored),
 * подставляется синтетика, но факт подмены виден вызывающему через fromLiveRun=false —
 * и тест обязан сам решить, объявлять skip или нет. Молчаливая подмена запрещена.
 *
 * Экспорт: { loadFixture }
 *   loadFixture(toolsPath, synthFactory?, opts?) → { text, json, bytes, fromLiveRun, source,
 *                                                     existed, synthetic, sha1 }
 *
 * opts: { parseJson=false, encoding='utf8', forceSynthetic }
 * env:  AI_CM_CONTRACT_SYNTH=1 — принудительный синтез (отладка CI-ветки).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.join(__dirname, '..', '..');

/** Единственный env-переключатель принудительного синтеза. */
function synthForced() {
  return String(process.env.AI_CM_CONTRACT_SYNTH || '') === '1';
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return undefined;
  }
}

/**
 * @param {string} toolsPath путь от корня репозитория, напр. 'tools/o18-samples/live-18-19.txt'
 * @param {(() => (string|Buffer|object))} [synthFactory] фабрика синтетики
 * @param {object} [opts]
 */
function loadFixture(toolsPath, synthFactory, opts) {
  const options = opts || {};
  const abs = path.isAbsolute(toolsPath) ? toolsPath : path.join(REPO_ROOT, toolsPath);
  const forced = options.forceSynthetic !== undefined ? !!options.forceSynthetic : synthForced();
  const existed = fs.existsSync(abs);

  if (existed && !forced) {
    const buf = fs.readFileSync(abs);
    const text = buf.toString(options.encoding || 'utf8');
    const parsed = options.parseJson ? tryParseJson(text) : undefined;
    if (options.parseJson && parsed === undefined) {
      throw new Error('[contract-fixture-loader] ' + toolsPath + ': JSON не разобран, а parseJson=true');
    }
    return {
      text: text,
      json: parsed,
      bytes: buf.length,
      fromLiveRun: true,
      existed: true,
      synthetic: false,
      source: toolsPath,
      sha1: crypto.createHash('sha1').update(buf).digest('hex')
    };
  }

  // Ветка синтеза: либо файла нет, либо синтез запрошен явно.
  if (typeof synthFactory !== 'function') {
    throw new Error('[contract-fixture-loader] артефакт ' + toolsPath +
      (existed ? ' есть, но запрошен синтез' : ' отсутствует') + ', а synthFactory не передан');
  }
  const made = synthFactory();
  if (made === undefined || made === null) {
    throw new Error('[contract-fixture-loader] synthFactory(' + toolsPath + ') вернула пусто');
  }
  const isObj = typeof made === 'object' && !Buffer.isBuffer(made);
  const text = isObj ? JSON.stringify(made) : String(made);
  return {
    text: text,
    json: isObj ? made : (options.parseJson ? tryParseJson(text) : undefined),
    bytes: Buffer.byteLength(text, options.encoding || 'utf8'),
    fromLiveRun: false,
    existed: existed,
    synthetic: true,
    source: toolsPath,
    sha1: crypto.createHash('sha1').update(text).digest('hex')
  };
}

module.exports = { loadFixture: loadFixture, REPO_ROOT: REPO_ROOT };
