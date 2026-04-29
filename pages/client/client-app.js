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

  // Корень репо (где лежит универсальный логин). Для пути типа
  // /crm/pages/client/index.html → '/crm/'. Раньше было через slice(-2)
  // и для подпапок (включая /client/) возвращало '/crm/pages/' → 404.
  function rootHref() {
    const path = location.pathname;
    const idx = path.indexOf('/pages/');
    if (idx >= 0) return path.substring(0, idx + 1);
    return path.substring(0, path.lastIndexOf('/') + 1);
  }

  async function requireLogin() {
    if (!Auth.isLogged()) {
      try { await Auth.refresh(); } catch (_) {}
    }
    if (!Auth.isLogged()) {
      try { sessionStorage.setItem('mentori-cli-after-login', location.pathname + location.search); } catch (_) {}
      location.replace(rootHref());
      return false;
    }
    // На всякий случай: если в Supabase эта учётка не client — в админку всё равно
    // не пустит RLS, но и тут не дадим открыть портал (вероятно ошибка настройки).
    const role = Auth.role();
    if (role !== 'client') {
      // Возвращаем на универсальный логин — auth-gate.js разберётся куда
      // отправить (owner → дашборд, team → аккаунты).
      try { Auth.signOut(); } catch (_) {}
      alert('Этот аккаунт не помечен как клиент. Обратись к администратору.');
      location.replace(rootHref());
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
      location.replace(rootHref());
    });
  }

  function renderTotals(totals, anketas) {
    const el = document.querySelector('[data-cli-totals]');
    if (!el || !totals) return;
    // Сводный счётчик «в работе» по всем анкетам.
    let inProgress = 0;
    (anketas || []).forEach(a => {
      inProgress += _statusBreakdown(a.statuses).active;
    });
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
        <div class="cli-kpi__label">В работе</div>
        <div class="cli-kpi__value" style="color:#fa8c16">${inProgress}</div>
      </div>
      <div class="cli-kpi">
        <div class="cli-kpi__label">Остаток</div>
        <div class="cli-kpi__value ${(totals.remain||0) > 0 ? 'neg' : ''}">${fmtMoney(totals.remain || 0)}</div>
      </div>
    `;
  }

  /** Разбивка статусов на 3 группы для визуализации в карточке анкеты:
   *  «Запланировано» (📋) — серый, ничего ещё не происходит;
   *  «В работе» — оранжевый, активные диалоги/выбор/выбран;
   *  «Готово» (🎯) — зелёный, опубликованный отзыв. */
  const STATUS_PLANNED = '📋 Запланировано';
  const STATUS_DONE    = '🎯 Готов';
  function _statusBreakdown(statuses) {
    let planned = 0, active = 0, done = 0;
    (statuses || []).forEach(s => {
      if (s.status === STATUS_PLANNED) planned++;
      else if (s.status === STATUS_DONE) done++;
      else active++;   // диалог начат / закончен / выбрать / выбран
    });
    return { planned, active, done, total: planned + active + done };
  }

  function renderAnketas(anketas) {
    const el = document.querySelector('[data-cli-anketas]');
    if (!el) return;
    if (!anketas || !anketas.length) {
      el.innerHTML = '<div class="cli-empty">У вас пока нет анкет в работе. Свяжитесь с менеджером.</div>';
      return;
    }
    el.innerHTML = anketas.map(a => {
      const br = _statusBreakdown(a.statuses);
      // Стек-бар по статусам аккаунтов: ширина = отношение к общему числу
      // привязанных аккаунтов. Если совсем ничего нет — пустая полоска.
      const total = br.total || 1;
      const wPlanned = (br.planned / total) * 100;
      const wActive  = (br.active  / total) * 100;
      const wDone    = (br.done    / total) * 100;
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
              <div class="cli-card__stat-value" style="color:#389e0d">${a.done || 0}</div>
            </div>
            <div class="cli-card__stat">
              <div class="cli-card__stat-label">В работе</div>
              <div class="cli-card__stat-value" style="color:#fa8c16">${br.active}</div>
            </div>
          </div>
          <div class="cli-stackbar" title="Распределение аккаунтов по статусам">
            ${br.planned ? `<span class="cli-stackbar__seg planned" style="width:${wPlanned}%"></span>` : ''}
            ${br.active  ? `<span class="cli-stackbar__seg active"  style="width:${wActive}%"></span>` : ''}
            ${br.done    ? `<span class="cli-stackbar__seg done"    style="width:${wDone}%"></span>` : ''}
            ${br.total === 0 ? '<span class="cli-stackbar__empty">Аккаунты ещё не подключены</span>' : ''}
          </div>
          <div class="cli-stackbar__legend">
            <span><span class="cli-dot planned"></span>Запланировано · <b>${br.planned}</b></span>
            <span><span class="cli-dot active"></span>В работе · <b>${br.active}</b></span>
            <span><span class="cli-dot done"></span>Готово · <b>${br.done}</b></span>
          </div>
          <div class="cli-card__remain">Остаток к оплате: <b>${fmtMoney(a.remain || 0)}</b></div>
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
    el.innerHTML = feed.slice(0, 30).map(f => {
      // Показываем имя анкеты (например «ФЛ1»), а не служебный код «a21».
      const anketaLabel = f.anketaName || f.anketa || '';
      return `
      <div class="cli-feed__item">
        <div class="cli-feed__icon ${f.kind === 'review' ? 'review' : ''}">${f.kind === 'review' ? '✍️' : '📋'}</div>
        <div class="cli-feed__text">
          <div><strong>${escapeHtml(anketaLabel)}</strong> · ${escapeHtml(f.text || '')}</div>
          <div class="cli-feed__date">${fmtDate(f.date)}</div>
        </div>
      </div>`;
    }).join('');
  }

  /* --- Calendar widget ---
     Месячная сетка со статусами и опубликованными отзывами. Каждый день
     с событиями подсвечен точками по цвету анкеты. Тап на день → список
     событий за этот день. Идея — клиент видит активность по своим
     анкетам в календарном виде, не вчитываясь в ленту. */
  const CAL_COLORS = ['#2f54eb', '#52c41a', '#fa8c16', '#722ed1', '#13c2c2'];
  const calState = { month: new Date(), selected: new Date().toISOString().slice(0, 10) };

  function _gatherEvents(snap) {
    const events = [];
    if (!snap || !snap.anketas) return events;
    snap.anketas.forEach((a, idx) => {
      const color = CAL_COLORS[idx % CAL_COLORS.length];
      a.statuses.forEach(s => {
        if (!s.date) return;
        events.push({
          date: String(s.date).slice(0, 10),
          color, anketa: a.name || a.code,
          kind: 'status', icon: '📋',
          title: s.status || '',
          sub: s.profileName || '',
          comment: s.comment || ''
        });
      });
      a.reviews.forEach(r => {
        if (!r.date) return;
        events.push({
          date: String(r.date).slice(0, 10),
          color, anketa: a.name || a.code,
          kind: 'review', icon: '✍️',
          title: 'Опубликован отзыв',
          sub: r.profileName || '',
          comment: ''
        });
      });
    });
    return events;
  }

  function _monthLabel(d) {
    const months = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
    return `${months[d.getMonth()]} ${d.getFullYear()}`;
  }

  function renderCalendar(snap) {
    const el = document.querySelector('[data-cli-calendar]');
    if (!el || !snap) return;
    const events = _gatherEvents(snap);
    const byDate = new Map();
    events.forEach(e => {
      if (!byDate.has(e.date)) byDate.set(e.date, []);
      byDate.get(e.date).push(e);
    });

    const m = calState.month;
    const year = m.getFullYear(), month = m.getMonth();
    const first = new Date(year, month, 1);
    const last = new Date(year, month + 1, 0);
    // Пн=0..Вс=6
    const firstDow = (first.getDay() + 6) % 7;
    const daysInMonth = last.getDate();
    const todayStr = new Date().toISOString().slice(0, 10);

    // Легенда по анкетам
    const legend = (snap.anketas || []).map((a, idx) => `
      <span class="cli-cal__legend-item">
        <span class="cli-cal__dot" style="background:${CAL_COLORS[idx % CAL_COLORS.length]}"></span>
        ${escapeHtml(a.name || a.code)}
      </span>
    `).join('');

    // Сетка
    const cells = [];
    for (let i = 0; i < firstDow; i++) cells.push(`<div class="cli-cal__cell cli-cal__cell--empty"></div>`);
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const dayEvents = byDate.get(dateStr) || [];
      // уникальные цвета
      const uniqColors = [...new Set(dayEvents.map(e => e.color))];
      const dotsHtml = uniqColors.slice(0, 3).map(c =>
        `<span class="cli-cal__dot" style="background:${c}"></span>`
      ).join('');
      const cls = [
        'cli-cal__cell',
        dateStr === todayStr ? 'is-today' : '',
        dateStr === calState.selected ? 'is-selected' : '',
        dayEvents.length > 0 ? 'has-events' : ''
      ].filter(Boolean).join(' ');
      cells.push(`
        <button class="${cls}" data-date="${dateStr}">
          <span class="cli-cal__day">${d}</span>
          ${dotsHtml ? `<span class="cli-cal__dots">${dotsHtml}</span>` : ''}
        </button>
      `);
    }

    // События за выбранный день
    const selEvents = byDate.get(calState.selected) || [];
    const selEventsHtml = selEvents.length
      ? selEvents.map(e => `
          <div class="cli-cal__event">
            <span class="cli-cal__event-icon" style="background:${e.color}22;color:${e.color}">${e.icon}</span>
            <div class="cli-cal__event-body">
              <div class="cli-cal__event-title">${escapeHtml(e.title)}</div>
              <div class="cli-cal__event-meta">
                <strong>${escapeHtml(e.anketa)}</strong> · ${escapeHtml(e.sub)}
                ${e.comment ? ' · <span style="color:var(--text-mute)">' + escapeHtml(e.comment) + '</span>' : ''}
              </div>
            </div>
          </div>
        `).join('')
      : `<div class="cli-cal__empty">Событий за этот день нет.</div>`;

    el.innerHTML = `
      <div class="cli-cal__nav">
        <button class="cli-cal__nav-btn" data-cal-prev>‹</button>
        <div class="cli-cal__month">${_monthLabel(m)}</div>
        <button class="cli-cal__nav-btn" data-cal-next>›</button>
        <button class="cli-cal__today" data-cal-today>сегодня</button>
      </div>
      <div class="cli-cal__legend">${legend}</div>
      <div class="cli-cal__weekdays">
        <span>Пн</span><span>Вт</span><span>Ср</span><span>Чт</span><span>Пт</span><span>Сб</span><span>Вс</span>
      </div>
      <div class="cli-cal__grid">${cells.join('')}</div>
      <div class="cli-cal__sel-title">${fmtDate(calState.selected)}</div>
      <div class="cli-cal__events">${selEventsHtml}</div>
    `;

    // Биндим клики (после каждого ререндера, поскольку innerHTML затирает старые слушатели)
    el.querySelector('[data-cal-prev]').addEventListener('click', () => {
      calState.month = new Date(year, month - 1, 1); renderCalendar(snap);
    });
    el.querySelector('[data-cal-next]').addEventListener('click', () => {
      calState.month = new Date(year, month + 1, 1); renderCalendar(snap);
    });
    el.querySelector('[data-cal-today]').addEventListener('click', () => {
      const t = new Date();
      calState.month = new Date(t.getFullYear(), t.getMonth(), 1);
      calState.selected = t.toISOString().slice(0, 10);
      renderCalendar(snap);
    });
    el.querySelectorAll('.cli-cal__cell[data-date]').forEach(b => {
      b.addEventListener('click', () => {
        calState.selected = b.dataset.date;
        renderCalendar(snap);
      });
    });
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
    const br = _statusBreakdown(a.statuses);
    const total = br.total || 1;
    const wPlanned = (br.planned / total) * 100;
    const wActive  = (br.active  / total) * 100;
    const wDone    = (br.done    / total) * 100;
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
          <div class="cli-kpi__label">В работе</div>
          <div class="cli-kpi__value" style="color:#fa8c16">${br.active}</div>
        </div>
        <div class="cli-kpi">
          <div class="cli-kpi__label">Прогресс</div>
          <div class="cli-kpi__value">${pct}%</div>
        </div>
      </div>
      <div class="cli-stackbar" style="margin-bottom:6px">
        ${br.planned ? `<span class="cli-stackbar__seg planned" style="width:${wPlanned}%"></span>` : ''}
        ${br.active  ? `<span class="cli-stackbar__seg active"  style="width:${wActive}%"></span>` : ''}
        ${br.done    ? `<span class="cli-stackbar__seg done"    style="width:${wDone}%"></span>` : ''}
        ${br.total === 0 ? '<span class="cli-stackbar__empty">Аккаунты ещё не подключены</span>' : ''}
      </div>
      <div class="cli-stackbar__legend" style="margin-bottom:18px">
        <span><span class="cli-dot planned"></span>Запланировано · <b>${br.planned}</b></span>
        <span><span class="cli-dot active"></span>В работе · <b>${br.active}</b></span>
        <span><span class="cli-dot done"></span>Готово · <b>${br.done}</b></span>
      </div>
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
            <td><strong>${escapeHtml(s.profileName || '—')}</strong></td>
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
            <span class="cli-review__code">${escapeHtml(r.profileName || '—')}</span>
            <span>${fmtDate(r.date)}</span>
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
    renderCalendar,
    renderProfileDetail,
    fmtDate, fmtMoney, escapeHtml
  };
})();
