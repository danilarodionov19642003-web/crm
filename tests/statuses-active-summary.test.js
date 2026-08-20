'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'pages/statuses.html'), 'utf8');

assert.match(
  source,
  /function activeProfileStatuses\(\)[\s\S]*new Set\(\(Store\.state\.profiles \|\| \[\]\)\.map\(profile => profile\.id\)\)[\s\S]*activeProfileIds\.has\(row\.profileId\)/,
  'сводка должна отбирать статусы только для активных аккаунтов'
);
assert.match(
  source,
  /function renderKpis\(\)[\s\S]*const ps = activeProfileStatuses\(\);/,
  'верхние показатели должны использовать только активные аккаунты'
);
assert.match(
  source,
  /function renderPerformers\(\)[\s\S]*const ps = activeProfileStatuses\(\);[\s\S]*const groups = PERFORMERS;/,
  'сводка сотрудников должна использовать активные аккаунты и известных исполнителей'
);
assert.doesNotMatch(
  source,
  /const groups = \[\.\.\.PERFORMERS, ''\]/,
  'отдельной карточки для неуказанного исполнителя быть не должно'
);
assert.doesNotMatch(
  source,
  /perf-card--none/,
  'стиль удалённой карточки неуказанного исполнителя не должен оставаться'
);

console.log('statuses active summary: OK');
