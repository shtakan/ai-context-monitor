/* ============================================================================================
 * canonicalBody — единственная функция канонического тела контекста (ADR-001 / S1.1).
 *
 * ПОЧЕМУ. До S1.1 текст метрики собирался в нескольких местах (core/base-handler.ts,
 * core/content.ts) каждый раз своим циклом. Любая правка одного цикла расходилась с
 * остальными, а вместе с текстом расходились chars и bodyHash. Здесь тело, его длина и
 * хэш считаются ОДНИМ проходом по одному массиву.
 *
 * КАК. canonicalBodyText() — тексты сообщений через '\n' (пустой/отсутствующий текст
 * даёт пустой сегмент). bodyHash = fnv1a32(convId + '\0' + role + '\0' + text + '\1'
 * для каждого сообщения) + ':' + chars: смена чата, роли, порядка или текста меняет
 * хэш, а одинаковый вход воспроизводит его побайтово.
 *
 * ГДЕ ЖИВЁТ. Чистый ESM-модуль: без DOM, window, storage и глобального состояния.
 * Потребители импортируют функции статически; build.mjs втягивает модуль в бандл,
 * tests/helpers/load-esm.js повторяет этот шаг для jest.
 * ============================================================================================ */

/** Сообщение, из которого строится каноническое тело. Лишние поля не участвуют. */
export interface AiCmCanonicalMessage {
  role?: string | null;
  text?: string | null;
  [key: string]: any;
}

/** Результат canonicalBody: исходный массив, тело и его детерминированные метрики. */
export interface AiCmCanonicalBody {
  messages: AiCmCanonicalMessage[];
  text: string;
  chars: number;
  msgs: number;
  bodyHash: string;
}

/**
 * S1.3 (inv-i3): кэш канонического тела по ССЫЛКЕ на массив сообщений.
 *
 * Ключ — сам массив (WeakMap не держит базу живой дольше её владельца), значение —
 * последний convId и готовое тело. Тот же массив + тот же чат отдают ТОТ ЖЕ объект
 * body (идентичность сохраняет body.messages и экономит проход по ~650 КБ на Qwen);
 * другой convId — пересчёт, иначе bodyHash перестал бы зависеть от чата
 * (tests/inv-s1-2-snapshot-body.test.js:194). Не-массивы не кэшируются: у них нет
 * стабильной ссылки, и слабый ключ был бы мусорным.
 */
var canonicalBodyCache: WeakMap<object, { convId: string; body: AiCmCanonicalBody }> | null =
  (typeof WeakMap === 'function') ? new WeakMap() : null;

/**
 * Канонический текст: тексты сообщений в исходном порядке через '\n'.
 * null/undefined-текст даёт пустую строку; не-массив — пустое тело.
 * @param list Массив сообщений (может быть null/undefined).
 * @returns Текст тела.
 */
export function canonicalBodyText(list: AiCmCanonicalMessage[] | null | undefined): string {
  var src: AiCmCanonicalMessage[] = Array.isArray(list) ? list : [];
  return src.map(function (m) { return String(m?.text ?? ''); }).join('\n');
}

/**
 * FNV-1a 32 бита по UTF-16 code units (charCodeAt): 8 hex-символов.
 * Хэш внутренний (bodyHash), межъязыковая совместимость не требуется; важны
 * детерминированность и чувствительность к любому изменению входа.
 * @param input Любое значение; null/undefined трактуются как пустая строка.
 * @returns Ровно 8 hex-символов.
 */
export function fnv1a32(input: unknown): string {
  var str = String(input == null ? '' : input);
  var hash = 0x811c9dc5;
  for (var i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  var hex = (hash >>> 0).toString(16);
  while (hex.length < 8) hex = '0' + hex;
  return hex;
}

/**
 * Каноническое тело чата: текст, число символов/сообщений и bodyHash.
 * messages — тот же массив (идентичность сохраняется), поэтому вызывающий код
 * не теряет ссылки на подготовленную базу.
 * @param convId Идентификатор чата; входит в хэш.
 * @param list Массив сообщений (может быть null/undefined).
 * @returns Тело и его метрики.
 */
export function canonicalBody(
  convId: string,
  list: AiCmCanonicalMessage[] | null | undefined
): AiCmCanonicalBody {
  var src: AiCmCanonicalMessage[] = Array.isArray(list) ? list : [];
  var cid = String(convId == null ? '' : convId);
  if (Array.isArray(list) && canonicalBodyCache) {
    var cached = canonicalBodyCache.get(src);
    if (cached && cached.convId === cid) return cached.body;
  }
  var text = canonicalBodyText(src);
  var seed: string[] = [cid, '\u0000'];
  for (var i = 0; i < src.length; i++) {
    var m = src[i] || {};
    seed.push(String(m.role == null ? '' : m.role), '\u0000', String(m.text == null ? '' : m.text), '\u0001');
  }
  var hash = fnv1a32(seed.join(''));
  var chars = text.length;
  var body: AiCmCanonicalBody = {
    messages: src,
    text: text,
    chars: chars,
    msgs: src.length,
    bodyHash: hash + ':' + chars
  };
  if (Array.isArray(list) && canonicalBodyCache) {
    canonicalBodyCache.set(src, { convId: cid, body: body });
  }
  return body;
}
