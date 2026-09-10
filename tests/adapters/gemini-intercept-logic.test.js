/**
 * РўРµСЃС‚С‹ С‡РёСЃС‚РѕР№ Р»РѕРіРёРєРё РїРµСЂРµС…РІР°С‚С‡РёРєР° Gemini (utils/gemini-intercept-logic.js).
 * РџРѕРєСЂС‹РІР°СЋС‚ РґРІР° РєР»Р°СЃСЃР° Р±Р°РіРѕРІ:
 *   (Р°) РїРѕР» (floor): РєР»СЋС‡ РІРєР»СЋС‡Р°РµС‚ PARSER_VERSION вЂ” РїСЂРё СЃРјРµРЅРµ РІРµСЂСЃРёРё СЃРѕС…СЂР°РЅС‘РЅРЅРѕРµ
 *       РёРіРЅРѕСЂРёСЂСѓРµС‚СЃСЏ Рё РїРµСЂРµР·Р°РїРёСЃС‹РІР°РµС‚СЃСЏ; РїРѕР» РЅРµ РїСЂРёРјРµРЅСЏРµС‚СЃСЏ РїСЂРё baseComplete=true.
 *   (Р±) РїРѕР»РЅР°СЏ РїРµСЂРµСЃР±РѕСЂРєР° vf5: РїРµР№Р»РѕР°Рґ СЃ РєСѓСЂСЃРѕСЂРѕРј в†’ merge Р±РµР· СЃР±СЂРѕСЃР°,
 *       Р±РµР· РєСѓСЂСЃРѕСЂР° в†’ rebuild.
 */

const {
  floorStorageKey,
  loadFloor,
  saveFloor,
  resolveFloor,
  shouldSaveFloor,
  shouldFullRebuild,
  shouldDisjointReset,
  tapeStorageKey,
  tapeVersionOf,
  shouldAcceptTape,
  orderPages,
  reverseRawTurnPage,
  orderPageByR1,
  orderRestoredTape,
  countR1Inversions,
  orderByArrival,
  orderByR1Chain,
  mergeRestoredTurns,
  isProtobufSkeleton,
  effectiveReachedStart,
  shouldMergeRestoredTurns,
  canConfirmByScroll,
  paginateStepDecision,
  resetPaginationCounters,
  completenessOracle,
  DEFAULT_PAGINATE_PAGE_CAP,
  DEFAULT_PAGINATE_TIME_CAP_MS,
  sanitizeFinalMessages,
  newDomReadiness,
  advanceReadiness,
  shouldRetryAutoscroll,
  shouldPollVf5,
  diagnoseFloorAbsence,
  orderExportMessages,
  shouldBypassCacheComplete,
  shouldHideScroller,
  updateProbeMetaRetain,
  probeTerminalGate
} = require('../../utils/gemini-intercept-logic');

function makeStorage() {
  const map = {};
  return {
    getItem: (k) => (k in map ? map[k] : null),
    setItem: (k, v) => { map[k] = String(v); },
    _map: map
  };
}

// v62/v63/v65: РіР°СЂРґ confirmed-by-scroll вЂ” РїРѕРґС‚РІРµСЂР¶РґРµРЅРёРµ РїРѕР»РЅРѕС‚С‹ РїРѕ С„РёР·РёС‡РµСЃРєРѕРјСѓ РІРµСЂС…Сѓ,
// proof РёР»Рё sanity-С„РѕР»Р±СЌРєСѓ
describe('Gemini v62/v63/v65 confirmed-by-scroll guard (canConfirmByScroll)', () => {
  // v65: РѕР±СЏР·Р°С‚РµР»СЊРЅС‹Р№ topReached
  it('v65: topReached=false + sanity РїСЂРѕР№РґРµРЅ в†’ allowed=false (reason=top-not-reached)', () => {
    expect(canConfirmByScroll({ tapeWasUsedInThisColdStart: false, vf5OverlapSinceLoaderStart: false, msgCount: 10, textLength: 300, topReached: false }))
      .toEqual({ allowed: false, lowConfidence: false, reason: 'top-not-reached' });
  });

  it('v65: topReached=true + sanity РїСЂРѕР№РґРµРЅ в†’ allowed=true, lowConfidence=true (reason=fallback-sanity-check)', () => {
    expect(canConfirmByScroll({ tapeWasUsedInThisColdStart: false, vf5OverlapSinceLoaderStart: false, msgCount: 10, textLength: 300, topReached: true, scrollEngaged: true }))
      .toEqual({ allowed: true, lowConfidence: true, reason: 'fallback-sanity-check' });
  });

  it('v65: topReached=true + tape в†’ allowed=true, lowConfidence=false (reason=tape-used)', () => {
    expect(canConfirmByScroll({ tapeWasUsedInThisColdStart: true, vf5OverlapSinceLoaderStart: false, msgCount: 10, textLength: 600, topReached: true, scrollEngaged: true }))
      .toEqual({ allowed: true, lowConfidence: false, reason: 'tape-used' });
  });

  it('v65: topReached=true + vf5-overlap в†’ allowed=true, lowConfidence=false (reason=vf5-overlap)', () => {
    expect(canConfirmByScroll({ tapeWasUsedInThisColdStart: false, vf5OverlapSinceLoaderStart: true, msgCount: 10, textLength: 600, topReached: true, scrollEngaged: true }))
      .toEqual({ allowed: true, lowConfidence: false, reason: 'vf5-overlap' });
  });

  it('v66: topReached=true, РЅРѕ scrollEngaged=false в†’ allowed=false (reason=scroll-not-engaged)', () => {
    // С…РѕР»РѕРґРЅС‹Р№ СЃС‚Р°СЂС‚ СЃ РЅРµРІРѕРІР»РµС‡С‘РЅРЅС‹Рј СЃРєСЂС‹С‚С‹Рј СЃРєСЂРѕР»Р»РѕРј: scrollTop=0 С‚СЂРёРІРёР°Р»РµРЅ,
    // В«РІРµСЂС…В» РЅРµ СЏРІР»СЏРµС‚СЃСЏ РґРѕРєР°Р·Р°С‚РµР»СЊСЃС‚РІРѕРј (СЂРµРіСЂРµСЃСЃРёСЏ 15:40 вЂ” Р»РѕР¶РЅС‹Р№ data-complete)
    expect(canConfirmByScroll({ tapeWasUsedInThisColdStart: false, vf5OverlapSinceLoaderStart: false, msgCount: 80, textLength: 5000, topReached: true, scrollEngaged: false }))
      .toEqual({ allowed: false, lowConfidence: false, reason: 'scroll-not-engaged' });
    // scrollEngaged РѕС‚СЃСѓС‚СЃС‚РІСѓРµС‚ (СЃС‚Р°СЂС‹Р№ РІС‹Р·РѕРІ Р±РµР· РїРѕР»СЏ) вЂ” С‚РѕР¶Рµ Р±Р»РѕРє
    expect(canConfirmByScroll({ tapeWasUsedInThisColdStart: true, vf5OverlapSinceLoaderStart: false, msgCount: 10, textLength: 600, topReached: true }))
      .toEqual({ allowed: false, lowConfidence: false, reason: 'scroll-not-engaged' });
  });

  it('РЅРµС‚ tape, РЅРµС‚ vf5-overlap, sanity РїСЂРѕР№РґРµРЅ (msgCount=10) в†’ allowed=true, lowConfidence=true (reason=fallback-sanity-check)', () => {
    expect(canConfirmByScroll({ tapeWasUsedInThisColdStart: false, vf5OverlapSinceLoaderStart: false, msgCount: 10, textLength: 300, topReached: true, scrollEngaged: true }))
      .toEqual({ allowed: true, lowConfidence: true, reason: 'fallback-sanity-check' });
  });

  it('РЅРµС‚ tape, РЅРµС‚ vf5-overlap, sanity РїСЂРѕР№РґРµРЅ РїРѕ РґР»РёРЅРµ (textLength=600) в†’ allowed=true, lowConfidence=true', () => {
    expect(canConfirmByScroll({ tapeWasUsedInThisColdStart: false, vf5OverlapSinceLoaderStart: false, msgCount: 2, textLength: 600, topReached: true, scrollEngaged: true }))
      .toEqual({ allowed: true, lowConfidence: true, reason: 'fallback-sanity-check' });
  });

  it('РЅРµС‚ proof Рё sanity РїСЂРѕРІР°Р»РµРЅ (msgCount=2, textLength=100) в†’ allowed=false, lowConfidence=false (reason=no-tape-no-vf5-overlap-and-failed-sanity)', () => {
    expect(canConfirmByScroll({ tapeWasUsedInThisColdStart: false, vf5OverlapSinceLoaderStart: false, msgCount: 2, textLength: 100, topReached: true, scrollEngaged: true }))
      .toEqual({ allowed: false, lowConfidence: false, reason: 'no-tape-no-vf5-overlap-and-failed-sanity' });
    // v65: Р±РµР· topReached в†’ Р±Р»РѕРє РІСЃРµРіРґР°, reason=top-not-reached
    expect(canConfirmByScroll(null)).toEqual({ allowed: false, lowConfidence: false, reason: 'top-not-reached' });
    expect(canConfirmByScroll({})).toEqual({ allowed: false, lowConfidence: false, reason: 'top-not-reached' });
  });

  it('tape-restore action=used РІ СЌС‚РѕРј С…РѕР»РѕРґРЅРѕРј СЃС‚Р°СЂС‚Рµ в†’ РїРѕРґС‚РІРµСЂР¶РґРµРЅРёРµ СЂР°Р·СЂРµС€РµРЅРѕ Р±РµР· low-confidence (reason=tape-used)', () => {
    expect(canConfirmByScroll({ tapeWasUsedInThisColdStart: true, vf5OverlapSinceLoaderStart: false, msgCount: 10, textLength: 600, topReached: true, scrollEngaged: true }))
      .toEqual({ allowed: true, lowConfidence: false, reason: 'tape-used' });
  });

  it('vf5 СЃ overlapCount>0 РїРѕСЃР»Рµ СЃС‚Р°СЂС‚Р° Р»РѕР°РґРµСЂР° в†’ РїРѕРґС‚РІРµСЂР¶РґРµРЅРёРµ СЂР°Р·СЂРµС€РµРЅРѕ Р±РµР· low-confidence (reason=vf5-overlap)', () => {
    expect(canConfirmByScroll({ tapeWasUsedInThisColdStart: false, vf5OverlapSinceLoaderStart: true, msgCount: 10, textLength: 600, topReached: true, scrollEngaged: true }))
      .toEqual({ allowed: true, lowConfidence: false, reason: 'vf5-overlap' });
  });

  it('tape РёРјРµРµС‚ РїСЂРёРѕСЂРёС‚РµС‚ РЅР°Рґ vf5-overlap Рё sanity-С„РѕР»Р±СЌРєРѕРј (СЃС†РµРЅР°СЂРёР№ B: РєСЌС€ СЃРїР°СЃР°РµС‚ СЃСЂР°Р·Сѓ)', () => {
    expect(canConfirmByScroll({ tapeWasUsedInThisColdStart: true, vf5OverlapSinceLoaderStart: true, msgCount: 1, textLength: 10, topReached: true, scrollEngaged: true }))
      .toEqual({ allowed: true, lowConfidence: false, reason: 'tape-used' });
  });
});

describe('Gemini floor (РїРѕР») вЂ” РІРµСЂСЃРёРѕРЅРёСЂРѕРІР°РЅРёРµ РїРѕ PARSER_VERSION', () => {
  it('РєР»СЋС‡ РїРѕР»Р° РІРєР»СЋС‡Р°РµС‚ PARSER_VERSION', () => {
    expect(floorStorageKey('conv_1', 'g2')).toBe('ai-cm-gemini-floor-g2-conv_1');
    expect(floorStorageKey('conv_1', 'g2')).not.toBe(floorStorageKey('conv_1', 'g1'));
  });

  it('РїРѕР» СЃР±СЂР°СЃС‹РІР°РµС‚СЃСЏ РїСЂРё СЃРјРµРЅРµ PARSER_VERSION: СЃРѕС…СЂР°РЅС‘РЅРЅРѕРµ РёРіРЅРѕСЂРёСЂСѓРµС‚СЃСЏ Рё РїРµСЂРµР·Р°РїРёСЃС‹РІР°РµС‚СЃСЏ', () => {
    const storage = makeStorage();

    // СЃРѕС…СЂР°РЅСЏРµРј В«РіСЂСЏР·РЅС‹Р№В» РёСЃС‚РѕСЂРёС‡РµСЃРєРёР№ РїРѕР» РїРѕРґ СЃС‚Р°СЂРѕР№ РІРµСЂСЃРёРµР№
    saveFloor('conv_1', 'g1', 98, 1320505, storage);
    expect(loadFloor('conv_1', 'g1', storage)).toEqual(
      expect.objectContaining({ count: 98, effectiveLen: 1320505 })
    );

    // РїРѕРґ РЅРѕРІРѕР№ РІРµСЂСЃРёРµР№ СЃС‚Р°СЂС‹Р№ РїРѕР» РЅРµ РІРёРґРµРЅ в†’ СЃР±СЂРѕС€РµРЅ
    expect(loadFloor('conv_1', 'g2', storage)).toBeNull();
  });

  it('СЃРѕС…СЂР°РЅС‘РЅРЅС‹Р№ РїРѕР» РґСЂСѓРіРѕР№ РІРµСЂСЃРёРё РїРµСЂРµР·Р°РїРёСЃС‹РІР°РµС‚СЃСЏ РЅРѕРІРѕР№ Р·Р°РїРёСЃСЊСЋ', () => {
    const storage = makeStorage();

    // СЃС‚Р°СЂС‹Р№ РїРѕР» Р·Р°РїРёСЃР°РЅ РЅР°РїСЂСЏРјСѓСЋ РІ РєР»СЋС‡ РЅРѕРІРѕР№ РІРµСЂСЃРёРё, РЅРѕ СЃ С‡СѓР¶РѕР№ version
    storage.setItem(
      floorStorageKey('conv_1', 'g2'),
      JSON.stringify({ count: 98, effectiveLen: 1320505, ts: 1, version: 'g1' })
    );
    // РёР·-Р·Р° РЅРµСЃРѕРІРїР°РґРµРЅРёСЏ РІРµСЂСЃРёРё РѕРЅ РёРіРЅРѕСЂРёСЂСѓРµС‚СЃСЏ
    expect(loadFloor('conv_1', 'g2', storage)).toBeNull();

    // РЅРѕРІР°СЏ Р·Р°РїРёСЃСЊ РґРѕР»Р¶РЅР° РїРµСЂРµР·Р°РїРёСЃР°С‚СЊ РєР»СЋС‡ (СЃСѓС‰РµСЃС‚РІСѓСЋС‰РёР№ РїРѕР» = null)
    saveFloor('conv_1', 'g2', 20, 250000, storage);
    const f = loadFloor('conv_1', 'g2', storage);
    expect(f).toEqual(expect.objectContaining({ count: 20, effectiveLen: 250000, version: 'g2' }));
  });
});

