#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function usage() {
  throw new Error('Usage: node ops/reconcile-phone-expenses.js <input.json> [output.json]');
}

const inputPath = process.argv[2] ? path.resolve(process.argv[2]) : usage();
const outputPath = process.argv[3] ? path.resolve(process.argv[3]) : '';
const source = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
const state = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const noop = () => {};
const context = {
  console,
  Date,
  setTimeout,
  clearTimeout,
  CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  document: {
    addEventListener: noop,
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
    body: { appendChild: noop },
    createElement: () => ({ className: '', textContent: '', appendChild: noop, remove: noop })
  },
  window: {
    addEventListener: noop,
    dispatchEvent: noop,
    SEED_INCOMES: [],
    SEED_EXPENSES: [],
    SEED_CLIENTS: [],
    SEED_SUBSCRIPTIONS: []
  }
};
context.window.window = context.window;
vm.createContext(context);
vm.runInContext(source, context);

const Store = context.window.App.Store;
Store.state = state;
Store.save = noop;
const report = Store.reconcileAccountPhoneExpenses({ save: false });

if (outputPath) {
  fs.writeFileSync(outputPath, `${JSON.stringify(Store.state)}\n`, { mode: 0o600 });
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
