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
   *  Правило начисления (с 27.04.2026):
   *    1. Отзыв одобрен (moderation='approved').
   *    2. У пары (mentorId, profileId) сейчас стоит статус «🎯 Готов».
   *    3. Зарплата идёт АВТОРУ ОТЗЫВА — review.authorEmail. Это тот, кто
   *       нажал «Готов» и вставил текст отзыва на модерацию.
   *       Раньше зарплата шла «менеджеру клиента» (client.assignedEmail),
   *       но это было плохо: одного клиента могут вести двое (Настя +
   *       владелец), а смена менеджера задним числом перебрасывала ВСЕ
   *       отзывы новому менеджеру. Теперь — атрибуция по факту: кто
   *       опубликовал, тому и оплачивается. */
  function recompute() {
    if (!Store || !Store.state) return;
    const reviews = Store.state.reviews || [];
    const statuses = Store.state.profileStatuses || [];

    // быстрый поиск: есть ли «Готов» для пары
    const doneSet = new Set();
    statuses.forEach(s => {
      if (s.status === DONE_STATUS) doneSet.add(s.mentorId + '::' + s.profileId);
    });
    // counts по автору отзыва
    const counts = new Map();
    reviews.forEach(r => {
      if (r.moderation !== 'approved') return;
      if (!doneSet.has(r.mentorId + '::' + r.profileId)) return;
      const e = String(r.authorEmail || '').toLowerCase().trim();
      if (!e) return;
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
