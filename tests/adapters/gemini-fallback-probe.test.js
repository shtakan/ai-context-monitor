/**
 * v1.14.1 (FB-PROBE): fallback-top объявляет полноту ТОЛЬКО при доступности серверного
 * probe (v73). Раньше критерий base>=floor был круговой проверкой: floor мог быть
 * сохранён из такой же ложной полноты при прерванной загрузке → автоэкспорт стрелял
 * по усечённой базе (баг чата e292103e, 2026-09-02).
 *
 * Гард вынесен в чистый хелпер GeminiInterceptLogic.fallbackProbeReady(meta, wideCur),
 * который используется в core/gemini-intercept.js (applyFallbackComplete).
 *
 * Проверяем:
 *   а) все метаданные + широкий курсор → probe доступен (true);
 *   б) отсутствие каждого компонента по отдельности → false (at/baseUrl/headers/курсор);
 *   в) null/undefined входы → false (без исключений);
 *   г) core реально вызывает хелпер (гард присутствует в исходнике).
 */
const path = require('path');
const fs = require('fs');

const GIL = require('../../utils/gemini-intercept-logic.js');

const FULL_META = { atEncoded: 'at-token', baseUrl: 'https://gemini.google.com/_/BardChatUi/data/...', headers: { authorization: 'SATK' } };
const WIDE_CUR = { cursor: 'opaque-continuation' };

describe('Gemini v1.14.1 FB-PROBE: fallback-top только через серверный probe (fallbackProbeReady)', () => {
  test('полные метаданные + широкий курсор → true', () => {
    expect(GIL.fallbackProbeReady(FULL_META, WIDE_CUR)).toBe(true);
  });

  test('нет atEncoded → false', () => {
    expect(GIL.fallbackProbeReady({ ...FULL_META, atEncoded: null }, WIDE_CUR)).toBe(false);
  });

  test('нет baseUrl → false', () => {
    expect(GIL.fallbackProbeReady({ ...FULL_META, baseUrl: '' }, WIDE_CUR)).toBe(false);
  });

  test('нет headers → false', () => {
    expect(GIL.fallbackProbeReady({ ...FULL_META, headers: null }, WIDE_CUR)).toBe(false);
  });

  test('нет широкого курсора → false (класс усечённых ответов e292103e)', () => {
    expect(GIL.fallbackProbeReady(FULL_META, null)).toBe(false);
    expect(GIL.fallbackProbeReady(FULL_META, undefined)).toBe(false);
  });

  test('null/undefined входы → false без исключений', () => {
    expect(GIL.fallbackProbeReady(null, WIDE_CUR)).toBe(false);
    expect(GIL.fallbackProbeReady(undefined, undefined)).toBe(false);
  });

  test('core/gemini-intercept.js реально гейтит fallback-top через fallbackProbeReady', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'core', 'gemini-intercept.js'),
      'utf8'
    );
    expect(src).toContain('fallbackProbeReady');
    expect(src).toContain('fallback-top wait reason=probe-unavailable');
    // старый безгардовый путь объявления полноты удалён
    expect(src).not.toContain('reason=fallback-scroll-top');
  });

  // ---- H9b: retained last-good (wide-курсор + probe-метаданные) — вход probe, не источник complete ----
  describe('H9b: retained last-good (core держит и подаёт в обе точки probe)', () => {
    const CORE = path.join(__dirname, '..', '..', 'core', 'gemini-intercept.js');

    test('(а) поля lastGoodWideCur/lastGoodProbeMeta существуют рядом с serverFirstHash и обновляются только на здоровом шаге', () => {
      const src = fs.readFileSync(CORE, 'utf8');
      expect(src).toContain('var lastGoodWideCur = null');
      expect(src).toContain('var lastGoodProbeMeta = null');
      // обновление через чистую функцию-правило, гейт здорового шага (шаг не сломан + added/курсор)
      expect(src).toContain('updateProbeMetaRetain(lastGoodProbeMeta');
      expect(src).toContain('if (!lastPagStepBroken && (added > 0 || next)) {');
      // сбросы: объявление + resetForNewConversation + disjoint-reset + после probe-terminal (>=4)
      const wideNull = (src.match(/lastGoodWideCur = null/g) || []).length;
      const metaNull = (src.match(/lastGoodProbeMeta = null/g) || []).length;
      expect(wideNull).toBeGreaterThanOrEqual(4);
      expect(metaNull).toBeGreaterThanOrEqual(4);
      // обновление живёт только в шагах тихой пагинации (src='pag'); probe-парсы не проходят
      expect(src).toContain('// H9b (retain-last-good): фиксация retained ТОЛЬКО на здоровом шаге тихой пагинации');
    });

    test('(б) core подаёт retained в probe в ОБЕИХ точках: oracle (b) и fallback-top', () => {
      const src = fs.readFileSync(CORE, 'utf8');
      expect(src).toContain('retained-wide-cur fed reason=oracle-b');
      expect(src).toContain('retained-wide-cur fed reason=fallback-top');
      expect(src).toContain('retained-meta fed reason=fallback-top');
      // meta при пустом живом слоте — из retained (гарды same-convId/isStaleReqTag сохранены)
      expect(src).toContain('lastGoodProbeMeta.conv === (getConvId() || \'\')');
      expect(src).toContain('probe retained-meta convId=');
      // retained — ТОЛЬКО вход запроса: complete по-прежнему единственный probe-terminal;
      // безprobe-путь не возвращается (wait reason=probe-unavailable остаётся гардом)
      expect(src).toContain('oracle=complete reason=probe-terminal');
      expect(src).toContain('fallback-top wait reason=probe-unavailable');
      // probe-парс не мутирует состояние пагинации: подмена метаданных временная (restore)
      expect(src).toContain('__pMetaSavedH9b');
      expect(src).toContain('запрос уже сформирован (url/body/headers собраны синхронно)');
    });
  });
});
