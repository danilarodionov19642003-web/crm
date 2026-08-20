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
  const CONFLICT_LOG_KEY = 'mentori-crm-sync-conflicts';
  const CONFLICT_BACKUP_KEY = 'mentori-crm-sync-conflict-backup';
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

  async function _fetch(url, opts = {}) {
    const sb = _SB();
    const headers = { ..._hdr(), ...(opts.headers || {}) };
    const request = { ...opts, headers };
    if (typeof sb.authFetch === 'function') return sb.authFetch(url, request);
    if (sb.Auth && typeof sb.Auth.ensureFresh === 'function') await sb.Auth.ensureFresh();
    return fetch(url, { ...opts, headers: { ..._hdr(), ...(opts.headers || {}) } });
  }

  /* ---- Сетевые операции ---- */
  async function fetchRemote() {
    const url = `${_supaUrl()}/rest/v1/${TABLE}?id=eq.${ROW_ID}&select=data,updated_at`;
    const res = await _fetch(url);
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
    const res = await _fetch(url, {
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
      if (!rows || rows.length === 0) {
        const error = new Error('push conflict: crm_state changed during write');
        error.code = 'CRM_STATE_CONFLICT';
        throw error;
      }
    }
    setMeta({ lastPushedAt: updated_at });
    serverUpdatedAt = updated_at;             // мы только что записали — это новая «правда»
    // Снимок обязан быть отдельным объектом. Store.state продолжает мутировать
    // после сохранения; общая ссылка превращала эти будущие правки в часть
    // merge-base, из-за чего они могли ошибочно считаться «неизменёнными».
    remoteSnapshot  = cloneState(state);
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
  async function pushHistory(state, { force = false } = {}) {
    const now = Date.now();
    if (!force && now - lastHistoryAt < HISTORY_THROTTLE_MS) return true;
    lastHistoryAt = now;
    const row = {
      state_id: ROW_ID,
      data: state,
      pushed_at: new Date().toISOString(),
      client_info: (navigator.userAgent || '').slice(0, 200)
    };
    const url = `${_supaUrl()}/rest/v1/${HISTORY_TABLE}`;
    const res = await _fetch(url, {
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
      return false;
    }
    return true;
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
    const res = await _fetch(url, {
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
      const existingRes = await _fetch(
        `${_supaUrl()}/rest/v1/${SNAPSHOTS_TABLE}?select=email`,
        { headers: _hdr() }
      );
      if (existingRes.ok) {
        const existing = await existingRes.json();
        const allowed = new Set(snapshots.map(s => s.email));
        const stale = existing.map(r => r.email).filter(e => !allowed.has(e));
        for (const email of stale) {
          const enc = encodeURIComponent(email);
          await _fetch(
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

  const MERGE_MISSING = Symbol('merge-missing');

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function sameMergeValue(a, b) {
    if (a === MERGE_MISSING || b === MERGE_MISSING) return a === b;
    return sameJson(a, b);
  }

  function cloneMergeValue(value) {
    return value === MERGE_MISSING ? MERGE_MISSING : cloneState(value);
  }

  function conflictValue(value) {
    if (value === MERGE_MISSING) return { missing: true };
    const cloned = cloneState(value);
    try {
      const raw = JSON.stringify(cloned);
      if (raw && raw.length > 4000) {
        return { truncated: true, bytes: raw.length, preview: raw.slice(0, 4000) };
      }
    } catch (_) {}
    return cloned;
  }

  function addMergeConflict(conflicts, path, kind, baseValue, localValue, remoteValue, resolution) {
    conflicts.push({
      path: path || '$',
      kind,
      resolution,
      base: conflictValue(baseValue),
      local: conflictValue(localValue),
      remote: conflictValue(remoteValue)
    });
  }

  function arrayItemIdentity(item, path) {
    if (!isPlainObject(item)) return null;
    if (item.id != null && item.id !== '') {
      const value = String(item.id);
      return { key: `id:${value}`, label: `id=${value}` };
    }
    if (path.endsWith('.schedule') && item.date) {
      const value = String(item.date);
      return { key: `date:${value}`, label: `date=${value}` };
    }
    if (path.endsWith('.items') && item.accountId) {
      const value = String(item.accountId);
      return { key: `accountId:${value}`, label: `accountId=${value}` };
    }
    return null;
  }

  function keyedArray(arr, path) {
    if (!Array.isArray(arr)) return null;
    const byKey = new Map();
    const labels = new Map();
    const order = [];
    for (const item of arr) {
      const identity = arrayItemIdentity(item, path);
      if (!identity || byKey.has(identity.key)) return null;
      byKey.set(identity.key, item);
      labels.set(identity.key, identity.label);
      order.push(identity.key);
    }
    return { byKey, labels, order };
  }

  function isPrefixArray(prefix, value) {
    if (!Array.isArray(prefix) || !Array.isArray(value) || prefix.length > value.length) return false;
    for (let i = 0; i < prefix.length; i++) {
      if (!sameJson(prefix[i], value[i])) return false;
    }
    return true;
  }

  function mergeAppendOnlyArray(localArr, baseArr, remoteArr) {
    if (!isPrefixArray(baseArr, localArr) || !isPrefixArray(baseArr, remoteArr)) return null;
    const out = remoteArr.map(cloneState);
    for (const item of localArr.slice(baseArr.length)) {
      if (!out.some(existing => sameJson(existing, item))) out.push(cloneState(item));
    }
    return out;
  }

  function mergePrimitiveSetArray(localArr, baseArr, remoteArr) {
    const primitive = value => value == null || ['string', 'number', 'boolean'].includes(typeof value);
    if (![localArr, baseArr, remoteArr].every(arr => arr.every(primitive))) return null;
    const key = value => `${typeof value}:${String(value)}`;
    const unique = arr => new Set(arr.map(key)).size === arr.length;
    if (![localArr, baseArr, remoteArr].every(unique)) return null;

    const baseSet = new Set(baseArr.map(key));
    const localSet = new Set(localArr.map(key));
    const remoteSet = new Set(remoteArr.map(key));
    const values = new Map();
    [...remoteArr, ...localArr, ...baseArr].forEach(value => values.set(key(value), value));
    const order = [...remoteArr.map(key), ...localArr.map(key).filter(k => !remoteSet.has(k))];
    return order.filter(k => {
      const baseHas = baseSet.has(k);
      const localHas = localSet.has(k);
      const remoteHas = remoteSet.has(k);
      const localChanged = localHas !== baseHas;
      const remoteChanged = remoteHas !== baseHas;
      if (!localChanged) return remoteHas;
      if (!remoteChanged || localHas === remoteHas) return localHas;
      return localHas;
    }).map(k => cloneState(values.get(k)));
  }

  function mergeArrayById(localArr, baseArr, remoteArr, path, conflicts, keyed = null) {
    const localKeyed = keyed && keyed.local ? keyed.local : keyedArray(localArr, path);
    const baseKeyed = keyed && keyed.base ? keyed.base : keyedArray(baseArr, path);
    const remoteKeyed = keyed && keyed.remote ? keyed.remote : keyedArray(remoteArr, path);
    if (!localKeyed || !baseKeyed || !remoteKeyed) return null;
    const order = remoteKeyed.order.slice();
    localKeyed.order.forEach(key => { if (!order.includes(key)) order.push(key); });

    const out = [];
    for (const key of order) {
      const localValue = localKeyed.byKey.has(key) ? localKeyed.byKey.get(key) : MERGE_MISSING;
      const baseValue = baseKeyed.byKey.has(key) ? baseKeyed.byKey.get(key) : MERGE_MISSING;
      const remoteValue = remoteKeyed.byKey.has(key) ? remoteKeyed.byKey.get(key) : MERGE_MISSING;
      const label = localKeyed.labels.get(key) || remoteKeyed.labels.get(key) || baseKeyed.labels.get(key) || key;
      const itemPath = `${path || '$'}[${label}]`;
      const merged = mergeValue(localValue, baseValue, remoteValue, itemPath, conflicts);
      if (merged !== MERGE_MISSING) out.push(merged);
    }
    return out;
  }

  function mergeObjectValues(localObj, baseObj, remoteObj, path, conflicts) {
    const out = {};
    const keys = new Set([
      ...Object.keys(localObj || {}),
      ...Object.keys(baseObj || {}),
      ...Object.keys(remoteObj || {})
    ]);
    keys.forEach(key => {
      const localValue = Object.prototype.hasOwnProperty.call(localObj, key) ? localObj[key] : MERGE_MISSING;
      const baseValue = Object.prototype.hasOwnProperty.call(baseObj, key) ? baseObj[key] : MERGE_MISSING;
      const remoteValue = Object.prototype.hasOwnProperty.call(remoteObj, key) ? remoteObj[key] : MERGE_MISSING;
      const childPath = path ? `${path}.${key}` : key;
      const merged = mergeValue(localValue, baseValue, remoteValue, childPath, conflicts);
      if (merged !== MERGE_MISSING) out[key] = merged;
    });
    return out;
  }

  function mergeValue(localValue, baseValue, remoteValue, path, conflicts) {
    const localChanged = !sameMergeValue(localValue, baseValue);
    const remoteChanged = !sameMergeValue(remoteValue, baseValue);
    if (!localChanged) return cloneMergeValue(remoteValue);
    if (!remoteChanged || sameMergeValue(localValue, remoteValue)) return cloneMergeValue(localValue);

    if (
      Array.isArray(localValue) && Array.isArray(baseValue) && Array.isArray(remoteValue)
    ) {
      const keyed = {
        local: keyedArray(localValue, path),
        base: keyedArray(baseValue, path),
        remote: keyedArray(remoteValue, path)
      };
      if (keyed.local && keyed.base && keyed.remote) {
        return mergeArrayById(localValue, baseValue, remoteValue, path, conflicts, keyed);
      }
      const appended = mergeAppendOnlyArray(localValue, baseValue, remoteValue);
      if (appended) return appended;
      const primitiveSet = mergePrimitiveSetArray(localValue, baseValue, remoteValue);
      if (primitiveSet) return primitiveSet;
      addMergeConflict(conflicts, path, 'array', baseValue, localValue, remoteValue, 'local');
      return cloneState(localValue);
    }

    if (isPlainObject(localValue) && isPlainObject(baseValue) && isPlainObject(remoteValue)) {
      return mergeObjectValues(localValue, baseValue, remoteValue, path, conflicts);
    }

    // Удаление против параллельного редактирования не должно уничтожать запись.
    if (localValue === MERGE_MISSING && remoteValue !== MERGE_MISSING) {
      addMergeConflict(conflicts, path, 'delete-vs-edit', baseValue, localValue, remoteValue, 'remote');
      return cloneMergeValue(remoteValue);
    }
    if (remoteValue === MERGE_MISSING && localValue !== MERGE_MISSING) {
      addMergeConflict(conflicts, path, 'edit-vs-delete', baseValue, localValue, remoteValue, 'local');
      return cloneMergeValue(localValue);
    }

    // Для одного скалярного поля физически возможен только один итог. Здесь
    // выигрывает действие, которое сейчас сохраняется; прежний серверный
    // вариант архивируется отдельно перед guarded push.
    addMergeConflict(conflicts, path, 'same-field', baseValue, localValue, remoteValue, 'local');
    return cloneMergeValue(localValue);
  }

  function mergePendingWithRemote(localState, baseState, remoteData, conflicts = []) {
    if (!localState || !baseState || !remoteData) return null;
    return mergeObjectValues(localState, baseState, remoteData, '', conflicts);
  }

  function applySyncedState(state) {
    const raw = JSON.stringify(state);
    if (localStorage.getItem(STORAGE_KEY) === raw) return false;
    localStorage.setItem(STORAGE_KEY, raw);
    window.dispatchEvent(new CustomEvent('cloudstate:updated', { detail: state }));
    return true;
  }

  function persistMergeConflicts(remoteData, conflicts, meta = {}) {
    if (!conflicts.length) return;
    const at = new Date().toISOString();
    try {
      localStorage.setItem(CONFLICT_BACKUP_KEY, JSON.stringify({
        capturedAt: at,
        meta,
        remoteState: remoteData
      }));
    } catch (e) {
      console.warn('[CloudSync] conflict backup did not fit localStorage', e);
    }
    try {
      const previous = JSON.parse(localStorage.getItem(CONFLICT_LOG_KEY) || '[]');
      const log = Array.isArray(previous) ? previous : [];
      log.push({ at, meta, conflicts });
      localStorage.setItem(CONFLICT_LOG_KEY, JSON.stringify(log.slice(-20)));
    } catch (e) {
      console.warn('[CloudSync] conflict log write failed', e);
    }
    try {
      window.dispatchEvent(new CustomEvent('cloudsync:conflict', {
        detail: { at, conflicts, meta }
      }));
    } catch (_) {}
    try {
      if (window.App && typeof window.App.toast === 'function') {
        window.App.toast(
          'Параллельные правки объединены. Последнее изменение совпавшего поля применено, предыдущая версия сохранена.',
          'error'
        );
      }
    } catch (_) {}
    // Полный серверный снимок до разрешения конфликта сохраняем в истории
    // без обычного пятиминутного throttle. Локальная копия уже создана выше,
    // поэтому недоступность history не блокирует основное сохранение.
    pushHistory(remoteData, { force: true }).catch(e => {
      console.warn('[CloudSync] forced conflict history failed', e);
    });
  }

  /* ---- Pull: вытянуть удалённый state и заместить локальный ---- */
  async function pull({ silent = false } = {}) {
    // Pull не должен менять merge-base посреди активного guarded push.
    if (flushPromise) await flushPromise;
    if (!silent) setStatus('syncing', 'Загрузка…');
    try {
      const remote = await fetchRemote();
      if (!remote || !remote.data || Object.keys(remote.data).length === 0) {
        // удалённого state ещё нет — отправим текущий локальный
        remoteSnapshot = {};
        serverUpdatedAt = null;
        pullCompleted = true;
        if (pendingState) {
          clearTimeout(pushTimer);
          pushTimer = setTimeout(flush, 50);
          setStatus('syncing', 'Сохранение…');
        } else {
          const local = readLocal();
          if (local) await pushRemote(cloneState(local), null);
          setStatus('synced', 'Синхронизировано');
        }
        return { changed: false };
      }
      remoteSnapshot   = cloneState(remote.data);
      serverUpdatedAt  = remote.updated_at;   // фиксируем «версию» сервера
      pullCompleted = true;
      setMeta({ lastPulledAt: remote.updated_at });

      // Несохранённую локальную работу нельзя заменять pull-снимком. Сразу
      // перебазируем pending на свежий сервер и только затем обновляем UI.
      if (pendingState) {
        if (!pendingBase) {
          quarantinePersistedPending({
            state: pendingState,
            base: pendingBase,
            baseUpdatedAt: pendingBaseUpdatedAt,
            queued_at: new Date().toISOString()
          }, 'pull_without_merge_base');
          pendingState = null;
          pendingBase = null;
          pendingBaseUpdatedAt = null;
          applySyncedState(remote.data);
          setStatus('error', 'Черновик сохранён отдельно');
          return { changed: true, data: remote.data };
        }
        const conflicts = [];
        const mergeBaseUpdatedAt = pendingBaseUpdatedAt;
        const merged = mergePendingWithRemote(pendingState, pendingBase, remote.data, conflicts);
        pendingState = merged;
        pendingBase = cloneState(remote.data);
        pendingBaseUpdatedAt = remote.updated_at;
        pendingRevision++;
        persistPending(merged);
        if (conflicts.length) {
          persistMergeConflicts(remote.data, conflicts, {
            phase: 'pull',
            baseUpdatedAt: mergeBaseUpdatedAt,
            remoteUpdatedAt: remote.updated_at
          });
        }
        const changed = applySyncedState(merged);
        clearTimeout(pushTimer);
        pushTimer = setTimeout(flush, 50);
        setStatus('syncing', conflicts.length ? 'Объединение изменений…' : 'Сохранение…');
        return { changed, data: merged, merged: true };
      }

      // Принимаем облачный state
      const changed = applySyncedState(remote.data);
      setStatus('synced', changed ? 'Обновлено из облака' : 'Синхронизировано');
      return { changed, data: remote.data };
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
  let pendingRevision = 0;         // меняется при каждом новом локальном снимке/rebase
  let flushPromise = null;         // сериализует push и pull внутри одной вкладки
  let pullCompleted = false;         // true после первого успешного fetchRemote
  const bootMeta = getMeta();
  const bootVersion = tsMs(bootMeta.lastPushedAt) > tsMs(bootMeta.lastPulledAt)
    ? bootMeta.lastPushedAt
    : bootMeta.lastPulledAt;
  // До первого pull это последняя подтверждённая локальная копия. Она нужна
  // как merge-base, если пользователь успел нажать Save сразу после загрузки.
  let remoteSnapshot = cloneState(readLocal());
  let serverUpdatedAt = bootVersion || null;
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
    // Замораживаем состояние в момент клика «Сохранить». Сетевые операции
    // асинхронны, а Store.state продолжает мутировать; ссылка здесь недопустима.
    const snapshot = cloneState(state);
    if (!pendingState) {
      pendingBase = cloneState(remoteSnapshot || {});
      pendingBaseUpdatedAt = serverUpdatedAt || null;
    }
    // При нескольких быстрых сохранениях база остаётся исходной, а pending
    // заменяется полным последним локальным снимком. Так все локальные правки
    // входят в один трехсторонний merge.
    pendingState = snapshot;
    pendingRevision++;
    persistPending(snapshot);         // на случай reload/closure
    if (!pullCompleted) {
      // не ставим таймер — flush запустится после первого pull
      setStatus('syncing', 'Ожидание облака…');
      return;
    }
    setStatus('syncing', 'Сохранение…');
    clearTimeout(pushTimer);
    pushTimer = setTimeout(flush, 600);
  }

  function versionsEqual(a, b) {
    if (!a || !b) return !a && !b;
    const versionKey = value => {
      const raw = String(value).trim();
      // Postgres/PostgREST может вернуть шесть микросекунд и `+00:00`, тогда
      // как браузер пишет три миллисекунды и `Z`. Нормализуем UTC-формы, не
      // отбрасывая микросекунды: Date.parse здесь недостаточен.
      const utc = raw.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:Z|[+-]00(?::?00)?)$/i);
      if (utc) return `${utc[1]}.${String(utc[2] || '').padEnd(9, '0').slice(0, 9)}Z`;
      const parsed = tsMs(raw);
      return parsed ? `ms:${parsed}` : `raw:${raw}`;
    };
    return versionKey(a) === versionKey(b);
  }

  async function runFlush() {
    if (!pendingState) return;
    if (!pullCompleted) return; // повторная защита
    const state = cloneState(pendingState);
    const base = cloneState(pendingBase);
    const baseUpdatedAt = pendingBaseUpdatedAt;
    const revision = pendingRevision;
    // SAFETY-CHECK 1: нельзя перезаписывать непустое облако пустым локальным state.
    if (isEffectivelyEmpty(state) && remoteHasData(remoteSnapshot)) {
      console.error('[CloudSync] BLOCKED push of empty state over non-empty remote.', {
        localKeys: Object.keys(state || {}),
        remoteCounts: BIG_COLLECTIONS.reduce((o,k) => (o[k]=(remoteSnapshot[k]||[]).length, o), {})
      });
      persistPending(pendingState);
      setStatus('error', 'Push отклонён (защита)');
      return;
    }

    let remote = null;
    let remoteFetched = false;
    try {
      remote = await fetchRemote();
      remoteFetched = true;
    } catch (e) {
      // При известной версии guarded PATCH всё равно безопасен: если сервер
      // изменился, CAS вернёт пустой ответ и мы повторим merge после retry.
      if (!baseUpdatedAt) {
        console.warn('[CloudSync] safe push postponed: remote version unavailable', e);
        persistPending(pendingState);
        const delay = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)];
        retryAttempt++;
        setStatus('error', `Нет связи, повтор через ${Math.round(delay/1000)}с`);
        clearTimeout(pushTimer);
        pushTimer = setTimeout(flush, delay);
        return;
      }
      console.warn('[CloudSync] preflight failed; guarded push will use pending base', e);
    }

    let candidate = state;
    let expectedUpdatedAt = baseUpdatedAt;
    const conflicts = [];
    if (remote && remote.data) {
      if (!base) {
        quarantinePersistedPending({
          state,
          base,
          baseUpdatedAt,
          queued_at: new Date().toISOString()
        }, 'flush_without_merge_base');
        if (pendingRevision === revision) {
          pendingState = null;
          pendingBase = null;
          pendingBaseUpdatedAt = null;
        }
        applySyncedState(remote.data);
        setStatus('error', 'Черновик сохранён отдельно');
        return;
      }
      if (!versionsEqual(remote.updated_at, baseUpdatedAt)) {
        console.warn('[CloudSync] CONFLICT: server changed since pending base; merging.', {
          base: baseUpdatedAt,
          server: remote.updated_at
        });
        candidate = mergePendingWithRemote(state, base, remote.data, conflicts);
      }
      mergeBotAdditions(candidate, remote.data);
      expectedUpdatedAt = remote.updated_at;
      remoteSnapshot = cloneState(remote.data);
      serverUpdatedAt = remote.updated_at;
      setMeta({ lastPulledAt: remote.updated_at });
    } else if (remoteFetched) {
      // fetchRemote подтвердил отсутствие строки: разрешён только initial upsert.
      expectedUpdatedAt = null;
    }

    const safetyRemote = remote && remote.data ? remote.data : remoteSnapshot;
    if (isEffectivelyEmpty(candidate) && remoteHasData(safetyRemote)) {
      persistPending(pendingState);
      setStatus('error', 'Push отклонён (защита)');
      return;
    }

    if (conflicts.length && remote && remote.data) {
      persistMergeConflicts(remote.data, conflicts, {
        phase: 'push',
        baseUpdatedAt,
        remoteUpdatedAt: remote.updated_at
      });
    }

    try {
      const pushedAt = await pushRemote(candidate, expectedUpdatedAt);
      retryAttempt = 0;                  // успех — сбрасываем счётчик retry

      if (pendingRevision === revision) {
        pendingState = null;
        pendingBase = null;
        pendingBaseUpdatedAt = null;
        clearPersistedPending();
        applySyncedState(candidate);
      } else {
        // Пока запрос был в сети, пользователь успел сохранить ещё раз.
        // Выделяем только новые правки относительно отправленного state и
        // перебазируем их на только что записанный candidate.
        const rebaseConflicts = [];
        const rebased = mergePendingWithRemote(pendingState, state, candidate, rebaseConflicts);
        if (rebaseConflicts.length) {
          persistMergeConflicts(candidate, rebaseConflicts, {
            phase: 'inflight-rebase',
            baseUpdatedAt,
            remoteUpdatedAt: pushedAt
          });
        }
        pendingState = rebased;
        pendingBase = cloneState(candidate);
        pendingBaseUpdatedAt = pushedAt;
        persistPending(rebased);
        applySyncedState(rebased);
        clearTimeout(pushTimer);
        pushTimer = setTimeout(flush, 50);
      }

      setStatus('synced', conflicts.length ? 'Сохранено с объединением' : 'Сохранено');
      // Зеркалим личные снимки клиентов — best effort, не блокирует основной push
      pushClientSnapshots(candidate).catch(e => {
        console.warn('[CloudSync] snapshots mirror failed', e);
      });
    } catch (e) {
      console.warn('[CloudSync] push error, will retry', e);
      // pendingState не обнулялся и содержит либо этот снимок, либо ещё более
      // свежий. Persist не чистим до подтверждённого guarded push.
      persistPending(pendingState);
      const isConflict = e && e.code === 'CRM_STATE_CONFLICT';
      const delay = isConflict
        ? 250
        : RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)];
      if (!isConflict) retryAttempt++;
      setStatus(
        'error',
        isConflict
          ? 'Параллельное сохранение, объединяем…'
          : `Ошибка сохранения, повтор через ${Math.round(delay/1000)}с (попытка ${retryAttempt})`
      );
      clearTimeout(pushTimer);
      pushTimer = setTimeout(flush, delay);
    }
  }

  function flush() {
    if (flushPromise) return flushPromise;
    flushPromise = runFlush().finally(() => { flushPromise = null; });
    return flushPromise;
  }

  function readLocal() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
    catch { return null; }
  }

  let resumePromise = null;
  function resumeSync({ silent = false } = {}) {
    if (!navigator.onLine || document.visibilityState === 'hidden') {
      if (!navigator.onLine) setStatus('offline', 'Оффлайн');
      return Promise.resolve({ changed: false });
    }
    if (resumePromise) return resumePromise;
    if (!silent) setStatus('syncing', 'Восстановление…');
    resumePromise = (async () => {
      const result = await pull({ silent });
      if (!result.error) await flush();
      return result;
    })().finally(() => { resumePromise = null; });
    return resumePromise;
  }

  /* ---- Online/offline events ---- */
  window.addEventListener('online',  () => { resumeSync(); });
  window.addEventListener('offline', () => setStatus('offline','Оффлайн'));

  /* ---- Закрытие/сворачивание вкладки ----
     Раньше здесь уходил keepalive push всего JSON-блоба без concurrency-check.
     Это спасало последние клики, но могло затереть чужой свежий state. Теперь
     только гарантируем локальный pending; обычный flush/recovery сделает merge. */
  function flushOnHide() {
    if (!pendingState || !pullCompleted) return;
    if (isEffectivelyEmpty(pendingState) && remoteHasData(remoteSnapshot)) return;
    persistPending(pendingState);
  }
  window.addEventListener('pagehide', flushOnHide);
  window.addEventListener('beforeunload', flushOnHide);
  // На мобильных Safari pagehide не всегда срабатывает при сворачивании —
  // дополнительно спасаемся при переходе вкладки в hidden.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushOnHide();
    else resumeSync();
  });
  window.addEventListener('pageshow', () => { resumeSync({ silent: pullCompleted }); });

  /* ---- Фоновый pull раз в минуту ----
     Закрывает сценарий «вторая вкладка с устаревшим стейтом перетёрла
     свежие данные»: даже если ты её не трогаешь, она каждую минуту
     подтягивает актуальный state и обновляет serverUpdatedAt.
     Только когда вкладка видима — на скрытой нет смысла греть сеть. */
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (!navigator.onLine) return;
    resumeSync({ silent: true });
  }, POLL_INTERVAL_MS);

  /* ---- Очередь Telegram-уведомлений ----
     Вызывается из app.js при смене статуса. Просто INSERT-нашей строки
     в notification_outbox. Бот на VPS опрашивает таблицу и шлёт сообщения.
     Best effort: ошибки логируем, ничего не блокируем. */
  async function queueTelegramNotification(row) {
    if (!row || !row.message) return false;
    const url = `${_supaUrl()}/rest/v1/${OUTBOX_TABLE}`;
    try {
      const res = await _fetch(url, {
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

  /** Поставить клиентское уведомление через серверную таблицу контактов.
   *  RPC сам размножает одну бизнес-событие по активным Telegram-контактам.
   *  Старый прямой chat_id используется только как переходный fallback, если
   *  новая миграция ещё не применена или RPC временно недоступен. */
  async function queueClientTelegramNotification(row) {
    if (!row || !row.client_email || !row.message) return false;
    try {
      const res = await _fetch(`${_supaUrl()}/rest/v1/rpc/queue_client_telegram_notification`, {
        method: 'POST',
        headers: { ...(_hdr()), 'Prefer': 'return=representation' },
        body: JSON.stringify({
          p_portal_email: row.client_email,
          p_kind: row.kind || 'status_change',
          p_message: row.message,
          p_mentor_id: row.mentor_id || null,
          p_profile_id: row.profile_id || null,
          p_new_status: row.new_status || null,
          p_old_status: row.old_status || null,
          p_created_by: row.created_by || null
        })
      });
      if (res.ok) {
        const queued = Number(await res.json().catch(() => 0));
        if (queued > 0 || !row.telegram_chat_id) return queued > 0;
        console.warn('[CloudSync] no normalized Telegram recipients, using legacy fallback');
      } else {
        console.warn('[CloudSync] client Telegram fan-out failed', res.status,
          await res.text().catch(() => ''));
      }
    } catch (error) {
      console.warn('[CloudSync] client Telegram fan-out error', error);
    }

    if (!row.telegram_chat_id) return false;
    const { created_by: _ignoredCreatedBy, ...legacyRow } = row;
    return queueTelegramNotification(legacyRow);
  }

  /* ---- Закрытие выполненного отклика в каноническом графике ----
     Вызывается при переходе аккаунта из «Запланировано» в рабочий статус.
     Ошибка отдельной таблицы не должна отменять сохранение основного CRM state. */
  async function completeOutreachSlot(mentorId, date) {
    if (!mentorId || !date) return false;
    try {
      const res = await _fetch(`${_supaUrl()}/rest/v1/rpc/staff_complete_outreach_slot`, {
        method: 'POST',
        headers: { ...(_hdr()), 'Prefer': 'return=representation' },
        body: JSON.stringify({ p_mentor_id: mentorId, p_date: date })
      });
      if (!res.ok) {
        console.warn('[CloudSync] outreach completion failed', res.status, await res.text().catch(() => ''));
        return false;
      }
      const completed = await res.json().catch(() => false);
      if (window.OutreachScheduleSync && window.OutreachScheduleSync.refresh) {
        window.OutreachScheduleSync.refresh().catch(() => {});
      }
      return completed === true;
    } catch (error) {
      console.warn('[CloudSync] outreach completion error', error);
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
    queueClientTelegramNotification, // fan-out по подключённым контактам клиента
    completeOutreachSlot,   // закрыть слот, когда аккаунт перешёл в работу
    downloadBackup,         // ручной бэкап на диск (используется кнопкой в шапке)
    getConflictLog: () => {
      try { return JSON.parse(localStorage.getItem(CONFLICT_LOG_KEY) || '[]'); }
      catch (_) { return []; }
    },
    getConflictBackup: () => {
      try { return JSON.parse(localStorage.getItem(CONFLICT_BACKUP_KEY) || 'null'); }
      catch (_) { return null; }
    },
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
    pendingState = cloneState(saved.state);
    pendingBase = cloneState(saved.base);
    pendingBaseUpdatedAt = saved.baseUpdatedAt;
    pendingRevision++;
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
    setTimeout(() => resumeSync(), 50);
  });

  /* store:reloaded — локальное событие страниц/модулей. Не прокидываем его
     обратно в cloudstate:updated, иначе app.js и cloud-sync образуют цикл. */
})();
