/* ==========================================================================
   Sidebar — боковое меню
   Рендерится в любой элемент с data-component="sidebar".
   Активный пункт определяется по атрибуту data-active у контейнера
   или по имени страницы в URL.
   ========================================================================== */
(function () {
  'use strict';

  const NAV = [
    { id: 'dashboard',     label: 'Дашборд',    href: 'dashboard.html',     icon: icoGrid() },
    { id: 'finance',       label: 'Финансы',    href: 'finance.html',       icon: icoWallet() },
    { id: 'clients',       label: 'Клиенты',    href: 'clients.html',       icon: icoClient() },
    { id: 'subscriptions', label: 'Подписки',   href: 'subscriptions.html', icon: icoSub() },
    { id: 'employees',     label: 'Сотрудники', href: 'employees.html',     icon: icoUsers() },
    { id: 'reviews',       label: 'Отзывы',     href: 'reviews.html',       icon: icoReviews() },
    { id: 'statuses',      label: 'Аккаунты',   href: 'statuses.html',      icon: icoProfiles() },
    { id: 'links',         label: 'Связи',      href: 'links.html',         icon: icoLinks() },
    { id: 'ips',           label: 'IP-адреса',  href: 'ips.html',           icon: icoIps() },
    { id: 'phones',        label: 'Номера',     href: 'phones.html',        icon: icoPhones() }
  ];

  function resolveHref(baseHref) {
    // Если страница лежит в /pages/, ссылки относительно текущей директории.
    // Если это index.html в корне — нужен префикс pages/.
    const path = location.pathname.toLowerCase();
    if (path.endsWith('/') || path.endsWith('index.html')) return 'pages/' + baseHref;
    return baseHref;
  }

  function render(el) {
    const active = (el.dataset.active || detectActive()).toLowerCase();
    el.innerHTML = `
      <aside class="sidebar" id="sidebar">
        <div class="sidebar__brand">
          <div class="sidebar__logo">M</div>
          <span>Mentori</span>
        </div>
        <nav class="sidebar__nav">
          ${NAV.map(n => `
            <a href="${resolveHref(n.href)}" class="nav-item ${n.id === active ? 'active' : ''}">
              ${n.icon}
              <span>${n.label}</span>
            </a>
          `).join('')}
        </nav>
        <div class="sidebar__footer">
          © ${new Date().getFullYear()} Mentori CRM
        </div>
      </aside>
      <div class="backdrop-sidebar" id="sidebarBackdrop"></div>
    `;

    // Мобильный тоггл — закрытие по бэкдропу
    const backdrop = document.getElementById('sidebarBackdrop');
    backdrop.addEventListener('click', () => {
      document.getElementById('sidebar').classList.remove('open');
      backdrop.classList.remove('open');
    });
  }

  function detectActive() {
    const f = location.pathname.split('/').pop().replace('.html','');
    return f || 'dashboard';
  }

  /* --- icons ------------------------------------------------------- */
  function icoGrid() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`;
  }
  function icoWallet() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12V8a2 2 0 0 0-2-2H5a2 2 0 0 1 0-4h14v4"/><rect x="2" y="6" width="20" height="14" rx="2"/><circle cx="17" cy="13" r="1.2" fill="currentColor"/></svg>`;
  }
  function icoUsers() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
  }
  function icoClient() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
  }
  function icoSub() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/></svg>`;
  }
  function icoReviews() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
  }
  function icoProfiles() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18"/><circle cx="8" cy="15" r="1.5" fill="currentColor"/><line x1="12" y1="15" x2="18" y2="15"/></svg>`;
  }
  function icoLinks() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07l1.5-1.5"/></svg>`;
  }
  function icoIps() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z"/></svg>`;
  }
  function icoPhones() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.91.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;
  }

  window.Sidebar = {
    mount() {
      document.querySelectorAll('[data-component="sidebar"]').forEach(render);
    }
  };

  document.addEventListener('DOMContentLoaded', () => window.Sidebar.mount());
})();
