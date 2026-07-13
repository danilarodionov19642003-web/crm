'use strict';

const assert = require('node:assert/strict');
const { calculate } = require('../pages/client/remainder-calculator.js');

const sourceOrders = [
  { id: 26, order_type: 'order', anketa_code: 'a28', anketa_name: 'Максим Б', tariff_name: 'Поддержка', amount: 8290, prepay_amount: 4145, status: 'confirmed', remainder_status: 'pending' },
  { id: 28, order_type: 'order', anketa_code: 'a27', anketa_name: 'Ремонт ИО', tariff_name: 'Опт', amount: 18000, prepay_amount: 9000, status: 'confirmed', remainder_status: 'pending' }
];
const flagshipAnketas = [
  { code: 'a21', name: 'Столичный уют', remain: 7745 },
  { code: 'a22', name: 'Юрий', remain: 7745 },
  { code: 'a27', name: 'Ремонт ИО', remain: 9000 },
  { code: 'a28', name: 'Максим Б', remain: 4145 }
];

function total(items) {
  return items.reduce((sum, item) => sum + item.amount, 0);
}

const flagship = calculate(sourceOrders, flagshipAnketas);
assert.equal(total(flagship), 28635, 'Флагман должен видеть весь остаток 28 635 ₽');
assert.deepEqual(
  Object.fromEntries(flagship.map(item => [item.code, item.amount])),
  { a28: 4145, a27: 9000, a21: 7745, a22: 7745 }
);

const pendingModern = calculate(sourceOrders.concat({
  id: 40,
  order_type: 'remainder',
  status: 'new',
  items: [{ code: 'a28', name: 'Максим Б', amount: 4145, source_order_id: '26' }]
}), flagshipAnketas);
assert.equal(total(pendingModern), 24490, 'остаток с уже отправленной A-28 не должен предлагаться повторно');

const pendingLegacy = calculate(sourceOrders.concat({
  id: 41,
  order_type: 'remainder',
  status: 'new',
  items: [{ code: 'a21', name: 'Столичный уют', amount: 7745, source_order_id: null }]
}), flagshipAnketas);
assert.equal(total(pendingLegacy), 20890, 'старый остаток A-21 на проверке не должен дублироваться');

const closedSource = sourceOrders.map(order => order.id === 26
  ? { ...order, remainder_status: null }
  : order);
const staleSnapshot = calculate(closedSource.concat({
  id: 42,
  order_type: 'remainder',
  status: 'confirmed',
  items: [{ code: 'a28', name: 'Максим Б', amount: 4145, source_order_id: '26' }]
}), flagshipAnketas);
assert.equal(total(staleSnapshot), 24490, 'подтверждённая доплата не должна воскреснуть из ещё не обновлённого снимка');

console.log('client remainder calculator: OK');
