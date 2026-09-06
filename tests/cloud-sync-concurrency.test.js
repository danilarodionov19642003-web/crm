const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const CLOUD_SYNC_PATH = require('node:path').join(__dirname, '..', 'js', 'cloud-sync.js');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function makeResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return clone(payload); },
    async text() { return typeof payload === 'string' ? payload : JSON.stringify(payload); }
  };
}

function createHarness(initialState, options = {}) {
  const storage = new Map();
  if (options.bootLocal) storage.set('mentori-crm-v2', JSON.stringify(options.bootLocal));
  if (options.bootMeta) storage.set('mentori-crm-meta', JSON.stringify(options.bootMeta));
  const server = {
    data: clone(initialState),
    updatedAt: '2026-07-26T00:00:00.000Z'
  };
  const historyRows = [];
  let timerId = 0;
  let beforeNextPatch = null;
  let patchGate = null;
  let patchStartedResolve = null;

  async function authFetch(rawUrl, options = {}) {
    const url = new URL(rawUrl);
    const method = String(options.method || 'GET').toUpperCase();

    if (url.pathname.endsWith('/crm_state_history')) {
      historyRows.push(clone(JSON.parse(options.body)));
      return makeResponse(201, null);
    }
    if (url.pathname.endsWith('/client_snapshots')) return makeResponse(201, null);
    if (!url.pathname.endsWith('/crm_state')) return makeResponse(404, 'not found');

    if (method === 'GET') {
      return makeResponse(200, server.data ? [{ data: server.data, updated_at: server.updatedAt }] : []);
    }

    if (method === 'POST') {
      const body = JSON.parse(options.body);
      server.data = clone(body.data);
      server.updatedAt = body.updated_at;
      return makeResponse(201, null);
    }

    if (method === 'PATCH') {
      if (beforeNextPatch) {
        const hook = beforeNextPatch;
        beforeNextPatch = null;
        hook(server);
      }
      if (patchStartedResolve) {
        patchStartedResolve();
        patchStartedResolve = null;
      }
      if (patchGate) await patchGate.promise;

      const expected = url.searchParams.get('updated_at')?.replace(/^eq\./, '') || '';
      if (expected !== server.updatedAt) return makeResponse(200, []);
      const body = JSON.parse(options.body);
      server.data = clone(body.data);
      server.updatedAt = body.updated_at;
      return makeResponse(200, [{ id: 'main' }]);
    }

    return makeResponse(405, 'method not allowed');
  }

  const sandbox = {
    console,
    URL,
    URLSearchParams,
    Date,
    JSON,
    Map,
    Set,
    Symbol,
    Promise,
    encodeURIComponent,
    fetch: authFetch,
    setTimeout() { return ++timerId; },
    clearTimeout() {},
    setInterval() { return ++timerId; },
    navigator: { onLine: true, userAgent: 'cloud-sync-concurrency-test' },
    location: { search: '', pathname: '/', hash: '' },
    history: { replaceState() {} },
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); }
    },
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init && init.detail; }
    },
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      getElementById() { return null; }
    },
    window: {
      addEventListener() {},
      dispatchEvent() {},
      App: null,
      Supabase: {
        URL: 'https://sync.test',
        KEY: 'test-key',
        authFetch
      }
    }
  };
  sandbox.window.window = sandbox.window;

  let source = fs.readFileSync(CLOUD_SYNC_PATH, 'utf8');
  source = source.replace(
    '  /* ---- Pull: вытянуть удалённый state и заместить локальный ---- */',
    '  window.__CloudSyncMergeTest = { mergePendingWithRemote };\n\n' +
      '  /* ---- Pull: вытянуть удалённый state и заместить локальный ---- */'
  );
  source = source.replace(
    '  /* ---- Авто-pull при загрузке страницы ---- */',
    '  window.__CloudSyncMergeTest.recoverPending = recoverPending;\n\n' +
      '  /* ---- Авто-pull при загрузке страницы ---- */'
  );
  vm.runInNewContext(source, sandbox, { filename: CLOUD_SYNC_PATH });

  return {
    cloud: sandbox.window.CloudSync,
    merge: sandbox.window.__CloudSyncMergeTest.mergePendingWithRemote,
    recoverPending: sandbox.window.__CloudSyncMergeTest.recoverPending,
    server,
    historyRows,
    storage,
    setLocal(state) {
      storage.set('mentori-crm-v2', JSON.stringify(state));
    },
    beforePatch(hook) { beforeNextPatch = hook; },
    blockNextPatch() {
      let release;
      const promise = new Promise(resolve => { release = resolve; });
      patchGate = { promise, release };
      return {
        started: new Promise(resolve => { patchStartedResolve = resolve; }),
        release() {
          patchGate.release();
          patchGate = null;
        }
      };
    }
  };
}

