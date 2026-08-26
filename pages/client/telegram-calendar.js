(function () {
  'use strict';

  const root = document.querySelector('[data-tgcal]');
  const SB = {
    URL: 'https://mentori.tech/sb',
    KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzc5MzE4NDc3LCJleHAiOjIwOTQ2Nzg0Nzd9.XuMHwfOo8qcycoooOMGwWd3R9_YA55JQZwaJBh132N8'
  };
  const tg = window.Telegram && window.Telegram.WebApp;
  const params = new URLSearchParams(location.search);
  const token = params.get('token') || '';
  const state = { payload: null, mentorId: '', selectedDate: '', month: null, busy: false };
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

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
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
    if (raw.includes('TOKEN_INVALID_OR_EXPIRED') || Number(error && error.status) === 401) {
      return 'Ссылка устарела. Откройте календарь заново из свежего сообщения бота.';
    }
    if (raw.includes('DAY_FULL')) return 'На этот день свободных мест уже нет.';
    if (raw.includes('SCHEDULE_LIMIT_REACHED')) return 'Все доступные отклики уже запланированы.';
    if (raw.includes('DATE_OUT_OF_RANGE')) return 'Начать можно только со следующего дня.';
    return 'Не удалось сохранить. Попробуйте ещё раз.';
  }

  function currentAnketa() {
    return (state.payload && state.payload.anketas || []).find(item => item.mentor_id === state.mentorId) || null;
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
    return {
      ok: true,
      minimum_date: isoDate(tomorrow),
      anketas: [{
        mentor_id: 'preview-a34', code: 'A34', name: 'test',
        schedule_limit: 3, active_count: 2, available_to_add: 1,
        slots: [
          { id: 1, scheduled_date: calendar[2].date, slot_status: 'scheduled' },
          { id: 2, scheduled_date: calendar[5].date, slot_status: 'scheduled' }
        ]
      }],
      calendar
    };
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

  function render() {
    const payload = state.payload;
    if (!payload) return;
    const anketa = currentAnketa();
    if (!anketa) {
      root.innerHTML = '<section class="tgcal-state">Нет активных анкет для планирования.</section>';
      return;
    }
    const days = calendarByDate();
    const ownedDates = new Set((anketa.slots || []).map(slot => String(slot.scheduled_date)));
    const minimum = String(payload.minimum_date || '');
    const maxDate = [...days.keys()].sort().pop() || minimum;
    const canAdd = Number(anketa.available_to_add) > 0;
    const slots = (anketa.slots || []).map(slot => `
      <div class="tgcal-slot">
        <strong>${escapeHtml(dateFmt.format(new Date(`${slot.scheduled_date}T12:00:00`)))}</strong>
        <button type="button" data-cancel-slot="${Number(slot.id)}">Отменить</button>
      </div>`).join('');
    root.innerHTML = `
      <header class="tgcal-head">
        <h1>Календарь откликов</h1>
        <p>Выберите свободный день. Минимальная дата начала работы: завтра.</p>
      </header>
      <section class="tgcal-card">
        <select class="tgcal-select" data-anketa aria-label="Анкета">
          ${(payload.anketas || []).map(item => `<option value="${escapeHtml(item.mentor_id)}"${item.mentor_id === state.mentorId ? ' selected' : ''}>${escapeHtml(String(item.code || '').toUpperCase())}${item.name ? ` · ${escapeHtml(item.name)}` : ''}</option>`).join('')}
        </select>
        <div class="tgcal-limit"><span>Можно запланировать</span><b>${Number(anketa.available_to_add) || 0}</b></div>
        <div class="tgcal-slots"${slots ? '' : ' hidden'}>${slots}</div>
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
              const available = Number(info && info.available_count) || 0;
              const disabled = iso < minimum || iso > maxDate || !info || available <= 0 || !canAdd;
              const classes = ['tgcal-day'];
              if (ownedDates.has(iso)) classes.push('is-owned');
              if (state.selectedDate === iso) classes.push('is-selected');
              if (info && available <= 0) classes.push('is-full');
              return `<button type="button" class="${classes.join(' ')}" data-date="${iso}"${disabled ? ' disabled' : ''}><strong>${date.getDate()}</strong><small>${info ? (available > 0 ? `мест ${available}` : 'занято') : ''}</small></button>`;
            }).join('')}
          </div>
        </div>
        <button type="button" class="tgcal-submit" data-submit${state.selectedDate && canAdd ? '' : ' disabled'}>${state.selectedDate ? `Запланировать на ${escapeHtml(dateFmt.format(new Date(`${state.selectedDate}T12:00:00`)))}` : 'Выберите дату'}</button>
        <div class="tgcal-result" data-result></div>
      </section>`;
    bind();
  }

  function bind() {
    root.querySelector('[data-anketa]').addEventListener('change', event => {
      state.mentorId = event.target.value;
      state.selectedDate = '';
      render();
    });
    root.querySelectorAll('[data-date]').forEach(button => button.addEventListener('click', () => {
      state.selectedDate = button.dataset.date;
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
      result.className = 'tgcal-result is-ok';
      result.textContent = action === 'cancel' ? 'Отклик отменён.' : 'Отклик запланирован.';
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

  async function load() {
    if ((location.hostname === '127.0.0.1' || location.hostname === 'localhost')
        && params.get('preview') === '1') {
      state.payload = localPreviewPayload();
      state.mentorId = state.payload.anketas[0].mentor_id;
      const minimum = new Date(`${state.payload.minimum_date}T12:00:00`);
      state.month = new Date(minimum.getFullYear(), minimum.getMonth(), 1, 12);
      render();
      return;
    }
    if (!token || !SB) {
      root.innerHTML = '<section class="tgcal-state">Откройте календарь кнопкой из сообщения бота.</section>';
      return;
    }
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const until = new Date(tomorrow);
    until.setDate(until.getDate() + 45);
    try {
      state.payload = await rpc('get_client_telegram_calendar', {
        p_token: token, p_from: isoDate(tomorrow), p_to: isoDate(until)
      });
      const anketas = state.payload.anketas || [];
      if (!state.mentorId || !anketas.some(item => item.mentor_id === state.mentorId)) {
        state.mentorId = anketas[0] && anketas[0].mentor_id || '';
      }
      state.selectedDate = '';
      state.month = state.month || new Date(tomorrow.getFullYear(), tomorrow.getMonth(), 1, 12);
      render();
    } catch (error) {
      root.innerHTML = `<section class="tgcal-state">${escapeHtml(errorMessage(error))}</section>`;
    }
  }

  load();
})();
