const {
    getConvIdFromPath,
    shouldResetChatConversation,
    orderChatGPTMapping,
    sanitizeChatGPTText,
    parseChatGPTConversation
} = require('../../utils/chatgpt-conversation-parser');

describe('ChatGPT навигация /c/<id>', () => {
    it('извлекает id чата из пути', () => {
        expect(getConvIdFromPath('/c/abc-123_XYZ')).toBe('abc-123_XYZ');
        expect(getConvIdFromPath('/c/abc-123_XYZ/')).toBe('abc-123_XYZ');
        expect(getConvIdFromPath('/')).toBe('');
        expect(getConvIdFromPath('/gpts')).toBe('');
    });

    it('сброс только при смене на новый непустой id', () => {
        expect(shouldResetChatConversation('', 'abc')).toBe(true);
        expect(shouldResetChatConversation('abc', 'def')).toBe(true);
        expect(shouldResetChatConversation('abc', 'abc')).toBe(false);
        expect(shouldResetChatConversation('abc', '')).toBe(false);
        expect(shouldResetChatConversation('', '')).toBe(false);
    });
});

function makeLiveSnapshot(totalNodes) {
    // Живой снимок: system-корень первым + цепочка из (totalNodes-1) узлов.
    // Каждый user-текст — "Привет." (без маркеров [entity]/[cite:]).
    const mapping = {};
    const ids = [];
    mapping['root'] = {
        id: 'root', parent: null, children: ['u0'],
        message: { author: { role: 'system' }, content: { parts: [''], content_type: 'text' }, create_time: 0 }
    };
    ids.push('root');
    for (let i = 0; i < totalNodes - 1; i++) {
        const id = 'n' + i;
        const role = (i % 2 === 0) ? 'user' : 'assistant';
        const parentId = (i === 0) ? 'root' : 'n' + (i - 1);
        const children = (i < totalNodes - 2) ? ['n' + (i + 1)] : [];
        mapping[id] = {
            id: id, parent: parentId, children: children,
            message: { author: { role: role }, content: { parts: ['Привет.'], content_type: 'text' }, create_time: i + 1 }
        };
        ids.push(id);
    }
    mapping['root'].children = ['n0'];
    return { mapping: mapping, ids: ids };
}

