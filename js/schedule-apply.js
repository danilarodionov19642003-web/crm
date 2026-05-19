/* ==========================================================================
   Авто-применение переносов даты, согласованных через бота.
   --------------------------------------------------------------------------
   Когда клиент в утреннем опросе отвечает «Нет» и выбирает другую дату,
   бот пишет строку в schedule_responses (response='no', chosen_date != schedule_date).
   Этот скрипт при загрузке admin-страницы:
     1. Подтягивает все pending переносы (applied_at IS NULL)
     2. Для каждого находит клиента по client_code
     3. В client.schedule[] уменьшает count на исходной дате (или удаляет
        запись если был count=1) и добавляет 1 на новой дате
     4. Сохраняет изменения через Store.save() → CloudSync.push()
     5. PATCH-ит applied_at в schedule_responses чтобы не применять повторно
   Идемпотентен: при повторном открытии страниц повторно не сработает —
   applied_at защищает.
   Безопасен в клиент-портале — Store/Supabase там не определены, скрипт
   просто выйдет без действия.
   ========================================================================== */
(function () {
  'use strict';
  if (!window.App || !window.App.Store || !window.Supabase) return;

  const { Store } = window.App;
  const SUPA_URL  = window.Supabase.URL;
  const SUPA_KEY  = window.Supabase.KEY;
  if (!SUPA_URL || !SUPA_KEY) return;

  const HEADERS = {
    'apikey': SUPA_KEY,
    'Authorization': `Bearer ${SUPA_KEY}`,
  };

  async function fetchPending() {
    const url = `${SUPA_URL}/rest/v1/schedule_responses` +
                `?response=eq.no` +
                `&chosen_date=not.is.null` +
                `&applied_at=is.null` +
                `&select=id,client_code,mentor_id,schedule_date,chosen_date,chosen_time` +
                `&order=responded_at.desc.nullsfirst`;
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) {
        console.warn('[schedule-apply] fetch failed', res.status);
        return [];
      }
      return await res.json();
    } catch (e) {
      console.warn('[schedule-apply] fetch error', e);
      return [];
    }
  }

  async function markApplied(ids) {
    if (!ids.length) return;
    const idsStr = ids.join(',');
    const url = `${SUPA_URL}/rest/v1/schedule_responses?id=in.(${idsStr})&applied_at=is.null`;
    try {
      await fetch(url, {
        method: 'PATCH',
        headers: { ...HEADERS, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ applied_at: new Date().toISOString() }),
      });
    } catch (e) {
      console.warn('[schedule-apply] mark applied error', e);
    }
  }

  function applyOneTransfer(client, fromDate, toDate) {
    // Уменьшаем count на fromDate, увеличиваем на toDate. Если count
    // на fromDate был 1 — запись удаляем. Если на toDate нет — добавляем.
    if (!Array.isArray(client.schedule)) client.schedule = [];
    const fromIdx = client.schedule.findIndex(s => s.date === fromDate);
    if (fromIdx < 0) return false;             // нечего переносить — уже стёрто
    const cnt = Number(client.schedule[fromIdx].count) || 1;
    if (cnt <= 1) client.schedule.splice(fromIdx, 1);
    else          client.schedule[fromIdx].count = cnt - 1;
    const toIdx = client.schedule.findIndex(s => s.date === toDate);
    if (toIdx >= 0) {
      client.schedule[toIdx].count = (Number(client.schedule[toIdx].count) || 0) + 1;
    } else {
      client.schedule.push({ date: toDate, count: 1 });
    }
    client.schedule = client.schedule
      .filter(s => Number(s.count) > 0)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return true;
  }

  async function runApply() {
    if (!Store.state || !Array.isArray(Store.state.clients)) return;
    const rows = await fetchPending();
    if (!rows.length) return;
    let touched = false;
    const handledIds = [];
    for (const r of rows) {
      if (!r.client_code || !r.schedule_date || !r.chosen_date) {
        handledIds.push(r.id);
        continue;
      }
      if (r.schedule_date === r.chosen_date) {
        // ответил «no» но выбрал тот же день — это просто отказ, переносить
        // нечего, но в applied_at пометим чтобы не дёргать заново.
        handledIds.push(r.id);
        continue;
      }
      const code = String(r.client_code).toLowerCase().trim();
      const client = Store.state.clients.find(
        c => String(c.code || '').toLowerCase().trim() === code
      );
      if (!client) {
        // Клиента нет (удалили?) — помечаем applied, чтобы не дёргать.
        handledIds.push(r.id);
        continue;
      }
      const moved = applyOneTransfer(client, r.schedule_date, r.chosen_date);
      if (moved) touched = true;
      handledIds.push(r.id);
    }
    if (touched) {
      Store.save();   // localStorage + CloudSync.push()
      console.info(`[schedule-apply] applied ${rows.length} transfer(s)`);
    }
    await markApplied(handledIds);
  }

  // Ждём пока cloud-sync подтянет свежий state и Store.load() отработал.
  // Если state уже подтянут — запускаем сразу с небольшой задержкой
  // (даём pull'у успеть, если он в процессе).
  function start() {
    if (Store.state && Array.isArray(Store.state.clients)) {
      setTimeout(runApply, 1500);
    } else {
      window.addEventListener('cloudstate:updated', () => {
        setTimeout(runApply, 200);
      }, { once: true });
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
