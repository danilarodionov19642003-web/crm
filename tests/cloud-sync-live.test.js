const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const sourcePath = path.join(__dirname, '..', 'js', 'cloud-sync.js');
const STORAGE_KEY = 'mentori-crm-v2';
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatchEvent(event) {
      for (const listener of [...(listeners.get(event.type) || [])]) listener(event);
      return true;
    }
  };
}

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return clone(body); },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); }
  };
}

function createServer(initialState) {
  let clock = Date.parse('2026-09-05T20:58:00.000Z');
  const requests = [];
  const gates = [];
  const failures = [];
  const server = {
    data: clone(initialState),
    updatedAt: new Date(clock).toISOString(),
    requests,
    nextTime() { return ++clock; },
    failNext(method, select, status = 503) { failures.push({ method, select, status }); },
    change(edit) {
      edit(server.data);
      server.updatedAt = new Date(server.nextTime()).toISOString();
    },
    holdNext(method, select) {
      const started = deferred();
      const release = deferred();
      const gate = {
        method, select, request: null,
        started: started.promise,
        release: () => release.resolve(),
        async wait(request) {
          gate.request = request;
          started.resolve(request);
          await release.promise;
        }
      };
      gates.push(gate);
      return gate;
    },
    async fetch(client, rawUrl, options = {}) {
      if (!client.navigator.onLine) throw new Error('Simulated offline connection');
      const url = new URL(rawUrl);
      const method = (options.method || 'GET').toUpperCase();
      const request = {
        client: client.name,
        method,
        table: url.pathname.split('/').pop(),
        select: url.searchParams.get('select'),
        body: options.body ? JSON.parse(options.body) : null
      };
      requests.push(request);
      if (request.table !== 'crm_state') return response(201, []);
      const failureIndex = failures.findIndex(failure => failure.method === method
        && (failure.select == null || failure.select === request.select));
      if (failureIndex !== -1) return response(failures.splice(failureIndex, 1)[0].status, 'Temporary outage');

      // A held GET represents a response generated before a concurrent write,
      // not a fresh read performed only after its network delay has ended.
      const captured = { data: clone(server.data), updated_at: server.updatedAt };
      const index = gates.findIndex(gate => gate.method === method
        && (gate.select == null || gate.select === request.select));
      if (index !== -1) await gates.splice(index, 1)[0].wait(request);

      if (method === 'GET') {
        return response(200, [request.select === 'updated_at'
          ? { updated_at: captured.updated_at }
          : captured]);
      }
      if (method === 'PATCH') {
        const expected = url.searchParams.get('updated_at')?.replace(/^eq\./, '');
        if (expected !== server.updatedAt) return response(200, []);
        server.data = clone(request.body.data);
        server.updatedAt = request.body.updated_at;
        return response(200, [{ id: 'main' }]);
      }
      if (method === 'POST') {
        server.data = clone(request.body.data);
        server.updatedAt = request.body.updated_at;
        return response(201, null);
      }
      return response(405, 'Unsupported request');
    }
  };
  return server;
}

function createStorage(initialState, initialVersion) {
  const values = new Map([
    [STORAGE_KEY, JSON.stringify(initialState)],
    ['mentori-crm-meta', JSON.stringify({ lastPulledAt: initialVersion })]
  ]);
  const clients = new Set();
  const changes = [];
  let queued = 0;
  return {
    values,
    changes,
    get queued() { return queued; },
    detach(client) { clients.delete(client); },
    attach(client) {
      clients.add(client);
      function change(key, newValue) {
        const oldValue = values.get(key) ?? null;
        if (oldValue === newValue) return;
        changes.push({ document: client.name, key, oldValue, newValue });
        if (newValue === null) values.delete(key);
        else values.set(key, newValue);
        for (const other of clients) {
          if (other === client) continue;
          queued++;
          // Native storage events arrive in the other document's next task.
          setImmediate(() => {
            queued--;
            if (!clients.has(other)) return;
            other.window.dispatchEvent({
              type: 'storage', key, oldValue, newValue,
              storageArea: other.localStorage
            });
          });
        }
      }
      return {
        get length() { return values.size; },
        key(index) { return [...values.keys()][index] ?? null; },
        getItem(key) { return values.get(key) ?? null; },
        setItem(key, value) { change(key, String(value)); },
        removeItem(key) { change(key, null); }
      };
    }
  };
}

