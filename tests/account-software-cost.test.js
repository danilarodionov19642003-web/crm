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
Store.save = noop;
Store.state = {
  profiles: [
    { id: 'a', code: '8-5', createdAt: '2026-06-01', softwareStartedAt: '2026-06-01' },
    { id: 'b', code: '8-8', createdAt: '2026-06-20', softwareStartedAt: '2026-06-20' }
  ],
  archivedProfiles: [
    {
      id: 'c', code: '8-10', createdAt: '2026-06-01', softwareStartedAt: '2026-06-01',
      deletedAt: '2026-06-25', softwareEndedAt: '2026-06-25', archived: true
    }
  ],
  expenses: [
    { id: 'soft-1', date: '2026-06-12', category: 'Софт', amount: 1600, costScope: 'account_software' },
    { id: 'soft-1-extra', date: '2026-06-12', category: 'Софт', amount: 55, costScope: 'account_software' },
    { id: 'soft-2', date: '2026-07-12', category: 'Софт', amount: 2123, costScope: 'account_software' },
    { id: 'soft-unrelated', date: '2026-07-15', category: 'Софт', amount: 9999, costScope: 'general' },
    { id: 'phone-a', date: '2026-06-01', category: 'Реклама - Номера', amount: 99, source: 'account_phone_auto', profileId: 'a' }
  ]
};

const cycles = Store.accountSoftwareCycles();
assert.equal(cycles.length, 2, 'явно исключённый общий расход не должен стать циклом');
assert.equal(cycles[0].amount, 1655, 'платежи одного дня должны суммироваться');
assert.equal(cycles[0].start, '2026-06-12');
assert.equal(cycles[0].end, '2026-07-11');
assert.equal(cycles[1].end, '2026-08-11', 'последний платеж покрывает один календарный месяц');

const costA = Store.accountSoftwareCost('a');
assert.equal(costA.paidPeriods, 2);
assert.equal(costA.paidThrough, '2026-08-11');
assert.equal(costA.breakdown[0].accountDays, 30);
assert.equal(costA.breakdown[0].totalAccountDays, 66);
assert.equal(costA.breakdown[1].accountDays, 31);
assert.equal(costA.breakdown[1].totalAccountDays, 62);
assert.ok(Math.abs(costA.softwareCost - (1655 * 30 / 66 + 2123 * 31 / 62)) < 1e-9);
assert.equal(costA.phoneCost, 99);
assert.ok(Math.abs(costA.trackedCost - (costA.softwareCost + 99)) < 1e-9);

const costB = Store.accountSoftwareCost('b');
assert.equal(costB.breakdown[0].accountDays, 22, 'созданный посреди цикла аккаунт оплачивает только дни присутствия');
assert.equal(costB.breakdown[1].accountDays, 31);

const costC = Store.accountSoftwareCost('c');
assert.equal(costC.paidPeriods, 1, 'архивный аккаунт не должен участвовать в циклах после архивации');
assert.equal(costC.breakdown[0].accountDays, 14);
assert.equal(costC.end, '2026-06-25');

Store.updateExpense('soft-2', { personal: true });
assert.equal(Store.state.expenses.find(x => x.id === 'soft-2').costScope, undefined,
  'личный или не-Софт расход не должен сохранять отметку распределения');

const statusesSource = fs.readFileSync(path.join(__dirname, '../pages/statuses.html'), 'utf8');
const financeSource = fs.readFileSync(path.join(__dirname, '../pages/finance.html'), 'utf8');
assert.match(statusesSource, /Store\.accountSoftwareCost\(p\.id\)/,
  'карточка аккаунта должна выводить расчёт содержания');
assert.match(statusesSource, /id="costStartedAt"/,
  'владелец должен иметь возможность исправить дату начала содержания');
assert.doesNotMatch(statusesSource, /data-act="restore"/,
  'архивный аккаунт не должен иметь кнопки восстановления');
assert.match(financeSource, /data-toggle-infrastructure/,
  'существующую оплату софта или прокси можно отметить прямо в расходах');
assert.match(financeSource, /costScope:\s*document\.getElementById\('eAccountSoftware'\)/,
  'новая оплата софта должна сохранять устойчивую отметку назначения');
assert.doesNotMatch(
  financeSource,
  /function renderAll\(\)\s*\{[\s\S]*?dispatchEvent\(new CustomEvent\('finance:updated'\)\)/,
  'renderAll не должен отправлять событие, на которое сам подписан'
);

console.log('account software cost: OK');
