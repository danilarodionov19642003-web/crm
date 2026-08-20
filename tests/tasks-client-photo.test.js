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

console.log('tasks client photo preview: OK');
