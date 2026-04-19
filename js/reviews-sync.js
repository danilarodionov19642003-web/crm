/* ==========================================================================
   Reviews Sync — авто-подсчёт отзывов сотрудников.
   --------------------------------------------------------------------------
   Тянет из Supabase tasks (status='проверено'), считает количество по
   employee_email и обновляет state.employees[*].reviewsDone.
   После каждого изменения шлёт событие 'reviews:updated' — страницы
   employees.html / dashboard.html слушают и перерисовываются.

   Подключается ПОСЛЕ supabase-client.js и app.js.
   ========================================================================== */
(function () {
  'use strict';

  if (!window.Supabase || !window.App) {
    console.warn('[reviews-sync] Supabase or App not loaded');
    return;
  }

  const { Tbl } = window.Supabase;
  const { Store } = window.App;

  async function pull() {
    try {
      // тянем только нужные поля только проверенных тасков
      const rows = await Tbl.select(
        'tasks',
        'select=employee_email&status=eq.%D0%BF%D1%80%D0%BE%D0%B2%D0%B5%D1%80%D0%B5%D0%BD%D0%BE'
      );
      // counts by email
      const counts = new Map();
      rows.forEach(r => {
        const e = (r.employee_email || '').toLowerCase();
        if (!e) return;
        counts.set(e, (counts.get(e) || 0) + 1);
      });

      let changed = false;
      (Store.state.employees || []).forEach(emp => {
        const email = (emp.email || '').toLowerCase();
        if (!email) return;            // у сотрудника нет привязки — не трогаем
        const cnt = counts.get(email) || 0;
        if (Number(emp.reviewsDone || 0) !== cnt) {
          emp.reviewsDone = cnt;
          changed = true;
        }
      });

      if (changed) {
        // тихо записываем без эха в облако
        localStorage.setItem('mentori-crm-v2', JSON.stringify(Store.state));
        window.dispatchEvent(new CustomEvent('reviews:updated'));
      }
    } catch (e) {
      console.warn('[reviews-sync] pull error', e);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(pull, 600);                 // первый pull (после accounts-sync)
    setInterval(pull, 30_000);             // каждые 30 сек
  });

  window.ReviewsSync = { pull };
})();
