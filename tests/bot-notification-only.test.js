'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const patch = fs.readFileSync(
  path.join(root, 'ops/telegram/patches/bot-notification-only.patch'),
  'utf8'
);

assert.match(patch, /\+\s+"📥 Заявки":\s+"orders"/,
  'кнопка заявок должна остаться');
assert.match(patch, /\+\s+"📅 Отклики":\s+"schedule"/,
  'CRM-график должен остаться');
assert.match(patch, /-\s+"📊 Активные":\s+"stats"/,
  'панель рассылок должна быть удалена');
assert.match(patch, /-async def periodic_report_loop/,
  'автоматический отчёт рассылки должен быть удалён');
assert.match(patch, /-@dp\.business_message\(\)/,
  'Telegram Business автоответчик старого софта должен быть отключён');
assert.match(patch, /menu_schema = "notification-only-v1"/,
  'старая клавиатура должна быть сброшена после обновления');
assert.doesNotMatch(patch, /^-.*channel_post/m,
  'уведомления и публикации канала нельзя отключать');
assert.doesNotMatch(patch, /^-.*schedule_reminder\.reminder_loop/m,
  'системные напоминания CRM нельзя отключать');

console.log('bot notification-only mode: OK');
