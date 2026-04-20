/* ==========================================================================
   Cloud Sync — Supabase backend
   --------------------------------------------------------------------------
   Хранит весь state CRM как JSON в одной строке таблицы `crm_state` (id='main').
   - При загрузке страницы: подтягивает свежий state из облака → обновляет
     localStorage → диспатчит событие 'cloudstate:updated'.
   - При каждом сохранении: дебаунсит и шлёт PATCH в облако.

   Таблица создаётся через SQL из SUPABASE_SETUP.md.
   ========================================================================== */
(function () {
  // === КОНФИГ ===========================================================
  const SUPABASE_URL = 'https://ivzouyhyuyfzoodhyrya.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_QpxNagNre_4iKQrVO5Swzw_XWhmrQo4';
  const TABLE   = 'crm_state';
  const ROW_ID  = 'main';
  const STORAGE_KEY = 'mentori-crm-v2';
  const META_KEY    = 'mentori-crm-meta';   // { lastPushedAt, lastPulledAt }

  // Принудительный ресинк через URL ?resync=1 — чистим локалку ДО того,
  // как app.js успеет её прочитать. Параметр после этого убираем из URL.
  try {
    const params = new URLSearchParams(location.search);
    if (params.has('resync')) {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(META_KEY);
      params.delete('resync');
      const clean = location.pathname + (params.toString() ? '?' + params.toString() : '') + location.hash;
      history.replaceState(null, '', clean);
    }
  } catch (e) { console.warn('[CloudSync] resync reset failed', e); }

  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };

  /* ---- Сетевые операции ---- */
  async function fetchRemote() {
    const url = `${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.${ROW_ID}&select=data,updated_at`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`fetch ${res.status}: ${await res.text()}`);
    const rows = await res.json();
    return rows[0] || null;  // { data, updated_at } или null
  }

  async function pushRemote(state) {
    const updated_at = new Date().toISOString();
    const body = JSON.stringify({ id: ROW_ID, data: state, updated_at });
    // upsert через POST с Prefer: resolution=merge-duplicates
    const url = `${SUPABASE_URL}/rest/v1/${TABLE}?on_conflict=id`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body
    });
    if (!res.ok && res.status !== 201 && res.status !== 204) {
      throw new Error(`push ${res.status}: ${await res.text()}`);
    }
    setMeta({ lastPushedAt: updated_at });
    return updated_at;
  }

  /* ---- Локальные мета-данные ---- */
  function getMeta() {
    try { return JSON.parse(localStorage.getItem(META_KEY) || '{}'); }
    catch { return {}; }
  }
  function setMeta(patch) {
    const m = { ...getMeta(), ...patch };
    localStorage.setItem(META_KEY, JSON.stringify(m));
  }

  /* ---- Индикатор статуса в шапке ---- */
  function setStatus(state, text) {
    const el = document.getElementById('cloudStatus');
    if (!el) return;
    el.dataset.state = state;        // idle | syncing | synced | error | offline
    el.querySelector('.cloud-status__text').textContent = text || '';
  }

  /* ---- Pull: вытянуть удалённый state и заместить локальный ---- */
  async function pull({ silent = false } = {}) {
    if (!silent) setStatus('syncing', 'Загрузка…');
    try {
      const remote = await fetchRemote();
      if (!remote || !remote.data || Object.keys(remote.data).length === 0) {
        // удалённого state ещё нет — отправим текущий локальный
        remoteSnapshot = null;
        pullCompleted = true;
        const local = readLocal();
        if (local) await pushRemote(local);
        setStatus('synced', 'Синхронизировано');
        if (pendingState) { clearTimeout(pushTimer); pushTimer = setTimeout(flush, 50); }
        return { changed: false };
      }
      remoteSnapshot = remote.data;
      pullCompleted = true;
      // если push ждал окончания pull — запустим его сейчас
      if (pendingState) { clearTimeout(pushTimer); pushTimer = setTimeout(flush, 50); }

      const localRaw = localStorage.getItem(STORAGE_KEY);
      const remoteRaw = JSON.stringify(remote.data);
      const meta = getMeta();
      setMeta({ lastPulledAt: remote.updated_at });

      if (localRaw === remoteRaw) {
        setStatus('synced', 'Синхронизировано');
        return { changed: false };
      }

      // Решение конфликта: если локальный был запушен позже remote.updated_at —
      // оставляем локальный (он ещё в очереди на отправку). Иначе берём облако.
      const lastPushedAt = meta.lastPushedAt;
      if (lastPushedAt && lastPushedAt > remote.updated_at) {
        setStatus('synced', 'Синхронизировано');
        return { changed: false };
      }

      // Принимаем облачный state
      localStorage.setItem(STORAGE_KEY, remoteRaw);
      setStatus('synced', 'Обновлено из облака');
      window.dispatchEvent(new CustomEvent('cloudstate:updated', { detail: remote.data }));
      return { changed: true, data: remote.data };
    } catch (e) {
      console.warn('[CloudSync] pull error', e);
      setStatus('error', 'Нет связи');
      return { changed: false, error: e };
    }
  }

  /* ---- Push (debounced) ----
     ⚠️ SAFETY: push заблокирован до первого успешного pull.
     Иначе _seed() из app.js может улететь в облако раньше, чем cloud-sync
     успеет загрузить актуальное состояние — и затереть боевые данные пустым сидом.
     Снимок этой катастрофы лежал в /tmp/crm_BROKEN_19_37.json (20.04.2026). */
  let pushTimer = null;
  let pendingState = null;
  let pullCompleted = false;         // true после первого успешного fetchRemote
  let remoteSnapshot = null;         // последний известный облачный state — для safety-check
  const BIG_COLLECTIONS = ['mentors','profiles','ipLogs','phones','accountRegs','profileStatuses'];

  /** Возвращает true, если state подозрительно пуст по всем «большим» коллекциям. */
  function isEffectivelyEmpty(s) {
    if (!s || typeof s !== 'object') return true;
    return BIG_COLLECTIONS.every(k => !Array.isArray(s[k]) || s[k].length === 0);
  }
  /** Возвращает true, если remote имеет хоть какие-то «большие» данные. */
  function remoteHasData(s) {
    if (!s || typeof s !== 'object') return false;
    return BIG_COLLECTIONS.some(k => Array.isArray(s[k]) && s[k].length > 0);
  }

  function schedulePush(state) {
    pendingState = state;
    if (!pullCompleted) {
      // не ставим таймер — flush запустится после первого pull
      setStatus('syncing', 'Ожидание облака…');
      return;
    }
    setStatus('syncing', 'Сохранение…');
    clearTimeout(pushTimer);
    pushTimer = setTimeout(flush, 600);
  }

  async function flush() {
    if (!pendingState) return;
    if (!pullCompleted) return; // повторная защита
    const state = pendingState;
    pendingState = null;
    // SAFETY-CHECK: нельзя перезаписывать непустое облако пустым локальным state.
    if (isEffectivelyEmpty(state) && remoteHasData(remoteSnapshot)) {
      console.error('[CloudSync] BLOCKED push of empty state over non-empty remote.', {
        localKeys: Object.keys(state || {}),
        remoteCounts: BIG_COLLECTIONS.reduce((o,k) => (o[k]=(remoteSnapshot[k]||[]).length, o), {})
      });
      setStatus('error', 'Push отклонён (защита)');
      return;
    }
    try {
      await pushRemote(state);
      setStatus('synced', 'Сохранено');
    } catch (e) {
      console.warn('[CloudSync] push error', e);
      setStatus('error', 'Ошибка сохранения');
      // повторим через минуту
      setTimeout(() => schedulePush(state), 30_000);
    }
  }

  function readLocal() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
    catch { return null; }
  }

  /* ---- Online/offline events ---- */
  window.addEventListener('online',  () => { setStatus('syncing','Восстановление…'); pull(); flush(); });
  window.addEventListener('offline', () => setStatus('offline','Оффлайн'));

  /* ---- Публичный API ---- */
  window.CloudSync = {
    pull,
    push: schedulePush,
    flush,
    URL: SUPABASE_URL,
    isConfigured: () => !!SUPABASE_URL && !!SUPABASE_KEY
  };

  /* ---- Авто-pull при загрузке страницы ---- */
  document.addEventListener('DOMContentLoaded', () => {
    if (!navigator.onLine) { setStatus('offline','Оффлайн'); return; }
    // Дать app.js успеть инициализировать Store.load() сначала из localStorage,
    // затем тянем облако и при необходимости ререндерим.
    setTimeout(() => pull(), 50);
  });

  /* ---- Если страница уже отрисована, а пришли свежие данные —
         НЕ перезагружаем страницу (это вызывало бесконечную петлю,
         когда accounts-sync и cloud-sync друг друга «перетягивают»).
         Пробрасываем событие как cloudstate:updated — страницы сами
         подписываются и перерисовываются без релоада. ---- */
  window.addEventListener('store:reloaded', () => {
    window.dispatchEvent(new CustomEvent('cloudstate:updated'));
  });
})();
