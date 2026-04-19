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
          <button class="btn--icon" title="Уведомления">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
          </button>
          <div class="avatar" title="Владелец">M</div>
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