describe('Gemini floor вЂ” РїСЂРёРјРµРЅРµРЅРёРµ С‚РѕР»СЊРєРѕ РїСЂРё РЅРµРїРѕР»РЅРѕР№ Р·Р°РіСЂСѓР·РєРµ', () => {
  const savedFloor = { count: 98, effectiveLen: 1320505 };

  it('РЅРµ РїСЂРёРјРµРЅСЏРµС‚СЃСЏ РїСЂРё baseComplete=true: effectiveLen = С„Р°РєС‚РёС‡РµСЃРєРёР№ textLen', () => {
    const r = resolveFloor(250000, 20, savedFloor, true);
    expect(r.effectiveLen).toBe(250000);
    expect(r.floorApplied).toBe(false);
    expect(r.floorValue).toBe(0);
  });

  it('РїСЂРёРјРµРЅСЏРµС‚СЃСЏ РїСЂРё baseComplete=false РєР°Рє Р·Р°С‰РёС‚Р° РѕС‚ РїСЂРѕСЃР°РґРєРё', () => {
    const r = resolveFloor(250000, 20, savedFloor, false);
    expect(r.floorApplied).toBe(true);
    expect(r.floorValue).toBe(1320505);
    expect(r.effectiveLen).toBe(1320505);
  });

  it('РЅРµ РїСЂРёРјРµРЅСЏРµС‚СЃСЏ РїСЂРё baseComplete=false, РµСЃР»Рё СЃРѕС…СЂР°РЅС‘РЅРЅС‹Р№ РїРѕР» РЅРµ РІС‹С€Рµ С„Р°РєС‚РёС‡РµСЃРєРѕРіРѕ', () => {
    const lowFloor = { count: 5, effectiveLen: 1000 };
    const r = resolveFloor(250000, 20, lowFloor, false);
    expect(r.floorApplied).toBe(false);
    expect(r.effectiveLen).toBe(250000);
  });

  it('РїРѕР» РѕР±РЅРѕРІР»СЏРµС‚СЃСЏ С‚РѕР»СЊРєРѕ РєРѕРіРґР° Р±Р°Р·Р° РїРѕР»РЅР°СЏ Рё РїР°РіРёРЅР°С†РёСЏ РґРѕС€Р»Р° РґРѕ РЅР°С‡Р°Р»Р°', () => {
    expect(shouldSaveFloor(true, true)).toBe(true);
    expect(shouldSaveFloor(true, false)).toBe(false);
    expect(shouldSaveFloor(false, true)).toBe(false);
    expect(shouldSaveFloor(false, false)).toBe(false);
  });
});

describe('Gemini rebuild РёР· vf5 вЂ” РєСѓСЂСЃРѕСЂ РїСЂРѕРґРѕР»Р¶РµРЅРёСЏ РїСЂРѕС‚РёРІ РїРѕР»РЅРѕР№ РёСЃС‚РѕСЂРёРё', () => {
  it('РїРµР№Р»РѕР°Рґ СЃ РєСѓСЂСЃРѕСЂРѕРј в†’ merge Р±РµР· СЃР±СЂРѕСЃР° (РЅРµС‚ РїРѕР»РЅРѕР№ РїРµСЂРµСЃР±РѕСЂРєРё)', () => {
    expect(shouldFullRebuild({ fromVirtualF5: true, wasFull: true, hasCursor: true })).toBe(false);
  });

  it('РїРµР№Р»РѕР°Рґ Р±РµР· РєСѓСЂСЃРѕСЂР° в†’ rebuild (РїРѕР»РЅР°СЏ РїРµСЂРµСЃР±РѕСЂРєР°)', () => {
    expect(shouldFullRebuild({ fromVirtualF5: true, wasFull: true, hasCursor: false })).toBe(true);
  });

  it('РїРµСЂРµСЃР±РѕСЂРєР° С‚РѕР»СЊРєРѕ РґР»СЏ vf5 РїСЂРё СѓР¶Рµ РїРѕР»РЅРѕР№ Р±Р°Р·Рµ', () => {
    expect(shouldFullRebuild({ fromVirtualF5: false, wasFull: true, hasCursor: false })).toBe(false);
    expect(shouldFullRebuild({ fromVirtualF5: true, wasFull: false, hasCursor: false })).toBe(false);
  });
});

describe('Gemini РіР»РѕР±Р°Р»СЊРЅС‹Р№ РїРѕСЂСЏРґРѕРє СЃС‚СЂР°РЅРёС† РїР°РіРёРЅР°С†РёРё', () => {
  it('РґРІРµ СЃРёРЅС‚РµС‚РёС‡РµСЃРєРёРµ СЃС‚СЂР°РЅРёС†С‹ В«РЅРѕРІС‹Рµ СЃРІРµСЂС…СѓВ» в†’ С„РёРЅР°Р»СЊРЅР°СЏ С…СЂРѕРЅРѕР»РѕРіРёСЏ, messages[0]=СЃС‚Р°СЂС‹Р№ С…РѕРґ', () => {
    // passive (СЃРІРµР¶Р°СЏ СЃС‚СЂР°РЅРёС†Р°) РїСЂРёС…РѕРґРёС‚ РїРµСЂРІРѕР№, pag (СЃС‚Р°СЂС€Р°СЏ) вЂ” РїРѕСЃР»РµРґРЅРµР№.
    const pages = [
      { mode: 'fresh', turns: [{ id: 't3', text: 'С‚СЂРµС‚РёР№', role: 'assistant' }, { id: 't4', text: 'С‡РµС‚РІС‘СЂС‚С‹Р№', role: 'assistant' }] },
      { mode: 'older', turns: [{ id: 't1', text: 'РїРµСЂРІС‹Р№', role: 'user' }, { id: 't2', text: 'РІС‚РѕСЂРѕР№', role: 'assistant' }] }
    ];
    const ordered = orderPages(pages);
    expect(ordered.map(x => x.id)).toEqual(['t1', 't2', 't3', 't4']);
    expect(ordered[0].text).toBe('РїРµСЂРІС‹Р№');
  });

  it('РЅРµСЃРєРѕР»СЊРєРѕ СЃС‚Р°СЂС€РёС… СЃС‚СЂР°РЅРёС†: РєР°Р¶РґС‹Р№ РЅРѕРІС‹Р№ prepend РІСЃС‚Р°РІР»СЏРµС‚СЃСЏ РїРµСЂРµРґ РїСЂРµРґС‹РґСѓС‰РёРјРё', () => {
    const pages = [
      { mode: 'fresh', turns: [{ id: 'a5', text: '5', role: 'assistant' }] },
      { mode: 'older', turns: [{ id: 'a3', text: '3', role: 'user' }, { id: 'a4', text: '4', role: 'assistant' }] },
      { mode: 'older', turns: [{ id: 'a1', text: '1', role: 'user' }, { id: 'a2', text: '2', role: 'assistant' }] }
    ];
    const ordered = orderPages(pages);
    expect(ordered.map(x => x.id)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
  });

  it('РґРµРґСѓРїР»РёРєР°С†РёСЏ РїРѕ id: СЃРІРµР¶Р°СЏ РІСЃС‚СЂРµС‡Р° РїРѕР±РµР¶РґР°РµС‚', () => {
    const pages = [
      { mode: 'fresh', turns: [{ id: 'x1', text: 'СЃРІРµР¶РёР№', role: 'user' }] },
      { mode: 'older', turns: [{ id: 'x1', text: 'СЃС‚Р°СЂС€РёР№-РґСѓР±Р»СЊ', role: 'user' }, { id: 'x2', text: 'С…2', role: 'assistant' }] }
    ];
    const ordered = orderPages(pages);
    expect(ordered.map(x => x.id)).toEqual(['x2', 'x1']);
    expect(ordered[1].text).toBe('СЃРІРµР¶РёР№');
  });

  it('r1-СЃР°РјРѕРїСЂРѕРІРµСЂРєР° (2 СЃС‚СЂР°РЅРёС†С‹ РїРѕ 3 С…РѕРґР°): r1=СЃРѕСЃРµРґ РќРћР’Р•Р•, РЅР°С‡Р°Р»Рѕ=СЃР°РјС‹Р№ СЃС‚Р°СЂС‹Р№, РєРѕРЅРµС†=СЃР°РјС‹Р№ РЅРѕРІС‹Р№', () => {
    // r1 вЂ” СѓРєР°Р·Р°С‚РµР»СЊ РЅР° СЃРѕСЃРµРґРЅРёР№ Р‘РћР›Р•Р• РќРћР’Р«Р™ С…РѕРґ (РїРѕРґС‚РІРµСЂР¶РґРµРЅРѕ Р»РѕРіР°РјРё idmap).
    // РЎС‚Р°СЂС€Р°СЏ СЃС‚СЂР°РЅРёС†Р° (t1..t3), СЃРІРµР¶Р°СЏ СЃС‚СЂР°РЅРёС†Р° (t4..t6); РїСЂРёР±С‹С‚РёРµ РІ Р»СЋР±РѕРј РїРѕСЂСЏРґРєРµ.
    const pages = [
      { mode: 'fresh', turns: [
        { id: 't4', text: 'С…РѕРґ4', role: 'assistant', r1: 't5' },
        { id: 't5', text: 'С…РѕРґ5', role: 'assistant', r1: 't6' },
        { id: 't6', text: 'С…РѕРґ6', role: 'assistant', r1: null }
      ] },
      { mode: 'older', turns: [
        { id: 't1', text: 'С…РѕРґ1', role: 'user', r1: 't2' },
        { id: 't2', text: 'С…РѕРґ2', role: 'assistant', r1: 't3' },
        { id: 't3', text: 'С…РѕРґ3', role: 'assistant', r1: 't4' }
      ] }
    ];
    const ordered = orderPages(pages);
    expect(ordered.map(x => x.id)).toEqual(['t1', 't2', 't3', 't4', 't5', 't6']);
    // СЃР°РјРѕРїСЂРѕРІРµСЂРєР°: РґР»СЏ РєР°Р¶РґРѕР№ СЃРѕСЃРµРґРЅРµР№ РїР°СЂС‹ older.r1 === newer.id
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(ordered[i].r1).toBe(ordered[i + 1].id);
    }
    // РєСЂР°РµРІС‹Рµ С…РѕРґС‹
    expect(ordered[0].id).toBe('t1'); // СЃР°РјС‹Р№ СЃС‚Р°СЂС‹Р№
    expect(ordered[ordered.length - 1].id).toBe('t6'); // СЃР°РјС‹Р№ РЅРѕРІС‹Р№
    expect(ordered[ordered.length - 1].r1).toBeNull(); // СЃР°РјС‹Р№ РЅРѕРІС‹Р№ РЅРё РЅР° РєРѕРіРѕ РЅРµ СЃСЃС‹Р»Р°РµС‚СЃСЏ
  });
});

describe('Gemini СЂР°Р·РІРѕСЂРѕС‚ СЃС‹СЂРѕР№ СЃС‚СЂР°РЅРёС†С‹ (reverseRawTurnPage)', () => {
  it('СЃС‚СЂР°РЅРёС†Р° raw РЅРѕРІС‹Рµв†’СЃС‚Р°СЂС‹Рµ в†’ С„РёРЅР°Р»СЊРЅС‹Р№ РїРѕСЂСЏРґРѕРє С…СЂРѕРЅРѕР»РѕРіРёС‡РµСЃРєРёР№, user РїРµСЂРµРґ assistant', () => {
    // raw РІ РѕС‚РІРµС‚Рµ РёРґС‘С‚ В«РЅРѕРІС‹Рµв†’СЃС‚Р°СЂС‹РµВ». РІРЅСѓС‚СЂРё t2 (РїРѕСЃР»РµРґРЅРёР№ РїРѕ РІСЂРµРјРµРЅРё) user+assistant.
    const rawMsgs = [
      { id: 't2_assistant', turnId: 't2', role: 'assistant' },
      { id: 't2_user', turnId: 't2', role: 'user' },
      { id: 't1_assistant', turnId: 't1', role: 'assistant' },
      { id: 't1_user', turnId: 't1', role: 'user' }
    ];
    const out = reverseRawTurnPage(rawMsgs);
    expect(out.map(x => x.id)).toEqual(['t1_user', 't1_assistant', 't2_user', 't2_assistant']);
    // user РїРµСЂРµРґ assistant РІРЅСѓС‚СЂРё РєР°Р¶РґРѕРіРѕ С…РѕРґР°
    expect(out[0].id).toBe('t1_user');
    expect(out[2].id).toBe('t2_user');
  });
});

