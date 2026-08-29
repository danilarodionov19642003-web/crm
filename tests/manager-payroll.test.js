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
const { employeeCompensationStats } = context.window.App;
Store.state = {
  employees: [{
    id: 'legacy-nastya', name: 'Настя', role: 'Ревьюер',
    ratePerReview: 300, reviewsDone: 2, paid: 0,
    status: 'active', hired: '2026-04-01', payments: []
  }],
  profileStatuses: [
    ...Array.from({ length: 24 }, (_, i) => ({
      id: `i-${i}`, performer: 'Илья',
      date: i < 4 ? `2026-08-${String(24 + i).padStart(2, '0')}`
        : i < 14 ? `2026-08-${String(i + 1).padStart(2, '0')}`
        : `2026-07-${String(i + 1).padStart(2, '0')}`,
      status: '⭐ Выбрать', history: []
    })),
    ...Array.from({ length: 64 }, (_, i) => ({ id: `d-${i}`, performer: 'Данил' })),
    { id: 'none-1', performer: '' }
  ],
  expenses: []
};

Store._migrateManagerPayroll();
Store._syncEmployeeWorkCounts();

assert.equal(Store.state.employees.some(e => e.name === 'Настя'), false,
  'Настя должна быть полностью удалена из зарплатного списка');
let ilya = Store.state.employees.find(e => e.name === 'Илья');
const danil = Store.state.employees.find(e => e.name === 'Данил');
assert.ok(ilya && danil, 'Илья и Данил должны быть созданы миграцией');
assert.equal(ilya.ratePerReview, 300, 'Илья наследует прежнюю редактируемую ставку');
assert.equal(danil.ratePerReview, 0, 'Данил не должен получать случайно начисленную зарплату владельца');
assert.equal(ilya.reviewsDone, 24, 'Илье должны считаться все его отметки в аккаунтах');
assert.equal(danil.reviewsDone, 64, 'Данилу должны считаться все его отметки в аккаунтах');
assert.equal(ilya.paid, 0, 'старые выплаты Насти не переносятся Илье');

Store.updateEmployee(ilya.id, { ratePerReview: 450 });
ilya = Store.state.employees.find(e => e.name === 'Илья');
Store._syncEmployeeWorkCounts();
assert.equal(ilya.ratePerReview, 450, 'автоподсчёт не должен затирать ручную ставку');
assert.equal(Store.state.profileStatuses[0].performerRate, 300,
  'смена ставки должна зафиксировать прежнюю ставку на уже сделанных откликах');

let stats = employeeCompensationStats(Store.state, ilya, { today: '2026-08-26', month: '2026-08' });
assert.equal(stats.week.count, 4, 'в текущей неделе считаются только отклики с понедельника');
assert.equal(stats.month.count, 14, 'месячная статистика считается по датам откликов');
assert.equal(stats.month.baseEarned, 4200, 'месячный заработок использует сохранённую ставку отклика');
assert.equal(stats.all.count, 24, 'общий счётчик сохраняет прежнее число откликов');

const bonus = Store.addEmployeeBonus(ilya.id, {
  id: 'ilya-bonus-1', date: '2026-08-26', amount: 1500, note: 'недельный объём'
});
assert.equal(bonus.amount, 1500, 'премию можно начислить отдельной операцией');
stats = employeeCompensationStats(Store.state, ilya, { today: '2026-08-26', month: '2026-08' });
assert.equal(stats.week.bonusEarned, 1500, 'премия видна в недельной статистике');
assert.equal(stats.month.earned, 5700, 'премия входит в начисление месяца');
assert.equal(stats.all.outstanding, 8700, 'премия увеличивает общую сумму к выплате');
assert.equal(Store.deleteEmployeeBonus(ilya.id, 'ilya-bonus-1'), true,
  'ошибочно начисленную премию можно удалить');

const dailyPlanIlya = {
  id: 'ilya-daily-plan', name: 'Илья', ratePerReview: 300,
  bonuses: [{ id: 'manual-extra', date: '2026-08-25', amount: 200, note: 'ручная премия' }],
  payments: [], paid: 0
};
const makeDailyWork = (date, count, performer = 'Илья') => Array.from({ length: count }, (_, index) => ({
  id: `${performer}-${date}-${index}`,
  performer,
  date,
  status: '⭐ Выбрать',
  history: []
}));
const dailyPlanState = {
  employees: [dailyPlanIlya], mentors: [], profiles: [], archivedProfiles: [],
  profileStatuses: [
    ...makeDailyWork('2026-08-24', 4),
    ...makeDailyWork('2026-08-25', 5),
    ...makeDailyWork('2026-08-26', 7)
  ]
};
const dailyPlanStats = employeeCompensationStats(dailyPlanState, dailyPlanIlya, {
  today: '2026-08-26', month: '2026-08'
});
assert.equal(dailyPlanStats.month.count, 16);
assert.equal(dailyPlanStats.month.baseEarned, 4800,
  'обычная ставка за каждый отклик продолжает начисляться');
