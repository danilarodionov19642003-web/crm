'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const noop = () => {};
const context = {
  console,
  Date,
  URL,
  URLSearchParams,
  setTimeout,
  clearTimeout,
  CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  navigator: { userAgent: 'node-test' },
  location: { pathname: '/pages/client/index.html', hostname: 'localhost', search: '', hash: '' },
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
    Supabase: {
      URL: 'https://example.invalid', KEY: 'test', Auth: {},
      accessToken: () => '', authFetch: async () => ({ ok: true, json: async () => [] })
    }
  }
};
context.window.window = context.window;
context.window.document = context.document;
context.window.location = context.location;
context.window.navigator = context.navigator;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, 'js/app.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(root, 'pages/client/client-app.js'), 'utf8'), context);

test('staff status plan survives the client snapshot and appears once in the calendar', () => {
  const { Store } = context.window.App;
  Store.state = {
    mentors: [{ id: 'mentor-a27', code: 'a27', name: 'Ремонт.ИО' }],
    clients: [{ id: 'client-a27', code: 'a27', name: 'Ремонт.ИО', ordered: 2, closed: false }],
    profiles: [{ id: 'profile-21-7', code: '21-7' }],
    archivedProfiles: [],
    accountRegs: [{ id: 'reg-1', profileId: 'profile-21-7', ownerName: 'Аккаунт 21-7' }],
    profileStatuses: [{
      id: 'status-a27-1', mentorId: 'mentor-a27', profileId: 'profile-21-7',
      status: '⭐ Выбрать', date: '2026-08-10', plannedActionDate: '2026-09-01',
      nextActionStatus: '🏆 Выбран', taskPlanSource: 'staff', taskPlanSchema: 'separate-v1', history: []
    }],
    reviews: [], income: []
  };

  const anketa = Store._buildAnketaSnapshot('mentor-a27');
  const status = anketa.statuses[0];
  assert.equal(status.plannedActionDate, '2026-09-01');
  assert.equal(status.nextActionStatus, '🏆 Выбран');
  assert.equal(status.taskPlanSource, 'staff');
  assert.equal(status.taskPlanSchema, 'separate-v1');

  const acceptedOldRequest = [{
    id: 1, status_id: status.id, mentor_id: anketa.mentorId,
    current_status: status.status, target_status: '🏆 Выбран',
    requested_date: '2026-08-31', request_status: 'accepted'
  }];
  const events = context.window.ClientApp.gatherCalendarEvents(
    { anketas: [anketa] }, [], acceptedOldRequest
  ).filter(event => event.kind === 'status-plan');

  assert.equal(events.length, 1, 'канонический план статуса должен подавлять старый accepted-запрос');
  assert.equal(events[0].date, '2026-09-01');
  assert.equal(events[0].comment, 'Назначено менеджером');
  assert.equal(events[0].sub, 'Аккаунт 21-7');
});

test('accepted client request remains a fallback when snapshot has no canonical plan', () => {
  const anketa = {
    mentorId: 'mentor-a27', code: 'a27', name: 'Ремонт.ИО', closed: false,
    statuses: [{
      id: 'status-a27-2', mentorId: 'mentor-a27', profileId: 'profile-26-9',
      profileName: 'Аккаунт 26-9', status: '💬 Начать диалог', date: '2026-08-25'
    }],
    reviews: []
  };
  const requests = [{
    id: 2, status_id: 'status-a27-2', mentor_id: 'mentor-a27',
    current_status: '💬 Начать диалог', target_status: '✅ Обменяться',
    requested_date: '2026-09-02', request_status: 'accepted'
  }];
  const events = context.window.ClientApp.gatherCalendarEvents(
    { anketas: [anketa] }, [], requests
  ).filter(event => event.kind === 'status-plan');

  assert.equal(events.length, 1);
  assert.equal(events[0].date, '2026-09-02');
  assert.equal(events[0].comment, 'Вы выбрали дату');
});

test('closed anketa keeps plan data but does not create an actionable calendar event', () => {
  const anketa = {
    mentorId: 'mentor-a28', code: 'a28', name: 'Максим Б', closed: true,
    statuses: [{
      id: 'status-a28-1', status: '⭐ Выбрать', date: '2026-08-01',
      plannedActionDate: '2026-09-03', nextActionStatus: '🏆 Выбран', taskPlanSource: 'staff'
    }],
    reviews: []
  };
  const events = context.window.ClientApp.gatherCalendarEvents(
    { anketas: [anketa] }, [], []
  ).filter(event => event.kind === 'status-plan');
  assert.equal(events.length, 0);
});

test('same-day outreach cancellation warns that the date cannot be restored', () => {
  const copy = context.window.ClientApp.outreachCancellationCopy('2026-09-01', '2026-09-02');
  assert.equal(copy.cannotRestoreDate, true);
  assert.equal(copy.title, 'Отменить отклик на сегодня?');
  assert.match(copy.message, /Вернуть его на сегодняшний день уже не получится/);
  assert.match(copy.message, /день на закупку и подготовку/);
  assert.match(copy.message, /02\.09\.2026/);
  assert.equal(copy.confirmLabel, 'Всё равно отменить');
});

test('future outreach cancellation keeps a softer availability warning', () => {
  const copy = context.window.ClientApp.outreachCancellationCopy('2026-09-05', '2026-09-02');
  assert.equal(copy.cannotRestoreDate, false);
  assert.equal(copy.title, 'Отменить запланированный отклик?');
  assert.match(copy.message, /только при наличии свободных мест/);
  assert.equal(copy.confirmLabel, 'Отменить отклик');
});

test('client-facing workflow labels explain the current and next action', () => {
  assert.equal(context.window.ClientApp.clientStatusLabel('⭐ Выбрать'), 'Выбрать специалиста');
  assert.equal(context.window.ClientApp.clientStatusLabel('🏆 Выбран'), 'Специалист выбран');
  assert.equal(context.window.ClientApp.clientStatusLabel('🎯 Опубликован'), 'Отзыв опубликован');
  assert.equal(context.window.ClientApp.nextStatusQuestion('🏆 Выбран'), 'Когда выбрать специалиста?');
  assert.equal(context.window.ClientApp.nextStatusQuestion('🎯 Опубликован'), 'Когда опубликовать отзыв?');
});
