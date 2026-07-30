/* ==========================================================================
   Supabase REST + Auth — общий тонкий клиент.
   Используется и админкой, и кабинетом сотрудника.
   Без npm-пакета: чистый fetch().
   ========================================================================== */
(function () {
  'use strict';

  // С 22.05.2026 fallback УБРАН.
  // Раньше при недоступности api.mentori.tech (SNI-блок в РФ) переключались
  // на старый hosted Supabase. Сейчас primary живёт под тем же SNI что
  // лендинг (mentori.tech/sb) — если сайт открывается, API тоже работает.
  // Fallback стал чисто security-дырой: подмена ключа localStorage
  // 'mentori-sb-backend' → запись через anon-открытый старый Supabase
  // в обход новых RLS-политик. Убрали. Старый Supabase оставлен в живых
  // как read-only архив, не используется фронтом.
  const PRIMARY = {
    URL: 'https://mentori.tech/sb',
    KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzc5MzE4NDc3LCJleHAiOjIwOTQ2Nzg0Nzd9.XuMHwfOo8qcycoooOMGwWd3R9_YA55JQZwaJBh132N8',
    name: 'primary',
  };
  // Очистка любых старых ключей-выборов backend на всех клиентах.
  try {
    localStorage.removeItem('mentori-sb-backend');
    localStorage.removeItem('mentori-sb-backend-v2');
  } catch (_) {}
  const CURRENT = PRIMARY;
  // _probePromise оставлен для обратной совместимости (cloud-sync.js, rest()
  // ждут его перед запросами). Резолвится мгновенно — больше нечего пробовать.
  const _probePromise = Promise.resolve(PRIMARY);

  // Геттеры — другие модули (cloud-sync.js и т.п.) могут читать URL/KEY
  // через window.Supabase.URL и window.Supabase.KEY (см. экспорт ниже).
  const SESSION_KEY = 'mentori-supabase-session';
  const REFRESH_LOCK_NAME = 'mentori-supabase-auth-refresh';
  const REFRESH_MIN_VALIDITY_MS = 60 * 1000;

  /* ---- сессия (для Auth) ---- */
  function getSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
    catch { return null; }
  }
  function setSession(s) {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else   localStorage.removeItem(SESSION_KEY);
  }

  function sessionIsFresh(s, minValidityMs = REFRESH_MIN_VALIDITY_MS) {
    if (!s || !s.user || !s.access_token) return false;
    const expiresAt = Number(s.expires_at) * 1000;
    // Старые сохранённые сессии без expires_at считаем пригодными: серверный
    // 401 всё равно запустит refresh и повтор запроса через authFetch().
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) return true;
    return expiresAt - Date.now() > minValidityMs;
  }

  async function withRefreshLock(task) {
    const locks = typeof navigator !== 'undefined' && navigator.locks;
    if (locks && typeof locks.request === 'function') {
      return locks.request(REFRESH_LOCK_NAME, task);
    }
    return task();
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

  /* ---- Авто-refresh access_token ----
     GoTrue выдаёт access_token с exp=1 час. Без авто-обновления:
       login → через час silent 401 на всех push → pending копится →
       пользователь думает «сохраняется», а ничего не сохраняется.
     Решение: перед самым истечением (за 5 мин) дёргаем refresh.
     Lock через Auth._refreshing — см. Auth.refresh() ниже. */
  let _refreshTimer = null;
  function _scheduleRefresh() {
    clearTimeout(_refreshTimer);
    const s = getSession();
    if (!s || !s.expires_at) return;
    // expires_at — unix seconds. Переводим в ms, вычитаем 5 мин.
    const fireAt  = (s.expires_at * 1000) - (5 * 60 * 1000);
    const delayMs = Math.max(0, fireAt - Date.now());
    _refreshTimer = setTimeout(() => {
      if (window.Supabase && window.Supabase.Auth && window.Supabase.Auth.ensureFresh) {
        window.Supabase.Auth.ensureFresh(5 * 60 * 1000).catch(() => {});
      }
    }, delayMs);
  }
  // Запустим планировщик сразу после загрузки скрипта — если сессия
  // уже есть (открыли страницу с валидным токеном).
  _scheduleRefresh();
  // И каждый раз когда вкладка снова становится видимой — пересмотрим
  // (могли спать ноут несколько часов, токен уже истёк).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (window.Supabase && window.Supabase.Auth && window.Supabase.Auth.ensureFresh) {
      window.Supabase.Auth.ensureFresh(5 * 60 * 1000).catch(() => {});
    }
  });

  /** Авторизованный fetch: освежает токен до запроса и один раз повторяет
   *  запрос после 401. Заголовок Authorization всегда строится заново. */
  async function authFetch(url, opts = {}) {
    await _probePromise;
    await Auth.ensureFresh();
    const request = () => fetch(url, {
      ...opts,
      headers: {
        ...(opts.headers || {}),
        'Authorization': authHeader()
      }
    });
    let res = await request();
    if (res.status === 401) {
      const user = await Auth.refresh();
      if (user) res = await request();
    }
    return res;
  }

  /* ---- общий fetch к PostgREST ----
     Ждём пока _probe выберет рабочий backend (обычно мгновенно из кэша,
     иначе до 4с при первом заходе). */
  async function rest(path, opts = {}) {
    const res = await authFetch(`${CURRENT.URL}/rest/v1/${path}`, {
      ...opts,
      headers: {
        'apikey': CURRENT.KEY,
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
    isLogged() {
      const s = getSession();
      return !!(s && s.user && s.refresh_token);
    },

    ensureFresh(minValidityMs = REFRESH_MIN_VALIDITY_MS) {
      const s = getSession();
      if (!s || !s.user || !s.refresh_token) return Promise.resolve(null);
      if (sessionIsFresh(s, minValidityMs)) {
        _scheduleRefresh();
        return Promise.resolve(s.user);
      }
      return this.refresh();
    },

    async signIn(email, password) {
      // Fallback убран, идём прямо на PRIMARY.
      const res = await fetch(`${PRIMARY.URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { 'apikey': PRIMARY.KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      let data;
      try { data = await res.json(); } catch (_) { data = {}; }
      if (!res.ok) {
        const isRateLimited = res.status === 429;
        const retryAfter = Number.parseInt(res.headers && res.headers.get('Retry-After'), 10);
        const error = new Error(
          data.error_description || data.msg || data.message ||
          (isRateLimited
            ? 'Слишком много попыток входа. Повторите через 15 минут.'
            : 'Неверный email или пароль')
        );
        error.status = res.status;
        error.code = data.error_code || data.code || '';
        error.retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter
          : (isRateLimited ? 15 * 60 : 0);
        throw error;
      }
      setSession(data);
      _scheduleRefresh();              // запустить таймер авто-обновления
      return data.user;
    },

    // Single-flight: если уже идёт refresh, отдаём тот же промис.
    // Иначе один refresh-токен может быть использован дважды (две
    // вкладки одновременно) → GoTrue инвалидирует обе сессии.
    refresh() {
      if (Auth._refreshing) return Auth._refreshing;
      const startedSession = getSession();
      const startedRefreshToken = startedSession && startedSession.refresh_token;
      Auth._refreshing = (async () => {
        await _probePromise;
        return withRefreshLock(async () => {
          const s = getSession();
          if (!s || !s.refresh_token) return null;

          // Пока эта вкладка ждала lock, другая уже могла обновить ротационный
          // refresh_token и записать свежую сессию в общий localStorage.
          if (startedRefreshToken && s.refresh_token !== startedRefreshToken && sessionIsFresh(s)) {
            _scheduleRefresh();
            return s.user;
          }

          const usedRefreshToken = s.refresh_token;
          try {
            const res = await fetch(`${CURRENT.URL}/auth/v1/token?grant_type=refresh_token`, {
              method: 'POST',
              headers: { 'apikey': CURRENT.KEY, 'Content-Type': 'application/json' },
              body: JSON.stringify({ refresh_token: usedRefreshToken })
            });
            let data;
            try { data = await res.json(); } catch (_) { data = {}; }
            if (!res.ok) {
              // Fallback для браузеров без Web Locks: параллельная вкладка могла
              // успеть записать новую сессию между нашим запросом и ответом.
              const latest = getSession();
              if (latest && latest.refresh_token !== usedRefreshToken && sessionIsFresh(latest)) {
                _scheduleRefresh();
                return latest.user;
              }
              // Сетевые/серверные ошибки не должны выкидывать пользователя.
              // Чистим сессию только когда сервер явно отверг refresh_token.
              if (res.status === 400 || res.status === 401) {
                setSession(null);
                window.dispatchEvent(new CustomEvent('supabase:auth-expired'));
              }
              return null;
            }
            setSession(data);
            _scheduleRefresh();
            return data.user || null;
          } catch (_) {
            return null;
          }
        });
      })();
      const releaseLocalRefresh = () => {
        // Чистим локальный single-flight после записи новой сессии.
        setTimeout(() => { Auth._refreshing = null; }, 0);
      };
      Auth._refreshing.then(releaseLocalRefresh, releaseLocalRefresh);
      return Auth._refreshing;
    },

    signOut() {
      const s = getSession();
      setSession(null);
      if (s) {
        // scope=global отзывает ВСЕ refresh-токены пользователя на сервере.
        // Без этого refresh_token, который мог быть украден через XSS до signOut,
        // остаётся валидным до своего естественного истечения (~24ч).
        fetch(`${CURRENT.URL}/auth/v1/logout?scope=global`, {
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
    /** Роль выдаётся только сервером через app_metadata. */
    role() {
      const u = this.user();
      if (!u) return null;
      const appMeta  = u.app_metadata  || {};
      const role = appMeta.role;
      if (role === 'owner' || role === 'team' || role === 'client') return role;
      return null;
    }
  };

  // Экспонируем URL/KEY как геттеры — они подменяются автоматически после
  // того как _probe() выберет рабочий backend. cloud-sync.js, bot-stats.js
  // и другие модули используют window.Supabase.URL/KEY и автоматически
  // подхватят правильный backend, не зная о фолбэке ничего.
  window.Supabase = Object.defineProperties({
    rest, authFetch, Tbl, Auth, accessToken,
    // Promise — дождаться выбора backend (полезно если модуль хочет точно
    // знать что URL/KEY уже верные). Например cloud-sync await'ит до push.
    ready: _probePromise,
  }, {
    URL: { get: () => CURRENT.URL, enumerable: true },
    KEY: { get: () => CURRENT.KEY, enumerable: true },
    backend: { get: () => CURRENT.name, enumerable: true },
  });
})();
