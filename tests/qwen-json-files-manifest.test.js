'use strict';
/**
 * Qwen JSON: в `files[]` не должно быть raw signed URL (JWT) и транспортных
 * полей. Внутренний raw URL нужен core/qwen-files.js для скачивания текста и
 * в файл не пишется; в JSON остаётся безопасный манифест вложения.
 */

const loadEsm = require('./helpers/load-esm.js');
const Builders = loadEsm.loadEsmGlobal('utils/export-text-builders.ts', 'AiCmExportBuilders');

const RAW_FILE = {
  id: 'file-1',
  name: 'image.png',
  file_type: 'image/png',
  type: 'image',
  file_class: 'vision',
  size: 388828,
  status: 'uploaded',
  url: 'https://cdn.qwenlm.ai/u/file-1_image.png?key=JWT.SIGNATURE',
  file: { user_id: 'u-1', id: 'file-1' },
  uploadTaskId: 'task-1',
  greenNet: 1,
  progress: 100,
  error: null,
  itemId: 'item-1',
  collection_name: 'c',
  showType: 's'
};

function build(site, files) {
  return JSON.parse(Builders.buildJsonFromHistory({
    site: site,
    model: 'Qwen3.7-Plus',
    messages: [{ role: 'user', text: 'вопрос', id: 'node-1', files: files }]
  }, site === 'qwen' ? 'Qwen' : 'DeepSeek'));
}

describe('Qwen JSON: безопасный манифест files', () => {
  test('остаются только id/name/file_type/type/file_class/size/status', () => {
    const parsed = build('qwen', [RAW_FILE]);
    expect(parsed.messages[0].id).toBe('node-1');
    expect(parsed.messages[0].files).toEqual([{
      id: 'file-1',
      name: 'image.png',
      file_type: 'image/png',
      type: 'image',
      file_class: 'vision',
      size: 388828,
      status: 'uploaded'
    }]);
  });

  test('raw URL, вложенный file и транспортные поля не попадают в файл', () => {
    const text = JSON.stringify(build('qwen', [RAW_FILE]));
    expect(text).not.toContain('cdn.qwenlm.ai');
    expect(text).not.toContain('JWT.SIGNATURE');
    expect(text).not.toContain('uploadTaskId');
    expect(text).not.toContain('greenNet');
    expect(text).not.toContain('progress');
    expect(text).not.toContain('collection_name');
    expect(text).not.toContain('showType');
    expect(text).not.toContain('user_id');
  });

  test('битый/пустой files не оставляет поле', () => {
    const parsed = build('qwen', [{}]);
    expect(parsed.messages[0].files).toBeUndefined();
  });

  test('другие платформы: files байтово прежние', () => {
    const parsed = build('deepseek', [RAW_FILE]);
    expect(parsed.messages[0].files).toEqual([RAW_FILE]);
  });
});
