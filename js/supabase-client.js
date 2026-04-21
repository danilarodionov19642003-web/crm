/* ==========================================================================
   Supabase REST + Auth — общий тонкий клиент.
   Используется и админкой, и кабинетом сотрудника.
   Без npm-пакета: чистый fetch().
   ========================================================================== */
(function () {
  'use strict';

  const URL = 'https://ivzouyhyuyfzoodhyrya.supabase.co';
  const KEY = 'sb_publishable_QpxNagNre_4iKQrVO5Swzw_XWhmrQo4';
  const SESSION_KEY = 'mentori-supabase-session';

  /* ---- сессия (для Auth) ---- */
  function getSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
    catch { return null; }
  }
  function setSession(s) {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else   localStorage.removeItem(SESSION_KEY);
  }

  function authHeader() {
    // Личную сессию используем ТОЛЬКО в кабинете сотрудника
    // (страницы /pages/employee/*). Админка всегда ходит анонимно
    // под публичным ключом — иначе протухший JWT сотрудника на том же
    // устройстве ломает все REST-запросы админки (PGRST303 JWT expired).
    const isEmployeeArea = location.pathname.includes('/employee/');
    if (!isEmployeeArea) return `Bearer ${KEY}`;
    const s = getSession();
    return s && s.access_token ? `Bearer ${s.access_token}` : `Bearer ${KEY}`;
  }

  /* ---- общий fetch к PostgREST ---- */
  async function rest(path, opts = {}) {
    const res = await fetch(`${URL}/rest/v1/${path}`, {
      ...opts,
      headers: {
        'apikey': KEY,
        'Authorization': authHeader(),
        'Content-Type': 'application/json',
        'Prefer': opts.prefer || 'return=representation',
        ...(opts.headers || {})
      }
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`REST ${res.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  }

  /* ---- удобные шорткаты ---- */
  const Tbl = {
    select(table, query = '') {
      return rest(`${table}?${query}`);
    },
    insert(table, row) {
      return rest(table, { method: 'POST', body: JSON.stringify(row) });
    },
    upsert(table, rows, onConflict = 'id') {
      const body = JSON.stringify(Array.isArray(rows) ? rows : [rows]);
      return rest(`${table}?on_conflict=${onConflict}`, {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=representation',
        body
      });
    },
    update(table, query, patch) {
      return rest(`${table}?${query}`, {
        method: 'PATCH',
        body: JSON.stringify(patch)
      });
    },
    remove(table, query) {
      return rest(`${table}?${query}`, { method: 'DELETE' });
    }
  };

  /* ---- Auth ---- */
  const Auth = {
    user() {
      const s = getSession();
      return s ? s.user : null;
    },
    isLogged() { return !!this.user(); },

    async signIn(email, password) {
      const res = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { 'apikey': KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error_description || data.msg || 'Ошибка входа');
      setSession(data);
      return data.user;
    },

    async refresh() {
      const s = getSession();
      if (!s || !s.refresh_token) return null;
      const res = await fetch(`${URL}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { 'apikey': KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: s.refresh_token })
      });
      const data = await res.json();
      if (!res.ok) { setSession(null); return null; }
      setSession(data);
      return data.user;
    },

    signOut() {
      setSession(null);
      // best-effort revoke
      const s = getSession();
      if (s) {
        fetch(`${URL}/auth/v1/logout`, {
          method: 'POST',
          headers: { 'apikey': KEY, 'Authorization': `Bearer ${s.access_token}` }
        }).catch(() => {});
      }
    },

    /** редирект на login, если сессии нет */
    requireLogin(loginUrl = './login.html') {
      if (!this.isLogged()) location.replace(loginUrl);
    },

    email() { const u = this.user(); return u ? u.email : null; },
    rate()  { const u = this.user(); return u && u.user_metadata ? Number(u.user_metadata.rate) || 0 : 0; },
    name()  { const u = this.user(); return u && u.user_metadata && u.user_metadata.name || (u ? u.email : ''); },
    /**
     * Роль определяется по email-маппингу в state.crmRoles либо по
     * user_metadata.role. По умолчанию — 'team' (без полных прав).
     * Чтобы быть owner-ом, email должен быть либо в OWNER_EMAILS,
     * либо в user_metadata.role === 'owner'.
     */
    role() {
      const u = this.user();
      if (!u) return null;
      const meta = u.user_metadata || {};
      if (meta.role === 'owner' || meta.role === 'team') return meta.role;
      const email = (u.email || '').toLowerCase();
      const OWNER_EMAILS = ['danila.rodionov19642003@gmail.com'];
      return OWNER_EMAILS.includes(email) ? 'owner' : 'team';
    }
  };

  window.Supabase = { URL, KEY, rest, Tbl, Auth };
})();
