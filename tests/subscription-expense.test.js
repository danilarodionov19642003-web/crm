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
    SEED_INCOMES: [], SEED_EXPENSES: [], SEED_CLIENTS: [], SEED_SUBSCRIPTIONS: []
  }
};
context.window.window = context.window;
vm.createContext(context);
vm.runInContext(source, context);

const Store = context.window.App.Store;
Store.save = noop;
Store.state = { subscriptions: [], expenses: [], employees: [], profileStatuses: [] };

const proxy = Store.addSubscription({
  id: 'proxy-3', name: 'Прокси МСК 3', amount: 2250,
  frequency: 'Каждые 30 дней', nextDate: '2026-09-01', status: 'оплачен'
});
assert.equal(proxy.costScope, 'account_proxy', 'прокси должен определяться по названию');

const payment = Store.recordSubscriptionPayment(proxy.id, {
  date: '2026-08-01', coverageStart: '2026-08-01', coverageEnd: '2026-09-01'
});
assert.ok(payment, 'оплата прокси должна создать расход');
assert.deepEqual(
  JSON.parse(JSON.stringify(payment)),
  {
    id: 'subscription-payment-proxy-3-2026-08-01',
    date: '2026-08-01',
    category: 'Прокси',
    amount: 2250,
    comment: 'Оплата подписки: Прокси МСК 3',
    source: 'subscription_payment',
    createdAt: payment.createdAt,
    subscriptionId: 'proxy-3',
    costScope: 'account_proxy',
    costCoverageStart: '2026-08-01',
    costCoverageEnd: '2026-09-01'
  }
);
assert.equal(
  Store.recordSubscriptionPayment(proxy.id, {
    date: '2026-08-01', coverageStart: '2026-08-01', coverageEnd: '2026-09-01'
  }).id,
  payment.id,
  'повторный клик должен вернуть существующий расход'
);
assert.equal(Store.state.expenses.length, 1, 'повторный клик не должен задвоить расход');

const renewedProxy = Store.renewSubscription(proxy.id, {
  amount: 2300,
  date: '2026-09-01'
});
assert.ok(renewedProxy && renewedProxy.expense, 'Продлить должно атомарно создать расход прокси');
assert.equal(renewedProxy.expense.amount, 2300, 'в расход попадает сумма из строки подписки');
assert.equal(renewedProxy.expense.costCoverageStart, '2026-09-01');
assert.equal(renewedProxy.expense.costCoverageEnd, '2026-10-01');
assert.equal(proxy.nextDate, '2026-10-01', 'дата подписки сдвигается тем же сохранением');
assert.equal(proxy.amount, 2300, 'вручную изменённая сумма сохраняется в подписке');
assert.equal(Store.state.expenses.length, 2);

const vpn = Store.addSubscription({
  id: 'vpn', name: 'VPN Илье', amount: 200, costScope: 'general',
  frequency: 'Каждые 30 дней', nextDate: '2026-09-01', status: 'оплачен'
});
assert.equal(Store.recordSubscriptionPayment(vpn.id, {
  date: '2026-08-01', coverageStart: '2026-08-01', coverageEnd: '2026-09-01'
}), null, 'общая подписка не должна создавать клиентский инфраструктурный расход');
assert.equal(Store.state.expenses.length, 2);

const software = Store.addSubscription({
  id: 'dicloak', name: 'Dicloak', amount: 2123,
  frequency: 'Каждые 30 дней', nextDate: '2026-08-12', status: 'оплачен'
});
Store.recordSubscriptionPayment(software.id, {
  date: '2026-07-12', coverageStart: '2026-07-12', coverageEnd: '2026-08-12'
});
const cycles = Store.accountSoftwareCycles();
assert.equal(cycles.length, 1);
assert.equal(cycles[0].start, '2026-07-12');
assert.equal(cycles[0].endExclusive, '2026-08-12');
assert.equal(cycles[0].amount, 2123);

const emptySoftware = Store.addSubscription({
  id: 'empty-software', name: 'Dicloak test', amount: 0,
  frequency: 'Каждые 30 дней', nextDate: '2026-10-12', status: 'не оплачен'
});
assert.equal(Store.renewSubscription(emptySoftware.id, { amount: 0 }), null,
  'софт нельзя продлить с нулевой суммой и создать пустой расход');

const pageSource = fs.readFileSync(path.join(__dirname, '../pages/subscriptions.html'), 'utf8');
assert.match(pageSource, /data-field="amount"[^>]*type="number"|type="number"[^>]*data-field="amount"/,
  'сумма подписки должна редактироваться обычным числовым полем');
assert.match(pageSource, /Store\.renewSubscription\(id/,
  'кнопка Продлить должна использовать атомарное сохранение подписки и расхода');

console.log('subscription expenses: OK');
