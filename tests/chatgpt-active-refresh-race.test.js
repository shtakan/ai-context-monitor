const fs = require('fs');
const path = require('path');

/**
 * Регресс-пин гонки ChatGPT active refresh (18_65b, 2026-11-24).
 *
 * Симптом: после account switch первый длинный ответ не попадал в базу;
 * active GET через 2.5с брал только первый обмен (1–2 узла), а после
 * завершения стрима повторного снимка не было. Бейдж замирал на 0.2%,
 * модель оставалась GPT-5.5 до F5.
 *
 * Фикс: не ходить на local-chatgpt/пустой convId, валидировать
 * lastSnapshotUrl по текущему convId, планировать снимок после завершения
 * тела POST /f/conversation и держать follow-up, пока в истории не появится
 * assistant после нового хода. Плюс retry на 400/404/сетевые ошибки вместо
 * мгновенного activeDisabled.
 *
 * Это статический пин: page-intercept запускается в MAIN-мире и требует
 * реального fetch/DOM, поэтому поведенческий harness здесь дороже, чем
 * структурные инварианты. Причина в behavior-gate whitelist: static-linter.
 */
const SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'page-intercept.js'), 'utf8');

describe('ChatGPT active refresh: гонка первого длинного ответа (18_65b)', () => {
  test('не ходит на local-chatgpt и валидирует URL по текущему convId', () => {
    expect(SRC).toContain('function isRealConvId(');
    expect(SRC).toContain('if (!isRealConvId(currentConvId))');
    expect(SRC).toContain('function snapshotUrlForConv(');
    expect(SRC).toContain('snapshotUrlForConv(lastSnapshotUrl, currentConvId)');
    expect(SRC).toContain('if (!isRealConvId(convId)) return;');
  });

  test('планирует снимок после завершения ответа и держит follow-up', () => {
    expect(SRC).toContain('function schedulePostSendFollowUp(');
    expect(SRC).toContain('postSendFollowUpDelays = [8000, 18000, 35000, 60000]');
    expect(SRC).toContain('schedulePostSendFollowUp();');
    expect(SRC).toContain('scheduleActiveAfterResponse(responsePromise);');
    expect(SRC).toContain("scheduleActive('после завершения ответа', 800);");
  });

  test('400/404/сеть не выключают активный путь сразу', () => {
    expect(SRC).toContain('activeHttpRetryCount');
    expect(SRC).toMatch(/status === 401 \|\| status === 403/);
    expect(SRC).toContain('activeHttpRetryCount < 2');
    expect(SRC).toContain("activeRefresh('ретрай после сетевой ошибки')");
    expect(SRC).toContain('lastSnapshotCount = parsed.count');
    expect(SRC).toContain('lastSnapshotLastRole = parsed.lastRole');
  });
});
