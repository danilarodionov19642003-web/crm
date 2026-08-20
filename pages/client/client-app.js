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
  const { Auth, accessToken, authFetch } = window.Supabase;
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
  function todayISO() {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }
  function daysSince(iso) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (!match) return 0;
    const start = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    const now = new Date();
    const current = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.max(0, Math.floor((current - start) / 86400000));
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
    try {
      if (Auth.ensureFresh) await Auth.ensureFresh();
      else if (!Auth.isLogged()) await Auth.refresh();
    } catch (_) {}
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

  async function loadMyPublicationRequests() {
    const token = accessToken();
    const email = (Auth.email() || '').toLowerCase();
    if (!token || !email) return [];
    try {
      const url = `${_url()}/rest/v1/client_publication_requests`
        + `?client_email=eq.${encodeURIComponent(email)}`
        + '&select=id,status_id,mentor_id,profile_id,status_date,requested_date,request_status,updated_at,resolved_at'
        + '&order=updated_at.desc';
      const res = await authFetch(url, {
        headers: { 'apikey': _key(), 'Accept': 'application/json' }
      });
      if (!res.ok) {
        console.warn('[client-app] publication requests load failed', res.status);
        return [];
      }
      return await res.json();
    } catch (error) {
      console.warn('[client-app] publication requests load error', error);
      return [];
    }
  }

  async function submitPublicationRequest(statusId, requestedDate) {
    try {
      const res = await authFetch(`${_url()}/rest/v1/rpc/request_client_publication_date`, {
        method: 'POST',
        headers: {
          'apikey': _key(),
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ p_status_id: statusId, p_requested_date: requestedDate })
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const raw = String(body.message || body.details || '');
        let message = 'Не удалось сохранить дату. Обновите страницу и попробуйте ещё раз.';
        if (raw.includes('DATE_OUT_OF_RANGE')) message = 'Выберите дату от сегодняшнего дня до ближайших шести месяцев.';
        else if (raw.includes('STATUS_NOT_AVAILABLE')) message = 'Статус аккаунта уже изменился. Обновите страницу.';
        else if (raw.includes('DATE_ALREADY_ACCEPTED')) message = 'Эта дата уже подтверждена менеджером.';
        return { ok: false, message };
      }
      return { ok: true, row: body };
    } catch (error) {
      console.warn('[client-app] publication request submit error', error);
      return { ok: false, message: 'Нет связи с сервером. Попробуйте ещё раз.' };
    }
  }

  async function loadMyOutreachSlots() {
    const token = accessToken();
    const email = (Auth.email() || '').toLowerCase();
    if (!token || !email) return null;
    try {
      const url = `${_url()}/rest/v1/client_outreach_slots`
        + `?client_email=eq.${encodeURIComponent(email)}`
        + '&select=id,mentor_id,anketa_code,anketa_name,scheduled_date,slot_status,source,updated_at'
        + '&order=scheduled_date.asc,id.asc';
      const res = await authFetch(url, {
        headers: { apikey: _key(), Accept: 'application/json' }
      });
      if (!res.ok) {
        console.warn('[client-app] outreach slots load failed', res.status);
        return null;
      }
      return await res.json();
    } catch (error) {
      console.warn('[client-app] outreach slots load error', error);
      return null;
    }
  }

  async function loadOutreachAvailability(fromDate, toDate) {
    try {
      const res = await authFetch(`${_url()}/rest/v1/rpc/get_client_outreach_calendar`, {
        method: 'POST',
        headers: { apikey: _key(), 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ p_from: fromDate, p_to: toDate })
      });
      if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
      return await res.json();
    } catch (error) {
      console.warn('[client-app] outreach availability load error', error);
      throw error;
    }
  }

  function outreachErrorMessage(rawError) {
    const raw = String(rawError && rawError.message || rawError || '');
    if (raw.includes('DAY_FULL')) return 'На этот день уже запланировано 7 откликов. Выберите другой.';
    if (raw.includes('NO_AVAILABLE_OUTREACH')) return 'Все доступные отклики этой анкеты уже запланированы или находятся в работе.';
    if (raw.includes('DATE_OUT_OF_RANGE')) return 'Можно выбрать дату от сегодняшнего дня до ближайших шести месяцев.';
    if (raw.includes('SLOT_NOT_FOUND')) return 'Этот отклик уже перенесён или отменён. Обновите страницу.';
    if (raw.includes('ANKETA_NOT_FOUND')) return 'Доступ к анкете изменился. Обновите страницу.';
    return 'Не удалось изменить план. Проверьте связь и попробуйте ещё раз.';
  }

  async function manageOutreachSlot(action, options = {}) {
    try {
      const res = await authFetch(`${_url()}/rest/v1/rpc/manage_client_outreach_slot`, {
        method: 'POST',
        headers: { apikey: _key(), 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          p_action: action,
          p_slot_id: options.slotId || null,
          p_mentor_id: options.mentorId || null,
          p_target_date: options.targetDate || null
        })
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(body.message || body.details || `HTTP ${res.status}`));
      return { ok: true, row: body };
    } catch (error) {
      console.warn('[client-app] outreach slot update error', error);
      return { ok: false, message: outreachErrorMessage(error) };
    }
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

  function _gatherEvents(snap, outreachSlots) {
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
      // Canonical rows are preferred. The snapshot schedule remains a fallback
      // while an old cached client page is being refreshed.
      const plannedRows = Array.isArray(outreachSlots)
        ? (() => {
            const grouped = new Map();
            outreachSlots
              .filter(row => row.slot_status === 'scheduled' && row.mentor_id === a.mentorId)
              .forEach(row => {
                const date = String(row.scheduled_date || '').slice(0, 10);
                if (date) grouped.set(date, (grouped.get(date) || 0) + 1);
              });
            return [...grouped].map(([date, count]) => ({ date, count }));
          })()
        : (a.schedule || []);
      plannedRows.forEach(p => {
        if (!p.date || !p.count) return;
        const d = String(p.date).slice(0, 10);
        const left = Math.max(0, +p.count || 0);
        if (left <= 0) return;
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

  function renderCalendar(snap, outreachSlots) {
    const el = document.querySelector('[data-cli-calendar]');
    if (!el || !snap) return;
    const events = _gatherEvents(snap, outreachSlots);
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
      calState.month = new Date(year, month - 1, 1); renderCalendar(snap, outreachSlots);
    });
    el.querySelector('[data-cal-next]').addEventListener('click', () => {
      calState.month = new Date(year, month + 1, 1); renderCalendar(snap, outreachSlots);
    });
    el.querySelector('[data-cal-today]').addEventListener('click', () => {
      const t = new Date();
      calState.month = new Date(t.getFullYear(), t.getMonth(), 1);
      calState.selected = t.toISOString().slice(0, 10);
      renderCalendar(snap, outreachSlots);
    });
    el.querySelectorAll('.cli-cal__cell[data-date]').forEach(b => {
      b.addEventListener('click', () => {
        calState.selected = b.dataset.date;
        renderCalendar(snap, outreachSlots);
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
        <h3 class="cli-section-title">Заказы по анкете</h3>
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

  let outreachPlannerState = null;
  const inlineOutreachMonths = new Map();

  function localISO(date) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function ensureOutreachPlannerModal() {
    let modal = document.getElementById('cliOutreachModal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.className = 'cli-modal';
    modal.id = 'cliOutreachModal';
    modal.hidden = true;
    modal.innerHTML = `
      <div class="cli-modal__backdrop" data-outreach-close></div>
      <div class="cli-modal__box cli-outreach-modal">
        <div class="cli-modal__head">
          <h3 data-outreach-title>Запланировать отклик</h3>
          <button class="cli-modal__x" type="button" data-outreach-close aria-label="Закрыть">✕</button>
        </div>
        <div class="cli-modal__body" data-outreach-body></div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelectorAll('[data-outreach-close]').forEach(button => {
      button.addEventListener('click', closeOutreachPlanner);
    });
    return modal;
  }

  function closeOutreachPlanner() {
    const modal = document.getElementById('cliOutreachModal');
    if (modal) modal.hidden = true;
    outreachPlannerState = null;
  }

  async function refreshProfileOutreach(context) {
    const refreshed = await loadMyOutreachSlots();
    const slots = Array.isArray(refreshed) ? refreshed : context.outreachSlots;
    renderProfileDetail(
      context.payload,
      context.mentorId,
      context.orders,
      context.publicationRequests,
      slots
    );
  }

  function profileOutreachMeta(context) {
    const anketa = ((context.payload && context.payload.anketas) || [])
      .find(item => item.mentorId === context.mentorId);
    const canonicalAvailable = Array.isArray(context.outreachSlots);
    const activeSlots = canonicalAvailable
      ? context.outreachSlots
          .filter(row => row.mentor_id === context.mentorId && row.slot_status === 'scheduled')
          .sort((left, right) => String(left.scheduled_date).localeCompare(String(right.scheduled_date)))
      : [];
    if (!anketa) return { anketa: null, canonicalAvailable, activeSlots, availableToAdd: 0 };
    const breakdown = _statusBreakdown(anketa.statuses);
    const ordered = Math.max(0, Number(anketa.ordered) || 0);
    const done = Math.max(Number(anketa.done) || 0, breakdown.done);
    const fallbackLimit = Math.max(0, ordered - done - breakdown.active);
    const limit = Number.isFinite(Number(anketa.scheduleLimit))
      ? Math.max(0, Number(anketa.scheduleLimit))
      : fallbackLimit;
    return {
      anketa,
      canonicalAvailable,
      activeSlots,
      availableToAdd: Math.max(0, limit - activeSlots.length)
    };
  }

  async function renderInlineOutreachCalendar(context) {
    const host = document.querySelector('[data-outreach-inline]');
    if (!host) return;
    const meta = profileOutreachMeta(context);
    if (!meta.anketa || !meta.canonicalAvailable) return;

    const storedMonth = inlineOutreachMonths.get(context.mentorId);
    const month = storedMonth instanceof Date && !isNaN(storedMonth.getTime())
      ? storedMonth
      : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    inlineOutreachMonths.set(context.mentorId, month);
    const year = month.getFullYear();
    const monthIndex = month.getMonth();
    const first = new Date(year, monthIndex, 1);
    const last = new Date(year, monthIndex + 1, 0);
    const requestId = `${Date.now()}-${Math.random()}`;
    host.dataset.requestId = requestId;
    host.innerHTML = '<div class="cli-empty cli-outreach-cal__loading">Проверяем свободные даты…</div>';

    let availability;
    try {
      availability = await loadOutreachAvailability(localISO(first), localISO(last));
    } catch (_) {
      if (host.dataset.requestId !== requestId || !host.isConnected) return;
      host.innerHTML = `
        <div class="cli-outreach-error">Не удалось загрузить свободные даты.</div>
        <button type="button" class="cli-outreach-primary" data-outreach-inline-retry>Повторить</button>`;
      host.querySelector('[data-outreach-inline-retry]').addEventListener('click', () => renderInlineOutreachCalendar(context));
      return;
    }
    if (host.dataset.requestId !== requestId || !host.isConnected) return;

    const byDate = new Map((availability || []).map(item => [
      String(item.schedule_date || '').slice(0, 10),
      {
        used: Math.max(0, Number(item.used_count) || 0),
        available: Math.max(0, Number(item.available_count) || 0)
      }
    ]));
    const ownByDate = new Map();
    meta.activeSlots.forEach(slot => {
      const date = String(slot.scheduled_date || '').slice(0, 10);
      if (!date) return;
      if (!ownByDate.has(date)) ownByDate.set(date, []);
      ownByDate.get(date).push(slot);
    });

    const today = todayISO();
    const maxDateObject = new Date();
    maxDateObject.setDate(maxDateObject.getDate() + 180);
    const maxDate = localISO(maxDateObject);
    const firstDow = (first.getDay() + 6) % 7;
    const cells = [];
    for (let index = 0; index < firstDow; index++) cells.push('<span class="cli-outreach-cal__empty"></span>');
    for (let day = 1; day <= last.getDate(); day++) {
      const date = localISO(new Date(year, monthIndex, day));
      const load = byDate.get(date) || { used: 0, available: 7 };
      const ownSlots = ownByDate.get(date) || [];
      const ownCount = ownSlots.length;
      const canAdd = date >= today && date <= maxDate && load.available > 0 && meta.availableToAdd > 0;
      const canToggle = ownCount > 0 || canAdd;
      const classes = [
        'cli-outreach-cal__day',
        ownCount ? 'is-owned' : '',
        load.available <= 0 && !ownCount ? 'is-full' : '',
        !canToggle ? 'is-disabled' : '',
        date === today ? 'is-today' : ''
      ].filter(Boolean).join(' ');
      const label = ownCount
        ? (ownCount === 1 ? 'ваш отклик' : `ваших: ${ownCount}`)
        : (load.available > 0 ? `свободно ${load.available}` : 'занято');
      const actionLabel = ownCount
        ? `Снять отклик на ${fmtDate(date)}`
        : `Запланировать отклик на ${fmtDate(date)}, свободно ${load.available} из 7`;
      cells.push(`
        <button type="button" class="${classes}" data-outreach-inline-date="${date}"
          aria-label="${escapeAttr(actionLabel)}"${canToggle ? '' : ' disabled'}>
          <strong>${day}</strong>
          <span>${label}</span>
        </button>`);
    }

    const monthLabel = first.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
    const minMonth = new Date();
    minMonth.setDate(1);
    minMonth.setHours(0, 0, 0, 0);
    const maxMonth = new Date(maxDateObject.getFullYear(), maxDateObject.getMonth(), 1);
    const canPrev = first > minMonth;
    const canNext = first < maxMonth;
    host.innerHTML = `
      <div class="cli-outreach-cal__nav">
        <button type="button" data-outreach-inline-prev${canPrev ? '' : ' disabled'} aria-label="Предыдущий месяц">‹</button>
        <strong>${escapeHtml(monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1))}</strong>
        <button type="button" data-outreach-inline-next${canNext ? '' : ' disabled'} aria-label="Следующий месяц">›</button>
      </div>
      <div class="cli-outreach-cal__weekdays"><span>Пн</span><span>Вт</span><span>Ср</span><span>Чт</span><span>Пт</span><span>Сб</span><span>Вс</span></div>
      <div class="cli-outreach-cal__grid">${cells.join('')}</div>
      <div class="cli-outreach-cal__legend"><span class="is-free">Свободно</span><span class="is-owned">Ваш отклик</span><span class="is-full">Занято</span></div>
      <div class="cli-outreach-cal__result" data-outreach-inline-result></div>`;

    host.querySelector('[data-outreach-inline-prev]').addEventListener('click', () => {
      inlineOutreachMonths.set(context.mentorId, new Date(year, monthIndex - 1, 1));
      renderInlineOutreachCalendar(context);
    });
    host.querySelector('[data-outreach-inline-next]').addEventListener('click', () => {
      inlineOutreachMonths.set(context.mentorId, new Date(year, monthIndex + 1, 1));
      renderInlineOutreachCalendar(context);
    });
    host.querySelectorAll('[data-outreach-inline-date]:not([disabled])').forEach(button => {
      button.addEventListener('click', async () => {
        const date = button.dataset.outreachInlineDate;
        const ownSlots = ownByDate.get(date) || [];
        const action = ownSlots.length ? 'cancel' : 'add';
        const result = host.querySelector('[data-outreach-inline-result]');
        host.querySelectorAll('button').forEach(item => { item.disabled = true; });
        result.className = 'cli-outreach-cal__result is-pending';
        result.textContent = action === 'cancel' ? 'Снимаем отклик…' : 'Добавляем отклик…';
        const response = await manageOutreachSlot(action, {
          slotId: ownSlots[0] && ownSlots[0].id,
          mentorId: context.mentorId,
          targetDate: date
        });
        if (!response.ok) {
          alert(response.message);
          await renderInlineOutreachCalendar(context);
          return;
        }
        await refreshProfileOutreach(context);
      });
    });
  }

  async function renderOutreachPlannerCalendar() {
    const state = outreachPlannerState;
    const modal = ensureOutreachPlannerModal();
    const body = modal.querySelector('[data-outreach-body]');
    if (!state || !body) return;

    const year = state.month.getFullYear();
    const month = state.month.getMonth();
    const first = new Date(year, month, 1);
    const last = new Date(year, month + 1, 0);
    const from = localISO(first);
    const to = localISO(last);
    body.innerHTML = '<div class="cli-empty">Проверяем свободные даты…</div>';

    let availability;
    try {
      availability = await loadOutreachAvailability(from, to);
    } catch (_) {
      if (outreachPlannerState !== state) return;
      body.innerHTML = `
        <div class="cli-outreach-error">Не удалось загрузить календарь.</div>
        <button type="button" class="cli-outreach-primary" data-outreach-retry>Повторить</button>`;
      body.querySelector('[data-outreach-retry]').addEventListener('click', renderOutreachPlannerCalendar);
      return;
    }
    if (outreachPlannerState !== state) return;

    const byDate = new Map((availability || []).map(item => [
      String(item.schedule_date || '').slice(0, 10),
      {
        used: Math.max(0, Number(item.used_count) || 0),
        available: Math.max(0, Number(item.available_count) || 0)
      }
    ]));
    const today = todayISO();
    const maxDateObject = new Date();
    maxDateObject.setDate(maxDateObject.getDate() + 180);
    const maxDate = localISO(maxDateObject);
    const currentSlotDate = state.slot ? String(state.slot.scheduled_date || '').slice(0, 10) : '';
    const firstDow = (first.getDay() + 6) % 7;
    const cells = [];
    for (let index = 0; index < firstDow; index++) cells.push('<span class="cli-outreach-cal__empty"></span>');
    for (let day = 1; day <= last.getDate(); day++) {
      const date = localISO(new Date(year, month, day));
      const load = byDate.get(date) || { used: 0, available: 7 };
      const disabled = date < today || date > maxDate || load.available <= 0 || date === currentSlotDate;
      const classes = [
        'cli-outreach-cal__day',
        disabled ? 'is-disabled' : '',
        load.available <= 0 ? 'is-full' : '',
        date === state.selectedDate ? 'is-selected' : '',
        date === today ? 'is-today' : ''
      ].filter(Boolean).join(' ');
      cells.push(`
        <button type="button" class="${classes}" data-outreach-date="${date}"${disabled ? ' disabled' : ''}>
          <strong>${day}</strong>
          <span>${load.available > 0 ? `${load.available} из 7` : 'мест нет'}</span>
        </button>`);
    }

    const monthLabel = first.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
    const minMonth = new Date();
    minMonth.setDate(1);
    minMonth.setHours(0, 0, 0, 0);
    const maxMonth = new Date(maxDateObject.getFullYear(), maxDateObject.getMonth(), 1);
    const canPrev = first > minMonth;
    const canNext = first < maxMonth;
    body.innerHTML = `
      <div class="cli-outreach-cal__nav">
        <button type="button" data-outreach-prev${canPrev ? '' : ' disabled'} aria-label="Предыдущий месяц">‹</button>
        <strong>${escapeHtml(monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1))}</strong>
        <button type="button" data-outreach-next${canNext ? '' : ' disabled'} aria-label="Следующий месяц">›</button>
      </div>
      <div class="cli-outreach-cal__weekdays"><span>Пн</span><span>Вт</span><span>Ср</span><span>Чт</span><span>Пт</span><span>Сб</span><span>Вс</span></div>
      <div class="cli-outreach-cal__grid">${cells.join('')}</div>
      <div class="cli-outreach-cal__footer">
        <span data-outreach-result>${state.selectedDate ? `Выбрано: ${fmtDate(state.selectedDate)}` : 'Выберите свободный день'}</span>
        <button type="button" class="cli-outreach-primary" data-outreach-save${state.selectedDate ? '' : ' disabled'}>${state.mode === 'move' ? 'Перенести' : 'Запланировать'}</button>
      </div>`;

    body.querySelector('[data-outreach-prev]').addEventListener('click', () => {
      state.month = new Date(year, month - 1, 1);
      state.selectedDate = '';
      renderOutreachPlannerCalendar();
    });
    body.querySelector('[data-outreach-next]').addEventListener('click', () => {
      state.month = new Date(year, month + 1, 1);
      state.selectedDate = '';
      renderOutreachPlannerCalendar();
    });
    body.querySelectorAll('[data-outreach-date]:not([disabled])').forEach(button => {
      button.addEventListener('click', () => {
        state.selectedDate = button.dataset.outreachDate;
        body.querySelectorAll('[data-outreach-date]').forEach(item => item.classList.toggle('is-selected', item === button));
        body.querySelector('[data-outreach-result]').textContent = `Выбрано: ${fmtDate(state.selectedDate)}`;
        body.querySelector('[data-outreach-save]').disabled = false;
      });
    });
    body.querySelector('[data-outreach-save]').addEventListener('click', async event => {
      if (!state.selectedDate) return;
      const button = event.currentTarget;
      const result = body.querySelector('[data-outreach-result]');
      button.disabled = true;
      button.textContent = 'Сохраняем…';
      const response = await manageOutreachSlot(state.mode, {
        slotId: state.slot && state.slot.id,
        mentorId: state.context.mentorId,
        targetDate: state.selectedDate
      });
      if (!response.ok) {
        button.disabled = false;
        button.textContent = state.mode === 'move' ? 'Перенести' : 'Запланировать';
        result.className = 'cli-outreach-error';
        result.textContent = response.message;
        return;
      }
      const context = state.context;
      closeOutreachPlanner();
      await refreshProfileOutreach(context);
    });
  }

  function openOutreachPlanner(context, mode, slot) {
    const modal = ensureOutreachPlannerModal();
    const anchor = slot && slot.scheduled_date ? new Date(`${slot.scheduled_date}T12:00:00`) : new Date();
    outreachPlannerState = {
      context,
      mode,
      slot: slot || null,
      month: new Date(anchor.getFullYear(), anchor.getMonth(), 1),
      selectedDate: ''
    };
    modal.querySelector('[data-outreach-title]').textContent = mode === 'move'
      ? 'Перенести отклик'
      : 'Запланировать отклик';
    modal.hidden = false;
    renderOutreachPlannerCalendar();
  }

  function outreachPlannerHtml(anketa, outreachSlots, fallbackLimit) {
    const canonicalAvailable = Array.isArray(outreachSlots);
    let activeSlots;
    if (canonicalAvailable) {
      activeSlots = outreachSlots
        .filter(row => row.mentor_id === anketa.mentorId && row.slot_status === 'scheduled')
        .sort((left, right) => String(left.scheduled_date).localeCompare(String(right.scheduled_date)));
    } else {
      activeSlots = [];
      (anketa.schedule || []).forEach((item, itemIndex) => {
        for (let index = 0; index < Math.max(0, Number(item.count) || 0); index++) {
          activeSlots.push({ id: null, scheduled_date: item.date, mentor_id: anketa.mentorId, legacyKey: `${itemIndex}-${index}` });
        }
      });
    }
    const limit = Number.isFinite(Number(anketa.scheduleLimit))
      ? Math.max(0, Number(anketa.scheduleLimit))
      : Math.max(0, Number(fallbackLimit) || 0);
    const availableToAdd = Math.max(0, limit - activeSlots.length);
    const rowsHtml = activeSlots.length
      ? activeSlots.map(slot => `
          <div class="cli-outreach-row">
            <span class="cli-outreach-row__date">${fmtDate(slot.scheduled_date)}</span>
            <span class="cli-outreach-row__state">Запланирован</span>
            <div class="cli-outreach-row__actions">
              <button type="button" data-outreach-move="${escapeAttr(slot.id || '')}"${slot.id ? '' : ' disabled'}>Перенести</button>
              <button type="button" data-outreach-cancel="${escapeAttr(slot.id || '')}"${slot.id ? '' : ' disabled'}>Отменить</button>
            </div>
          </div>`).join('')
      : '<div class="cli-empty cli-outreach-empty">Запланированных откликов пока нет.</div>';
    return `
      <section class="cli-outreach" data-outreach-section>
        <div class="cli-outreach__head">
          <div>
            <h3>План откликов</h3>
            <span>${activeSlots.length} запланировано · до 7 в день</span>
          </div>
          <button type="button" class="cli-outreach-primary" data-outreach-add${canonicalAvailable && availableToAdd > 0 ? '' : ' disabled'}>+ Запланировать</button>
        </div>
        <div class="cli-outreach__body">
          <div class="cli-outreach__agenda">
            <div class="cli-outreach__list">${rowsHtml}</div>
            ${canonicalAvailable && availableToAdd <= 0 ? '<div class="cli-outreach__limit">Все доступные отклики уже распределены.</div>' : ''}
            ${!canonicalAvailable ? '<div class="cli-outreach-error">План временно доступен только для просмотра. Обновите страницу.</div>' : ''}
          </div>
          <div class="cli-outreach__calendar" data-outreach-inline>
            ${canonicalAvailable
              ? '<div class="cli-empty cli-outreach-cal__loading">Проверяем свободные даты…</div>'
              : '<div class="cli-empty">Календарь временно недоступен.</div>'}
          </div>
        </div>
      </section>`;
  }

  function renderProfileDetail(payload, mentorId, orders, publicationRequests, outreachSlots) {
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
    const outreachContext = { payload, mentorId, orders, publicationRequests, outreachSlots };
    const outreachHtml = outreachPlannerHtml(
      a,
      outreachSlots,
      Math.max(0, ordered - effectiveDone - br.active)
    );
    const requestsByStatus = new Map();
    (publicationRequests || []).forEach(request => {
      if (!requestsByStatus.has(request.status_id)) requestsByStatus.set(request.status_id, request);
    });
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
    const requestForStatus = status => {
      const stored = requestsByStatus.get(status.id);
      return stored && String(stored.status_date || '').slice(0, 10) === String(status.date || '').slice(0, 10)
        ? stored
        : null;
    };
    const publicationControl = status => {
      if (status.status !== '🏆 Выбран' || !status.id) return '<span class="cli-pub-empty">—</span>';
      const request = requestForStatus(status);
      if (request && request.request_status === 'accepted') {
        return `<div class="cli-pub-confirmed"><strong>${fmtDate(request.requested_date)}</strong><span>Подтверждено</span></div>`;
      }
      const value = request && request.request_status === 'pending'
        ? String(request.requested_date || '').slice(0, 10)
        : '';
      const state = request && request.request_status === 'pending'
        ? '<span class="cli-pub-state is-pending">Ожидает подтверждения</span>'
        : (request && request.request_status === 'rejected'
            ? '<span class="cli-pub-state is-rejected">Выберите другую дату</span>'
            : '<span class="cli-pub-state" data-publication-result></span>');
      return `
        <div class="cli-pub-control" data-publication-status="${escapeAttr(status.id)}">
          <div class="cli-pub-actions">
            <input type="date" class="cli-pub-date" min="${todayISO()}" value="${escapeAttr(value)}" aria-label="Дата публикации"/>
            <button type="button" class="cli-pub-submit" data-publication-submit>${value ? 'Изменить' : 'Запланировать'}</button>
          </div>
          ${state}
        </div>`;
    };
    const publicationSummary = status => {
      if (status.status !== '🏆 Выбран' || !status.id) return '';
      const request = requestForStatus(status);
      if (!request) return '<span class="cli-status-mobile__request">Дата не выбрана</span>';
      if (request.request_status === 'accepted') {
        return `<span class="cli-status-mobile__request is-accepted">${fmtDate(request.requested_date)}</span>`;
      }
      if (request.request_status === 'pending') {
        return `<span class="cli-status-mobile__request is-pending">${fmtDate(request.requested_date)} · на проверке</span>`;
      }
      if (request.request_status === 'rejected') {
        return '<span class="cli-status-mobile__request is-rejected">Выбрать другую дату</span>';
      }
      return '';
    };
    const statusesHtml = a.statuses && a.statuses.length ? `
      <h3 class="cli-section-title">Аккаунты в работе</h3>
      <div class="cli-table-wrap">
      <table class="cli-table cli-status-table">
        <thead><tr><th>Аккаунт</th><th>Статус</th><th>Обновлён</th><th>В статусе</th><th>Публикация</th></tr></thead>
        <tbody>${a.statuses.map(s => `
          <tr>
            <td data-label="Аккаунт"><strong>${escapeHtml(s.profileName || '—')}</strong></td>
            <td data-label="Статус"><span class="cli-status-pill">${escapeHtml(s.status || '')}</span></td>
            <td data-label="Обновлён">${fmtDate(s.date)}</td>
            <td data-label="В статусе"><span class="cli-status-days"><strong>${daysSince(s.date)}</strong> дн.</span></td>
            <td data-label="Публикация">${publicationControl(s)}</td>
          </tr>
        `).join('')}</tbody>
      </table>
      </div>
      <div class="cli-status-mobile">
        ${a.statuses.map(s => `
          <details class="cli-status-mobile__item"${requestForStatus(s) && requestForStatus(s).request_status === 'rejected' ? ' open' : ''}>
            <summary class="cli-status-mobile__summary">
              <span class="cli-status-mobile__identity">
                <strong>${escapeHtml(s.profileName || '—')}</strong>
                <span class="cli-status-pill">${escapeHtml(s.status || '')}</span>
              </span>
              <span class="cli-status-mobile__meta">
                <span class="cli-status-days"><strong>${daysSince(s.date)}</strong> дн.</span>
                ${publicationSummary(s)}
              </span>
            </summary>
            <div class="cli-status-mobile__body">
              <div class="cli-status-mobile__fact">
                <span>Статус обновлён</span>
                <strong>${fmtDate(s.date)}</strong>
              </div>
              <div class="cli-status-mobile__publication">
                <span>Дата публикации</span>
                ${publicationControl(s)}
              </div>
            </div>
          </details>
        `).join('')}
      </div>
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
      ${outreachHtml}
      ${packagesHtml}
      ${statusesHtml}
      ${paymentsHtml}
      ${reviewsHtml}
    `;

    root.querySelectorAll('[data-publication-submit]').forEach(button => {
      button.addEventListener('click', async () => {
        const control = button.closest('[data-publication-status]');
        const input = control && control.querySelector('.cli-pub-date');
        const result = control && control.querySelector('[data-publication-result], .cli-pub-state');
        const date = input && input.value;
        if (!date || date < todayISO()) {
          if (result) {
            result.className = 'cli-pub-state is-rejected';
            result.textContent = 'Выберите сегодняшнюю или будущую дату';
          }
          return;
        }
        button.disabled = true;
        button.textContent = 'Сохраняю…';
        const response = await submitPublicationRequest(control.dataset.publicationStatus, date);
        if (!response.ok) {
          button.disabled = false;
          button.textContent = 'Запланировать';
          if (result) {
            result.className = 'cli-pub-state is-rejected';
            result.textContent = response.message;
          }
          return;
        }
        const updatedRequests = await loadMyPublicationRequests();
        renderProfileDetail(payload, mentorId, orders, updatedRequests, outreachSlots);
      });
    });

    const activeOutreachSlots = Array.isArray(outreachSlots)
      ? outreachSlots.filter(row => row.mentor_id === mentorId && row.slot_status === 'scheduled')
      : [];
    const slotsById = new Map(activeOutreachSlots.map(row => [String(row.id), row]));
    const addOutreach = root.querySelector('[data-outreach-add]');
    if (addOutreach && !addOutreach.disabled) {
      addOutreach.addEventListener('click', () => openOutreachPlanner(outreachContext, 'add', null));
    }
    root.querySelectorAll('[data-outreach-move]').forEach(button => {
      button.addEventListener('click', () => {
        const slot = slotsById.get(button.dataset.outreachMove);
        if (slot) openOutreachPlanner(outreachContext, 'move', slot);
      });
    });
    root.querySelectorAll('[data-outreach-cancel]').forEach(button => {
      button.addEventListener('click', async () => {
        const slot = slotsById.get(button.dataset.outreachCancel);
        if (!slot || !confirm(`Отменить отклик на ${fmtDate(slot.scheduled_date)}?`)) return;
        button.disabled = true;
        const response = await manageOutreachSlot('cancel', { slotId: slot.id });
        if (!response.ok) {
          button.disabled = false;
          alert(response.message);
          return;
        }
        await refreshProfileOutreach(outreachContext);
      });
    });
    renderInlineOutreachCalendar(outreachContext);
  }

  function escapeAttr(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  /* ====================================================================
     Заказ отзывов (самообслуживание оплаты).
     Клиент выбирает существующую анкету + тариф и жмёт
     «Перейти к оплате» → INSERT в client_orders (RLS: только свой email),
     затем backend создаёт платёж RollyPay и возвращает pay_url.
     Триггер в БД пингует владельца в Telegram. Тарифы приходят в
     snapshot.payload.payment (владелец задаёт их в CRM).
     ==================================================================== */
  let _orderPayload = null;   // последний snap.payload (anketas + payment)
  const PAYMENTS_API = 'https://mentori.tech/api/payments';
  const RECEIPT_EXTENSIONS = {
    'application/pdf': 'pdf',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif'
  };
  const RECEIPT_MIME_TYPES = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    heic: 'image/heic',
    heif: 'image/heif'
  };

  function receiptExtension(file) {
    const mime = String((file && file.type) || '').trim().toLowerCase();
    if (RECEIPT_EXTENSIONS[mime]) return RECEIPT_EXTENSIONS[mime];
    const match = String((file && file.name) || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    const ext = match ? match[1] : '';
    if (ext === 'jpeg') return 'jpg';
    return ['pdf', 'jpg', 'png', 'webp', 'heic', 'heif'].includes(ext) ? ext : '';
  }

  async function uploadReceipt(file) {
    const ext = receiptExtension(file);
    if (!ext) throw new Error('Unsupported receipt format');
    const userId = String((Auth.user() || {}).id || '').trim();
    if (!userId) throw new Error('Authentication required');
    const uuid = window.crypto && typeof window.crypto.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const objectPath = `${userId}/${uuid}.${ext}`;
    const encodedPath = objectPath.split('/').map(encodeURIComponent).join('/');
    const mime = RECEIPT_MIME_TYPES[ext];
    const response = await fetch(`${_url()}/storage/v1/object/receipts/${encodedPath}`, {
      method: 'POST',
      headers: {
        'apikey': _key(),
        'Authorization': `Bearer ${accessToken()}`,
        'Content-Type': mime,
        'x-upsert': 'false'
      },
      body: file
    });
    if (!response.ok) {
      const details = await response.text().catch(() => '');
      throw new Error(`Receipt upload failed (${response.status}): ${details.slice(0, 300)}`);
    }
    return `storage://receipts/${objectPath}`;
  }

  function receiptObjectPath(reference) {
    const value = String(reference || '').trim();
    const privatePrefix = 'storage://receipts/';
    if (value.startsWith(privatePrefix)) return value.slice(privatePrefix.length);
    const publicMarker = '/storage/v1/object/public/receipts/';
    const authenticatedMarker = '/storage/v1/object/authenticated/receipts/';
    const marker = value.includes(publicMarker) ? publicMarker
      : value.includes(authenticatedMarker) ? authenticatedMarker : '';
    if (!marker) return '';
    const encoded = value.slice(value.indexOf(marker) + marker.length).split(/[?#]/, 1)[0];
    try { return decodeURIComponent(encoded); } catch (_) { return encoded; }
  }

  async function receiptSignedUrl(reference) {
    const objectPath = receiptObjectPath(reference);
    if (!objectPath) throw new Error('Receipt path is invalid');
    const encodedPath = objectPath.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(`${_url()}/storage/v1/object/sign/receipts/${encodedPath}`, {
      method: 'POST',
      headers: {
        'apikey': _key(),
        'Authorization': `Bearer ${accessToken()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ expiresIn: 300 })
    });
    if (!response.ok) throw new Error(`Receipt access failed (${response.status})`);
    const payload = await response.json();
    const signed = String(payload.signedURL || payload.signedUrl || '');
    if (!signed) throw new Error('Receipt link is missing');
    if (/^https?:\/\//i.test(signed)) return signed;
    if (signed.startsWith('/storage/v1/')) return `${_url()}${signed}`;
    return `${_url()}/storage/v1${signed.startsWith('/') ? '' : '/'}${signed}`;
  }

  async function openReceipt(reference) {
    const popup = window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    try {
      const url = await receiptSignedUrl(reference);
      if (!popup) throw new Error('Popup blocked');
      popup.location.replace(url);
    } catch (error) {
      if (popup) popup.close();
      throw error;
    }
  }

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
    const anketas = (payload && payload.anketas) || [];
    if (!tariffs.length || !anketas.length) { cta.hidden = true; return; }
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

  function _tariffOptionHtml(t, index) {
    const label = t.unit === 'per'
      ? `${t.name || 'Тариф'} — ${Number(t.price || 0).toLocaleString('ru-RU')} ₽/шт (от ${Number(t.qty) || 1})`
      : `${t.name || 'Тариф'}${t.qty ? ' · ' + t.qty + ' отзывов' : ''}${t.price ? ' — ' + Number(t.price).toLocaleString('ru-RU') + ' ₽' : ''}`;
    return `<option value="${index}">${escapeHtml(label)}</option>`;
  }

  function _requisiteRows(requisites) {
    const source = (requisites && typeof requisites === 'object') ? requisites : {};
    return [
      ['Телефон СБП', source.sbpPhone],
      ['Банк', source.bank],
      ['Карта', source.card],
      ['Получатель', source.recipient],
      ['Примечание', source.note]
    ].filter(([, value]) => String(value || '').trim());
  }

  function _requisitesHtml(requisites) {
    return _requisiteRows(requisites).map(([label, value]) => `
      <div class="cli-req-row">
        <div><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></div>
        <button type="button" class="cli-req-row__copy" data-copy="${escapeAttr(value)}" title="Скопировать">Копировать</button>
      </div>`).join('');
  }

  function _orderPackageHtml(index, tariffs, anketas, suggestedIndex) {
    return `
      <section class="cli-cart-item" data-order-item>
        <div class="cli-cart-item__head">
          <strong data-order-item-title>Заказ ${index + 1}</strong>
          <button type="button" class="cli-cart-item__remove" data-order-remove title="Убрать из заказа" aria-label="Убрать из заказа">×</button>
        </div>
        <label class="cli-cart-control">
          <span>Анкета</span>
          <select class="cli-ord-input" data-order-existing>
            ${anketas.map((a, i) => `<option value="${i}" ${i === suggestedIndex ? 'selected' : ''}>${escapeHtml(a.code || '')}${a.name ? ' · ' + escapeHtml(a.name) : ''}</option>`).join('')}
          </select>
        </label>
        <div class="cli-cart-grid">
          <label class="cli-cart-control">
            <span>Тариф</span>
            <select class="cli-ord-input" data-order-tariff>${tariffs.map(_tariffOptionHtml).join('')}</select>
          </label>
          <label class="cli-cart-control" data-order-qty-wrap hidden>
            <span>Количество отзывов</span>
            <input type="number" class="cli-ord-input" data-order-qty min="1" max="500" step="1" inputmode="numeric"/>
            <small class="cli-cart-control__error" data-order-qty-error hidden></small>
          </label>
        </div>
        <div class="cli-cart-item__sum" data-order-item-sum></div>
      </section>`;
  }

  function openOrderModal() {
    const m = document.getElementById('cliOrderModal');
    const body = document.querySelector('[data-cli-order-body]');
    if (!m || !body || !_orderPayload) return;
    const tariffs = ((_orderPayload.payment || {}).tariffs || []);
    const payment = _orderPayload.payment || {};
    const requisites = payment.requisites || {};
    const requisiteRows = _requisiteRows(requisites);
    const manualEnabled = requisiteRows.some(([label]) => label === 'Телефон СБП' || label === 'Карта');
    const anketas = _orderPayload.anketas || [];
    const cart = window.MentoriOrderCart;
    if (!cart || !tariffs.length) return;

    if (!anketas.length) return;
    body.innerHTML = `
      <div class="cli-cart-list" data-order-list></div>
      <button type="button" class="cli-cart-add" data-order-add><span aria-hidden="true">+</span> Добавить отзывы для другой анкеты</button>
      <div class="cli-ord-field cli-cart-payment">
        <div class="cli-ord-label">Способ оплаты</div>
        <div class="cli-cart-target">
          <label class="cli-cart-target__option"><input type="radio" name="ordMethod" value="online" checked/><span>Онлайн: СБП или крипта</span></label>
          <label class="cli-cart-target__option"><input type="radio" name="ordMethod" value="card_transfer" ${manualEnabled ? '' : 'disabled'}/><span>Перевод · скидка 300 ₽</span></label>
        </div>
      </div>
      <div class="cli-ord-amount cli-cart-total" id="ordAmount"></div>
      <div class="cli-manual-payment" data-manual-payment hidden>
        <div class="cli-ord-label">Реквизиты для перевода</div>
        <div class="cli-requisites">${_requisitesHtml(requisites)}</div>
        <label class="cli-cart-control">
          <span>Чек об оплате</span>
          <input type="file" class="cli-ord-file" id="ordReceipt" accept="image/*,application/pdf"/>
        </label>
      </div>
      <div class="cli-ord-field">
        <div class="cli-ord-label">Комментарий <span class="muted">(необязательно)</span></div>
        <textarea class="cli-ord-input" id="ordComment" rows="2" maxlength="1000" placeholder="Общие пожелания по заказу"></textarea>
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
      <button type="button" class="cli-ord-submit" id="ordSubmit">Перейти к оплате</button>`;

    const list = body.querySelector('[data-order-list]');
    const addButton = body.querySelector('[data-order-add]');
    const isCartFull = () => false;
    const maxOrderItems = Math.min(cart.MAX_ITEMS, anketas.length);
    const isManualTransfer = () => (body.querySelector('input[name="ordMethod"]:checked') || {}).value === 'card_transfer';
    const rowTariff = row => tariffs[Number(row.querySelector('[data-order-tariff]').value) || 0] || {};
    const nextSuggestedAnketa = () => {
      const used = new Set([...list.querySelectorAll('[data-order-item]')]
        .map(row => Number(row.querySelector('[data-order-existing]').value)));
      const free = anketas.findIndex((_, index) => !used.has(index));
      return free >= 0 ? free : 0;
    };
    const recalc = () => {
      const rows = [...list.querySelectorAll('[data-order-item]')];
      const priced = rows.map(row => {
        const tariff = rowTariff(row);
        const qtyWrap = row.querySelector('[data-order-qty-wrap]');
        const qtyInput = row.querySelector('[data-order-qty]');
        const tariffKey = `${tariff.id || tariff.name || ''}:${tariff.unit || ''}:${tariff.qty || ''}`;
        const tariffChanged = qtyInput.dataset.tariffKey !== tariffKey;
        qtyInput.dataset.tariffKey = tariffKey;
        qtyWrap.hidden = tariff.unit !== 'per';
        if (tariff.unit === 'per') {
          qtyInput.min = Math.max(1, Number(tariff.qty) || 1);
          if (tariffChanged) qtyInput.value = qtyInput.min;
        }
        return { row, tariff, qty: qtyInput.value };
      });
      const summary = cart.summarize(
        priced,
        isCartFull(),
        isManualTransfer() ? (Number(payment.manualTransferDiscount) || cart.MANUAL_TRANSFER_DISCOUNT) : 0
      );
      let hasInvalidQuantity = false;
      summary.items.forEach(entry => {
        const qtyInput = entry.row.querySelector('[data-order-qty]');
        const qtyError = entry.row.querySelector('[data-order-qty-error]');
        const validation = cart.validateQuantity(entry.tariff, qtyInput.value);
        const invalid = entry.tariff.unit === 'per' && !validation.valid;
        hasInvalidQuantity = hasInvalidQuantity || invalid;
        qtyInput.classList.toggle('is-invalid', invalid);
        qtyInput.setAttribute('aria-invalid', invalid ? 'true' : 'false');
        qtyError.hidden = !invalid;
        qtyError.textContent = invalid ? validation.message : '';
        entry.row.querySelector('[data-order-item-sum]').textContent = invalid
          ? 'Укажите допустимое количество, чтобы рассчитать оплату.'
          : `Стоимость: ${fmtMoney(entry.pricing.amount)} · к оплате ${fmtMoney(entry.pricing.prepayAmount)}`
            + (entry.pricing.discountAmount ? ` · скидка ${fmtMoney(entry.pricing.discountAmount)}` : '')
            + (entry.pricing.remainder ? ` · остаток ${fmtMoney(entry.pricing.remainder)}` : '');
      });
      const amountEl = document.getElementById('ordAmount');
      amountEl.innerHTML = hasInvalidQuantity
        ? '<b class="cli-cart-quantity-warning">Исправьте количество отзывов. Оплата пока недоступна.</b>'
        : `<span>Стоимость отзывов: ${fmtMoney(summary.baseAmount)}</span>`
          + (summary.discount ? `<span class="cli-cart-discount">Скидка за перевод: −${fmtMoney(summary.discount)}</span>` : '')
          + (summary.discount ? `<span>Стоимость со скидкой: ${fmtMoney(summary.amount)}</span>` : '')
          + `<b>К оплате сейчас: ${fmtMoney(summary.prepayAmount)}</b>`
          + (summary.remainder ? `<small>Остаток после выполнения: ${fmtMoney(summary.remainder)}</small>` : '');
      const manualBlock = body.querySelector('[data-manual-payment]');
      if (manualBlock) manualBlock.hidden = !isManualTransfer();
      const submit = document.getElementById('ordSubmit');
      if (submit) {
        submit.textContent = isManualTransfer() ? 'Отправить чек на проверку' : 'Перейти к оплате';
        submit.disabled = hasInvalidQuantity;
      }
      rows.forEach((row, index) => {
        row.querySelector('[data-order-item-title]').textContent = `Заказ ${index + 1}`;
        row.querySelector('[data-order-remove]').hidden = rows.length === 1;
      });
      addButton.disabled = rows.length >= maxOrderItems;
      addButton.title = addButton.disabled ? 'Все доступные анкеты уже добавлены' : '';
    };
    const addRow = () => {
      const count = list.querySelectorAll('[data-order-item]').length;
      if (count >= maxOrderItems) return;
      list.insertAdjacentHTML('beforeend', _orderPackageHtml(count, tariffs, anketas, nextSuggestedAnketa()));
      recalc();
    };

    list.addEventListener('change', event => {
      const row = event.target.closest('[data-order-item]');
      if (!row) return;
      recalc();
    });
    list.addEventListener('input', recalc);
    list.addEventListener('click', event => {
      const remove = event.target.closest('[data-order-remove]');
      if (!remove) return;
      remove.closest('[data-order-item]').remove();
      recalc();
    });
    addButton.addEventListener('click', addRow);
    body.querySelectorAll('input[name="ordMethod"]').forEach(input => input.addEventListener('change', recalc));
    body.querySelectorAll('.cli-req-row__copy').forEach(button => {
      button.addEventListener('click', async () => {
        const value = button.dataset.copy || '';
        try {
          await navigator.clipboard.writeText(value);
          const original = button.textContent;
          button.textContent = 'Скопировано';
          setTimeout(() => { button.textContent = original; }, 1200);
        } catch (_) {
          button.textContent = 'Скопируй вручную';
        }
      });
    });
    document.getElementById('ordOfferLink').addEventListener('click', event => { event.preventDefault(); openTerms(); });
    document.getElementById('ordSubmit').addEventListener('click', () => {
      onOrderSubmit().catch(error => {
        console.error('[client-app] unexpected order submit error', error);
        const submit = document.getElementById('ordSubmit');
        const result = document.getElementById('ordResult');
        if (submit) {
          submit.disabled = false;
          submit.textContent = isManualTransfer() ? 'Отправить чек на проверку' : 'Перейти к оплате';
        }
        if (result) {
          result.className = 'cli-ord-result is-err';
          result.textContent = 'Не получилось отправить заказ. Обнови страницу и попробуй ещё раз.';
        }
      });
    });
    addRow();
    m.hidden = false;
    document.body.classList.add('cli-modal-open');
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
    const tariffs = ((_orderPayload && _orderPayload.payment) || {}).tariffs || [];
    const anketas = (_orderPayload && _orderPayload.anketas) || [];
    const cart = window.MentoriOrderCart;
    const rows = [...document.querySelectorAll('[data-order-list] [data-order-item]')];
    const comment = (document.getElementById('ordComment').value || '').trim();
    const pay_full = false;
    const payment_method = (document.querySelector('input[name="ordMethod"]:checked') || {}).value === 'card_transfer'
      ? 'card_transfer'
      : 'online';
    if (!cart || !rows.length || rows.length > cart.MAX_ITEMS) {
      result.className = 'cli-ord-result is-err';
      result.textContent = 'Выбери хотя бы одну анкету.';
      return;
    }

    const items = [];
    const selectedAnketas = new Set();
    for (const row of rows) {
      const tariff = tariffs[Number(row.querySelector('[data-order-tariff]').value) || 0] || {};
      if (!tariff.name) {
        result.className = 'cli-ord-result is-err'; result.textContent = 'Выбери тариф для каждой анкеты.'; return;
      }
      const selected = anketas[Number(row.querySelector('[data-order-existing]').value) || 0];
      if (!selected) {
        result.className = 'cli-ord-result is-err'; result.textContent = 'Выбери анкету для каждого заказа.'; return;
      }
      const anketa_code = selected.code || '';
      const anketa_name = selected.name || selected.code || '';
      const anketaKey = String(anketa_code || anketa_name).trim().toLowerCase();
      if (selectedAnketas.has(anketaKey)) {
        result.className = 'cli-ord-result is-err';
        result.textContent = 'Одна анкета добавлена в заказ дважды.';
        return;
      }
      selectedAnketas.add(anketaKey);
      const pricing = cart.priceItem(tariff, Number(row.querySelector('[data-order-qty]').value) || 0, pay_full);
      const quantityValidation = cart.validateQuantity(tariff, row.querySelector('[data-order-qty]').value);
      if (!quantityValidation.valid) {
        const qtyInput = row.querySelector('[data-order-qty]');
        result.className = 'cli-ord-result is-err';
        result.textContent = `Тариф «${tariff.name}»: ${quantityValidation.message}`;
        qtyInput.focus();
        return;
      }
      items.push({
        anketa_code,
        anketa_name,
        is_new_anketa: false,
        tariff_id: tariff.id || null,
        tariff_name: tariff.name,
        qty: pricing.qty,
        amount: pricing.amount,
        pay_full: pricing.payFull,
        prepay_amount: pricing.prepayAmount,
        profile_url: null
      });
    }
    const summary = cart.summarize(items.map(item => ({
      tariff: tariffs.find(t => String(t.id || '') === String(item.tariff_id || ''))
        || tariffs.find(t => t.name === item.tariff_name),
      qty: item.qty
    })), pay_full, payment_method === 'card_transfer'
      ? (Number(((_orderPayload.payment || {}).manualTransferDiscount)) || cart.MANUAL_TRANSFER_DISCOUNT)
      : 0);
    summary.items.forEach((entry, index) => {
      items[index].amount = entry.pricing.amount;
      items[index].pay_full = entry.pricing.payFull;
      items[index].prepay_amount = entry.pricing.prepayAmount;
      items[index].discount_amount = entry.pricing.discountAmount || 0;
    });

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

    let receipt_url = null;
    if (payment_method === 'card_transfer') {
      const fileInput = document.getElementById('ordReceipt');
      const file = fileInput && fileInput.files && fileInput.files[0];
      if (!file) {
        result.className = 'cli-ord-result is-err';
        result.textContent = 'Прикрепи чек перевода.';
        return;
      }
      if (file.size > 50 * 1024 * 1024) {
        result.className = 'cli-ord-result is-err';
        result.textContent = 'Файл больше 50 МБ — выбери файл поменьше.';
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Загружаю чек…';
      try {
        receipt_url = await uploadReceipt(file);
      } catch (error) {
        console.warn('[client-app] receipt upload failed', error);
        btn.disabled = false;
        btn.textContent = 'Отправить чек на проверку';
        result.className = 'cli-ord-result is-err';
        result.textContent = /Unsupported receipt format/.test(String(error && error.message))
          ? 'Поддерживаются PDF, JPG, PNG, WEBP, HEIC и HEIF.'
          : 'Не получилось загрузить чек. Проверь интернет и попробуй ещё раз.';
        return;
      }
    }

    btn.disabled = true;
    btn.textContent = payment_method === 'card_transfer' ? 'Отправляю чек…' : 'Создаю платёж…';
    const email = (Auth.email() || '').toLowerCase();
    const order = await submitOrder({
      client_email: email,
      client_name: Auth.name() || email,
      order_type: 'multi_order',
      anketa_name: items.map(item => item.anketa_name || item.anketa_code).join(', '),
      tariff_name: items.length === 1 ? items[0].tariff_name : `Отзывы (${items.length} анкет)`,
      qty: items.reduce((sum, item) => sum + (Number(item.qty) || 0), 0),
      amount: summary.amount,
      pay_full,
      prepay_amount: summary.prepayAmount,
      items,
      receipt_url,
      payment_method,
      discount_amount: summary.discount,
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
      if (payment_method === 'card_transfer') {
        const box = document.querySelector('[data-cli-order-body]');
        box.innerHTML = `
          <div class="cli-ord-success">
            <div style="font-size:36px">✓</div>
            <div style="font-weight:700;margin:10px 0 4px">Чек отправлен</div>
            <div style="color:var(--cli-muted,#888);font-size:13px">После проверки платежа заказ появится в работе.</div>
            <button type="button" class="cli-ord-submit" id="ordDone" style="margin-top:18px">Закрыть</button>
          </div>`;
        document.getElementById('ordDone').addEventListener('click', closeOrderModal);
        loadMyOrders().then(renderMyOrders);
      } else {
        const opened = await startPayment(order.id, btn, result);
        if (!opened) loadMyOrders().then(renderMyOrders);
      }
    } else {
      btn.disabled = false;
      btn.textContent = payment_method === 'card_transfer' ? 'Отправить чек на проверку' : 'Перейти к оплате';
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
        + `&select=id,parent_order_id,parent_item_id,anketa_code,anketa_name,is_new_anketa,tariff_name,qty,amount,status,created_at,confirmed_at,receipt_url,offer_agreed,offer_text,offer_version,personal_data_agreed,personal_data_consent_text,personal_data_consent_version,pay_full,prepay_amount,remainder_status,order_type,items,comment,payment_method,discount_amount,payment_provider,payment_id,payment_status,payment_url,payment_environment,payment_created_at,payment_paid_at`
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
    const isMulti = o.order_type === 'multi_order';
    const isManualTransfer = o.payment_method === 'card_transfer';
    const amt = Number(o.amount) || 0;
    let title, sub, payLine = '';
    if (isRem) {
      title = 'Доплата остатка';
      sub = `${escapeHtml(o.anketa_name || '—')} · ${_fmtDateTime(o.created_at)}`;
      payLine = `<div class="cli-order__pay">💳 ${o.status === 'confirmed' || paymentReceived ? 'Оплачено' : 'К оплате'}: ${fmtMoney(amt)}</div>`;
    } else if (isMulti) {
      const items = Array.isArray(o.items) ? o.items : [];
      const childByItem = new Map((_myOrders || [])
        .filter(child => String(child.parent_order_id || '') === String(o.id))
        .map(child => [String(child.parent_item_id || ''), child]));
      title = `Отзывы для ${items.length || 1} ${items.length === 1 ? 'анкеты' : 'анкет'}`;
      sub = _fmtDateTime(o.created_at);
      let outstanding = 0;
      const packageLines = items.map(item => {
        const target = item.anketa_code
          ? escapeHtml(item.anketa_code)
          : `новая «${escapeHtml(item.anketa_name || '—')}»`;
        const itemAmount = Number(item.amount) || 0;
        const itemPrepay = item.prepay_amount != null ? Number(item.prepay_amount) : itemAmount;
        const itemRest = Math.max(0, itemAmount - itemPrepay);
        const child = childByItem.get(String(item.item_id || ''));
        const itemOutstanding = itemRest > 0 && (!paymentReceived || !child || child.remainder_status === 'pending')
          ? itemRest : 0;
        outstanding += itemOutstanding;
        return `<div class="cli-order__package"><b>${target}</b> · ${escapeHtml(item.tariff_name || 'Тариф')}`
          + `${item.qty ? ' · ' + Number(item.qty) + ' отз.' : ''} · ${fmtMoney(itemAmount)}`
          + `${itemOutstanding > 0 ? ` (сейчас ${fmtMoney(itemPrepay)}, остаток ${fmtMoney(itemOutstanding)})` : ''}</div>`;
      }).join('');
      const prepay = o.prepay_amount != null ? Number(o.prepay_amount) : amt;
      payLine = `<div class="cli-order__packages">${packageLines}</div>`
        + `<div class="cli-order__pay">💳 ${paymentReceived && outstanding <= 0 ? 'Оплачено полностью' : (o.status === 'confirmed' || paymentReceived ? 'Оплачено' : 'К оплате')}: ${fmtMoney(paymentReceived && outstanding <= 0 ? amt : prepay)}`
        + `${outstanding > 0 ? ` · общий остаток: <b>${fmtMoney(outstanding)}</b>` : ''}</div>`
        + (Number(o.discount_amount) > 0 ? `<div class="cli-order__discount">Скидка за перевод: −${fmtMoney(o.discount_amount)}</div>` : '');
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
        payLine = `<div class="cli-order__pay">💳 К оплате: ${fmtMoney(prepay)}</div>`;
      }
    }
    const consent = o.offer_agreed
      ? `<div class="cli-order__consent">✅ Оферта${o.offer_version ? ' ' + escapeHtml(o.offer_version) : ''} принята${o.personal_data_agreed ? ' · согласие на обработку данных дано' : ''} · ${_fmtDateTime(o.created_at)}${o.offer_text ? ` · <button type="button" class="cli-order__terms" data-view-terms="${o.id}">оферта</button>` : ''}${o.personal_data_consent_text ? ` · <button type="button" class="cli-order__terms" data-view-consent="${o.id}">согласие</button>` : ''}</div>`
      : '';
    const receipt = o.receipt_url
      ? `<button type="button" class="cli-order__receipt" data-receipt-ref="${escapeAttr(o.receipt_url)}">Открыть чек</button>`
      : '';
    const paymentAction = o.status === 'new' && !paymentReceived && !isManualTransfer
      ? `<button type="button" class="cli-order__pay-btn" data-pay-order="${o.id}">Перейти к оплате</button>`
      : paymentReceived && o.status !== 'confirmed'
        ? `<div class="cli-order__payment-note">Оплата получена. Заказ обрабатывается.</div>`
        : isManualTransfer && o.status === 'new'
          ? `<div class="cli-order__payment-note">Чек отправлен. Платёж проверяется менеджером.</div>`
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
    const visibleOrders = _myOrders.filter(o => !o.parent_order_id && o.order_type !== 'package_item');
    if (!visibleOrders.length) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    const rest = visibleOrders.slice(1);  // показываем последний, остальные — по кнопке
    el.innerHTML = `
      <h2 class="cli-section-title">Мои заказы</h2>
      <div class="cli-orders__list">${_orderCardHtml(visibleOrders[0])}</div>
      ${rest.length ? `
        <div class="cli-orders__list cli-orders__more" data-cli-orders-more hidden>${rest.map(_orderCardHtml).join('')}</div>
        <button type="button" class="cli-orders__toggle" data-cli-orders-toggle>▾ Показать все заказы (${visibleOrders.length})</button>` : ''}`;
    const toggle = el.querySelector('[data-cli-orders-toggle]');
    const more = el.querySelector('[data-cli-orders-more]');
    if (toggle && more) toggle.addEventListener('click', () => {
      const willOpen = more.hidden;
      more.hidden = !willOpen;
      toggle.textContent = willOpen ? '▴ Свернуть' : `▾ Показать все заказы (${visibleOrders.length})`;
    });
    el.querySelectorAll('[data-view-terms]').forEach(b => b.addEventListener('click', () => {
      const o = _myOrders.find(x => String(x.id) === b.dataset.viewTerms);
      if (o) openTerms(o.offer_text);
    }));
    el.querySelectorAll('[data-view-consent]').forEach(b => b.addEventListener('click', () => {
      const o = _myOrders.find(x => String(x.id) === b.dataset.viewConsent);
      if (o) openDataConsent(o.personal_data_consent_text);
    }));
    el.querySelectorAll('[data-receipt-ref]').forEach(button => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await openReceipt(button.dataset.receiptRef);
        } catch (error) {
          alert('Не удалось открыть чек. Обновите страницу и попробуйте ещё раз.');
        } finally {
          button.disabled = false;
        }
      });
    });
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
    let paid = false;
    if (result === 'success') {
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const response = await fetch(`${PAYMENTS_API}/orders/${orderId}`, {
            headers: { 'Authorization': `Bearer ${accessToken()}` }
          });
          const data = await response.json().catch(() => ({}));
          if (response.ok && data.status === 'paid') {
            paid = true;
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
    if (paid) window.setTimeout(() => window.location.reload(), 700);
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
        : `${item.code || item.name || '—'} · ${item.tariff_name || 'Тариф'}${date ? ' · ' + date : ''}`;
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
        <div class="cli-ord-label">Выбери заказы для оплаты остатка</div>
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
    loadMyPublicationRequests,
    submitPublicationRequest,
    loadMyOutreachSlots,
    loadOutreachAvailability,
    manageOutreachSlot,
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
