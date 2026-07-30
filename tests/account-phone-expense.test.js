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
  'без 17-2 должен использоваться самый частый облачный пароль');

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
assert.ok(result.phoneExpense, 'каждая карточка аккаунта должна получить собственный расход');
assert.equal(Store.state.expenses.length, 2);

Store.state.expenses.push({
  ...Store.state.expenses[0],
  id: 'legacy-phone-cost-duplicate'
});
result = Store.upsertAccountReg('profile-1', { phone: '89992223344' });
assert.equal(result.phoneExpense, null, 'замена номера не должна создавать новый расход');
assert.equal(Store.state.expenses.length, 2);
assert.equal(Store.state.expenses[0].phoneNumber, '89992223344');
assert.equal(Store.state.expenses[0].comment, 'Номер 89992223344 · аккаунт 2-1');

result = Store.upsertAccountReg('profile-1', { phone: '', avitoPhone: '89993334455' });
assert.equal(result.phoneExpense, null, 'номер Авито не должен создавать расход основного номера');
assert.equal(Store.state.expenses.length, 2);

result = Store.upsertAccountReg('profile-1', { phone: '12345' });
assert.equal(result.phoneExpense, null, 'неполный номер не должен создавать расход');
assert.equal(Store.state.expenses.length, 2);

Store.state.archivedProfiles.push({ id: 'archived-profile', code: '9-9', archived: true });
Store.state.accountRegs.push({
  id: 'archived-reg',
  profileId: 'archived-profile',
  phone: '89994445566'
});
assert.deepEqual(
  Array.from(Store.profilesUsingPhone('+7 (999) 444-55-66')),
  ['archived-profile'],
  'общая проверка номера должна находить регистрацию архивного аккаунта'
);

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
assert.match(statusesSource, /function profileById\(id\) \{[\s\S]*?Store\.getProfileOrArchived\(id\)/,
  'предупреждение о дубликате должно уметь показать код архивного аккаунта');

Store.state.profiles.push({ id: 'source-17-2', code: '17-2' });
Store.state.accountRegs.push({ id: 'reg-17-2', profileId: 'source-17-2', cloudPassword: 'preferred-17-2-password' });
assert.equal(Store.getDefaultCloudPassword(), 'preferred-17-2-password',
  'пароль аккаунта 17-2 должен иметь приоритет над самым частым');

Store.state = {
  profiles: [
    { id: 'live', code: '3-1', createdAt: '2026-06-01' },
    { id: 'linked-only', code: '3-2', createdAt: '2026-03-01' }
  ],
  archivedProfiles: [
    { id: 'archived', code: '2-1', createdAt: '2026-05-01', archived: true },
    { id: 'no-phone', code: '2-2', createdAt: '2026-04-01', archived: true }
  ],
  accountRegs: [
    { id: 'reg-live', profileId: 'live', phone: '89990000001', createdAt: '2026-06-01' },
    { id: 'reg-archived', profileId: 'archived', phone: '89990000002', createdAt: '2026-05-03' }
  ],
  phones: [
    { id: 'phone-live', profileId: 'live', number: '89990000001', section: 'phone', createdAt: '2026-06-03' },
    { id: 'phone-linked', profileId: 'linked-only', number: '89990000003', section: 'phone', createdAt: '2026-03-02' }
  ],
  expenses: [
    { id: 'manual-1', date: '2026-01-01', category: 'Реклама - Номера', amount: 50, source: 'crm' },
    { id: 'manual-2', date: '2026-02-01', category: 'Реклама - Номера', amount: 99, source: 'crm' },
    { id: 'live-old', date: '2026-07-01', category: 'Реклама - Номера', amount: 100,
      source: 'account_phone_auto', profileId: 'live', phoneNumber: '89990000001' },
    { id: 'live-duplicate', date: '2026-07-02', category: 'Реклама - Номера', amount: 99,
      source: 'account_phone_auto', profileId: 'live', phoneNumber: '89990000001' },
    { id: 'other', date: '2026-02-01', category: 'Прочее', amount: 500 }
  ]
};

const repair = Store.reconcileAccountPhoneExpenses({ save: false });
assert.deepEqual(JSON.parse(JSON.stringify(repair)), {
  profiles: 4,
  expenses: 4,
  total: 396,
  removedUnlinked: 2,
  removedUnlinkedTotal: 149,
  exactPhoneDates: 2,
  profileFallbackDates: 2,
  withoutRecordedPhone: 1,
  byMonth: {
    '2026-05': 99,
    '2026-04': 99,
    '2026-06': 99,
    '2026-03': 99
  }
});
const repairedPhoneExpenses = Store.state.expenses.filter(row => row.category === 'Реклама - Номера');
assert.equal(repairedPhoneExpenses.length, 4);
assert.equal(repairedPhoneExpenses.reduce((sum, row) => sum + row.amount, 0), 396);
assert.equal(Store.state.expenses.some(row => row.id === 'manual-1' || row.id === 'manual-2'), false);
assert.equal(Store.state.expenses.some(row => row.id === 'other'), true);
assert.equal(repairedPhoneExpenses.find(row => row.profileId === 'live').date, '2026-06-03');
assert.equal(repairedPhoneExpenses.find(row => row.profileId === 'archived').date, '2026-05-01');
assert.equal(repairedPhoneExpenses.find(row => row.profileId === 'linked-only').date, '2026-03-02');
assert.equal(repairedPhoneExpenses.find(row => row.profileId === 'no-phone').date, '2026-04-01');
assert.equal(repairedPhoneExpenses.find(row => row.profileId === 'no-phone').phoneNumber, '');

const once = JSON.stringify(Store.state);
Store.reconcileAccountPhoneExpenses({ save: false });
assert.equal(JSON.stringify(Store.state), once, 'повторная реконструкция должна быть идемпотентной');

console.log('account phone expense: OK');
