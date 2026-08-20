'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
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
  window: { addEventListener: noop, dispatchEvent: noop }
};
context.window.window = context.window;
vm.createContext(context);
vm.runInContext(source, context);

const { normalizeSearchText } = context.window.App;
const searchable = normalizeSearchText('25-1 МСК Анна 8 (999) 111-22-33 a20 · Лиана Русский');

for (const query of ['A20', 'А20', 'а-20', 'a 20']) {
  assert.ok(searchable.includes(normalizeSearchText(query)), `${query} must find the same client code`);
}
assert.ok(searchable.includes(normalizeSearchText('Анна')),
  'normalizing Cyrillic А must not break owner-name search');
assert.ok(searchable.includes(normalizeSearchText('25 1')),
  'account codes must be searchable with either a hyphen or a space');

const statuses = fs.readFileSync(path.join(root, 'pages/statuses.html'), 'utf8');
assert.match(statuses, /filters\.q = normalizeSearchText\(e\.target\.value\)/);
assert.match(statuses, /const blob = normalizeSearchText\(/);
assert.match(statuses, /app\.js\?v=20260820g/);

console.log('account search normalization: OK');
