'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('../pages/client/package-progress.js');

const orders = [
  { id: 40, anketa_code: 'a21', tariff_name: 'Развитие', qty: 12, status: 'confirmed', order_type: 'order', confirmed_at: '2026-04-02' },
  { id: 41, anketa_code: 'A-21', tariff_name: 'Поддержка', qty: 3, status: 'confirmed', order_type: 'order', confirmed_at: '2026-07-13', comment: 'MANUAL:A21:TRANSFER-A28-3' },
  { id: 42, anketa_code: 'a21', tariff_name: 'Опт', qty: 20, status: 'confirmed', order_type: 'order', confirmed_at: '2026-07-14' },
  { id: 43, anketa_code: 'a21', tariff_name: 'Отклонён', qty: 99, status: 'rejected', order_type: 'order' },
  { id: 44, anketa_code: 'a21', tariff_name: 'Доплата', qty: 99, status: 'confirmed', order_type: 'remainder' }
];

const packages = build(orders, { code: 'A-21', ordered: 35, done: 3 }, 10);
assert.deepEqual(packages.map(p => ({ name: p.name, qty: p.qty, done: p.done, active: p.active, state: p.state })), [
  { name: 'Развитие', qty: 12, done: 3, active: 9, state: 'active' },
  { name: 'Поддержка', qty: 3, done: 0, active: 1, state: 'active' },
  { name: 'Опт', qty: 20, done: 0, active: 0, state: 'queued' }
]);
assert.equal(packages[1].transferred, true);

const legacy = build([], { code: 'a99', tariff: 'Поддержка', ordered: 6, done: 6 }, 0);
assert.deepEqual(legacy.map(p => ({ name: p.name, qty: p.qty, done: p.done, state: p.state })), [
  { name: 'Поддержка', qty: 6, done: 6, state: 'closed' }
]);

const clientApp = fs.readFileSync(path.join(__dirname, '../pages/client/client-app.js'), 'utf8');
assert.match(clientApp, /Math\.min\(100, Math\.round\(\(\(br\.active \+ effectiveDone\)/,
  'процент карточки должен быть ограничен 100%');

console.log('client package progress: OK');
