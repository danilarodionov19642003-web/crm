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

Store.setProfileStatusDate(
  'mentor-a21', 'profile-8-8', '2026-06-16', 'Данил', '2026-07-28', 'manual'
);
let changed = Store.getProfileStatus('mentor-a21', 'profile-8-8');
assert.equal(changed.nextActionDate, '2026-07-28');
assert.equal(changed.nextActionMode, 'manual');
assert.equal(Store.getProfileStatusAction(changed, '2026-07-22').dueState, 'future');

Store.setProfileStatus(
  'mentor-a21', 'profile-8-8', STATUS_READY, '', '2026-07-22', 'Данил'
);
changed = Store.getProfileStatus('mentor-a21', 'profile-8-8');
assert.equal(changed.nextActionDate, undefined, 'при выполнении срок удаляется из текущего статуса');
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
assert.match(tasksHtml, /Сегодня и просроченные/,
  'просроченные действия не должны скрываться из основного списка');

console.log('status next actions: OK');