function createLockManager() {
  const held = new Map();
  const queues = new Map();
  function release(request) {
    if (held.get(request.name) !== request) return;
    held.delete(request.name);
    const next = queues.get(request.name)?.shift();
    if (next) start(next);
  }
  function start(request) {
    held.set(request.name, request);
    Promise.resolve().then(() => request.callback({ name: request.name, mode: 'exclusive' }))
      .then(request.resolve, request.reject).finally(() => release(request));
  }
  return {
    forDocument(owner) {
      return {
        request(name, options, callback) {
          if (typeof options === 'function') { callback = options; options = {}; }
          if (options?.ifAvailable && held.has(name)) return Promise.resolve(callback(null));
          return new Promise((resolve, reject) => {
            const request = { owner, name, callback, resolve, reject };
            if (!held.has(name)) start(request);
            else {
              if (!queues.has(name)) queues.set(name, []);
              queues.get(name).push(request);
            }
          });
        }
      };
    },
    closeDocument(owner) {
      // Browser-held locks are released on unload even if the callback promise
      // deliberately stays pending for the document's lifetime.
      for (const request of [...held.values()]) if (request.owner === owner) release(request);
    }
  };
}

function createClient(name, server, storage = createStorage(server.data, server.updatedAt), options = {}) {
  const timers = new Map();
  let timerId = 0;
  let reloads = 0;
  let storeUpdates = 0;
  const statusText = { textContent: '' };
  const status = { dataset: {}, querySelector() { return statusText; } };
  const window = eventTarget();
  const document = {
    ...eventTarget(),
    visibilityState: 'visible',
    getElementById(id) { return id === 'cloudStatus' ? status : null; }
  };
  const client = {
    name, window, document, storage,
    navigator: { onLine: true, userAgent: `sync-live-test-${name}` },
    get reloads() { return reloads; },
    get storeUpdates() { return storeUpdates; },
    status
  };
  client.localStorage = storage.attach(client);
  const session = options.session || new Map();
  client.session = session;
  if (options.locks) client.navigator.locks = options.locks.forDocument(name);
  client.close = () => {
    client.navigator.onLine = false;
    document.visibilityState = 'hidden';
    storage.detach(client);
    options.locks?.closeDocument(name);
  };
  const sessionStorage = {
    getItem(key) { return session.get(key) ?? null; },
    setItem(key, value) { session.set(key, String(value)); },
    removeItem(key) { session.delete(key); }
  };
  const Store = {
    state: JSON.parse(client.localStorage.getItem(STORAGE_KEY)),
    load() {
      this.state = JSON.parse(client.localStorage.getItem(STORAGE_KEY));
      if (options.normalize) {
        options.normalize(this.state);
        client.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      }
    },
    save() {
      client.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      window.CloudSync.push(this.state);
    },
    buildAllClientSnapshots() { return []; }
  };
  client.Store = Store;
  if (options.normalize) Store.load();
  window.App = { Store };
  window.window = window;
  window.Supabase = {
    URL: 'https://sync.test', KEY: 'test-key',
    authFetch: (...args) => server.fetch(client, ...args)
  };
  const now = () => typeof options.now === 'function' ? options.now() : (options.now ?? server.nextTime());
  class SyncDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now()])); }
    static now() { return now(); }
  }
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    URL, URLSearchParams, Date: SyncDate, JSON, Map, Set, Symbol, Promise,
    Math, encodeURIComponent,
    window, document, navigator: client.navigator,
    localStorage: client.localStorage, sessionStorage,
    location: { search: '', pathname: '/pages/tasks.html', hash: '', reload() { reloads++; } },
    history: { replaceState() {} },
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
    },
    fetch: (...args) => server.fetch(client, ...args),
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay, interval: false });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay, interval: true });
      return id;
    },
    clearInterval(id) { timers.delete(id); }
  };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), sandbox, { filename: sourcePath });
  window.addEventListener('cloudstate:updated', () => {
    Store.load();
    storeUpdates++;
    window.dispatchEvent(new sandbox.CustomEvent('store:reloaded'));
  });
  client.cloud = window.CloudSync;
  client.save = edit => { edit(Store.state); Store.save(); };
  client.confirm = () => {
    assert.equal(typeof client.cloud.confirmSaved, 'function', 'UI needs a server-confirmed save result');
    return client.cloud.confirmSaved();
  };
  client.boot = async () => {
    document.dispatchEvent({ type: 'DOMContentLoaded' });
    await settle(server, storage);
    for (const [id, timer] of [...timers]) {
      if (!timer.interval && timer.delay === 50) {
        timers.delete(id);
        timer.callback();
      }
    }
    await settle(server, storage);
  };
  client.poll = async () => {
    const callbacks = [...timers.values()].filter(timer => timer.interval && timer.delay <= 3000);
    assert.ok(callbacks.length, 'visible tabs must check for updates within three seconds');
    for (const timer of callbacks) timer.callback();
    await settle(server, storage);
  };
  return client;
}

