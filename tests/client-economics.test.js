const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Economics = require('../js/economics.js');

const state = {
  finance: {
    balance: 5000,
    balanceUpdatedAt: '2026-01-15T12:00:00.000Z'
  },
  clients: [
    {
      id: 'c1', code: 'a1', name: 'Первый', ordered: 3,
      paid: 3000, remain: 3000, total: 0, manager: '',
      schedule: [{ date: '2026-02-01', count: 1 }]
    },
    {
      id: 'c2', code: 'a2', name: 'Второй', ordered: 1,
      paid: 4000, remain: 0, total: 4000, manager: 'Илья'
    },
    {
      id: 'closed', code: 'a3', name: 'Закрытый', ordered: 5,
      paid: 1000, remain: 1000, closed: true
    }
  ],
  mentors: [
    { id: 'm1', code: 'a1' },
    { id: 'm2', code: 'a2' },
    { id: 'm3', code: 'a3' }
  ],
  profiles: [
    { id: 'p1', code: '1-1', softwareStartedAt: '2026-01-01', mentorIds: ['m1', 'm2'] },
    { id: 'p2', code: '1-2', softwareStartedAt: '2026-01-16', mentorIds: ['m1'] }
  ],
  archivedProfiles: [],
  profileStatuses: [
    {
      id: 's1', mentorId: 'm1', profileId: 'p1', status: '🎯 Готов',
      date: '2026-01-10', performer: 'Данил',
      history: [{ date: '2026-01-01', status: '📋 Запланировано' }]
    },
    {
      id: 's2', mentorId: 'm2', profileId: 'p1', status: '🏆 Выбран',
      date: '2026-01-11', performer: 'Илья', history: []
    },
    {
      id: 's3', mentorId: 'm1', profileId: 'p2', status: '⭐ Выбрать',
      date: '2026-01-16', performer: 'Илья', history: []
    }
  ],
  reviews: [
    { id: 'r1', mentorId: 'm1', profileId: 'p1', moderation: 'approved' }
  ],
  employees: [
    { id: 'e1', name: 'Илья', ratePerReview: 300, paid: 300 },
    { id: 'e2', name: 'Данил', ratePerReview: 0, paid: 0 }
  ],
  expenses: [
    {
      id: 'soft', date: '2026-01-01', amount: 310,
      category: 'Софт', costScope: 'account_software'
    },
    {
      id: 'proxy', date: '2026-01-01', amount: 620,
      category: 'Прокси', costScope: 'account_proxy',
      costSegments: [
        { start: '2026-01-01', endExclusive: '2026-02-01', amount: 310 },
        { start: '2026-01-05', endExclusive: '2026-02-05', amount: 310 }
      ]
    },
    {
      id: 'phone-p1', date: '2026-01-01', amount: 99,
      category: 'Реклама - Номера', source: 'account_phone_auto', profileId: 'p1'
    },
    {
      id: 'phone-p2', date: '2026-01-16', amount: 99,
      category: 'Реклама - Номера', source: 'account_phone_auto', profileId: 'p2'
    },
    {
      id: 'old-phones', date: '2025-12-01', amount: 500,
      category: 'Реклама - Номера', source: 'crm'
    },
    {
      id: 'after-balance', date: '2026-01-01', amount: 100,
      category: 'Прочее', createdAt: '2026-01-15T12:01:00.000Z'
    }
  ],
  income: [
    { id: 'after-income', date: '2026-01-01', amount: 250, createdAt: '2026-01-15T12:02:00.000Z' }
  ],
  subscriptions: [
    {
      id: 'sub-soft', name: 'Dicloak', amount: 200, status: 'оплачен',
      frequency: 'Каждые 30 дней', nextDate: '2026-02-01'
    },
    {
      id: 'sub-proxy', name: 'Прокси МСК 1', amount: 450, status: 'оплачен',
      frequency: 'Каждые 30 дней', nextDate: '2026-02-01'
    }
  ]
};

const result = Economics.analyze(state, { today: '2026-01-15', phoneUnitCost: 99 });

assert.equal(result.clients.length, 2, 'закрытая карточка не должна считаться активной');
assert.equal(result.cash.current, 5051, 'текущий кэш должен учитывать операции после сверки');

const c1 = result.clients.find(row => row.id === 'c1');
const c2 = result.clients.find(row => row.id === 'c2');
assert.deepEqual(
  { done: c1.done, inWork: c1.inWork, unassigned: c1.unassigned, performer: c1.forecastPerformer },
  { done: 1, inWork: 1, unassigned: 1, performer: 'Данил' },
  'неназначенный остаток должен прогнозироваться за Данилом'
);
assert.equal(c1.future.salary, 0);
assert.equal(c1.future.phones, 99);

assert.ok(Math.abs(c1.actual.phones - 148.5) < 1e-9,
  'номер общего аккаунта делится между двумя клиентами');
assert.ok(Math.abs(c2.actual.phones - 49.5) < 1e-9);

const softwareAllocated = result.clients.reduce((sum, row) => sum + row.actual.software, 0)
  + result.costs.software.idle + result.costs.software.unallocated;
const proxyAllocated = result.clients.reduce((sum, row) => sum + row.actual.proxy, 0)
  + result.costs.proxy.idle + result.costs.proxy.unallocated;
assert.ok(Math.abs(softwareAllocated - 310) < 1e-7,
  'софт должен полностью распределяться без потери денег');
assert.ok(Math.abs(proxyAllocated - 620) < 1e-7,
  'прокси должны полностью распределяться по тем же account-days');

assert.equal(c1.actual.salary, 300);
assert.equal(c2.actual.salary, 300);
assert.equal(result.costs.labor.debt, 300,
  'долг по зарплате считается как начислено минус выплачено');
assert.equal(result.costs.phones.historicalUnlinked, 500,
  'старые общие покупки номеров нельзя молча приписывать клиенту');

assert.equal(Economics.inferSubscriptionCostScope('Прокси МСК 3'), 'account_proxy');
assert.equal(Economics.inferSubscriptionCostScope('Dicloak'), 'account_software');
assert.equal(result.costs.projected.cashTotal, 650,
  'две подписки должны попасть в будущие денежные обязательства');
assert.ok(c1.future.software > 0 && c1.future.proxy > 0,
  'будущий аккаунт клиента получает долю подписок по прогнозным account-days');

assert.equal(result.warnings.financialMismatch.length, 0,
  'нулевое legacy-поле total не должно создавать ложное предупреждение');

const pulseSource = fs.readFileSync(path.join(__dirname, '../pages/finance-pulse.html'), 'utf8');
const dashboardSource = fs.readFileSync(path.join(__dirname, '../pages/dashboard.html'), 'utf8');
assert.match(pulseSource, /window\.Economics\.analyze\(Store\.state/,
  'Пульс должен использовать общий калькулятор');
assert.match(dashboardSource, /window\.Economics\.analyze\(Store\.state/,
  'дашборд должен использовать тот же калькулятор');
assert.match(pulseSource, /row\.tariff === 'Поддержка'.*row\.ordered !== 6/,
  'нестандартный заказ не должен отображаться как типовой тариф Поддержка');

console.log('client economics: OK');
