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

const { Store } = context.window.App;
let saves = 0;
Store.save = () => { saves += 1; };
Store.state = {
  clients: [
    { id: 'client-a37', code: 'a37', name: 'Клиент 37' },
    { id: 'client-a40', code: 'A-40', name: 'Клиент 40' }
  ],
  mentors: [
    { id: 'mentor-a37', code: 'a37', name: 'Клиент 37' },
    { id: 'mentor-a38', code: 'a-38', name: 'Старая анкета 38' }
  ]
};

assert.equal(Store.findClientCodeOwner('A-37').record.id, 'client-a37');
assert.equal(Store.findClientCodeOwner(' a 37 ').record.id, 'client-a37');
assert.equal(Store.findClientCodeOwner('А-37').record.id, 'client-a37',
  'русская А не должна обходить проверку занятого кода');
assert.equal(Store.findClientCodeOwner('a38').record.id, 'mentor-a38',
  'проверка учитывает старые записи раздела «Аккаунты»');
assert.equal(Store.findClientCodeOwner('a39'), null);

const clientsBefore = Store.state.clients.length;
const duplicate = Store.addClient({ code: 'A-37', name: 'Дубликат' });
assert.equal(duplicate, null);
assert.equal(Store.state.clients.length, clientsBefore);
assert.equal(saves, 0, 'дубликат не должен сохраняться');

const created = Store.addClient({ code: 'A-39', name: 'Новый клиент' });
assert.ok(created);
assert.equal(Store.state.clients.length, clientsBefore + 1);
assert.equal(Store.findClientCodeOwner('a39').record.id, created.id);
assert.equal(saves, 1);

const duplicateMentor = Store.addMentor({ code: 'А-40', name: 'Дубликат 40' });
assert.equal(duplicateMentor, null);
assert.equal(saves, 1);
assert.equal(Store._nextMentorCode(), 'a41',
  'следующий код вычисляется по клиентам и старым записям во всех форматах');

const clientsHtml = fs.readFileSync(path.join(root, 'pages/clients.html'), 'utf8');
const statusesHtml = fs.readFileSync(path.join(root, 'pages/statuses.html'), 'utf8');
assert.match(clientsHtml, /id="mCodeFeedback"/);
assert.match(clientsHtml, /mCodeInput\.addEventListener\('input', validateNewClientCode\)/);
assert.match(statusesHtml, /id="mnCodeFeedback"/);
assert.match(statusesHtml, /mnCodeInput\.addEventListener\('input', validateNewMentorCode\)/);

console.log('client code uniqueness: OK');
