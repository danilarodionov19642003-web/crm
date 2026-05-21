/* ==========================================================================
   Header — верхняя панель с поиском и профилем.
   Монтируется в любой элемент с data-component="header".
   Принимает атрибуты:
     data-title    — заголовок страницы
     data-subtitle — опциональный подзаголовок (не используется визуально здесь)
   ========================================================================== */
(function () {
  'use strict';

  function render(el) {
    const title = el.dataset.title || 'Mentori CRM';
    const role = (document.documentElement.dataset.role || (document.body && document.body.dataset.role) || 'owner').toLowerCase();
    const userName = document.documentElement.dataset.userName
                  || (document.body && document.body.dataset.userName) || '';
    const userEmail = document.documentElement.dataset.userEmail
                  || (document.body && document.body.dataset.userEmail) || '';
    const initial = (userName || userEmail || 'M').trim().charAt(0).toUpperCase();
    const avatarTitle = userName
      ? `${userName} (${role === 'owner' ? 'владелец' : 'сотрудник'})`
      : (role === 'owner' ? 'Владелец' : 'Профиль');
    el.innerHTML = `
      <header class="header">
        <button class="menu-toggle btn--icon" id="menuToggle" aria-label="Меню">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        </button>
        <div class="header__title">${title}</div>
        <div class="header__search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" id="globalSearch" placeholder="Поиск по CRM..." autocomplete="off"/>
        </div>
        <div class="header__actions">
          <div id="cloudStatus" class="cloud-status" data-state="idle" title="Статус облачной синхронизации">
            <span class="cloud-status__dot"></span>
            <span class="cloud-status__text">…</span>
          </div>
          ${role === 'owner' ? `
          <button class="btn--icon" id="btnBackup" title="Скачать бэкап JSON">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>` : ''}
          <button class="btn--icon" id="btnLogout" title="${userName ? 'Выйти (' + userName + ')' : 'Выйти'}">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          </button>
          <div class="avatar" title="${avatarTitle}">${initial}</div>
        </div>
      </header>
    `;

    // Мобильный тоггл сидбара
    const toggle = document.getElementById('menuToggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        const sb = document.getElementById('sidebar');
        const bd = document.getElementById('sidebarBackdrop');
        if (sb) sb.classList.toggle('open');
        if (bd) bd.classList.toggle('open');
      });
    }

    // (раньше тут была кнопка «принудительный ресинк» — убрана как лишняя:
    //  cloud-sync уже делает pull при каждой загрузке страницы. Если когда-то
    //  очень понадобится сброс кеша — открой URL с ?resync=1, см. cloud-sync.js?v=20260521a.)

    // Ручной бэкап (только у owner-а — кнопка в шаблоне рендерится тоже только ему).
    const btnBackup = document.getElementById('btnBackup');
    if (btnBackup) {
      btnBackup.addEventListener('click', async () => {
        if (!window.CloudSync || !window.CloudSync.downloadBackup) {
          alert('Облачная синхронизация ещё не загрузилась — попробуй через секунду.');
          return;
        }
        btnBackup.disabled = true;
        try { await window.CloudSync.downloadBackup(); }
        finally { btnBackup.disabled = false; }
      });
    }

    // Выход из аккаунта
    const btnLogout = document.getElementById('btnLogout');
    if (btnLogout) {
      btnLogout.addEventListener('click', () => {
        if (!window.confirm('Выйти из аккаунта?')) return;
        if (window.AuthGate && window.AuthGate.signOut) {
          window.AuthGate.signOut();
        } else if (window.Supabase && window.Supabase.Auth) {
          window.Supabase.Auth.signOut();
          // Корень = всё, что до /pages/ (или текущая директория).
          // Раньше slice(-2) ломалось на /pages/client/* → 404.
          const path = location.pathname;
          const idx = path.indexOf('/pages/');
          const root = idx >= 0 ? path.substring(0, idx + 1) : path.substring(0, path.lastIndexOf('/') + 1);
          location.replace(root);
        }
      });
    }

    // Поиск: вызывает колбэк, если он зарегистрирован на странице
    const search = document.getElementById('globalSearch');
    if (search) {
      search.addEventListener('input', (e) => {
        if (typeof window.onGlobalSearch === 'function') {
          window.onGlobalSearch(e.target.value.trim().toLowerCase());
        }
      });
    }
  }

  window.Header = {
    mount() {
      document.querySelectorAll('[data-component="header"]').forEach(render);
    }
  };

  document.addEventListener('DOMContentLoaded', () => window.Header.mount());
})();
