'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
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
Store.state = {
  accountRegs: [], phones: [], expenses: [],
  profiles: [{ id: 'profile-1', code: '2-1' }, { id: 'profile-2', code: '2-2' }],
  archivedProfiles: []
};
Store.save = noop;

let result = Store.upsertAccountReg('profile-1', { phone: '+7 999 111-22-33' });
assert.ok(result.phoneExpense, 'первый номер должен создать расход');
assert.equal(Store.state.expenses.length, 1);
assert.deepEqual(
  JSON.parse(JSON.stringify(Store.state.expenses[0])),
  {
    id: 'phone-cost-account-profile-1',
    date: Store.state.expenses[0].date,
    category: 'Реклама - Номера',
    amount: 99,
    comment: 'Номер 89991112233 · аккаунт 2-1',
    personal: false,
    source: 'account_phone_auto',
    phoneNumber: '89991112233',
    profileId: 'profile-1',
    createdAt: Store.state.expenses[0].createdAt
  }
);

result = Store.upsertAccountReg('profile-1', { phone: '8 (999) 111-22-33' });
assert.equal(result.phoneExpense, null, 'повторное сохранение не должно дублировать расход');
assert.equal(Store.state.expenses.length, 1);

result = Store.upsertAccountReg('profile-2', { phone: '89991112233' });
assert.equal(result.phoneExpense, null, 'повторное использование того же номера не является новой покупкой');
assert.equal(Store.state.expenses.length, 1);

Store.state.expenses.push({
  ...Store.state.expenses[0],
  id: 'legacy-phone-cost-duplicate'
});
result = Store.upsertAccountReg('profile-1', { phone: '89992223344' });
assert.equal(result.phoneExpense, null, 'замена номера не должна создавать новый расход');
assert.equal(Store.state.expenses.length, 1);
assert.equal(Store.state.expenses[0].phoneNumber, '89992223344');
assert.equal(Store.state.expenses[0].comment, 'Номер 89992223344 · аккаунт 2-1');

result = Store.upsertAccountReg('profile-1', { phone: '', avitoPhone: '89993334455' });
assert.equal(result.phoneExpense, null, 'номер Авито не должен создавать расход основного номера');
assert.equal(Store.state.expenses.length, 1);

result = Store.upsertAccountReg('profile-1', { phone: '12345' });
assert.equal(result.phoneExpense, null, 'неполный номер не должен создавать расход');
assert.equal(Store.state.expenses.length, 1);

const statusesSource = fs.readFileSync(path.join(__dirname, '../pages/statuses.html'), 'utf8');
const layoutMatch = statusesSource.match(/const REG_FIELDS_LAYOUT = \[([\s\S]*?)\n    \];/);
assert.ok(layoutMatch, 'список полей карточки должен существовать');
const layout = layoutMatch[1];
for (const field of ['ownerName', 'phone', 'profiEmail', 'cloudPassword', 'recoveryEmail']) {
  assert.match(layout, new RegExp(`\\['${field}'`), `${field} должно остаться в карточке`);
}
for (const field of ['city', 'tg', 'yandexLogin', 'yandexPassword', 'avitoPhone', 'avitoEmail', 'avitoPassword', 'twoGis', 'lat', 'lon', 'notes']) {
  assert.doesNotMatch(layout, new RegExp(`\\['${field}'`), `${field} нужно скрыть из карточки`);
}

console.log('account phone expense: OK');
