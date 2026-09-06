'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'pages', 'tasks.html'), 'utf8');
const helper = html.slice(html.indexOf('    const savingTaskChanges = new Set();'),
  html.indexOf('    function escapeHtml(s)'));
const handlers = html.slice(html.indexOf("    document.getElementById('statusScheduleSave').addEventListener"),
  html.indexOf('    /* ---------- фильтры ---------- */'));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(confirmSaved) {
  const elements = new Map();
  const toasts = [];
  const closed = [];
  let confirmationCalls = 0;
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, {
        tagName: 'BUTTON', textContent: 'Сохранить', value: '', disabled: false,
        attributes: {}, style: {}, handlers: {},
        setAttribute(name, value) { this.attributes[name] = value; },
        removeAttribute(name) { delete this.attributes[name]; },
        focus() {},
        addEventListener(type, fn) { this.handlers[type] = fn; }
      });
      return elements.get(id);
    }
  };
  const Store = {
    state: { dailyTasks: [], profileStatuses: [{ id: 'status-1', plannedActionDate: '' }] },
    setProfileStatusTaskDate(id, date) {
      const status = this.state.profileStatuses.find(item => item.id === id);
      if (status) status.plannedActionDate = date;
      return status;
    },
    addDailyTask(task) { this.state.dailyTasks.push({ id: `task-${this.state.dailyTasks.length + 1}`, ...task }); },
    updateDailyTask(id, patch) { Object.assign(this.state.dailyTasks.find(task => task.id === id), patch); },
    deleteDailyTask(id) { this.state.dailyTasks = this.state.dailyTasks.filter(task => task.id !== id); }
  };
  const context = vm.createContext({
    document, Store, console: { warn() {} },
    window: { CloudSync: { async confirmSaved() { confirmationCalls += 1; return confirmSaved(); } } },
    toast(message, kind) { toasts.push({ message, kind }); },
    Modal: { close(id) { closed.push(id); }, open() {} },
    confirmDelete: () => true,
    todayISO: () => '2026-09-06', fmtDate: date => date,
    render() {}, renderSched() {},
    schedState: {}, schedulingStatusId: 'status-1', editingId: null, isOwner: true,
    setTimeout() {}
  });
  vm.runInContext(helper + '\n' + handlers, context);
  document.getElementById('statusScheduleDate').value = '2026-09-07';
  document.getElementById('tMentor').value = 'mentor-1';
  document.getElementById('tNote').value = 'Проверить план';
  return {
    Store, context, toasts, closed,
    get confirmationCalls() { return confirmationCalls; },
    element: id => document.getElementById(id),
    click(id) { const target = document.getElementById(id); return target.handlers.click({ currentTarget: target }); }
  };
}

test('task scheduling shows success only after server acknowledgement and blocks duplicate saves', async () => {
  const ack = deferred();
  const h = harness(() => ack.promise);
  const save = h.click('statusScheduleSave');
  assert.equal(h.Store.state.profileStatuses[0].plannedActionDate, '2026-09-07');
  assert.equal(h.element('statusScheduleSave').disabled, true);
  assert.equal(h.toasts.length, 0);
  assert.equal(h.closed.length, 0);
  await h.click('statusScheduleSave');
  assert.equal(h.confirmationCalls, 1);
  ack.resolve({ saved: true });
  await save;
  assert.equal(h.toasts[0].message, 'Задача запланирована на 2026-09-07');
  assert.deepEqual(h.closed, ['statusScheduleModal']);
  assert.equal(h.element('statusScheduleSave').disabled, false);
  assert.equal(h.element('statusScheduleSave').textContent, 'Сохранить');
});

test('an offline task plan stays local and is explicitly marked as pending, without a success toast', async () => {
  const h = harness(() => ({ saved: false, error: 'offline' }));
  await h.click('statusScheduleSave');
  assert.equal(h.Store.state.profileStatuses[0].plannedActionDate, '2026-09-07');
  assert.deepEqual(h.toasts, [{
    message: 'Изменения сохранены на устройстве. Ожидаем отправки на сервер.', kind: 'error'
  }]);
  assert.deepEqual(h.closed, ['statusScheduleModal']);
  assert.equal(h.element('statusScheduleSave').disabled, false);
});

