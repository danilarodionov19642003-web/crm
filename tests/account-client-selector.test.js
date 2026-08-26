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

const { compareClientCodes, clientReviewsRemaining } = context.window.App;

const codes = ['А40', 'a41', 'A-2', 'а1', 'a10', '6-6'];
assert.deepEqual(
  Array.from(codes.sort(compareClientCodes)),
  ['а1', 'A-2', 'a10', 'А40', 'a41', '6-6'],
  'client codes must be sorted by their numeric A-code regardless of alphabet or punctuation'
);

const state = {
  clients: [
    { id: 'c1', code: 'a1', ordered: 4 },
    { id: 'c2', code: 'А-2', ordered: 2 },
    { id: 'c3', code: 'a3', ordered: 3, manualDone: 2 }
  ],
  mentors: [
    { id: 'm1', code: 'А1' },
    { id: 'm2', code: 'a-2' },
    { id: 'm3', code: 'A3' }
  ],
  reviews: [
    { id: 'r1', mentorId: 'm1', profileId: 'p1', moderation: 'approved' },
    { id: 'r2', mentorId: 'm1', profileId: 'p2', moderation: 'approved' },
    { id: 'r3', mentorId: 'm2', profileId: 'p3', moderation: 'approved' }
  ],
  profileStatuses: [
    { mentorId: 'm1', profileId: 'p1', status: '🎯 Готов' },
    { mentorId: 'm1', profileId: 'p2', status: '⭐ Выбрать' },
    { mentorId: 'm2', profileId: 'p3', status: '🎯 Готов' }
  ]
};

assert.equal(clientReviewsRemaining(state, state.mentors[0]), 3,
  'only an approved review that is still Ready counts as completed');
assert.equal(clientReviewsRemaining(state, state.mentors[1]), 1);
assert.equal(clientReviewsRemaining(state, state.mentors[2]), 1,
  'manualDone must be used as the completed minimum');
assert.equal(clientReviewsRemaining(state, { id: 'missing', code: 'a99' }), 0,
  'orphan mentors must not appear in the add-client selector');

const statuses = fs.readFileSync(path.join(root, 'pages/statuses.html'), 'utf8');
assert.match(statuses, /\.filter\(m => clientReviewsRemaining\(Store\.state, m\) > 0\)/);
assert.match(statuses, /\.sort\(\(a, b\) => compareClientCodes\(a\.code, b\.code\)\)/);
assert.match(statuses, /нет клиентов с остатком отзывов/);
assert.match(statuses, /app\.js\?v=20260826c/);

console.log('account client selector: OK');
