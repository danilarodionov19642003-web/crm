'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const tasksHtml = fs.readFileSync(path.join(root, 'pages', 'tasks.html'), 'utf8');

assert.match(tasksHtml, /id="clientPhotoModal"/,
  'tasks: отсутствует окно быстрого просмотра фотографии');
assert.match(tasksHtml, /data-client-photo=/,
  'tasks: плашка клиента не открывает фотографию');
assert.match(tasksHtml, /function openClientPhoto\(mentorId\)/,
  'tasks: отсутствует обработчик просмотра фотографии');
assert.match(tasksHtml, /url\.hostname === 'cdn\.profi\.ru'/,
  'tasks: фотография должна приниматься только с разрешённого CDN Profi.ru');
assert.match(tasksHtml, /referrerpolicy="no-referrer"/,
  'tasks: фотография должна загружаться без передачи адреса CRM');
assert.match(tasksHtml, /Фотография для этой анкеты пока не загружена/,
  'tasks: для анкет без фото нужен понятный пустой экран');
assert.match(tasksHtml, /function scheduleAvatarHtml\(row\)/,
  'tasks: календарь должен собирать компактную аватарку для каждой анкеты');
assert.match(tasksHtml, /rows\.map\(scheduleAvatarHtml\)/,
  'tasks: одинаковые цвета не должны объединять разные анкеты в одну отметку');
assert.match(tasksHtml, /class="sched-cell__avatars"/,
  'tasks: ячейка календаря должна показывать аватарки вместо цветных точек');
assert.doesNotMatch(tasksHtml, /new Set\(rows\.map\(r => r\.color\)\)/,
  'tasks: календарь не должен терять анкеты из-за совпавшего цвета');
assert.match(tasksHtml, /data-sched-avatar/,
  'tasks: при ошибке загрузки аватарки должен оставаться инициал анкеты');

console.log('tasks client photo preview: OK');