// No wall-clock sleeps: an event-loop barrier lets already-resolved fetches
// finish their microtasks and drains native-style cross-document events.
async function settle(server, ...storages) {
  for (let pass = 0; pass < 30; pass++) {
    const requestCount = server.requests.length;
    await new Promise(resolve => setImmediate(resolve));
    if (requestCount === server.requests.length && storages.every(storage => storage.queued === 0)) return;
  }
  assert.fail('Synchronization kept emitting requests/storage events without becoming idle');
}

function initialState() {
  return {
    initialized: true,
    clients: [{ id: 'a37', name: 'A37', paid: 100 }],
    profiles: [{ id: 'profile-26-1', name: '26-1' }],
    profileStatuses: [{
      id: 'status-26-1-a37', profileId: 'profile-26-1', mentorId: 'a37',
      status: 'Выбрать', plannedActionDate: '', taskPlanSchema: 'separate-v1'
    }],
    reviews: [], clientPortals: []
  };
}

test('fresh shared storage must refresh a stale Store before an unrelated save', async () => {
  const server = createServer(initialState());
  const client = createClient('stale-tab', server);
  await client.cloud.pull();
  server.change(state => { state.profileStatuses[0].plannedActionDate = '2026-09-06'; });

  // Another tab has already replaced shared localStorage. This document's
  // in-memory Store is still old, exactly as in the lost-task incident.
  client.storage.values.set(STORAGE_KEY, JSON.stringify(server.data));
  assert.equal(client.Store.state.profileStatuses[0].plannedActionDate, '');
  await client.cloud.pull({ silent: true });
  assert.equal(client.Store.state.profileStatuses[0].plannedActionDate, '2026-09-06');
  assert.ok(client.storeUpdates > 0, 'the open page must receive its redraw event');

  client.save(state => { state.clients[0].paid = 150; });
  assert.equal((await client.confirm()).saved, true);
  assert.equal(server.data.profileStatuses[0].plannedActionDate, '2026-09-06');
  assert.equal(server.data.clients[0].paid, 150);
});

test('independent users retain both edits and update their open pages without reload', async () => {
  const server = createServer(initialState());
  const owner = createClient('owner', server);
  const manager = createClient('manager', server);
  await Promise.all([owner.cloud.pull(), manager.cloud.pull()]);
  owner.save(state => { state.profileStatuses[0].plannedActionDate = '2026-09-06'; });
  assert.equal((await owner.confirm()).saved, true);

  manager.save(state => { state.clients[0].paid = 150; });
  assert.equal((await manager.confirm()).saved, true);
  await owner.poll();
  for (const client of [owner, manager]) {
    assert.equal(client.Store.state.profileStatuses[0].plannedActionDate, '2026-09-06');
    assert.equal(client.Store.state.clients[0].paid, 150);
    assert.equal(client.reloads, 0);
  }
  assert.equal(server.data.profileStatuses[0].plannedActionDate, '2026-09-06');
  assert.equal(server.data.clients[0].paid, 150);
});