describe('Gemini РІРЅСѓС‚СЂРёСЃС‚СЂР°РЅРёС‡РЅС‹Р№ r1-РїРѕСЂСЏРґРѕРє (orderPageByR1)', () => {
  it('(Р°) СЃС‚СЂР°РЅРёС†Р° СЃ r1-С†РµРїРѕС‡РєРѕР№ в†’ oldв†’new, user РїРµСЂРµРґ assistant', () => {
    // r1 = СЃРѕСЃРµРґ РЎРўРђР РЁР•. newest = t3 (id РЅРµ РІСЃС‚СЂРµС‡Р°РµС‚СЃСЏ РєР°Рє r1 РІ СЃС‚СЂР°РЅРёС†Рµ).
    // С†РµРїРѕС‡РєР° t3в†’t2в†’t1 (newestв†’oldest) в†’ СЂР°Р·РІРѕСЂРѕС‚ t1,t2,t3.
    const page = [
      { id: 't3_assistant', turnId: 't3', r1: 't2', role: 'assistant' },
      { id: 't2_assistant', turnId: 't2', r1: 't1', role: 'assistant' },
      { id: 't1_user', turnId: 't1', r1: null, role: 'user' },
      { id: 't1_assistant', turnId: 't1', r1: null, role: 'assistant' }
    ];
    const r = orderPageByR1(page);
    expect(r.ok).toBe(true);
    expect(r.ids).toEqual(['t1_user', 't1_assistant', 't2_assistant', 't3_assistant']);
  });

  it('(Р°) restored-Р»РµРЅС‚Р° [РЅРѕРІС‹Рµ->СЃС‚Р°СЂС‹Рµ] СЃ r1 в†’ [СЃС‚Р°СЂС‹Рµ->РЅРѕРІС‹Рµ], messages[0]=user СЃ r1=null', () => {
    // r1 СѓРєР°Р·С‹РІР°РµС‚ РЅР° РџР Р•Р”Р«Р”РЈР©РР™ (Р±РѕР»РµРµ СЃС‚Р°СЂС‹Р№) С…РѕРґ; Сѓ РєРѕСЂРЅСЏ r1=null (РїРµСЂРІР°СЏ РїР°СЂР° user+assistant).
    // Р›РµРЅС‚Р° newв†’old: t3в†’t2, t2в†’t1, t1(r1=null). Р’РЅСѓС‚СЂРё С…РѕРґР° assistant-first.
    const tape = [
      { id: 't3_assistant', role: 'assistant', r1: 't2' },
      { id: 't3_user', role: 'user', r1: 't2' },
      { id: 't2_assistant', role: 'assistant', r1: 't1' },
      { id: 't2_user', role: 'user', r1: 't1' },
      { id: 't1_assistant', role: 'assistant', r1: null },
      { id: 't1_user', role: 'user', r1: null }
    ];
    expect(orderRestoredTape(tape)).toEqual([
      't1_user', 't1_assistant', 't2_user', 't2_assistant', 't3_user', 't3_assistant'
    ]);
    // messages[0] = user СЃ r1=null (РїРµСЂРІС‹Р№ РїСЂРѕРјС‚)
    expect(orderRestoredTape(tape)[0]).toBe('t1_user');
  });

  it('(Р±) restored-Р±Р»РѕРє prepend + СЂР°Р·РІРѕСЂРѕС‚ (orderRestoredTape)', () => {
    // Р»РµРЅС‚Р° С…СЂР°РЅРёС‚СЃСЏ newв†’old
    const tape = [
      { id: 'r3', role: 'assistant' },
      { id: 'r2', role: 'assistant' },
      { id: 'r1', role: 'user' }
    ];
    expect(orderRestoredTape(tape)).toEqual(['r1', 'r2', 'r3']);
  });

  it('(РІ) РёРЅРІР°СЂРёР°РЅС‚ inversions=0 (r1=СЃС‚Р°СЂС€Рµ РёРґС‘С‚ СЂР°РЅСЊС€Рµ)', () => {
    // С„РёРЅР°Р»СЊРЅС‹Р№ РїРѕСЂСЏРґРѕРє oldв†’new: t1(СЃС‚Р°СЂС‹Р№) в†’ t2 в†’ t3(РЅРѕРІС‹Р№). r1 СѓРєР°Р·С‹РІР°РµС‚ РЅР° СЃС‚Р°СЂС€РµРіРѕ.
    const items = [
      { id: 't1_user', turnId: 't1', r1: null },
      { id: 't2_assistant', turnId: 't2', r1: 't1' },
      { id: 't3_assistant', turnId: 't3', r1: 't2' }
    ];
    expect(countR1Inversions(items)).toBe(0);

    // РїРµСЂРµРІС‘СЂРЅСѓС‚С‹Р№ РїРѕСЂСЏРґРѕРє в†’ 2 РёРЅРІРµСЂСЃРёРё (t3 СЂР°РЅСЊС€Рµ t2; t2 СЂР°РЅСЊС€Рµ t1)
    const rev = [items[2], items[1], items[0]];
    expect(countR1Inversions(rev)).toBe(2);
  });
});

describe('Gemini РїРѕСЂСЏРґРѕРє РїРѕ РїСЂРёР±С‹С‚РёСЋ СЃС‚СЂР°РЅРёС† (orderByArrival)', () => {
  it('3 СЃС‚СЂР°РЅРёС†С‹ РІ РїРѕСЂСЏРґРєРµ РїСЂРёР±С‹С‚РёСЏ в†’ С„РёРЅР°Р»СЊРЅС‹Р№ РїРѕСЂСЏРґРѕРє = РїРѕСЂСЏРґРѕРє РїСЂРёР±С‹С‚РёСЏ', () => {
    // passive (СЃРІРµР¶Р°СЏ) в†’ pag (СЃС‚Р°СЂС€Р°СЏ) в†’ vf5 (СЃРІРµР¶Р°СЏ). order РѕС‚СЂР°Р¶Р°РµС‚ РїСЂРёР±С‹С‚РёРµ.
    const items = [
      { id: 'p1_user', turnId: 'p1', r1: null, order: 0, role: 'user' },
      { id: 'p2_assistant', turnId: 'p2', r1: null, order: 1, role: 'assistant' },
      { id: 'g1_user', turnId: 'g1', r1: null, order: 2, role: 'user' },
      { id: 'g2_assistant', turnId: 'g2', r1: null, order: 3, role: 'assistant' },
      { id: 'v1_user', turnId: 'v1', r1: null, order: 4, role: 'user' },
      { id: 'v2_assistant', turnId: 'v2', r1: null, order: 5, role: 'assistant' }
    ];
    const r = orderByArrival(items);
    expect(r.ok).toBe(true);
    expect(r.ids).toEqual(['p1_user', 'p2_assistant', 'g1_user', 'g2_assistant', 'v1_user', 'v2_assistant']);
  });

  it('РІРЅСѓС‚СЂРё С…РѕРґР° user РїРµСЂРµРґ assistant (РїРѕСЂСЏРґРѕРє СЃРѕРѕР±С‰РµРЅРёР№ СЃС‚Р°Р±РёР»РµРЅ)', () => {
    const items = [
      { id: 't1_assistant', turnId: 't1', r1: null, order: 0, role: 'assistant' },
      { id: 't1_user', turnId: 't1', r1: null, order: 0, role: 'user' }
    ];
    const r = orderByArrival(items);
    expect(r.ok).toBe(true);
    expect(r.ids).toEqual(['t1_user', 't1_assistant']);
  });

  it('РґСѓР±Р»РёРєР°С‚ order Сѓ СЂР°Р·РЅС‹С… turn\'РѕРІ в†’ ok=false (РґРµС‚РµСЂРјРёРЅРёСЂРѕРІР°РЅРЅРѕСЃС‚СЊ РЅР°СЂСѓС€РµРЅР°)', () => {
    const items = [
      { id: 'a_user', turnId: 'a', r1: null, order: 1, role: 'user' },
      { id: 'b_assistant', turnId: 'b', r1: null, order: 1, role: 'assistant' }
    ];
    const r = orderByArrival(items);
    expect(r.ok).toBe(false);
  });
});

describe('Gemini С„РёРєСЃ РїРµСЂРІРѕРіРѕ РїСЂРѕРјС‚Р°: reachedStart + protobuf-СЃС‚СЂР°РЅРёС†Р°', () => {
  it('(Р°) reachedStart=false в†’ restored-Р»РµРЅС‚Р° РјРµСЂРґР¶РёС‚СЃСЏ РќР•Р—РђР’РРЎРРњРћ РѕС‚ baseComplete/historyFullByQuiet', () => {
    expect(shouldMergeRestoredTurns(false)).toBe(true);
    expect(shouldMergeRestoredTurns(undefined)).toBe(true);
    expect(shouldMergeRestoredTurns(true)).toBe(false);
  });

  it('protobuf-СЃРєРµР»РµС‚ (С‡РёСЃР»Р°/РјР°СЃСЃРёРІС‹ Р±РµР· СЃС‚СЂРѕРє) СЂР°СЃРїРѕР·РЅР°С‘С‚СЃСЏ', () => {
    // buildJsonSkeleton СЃРµСЂРёР°Р»РёР·СѓРµС‚ РЅРµРїР°СЂСЃСЏС‰СѓСЋСЃСЏ protobuf-СЃС‚СЂР°РЅРёС†Сѓ РєР°Рє
    // {arr:N, items:[С‡РёСЃР»Р°/РјР°СЃСЃРёРІС‹]} вЂ” Р±РµР· РµРґРёРЅРѕР№ СЃС‚СЂРѕРєРё С‚РµРєСЃС‚Р° С…РѕРґР°.
    const skel = { arr: 2, items: [ { arr: 3, items: [1, 2, 3] }, 0, null ] };
    expect(isProtobufSkeleton(skel)).toBe(true);
  });

  it('РќР• protobuf-СЃРєРµР»РµС‚ (РµСЃС‚СЊ СЃС‚СЂРѕРєР°-С‚РµРєСЃС‚) РЅРµ СЂР°СЃРїРѕР·РЅР°С‘С‚СЃСЏ', () => {
    const skel = { arr: 1, items: [{ arr: 2, items: ['s12: РєР°РєРѕР№-С‚Рѕ С‚РµРєСЃС‚'] }] };
    expect(isProtobufSkeleton(skel)).toBe(false);
  });

  it('effectiveReachedStart=false РєРѕРіРґР° РїРѕСЃР»РµРґРЅРёР№ С€Р°Рі РІРµСЂРЅСѓР» 0 С…РѕРґРѕРІ', () => {
    expect(effectiveReachedStart(true, 0, null)).toBe(false);
  });

  it('effectiveReachedStart=false РєРѕРіРґР° СЃРѕС…СЂР°РЅС‘РЅ protobuf-СЃРєРµР»РµС‚ (РґР°Р¶Рµ РїСЂРё added>0)', () => {
    const skel = { arr: 2, items: [{ arr: 3, items: [1, 2, 3] }, null] };
    expect(effectiveReachedStart(true, 1, skel)).toBe(false);
  });

  it('effectiveReachedStart=true С‚РѕР»СЊРєРѕ РїСЂРё С„Р»Р°РіРµ + РґРѕР±Р°РІР»РµРЅРЅС‹С… С…РѕРґР°С… Р±РµР· protobuf-СЃРєРµР»РµС‚Р°', () => {
    expect(effectiveReachedStart(true, 3, null)).toBe(true);
    expect(effectiveReachedStart(false, 3, null)).toBe(false);
  });
});

describe('Gemini СЃР°РЅР°С†РёСЏ Рё РґРµРґСѓРї С„РёРЅР°Р»СЊРЅРѕРіРѕ messages (sanitizeFinalMessages)', () => {
  function helpers() {
    const parser = require('../../utils/gemini-batchexecute-parser');
    return {
      isThinkingAssistant: function (s) { return parser.isThinkingAssistant(s); },
      stripLeadingThinking: function (s) { return parser.stripLeadingThinking(s); }
    };
  }

  it('(РІ) С‡РёСЃС‚Рѕ Р°РЅРіР»РёР№СЃРєРѕРµ РјС‹С€Р»РµРЅРёРµ РїРѕР»РЅРѕСЃС‚СЊСЋ РІС‹СЂРµР·Р°РµС‚СЃСЏ РёР· messages', () => {
    const h = helpers();
    const input = [
      { role: 'user', text: 'РџСЂРёРІРµС‚' },
      { role: 'assistant', text: 'Assessing the Core Task' }, // С‡РёСЃС‚С‹Р№ thinking
      { role: 'assistant', text: "I'm now zeroing in on the structure." }, // С‡РёСЃС‚С‹Р№ thinking
      { role: 'assistant', text: 'Р’РѕС‚ РѕС‚РІРµС‚.' }
    ];
    const out = sanitizeFinalMessages(input, h);
    expect(out.map(m => m.text)).toEqual(['РџСЂРёРІРµС‚', 'Р’РѕС‚ РѕС‚РІРµС‚.']);
    expect(out.every(m => !(/Assessing|zeroing in/).test(m.text))).toBe(true);
  });

  it('СЃРјРµС€Р°РЅРЅС‹Р№ Р±Р»РѕРє СЃСЂРµР·Р°РµС‚СЃСЏ РґРѕ РїРµСЂРІРѕРіРѕ РєРёСЂРёР»Р»РёС‡РµСЃРєРѕРіРѕ СЃРёРјРІРѕР»Р°', () => {
    const h = helpers();
    const input = [
      { role: 'assistant', text: 'Assessing the Core Task\nР’РѕС‚ РёС‚РѕРіРѕРІС‹Р№ РѕС‚РІРµС‚.' }
    ];
    const out = sanitizeFinalMessages(input, h);
    expect(out[0].text).toBe('Р’РѕС‚ РёС‚РѕРіРѕРІС‹Р№ РѕС‚РІРµС‚.');
  });

  it('(Р±) РґСѓР±Р»РёРєР°С‚С‹ assistant РїРѕРґСЂСЏРґ РїРѕ text РёР»Рё id вЂ” РЅР° РІС‹С…РѕРґРµ С‚РѕР»СЊРєРѕ СѓРЅРёРєР°Р»СЊРЅС‹Рµ', () => {
    const input = [
      { role: 'user', text: 'Р’РѕРїСЂРѕСЃ', id: 't1_user' },
      { role: 'assistant', text: 'РћС‚РІРµС‚', id: 't1_assistant' },
      { role: 'assistant', text: 'РћС‚РІРµС‚', id: 't1_assistant' }, // РґСѓР±Р»СЊ РїРѕ text+id
      { role: 'assistant', text: 'РћС‚РІРµС‚ 2', id: 't2_assistant' },
      { role: 'assistant', text: 'РћС‚РІРµС‚ 2', id: 't3_assistant' } // РґСѓР±Р»СЊ РїРѕ text (СЂР°Р·РЅС‹Рµ id)
    ];
    const out = sanitizeFinalMessages(input);
    expect(out.map(m => m.text)).toEqual(['Р’РѕРїСЂРѕСЃ', 'РћС‚РІРµС‚', 'РћС‚РІРµС‚ 2']);
    expect(out.length).toBe(3);
  });
});