test('new manual tasks are created once while their server save is pending', async () => {
  const ack = deferred();
  const h = harness(() => ack.promise);
  const save = h.click('tSave');
  await h.click('tSave');
  assert.equal(h.Store.state.dailyTasks.length, 1);
  assert.equal(h.confirmationCalls, 1);
  assert.equal(h.toasts.length, 0);
  ack.resolve({ saved: true });
  await save;
  assert.equal(h.toasts[0].message, 'Задача добавлена');
  assert.equal(h.element('tSave').disabled, false);
});

test('manual task edits and deletions share a lock until the server responds', async () => {
  const ack = deferred();
  const h = harness(() => ack.promise);
  h.Store.state.dailyTasks.push({ id: 'task-1', note: 'Старый план' });
  h.context.editingId = 'task-1';
  const save = h.click('tSave');
  await h.click('tDelete');
  assert.equal(h.Store.state.dailyTasks.length, 1);
  assert.equal(h.Store.state.dailyTasks[0].note, 'Проверить план');
  assert.equal(h.toasts.length, 0);
  ack.resolve({ saved: true });
  await save;
  assert.equal(h.toasts[0].message, 'Сохранено');
  await h.click('tDelete');
  assert.equal(h.Store.state.dailyTasks.length, 0);
  assert.equal(h.toasts[1].message, 'Удалено');
});

test('unconfirmed deletions never claim that deletion reached the server', async () => {
  const h = harness(() => ({ saved: false }));
  h.Store.state.dailyTasks.push({ id: 'task-1' });
  h.context.editingId = 'task-1';
  await h.click('tDelete');
  assert.equal(h.Store.state.dailyTasks.length, 0);
  assert.match(h.toasts[0].message, /Ожидаем отправки на сервер/);
  assert.equal(h.element('tDelete').disabled, false);
});

test('unexpected confirmation failures keep local edits and release the save button', async () => {
  const h = harness(() => { throw new Error('network failed'); });
  await h.click('tSave');
  assert.equal(h.Store.state.dailyTasks.length, 1);
  assert.match(h.toasts[0].message, /сохранены на устройстве/);
  assert.equal(h.element('tSave').disabled, false);
  assert.deepEqual(h.closed, ['taskModal']);
});

test('local mutation failures do not falsely claim that changes are saved locally', async () => {
  const h = harness(() => ({ saved: true }));
  h.Store.addDailyTask = () => { throw new Error('local write failed'); };
  await h.click('tSave');
  assert.equal(h.confirmationCalls, 0);
  assert.equal(h.toasts[0].message, 'Не удалось сохранить изменения. Попробуй ещё раз.');
  assert.equal(h.element('tSave').disabled, false);
  assert.equal(h.closed.length, 0);
});

test('an unavailable sync layer cannot produce a server-saved confirmation', async () => {
  const h = harness(() => ({ saved: true }));
  delete h.context.window.CloudSync;
  await h.click('tSave');
  assert.match(h.toasts[0].message, /Ожидаем отправки на сервер/);
  assert.equal(h.confirmationCalls, 0);
});

test('a removed task is not falsely reported as successfully edited', async () => {
  const h = harness(() => ({ saved: true }));
  h.context.editingId = 'deleted-task';
  await h.click('tSave');
  assert.equal(h.confirmationCalls, 0);
  assert.equal(h.toasts[0].message, 'Задача уже удалена. Обновляю список.');
});

test('a delayed calendar response cannot repaint an older plan after a live update', async () => {
  const calendarCode = html.slice(html.indexOf('    async function renderSched()'),
    html.indexOf("    document.getElementById('schedPrev').addEventListener"));
  const firstResponse = deferred();
  const secondResponse = deferred();
  const requests = [firstResponse, secondResponse];
  const rendered = [];
  let version = 'old';
  const context = vm.createContext({
    collectScheduleByDate: () => ({ version }),
    collectStatusActionsByDate: () => ({ version }),
    renderSchedSummary() {}, renderSchedGrid() {},
    renderSchedDayDetail(schedule, actions) { rendered.push([schedule.version, actions.version]); },
    loadScheduleResponses: () => requests.shift().promise
  });
  vm.runInContext(calendarCode, context);
  await context.renderSched();
  version = 'new';
  await context.renderSched();
  secondResponse.resolve();
  await Promise.resolve();
  firstResponse.resolve();
  await Promise.resolve();
  assert.deepEqual(rendered, [['old', 'old'], ['new', 'new'], ['new', 'new'], ['new', 'new']]);
});
