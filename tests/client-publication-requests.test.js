'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
const clientApp = fs.readFileSync(path.join(root, 'pages/client/client-app.js'), 'utf8');
const profileHtml = fs.readFileSync(path.join(root, 'pages/client/profile.html'), 'utf8');
const tasksHtml = fs.readFileSync(path.join(root, 'pages/tasks.html'), 'utf8');
const migration = fs.readFileSync(
  path.join(root, 'sql/migrations/2026-08-20_client_publication_requests.sql'),
  'utf8'
);

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
vm.runInContext(appSource, context);

const { Store, STATUS_CHOSEN } = context.window.App;
Store.state = {
  mentors: [{ id: 'mentor-a21', code: 'a21', name: 'Столичный уют' }],
  clients: [{ id: 'client-a21', code: 'a21', name: 'Столичный уют', ordered: 1 }],
  profiles: [{ id: 'profile-1', code: '8-8' }],
  archivedProfiles: [],
  accountRegs: [{ id: 'reg-1', profileId: 'profile-1', ownerName: 'Александр' }],
  profileStatuses: [{
    id: 'status-1', mentorId: 'mentor-a21', profileId: 'profile-1',
    status: STATUS_CHOSEN, date: '2026-06-15', history: []
  }],
  reviews: [], income: []
};
const snapshot = Store._buildAnketaSnapshot('mentor-a21');
assert.equal(snapshot.statuses[0].id, 'status-1');
assert.equal(snapshot.statuses[0].mentorId, 'mentor-a21');
assert.equal(snapshot.statuses[0].profileId, 'profile-1');
assert.equal(snapshot.statuses[0].profileName, 'Александр');

assert.match(migration, /security definer/i);
assert.match(migration, /client_snapshots/);
assert.match(migration, /s\.item ->> 'status' = '🏆 Выбран'/);
assert.match(migration, /p_requested_date < current_date/);
assert.match(migration, /p_requested_date > current_date \+ 180/);
assert.match(migration, /client_email = lower\(coalesce\(auth\.jwt\(\) ->> 'email'/);
assert.match(migration, /kind, message, status, mentor_id, profile_id, client_email/);
assert.doesNotMatch(migration, /grant insert on public\.client_publication_requests to authenticated/i,
  'клиент не получает прямой INSERT в таблицу запросов');

assert.match(clientApp, /status\.status !== '🏆 Выбран'/);
assert.match(clientApp, /request_client_publication_date/);
assert.match(clientApp, /Ожидает подтверждения/);
assert.match(clientApp, /daysSince\(s\.date\)/);
assert.match(profileHtml, /loadMyPublicationRequests/);

assert.match(tasksHtml, /client_publication_request/);
assert.match(tasksHtml, /accept-client-publication/);
assert.match(tasksHtml, /reject-client-publication/);
assert.match(tasksHtml, /Store\.setProfileStatusTaskDate\(request\.status_id, request\.requested_date\)/);
assert.match(tasksHtml, /pushClientSnapshots\(Store\.state\)/);

console.log('client publication requests: OK');