describe('Gemini fallback РїРѕ СЃРІСЏР·РЅРѕРјСѓ СЃРїРёСЃРєСѓ r1 (orderByR1Chain)', () => {
  // r1 = id РЎРўРђР РЁР•Р“Рћ СЃРѕСЃРµРґР°. РСЃРїРѕР»СЊР·СѓРµС‚СЃСЏ РўРћР›Р¬РљРћ РєР°Рє fallback РїСЂРё СЂР°Р·СЂС‹РІР°С… РїСЂРёР±С‹С‚РёСЏ.
  it('С†РµРїРѕС‡РєР° СЃРєРІРѕР·СЊ РіСЂР°РЅРёС†С‹ СЃС‚СЂР°РЅРёС†: head РЅР°Р№РґС‘С‚СЃСЏ (СЃР°РјС‹Р№ РЅРѕРІС‹Р№), РїРѕСЂСЏРґРѕРє С…СЂРѕРЅРѕР»РѕРіРёС‡РµСЃРєРёР№', () => {
    // 6 С…РѕРґРѕРІ: t6(РЅРѕРІС‹Р№) в†’ t5 в†’ ... в†’ t1(СЃС‚Р°СЂС‹Р№). r1 СѓРєР°Р·С‹РІР°РµС‚ РЅР° СЃС‚Р°СЂС€РµРіРѕ.
    const items = [
      { id: 't3_assistant', turnId: 't3', r1: 't2' },
      { id: 't6_assistant', turnId: 't6', r1: 't5' },
      { id: 't1_user', turnId: 't1', r1: null },
      { id: 't4_assistant', turnId: 't4', r1: 't3' },
      { id: 't2_assistant', turnId: 't2', r1: 't1' },
      { id: 't5_assistant', turnId: 't5', r1: 't4' }
    ];
    const r = orderByR1Chain(items);
    expect(r.ok).toBe(true);
    expect(r.ids).toEqual(['t1_user', 't2_assistant', 't3_assistant', 't4_assistant', 't5_assistant', 't6_assistant']);
  });

  it('РЅРµС‚ head (РІСЃРµ С…РѕРґС‹ вЂ” r1-С†РµР»Рё, С†РёРєР») в†’ ok=false, С„РѕР»Р±СЌРє РЅРµ РїР°РґР°РµС‚', () => {
    const items = [
      { id: 'a_user', turnId: 'a', r1: 'b' },
      { id: 'b_assistant', turnId: 'b', r1: 'a' }
    ];
    const r = orderByR1Chain(items);
    expect(r.ok).toBe(false);
    expect(r.ids).toEqual([]);
  });
});

describe('Gemini restored-Р»РµРЅС‚Р°: РІРµСЂСЃРёРѕРЅРёСЂРѕРІР°РЅРёРµ, Р°РІС‚РѕСЂРёС‚РµС‚ РїРѕ id, РїРѕСЂСЏРґРѕРє РїРѕ r1', () => {
  it('РєР»СЋС‡ Р»РµРЅС‚С‹ РІРєР»СЋС‡Р°РµС‚ РІРµСЂСЃРёСЋ РїР°СЂСЃРµСЂР°', () => {
    expect(tapeStorageKey('conv_1', 'g3')).toBe('ai-cm-gemini-tape-g3-conv_1');
    expect(tapeStorageKey('conv_1', 'g3')).not.toBe(tapeStorageKey('conv_1', 'g2'));
    expect(tapeVersionOf({ meta: { version: 'g3' } })).toBe('g3');
    expect(tapeVersionOf({})).toBe('');
  });

  it('(Р°) РїСЂРѕС‚СѓС…С€Р°СЏ Р»РµРЅС‚Р°: РІРµСЂСЃРёСЏ Р·Р°РїРёСЃРё в‰  С‚РµРєСѓС‰РµР№ в†’ РёРіРЅРѕСЂРёСЂСѓРµС‚СЃСЏ Р±РµР· РјРёРіСЂР°С†РёРё', () => {
    expect(shouldAcceptTape({ meta: { version: 'g2' } }, 'g3')).toBe(false);
    expect(shouldAcceptTape({ meta: {} }, 'g3')).toBe(false);
    expect(shouldAcceptTape(null, 'g3')).toBe(false);
    expect(shouldAcceptTape({ meta: { version: 'g3' } }, 'g3')).toBe(true);
    expect(shouldAcceptTape({ meta: { version: 'g3' } }, '')).toBe(false);
  });

  it('(Р°) СЃРµС‚СЊ Р°РІС‚РѕСЂРёС‚РµС‚РЅР° РїРѕ id: СЃРµС‚РµРІРѕР№ С…РѕРґ РїРµСЂРµР·Р°РїРёСЃС‹РІР°РµС‚ restored С‚РѕРіРѕ Р¶Рµ id (С‚РµРєСЃС‚/СЂРѕР»СЊ), missing С‚РѕР»СЊРєРѕ РґР»СЏ РѕС‚СЃСѓС‚СЃС‚РІСѓСЋС‰РёС…', () => {
    const network = [
      { id: 'r_5341_user', turnId: 'r_5341', r1: null, order: 0, role: 'user', text: 'СЃРµС‚РµРІРѕР№-РІРѕРїСЂРѕСЃ' },
      { id: 'r_5341_assistant', turnId: 'r_5341', r1: null, order: 1, role: 'assistant', text: 'СЃРµС‚РµРІРѕР№-РѕС‚РІРµС‚' },
      { id: 'r_5342_assistant', turnId: 'r_5342', r1: 'r_5341', order: 2, role: 'assistant', text: 'СЃРµС‚РµРІРѕР№-РѕС‚РІРµС‚-2' }
    ];
    const restored = [
      { id: 'r_5341_user', text: 'RU_ANSWER + EN_THINKING + RU_ANSWER', role: 'user', r1: null },
      { id: 'r_5341_assistant', text: 'STALE-DUP', role: 'assistant', r1: null },
      { id: 'r_5342_assistant', text: 'STALE-DUP-2', role: 'assistant', r1: 'r_5341' },
      { id: 'r_old_missing_user', text: 'РЅРµРґРѕСЃС‚Р°СЋС‰РёР№ РїСЂРѕРјС‚', role: 'user', r1: null }
    ];
    const r = mergeRestoredTurns(network, restored);
    expect(r.missingCount).toBe(1);
    const ids = r.items.map(x => x.id);
    expect(ids).toContain('r_5341_user');
    expect(ids).toContain('r_5341_assistant');
    expect(ids).toContain('r_5342_assistant');
    expect(ids).toContain('r_old_missing_user');
    // СЃРµС‚РµРІРѕР№ С‚РµРєСЃС‚ РЅРµ РїРµСЂРµС‚С‘СЂС‚ restored-РґСѓР±Р»РµРј
    expect(r.items.find(x => x.id === 'r_5341_user').text).toBe('СЃРµС‚РµРІРѕР№-РІРѕРїСЂРѕСЃ');
    expect(r.items.find(x => x.id === 'r_5342_assistant').text).toBe('СЃРµС‚РµРІРѕР№-РѕС‚РІРµС‚-2');
  });

  it('(Р°) С„РёРЅР°Р»СЊРЅС‹Р№ РїРѕСЂСЏРґРѕРє РїРѕ r1-С†РµРїРѕС‡РєРµ РѕР±СЉРµРґРёРЅРµРЅРёСЏ: inversions=0, РіРѕР»РѕРІР° r_5341 (user РїРµСЂРµРґ assistant)', () => {
    const items = [
      { id: 'r_5341_user', turnId: 'r_5341', r1: null, order: 0, role: 'user', text: 'СЂРµС†РµРїС‚-user' },
      { id: 'r_5341_assistant', turnId: 'r_5341', r1: null, order: 1, role: 'assistant', text: 'СЂРµС†РµРїС‚-assistant' },
      { id: 'r_5342_assistant', turnId: 'r_5342', r1: 'r_5341', order: 2, role: 'assistant', text: 'РѕС‚РІРµС‚-2' },
      { id: 'r_5343_assistant', turnId: 'r_5343', r1: 'r_5342', order: 3, role: 'assistant', text: 'РѕС‚РІРµС‚-3' }
    ];
    const r = orderByR1Chain(items);
    expect(r.ok).toBe(true);
    expect(r.ids).toEqual(['r_5341_user', 'r_5341_assistant', 'r_5342_assistant', 'r_5343_assistant']);
    expect(r.ids[0]).toBe('r_5341_user'); // РіРѕР»РѕРІР° = r_5341, user РїРµСЂРІС‹Рј
    const invItems = r.ids.map(id => items.find(x => x.id === id));
    expect(countR1Inversions(invItems)).toBe(0);
  });

  it('(Р±) protobuf-С…РІРѕСЃС‚ (РІ СЃРµС‚Рё РЅРµС‚ r1=null) + Р»РµРЅС‚Р° С‚РµРєСѓС‰РµР№ РІРµСЂСЃРёРё в†’ РјРµСЂРґР¶РёС‚СЃСЏ С‚РѕР»СЊРєРѕ РЅРµРґРѕСЃС‚Р°СЋС‰РµРµ, РїРѕСЂСЏРґРѕРє РїРѕ r1, inversions=0', () => {
    // РЎРµС‚СЊ РѕС‚РґР°Р»Р° r1-С†РµРїРѕС‡РєСѓ Р±РµР· РєРѕСЂРЅСЏ (r_5341 РѕС‚СЃСѓС‚СЃС‚РІСѓРµС‚) вЂ” protobuf-С…РІРѕСЃС‚; Р»РµРЅС‚Р° РІРµСЂСЃРёРё g3.
    expect(shouldAcceptTape({ meta: { version: 'g3' } }, 'g3')).toBe(true);
    expect(shouldMergeRestoredTurns(false)).toBe(true);

    const network = [
      { id: 'r_5343_assistant', turnId: 'r_5343', r1: 'r_5342', order: 0, role: 'assistant', text: 'РѕС‚РІРµС‚-3' },
      { id: 'r_5342_assistant', turnId: 'r_5342', r1: 'r_5341', order: 1, role: 'assistant', text: 'РѕС‚РІРµС‚-2' }
    ];
    const restored = [
      { id: 'r_5342_assistant', text: 'Р”РЈР‘Р›Р¬ Р›Р•РќРўР«', role: 'assistant', r1: 'r_5341' },      // СЃРµС‚СЊ Р°РІС‚РѕСЂРёС‚РµС‚РЅР°
      { id: 'r_5341_user', text: 'РЅРµРґРѕСЃС‚Р°СЋС‰РёР№ РїСЂРѕРјС‚', role: 'user', r1: null },               // missing
      { id: 'r_5341_assistant', text: 'РЅРµРґРѕСЃС‚Р°СЋС‰РёР№ РѕС‚РІРµС‚', role: 'assistant', r1: null }       // missing
    ];
    const merged = mergeRestoredTurns(network, restored);
    expect(merged.missingCount).toBe(2);
    // r_5342_assistant РѕСЃС‚Р°Р»СЃСЏ РѕС‚ РЎР•РўР вЂ” restored-РґСѓР±Р»СЊ РЅРµ РґРѕР»Р¶РµРЅ РµРіРѕ РїРµСЂРµС‚РµСЂРµС‚СЊ
    expect(merged.items.find(x => x.id === 'r_5342_assistant').text).toBe('РѕС‚РІРµС‚-2');

    const r = orderByR1Chain(merged.items);
    expect(r.ok).toBe(true);
    expect(r.ids).toEqual(['r_5341_user', 'r_5341_assistant', 'r_5342_assistant', 'r_5343_assistant']);
    const invItems = r.ids.map(id => merged.items.find(x => x.id === id));
    expect(countR1Inversions(invItems)).toBe(0);
  });
});

describe('Gemini РґРµС‚РµРєС‚РѕСЂ РіРѕС‚РѕРІРЅРѕСЃС‚Рё DOM РїРµСЂРµРґ Р°РІС‚РѕСЃРєСЂРѕР»Р»РѕРј (advanceReadiness)', () => {
  it('С„РёРєСЃС‚СѓСЂР° В«Р»РµРЅРёРІР°СЏ РїРѕРґРіСЂСѓР·РєР°В»: scrollHeight СЂР°СЃС‚С‘С‚ в†’ РіРѕС‚РѕРІРЅРѕСЃС‚СЊ РїРѕ СЃС‚Р°Р±РёР»РёР·Р°С†РёРё 2 Р·Р°РјРµСЂРѕРІ', () => {
    // elements===expected РЅРµ РІС‹РїРѕР»РЅСЏРµС‚СЃСЏ (expected=20, СЌР»РµРјРµРЅС‚РѕРІ в‰¤10), РїРѕСЌС‚РѕРјСѓ РєСЂРёС‚РµСЂРёР№
    // РіРѕС‚РѕРІРЅРѕСЃС‚Рё вЂ” СЃС‚Р°Р±РёР»РёР·Р°С†РёСЏ РґРІСѓС… РїРѕСЃР»РµРґРЅРёС… Р·Р°РјРµСЂРѕРІ scrollHeight (СЂР°Р·РЅРёС†Р° < 100).
    const state = newDomReadiness();
    expect(state.samples).toEqual([]);

    let r = advanceReadiness(state, 1000, 3, 20);
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('pending');

    r = advanceReadiness(state, 1900, 5, 20);
    expect(r.ready).toBe(false);

    r = advanceReadiness(state, 3100, 7, 20);
    expect(r.ready).toBe(false);

    // РїРѕСЃР»РµРґРЅРёРµ 2 = [3100, 3150], СЂР°Р·РЅРёС†Р° 50 < 100 в†’ СЃС‚Р°Р±РёР»СЊРЅРѕ
    r = advanceReadiness(state, 3150, 9, 20);
    expect(r.ready).toBe(true);
    expect(r.reason).toMatch(/^stable:/);
  });

  it('СЃС‚Р°Р±РёР»РёР·Р°С†РёСЏ scrollHeight (2 Р·Р°РјРµСЂР°, СЂР°Р·РЅРёС†Р° < 100px) в†’ ready=true', () => {
    const state = newDomReadiness();
    let r = advanceReadiness(state, 2000, 1, 20);
    expect(r.ready).toBe(false);
    r = advanceReadiness(state, 2050, 2, 20); // СЂР°Р·РЅРёС†Р° 50 < 100
    expect(r.ready).toBe(true);
    expect(r.reason).toBe('stable:2000-2050');
  });

  it('elements>10 РіРѕС‚РѕРІРѕ РўРћР›Р¬РљРћ РєРѕРіРґР° elements===expected', () => {
    const state = newDomReadiness();
    const r = advanceReadiness(state, 1200, 11, 11);
    expect(r.ready).toBe(true);
    expect(r.reason).toBe('elements:11');
  });

  it('elements>10, РЅРѕ elements !== expected в†’ РќР• РіРѕС‚РѕРІ РїРѕ СЌР»РµРјРµРЅС‚Р°Рј (Р¶РјС‘С‚ СЃС‚Р°Р±РёР»РёР·Р°С†РёСЋ)', () => {
    const state = newDomReadiness();
    const r = advanceReadiness(state, 1200, 11, 5);
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('pending');
  });

  it('СЌР»РµРјРµРЅС‚РѕРІ в‰¤ 10 Рё scrollHeight РЅРµ СЃС‚Р°Р±РёР»РёР·РёСЂРѕРІР°Р»СЃСЏ в†’ ready=false', () => {
    const state = newDomReadiness();
    advanceReadiness(state, 1000, 5, 20);
    advanceReadiness(state, 1600, 8, 20);
    const r = advanceReadiness(state, 2200, 10, 20);
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('pending');
  });

  it('РґРµСЂР¶РёС‚ РЅРµ Р±РѕР»РµРµ 3 РїРѕСЃР»РµРґРЅРёС… Р·Р°РјРµСЂРѕРІ РІ samples', () => {
    const state = newDomReadiness();
    advanceReadiness(state, 1000, 1, 20);
    advanceReadiness(state, 1100, 2, 20);
    advanceReadiness(state, 1200, 3, 20);
    advanceReadiness(state, 1300, 4, 20);
    expect(state.samples).toEqual([1100, 1200, 1300]);
  });
});

