/* ==========================================================================
   Accounts Sync — двусторонняя синхронизация state.clients ↔ Supabase.accounts
   --------------------------------------------------------------------------
   Зачем: сотрудник работает в `pages/employee/*` напрямую с таблицей `accounts`.
          Админка хранит то же в JSONB-блобе. Этот модуль держит их в курсе.

   Что делает:
   1. После каждого Store.save() — апсёртит изменившиеся клиенты (id, code,
      name, ordered, done, assigned_email) в таблицу accounts.
   2. При загрузке (и каждые 30 сек) — тянет accounts.done и обновляет
      state.clients[].done. Так админ видит, что сотрудник добавил отзыв.

   Подключается ПОСЛЕ supabase-client.js и app.js.
   ========================================================================== */
(function () {
  'use strict';

  if (!window.Supabase || !window.App) {
    console.warn('[accounts-sync] Supabase or App not loaded');
    return;
  }

  const { Tbl } = window.Supabase;
  const { Store } = window.App;

  /* ---- упаковка клиента в формат таблицы accounts ---- */
  function rowFromClient(c) {
    return {
      id:             c.id,
      code:           c.code || null,
      name:           c.name || null,
      ordered:        Number(c.ordered) || 0,
      done:           Number(c.done) || 0,
      assigned_email: (c.assignedEmail || '').toLowerCase().trim() || null,
      avatar_url:     c.avatarUrl || null,
      updated_at:     new Date().toISOString()
    };
  }

  /* ---- push: апсёртим только клиентов с заказом > 0 ---- */
  let pushTimer = null;
  function schedulePush() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushNow, 800);
  }

  async function pushNow() {
    try {
      const rows = (Store.state.clients || [])
        .filter(c => Number(c.ordered) > 0)
        .map(rowFromClient);
      if (rows.length === 0) return;
      await Tbl.upsert('accounts', rows, 'id');
    } catch (e) {
      console.warn('[accounts-sync] push error', e);
    }
  }

  /* ---- pull: подтягиваем done из облака ---- */
  async function pull() {
    try {
      const rows = await Tbl.select('accounts', 'select=id,done');
      const byId = new Map(rows.map(r => [r.id, r.done]));
      let changed = false;
      (Store.state.clients || []).forEach(c => {
        if (byId.has(c.id) && byId.get(c.id) !== Number(c.done || 0)) {
          c.done = Number(byId.get(c.id)) || 0;
          changed = true;
        }
      });
      if (changed) {
        // тихо сохраняем без триггера повторного push (избегаем эхо).
        // Просто пишем в localStorage и просим страницу перерисоваться.
        localStorage.setItem('mentori-crm-v2', JSON.stringify(Store.state));
        window.dispatchEvent(new CustomEvent('store:reloaded'));
      }
    } catch (e) {
      console.warn('[accounts-sync] pull error', e);
    }
  }

  /* ---- авто-push: оборачиваем Store.save() ---- */
  const origSave = Store.save.bind(Store);
  Store.save = function () {
    const r = origSave();
    schedulePush();
    return r;
  };

  /* ---- старт ---- */
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(pull, 300);                  // первый pull после загрузки
    setInterval(pull, 30_000);              // каждые 30 сек
  });

  // ручной триггер
  window.AccountsSync = { push: schedulePush, pull };
})();