describe('ChatGPT линеаризация mapping (потеря первого обмена)', () => {
    function makeTurn(id, parent, role, text) {
        return {
            id: id,
            parent: parent,
            children: [],
            message: {
                author: { role: role },
                content: { parts: [text] },
                create_time: 0
            }
        };
    }

    it('3 обмена → 6 сообщений, голова = первый user', () => {
        const mapping = {};
        mapping['msg-root'] = { id: 'msg-root', parent: null, children: ['msg-user-1'], message: { author: { role: 'system' }, content: { parts: [''] } } };
        mapping['msg-user-1'] = makeTurn('msg-user-1', 'msg-root', 'user', 'Первый вопрос');
        mapping['msg-assistant-1'] = makeTurn('msg-assistant-1', 'msg-user-1', 'assistant', 'Первый ответ');
        mapping['msg-user-2'] = makeTurn('msg-user-2', 'msg-assistant-1', 'user', 'Второй вопрос');
        mapping['msg-assistant-2'] = makeTurn('msg-assistant-2', 'msg-user-2', 'assistant', 'Второй ответ');
        mapping['msg-user-3'] = makeTurn('msg-user-3', 'msg-assistant-2', 'user', 'Третий вопрос');
        mapping['msg-assistant-3'] = makeTurn('msg-assistant-3', 'msg-user-3', 'assistant', 'Третий ответ');

        mapping['msg-root'].children = ['msg-user-1'];
        mapping['msg-user-1'].children = ['msg-assistant-1'];
        mapping['msg-assistant-1'].children = ['msg-user-2'];
        mapping['msg-user-2'].children = ['msg-assistant-2'];
        mapping['msg-assistant-2'].children = ['msg-user-3'];
        mapping['msg-user-3'].children = ['msg-assistant-3'];
        mapping['msg-assistant-3'].children = [];

        const result = parseChatGPTConversation({ mapping: mapping });
        expect(result.messages).toHaveLength(6);
        expect(result.messages[0]).toEqual({ role: 'user', content: 'Первый вопрос' });
        expect(result.messages[1]).toEqual({ role: 'assistant', content: 'Первый ответ' });
        expect(result.messages[5]).toEqual({ role: 'assistant', content: 'Третий ответ' });
    });

    it('orderChatGPTMapping возвращает ключи хронологически (голова = первый user)', () => {
        const mapping = {};
        mapping['a'] = makeTurn('a', null, 'user', 'Первый вопрос');
        mapping['b'] = makeTurn('b', 'a', 'assistant', 'Первый ответ');
        mapping['c'] = makeTurn('c', 'b', 'user', 'Второй вопрос');
        mapping['a'].children = ['b'];
        mapping['b'].children = ['c'];
        const keys = orderChatGPTMapping(mapping);
        expect(keys).toEqual(['a', 'b', 'c']);
    });

    it('живой снимок (system-корень первым + цепочка 91 узла) → голова="Привет.", маркеров 0', () => {
        const snap = makeLiveSnapshot(91);
        const ordered = orderChatGPTMapping(snap.mapping);
        expect(ordered.length).toBe(91);
        expect(ordered[0]).toBe('root');

        const result = parseChatGPTConversation({ mapping: snap.mapping });
        // system-корень пропущен, голова = первый user
        expect(result.messages[0].role).toBe('user');
        expect(result.messages[0].content).toBe('Привет.');

        // маркеров [entity]/[cite:] в итоге нет
        const allText = result.messages.map(m => m.content).join('\n');
        expect(allText).not.toMatch(/\[entity\]/);
        expect(allText).not.toMatch(/\[cite:/);
    });
});

describe('ChatGPT санация маркеров', () => {
    it('вырезает [entity][…] и [cite:…]', () => {
        expect(sanitizeChatGPTText('Ответ модели [entity]["some-entity"][cite:turn0search0] продолжение [cite:turn1search2] конец'))
            .toBe('Ответ модели продолжение конец');
        expect(sanitizeChatGPTText('[entity][foo]')).toBe('');
        expect(sanitizeChatGPTText('[cite:turn0searchN]')).toBe('');
    });

    it('склеивает двойные пробелы после вырезки', () => {
        expect(sanitizeChatGPTText('a [entity][x]  b')).toBe('a b');
    });

    it('вырезает PUA-токены cite/image_group (U+E000–U+F8FF)', () => {
        const E200 = '\uE200', E201 = '\uE201', E202 = '\uE202';
        const withCite = `функция ${E200}cite${E202}turn0search2${E202}turn0search14${E201} тут`;
        expect(sanitizeChatGPTText(withCite)).toBe('функция тут');
        const withImageGroup = `шаг ${E200}image_group${E202}{"aspect_ratio":"1:1","query":["a"]}${E201} далее`;
        expect(sanitizeChatGPTText(withImageGroup)).toBe('шаг далее');
        expect(sanitizeChatGPTText(withCite)).not.toMatch(/[\uE000-\uF8FF]/);
    });

    it('PUA entity заменяется на «видимый» текст (Google Chrome, Microsoft Edge)', () => {
        const E200 = '\uE200', E201 = '\uE201', E202 = '\uE202';
        const src = `например, ${E200}entity${E202}["software","Google Chrome","web browser"]${E201} или ${E200}entity${E202}["software","Microsoft Edge","web browser"]${E201}:`;
        expect(sanitizeChatGPTText(src)).toBe('например, Google Chrome или Microsoft Edge:');
        expect(sanitizeChatGPTText(src)).not.toMatch(/[\uE000-\uF8FF]/);
        expect(sanitizeChatGPTText(src)).not.toContain('entity');
    });
});

describe('ChatGPT живой образец (chatgpt-conversation-sample.json)', () => {
    it('голова = "Привет.", маркеров/PUA в текстах нет', () => {
        const fs = require('fs');
        const path = require('path');
        const samplePath = path.join(__dirname, '..', '..', 'chatgpt-conversation-sample.json');
        expect(fs.existsSync(samplePath)).toBe(true);
        const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8'));

        const ordered = orderChatGPTMapping(sample.mapping);
        // после system-корня (ordered[0]) должна идти истинная голова «Привет.»
        expect(ordered[1]).toBe('98c6995a-b4da-4d18-99dd-49a7b23c86f6');

        const result = parseChatGPTConversation(sample);
        expect(result.messages[0].role).toBe('user');
        expect(result.messages[0].content).toBe('Привет.');

        const allText = result.messages.map(m => m.content).join('\n');
        expect(allText).not.toMatch(/\[entity\]/);
        expect(allText).not.toMatch(/\[cite:/);
        expect(allText).not.toMatch(/[\uE000-\uF8FF]/);
        // Санация entity сохраняет видимый текст («Google Chrome или Microsoft Edge»),
        // а не вырезает его вместе с токеном.
        expect(allText).toContain('Google Chrome или Microsoft Edge');
    });
});
