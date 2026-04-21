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

  const TARIFFS = [
    { id: 'basic',    name: 'Базовый',  price: 800,   desc: 'Любое кол-во отзывов · 800 ₽/шт' },
    { id: 'standard', name: 'Стандарт', price: 1000,  desc: 'Любое кол-во отзывов · 1000 ₽/шт' },
    { id: 'premium',  name: 'Премиум',  price: 15490, desc: '12 отзывов / мес — фиксированная подписка' }
  ];
  const TARIFF_NAMES = TARIFFS.map(t => t.name);

  /* ------------------------------------------------------------------ */
  /* Справочники для новых модулей (статусы, города)                    */
  /* ------------------------------------------------------------------ */
  const PROFILE_STATUSES = [
    '📋 Запланировано',
    '💬 Диалог Начат',
    '✅ Диалог Закончен',
    '⭐ Выбрать',
    '🏆 Выбран',
    '🎯 Готов'
  ];
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

  function fmtMoney(v) {
    if (v == null || isNaN(v)) return '0 ₽';
    const n = Number(v);
    return n.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ₽';
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
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
      this._migrateNormalizePhones();
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

    save() {
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

      // Сотрудник — только Настя, начало работы = завтра
      const employees = [
        {
          id: uid(),
          name: 'Настя',
          role: 'Ревьюер',
          ratePerReview: 300,
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
        items: null   // null = старый формат (по тексту); [] = распределённый
      }, rec);

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
        c.paid = Math.max(0, (Number(c.paid) || 0) + sign * Number(amount));
        const total = Number(c.total) || 0;
        if (total > 0) c.remain = Math.max(0, total - c.paid);
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
        amount: 0, comment: ''
      }, rec);
      this.state.expenses.push(item);
      this.save();
      return item;
    },
    updateExpense(id, patch) {
      const i = this.state.expenses.findIndex(x => x.id === id);
      if (i < 0) return;
      this.state.expenses[i] = Object.assign({}, this.state.expenses[i], patch);
      this.save();
    },
    deleteExpense(id) {
      this.state.expenses = this.state.expenses.filter(x => x.id !== id);
      this.save();
    },

    /* ---------- Clients ---------- */
    addClient(rec) {
      const item = Object.assign({
        id: uid(),
        platform: '', name: '', code: '', tariff: TARIFF_NAMES[0],
        ordered: 0, done: 0,
        paid: 0, remain: 0, total: 0,
        date: todayISO(), deadline: '', overdueDays: 0,
        assignedEmail: '', avatarUrl: ''
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
      const code = String(client.code || '').toLowerCase().trim();
      if (!code) return;
      this.state.mentors = this.state.mentors || [];
      const existing = this.state.mentors.find(
        m => String(m.code || '').toLowerCase().trim() === code
      );
      if (existing) {
        if (!existing.name && client.name) existing.name = client.name;
        return existing;
      }
      const mentor = {
        id: uid(),
        code,
        name: client.name || '',
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
    addEmployee(rec) {
      const item = Object.assign({
        id: uid(),
        name: '', role: 'Ревьюер',
        email: '',                  // привязка к Supabase Auth (lowercase)
        ratePerReview: 300,
        reviewsDone: 0,             // авто-считается reviews-sync.js
        paid: 0,
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
      e.payments.push(p);
      e.paid = (e.paid || 0) + Number(p.amount || 0);
      this.save();
      return p;
    },

    /* ---------- Subscriptions ---------- */
    addSubscription(rec) {
      const item = Object.assign({
        id: uid(),
        name: '', clientId: null, tariff: '',
        frequency: 'Каждые 30 дней',
        amount: 0, status: 'оплачен',
        nextDate: todayISO()
      }, rec);
      this.state.subscriptions.push(item);
      this.save();
      return item;
    },
    updateSubscription(id, patch) {
      const i = this.state.subscriptions.findIndex(x => x.id === id);
      if (i < 0) return;
      this.state.subscriptions[i] = Object.assign({}, this.state.subscriptions[i], patch);
      this.save();
    },
    deleteSubscription(id) {
      this.state.subscriptions = this.state.subscriptions.filter(x => x.id !== id);
      this.save();
    },

    /* ====================================================================
       НОВЫЕ МОДУЛИ: mentors / profiles / statuses / ipLogs / phones
       ==================================================================== */

    /* ---------- Mentors (a1..aN — клиенты в новой модели) ---------- */
    addMentor(rec) {
      const item = Object.assign({
        id: uid(),
        code: this._nextMentorCode(),
        name: '',
        notes: '',
        createdAt: todayISO()
      }, rec);
      item.code = String(item.code || '').toLowerCase().trim();
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
      const nums = (this.state.mentors || [])
        .map(m => /^a(\d+)$/.exec(m.code || ''))
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
        createdAt: todayISO()
      }, rec);
      item.code = String(item.code || '').trim();
      if (!item.city) item.city = cityFromCode(item.code);
      this.state.profiles.push(item);
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
    /**
     * Удаление аккаунта НЕ безвозвратно: мы архивируем снимок профиля, чтобы
     * сохранить память о:
     *   1. связях клиентов (кто уже был вместе на этом аккаунте) — граф связей
     *      считается из profiles ∪ archivedProfiles, и повторная связка
     *      по-прежнему ловится предупреждением о риске бана.
     *   2. IP-адресах — ipLogs НЕ удаляются, чтобы нельзя было случайно
     *      переиспользовать IP, который уже засвечен на старом аккаунте.
     *   3. номерах — phones с profileId этого аккаунта остаются как были.
     * Чистим только profileStatuses (они уже неактуальны).
     */
    deleteProfile(id) {
      const profile = this.state.profiles.find(x => x.id === id);
      if (!profile) return;
      this.state.archivedProfiles = this.state.archivedProfiles || [];
      // Защита от повторной архивации одного и того же id
      if (!this.state.archivedProfiles.some(a => a.id === id)) {
        this.state.archivedProfiles.push(Object.assign({}, profile, {
          deletedAt: todayISO(),
          archived: true
        }));
      }
      this.state.profiles = this.state.profiles.filter(x => x.id !== id);
      this.state.profileStatuses = (this.state.profileStatuses || []).filter(s => s.profileId !== id);
      // ipLogs и phones НЕ трогаем — ссылка profileId продолжает указывать
      // на архивный профиль, UI резолвит через getProfileOrArchived()
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
    setProfileStatus(mentorId, profileId, status, comment = '', date = null) {
      const list = this.state.profileStatuses;
      let rec = list.find(s => s.mentorId === mentorId && s.profileId === profileId);
      const stamp = date || todayISO();
      if (rec) {
        rec.history = rec.history || [];
        rec.history.push({ date: rec.date || stamp, status: rec.status, comment: rec.comment || '' });
        rec.status = status;
        rec.comment = comment;
        rec.date = stamp;
      } else {
        rec = {
          id: uid(),
          mentorId, profileId, status, comment,
          date: stamp,
          history: []
        };
        list.push(rec);
      }
      this.save();
      return rec;
    },
    /** Обновить только дату статуса, не меняя сам статус (inline edit из карточки) */
    setProfileStatusDate(mentorId, profileId, date) {
      const rec = (this.state.profileStatuses || [])
        .find(s => s.mentorId === mentorId && s.profileId === profileId);
      if (!rec) return null;
      rec.date = date || todayISO();
      this.save();
      return rec;
    },
    deleteProfileStatus(id) {
      this.state.profileStatuses = (this.state.profileStatuses || []).filter(s => s.id !== id);
      this.save();
    },

    /* ---------- Reviews (модерация опубликованных отзывов) ----------
       Когда сотрудник (Настя) выставляет статус «🎯 Готов», он обязан
       вставить текст опубликованного отзыва. Отзыв попадает сюда со
       статусом 'pending', владелец на странице reviews.html нажимает
       «Проверен» → moderation='approved' → засчитывается зарплата
       (rate ₽) и отзыв учитывается в счётчике «Сделано» у клиента. */
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
      }, rec);
      this.state.reviews ??= [];
      this.state.reviews.push(item);
      this.save();
      return item;
    },
    approveReview(id, moderatorEmail) {
      const r = (this.state.reviews || []).find(x => x.id === id);
      if (!r) return null;
      r.moderation = 'approved';
      r.moderatedAt = new Date().toISOString();
      r.moderatedBy = moderatorEmail || null;
      this.save();
      return r;
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
    /** Создать или обновить регистрацию по profileId */
    upsertAccountReg(profileId, patch) {
      const list = this.state.accountRegs;
      const i = list.findIndex(r => r.profileId === profileId);
      if (i >= 0) {
        if (patch && typeof patch.phone === 'string') patch.phone = this._normalizePhone(patch.phone);
        if (patch && typeof patch.avitoPhone === 'string') patch.avitoPhone = this._normalizePhone(patch.avitoPhone);
        list[i] = Object.assign({}, list[i], patch, { updatedAt: todayISO() });
      } else {
        const rec = Object.assign({
          id: uid(), profileId,
          ownerName: '', phone: '', tg: '', city: '',
          yandexLogin: '', yandexPassword: '',
          profiEmail: '', cloudPassword: '', recoveryEmail: '',
          avitoPhone: '', avitoEmail: '', avitoPassword: '',
          twoGis: '', lat: '', lon: '', notes: '',
          createdAt: todayISO(), updatedAt: todayISO()
        }, patch);
        rec.phone = this._normalizePhone(rec.phone);
        rec.avitoPhone = this._normalizePhone(rec.avitoPhone);
        list.push(rec);
      }
      this.save();
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

    /* ---------- Сводки ---------- */
    totals() {
      const income = this.state.income.reduce((s, r) => s + (Number(r.amount) || 0), 0);
      const expense = this.state.expenses.reduce((s, r) => s + (Number(r.amount) || 0), 0);
      const employeesActive = this.state.employees.filter(e => e.status === 'active').length;
      const clients = this.state.clients.length;
      const clientsActive = this.state.clients.filter(c => (c.ordered || 0) > (c.done || 0)).length;
      const clientsOverdue = this.state.clients.filter(c => (c.overdueDays || 0) > 0).length;
      const subsCount = this.state.subscriptions.length;
      const subsMonthly = this.state.subscriptions.reduce((s, r) => s + (Number(r.amount) || 0), 0);
      return {
        income, expense,
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

  /** Маппинг тарифов из xlsx → наши три */
  function mapTariff(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return TARIFF_NAMES[0];
    if (s.includes('1000') || s.includes('№2')) return 'Стандарт';
    if (s.includes('поддерж') || s.includes('развит') || s.includes('рост') || s.includes('№3') || s.includes('№4')) return 'Премиум';
    return 'Базовый';
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
    uid, todayISO, tomorrowISO,
    SERVICES, EXPENSE_CATEGORIES, TARIFFS, TARIFF_NAMES,
    PROFILE_STATUSES, CITIES, cityFromCode
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
