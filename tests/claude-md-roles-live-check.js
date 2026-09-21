// tests/claude-md-roles-live-check.js
// READ-ONLY замер корня дефекта «Claude md: все ходы → ## Ассистент».
// Не коммитить. Ничего не мутирует: только читает utils/export-text-builders.js.
const fs = require('fs');
const path = require('path');

// Читаем buildMdFromHistory
const buildersPath = path.join(__dirname, '../utils/export-text-builders.js');
const buildersCode = fs.readFileSync(buildersPath, 'utf-8');

// 1. Проверяем условие user/human в md-пути
const hasHumanCheck = buildersCode.includes("msg.role === 'human'");
const hasUserCheck = buildersCode.includes("msg.role === 'user'");
console.log('Условие msg.role === "human" присутствует:', hasHumanCheck);
console.log('Условие msg.role === "user" присутствует:', hasUserCheck);
const condMatch = buildersCode.match(/:\s*\(\(msg\.role[\s\S]{0,120}?\)\)/);
console.log('Точное условие:', condMatch ? condMatch[0].replace(/\s+/g, ' ') : 'НЕ НАЙДЕНО');

// 2. Проверяем TXT_ROLE_MARKER_SITES
const markerSitesMatch = buildersCode.match(/TXT_ROLE_MARKER_SITES\s*=\s*\[([^\]]*)\]/);
if (markerSitesMatch) {
  console.log('TXT_ROLE_MARKER_SITES:', markerSitesMatch[1]);
}

// 3. Проверяем isTxtRoleMarkerHistory
const isTxtRoleMarkerMatch = buildersCode.match(/function isTxtRoleMarkerHistory\(history\)\s*\{[\s\S]*?\n  \}/);
if (isTxtRoleMarkerMatch) {
  console.log('isTxtRoleMarkerHistory:', isTxtRoleMarkerMatch[0].replace(/\n\s*/g, ' '));
}

// 4. Практическая проверка через публичный API модуля (если экспортируется)
let api = null;
try {
  api = require(buildersPath);
} catch (e) {
  console.log('require(export-text-builders) не удался:', e.message);
}
const g = (typeof globalThis !== 'undefined') ? globalThis : global;
const sites = (g && g.aiCmTxtRoleMarkerSites) || (api && api.aiCmTxtRoleMarkerSites);
if (Array.isArray(sites)) {
  console.log('aiCmTxtRoleMarkerSites (рантайм):', JSON.stringify(sites));
} else {
  console.log('aiCmTxtRoleMarkerSites (рантайм): не экспортирован в этой среде');
}
const fn = (g && g.aiCmIsTxtRoleMarkerHistory) || (api && api.aiCmIsTxtRoleMarkerHistory);
if (typeof fn === 'function') {
  ['claude', 'qwen', 'deepseek', 'chatgpt', 'gemini', 'grok', '', null].forEach(function (s) {
    let r;
    try { r = fn({ site: s }); } catch (e) { r = 'throw:' + e.message; }
    console.log('  mdMarked(' + JSON.stringify(s) + ') =', r);
  });
} else {
  console.log('aiCmIsTxtRoleMarkerHistory: не экспортирован в этой среде');
}

// 5. Ищем фактический role, который кладёт claude-путь (для контекста)
const claudeSrc = fs.readFileSync(path.join(__dirname, '../core/claude-intercept.js'), 'utf-8');
const roles = Array.from(new Set((claudeSrc.match(/role\s*[:=]\s*'[^']+'/g) || [])));
console.log('role-литералы в core/claude-intercept.js:', roles.join(' | ') || 'нет');
