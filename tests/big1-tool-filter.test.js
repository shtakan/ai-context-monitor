'use strict';

/**
 * BIG-01 (2.1.5): tool/file-узлы ChatGPT не попадают в историю.
 * Регресс на живой артефакт приёмки: `filecite…` + дамп файла под ролью assistant.
 */

const loadEsm = require('./helpers/load-esm.js');
const Parser = loadEsm.loadEsmModule('utils/chatgpt-conversation-parser.ts');

function node(role, parts, metadata, contentType) {
  return {
    message: {
      author: { role: role },
      metadata: metadata || {},
      content: { content_type: contentType || 'text', parts: parts }
    }
  };
}

function conversation() {
  return {
    model_slug: 'gpt-6',
    mapping: {
      u1: node('user', ['Что в файле?']),
      t1: node('tool', ['Make sure to include fileciteturn0file0L5-L8 in your response.']),
      t2: node('assistant', ['[L5] qwen-test'], { is_tool: true }),
      t3: node('assistant', ['tool payload'], null, 'tool_result'),
      a1: node('assistant', ['В файле три строки: qwen-test.'])
    }
  };
}

describe('BIG-01: фильтр tool/file-узлов ChatGPT', () => {
  test('tool-роль, metadata.is_tool и content_type=tool_result отбрасываются', () => {
    const out = Parser.parseChatGPTConversation(conversation());
    const texts = out.messages.map((m) => m.content).join('\n');
    expect(texts).not.toContain('filecite');
    expect(texts).not.toContain('[L5]');
    expect(texts).not.toContain('tool payload');
  });

  test('обычный ответ ассистента и вопрос пользователя сохраняются', () => {
    const out = Parser.parseChatGPTConversation(conversation());
    expect(out.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(out.messages[1].content).toContain('qwen-test');
  });
});
