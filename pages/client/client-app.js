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
    console.error('[client-app] supabase-client.js?v=20260521a должен подключаться раньше');
    return;
  }
  const { Auth, accessToken } = window.Supabase;
  // URL/KEY — геттеры (см. supabase-client.js Object.defineProperties),
  // меняются после фолбэка. Через _url()/_key() читаем актуальные значения.
  const _url = () => window.Supabase.URL;
  const _key = () => window.Supabase.KEY;

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
    const url = `${_url()}/rest/v1/${SNAPSHOTS_TABLE}?email=eq.${encodeURIComponent(email)}&select=payload,updated_at`;
    const res = await fetch(url, {
      headers: {
        'apikey': _key(),
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

  /** SVG-donut с двумя сегментами: «в работе» (оранжевый) и «готово» (зелёный).
   *  Радиус 40 → периметр 2π·40 ≈ 251.33. На него и опираемся при расчёте
   *  stroke-dasharray. */
  function _donutSvg(active, done, ordered) {
    const CIRC = 2 * Math.PI * 40;  // = 251.33
    const total = ordered || 0;
    const dFrac = total > 0 ? Math.min(1, done   / total) : 0;
    const aFrac = total > 0 ? Math.min(Math.max(0, 1 - dFrac), active / total) : 0;
    const aLen  = CIRC * aFrac;
    const dLen  = CIRC * dFrac;
    // segments: done сначала (0..dLen), потом active сразу за ним.
    // stroke-dasharray трюк: dash=сегмент, gap=всё остальное. offset сдвигает.
    return `
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle class="cli-donut__track" cx="50" cy="50" r="40"></circle>
        <circle class="cli-donut__done"   cx="50" cy="50" r="40"
                stroke-dasharray="${dLen.toFixed(2)} ${(CIRC - dLen).toFixed(2)}"
                stroke-dashoffset="0"></circle>
        <circle class="cli-donut__active" cx="50" cy="50" r="40"
                stroke-dasharray="${aLen.toFixed(2)} ${(CIRC - aLen).toFixed(2)}"
                stroke-dashoffset="-${dLen.toFixed(2)}"></circle>
      </svg>`;
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
      const ordered = a.ordered || 0;
      const effectiveDone = Math.max(Number(a.done) || 0, br.done);
      const pct = ordered > 0
        ? Math.min(100, Math.round(((br.active + effectiveDone) / ordered) * 100))
        : 0;
      return `
        <a class="cli-card" href="./profile.html?id=${encodeURIComponent(a.mentorId)}">
          <div class="cli-card__top">
            <span class="cli-card__code">${escapeHtml(a.code)}</span>
            <span class="cli-card__name">${escapeHtml(a.name || a.code)}</span>
          </div>
          <div class="cli-card__body">
            <div class="cli-donut" title="Прогресс заказа: сделано и в работе">
              ${_donutSvg(br.active, effectiveDone, ordered)}
              <div class="cli-donut__center">
                <div class="cli-donut__pct">${pct}%</div>
                <div class="cli-donut__sub">прогресс</div>
              </div>
            </div>
            <div class="cli-card__stats">
              <div class="cli-card__stat">
                <div class="cli-card__stat-label">Заказано</div>
                <div class="cli-card__stat-value">${a.ordered || 0}</div>
              </div>
              <div class="cli-card__stat">
                <div class="cli-card__stat-label">Готово</div>
                <div class="cli-card__stat-value" style="color:var(--cli-green,#22c55e)">${a.done || 0}</div>
              </div>
              <div class="cli-card__stat">
                <div class="cli-card__stat-label">В работе</div>
                <div class="cli-card__stat-value" style="color:var(--cli-accent,#ff7a00)">${br.active}</div>
              </div>
            </div>
          </div>
          <div class="cli-card__remain">
            <span>Остаток к оплате</span>
            <b>${fmtMoney(a.remain || 0)}</b>
          </div>
        </a>
      `;
    }).join('');
  }

  function renderFeed(feed) {
    const el = document.querySelector('[data-cli-feed]');
    if (!el) return;
    // Корневой элемент превращается в свёрнутый <details> со счётчиком.
    // Чтобы при перерендере не плодить вложенность — каждый раз заново
    // строим разметку и заменяем innerHTML контейнера-обёртки.
    const list = (feed || []).slice(0, 30);
    if (!list.length) {
      el.innerHTML = `
        <details class="cli-feed-wrap">
          <summary>📋 Последние действия <span class="cli-feed-count">0</span></summary>
          <div class="cli-feed"><div class="cli-empty" style="margin:6px 0 12px">Активности пока нет.</div></div>
        </details>`;
      return;
    }
    el.innerHTML = `
      <details class="cli-feed-wrap">
        <summary>📋 Последние действия <span class="cli-feed-count">${list.length}</span></summary>
        <div class="cli-feed">
          ${list.map(f => {
            const anketaLabel = f.anketaName || f.anketa || '';
            return `
              <div class="cli-feed__item">
                <div class="cli-feed__icon ${f.kind === 'review' ? 'review' : ''}">${f.kind === 'review' ? '✍️' : '📋'}</div>
                <div class="cli-feed__text">
                  <div><strong>${escapeHtml(anketaLabel)}</strong> · ${escapeHtml(f.text || '')}</div>
                  <div class="cli-feed__date">${fmtDate(f.date)}</div>
                </div>
              </div>`;
          }).join('')}
        </div>
      </details>`;
  }

  /* --- Calendar widget ---
     Месячная сетка с тремя типами событий:
       1. status — изменение статуса аккаунта (📋)
       2. review — опубликованный отзыв (✍️)
       3. planned — запланированный отзыв (📅, новый!) — из client.schedule[]
     Запланированные дни в будущем подсвечены пунктирной оранжевой рамкой
     и счётчиком в углу. Идея — клиент видит и активность, и план,
     понимает когда ждать следующих отзывов. */
  const CAL_COLORS = ['#ff7a00', '#22c55e', '#3b82f6', '#a855f7', '#14b8a6'];
  const calState = { month: new Date(), selected: new Date().toISOString().slice(0, 10) };

  function _gatherEvents(snap) {
    const events = [];
    if (!snap || !snap.anketas) return events;
    snap.anketas.forEach((a, idx) => {
      const color = CAL_COLORS[idx % CAL_COLORS.length];
      (a.statuses || []).forEach(s => {
        if (!s.date) return;
        // Не дублируем события: «🎯 Готов» уже показан как «Опубликован отзыв»,
        // а «📋 Запланировано» — как «Запланировано отклик». Сырые эти статусы скрываем.
        if (s.status === '🎯 Готов' || s.status === '📋 Запланировано') return;
        events.push({
          date: String(s.date).slice(0, 10),
          color, anketa: a.name || a.code,
          kind: 'status', icon: '📋',
          title: s.status || '',
          sub: s.profileName || '',
          comment: s.comment || ''
        });
      });
      (a.reviews || []).forEach(r => {
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
      // Запланированные дни — из admin'ского графика (client.schedule).
      // Гасим сделанное: план за день − откликов сделано (аккаунты со статусом
      // ≠ «Запланировано», датированным этим днём). Сделал отклик → план уменьшается.
      (a.schedule || []).forEach(p => {
        if (!p.date || !p.count) return;
        const d = String(p.date).slice(0, 10);
        const doneToday = (a.statuses || []).filter(s =>
          String(s.date || '').slice(0, 10) === d && s.status !== '📋 Запланировано').length;
        const left = Math.max(0, (+p.count || 0) - doneToday);
        if (left <= 0) return;  // все запланированные отклики за день сделаны — не показываем
        events.push({
          date: d,
          color, anketa: a.name || a.code,
          kind: 'planned', icon: '📅',
          title: `Запланировано отклик${left > 1 ? 'ов' : ''} · ${left}`,
          sub: '', comment: '',
          plannedCount: left
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

    // Легенда: анкеты + пояснение «Запланировано».
    // Если ни одна анкета не имеет schedule[] — легенду про план не показываем,
    // чтобы не путать клиента (по умолчанию старые анкеты без графика).
    const hasAnyPlanned = events.some(e => e.kind === 'planned');
    const legend = (snap.anketas || []).map((a, idx) => `
      <span class="cli-cal__legend-item">
        <span class="cli-cal__dot" style="background:${CAL_COLORS[idx % CAL_COLORS.length]}"></span>
        ${escapeHtml(a.name || a.code)}
      </span>
    `).join('') + (hasAnyPlanned ? `
      <span class="cli-cal__legend-item" style="margin-left:auto">
        <span class="cli-cal__dot" style="background:transparent;border:1px dashed var(--cli-accent,#ff7a00)"></span>
        Запланировано
      </span>
    ` : '');

    // Сетка
    const cells = [];
    for (let i = 0; i < firstDow; i++) cells.push(`<div class="cli-cal__cell cli-cal__cell--empty"></div>`);
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const dayEvents = byDate.get(dateStr) || [];
      // Разделяем планируемые от фактических — план показываем счётчиком в углу,
      // факты — точками по цвету анкеты.
      const factEvents    = dayEvents.filter(e => e.kind !== 'planned');
      const plannedEvents = dayEvents.filter(e => e.kind === 'planned');
      const plannedCount  = plannedEvents.reduce((s, e) => s + (e.plannedCount || 1), 0);
      const uniqColors = [...new Set(factEvents.map(e => e.color))];
      const dotsHtml = uniqColors.slice(0, 3).map(c =>
        `<span class="cli-cal__dot" style="background:${c}"></span>`
      ).join('');
      const hasOnlyPlan = plannedCount > 0 && factEvents.length === 0;
      const cls = [
        'cli-cal__cell',
        dateStr === todayStr ? 'is-today' : '',
        dateStr === calState.selected ? 'is-selected' : '',
        (factEvents.length || plannedCount) ? 'has-events' : '',
        hasOnlyPlan ? 'is-planned' : ''
      ].filter(Boolean).join(' ');
      cells.push(`
        <button class="${cls}" data-date="${dateStr}">
          ${plannedCount > 0 ? `<span class="cli-cal__planned-badge" title="Запланировано откликов">${plannedCount}</span>` : ''}
          <span class="cli-cal__day">${d}</span>
          ${dotsHtml ? `<span class="cli-cal__dots">${dotsHtml}</span>` : ''}
        </button>
      `);
    }

    // События за выбранный день — сортируем «планируемые» вниз, «факт» наверх,
    // потому что факт важнее.
    const selEvents = [...(byDate.get(calState.selected) || [])].sort((a, b) => {
      const order = { review: 0, status: 1, planned: 2 };
      return (order[a.kind] || 9) - (order[b.kind] || 9);
    });
    const selPlannedTotal = selEvents
      .filter(e => e.kind === 'planned')
      .reduce((s, e) => s + (e.plannedCount || 1), 0);
    const selFactTotal = selEvents.filter(e => e.kind !== 'planned').length;
    const selEventsHtml = selEvents.length
      ? selEvents.map(e => `
          <div class="cli-cal__event">
            <span class="cli-cal__event-icon" style="background:${e.color}22;color:${e.color}">${e.icon}</span>
            <div class="cli-cal__event-body">
              <div class="cli-cal__event-title">${escapeHtml(e.title)}</div>
              <div class="cli-cal__event-meta">
                <strong>${escapeHtml(e.anketa)}</strong>${e.sub ? ' · ' + escapeHtml(e.sub) : ''}
                ${e.comment ? ' · <span style="color:var(--text-mute)">' + escapeHtml(e.comment) + '</span>' : ''}
              </div>
            </div>
          </div>
        `).join('')
      : `<div class="cli-cal__empty">Событий и планов на этот день нет.</div>`;
    const selMeta = [
      selFactTotal ? `${selFactTotal} событи${selFactTotal === 1 ? 'е' : (selFactTotal < 5 ? 'я' : 'й')}` : null,
      selPlannedTotal ? `📅 план: ${selPlannedTotal}` : null,
    ].filter(Boolean).join(' · ');

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
      <div class="cli-cal__sel-title">
        ${fmtDate(calState.selected)}
        ${selMeta ? `<span class="cli-cal__sel-title-meta">${escapeHtml(selMeta)}</span>` : ''}
      </div>
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
  function _packageHistoryHtml(anketa, orders, activeCount) {
    const calculator = window.MentoriPackages;
    if (!calculator || typeof calculator.build !== 'function') return '';
    const packages = calculator.build(orders, anketa, activeCount);
    if (!packages.length) return '';
    const stateLabel = {
      closed: ['Закрыт', 'closed'],
      active: ['В работе', 'active'],
      queued: ['Ожидает', 'queued']
    };
    return `
      <section class="cli-packages">
        <h3 class="cli-section-title">Пакеты по анкете</h3>
        <div class="cli-packages__list">
          ${packages.map(item => {
            const state = stateLabel[item.state] || stateLabel.queued;
            const donePct = item.qty ? Math.min(100, item.done / item.qty * 100) : 0;
            const activePct = item.qty
              ? Math.min(100 - donePct, item.active / item.qty * 100)
              : 0;
            return `
              <article class="cli-package">
                <div class="cli-package__head">
                  <div>
                    <div class="cli-package__name">${escapeHtml(item.name)}</div>
                    ${item.transferred ? '<div class="cli-package__note">Перенос с A-28</div>' : ''}
                  </div>
                  <span class="cli-package__state cli-package__state--${state[1]}">${state[0]}</span>
                </div>
                <div class="cli-package__counts">
                  <span>${item.bonus ? 'Бонус' : 'Заказано'} <b>${item.qty}</b></span>
                  <span>Выполнено <b>${item.done}</b></span>
                  <span>В работе <b>${item.active}</b></span>
                </div>
                <div class="cli-package__bar" aria-label="Выполнено ${item.done} из ${item.qty}">
                  ${donePct ? `<span class="cli-package__bar-done" style="width:${donePct}%"></span>` : ''}
                  ${activePct ? `<span class="cli-package__bar-active" style="width:${activePct}%"></span>` : ''}
                </div>
              </article>`;
          }).join('')}
        </div>
      </section>`;
  }

  function renderProfileDetail(payload, mentorId, orders) {
    const a = (payload.anketas || []).find(x => x.mentorId === mentorId);
    const root = document.querySelector('[data-cli-profile]');
    if (!root) return;
    if (!a) {
      root.innerHTML = '<div class="cli-empty">Анкета не найдена. Возможно, доступ к ней был отозван.</div>';
      return;
    }
    const br = _statusBreakdown(a.statuses);
    const ordered = a.ordered || 0;
    const effectiveDone = Math.max(Number(a.done) || 0, br.done);
    const pct = progressPct(effectiveDone + br.active, ordered);
    const wDone = ordered ? Math.min(100, (effectiveDone / ordered) * 100) : 0;
    const wActive = ordered ? Math.min(100 - wDone, (br.active / ordered) * 100) : 0;
    const packagesHtml = _packageHistoryHtml(a, orders || [], br.active);
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
        ${br.active ? `<span class="cli-stackbar__seg active" style="width:${wActive}%"></span>` : ''}
        ${br.done   ? `<span class="cli-stackbar__seg done"   style="width:${wDone}%"></span>`   : ''}
        ${ordered === 0 && br.total === 0 ? '<span class="cli-stackbar__empty">Аккаунты ещё не подключены</span>' : ''}
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
      ${packagesHtml}
      ${statusesHtml}
      ${paymentsHtml}
      ${reviewsHtml}
    `;
  }

  /* ==========================================================================
     Прокси для Telegram. Читаем из public.client_proxies + meta.
     Обновляется на сервере раз в 30 мин (cron + /home/mentori/scripts/client_proxies_refresh.py).
     Клиент тапает на ссылку tg://proxy?... — Telegram сам подставит настройки.
     ========================================================================== */
  async function loadProxies() {
    const token = accessToken();
    if (!token) return { proxies: [], meta: null };
    try {
      const [px, meta] = await Promise.all([
        fetch(`${_url()}/rest/v1/client_proxies?select=host,port,tg_link,latency_ms,tested_at&order=latency_ms.asc&limit=10`, {
          headers: { apikey: _key(), Authorization: `Bearer ${token}`, Accept: 'application/json' }
        }).then(r => r.ok ? r.json() : []),
        fetch(`${_url()}/rest/v1/client_proxies_meta?id=eq.main&select=updated_at,alive_count,feed_count`, {
          headers: { apikey: _key(), Authorization: `Bearer ${token}`, Accept: 'application/json' }
        }).then(r => r.ok ? r.json() : []),
      ]);
      return { proxies: px || [], meta: (meta && meta[0]) || null };
    } catch (e) {
      console.warn('[client-app] proxies load failed', e);
      return { proxies: [], meta: null };
    }
  }

  function _fmtAgo(iso) {
    if (!iso) return 'неизвестно';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000) return 'только что';
    const min = Math.floor(ms / 60_000);
    if (min < 60) return `${min} мин назад`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} ч назад`;
    return `${Math.floor(hr / 24)} д назад`;
  }

  async function renderProxies() {
    const el = document.querySelector('[data-cli-proxies]');
    if (!el) return;
    const { proxies, meta } = await loadProxies();
    if (!proxies.length) {
      el.innerHTML = `
        <div class="cli-proxy-empty">
          <div style="font-size:14px;color:var(--text-mute);margin-bottom:8px">⚠️ Сейчас нет проверенных прокси.</div>
          <div style="font-size:12px;color:var(--text-mute)">Список обновляется каждые 30 минут. Зайди чуть позже.</div>
          ${meta && meta.updated_at ? `<div style="font-size:11px;color:var(--text-mute);margin-top:8px">Последняя проверка: ${escapeHtml(_fmtAgo(meta.updated_at))}</div>` : ''}
        </div>`;
      return;
    }
    const updated = meta && meta.updated_at ? _fmtAgo(meta.updated_at) : '—';
    // Список свёрнут в <details>-дропдаун: закрытым — одна строка со счётчиком,
    // по тапу раскрывается весь список (иначе 10 прокси съедали пол-экрана).
    el.innerHTML = `
      <details class="cli-proxy-dd">
        <summary class="cli-proxy-summary">
          <span class="cli-proxy-summary__icon">🛰️</span>
          <span class="cli-proxy-summary__label">Показать прокси <b>(${proxies.length})</b></span>
          <span class="cli-proxy-summary__meta">обновлено ${escapeHtml(updated)}</span>
          <span class="cli-proxy-summary__chev">▾</span>
        </summary>
        <div class="cli-proxy-info">
          Если Telegram не открывается — нажми на любой прокси ниже. Telegram сам подставит настройки.
          Если не получилось через один — попробуй другой (некоторые могут не работать на твоём операторе).
        </div>
        <div class="cli-proxy-list">
          ${proxies.map((p, i) => `
            <a class="cli-proxy-item" href="${escapeAttr(p.tg_link)}">
              <div class="cli-proxy-num">${i + 1}</div>
              <div class="cli-proxy-body">
                <div class="cli-proxy-host">${escapeHtml(p.host)}:${escapeHtml(p.port)}</div>
                <div class="cli-proxy-meta">⚡ ${escapeHtml(p.latency_ms || '?')} ms · открыть в Telegram</div>
              </div>
              <div class="cli-proxy-arrow">→</div>
            </a>
          `).join('')}
        </div>
        <div style="font-size:11px;color:var(--text-mute);margin-top:10px;text-align:center">
          Если ни один не работает — напиши менеджеру.
        </div>
      </details>
    `;
  }
  function escapeAttr(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  /* ====================================================================
     Заказ отзывов (самообслуживание оплаты).
     Клиент выбирает анкету (существующую/новую) + тариф и жмёт
     «Перейти к оплате» → INSERT в client_orders (RLS: только свой email),
     затем backend создаёт платёж RollyPay и возвращает pay_url.
     Триггер в БД пингует владельца в Telegram. Тарифы приходят в
     snapshot.payload.payment (владелец задаёт их в CRM).
     ==================================================================== */
  let _orderPayload = null;   // последний snap.payload (anketas + payment)
  const PAYMENTS_API = 'https://mentori.tech/api/payments';

  // Оферта одна: кабинет читает её из /legal/offer.html и сохраняет точный
  // текст в заказе. При недоступности документа заказ не отправляется.
  const LEGAL = window.MentoriLegal || {};
  const OFFER_VERSION = LEGAL.offerVersion || LEGAL.version || '2026-07-13-3';
  const CONSENT_VERSION = LEGAL.consentVersion || '2026-07-13';
  const DATA_CONSENT_DEFAULT = LEGAL.consentText || 'Согласие на обработку персональных данных Mentori: /legal/consent.html';
  let _canonicalOfferText = '';
  let _canonicalOfferPromise = null;

  function preloadLegalDocuments() {
    if (_canonicalOfferText) return Promise.resolve(_canonicalOfferText);
    if (_canonicalOfferPromise) return _canonicalOfferPromise;
    _canonicalOfferPromise = fetch('../../legal/offer.html?v=20260713e', { cache: 'no-store' })
      .then(res => {
        if (!res.ok) throw new Error(`offer ${res.status}`);
        return res.text();
      })
      .then(html => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const main = doc.querySelector('.legal-main');
        if (!main) throw new Error('offer body not found');
        const blocks = [...main.querySelectorAll('h1, .legal-date, h2, p, li')]
          .map(el => String(el.textContent || '').trim())
          .filter(Boolean);
        const requisites = main.querySelector('.legal-requisites');
        if (requisites) blocks.push(String(requisites.textContent || '').replace(/\s+/g, ' ').trim());
        const text = blocks.join('\n\n');
        if (text.length < 1000 || !/Публичная оферта/i.test(text)) throw new Error('offer text is incomplete');
        _canonicalOfferText = text;
        return text;
      })
      .catch(error => {
        console.warn('[client-app] canonical offer unavailable', error);
        return '';
      })
      .finally(() => {
        _canonicalOfferPromise = null;
      });
    return _canonicalOfferPromise;
  }

  function renderOrder(payload) {
    _orderPayload = payload || null;
    const cta = document.querySelector('[data-cli-order-cta]');
    if (!cta) return;
    const pay = (payload && payload.payment) || {};
    const tariffs = pay.tariffs || [];
    if (!tariffs.length) { cta.hidden = true; return; }
    cta.hidden = false;
    const btn = document.getElementById('cliOrderBtn');
    if (btn && !btn._bound) { btn._bound = true; btn.addEventListener('click', openOrderModal); }
    document.querySelectorAll('[data-cli-order-close]').forEach(el => {
      if (el._bound) return; el._bound = true; el.addEventListener('click', closeOrderModal);
    });
  }

  function closeOrderModal() {
    const m = document.getElementById('cliOrderModal');
    if (m) m.hidden = true;
    document.body.classList.remove('cli-modal-open');  // вернуть скролл фона
  }

  function openOrderModal() {
    const m = document.getElementById('cliOrderModal');
    const body = document.querySelector('[data-cli-order-body]');
    if (!m || !body || !_orderPayload) return;
    const pay = _orderPayload.payment || {};
    const tariffs = pay.tariffs || [];
    const anketas = _orderPayload.anketas || [];
    const hasExisting = anketas.length > 0;
    body.innerHTML = `
      <div class="cli-ord-field">
        <div class="cli-ord-label">На какую анкету?</div>
        <label class="cli-ord-radio"><input type="radio" name="ordTarget" value="existing" ${hasExisting ? 'checked' : 'disabled'}/> Существующая</label>
        <select class="cli-ord-input" id="ordExisting" ${hasExisting ? '' : 'disabled'}>
          ${anketas.map(a => `<option data-code="${escapeAttr(a.code || '')}" data-name="${escapeAttr(a.name || a.code || '')}">${escapeHtml(a.code || '')}${a.name ? ' · ' + escapeHtml(a.name) : ''}</option>`).join('')}
        </select>
        <label class="cli-ord-radio" style="margin-top:10px"><input type="radio" name="ordTarget" value="new" ${hasExisting ? '' : 'checked'}/> Новая анкета</label>
        <input type="text" class="cli-ord-input" id="ordNewName" placeholder="имя новой анкеты (например: Кирилл / физика)" ${hasExisting ? 'disabled' : ''}/>
      </div>
      <div class="cli-ord-field">
        <div class="cli-ord-label">Тариф</div>
        <select class="cli-ord-input" id="ordTariff">
          ${tariffs.map((t, i) => {
            const lbl = t.unit === 'per'
              ? `${escapeHtml(t.name || 'Тариф')} — ${Number(t.price || 0).toLocaleString('ru-RU')} ₽/шт (от ${Number(t.qty) || 1})`
              : `${escapeHtml(t.name || 'Тариф')}${t.qty ? ' · ' + t.qty + ' отзывов' : ''}${t.price ? ' — ' + Number(t.price).toLocaleString('ru-RU') + ' ₽' : ''}`;
            return `<option value="${i}">${lbl}</option>`;
          }).join('')}
        </select>
      </div>
      <div class="cli-ord-field" id="ordQtyWrap" hidden>
        <div class="cli-ord-label">Количество отзывов</div>
        <input type="number" class="cli-ord-input" id="ordQty"/>
      </div>
      <div class="cli-ord-field">
        <div class="cli-ord-label">Оплата</div>
        <label class="cli-ord-radio"><input type="radio" name="ordPay" value="half" checked/> Предоплата 50% сейчас (остаток — после выполнения)</label>
        <label class="cli-ord-radio" style="margin-top:6px"><input type="radio" name="ordPay" value="full"/> Оплатить 100% сейчас</label>
      </div>
      <div class="cli-ord-amount" id="ordAmount"></div>
      <div class="cli-ord-field">
        <div class="cli-ord-label">Ссылка на профиль (если есть)</div>
        <input type="url" class="cli-ord-input" id="ordProfileUrl" placeholder="ссылка на твою анкету/профиль"/>
      </div>
      <div class="cli-ord-field">
        <div class="cli-ord-label">Комментарий (необязательно)</div>
        <textarea class="cli-ord-input" id="ordComment" rows="2" placeholder="пожелания или важная информация по заказу"></textarea>
      </div>
      <div class="cli-ord-offer">
        <label class="cli-ord-offer__check">
          <input type="checkbox" id="ordOffer"/>
          <span>Я принимаю <a href="#" id="ordOfferLink">Публичную оферту</a></span>
        </label>
        <label class="cli-ord-offer__check">
          <input type="checkbox" id="ordPersonalData"/>
          <span>Я отдельно даю <a href="../../legal/consent.html" target="_blank" rel="noopener">согласие на обработку персональных данных</a> и ознакомлен с <a href="../../legal/privacy.html" target="_blank" rel="noopener">Политикой конфиденциальности</a></span>
        </label>
      </div>
      <div class="cli-ord-result" id="ordResult"></div>
      <button type="button" class="cli-ord-submit" id="ordSubmit">Перейти к оплате</button>
    `;
    // переключение существующая/новая → активируем нужное поле
    body.querySelectorAll('input[name="ordTarget"]').forEach(r => r.addEventListener('change', () => {
      const isEx = (body.querySelector('input[name="ordTarget"]:checked') || {}).value === 'existing';
      const ex = document.getElementById('ordExisting'); if (ex) ex.disabled = !isEx;
      const nn = document.getElementById('ordNewName'); if (nn) nn.disabled = isEx;
    }));
    // тариф/количество → пересчёт суммы. Для «за шт» показываем поле кол-ва.
    const tariffSel = document.getElementById('ordTariff');
    const qtyWrap = document.getElementById('ordQtyWrap');
    const qtyInp = document.getElementById('ordQty');
    const amountEl = document.getElementById('ordAmount');
    const curTariff = () => tariffs[Number(tariffSel.value) || 0] || {};
    // полная сумма заказа по выбранному тарифу/количеству
    function orderFull() {
      const t = curTariff();
      if (t.unit === 'per') {
        const minQ = Math.max(1, Number(t.qty) || 1);
        qtyInp.min = minQ;
        let q = Number(qtyInp.value) || minQ;
        if (q < minQ) q = minQ;
        return (Number(t.price) || 0) * q;
      }
      return Number(t.price) || 0;
    }
    const isPayFull = () => (body.querySelector('input[name="ordPay"]:checked') || {}).value === 'full';
    const fmtRub = n => Number(n).toLocaleString('ru-RU') + ' ₽';
    function recalcAmount() {
      qtyWrap.hidden = curTariff().unit !== 'per';
      const full = orderFull();
      if (full <= 0) { amountEl.innerHTML = ''; return; }
      const payNow = isPayFull() ? full : Math.round(full / 2);
      amountEl.innerHTML = `Сумма заказа: ${fmtRub(full)}<br>`
        + `<b>К оплате сейчас: ${fmtRub(payNow)}</b>`
        + (isPayFull() ? '' : `<br><span class="cli-ord-amount__rest">Остаток ${fmtRub(full - payNow)} — после выполнения</span>`);
    }
    tariffSel.addEventListener('change', () => {
      const t = curTariff();
      if (t.unit === 'per') qtyInp.value = Math.max(1, Number(t.qty) || 1);
      recalcAmount();
    });
    body.querySelectorAll('input[name="ordPay"]').forEach(r => r.addEventListener('change', recalcAmount));
    qtyInp.addEventListener('input', recalcAmount);
    recalcAmount();
    // копирование каждого реквизита своей кнопкой
    body.querySelectorAll('.cli-req-row__copy').forEach(b => b.addEventListener('click', () => {
      const txt = b.getAttribute('data-copy') || '';
      const done = () => { const o = b.textContent; b.textContent = '✓ Скопировано'; setTimeout(() => b.textContent = o, 1300); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, () => { b.textContent = 'Выдели вручную'; });
      else b.textContent = 'Выдели вручную';
    }));
    const offerLink = document.getElementById('ordOfferLink');
    if (offerLink) offerLink.addEventListener('click', e => { e.preventDefault(); openTerms(); });
    document.getElementById('ordSubmit').addEventListener('click', onOrderSubmit);
    m.hidden = false;
    document.body.classList.add('cli-modal-open');  // блок скролла фона
  }

  /** Окно с текстом условий заказа. Без аргумента — текущие условия;
   *  с textOverride — показывает именно тот текст (снимок из конкретной заявки —
   *  доказательство, с какими условиями клиент согласился). */
  async function openTerms(textOverride) {
    const text = (typeof textOverride === 'string' && textOverride.trim())
      ? textOverride
      : await preloadLegalDocuments();
    openLegalText(
      'Публичная оферта',
      text,
      'Не удалось загрузить Публичную оферту. Обновите страницу и попробуйте ещё раз.'
    );
  }

  function openDataConsent(textOverride) {
    openLegalText('Согласие на обработку данных', textOverride, DATA_CONSENT_DEFAULT);
  }

  function openLegalText(title, textOverride, fallback) {
    const m = document.getElementById('cliTermsModal');
    const body = document.querySelector('[data-cli-terms-body]');
    if (!m || !body) return;
    const titleEl = m.querySelector('[data-cli-terms-title]');
    if (titleEl) titleEl.textContent = title;
    let text = (typeof textOverride === 'string' && textOverride.trim()) ? textOverride : '';
    if (!text) text = fallback;
    body.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
    m.hidden = false;
  }
  function closeTerms() { const m = document.getElementById('cliTermsModal'); if (m) m.hidden = true; }

  async function onOrderSubmit() {
    const btn = document.getElementById('ordSubmit');
    const result = document.getElementById('ordResult');
    const offerText = await preloadLegalDocuments();
    if (!offerText) {
      result.className = 'cli-ord-result is-err';
      result.textContent = 'Не удалось загрузить Публичную оферту. Обновите страницу и попробуйте ещё раз.';
      return;
    }
    const pay = (_orderPayload && _orderPayload.payment) || {};
    const tariffs = pay.tariffs || [];
    const target = (document.querySelector('input[name="ordTarget"]:checked') || {}).value || 'new';
    const tariff = tariffs[Number(document.getElementById('ordTariff').value) || 0] || {};
    const comment = (document.getElementById('ordComment').value || '').trim();
    const profileUrl = (document.getElementById('ordProfileUrl').value || '').trim();

    // кол-во + ПОЛНАЯ сумма заказа: пакет — фиксированы из тарифа; за шт — qty×цена
    let qty, amount;
    if (tariff.unit === 'per') {
      const minQ = Math.max(1, Number(tariff.qty) || 1);
      qty = Math.max(minQ, Number((document.getElementById('ordQty') || {}).value) || minQ);
      amount = (Number(tariff.price) || 0) * qty;
    } else {
      qty = Number(tariff.qty) || null;
      amount = Number(tariff.price) || 0;
    }
    // выбор оплаты: 50% предоплата или 100% сразу
    const pay_full = (document.querySelector('input[name="ordPay"]:checked') || {}).value === 'full';
    const prepay_amount = pay_full ? amount : Math.round(amount / 2);

    let anketa_code = null, anketa_name = '', is_new_anketa = false;
    if (target === 'existing') {
      const sel = document.getElementById('ordExisting');
      const opt = sel && sel.options[sel.selectedIndex];
      if (!opt) { result.className = 'cli-ord-result is-err'; result.textContent = 'Выбери анкету.'; return; }
      anketa_code = opt.dataset.code || null;
      anketa_name = opt.dataset.name || '';
    } else {
      is_new_anketa = true;
      anketa_name = (document.getElementById('ordNewName').value || '').trim();
      if (!anketa_name) { result.className = 'cli-ord-result is-err'; result.textContent = 'Впиши имя новой анкеты.'; return; }
    }

    // Оферта и обработка персональных данных подтверждаются отдельно.
    const offerChk = document.getElementById('ordOffer');
    if (!offerChk || !offerChk.checked) {
      result.className = 'cli-ord-result is-err';
      result.textContent = 'Подтверди принятие Публичной оферты.';
      return;
    }
    const personalDataChk = document.getElementById('ordPersonalData');
    if (!personalDataChk || !personalDataChk.checked) {
      result.className = 'cli-ord-result is-err';
      result.textContent = 'Дай отдельное согласие на обработку персональных данных.';
      return;
    }
    const offer_agreed = true;
    const personal_data_agreed = true;

    btn.disabled = true;
    btn.textContent = 'Создаю платёж…';
    const email = (Auth.email() || '').toLowerCase();
    const order = await submitOrder({
      client_email: email,
      client_name: Auth.name() || email,
      anketa_code, anketa_name, is_new_anketa,
      tariff_name: tariff.name || null,
      tariff_price: tariff.price != null ? tariff.price : null,
      qty: qty != null ? qty : null,
      amount: amount != null ? amount : null,
      pay_full: pay_full,
      prepay_amount: prepay_amount,
      profile_url: profileUrl || null,
      receipt_url: null,
      offer_agreed: offer_agreed,
      offer_text: offerText,
      offer_version: OFFER_VERSION,
      personal_data_agreed: personal_data_agreed,
      personal_data_consent_text: DATA_CONSENT_DEFAULT,
      personal_data_consent_version: CONSENT_VERSION,
      consent_user_agent: String(navigator.userAgent || '').slice(0, 1000),
      comment: comment || null
    });

    if (order && order.id) {
      const opened = await startPayment(order.id, btn, result);
      if (!opened) loadMyOrders().then(renderMyOrders);
    } else {
      btn.disabled = false; btn.textContent = 'Перейти к оплате';
      result.className = 'cli-ord-result is-err';
      result.textContent = 'Не получилось создать заказ. Попробуй ещё раз или напиши менеджеру.';
    }
  }

  async function submitOrder(payload) {
    try {
      const res = await fetch(`${_url()}/rest/v1/client_orders`, {
        method: 'POST',
        headers: {
          'apikey': _key(),
          'Authorization': `Bearer ${accessToken()}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify(payload)
      });
      if (!res.ok && res.status !== 201 && res.status !== 204) {
        console.warn('[client-app] order insert failed', res.status, await res.text().catch(() => ''));
        return null;
      }
      const rows = await res.json().catch(() => []);
      return Array.isArray(rows) ? (rows[0] || null) : rows;
    } catch (e) { console.warn('[client-app] submitOrder failed', e); return null; }
  }

  async function startPayment(orderId, button, result) {
    if (!orderId) return false;
    if (button) { button.disabled = true; button.textContent = 'Открываю оплату…'; }
    if (result) { result.className = 'cli-ord-result'; result.textContent = ''; }
    try {
      const response = await fetch(`${PAYMENTS_API}/create`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ client_order_id: Number(orderId) })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.pay_url) throw new Error(data.detail || `payment ${response.status}`);
      window.location.assign(data.pay_url);
      return true;
    } catch (error) {
      console.warn('[client-app] payment create failed', error);
      if (button) { button.disabled = false; button.textContent = 'Перейти к оплате'; }
      if (result) {
        result.className = 'cli-ord-result is-err';
        result.textContent = 'Заказ сохранён, но платёжная страница сейчас не открылась. Закрой окно и нажми «Перейти к оплате» в истории заказа.';
      }
      return false;
    }
  }

  /* ---- Мои заказы (история заявок клиента со статусом) ---- */
  async function loadMyOrders() {
    const token = accessToken();
    const email = (Auth.email() || '').toLowerCase();
    if (!token || !email) return [];
    try {
      const url = `${_url()}/rest/v1/client_orders`
        + `?client_email=eq.${encodeURIComponent(email)}`
        + `&select=id,anketa_code,anketa_name,is_new_anketa,tariff_name,qty,amount,status,created_at,confirmed_at,receipt_url,offer_agreed,offer_text,offer_version,personal_data_agreed,personal_data_consent_text,personal_data_consent_version,pay_full,prepay_amount,remainder_status,order_type,items,comment,payment_provider,payment_id,payment_status,payment_url,payment_environment,payment_created_at,payment_paid_at`
        + `&order=created_at.desc&limit=200`;
      const res = await fetch(url, { headers: { 'apikey': _key(), 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } });
      if (!res.ok) { console.warn('[client-app] loadMyOrders failed', res.status); return []; }
      return await res.json();
    } catch (e) { console.warn('[client-app] loadMyOrders error', e); return []; }
  }

  const ORDER_STATUS = {
    new:       { label: 'На проверке',       cls: 'wait' },
    confirmed: { label: 'Платёж подтверждён', cls: 'ok' },
    paid_review: { label: 'Оплата получена', cls: 'wait' },
    rejected:  { label: 'Отклонён',           cls: 'err' }
  };
  function _fmtDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return fmtDate(iso);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function _orderCardHtml(o) {
    const paymentReceived = o.payment_status === 'paid';
    const st = paymentReceived && o.status !== 'confirmed'
      ? ORDER_STATUS.paid_review
      : (ORDER_STATUS[o.status] || { label: o.status || '—', cls: '' });
    const isRem = o.order_type === 'remainder';
    const amt = Number(o.amount) || 0;
    let title, sub, payLine = '';
    if (isRem) {
      title = 'Доплата остатка';
      sub = `${escapeHtml(o.anketa_name || '—')} · ${_fmtDateTime(o.created_at)}`;
      payLine = `<div class="cli-order__pay">💳 ${o.status === 'confirmed' || paymentReceived ? 'Оплачено' : 'К оплате'}: ${fmtMoney(amt)}</div>`;
    } else {
      const anketa = o.is_new_anketa
        ? `новая «${escapeHtml(o.anketa_name || '—')}»`
        : escapeHtml(o.anketa_code || o.anketa_name || '—');
      title = `${escapeHtml(o.tariff_name || 'Заказ')}${o.qty ? ' · ' + o.qty + ' отз.' : ''}`;
      sub = `${anketa} · ${_fmtDateTime(o.created_at)}`;
      const prepay = o.prepay_amount != null ? Number(o.prepay_amount) : amt;
      const rest = Math.max(0, amt - prepay);
      if (o.status === 'confirmed' || paymentReceived) {
        payLine = (o.pay_full || rest <= 0)
          ? `<div class="cli-order__pay">💳 Оплачено полностью: ${fmtMoney(amt)}</div>`
          : o.remainder_status === 'pending'
            ? `<div class="cli-order__pay">💳 Оплачено: ${fmtMoney(prepay)} (предоплата) · Остаток: <b>${fmtMoney(rest)}</b> после выполнения</div>`
            : `<div class="cli-order__pay">💳 Оплачено: ${fmtMoney(prepay)} + остаток ${fmtMoney(rest)}</div>`;
      } else if (o.status === 'new') {
        payLine = `<div class="cli-order__pay">💳 К оплате: ${fmtMoney(prepay)}${o.pay_full ? ' (100%)' : ' (предоплата 50%)'}</div>`;
      }
    }
    const consent = o.offer_agreed
      ? `<div class="cli-order__consent">✅ Оферта${o.offer_version ? ' ' + escapeHtml(o.offer_version) : ''} принята${o.personal_data_agreed ? ' · согласие на обработку данных дано' : ''} · ${_fmtDateTime(o.created_at)}${o.offer_text ? ` · <button type="button" class="cli-order__terms" data-view-terms="${o.id}">оферта</button>` : ''}${o.personal_data_consent_text ? ` · <button type="button" class="cli-order__terms" data-view-consent="${o.id}">согласие</button>` : ''}</div>`
      : '';
    const receipt = o.receipt_url
      ? `<a class="cli-order__receipt" href="${escapeAttr(o.receipt_url)}" target="_blank" rel="noopener">Открыть чек</a>`
      : '';
    const paymentAction = o.status !== 'confirmed' && !paymentReceived
      ? `<button type="button" class="cli-order__pay-btn" data-pay-order="${o.id}">Перейти к оплате</button>`
      : paymentReceived && o.status !== 'confirmed'
        ? `<div class="cli-order__payment-note">Оплата получена. Заказ обрабатывается.</div>`
        : '';
    return `
      <div class="cli-order">
        <div class="cli-order__row">
          <div class="cli-order__main">
            <div class="cli-order__title">${title}</div>
            <div class="cli-order__sub">${sub}</div>
          </div>
          <span class="cli-order__status cli-order__status--${st.cls}">${st.label}</span>
        </div>
        ${payLine}
        ${paymentAction}
        ${receipt}
        ${consent}
      </div>`;
  }
  let _myOrders = [];
  function renderMyOrders(orders) {
    const el = document.querySelector('[data-cli-orders]');
    if (!el) return;
    _myOrders = orders || [];
    if (!_myOrders.length) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    const rest = _myOrders.slice(1);  // показываем последний, остальные — по кнопке
    el.innerHTML = `
      <h2 class="cli-section-title">Мои заказы</h2>
      <div class="cli-orders__list">${_orderCardHtml(_myOrders[0])}</div>
      ${rest.length ? `
        <div class="cli-orders__list cli-orders__more" data-cli-orders-more hidden>${rest.map(_orderCardHtml).join('')}</div>
        <button type="button" class="cli-orders__toggle" data-cli-orders-toggle>▾ Показать все заказы (${_myOrders.length})</button>` : ''}`;
    const toggle = el.querySelector('[data-cli-orders-toggle]');
    const more = el.querySelector('[data-cli-orders-more]');
    if (toggle && more) toggle.addEventListener('click', () => {
      const willOpen = more.hidden;
      more.hidden = !willOpen;
      toggle.textContent = willOpen ? '▴ Свернуть' : `▾ Показать все заказы (${_myOrders.length})`;
    });
    el.querySelectorAll('[data-view-terms]').forEach(b => b.addEventListener('click', () => {
      const o = _myOrders.find(x => String(x.id) === b.dataset.viewTerms);
      if (o) openTerms(o.offer_text);
    }));
    el.querySelectorAll('[data-view-consent]').forEach(b => b.addEventListener('click', () => {
      const o = _myOrders.find(x => String(x.id) === b.dataset.viewConsent);
      if (o) openDataConsent(o.personal_data_consent_text);
    }));
    el.querySelectorAll('[data-pay-order]').forEach(button => {
      button.addEventListener('click', () => startPayment(button.dataset.payOrder, button, null));
    });
  }

  async function handlePaymentReturn() {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('payment');
    const orderId = Number(params.get('order')) || 0;
    if (!result || !orderId) return;
    const box = document.querySelector('[data-cli-payment-result]');
    if (box) {
      box.hidden = false;
      box.className = `cli-payment-result ${result === 'success' ? 'is-ok' : 'is-err'}`;
      box.textContent = result === 'success'
        ? 'Проверяем оплату… Обычно это занимает несколько секунд.'
        : 'Оплата не завершена. Её можно повторить в разделе «Мои заказы».';
    }
    if (result === 'success') {
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const response = await fetch(`${PAYMENTS_API}/orders/${orderId}`, {
            headers: { 'Authorization': `Bearer ${accessToken()}` }
          });
          const data = await response.json().catch(() => ({}));
          if (response.ok && data.status === 'paid') {
            if (box) box.textContent = data.requires_manual_review
              ? 'Оплата получена. Менеджер завершит обработку заказа.'
              : 'Оплата подтверждена. Данные заказа обновлены.';
            break;
          }
        } catch (error) {
          console.warn('[client-app] payment status failed', error);
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    history.replaceState({}, '', window.location.pathname);
  }

  /* ---- Оплатить остаток (по конкретным заказам) ---- */
  // Часть старых карточек появилась до client_orders. Калькулятор добавляет
  // разницу из карточки к современным остаткам и защищает от повторной заявки.
  function _payableRemainItems() {
    const anketas = (_orderPayload && _orderPayload.anketas) || [];
    const calculator = window.MentoriRemainder;
    if (!calculator || typeof calculator.calculate !== 'function') return [];
    return calculator.calculate(_myOrders || [], anketas).map(item => {
      const date = _fmtDateTime(item.confirmed_at);
      const label = item.kind === 'legacy'
        ? `${item.code || item.name || 'Анкета'} · остаток по карточке`
        : `${item.code || item.name || '—'} · ${item.tariff_name || 'Пакет'}${date ? ' · ' + date : ''}`;
      return { ...item, label };
    });
  }
  function renderRemainder(payload, orders) {
    if (payload) _orderPayload = payload;
    _myOrders = orders || _myOrders || [];
    const cta = document.querySelector('[data-cli-remain-cta]');
    if (!cta) return;
    const payable = _payableRemainItems();
    const total = payable.reduce((s, item) => s + item.amount, 0);
    if (!payable.length || total <= 0) { cta.hidden = true; return; }
    cta.hidden = false;
    const totalEl = cta.querySelector('[data-cli-remain-total]');
    if (totalEl) totalEl.textContent = fmtMoney(total);
    const btn = document.getElementById('cliRemainBtn');
    if (btn && !btn._bound) { btn._bound = true; btn.addEventListener('click', openRemainModal); }
  }
  function closeRemainModal() { const m = document.getElementById('cliRemainModal'); if (m) m.hidden = true; }

  function openRemainModal() {
    const m = document.getElementById('cliRemainModal');
    const body = document.querySelector('[data-cli-remain-body]');
    if (!m || !body || !_orderPayload) return;
    const items = _payableRemainItems();
    if (!items.length) return;
    body.innerHTML = `
      <div class="cli-ord-field">
        <div class="cli-ord-label">Выбери пакеты для оплаты остатка</div>
        ${items.map(item => `
          <label class="cli-remain-row">
            <input type="checkbox" class="cli-remain-chk"
              data-source-order-id="${escapeAttr(item.source_order_id)}"
              data-code="${escapeAttr(item.code)}"
              data-name="${escapeAttr(item.name)}"
              data-label="${escapeAttr(item.label)}"
              data-amount="${item.amount}" checked/>
            <span class="cli-remain-row__name">${escapeHtml(item.label)}</span>
            <span class="cli-remain-row__amt">${fmtMoney(item.amount)}</span>
          </label>`).join('')}
      </div>
      <div class="cli-ord-amount" id="remainTotal"></div>
      <div class="cli-ord-offer">
        <label class="cli-ord-offer__check">
          <input type="checkbox" id="remainOffer"/>
          <span>Я принимаю <a href="#" id="remainOfferLink">Публичную оферту</a></span>
        </label>
        <label class="cli-ord-offer__check">
          <input type="checkbox" id="remainPersonalData"/>
          <span>Я отдельно даю <a href="../../legal/consent.html" target="_blank" rel="noopener">согласие на обработку персональных данных</a> и ознакомлен с <a href="../../legal/privacy.html" target="_blank" rel="noopener">Политикой конфиденциальности</a></span>
        </label>
      </div>
      <div class="cli-ord-result" id="remainResult"></div>
      <button type="button" class="cli-ord-submit" id="remainSubmit">Перейти к оплате</button>
    `;
    const recalc = () => {
      const total = [...body.querySelectorAll('.cli-remain-chk:checked')].reduce((s, c) => s + (Number(c.dataset.amount) || 0), 0);
      document.getElementById('remainTotal').innerHTML = `<b>К оплате: ${fmtMoney(total)}</b>`;
    };
    body.querySelectorAll('.cli-remain-chk').forEach(c => c.addEventListener('change', recalc));
    recalc();
    document.getElementById('remainOfferLink').addEventListener('click', e => { e.preventDefault(); openTerms(); });
    document.getElementById('remainSubmit').addEventListener('click', onRemainSubmit);
    m.hidden = false;
  }

  async function onRemainSubmit() {
    const btn = document.getElementById('remainSubmit');
    const result = document.getElementById('remainResult');
    const offerText = await preloadLegalDocuments();
    if (!offerText) {
      result.className = 'cli-ord-result is-err';
      result.textContent = 'Не удалось загрузить Публичную оферту. Обновите страницу и попробуйте ещё раз.';
      return;
    }
    const body = document.querySelector('[data-cli-remain-body]');
    const sel = [...body.querySelectorAll('.cli-remain-chk:checked')];
    if (!sel.length) { result.className = 'cli-ord-result is-err'; result.textContent = 'Выбери хотя бы одну анкету.'; return; }
    const items = sel.map(c => ({
      code: c.dataset.code,
      name: c.dataset.name,
      label: c.dataset.label,
      source_order_id: c.dataset.sourceOrderId || null,
      amount: Number(c.dataset.amount) || 0
    }))
      .filter(i => i.amount > 0);
    const total = items.reduce((s, i) => s + i.amount, 0);
    if (!items.length || total <= 0) { result.className = 'cli-ord-result is-err'; result.textContent = 'Нет суммы к оплате.'; return; }
    if (!document.getElementById('remainOffer').checked) {
      result.className = 'cli-ord-result is-err'; result.textContent = 'Подтверди принятие Публичной оферты.'; return;
    }
    if (!document.getElementById('remainPersonalData').checked) {
      result.className = 'cli-ord-result is-err'; result.textContent = 'Дай отдельное согласие на обработку персональных данных.'; return;
    }

    btn.disabled = true;
    btn.textContent = 'Создаю платёж…';
    const email = (Auth.email() || '').toLowerCase();
    const order = await submitOrder({
      client_email: email,
      client_name: Auth.name() || email,
      order_type: 'remainder',
      anketa_name: items.map(i => i.label || i.code).join(', '),
      items: items,
      amount: total,
      receipt_url: null,
      offer_agreed: true,
      offer_text: offerText,
      offer_version: OFFER_VERSION,
      personal_data_agreed: true,
      personal_data_consent_text: DATA_CONSENT_DEFAULT,
      personal_data_consent_version: CONSENT_VERSION,
      consent_user_agent: String(navigator.userAgent || '').slice(0, 1000)
    });
    if (order && order.id) {
      const opened = await startPayment(order.id, btn, result);
      if (!opened) loadMyOrders().then(o => { renderMyOrders(o); renderRemainder(_orderPayload, o); });
    } else {
      btn.disabled = false; btn.textContent = 'Перейти к оплате';
      result.className = 'cli-ord-result is-err';
      result.textContent = 'Не получилось создать доплату. Попробуй ещё раз или напиши менеджеру.';
    }
  }

  window.ClientApp = {
    requireLogin,
    preloadLegalDocuments,
    loadSnapshot,
    renderHeader,
    renderTotals,
    renderAnketas,
    renderFeed,
    renderCalendar,
    renderProfileDetail,
    renderProxies,
    renderOrder,
    renderRemainder,
    openRemainModal,
    closeRemainModal,
    loadMyOrders,
    renderMyOrders,
    handlePaymentReturn,
    openTerms,
    openDataConsent,
    closeTerms,
    fmtDate, fmtMoney, escapeHtml
  };
})();
