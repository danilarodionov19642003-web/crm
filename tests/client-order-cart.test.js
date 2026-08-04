const assert = require('node:assert/strict');
const cart = require('../pages/client/order-cart.js');

const support = { id: 'support', name: 'Поддержка', unit: 'package', qty: 6, price: 8290 };
const develop = { id: 'develop', name: 'Развитие', unit: 'package', qty: 12, price: 15490 };
const wholesale = { id: 'wholesale', name: 'Опт', unit: 'per', qty: 20, price: 900 };

let result = cart.summarize([
  { tariff: support },
  { tariff: develop }
], false);
assert.equal(result.amount, 23780);
assert.equal(result.prepayAmount, 11890);
assert.equal(result.remainder, 11890);
assert.equal(result.allPayFull, false);

result = cart.summarize([
  { tariff: support },
  { tariff: wholesale, qty: 20 }
], true);
assert.equal(result.amount, 26290);
assert.equal(result.prepayAmount, 26290);
assert.equal(result.remainder, 0);
assert.equal(result.items[1].pricing.qty, 20);

assert.deepEqual(cart.validateQuantity(wholesale, 22), {
  valid: true, qty: 22, minimum: 20, message: ''
});
assert.equal(cart.priceItem(wholesale, 22, false).amount, 19800);
assert.equal(cart.priceItem(wholesale, 22, false).prepayAmount, 9900);
assert.equal(cart.validateQuantity(wholesale, 19).valid, false);
assert.match(cart.validateQuantity(wholesale, 19).message, /Минимум 20/);
assert.equal(cart.validateQuantity(wholesale, '').valid, false);
assert.equal(cart.validateQuantity(wholesale, 20.5).valid, false);
assert.equal(cart.validateQuantity(wholesale, 501).valid, false);

const express = { id: 'express', name: 'Экспресс', unit: 'package', qty: 3, price: 4800 };
result = cart.summarize([{ tariff: express }], false, cart.MANUAL_TRANSFER_DISCOUNT);
assert.equal(result.baseAmount, 4800);
assert.equal(result.discount, 300);
assert.equal(result.amount, 4500);
assert.equal(result.prepayAmount, 2250);
assert.equal(result.remainder, 2250);
assert.equal(result.items[0].pricing.discountAmount, 300);

const privateTariff = { unit: 'package', qty: 1, price: 300, fullOnly: true };
assert.deepEqual(cart.priceItem(privateTariff, 1, false), {
  qty: 1, amount: 300, payFull: true, prepayAmount: 300, remainder: 0
});
assert.equal(cart.MAX_ITEMS, 10);
assert.equal(cart.MAX_NEW_ANKETAS, 5);
assert.equal(cart.MANUAL_TRANSFER_DISCOUNT, 300);

console.log('client multi-package cart: OK');
