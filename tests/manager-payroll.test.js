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
  ],
  expenses: []
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

const payment = Store.addPayment(ilya.id, {
  id: 'ilya-pay-1', date: '2026-07-10', amount: 1234, note: 'частичная выплата'
});
assert.equal(payment.amount, 1234, 'можно внести произвольную сумму выплаты');
assert.equal(ilya.paid, 1234, 'выплата должна увеличивать выплаченную сумму');
assert.deepEqual(
  JSON.parse(JSON.stringify(Store.state.expenses[0])),
  {
    id: 'employee-payment-ilya-pay-1',
    date: '2026-07-10',
    category: 'Зарплаты',
    amount: 1234,
    comment: 'ЗП сотруднику Илья · частичная выплата',
    personal: false,
    source: 'employee_payment',
    employeeId: ilya.id,
    employeePaymentId: 'ilya-pay-1',
    createdAt: Store.state.expenses[0].createdAt
  },
  'выплата задним числом должна стать рабочим расходом на ту же дату'
);
assert.equal(Store.deletePayment(ilya.id, 'ilya-pay-1'), true);
assert.equal(ilya.paid, 0, 'удаление выплаты должно откатить выплаченную сумму');
assert.equal(Store.state.expenses.length, 0, 'связанный расход должен удалиться вместе с выплатой');

ilya.advanceDebt = 5620;
const splitPayment = Store.addPayment(ilya.id, {
  id: 'ilya-split-pay-1',
  date: '2026-08-31',
  amount: 3000,
  cashAmount: 1500,
  debtOffset: 1500,
  note: '50% в погашение долга'
});
assert.equal(splitPayment.cashAmount, 1500, 'в кассу должна попадать только сумма на руки');
assert.equal(splitPayment.debtOffset, 1500, 'половина выплаты должна погашать долг сотрудника');
assert.equal(ilya.paid, 3000, 'вся начисленная зарплата должна считаться закрытой');
assert.equal(ilya.advanceDebt, 4120, 'долг сотрудника должен уменьшаться на удержание');
assert.deepEqual(
  JSON.parse(JSON.stringify(Store.state.expenses[0])),
  {
    id: 'employee-payment-ilya-split-pay-1',
    date: '2026-08-31',
    category: 'Зарплаты',
    amount: 1500,
    comment: 'ЗП сотруднику Илья · 50% в погашение долга',
    personal: false,
    source: 'employee_payment',
    employeeId: ilya.id,
    employeePaymentId: 'ilya-split-pay-1',
    createdAt: Store.state.expenses[0].createdAt,
    grossAmount: 3000,
    debtOffset: 1500
  },
  'расход должен равняться сумме, реально выданной сотруднику'
);
assert.equal(Store.deletePayment(ilya.id, 'ilya-split-pay-1'), true);
assert.equal(ilya.paid, 0, 'удаление разделённой выплаты должно откатывать закрытую зарплату');
assert.equal(ilya.advanceDebt, 5620, 'удаление разделённой выплаты должно восстанавливать долг сотрудника');
assert.equal(Store.state.expenses.length, 0, 'расход разделённой выплаты должен удаляться вместе с ней');

const clientsHtml = fs.readFileSync(path.join(root, 'pages/clients.html'), 'utf8');
const tasksHtml = fs.readFileSync(path.join(root, 'pages/tasks.html'), 'utf8');
const employeesHtml = fs.readFileSync(path.join(root, 'pages/employees.html'), 'utf8');
assert.match(employeesHtml, /data-act="payout" title="Внести выплату"/,
  'главная кнопка должна предлагать ввод выплаты, а не оплату всего долга');
assert.match(employeesHtml, /payoutBtn\.addEventListener\('click', \(\) => openPayments\(id\)\)/,
  'кнопка выплаты должна открывать форму с редактируемой суммой и датой');
assert.doesNotMatch(employeesHtml, /обнулить долг/,
  'быстрая выплата всего долга не должна обходить форму частичной выплаты');
assert.match(clientsHtml, /data-field="manager"/, 'в карточке клиента нужен селектор менеджера');
assert.match(clientsHtml, /id="mManager"/, 'менеджер должен назначаться при создании клиента');
assert.match(tasksHtml, /id="fManager"/, 'в задачах нужен фильтр по менеджеру');
assert.match(tasksHtml, /matchesManager\(String\(c\.manager/, 'фильтр должен применяться к календарю графиков');
assert.match(tasksHtml, /managerForMentor\(t\.mentorId\)/, 'задача должна наследовать менеджера клиента');

console.log('manager payroll and task ownership: OK');
