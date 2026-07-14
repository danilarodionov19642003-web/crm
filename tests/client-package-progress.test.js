'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('../pages/client/package-progress.js');

const orders = [
  { id: 40, anketa_code: 'a21', tariff_name: 'Развитие', qty: 12, status: 'confirmed', order_type: 'order', confirmed_at: '2026-04-02' },
  { id: 41, anketa_code: 'A-21', tariff_name: 'Поддержка', qty: 3, status: 'confirmed', order_type: 'order', confirmed_at: '2026-07-13T13:42:37Z', comment: 'MANUAL:A21:TRANSFER-A28-3' },
  { id: 42, anketa_code: 'a21', tariff_name: 'Опт', qty: 20, status: 'confirmed', order_type: 'order', confirmed_at: '2026-07-13T13:42:38Z' },
  { id: 43, anketa_code: 'a21', tariff_name: 'Отклонён', qty: 99, status: 'rejected', order_type: 'order' },
  { id: 44, anketa_code: 'a21', tariff_name: 'Доплата', qty: 99, status: 'confirmed', order_type: 'remainder' }
];

const packages = build(orders, {
  code: 'A-21', ordered: 35, done: 3,
  packageExtras: [{
    id: 'bonus-a21-1', name: 'Бонусный отзыв', qty: 1,
    date: '2026-07-13T13:42:36Z', countsTowardOrdered: false
  }]
}, 10);
assert.deepEqual(packages.map(p => ({ name: p.name, qty: p.qty, done: p.done, active: p.active, state: p.state })), [
  { name: 'Развитие', qty: 12, done: 3, active: 9, state: 'active' },
  { name: 'Бонусный отзыв', qty: 1, done: 0, active: 1, state: 'active' },
  { name: 'Поддержка', qty: 3, done: 0, active: 0, state: 'queued' },
  { name: 'Опт', qty: 20, done: 0, active: 0, state: 'queued' }
]);
assert.equal(packages[1].bonus, true);
assert.equal(packages[2].transferred, true);

const a22 = build([
  { id: 50, anketa_code: 'a22', tariff_name: 'Развитие', qty: 12, status: 'confirmed', order_type: 'order', confirmed_at: '2026-04-02T09:00:00Z' }
], {
  code: 'a22', ordered: 14, done: 2,
  packageExtras: [{
    id: 'bonus-a22-2', name: 'Бонусные отзывы', qty: 2,
    date: '2026-04-02T09:00:01Z', countsTowardOrdered: true
  }]
}, 6);
assert.deepEqual(a22.map(p => ({ name: p.name, qty: p.qty, done: p.done, active: p.active, state: p.state })), [
  { name: 'Развитие', qty: 12, done: 2, active: 6, state: 'active' },
  { name: 'Бонусные отзывы', qty: 2, done: 0, active: 0, state: 'queued' }
]);

const legacy = build([], { code: 'a99', tariff: 'Поддержка', ordered: 6, done: 6 }, 0);
assert.deepEqual(legacy.map(p => ({ name: p.name, qty: p.qty, done: p.done, state: p.state })), [
  { name: 'Поддержка', qty: 6, done: 6, state: 'closed' }
]);

const clientApp = fs.readFileSync(path.join(__dirname, '../pages/client/client-app.js'), 'utf8');
assert.match(clientApp, /Math\.min\(100, Math\.round\(\(\(br\.active \+ effectiveDone\)/,
  'процент карточки должен быть ограничен 100%');
const storeApp = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
assert.match(storeApp, /packageExtras: client && Array\.isArray\(client\.packageExtras\)/,
  'бонусные пакеты должны попадать в клиентский снимок');

console.log('client package progress: OK');
