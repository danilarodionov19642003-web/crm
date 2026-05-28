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
    const delayMs = Math.max(5_000, fireAt - Date.now());   // не раньше чем через 5с
    _refreshTimer = setTimeout(() => {
      if (window.Supabase && window.Supabase.Auth && window.Supabase.Auth.refresh) {
        window.Supabase.Auth.refresh().catch(() => {});
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
    const s = getSession();
    if (!s || !s.expires_at) return;
    // Если меньше 60 сек осталось — refresh сразу, не ждём таймер.
    if (s.expires_at * 1000 - Date.now() < 60_000) {
      if (window.Supabase && window.Supabase.Auth) window.Supabase.Auth.refresh().catch(() => {});
    } else {
      _scheduleRefresh();
    }
  });

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
      // Fallback убран, идём прямо на PRIMARY.
      const res = await fetch(`${PRIMARY.URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { 'apikey': PRIMARY.KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      let data;
      try { data = await res.json(); } catch (_) { data = {}; }
      if (!res.ok) {
        throw new Error(data.error_description || data.msg || 'Ошибка входа');
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
      Auth._refreshing = (async () => {
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
          _scheduleRefresh();   // переставить таймер под новый expires_at
          return data.user;
        } catch (_) { return null; }
        finally {
          // Чистим lock ПОСЛЕ записи новой сессии, чтобы следующие
          // параллельные вызовы получили свежий access_token.
          setTimeout(() => { Auth._refreshing = null; }, 0);
        }
      })();
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
    /**
     * Роль определяется в порядке:
     *   1. user_metadata.role  (предпочтительно, ставится при создании)
     *   2. app_metadata.role   (зеркало в JWT — иногда заполняется без user_metadata)
     *   3. email в OWNER_EMAILS → 'owner'
     *   4. fallback 'team'
     * Раньше (до 25.05.2026) смотрели только user_metadata.role и при
     * его отсутствии валились в 'team' — клиенты видели admin-интерфейс.
     */
    role() {
      const u = this.user();
      if (!u) return null;
      const userMeta = u.user_metadata || {};
      const appMeta  = u.app_metadata  || {};
      const role = userMeta.role || appMeta.role;
      if (role === 'owner' || role === 'team' || role === 'client') return role;
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
