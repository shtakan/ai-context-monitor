// Jest setupFiles: options/options.js в исходниках — классический скрипт страницы,
// который зовёт aiCmIsFirefox() как глобал (в расширении его объявляет utils/platform.js
// перед options.js). В Node общего лексического окружения нет, поэтому публикуем функцию
// в global до загрузки тестов. Тело функции читает global.chrome/browser в момент вызова,
// так что per-test моки (chrome-extension:// / moz-extension://) работают штатно.
const { aiCmIsFirefox } = require('../utils/platform.js');

global.aiCmIsFirefox = aiCmIsFirefox;
