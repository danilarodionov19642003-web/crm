(function () {
  'use strict';

  const root = document.querySelector('[data-tgcal]');
  const SB = {
    URL: 'https://mentori.tech/sb',
    KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzc5MzE4NDc3LCJleHAiOjIwOTQ2Nzg0Nzd9.XuMHwfOo8qcycoooOMGwWd3R9_YA55JQZwaJBh132N8'
  };
  const tg = window.Telegram && window.Telegram.WebApp;
  const OUTREACH_SUNDAY_DAY_OFF_FROM = '2026-08-30';
  const params = new URLSearchParams(location.search);
  const fragmentParams = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
  const token = fragmentParams.get('token') || params.get('token') || '';
  const requestedView = fragmentParams.get('view') || params.get('view');
  const initialView = requestedView === 'home' ? 'home' : 'calendar';
  const state = {
    payload: null,
    mentorId: '',
    detailMentorId: '',
    detailProfileId: '',
    selectedDate: '',
    month: null,
    busy: false,
    view: initialView,
    flash: ''
  };
  const monthFmt = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' });
  const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

  if (tg) {
    tg.ready();
    tg.expand();
    tg.setHeaderColor('#111112');
    tg.setBackgroundColor('#0d0d0e');
  }

  function isoDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function isOutreachDayOff(iso) {
    const value = String(iso || '').slice(0, 10);
    if (value < OUTREACH_SUNDAY_DAY_OFF_FROM) return false;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay() === 0;
  }

  function outreachCapacityForDate(iso) {
    const value = String(iso || '').slice(0, 10);
    if (isOutreachDayOff(value)) return 0;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return 0;
    const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
    return day === 6 ? 3 : 7;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  }

  function fmtMoney(value) {
    return `${Math.round(Number(value) || 0).toLocaleString('ru-RU')} ₽`;
  }

  function fmtDate(value) {
    if (!value) return '—';
    const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
    return Number.isNaN(date.getTime()) ? '—' : dateFmt.format(date);
  }

  function safeImageUrl(value) {
    const url = String(value || '').trim();
    if (/^https:\/\//i.test(url)) return url;
    if ((location.hostname === '127.0.0.1' || location.hostname === 'localhost') && url.startsWith('/')) return url;
    return '';
  }

  function avatarHtml(anketa, large = false) {
    const src = safeImageUrl(anketa && anketa.avatar_url);
    const fallback = String((anketa && (anketa.name || anketa.code)) || 'M').trim().charAt(0).toUpperCase() || 'M';
    return `<span class="tgapp-avatar${large ? ' is-large' : ''}">
      <span class="tgapp-avatar__fallback">${escapeHtml(fallback)}</span>
      ${src ? `<img src="${escapeHtml(src)}" alt="" data-avatar/>` : ''}
    </span>`;
  }

  function bindAvatarFallbacks() {
    root.querySelectorAll('img[data-avatar]').forEach(image => {
      image.addEventListener('error', () => { image.hidden = true; }, { once: true });
    });
  }

  async function rpc(name, body) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('POST', `${SB.URL}/rest/v1/rpc/${name}`, true);
      request.setRequestHeader('apikey', SB.KEY);
      request.setRequestHeader('Content-Type', 'application/json');
      request.setRequestHeader('Accept', 'application/json');
      request.onload = () => {
        let payload = {};
        try { payload = JSON.parse(request.responseText || '{}'); } catch (_) {}
        if (request.status >= 200 && request.status < 300) {
          resolve(payload);
          return;
        }
        const error = new Error(String(payload.message || payload.details || `HTTP ${request.status}`));
        error.status = request.status;
        reject(error);
      };
      request.onerror = () => reject(new Error('NETWORK_ERROR'));
      request.send(JSON.stringify(body));
    });
  }

  function errorMessage(error) {
    const raw = String(error && error.message || error || '');
    if (raw.includes('CHANNEL_SUBSCRIPTION_REQUIRED')) {
      return 'Подпишитесь на канал @Mento_ri, затем вернитесь в бот и отправьте /start.';
    }
    if (raw.includes('TOKEN_INVALID_OR_EXPIRED') || Number(error && error.status) === 401) {
      return 'Доступ устарел. Нажмите «Кабинет» рядом с полем ввода или откройте новое сообщение бота.';
    }
    if (raw.includes('OUTREACH_SATURDAY_FULL')) return 'В субботу можно запланировать не больше трёх откликов. Выберите другой день.';
    if (raw.includes('DAY_FULL')) return 'На этот день свободных мест уже нет.';
    if (raw.includes('SCHEDULE_LIMIT_REACHED')) return 'Все доступные отклики уже запланированы.';
    if (raw.includes('OUTREACH_DAY_OFF')) return 'В воскресенье отклики не планируются. Выберите другой день.';
    if (raw.includes('DATE_OUT_OF_RANGE')) return 'Начать можно только со следующего дня.';
    if (raw.includes('PUBLICATION_TOO_EARLY')) {
      const match = raw.match(/PUBLICATION_TOO_EARLY:(\d{4}-\d{2}-\d{2})/);
      return match ? `Эту дату выбрать нельзя. Доступно не раньше ${fmtDate(match[1])}.` : 'Эту дату выбрать пока нельзя.';
    }
    if (raw.includes('DATE_ALREADY_ACCEPTED')) return 'Эта дата уже подтверждена.';
    if (raw.includes('STATUS_NOT_AVAILABLE')) return 'Дата доступна только для аккаунта в статусе «Выбран».';
    if (raw.includes('COMMENT_REQUIRED')) return 'Напишите, что нужно исправить в тексте.';
    if (raw.includes('TEXT_APPROVER_REQUIRED')) return 'Согласовать текст может только ответственный контакт.';
    if (raw.includes('ALREADY_RESOLVED')) return 'На этот текст уже ответили.';
    return 'Не удалось сохранить. Попробуйте ещё раз.';
  }

  function statusBreakdown(anketa) {
    let planned = 0;
    let active = 0;
    let done = 0;
    (anketa && anketa.statuses || []).forEach(item => {
      if (item.status === '📋 Запланировано') planned += 1;
      else if (item.status === '🎯 Опубликован') done += 1;
      else active += 1;
    });
    return { planned, active, done };
  }

  function progressPercent(anketa) {
    const ordered = Math.max(0, Number(anketa && anketa.ordered) || 0);
    const breakdown = statusBreakdown(anketa);
    const done = Math.max(Number(anketa && anketa.done) || 0, breakdown.done);
    return ordered ? Math.min(100, Math.round(((done + breakdown.active) / ordered) * 100)) : 0;
  }

  function currentAnketa() {
    return (state.payload && state.payload.anketas || []).find(item => item.mentor_id === state.mentorId) || null;
  }

  function detailAnketa() {
    return (state.payload && state.payload.anketas || []).find(item => item.mentor_id === state.detailMentorId) || null;
  }

  function detailStatus() {
    const anketa = detailAnketa();
    return (anketa && anketa.statuses || []).find(item =>
      String(item.profile_id || '') === String(state.detailProfileId || '')
    ) || null;
  }

  function latestTextApproval(mentorId, profileId) {
    return (state.payload && state.payload.text_approvals || [])
      .filter(item => String(item.mentor_id || '') === String(mentorId || '')
        && String(item.source_profile_id || '') === String(profileId || ''))
      .sort((left, right) => {
        const revision = (Number(right.source_revision) || 0) - (Number(left.source_revision) || 0);
        if (revision) return revision;
        return Number(right.id) - Number(left.id);
      })[0] || null;
  }

  function pendingTextApprovals() {
    const seen = new Set();
    return (state.payload && state.payload.text_approvals || [])
      .filter(item => item.request_status === 'pending')
      .sort((left, right) => {
        const revision = (Number(right.source_revision) || 0) - (Number(left.source_revision) || 0);
        if (revision) return revision;
        return Number(right.id) - Number(left.id);
      })
      .filter(item => {
        const sourceKey = item.source_profile_id || item.title || item.id;
        const key = `${String(item.mentor_id || '')}:${String(sourceKey || '')}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function approvalTarget(request) {
    const anketa = (state.payload && state.payload.anketas || []).find(item =>
      String(item.mentor_id || '') === String(request && request.mentor_id || '')
    ) || null;
    if (!anketa) return { anketa: null, status: null };
    let status = (anketa.statuses || []).find(item =>
      String(item.profile_id || '') === String(request && request.source_profile_id || '')
    ) || null;
    if (!status && request && request.title) {
      const titleAccount = String(request.title).split('·').pop().trim().toLocaleLowerCase('ru-RU');
      status = (anketa.statuses || []).find(item =>
        String(item.profile_name || '').trim().toLocaleLowerCase('ru-RU') === titleAccount
      ) || null;
    }
    return { anketa, status };
  }

  function pendingApprovalCard(request) {
    const target = approvalTarget(request);
    const anketaCode = target.anketa && target.anketa.code || request.anketa_code || 'Анкета';
    const titleAccount = String(request.title || '').split('·').pop().trim();
    const accountName = target.status && target.status.profile_name || titleAccount || 'Аккаунт';
    const body = String(request.body || '').trim();
    const preview = body.length > 122 ? `${body.slice(0, 119).trim()}…` : body;
    return `<button type="button" class="tgapp-pending-approval" data-open-pending-approval="${escapeHtml(request.id)}">
      <span class="tgapp-pending-approval__icon" aria-hidden="true">📝</span>
      <span class="tgapp-pending-approval__body">
        <small>Нужно ваше решение</small>
        <strong>Текст ждёт согласования</strong>
        <b>${escapeHtml(String(anketaCode).toUpperCase())} · ${escapeHtml(accountName)}</b>
        ${preview ? `<em>${escapeHtml(preview)}</em>` : ''}
      </span>
      <span class="tgapp-pending-approval__arrow" aria-hidden="true">›</span>
    </button>`;
  }

  function publicationRequest(status) {
    return (state.payload && state.payload.publication_requests || []).find(item =>
      String(item.status_id || '') === String(status && status.id || '')
      && String(item.status_date || '').slice(0, 10) === String(status && status.date || '').slice(0, 10)
    ) || null;
  }

  function activeAnketas() {
    return (state.payload && state.payload.anketas || []).filter(item => !item.closed);
  }

  function localPreviewPayload() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const calendar = [];
    for (let offset = 0; offset <= 45; offset += 1) {
      const date = new Date(tomorrow);
      date.setDate(date.getDate() + offset);
      const available = offset % 7 === 0 ? 0 : Math.max(1, 7 - (offset % 6));
      calendar.push({ date: isoDate(date), capacity: 7, used_count: 7 - available, available_count: available });
    }
    const active = {
      mentor_id: 'preview-a34', code: 'A34', name: 'Тестовая анкета',
      avatar_url: '/assets/icons/mentori-crm-icon-512.png', platform: 'Profi.ru',
      tariff: 'Развитие профиля', ordered: 12, done: 4, paid: 4800, remain: 4800, total: 9600,
      closed: false, schedule_limit: 3, active_count: 2, available_to_add: 1,
      slots: [
        { id: 1, scheduled_date: calendar[2].date, slot_status: 'scheduled' },
        { id: 2, scheduled_date: calendar[5].date, slot_status: 'scheduled' }
      ],
      statuses: [
        { id: 's1', profile_id: 'p1', profile_name: 'Тестовый аккаунт 3', status: '🏆 Выбран', date: isoDate(new Date()), publication_wait_days: 5, publication_minimum_date: calendar[4].date },
        { id: 's2', profile_id: 'p2', profile_name: 'Тестовый аккаунт 2', status: '⭐ Выбрать', date: isoDate(new Date()), publication_wait_days: 5, publication_minimum_date: calendar[4].date },
        { id: 's3', profile_id: 'p3', profile_name: 'Тестовый аккаунт 1', status: '🎯 Опубликован', date: isoDate(new Date()), publication_wait_days: 5, publication_minimum_date: calendar[4].date }
      ],
      reviews: [{ id: 'r1', profile_name: 'Тестовый аккаунт 1', text: 'Спасибо за отличную работу и внимательное отношение к деталям.', date: isoDate(new Date()) }]
    };
    const completed = {
      mentor_id: 'preview-complete', code: 'A18', name: 'Завершённая анкета',
      avatar_url: '', platform: 'Profi.ru', tariff: 'Поддержка профиля',
      ordered: 6, done: 6, paid: 5400, remain: 0, total: 5400, closed: true,
      schedule_limit: 0, active_count: 0, available_to_add: 0, slots: [],
      statuses: [{ id: 's4', profile_name: 'Аккаунт 8-2', status: '🎯 Опубликован', date: isoDate(new Date()) }],
      reviews: []
    };
    return {
      ok: true,
      client_name: 'Александр',
      generated_at: new Date().toISOString(),
      minimum_date: isoDate(tomorrow),
      totals: { ordered: 18, done: 10, paid: 10200, remain: 4800, total: 15000 },
      anketas: [active, completed],
      calendar,
      can_approve_texts: true,
      text_approvals: [{
        id: 101, mentor_id: 'preview-a34', source_profile_id: 'p1',
        title: 'Текст отзыва · A34 · Тестовый аккаунт 3',
        body: 'Очень понравился результат работы. Специалист всё объяснял по ходу проекта, аккуратно выполнил задачу и уложился в согласованные сроки.',
        request_status: 'pending', source_revision: 1, created_at: new Date().toISOString(),
        resolution_comment: ''
      }],
      publication_requests: []
    };
  }

  function bottomNav(active) {
    return `<nav class="tgapp-nav" aria-label="Разделы кабинета">
      <button type="button" data-view="home" class="${active === 'home' || active === 'anketa' || active === 'account' ? 'is-active' : ''}">
        <span aria-hidden="true">⌂</span><b>Главная</b>
      </button>
      <button type="button" data-view="calendar" class="${active === 'calendar' ? 'is-active' : ''}">
        <span aria-hidden="true">□</span><b>Календарь</b>
      </button>
    </nav>`;
  }

  function renderShell(content, active) {
    root.innerHTML = `<div class="tgapp-page">${content}</div>${bottomNav(active)}`;
    root.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
      state.view = button.dataset.view === 'calendar' ? 'calendar' : 'home';
      state.detailProfileId = '';
      state.selectedDate = '';
      state.flash = '';
      render();
      if (tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged();
    }));
    bindAvatarFallbacks();
  }

  function renderHome() {
    const payload = state.payload;
    // Главная Mini App показывает только текущую работу. Завершённые анкеты
    // остаются в серверном снимке и истории, но не занимают место у клиента.
    const anketas = activeAnketas();
    const totals = payload.totals || {};
    const inWork = anketas.reduce((sum, item) => sum + statusBreakdown(item).active, 0);
    const pendingApprovals = pendingTextApprovals();
    const pendingApprovalCards = pendingApprovals.map(pendingApprovalCard).join('');
    const cards = anketas.map(anketa => {
      const breakdown = statusBreakdown(anketa);
      const pct = progressPercent(anketa);
      return `<button type="button" class="tgapp-anketa-card" data-open-anketa="${escapeHtml(anketa.mentor_id)}">
        <span class="tgapp-anketa-card__head">
          ${avatarHtml(anketa)}
          <span class="tgapp-anketa-card__identity">
            <span><b>${escapeHtml(String(anketa.code || '').toUpperCase())}</b>${anketa.closed ? '<i>Завершена</i>' : '<i class="is-active">В работе</i>'}</span>
            <strong>${escapeHtml(anketa.name || anketa.code || 'Анкета')}</strong>
            <small>${escapeHtml(anketa.tariff || anketa.platform || 'Profi.ru')}</small>
          </span>
          <span class="tgapp-anketa-card__arrow">›</span>
        </span>
        <span class="tgapp-progress"><i style="width:${pct}%"></i></span>
        <span class="tgapp-anketa-card__foot">
          <span><small>Прогресс</small><b>${pct}%</b></span>
          <span><small>Опубликовано</small><b class="is-green">${Math.max(Number(anketa.done) || 0, breakdown.done)}</b></span>
          <span><small>В работе</small><b class="is-orange">${breakdown.active}</b></span>
          <span><small>Остаток</small><b>${fmtMoney(anketa.remain)}</b></span>
        </span>
      </button>`;
    }).join('');
    renderShell(`
      <section class="tgapp-hero">
        <img src="../../assets/icons/mentori-crm-icon-512.png" alt=""/>
        <div><span>Личный кабинет</span><h1>Привет, ${escapeHtml(payload.client_name || 'друг')}!</h1><p>Вся работа по вашим анкетам в одном месте.</p></div>
      </section>
      ${pendingApprovalCards ? `<section class="tgapp-pending-approvals" aria-label="Тексты на согласование">${pendingApprovalCards}</section>` : ''}
      <section class="tgapp-quick">
        <button type="button" data-go-calendar><span>📅</span><div><b>Запланировать отклик</b><small>Выбрать свободную дату</small></div><i>›</i></button>
      </section>
      <h2 class="tgapp-section-title">Сводка</h2>
      <section class="tgapp-kpis">
        <article><span>Заказано</span><strong>${Number(totals.ordered) || 0}</strong></article>
        <article><span>Сделано</span><strong class="is-green">${Number(totals.done) || 0}</strong></article>
        <article><span>В работе</span><strong class="is-orange">${inWork}</strong></article>
        <article><span>Остаток</span><strong>${fmtMoney(totals.remain)}</strong></article>
      </section>
      <div class="tgapp-section-heading"><h2>Ваши анкеты</h2><span>${anketas.length}</span></div>
      <section class="tgapp-anketas">${cards || '<div class="tgapp-empty">Активных анкет сейчас нет.</div>'}</section>
    `, 'home');
    const calendarButton = root.querySelector('[data-go-calendar]');
    if (calendarButton) calendarButton.addEventListener('click', () => {
      state.view = 'calendar';
      render();
    });
    root.querySelectorAll('[data-open-anketa]').forEach(button => button.addEventListener('click', () => {
      state.detailMentorId = button.dataset.openAnketa;
      state.detailProfileId = '';
      state.view = 'anketa';
      render();
    }));
    root.querySelectorAll('[data-open-pending-approval]').forEach(button => button.addEventListener('click', () => {
      const request = pendingApprovals.find(item => String(item.id) === String(button.dataset.openPendingApproval));
      const target = approvalTarget(request);
      if (!target.anketa) return;
      state.detailMentorId = target.anketa.mentor_id;
      state.detailProfileId = target.status && target.status.profile_id || '';
      state.view = target.status ? 'account' : 'anketa';
      render();
      if (tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged();
    }));
  }

  function statusTone(status) {
    if (status === '🎯 Опубликован') return 'is-green';
    if (status === '🏆 Выбран') return 'is-orange';
    if (status === '⭐ Выбрать') return 'is-purple';
    return '';
  }

  function renderAnketaDetail() {
    const anketa = detailAnketa();
    if (!anketa) {
      state.view = 'home';
      renderHome();
      return;
    }
    const breakdown = statusBreakdown(anketa);
    const done = Math.max(Number(anketa.done) || 0, breakdown.done);
    const pct = progressPercent(anketa);
    const statuses = (anketa.statuses || []).map(item => {
      const pendingApproval = latestTextApproval(anketa.mentor_id, item.profile_id);
      const needsApproval = pendingApproval && pendingApproval.request_status === 'pending';
      return `<button type="button" class="tgapp-status-row${needsApproval ? ' is-approval-pending' : ''}" data-open-account="${escapeHtml(item.profile_id || '')}">
      <span class="tgapp-status-row__dot ${statusTone(item.status)}"></span>
      <div><strong>${escapeHtml(item.profile_name || 'Аккаунт')}</strong><span>${escapeHtml(item.status || '—')}</span>${needsApproval ? '<em>📝 Текст ждёт согласования</em>' : ''}</div>
      <span class="tgapp-status-row__side"><time>${escapeHtml(fmtDate(item.date))}</time><i>›</i></span>
    </button>`;
    }).join('');
    const reviews = (anketa.reviews || []).map(item => `<article class="tgapp-review">
      <header><b>${escapeHtml(item.profile_name || 'Опубликованный отзыв')}</b><time>${escapeHtml(fmtDate(item.date))}</time></header>
      <p>${escapeHtml(item.text || '')}</p>
    </article>`).join('');
    renderShell(`
      <button type="button" class="tgapp-back" data-back-home>‹ <span>К анкетам</span></button>
      <section class="tgapp-profile-hero">
        ${avatarHtml(anketa, true)}
        <div><span>${escapeHtml(String(anketa.code || '').toUpperCase())}${anketa.closed ? ' · завершена' : ''}</span><h1>${escapeHtml(anketa.name || anketa.code || 'Анкета')}</h1><p>${escapeHtml(anketa.tariff || anketa.platform || 'Profi.ru')}</p></div>
      </section>
      <section class="tgapp-progress-card">
        <header><div><span>Прогресс работы</span><strong>${pct}%</strong></div><small>${done} из ${Number(anketa.ordered) || 0} готово</small></header>
        <span class="tgapp-progress is-large"><i style="width:${pct}%"></i></span>
      </section>
      <section class="tgapp-kpis is-profile">
        <article><span>Заказано</span><strong>${Number(anketa.ordered) || 0}</strong></article>
        <article><span>Опубликовано</span><strong class="is-green">${done}</strong></article>
        <article><span>В работе</span><strong class="is-orange">${breakdown.active}</strong></article>
        <article><span>Остаток</span><strong>${fmtMoney(anketa.remain)}</strong></article>
      </section>
      ${anketa.closed ? '' : '<button type="button" class="tgapp-primary" data-detail-calendar>📅 Запланировать отклик</button>'}
      <div class="tgapp-section-heading"><h2>Аккаунты</h2><span>${(anketa.statuses || []).length}</span></div>
      <section class="tgapp-statuses">${statuses || '<div class="tgapp-empty">Аккаунты ещё не добавлены.</div>'}</section>
      ${reviews ? `<div class="tgapp-section-heading"><h2>Опубликованные отзывы</h2><span>${(anketa.reviews || []).length}</span></div><section class="tgapp-reviews">${reviews}</section>` : ''}
    `, 'anketa');
    root.querySelector('[data-back-home]').addEventListener('click', () => {
      state.detailProfileId = '';
      state.view = 'home';
      render();
    });
    const calendarButton = root.querySelector('[data-detail-calendar]');
    if (calendarButton) calendarButton.addEventListener('click', () => {
      state.mentorId = anketa.mentor_id;
      state.view = 'calendar';
      render();
    });
    root.querySelectorAll('[data-open-account]').forEach(button => button.addEventListener('click', () => {
      state.detailProfileId = button.dataset.openAccount;
      state.view = 'account';
      render();
    }));
  }

  function textApprovalMeta(request) {
    if (!request) return { label: 'Текст ещё не отправлен', tone: 'is-empty' };
    if (request.request_status === 'approved') return { label: 'Текст согласован', tone: 'is-approved' };
    if (request.request_status === 'changes_requested') return { label: 'Нужны правки', tone: 'is-changes' };
    return { label: 'Ждёт согласования', tone: 'is-pending' };
  }

  function renderAccountDetail() {
    const anketa = detailAnketa();
    const status = detailStatus();
    if (!anketa || !status) {
      state.detailProfileId = '';
      state.view = 'anketa';
      renderAnketaDetail();
      return;
    }
    const approval = latestTextApproval(anketa.mentor_id, status.profile_id);
    const approvalMeta = textApprovalMeta(approval);
    const request = publicationRequest(status);
    const canApprove = Boolean(state.payload && state.payload.can_approve_texts);
    const pendingApprovalActions = approval && approval.request_status === 'pending' && canApprove
      ? `<div class="tgapp-approval__actions">
          <button type="button" class="is-approve" data-approve-text>Согласовать</button>
          <button type="button" class="is-change" data-show-changes>Нужны правки</button>
        </div>
        <form class="tgapp-change-form" data-change-form hidden>
          <label for="tgapp-change-comment">Что нужно исправить</label>
          <textarea id="tgapp-change-comment" maxlength="1500" placeholder="Напишите комментарий к тексту"></textarea>
          <div><button type="button" data-hide-changes>Отмена</button><button type="submit">Отправить</button></div>
        </form>`
      : '';
    const approvalHtml = approval
      ? `<section class="tgapp-account-card tgapp-approval">
          <header><span>Текст отзыва</span><b class="${approvalMeta.tone}">${approvalMeta.label}</b></header>
          <p>${escapeHtml(approval.body || '')}</p>
          ${approval.request_status === 'changes_requested' && approval.resolution_comment
            ? `<aside><strong>Комментарий:</strong> ${escapeHtml(approval.resolution_comment)}</aside>` : ''}
          ${pendingApprovalActions}
          <div class="tgapp-account-result" data-account-result></div>
        </section>`
      : `<section class="tgapp-account-card tgapp-approval is-empty">
          <header><span>Текст отзыва</span><b class="${approvalMeta.tone}">${approvalMeta.label}</b></header>
          <p>Когда менеджер подготовит текст, он появится здесь. Вы сможете сразу его согласовать или попросить правки.</p>
        </section>`;
    let publicationHtml = '';
    if (status.status === '🏆 Выбран') {
      const accepted = request && request.request_status === 'accepted';
      const value = request && ['pending', 'accepted'].includes(request.request_status)
        ? String(request.requested_date || '').slice(0, 10) : '';
      const minimum = String(status.publication_minimum_date || state.payload.minimum_date || '');
      const waitDays = Math.max(0, Number(status.publication_wait_days) || 0);
      const publicationState = accepted
        ? `<span class="tgapp-publication-state is-approved">Дата подтверждена</span>`
        : request && request.request_status === 'pending'
          ? `<span class="tgapp-publication-state is-pending">Ожидает подтверждения</span>`
          : request && request.request_status === 'rejected'
            ? `<span class="tgapp-publication-state is-changes">Выберите другую дату</span>` : '';
      publicationHtml = `<section class="tgapp-account-card tgapp-publication">
        <header><span>Дата публикации</span>${publicationState}</header>
        <p>Выберите удобный день, когда будете готовы опубликовать согласованный отзыв.</p>
        <div class="tgapp-publication__control">
          <input type="date" min="${escapeHtml(minimum)}" value="${escapeHtml(value)}" data-publication-date${accepted ? ' disabled' : ''}/>
          <button type="button" data-save-publication${accepted ? ' disabled' : ''}>${value ? 'Изменить' : 'Запланировать'}</button>
        </div>
        ${waitDays ? `<small>Не раньше ${escapeHtml(fmtDate(minimum))}, минимум ${waitDays} дн. в статусе «Выбран».</small>` : ''}
        <div class="tgapp-account-result" data-publication-result></div>
      </section>`;
    } else if (status.status === '🎯 Опубликован') {
      publicationHtml = `<section class="tgapp-account-card tgapp-publication is-complete"><header><span>Публикация</span><b>Опубликовано ✓</b></header><p>Отзыв опубликован ${status.date ? escapeHtml(fmtDate(status.date)) : ''}.</p></section>`;
    } else {
      publicationHtml = `<section class="tgapp-account-card tgapp-publication is-locked"><header><span>Дата публикации</span><b>Пока недоступно</b></header><p>Выбрать дату можно, когда аккаунт перейдёт в статус «Выбран».</p></section>`;
    }
    renderShell(`
      <button type="button" class="tgapp-back" data-back-anketa>‹ <span>К анкете ${escapeHtml(String(anketa.code || '').toUpperCase())}</span></button>
      <section class="tgapp-account-hero">
        <span class="tgapp-status-row__dot ${statusTone(status.status)}"></span>
        <div><small>${escapeHtml(String(anketa.code || '').toUpperCase())} · аккаунт</small><h1>${escapeHtml(status.profile_name || 'Аккаунт')}</h1><span>${escapeHtml(status.status || '—')} · обновлён ${escapeHtml(fmtDate(status.date))}</span></div>
      </section>
      ${approvalHtml}
      ${publicationHtml}
    `, 'account');
    root.querySelector('[data-back-anketa]').addEventListener('click', () => {
      state.view = 'anketa';
      render();
    });
    bindAccountActions(approval, status);
  }

  function bindAccountActions(approval, status) {
    const approve = root.querySelector('[data-approve-text]');
    if (approve) approve.addEventListener('click', () => resolveTextApproval(approval, 'approved', '', approve));
    const showChanges = root.querySelector('[data-show-changes]');
    const changeForm = root.querySelector('[data-change-form]');
    if (showChanges && changeForm) showChanges.addEventListener('click', () => {
      changeForm.hidden = false;
      showChanges.hidden = true;
      changeForm.querySelector('textarea').focus();
    });
    const hideChanges = root.querySelector('[data-hide-changes]');
    if (hideChanges && changeForm) hideChanges.addEventListener('click', () => {
      changeForm.hidden = true;
      showChanges.hidden = false;
    });
    if (changeForm) changeForm.addEventListener('submit', event => {
      event.preventDefault();
      const comment = changeForm.querySelector('textarea').value.trim();
      resolveTextApproval(approval, 'changes_requested', comment, changeForm.querySelector('[type="submit"]'));
    });
    const savePublication = root.querySelector('[data-save-publication]');
    if (savePublication) savePublication.addEventListener('click', () => {
      const input = root.querySelector('[data-publication-date]');
      const result = root.querySelector('[data-publication-result]');
      if (!input.value) {
        result.className = 'tgapp-account-result is-error';
        result.textContent = 'Сначала выберите дату.';
        return;
      }
      savePublicationDate(status, input.value, savePublication);
    });
  }

  async function resolveTextApproval(approval, decision, comment, button) {
    const result = root.querySelector('[data-account-result]');
    if (!approval || state.busy) return;
    if (decision === 'changes_requested' && !comment) {
      result.className = 'tgapp-account-result is-error';
      result.textContent = 'Напишите, что нужно исправить.';
      return;
    }
    state.busy = true;
    button.disabled = true;
    result.className = 'tgapp-account-result';
    result.textContent = 'Сохраняем…';
    try {
      if ((location.hostname === '127.0.0.1' || location.hostname === 'localhost') && params.get('preview') === '1') {
        approval.request_status = decision;
        approval.resolution_comment = comment;
        approval.resolved_at = new Date().toISOString();
      } else {
        const response = await rpc('resolve_client_telegram_webapp_text_approval', {
          p_token: token, p_request_id: Number(approval.id), p_decision: decision, p_comment: comment || null
        });
        if (response && response.ok === false) throw new Error(response.reason || 'SAVE_FAILED');
        await load();
        return;
      }
      render();
      if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
    } catch (error) {
      result.className = 'tgapp-account-result is-error';
      result.textContent = errorMessage(error);
      button.disabled = false;
    } finally {
      state.busy = false;
    }
  }

  async function savePublicationDate(status, targetDate, button) {
    const result = root.querySelector('[data-publication-result]');
    if (state.busy) return;
    state.busy = true;
    button.disabled = true;
    result.className = 'tgapp-account-result';
    result.textContent = 'Сохраняем…';
    try {
      if ((location.hostname === '127.0.0.1' || location.hostname === 'localhost') && params.get('preview') === '1') {
        const current = publicationRequest(status);
        const row = current || { id: Date.now(), status_id: status.id, status_date: status.date };
        Object.assign(row, { requested_date: targetDate, request_status: 'pending', updated_at: new Date().toISOString() });
        if (!current) state.payload.publication_requests.push(row);
      } else {
        await rpc('request_client_telegram_publication_date', {
          p_token: token, p_status_id: status.id, p_requested_date: targetDate
        });
        await load();
        return;
      }
      render();
      if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
    } catch (error) {
      result.className = 'tgapp-account-result is-error';
      result.textContent = errorMessage(error);
      button.disabled = false;
    } finally {
      state.busy = false;
    }
  }

  function calendarByDate() {
    return new Map((state.payload && state.payload.calendar || []).map(item => [String(item.date), item]));
  }

  function monthDays() {
    const month = state.month;
    const first = new Date(month.getFullYear(), month.getMonth(), 1, 12);
    const last = new Date(month.getFullYear(), month.getMonth() + 1, 0, 12);
    const cells = [];
    const offset = (first.getDay() + 6) % 7;
    for (let index = 0; index < offset; index += 1) cells.push(null);
    for (let day = 1; day <= last.getDate(); day += 1) {
      cells.push(new Date(month.getFullYear(), month.getMonth(), day, 12));
    }
    return cells;
  }

  function renderCalendar() {
    const payload = state.payload;
    const availableAnketas = activeAnketas();
    if (!availableAnketas.length) {
      renderShell('<section class="tgapp-empty is-page"><b>Нет активных анкет</b><span>Завершённые анкеты можно посмотреть на главной.</span></section>', 'calendar');
      return;
    }
    if (!state.mentorId || !availableAnketas.some(item => item.mentor_id === state.mentorId)) {
      state.mentorId = availableAnketas[0].mentor_id;
    }
    const anketa = currentAnketa();
    const days = calendarByDate();
    const ownedDates = new Set((anketa.slots || []).map(slot => String(slot.scheduled_date)));
    const minimum = String(payload.minimum_date || '');
    const maxDate = [...days.keys()].sort().pop() || minimum;
    const canAdd = Number(anketa.available_to_add) > 0;
    const slots = (anketa.slots || []).map(slot => `<div class="tgcal-slot">
      <span><i>✓</i><div><small>Запланировано</small><strong>${escapeHtml(fmtDate(slot.scheduled_date))}</strong></div></span>
      <button type="button" data-cancel-slot="${Number(slot.id)}">Отменить</button>
    </div>`).join('');
    renderShell(`
      <header class="tgcal-head"><span>Планирование</span><h1>Календарь откликов</h1><p>Начать можно со следующего дня, если есть свободные места.</p></header>
      <section class="tgcal-card">
        <div class="tgcal-anketa">
          ${avatarHtml(anketa)}
          <select class="tgcal-select" data-anketa aria-label="Анкета">
            ${availableAnketas.map(item => `<option value="${escapeHtml(item.mentor_id)}"${item.mentor_id === state.mentorId ? ' selected' : ''}>${escapeHtml(String(item.code || '').toUpperCase())}${item.name ? ` · ${escapeHtml(item.name)}` : ''}</option>`).join('')}
          </select>
        </div>
        <div class="tgcal-limit"><span>Можно запланировать ещё</span><b>${Number(anketa.available_to_add) || 0}</b></div>
        ${slots ? `<div class="tgcal-planned"><h2>Запланировано</h2><div class="tgcal-slots">${slots}</div></div>` : ''}
        <div class="tgcal-calendar">
          <div class="tgcal-nav">
            <button type="button" data-month-prev aria-label="Предыдущий месяц">‹</button>
            <strong>${escapeHtml(monthFmt.format(state.month))}</strong>
            <button type="button" data-month-next aria-label="Следующий месяц">›</button>
          </div>
          <div class="tgcal-week"><span>Пн</span><span>Вт</span><span>Ср</span><span>Чт</span><span>Пт</span><span>Сб</span><span>Вс</span></div>
          <div class="tgcal-grid">
            ${monthDays().map(date => {
              if (!date) return '<span class="tgcal-day is-empty"></span>';
              const iso = isoDate(date);
              const info = days.get(iso);
              const capacity = outreachCapacityForDate(iso);
              const used = Number(info && info.used_count) || 0;
              const available = Math.max(0, capacity - used);
              const owned = ownedDates.has(iso);
              const dayOff = isOutreachDayOff(iso);
              const disabled = iso < minimum || iso > maxDate || !info || available <= 0 || !canAdd || owned || dayOff;
              const classes = ['tgcal-day'];
              if (owned) classes.push('is-owned');
              if (state.selectedDate === iso) classes.push('is-selected');
              if (info && available <= 0) classes.push('is-full');
              if (dayOff) classes.push('is-day-off');
              return `<button type="button" class="${classes.join(' ')}" data-date="${iso}"${disabled ? ' disabled' : ''}><strong>${date.getDate()}</strong><small>${owned ? 'ваш' : (dayOff ? 'выходной' : (info ? (available > 0 ? `мест ${available}` : 'занято') : ''))}</small></button>`;
            }).join('')}
          </div>
        </div>
        <button type="button" class="tgcal-submit" data-submit${state.selectedDate && canAdd ? '' : ' disabled'}>${state.selectedDate ? `Запланировать на ${escapeHtml(fmtDate(state.selectedDate))}` : 'Выберите свободную дату'}</button>
        <div class="tgcal-result${state.flash ? ' is-ok' : ''}" data-result>${escapeHtml(state.flash)}</div>
      </section>
    `, 'calendar');
    bindCalendar();
  }

  function bindCalendar() {
    const select = root.querySelector('[data-anketa]');
    if (!select) return;
    select.addEventListener('change', event => {
      state.mentorId = event.target.value;
      state.selectedDate = '';
      state.flash = '';
      render();
    });
    root.querySelectorAll('[data-date]').forEach(button => button.addEventListener('click', () => {
      state.selectedDate = button.dataset.date;
      state.flash = '';
      render();
    }));
    root.querySelector('[data-month-prev]').addEventListener('click', () => {
      state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1, 12);
      render();
    });
    root.querySelector('[data-month-next]').addEventListener('click', () => {
      state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1, 12);
      render();
    });
    const submit = root.querySelector('[data-submit]');
    submit.addEventListener('click', () => manage('add', null, state.selectedDate, submit));
    root.querySelectorAll('[data-cancel-slot]').forEach(button => button.addEventListener('click', () => {
      if (window.confirm('Отменить этот запланированный отклик?')) {
        manage('cancel', Number(button.dataset.cancelSlot), null, button);
      }
    }));
  }

  async function manage(action, slotId, targetDate, button) {
    if (state.busy) return;
    state.busy = true;
    button.disabled = true;
    const result = root.querySelector('[data-result]');
    result.className = 'tgcal-result';
    result.textContent = 'Сохраняем…';
    try {
      await rpc('manage_client_telegram_outreach_slot', {
        p_token: token,
        p_action: action,
        p_mentor_id: state.mentorId,
        p_slot_id: slotId,
        p_target_date: targetDate
      });
      state.flash = action === 'cancel' ? 'Отклик отменён.' : 'Отклик запланирован.';
      state.selectedDate = '';
      await load();
      if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
    } catch (error) {
      result.className = 'tgcal-result is-error';
      result.textContent = errorMessage(error);
      button.disabled = false;
    } finally {
      state.busy = false;
    }
  }

  function render() {
    if (!state.payload) return;
    if (state.view === 'home') renderHome();
    else if (state.view === 'anketa') renderAnketaDetail();
    else if (state.view === 'account') renderAccountDetail();
    else renderCalendar();
  }

  async function load() {
    if ((location.hostname === '127.0.0.1' || location.hostname === 'localhost') && params.get('preview') === '1') {
      state.payload = localPreviewPayload();
      state.mentorId = activeAnketas()[0] && activeAnketas()[0].mentor_id || '';
      const minimum = new Date(`${state.payload.minimum_date}T12:00:00`);
      state.month = state.month || new Date(minimum.getFullYear(), minimum.getMonth(), 1, 12);
      render();
      return;
    }
    if (!token || !SB) {
      root.innerHTML = '<section class="tgcal-state">Откройте личный кабинет кнопкой из сообщения бота.</section>';
      return;
    }
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const until = new Date(tomorrow);
    until.setDate(until.getDate() + 45);
    try {
      state.payload = await rpc('get_client_telegram_calendar', {
        p_token: token,
        p_from: isoDate(tomorrow),
        p_to: isoDate(until)
      });
      const anketas = activeAnketas();
      if (!state.mentorId || !anketas.some(item => item.mentor_id === state.mentorId)) {
        state.mentorId = anketas[0] && anketas[0].mentor_id || '';
      }
      state.month = state.month || new Date(tomorrow.getFullYear(), tomorrow.getMonth(), 1, 12);
      render();
    } catch (error) {
      root.innerHTML = `<section class="tgcal-state">${escapeHtml(errorMessage(error))}</section>`;
    }
  }

  load();
})();
