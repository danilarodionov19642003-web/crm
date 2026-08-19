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
  statusOutreachStartDate, statusOutreachStartDates,
  clientOutreachStartsByDate, clientScheduleBreakdown,
  scheduledReviewCount, manualScheduleLimit
} = context.window.App;
Store.save = noop;
Store._queueStatusNotification = noop;
Store.state = {
  mentors: [
    { id: 'mentor-a44', code: 'a44', name: 'Максим' },
    { id: 'mentor-a20', code: 'a20', name: 'Лиана' }
  ],
  clients: [
    {
      id: 'client-a44', code: 'a44', ordered: 4,
      schedule: [
        { date: '2026-08-19', count: 2 },
        { date: '2026-08-26', count: 1 },
        { date: '2026-08-29', count: 1 },
        { date: '2026-08-31', count: 1 }
      ]
    },
    {
      id: 'client-a20', code: 'a20', ordered: 2,
      schedule: [{ date: '2026-08-19', count: 1 }]
    }
  ],
  profileStatuses: [
    {
      id: 'status-a44', mentorId: 'mentor-a44', profileId: 'profile-25-2',
      status: STATUS_SELECT, date: '2026-08-19', history: []
    },
    {
      id: 'status-a20-old', mentorId: 'mentor-a20', profileId: 'profile-old',
      status: STATUS_READY, date: '2026-08-19',
      history: [
        { status: PROFILE_STATUSES[0], date: '2026-07-10' },
        { status: STATUS_SELECT, date: '2026-07-10' },
        { status: STATUS_CHOSEN, date: '2026-07-27' }
      ]
    }
  ],
  reviews: [], profiles: [], archivedProfiles: [], accountRegs: [], income: []
};

const a44 = Store.state.clients.find(item => item.id === 'client-a44');
assert.equal(statusOutreachStartDate(Store.state.profileStatuses[0]), '2026-08-19');
assert.deepEqual(
  JSON.parse(JSON.stringify(clientScheduleBreakdown(Store.state, a44))),
  [
    { date: '2026-08-19', planned: 2, completed: 1, completedStarts: 1, remaining: 1 },
    { date: '2026-08-26', planned: 1, completed: 0, completedStarts: 0, remaining: 1 },
    { date: '2026-08-29', planned: 1, completed: 0, completedStarts: 0, remaining: 1 },
    { date: '2026-08-31', planned: 1, completed: 0, completedStarts: 0, remaining: 1 }
  ],
  'первый рабочий статус автоматически закрывает один план на свою дату'
);
assert.equal(scheduledReviewCount(a44, Store.state), 4);
assert.equal(manualScheduleLimit(Store.state, a44), 3,
  'лимит свободного плана учитывает уже начатый аккаунт');

const oldA20 = Store.state.profileStatuses.find(item => item.id === 'status-a20-old');
assert.equal(statusOutreachStartDate(oldA20), '2026-07-10',
  'дата публикации старого отзыва не становится датой нового отклика');
assert.equal(clientScheduleBreakdown(Store.state, Store.state.clients[1])[0].remaining, 1,
  'старый отзыв, опубликованный 19 августа, не закрывает план 19 августа');

Store.state.profileStatuses.push({
  id: 'status-a20-new', mentorId: 'mentor-a20', profileId: 'profile-new',
  status: STATUS_SELECT, date: '2026-08-19', history: []
});
assert.equal(clientOutreachStartsByDate(Store.state, Store.state.clients[1])['2026-08-19'], 1);
assert.equal(clientScheduleBreakdown(Store.state, Store.state.clients[1])[0].remaining, 0,
  'новый аккаунт с первым рабочим статусом закрывает план автоматически');

const repeating = {
  status: STATUS_CHOSEN,
  date: '2026-08-20',
  history: [
    { status: STATUS_SELECT, date: '2026-07-01' },
    { status: STATUS_READY, date: '2026-07-10' },
    { status: PROFILE_STATUSES[0], date: '2026-08-20' }
  ]
};
assert.deepEqual(
  JSON.parse(JSON.stringify(statusOutreachStartDates(repeating))),
  ['2026-07-01', '2026-08-20'],
  'повторный рабочий цикл того же аккаунта считается новым откликом один раз'
);
assert.equal(statusOutreachStartDate({ status: STATUS_READY, date: '2026-08-20', history: [] }), '',
  'готовый отзыв без рабочей истории не считается новым откликом');

const scheduleBefore = JSON.stringify(a44.schedule);
Store.setProfileStatus('mentor-a44', 'profile-25-2', STATUS_CHOSEN, '', '2026-08-20', 'Данил');
assert.equal(JSON.stringify(a44.schedule), scheduleBefore,
  'смена статуса не переписывает сохранённый график');

const a20Snapshot = Store._buildAnketaSnapshot('mentor-a20');
assert.deepEqual(JSON.parse(JSON.stringify(a20Snapshot.schedule)), [],
  'в личный кабинет попадает только фактический остаток графика');

const clientsHtml = fs.readFileSync(path.join(root, 'pages/clients.html'), 'utf8');
const tasksHtml = fs.readFileSync(path.join(root, 'pages/tasks.html'), 'utf8');
const clientApp = fs.readFileSync(path.join(root, 'pages/client/client-app.js'), 'utf8');
assert.match(clientsHtml, /clientScheduleBreakdown\(Store\.state, c\)/,
  'календарь клиента использует автоматическую сверку со стартами откликов');
assert.match(clientsHtml, /лишних \$\{plannedManual - manualLimit\}/,
  'реальное превышение плана остаётся заметным');
assert.doesNotMatch(tasksHtml, /data-complete-schedule-client|Отклик сделан/,
  'ручная кнопка выполнения отклика удалена');
assert.doesNotMatch(source, /completeScheduledReview|consumeScheduledReview/,
  'ядро больше не удаляет график вручную или при смене статуса');
assert.doesNotMatch(clientApp, /doneToday/,
  'личный кабинет не связывает публикацию старого отзыва с новым откликом');

console.log('client schedule consumption: OK');
