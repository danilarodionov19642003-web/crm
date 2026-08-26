'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
const clientApp = fs.readFileSync(path.join(root, 'pages/client/client-app.js'), 'utf8');
const clientCss = fs.readFileSync(path.join(root, 'pages/client/client.css'), 'utf8');
const clientIndex = fs.readFileSync(path.join(root, 'pages/client/index.html'), 'utf8');
const migration = fs.readFileSync(
  path.join(root, 'sql/migrations/2026-08-25_client_completed_anketas.sql'),
  'utf8'
);

assert.match(app, /closed: client \? client\.closed === true : false/,
  'снимок кабинета должен получать безопасный флаг closed');
assert.match(clientApp, /function isCompletedAnketa\(anketa\)/);
assert.match(clientApp, /const activeAnketas = anketas\.filter\(a => !isCompletedAnketa\(a\)\)/);
assert.match(clientApp, /const completedAnketas = anketas\.filter\(isCompletedAnketa\)/);
assert.match(clientApp, /data-anketa-mode="active"/);
assert.match(clientApp, /data-anketa-mode="completed"/);
assert.match(clientApp, /Завершённые/);
assert.match(clientCss, /\.cli-anketa-tabs/);
assert.match(clientIndex, /client-app\.js\?v=20260826c/);
assert.match(clientIndex, /client\.css\?v=20260826c/);
assert.match(clientCss, /\.cli-tg-connect > \.cli-check-row \{ margin: 10px 0 13px; \}/,
  'чекбокс согласования не должен прилипать к кнопке подключения Telegram');
assert.match(migration, /client_snapshots/);
assert.match(migration, /client_item ->> 'closed'/);
assert.doesNotMatch(migration, /update\s+public\.crm_state/i,
  'миграция снимков не должна менять основную CRM');

console.log('client completed anketas: OK');
