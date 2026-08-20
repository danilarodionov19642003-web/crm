/* ==========================================================================
   MENTORI CRM — Ядро приложения (v2)
   ---------------------------------------------------------------------------
   • Store: income / expenses / clients / employees / subscriptions в localStorage
   • Справочники: SERVICES, EXPENSE_CATEGORIES, TARIFFS
   • Утилиты: фмт валюты / дат, toast, модалки, counter (+/−)
   ========================================================================== */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Ключ хранилища и версия                                            */
  /* ------------------------------------------------------------------ */
  const STORAGE_KEY = 'mentori-crm-v2';

  /* ------------------------------------------------------------------ */
  /* Справочники (используются везде)                                   */
  /* ------------------------------------------------------------------ */
  const SERVICES = [
    'Профи.ру',
    'Яндекс',
    '2ГИС',
    'Авито',
    'Консультация',
    'Прочие услуги'
  ];

  const EXPENSE_CATEGORIES = [
    'Реклама - Номера',
    'Зарплаты',
    'Прокси',
    'Софт',
    'Прочее'
  ];
  const PHONE_EXPENSE_AMOUNT = 99;

  // Категории ЛИЧНЫХ трат (expense.personal === true). Бот/ассистент
  // использует этот же список чтобы классифицировать траты владельца.
  const PERSONAL_CATEGORIES = [
    'Еда / продукты',
    'Кафе / рестораны',
    'Такси / транспорт',
    'Одежда',
    'Развлечения',
    'Девушка / подарки',
    'Родители / семья',
    'Подписки / связь',
    'Здоровье',
    'Дом / быт',
    'Прочее личное'
  ];

  const TARIFFS = [
    { id: 'support',   name: 'Поддержка',  price: 8290,  qty: 6,  unit: 'package', desc: '6 отзывов · 8 290 ₽' },
    { id: 'develop',   name: 'Развитие',   price: 15490, qty: 12, unit: 'package', desc: '12 отзывов · 15 490 ₽' },
    { id: 'wholesale', name: 'Опт',        price: 900,   qty: 20, unit: 'per',     desc: 'от 20 отзывов · 900 ₽/шт' },
    { id: 'regular',   name: 'Постоянник', price: 800,   qty: 0,  unit: 'per',     desc: '800 ₽/шт · количество вручную' }
  ];
  const TARIFF_NAMES = TARIFFS.map(t => t.name);
  const DEFAULT_PAYMENT_TARIFFS = TARIFFS.map(({ id, name, price, qty, unit }) => ({ id, name, price, qty, unit }));

  /* ------------------------------------------------------------------ */
  /* Справочники для новых модулей (статусы, города)                    */
  /* ------------------------------------------------------------------ */
  const PROFILE_STATUSES = [
    '📋 Запланировано',
    '💬 Диалог Начать',
    '✅ Диалог Закончен',
    '⭐ Выбрать',
    '🏆 Выбран',
    '🎯 Готов'
  ];
  const STATUS_SELECT = '⭐ Выбрать';
  const STATUS_CHOSEN = '🏆 Выбран';
  const STATUS_READY = '🎯 Готов';
  const STATUS_SELECT_WAIT_DAYS = 5;
  const STATUS_CHOSEN_FALLBACK_DAYS = 7;
  // Исполнители откликов/заказов — для расчёта ЗП. Владелец (Данил) и его брат
  // (Илья) работают под ОДНИМ логином CRM, поэтому на каждом статусе аккаунта
  // можно отметить, КТО делал работу. Пустое значение = не указан.
  const PERFORMERS = ['Данил', 'Илья'];
  const CITIES = ['МСК', 'СПБ', 'Прочее'];

  /** Извлекает город из кода аккаунта вида "2-1" (2=МСК, 3=СПБ, иначе — Прочее) */
  function cityFromCode(code) {
    const prefix = String(code || '').split('-')[0];
    return ({ '2': 'МСК', '3': 'СПБ' }[prefix]) || 'Прочее';
  }

  /* ------------------------------------------------------------------ */
  /* Утилиты                                                            */
  /* ------------------------------------------------------------------ */
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  /** YYYY-MM-DD в локальной таймзоне */
  const _pad = (n) => String(n).padStart(2, '0');
  const _iso = (d) => `${d.getFullYear()}-${_pad(d.getMonth()+1)}-${_pad(d.getDate())}`;
  const todayISO = () => _iso(new Date());
  const tomorrowISO = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return _iso(d);
  };

  function parseISODate(iso) {
    const parts = String(iso || '').slice(0, 10).split('-').map(Number);
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
    const value = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0);
    return isNaN(value.getTime()) ? null : value;
  }
  function addDaysISO(iso, days) {
    const value = parseISODate(iso) || parseISODate(todayISO());
    value.setDate(value.getDate() + (Number(days) || 0));
    return _iso(value);
  }
  function addMonthsISO(iso, months = 1) {
    const value = parseISODate(iso);
    if (!value) return '';
    const day = value.getDate();
    value.setDate(1);
    value.setMonth(value.getMonth() + (Number(months) || 0));
    const lastDay = new Date(value.getFullYear(), value.getMonth() + 1, 0).getDate();
    value.setDate(Math.min(day, lastDay));
    return _iso(value);
  }
  function isoDayNumber(iso) {
    const parts = String(iso || '').slice(0, 10).split('-').map(Number);
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
    return Math.floor(Date.UTC(parts[0], parts[1] - 1, parts[2]) / 86400000);
  }
  function overlapDaysISO(startA, endExclusiveA, startB, endExclusiveB) {
    const a1 = isoDayNumber(startA);
    const a2 = isoDayNumber(endExclusiveA);
    const b1 = isoDayNumber(startB);
    const b2 = isoDayNumber(endExclusiveB);
    if ([a1, a2, b1, b2].some(v => v == null)) return 0;
    return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
  }
  function daysBetweenISO(fromISO, toISO = todayISO()) {
    const from = parseISODate(fromISO);
    const to = parseISODate(toISO);
    if (!from || !to) return 0;
    return Math.round((to.getTime() - from.getTime()) / 86400000);
  }
  function statusActionTarget(status) {
    if (status === STATUS_SELECT) return STATUS_CHOSEN;
    if (status === STATUS_CHOSEN) return STATUS_READY;
    return '';
  }
  function normalizeClientCode(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/^а/, 'a')
      .replace(/[\s\u2010-\u2015-]+/g, '');
  }
  function normalizeSearchText(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/а/g, 'a')
      .replace(/[\s\u2010-\u2015-]+/g, '');
  }
  function compareClientCodes(left, right) {
    const a = normalizeClientCode(left);
    const b = normalizeClientCode(right);
    const aNumber = /^a(\d+)$/.exec(a);
    const bNumber = /^a(\d+)$/.exec(b);
    if (aNumber && bNumber) return Number(aNumber[1]) - Number(bNumber[1]);
    if (aNumber) return -1;
    if (bNumber) return 1;
    return a.localeCompare(b, 'ru', { numeric: true, sensitivity: 'base' });
  }
  function clientReviewsRemaining(state, mentor) {
    const code = normalizeClientCode(mentor && mentor.code);
    if (!code) return 0;
    const client = (state.clients || []).find(item => normalizeClientCode(item.code) === code);
    if (!client) return 0;

    const mentorIds = new Set((state.mentors || [])
      .filter(item => normalizeClientCode(item.code) === code)
      .map(item => item.id));
    const statuses = state.profileStatuses || [];
    const realDone = (state.reviews || []).filter(review =>
      mentorIds.has(review.mentorId)
      && review.moderation === 'approved'
      && statuses.some(status =>
        status.mentorId === review.mentorId
        && status.profileId === review.profileId
        && status.status === STATUS_READY
      )
    ).length;
    const done = Math.max(realDone, Number(client.manualDone) || 0);
    return Math.max(0, (Number(client.ordered) || 0) - done);
  }
  function clientForStatusMentor(state, mentorId) {
    const mentor = (state.mentors || []).find(item => item.id === mentorId);
    const code = normalizeClientCode(mentor && mentor.code);
    if (!code) return null;
    return (state.clients || []).find(item => normalizeClientCode(item.code) === code) || null;
  }
  const OUTREACH_WORK_STATUSES = new Set(PROFILE_STATUSES.slice(1, -1));
  function statusOutreachStartDates(rec) {
    if (!rec) return [];
    const timeline = [
      ...(Array.isArray(rec.history) ? rec.history : []),
      { status: rec.status, date: rec.date }
    ];
    const starts = [];
    let previousStatus = '';
    timeline.forEach(item => {
      const status = String(item && item.status || '');
      const date = String(item && item.date || '').slice(0, 10);
      const isWork = OUTREACH_WORK_STATUSES.has(status);
      const previousWasWork = OUTREACH_WORK_STATUSES.has(previousStatus);
      if (isWork && !previousWasWork && /^\d{4}-\d{2}-\d{2}$/.test(date)) starts.push(date);
      previousStatus = status;
    });
    return starts;
  }
  function statusOutreachStartDate(rec) {
    return statusOutreachStartDates(rec)[0] || '';
  }
  function clientOutreachStartsByDate(state, client) {
    const code = normalizeClientCode(client && client.code);
    const map = {};
    if (!code) return map;
    const mentorIds = new Set((state && state.mentors || [])
      .filter(item => normalizeClientCode(item.code) === code)
      .map(item => item.id));
    (state && state.profileStatuses || []).forEach(rec => {
      if (!mentorIds.has(rec.mentorId)) return;
      statusOutreachStartDates(rec).forEach(date => {
        map[date] = (map[date] || 0) + 1;
      });
    });
    return map;
  }
  function clientScheduleBreakdown(state, client) {
    const plannedByDate = {};
    (Array.isArray(client && client.schedule) ? client.schedule : []).forEach(item => {
      const date = String(item && item.date || '').slice(0, 10);
      const count = Math.max(0, Number(item && item.count) || 0);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !count) return;
      plannedByDate[date] = (plannedByDate[date] || 0) + count;
    });
    const starts = clientOutreachStartsByDate(state || {}, client);
    return Object.keys(plannedByDate).sort().map(date => {
      const planned = plannedByDate[date];
      const completedStarts = Math.max(0, Number(starts[date]) || 0);
      const completed = Math.min(planned, completedStarts);
      return {
        date,
        planned,
        completed,
        completedStarts,
        remaining: Math.max(0, planned - completedStarts)
      };
    });
  }
  function scheduledReviewCount(client, state) {
    if (state) {
      return clientScheduleBreakdown(state, client)
        .reduce((sum, item) => sum + item.remaining, 0);
    }
    return (Array.isArray(client && client.schedule) ? client.schedule : [])
      .reduce((sum, item) => sum + Math.max(0, Number(item && item.count) || 0), 0);
  }
  function manualScheduleLimit(state, client) {
    const code = normalizeClientCode(client && client.code);
    const ordered = Math.max(0, Number(client && client.ordered) || 0);
    if (!code || !ordered) return 0;
    const mentorIds = new Set((state.mentors || [])
      .filter(item => normalizeClientCode(item.code) === code)
      .map(item => item.id));
    const statuses = (state.profileStatuses || []).filter(item => mentorIds.has(item.mentorId));
    const done = Math.max(
      statuses.filter(item => item.status === STATUS_READY).length,
      Math.max(0, Number(client && client.manualDone) || 0)
    );
    const active = statuses.filter(item =>
      item.status !== PROFILE_STATUSES[0] && item.status !== STATUS_READY
    ).length;
    return Math.max(0, ordered - done - active);
  }
  function statusActionDefaultDays(rec, state) {
    if (!rec) return 0;
    if (rec.status === STATUS_SELECT) return STATUS_SELECT_WAIT_DAYS;
    if (rec.status !== STATUS_CHOSEN) return 0;
    const client = clientForStatusMentor(state || {}, rec.mentorId);
    const niche = client && client.niche;
    const config = niche && state && state.nicheConfig && state.nicheConfig[niche];
    const configured = config && Number(config.daysToPublish);
    return configured > 0 ? configured : STATUS_CHOSEN_FALLBACK_DAYS;
  }

  function clientPublicationMinimumDays(state, client) {
    if (!client) return 0;
    const niche = String(client.niche || '').trim();
    const config = niche && state && state.nicheConfig && state.nicheConfig[niche];
    const explicit = config && Number(config.clientMinPublicationDays);
    if (explicit >= 0 && Number.isFinite(explicit)) return explicit;
    // Для ремонта внутренний контроль остаётся на 30-м дне, но клиент может
    // предложить дату начиная с 20-го дня. Для остальных ниш минимум совпадает
    // с обычной паузой «Выбран → Опубликован».
    if (niche === 'remont') return 20;
    const configured = config && Number(config.daysToPublish);
    return configured > 0 ? configured : 0;
  }
  function deriveStatusAction(rec, state, today = todayISO()) {
    const targetStatus = statusActionTarget(rec && rec.status);
    if (!rec || !targetStatus) return null;
    const waitDays = statusActionDefaultDays(rec, state || {});
    const statusDate = String(rec.date || today).slice(0, 10);
    const storedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(rec.nextActionDate || ''))
      ? String(rec.nextActionDate).slice(0, 10)
      : '';
    const date = storedDate || addDaysISO(statusDate, waitDays);
    const daysInStatus = Math.max(0, daysBetweenISO(statusDate, today));
    const daysOverdue = daysBetweenISO(date, today);
    return {
      date,
      targetStatus,
      waitDays,
      daysInStatus,
      daysOverdue,
      dueState: daysOverdue > 0 ? 'overdue' : daysOverdue === 0 ? 'today' : 'future',
      mode: storedDate ? (rec.nextActionMode || 'manual') : 'legacy-auto',
      note: rec.status === STATUS_SELECT
        ? `Перевести ${STATUS_SELECT} → ${STATUS_CHOSEN}`
        : `Опубликовать отзыв и перевести ${STATUS_CHOSEN} → ${STATUS_READY}`
    };
  }

  function fmtMoney(v) {
    if (v == null || isNaN(v)) return '0 ₽';
    const n = Number(v);
    return n.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ₽';
  }
  function fmtDate(iso) {
    if (!iso) return '';
    // Поддерживаем и YYYY-MM-DD, и полный ISO-таймштамп (2026-04-21T00:00:00Z).
    // Без slice старый код возвращал «21T00:00:00Z.04.2026» — баг.
    const s = String(iso).slice(0, 10);
    const [y, m, d] = s.split('-');
    if (!y || !m || !d) return s;
    return `${d}.${m}.${y}`;
  }
  function monthKey(iso) { return iso ? iso.slice(0, 7) : ''; }
  function monthLabel(key) {
    if (!key) return '';
    const [y, m] = key.split('-');
    const names = ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
    return `${names[parseInt(m,10)-1]} ${y}`;
  }

  /**
   * Нормализация "площадки" из сида → наш справочник SERVICES
   */
  function normalizeService(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return 'Прочие услуги';
    if (s.startsWith('проф')) return 'Профи.ру';
    if (s.startsWith('авит')) return 'Авито';
    if (s.startsWith('2')) return '2ГИС';
    if (s.includes('яндекс')) return 'Яндекс';
    if (s.includes('консул')) return 'Консультация';
    return 'Прочие услуги';
  }

  /**
   * Нормализация категории расхода из сида → наш справочник EXPENSE_CATEGORIES
   */
  function normalizeExpenseCategory(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return 'Прочее';
    if (s.includes('прокси')) return 'Прокси';
    if (s.includes('софт') || s.includes('соф') || s.startsWith('c')) return 'Софт';
    if (s.includes('номер') || s.includes('тг') || s.includes('аккаунт')) return 'Реклама - Номера';
    if (s.includes('исполн') || s.includes('зарпл') || s.includes('зп')) return 'Зарплаты';
    return 'Прочее';
  }

  /* ------------------------------------------------------------------ */
  /* Store                                                              */
  /* ------------------------------------------------------------------ */
  const Store = {
    state: null,

    load() {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        try { this.state = JSON.parse(raw); }
        catch { this.state = null; }
      }
      if (!this.state || !this.state.initialized) this._seed();
      // защитные дефолты
      this.state.income ??= [];
      this.state.expenses ??= [];
      this.state.clients ??= [];
      this.state.employees ??= [];
      this.state.subscriptions ??= [];
      // новые коллекции (модуль связи / IP / статусы / номера)
      this.state.mentors ??= [];
      this.state.profiles ??= [];
      this.state.profileStatuses ??= [];
      this.state.ipLogs ??= [];
      this.state.phones ??= [];
      this.state.accountRegs ??= [];   // регистрации аккаунтов: TG/Яндекс/Авито/2ГИС/почта Профи
      this.state.archivedProfiles ??= []; // удалённые аккаунты: хранятся чтобы не терять историю IP/связей/номеров
      this.state.reviews ??= [];        // отзывы на модерации: см. Store.addReview / approveReview / rejectReview
      this.state.proxyLinks ??= [];     // ссылки для смены IP (LTE-Center и др.)
      this.state.dailyTasks ??= [];     // ежедневные задачи Насте: с какого аккаунта работать с каким клиентом
      this.state.clientPortals ??= [];  // доступы клиентов (Флагман и т.п.) к личному кабинету: см. addClientPortal
      // Реквизиты для оплаты + тарифы владелец редактирует в CRM. Клиентские
      // снимки получают их для альтернативной оплаты переводом с чеком.
      // tariffs: {id, name, price, qty, unit}. unit='package' — фикс-пакет
      // (price=итог, qty=число отзывов); unit='per' — за штуку (price=цена/шт,
      // qty=минимум, клиент сам выбирает количество, сумма=price×qty).
      this.state.paymentSettings ??= {
        // requisites — структурированный объект: каждое поле клиент копирует
        // отдельной кнопкой в кабинете. (legacy: мог быть строкой — мигрируем
        // в модалке «Реквизиты» в поле note.)
        requisites: { sbpPhone: '', bank: '', card: '', recipient: '', note: '' },
        tariffs: DEFAULT_PAYMENT_TARIFFS.map(t => ({ ...t })),
        updatedAt: null
      };
      this._normalizePaymentSettings();
      this.state.clients.forEach(c => { c.tariff = mapTariff(c.tariff); });
      this.state.clients.forEach(c => {
        if (!PERFORMERS.includes(c.manager)) c.manager = '';
      });
      this._migrateManagerPayroll();
      this._syncEmployeeWorkCounts();
      // Справочник ниш и пауз «Выбран → Опубликован» в днях.
      // Используется ботом для напоминаний публиковать отзыв (см. A3).
      // ⭐ ключ — это код категории, который проставляется у клиента (clients[].niche).
      this.state.nicheConfig ??= {
        repetitor: { label: 'Репетитор', daysToPublish: 2, clientMinPublicationDays: 2 },
        design:    { label: 'Дизайн интерьера', daysToPublish: 5, clientMinPublicationDays: 5 },
        remont:    { label: 'Ремонт квартир', daysToPublish: 30, clientMinPublicationDays: 20 },
        beauty:    { label: 'Косметология', daysToPublish: 3, clientMinPublicationDays: 3 },
        legal:     { label: 'Юридические услуги', daysToPublish: 7, clientMinPublicationDays: 7 },
        other:     { label: 'Другое', daysToPublish: 5, clientMinPublicationDays: 5 },
      };
      this._migrateSeparatedTaskPlanDate();
      this._migrateNormalizePhones();
      this._migrateRenameDialogStatus();
      // Бэкфилл менторов из клиентов: если клиент был создан на странице
      // «Клиенты» и не имеет пары в state.mentors — создаём её здесь, чтобы
      // клиент был доступен в модалке «Добавить в аккаунт» без перезагрузки.
      // Пишем только локально (без push), чтобы не гоняться с cloud-sync pull.
      const addedMentors = this._backfillMentorsFromClients();
      if (addedMentors > 0) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); } catch (_) {}
      }
      // Подчистим «осиротевших» менторов: их клиент удалён, и они нигде
      // не используются (ни в profiles, ни в profileStatuses, ни в reviews).
      // Иначе a21 и подобные тестовые записи продолжали бы висеть в дропдаунах.
      const removedOrphans = this._cleanupOrphanMentors();
      this._lastOrphansRemoved = removedOrphans;
      if (removedOrphans > 0) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); } catch (_) {}
      }
      return this.state;
    },

    /** Удаляет менторов, у которых нет клиента с таким же code и которые
     *  нигде не используются. Возвращает количество удалённых. Идемпотентно. */
    _cleanupOrphanMentors() {
      const clients = this.state.clients || [];
      const clientCodes = new Set(
        clients.map(c => String(c.code || '').toLowerCase().trim()).filter(Boolean)
      );
      const usedInProfiles = new Set();
      [...(this.state.profiles || []), ...(this.state.archivedProfiles || [])]
        .forEach(p => (p.mentorIds || []).forEach(id => usedInProfiles.add(id)));
      const usedInStatuses = new Set((this.state.profileStatuses || []).map(s => s.mentorId));
      const usedInReviews  = new Set((this.state.reviews || []).map(r => r.mentorId));

      const before = (this.state.mentors || []).length;
      this.state.mentors = (this.state.mentors || []).filter(m => {
        const code = String(m.code || '').toLowerCase().trim();
        if (clientCodes.has(code)) return true;          // клиент есть — оставляем
        if (usedInProfiles.has(m.id)) return true;       // привязан к аккаунту
        if (usedInStatuses.has(m.id)) return true;       // есть история статуса
        if (usedInReviews.has(m.id))  return true;       // есть отзывы
        return false;                                     // полностью осиротел — выпиливаем
      });
      return before - this.state.mentors.length;
    },

    /** Однократная очистка legacy 12-значных номеров (артефакт float-парсинга xlsx).
     *  Идемпотентно: если всё уже норм — ничего не пишет. */
    _migrateNormalizePhones() {
      let changed = false;
      (this.state.phones || []).forEach(p => {
        const n = this._normalizePhone(p.number);
        if (n && n !== p.number) { p.number = n; changed = true; }
      });
      (this.state.accountRegs || []).forEach(r => {
        ['phone','avitoPhone'].forEach(f => {
          const n = this._normalizePhone(r[f]);
          if (n !== (r[f] || '') && (r[f] || '').length) {
            r[f] = n; changed = true;
          }
        });
      });
      // После нормализации — допривяжем phones[].profileId по совпадению с accountRegs
      if (changed) {
        const idx = new Map();
        (this.state.accountRegs || []).forEach(r => {
          ['phone','avitoPhone'].forEach(f => {
            if (r[f]) idx.set(r[f], r.profileId);
          });
        });
        (this.state.phones || []).forEach(p => {
          if (!p.profileId && idx.has(p.number)) p.profileId = idx.get(p.number);
        });
        // ⚠️ только локально — push отложим до первого действия пользователя,
        // чтобы не гоняться с pull в cloud-sync.
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); } catch (_) {}
      }
    },

    /** Одноразовое переименование статуса «💬 Диалог Начат» → «💬 Диалог Начать»
     *  (владелец исправил формулировку). Правим и текущий статус, и историю.
     *  Идемпотентно: если старой формы нет — ничего не пишет. Пишем локально
     *  (push отложен до первого действия — как в _migrateNormalizePhones). */
    _migrateRenameDialogStatus() {
      const OLD = '💬 Диалог Начат', NEW = '💬 Диалог Начать';
      let changed = false;
      (this.state.profileStatuses || []).forEach(s => {
        if (s.status === OLD) { s.status = NEW; changed = true; }
        (s.history || []).forEach(h => {
          if (h.status === OLD) { h.status = NEW; changed = true; }
        });
      });
      if (changed) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); } catch (_) {}
      }
    },

    /** Исправляет записи, созданные короткоживущей версией планировщика,
     *  которая записывала рабочую дату поверх исходного nextActionDate.
     *  updatedAt у profileStatuses выставляла только та версия, поэтому
     *  обычные ручные сроки из карточки аккаунта миграция не затрагивает. */
    _migrateSeparatedTaskPlanDate() {
      let changed = 0;
      (this.state.profileStatuses || []).forEach(rec => {
        if (rec.taskPlanSchema === 'separate-v1' || rec.plannedActionDate || !rec.updatedAt || rec.nextActionMode !== 'manual') return;
        const plannedDate = String(rec.nextActionDate || '').slice(0, 10);
        const targetStatus = statusActionTarget(rec.status);
        if (!targetStatus || !/^\d{4}-\d{2}-\d{2}$/.test(plannedDate)) return;
        rec.plannedActionDate = plannedDate;
        rec.nextActionDate = addDaysISO(
          rec.date || todayISO(),
          statusActionDefaultDays(rec, this.state)
        );
        rec.nextActionStatus = targetStatus;
        rec.nextActionMode = 'auto';
        rec.taskPlanSchema = 'separate-v1';
        rec.taskPlanMigration = '20260805-separated-dates';
        changed++;
      });
      if (changed) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); } catch (_) {}
      }
      return changed;
    },

    save() {
      this._syncEmployeeWorkCounts();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      // Облачная синхронизация (если подключена)
      if (window.CloudSync && window.CloudSync.isConfigured()) {
        window.CloudSync.push(this.state);
      }
    },

    reset() {
      localStorage.removeItem(STORAGE_KEY);
      this.state = null;
      this.load();
    },

    /** Начальный сид — собирается из /data/seed.js при первом запуске */
    _seed() {
      // Доходы — из SEED_INCOMES
      const income = (window.SEED_INCOMES || []).map(r => ({
        id: uid(),
        date: r.date,
        client: r.client || '—',
        service: normalizeService(r.platform),
        amount: Number(r.sum) || 0,
        comment: r.qty != null ? `Кол-во: ${r.qty}` : ''
      }));

      // Расходы — из SEED_EXPENSES, нормализуем категории
      const expenses = (window.SEED_EXPENSES || []).map(r => ({
        id: uid(),
        date: r.date,
        category: normalizeExpenseCategory(r.category),
        amount: Number(r.sum) || 0,
        comment: r.category || ''  // храним исходное имя как комментарий
      }));

      // Клиенты — из SEED_CLIENTS, приводим тариф к нашим 3 вариантам
      const clients = (window.SEED_CLIENTS || []).map(c => ({
        id: uid(),
        platform: c.platform || '',
        name: c.name || '',
        code: c.code || '',
        tariff: mapTariff(c.tariff),
        ordered: Number(c.ordered) || 0,
        done: Number(c.done) || 0,
        paid: Number(c.paid) || 0,
        remain: Number(c.remain) || 0,
        total: Number(c.total) || 0,
        date: c.date || '',
        deadline: c.deadline || '',
        overdueDays: Number(c.overdueDays) || 0
      }));

      // Подписки — из SEED_SUBSCRIPTIONS, без привязки к клиенту (можно привязать в UI)
      const subscriptions = (window.SEED_SUBSCRIPTIONS || []).map(s => ({
        id: uid(),
        name: s.name || '',
        clientId: null,
        tariff: '',
        frequency: s.frequency || 'Каждые 30 дней',
        amount: Number(s.amount) || 0,
        status: (s.status || '').trim().toLowerCase().startsWith('опл') ? 'оплачен' : 'не оплачен',
        nextDate: s.nextDate || ''
      }));

      // Менеджеры откликов. Данил — владелец, поэтому его ставка по умолчанию
      // нулевая; при необходимости она редактируется на странице сотрудников.
      const employees = [
        {
          id: uid(),
          name: 'Илья',
          role: 'Менеджер',
          ratePerReview: 300,
          reviewsDone: 0,
          paid: 0,
          status: 'active',
          hired: tomorrowISO(),
          payments: []
        },
        {
          id: uid(),
          name: 'Данил',
          role: 'Менеджер',
          ratePerReview: 0,
          reviewsDone: 0,
          paid: 0,
          status: 'active',
          hired: tomorrowISO(),
          payments: []
        }
      ];

      this.state = {
        initialized: true,
        version: 2,
        income,
        expenses,
        clients,
        employees,
        subscriptions
      };
      // ⚠️ НЕ вызываем this.save() здесь: это улетит в облако и затрёт
      // боевое состояние раньше, чем cloud-sync успеет сделать pull.
      // Достаточно положить сид в localStorage; дальше pull либо оставит
      // сид (если облако пустое — cloud-sync сам запушит), либо заменит
      // сид облачным state.
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); } catch (_) {}
    },

    /* ---------- Income ---------- */
    /**
     * Добавление дохода. Если передан rec.items = [{accountId, amount}, ...]
     * — автоматически распределяем оплату по анкетам и синхронизируем
     * client.paid / client.remain.
     */
    addIncome(rec) {
      const item = Object.assign({
        id: uid(), date: todayISO(),
        client: '', service: SERVICES[0],
        amount: 0, comment: '',
        source: 'crm',
        createdAt: new Date().toISOString(),  // точное время добавления — для «Пульса кэша»
        items: null   // null = старый формат (по тексту); [] = распределённый
      }, rec);
      if (!item.createdAt) item.createdAt = new Date().toISOString();

      // Если есть items — пересчитать сумму и автоподписать клиента
      if (Array.isArray(item.items) && item.items.length > 0) {
        item.items = item.items
          .filter(x => x.accountId && Number(x.amount) > 0)
          .map(x => ({ accountId: x.accountId, amount: Number(x.amount) }));
        item.amount = item.items.reduce((s, x) => s + x.amount, 0);
        // Автозаполнить текстовое поле client = "A15 Варвара, A16 Никита"
        if (!item.client) {
          item.client = item.items.map(x => {
            const c = this.state.clients.find(cl => cl.id === x.accountId);
            return c ? `${c.code || ''} ${c.name || ''}`.trim() : '';
          }).filter(Boolean).join(', ');
        }
        // Раскидать paid по клиентам
        this._applyPaymentItems(item.items, +1);
      }

      this.state.income.push(item);
      this.save();
      return item;
    },

    updateIncome(id, patch) {
      const i = this.state.income.findIndex(x => x.id === id);
      if (i < 0) return;

      const old = this.state.income[i];
      const next = Object.assign({}, old, patch);

      // Если меняются items — откатить старые, применить новые
      if ('items' in patch) {
        if (Array.isArray(old.items) && old.items.length) {
          this._applyPaymentItems(old.items, -1);
        }
        if (Array.isArray(next.items) && next.items.length) {
          next.items = next.items
            .filter(x => x.accountId && Number(x.amount) > 0)
            .map(x => ({ accountId: x.accountId, amount: Number(x.amount) }));
          next.amount = next.items.reduce((s, x) => s + x.amount, 0);
          this._applyPaymentItems(next.items, +1);
        }
      }

      this.state.income[i] = next;
      this.save();
    },

    deleteIncome(id) {
      const rec = this.state.income.find(x => x.id === id);
      if (rec && Array.isArray(rec.items) && rec.items.length) {
        // откатить оплату
        this._applyPaymentItems(rec.items, -1);
      }
      this.state.income = this.state.income.filter(x => x.id !== id);
      this.save();
    },

    /** Применить (sign=+1) или откатить (sign=-1) набор items к client.paid/remain */
    _applyPaymentItems(items, sign) {
      items.forEach(({ accountId, amount }) => {
        const c = this.state.clients.find(x => x.id === accountId);
        if (!c) return;
        const delta = sign * Number(amount);
        c.paid = Math.max(0, (Number(c.paid) || 0) + delta);
        c.remain = Math.max(0, (Number(c.remain) || 0) - delta);
      });
    },

    /** Все доходы, в которых участвует данный клиент (по items.accountId) */
    getPaymentsForClient(clientId) {
      const list = [];
      (this.state.income || []).forEach(inc => {
        if (!Array.isArray(inc.items)) return;
        inc.items.forEach(it => {
          if (it.accountId === clientId) {
            list.push({
              incomeId: inc.id,
              date: inc.date,
              amount: Number(it.amount) || 0,
              service: inc.service,
              comment: inc.comment || ''
            });
          }
        });
      });
      return list.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    },

    /* ---------- Expenses ---------- */
    addExpense(rec) {
      const item = Object.assign({
        id: uid(), date: todayISO(),
        category: EXPENSE_CATEGORIES[0],
        amount: 0, comment: '',
        source: 'crm',
        createdAt: new Date().toISOString()  // точное время добавления — для «Пульса кэша»
      }, rec);
      if (!item.createdAt) item.createdAt = new Date().toISOString();
      if (!this._validInfrastructureScope(item.costScope, item.category, item.personal)) {
        delete item.costScope;
      }
      this.state.expenses.push(item);
      this.save();
      return item;
    },
    updateExpense(id, patch) {
      const i = this.state.expenses.findIndex(x => x.id === id);
      if (i < 0) return;
      const next = Object.assign({}, this.state.expenses[i], patch);
      if (!this._validInfrastructureScope(next.costScope, next.category, next.personal)) {
        delete next.costScope;
      }
      this.state.expenses[i] = next;
      this.save();
    },
    deleteExpense(id) {
      this.state.expenses = this.state.expenses.filter(x => x.id !== id);
      this.save();
    },

    _validInfrastructureScope(scope, category, personal) {
      if (personal) return false;
      if (scope === 'account_software') return category === 'Софт';
      if (scope === 'account_proxy') return category === 'Прокси';
      return !scope;
    },

    _normalizePaymentSettings() {
      const ps = this.state.paymentSettings || {};
      if (!Array.isArray(ps.tariffs)) ps.tariffs = [];
      const byId = Object.fromEntries(DEFAULT_PAYMENT_TARIFFS.map(t => [t.id, t]));
      const legacyByName = {
        'поддержка профиля': 'support',
        'поддержка': 'support',
        'развитие профиля': 'develop',
        'развитие': 'develop',
        'опт': 'wholesale',
        'постоянник': 'regular',
        'базовый': 'regular',
        'стандарт': 'wholesale',
        'премиум': 'develop'
      };
      const seen = new Set();
      const seenNames = new Set();
      const normalized = [];
      ps.tariffs.forEach(t => {
        const legacyId = legacyByName[String(t.name || '').trim().toLowerCase()];
        const id = byId[t.id] ? t.id : legacyId;
        if (id) {
          if (seen.has(id)) return;
          seen.add(id);
          seenNames.add(String(byId[id].name || '').trim().toLowerCase());
          normalized.push({ ...byId[id] });
          return;
        }
        const name = String(t.name || '').trim();
        const nameKey = name.toLowerCase();
        const price = Math.max(0, Number(t.price) || 0);
        const unit = t.unit === 'per' ? 'per' : 'package';
        const qty = Math.max(unit === 'per' ? 1 : 0, Number(t.qty) || 0);
        if (!name || !price || !qty || seenNames.has(nameKey)) return;
        let customId = String(t.id || '').trim();
        if (!customId || seen.has(customId)) customId = `custom-${uid()}`;
        seen.add(customId);
        seenNames.add(nameKey);
        normalized.push({ id: customId, name, price, qty, unit });
      });
      DEFAULT_PAYMENT_TARIFFS.forEach(t => {
        if (!seen.has(t.id)) {
          normalized.push({ ...t });
          seen.add(t.id);
          seenNames.add(String(t.name || '').trim().toLowerCase());
        }
      });
      ps.tariffs = normalized;
      // Оферта хранится только в /legal/offer.html. Удаляем устаревшую копию
      // из общего CRM-состояния, чтобы она не попадала в новые снимки клиентов.
      delete ps.offerText;
      this.state.paymentSettings = ps;
    },

    /* ---------- Clients ---------- */
    findClientCodeOwner(value, options = {}) {
      const code = normalizeClientCode(value);
      if (!code) return null;
      const excludeClientId = String(options.excludeClientId || '');
      const excludeMentorId = String(options.excludeMentorId || '');
      const client = (this.state.clients || []).find(item =>
        String(item.id || '') !== excludeClientId && normalizeClientCode(item.code) === code
      );
      if (client) return { kind: 'client', record: client };
      const mentor = (this.state.mentors || []).find(item =>
        String(item.id || '') !== excludeMentorId && normalizeClientCode(item.code) === code
      );
      return mentor ? { kind: 'mentor', record: mentor } : null;
    },
    addClient(rec) {
      const requestedCode = String(rec && rec.code || '').trim();
      if (requestedCode && this.findClientCodeOwner(requestedCode)) return null;
      const item = Object.assign({
        id: uid(),
        platform: '', name: '', code: '', tariff: '',
        ordered: 0, done: 0,
        paid: 0, remain: 0, total: 0,
        allowRegularTariff: false,
        date: todayISO(), deadline: '', overdueDays: 0,
        assignedEmail: '', manager: '',
        profileUrl: '', avatarUrl: '', avatarUpdatedAt: ''
      }, rec);
      // нормализация email
      if (item.assignedEmail) item.assignedEmail = String(item.assignedEmail).toLowerCase().trim();
      this.state.clients.push(item);
      // Автосинк: создать ментора с тем же кодом, если его ещё нет,
      // чтобы клиент сразу был доступен в модалке «Добавить в аккаунт».
      this._ensureMentorForClient(item);
      this.save();
      return item;
    },
    updateClient(id, patch) {
      const i = this.state.clients.findIndex(x => x.id === id);
      if (i < 0) return;
      if (patch && typeof patch.assignedEmail === 'string') {
        patch.assignedEmail = patch.assignedEmail.toLowerCase().trim();
      }
      this.state.clients[i] = Object.assign({}, this.state.clients[i], patch);
      // Синк имени/кода в связанного ментора (если они изменились).
      this._ensureMentorForClient(this.state.clients[i]);
      this.save();
    },
    deleteClient(id) {
      const client = (this.state.clients || []).find(x => x.id === id);
      this.state.clients = this.state.clients.filter(x => x.id !== id);
      // Каскад: удалить ассоциированного ментора (по code) — иначе клиент
      // продолжит появляться в выпадающих списках на страницах «Аккаунты» и
      // «Связи». deleteMentor сам подчистит profileStatuses и mentorIds.
      if (client && client.code) {
        const code = String(client.code).toLowerCase().trim();
        const mentor = (this.state.mentors || []).find(
          m => String(m.code || '').toLowerCase().trim() === code
        );
        if (mentor) {
          // удалим связанные отзывы
          this.state.reviews = (this.state.reviews || []).filter(r => r.mentorId !== mentor.id);
          // удалим ментора (без save — мы сделаем save один раз ниже)
          this.state.profiles.forEach(p => {
            if (Array.isArray(p.mentorIds)) p.mentorIds = p.mentorIds.filter(x => x !== mentor.id);
          });
          this.state.profileStatuses = (this.state.profileStatuses || []).filter(s => s.mentorId !== mentor.id);
          this.state.mentors = this.state.mentors.filter(x => x.id !== mentor.id);
        }
      }
      this.save();
    },

    /**
     * Гарантирует существование ментора с кодом клиента — чтобы клиенты,
     * заведённые на странице «Клиенты», появлялись в модалке «Добавить в аккаунт»
     * на странице «Аккаунты/Статусы». Если ментор с таким кодом уже есть —
     * подсинкаем имя, если оно пустое.
     */
    _ensureMentorForClient(client) {
      if (!client) return;
      const code = normalizeClientCode(client.code);
      if (!code) return;
      this.state.mentors = this.state.mentors || [];
      const existing = this.state.mentors.find(
        m => normalizeClientCode(m.code) === code
      );
      if (existing) {
        // Всегда синхронизируем имя клиента в ментора, чтобы переименование
        // в разделе «Клиенты» сразу отражалось в выпадающих списках на
        // страницах «Аккаунты», «Связи», «Задачи» и т.д.
        const cn = String(client.name || '').trim();
        if (cn && existing.name !== cn) existing.name = cn;
        existing.profileUrl = String(client.profileUrl || '');
        existing.avatarUrl = String(client.avatarUrl || '');
        return existing;
      }
      const mentor = {
        id: uid(),
        code,
        name: client.name || '',
        profileUrl: client.profileUrl || '',
        avatarUrl: client.avatarUrl || '',
        notes: '',
        createdAt: todayISO()
      };
      this.state.mentors.push(mentor);
      return mentor;
    },

    /**
     * Одноразовая миграция: для каждого клиента с code, у которого нет
     * соответствующего ментора, — создаёт ментора. Безопасна при повторных
     * вызовах (идемпотентна). Используется в Store.load().
     */
    _backfillMentorsFromClients() {
      const clients = this.state.clients || [];
      let added = 0;
      clients.forEach(c => {
        const before = (this.state.mentors || []).length;
        this._ensureMentorForClient(c);
        if ((this.state.mentors || []).length > before) added++;
      });
      return added;
    },

    /* ---------- Employees ---------- */
    _migrateManagerPayroll() {
      if (this.state._managerPayrollV1) return;
      const employees = this.state.employees || [];
      const legacy = employees.find(e => String(e.name || '').trim().toLowerCase() === 'настя');
      const kept = employees.filter(e => String(e.name || '').trim().toLowerCase() !== 'настя');
      const has = name => kept.some(e => String(e.name || '').trim().toLowerCase() === name.toLowerCase());
      if (!has('Илья')) {
        kept.push({
          id: uid(), name: 'Илья', role: 'Менеджер',
          ratePerReview: Number(legacy && legacy.ratePerReview) || 300,
          reviewsDone: 0, paid: 0, status: 'active',
          hired: todayISO(), payments: []
        });
      }
      if (!has('Данил')) {
        kept.push({
          id: uid(), name: 'Данил', role: 'Менеджер',
          ratePerReview: 0, reviewsDone: 0, paid: 0,
          status: 'active', hired: todayISO(), payments: []
        });
      }
      this.state.employees = kept;
      this.state._managerPayrollV1 = true;
    },
    _syncEmployeeWorkCounts() {
      if (!this.state) return false;
      const counts = new Map(PERFORMERS.map(name => [name, 0]));
      (this.state.profileStatuses || []).forEach(rec => {
        const performer = String(rec.performer || '').trim();
        if (counts.has(performer)) counts.set(performer, counts.get(performer) + 1);
      });
      let changed = false;
      (this.state.employees || []).forEach(emp => {
        const name = String(emp.name || '').trim();
        if (!counts.has(name)) return;
        const next = counts.get(name);
        if (Number(emp.reviewsDone || 0) !== next) {
          emp.reviewsDone = next;
          changed = true;
        }
      });
      return changed;
    },
    addEmployee(rec) {
      const item = Object.assign({
        id: uid(),
        name: '', role: 'Ревьюер',
        email: '',                  // привязка к Supabase Auth (lowercase)
        ratePerReview: 300,
        reviewsDone: 0,             // авто-считается reviews-sync.js
        paid: 0,
        advanceDebt: 0,             // долг сотрудника перед компанией
        status: 'active',
        hired: tomorrowISO(),
        payments: []
      }, rec);
      if (item.email) item.email = String(item.email).toLowerCase().trim();
      this.state.employees.push(item);
      this.save();
      return item;
    },
    updateEmployee(id, patch) {
      const i = this.state.employees.findIndex(x => x.id === id);
      if (i < 0) return;
      if (patch && typeof patch.email === 'string') {
        patch.email = patch.email.toLowerCase().trim();
      }
      this.state.employees[i] = Object.assign({}, this.state.employees[i], patch);
      this.save();
    },
    deleteEmployee(id) {
      this.state.employees = this.state.employees.filter(x => x.id !== id);
      this.save();
    },
    addPayment(employeeId, payment) {
      const e = this.state.employees.find(x => x.id === employeeId);
      if (!e) return;
      e.payments = e.payments || [];
      const p = Object.assign({ id: uid(), date: todayISO(), amount: 0, note: '' }, payment);
      p.amount = Math.max(0, Number(p.amount) || 0);
      if (p.amount <= 0) return null;
      const debtBefore = Math.max(0, Number(e.advanceDebt) || 0);
      p.debtOffset = Math.min(
        p.amount,
        debtBefore,
        Math.max(0, Number(p.debtOffset) || 0)
      );
      p.debtCreated = Math.max(0, Number(p.debtCreated) || 0);
      p.cashAmount = Object.prototype.hasOwnProperty.call(p, 'cashAmount')
        ? Math.max(0, Number(p.cashAmount) || 0)
        : Math.max(0, p.amount - p.debtOffset);
      e.payments.push(p);
      e.paid = (e.paid || 0) + p.amount;
      e.advanceDebt = Math.max(0, debtBefore - p.debtOffset + p.debtCreated);
      this.state.expenses ??= [];
      const expenseId = `employee-payment-${p.id}`;
      if (p.cashAmount > 0 && !this.state.expenses.some(x => x.id === expenseId)) {
        const expense = {
          id: expenseId,
          date: p.date || todayISO(),
          category: 'Зарплаты',
          amount: p.cashAmount,
          comment: `ЗП сотруднику ${e.name || '—'}${p.note ? ` · ${p.note}` : ''}`,
          personal: false,
          source: 'employee_payment',
          employeeId: e.id,
          employeePaymentId: p.id,
          createdAt: new Date().toISOString()
        };
        if (p.cashAmount !== p.amount) expense.grossAmount = p.amount;
        if (p.debtOffset > 0) expense.debtOffset = p.debtOffset;
        this.state.expenses.push(expense);
      }
      this.save();
      return p;
    },
    deletePayment(employeeId, paymentId) {
      const e = this.state.employees.find(x => x.id === employeeId);
      if (!e) return false;
      const payment = (e.payments || []).find(p => p.id === paymentId);
      if (!payment) return false;
      if (payment.locked === true) return false;
      e.payments = (e.payments || []).filter(p => p.id !== paymentId);
      e.paid = Math.max(0, (Number(e.paid) || 0) - (Number(payment.amount) || 0));
      e.advanceDebt = Math.max(
        0,
        (Number(e.advanceDebt) || 0)
          + (Number(payment.debtOffset) || 0)
          - (Number(payment.debtCreated) || 0)
      );
      this.state.expenses = (this.state.expenses || []).filter(x =>
        x.id !== `employee-payment-${paymentId}` && x.employeePaymentId !== paymentId
      );
      this.save();
      return true;
    },

    /* ---------- Subscriptions ---------- */
    addSubscription(rec) {
      const item = Object.assign({
        id: uid(),
        name: '', clientId: null, tariff: '',
        frequency: 'Каждые 30 дней',
        amount: 0, status: 'оплачен',
        nextDate: addMonthsISO(todayISO(), 1),
        costScope: ''
      }, rec);
      item.costScope = this.inferSubscriptionCostScope(item.name, item.costScope);
      this.state.subscriptions.push(item);
      this.save();
      return item;
    },
    updateSubscription(id, patch) {
      const i = this.state.subscriptions.findIndex(x => x.id === id);
      if (i < 0) return;
      const next = Object.assign({}, this.state.subscriptions[i], patch);
      next.costScope = this.inferSubscriptionCostScope(next.name, next.costScope);
      this.state.subscriptions[i] = next;
      this.save();
      return next;
    },
    deleteSubscription(id) {
      this.state.subscriptions = this.state.subscriptions.filter(x => x.id !== id);
      this.save();
    },

    inferSubscriptionCostScope(name, current) {
      if (current === 'general') return 'general';
      if (current === 'account_software' || current === 'account_proxy') return current;
      const value = String(name || '').trim().toLowerCase();
      if (value.includes('прокси') || value.includes('proxy')) return 'account_proxy';
      if (value.includes('dicloak') || value.includes('антидетект')) return 'account_software';
      return '';
    },

    inferExpenseCostScope(expense) {
      if (!expense || expense.personal || expense.costScope === 'general') return '';
      if (expense.costScope === 'account_software' || expense.costScope === 'account_proxy') {
        return expense.costScope;
      }
      const text = [expense.category, expense.comment, expense.name]
        .map(value => String(value || '').trim().toLowerCase())
        .join(' ');
      if (/\b(?:vpn|впн)\b/.test(text)) return '';
      const category = String(expense.category || '').trim().toLowerCase();
      if (category === 'прокси' || text.includes('proxy')) return 'account_proxy';
      if (category === 'софт' || text.includes('dicloak') || text.includes('антидетект')) {
        return 'account_software';
      }
      return '';
    },

    subscriptionPeriodEnd(start, frequency) {
      const value = String(frequency || '').toLowerCase();
      if (value.includes('7')) return addDaysISO(start, 7);
      if (value.includes('90')) return addMonthsISO(start, 3);
      if (value.includes('год')) return addMonthsISO(start, 12);
      return addMonthsISO(start, 1);
    },

    recordSubscriptionPayment(subscriptionId, options = {}) {
      const subscription = (this.state.subscriptions || []).find(item => item.id === subscriptionId);
      if (!subscription) return null;
      const scope = this.inferSubscriptionCostScope(subscription.name, subscription.costScope);
      if (scope !== 'account_software' && scope !== 'account_proxy') return null;
      const paymentAmount = Number(options.amount ?? subscription.amount);
      if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) return null;
      const coverageStart = String(options.coverageStart || todayISO()).slice(0, 10);
      const coverageEnd = String(
        options.coverageEnd || this.subscriptionPeriodEnd(coverageStart, subscription.frequency)
      ).slice(0, 10);
      const paymentId = `subscription-payment-${subscription.id}-${coverageStart}`;
      const existing = (this.state.expenses || []).find(expense =>
        expense.id === paymentId ||
        (expense.subscriptionId === subscription.id && expense.costCoverageStart === coverageStart)
      );
      if (existing) return existing;
      const category = scope === 'account_proxy' ? 'Прокси' : 'Софт';
      return this.addExpense({
        id: paymentId,
        date: String(options.date || todayISO()).slice(0, 10),
        category,
        amount: paymentAmount,
        comment: `Оплата подписки: ${subscription.name || category}`,
        source: 'subscription_payment',
        subscriptionId: subscription.id,
        costScope: scope,
        costCoverageStart: coverageStart,
        costCoverageEnd: coverageEnd
      });
    },

    renewSubscription(subscriptionId, options = {}) {
      const subscription = (this.state.subscriptions || []).find(item => item.id === subscriptionId);
      if (!subscription) return null;
      const scope = this.inferSubscriptionCostScope(subscription.name, subscription.costScope);
      const isInfrastructure = scope === 'account_software' || scope === 'account_proxy';
      const paymentAmount = Number(options.amount ?? subscription.amount);
      if (isInfrastructure && (!Number.isFinite(paymentAmount) || paymentAmount <= 0)) return null;

      const coverageStart = String(options.coverageStart || subscription.nextDate || todayISO()).slice(0, 10);
      const coverageEnd = String(
        options.coverageEnd || this.subscriptionPeriodEnd(coverageStart, subscription.frequency)
      ).slice(0, 10);
      let expense = null;
      if (isInfrastructure) {
        const paymentId = `subscription-payment-${subscription.id}-${coverageStart}`;
        expense = (this.state.expenses || []).find(item =>
          item.id === paymentId ||
          (item.subscriptionId === subscription.id && item.costCoverageStart === coverageStart)
        );
        if (!expense) {
          const category = scope === 'account_proxy' ? 'Прокси' : 'Софт';
          expense = {
            id: paymentId,
            date: String(options.date || todayISO()).slice(0, 10),
            category,
            amount: paymentAmount,
            comment: `Оплата подписки: ${subscription.name || category}`,
            personal: false,
            source: 'subscription_payment',
            createdAt: new Date().toISOString(),
            subscriptionId: subscription.id,
            costScope: scope,
            costCoverageStart: coverageStart,
            costCoverageEnd: coverageEnd
          };
          this.state.expenses.push(expense);
        }
      }

      if (Number.isFinite(paymentAmount) && paymentAmount >= 0) subscription.amount = paymentAmount;
      subscription.costScope = scope || subscription.costScope || '';
      subscription.nextDate = coverageEnd;
      subscription.status = 'оплачен';
      this.save();
      return { subscription, expense, coverageStart, coverageEnd };
    },

    /* ====================================================================
       НОВЫЕ МОДУЛИ: mentors / profiles / statuses / ipLogs / phones
       ==================================================================== */

    /* ---------- Mentors (a1..aN — клиенты в новой модели) ---------- */
    addMentor(rec) {
      const requestedCode = String(rec && rec.code || '').trim() || this._nextMentorCode();
      if (this.findClientCodeOwner(requestedCode)) return null;
      const item = Object.assign({
        id: uid(),
        code: requestedCode,
        name: '',
        notes: '',
        createdAt: todayISO()
      }, rec);
      item.code = normalizeClientCode(requestedCode);
      this.state.mentors.push(item);
      this.save();
      return item;
    },
    updateMentor(id, patch) {
      const i = this.state.mentors.findIndex(x => x.id === id);
      if (i < 0) return;
      if (patch && typeof patch.code === 'string') patch.code = patch.code.toLowerCase().trim();
      this.state.mentors[i] = Object.assign({}, this.state.mentors[i], patch);
      this.save();
    },
    deleteMentor(id) {
      // также удалить из profiles.mentorIds, из profileStatuses и из reviews
      this.state.profiles.forEach(p => {
        if (Array.isArray(p.mentorIds)) p.mentorIds = p.mentorIds.filter(x => x !== id);
      });
      this.state.profileStatuses = (this.state.profileStatuses || []).filter(s => s.mentorId !== id);
      this.state.reviews = (this.state.reviews || []).filter(r => r.mentorId !== id);
      this.state.mentors = this.state.mentors.filter(x => x.id !== id);
      this.save();
    },
    _nextMentorCode() {
      const nums = [...(this.state.mentors || []), ...(this.state.clients || [])]
        .map(item => /^a(\d+)$/.exec(normalizeClientCode(item.code)))
        .filter(Boolean)
        .map(m => Number(m[1]));
      const next = (nums.length ? Math.max(...nums) : 0) + 1;
      return `a${next}`;
    },

    /* ---------- Profiles (аккаунты 2-1, 3-1 ...) ---------- */
    addProfile(rec) {
      const item = Object.assign({
        id: uid(),
        code: '',
        city: '',
        mentorIds: [],
        createdAt: todayISO(),
        softwareStartedAt: todayISO()
      }, rec);
      item.code = String(item.code || '').trim();
      if (!item.city) item.city = cityFromCode(item.code);
      if (!item.softwareStartedAt) item.softwareStartedAt = item.createdAt || todayISO();
      this.state.profiles.push(item);
      const defaultCloudPassword = this.getDefaultCloudPassword();
      if (defaultCloudPassword) {
        this.state.accountRegs.push(this._buildAccountReg(item.id, { cloudPassword: defaultCloudPassword }));
      }
      this.save();
      return item;
    },
    updateProfile(id, patch) {
      const i = this.state.profiles.findIndex(x => x.id === id);
      if (i < 0) return;
      if (patch && typeof patch.code === 'string') {
        patch.code = patch.code.trim();
        patch.city = patch.city || cityFromCode(patch.code);
      }
      this.state.profiles[i] = Object.assign({}, this.state.profiles[i], patch);
      this.save();
    },
    updateProfileOrArchived(id, patch) {
      const liveIndex = (this.state.profiles || []).findIndex(x => x.id === id);
      if (liveIndex >= 0) {
        this.state.profiles[liveIndex] = Object.assign({}, this.state.profiles[liveIndex], patch);
        this.save();
        return this.state.profiles[liveIndex];
      }
      const archivedIndex = (this.state.archivedProfiles || []).findIndex(x => x.id === id);
      if (archivedIndex < 0) return null;
      this.state.archivedProfiles[archivedIndex] = Object.assign(
        {},
        this.state.archivedProfiles[archivedIndex],
        patch
      );
      this.save();
      return this.state.archivedProfiles[archivedIndex];
    },

    /** Платежи за софт, в котором хранятся аккаунты. Один платёж покрывает
     *  период от своей даты до следующего отмеченного платежа, но не дольше
     *  одного календарного месяца. Несколько платежей в один день суммируются. */
    accountSoftwareCycles() {
      const grouped = new Map();
      (this.state.expenses || []).forEach(expense => {
        if (this.inferExpenseCostScope(expense) !== 'account_software') return;
        const start = String(expense.costCoverageStart || expense.date || '').slice(0, 10);
        const explicitEnd = String(expense.costCoverageEnd || '').slice(0, 10);
        const endExclusive = parseISODate(explicitEnd) ? explicitEnd : addMonthsISO(start, 1);
        const amount = Number(expense.amount) || 0;
        if (!parseISODate(start) || !parseISODate(endExclusive) || endExclusive <= start || amount <= 0) return;
        const key = `${start}::${endExclusive}`;
        const current = grouped.get(key) || { start, endExclusive, amount: 0, expenseIds: [] };
        current.amount += amount;
        if (expense.id) current.expenseIds.push(expense.id);
        grouped.set(key, current);
      });

      const rows = [...grouped.values()].sort((a, b) => a.start.localeCompare(b.start));
      return rows.map((row, index) => {
        const nextStart = rows[index + 1] ? rows[index + 1].start : '';
        const endExclusive = nextStart && nextStart < row.endExclusive ? nextStart : row.endExclusive;
        return Object.assign({}, row, {
          endExclusive,
          end: addDaysISO(endExclusive, -1)
        });
      }).filter(row => row.endExclusive && row.endExclusive > row.start);
    },

    _profileSoftwareRange(profile) {
      if (!profile) return null;
      const explicitStart = String(profile.softwareStartedAt || '').slice(0, 10);
      const statusDates = (this.state.profileStatuses || [])
        .filter(status => status && status.profileId === profile.id)
        .flatMap(status => [status.date, ...(status.history || []).map(item => item && item.date)])
        .map(value => String(value || '').slice(0, 10))
        .filter(parseISODate)
        .sort();
      const knownStarts = [String(profile.createdAt || '').slice(0, 10), statusDates[0]]
        .filter(parseISODate)
        .sort();
      const start = parseISODate(explicitStart) ? explicitStart : (knownStarts[0] || '');
      if (!parseISODate(start)) return null;
      const rawEnd = profile.softwareEndedAt || profile.deletedAt || '';
      const end = parseISODate(rawEnd) ? String(rawEnd).slice(0, 10) : '';
      return {
        start,
        end,
        endExclusive: end ? addDaysISO(end, 1) : '9999-12-31'
      };
    },

    /** Распределяет каждый фактический платёж за софт по account-days.
     *  Так новый аккаунт посреди цикла получает только свою долю, а сумма
     *  распределений по всем аккаунтам ровно равна реальному платежу. */
    accountSoftwareCost(profileId) {
      const found = this.getProfileOrArchived(profileId);
      const profile = found ? found.profile : null;
      const range = this._profileSoftwareRange(profile);
      if (!profile || !range) return null;

      const uniqueProfiles = new Map();
      (this.state.archivedProfiles || []).forEach(item => item && item.id && uniqueProfiles.set(item.id, item));
      // При редком конфликте archive-vs-edit один id может временно оказаться
      // в обоих массивах. Активная карточка приоритетнее и считается один раз.
      (this.state.profiles || []).forEach(item => item && item.id && uniqueProfiles.set(item.id, item));
      const pool = [...uniqueProfiles.values()]
        .map(item => ({ profile: item, range: this._profileSoftwareRange(item) }))
        .filter(item => item.range);

      const breakdown = this.accountSoftwareCycles().map(cycle => {
        const totalAccountDays = pool.reduce((sum, item) => sum + overlapDaysISO(
          item.range.start,
          item.range.endExclusive,
          cycle.start,
          cycle.endExclusive
        ), 0);
        const accountDays = overlapDaysISO(
          range.start,
          range.endExclusive,
          cycle.start,
          cycle.endExclusive
        );
        const allocated = totalAccountDays > 0
          ? cycle.amount * accountDays / totalAccountDays
          : 0;
        return Object.assign({}, cycle, { totalAccountDays, accountDays, allocated });
      }).filter(row => row.accountDays > 0);

      const effectiveEnd = range.end || todayISO();
      const startDay = isoDayNumber(range.start);
      const endDay = isoDayNumber(effectiveEnd);
      const daysInSoftware = startDay == null || endDay == null
        ? 0
        : Math.max(0, endDay - startDay + 1);
      const softwareCost = breakdown.reduce((sum, row) => sum + row.allocated, 0);
      const phoneCost = (this.state.expenses || [])
        .filter(item => item && item.source === 'account_phone_auto' && item.profileId === profileId)
        .reduce((sum, item) => sum + (Number(item.amount) || 0), 0);

      return {
        profileId,
        start: range.start,
        end: range.end,
        daysInSoftware,
        paidPeriods: breakdown.length,
        paidThrough: breakdown.length ? breakdown[breakdown.length - 1].end : '',
        softwareCost,
        phoneCost,
        trackedCost: softwareCost + phoneCost,
        breakdown
      };
    },
    /**
     * Удаление аккаунта НЕ безвозвратно: мы архивируем снимок профиля, чтобы
     * сохранить память о:
     *   1. связях клиентов (кто уже был вместе на этом аккаунте) — граф связей
     *      считается из profiles ∪ archivedProfiles, и повторная связка
     *      по-прежнему ловится предупреждением о риске бана.
     *   2. IP-адресах — ipLogs НЕ удаляются, чтобы нельзя было случайно
     *      переиспользовать IP, который уже засвечен на старом аккаунте.
     *   3. номерах — phones с profileId этого аккаунта остаются как были.
     *   4. статусах — profileStatuses тоже сохраняем (был «🎯 Готов» —
     *      пусть и остаётся, иначе у клиента счётчик «Сделано» откатится
     *      назад при архивации, и история «на каком аккаунте мы дошли до
     *      готова» потеряется. См. purgeProfile — там чистим окончательно).
     */
    deleteProfile(id) {
      const profile = this.state.profiles.find(x => x.id === id);
      if (!profile) return;
      const archivedAt = todayISO();
      this.state.archivedProfiles = this.state.archivedProfiles || [];
      // Защита от повторной архивации одного и того же id
      if (!this.state.archivedProfiles.some(a => a.id === id)) {
        this.state.archivedProfiles.push(Object.assign({}, profile, {
          deletedAt: archivedAt,
          softwareEndedAt: archivedAt,
          archived: true
        }));
      }
      this.state.profiles = this.state.profiles.filter(x => x.id !== id);
      // statuses, ipLogs, phones НЕ трогаем — UI резолвит профиль через
      // getProfileOrArchived(), а клиентский счётчик «Сделано» дальше учитывает
      // статус «Готов» на архивном аккаунте.
      this.save();
    },

    /** Вернуть профиль или архивный профиль по id. { profile, archived } */
    getProfileOrArchived(id) {
      if (!id) return null;
      const live = (this.state.profiles || []).find(p => p.id === id);
      if (live) return { profile: live, archived: false };
      const dead = (this.state.archivedProfiles || []).find(p => p.id === id);
      if (dead) return { profile: dead, archived: true };
      return null;
    },

    /** Восстановить аккаунт из архива в активный список.
     *  Снимает флаги archived/deletedAt, возвращает в state.profiles. */
    restoreProfile(id) {
      const arr = this.state.archivedProfiles || [];
      const i = arr.findIndex(p => p.id === id);
      if (i < 0) return null;
      const snap = arr[i];
      arr.splice(i, 1);
      const live = Object.assign({}, snap);
      delete live.archived;
      delete live.deletedAt;
      live.restoredAt = todayISO();
      // Защита от коллизий: если такого id уже нет в profiles — кладём.
      if (!(this.state.profiles || []).some(p => p.id === id)) {
        this.state.profiles.push(live);
      }
      this.save();
      return live;
    },

    /** Удалить аккаунт ОКОНЧАТЕЛЬНО — из архива, без возможности восстановления.
     *  Чистит:
     *    • запись из state.archivedProfiles;
     *    • profileStatuses (на всякий — обычно их уже нет, удалены при архивации);
     *    • accountRegs (регистрационные данные);
     *    • привязку profileId у phones (сами номера не трогаем — это ценные данные,
     *      просто отвязываем от удалённого аккаунта).
     *  ipLogs НЕ трогаем — это история засветки IP, важна даже после удаления. */
    purgeProfile(id) {
      this.state.archivedProfiles = (this.state.archivedProfiles || []).filter(p => p.id !== id);
      this.state.profileStatuses = (this.state.profileStatuses || []).filter(s => s.profileId !== id);
      this.state.accountRegs = (this.state.accountRegs || []).filter(r => r.profileId !== id);
      (this.state.phones || []).forEach(ph => { if (ph.profileId === id) ph.profileId = ''; });
      this.save();
    },

    /* ====================================================================
       ГРАФ СВЯЗЕЙ + DFS — антипересечения клиентов
       --------------------------------------------------------------------
       Граф строится из profiles: если два mentor оказались в одном profile,
       то между ними рёбра в обе стороны. canAddMentorToProfile проверяет:
       не появится ли путь в графе после добавления нового клиента.
       ==================================================================== */

    /** Возвращает Map<mentorId, Set<mentorId>> — рёбра графа.
     *  Учитывает и живые, и архивные (удалённые) аккаунты, чтобы не дать
     *  снова собрать двух клиентов, которые уже были вместе в бане. */
    buildMentorGraph(extraEdges = []) {
      const g = new Map();
      const link = (a, b) => {
        if (!g.has(a)) g.set(a, new Set());
        g.get(a).add(b);
      };
      const sources = [
        ...(this.state.profiles || []),
        ...(this.state.archivedProfiles || [])
      ];
      sources.forEach(p => {
        const ms = (p.mentorIds || []).filter(Boolean);
        for (let i = 0; i < ms.length; i++) {
          for (let j = i + 1; j < ms.length; j++) {
            link(ms[i], ms[j]);
            link(ms[j], ms[i]);
          }
        }
      });
      extraEdges.forEach(([a, b]) => { link(a, b); link(b, a); });
      return g;
    },

    /** Найти аккаунт (живой или архивный), на котором клиенты A и B
     *  уже были вместе. Возвращает { profile, archived } либо null. */
    findSharedProfile(mentorAId, mentorBId) {
      const pool = [
        ...(this.state.profiles || []).map(p => ({ p, archived: false })),
        ...(this.state.archivedProfiles || []).map(p => ({ p, archived: true }))
      ];
      for (const { p, archived } of pool) {
        const ms = p.mentorIds || [];
        if (ms.includes(mentorAId) && ms.includes(mentorBId)) {
          return { profile: p, archived };
        }
      }
      return null;
    },

    /** Проверка: есть ли в графе путь любой длины между двумя клиентами */
    hasPath(graph, start, target) {
      if (start === target) return true;
      const visited = new Set([start]);
      const stack = [start];
      while (stack.length) {
        const node = stack.pop();
        const nbrs = graph.get(node) || new Set();
        for (const n of nbrs) {
          if (n === target) return true;
          if (!visited.has(n)) {
            visited.add(n);
            stack.push(n);
          }
        }
      }
      return false;
    },

    /**
     * Можно ли добавить клиента mentorId в аккаунт profileId.
     * Возвращает { ok: bool, reason?: string, conflictMentorId?: string }
     */
    canAddMentorToProfile(mentorId, profileId) {
      const profile = this.state.profiles.find(p => p.id === profileId);
      if (!profile) return { ok: false, reason: 'Аккаунт не найден' };
      const current = (profile.mentorIds || []).filter(Boolean);
      if (current.includes(mentorId)) return { ok: false, reason: 'Уже привязан к этому аккаунту' };

      // Граф БЕЗ нового ребра — ищем существующие пути между новым и теми, кто уже в аккаунте.
      // Граф строится по profiles ∪ archivedProfiles, значит учитывается память
      // об уже удалённых связках (иначе клиенты, которые сидели на одном забаненном
      // аккаунте, могут незаметно снова оказаться вместе).
      const g = this.buildMentorGraph();
      for (const other of current) {
        if (this.hasPath(g, mentorId, other)) {
          const shared = this.findSharedProfile(mentorId, other);
          let reason = 'Риск пересечения клиентов. Возможен бан аккаунтов.';
          if (shared && shared.archived) {
            reason = `Клиенты уже были вместе на удалённом аккаунте ${shared.profile.code || ''} — риск бана.`;
          } else if (shared) {
            reason = `Клиенты уже связаны через аккаунт ${shared.profile.code || ''} — риск бана.`;
          }
          return {
            ok: false,
            reason,
            conflictMentorId: other,
            conflictProfileId: shared ? shared.profile.id : null,
            conflictArchived: !!(shared && shared.archived)
          };
        }
      }
      return { ok: true };
    },

    /** Связи между конкретной парой клиентов: через какие аккаунты */
    findLinkPath(mentorAId, mentorBId) {
      const g = this.buildMentorGraph();
      // BFS чтобы найти кратчайший путь
      const prev = new Map();
      const visited = new Set([mentorAId]);
      const queue = [mentorAId];
      let found = false;
      while (queue.length) {
        const node = queue.shift();
        if (node === mentorBId) { found = true; break; }
        for (const n of (g.get(node) || [])) {
          if (!visited.has(n)) {
            visited.add(n);
            prev.set(n, node);
            queue.push(n);
          }
        }
      }
      if (!found) return null;
      // восстановить путь
      const path = [mentorBId];
      let cur = mentorBId;
      while (prev.has(cur)) { cur = prev.get(cur); path.unshift(cur); }
      return path;
    },

    /** Все прямые связи (pairs) с указанием через какие profile они.
     *  Включает архивные аккаунты с флагом archived:true. */
    listDirectLinks() {
      const links = []; // { aId, bId, profileId, archived }
      const pool = [
        ...(this.state.profiles || []).map(p => ({ p, archived: false })),
        ...(this.state.archivedProfiles || []).map(p => ({ p, archived: true }))
      ];
      pool.forEach(({ p, archived }) => {
        const ms = (p.mentorIds || []).filter(Boolean);
        for (let i = 0; i < ms.length; i++) {
          for (let j = i + 1; j < ms.length; j++) {
            links.push({ aId: ms[i], bId: ms[j], profileId: p.id, archived });
          }
        }
      });
      return links;
    },

    /* ---------- Profile statuses ---------- */
    /** Получить статус по паре (mentorId, profileId), или null */
    getProfileStatus(mentorId, profileId) {
      return (this.state.profileStatuses || [])
        .find(s => s.mentorId === mentorId && s.profileId === profileId) || null;
    },
    /**
     * Поставить/обновить статус. Если запись уже есть — апдейт + история.
     * Если нет — создаём. date опционально — по умолчанию сегодня.
     */
    setProfileStatus(
      mentorId, profileId, status, comment = '', date = null, performer = undefined,
      nextActionDate = undefined, nextActionMode = undefined
    ) {
      const list = this.state.profileStatuses;
      let rec = list.find(s => s.mentorId === mentorId && s.profileId === profileId);
      const stamp = date || todayISO();
      // Захватываем СТАРЫЙ статус ДО мутации — нужен для уведомления клиенту.
      const oldStatus = rec ? rec.status : null;
      const isNew = !rec;
      if (rec) {
        rec.history = rec.history || [];
        rec.history.push({
          date: rec.date || stamp,
          status: rec.status,
          comment: rec.comment || '',
          nextActionDate: rec.nextActionDate || '',
          nextActionStatus: rec.nextActionStatus || statusActionTarget(rec.status),
          plannedActionDate: rec.plannedActionDate || ''
        });
        rec.status = status;
        rec.comment = comment;
        rec.date = stamp;
        // performer (Данил/Илья для ЗП) задаётся только из модалок «Аккаунты».
        // Прочие вызовы (график в clients.html, массовые операции) его опускают
        // — тогда НЕ затираем уже выбранного исполнителя.
        if (performer !== undefined) rec.performer = performer;
      } else {
        rec = {
          id: uid(),
          mentorId, profileId, status, comment,
          date: stamp,
          performer: performer || '',
          history: []
        };
        list.push(rec);
      }
      this._syncProfileStatusAction(rec, {
        reset: isNew || oldStatus !== status,
        clearTaskPlan: isNew || oldStatus !== status,
        nextActionDate,
        nextActionMode
      });
      this.save();
      // Уведомление в Telegram-очередь — best effort, не блокирует и не валит save.
      try { this._queueStatusNotification(mentorId, profileId, status, oldStatus, comment, isNew); }
      catch (e) { console.warn('[Store] queueStatusNotification failed', e); }
      // Начало нового отклика закрывает один серверный слот графика. Дата
      // публикации отзыва здесь не участвует: это отдельный следующий этап.
      const outreachStarted = OUTREACH_WORK_STATUSES.has(status)
        && !OUTREACH_WORK_STATUSES.has(oldStatus);
      if (outreachStarted && window.CloudSync && window.CloudSync.completeOutreachSlot) {
        window.CloudSync.completeOutreachSlot(mentorId, stamp).catch(error => {
          console.warn('[Store] outreach slot completion failed', error);
        });
      }
      return rec;
    },

    /** Дата следующего действия живёт в самой записи статуса.
     *  При смене статуса создаём новый срок; при обычном сохранении без
     *  явной даты существующий ручной срок не трогаем. */
    _syncProfileStatusAction(rec, options = {}) {
      if (!rec) return;
      const targetStatus = statusActionTarget(rec.status);
      if (options.clearTaskPlan) delete rec.plannedActionDate;
      if (!targetStatus) {
        delete rec.nextActionDate;
        delete rec.nextActionStatus;
        delete rec.nextActionMode;
        delete rec.plannedActionDate;
        return;
      }
      const hasExplicitDate = options.nextActionDate !== undefined;
      const fallbackDate = addDaysISO(
        rec.date || todayISO(),
        statusActionDefaultDays(rec, this.state)
      );
      rec.nextActionStatus = targetStatus;
      if (hasExplicitDate) {
        rec.nextActionDate = options.nextActionDate || fallbackDate;
        rec.nextActionMode = options.nextActionMode || 'manual';
      } else if (options.reset || !rec.nextActionDate) {
        rec.nextActionDate = fallbackDate;
        rec.nextActionMode = 'auto';
      }
    },

    /** Кладёт уведомление о смене статуса в notification_outbox (Supabase).
     *  Бот в /Users/mentori/tg/ опрашивает таблицу и шлёт сообщение клиенту в TG.
     *  Не падает если: нет CloudSync, нет clientPortal-владельца этой анкеты,
     *  у кабинета нет подключённых Telegram-контактов, статус не изменился, или это
     *  создание записи со статусом «Запланировано» (первое назначение).
     */
    _queueStatusNotification(mentorId, profileId, newStatus, oldStatus, comment, isNew) {
      if (!window.CloudSync) return;
      // Не уведомляем если статус по факту не сменился
      if (!isNew && oldStatus === newStatus) return;
      // Не уведомляем при ПЕРВОМ назначении статуса «Запланировано» — это просто
      // заведение в работу, для клиента ничего не произошло
      if (isNew && newStatus === PROFILE_STATUSES[0]) return;

      // Находим клиента-владельца этой анкеты
      const portal = (this.state.clientPortals || [])
        .find(p => Array.isArray(p.mentorIds) && p.mentorIds.includes(mentorId));
      if (!portal) return;                          // нет привязанного клиента — ничего не шлём
      if (!portal.email) return;                    // нет стабильного ключа кабинета

      const mentor  = (this.state.mentors  || []).find(m => m.id === mentorId);
      const profile = (this.state.profiles || []).find(p => p.id === profileId);
      const mentorLabel  = mentor  ? `${mentor.code}${mentor.name ? ' «' + mentor.name + '»' : ''}` : '—';
      // Имя владельца аккаунта берём из accountRegs.ownerName (одна или несколько
      // регистраций на платформах — у каждой свой ownerName). Если имени нет —
      // fallback на profile.code (чтобы клиент хоть как-то понял о чём речь).
      const regs = (this.state.accountRegs || []).filter(r => r.profileId === profileId);
      const ownerNames = Array.from(new Set(regs.map(r => (r.ownerName || '').trim()).filter(Boolean)));
      const accountLabel = ownerNames.length
        ? ownerNames.join(' / ')
        : (profile ? profile.code : '—');

      let message;
      if (oldStatus) {
        message = `📢 Обновление по анкете ${mentorLabel}\n`
                + `Аккаунт ${accountLabel}: ${oldStatus} → ${newStatus}`;
      } else {
        message = `📢 Обновление по анкете ${mentorLabel}\n`
                + `Аккаунт ${accountLabel}: ${newStatus}`;
      }
      if (comment) message += `\n\n💬 ${comment}`;

      const queue = window.CloudSync.queueClientTelegramNotification
        || window.CloudSync.queueTelegramNotification;
      if (!queue) return;
      queue({
        client_email:      portal.email || null,
        // Переходный fallback до применения серверной миграции.
        telegram_chat_id:  portal.telegramChatId,
        telegram_username: portal.telegramUsername || null,
        kind:              'status_change',
        message:           message,
        mentor_id:         mentorId,
        profile_id:        profileId,
        new_status:        newStatus,
        old_status:        oldStatus || null,
        created_by:        (window.AuthGate && window.AuthGate.getUserEmail && window.AuthGate.getUserEmail()) || 'admin'
      }).catch(e => console.warn('[Store] queueTelegramNotification failed', e));
    },
    /** Обновить только дату статуса, не меняя сам статус (inline edit из карточки) */
    setProfileStatusDate(
      mentorId, profileId, date, performer = undefined,
      nextActionDate = undefined, nextActionMode = undefined
    ) {
      const rec = (this.state.profileStatuses || [])
        .find(s => s.mentorId === mentorId && s.profileId === profileId);
      if (!rec) return null;
      const oldDate = rec.date;
      rec.date = date || todayISO();
      if (performer !== undefined) rec.performer = performer;
      const statusDateChanged = oldDate !== rec.date;
      this._syncProfileStatusAction(rec, {
        reset: statusDateChanged && rec.nextActionMode !== 'manual',
        nextActionDate,
        nextActionMode
      });
      this.save();
      return rec;
    },

    getProfileStatusAction(rec, today = todayISO()) {
      return deriveStatusAction(rec, this.state, today);
    },

    /** Запланировать работу над просроченным статусом на выбранный день.
     *  Исходный nextActionDate не меняется: он продолжает показывать реальный
     *  срок и просрочку. plannedActionDate используется только календарём. */
    setProfileStatusTaskDate(statusId, date) {
      const safeDate = String(date || '').slice(0, 10);
      const parsedDate = parseISODate(safeDate);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(safeDate) || !parsedDate || _iso(parsedDate) !== safeDate) return null;
      const rec = (this.state.profileStatuses || []).find(item => item.id === statusId);
      if (!rec) return null;
      const targetStatus = statusActionTarget(rec.status);
      if (!targetStatus) return null;
      rec.plannedActionDate = safeDate;
      rec.taskPlanSchema = 'separate-v1';
      rec.updatedAt = new Date().toISOString();
      this.save();
      return rec;
    },

    // Совместимость с уже опубликованной страницей задач предыдущей версии.
    setProfileStatusActionDate(statusId, date) {
      return this.setProfileStatusTaskDate(statusId, date);
    },

    /** Системные задачи, вычисленные из profileStatuses. Они не копируются
     *  в dailyTasks и закрываются только реальной сменой статуса. */
    listProfileStatusActionTasks(today = todayISO()) {
      return (this.state.profileStatuses || []).map(rec => {
        const action = deriveStatusAction(rec, this.state, today);
        if (!action) return null;
        const mentor = (this.state.mentors || []).find(item => item.id === rec.mentorId);
        const profile = (this.state.profiles || []).find(item => item.id === rec.profileId);
        if (!mentor || !profile) return null;
        const client = clientForStatusMentor(this.state, rec.mentorId);
        const registration = (this.state.accountRegs || []).find(item => item.profileId === rec.profileId);
        return {
          id: `status-action:${rec.id}`,
          source: 'profile_status_action',
          statusId: rec.id,
          date: action.date,
          mentorId: rec.mentorId,
          profileId: rec.profileId,
          note: action.note,
          done: false,
          createdAt: rec.date || '',
          currentStatus: rec.status,
          targetStatus: action.targetStatus,
          daysInStatus: action.daysInStatus,
          daysOverdue: action.daysOverdue,
          dueState: action.dueState,
          actionMode: action.mode,
          plannedDate: String(rec.plannedActionDate || '').slice(0, 10),
          manager: String((client && client.manager) || '').trim(),
          accountCode: profile.code || '',
          accountOwner: (registration && registration.ownerName) || ''
        };
      }).filter(Boolean);
    },
    deleteProfileStatus(id) {
      this.state.profileStatuses = (this.state.profileStatuses || []).filter(s => s.id !== id);
      this.save();
    },

    /* ---------- Reviews (согласование клиента + внутренняя модерация) ----------
       Когда менеджер выставляет статус «🎯 Готов», он вставляет текст.
       Запись сохраняется в CRM, а серверный запрос согласования связан с
       review.id. Внутренняя moderation по-прежнему отдельно отвечает за
       зарплату и счётчик «Сделано». */
    addReview(rec) {
      const item = Object.assign({
        id: uid(),
        profileId: '',
        mentorId: '',
        text: '',
        authorEmail: '',           // кто опубликовал и сдал на модерацию
        submittedAt: new Date().toISOString(),
        moderation: 'pending',     // pending | approved | rejected
        moderatedAt: null,
        moderatedBy: null,
        rate: 300,                 // ставка фиксируется в момент создания
        clientApprovalRequired: false,
        clientApprovalRequestId: null,
        clientApprovalSentAt: null,
        clientApprovalLastError: '',
      }, rec);
      this.state.reviews ??= [];
      this.state.reviews.push(item);
      this.save();
      return item;
    },
    approveReview(id, moderatorEmail) {
      const r = (this.state.reviews || []).find(x => x.id === id);
      if (!r) return null;
      const wasApproved = r.moderation === 'approved';
      r.moderation = 'approved';
      r.moderatedAt = new Date().toISOString();
      r.moderatedBy = moderatorEmail || null;
      this.save();
      if (!wasApproved) {
        try { this._queueClientProgressNotification(r); }
        catch (e) { console.warn('[Store] queueClientProgressNotification failed', e); }
      }
      return r;
    },
    _queueClientProgressNotification(review) {
      if (!review || !window.CloudSync || !window.CloudSync.queueClientProgressNotification) return;
      const client = clientForStatusMentor(this.state, review.mentorId);
      if (!client || Math.max(0, Number(client.ordered) || 0) <= 0) return;
      const remaining = clientRemainingReviews(client, this.state);
      if (remaining !== 1 && remaining !== 0) return;

      const portal = (this.state.clientPortals || [])
        .find(item => Array.isArray(item.mentorIds) && item.mentorIds.includes(review.mentorId));
      if (!portal || !portal.email) return;
      const mentor = (this.state.mentors || []).find(item => item.id === review.mentorId);
      const mentorLabel = mentor
        ? `${mentor.code}${mentor.name ? ` «${mentor.name}»` : ''}`
        : (client.code || 'анкете');
      const completed = remaining === 0;
      const kind = completed ? 'order_completed' : 'low_reviews';
      const message = completed
        ? `✅ По анкете ${mentorLabel} пакет выполнен.`
        : `🔔 По анкете ${mentorLabel} в пакете остался 1 отзыв.`;

      window.CloudSync.queueClientProgressNotification({
        client_email: portal.email,
        kind,
        message,
        mentor_id: review.mentorId,
        profile_id: review.profileId,
        action_ref: `review:${review.id}:remaining:${remaining}`,
        created_by: review.moderatedBy || 'admin'
      }).catch(error => console.warn('[Store] queueClientProgressNotification failed', error));
    },
    rejectReview(id, moderatorEmail, reason = '') {
      const r = (this.state.reviews || []).find(x => x.id === id);
      if (!r) return null;
      r.moderation = 'rejected';
      r.moderatedAt = new Date().toISOString();
      r.moderatedBy = moderatorEmail || null;
      if (reason) r.rejectReason = reason;
      this.save();
      return r;
    },
    deleteReview(id) {
      this.state.reviews = (this.state.reviews || []).filter(x => x.id !== id);
      this.save();
    },
    /* ---------- Proxy links (смена IP — LTE-center и пр.) ----------
       Список ссылок-«пинков», которые при GET-запросе перезагружают модем
       и выдают новый IP. Кнопка «Сменить IP» вызывает все ссылки разом.
       Управляет владелец, используют менеджеры. */
    addProxyLink(rec) {
      const item = Object.assign({
        id: uid(),
        label: '',
        url: '',
        createdAt: todayISO()
      }, rec);
      item.url = String(item.url || '').trim();
      item.label = String(item.label || '').trim();
      if (!item.url) return null;
      this.state.proxyLinks ??= [];
      this.state.proxyLinks.push(item);
      this.save();
      return item;
    },
    updateProxyLink(id, patch) {
      const i = (this.state.proxyLinks || []).findIndex(x => x.id === id);
      if (i < 0) return;
      if (patch && typeof patch.url === 'string') patch.url = patch.url.trim();
      if (patch && typeof patch.label === 'string') patch.label = patch.label.trim();
      this.state.proxyLinks[i] = Object.assign({}, this.state.proxyLinks[i], patch);
      this.save();
    },
    deleteProxyLink(id) {
      this.state.proxyLinks = (this.state.proxyLinks || []).filter(x => x.id !== id);
      this.save();
    },

    /* ---------- Daily tasks ----------
       Задача привязана к клиенту; ответственный определяется из client.manager,
       поэтому при смене менеджера уже созданные задачи автоматически переходят
       в его фильтр. */
    addDailyTask(rec) {
      const item = Object.assign({
        id: uid(),
        date: todayISO(),
        mentorId: '',
        profileId: '',
        note: '',
        done: false,
        createdBy: '',
        createdAt: new Date().toISOString()
      }, rec);
      this.state.dailyTasks ??= [];
      this.state.dailyTasks.push(item);
      this.save();
      return item;
    },
    updateDailyTask(id, patch) {
      const i = (this.state.dailyTasks || []).findIndex(x => x.id === id);
      if (i < 0) return;
      this.state.dailyTasks[i] = Object.assign({}, this.state.dailyTasks[i], patch);
      this.save();
    },
    deleteDailyTask(id) {
      this.state.dailyTasks = (this.state.dailyTasks || []).filter(x => x.id !== id);
      this.save();
    },
    toggleDailyTask(id) {
      const t = (this.state.dailyTasks || []).find(x => x.id === id);
      if (!t) return;
      t.done = !t.done;
      t.doneAt = t.done ? new Date().toISOString() : null;
      this.save();
      return t;
    },

    /** Каскадное удаление отзывов по паре (profileId, mentorId).
     *  Используется при отвязке клиента от аккаунта на странице «Аккаунты»,
     *  чтобы тестовые/ошибочные отзывы не висели в модерации и не считались
     *  у клиента в «Сделано». Возвращает кол-во удалённых отзывов. */
    deleteReviewsForPair(profileId, mentorId) {
      const before = (this.state.reviews || []).length;
      this.state.reviews = (this.state.reviews || []).filter(
        r => !(r.profileId === profileId && r.mentorId === mentorId)
      );
      const removed = before - this.state.reviews.length;
      if (removed > 0) this.save();
      return removed;
    },

    /* ---------- Client portals (личные кабинеты клиентов) ----------
       Один доступ = один клиент-человек (например, «Флагман»), у которого
       может быть НЕСКОЛЬКО анкет (mentorIds: [a21, a22, ...]). По email
       клиент входит в /pages/client/, видит сводку по своим анкетам:
       статусы, оплаты, опубликованные отзывы. ВАЖНО: данные изолируются
       на уровне БД — для клиента генерится отдельный snapshot и кладётся
       в таблицу client_snapshots, защищённую RLS. К сырому crm_state
       клиент доступа не имеет. */
    addClientPortal(rec) {
      const item = Object.assign({
        id: uid(),
        email: '',
        name: '',
        mentorIds: [],
        note: '',
        createdAt: todayISO(),
        updatedAt: todayISO()
      }, rec);
      item.email = String(item.email || '').toLowerCase().trim();
      item.mentorIds = (item.mentorIds || []).filter(Boolean);
      if (!item.email) return null;
      // Защита от дубликатов: один email — один доступ
      const existing = (this.state.clientPortals || []).find(
        p => p.email === item.email
      );
      if (existing) {
        // Сольём mentorIds, обновим поля
        const merged = Array.from(new Set([...(existing.mentorIds || []), ...item.mentorIds]));
        Object.assign(existing, {
          name: item.name || existing.name,
          note: item.note || existing.note,
          mentorIds: merged,
          updatedAt: todayISO()
        });
        this.save();
        return existing;
      }
      this.state.clientPortals.push(item);
      this.save();
      return item;
    },
    updateClientPortal(id, patch) {
      const i = (this.state.clientPortals || []).findIndex(x => x.id === id);
      if (i < 0) return;
      if (patch && typeof patch.email === 'string') {
        patch.email = patch.email.toLowerCase().trim();
      }
      if (patch && Array.isArray(patch.mentorIds)) {
        patch.mentorIds = patch.mentorIds.filter(Boolean);
      }
      this.state.clientPortals[i] = Object.assign(
        {}, this.state.clientPortals[i], patch, { updatedAt: todayISO() }
      );
      this.save();
    },
    deleteClientPortal(id) {
      this.state.clientPortals = (this.state.clientPortals || []).filter(x => x.id !== id);
      this.save();
    },
    getClientPortalByEmail(email) {
      const e = String(email || '').toLowerCase().trim();
      if (!e) return null;
      return (this.state.clientPortals || []).find(p => p.email === e) || null;
    },

    /**
     * Снимок данных одной анкеты (mentorId) — то, что видит клиент в личном
     * кабинете. Безопасно резолвит коды аккаунтов (live + archived).
     */
    _buildAnketaSnapshot(mentorId) {
      const mentor = (this.state.mentors || []).find(m => m.id === mentorId);
      if (!mentor) return null;
      const code = normalizeClientCode(mentor.code);
      // Парный клиент (источник financial-полей: ordered/paid/total/...)
      const client = (this.state.clients || []).find(
        c => normalizeClientCode(c.code) === code
      );
      // Платежи — только items.accountId === client.id
      const payments = client ? this.getPaymentsForClient(client.id) : [];

      // Резолвер «дружелюбного имени» аккаунта для клиентского портала.
      // Внутренний код «5-3» — это служебное (город + номер), клиент
      // его видеть не должен. Берём имя из регистрации (ownerName —
      // персона, на которую заведён профи/авито), а если пусто —
      // показываем нейтральное «Аккаунт #N» (нумерация в пределах
      // одной анкеты).
      const profilesUsedHere = new Set();
      (this.state.profileStatuses || [])
        .filter(s => s.mentorId === mentorId)
        .forEach(s => profilesUsedHere.add(s.profileId));
      (this.state.reviews || [])
        .filter(r => r.mentorId === mentorId)
        .forEach(r => profilesUsedHere.add(r.profileId));
      // нумерация по порядку появления в state.profiles (стабильна между сборками)
      const orderedProfiles = [
        ...(this.state.profiles || []),
        ...(this.state.archivedProfiles || [])
      ].filter(p => profilesUsedHere.has(p.id));
      const profileNumByCode = new Map();
      orderedProfiles.forEach((p, i) => profileNumByCode.set(p.id, i + 1));
      const friendlyName = (profileId) => {
        const reg = this.getAccountReg(profileId);
        if (reg && reg.ownerName) return String(reg.ownerName).trim();
        const num = profileNumByCode.get(profileId) || 0;
        return num > 0 ? `Аккаунт #${num}` : 'Аккаунт';
      };

      // Все статусы по этой анкете (текущие — на каком аккаунте мы сейчас работаем)
      const statuses = (this.state.profileStatuses || [])
        .filter(s => s.mentorId === mentorId)
        .map(s => {
          const pr = this.getProfileOrArchived(s.profileId);
          return {
            id: s.id,
            mentorId: s.mentorId,
            profileId: s.profileId,
            profileName: friendlyName(s.profileId),
            archived: pr ? !!pr.archived : false,
            status: s.status,
            date: s.date,
            comment: s.comment || ''
          };
        });
      // Опубликованные отзывы — только approved (модерированные)
      const reviewsRaw = (this.state.reviews || [])
        .filter(r => r.mentorId === mentorId && r.moderation === 'approved');
      const reviews = reviewsRaw
        .map(r => {
          const pr = this.getProfileOrArchived(r.profileId);
          return {
            id: r.id,
            profileId: r.profileId,
            profileName: friendlyName(r.profileId),
            archived: pr ? !!pr.archived : false,
            text: r.text || '',
            date: (r.moderatedAt || r.submittedAt || '').slice(0, 10)
          };
        })
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      // «Сделано» считаем из ЖИВЫХ данных, а не из устаревшего client.done.
      // Правило: одобренный отзыв + у этой пары (mentor, profile) до сих
      // пор стоит статус «🎯 Готов». Если позже статус сменили на другой
      // или отзыв удалили — счётчик уменьшится (как и в clients.html).
      const doneProfileIds = new Set(
        (this.state.profileStatuses || [])
          .filter(s => s.mentorId === mentorId && s.status === '🎯 Готов')
          .map(s => s.profileId)
      );
      const realDone = reviewsRaw.filter(r => doneProfileIds.has(r.profileId)).length;
      // Для исключительных случаев (например, профиль утрачен после частично
      // выполненного пакета) владелец может зафиксировать неснижаемый минимум.
      const effectiveDone = Math.max(realDone, Number(client && client.manualDone) || 0);
      const publicationWaitDays = clientPublicationMinimumDays(this.state, client);
      const nicheConfig = client && client.niche
        ? (this.state.nicheConfig && this.state.nicheConfig[client.niche])
        : null;
      return {
        mentorId,
        code: mentor.code || '',
        name: client ? (client.name || mentor.name || '') : (mentor.name || ''),
        profileUrl: client ? (client.profileUrl || '') : (mentor.profileUrl || ''),
        avatarUrl: client ? (client.avatarUrl || '') : (mentor.avatarUrl || ''),
        platform: client ? (client.platform || '') : '',
        niche: client ? (client.niche || '') : '',
        nicheLabel: nicheConfig ? (nicheConfig.label || client.niche || '') : '',
        publicationWaitDays,
        tariff: client ? (client.tariff || '') : '',
        ordered: client ? Number(client.ordered) || 0 : 0,
        done: effectiveDone,
        paid: client ? Number(client.paid) || 0 : 0,
        remain: client ? Number(client.remain) || 0 : 0,
        total: client ? Number(client.total) || 0 : 0,
        date: client ? (client.date || '') : '',
        deadline: client ? (client.deadline || '') : '',
        overdueDays: client ? Number(client.overdueDays) || 0 : 0,
        // График работы по дням (Mentor проставляет на странице «Клиенты»
        // → «📅 График»). Клиент в своём кабинете видит запланированные
        // дни на календаре и понимает когда ждать следующих отзывов.
        schedule: client
          ? clientScheduleBreakdown(this.state, client)
              .filter(item => item.remaining > 0 && item.date >= todayISO())
              .map(item => ({ date: item.date, count: item.remaining }))
          : [],
        scheduleLimit: client ? manualScheduleLimit(this.state, client) : 0,
        weeklyPace:  client ? Number(client.weeklyPace) || 0 : 0,
        packageExtras: client && Array.isArray(client.packageExtras) ? client.packageExtras : [],
        payments,
        statuses,
        reviews
      };
    },

    /**
     * Полный снимок для одного клиента-портала. Это ровно то, что уйдёт
     * в client_snapshots.payload и попадёт под RLS. Никаких чужих данных
     * здесь быть НЕ ДОЛЖНО — никаких state.clients, state.expenses и т.д.
     */
    buildClientSnapshot(portal) {
      if (!portal) return null;
      const anketas = (portal.mentorIds || [])
        .map(mid => this._buildAnketaSnapshot(mid))
        .filter(Boolean);
      // Сводный фид: последние действия (отзывы + смены статусов) по всем анкетам
      const feed = [];
      anketas.forEach(a => {
        a.reviews.slice(0, 20).forEach(r => feed.push({
          kind: 'review', date: r.date, anketa: a.code, anketaName: a.name,
          profileName: r.profileName,
          text: `Опубликован отзыв · ${r.profileName || '—'}`
        }));
        a.statuses.forEach(s => feed.push({
          kind: 'status', date: s.date, anketa: a.code, anketaName: a.name,
          profileName: s.profileName, status: s.status,
          text: `${s.status} · ${s.profileName || '—'}`
        }));
      });
      feed.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      // Итоги по всем анкетам
      const totals = anketas.reduce((acc, a) => {
        acc.ordered += a.ordered;
        acc.done    += a.done;
        acc.paid    += a.paid;
        acc.remain  += a.remain;
        acc.total   += a.total;
        return acc;
      }, { ordered: 0, done: 0, paid: 0, remain: 0, total: 0 });
      const regularAllowed = (portal.mentorIds || [])
        .map(mid => (this.state.mentors || []).find(m => m.id === mid))
        .map(m => String((m && m.code) || '').toLowerCase().trim())
        .some(code => (this.state.clients || []).some(c =>
          String(c.code || '').toLowerCase().trim() === code && c.allowRegularTariff === true
        ));
      const paymentTariffs = ((this.state.paymentSettings && this.state.paymentSettings.tariffs) || [])
        .filter(t => t && (t.id !== 'regular' || regularAllowed));
      const privateTariffs = Array.isArray(portal.paymentTariffs)
        ? portal.paymentTariffs.filter(t => t && t.name && Number(t.price) > 0)
        : [];
      const requisites = (this.state.paymentSettings && this.state.paymentSettings.requisites) || {};
      return {
        email: portal.email,
        name: portal.name || '',
        anketas,
        totals,
        feed: feed.slice(0, 50),
        // Тарифы и реквизиты для двух способов оплаты в кабинете.
        // Каноническую оферту кабинет загружает напрямую из /legal/offer.html.
        payment: {
          tariffs: privateTariffs.concat(paymentTariffs),
          requisites: (requisites && typeof requisites === 'object') ? { ...requisites } : {},
          manualTransferDiscount: 300
        },
        generatedAt: new Date().toISOString()
      };
    },

    /** Снимки всех клиентов: вызывается перед push в client_snapshots.
     *  Возвращает массив { email, payload } */
    buildAllClientSnapshots() {
      return (this.state.clientPortals || [])
        .filter(p => p.email)
        .map(p => ({
          email: p.email,
          payload: this.buildClientSnapshot(p)
        }));
    },

    /* ---------- IP logs ---------- */
    addIp(rec) {
      const item = Object.assign({
        id: uid(),
        ip: '',
        profileId: '',
        date: todayISO(),
        note: ''
      }, rec);
      item.ip = String(item.ip || '').trim();
      this.state.ipLogs.push(item);
      this.save();
      return item;
    },
    updateIp(id, patch) {
      const i = this.state.ipLogs.findIndex(x => x.id === id);
      if (i < 0) return;
      if (patch && typeof patch.ip === 'string') patch.ip = patch.ip.trim();
      this.state.ipLogs[i] = Object.assign({}, this.state.ipLogs[i], patch);
      this.save();
    },
    deleteIp(id) {
      this.state.ipLogs = this.state.ipLogs.filter(x => x.id !== id);
      this.save();
    },
    /**
     * Проверка: где ещё используется IP.
     * Возвращает { ok: bool, conflicts: [{profileId, ip, count}] }
     * conflict если IP используется в РАЗНЫХ profiles.
     */
    checkIpConflict(ip, ignoreId = null) {
      const ipNorm = String(ip || '').trim();
      if (!ipNorm) return { ok: true, conflicts: [] };
      const matches = (this.state.ipLogs || [])
        .filter(x => x.ip === ipNorm && x.id !== ignoreId);
      const profileSet = new Set(matches.map(m => m.profileId));
      const conflicts = matches.filter(m => true);
      return {
        ok: profileSet.size <= 1,
        conflicts,
        diffProfiles: profileSet.size > 1
      };
    },

    /* ---------- Phones ----------
       Каждая запись телефона может хранить полные регистрационные данные
       (см. PHONE_META_FIELDS). Эти поля приходят из Excel «Регистрации».
       profileId — ручная привязка телефона к аккаунту (не путать с
       автоматическим определением аккаунта по совпадению с accountRegs.phone). */
    PHONE_META_FIELDS: [
      'ownerName',       // имя владельца номера
      'tgInfo',          // где Telegram ("сам 2 телега" / "есть" / "нет")
      'city',            // город
      'section',         // раздел из xlsx (стационарные / мобильные / 4 группа)
      'yandexLogin',
      'yandexPassword',
      'profiEmail',
      'cloudPassword',
      'recoveryEmail',
      'twoGis',
      'avitoEmail',
      'avitoPassword',
      'lat',
      'lon'
    ],
    _emptyPhoneMeta() {
      const o = {};
      this.PHONE_META_FIELDS.forEach(k => o[k] = '');
      return o;
    },
    addPhone(rec) {
      const item = Object.assign({
        id: uid(),
        number: '',
        note: '',
        profileId: '',
        createdAt: todayISO()
      }, this._emptyPhoneMeta(), rec);
      item.number = this._normalizePhone(item.number);
      this.state.phones.push(item);
      this.save();
      return item;
    },
    updatePhone(id, patch) {
      const i = this.state.phones.findIndex(x => x.id === id);
      if (i < 0) return;
      if (patch && typeof patch.number === 'string') patch.number = this._normalizePhone(patch.number);
      this.state.phones[i] = Object.assign({}, this.state.phones[i], patch, { updatedAt: todayISO() });
      this.save();
    },
    deletePhone(id) {
      this.state.phones = this.state.phones.filter(x => x.id !== id);
      this.save();
    },
    _normalizePhone(raw) {
      // openpyxl/Excel мог сохранить номер как float (89951554507.0),
      // и старый импорт после удаления нецифр оставлял хвостовой 0.
      // Защищаемся: режем хвост в любых случаях > 11 цифр, если первая 7/8/9.
      let s = String(raw || '').replace(/\D+/g, '');
      if (!s) return '';
      if (s.length > 11 && /^[789]/.test(s)) s = s.slice(0, 11);
      if (s.length === 11 && s[0] === '7') return '8' + s.slice(1);
      if (s.length === 10) return '8' + s;
      return s;
    },
    /** Найти дубликаты по номеру — массив phones с тем же number, кроме ignoreId */
    findPhoneDuplicates(number, ignoreId = null) {
      const n = this._normalizePhone(number);
      if (!n) return [];
      return (this.state.phones || []).filter(p => p.number === n && p.id !== ignoreId);
    },

    /* ---------- Account registrations (TG / Яндекс / Авито / 2ГИС / почта Профи) ----------
       Одна запись = регистрационные данные одного аккаунта. Один аккаунт = одна запись.
       Хранится как объект полей; пустые строки допустимы (часть данных может отсутствовать). */
    REG_FIELDS: [
      'ownerName',       // имя владельца (Евгения сидоркина)
      'phone',           // номер телефона аккаунта (нормализуем)
      'tg',              // статус регистрации в Telegram ("сам 2 телега" / "есть" / "нет")
      'city',            // город
      'yandexLogin',
      'yandexPassword',
      'profiEmail',      // почта на Профи.ру (главный логин)
      'cloudPassword',   // пароль iCloud / резервный
      'recoveryEmail',
      'avitoPhone',      // номер на Авито (или 2ГИС в 4-й группе)
      'avitoEmail',
      'avitoPassword',
      'twoGis',          // отметка 2ГИС
      'lat', 'lon',
      'notes'
    ],
    getAccountReg(profileId) {
      return (this.state.accountRegs || []).find(r => r.profileId === profileId) || null;
    },
    /** Общий облачный пароль: сначала аккаунт 17-2, затем самое частое
     *  непустое значение среди регистраций. Сам пароль в коде не хранится. */
    getDefaultCloudPassword() {
      const regs = this.state.accountRegs || [];
      const profiles = (this.state.profiles || []).concat(this.state.archivedProfiles || []);
      const sourceProfile = profiles.find(p => String(p.code || '').trim().toLowerCase() === '17-2');
      if (sourceProfile) {
        const sourceReg = regs.find(r => r.profileId === sourceProfile.id);
        const direct = String((sourceReg && sourceReg.cloudPassword) || '').trim();
        if (direct) return direct;
      }

      const counts = new Map();
      let best = '';
      let bestCount = 0;
      regs.forEach(reg => {
        const password = String((reg && reg.cloudPassword) || '').trim();
        if (!password) return;
        const count = (counts.get(password) || 0) + 1;
        counts.set(password, count);
        if (count > bestCount) {
          best = password;
          bestCount = count;
        }
      });
      return best;
    },
    _buildAccountReg(profileId, patch) {
      const defaultCloudPassword = this.getDefaultCloudPassword();
      const rec = Object.assign({
        id: uid(), profileId,
        ownerName: '', phone: '', tg: '', city: '',
        yandexLogin: '', yandexPassword: '',
        profiEmail: '', cloudPassword: defaultCloudPassword, recoveryEmail: '',
        avitoPhone: '', avitoEmail: '', avitoPassword: '',
        twoGis: '', lat: '', lon: '', notes: '',
        phoneAddedAt: '',
        createdAt: todayISO(), updatedAt: todayISO()
      }, patch);
      if (!String(rec.cloudPassword || '').trim()) rec.cloudPassword = defaultCloudPassword;
      rec.phone = this._normalizePhone(rec.phone);
      rec.avitoPhone = this._normalizePhone(rec.avitoPhone);
      if (/^\d{11}$/.test(rec.phone) && !rec.phoneAddedAt) {
        rec.phoneAddedAt = rec.createdAt || new Date().toISOString();
      }
      return rec;
    },
    /** Создать или обновить регистрацию по profileId.
     *  Побочный эффект: номера телефонов (phone и avitoPhone) автоматически
     *  заводятся в общую базу state.phones и привязываются к этому profileId,
     *  если такой пары (number, profileId) там ещё нет. Так не нужно вручную
     *  дублировать номер в разделе «Номера». */
    upsertAccountReg(profileId, patch) {
      const list = this.state.accountRegs;
      const i = list.findIndex(r => r.profileId === profileId);
      const previousPhone = i >= 0 ? this._normalizePhone(list[i].phone) : '';
      if (i >= 0) {
        if (patch && typeof patch.phone === 'string') patch.phone = this._normalizePhone(patch.phone);
        if (patch && typeof patch.avitoPhone === 'string') patch.avitoPhone = this._normalizePhone(patch.avitoPhone);
        list[i] = Object.assign({}, list[i], patch, { updatedAt: todayISO() });
      } else {
        list.push(this._buildAccountReg(profileId, patch));
      }
      // Авто-привязка номеров к разделу «Номера»
      const finalReg = (this.state.accountRegs || []).find(r => r.profileId === profileId);
      if (finalReg) {
        if (!/^\d{11}$/.test(previousPhone)
            && /^\d{11}$/.test(this._normalizePhone(finalReg.phone))
            && !finalReg.phoneAddedAt) {
          finalReg.phoneAddedAt = new Date().toISOString();
        }
        this._ensurePhoneRecord(finalReg.phone,      profileId, { ownerName: finalReg.ownerName, city: finalReg.city, section: 'phone' });
        this._ensurePhoneRecord(finalReg.avitoPhone, profileId, { ownerName: finalReg.ownerName, city: finalReg.city, section: '🟢 Авито' });
      }
      const phoneExpense = this._addPhoneExpenseForChange(
        profileId,
        previousPhone,
        finalReg ? finalReg.phone : ''
      );
      this.save();
      return { registration: finalReg, phoneExpense };
    },

    /** Дата первой покупки номера: точная дата телефона, иначе дата аккаунта. */
    _accountPhoneExpenseDate(profileId, rawNumber) {
      const number = this._normalizePhone(rawNumber);
      const profile = (this.state.profiles || []).find(p => p.id === profileId)
        || (this.state.archivedProfiles || []).find(p => p.id === profileId);
      const reg = (this.state.accountRegs || []).find(r => r.profileId === profileId);
      const phoneDates = (this.state.phones || [])
        .filter(row => row && row.profileId === profileId
          && (!number || this._normalizePhone(row.number) === number))
        .map(row => String(row.createdAt || row.date || '').slice(0, 10))
        .filter(parseISODate)
        .sort();
      const candidates = [
        String(reg && reg.phoneAddedAt || '').slice(0, 10),
        phoneDates[0] || '',
        String(profile && profile.createdAt || '').slice(0, 10),
        String(reg && reg.createdAt || '').slice(0, 10)
      ];
      return candidates.find(parseISODate) || todayISO();
    },

    /** Одна карточка аккаунта = максимум один бизнес-расход 99 ₽.
     *  При замене телефона обновляем существующую операцию, а не добавляем новую. */
    _addPhoneExpenseForChange(profileId, previousRaw, nextRaw) {
      const previous = this._normalizePhone(previousRaw);
      const number = this._normalizePhone(nextRaw);
      if (!/^\d{11}$/.test(number) || number === previous) return null;

      const expenses = this.state.expenses || (this.state.expenses = []);
      const profile = (this.state.profiles || []).find(p => p.id === profileId)
        || (this.state.archivedProfiles || []).find(p => p.id === profileId);
      const profileCode = profile && profile.code ? String(profile.code).trim() : '';
      const comment = `Номер ${number}${profileCode ? ` · аккаунт ${profileCode}` : ''}`;
      const accountExpenses = expenses.filter(item => item
        && item.source === 'account_phone_auto'
        && item.profileId === profileId);

      if (accountExpenses.length) {
        const existing = accountExpenses[0];
        existing.phoneNumber = number;
        existing.comment = comment;
        existing.updatedAt = new Date().toISOString();
        if (accountExpenses.length > 1) {
          const duplicateItems = new Set(accountExpenses.slice(1));
          this.state.expenses = expenses.filter(item => !duplicateItems.has(item));
        }
        return null;
      }

      const safeProfileId = String(profileId || '').replace(/[^a-zA-Z0-9_-]/g, '');
      const expenseDate = this._accountPhoneExpenseDate(profileId, number);
      const item = {
        id: `phone-cost-account-${safeProfileId || uid()}`,
        date: expenseDate,
        category: 'Реклама - Номера',
        amount: PHONE_EXPENSE_AMOUNT,
        comment,
        personal: false,
        source: 'account_phone_auto',
        phoneNumber: number,
        profileId,
        createdAt: `${expenseDate}T12:00:00.000Z`
      };
      expenses.push(item);
      return item;
    },

    /** Перестраивает исторические расходы: ровно 99 ₽ на каждую карточку.
     *  Непривязанные ручные строки удаляются, активные и архивные аккаунты
     *  учитываются одинаково. Повторный запуск не меняет результат. */
    reconcileAccountPhoneExpenses({ save = true } = {}) {
      const profiles = new Map();
      (this.state.archivedProfiles || []).forEach(profile => {
        if (profile && profile.id) profiles.set(profile.id, profile);
      });
      (this.state.profiles || []).forEach(profile => {
        if (profile && profile.id) profiles.set(profile.id, profile);
      });

      const oldExpenses = this.state.expenses || [];
      const oldNumberExpenses = oldExpenses.filter(item => item
        && !item.personal
        && item.category === 'Реклама - Номера');
      const existingByProfile = new Map();
      oldNumberExpenses.forEach(item => {
        if (!item.profileId) return;
        const current = existingByProfile.get(item.profileId);
        if (!current || (item.source === 'account_phone_auto' && current.source !== 'account_phone_auto')) {
          existingByProfile.set(item.profileId, item);
        }
      });

      const regs = new Map((this.state.accountRegs || [])
        .filter(row => row && row.profileId)
        .map(row => [row.profileId, row]));
      const phonesByProfile = new Map();
      (this.state.phones || []).forEach(row => {
        if (!row || !row.profileId || !/^\d{11}$/.test(this._normalizePhone(row.number))) return;
        const list = phonesByProfile.get(row.profileId) || [];
        list.push(row);
        phonesByProfile.set(row.profileId, list);
      });

      let withoutRecordedPhone = 0;
      let exactPhoneDates = 0;
      let profileFallbackDates = 0;
      const rebuilt = [];
      const byMonth = {};

      profiles.forEach((profile, profileId) => {
        const reg = regs.get(profileId) || null;
        const linkedPhones = phonesByProfile.get(profileId) || [];
        let number = this._normalizePhone(reg && reg.phone);
        if (!/^\d{11}$/.test(number)) {
          const preferred = linkedPhones.find(row => String(row.section || '').toLowerCase() === 'phone')
            || linkedPhones.find(row => !String(row.section || '').toLowerCase().includes('авито'));
          number = preferred ? this._normalizePhone(preferred.number) : '';
        }
        if (!/^\d{11}$/.test(number)) {
          number = '';
          withoutRecordedPhone += 1;
        }

        const exactDates = [
          String(reg && reg.phoneAddedAt || '').slice(0, 10),
          ...linkedPhones
            .filter(row => !number || this._normalizePhone(row.number) === number)
            .map(row => String(row.createdAt || row.date || '').slice(0, 10))
        ].filter(parseISODate).sort();
        const profileDate = String(profile.createdAt || '').slice(0, 10);
        const regDate = String(reg && reg.createdAt || '').slice(0, 10);
        const date = exactDates[0]
          || (parseISODate(profileDate) ? profileDate : '')
          || (parseISODate(regDate) ? regDate : '')
          || todayISO();
        if (exactDates.length) exactPhoneDates += 1;
        else profileFallbackDates += 1;
        if (reg && number && !reg.phoneAddedAt) reg.phoneAddedAt = `${date}T12:00:00.000Z`;

        const existing = existingByProfile.get(profileId) || {};
        const safeProfileId = String(profileId).replace(/[^a-zA-Z0-9_-]/g, '');
        const profileCode = String(profile.code || '').trim();
        const comment = number
          ? `Номер ${number}${profileCode ? ` · аккаунт ${profileCode}` : ''}`
          : `Номер аккаунта${profileCode ? ` ${profileCode}` : ''}`;
        rebuilt.push({
          id: existing.id || `phone-cost-account-${safeProfileId || uid()}`,
          date,
          category: 'Реклама - Номера',
          amount: PHONE_EXPENSE_AMOUNT,
          comment,
          personal: false,
          source: 'account_phone_auto',
          phoneNumber: number,
          profileId,
          createdAt: `${date}T12:00:00.000Z`
        });
        const month = date.slice(0, 7);
        byMonth[month] = (byMonth[month] || 0) + PHONE_EXPENSE_AMOUNT;
      });

      const unlinked = oldNumberExpenses.filter(item => !item.profileId);
      const untouched = oldExpenses.filter(item => item
        && (item.personal || item.category !== 'Реклама - Номера'));
      this.state.expenses = untouched.concat(rebuilt);
      if (save) this.save();
      return {
        profiles: profiles.size,
        expenses: rebuilt.length,
        total: rebuilt.length * PHONE_EXPENSE_AMOUNT,
        removedUnlinked: unlinked.length,
        removedUnlinkedTotal: unlinked.reduce((sum, item) => sum + (Number(item.amount) || 0), 0),
        exactPhoneDates,
        profileFallbackDates,
        withoutRecordedPhone,
        byMonth
      };
    },

    /** Создать запись в state.phones, если для пары (number, profileId) её ещё нет.
     *  Если такой номер уже привязан к этому аккаунту — просто подтянем мета (имя/город),
     *  оставив существующий id. Если номер записан под другим аккаунтом — НЕ трогаем
     *  его (это ценная история «этот номер был на стольких-то аккаунтах»),
     *  заводим отдельную запись для нового аккаунта. */
    _ensurePhoneRecord(rawNumber, profileId, meta) {
      const number = this._normalizePhone(rawNumber);
      if (!number || !profileId) return null;
      const phones = this.state.phones || (this.state.phones = []);
      const existing = phones.find(p => p.number === number && p.profileId === profileId);
      if (existing) {
        // не перетираем уже введённые поля, только дозаполняем пустые
        ['ownerName','city','section'].forEach(k => {
          if (!existing[k] && meta && meta[k]) existing[k] = meta[k];
        });
        return existing;
      }
      const rec = Object.assign({
        id: uid(),
        number,
        profileId,
        note: '',
        createdAt: todayISO(),
        autoCreated: true,            // помечаем — пришёл из регистрации, а не из ручного ввода
      }, this._emptyPhoneMeta(), meta || {});
      phones.push(rec);
      return rec;
    },
    deleteAccountReg(profileId) {
      this.state.accountRegs = (this.state.accountRegs || []).filter(r => r.profileId !== profileId);
      this.save();
    },
    /** На каком(их) аккаунте(ах) уже используется этот номер (по основному phone + avitoPhone) */
    profilesUsingPhone(number, ignoreProfileId = null) {
      const n = this._normalizePhone(number);
      if (!n) return [];
      return (this.state.accountRegs || [])
        .filter(r => r.profileId !== ignoreProfileId && (r.phone === n || r.avitoPhone === n))
        .map(r => r.profileId);
    },

    /* ---------- Сводки ----------
       expense / profit считаются БЕЗ личных трат (бизнес-показатели).
       expensePersonal — отдельно, для «Пульса кэша» (там личные тоже
       уменьшают баланс, но не считаются убытком бизнеса). */
    totals() {
      const income = this.state.income.reduce((s, r) => s + (Number(r.amount) || 0), 0);
      const expenseAll = this.state.expenses.reduce((s, r) => s + (Number(r.amount) || 0), 0);
      const expensePersonal = this.state.expenses
        .filter(r => r.personal)
        .reduce((s, r) => s + (Number(r.amount) || 0), 0);
      const expense = expenseAll - expensePersonal;
      const employeesActive = this.state.employees.filter(e => e.status === 'active').length;
      const clients = this.state.clients.length;
      const clientsActive = this.state.clients.filter(c => (c.ordered || 0) > (c.done || 0)).length;
      const clientsOverdue = this.state.clients.filter(c => (c.overdueDays || 0) > 0).length;
      const subsCount = this.state.subscriptions.length;
      const subsMonthly = this.state.subscriptions.reduce((s, r) => s + (Number(r.amount) || 0), 0);
      return {
        income,
        expense,            // только бизнес-расходы (для P&L)
        expensePersonal,    // личные траты отдельно
        expenseAll,         // всё вместе (для Пульса кэша)
        profit: income - expense,
        employees: employeesActive,
        clients, clientsActive, clientsOverdue,
        subsCount, subsMonthly
      };
    },

    /** Агрегация доходов/расходов по месяцам для графика */
    monthlyStats() {
      const map = {};
      const push = (key, field, val) => {
        if (!key) return;
        map[key] ??= { income: 0, expense: 0 };
        map[key][field] += Number(val) || 0;
      };
      this.state.income.forEach(r => push(monthKey(r.date), 'income', r.amount));
      this.state.expenses.forEach(r => push(monthKey(r.date), 'expense', r.amount));
      const keys = Object.keys(map).sort();
      return keys.map(k => ({ month: k, label: monthLabel(k), ...map[k], profit: map[k].income - map[k].expense }));
    }
  };

  /** Маппинг тарифов из xlsx/старых карточек → текущий прайс */
  function mapTariff(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return '';
    if (s.includes('опт') || s.includes('900') || s.includes('1000') || s.includes('№2')) return 'Опт';
    if (s.includes('постоян') || s.includes('кастом') || s.includes('800') || s.includes('баз')) return 'Постоянник';
    if (s.includes('развит') || s.includes('рост') || s.includes('15490') || s.includes('15 490') || s.includes('прем') || s.includes('№4')) return 'Развитие';
    if (s.includes('поддерж') || s.includes('8490') || s.includes('8 490') || s.includes('8290') || s.includes('8 290') || s.includes('№3')) return 'Поддержка';
    return TARIFF_NAMES.includes(raw) ? raw : TARIFF_NAMES[0];
  }

  /* ------------------------------------------------------------------ */
  /* Toast                                                              */
  /* ------------------------------------------------------------------ */
  function ensureToastWrap() {
    let wrap = document.querySelector('.toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'toast-wrap';
      document.body.appendChild(wrap);
    }
    return wrap;
  }
  function toast(message, type = 'success') {
    const wrap = ensureToastWrap();
    const t = document.createElement('div');
    t.className = `toast toast--${type}`;
    t.textContent = message;
    wrap.appendChild(t);
    setTimeout(() => {
      t.style.transition = 'opacity .25s ease, transform .25s ease';
      t.style.opacity = '0';
      t.style.transform = 'translateX(10px)';
      setTimeout(() => t.remove(), 260);
    }, 2600);
  }

  /* ------------------------------------------------------------------ */
  /* Модальные окна                                                     */
  /* ------------------------------------------------------------------ */
  const Modal = {
    open(id) { const el = document.getElementById(id); if (el) el.classList.add('open'); },
    close(id) { const el = document.getElementById(id); if (el) el.classList.remove('open'); },
    bind() {
      document.querySelectorAll('.modal-backdrop').forEach(bd => {
        bd.addEventListener('click', e => { if (e.target === bd) bd.classList.remove('open'); });
        bd.querySelectorAll('[data-close]').forEach(btn =>
          btn.addEventListener('click', () => bd.classList.remove('open'))
        );
      });
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
          document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'));
        }
      });
    }
  };

  /* ------------------------------------------------------------------ */
  /* Counter (+/−) — универсальный компонент                            */
  /* ------------------------------------------------------------------ */
  const Counter = {
    /**
     * Возвращает HTML-строку счётчика. Не забудь потом вызвать Counter.bind.
     * @param {number} value
     * @param {Object} opts { id?: string, min?: number, max?: number }
     */
    html(value, opts = {}) {
      const v = Number(value) || 0;
      const id = opts.id ? ` data-counter-id="${opts.id}"` : '';
      const min = opts.min ?? 0;
      const max = opts.max != null ? ` data-max="${opts.max}"` : '';
      return `
        <div class="counter" data-counter data-min="${min}"${max}${id}>
          <button type="button" class="counter-btn" data-counter-dec aria-label="−">−</button>
          <span class="counter__val">${v}</span>
          <button type="button" class="counter-btn" data-counter-inc aria-label="+">+</button>
        </div>`;
    },

    /**
     * Привязывает обработчики к одному счётчику.
     * @param {HTMLElement} root — элемент с классом .counter
     * @param {Function} onChange — (newValue) => void
     */
    bind(root, onChange) {
      if (!root || root._bound) return;
      root._bound = true;
      const val = root.querySelector('.counter__val');
      const min = Number(root.dataset.min ?? 0);
      const max = root.dataset.max != null ? Number(root.dataset.max) : null;
      root.querySelector('[data-counter-dec]').addEventListener('click', (e) => {
        e.stopPropagation();
        let v = (Number(val.textContent) || 0) - 1;
        if (v < min) v = min;
        val.textContent = v;
        onChange(v);
      });
      root.querySelector('[data-counter-inc]').addEventListener('click', (e) => {
        e.stopPropagation();
        let v = (Number(val.textContent) || 0) + 1;
        if (max != null && v > max) v = max;
        val.textContent = v;
        onChange(v);
      });
    },

    /** Привязывает все неинициализированные счётчики внутри root */
    bindAll(root, resolver) {
      root.querySelectorAll('.counter[data-counter]').forEach(el => {
        const id = el.dataset.counterId;
        const onChange = resolver(id, el);
        if (onChange) this.bind(el, onChange);
      });
    }
  };

  /* ------------------------------------------------------------------ */
  /* Экспорт                                                            */
  /* ------------------------------------------------------------------ */
  window.App = {
    Store, Modal, Counter, toast,
    fmtMoney, fmtDate, monthKey, monthLabel,
    uid, todayISO, tomorrowISO, addDaysISO, addMonthsISO, daysBetweenISO, deriveStatusAction,
    normalizeClientCode, normalizeSearchText, compareClientCodes, clientReviewsRemaining,
    statusOutreachStartDate, statusOutreachStartDates,
    clientOutreachStartsByDate, clientScheduleBreakdown,
    scheduledReviewCount, manualScheduleLimit,
    SERVICES, EXPENSE_CATEGORIES, PERSONAL_CATEGORIES, PHONE_EXPENSE_AMOUNT, TARIFFS, TARIFF_NAMES,
    PROFILE_STATUSES, PERFORMERS, CITIES, cityFromCode,
    STATUS_SELECT, STATUS_CHOSEN, STATUS_READY
  };

  /* ------------------------------------------------------------------ */
  /* Автоинициализация                                                  */
  /* ------------------------------------------------------------------ */
  document.addEventListener('DOMContentLoaded', () => {
    Store.load();
    Modal.bind();
  });

  /* При обновлении состояния из облака — перечитываем localStorage и шлём
     событие 'store:reloaded', чтобы каждая страница перерендерилась.
     Если при загрузке были подчищены осиротевшие менторы — пушим обратно,
     иначе очистка останется только локальной и на других устройствах a21
     продолжит висеть. */
  window.addEventListener('cloudstate:updated', () => {
    Store.load();
    if (Store._lastOrphansRemoved > 0) {
      // Cleanup что-то выпилил из облачной копии — синхронизируем обратно,
      // иначе на других устройствах a21 (или подобный сирота) продолжит висеть.
      try { Store.save(); } catch (_) {}
    }
    window.dispatchEvent(new CustomEvent('store:reloaded'));
  });
})();