describe('Gemini РїСЂРёС‡РёРЅР° РЅСѓР»РµРІРѕРіРѕ РїРѕР»Р° (diagnoseFloorAbsence)', () => {
  it('РґРёР°РіРЅРѕСЃС‚РёСЂСѓРµС‚ РѕС‚СЃСѓС‚СЃС‚РІРёРµ СЃРѕС…СЂР°РЅС‘РЅРЅРѕРіРѕ РїРѕР»Р° Рё РЅРµРІРµСЂРЅСѓСЋ РІРµСЂСЃРёСЋ', () => {
    const storage = makeStorage();
    expect(diagnoseFloorAbsence('', 'g3', storage)).toBe('no-conv');
    expect(diagnoseFloorAbsence('conv_1', 'g3', storage)).toBe('no-floor-saved');
    // РґР°Р¶Рµ РїРѕРґ РЅРѕРІС‹Рј РєР»СЋС‡РѕРј РІСЂСѓС‡РЅСѓСЋ Р·Р°РїРёС€РµРј РґСЂСѓРіРѕР№ РІРµСЂСЃРёРё в†’ version-mismatch
    storage.setItem(floorStorageKey('conv_1', 'g3'), JSON.stringify({ count: 10, effectiveLen: 100, version: 'g2' }));
    expect(diagnoseFloorAbsence('conv_1', 'g3', storage)).toBe('version-mismatch-or-invalid');
    storage.setItem(floorStorageKey('conv_1', 'g3'), JSON.stringify({ count: 0, effectiveLen: 0, version: 'g3' }));
    expect(diagnoseFloorAbsence('conv_1', 'g3', storage)).toBe('floor-count-zero');
    storage.setItem(floorStorageKey('conv_1', 'g3'), JSON.stringify({ count: 10, effectiveLen: 100, version: 'g3' }));
    expect(diagnoseFloorAbsence('conv_1', 'g3', storage)).toBe('ok');
  });
});

describe('Gemini С‚РёС€РёРЅР° vf5-РїРѕР»Р»РµСЂР° РїСЂРё РїРѕР»РЅРѕР№ РёСЃС‚РѕСЂРёРё (shouldPollVf5)', () => {
  it('РїРѕР»РЅР°СЏ РёСЃС‚РѕСЂРёСЏ + reachedStart + Р°РєС‚РёРІРЅРѕСЃС‚Рё РЅРµ Р±С‹Р»Рѕ 60СЃ в†’ РЅРµ РїРѕР»Р»РёС‚СЊ', () => {
    const now = 200000;
    expect(shouldPollVf5({ baseComplete: true, reachedStart: true, lastActivityAt: now - 60000 }, now)).toBe(false);
    expect(shouldPollVf5({ baseComplete: true, reachedStart: true, lastActivityAt: now - 120000 }, now)).toBe(false);
  });

  it('РїРѕР»РЅР°СЏ РёСЃС‚РѕСЂРёСЏ + reachedStart, РЅРѕ Р°РєС‚РёРІРЅРѕСЃС‚СЊ Р±С‹Р»Р° РЅРµРґР°РІРЅРѕ в†’ РїРѕР»Р»РёС‚СЊ', () => {
    const now = 200000;
    expect(shouldPollVf5({ baseComplete: true, reachedStart: true, lastActivityAt: now - 59999 }, now)).toBe(true);
    expect(shouldPollVf5({ baseComplete: true, reachedStart: true, lastActivityAt: now }, now)).toBe(true);
  });

  it('Р°РєС‚РёРІРЅРѕСЃС‚СЊ < 60СЃ РёР»Рё СЂРѕРІРЅРѕ 0 в†’ РїРѕР»Р»РёС‚СЊ (Р»СЋР±РѕРµ СЃРѕР±С‹С‚РёРµ СЃРЅРёРјР°РµС‚ С‚РёС€РёРЅСѓ)', () => {
    const now = 200000;
    expect(shouldPollVf5({ baseComplete: true, reachedStart: true, lastActivityAt: now - 1 }, now)).toBe(true);
    expect(shouldPollVf5({ baseComplete: true, reachedStart: true, lastActivityAt: now }, now)).toBe(true);
  });

  it('РёСЃС‚РѕСЂРёСЏ РќР• РїРѕР»РЅР°СЏ РёР»Рё РќР• reachedStart в†’ РїРѕР»Р»РёС‚СЊ РЅРµР·Р°РІРёСЃРёРјРѕ РѕС‚ РїСЂРѕСЃС‚РѕСЏ', () => {
    const now = 200000;
    const stale = now - 60000;
    expect(shouldPollVf5({ baseComplete: false, reachedStart: true, lastActivityAt: stale }, now)).toBe(true);
    expect(shouldPollVf5({ baseComplete: true, reachedStart: false, lastActivityAt: stale }, now)).toBe(true);
    expect(shouldPollVf5({ baseComplete: false, reachedStart: false, lastActivityAt: stale }, now)).toBe(true);
  });

  it('РїСѓСЃС‚РѕРµ СЃРѕСЃС‚РѕСЏРЅРёРµ / РѕС‚СЃСѓС‚СЃС‚РІРёРµ lastActivityAt в†’ РїРѕР»Р»РёС‚СЊ (РіСЂР°РЅРёС‡РЅС‹Р№ СЃР»СѓС‡Р°Р№)', () => {
    expect(shouldPollVf5({}, 200000)).toBe(true);
    expect(shouldPollVf5(null, 200000)).toBe(true);
  });
});

describe('Gemini retry-Р»РѕРіРёРєР° Р°РІС‚РѕСЃРєСЂРѕР»Р»Р° (shouldRetryAutoscroll)', () => {
  it('С„Р°РєС‚ < РѕР¶РёРґР°РµРјРѕРіРѕ в†’ РЅСѓР¶РµРЅ retry, РїРѕРєР° РЅРµ РёСЃС‡РµСЂРїР°РЅ Р»РёРјРёС‚', () => {
    expect(shouldRetryAutoscroll(50, 100, 0, 2)).toBe(true);
    expect(shouldRetryAutoscroll(50, 100, 1, 2)).toBe(true);
    expect(shouldRetryAutoscroll(50, 100, 2, 2)).toBe(false); // Р»РёРјРёС‚ РёСЃС‡РµСЂРїР°РЅ
  });

  it('С„Р°РєС‚ >= РѕР¶РёРґР°РµРјРѕРіРѕ в†’ retry РЅРµ РЅСѓР¶РµРЅ', () => {
    expect(shouldRetryAutoscroll(100, 100, 0, 2)).toBe(false);
    expect(shouldRetryAutoscroll(120, 100, 0, 2)).toBe(false);
  });

  it('РЅРµС‚ РѕР¶РёРґР°РµРјРѕРіРѕ С‡РёСЃР»Р° (0 РёР»Рё РїСѓСЃС‚Рѕ) в†’ retry РЅРµ РЅСѓР¶РµРЅ (РЅРµ СЃ С‡РµРј СЃСЂР°РІРЅРёРІР°С‚СЊ)', () => {
    expect(shouldRetryAutoscroll(50, 0, 0, 2)).toBe(false);
    expect(shouldRetryAutoscroll(50, null, 0, 2)).toBe(false);
    expect(shouldRetryAutoscroll(50, undefined, 0, 2)).toBe(false);
  });
});

describe('Gemini disjoint-reset вЂ” РєРѕРЅС‚РµРЅС‚РЅС‹Р№ РєСЂРёС‚РµСЂРёР№ СЃРјРµРЅС‹ СЃРµР°РЅСЃР°/Р°РєРєР°СѓРЅС‚Р° (v60)', () => {
  it('РґРІР° РЅРµРїРµСЂРµСЃРµРєР°СЋС‰РёС…СЃСЏ РЅР°Р±РѕСЂР° id в†’ reset (СЃРјРµРЅР° СЃРµР°РЅСЃР°/Р°РєРєР°СѓРЅС‚Р°)', () => {
    // passive-СЃРЅР°РїС€РѕС‚ РґСЂСѓРіРѕРіРѕ СЃРµР°РЅСЃР°: РЅРё РѕРґРёРЅ id РЅРµ РІСЃС‚СЂРµС‡Р°РµС‚СЃСЏ РІ Р±Р°Р·Рµ
    expect(shouldDisjointReset({
      src: 'passive',
      existingIds: ['r_a_user', 'r_a_assistant', 'r_b_user', 'r_b_assistant'],
      incomingIds: ['r_x_user', 'r_x_assistant', 'r_y_user']
    })).toBe(true);
    // vf5-СЃРЅР°РїС€РѕС‚ РґСЂСѓРіРѕРіРѕ СЃРµР°РЅСЃР°
    expect(shouldDisjointReset({
      src: 'vf5',
      existingIds: ['r_a_user', 'r_a_assistant'],
      incomingIds: ['r_x_user', 'r_x_assistant']
    })).toBe(true);
  });

  it('РїРµСЂРµСЃРµС‡РµРЅРёРµ РЅРµРЅСѓР»РµРІРѕРµ в†’ merge (СЃР±СЂРѕСЃ РЅРµ РІР·РІРѕРґРёС‚СЃСЏ)', () => {
    // СЃРЅР°РїС€РѕС‚ С‚РѕРіРѕ Р¶Рµ СЂР°Р·РіРѕРІРѕСЂР°: С…РІРѕСЃС‚РѕРІС‹Рµ С…РѕРґС‹ СЃРѕРІРїР°РґР°СЋС‚ СЃ Р±Р°Р·РѕР№
    expect(shouldDisjointReset({
      src: 'passive',
      existingIds: ['r_a_user', 'r_a_assistant', 'r_b_user'],
      incomingIds: ['r_b_user', 'r_b_assistant', 'r_c_user']
    })).toBe(false);
    expect(shouldDisjointReset({
      src: 'vf5',
      existingIds: ['r_a_user', 'r_b_assistant'],
      incomingIds: ['r_b_assistant']
    })).toBe(false);
  });

  it('pag-РїСѓС‚СЊ РЅРµ РїРѕРґРІРµСЂР¶РµРЅ РіР°СЂРґСѓ: СЃС‚СЂР°РЅРёС†С‹ РїР°РіРёРЅР°С†РёРё Р»РµРіРёС‚РёРјРЅРѕ РЅРµ РїРµСЂРµСЃРµРєР°СЋС‚СЃСЏ СЃ Р±Р°Р·РѕР№', () => {
    expect(shouldDisjointReset({
      src: 'pag',
      existingIds: ['r_a_user', 'r_a_assistant'],
      incomingIds: ['r_old1_user', 'r_old1_assistant', 'r_old2_user']
    })).toBe(false);
  });

  it('РїСѓСЃС‚Р°СЏ Р±Р°Р·Р° РёР»Рё РїСѓСЃС‚РѕР№ РІС…РѕРґСЏС‰РёР№ РЅР°Р±РѕСЂ в†’ reset РЅРµ РІР·РІРѕРґРёС‚СЃСЏ', () => {
    expect(shouldDisjointReset({ src: 'vf5', existingIds: [], incomingIds: ['r_x_user'] })).toBe(false);
    expect(shouldDisjointReset({ src: 'passive', existingIds: ['r_a_user'], incomingIds: [] })).toBe(false);
    expect(shouldDisjointReset({ src: 'stream', existingIds: ['r_a_user'], incomingIds: ['r_x_user'] })).toBe(false);
    expect(shouldDisjointReset({ existingIds: ['r_a_user'], incomingIds: ['r_x_user'] })).toBe(false);
  });

  // v64: С„РёРєСЃ СѓРЅРёС‡С‚РѕР¶РµРЅРёСЏ Р±Р°Р·С‹ disjoint-reset'Р°РјРё РІРЅСѓС‚СЂРё РѕРґРЅРѕРіРѕ С‡Р°С‚Р°
  it('v64: passive, С‚РѕС‚ Р¶Рµ convId, zero-overlap в†’ merge (reset Р·Р°РїСЂРµС‰С‘РЅ, Р±Р°Р·Р° СЃРѕС…СЂР°РЅСЏРµС‚СЃСЏ)', () => {
    // РЅРµРїРµСЂРµСЃРµРєР°СЋС‰РёРµСЃСЏ РѕРєРЅР° РћР”РќРћР“Рћ С‡Р°С‚Р° РїСЂРё СЃРєСЂРѕР»Р»Рµ Р»РѕР°РґРµСЂР°
    expect(shouldDisjointReset({
      src: 'passive',
      existingIds: ['r_a_user', 'r_a_assistant', 'r_b_user'],
      incomingIds: ['r_c_user', 'r_c_assistant', 'r_d_user'],
      incomingConvId: 'conv1',
      currentConvId: 'conv1'
    })).toBe(false);
    expect(shouldDisjointReset({
      src: 'vf5',
      existingIds: ['r_a_user', 'r_a_assistant'],
      incomingIds: ['r_x_user', 'r_x_assistant'],
      incomingConvId: 'conv1',
      currentConvId: 'conv1'
    })).toBe(false);
  });

  it('v64: РґСЂСѓРіРѕР№ convId, zero-overlap в†’ disjoint-reset СЃРѕС…СЂР°РЅСЏРµС‚СЃСЏ (СЃС‚СЂР°С…РѕРІРєР° cross-conv)', () => {
    expect(shouldDisjointReset({
      src: 'passive',
      existingIds: ['r_a_user', 'r_a_assistant'],
      incomingIds: ['r_x_user', 'r_x_assistant'],
      incomingConvId: 'conv1',
      currentConvId: 'conv2'
    })).toBe(true);
    expect(shouldDisjointReset({
      src: 'vf5',
      existingIds: ['r_a_user', 'r_a_assistant'],
      incomingIds: ['r_x_user', 'r_x_assistant'],
      incomingConvId: 'conv1',
      currentConvId: 'conv2'
    })).toBe(true);
  });
});

