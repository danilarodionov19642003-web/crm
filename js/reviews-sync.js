/* ==========================================================================
   Reviews Sync — авто-подсчёт откликов для зарплаты менеджеров.
   --------------------------------------------------------------------------
   Считает Store.state.profileStatuses по полю performer (Данил / Илья).
   Обновляет emp.reviewsDone и шлёт событие
   'reviews:updated' — страницы employees.html / dashboard.html слушают и
   перерисовывают KPI.

   Подключается ПОСЛЕ supabase-client.js?v=20260521a и app.js.
   ========================================================================== */
(function () {
  'use strict';

  if (!window.App) {
    console.warn('[reviews-sync] App not loaded');
    return;
  }
  const { Store } = window.App;

  const STORAGE_KEY = 'mentori-crm-v2';

  /** Пересчитать reviewsDone по фактической отметке исполнителя в аккаунтах. */
  function recompute() {
    if (!Store || !Store.state) return;
    const changed = Store._syncEmployeeWorkCounts();

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
