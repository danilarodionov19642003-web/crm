/* ==========================================================================
   Auth Gate — защита админских страниц (главной CRM).
   --------------------------------------------------------------------------
   Запускается ДО рендера: если нет сессии — редирект на login;
   если роль 'team' — открыты только страницы из TEAM_ALLOW (Аккаунты, IP),
   остальные редиректят на /pages/statuses.html.

   Проставляет document.body.dataset.role и .dataset.userEmail/.userName,
   чтобы header/sidebar/страницы могли подтянуть пункты меню по роли.

   Подключать в <head> ПОСЛЕ supabase-client.js, ДО других скриптов.
   На страницах /pages/employee/* НЕ подключать — там своя логика.
   ========================================================================== */
(function () {
  'use strict';

  if (!window.Supabase) {
    console.error('[auth-gate] supabase-client.js должен подключаться раньше');
    return;
  }
  const { Auth } = window.Supabase;

  // Страницы, разрешённые роли 'team' (Настя). Только базовое имя файла.
  const TEAM_ALLOW = new Set([
    'statuses.html',  // «Аккаунты» (карточки 2-1, 3-2 и т.д.)
    'ips.html',       // «IP» (+ кнопка смены IP по прокси)
    'reviews.html',   // её собственные сданные отзывы (видит свои + статус)
    'tasks.html',     // «Задачи» — лист дел на сегодня от владельца
  ]);

  // На какую страницу редиректить team-роль из запрещённых.
  const TEAM_HOME = '/pages/statuses.html';
  const LOGIN_URL = '/pages/employee/login.html';

  function isAdminPage() {
    const p = location.pathname;
    if (p.includes('/employee/')) return false; // у них своя auth
    if (p.includes('/client/'))   return false; // личный кабинет клиента — отдельный auth
    return p.endsWith('.html') || p.endsWith('/') || p === '';
  }

  // Учтём подкаталог GitHub Pages (если репо в /mentori-crm/, fall back ok)
  function resolveLogin() {
    // login.html лежит в /pages/employee/, нужно вычислить относительно текущей.
    if (location.pathname.includes('/pages/')) return '../pages/employee/login.html'.replace('../','./');
    return './pages/employee/login.html';
  }

  async function gate() {
    if (!isAdminPage()) return;

    if (!Auth.isLogged()) {
      // попытаемся обновить refresh-токен
      try { await Auth.refresh(); } catch (_) {}
    }

    if (!Auth.isLogged()) {
      // запоминаем куда хотели зайти, чтобы вернуть после входа
      try { sessionStorage.setItem('mentori-after-login', location.pathname + location.search); } catch (_) {}
      // относительный путь к login: всегда абсолютный безопаснее
      const repo = location.pathname.split('/').slice(0, location.pathname.includes('/pages/') ? -2 : -1).join('/');
      location.replace((repo || '') + LOGIN_URL);
      return;
    }

    const role = Auth.role();
    document.documentElement.dataset.role = role;
    document.documentElement.dataset.userEmail = (Auth.email() || '').toLowerCase();
    document.documentElement.dataset.userName = Auth.name() || '';
    // Дублируем в body когда DOM доступен — чтобы CSS-селекторы работали стабильно.
    function syncBody() {
      if (!document.body) return;
      document.body.dataset.role = role;
      document.body.dataset.userEmail = document.documentElement.dataset.userEmail;
      document.body.dataset.userName = document.documentElement.dataset.userName;
    }
    if (document.body) syncBody();
    else document.addEventListener('DOMContentLoaded', syncBody, { once: true });

    // Клиент попал в админку (например, ввёл URL вручную) — выкидываем
    // в его личный кабинет. Сами данные он всё равно прочитать не сможет
    // (на crm_state RLS запрещает любой authenticated-доступ), но
    // визуально не должен видеть админский интерфейс.
    if (role === 'client') {
      const repo = location.pathname.split('/').slice(0, location.pathname.includes('/pages/') ? -2 : -1).join('/');
      location.replace((repo || '') + '/pages/client/index.html');
      return;
    }

    // Гард для team-роли: запрещённые страницы → редирект.
    if (role === 'team') {
      const file = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
      const onIndex = file === '' || file === 'index.html';
      if (onIndex) {
        const repo = location.pathname.split('/').slice(0, -1).join('/');
        location.replace((repo || '') + TEAM_HOME);
        return;
      }
      if (!TEAM_ALLOW.has(file)) {
        const repo = location.pathname.split('/').slice(0, -1).join('/');
        location.replace((repo || '') + '/statuses.html');
        return;
      }
    }
  }

  // Запускаем сразу синхронно (top-level await не везде ок) — без блокировки рендера.
  gate();

  // Публичные хелперы для страниц.
  window.AuthGate = {
    role: () => Auth.role(),
    email: () => Auth.email(),
    name: () => Auth.name(),
    isOwner:  () => Auth.role() === 'owner',
    isTeam:   () => Auth.role() === 'team',
    isClient: () => Auth.role() === 'client',
    signOut() {
      Auth.signOut();
      const repo = location.pathname.split('/').slice(0, location.pathname.includes('/pages/') ? -2 : -1).join('/');
      location.replace((repo || '') + LOGIN_URL);
    }
  };
})();