describe('Gemini v68 СЃРµСЂРІРµСЂ-Р°РІС‚РѕСЂРёС‚РµС‚РЅР°СЏ РїР°РіРёРЅР°С†РёСЏ (paginateStepDecision)', () => {
  it('(Р°) РґРІРµ СЃС‚СЂР°РЅРёС†С‹, РєСѓСЂСЃРѕСЂ РёСЃС‡РµСЂРїР°РЅ в†’ complete: reachedStart=true, baseComplete=true', () => {
    // 2-СЏ СЃС‚СЂР°РЅРёС†Р° РІРµСЂРЅСѓР»Р°СЃСЊ Р±РµР· continuation-РєСѓСЂСЃРѕСЂР° Рё РґРѕР±Р°РІРёР»Р° С…РѕРґС‹ в†’ РёСЃС‚РёРЅРЅРѕРµ РЅР°С‡Р°Р»Рѕ
    const r = paginateStepDecision({ hasCursor: false, pages: 2, elapsedMs: 1000, added: 3, failedSkeleton: null });
    expect(r.action).toBe('complete');
    expect(r.reason).toBe('end');
    expect(r.reachedStart).toBe(true);
    expect(r.baseComplete).toBe(true);
    expect(r.warn).toBe('');
  });

  it('(Р°2) РєСѓСЂСЃРѕСЂ РёСЃС‡РµСЂРїР°РЅ, РЅРѕ РїРѕСЃР»РµРґРЅРёР№ С€Р°Рі РЅРµ РґРѕР±Р°РІРёР» С…РѕРґРѕРІ в†’ baseComplete=false (no-start)', () => {
    const r = paginateStepDecision({ hasCursor: false, pages: 3, elapsedMs: 2000, added: 0, failedSkeleton: null });
    expect(r.action).toBe('complete');
    expect(r.reason).toBe('no-start');
    expect(r.reachedStart).toBe(false);
    expect(r.baseComplete).toBe(false);
  });

  it('(Р±) РєСѓСЂСЃРѕСЂ Р·Р°СЃС‚СЂСЏР», 25 СЃС‚СЂР°РЅРёС† в†’ cap (page-cap): baseComplete=false + warn', () => {
    const r = paginateStepDecision({ hasCursor: true, pages: 25, elapsedMs: 10000, added: 3, failedSkeleton: null });
    expect(r.action).toBe('cap');
    expect(r.reason).toBe('page-cap');
    expect(r.reachedStart).toBe(false);
    expect(r.baseComplete).toBe(false);
    expect(r.warn).toBeTruthy(); // warn-Р»РѕРі РїСЂРё РґРѕСЃС‚РёР¶РµРЅРёРё РїРѕС‚РѕР»РєР°
  });

  it('(Р±2) РєСѓСЂСЃРѕСЂ Р·Р°СЃС‚СЂСЏР», 60 СЃРµРєСѓРЅРґ в†’ cap (time-cap): baseComplete=false + warn', () => {
    const r = paginateStepDecision({ hasCursor: true, pages: 10, elapsedMs: 60000, added: 3, failedSkeleton: null });
    expect(r.action).toBe('cap');
    expect(r.reason).toBe('time-cap');
    expect(r.baseComplete).toBe(false);
    expect(r.warn).toBeTruthy();
  });

  it('РєСѓСЂСЃРѕСЂ Р¶РёРІ Рё РєР°РїС‹ РЅРµ РёСЃС‡РµСЂРїР°РЅС‹ в†’ continue', () => {
    const r = paginateStepDecision({ hasCursor: true, pages: 2, elapsedMs: 1000, added: 3, failedSkeleton: null });
    expect(r.action).toBe('continue');
    expect(r.reason).toBe('cursor-alive');
    expect(r.baseComplete).toBe(false);
  });

  it('РєР°Рї РїРѕ СѓРјРѕР»С‡Р°РЅРёСЋ = 25 СЃС‚СЂР°РЅРёС† / 60СЃ (DEFAULT_*)', () => {
    expect(DEFAULT_PAGINATE_PAGE_CAP).toBe(25);
    expect(DEFAULT_PAGINATE_TIME_CAP_MS).toBe(60000);
  });
});

