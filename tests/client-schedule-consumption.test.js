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
  window: { addEventListener: noop, dispatchEvent: noop }
};
context.window.window = context.window;
vm.createContext(context);
vm.runInContext(source, context);

const {
  Store, PROFILE_STATUSES, STATUS_SELECT, STATUS_CHOSEN, STATUS_READY,
  scheduledReviewCount, manualScheduleLimit
} = context.window.App;
Store.save = noop;
Store._queueStatusNotification = noop;
Store.state = {
  mentors: [{ id: 'mentor-a44', code: 'a44', name: 'Максим' }],
  clients: [{
    id: 'client-a44', code: 'a44', ordered: 4,
    schedule: [
      { date: '2026-08-19', count: 1 },
      { date: '2026-08-26', count: 1 },
      { date: '2026-08-29', count: 1 },
      { date: '2026-08-31', count: 1 }
    ]
  }],
  profileStatuses: [{
    id: 'status-a44', mentorId: 'mentor-a44', profileId: 'profile-25-2',
    status: PROFILE_STATUSES[0], date: '2026-08-19', history: []
  }]
};

const client = Store.state.clients[0];
assert.equal(manualScheduleLimit(Store.state, client), 4,
  'назначенный, но ещё не начатый аккаунт остаётся частью ручного плана');

Store.setProfileStatus(
  'mentor-a44', 'profile-25-2', STATUS_SELECT, '', '2026-08-20', 'Данил'
);
assert.equal(scheduledReviewCount(client), 3,
  'первый переход в реальную работу списывает ровно один запланированный отклик');
assert.deepEqual(
  JSON.parse(JSON.stringify(client.schedule)),
  [
    { date: '2026-08-26', count: 1 },
    { date: '2026-08-29', count: 1 },
    { date: '2026-08-31', count: 1 }
  ],
  'списывается исходная дата статуса, а будущий график сохраняется'
);
assert.equal(manualScheduleLimit(Store.state, client), 3,
  'после начала работы вручную можно планировать только три оставшихся отклика');

Store.setProfileStatus(
  'mentor-a44', 'profile-25-2', PROFILE_STATUSES[4], '', '2026-08-24', 'Данил'
);
assert.equal(scheduledReviewCount(client), 3,
  'последующие смены статуса не должны повторно списывать график');

Store.state.clients.push({
  id: 'client-a20', code: 'a20', ordered: 2,
  schedule: [{ date: '2026-08-19', count: 1 }]
});
Store.state.mentors.push({ id: 'mentor-a20', code: 'a20', name: 'Лиана' });
Store.state.profileStatuses.push({
  id: 'status-a20-old', mentorId: 'mentor-a20', profileId: 'profile-old',
  status: STATUS_CHOSEN, date: '2026-07-27', history: []
});
Store.setProfileStatus(
  'mentor-a20', 'profile-old', STATUS_READY, '', '2026-08-19', 'Илья'
);
const a20 = Store.state.clients.find(item => item.id === 'client-a20');
assert.equal(scheduledReviewCount(a20), 1,
  'публикация старого отзыва в день нового плана не должна закрывать сегодняшний отклик');
const completed = Store.completeScheduledReview('client-a20', '2026-08-19');
assert.equal(completed.remainingOnDate, 0);
assert.equal(scheduledReviewCount(a20), 0,
  'отдельное действие «Отклик сделан» закрывает ровно выбранную задачу');

const clientsHtml = fs.readFileSync(path.join(root, 'pages/clients.html'), 'utf8');
const tasksHtml = fs.readFileSync(path.join(root, 'pages/tasks.html'), 'utf8');
const clientApp = fs.readFileSync(path.join(root, 'pages/client/client-app.js'), 'utf8');
assert.match(clientsHtml, /planned >= limit/,
  'календарь должен блокировать план сверх свободного количества отзывов');
assert.match(clientsHtml, /лишних \$\{plannedManual - manualLimit\}/,
  'старое превышение должно быть явно показано, а не маскироваться');
assert.match(tasksHtml, /data-complete-schedule-client/,
  'в задачах должна быть отдельная команда выполнения отклика');
assert.doesNotMatch(tasksHtml, /accountWorkOnDate/,
  'совпадение даты статуса больше не должно считаться выполненным откликом');
assert.doesNotMatch(clientApp, /doneToday/,
  'личный кабинет не должен гасить план публикацией старого отзыва');

console.log('client schedule consumption: OK');