const base = {
  initialized: true,
  clients: [
    {
      id: 'a21', name: 'A21', paid: 100, remain: 200,
      schedule: [{ date: '2026-07-26', count: 1 }, { date: '2026-07-27', count: 1 }]
    },
    { id: 'a22', name: 'A22', paid: 300, remain: 400 }
  ],
  profiles: [{ id: 'profile-1', mentorIds: ['mentor-1', 'mentor-2'] }],
  profileStatuses: [{
    id: 'status-1',
    status: 'Выбрать',
    history: [{ date: '2026-07-20', status: 'Диалог' }]
  }]
};

{
  const { merge } = createHarness(base);
  const local = clone(base);
  const remote = clone(base);
  local.clients[1].paid = 350;
  remote.clients[0].remain = 150;
  const conflicts = [];
  const merged = merge(local, base, remote, conflicts);
  assert.equal(merged.clients[0].remain, 150, 'remote edit on A21 must survive');
  assert.equal(merged.clients[1].paid, 350, 'local edit on A22 must survive');
  assert.equal(conflicts.length, 0, 'different records are not a conflict');
}

{
  const { merge } = createHarness(base);
  const local = clone(base);
  const remote = clone(base);
  local.clients[0].paid = 150;
  remote.clients[0].remain = 150;
  const conflicts = [];
  const merged = merge(local, base, remote, conflicts);
  assert.equal(merged.clients[0].paid, 150, 'local field on same record must survive');
  assert.equal(merged.clients[0].remain, 150, 'remote field on same record must survive');
  assert.equal(conflicts.length, 0, 'different fields on one record are mergeable');
}

{
  const { merge } = createHarness(base);
  const local = clone(base);
  const remote = clone(base);
  local.clients[0].paid = 150;
  remote.clients[0].paid = 175;
  const conflicts = [];
  const merged = merge(local, base, remote, conflicts);
  assert.equal(merged.clients[0].paid, 150, 'the later pending save wins the same scalar field');
  assert.equal(conflicts.length, 1, 'same-field conflict must be recorded');
  assert.equal(conflicts[0].path, 'clients[id=a21].paid');
}

{
  const { merge } = createHarness(base);
  const local = clone(base);
  const remote = clone(base);
  local.clients = local.clients.filter(client => client.id !== 'a21');
  remote.clients[0].name = 'A21 updated remotely';
  const conflicts = [];
  const merged = merge(local, base, remote, conflicts);
  assert.equal(merged.clients[0].name, 'A21 updated remotely', 'delete must not destroy a concurrently edited record');
  assert.equal(conflicts[0].kind, 'delete-vs-edit');
}

{
  const { merge } = createHarness(base);
  const local = clone(base);
  const remote = clone(base);
  local.profileStatuses[0].history.push({ date: '2026-07-21', status: 'Выбран локально' });
  remote.profileStatuses[0].history.push({ date: '2026-07-21', status: 'Выбран удалённо' });
  const conflicts = [];
  const merged = merge(local, base, remote, conflicts);
  assert.equal(merged.profileStatuses[0].history.length, 3, 'concurrent append-only history entries must be combined');
  assert.equal(conflicts.length, 0);
}

{
  const { merge } = createHarness(base);
  const local = clone(base);
  const remote = clone(base);
  local.clients[0].schedule[0].count = 2;
  remote.clients[0].schedule[1].count = 3;
  local.profiles[0].mentorIds = ['mentor-1'];
  remote.profiles[0].mentorIds.push('mentor-3');
  const conflicts = [];
  const merged = merge(local, base, remote, conflicts);
  assert.deepEqual(
    clone(merged.clients[0].schedule),
    [{ date: '2026-07-26', count: 2 }, { date: '2026-07-27', count: 3 }],
    'different schedule dates must merge by date'
  );
  assert.deepEqual(
    clone(merged.profiles[0].mentorIds),
    ['mentor-1', 'mentor-3'],
    'primitive membership additions and removals must both survive'
  );
  assert.equal(conflicts.length, 0);
}