describe('Gemini v68 СЃР±СЂРѕСЃ СЃС‡С‘С‚С‡РёРєРѕРІ РїР°РіРёРЅР°С†РёРё (resetPaginationCounters)', () => {
  it('(РІ) conv-changed СЃР±СЂР°СЃС‹РІР°РµС‚ СЃС‡С‘С‚С‡РёРєРё РїСЂРѕРіРѕРЅР° в†’ pageCount=0, startTs=0', () => {
    const afterReset = resetPaginationCounters({ pageCount: 24, startTs: 123456789 });
    expect(afterReset).toEqual({ pageCount: 0, startTs: 0 });
  });

  it('(РІ2) РїСѓСЃС‚РѕР№/РѕС‚СЃСѓС‚СЃС‚РІСѓСЋС‰РёР№ prev С‚РѕР¶Рµ РґР°С‘С‚ РЅСѓР»РµРІРѕРµ СЃРѕСЃС‚РѕСЏРЅРёРµ', () => {
    expect(resetPaginationCounters(null)).toEqual({ pageCount: 0, startTs: 0 });
    expect(resetPaginationCounters(undefined)).toEqual({ pageCount: 0, startTs: 0 });
  });

// v69: РµРґРёРЅС‹Р№ РёСЃС‚РѕС‡РЅРёРє РїСЂР°РІРґС‹ РїРѕР»РЅРѕС‚С‹ вЂ” completenessOracle
function fnv6(id, text) {
  var s = String(id || '') + '\u0000' + String(text || '');
  var h = 0x811c9dc5;
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('000000' + h.toString(16)).slice(-6);
}

describe('Gemini v69 completeness oracle (completenessOracle)', () => {
  it('(Р°) РєСѓСЂСЃРѕСЂ РёСЃС‡РµСЂРїР°РЅ + firstHash СЃРѕРІРїР°РґР°РµС‚ в†’ complete', () => {
    const r = completenessOracle({ cursorExhausted: true, dbFirstHash: 'abc123', serverFirstHash: 'abc123' });
    expect(r.complete).toBe(true);
    expect(r.reason).toBe('first-hash-match');
    expect(r.retry).toBe(false);
  });

  it('(Р±) РєСѓСЂСЃРѕСЂ РёСЃС‡РµСЂРїР°РЅ + firstHash РЅРµ СЃРѕРІРїР°РґР°РµС‚ в†’ incomplete + retry', () => {
    const r = completenessOracle({ cursorExhausted: true, dbFirstHash: 'abc123', serverFirstHash: 'def456' });
    expect(r.complete).toBe(false);
    expect(r.reason).toBe('first-hash-mismatch');
    expect(r.retry).toBe(true);
  });

  it('(РІ) РєСѓСЂСЃРѕСЂ РЅРµ РёСЃС‡РµСЂРїР°РЅ в†’ incomplete', () => {
    const r = completenessOracle({ cursorExhausted: false, dbFirstHash: 'abc123', serverFirstHash: 'abc123' });
    expect(r.complete).toBe(false);
    expect(r.reason).toBe('cursor-alive');
    expect(r.retry).toBe(false);
  });

  it('РєСѓСЂСЃРѕСЂ РёСЃС‡РµСЂРїР°РЅ, РЅРѕ РЅРµС‚ serverFirstHash в†’ incomplete (no-server-probe)', () => {
    const r = completenessOracle({ cursorExhausted: true, dbFirstHash: 'abc123', serverFirstHash: '' });
    expect(r.complete).toBe(false);
    expect(r.reason).toBe('no-server-probe');
    expect(r.retry).toBe(false);
  });
});

// v69: СЃРёРјСѓР»СЏС†РёСЏ С…РѕР»РѕРґРЅРѕРіРѕ РѕС‚РєСЂС‹С‚РёСЏ вЂ” РїСѓСЃС‚РѕР№ tape, РіРёРґСЂР°С‚Р°С†РёСЏ С‚РѕР»СЊРєРѕ С…РІРѕСЃС‚РѕРј, РІРёСЂС‚СѓР°Р»СЊРЅС‹Р№
// СЃРєСЂРѕР»Р» (DOM РѕС‚РґР°С‘С‚ РѕРєРЅР°) в†’ Р±Р°Р·Р° РІ РёС‚РѕРіРµ СЃРѕРґРµСЂР¶РёС‚ РїРµСЂРІРѕРµ СЃРѕРѕР±С‰РµРЅРёРµ Рё РїРѕР»РЅС‹Р№ СЃС‡С‘С‚С‡РёРє.
describe('Gemini v69 С…РѕР»РѕРґРЅРѕРµ РѕС‚РєСЂС‹С‚РёРµ: РѕСЂР°РєСѓР» Р·Р°РєСЂС‹РІР°РµС‚ РЅРµРїРѕР»РЅСѓСЋ РіРёРґСЂР°С‚Р°С†РёСЋ', () => {
  it('С…РІРѕСЃС‚ + РїР°РіРёРЅР°С†РёСЏ РїРѕ РѕРєРЅР°Рј в†’ РїРµСЂРІРѕРµ СЃРѕРѕР±С‰РµРЅРёРµ РїРѕРїР°Р»Рѕ, СЃС‡С‘С‚С‡РёРє РїРѕР»РЅС‹Р№, oracle=complete', () => {
    // РџРѕР»РЅС‹Р№ С‡Р°С‚: 6 С…РѕРґРѕРІ (id0..id2 РїРѕ turn), id0_user вЂ” СЃР°РјРѕРµ РїРµСЂРІРѕРµ СЃРѕРѕР±С‰РµРЅРёРµ.
    const allTurns = [
      { id: 'id0_user', turnId: 'id0', role: 'user', text: 'РїРµСЂРІРѕРµ СЃРѕРѕР±С‰РµРЅРёРµ' },
      { id: 'id0_assistant', turnId: 'id0', role: 'assistant', text: 'РѕС‚РІРµС‚ 0' },
      { id: 'id1_user', turnId: 'id1', role: 'user', text: 'РІС‚РѕСЂРѕРµ' },
      { id: 'id1_assistant', turnId: 'id1', role: 'assistant', text: 'РѕС‚РІРµС‚ 1' },
      { id: 'id2_user', turnId: 'id2', role: 'user', text: 'С‚СЂРµС‚СЊРµ' },
      { id: 'id2_assistant', turnId: 'id2', role: 'assistant', text: 'РѕС‚РІРµС‚ 2' }
    ];
    // РћРєРЅР°, РєРѕС‚РѕСЂС‹Рµ В«РѕС‚РґР°С‘С‚В» РІРёСЂС‚СѓР°Р»СЊРЅС‹Р№ СЃРєСЂРѕР»Р»: С…РІРѕСЃС‚ (id2) РїРµСЂРІС‹Рј, СЃС‚Р°СЂС€РёРµ вЂ” РїРѕР·Р¶Рµ.
    const windows = [
      allTurns.slice(4),     // С…РІРѕСЃС‚: id2 (С…РѕР»РѕРґРЅРѕРµ РѕС‚РєСЂС‹С‚РёРµ РІРёРґРёС‚ С‚РѕР»СЊРєРѕ РµРіРѕ)
      allTurns.slice(2, 4),  // id1
      allTurns.slice(0, 2)   // id0 вЂ” РіРѕР»РѕРІР° (РїРµСЂРІР°СЏ СЃС‚СЂР°РЅРёС†Р° СЃРµСЂРІРµСЂР°)
    ];

    // 1) РїСѓСЃС‚РѕР№ tape: restore РЅРµ РёСЃРїРѕР»СЊР·СѓРµС‚СЃСЏ (tapeWasUsedInThisColdStart=false вЂ” РЅРµ РІР»РёСЏРµС‚).
    // 2) РіРёРґСЂР°С‚Р°С†РёСЏ С‚РѕР»СЊРєРѕ С…РІРѕСЃС‚РѕРј: Р±Р°Р·Р° РїРѕРєР° РќР• РїРѕР»РЅР°СЏ.
    let orderedDb = windows[0].slice();
    let serverFirstHash = '';
    let retries = 0;

    // 3) РІРёСЂС‚СѓР°Р»СЊРЅС‹Р№ СЃРєСЂРѕР»Р» РїРѕРґРіСЂСѓР¶Р°РµС‚ СЃС‚Р°СЂС€РёРµ РѕРєРЅР° (prepend); РєСѓСЂСЃРѕСЂ В«Р¶РёРІВ» РїРѕРєР° РѕРєРЅР° РѕСЃС‚Р°СЋС‚СЃСЏ.
    for (let w = 1; w < windows.length; w++) {
      const hasCursor = w < windows.length - 1; // РїРѕСЃР»РµРґРЅСЏСЏ СЃС‚СЂР°РЅРёС†Р° вЂ” РєСѓСЂСЃРѕСЂ РёСЃС‡РµСЂРїР°РЅ
      const step = paginateStepDecision(
        { hasCursor, pages: w, elapsedMs: w * 1000, added: windows[w].length, failedSkeleton: null },
        { pageCap: 25, timeCapMs: 60000 }
      );
      orderedDb = windows[w].concat(orderedDb); // СЃС‚Р°СЂС€РµРµ РѕРєРЅРѕ вЂ” prepend (v33: РѕС‚СЂРёС†Р°С‚РµР»СЊРЅС‹Р№ order)
      if (step.action === 'complete') {
        // РіРѕР»РѕРІР° (РїРµСЂРІР°СЏ СЃС‚СЂР°РЅРёС†Р° СЃРµСЂРІРµСЂР°): РµС‘ РїРµСЂРІС‹Р№ С…РѕРґ вЂ” СЌС‚Р°Р»РѕРЅ firstMsgHash
        serverFirstHash = fnv6(windows[w][0].id, windows[w][0].text);
      }
    }

    // 4) РѕСЂР°РєСѓР»: РєСѓСЂСЃРѕСЂ РёСЃС‡РµСЂРїР°РЅ + firstMsgHash Р±Р°Р·С‹ == firstMsgHash РїРµСЂРІРѕР№ СЃС‚СЂР°РЅРёС†С‹ СЃРµСЂРІРµСЂР°.
    const dbFirstHash = fnv6(orderedDb[0].id, orderedDb[0].text);
    const oracle = completenessOracle({ cursorExhausted: true, dbFirstHash, serverFirstHash });
    if (!oracle.complete) { retries++; } // РґРѕР·Р°РїСѓСЃРє Р»РѕР°РґРµСЂР° (watchdog)

    // РРЅРІР°СЂРёР°РЅС‚: Р±Р°Р·Р° СЃРѕРґРµСЂР¶РёС‚ РџР•Р Р’РћР• СЃРѕРѕР±С‰РµРЅРёРµ Рё РїРѕР»РЅС‹Р№ СЃС‡С‘С‚С‡РёРє, СЂСѓС‡РЅРѕР№ СЃРєСЂРѕР»Р» РЅРµ РЅСѓР¶РµРЅ.
    expect(orderedDb.length).toBe(allTurns.length);
    expect(orderedDb[0].id).toBe('id0_user');
    expect(orderedDb[0].text).toBe('РїРµСЂРІРѕРµ СЃРѕРѕР±С‰РµРЅРёРµ');
    expect(oracle.complete).toBe(true);
    expect(oracle.reason).toBe('first-hash-match');
    expect(retries).toBe(0);
  });
});

// ===== D15: единый порядок экспорта (рваная r1-перемычка) =====
describe('D15: единый экспорт-билдер (orderExportMessages)', () => {
  // Сообщения вида { id: 'tN_role', turnId: 'tN', r1, order, role }
  function msg(id, r1, order) {
    var role = /_assistant$/.test(id) ? 'assistant' : 'user';
    return { id: id, turnId: id.replace(/_(user|assistant)$/, ''), r1: r1, order: order, role: role };
  }
  // Целая цепочка: корни t1 (user/assistant, r1=null), t2→t1, t3→t2.
  const wholeChain = [
    msg('t1_user', null, 0),
    msg('t1_assistant', null, 1),
    msg('t2_user', 't1', 2),
    msg('t2_assistant', 't1', 3),
    msg('t3_user', 't2', 4),
    msg('t3_assistant', 't2', 5)
  ];
  // Рваная перемычка: у t3 r1 потерян (null вместо 't2') → 2 head-кандидата (t2, t3).
  const tornChain = [
    msg('t1_user', null, 0),
    msg('t1_assistant', null, 1),
    msg('t2_user', 't1', 2),
    msg('t2_assistant', 't1', 3),
    msg('t3_user', null, 4), // перемычка: r1 потерян
    msg('t3_assistant', null, 5)
  ];

  test('(1) рваная перемычка → старший сегмент ПЕРЕД головой, авто==ручной', () => {
    const out = orderExportMessages(tornChain);
    expect(out.ids[0]).toBe('t1_user'); // старший сегмент (мин order) — первый
    expect(out.mode).toBe('chain-r1');  // r1-цепочка теперь корректно начинается со старшего
    const again = orderExportMessages(tornChain);
    expect(again.ids).toEqual(out.ids); // детерминизм («авто==ручной»)
    expect(out.ids.length).toBe(6);
  });

  test('(2) целая цепочка → r1 сохранена (mode=chain-r1), голова = t1_user', () => {
    const out = orderExportMessages(wholeChain);
    expect(out.mode).toBe('chain-r1');
    expect(out.ids[0]).toBe('t1_user');
    expect(out.ids).toEqual(['t1_user', 't1_assistant', 't2_user', 't2_assistant', 't3_user', 't3_assistant']);
  });

  test('(3) авто==ручной побайтово на одной базе (рваная)', () => {
    const a1 = orderExportMessages(tornChain).ids;
    const a2 = orderExportMessages(tornChain).ids; // «ручная» выгрузка того же снимка
    expect(a1).toEqual(a2);
    expect(a1[0]).toBe('t1_user');
  });

  test('(4) пустой список → пустой результат, без падений', () => {
    expect(orderExportMessages([]).ids).toEqual([]);
  });

  test('(5) один ход → он же', () => {
    expect(orderExportMessages([msg('t1_user', null, 0)]).ids).toEqual(['t1_user']);
  });

  test('(6) два сегмента: старший недосягаемый из головы → в начало, не в конец', () => {
    // старший сегмент S (предыстория, малые order) недосягаем по r1 из головы M2
    const two = [
      msg('s1_user', null, 0), msg('s1_assistant', null, 1),   // старший сегмент
      msg('s2_user', 's1', 2), msg('s2_assistant', 's1', 3),
      msg('m1_user', null, 10), msg('m1_assistant', null, 11), // основная цепь (новее)
      msg('m2_user', 'm1', 12), msg('m2_assistant', 'm1', 13)
    ];
    const out = orderExportMessages(two);
    expect(out.ids).toEqual([
      's1_user', 's1_assistant', 's2_user', 's2_assistant',
      'm1_user', 'm1_assistant', 'm2_user', 'm2_assistant'
    ]); // старший сегмент ПЕРЕД головой основной цепи
    expect(out.ids[0]).toBe('s1_user');
  });

  test('(7) тейп с повёрнутым order + полный r1-граф → голова = r1-голова (chain-r1, не arrival)', () => {
    // r1-граф правильный (t1 — корень), но order ПОВЁРНУТ (мин order user = t2_user).
    const twisted = [
      msg('t1_user', null, 10), msg('t1_assistant', null, 11), // истинная r1-голова
      msg('t2_user', 't1', 0), msg('t2_assistant', 't1', 1),   // повёрнутый order
      msg('t3_user', 't2', 2), msg('t3_assistant', 't2', 3)
    ];
    const out = orderExportMessages(twisted);
    expect(out.mode).toBe('chain-r1');      // r1-граф авторитетнее повёрнутого order
    expect(out.ids[0]).toBe('t1_user');     // голова = реальный ход с null r1
    expect(out.ids).toEqual(['t1_user', 't1_assistant', 't2_user', 't2_assistant', 't3_user', 't3_assistant']);
  });

  test('(8) отсутствие/цикл r1 → arrival-фолбэк (байтово как прежде)', () => {
    // зацикленный r1: все ходы являются чьим-то r1 → heads=[] → orderByR1Chain ok=false
    const cyc = [
      msg('t1_user', 't2', 0), msg('t1_assistant', 't2', 1),
      msg('t2_user', 't1', 2), msg('t2_assistant', 't1', 3)
    ];
    const out = orderExportMessages(cyc);
    expect(out.mode).toBe('arrival');       // фолбэк при отсутствии валидного r1-графа
    expect(out.ids[0]).toBe('t1_user');     // серверный (по order) порядок
  });
});

// ===== A: HWM пола — saveFloor не опускается =====
describe('A: HWM пола (saveFloor/loadFloor)', () => {
  test('(1) новый пол ниже сохранённого → не перезаписывается (max)', () => {
    const storage = makeStorage();
    saveFloor('c1', 'g3', 124, 50000, storage);   // сохранённый пол
    saveFloor('c1', 'g3', 80, 30000, storage);    // попытка опустить (ложный верх msgs=80)
    const f = loadFloor('c1', 'g3', storage);
    expect(f.count).toBe(124);
    expect(f.effectiveLen).toBe(50000);
  });

  test('(2) тот же count, меньший effectiveLen → не перезаписывается', () => {
    const storage = makeStorage();
    saveFloor('c1', 'g3', 124, 50000, storage);
    saveFloor('c1', 'g3', 124, 20000, storage);
    const f = loadFloor('c1', 'g3', storage);
    expect(f.effectiveLen).toBe(50000);
  });

  test('(3) выше сохранённого → обновляется', () => {
    const storage = makeStorage();
    saveFloor('c1', 'g3', 124, 50000, storage);
    saveFloor('c1', 'g3', 150, 60000, storage);
    const f = loadFloor('c1', 'g3', storage);
    expect(f.count).toBe(150);
    expect(f.effectiveLen).toBe(60000);
  });
});

// ===== D15-тупик: обход cache-complete при oracle=incomplete (ровно один раз) =====
describe('D15: shouldBypassCacheComplete (тупик cache-complete)', () => {
  test('(а) SPA-вход с восстановленной лентой + oracle incomplete → разрешён ОДИН ре-ран', () => {
    const seen = { '0362260d': true };        // probeIncomplete поставил флаг
    const rerun = {};                          // ре-ран ещё не использован
    expect(shouldBypassCacheComplete(seen, rerun, '0362260d')).toBe(true);
    // после ре-рана флаг снят + маркер rerun → повторный обход запрещён (нет цикла)
    delete seen['0362260d'];
    rerun['0362260d'] = true;
    expect(shouldBypassCacheComplete(seen, rerun, '0362260d')).toBe(false);
  });

  test('(б) холодное открытие/F5 без oracle=incomplete → bypass не срабатывает (байтово)', () => {
    const seen = {};                           // incomplete не было
    const rerun = {};
    expect(shouldBypassCacheComplete(seen, rerun, '0362260d')).toBe(false);
  });

  test('(в) rerun уже использован → даже при seen=true повторного обхода нет', () => {
    const seen = { '0362260d': true };
    const rerun = { '0362260d': true };
    expect(shouldBypassCacheComplete(seen, rerun, '0362260d')).toBe(false);
  });

  test('(г) без convId / другие convId не задеваются', () => {
    const seen = { 'a': true };
    expect(shouldBypassCacheComplete(seen, {}, '')).toBe(false);
    expect(shouldBypassCacheComplete(seen, {}, 'b')).toBe(false); // изоляция по convId
    expect(shouldBypassCacheComplete(null, {}, 'a')).toBe(false);
  });
});

// ===== D17: тейп принимается ПО КОНТЕНТУ (orderVersion не гейтит чтение) =====
describe('D17: shouldAcceptTape по контенту (orderVersion не гейт)', () => {
  test('старый g3-тейп без orderVersion → ПРИНИМАЕТСЯ (контент сливается, порядок пересчитает chain-r1)', () => {
    const entry = { turns: [{ id: 'a_user' }], meta: { version: 'g3' } };
    expect(shouldAcceptTape(entry, 'g3')).toBe(true);
  });

  test('новый тейп (version=g3, orderVersion=2) → принимается', () => {
    const entry = { turns: [{ id: 'a_user' }], meta: { version: 'g3', orderVersion: 2 } };
    expect(shouldAcceptTape(entry, 'g3')).toBe(true);
  });

  test('версия парсера не совпадает → не принимается', () => {
    const entry = { turns: [], meta: { version: 'g3' } };
    expect(shouldAcceptTape(entry, 'g4')).toBe(false);
  });
});

// ===== D16: bootstrap короткого контейнера (hide при старшей истории + oracle incomplete) =====
describe('D16: shouldHideScroller (bootstrap короткого контейнера)', () => {
  const base = { minHideH: 8000, olderHistorySeen: true, reachedStart: false, oracleIncomplete: true };

  test('(а) scrollH=1140 + старшая история + oracle incomplete → hide ВКЛ (bootstrap-short)', () => {
    const v = shouldHideScroller(Object.assign({}, base, { scrollH: 1140 }));
    expect(v.hide).toBe(true);
    expect(v.bootstrapShort).toBe(true); // независимо от порога 8000
  });

  test('(б) короткий чат БЕЗ старшей истории → hide НЕ включается (лоадер не крутится)', () => {
    const v = shouldHideScroller({ scrollH: 1140, minHideH: 8000, olderHistorySeen: false, reachedStart: false, oracleIncomplete: false });
    expect(v.hide).toBe(false);
    expect(v.bootstrapShort).toBe(false);
  });

  test('(б2) старшая история есть, но оракул НЕ incomplete → hide НЕ включается на коротком', () => {
    const v = shouldHideScroller(Object.assign({}, base, { scrollH: 1140, oracleIncomplete: false }));
    expect(v.hide).toBe(false);
  });

  test('(в) scrollH>8000 → hide ВКЛ как прежде (bootstrapShort=false, байтово)', () => {
    const v = shouldHideScroller({ scrollH: 12000, minHideH: 8000, olderHistorySeen: false, reachedStart: false, oracleIncomplete: false });
    expect(v.hide).toBe(true);
    expect(v.bootstrapShort).toBe(false);
  });

  test('начало достигнуто (reachedStart=true) → на коротком hide НЕ нужен', () => {
    const v = shouldHideScroller(Object.assign({}, base, { scrollH: 1140, reachedStart: true }));
    expect(v.hide).toBe(false);
  });
});

// ===== H12 (A5b): scrollProofAllowsComplete удалён — циркулярный оракул полноты =====
describe('H12 (A5b): scrollProofAllowsComplete отсутствует в экспорте GeminiInterceptLogic', () => {
  test('(б) функции нет в экспорте модуля и в исходнике utils', () => {
    const apiH12 = require('../../utils/gemini-intercept-logic.js');
    expect(apiH12.scrollProofAllowsComplete).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(apiH12, 'scrollProofAllowsComplete')).toBe(false);
    const logicSrc = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'utils', 'gemini-intercept-logic.js'), 'utf8');
    expect(logicSrc).not.toContain('scrollProofAllowsComplete');
  });

  test('(б2) core/gemini-intercept.js не вызывает хелпер и не объявляет complete по scroll-top-proof', () => {
    const coreSrc = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'core', 'gemini-intercept.js'), 'utf8');
    expect(coreSrc).not.toContain('scrollProofAllowsComplete');
    expect(coreSrc).not.toContain('oracle=complete reason=scroll-top-proof');
    expect(coreSrc).not.toContain('oracle=incomplete reason=below-floor scroll-top-proof');
    expect(coreSrc).toContain('H12 (A5b): scroll-top-proof удалён');
  });
});

