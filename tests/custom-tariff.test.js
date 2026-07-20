'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js/app.js'), 'utf8');
const noop = () => {};
const context = {
  console,
  Date,
  setTimeout,
  clearTimeout,
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  document: {
    addEventListener: noop,
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
    body: { appendChild: noop },
    createElement: () => ({ appendChild: noop, remove: noop })
  },
  window: { addEventListener: noop, dispatchEvent: noop }
};
context.window.window = context.window;
vm.createContext(context);
vm.runInContext(source, context);

const Store = context.window.App.Store;
Store.state = {
  paymentSettings: {
    requisites: { bank: 'Т-Банк' },
    tariffs: [
      { id: 'support', name: 'Поддержка', unit: 'package', qty: 6, price: 8290 },
      { id: 't_3975m', name: 'Экспресс', unit: 'package', qty: 3, price: 4800 }
    ]
  }
};
Store._normalizePaymentSettings();

const express = Store.state.paymentSettings.tariffs.find(t => t.id === 't_3975m');
assert.deepEqual(JSON.parse(JSON.stringify(express)), {
  id: 't_3975m', name: 'Экспресс', price: 4800, qty: 3, unit: 'package'
});
assert.equal(Store.state.paymentSettings.tariffs.filter(t => t.name === 'Экспресс').length, 1);
assert.equal(Store.state.paymentSettings.tariffs.length, 5);

console.log('custom payment tariff preservation: OK');