test('background checks fetch the version only until there is a real change', async () => {
  const server = createServer(initialState());
  const client = createClient('reader', server);
  await client.cloud.pull();
  const start = server.requests.length;
  await client.poll();
  const unchangedReads = server.requests.slice(start).filter(request => request.table === 'crm_state');
  assert.ok(unchangedReads.some(request => request.method === 'GET' && request.select === 'updated_at'));
  assert.equal(unchangedReads.some(request => request.select?.includes('data')), false,
    'unchanged CRM must not download the full state every three seconds');

  server.change(state => { state.profileStatuses[0].plannedActionDate = '2026-09-07'; });
  const changedStart = server.requests.length;
  await client.poll();
  assert.ok(server.requests.slice(changedStart).some(request => request.select?.includes('data')));
  assert.equal(client.Store.state.profileStatuses[0].plannedActionDate, '2026-09-07');
});

test('a save in another tab refreshes the receiving Store through storage events', async () => {
  const server = createServer(initialState());
  const storage = createStorage(server.data, server.updatedAt);
  const first = createClient('first-tab', server, storage);
  const second = createClient('second-tab', server, storage);
  await Promise.all([first.cloud.pull(), second.cloud.pull()]);
  await settle(server, storage);
  const start = server.requests.length;
  first.save(state => { state.profileStatuses[0].plannedActionDate = '2026-09-08'; });
  assert.equal((await first.confirm()).saved, true);
  await settle(server, storage);
  assert.equal(second.Store.state.profileStatuses[0].plannedActionDate, '2026-09-08');
  assert.ok(server.requests.slice(start).some(request => request.client === 'second-tab'
    && request.table === 'crm_state' && request.method === 'GET'),
  'storage signals must be verified against the server');
  assert.equal(second.reloads, 0);
});

test('a pending pull and a new save serialize in both directions', async () => {
  const server = createServer(initialState());
  const client = createClient('racing-tab', server);
  await client.cloud.pull();
  server.change(state => { state.profileStatuses[0].plannedActionDate = '2026-09-09'; });
  const gate = server.holdNext('GET', 'data,updated_at');
  const pull = client.cloud.pull({ silent: true });
  await gate.started;
  client.save(state => { state.clients[0].paid = 175; });
  const saving = client.confirm();
  await settle(server, client.storage);
  assert.equal(server.requests.some(request => request.method === 'PATCH'), false,
    'save must not race the already-running pull and change its merge base');
  gate.release();
  await pull;
  assert.equal((await saving).saved, true);
  assert.equal(server.data.profileStatuses[0].plannedActionDate, '2026-09-09');
  assert.equal(server.data.clients[0].paid, 175);
  assert.equal(client.Store.state.clients[0].paid, 175);
});

test('offline confirmation reports failure and keeps the unsaved draft durable', async () => {
  const server = createServer(initialState());
  const client = createClient('offline-tab', server);
  await client.cloud.pull();
  client.navigator.onLine = false;
  client.save(state => { state.profileStatuses[0].plannedActionDate = '2026-09-10'; });
  const result = await client.confirm();
  assert.equal(result.saved, false);
  assert.equal(server.data.profileStatuses[0].plannedActionDate, '');
  assert.equal(client.Store.state.profileStatuses[0].plannedActionDate, '2026-09-10');
  const drafts = [...client.storage.values.entries()]
    .filter(([key]) => key.startsWith('mentori-crm-pending'))
    .map(([, value]) => JSON.parse(value));
  assert.ok(drafts.some(draft => draft.state?.profileStatuses[0].plannedActionDate === '2026-09-10'),
    'the failed save remains persisted for recovery');
  assert.notEqual(client.status.dataset.state, 'synced');
});