// ===== D17: g3-тейп со старшим сегментом + хвостовое окно сети → объединение, голова истинная =====
describe('D17: tape-merge старшего сегмента (r1=null) + chain-r1', () => {
  // сеть отдаёт хвостовое окно (t3,t4), тейп содержит старший сегмент (t1,t2)
  const networkItems = [
    { id: 't3_user', turnId: 't3', r1: null, order: 100, role: 'user', text: 'окно1' },
    { id: 't3_assistant', turnId: 't3', r1: null, order: 101, role: 'assistant', text: 'окно1a' },
    { id: 't4_user', turnId: 't4', r1: 't3', order: 102, role: 'user', text: 'окно2' },
    { id: 't4_assistant', turnId: 't4', r1: 't3', order: 103, role: 'assistant', text: 'окно2a' }
  ];
  // тейп g3 без orderVersion: старший сегмент «Как называется…» (r1=null)
  const tapeTurns = [
    { id: 't1_user', text: 'Как называется квадратное/прямоугольное окошко…', r1: null, turnId: 't1', role: 'user' },
    { id: 't1_assistant', text: 'ответ1', r1: null, turnId: 't1', role: 'assistant' },
    { id: 't2_user', text: 'вопрос2', r1: 't1', turnId: 't2', role: 'user' },
    { id: 't2_assistant', text: 'ответ2', r1: 't1', turnId: 't2', role: 'assistant' }
  ];

  test('(а) merge: restored r1=null + сеть → объединение, старший сегмент ПЕРЕД хвостом, голова истинная', () => {
    const merged = mergeRestoredTurns(networkItems, tapeTurns);
    expect(merged.items.length).toBe(8);
    // restored-ходы не наследуют r1 (порядок пересчитает chain-r1)
    const t1u = merged.items.find(x => x.id === 't1_user');
    expect(t1u.r1).toBe(null);
    const out = orderExportMessages(merged.items);
    expect(out.mode).toBe('chain-r1');
    expect(out.ids[0]).toBe('t1_user'); // «Как называется…» — первая
    expect(out.ids.indexOf('t3_user')).toBeGreaterThan(out.ids.indexOf('t1_user')); // хвост после старшего
  });

  test('(б) сетевые r1 сохранены (сеть авторитетна)', () => {
    const merged = mergeRestoredTurns(networkItems, tapeTurns);
    const t4u = merged.items.find(x => x.id === 't4_user');
    expect(t4u.r1).toBe('t3');
  });
});

// ===== D19: циклический сдвиг — старший сегмент целиком ПЕРЕД головой =====
describe('D19: старший несвязный сегмент в начало (r1-компонента целиком)', () => {
  function msg(id, r1, order) {
    const role = /_assistant$/.test(id) ? 'assistant' : 'user';
    return { id: id, turnId: id.replace(/_(user|assistant)$/, ''), r1: r1, order: order, role: role };
  }
  test('(а) рваный r1-мост + у части ходов старшего сегмента order >= minOrderW → сегмент ЦЕЛИКОМ в начало', () => {
    // старший сегмент: s1 (мин order 5), s2 с ПОВЫШЕННЫМ order (20 >= minOrderW=10) — до фикса
    // s2 уезжал в конец (циклический сдвиг). Основная цепь m1→m2 (order 10..13).
    const items = [
      msg('s1_user', null, 5), msg('s1_assistant', null, 5),
      msg('s2_user', 's1', 20), msg('s2_assistant', 's1', 20), // order 20 >= minOrderW=10
      msg('m1_user', null, 10), msg('m1_assistant', null, 10),
      msg('m2_user', 'm1', 12), msg('m2_assistant', 'm1', 12)
    ];
    const out = orderExportMessages(items);
    expect(out.mode).toBe('chain-r1');
    expect(out.ids[0]).toBe('s1_user'); // голова = истинная (старший сегмент)
    expect(out.ids).toEqual([
      's1_user', 's1_assistant', 's2_user', 's2_assistant',
      'm1_user', 'm1_assistant', 'm2_user', 'm2_assistant'
    ]); // ВЕСЬ старший сегмент (s1+s2) перед основной цепью, хвост m2_assistant
  });

  test('(б) один сегмент (целая цепочка) — порядок байтово прежний', () => {
    const items = [
      msg('u1_user', null, 0), msg('u1_assistant', null, 0),
      msg('u2_user', 'u1', 1), msg('u2_assistant', 'u1', 1),
      msg('u3_user', 'u2', 2), msg('u3_assistant', 'u2', 2)
    ];
    const out = orderExportMessages(items);
    expect(out.mode).toBe('chain-r1');
    expect(out.ids).toEqual([
      'u1_user', 'u1_assistant', 'u2_user', 'u2_assistant', 'u3_user', 'u3_assistant'
    ]);
    expect(out.ids[0]).toBe('u1_user');
    expect(out.ids[out.ids.length - 1]).toBe('u3_assistant'); // хвост не меняется
  });
});

// ===== H9b: retained last-good метаданных probe — монотонное правило (по образцу saveFloor) =====
describe('H9b: updateProbeMetaRetain (retained last-good: шаг сломан/здоров)', () => {
  const META_A = { atEncoded: 'at-A', baseUrl: 'https://gemini.google.com/_/BardChatUi/data/...A', headers: { authorization: 'SATK-A' } };
  const META_B = { atEncoded: 'at-B', baseUrl: 'https://gemini.google.com/_/BardChatUi/data/...B', headers: { authorization: 'SATK-B' } };

  test('(а) stepOk=false (оборванный финальный шаг) → keep prev, НЕ перезаписывается', () => {
    const prev = updateProbeMetaRetain(null, META_A, true); // здоровый шаг принят
    const res = updateProbeMetaRetain(prev, META_B, false); // сломанный шаг
    expect(res).toBe(prev); // тот же объект
    expect(res.atEncoded).toBe('at-A');
    expect(res.baseUrl).toBe(META_A.baseUrl);
  });

  test('(б) stepOk=true (здоровый шаг: added>0 ИЛИ живой курсор) → replace входящим снапшотом', () => {
    const prev = updateProbeMetaRetain(null, META_A, true);
    const res = updateProbeMetaRetain(prev, META_B, true);
    expect(res).toBe(META_B);
    expect(res.baseUrl).toBe(META_B.baseUrl);
  });

  test('(в) пустой retained + сломанный шаг → остаётся null (мусор не заводится)', () => {
    expect(updateProbeMetaRetain(null, META_A, false)).toBe(null);
    expect(updateProbeMetaRetain(null, META_A, undefined)).toBe(null);
    expect(updateProbeMetaRetain(null, null, true)).toBe(null);
    expect(updateProbeMetaRetain(undefined, undefined, false)).toBe(undefined);
  });

  test('(г) здоровый шаг без обязательных полей (мусор) → keep prev (не опускает retained)', () => {
    const prev = updateProbeMetaRetain(null, META_A, true);
    expect(updateProbeMetaRetain(prev, { atEncoded: '', baseUrl: 'x', headers: {} }, true)).toBe(prev);
    expect(updateProbeMetaRetain(prev, { atEncoded: 'at-X', baseUrl: '', headers: {} }, true)).toBe(prev);
    expect(updateProbeMetaRetain(prev, { atEncoded: 'at-X', baseUrl: 'y', headers: null }, true)).toBe(prev);
    expect(updateProbeMetaRetain(prev, {}, true)).toBe(prev);
    expect(updateProbeMetaRetain(prev, null, true)).toBe(prev);
    expect(updateProbeMetaRetain(prev, undefined, true)).toBe(prev);
  });

  test('(д) монотонность: здоровый→сломан→здоровый = последний здоровый; сломан не роняет', () => {
    const s1 = updateProbeMetaRetain(null, META_A, true);
    const s2 = updateProbeMetaRetain(s1, META_B, false); // сломанный шаг между здоровыми
    expect(s2).toBe(s1);
    expect(s2.atEncoded).toBe('at-A');
    const s3 = updateProbeMetaRetain(s2, META_B, true); // следующий здоровый
    expect(s3).toBe(META_B);
    expect(s3.headers).toEqual(META_B.headers);
  });

  test('(е) поле экспортировано в API (рядом с fallbackProbeReady)', () => {
    const apiH9b = require('../../utils/gemini-intercept-logic.js');
    expect(typeof apiH9b.updateProbeMetaRetain).toBe('function');
    expect(typeof apiH9b.fallbackProbeReady).toBe('function');
  });
});

});

// ===== H10: probe-terminal gate (пол авторитетнее ответа probe; pb-ошибка ≠ complete) =====
describe('H10 probeTerminalGate (below-floor / pb-error)', () => {
  test('(а) floor=0 (пола нет, класс первого визита) → null (терминальный ответ легитимен)', () => {
    expect(probeTerminalGate({ floorCount: 0, baseCount: 80, pbError: false })).toBeNull();
    expect(probeTerminalGate({ floorCount: 0, baseCount: 80 })).toBeNull();
  });

  test('(б) base = floor → null (пол добрат, повторный вход без регресса)', () => {
    expect(probeTerminalGate({ floorCount: 80, baseCount: 80, pbError: false })).toBeNull();
    expect(probeTerminalGate({ floorCount: 108, baseCount: 108 })).toBeNull();
  });

  test('(в) base > floor → null', () => {
    expect(probeTerminalGate({ floorCount: 80, baseCount: 90, pbError: false })).toBeNull();
  });

  test('(г) base < floor (e292: 80 < 108, окно-дубль) → block below-floor-probe-terminal', () => {
    expect(probeTerminalGate({ floorCount: 108, baseCount: 80, pbError: false }))
      .toEqual({ block: true, reason: 'below-floor-probe-terminal' });
  });

  test('(д) pbError=true (error-страница pb, битый-парс-путь) → block pb-error-page', () => {
    expect(probeTerminalGate({ floorCount: 0, baseCount: 80, pbError: true }))
      .toEqual({ block: true, reason: 'pb-error-page' });
    expect(probeTerminalGate({ floorCount: 108, baseCount: 108, pbError: true }))
      .toEqual({ block: true, reason: 'pb-error-page' });
  });

  test('(е) below-floor приоритетнее pb-error (оба условия)', () => {
    expect(probeTerminalGate({ floorCount: 108, baseCount: 80, pbError: true }))
      .toEqual({ block: true, reason: 'below-floor-probe-terminal' });
  });

  test('(ж) пустые/мусорные входы → null без исключений', () => {
    expect(probeTerminalGate(null)).toBeNull();
    expect(probeTerminalGate(undefined)).toBeNull();
    expect(probeTerminalGate({})).toBeNull();
    expect(probeTerminalGate({ floorCount: '108', baseCount: '80' })).toBeNull();
    expect(probeTerminalGate({ floorCount: -1, baseCount: 80 })).toBeNull();
  });

  test('(з) поле экспортировано в API', () => {
    const apiH10 = require('../../utils/gemini-intercept-logic.js');
    expect(typeof apiH10.probeTerminalGate).toBe('function');
  });
});

describe('H10 пины в core/gemini-intercept.js (probe-terminal floor/error gate)', () => {
  const CORE = require('path').join(__dirname, '..', '..', 'core', 'gemini-intercept.js');
  const coreSrc = require('fs').readFileSync(CORE, 'utf8');

  test('строки reason живут в core (литералы гейта и его inline-дубля)', () => {
    expect(coreSrc).toContain('below-floor-probe-terminal');
    expect(coreSrc).toContain('pb-error-page');
    expect(coreSrc).toContain('[AI CM][completeness] probe-terminal blocked reason=');
  });

  test('probe-terminal блок вызывает гейт ПЕРЕД взводом complete (historyFullByQuiet/reachedStart)', () => {
    const gateIdx = coreSrc.indexOf('GeminiInterceptLogic.probeTerminalGate');
    const blockedIdx = coreSrc.indexOf('probe-terminal blocked reason=');
    const completeIdx = coreSrc.indexOf('oracle=complete reason=probe-terminal');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(blockedIdx).toBeGreaterThan(-1);
    expect(completeIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(blockedIdx);
    expect(blockedIdx).toBeLessThan(completeIdx);
    // вызов гейта стоит внутри терминальной ветки: newOlder===0 && !pCursorWide
    const branchIdx = coreSrc.indexOf('if (newOlder === 0 && !pCursorWide) {');
    expect(branchIdx).toBeGreaterThan(-1);
    expect(branchIdx).toBeLessThan(gateIdx);
  });

  test('в сборку pb-ответа передаётся pbError=lastHnvPageError (error-страница → block)', () => {
    expect(coreSrc).toContain('pbError: lastHnvPageError === true');
  });

  test('block → probeIncomplete(reason) (утренний путь loader-restart), complete не взводится', () => {
    expect(coreSrc).toContain('probeIncomplete(__ptGate.reason);');
    const gateIdx = coreSrc.indexOf('probeIncomplete(__ptGate.reason);');
    const firstCompleteWrite = coreSrc.indexOf('historyFullByQuiet = true;', gateIdx);
    expect(firstCompleteWrite).toBeGreaterThan(-1);
  });
});
