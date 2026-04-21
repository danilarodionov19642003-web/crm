/* ==========================================================================
   Reviews Sync — авто-подсчёт одобренных отзывов для зарплаты сотрудников.
   --------------------------------------------------------------------------
   Считает Store.state.reviews, где moderation==='approved' и authorEmail
   совпадает с emp.email. Обновляет emp.reviewsDone и шлёт событие
   'reviews:updated' — страницы employees.html / dashboard.html слушают и
   перерисовывают KPI.

   Подключается ПОСЛЕ supabase-client.js и app.js.
   ========================================================================== */
(function () {
  'use strict';

  if (!window.App) {
    console.warn('[reviews-sync] App not loaded');
    return;
  }
  const { Store } = window.App;

  const STORAGE_KEY = 'mentori-crm-v2';

  const DONE_STATUS = '🎯 Готов';

  /** Пересчитать reviewsDone у каждого сотрудника.
   *  Правило начисления:
   *    1. Отзыв одобрен (moderation='approved').
   *    2. У пары (mentorId, profileId) сейчас стоит статус «🎯 Готов».
   *    3. Зарплата идёт МЕНЕДЖЕРУ КЛИЕНТА — client.assignedEmail (ищем
   *       клиента по mentor.code). Если клиент ведёт владелец сам
   *       (assignedEmail пустой или не совпадает ни с одним сотрудником) —
   *       зарплата никому не начисляется. Так владелец может вести часть
   *       клиентов лично, а статус «Готов» по ним не будет капать в зп. */
  function recompute() {
    if (!Store || !Store.state) return;
    const reviews = Store.state.reviews || [];
    const statuses = Store.state.profileStatuses || [];
    const mentors = Store.state.mentors || [];
    const clients = Store.state.clients || [];

    // mentorId → assignedEmail (через mentor.code → client.assignedEmail)
    const clientByCode = new Map();
    clients.forEach(c => {
      const code = String(c.code || '').toLowerCase().trim();
      if (code) clientByCode.set(code, c);
    });
    const mentorToCreditEmail = new Map();
    mentors.forEach(m => {
      const code = String(m.code || '').toLowerCase().trim();
      const c = clientByCode.get(code);
      const e = c ? String(c.assignedEmail || '').toLowerCase().trim() : '';
      mentorToCreditEmail.set(m.id, e);
    });

    // быстрый поиск: есть ли «Готов» для пары
    const doneSet = new Set();
    statuses.forEach(s => {
      if (s.status === DONE_STATUS) doneSet.add(s.mentorId + '::' + s.profileId);
    });
    // counts по менеджеру клиента
    const counts = new Map();
    reviews.forEach(r => {
      if (r.moderation !== 'approved') return;
      if (!doneSet.has(r.mentorId + '::' + r.profileId)) return;
      const e = mentorToCreditEmail.get(r.mentorId) || '';
      if (!e) return; // клиент без менеджера = ведёт владелец = никому
      counts.set(e, (counts.get(e) || 0) + 1);
    });

    let changed = false;
    (Store.state.employees || []).forEach(emp => {
      const email = String(emp.email || '').toLowerCase().trim();
      if (!email) return;
      const cnt = counts.get(email) || 0;
      if (Number(emp.reviewsDone || 0) !== cnt) {
        emp.reviewsDone = cnt;
        changed = true;
      }
    });

    if (changed) {
      // тихо пишем в localStorage без push в облако (Store.save() уже отрабатывал
      // при approve/reject — нам остаётся только синхронизировать кэш сотрудников).
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(Store.state)); } catch (_) {}
      window.dispatchEvent(new CustomEvent('reviews:updated'));
    }
  }

  // Первый прогон — после загрузки Store
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(recompute, 200);
  });

  // Перерасчёт после прихода свежего state из облака
  window.addEventListener('cloudstate:updated', () => {
    setTimeout(recompute, 50);
  });
  window.addEventListener('store:reloaded', () => {
    setTimeout(recompute, 50);
  });

  // Подстраховка — раз в 30 секунд (на случай если кто-то поправил state.reviews
  // напрямую без события).
  setInterval(recompute, 30_000);

  window.ReviewsSync = { pull: recompute, recompute };
})();
