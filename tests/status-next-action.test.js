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

const { Store, STATUS_SELECT, STATUS_CHOSEN, STATUS_READY } = context.window.App;
Store.save = noop;
Store.state = {
  mentors: [
    { id: 'mentor-a10', code: 'a10', name: 'Анастасия' },
    { id: 'mentor-a21', code: 'a21', name: 'Столичный уют' }
  ],
  clients: [
    { id: 'client-a10', code: 'A-10', niche: 'Математика', manager: 'Илья' },
    { id: 'client-a21', code: 'a21', niche: 'Ремонт квартир', manager: 'Данил' }
  ],
  profiles: [
    { id: 'profile-8-2', code: '8-2' },
    { id: 'profile-8-8', code: '8-8' }
  ],
  accountRegs: [
    { id: 'reg-8-2', profileId: 'profile-8-2', ownerName: 'Вячеслав Ермолин' },
    { id: 'reg-8-8', profileId: 'profile-8-8', ownerName: 'Владимир' }
  ],
  nicheConfig: {
    'Ремонт квартир': { daysToPublish: 30 }
  },
  profileStatuses: [
    {
      id: 'status-a10', mentorId: 'mentor-a10', profileId: 'profile-8-2',
      status: STATUS_SELECT, date: '2026-05-22', history: []
    },
    {
      id: 'status-a21', mentorId: 'mentor-a21', profileId: 'profile-8-8',
      status: STATUS_CHOSEN, date: '2026-06-16', history: []
    }
  ]
};

const tasks = Store.listProfileStatusActionTasks('2026-07-22');
const selectTask = tasks.find(item => item.statusId === 'status-a10');
const chosenTask = tasks.find(item => item.statusId === 'status-a21');

assert.equal(selectTask.date, '2026-05-27', 'старый статус «Выбрать» получает срок +5 дней без миграции данных');
assert.equal(selectTask.daysInStatus, 61);
assert.equal(selectTask.daysOverdue, 56);
assert.equal(selectTask.targetStatus, STATUS_CHOSEN);
assert.equal(selectTask.manager, 'Илья');
assert.equal(selectTask.accountOwner, 'Вячеслав Ермолин');

assert.equal(chosenTask.date, '2026-07-16', 'срок «Выбран» берётся из настройки ниши');
assert.equal(chosenTask.daysInStatus, 36);
assert.equal(chosenTask.daysOverdue, 6);
assert.equal(chosenTask.targetStatus, STATUS_READY);

const legacyScheduled = Store.getProfileStatus('mentor-a10', 'profile-8-2');
legacyScheduled.nextActionDate = '2026-08-01';
legacyScheduled.nextActionMode = 'manual';
legacyScheduled.updatedAt = '2026-08-05T00:00:00.000Z';
assert.equal(Store._migrateSeparatedTaskPlanDate(), 1,
  'дата из короткоживущей версии планировщика должна быть безопасно разделена');
assert.equal(legacyScheduled.nextActionDate, '2026-05-27', 'исходный срок восстанавливается по статусу');
assert.equal(legacyScheduled.plannedActionDate, '2026-08-01', 'выбранный рабочий день сохраняется');
assert.equal(legacyScheduled.taskPlanSchema, 'separate-v1');
delete legacyScheduled.plannedActionDate;
legacyScheduled.nextActionDate = '2026-08-10';
legacyScheduled.nextActionMode = 'manual';
assert.equal(Store._migrateSeparatedTaskPlanDate(), 0,
  'последующие ручные сроки не должны ошибочно считаться старым планированием');
assert.equal(legacyScheduled.nextActionDate, '2026-08-10');

assert.equal(Store.setProfileStatusTaskDate('status-a21', '2026-02-31'), null,
  'несуществующая календарная дата не должна сохраняться');
Store.setProfileStatusTaskDate('status-a21', '2026-07-28');
let changed = Store.getProfileStatus('mentor-a21', 'profile-8-8');
assert.equal(changed.nextActionDate, undefined, 'планирование не должно менять исходный срок статуса');
assert.equal(changed.plannedActionDate, '2026-07-28');
assert.equal(Store.getProfileStatusAction(changed, '2026-07-22').date, '2026-07-16');
assert.equal(Store.getProfileStatusAction(changed, '2026-07-22').dueState, 'overdue');
const rescheduledTask = Store.listProfileStatusActionTasks('2026-07-22')
  .find(item => item.statusId === 'status-a21');
assert.equal(rescheduledTask.date, '2026-07-16', 'просрочка остаётся на исходной дате');
assert.equal(rescheduledTask.plannedDate, '2026-07-28', 'рабочий план хранится отдельно');

Store.setProfileStatus(
  'mentor-a21', 'profile-8-8', STATUS_READY, '', '2026-07-22', 'Данил'
);
changed = Store.getProfileStatus('mentor-a21', 'profile-8-8');
assert.equal(changed.nextActionDate, undefined, 'при выполнении срок удаляется из текущего статуса');
assert.equal(changed.plannedActionDate, undefined, 'при смене статуса задача удаляется из рабочего плана');
assert.equal(changed.history[0].plannedActionDate, '2026-07-28', 'прошлый план сохраняется в истории статуса');
assert.equal(Store.getProfileStatusAction(changed, '2026-07-22'), null);
assert.equal(Store.listProfileStatusActionTasks('2026-07-22').some(item => item.statusId === 'status-a21'), false,
  'системная задача закрывается реальной сменой статуса');

const statusesHtml = fs.readFileSync(path.join(root, 'pages/statuses.html'), 'utf8');
const tasksHtml = fs.readFileSync(path.join(root, 'pages/tasks.html'), 'utf8');
assert.match(statusesHtml, /stg__chip__age/, 'в карточке аккаунта должен отображаться возраст статуса');
assert.match(statusesHtml, /id="chgActionDate"/, 'срок следующего действия должен редактироваться');
assert.match(statusesHtml, /deepLink\.get\('profileId'\)/, 'страница статусов должна открывать карточку из задачи');
assert.match(tasksHtml, /Store\.listProfileStatusActionTasks\(todayISO\(\)\)/,
  'задачи по статусам должны вычисляться из profileStatuses');
assert.match(tasksHtml, /statuses\.html\?profileId=/, 'системная задача должна вести к нужной карточке');
assert.match(tasksHtml, /data-act="schedule-system"/, 'системную задачу можно запланировать на другой день');
assert.match(tasksHtml, /id="statusScheduleModal"/, 'для переноса должна открываться отдельная форма с датой');
assert.match(tasksHtml, /Store\.setProfileStatusTaskDate/, 'планирование должно менять отдельную рабочую дату');
assert.match(tasksHtml, /task\.plannedDate/, 'календарь должен использовать рабочую дату, а не срок статуса');
assert.match(tasksHtml, /collectStatusActionsByDate/, 'задачи по статусам должны попадать в календарь');
assert.match(tasksHtml, /sched-cell__task-count/, 'день календаря должен показывать число задач');
assert.match(tasksHtml, /План отзывов и задач/, 'календарь должен явно показывать оба вида работы');
assert.match(tasksHtml, /Сегодня и просроченные/,
  'просроченные действия не должны скрываться из основного списка');

console.log('status next actions: OK');
