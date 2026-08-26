/* ========================================================================
   Canonical outreach schedule.

   Client changes live in client_outreach_slots, where PostgreSQL enforces the
   seven-per-day limit atomically. Admin pages still read client.schedule from
   the CRM state, so this module mirrors canonical rows into that legacy shape.
   ======================================================================== */
(function () {
  'use strict';

  if (!window.App || !window.App.Store || !window.Supabase) return;

  const { Store, normalizeClientCode, clientOutreachStartsByDate } = window.App;
  const TABLE = 'client_outreach_slots';
  const POLL_MS = 30 * 1000;
  const MOSCOW_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  let rows = [];
  let refreshPromise = null;
  let refreshTimer = null;

  function apiHeaders(extra = {}) {
    return {
      apikey: window.Supabase.KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...extra
    };
  }

  async function request(path, options = {}) {
    const url = `${window.Supabase.URL}/rest/v1/${path}`;
    const fetcher = window.Supabase.authFetch || fetch;
    const response = await fetcher(url, {
      ...options,
      headers: apiHeaders(options.headers || {})
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = String(body && (body.message || body.details || body.hint) || `HTTP ${response.status}`);
      const error = new Error(message);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }

  function mentorIdsForClient(client) {
    const code = normalizeClientCode(client && client.code);
    if (!code) return [];
    return (Store.state.mentors || [])
      .filter(mentor => normalizeClientCode(mentor.code) === code)
      .map(mentor => mentor.id)
      .filter(Boolean);
  }

  function mentorIdForClient(client) {
    return mentorIdsForClient(client)[0] || '';
  }

  function normalizedSchedule(schedule) {
    return (Array.isArray(schedule) ? schedule : [])
      .filter(item => item && /^\d{4}-\d{2}-\d{2}$/.test(String(item.date || '').slice(0, 10)))
      .map(item => ({
        date: String(item.date).slice(0, 10),
        count: Math.max(0, Number(item.count) || 0)
      }))
      .filter(item => item.count > 0)
      .sort((left, right) => left.date.localeCompare(right.date));
  }

  function schedulesEqual(left, right) {
    return JSON.stringify(normalizedSchedule(left)) === JSON.stringify(normalizedSchedule(right));
  }

  function moscowTodayISO(now = new Date()) {
    const parts = MOSCOW_DATE_FORMATTER.formatToParts(now);
    const value = type => parts.find(part => part.type === type)?.value || '';
    return `${value('year')}-${value('month')}-${value('day')}`;
  }

  function syncStateFromRows(nextRows, businessToday = moscowTodayISO()) {
    if (!Store.state || !Array.isArray(Store.state.clients)) return false;
    const byMentor = new Map();
    (nextRows || []).forEach(row => {
      const mentorId = String(row && row.mentor_id || '');
      const date = String(row && row.scheduled_date || '').slice(0, 10);
      if (!mentorId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
      if (!byMentor.has(mentorId)) byMentor.set(mentorId, []);
      byMentor.get(mentorId).push({ ...row, scheduled_date: date });
    });

    let changed = false;
    Store.state.clients.forEach(client => {
      const mentorIds = mentorIdsForClient(client);
      const clientRows = mentorIds.flatMap(id => byMentor.get(id) || []);
      if (!clientRows.length) return;

      const activeByDate = new Map();
      const managedDates = new Set();
      clientRows.forEach(row => {
        managedDates.add(row.scheduled_date);
        if (row.slot_status === 'scheduled' && row.scheduled_date >= businessToday) {
          activeByDate.set(row.scheduled_date, (activeByDate.get(row.scheduled_date) || 0) + 1);
        }
      });
      const starts = clientOutreachStartsByDate(Store.state, client);
      const nextSchedule = [...managedDates].sort().map(date => ({
        date,
        // Legacy clientScheduleBreakdown subtracts outreach starts. Keep them
        // in the raw count so only canonical active slots remain visible.
        count: (activeByDate.get(date) || 0) + Math.max(0, Number(starts[date]) || 0)
      })).filter(item => item.count > 0);

      if (!schedulesEqual(client.schedule, nextSchedule)) {
        client.schedule = nextSchedule;
        changed = true;
      }
    });

    if (changed) Store.save();
    return changed;
  }

  async function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        await request('rpc/staff_expire_past_client_outreach_slots', {
          method: 'POST',
          body: '{}'
        });
      } catch (error) {
        // Keep admin pages usable during a rolling release. The local Moscow
        // date guard below still hides overdue slots until the RPC is present.
        console.warn('[outreach-schedule-sync] expiry RPC failed', error);
      }
      const nextRows = await request(
        `${TABLE}?select=id,client_email,mentor_id,anketa_code,anketa_name,scheduled_date,slot_status,source,updated_at&order=id.asc`
      );
      rows = Array.isArray(nextRows) ? nextRows : [];
      const changed = syncStateFromRows(rows);
      window.dispatchEvent(new CustomEvent('outreachschedule:updated', {
        detail: { rows: rows.slice(), changed }
      }));
      return rows.slice();
    })().catch(error => {
      console.warn('[outreach-schedule-sync] refresh failed', error);
      throw error;
    }).finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  async function rpc(name, payload) {
    const result = await request(`rpc/${name}`, {
      method: 'POST',
      body: JSON.stringify(payload || {})
    });
    await refresh();
    return result;
  }

  function adjustStaff(mentorId, date, delta) {
    return rpc('staff_adjust_outreach_slot', {
      p_mentor_id: mentorId,
      p_date: date,
      p_delta: delta
    });
  }

  function moveStaff(mentorId, fromDate, toDate) {
    return rpc('staff_move_outreach_slot', {
      p_mentor_id: mentorId,
      p_from: fromDate,
      p_to: toDate
    });
  }

  function clearStaff(mentorId) {
    return rpc('staff_clear_outreach_slots', { p_mentor_id: mentorId });
  }

  function completeStaff(mentorId, date) {
    return rpc('staff_complete_outreach_slot', {
      p_mentor_id: mentorId,
      p_date: date
    });
  }

  function scheduleRefresh(delay = 250) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh().catch(() => {}), delay);
  }

  function start() {
    scheduleRefresh(900);
    window.setInterval(() => {
      if (document.visibilityState === 'visible') scheduleRefresh(0);
    }, POLL_MS);
  }

  window.addEventListener('cloudstate:updated', () => scheduleRefresh(150));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleRefresh(0);
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.OutreachScheduleSync = {
    refresh,
    rows: () => rows.slice(),
    syncStateFromRows,
    moscowTodayISO,
    mentorIdsForClient,
    mentorIdForClient,
    adjustStaff,
    moveStaff,
    clearStaff,
    completeStaff
  };
})();
