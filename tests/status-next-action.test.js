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
assert.deepEqual(
  Array.from(context.window.App.PROFILE_STATUSES),
  ['📋 Запланировано', '💬 Начать диалог', '✅ Обменяться', '⭐ Выбрать', '🏆 Выбран', '🎯 Опубликован'],
  'воронка должна использовать новые названия статусов'
);

Store.state = {
  profileStatuses: [{
    status: '💬 Диалог Начать',
    nextActionStatus: '🎯 Готов',
    history: [
      { status: '💬 Диалог Начат' },
      { status: '✅ Диалог Закончен' },
      { status: '🎯 Готов' }
    ]
  }]
};
Store._migrateProfileStatusNames();
assert.equal(Store.state.profileStatuses[0].status, '💬 Начать диалог');
assert.equal(Store.state.profileStatuses[0].nextActionStatus, '🎯 Опубликован');
assert.deepEqual(
  Array.from(Store.state.profileStatuses[0].history, item => item.status),
  ['💬 Начать диалог', '✅ Обменяться', '🎯 Опубликован'],
  'старые текущие и исторические статусы должны мигрировать без потери записей'
);

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
const statusLabelsMigration = fs.readFileSync(
  path.join(root, 'sql/migrations/2026-08-29_profile_status_labels.sql'),
  'utf8'
);
assert.match(statusesHtml, /stg__chip__age/, 'в карточке аккаунта должен отображаться возраст статуса');
assert.match(statusesHtml, /id="chgActionDate"/, 'срок следующего действия должен редактироваться');
assert.doesNotMatch(statusesHtml, /<label>Дата статуса<\/label>/,
  'ручное поле даты статуса больше не должно показываться в формах');
assert.doesNotMatch(statusesHtml, /<label>Комментарий<\/label>/,
  'неиспользуемое поле комментария больше не должно показываться в формах статуса');
assert.doesNotMatch(statusesHtml, /id="(?:add|chg)Date"/,
  'удалённые поля даты не должны оставаться скрытыми элементами формы');
assert.doesNotMatch(statusesHtml, /id="(?:add|chg)Comment"/,
  'удалённые поля комментария не должны оставаться скрытыми элементами формы');
assert.match(statusesHtml, /const statusChanged = !cur \|\| cur\.status !== newStatus/,
  'сохранение должно определять реальную смену статуса');
assert.match(statusesHtml, /const newDate = statusChanged[\s\S]{0,100}window\.App\.todayISO\(\)/,
  'при смене статуса должна автоматически ставиться сегодняшняя дата');
assert.match(statusesHtml, /deepLink\.get\('accountId'\)/, 'страница статусов должна фильтровать нужный аккаунт из задачи');
assert.match(statusesHtml, /document\.getElementById\('fSearch'\)\.value = searchValue/,
  'номер аккаунта из задачи должен автоматически попадать в поиск');
assert.match(statusesHtml, /deepLink\.get\('profileId'\)/, 'старые прямые ссылки на окно статуса должны продолжить работать');
assert.match(tasksHtml, /Store\.listProfileStatusActionTasks\(todayISO\(\)\)/,
  'задачи по статусам должны вычисляться из profileStatuses');
assert.match(tasksHtml, /statuses\.html\?accountId=/, 'системная задача должна вести к отфильтрованной карточке аккаунта');
assert.doesNotMatch(tasksHtml, /statuses\.html\?profileId=/, 'задачи не должны сразу открывать окно смены статуса');
assert.match(tasksHtml, /data-act="schedule-system"/, 'системную задачу можно запланировать на другой день');
assert.match(tasksHtml, /id="statusScheduleModal"/, 'для переноса должна открываться отдельная форма с датой');
assert.match(tasksHtml, /Store\.setProfileStatusTaskDate/, 'планирование должно менять отдельную рабочую дату');
assert.match(tasksHtml, /task\.plannedDate/, 'календарь должен использовать рабочую дату, а не срок статуса');
assert.match(tasksHtml, /collectStatusActionsByDate/, 'задачи по статусам должны попадать в календарь');
assert.match(tasksHtml, /sched-cell__task-count/, 'день календаря должен показывать число задач');
assert.match(tasksHtml, /План отзывов и задач/, 'календарь должен явно показывать оба вида работы');
assert.match(tasksHtml, /Сегодня и просроченные/,
  'просроченные действия не должны скрываться из основного списка');
assert.match(tasksHtml, /<option value="active">Все актуальные<\/option>/,
  'по умолчанию должны быть доступны и просроченные, и будущие задачи');
assert.match(tasksHtml, /data-workflow-section="select"/,
  'аккаунты в статусе «Выбрать» должны выводиться отдельным рабочим разделом');
assert.match(tasksHtml, /data-workflow-section="publish"/,
  'аккаунты в статусе «Выбран» должны выводиться отдельным разделом публикации');
assert.match(tasksHtml, /t\.currentStatus === STATUS_SELECT/,
  'раздел выбора должен фильтроваться по текущему статусу аккаунта');
assert.match(tasksHtml, /t\.currentStatus === STATUS_CHOSEN/,
  'раздел публикации должен фильтроваться по текущему статусу аккаунта');
assert.match(tasksHtml, /function taskWorkDate\(task\)[\s\S]{0,180}task\.plannedDate/,
  'перенесённая задача должна группироваться по рабочей дате, а не по старой просрочке');
assert.match(tasksHtml, /task-workflow-grid[\s\S]{0,180}repeat\(2, minmax\(0, 1fr\)\)/,
  'два этапа работы должны быть визуально разделены на рабочем столе');
assert.match(statusLabelsMigration, /insert into public\.crm_state_history/,
  'перед переименованием живых статусов должен сохраняться снимок CRM');
assert.match(statusLabelsMigration, /update public\.client_snapshots/,
  'названия должны обновляться и в личных кабинетах');
assert.match(statusLabelsMigration, /not in \(''📋 Запланировано'', ''🎯 Готов'', ''🎯 Опубликован''\)/,
  'серверный лимит планирования должен понимать старое и новое конечное состояние');

console.log('status next actions: OK');
