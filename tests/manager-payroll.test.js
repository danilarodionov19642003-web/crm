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

const Store = context.window.App.Store;
Store.state = {
  employees: [{
    id: 'legacy-nastya', name: 'Настя', role: 'Ревьюер',
    ratePerReview: 300, reviewsDone: 2, paid: 0,
    status: 'active', hired: '2026-04-01', payments: []
  }],
  profileStatuses: [
    ...Array.from({ length: 24 }, (_, i) => ({ id: `i-${i}`, performer: 'Илья' })),
    ...Array.from({ length: 64 }, (_, i) => ({ id: `d-${i}`, performer: 'Данил' })),
    { id: 'none-1', performer: '' }
  ]
};

Store._migrateManagerPayroll();
Store._syncEmployeeWorkCounts();

assert.equal(Store.state.employees.some(e => e.name === 'Настя'), false,
  'Настя должна быть полностью удалена из зарплатного списка');
const ilya = Store.state.employees.find(e => e.name === 'Илья');
const danil = Store.state.employees.find(e => e.name === 'Данил');
assert.ok(ilya && danil, 'Илья и Данил должны быть созданы миграцией');
assert.equal(ilya.ratePerReview, 300, 'Илья наследует прежнюю редактируемую ставку');
assert.equal(danil.ratePerReview, 0, 'Данил не должен получать случайно начисленную зарплату владельца');
assert.equal(ilya.reviewsDone, 24, 'Илье должны считаться все его отметки в аккаунтах');
assert.equal(danil.reviewsDone, 64, 'Данилу должны считаться все его отметки в аккаунтах');
assert.equal(ilya.paid, 0, 'старые выплаты Насти не переносятся Илье');

ilya.ratePerReview = 450;
Store._syncEmployeeWorkCounts();
assert.equal(ilya.ratePerReview, 450, 'автоподсчёт не должен затирать ручную ставку');

const clientsHtml = fs.readFileSync(path.join(root, 'pages/clients.html'), 'utf8');
const tasksHtml = fs.readFileSync(path.join(root, 'pages/tasks.html'), 'utf8');
assert.match(clientsHtml, /data-field="manager"/, 'в карточке клиента нужен селектор менеджера');
assert.match(clientsHtml, /id="mManager"/, 'менеджер должен назначаться при создании клиента');
assert.match(tasksHtml, /id="fManager"/, 'в задачах нужен фильтр по менеджеру');
assert.match(tasksHtml, /matchesManager\(String\(c\.manager/, 'фильтр должен применяться к календарю графиков');
assert.match(tasksHtml, /managerForMentor\(t\.mentorId\)/, 'задача должна наследовать менеджера клиента');

console.log('manager payroll and task ownership: OK');
