'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const authSource = fs.readFileSync(path.join(root, 'js/supabase-client.js'), 'utf8');
const cloudSource = fs.readFileSync(path.join(root, 'js/cloud-sync.js'), 'utf8');
const SESSION_KEY = 'mentori-supabase-session';

function response(status, body, responseHeaders = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        const key = Object.keys(responseHeaders).find(item => item.toLowerCase() === String(name).toLowerCase());
        return key ? String(responseHeaders[key]) : null;
      }
    },
    async json() { return body; },
    async text() { return body == null ? '' : JSON.stringify(body); }
  };
}

function createAuthRuntime(initialSession, fetchImpl, onLock, urlState = {}) {
  const storage = new Map();
  if (initialSession) storage.set(SESSION_KEY, JSON.stringify(initialSession));
  const events = [];
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); }
  };
  const location = {
    hash: urlState.hash || '',
    pathname: urlState.pathname || '/pages/client/login.html',
    search: urlState.search || ''
  };
  const history = {
    replacedUrl: null,
    replaceState(_state, _title, url) {
      this.replacedUrl = url;
      location.hash = '';
    }
  };
  const context = {
    console,
    Date,
    JSON,
    Promise,
    URLSearchParams,
    localStorage,
    location,
    history,
    fetch: fetchImpl,
    clearTimeout() {},
    setTimeout() { return 1; },
    CustomEvent: function CustomEvent(type) { this.type = type; },
    document: { title: 'Client login', visibilityState: 'visible', addEventListener() {} },
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
  return { Supabase: context.window.Supabase, localStorage, events, location, history };
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

  {
    const clientUser = {
      id: 'client-magic-1',
      email: 'new-login@example.test',
      app_metadata: { role: 'client', portal_email: 'portal@example.test' }
    };
    const calls = [];
    const runtime = createAuthRuntime(
      null,
      async (url, options = {}) => {
        calls.push({ url, options });
        assert.match(url, /\/auth\/v1\/user$/);
        assert.equal(options.headers.Authorization, 'Bearer magic-access');
        return response(200, clientUser);
      },
      null,
      {
        hash: '#access_token=magic-access&refresh_token=magic-refresh&token_type=bearer&expires_in=3600',
        search: '?telegram=1'
      }
    );
    const restored = await runtime.Supabase.Auth.consumeUrlSession();
    assert.equal(restored.id, clientUser.id);
    assert.equal(calls.length, 1);
    assert.equal(runtime.location.hash, '', 'session tokens must leave the address bar');
    assert.equal(runtime.history.replacedUrl, '/pages/client/login.html?telegram=1');
    const stored = JSON.parse(runtime.localStorage.getItem(SESSION_KEY));
    assert.equal(stored.access_token, 'magic-access');
    assert.equal(stored.refresh_token, 'magic-refresh');
    assert.equal(runtime.Supabase.Auth.portalEmail(), 'portal@example.test');
    assert.equal(runtime.Supabase.Auth.role(), 'client');
  }

  {
    const runtime = createAuthRuntime(
      null,
      async () => response(401, { message: 'expired' }),
      null,
      { hash: '#access_token=expired&refresh_token=expired-refresh' }
    );
    await assert.rejects(
      runtime.Supabase.Auth.consumeUrlSession(),
      /недействительна или уже истекла/
    );
    assert.equal(runtime.location.hash, '', 'invalid tokens must also leave the address bar');
    assert.equal(runtime.localStorage.getItem(SESSION_KEY), null);
  }

  {
    const runtime = createAuthRuntime(null, async url => {
      assert.match(url, /grant_type=password/);
      return response(429, {
        msg: 'Слишком много попыток входа. Повторите через 15 минут.'
      }, { 'Retry-After': '900' });
    });
    await assert.rejects(
      runtime.Supabase.Auth.signIn('client@example.test', 'wrong'),
      error => {
        assert.equal(error.status, 429);
        assert.equal(error.retryAfterSeconds, 900);
        assert.match(error.message, /15 минут/);
        return true;
      },
      'login UI must receive a distinct server-side lockout error'
    );
  }

  const lockoutMigration = fs.readFileSync(
    path.join(root, 'sql/migrations/2026-07-30_auth_password_lockout.sql'),
    'utf8'
  );
  assert.match(lockoutMigration, /max_failures constant integer := 5/);
  assert.match(lockoutMigration, /lock_duration constant interval := interval '15 minutes'/);
  assert.match(lockoutMigration, /pg_advisory_xact_lock/,
    'parallel password attempts must be serialized per account');
  assert.match(lockoutMigration, /'http_code', 429/);

  assert.match(cloudSource, /async function _fetch\(url, opts = \{\}\)/);
  assert.match(cloudSource, /typeof sb\.authFetch === 'function'/);
  assert.match(cloudSource, /else resumeSync\(\)/, 'visible tab must resume cloud synchronization');
  assert.match(cloudSource, /window\.addEventListener\('pageshow'/);
  assert.match(cloudSource, /!pullCompleted[\s\S]*runPull\(\{ silent: true \}\)/,
    'polling must retry even when the first pull never completed');

  console.log('auth session recovery and cloud resume: OK');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
