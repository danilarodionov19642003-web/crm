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
        const local = readLocal();
        if (local) await pushRemote(local);
        setStatus('synced', 'Синхронизировано');
        return { changed: false };
      }
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

  /* ---- Push (debounced) ---- */
  let pushTimer = null;
  let pendingState = null;
  function schedulePush(state) {
    pendingState = state;
    setStatus('syncing', 'Сохранение…');
    clearTimeout(pushTimer);
    pushTimer = setTimeout(flush, 600);
  }

  async function flush() {
    if (!pendingState) return;
    const state = pendingState;
    pendingState = null;
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
         простейший способ обновить UI везде: перезагрузить страницу. ---- */
  window.addEventListener('store:reloaded', () => {
    // флажок не даёт зациклить релоад, если cloudstate приходит снова
    if (window.__cloudReloadDone) return;
    window.__cloudReloadDone = true;
    setTimeout(() => location.reload(), 100);
  });
})();
