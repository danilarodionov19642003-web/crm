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
  // URL/KEY теперь динамические — берём из supabase-client.js (там есть
  // авто-фолбэк api.mentori.tech ↔ supabase.co). Используем геттеры,
  // чтобы при каждом fetch получать текущий рабочий backend.
  const _SB = () => (window.Supabase || {});
  function _supaUrl() { return _SB().URL || 'https://api.mentori.tech'; }
  function _supaKey() { return _SB().KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzc5MzE4NDc3LCJleHAiOjIwOTQ2Nzg0Nzd9.XuMHwfOo8qcycoooOMGwWd3R9_YA55JQZwaJBh132N8'; }
  Object.defineProperty(window, '_CloudSyncBackend', { get: () => _SB().backend || 'primary' });
  const TABLE   = 'crm_state';
  const ROW_ID  = 'main';
  const SNAPSHOTS_TABLE = 'client_snapshots';   // зеркало для личных кабинетов клиентов
  const HISTORY_TABLE   = 'crm_state_history';  // история снимков для отката
  const OUTBOX_TABLE    = 'notification_outbox'; // очередь TG-уведомлений (читает бот на VPS)
  const STORAGE_KEY = 'mentori-crm-v2';
  const META_KEY    = 'mentori-crm-meta';   // { lastPushedAt, lastPulledAt }
  const PENDING_KEY = 'mentori-crm-pending'; // несохранённый push (для recovery после reload)
  const HISTORY_THROTTLE_MS = 5 * 60 * 1000;  // не чаще 1 снимка в 5 минут
  const POLL_INTERVAL_MS    = 60 * 1000;      // фоновый pull раз в минуту
  // Exponential backoff retry: 5с, 15с, 45с, 2мин, 5мин, потом каждые 5мин.
  // Лучше много попыток с растущей паузой, чем 1 retry через 30с.
  const RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000, 300_000];

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

  // headers — функция, потому что и _supaKey() меняется после фолбэка,
  // и access_token обновляется после логина/refresh.
  //
  // С 22.05.2026 Bearer = access_token пользователя (не ANON), потому что
  // RLS теперь требует authenticated с app_metadata.role IN ('owner','team').
  // Без сессии падаем в ANON — но тогда RLS не пропустит и push вернёт 401,
  // что корректно: незалогиненный не должен ничего писать.
  function _hdr() {
    const tok = (window.Supabase && window.Supabase.accessToken && window.Supabase.accessToken()) || _supaKey();
    return {
      'apikey': _supaKey(),
      'Authorization': `Bearer ${tok}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    };
  }

  /* ---- Сетевые операции ---- */
  async function fetchRemote() {
    const url = `${_supaUrl()}/rest/v1/${TABLE}?id=eq.${ROW_ID}&select=data,updated_at`;
    const res = await fetch(url, { headers: _hdr() });
    if (!res.ok) throw new Error(`fetch ${res.status}: ${await res.text()}`);
    const rows = await res.json();
    return rows[0] || null;  // { data, updated_at } или null
  }

  async function pushRemote(state) {
    const updated_at = new Date().toISOString();
    const body = JSON.stringify({ id: ROW_ID, data: state, updated_at });
    // upsert через POST с Prefer: resolution=merge-duplicates
    const url = `${_supaUrl()}/rest/v1/${TABLE}?on_conflict=id`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...(_hdr()), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body
    });
    if (!res.ok && res.status !== 201 && res.status !== 204) {
      throw new Error(`push ${res.status}: ${await res.text()}`);
    }
    setMeta({ lastPushedAt: updated_at });
    serverUpdatedAt = updated_at;             // мы только что записали — это новая «правда»
    remoteSnapshot  = state;                  // и обновим snapshot для safety-check
    // Фоном дублируем снимок в историю (best-effort, throttled).
    pushHistory(state).catch(e => console.warn('[CloudSync] history push failed', e));
    return updated_at;
  }

  /* ---- История версий ----
     На каждый успешный push добавляем строку в crm_state_history.
     Throttle: не чаще 1 раза в HISTORY_THROTTLE_MS (5 мин) — иначе при
     активной работе мы бы засирали таблицу десятками снимков в минуту.
     Откат: SELECT data FROM crm_state_history ORDER BY id DESC; найти
     нужную версию и UPDATE crm_state SET data = ... WHERE id='main'. */
  let lastHistoryAt = 0;
  async function pushHistory(state) {
    const now = Date.now();
    if (now - lastHistoryAt < HISTORY_THROTTLE_MS) return;
    lastHistoryAt = now;
    const row = {
      state_id: ROW_ID,
      data: state,
      pushed_at: new Date().toISOString(),
      client_info: (navigator.userAgent || '').slice(0, 200)
    };
    const url = `${_supaUrl()}/rest/v1/${HISTORY_TABLE}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...(_hdr()), 'Prefer': 'return=minimal' },
      body: JSON.stringify(row)
    });
    if (!res.ok && res.status !== 201 && res.status !== 204) {
      // не валим основной push — это всего лишь история
      const text = await res.text().catch(() => '');
      console.warn('[CloudSync] history insert failed', res.status, text);
      // откатим throttle, чтобы следующий push попробовал ещё раз
      lastHistoryAt = 0;
    }
  }

  /* ---- Push client snapshots ----
     После каждого успешного push в crm_state — пересобираем индивидуальные
     снимки для каждого клиента-портала и заливаем их в client_snapshots.
     Это та таблица, к которой клиент имеет доступ через RLS (по email из JWT).
     К сырому crm_state клиент доступа НЕ имеет. */
  async function pushClientSnapshots(state) {
    if (!state || !window.App || !window.App.Store) return;
    const Store = window.App.Store;
    // Подкладываем state, чтобы Store сгенерил снимки именно из него,
    // а не из своей внутренней копии (на момент вызова они идентичны).
    const portals = state.clientPortals || [];
    if (!portals.length) return; // нечего пушить
    // Используем Store API, но переключим временно state
    const saved = Store.state;
    Store.state = state;
    let snapshots;
    try {
      snapshots = Store.buildAllClientSnapshots();
    } finally {
      Store.state = saved;
    }
    if (!snapshots.length) return;
    const updated_at = new Date().toISOString();
    const rows = snapshots.map(s => ({
      email: s.email,
      payload: s.payload,
      updated_at
    }));
    const url = `${_supaUrl()}/rest/v1/${SNAPSHOTS_TABLE}?on_conflict=email`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...(_hdr()), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows)
    });
    if (!res.ok && res.status !== 201 && res.status !== 204) {
      // не валим основной push — снимки можно перезалить в следующий раз
      console.warn('[CloudSync] client_snapshots push failed', res.status, await res.text().catch(() => ''));
      return;
    }
    // Удалим лишние снимки (если в админке удалили доступ — соответствующая
    // строка в client_snapshots должна исчезнуть, иначе клиент сохранит
    // последний снимок в своём кабинете).
    try {
      const existingRes = await fetch(
        `${_supaUrl()}/rest/v1/${SNAPSHOTS_TABLE}?select=email`,
        { headers: _hdr() }
      );
      if (existingRes.ok) {
        const existing = await existingRes.json();
        const allowed = new Set(snapshots.map(s => s.email));
        const stale = existing.map(r => r.email).filter(e => !allowed.has(e));
        for (const email of stale) {
          const enc = encodeURIComponent(email);
          await fetch(
            `${_supaUrl()}/rest/v1/${SNAPSHOTS_TABLE}?email=eq.${enc}`,
            { method: 'DELETE', headers: _hdr() }
          ).catch(() => {});
        }
      }
    } catch (e) {
      console.warn('[CloudSync] snapshots cleanup failed', e);
    }
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
      remoteSnapshot   = remote.data;
      serverUpdatedAt  = remote.updated_at;   // фиксируем «версию» сервера
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
  let serverUpdatedAt = null;        // updated_at последней версии, которую мы видели/писали
  let retryAttempt = 0;              // счётчик неуспешных push для exponential backoff
  // «Большие» коллекции — те потеря которых однозначно катастрофа.
  // anti-wipe защита: если ВСЕ они пусты, а в облаке хоть какая-то — push
  // блокируется. Список расширен на clients/income/expenses потому что
  // финансовые данные так же критичны, как и аккаунты.
  const BIG_COLLECTIONS = [
    'mentors', 'profiles', 'ipLogs', 'phones',
    'accountRegs', 'profileStatuses',
    'clients', 'income', 'expenses', 'subscriptions', 'reviews',
  ];

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

  // Сохраняем pendingState в localStorage, чтобы при перезагрузке страницы
  // (или краше браузера) изменения не пропали. На старте recoverPending()
  // вытащит и повторит push.
  function persistPending(state) {
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify({
        state, queued_at: new Date().toISOString()
      }));
    } catch (_) {}
  }
  function clearPersistedPending() {
    try { localStorage.removeItem(PENDING_KEY); } catch (_) {}
  }
  function readPersistedPending() {
    try { return JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); }
    catch { return null; }
  }

  function schedulePush(state) {
    pendingState = state;
    persistPending(state);            // ← на случай reload/closure
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
    // SAFETY-CHECK 1: нельзя перезаписывать непустое облако пустым локальным state.
    if (isEffectivelyEmpty(state) && remoteHasData(remoteSnapshot)) {
      console.error('[CloudSync] BLOCKED push of empty state over non-empty remote.', {
        localKeys: Object.keys(state || {}),
        remoteCounts: BIG_COLLECTIONS.reduce((o,k) => (o[k]=(remoteSnapshot[k]||[]).length, o), {})
      });
      setStatus('error', 'Push отклонён (защита)');
      return;
    }
    // SAFETY-CHECK 2: проверка конкурентности.
    // Перед push сверяемся с сервером — если updated_at там новее того, что
    // мы видели последний pull’ом, значит другая вкладка/устройство уже
    // записали свежую версию. В таком случае не пушим (иначе затрём чужое),
    // а делаем pull и просим страницы перерисоваться. Локальный мелкий клик,
    // который привёл к этому push, придётся повторить — но это лучше, чем
    // молча грохнуть ночные изменения с другого устройства.
    try {
      const remote = await fetchRemote();
      if (remote && remote.updated_at && serverUpdatedAt && remote.updated_at > serverUpdatedAt) {
        console.warn('[CloudSync] CONFLICT: server newer than seen, pulling instead of pushing.', {
          seen: serverUpdatedAt, server: remote.updated_at
        });
        remoteSnapshot  = remote.data;
        serverUpdatedAt = remote.updated_at;
        setMeta({ lastPulledAt: remote.updated_at });
        localStorage.setItem(STORAGE_KEY, JSON.stringify(remote.data));
        window.dispatchEvent(new CustomEvent('cloudstate:updated', { detail: remote.data }));
        setStatus('synced', 'Обновлено из облака');
        return;
      }
    } catch (e) {
      // Если сеть упала — лучше попробовать push, чем потерять данные.
      console.warn('[CloudSync] concurrency check failed, proceeding with push', e);
    }
    try {
      await pushRemote(state);
      retryAttempt = 0;                  // успех — сбрасываем счётчик retry
      clearPersistedPending();           // ушло в облако — больше не нужно держать
      setStatus('synced', 'Сохранено');
      // Зеркалим личные снимки клиентов — best effort, не блокирует основной push
      pushClientSnapshots(state).catch(e => {
        console.warn('[CloudSync] snapshots mirror failed', e);
      });
    } catch (e) {
      console.warn('[CloudSync] push error, will retry', e);
      // Возвращаем state в pendingState чтобы следующий flush его подобрал.
      // НЕ чистим persistPending — он останется до успешного push.
      pendingState = state;
      const delay = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)];
      retryAttempt++;
      setStatus('error', `Ошибка сохранения, повтор через ${Math.round(delay/1000)}с (попытка ${retryAttempt})`);
      clearTimeout(pushTimer);
      pushTimer = setTimeout(flush, delay);
    }
  }

  function readLocal() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
    catch { return null; }
  }

  /* ---- Online/offline events ---- */
  window.addEventListener('online',  () => { setStatus('syncing','Восстановление…'); pull(); flush(); });
  window.addEventListener('offline', () => setStatus('offline','Оффлайн'));

  /* ---- Push при закрытии вкладки ----
     Дебаунс на 600 мс не успевает выстрелить, если юзер тут же закрыл
     ноут/вкладку. Раньше из-за этого терялись «последние клики перед сном».
     На pagehide/beforeunload отправляем pendingState через keepalive:true —
     браузер гарантирует доставку даже после выгрузки страницы.
     sendBeacon не подходит, так как требует фиксированный Content-Type
     и не позволяет проставить apikey/Authorization. */
  function flushOnHide() {
    if (!pendingState || !pullCompleted) return;
    const state = pendingState;
    if (isEffectivelyEmpty(state) && remoteHasData(remoteSnapshot)) return;
    // НЕ обнуляем pendingState и НЕ чистим persistPending — keepalive-запрос
    // может не долететь, тогда при следующей загрузке recoverPending() подберёт.
    // Очистка произойдёт после успешного pushRemote (он удалит PENDING_KEY).
    const updated_at = new Date().toISOString();
    const body = JSON.stringify({ id: ROW_ID, data: state, updated_at });
    const url = `${_supaUrl()}/rest/v1/${TABLE}?on_conflict=id`;
    try {
      fetch(url, {
        method: 'POST',
        headers: { ...(_hdr()), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body,
        keepalive: true
      });
      setMeta({ lastPushedAt: updated_at });
      // дублируем в историю — тоже keepalive, тоже best-effort
      const histRow = {
        state_id: ROW_ID,
        data: state,
        pushed_at: updated_at,
        client_info: 'pagehide:' + (navigator.userAgent || '').slice(0, 180)
      };
      fetch(`${_supaUrl()}/rest/v1/${HISTORY_TABLE}`, {
        method: 'POST',
        headers: { ...(_hdr()), 'Prefer': 'return=minimal' },
        body: JSON.stringify(histRow),
        keepalive: true
      });
    } catch (e) { /* всё, что могли — сделали */ }
  }
  window.addEventListener('pagehide', flushOnHide);
  window.addEventListener('beforeunload', flushOnHide);
  // На мобильных Safari pagehide не всегда срабатывает при сворачивании —
  // дополнительно спасаемся при переходе вкладки в hidden.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushOnHide();
  });

  /* ---- Фоновый pull раз в минуту ----
     Закрывает сценарий «вторая вкладка с устаревшим стейтом перетёрла
     свежие данные»: даже если ты её не трогаешь, она каждую минуту
     подтягивает актуальный state и обновляет serverUpdatedAt.
     Только когда вкладка видима — на скрытой нет смысла греть сеть. */
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (!navigator.onLine) return;
    if (!pullCompleted) return;
    pull({ silent: true });
  }, POLL_INTERVAL_MS);

  /* ---- Очередь Telegram-уведомлений ----
     Вызывается из app.js при смене статуса. Просто INSERT-нашей строки
     в notification_outbox. Бот на VPS опрашивает таблицу и шлёт сообщения.
     Best effort: ошибки логируем, ничего не блокируем. */
  async function queueTelegramNotification(row) {
    if (!row || !row.message) return false;
    const url = `${_supaUrl()}/rest/v1/${OUTBOX_TABLE}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...(_hdr()), 'Prefer': 'return=minimal' },
        body: JSON.stringify(row)
      });
      if (!res.ok && res.status !== 201 && res.status !== 204) {
        const text = await res.text().catch(() => '');
        console.warn('[CloudSync] outbox insert failed', res.status, text);
        return false;
      }
      return true;
    } catch (e) {
      console.warn('[CloudSync] outbox insert error', e);
      return false;
    }
  }

  /* ---- Ручной бэкап: скачать текущий облачный state как JSON ----
     Удобно жать раз в день/после важной работы. Файл лежит у тебя локально
     и в случае любой проблемы с базой — восстанавливается одним SQL. */
  async function downloadBackup() {
    setStatus('syncing', 'Готовим бэкап…');
    try {
      const remote = await fetchRemote();
      const data = (remote && remote.data) || readLocal() || {};
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mentori-crm-backup-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus('synced', 'Бэкап скачан');
      return true;
    } catch (e) {
      console.error('[CloudSync] backup failed', e);
      setStatus('error', 'Ошибка бэкапа');
      // fallback — отдаём хотя бы локальный стейт, чтобы юзер не остался ни с чем
      try {
        const data = readLocal() || {};
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mentori-crm-backup-LOCAL-${stamp}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
      } catch (_) {}
      return false;
    }
  }

  /* ---- Публичный API ---- */
  window.CloudSync = Object.defineProperties({
    pull,
    push: schedulePush,
    flush,
    flushOnHide,
    pushClientSnapshots,    // ручной триггер: после CRUD над clientPortals
    queueTelegramNotification, // пишем строку в notification_outbox (читает бот)
    downloadBackup,         // ручной бэкап на диск (используется кнопкой в шапке)
    isConfigured: () => !!_supaUrl() && !!_supaKey()
  }, {
    // URL — геттер: автоматически подхватит фолбэк после _probe()
    URL: { get: () => _supaUrl(), enumerable: true }
  });

  /* ---- Recovery несохранённых изменений ----
     При предыдущей сессии push мог упасть (сеть, 5xx, закрытие вкладки).
     pendingState мы успели сохранить в localStorage — поднимем его и
     поставим в очередь. Если облако с тех пор обновили — concurrency-check
     внутри flush() корректно сделает pull вместо push, ничего не затрёт. */
  function recoverPending() {
    const saved = readPersistedPending();
    if (!saved || !saved.state) return;
    console.warn('[CloudSync] recovering pending push from', saved.queued_at);
    pendingState = saved.state;
    setStatus('syncing', 'Восстанавливаем несохранённое…');
    // не дёргаем flush сразу — он запустится после первого успешного pull
    // (см. ветку `if (pendingState) ...` внутри pull()).
  }

  /* ---- Авто-pull при загрузке страницы ---- */
  document.addEventListener('DOMContentLoaded', () => {
    recoverPending();
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
