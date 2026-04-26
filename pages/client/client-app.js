/* ==========================================================================
   Client portal — runtime: auth-guard + загрузка персонального снимка
   из таблицы client_snapshots (RLS гарантирует, что клиент видит ТОЛЬКО
   свою строку).
   --------------------------------------------------------------------------
   Использование на странице:
     await ClientApp.requireLogin();    // редиректит на login.html если нет сессии
     const snap = await ClientApp.loadSnapshot();
     ClientApp.renderHeader(snap);
   ========================================================================== */
(function () {
  'use strict';

  if (!window.Supabase) {
    console.error('[client-app] supabase-client.js должен подключаться раньше');
    return;
  }
  const { Auth, URL: SUPA_URL, KEY, accessToken } = window.Supabase;

  const SNAPSHOTS_TABLE = 'client_snapshots';

  function fmtDate(iso) {
    if (!iso) return '';
    const s = String(iso).slice(0, 10);
    const [y, m, d] = s.split('-');
    if (!y || !m || !d) return s;
    return `${d}.${m}.${y}`;
  }
  function fmtMoney(v) {
    if (v == null || isNaN(v)) return '0 ₽';
    return Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ₽';
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }
  function progressPct(done, ordered) {
    const o = Number(ordered) || 0;
    const d = Number(done) || 0;
    if (o <= 0) return 0;
    return Math.min(100, Math.round((d / o) * 100));
  }

  async function requireLogin() {
    if (!Auth.isLogged()) {
      try { await Auth.refresh(); } catch (_) {}
    }
    if (!Auth.isLogged()) {
      try { sessionStorage.setItem('mentori-cli-after-login', location.pathname + location.search); } catch (_) {}
      location.replace('./login.html');
      return false;
    }
    // На всякий случай: если в Supabase эта учётка не client — в админку всё равно
    // не пустит RLS, но и тут не дадим открыть портал (вероятно ошибка настройки).
    const role = Auth.role();
    if (role !== 'client') {
      // Редиректим в обычный логин админки — там разберётся auth-gate
      try { Auth.signOut(); } catch (_) {}
      alert('Этот аккаунт не помечен как клиент. Обратись к администратору.');
      location.replace('./login.html');
      return false;
    }
    return true;
  }

  /** Загружает персональный снимок клиента. Возвращает payload или null. */
  async function loadSnapshot() {
    const token = accessToken();
    if (!token) return null;
    const email = (Auth.email() || '').toLowerCase();
    if (!email) return null;
    // Ходим под JWT: RLS на client_snapshots отдаст только строку,
    // где email = auth.jwt() ->> 'email'. Указываем фильтр для надёжности.
    const url = `${SUPA_URL}/rest/v1/${SNAPSHOTS_TABLE}?email=eq.${encodeURIComponent(email)}&select=payload,updated_at`;
    const res = await fetch(url, {
      headers: {
        'apikey': KEY,
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      }
    });
    if (!res.ok) {
      console.warn('[client-app] snapshot load failed', res.status, await res.text().catch(() => ''));
      return null;
    }
    const rows = await res.json();
    if (!rows || !rows.length) return null;
    return { payload: rows[0].payload, updatedAt: rows[0].updated_at };
  }

  function renderHeader(snap) {
    const el = document.querySelector('[data-cli-header]');
    if (!el) return;
    const name = (snap && snap.payload && snap.payload.name) || (Auth.name() || Auth.email() || '');
    const initial = (name || 'M').trim().charAt(0).toUpperCase();
    el.innerHTML = `
      <header class="cli-header">
        <div class="cli-header__brand">
          <div class="cli-header__logo">${escapeHtml(initial)}</div>
          <div>
            <div class="cli-header__hello">${escapeHtml(name)}</div>
            <div class="cli-header__sub">Личный кабинет · ${escapeHtml(Auth.email() || '')}</div>
          </div>
        </div>
        <button class="cli-header__logout" id="cliLogout">Выйти</button>
      </header>
    `;
    document.getElementById('cliLogout').addEventListener('click', () => {
      if (!confirm('Выйти из кабинета?')) return;
      try { Auth.signOut(); } catch (_) {}
      location.replace('./login.html');
    });
  }

  function renderTotals(totals) {
    const el = document.querySelector('[data-cli-totals]');
    if (!el || !totals) return;
    el.innerHTML = `
      <div class="cli-kpi">
        <div class="cli-kpi__label">Заказано</div>
        <div class="cli-kpi__value">${totals.ordered || 0}</div>
      </div>
      <div class="cli-kpi">
        <div class="cli-kpi__label">Сделано</div>
        <div class="cli-kpi__value pos">${totals.done || 0}</div>
      </div>
      <div class="cli-kpi">
        <div class="cli-kpi__label">Остаток</div>
        <div class="cli-kpi__value ${(totals.remain||0) > 0 ? 'neg' : ''}">${fmtMoney(totals.remain || 0)}</div>
      </div>
    `;
  }

  function renderAnketas(anketas) {
    const el = document.querySelector('[data-cli-anketas]');
    if (!el) return;
    if (!anketas || !anketas.length) {
      el.innerHTML = '<div class="cli-empty">У вас пока нет анкет в работе. Свяжитесь с менеджером.</div>';
      return;
    }
    el.innerHTML = anketas.map(a => {
      const pct = progressPct(a.done, a.ordered);
      return `
        <a class="cli-card" href="./profile.html?id=${encodeURIComponent(a.mentorId)}">
          <div class="cli-card__top">
            <span class="cli-card__code">${escapeHtml(a.code)}</span>
            <span class="cli-card__name">${escapeHtml(a.name || a.code)}</span>
          </div>
          <div class="cli-card__stats">
            <div class="cli-card__stat">
              <div class="cli-card__stat-label">Заказано</div>
              <div class="cli-card__stat-value">${a.ordered || 0}</div>
            </div>
            <div class="cli-card__stat">
              <div class="cli-card__stat-label">Сделано</div>
              <div class="cli-card__stat-value">${a.done || 0}</div>
            </div>
            <div class="cli-card__stat">
              <div class="cli-card__stat-label">Остаток</div>
              <div class="cli-card__stat-value">${fmtMoney(a.remain || 0)}</div>
            </div>
          </div>
          <div class="cli-progress"><div class="cli-progress__fill" style="width:${pct}%"></div></div>
        </a>
      `;
    }).join('');
  }

  function renderFeed(feed) {
    const el = document.querySelector('[data-cli-feed]');
    if (!el) return;
    if (!feed || !feed.length) {
      el.innerHTML = '<div class="cli-empty">Активности пока нет.</div>';
      return;
    }
    el.innerHTML = feed.slice(0, 30).map(f => `
      <div class="cli-feed__item">
        <div class="cli-feed__icon ${f.kind === 'review' ? 'review' : ''}">${f.kind === 'review' ? '✍️' : '📋'}</div>
        <div class="cli-feed__text">
          <div><strong>${escapeHtml(f.anketa || '')}</strong> · ${escapeHtml(f.text || '')}</div>
          <div class="cli-feed__date">${fmtDate(f.date)}</div>
        </div>
      </div>
    `).join('');
  }

  /* --- Profile detail rendering --- */
  function renderProfileDetail(payload, mentorId) {
    const a = (payload.anketas || []).find(x => x.mentorId === mentorId);
    const root = document.querySelector('[data-cli-profile]');
    if (!root) return;
    if (!a) {
      root.innerHTML = '<div class="cli-empty">Анкета не найдена. Возможно, доступ к ней был отозван.</div>';
      return;
    }
    const pct = progressPct(a.done, a.ordered);
    const totalsHtml = `
      <div class="cli-kpis" style="margin-bottom:16px">
        <div class="cli-kpi">
          <div class="cli-kpi__label">Заказано</div>
          <div class="cli-kpi__value">${a.ordered || 0}</div>
        </div>
        <div class="cli-kpi">
          <div class="cli-kpi__label">Сделано</div>
          <div class="cli-kpi__value pos">${a.done || 0}</div>
        </div>
        <div class="cli-kpi">
          <div class="cli-kpi__label">Прогресс</div>
          <div class="cli-kpi__value">${pct}%</div>
        </div>
      </div>
      <div class="cli-progress" style="margin-bottom:18px"><div class="cli-progress__fill" style="width:${pct}%"></div></div>
    `;
    const moneyHtml = `
      <div class="cli-kpis" style="margin-bottom:16px">
        <div class="cli-kpi">
          <div class="cli-kpi__label">Итого</div>
          <div class="cli-kpi__value">${fmtMoney(a.total || 0)}</div>
        </div>
        <div class="cli-kpi">
          <div class="cli-kpi__label">Оплачено</div>
          <div class="cli-kpi__value pos">${fmtMoney(a.paid || 0)}</div>
        </div>
        <div class="cli-kpi">
          <div class="cli-kpi__label">Остаток</div>
          <div class="cli-kpi__value ${(a.remain||0)>0?'neg':''}">${fmtMoney(a.remain || 0)}</div>
        </div>
      </div>
    `;
    const statusesHtml = a.statuses && a.statuses.length ? `
      <h3 class="cli-section-title">Аккаунты в работе</h3>
      <table class="cli-table">
        <thead><tr><th>Аккаунт</th><th>Статус</th><th>Обновлён</th></tr></thead>
        <tbody>${a.statuses.map(s => `
          <tr>
            <td><strong>${escapeHtml(s.profileCode || '—')}</strong>${s.archived ? ' <span style="color:#cf1322;font-size:11px">(архив)</span>' : ''}</td>
            <td><span class="cli-status-pill">${escapeHtml(s.status || '')}</span></td>
            <td>${fmtDate(s.date)}</td>
          </tr>
        `).join('')}</tbody>
      </table>
    ` : '';
    const paymentsHtml = a.payments && a.payments.length ? `
      <h3 class="cli-section-title">История оплат</h3>
      <table class="cli-table">
        <thead><tr><th>Дата</th><th>Услуга</th><th class="num">Сумма</th></tr></thead>
        <tbody>${a.payments.map(p => `
          <tr>
            <td>${fmtDate(p.date)}</td>
            <td>${escapeHtml(p.service || '')}${p.comment ? ' · ' + escapeHtml(p.comment) : ''}</td>
            <td class="num">${fmtMoney(p.amount)}</td>
          </tr>
        `).join('')}</tbody>
      </table>
    ` : `<h3 class="cli-section-title">История оплат</h3><div class="cli-empty">Платежей пока нет.</div>`;
    const reviewsHtml = a.reviews && a.reviews.length ? `
      <h3 class="cli-section-title">Опубликованные отзывы</h3>
      ${a.reviews.map(r => `
        <div class="cli-review">
          <div class="cli-review__head">
            <span class="cli-review__code">${escapeHtml(r.profileCode || '—')}</span>
            <span>${fmtDate(r.date)}</span>
            ${r.archived ? '<span style="color:#cf1322">(аккаунт в архиве)</span>' : ''}
          </div>
          <div class="cli-review__text">${escapeHtml(r.text || '')}</div>
        </div>
      `).join('')}
    ` : `<h3 class="cli-section-title">Опубликованные отзывы</h3><div class="cli-empty">Отзывов пока нет.</div>`;

    root.innerHTML = `
      <a href="./index.html" class="cli-back">← Назад к анкетам</a>
      <h1 class="cli-detail-title">${escapeHtml(a.code)} · ${escapeHtml(a.name || '')}</h1>
      <div class="cli-detail-sub">${escapeHtml(a.platform || '')}${a.tariff ? ' · ' + escapeHtml(a.tariff) : ''}${a.deadline ? ' · дедлайн ' + fmtDate(a.deadline) : ''}</div>
      ${totalsHtml}
      ${moneyHtml}
      ${statusesHtml}
      ${paymentsHtml}
      ${reviewsHtml}
    `;
  }

  window.ClientApp = {
    requireLogin,
    loadSnapshot,
    renderHeader,
    renderTotals,
    renderAnketas,
    renderFeed,
    renderProfileDetail,
    fmtDate, fmtMoney, escapeHtml
  };
})();