test('confirmation waits for newer edits queued while the first request is in flight', async () => {
  const server = createServer(initialState());
  const client = createClient('fast-editor', server);
  await client.cloud.pull();
  client.save(state => { state.profileStatuses[0].plannedActionDate = '2026-09-11'; });
  const firstGate = server.holdNext('PATCH');
  let confirmed = false;
  const saving = client.confirm().then(result => { confirmed = true; return result; });
  await firstGate.started;
  client.save(state => { state.clients[0].paid = 200; });
  const secondGate = server.holdNext('PATCH');
  firstGate.release();
  await settle(server, client.storage);
  assert.ok(secondGate.request, 'confirmation must actively save the newer queued revision');
  assert.equal(confirmed, false, 'the first request alone does not confirm all changes');
  assert.notEqual(client.status.dataset.state, 'synced', 'unsent edits must not display saved');
  secondGate.release();
  assert.equal((await saving).saved, true);
  assert.equal(server.data.profileStatuses[0].plannedActionDate, '2026-09-11');
  assert.equal(server.data.clients[0].paid, 200);
});

test('a duplicated tab cannot replay or remove the original tab\'s offline draft', async () => {
  const server = createServer(initialState());
  const storage = createStorage(server.data, server.updatedAt);
  const locks = createLockManager();
  const original = createClient('original-document', server, storage, { locks });
  await original.cloud.pull();
  original.navigator.onLine = false;
  original.save(state => { state.profileStatuses[0].plannedActionDate = '2026-09-12'; });
  assert.equal((await original.confirm()).saved, false);
  const draftKey = [...storage.values.keys()].find(key => key.startsWith('mentori-crm-pending:'));
  assert.ok(draftKey);

  // Browser Duplicate Tab copies sessionStorage, but creates a separate
  // document; the still-live original keeps its draft ownership lock.
  const duplicate = createClient('duplicated-document', server, storage,
    { locks, session: new Map(original.session) });
  await duplicate.boot();
  assert.equal(server.data.profileStatuses[0].plannedActionDate, '');
  assert.equal(duplicate.Store.state.profileStatuses[0].plannedActionDate, '');
  assert.equal(JSON.parse(storage.values.get(draftKey)).state.profileStatuses[0].plannedActionDate, '2026-09-12');

  duplicate.save(state => { state.clients[0].paid = 225; });
  assert.equal((await duplicate.confirm()).saved, true);
  assert.ok(storage.values.has(draftKey), 'saving the duplicate must not clear the original draft');
  assert.equal(server.data.profileStatuses[0].plannedActionDate, '');

  original.navigator.onLine = true;
  assert.equal((await original.confirm()).saved, true);
  assert.equal(server.data.profileStatuses[0].plannedActionDate, '2026-09-12');
  assert.equal(server.data.clients[0].paid, 225);
  original.close();
  duplicate.close();
});

test('reloading an offline editor recovers its own draft after the previous document unloads', async () => {
  const server = createServer(initialState());
  const storage = createStorage(server.data, server.updatedAt);
  const locks = createLockManager();
  const previous = createClient('before-reload', server, storage, { locks });
  await previous.cloud.pull();
  previous.navigator.onLine = false;
  previous.save(state => { state.profileStatuses[0].plannedActionDate = '2026-09-13'; });
  assert.equal((await previous.confirm()).saved, false);
  const draftKey = [...storage.values.keys()].find(key => key.startsWith('mentori-crm-pending:'));
  previous.close();

  server.change(state => { state.clients[0].paid = 250; });
  const reloaded = createClient('after-reload', server, storage,
    { locks, session: previous.session });
  await reloaded.boot();
  assert.equal((await reloaded.confirm()).saved, true);
  assert.equal(server.data.profileStatuses[0].plannedActionDate, '2026-09-13');
  assert.equal(server.data.clients[0].paid, 250);
  assert.equal(reloaded.Store.state.profileStatuses[0].plannedActionDate, '2026-09-13');
  assert.equal(storage.values.has(draftKey), false, 'old draft is removed only after ownership transfer');
  reloaded.close();
});

