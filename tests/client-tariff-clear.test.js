'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'pages', 'clients.html'), 'utf8');
const source = html.match(/function tariffByName\(name\)[\s\S]+?(?=\n    function refreshAddTariffTotals)/);
assert.ok(source, 'tariff helpers must be present');

let payments = [];
let activity = 0;
const context = {
  TARIFFS: [{ id: 'support', name: 'Поддержка', unit: 'package', qty: 6, price: 8290 }],
  Store: { getPaymentsForClient: () => payments },
  deriveDone: client => Number(client.done) || 0,
  accountsForClient: () => ({ total: activity })
};
vm.createContext(context);
vm.runInContext(`${source[0]}; this.tariffPatch = tariffPatch;`, context);

const plain = value => JSON.parse(JSON.stringify(value));
const untouched = { id: 'a40', tariff: 'Поддержка', ordered: 6, paid: 0, total: 8290, remain: 8290, done: 0 };
assert.deepEqual(plain(context.tariffPatch('', untouched)), {
  tariff: '', ordered: 0, total: 0, remain: 0
});

assert.deepEqual(plain(context.tariffPatch('', { ...untouched, paid: 4145, remain: 4145 })), {
  tariff: ''
}, 'paid packages must keep their financial fields');

payments = [{ amount: 4145 }];
assert.deepEqual(plain(context.tariffPatch('', untouched)), { tariff: '' },
  'packages with payment history must keep their financial fields');

payments = [];
activity = 1;
assert.deepEqual(plain(context.tariffPatch('', untouched)), { tariff: '' },
  'packages already assigned to work must keep their financial fields');

console.log('safe unpaid tariff clearing: OK');
