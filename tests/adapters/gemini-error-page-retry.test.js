/**
 * v1.15 (BUG «холодное открытие без полной истории»): Gemini hNvQHb отвечает на запрос
 * окна истории иногда НЕ данными, а ошибкой Bard (inner=null + BardErrorInfo, напр. code
 * 1177). Раньше такая страница трактовалась как «старших страниц больше нет» — тихая
 * пагинация гасла, курсор терялся, лоадер застревал в collapse и база оставалась неполной
 * (baseComplete=false, автоэкспорт не стрелял).
 *
 * Покрытие: isBardErrorPage (отличить ошибку-страницу от терминальной/данных) и
 * paginateErrorRetryDecision (повторять то же окно с растущей паузой, до 3 попыток).
 */

const {
  isBardErrorPage,
  paginateErrorRetryDecision,
} = require('../../utils/gemini-intercept-logic');

// Реальная вложенность payload: outer = [wrb-кортеж, ["di",…], …], ходы — outer[0][2].
const ERROR_PAGE_1177 = [
  ['wrb.fr', 'hNvQHb', null, null, null,
    [3, null, [['type.googleapis.com/assistant.boq.bard.application.BardErrorInfo', [1177]]]], 'generic'],
  ['di', 86],
];

// Терминальная страница (строковый inner с пустыми окнами) — НЕ ошибка.
const TERMINAL_PAGE = [
  ['wrb.fr', 'hNvQHb', '[[],[],[],[]]', null, 'generic'],
  ['di', 86],
];

// Страница с данными — НЕ ошибка.
const DATA_PAGE = [
  ['wrb.fr', 'hNvQHb', '[[{"x":1}],[{"y":2}]]', null, 'generic'],
  ['di', 86],
];

describe('isBardErrorPage', () => {
  test('распознаёт страницу-ошибку Bard (inner=null + BardErrorInfo 1177)', () => {
    expect(isBardErrorPage(ERROR_PAGE_1177)).toBe(true);
  });

  test('терминальная страница (пустой строковый inner) НЕ ошибка', () => {
    expect(isBardErrorPage(TERMINAL_PAGE)).toBe(false);
  });

  test('страница с данными НЕ ошибка', () => {
    expect(isBardErrorPage(DATA_PAGE)).toBe(false);
  });

  test('ошибка со строковым inner, но маркером BardErrorInfo в метаданных — распознаётся', () => {
    const withMeta = [
      ['wrb.fr', 'hNvQHb', '[]', null, null,
        [3, null, [['type.googleapis.com/assistant.boq.bard.application.BardErrorInfo', [1100]]]], 'generic'],
      ['di', 7],
    ];
    expect(isBardErrorPage(withMeta)).toBe(true);
  });

  test('мусорные входы не ломают (false)', () => {
    expect(isBardErrorPage(null)).toBe(false);
    expect(isBardErrorPage('строка')).toBe(false);
    expect(isBardErrorPage([])).toBe(false);
    expect(isBardErrorPage([[{}]])).toBe(true); // inner не строка — не-данные → ошибка
  });
});

describe('paginateErrorRetryDecision', () => {
  test('ошибка-страница без курсора и без добавления → retry с растущей паузой', () => {
    expect(paginateErrorRetryDecision({ errPage: true, hasCursor: false, added: 0, retries: 0 }))
      .toEqual({ retry: true, backoffMs: 2000 });
    expect(paginateErrorRetryDecision({ errPage: true, hasCursor: false, added: 0, retries: 1 }))
      .toEqual({ retry: true, backoffMs: 4000 });
    expect(paginateErrorRetryDecision({ errPage: true, hasCursor: false, added: 0, retries: 2 }))
      .toEqual({ retry: true, backoffMs: 6000 });
  });

  test('после 3 попыток ретрай прекращается (cap)', () => {
    expect(paginateErrorRetryDecision({ errPage: true, hasCursor: false, added: 0, retries: 3 }))
      .toEqual({ retry: false, backoffMs: 0 });
    expect(paginateErrorRetryDecision({ errPage: true, hasCursor: false, added: 0, retries: 10 }))
      .toEqual({ retry: false, backoffMs: 0 });
  });

  test('страница с данными/курсором не ретраится как ошибка', () => {
    expect(paginateErrorRetryDecision({ errPage: true, hasCursor: true, added: 0, retries: 0 }))
      .toEqual({ retry: false, backoffMs: 0 });
    expect(paginateErrorRetryDecision({ errPage: true, hasCursor: false, added: 20, retries: 0 }))
      .toEqual({ retry: false, backoffMs: 0 });
  });

  test('не-ошибка не ретраится', () => {
    expect(paginateErrorRetryDecision({ errPage: false, hasCursor: false, added: 0, retries: 0 }))
      .toEqual({ retry: false, backoffMs: 0 });
    expect(paginateErrorRetryDecision({}))
      .toEqual({ retry: false, backoffMs: 0 });
    expect(paginateErrorRetryDecision(null))
      .toEqual({ retry: false, backoffMs: 0 });
  });
});
