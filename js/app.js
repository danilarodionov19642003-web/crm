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
      return this.state;
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
      this.save();
    },

    /* ---------- Income ---------- */
    addIncome(rec) {
      const item = Object.assign({
        id: uid(), date: todayISO(),
        client: '', service: SERVICES[0],
        amount: 0, comment: ''
      }, rec);
      this.state.income.push(item);
      this.save();
      return item;
    },
    updateIncome(id, patch) {
      const i = this.state.income.findIndex(x => x.id === id);
      if (i < 0) return;
      this.state.income[i] = Object.assign({}, this.state.income[i], patch);
      this.save();
    },
    deleteIncome(id) {
      this.state.income = this.state.income.filter(x => x.id !== id);
      this.save();
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
        date: todayISO(), deadline: '', overdueDays: 0
      }, rec);
      this.state.clients.push(item);
      this.save();
      return item;
    },
    updateClient(id, patch) {
      const i = this.state.clients.findIndex(x => x.id === id);
      if (i < 0) return;
      this.state.clients[i] = Object.assign({}, this.state.clients[i], patch);
      this.save();
    },
    deleteClient(id) {
      this.state.clients = this.state.clients.filter(x => x.id !== id);
      this.save();
    },

    /* ---------- Employees ---------- */
    addEmployee(rec) {
      const item = Object.assign({
        id: uid(),
        name: '', role: 'Ревьюер',
        ratePerReview: 300,
        reviewsDone: 0,
        paid: 0,
        status: 'active',
        hired: tomorrowISO(),
        payments: []
      }, rec);
      this.state.employees.push(item);
      this.save();
      return item;
    },
    updateEmployee(id, patch) {
      const i = this.state.employees.findIndex(x => x.id === id);
      if (i < 0) return;
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
    SERVICES, EXPENSE_CATEGORIES, TARIFFS, TARIFF_NAMES
  };

  /* ------------------------------------------------------------------ */
  /* Автоинициализация                                                  */
  /* ------------------------------------------------------------------ */
  document.addEventListener('DOMContentLoaded', () => {
    Store.load();
    Modal.bind();
  });

  /* При обновлении состояния из облака — перечитываем localStorage и шлём
     событие 'store:reloaded', чтобы каждая страница перерендерилась. */
  window.addEventListener('cloudstate:updated', () => {
    Store.load();
    window.dispatchEvent(new CustomEvent('store:reloaded'));
  });
})();
