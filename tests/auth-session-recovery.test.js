'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const authSource = fs.readFileSync(path.join(root, 'js/supabase-client.js'), 'utf8');
const cloudSource = fs.readFileSync(path.join(root, 'js/cloud-sync.js'), 'utf8');
const SESSION_KEY = 'mentori-supabase-session';

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body; },
    async text() { return body == null ? '' : JSON.stringify(body); }
  };
}

function createAuthRuntime(initialSession, fetchImpl, onLock) {
  const storage = new Map([[SESSION_KEY, JSON.stringify(initialSession)]]);
  const events = [];
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); }
  };
  const context = {
    console,
    Date,
    JSON,
    Promise,
    localStorage,
    fetch: fetchImpl,
    clearTimeout() {},
    setTimeout() { return 1; },
    CustomEvent: function CustomEvent(type) { this.type = type; },
    document: { visibilityState: 'visible', addEventListener() {} },
    navigator: {
      locks: {
        async request(name, task) {
          assert.equal(name, 'mentori-supabase-auth-refresh');
          if (onLock) onLock(localStorage);
          return task();
        }
      }
    },
    window: {
      addEventListener() {},
      dispatchEvent(event) { events.push(event.type); }
    }
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(authSource, context);
  return { Supabase: context.window.Supabase, localStorage, events };
}

const nowSec = Math.floor(Date.now() / 1000);
const user = { id: 'owner-1', email: 'owner@example.test', app_metadata: { role: 'owner' } };

(async () => {
  {
    const spoofedUser = {
      id: 'client-1',
      email: 'client@example.test',
      app_metadata: { role: 'client' },
      user_metadata: { role: 'owner' }
    };
    const runtime = createAuthRuntime(
      { user: spoofedUser, access_token: 'access', refresh_token: 'refresh', expires_at: nowSec + 3600 },
      async () => response(200, {})
    );
    assert.equal(runtime.Supabase.Auth.role(), 'client', 'user_metadata must not elevate a role');
  }

  {
    const calls = [];
    const freshSession = {
      user, access_token: 'access-fresh', refresh_token: 'refresh-2', expires_at: nowSec + 3600
    };
    const runtime = createAuthRuntime(
      { user, access_token: 'access-expired', refresh_token: 'refresh-1', expires_at: nowSec - 60 },
      async (url, options = {}) => {
        calls.push({ url, authorization: options.headers && options.headers.Authorization });
        if (url.includes('grant_type=refresh_token')) return response(200, freshSession);
        assert.equal(options.headers.Authorization, 'Bearer access-fresh');
        return response(200, [{ id: 'main' }]);
      }
    );

    const rows = await runtime.Supabase.rest('crm_state?id=eq.main');
    assert.equal(rows[0].id, 'main');
    assert.equal(calls.filter(call => call.url.includes('grant_type=refresh_token')).length, 1);
    assert.equal(calls.filter(call => call.url.includes('/rest/v1/')).length, 1);
    assert.equal(JSON.parse(runtime.localStorage.getItem(SESSION_KEY)).access_token, 'access-fresh');
  }

  {
    let restCalls = 0;
    let refreshCalls = 0;
    const runtime = createAuthRuntime(
      { user, access_token: 'access-old', refresh_token: 'refresh-old', expires_at: nowSec + 3600 },
      async (url, options = {}) => {
        if (url.includes('grant_type=refresh_token')) {
          refreshCalls += 1;
          return response(200, {
            user, access_token: 'access-new', refresh_token: 'refresh-new', expires_at: nowSec + 3600
          });
        }
        restCalls += 1;
        if (restCalls === 1) {
          assert.equal(options.headers.Authorization, 'Bearer access-old');
          return response(401, { message: 'JWT expired' });
        }
        assert.equal(options.headers.Authorization, 'Bearer access-new');
        return response(200, [{ id: 'main' }]);
      }
    );

    const rows = await runtime.Supabase.rest('crm_state?id=eq.main');
    assert.equal(rows[0].id, 'main');
    assert.equal(restCalls, 2, 'REST request must retry exactly once after 401');
    assert.equal(refreshCalls, 1);
  }

  {
    let refreshCalls = 0;
    const newerSession = {
      user, access_token: 'access-from-other-tab', refresh_token: 'refresh-from-other-tab', expires_at: nowSec + 3600
    };
    const runtime = createAuthRuntime(
      { user, access_token: 'access-expired', refresh_token: 'refresh-stale', expires_at: nowSec - 60 },
      async () => {
        refreshCalls += 1;
        return response(400, { message: 'Invalid refresh token' });
      },
      localStorage => localStorage.setItem(SESSION_KEY, JSON.stringify(newerSession))
    );

    const restored = await runtime.Supabase.Auth.refresh();
    assert.equal(restored.email, user.email);
    assert.equal(refreshCalls, 0, 'tab must reuse the session refreshed while it waited for the lock');
    assert.equal(JSON.parse(runtime.localStorage.getItem(SESSION_KEY)).access_token, 'access-from-other-tab');
  }

  {
    const initial = { user, access_token: 'expired', refresh_token: 'keep-me', expires_at: nowSec - 60 };
    const runtime = createAuthRuntime(initial, async () => response(503, { message: 'temporary outage' }));
    const restored = await runtime.Supabase.Auth.refresh();
    assert.equal(restored, null);
    assert.equal(JSON.parse(runtime.localStorage.getItem(SESSION_KEY)).refresh_token, 'keep-me',
      'temporary server errors must not sign the user out');
    assert.deepEqual(runtime.events, []);
  }

  assert.match(cloudSource, /async function _fetch\(url, opts = \{\}\)/);
  assert.match(cloudSource, /typeof sb\.authFetch === 'function'/);
  assert.match(cloudSource, /else resumeSync\(\)/, 'visible tab must resume cloud synchronization');
  assert.match(cloudSource, /window\.addEventListener\('pageshow'/);
  assert.match(cloudSource, /resumeSync\(\{ silent: true \}\)/,
    'polling must retry even when the first pull never completed');

  console.log('auth session recovery and cloud resume: OK');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
