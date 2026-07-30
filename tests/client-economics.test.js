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
  { done: c1.done, inWork: c1.inWork, unassigned: c1.unassigned },
  { done: 1, inWork: 1, unassigned: 1 },
  'счётчики работы остаются фактическими и не создают будущие расходы'
);
assert.equal(c1.totalCost, c1.actual.total, 'себестоимость клиента должна состоять только из факта');
assert.equal(result.totals.futureCost, undefined, 'прогноз расходов больше не рассчитывается');
assert.equal(result.costs.projected, undefined, 'будущие подписки не распределяются по клиентам');
assert.equal(result.subscriptions, undefined, 'ближайшие подписки не входят в Пульс');
assert.equal(result.calendar, undefined, 'финансовый календарь удалён');

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
assert.equal(result.cash.obligations, 300,
  'в обязательствах остаётся только уже начисленная невыплаченная зарплата');
assert.equal(result.costs.phones.historicalUnlinked, 500,
  'старые общие покупки номеров нельзя молча приписывать клиенту');

assert.equal(Economics.inferSubscriptionCostScope('Прокси МСК 3'), 'account_proxy');
assert.equal(Economics.inferSubscriptionCostScope('Dicloak'), 'account_software');
assert.ok(c1.reviewCosts.length > 0, 'должна быть доступна себестоимость каждого начатого отзыва');
assert.ok(Math.abs(
  c1.reviewCosts.reduce((sum, row) => sum + row.total, 0) - c1.actual.total
) < 1e-7, 'детализация по аккаунтам должна сходиться с фактической себестоимостью клиента');

assert.equal(result.warnings.financialMismatch.length, 0,
  'нулевое legacy-поле total не должно создавать ложное предупреждение');

const archivedResult = Economics.analyze({
  clients: [{ id: 'legacy-client', code: 'a9', ordered: 2, paid: 1000, remain: 1 }],
  mentors: [{ id: 'legacy-mentor', code: 'a9' }],
  profiles: [],
  archivedProfiles: [{
    id: 'legacy-profile', code: '2-1', createdAt: '2026-04-20',
    deletedAt: '2026-04-10', archived: true
  }],
  profileStatuses: [{
    id: 'legacy-status', mentorId: 'legacy-mentor', profileId: 'legacy-profile',
    status: '🎯 Готов', date: '2026-03-01', performer: 'Данил'
  }],
  reviews: [{
    id: 'legacy-review', mentorId: 'legacy-mentor', profileId: 'legacy-profile', moderation: 'approved'
  }],
  employees: [{ id: 'danil', name: 'Данил', ratePerReview: 0, paid: 0 }],
  expenses: [
    { id: 'legacy-soft', date: '2026-03-01', category: 'Софт', amount: 310 },
    { id: 'legacy-proxy', date: '2026-03-01', category: 'Прокси', amount: 620 },
    { id: 'employee-vpn', date: '2026-03-01', category: 'Софт', comment: 'VPN Илье', amount: 9999 }
  ]
}, { today: '2026-04-30' });
const archivedClient = archivedResult.clients[0];
assert.equal(archivedClient.actual.software, 310,
  'старый фактический платёж софта без costScope должен учитываться');
assert.equal(archivedClient.actual.proxy, 620,
  'старый фактический платёж прокси без costScope должен учитываться');
assert.equal(archivedResult.costs.software.total, 310,
  'VPN сотрудника нельзя относить к содержанию клиентских аккаунтов');
assert.equal(archivedClient.reviewCosts[0].archived, true,
  'архивный аккаунт должен оставаться в детализации себестоимости');

const reusedProfileResult = Economics.analyze({
  clients: [
    { id: 'first-client', code: 'a1', ordered: 1, paid: 1000, remain: 1 },
    { id: 'second-client', code: 'a2', ordered: 1, paid: 1000, remain: 1 }
  ],
  mentors: [
    { id: 'first-mentor', code: 'a1' },
    { id: 'second-mentor', code: 'a2' }
  ],
  profiles: [],
  archivedProfiles: [{
    id: 'reused-profile', code: '3-1', createdAt: '2026-03-01',
    deletedAt: '2026-05-31', archived: true
  }],
  profileStatuses: [
    { id: 'first-status', mentorId: 'first-mentor', profileId: 'reused-profile', status: '🎯 Готов', date: '2026-03-01' },
    { id: 'second-status', mentorId: 'second-mentor', profileId: 'reused-profile', status: '🎯 Готов', date: '2026-05-01' }
  ],
  reviews: [],
  employees: [],
  expenses: [
    { id: 'march-soft', date: '2026-03-01', category: 'Софт', amount: 300 },
    { id: 'may-soft', date: '2026-05-01', category: 'Софт', amount: 310 }
  ]
}, { today: '2026-06-01' });
assert.ok(Math.abs(reusedProfileResult.clients.find(row => row.id === 'first-client').actual.software - 300) < 1e-9,
  'после передачи аккаунта следующему клиенту старый клиент больше не оплачивает его содержание');
assert.ok(Math.abs(reusedProfileResult.clients.find(row => row.id === 'second-client').actual.software - 310) < 1e-9,
  'последний клиент оплачивает аккаунт до архива');

const pulseSource = fs.readFileSync(path.join(__dirname, '../pages/finance-pulse.html'), 'utf8');
const dashboardSource = fs.readFileSync(path.join(__dirname, '../pages/dashboard.html'), 'utf8');
assert.match(pulseSource, /window\.Economics\.analyze\(Store\.state/,
  'Пульс должен использовать общий калькулятор');
assert.match(dashboardSource, /window\.Economics\.analyze\(Store\.state/,
  'дашборд должен использовать тот же калькулятор');
assert.match(pulseSource, /row\.tariff === 'Поддержка'.*row\.ordered !== 6/,
  'нестандартный заказ не должен отображаться как типовой тариф Поддержка');
assert.doesNotMatch(pulseSource, /Ещё нужно|Ближайшие подписки|view-calendar|row\.future/,
  'Пульс не должен показывать или считать будущие расходы');
assert.match(pulseSource, /Себестоимость каждого начатого отзыва/,
  'детали клиента должны показывать себестоимость по аккаунтам');

console.log('client economics: OK');
