/**
 * Изолированный хелпер парсера SSE-стрима Claude (POST /completion).
 * Логика извлечена из core/claude-intercept.js (parseSSEStream).
 * @param {string} raw - сырой текст SSE-потока (строки event:/data:)
 * @returns {{ model: string, text: string, stopped: boolean, rateLimit5h: number }}
 */

function parseClaudeSSE(raw) {
  var lines = raw.split('\n');
  var model = '';
  var stopped = false;
  var textParts = [];
  var rateLimit5h = 0;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.indexOf('event: ') === 0 || line.indexOf('data: ') !== 0) continue;

    var jsonStr = line.substring(6);
    try {
      var data = JSON.parse(jsonStr);
      if (data.type === 'message_start' && data.message && data.message.model) {
        model = data.message.model;
      }
      if (data.type === 'content_block_delta' && data.delta && typeof data.delta.text === 'string') {
        textParts.push(data.delta.text);
      }
      if (data.type === 'content_block_delta' && data.delta && data.delta.type === 'thinking_delta' && typeof data.delta.thinking === 'string') {
        textParts.push(data.delta.thinking);
      }
      if (data.type === 'content_block_delta' && data.delta && data.delta.type === 'thinking_summary_delta' && data.delta.thinking_summary) {
        textParts.push(data.delta.thinking_summary);
      }
      if (data.type === 'message_limit' && data.message_limit && data.message_limit.windows &&
          data.message_limit.windows['5h'] && typeof data.message_limit.windows['5h'].utilization === 'number') {
        rateLimit5h = data.message_limit.windows['5h'].utilization;
      }
      if (data.type === 'message_stop') {
        stopped = true;
      }
    } catch (e) {}
  }

  return { model: model, text: textParts.join(''), stopped: stopped, rateLimit5h: rateLimit5h };
}

module.exports = { parseClaudeSSE };