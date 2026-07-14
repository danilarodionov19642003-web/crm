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

const privateTariff = { unit: 'package', qty: 1, price: 300, fullOnly: true };
assert.deepEqual(cart.priceItem(privateTariff, 1, false), {
  qty: 1, amount: 300, payFull: true, prepayAmount: 300, remainder: 0
});
assert.equal(cart.MAX_ITEMS, 10);
assert.equal(cart.MAX_NEW_ANKETAS, 5);

console.log('client multi-package cart: OK');
