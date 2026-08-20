'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
const syncSource = fs.readFileSync(path.join(root, 'js/outreach-schedule-sync.js'), 'utf8');
const clientApp = fs.readFileSync(path.join(root, 'pages/client/client-app.js'), 'utf8');
const clientCss = fs.readFileSync(path.join(root, 'pages/client/client.css'), 'utf8');
const clientsHtml = fs.readFileSync(path.join(root, 'pages/clients.html'), 'utf8');
const tasksHtml = fs.readFileSync(path.join(root, 'pages/tasks.html'), 'utf8');
const planHtml = fs.readFileSync(path.join(root, 'pages/plan.html'), 'utf8');
const migration = fs.readFileSync(
  path.join(root, 'sql/migrations/2026-08-20_client_outreach_slots.sql'),
  'utf8'
);

const noop = () => {};
const context = {
  console,
  Date,
  Promise,
  setInterval: noop,
  clearInterval: noop,
  setTimeout: noop,
  clearTimeout: noop,
  CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  document: {
    readyState: 'loading',
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
    Supabase: { URL: 'https://example.test', KEY: 'anon', authFetch: noop }
  }
};
context.window.window = context.window;
vm.createContext(context);
vm.runInContext(appSource, context);
vm.runInContext(syncSource, context);

const { Store, PROFILE_STATUSES, STATUS_SELECT } = context.window.App;
let saves = 0;
Store.save = () => { saves++; };
Store.state = {
  mentors: [
    { id: 'mentor-a1', code: 'a1' },
    { id: 'mentor-a2', code: 'a2' }
  ],
  clients: [
    { id: 'client-a1', code: 'a1', schedule: [{ date: '2026-08-20', count: 9 }] },
    { id: 'client-a2', code: 'a2', schedule: [{ date: '2026-08-25', count: 1 }] }
  ],
  profileStatuses: [{
    id: 'status-a1', mentorId: 'mentor-a1', profileId: 'profile-1',
    status: STATUS_SELECT, date: '2026-08-20', history: []
  }]
};

context.window.OutreachScheduleSync.syncStateFromRows([
  { id: 1, mentor_id: 'mentor-a1', scheduled_date: '2026-08-20', slot_status: 'completed' },
  { id: 2, mentor_id: 'mentor-a1', scheduled_date: '2026-08-20', slot_status: 'scheduled' },
  { id: 3, mentor_id: 'mentor-a1', scheduled_date: '2026-08-20', slot_status: 'scheduled' },
  { id: 4, mentor_id: 'mentor-a1', scheduled_date: '2026-08-21', slot_status: 'cancelled' }
]);

assert.deepEqual(JSON.parse(JSON.stringify(Store.state.clients[0].schedule)), [
  { date: '2026-08-20', count: 3 }
]);
assert.equal(
  context.window.App.clientScheduleBreakdown(Store.state, Store.state.clients[0])[0].remaining,
  2,
  'legacy schedule must show exactly two canonical active slots after subtracting one real start'
);
assert.deepEqual(JSON.parse(JSON.stringify(Store.state.clients[1].schedule)), [
  { date: '2026-08-25', count: 1 }
], 'clients without canonical rows must stay untouched');
assert.equal(saves, 1);

let completedArgs = null;
context.window.CloudSync = {
  completeOutreachSlot: (...args) => {
    completedArgs = args;
    return Promise.resolve(true);
  }
};
Store.state.profileStatuses.push({
  id: 'status-a1-planned', mentorId: 'mentor-a1', profileId: 'profile-2',
  status: PROFILE_STATUSES[0], date: '2026-08-22', history: []
});
Store.setProfileStatus('mentor-a1', 'profile-2', STATUS_SELECT, '', '2026-08-23');
assert.deepEqual(completedArgs, ['mentor-a1', '2026-08-23'],
  'starting real work must close one canonical outreach slot');

assert.match(migration, /create table if not exists public\.client_outreach_slots/i);
assert.match(migration, /pg_advisory_xact_lock/);
assert.match(migration, /outreach-client:/);
assert.match(migration, /used_on_target >= 7/);
assert.match(migration, /caller_app_role <> 'client'/);
assert.match(migration, /client_email = lower\(coalesce\(auth\.jwt\(\) ->> 'email'/);
assert.match(migration, /kind, message, status, mentor_id, client_email/);
assert.match(migration, /staff_adjust_outreach_slot/);
assert.match(migration, /staff_move_outreach_slot/);
assert.match(migration, /staff_complete_outreach_slot/);
assert.match(migration, /scheduled_date <= p_date/);
assert.doesNotMatch(migration, /grant insert on public\.client_outreach_slots to authenticated/i);

assert.match(clientApp, /manage_client_outreach_slot/);
assert.match(clientApp, /get_client_outreach_calendar/);
assert.match(clientApp, /data-outreach-move/);
assert.match(clientApp, /data-outreach-cancel/);
assert.match(clientApp, /7 откликов/);
assert.match(appSource, /scheduleLimit: client \? manualScheduleLimit/);
assert.match(clientCss, /\.cli-status-mobile__item/);
assert.match(clientCss, /\.cli-outreach-cal__grid/);
assert.match(clientsHtml, /const MAX_OUTREACH_PER_DAY = 7/);
assert.match(clientsHtml, /outreachSlotsOnDate/);
assert.match(tasksHtml, /outreach-schedule-sync\.js/);
assert.match(planHtml, /outreach-schedule-sync\.js/);

console.log('client outreach scheduling: OK');
