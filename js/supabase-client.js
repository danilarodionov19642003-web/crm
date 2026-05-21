/* ==========================================================================
   Supabase REST + Auth — общий тонкий клиент.
   Используется и админкой, и кабинетом сотрудника.
   Без npm-пакета: чистый fetch().
   ========================================================================== */
(function () {
  'use strict';

  // Авто-фолбэк: на старте пингуем PRIMARY (наш Yandex VPS).
  // Если за 4с не отвечает — переключаемся на FALLBACK (старый Supabase).
  // Выбор кэшируется в localStorage на 5 минут чтобы не пинговать каждый
  // переход страницы.
  //
  // ВАЖНО: PRIMARY теперь живёт под тем же доменом что и лендинг —
  // https://mentori.tech/sb/*. Раньше был api.mentori.tech, но РФ-операторы
  // блокируют его по SNI (сайт mentori.tech работает, а отдельный поддомен
  // api — нет). Один SNI решает: если открывается сайт, открывается и API.
  // FALLBACK остаётся на старый hosted Supabase для случаев когда у нас лежит
  // вся инфраструктура VPS.
  const PRIMARY = {
    URL: 'https://mentori.tech/sb',
    KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzc5MzE4NDc3LCJleHAiOjIwOTQ2Nzg0Nzd9.XuMHwfOo8qcycoooOMGwWd3R9_YA55JQZwaJBh132N8',
    name: 'primary',
  };
  const FALLBACK = {
    URL: 'https://ivzouyhyuyfzoodhyrya.supabase.co',
    KEY: 'sb_publishable_QpxNagNre_4iKQrVO5Swzw_XWhmrQo4',
    name: 'fallback',
  };
  // v2 — после переезда primary с api.mentori.tech на mentori.tech/sb.
  // Меняем имя ключа чтобы у пользователей со старым залипшим выбором
  // ('fallback' из-за нерабочего api.mentori.tech) запустился свежий probe
  // и они автоматически подцепили рабочий primary без VPN.
  const BACKEND_CACHE_KEY = 'mentori-sb-backend-v2'; // {name, until: epoch_ms}
  const BACKEND_CACHE_TTL = 5 * 60 * 1000;           // 5 минут
  // одноразовая чистка старого ключа, не критично, но порядок
  try { localStorage.removeItem('mentori-sb-backend'); } catch (_) {}

  function _cachedBackend() {
    try {
      const raw = localStorage.getItem(BACKEND_CACHE_KEY);
      if (!raw) return null;
      const j = JSON.parse(raw);
      if (j && j.until && j.until > Date.now()) {
        return j.name === 'fallback' ? FALLBACK : PRIMARY;
      }
    } catch (_) {}
    return null;
  }
  function _saveBackend(b) {
    try { localStorage.setItem(BACKEND_CACHE_KEY,
      JSON.stringify({ name: b.name, until: Date.now() + BACKEND_CACHE_TTL })); }
    catch (_) {}
  }
  // По умолчанию используем primary; если в кэше есть валидный fallback —
  // он. Используется до того как _probe() завершится (синхронно).
  let CURRENT = _cachedBackend() || PRIMARY;

  // Дёргаем primary; если ОК — закрепляем primary, иначе пробуем fallback.
  // Выполняется один раз на загрузку страницы.
  async function _probe() {
    if (_cachedBackend()) return CURRENT;   // уже выбран, не дёргаем сеть
    const tryUrl = async (be, timeoutMs) => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        const r = await fetch(be.URL + '/auth/v1/settings', {
          method: 'GET', signal: ctrl.signal, cache: 'no-store'
        });
        clearTimeout(t);
        return r.ok;
      } catch (_) { return false; }
    };
    if (await tryUrl(PRIMARY, 4000)) {
      CURRENT = PRIMARY; _saveBackend(PRIMARY); return PRIMARY;
    }
    console.warn('[supabase-client] primary недоступен, переключаю на fallback');
    CURRENT = FALLBACK; _saveBackend(FALLBACK); return FALLBACK;
  }
  // Запускаем зондирование сразу; промис ждут Auth.signIn и rest().
  const _probePromise = _probe();

  // Геттеры — другие модули (cloud-sync.js и т.п.) могут читать URL/KEY
  // через window.Supabase.URL и window.Supabase.KEY (см. экспорт ниже).
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
    // С 22.05.2026: ВСЕГДА предпочитаем access_token пользователя из сессии,
    // независимо от пути. Раньше для админских страниц возвращался ANON,
    // что давало кому угодно (без логина) делать запросы — RLS-политики
    // для anon разрешали всё. Теперь RLS требует authenticated с проверкой
    // app_metadata.role IN ('owner','team'). Если сессии нет — отдаём ANON
    // (нужно для самого момента логина и публичных endpoint'ов).
    const s = getSession();
    return s && s.access_token ? `Bearer ${s.access_token}` : `Bearer ${CURRENT.KEY}`;
  }

  /** Текущий access_token, если есть валидная сессия. Иначе null. */
  function accessToken() {
    const s = getSession();
    return s && s.access_token ? s.access_token : null;
  }

  /* ---- общий fetch к PostgREST ----
     Ждём пока _probe выберет рабочий backend (обычно мгновенно из кэша,
     иначе до 4с при первом заходе). */
  async function rest(path, opts = {}) {
    await _probePromise;
    const res = await fetch(`${CURRENT.URL}/rest/v1/${path}`, {
      ...opts,
      headers: {
        'apikey': CURRENT.KEY,
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
      await _probePromise;
      // Сначала пробуем CURRENT (primary или кэш). Если TypeError /
      // network — пробуем другой backend и закрепляем его.
      const order = CURRENT === PRIMARY ? [PRIMARY, FALLBACK] : [FALLBACK, PRIMARY];
      let lastErr = null;
      for (const be of order) {
        try {
          const res = await fetch(`${be.URL}/auth/v1/token?grant_type=password`, {
            method: 'POST',
            headers: { 'apikey': be.KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
          });
          const data = await res.json();
          if (!res.ok) {
            // Auth-ошибка (400 invalid grant и т.п.) — пользовательская,
            // ретрай через fallback не поможет.
            throw new Error(data.error_description || data.msg || 'Ошибка входа');
          }
          CURRENT = be; _saveBackend(be);
          setSession(data);
          return data.user;
        } catch (e) {
          // TypeError → "Failed to fetch" / "Load failed" — попробуем другой
          // backend. Любая другая ошибка (от сервера) — пробрасываем.
          if (e instanceof TypeError) { lastErr = e; continue; }
          throw e;
        }
      }
      throw lastErr || new Error('Не удалось связаться с сервером');
    },

    async refresh() {
      await _probePromise;
      const s = getSession();
      if (!s || !s.refresh_token) return null;
      try {
        const res = await fetch(`${CURRENT.URL}/auth/v1/token?grant_type=refresh_token`, {
          method: 'POST',
          headers: { 'apikey': CURRENT.KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: s.refresh_token })
        });
        const data = await res.json();
        if (!res.ok) { setSession(null); return null; }
        setSession(data);
        return data.user;
      } catch (_) { return null; }
    },

    signOut() {
      const s = getSession();
      setSession(null);
      if (s) {
        fetch(`${CURRENT.URL}/auth/v1/logout`, {
          method: 'POST',
          headers: { 'apikey': CURRENT.KEY, 'Authorization': `Bearer ${s.access_token}` }
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
      if (meta.role === 'owner' || meta.role === 'team' || meta.role === 'client') return meta.role;
      const email = (u.email || '').toLowerCase();
      const OWNER_EMAILS = ['danila.rodionov19642003@gmail.com'];
      return OWNER_EMAILS.includes(email) ? 'owner' : 'team';
    }
  };

  // Экспонируем URL/KEY как геттеры — они подменяются автоматически после
  // того как _probe() выберет рабочий backend. cloud-sync.js, bot-stats.js
  // и другие модули используют window.Supabase.URL/KEY и автоматически
  // подхватят правильный backend, не зная о фолбэке ничего.
  window.Supabase = Object.defineProperties({
    rest, Tbl, Auth, accessToken,
    // Promise — дождаться выбора backend (полезно если модуль хочет точно
    // знать что URL/KEY уже верные). Например cloud-sync await'ит до push.
    ready: _probePromise,
  }, {
    URL: { get: () => CURRENT.URL, enumerable: true },
    KEY: { get: () => CURRENT.KEY, enumerable: true },
    backend: { get: () => CURRENT.name, enumerable: true },
  });
})();