assert.equal(dailyPlanStats.month.dailyPlan.completedDays, 2,
  'порог 5+ должен выполняться один раз за каждый подходящий день');
assert.equal(dailyPlanStats.month.dailyPlanBonusEarned, 1000,
  'два выполненных дневных плана автоматически дают 2 × 500 ₽');
assert.equal(dailyPlanStats.month.manualBonusEarned, 200,
  'ручная премия остаётся отдельной и не затирается автопланом');
assert.equal(dailyPlanStats.month.earned, 6000,
  'итого складывается из ставки за отклики, автоплана и ручных премий');
assert.equal(dailyPlanStats.dailyPlanDays.find(item => item.date === '2026-08-24').amount, 0,
  'четыре отклика не должны выполнять дневной план');
assert.equal(dailyPlanStats.dailyPlanDays.find(item => item.date === '2026-08-26').amount, 500,
  'семь откликов всё равно дают одну дневную премию, а не несколько');

const danilNoDailyPlan = { id: 'danil-no-plan', name: 'Данил', ratePerReview: 0, bonuses: [], payments: [] };
const danilPlanStats = employeeCompensationStats({
  employees: [danilNoDailyPlan], mentors: [], profiles: [], archivedProfiles: [],
  profileStatuses: makeDailyWork('2026-08-26', 5, 'Данил')
}, danilNoDailyPlan, { today: '2026-08-26', month: '2026-08' });
assert.equal(danilPlanStats.month.dailyPlanBonusEarned, 0,
  'автоматический дневной бонус применяется только к Илье');

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
assert.match(employeesHtml, /id="pDebtOffset"/,
  'в форме выплаты должна редактироваться сумма, направляемая в счёт долга');
assert.match(employeesHtml, /id="empOverview"/, 'на странице нужны отдельные карточки статистики сотрудников');
assert.match(employeesHtml, /За неделю/, 'в таблице должна быть недельная статистика');
assert.match(employeesHtml, /За месяц/, 'в таблице должна быть месячная статистика');
assert.match(employeesHtml, /data-act="bonus"/, 'у сотрудника должна быть кнопка премии');
assert.match(employeesHtml, /id="statsMonth"/, 'подробную статистику можно открыть за выбранный месяц');
assert.match(employeesHtml, /Какие отклики вошли в расчёт/, 'месячное начисление должно раскрываться до отдельных откликов');
assert.match(employeesHtml, /Для Ильи при 5 и более откликах за день автоматически добавляется 500 ₽/,
  'правило дневного плана должно быть явно показано в зарплатах');
assert.match(employeesHtml, /Дневной план · \$\{stats\.dailyPlan\.target\} откликов = \+\$\{fmtMoney\(stats\.dailyPlan\.bonus\)\}/,
  'в подробной статистике нужна разбивка выполнения плана по дням');
assert.match(employeesHtml, /item\.source === 'daily_plan' \? 'Автопремия' : 'Премия'/,
  'автоматическое начисление должно отличаться от ручной премии');
assert.match(employeesHtml, /js\/app\.js\?v=20260829b/,
  'страница зарплат должна обходить старый кэш расчёта');
assert.match(employeesHtml, /Math\.min\(debt, gross, requestedOffset\)/,
  'зачёт долга можно увеличить до всей выплаты, но не выше остатка долга');
assert.match(clientsHtml, /data-field="manager"/, 'в карточке клиента нужен селектор менеджера');
assert.match(clientsHtml, /id="mManager"/, 'менеджер должен назначаться при создании клиента');
assert.match(tasksHtml, /id="fManager"/, 'в задачах нужен фильтр по менеджеру');
assert.match(tasksHtml, /matchesManager\(String\(c\.manager/, 'фильтр должен применяться к календарю графиков');
assert.match(tasksHtml, /managerForMentor\(t\.mentorId\)/, 'задача должна наследовать менеджера клиента');

console.log('manager payroll and task ownership: OK');
