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
  accountRegs: [
    { id: 'reg-source-1', profileId: 'source-1', cloudPassword: 'shared-cloud-password' },
    { id: 'reg-source-2', profileId: 'source-2', cloudPassword: 'shared-cloud-password' },
    { id: 'reg-source-3', profileId: 'source-3', cloudPassword: 'other-password' }
  ], phones: [], expenses: [],
  profiles: [
    { id: 'profile-1', code: '2-1' }, { id: 'profile-2', code: '2-2' },
    { id: 'source-1', code: '1-1' }, { id: 'source-2', code: '1-2' }, { id: 'source-3', code: '1-3' }
  ],
  archivedProfiles: []
};
Store.save = noop;

assert.equal(Store.getDefaultCloudPassword(), 'shared-cloud-password',
  'без 18-2 должен использоваться самый частый облачный пароль');

const newProfile = Store.addProfile({ code: '2-3' });
assert.equal(Store.getAccountReg(newProfile.id).cloudPassword, 'shared-cloud-password',
  'новый аккаунт должен сразу получить общий облачный пароль');

let result = Store.upsertAccountReg('profile-1', { phone: '+7 999 111-22-33' });
assert.ok(result.phoneExpense, 'первый номер должен создать расход');
assert.equal(result.registration.cloudPassword, 'shared-cloud-password',
  'при первом сохранении регистрации общий пароль должен закрепиться');
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
assert.match(statusesSource, /cloudPassword: Store\.getDefaultCloudPassword\(\)/,
  'новая карточка должна показывать общий пароль до первого сохранения');

Store.state.profiles.push({ id: 'source-18-2', code: '18-2' });
Store.state.accountRegs.push({ id: 'reg-18-2', profileId: 'source-18-2', cloudPassword: 'preferred-18-2-password' });
assert.equal(Store.getDefaultCloudPassword(), 'preferred-18-2-password',
  'пароль аккаунта 18-2 должен иметь приоритет над самым частым');

console.log('account phone expense: OK');
