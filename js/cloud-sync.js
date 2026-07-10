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
  const PENDING_QUARANTINE_KEY = 'mentori-crm-pending-quarantine';
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

  async function pushRemote(state, expectedUpdatedAt = serverUpdatedAt) {
    const updated_at = new Date().toISOString();
    const expected = expectedUpdatedAt ? encodeURIComponent(expectedUpdatedAt) : '';
    const body = expected
      ? JSON.stringify({ data: state, updated_at })
      : JSON.stringify({ id: ROW_ID, data: state, updated_at });
    const url = expected
      ? `${_supaUrl()}/rest/v1/${TABLE}?id=eq.${ROW_ID}&updated_at=eq.${expected}&select=id`
      : `${_supaUrl()}/rest/v1/${TABLE}?on_conflict=id`;
    const res = await fetch(url, {
      method: expected ? 'PATCH' : 'POST',
      headers: {
        ...(_hdr()),
        'Prefer': expected ? 'return=representation' : 'resolution=merge-duplicates,return=minimal'
      },
      body
    });
    if (!res.ok && res.status !== 201 && res.status !== 204) {
      throw new Error(`push ${res.status}: ${await res.text()}`);
    }
    if (expected) {
      const rows = await res.json();
      if (!rows || rows.length === 0) throw new Error('push conflict: crm_state changed during write');
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

  /* Сравнение меток времени ПО EPOCH, не строкой. Форматы updated_at могут
     отличаться: наш push пишет `...Z` (Date.toISOString), а PostgREST отдаёт
     `...+00:00`. Строковое сравнение таких меток врёт → конфликт не ловился →
     устаревшая вкладка затирала свежие данные (инцидент 2026-06-24). */
  function tsMs(x) { const t = x ? Date.parse(x) : NaN; return isNaN(t) ? 0 : t; }

  function cloneState(x) {
    if (!x || typeof x !== 'object') return x;
    try { return JSON.parse(JSON.stringify(x)); }
    catch (_) { return x; }
  }

  function sameJson(a, b) {
    try { return JSON.stringify(a) === JSON.stringify(b); }
    catch (_) { return false; }
  }

  function mergeObjectPatch(out, localObj, baseObj, remoteObj) {
    const keys = new Set([
      ...Object.keys(localObj || {}),
      ...Object.keys(baseObj || {}),
      ...Object.keys(remoteObj || {})
    ]);
    keys.forEach(k => {
      const lv = localObj ? localObj[k] : undefined;
      const bv = baseObj ? baseObj[k] : undefined;
      const rv = remoteObj ? remoteObj[k] : undefined;
      const localChanged = !sameJson(lv, bv);
      const remoteChanged = !sameJson(rv, bv);
      if (!localChanged) return;
      if (!remoteChanged || sameJson(lv, rv)) {
        out[k] = cloneState(lv);
      } else if (Array.isArray(lv) && Array.isArray(bv) && Array.isArray(rv)) {
        out[k] = mergeArrayById(lv, bv, rv, k);
      }
    });
  }

  function mergeArrayById(localArr, baseArr, remoteArr, key) {
    const allHaveIds = arr => arr.every(x => !x || typeof x !== 'object' || x.id);
    if (!allHaveIds(localArr) || !allHaveIds(baseArr) || !allHaveIds(remoteArr)) {
      return sameJson(remoteArr, baseArr) ? cloneState(localArr) : cloneState(remoteArr);
    }
    const baseById = new Map(baseArr.filter(x => x && x.id).map(x => [x.id, x]));
    const localById = new Map(localArr.filter(x => x && x.id).map(x => [x.id, x]));
    const remoteById = new Map(remoteArr.filter(x => x && x.id).map(x => [x.id, x]));
    const out = remoteArr.map(x => cloneState(x));
    const outIndex = new Map(out.filter(x => x && x.id).map((x, i) => [x.id, i]));

    for (const [id, localItem] of localById.entries()) {
      const baseItem = baseById.get(id);
      const remoteItem = remoteById.get(id);
      if (!baseItem) {
        if (!remoteItem) {
          out.push(cloneState(localItem));
          outIndex.set(id, out.length - 1);
        }
        continue;
      }
      if (sameJson(localItem, baseItem)) continue;
      if (!remoteItem || sameJson(remoteItem, baseItem) || sameJson(remoteItem, localItem)) {
        const idx = outIndex.get(id);
        if (idx == null) {
          out.push(cloneState(localItem));
          outIndex.set(id, out.length - 1);
        } else {
          out[idx] = cloneState(localItem);
        }
      } else {
        console.warn(`[CloudSync] merge conflict in ${key}/${id}: kept remote item`);
      }
    }

    for (const [id, baseItem] of baseById.entries()) {
      if (localById.has(id)) continue;
      const remoteItem = remoteById.get(id);
      if (remoteItem && sameJson(remoteItem, baseItem)) {
        const idx = outIndex.get(id);
        if (idx != null) {
          out.splice(idx, 1);
          outIndex.clear();
          out.forEach((x, i) => { if (x && x.id) outIndex.set(x.id, i); });
        }
      }
    }
    return out;
  }

  function mergePendingWithRemote(localState, baseState, remoteData) {
    if (!localState || !baseState || !remoteData) return null;
    const merged = cloneState(remoteData);
    const keys = new Set([
      ...Object.keys(localState || {}),
      ...Object.keys(baseState || {}),
      ...Object.keys(remoteData || {})
    ]);
    keys.forEach(k => {
      const localVal = localState[k];
      const baseVal = baseState[k];
      const remoteVal = remoteData[k];
      const localChanged = !sameJson(localVal, baseVal);
      const remoteChanged = !sameJson(remoteVal, baseVal);
      if (!localChanged) return;

      if (Array.isArray(localVal) && Array.isArray(baseVal) && Array.isArray(remoteVal)) {
        merged[k] = mergeArrayById(localVal, baseVal, remoteVal, k);
        return;
      }
      if (
        localVal && baseVal && remoteVal &&
        typeof localVal === 'object' && typeof baseVal === 'object' && typeof remoteVal === 'object' &&
        !Array.isArray(localVal) && !Array.isArray(baseVal) && !Array.isArray(remoteVal)
      ) {
        mergeObjectPatch(merged[k] || (merged[k] = {}), localVal, baseVal, remoteVal);
        return;
      }
      if (!remoteChanged || sameJson(localVal, remoteVal)) {
        merged[k] = cloneState(localVal);
      } else {
        console.warn(`[CloudSync] merge conflict in ${k}: kept remote value`);
      }
    });
    return merged;
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
      if (lastPushedAt && tsMs(lastPushedAt) > tsMs(remote.updated_at)) {
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
  let pendingBase = null;          // снимок сервера, от которого сделан pendingState
  let pendingBaseUpdatedAt = null;
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

  /* ---- Anti-race с ботом AKIRA ----
     Бот (AKIRA) дописывает в облако расходы/доходы через свой бэкенд
     (source='bot', id='m...'/'tg...'). Наш фронт пушит ВЕСЬ state одним блобом и
     может затереть свежие записи бота, если в нашей локальной копии их ещё
     нет. Поэтому ПЕРЕД каждым push подмешиваем из свежего облака записи бота
     (по этим ключам), которых у нас локально нет — union по id.
     Это сохраняет добавления бота, не воскрешая удалённые юзером записи
     (берём только bot-origin и только отсутствующие локально id). */
  const BOT_MERGE_KEYS = ['expenses', 'income'];
  function isBotOriginRecord(r) {
    const id = String((r && r.id) || '');
    if (!r || !r.id) return false;
    // Распределённые оплаты создаёт CRM. Их uid иногда случайно выглядит как
    // bot-id `m` + 12 hex, поэтому проверка только по id воскрешала удалённые
    // клиентские платежи из старого серверного снимка.
    if (r.source === 'client_order' || (Array.isArray(r.items) && r.items.length)) return false;
    return r.source === 'bot'
      || /^tg[0-9a-f]{14}$/i.test(id)
      || (!r.source && /^m[0-9a-f]{12}$/i.test(id));
  }
  function mergeBotAdditions(localState, remoteData) {
    if (!localState || !remoteData || typeof remoteData !== 'object') return localState;
    let injected = 0;
    const out = localState;
    for (const k of BOT_MERGE_KEYS) {
      const rem = Array.isArray(remoteData[k]) ? remoteData[k] : [];
      if (!rem.length) continue;
      const loc = Array.isArray(out[k]) ? out[k] : [];
      const localIds = new Set(loc.map(x => x && x.id).filter(Boolean));
      const missing = rem.filter(r => isBotOriginRecord(r) && !localIds.has(r.id));
      if (missing.length) {
        out[k] = loc.concat(missing);
        injected += missing.length;
      }
    }
    if (injected) {
      console.warn(`[CloudSync] anti-race: подмешано ${injected} запис(ей) бота перед push`);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(out)); } catch (_) {}
    }
    return out;
  }

  // Сохраняем pendingState в localStorage, чтобы при перезагрузке страницы
  // (или краше браузера) изменения не пропали. На старте recoverPending()
  // вытащит и повторит push.
  function persistPending(state) {
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify({
        state,
        base: pendingBase,
        baseUpdatedAt: pendingBaseUpdatedAt,
        queued_at: new Date().toISOString()
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
  function quarantinePersistedPending(saved, reason) {
    try {
      localStorage.setItem(PENDING_QUARANTINE_KEY, JSON.stringify({
        saved,
        reason,
        quarantined_at: new Date().toISOString()
      }));
      localStorage.removeItem(PENDING_KEY);
    } catch (_) {}
  }

  function schedulePush(state) {
    pendingState = state;
    pendingBase = cloneState(remoteSnapshot || {});
    pendingBaseUpdatedAt = serverUpdatedAt || null;
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
      pendingState = state;
      persistPending(state);
      setStatus('error', 'Push отклонён (защита)');
      return;
    }
    // SAFETY-CHECK 2: проверка конкурентности.
    // Перед push сверяемся с сервером — если updated_at там новее того, что
    // мы видели последний pull’ом, значит другая вкладка/устройство уже
    // записали свежую версию. В таком случае не затираем чужое, а мержим
    // pending относительно последней известной базы и повторяем guarded push.
    let _remote = null;
    try {
      _remote = await fetchRemote();
    } catch (e) {
      // Если сеть упала — лучше попробовать push, чем потерять данные.
      console.warn('[CloudSync] concurrency check failed, proceeding with push', e);
    }
    if (_remote && _remote.data) {
      // ANTI-RACE с ботом: ВСЕГДА подмешиваем свежие записи бота (expenses/income,
      // source=bot), которых нет в нашей копии — иначе полный push их затрёт.
      mergeBotAdditions(state, _remote.data);
      // Если сервер новее по ДРУГИМ данным (другая вкладка/устройство) — не затираем
      // чужое: мержим pending с remote. Записи бота уже либо в state, либо в remote.
      // Сравниваем ПО EPOCH (tsMs), не строкой. Конфликт = сервер новее нашей
      // базовой версии, ИЛИ мы вообще не знаем свою версию (serverUpdatedAt пуст),
      // а на сервере есть данные. В обоих случаях НЕ затираем — подтягиваем серверное.
      const _remoteMs = tsMs(_remote.updated_at);
      const _seenMs   = tsMs(serverUpdatedAt);
      if (remoteHasData(_remote.data) && (_remoteMs > _seenMs || !_seenMs)) {
        console.warn('[CloudSync] CONFLICT: server newer/unknown base, merging pending with remote.', {
          seen: serverUpdatedAt, server: _remote.updated_at, seenMs: _seenMs, remoteMs: _remoteMs
        });
        const merged = mergePendingWithRemote(state, pendingBase, _remote.data);
        remoteSnapshot  = _remote.data;
        serverUpdatedAt = _remote.updated_at;
        setMeta({ lastPulledAt: _remote.updated_at });
        if (!merged) {
          quarantinePersistedPending({
            state,
            base: pendingBase,
            baseUpdatedAt: pendingBaseUpdatedAt,
            queued_at: new Date().toISOString()
          }, 'conflict_without_base');
          clearPersistedPending();
          localStorage.setItem(STORAGE_KEY, JSON.stringify(_remote.data));
          window.dispatchEvent(new CustomEvent('cloudstate:updated', { detail: _remote.data }));
          setStatus('error', 'Конфликт: черновик сохранён отдельно');
          return;
        }
        pendingState = merged;
        pendingBase = cloneState(_remote.data);
        pendingBaseUpdatedAt = _remote.updated_at;
        persistPending(merged);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
        window.dispatchEvent(new CustomEvent('cloudstate:updated', { detail: merged }));
        setStatus('syncing', 'Слияние изменений…');
        clearTimeout(pushTimer);
        pushTimer = setTimeout(flush, 600);
        return;
      }
    }
    try {
      await pushRemote(state);
      retryAttempt = 0;                  // успех — сбрасываем счётчик retry
      pendingBase = null;
      pendingBaseUpdatedAt = null;
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
      persistPending(state);
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

  /* ---- Закрытие/сворачивание вкладки ----
     Раньше здесь уходил keepalive push всего JSON-блоба без concurrency-check.
     Это спасало последние клики, но могло затереть чужой свежий state. Теперь
     только гарантируем локальный pending; обычный flush/recovery сделает merge. */
  function flushOnHide() {
    if (!pendingState || !pullCompleted) return;
    const state = pendingState;
    if (isEffectivelyEmpty(state) && remoteHasData(remoteSnapshot)) return;
    mergeBotAdditions(state, remoteSnapshot);
    persistPending(state);
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
     pendingState мы успели сохранить в localStorage вместе с merge-base —
     поднимем его и поставим в очередь. Старые pending без базы не replay'им:
     кладём в quarantine, чтобы не откатить свежую работу. */
  function recoverPending() {
    const saved = readPersistedPending();
    if (!saved || !saved.state) return;
    if (!saved.base || !saved.baseUpdatedAt) {
      console.warn('[CloudSync] pending push has no merge base; quarantined instead of replaying stale blob.');
      quarantinePersistedPending(saved, 'missing_merge_base');
      return;
    }
    console.warn('[CloudSync] recovering pending push from', saved.queued_at);
    pendingState = saved.state;
    pendingBase = saved.base;
    pendingBaseUpdatedAt = saved.baseUpdatedAt;
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

  /* store:reloaded — локальное событие страниц/модулей. Не прокидываем его
     обратно в cloudstate:updated, иначе app.js и cloud-sync образуют цикл. */
})();