(async () => {
  // Regression: after a successful push, mutating Store.state must not mutate
  // remoteSnapshot/merge-base. A later edit to another record must still merge.
  {
    const h = createHarness(base);
    await h.cloud.pull();
    const local = clone(base);
    local.clients[0].paid = 110;
    h.setLocal(local);
    h.cloud.push(local);
    await h.cloud.flush();

    h.server.data.clients[1].remain = 350;
    h.server.updatedAt = new Date(Date.parse(h.server.updatedAt) + 1000).toISOString();
    local.clients[0].paid = 120;
    h.setLocal(local);
    h.cloud.push(local);
    await h.cloud.flush();

    assert.equal(h.server.data.clients[0].paid, 120, 'second local edit must not be mistaken for merge-base');
    assert.equal(h.server.data.clients[1].remain, 350, 'parallel remote record edit must survive');
  }

  // A very fast Save before the first network pull still uses the last
  // confirmed local snapshot as its base and merges the newer server state.
  {
    const remote = clone(base);
    remote.clients[1].remain = 360;
    const h = createHarness(remote, {
      bootLocal: base,
      bootMeta: { lastPulledAt: '2026-07-26T00:00:00.000Z' }
    });
    h.server.updatedAt = '2026-07-26T00:00:03.000Z';
    const local = clone(base);
    local.clients[0].paid = 115;
    h.setLocal(local);
    h.cloud.push(local);
    await h.cloud.pull();
    await h.cloud.flush();

    assert.equal(h.server.data.clients[0].paid, 115, 'pre-pull local Save must survive');
    assert.equal(h.server.data.clients[1].remain, 360, 'newer server state must survive pre-pull Save');
  }

  // A second Save while the first PATCH is still in flight must remain queued.
  {
    const h = createHarness(base);
    await h.cloud.pull();
    const first = clone(base);
    first.clients[0].paid = 110;
    h.setLocal(first);
    h.cloud.push(first);
    const gate = h.blockNextPatch();
    const firstFlush = h.cloud.flush();
    await gate.started;

    const second = clone(first);
    second.clients[1].paid = 350;
    h.setLocal(second);
    h.cloud.push(second);
    gate.release();
    await firstFlush;
    await h.cloud.flush();

    assert.equal(h.server.data.clients[0].paid, 110);
    assert.equal(h.server.data.clients[1].paid, 350, 'save made during an in-flight request must not disappear');
  }

  // A write that lands between preflight GET and PATCH must fail CAS, then
  // merge on retry instead of overwriting the newer server state.
  {
    const h = createHarness(base);
    await h.cloud.pull();
    const local = clone(base);
    local.clients[0].paid = 125;
    h.setLocal(local);
    h.cloud.push(local);
    h.beforePatch(server => {
      server.data.clients[1].remain = 325;
      server.updatedAt = new Date(Date.parse(server.updatedAt) + 1000).toISOString();
    });
    await h.cloud.flush();
    await h.cloud.flush();

    assert.equal(h.server.data.clients[0].paid, 125, 'local edit must survive CAS retry');
    assert.equal(h.server.data.clients[1].remain, 325, 'server edit must survive CAS retry');
  }

  // Postgres keeps microseconds while Date.parse rounds to milliseconds.
  // Versions inside the same millisecond must still be treated as different.
  {
    const h = createHarness(base);
    h.server.updatedAt = '2026-07-26T00:00:00.123000+00:00';
    await h.cloud.pull();
    const local = clone(base);
    local.clients[0].paid = 130;
    h.server.data.clients[1].remain = 315;
    h.server.updatedAt = '2026-07-26T00:00:00.123456+00:00';
    h.setLocal(local);
    h.cloud.push(local);
    await h.cloud.flush();

    assert.equal(h.server.data.clients[0].paid, 130, 'local edit must survive microsecond-version merge');
    assert.equal(h.server.data.clients[1].remain, 315, 'microsecond-newer server edit must survive');
  }

  // Old shared drafts have no reliable tab owner. Preserve them separately;
  // a fresh page must not replay another still-open tab's stale snapshot.
  {
    const h = createHarness(base);
    const pending = clone(base);
    pending.clients[0].paid = 140;
    h.server.data.clients[1].remain = 310;
    h.server.updatedAt = '2026-07-26T00:00:05.000Z';
    h.storage.set('mentori-crm-pending', JSON.stringify({
      state: pending,
      base,
      baseUpdatedAt: '2026-07-26T00:00:00.000Z',
      queued_at: '2026-07-26T00:00:01.000Z'
    }));
    await h.recoverPending();
    await h.cloud.pull();
    await h.cloud.flush();

    assert.equal(h.server.data.clients[0].paid, 100, 'unowned legacy snapshot must not change server state');
    assert.equal(h.server.data.clients[1].remain, 310, 'new server edit must survive');
    const backup = JSON.parse(h.storage.get('mentori-crm-pending-quarantine'));
    assert.equal(backup.saved.state.clients[0].paid, 140, 'old unsent change remains recoverable');
    assert.equal((await h.cloud.confirmSaved()).saved, false, 'quarantined work cannot claim server acknowledgement');
  }

  // Same-field edits have one final value (the later Save), but the previous
  // server snapshot must remain recoverable locally and in server history.
  {
    const h = createHarness(base);
    await h.cloud.pull();
    h.server.data.clients[0].paid = 175;
    h.server.updatedAt = '2026-07-26T00:00:02.000Z';
    const local = clone(base);
    local.clients[0].paid = 150;
    h.setLocal(local);
    h.cloud.push(local);
    await h.cloud.flush();
    await Promise.resolve();

    assert.equal(h.server.data.clients[0].paid, 150, 'later Save wins the same field');
    const backup = JSON.parse(h.storage.get('mentori-crm-sync-conflict-backup'));
    assert.equal(backup.remoteState.clients[0].paid, 175, 'previous server value is kept in local conflict backup');
    assert.ok(
      h.historyRows.some(row => row.data.clients[0].paid === 175),
      'previous full server state is forced into history before overwrite'
    );
  }

  console.log('cloud-sync concurrency tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