test('sub-millisecond and reused versions do not conceal independent remote edits', async () => {
  for (const remoteVersion of ['2026-09-05T20:58:00.123456+00:00', '2026-09-05T20:58:00.123000+00:00']) {
    const server = createServer(initialState());
    server.updatedAt = '2026-09-05T20:58:00.123000+00:00';
    const client = createClient('precise-version-editor', server);
    await client.cloud.pull();
    client.save(state => { state.profileStatuses[0].plannedActionDate = '2026-09-14'; });
    server.data.clients[0].paid = 275;
    server.updatedAt = remoteVersion;
    assert.equal((await client.confirm()).saved, true);
    assert.equal(server.data.profileStatuses[0].plannedActionDate, '2026-09-14');
    assert.equal(server.data.clients[0].paid, 275, `remote edit must survive version ${remoteVersion}`);
  }
});

test('normalized Store fields do not cause redraws or storage churn on unchanged version polls', async () => {
  const server = createServer(initialState());
  const client = createClient('normalizing-store', server, undefined, {
    normalize(state) {
      const status = state.profileStatuses[0];
      status.derivedPlanLabel = status.plannedActionDate ? `Scheduled ${status.plannedActionDate}` : 'No plan';
    }
  });
  await client.cloud.pull();
  assert.equal(client.Store.state.profileStatuses[0].derivedPlanLabel, 'No plan');
  const updates = client.storeUpdates;
  const writes = client.storage.changes.length;
  for (let poll = 0; poll < 3; poll++) await client.poll();
  assert.equal(client.storeUpdates, updates, 'unchanged polls must leave the current form mounted');
  assert.equal(client.storage.changes.length, writes, 'normalization must not alternate raw and normalized storage');

  server.change(state => { state.profileStatuses[0].plannedActionDate = '2026-09-15'; });
  await client.poll();
  assert.equal(client.storeUpdates, updates + 1, 'real server changes still redraw the page once');
  assert.equal(client.Store.state.profileStatuses[0].plannedActionDate, '2026-09-15');
  assert.equal(client.Store.state.profileStatuses[0].derivedPlanLabel, 'Scheduled 2026-09-15');
});

test('every confirmed write advances the server version even when the local clock is frozen', async () => {
  const server = createServer(initialState());
  const fixedTime = Date.parse(server.updatedAt);
  const client = createClient('frozen-clock', server, undefined, { now: fixedTime });
  await client.cloud.pull();
  const initialVersion = server.updatedAt;
  client.save(state => { state.profileStatuses[0].plannedActionDate = '2026-09-16'; });
  assert.equal((await client.confirm()).saved, true);
  const firstVersion = server.updatedAt;
  client.save(state => { state.clients[0].paid = 300; });
  assert.equal((await client.confirm()).saved, true);
  const secondVersion = server.updatedAt;
  assert.ok(Date.parse(firstVersion) > Date.parse(initialVersion));
  assert.ok(Date.parse(secondVersion) > Date.parse(firstVersion), 'second edit must be visible to version-only pollers');
  assert.equal(server.data.profileStatuses[0].plannedActionDate, '2026-09-16');
  assert.equal(server.data.clients[0].paid, 300);
});

test('background polling retries an unsuccessful initial pull without a reload or focus event', async () => {
  const server = createServer(initialState());
  const client = createClient('temporary-startup-outage', server);
  server.change(state => { state.profileStatuses[0].plannedActionDate = '2026-09-17'; });
  server.failNext('GET', 'data,updated_at');
  const failed = await client.cloud.pull();
  assert.ok(failed.error, 'the first full read failed before any server state was accepted');
  assert.equal(client.Store.state.profileStatuses[0].plannedActionDate, '');
  const start = server.requests.length;
  await client.poll();
  assert.ok(server.requests.slice(start).some(request => request.method === 'GET' && request.select?.includes('data')),
    'the regular live-update timer must retry the initial state download');
  assert.equal(client.Store.state.profileStatuses[0].plannedActionDate, '2026-09-17');
  assert.equal(client.reloads, 0);
});
