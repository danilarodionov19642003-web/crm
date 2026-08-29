/* Review-linked client approval workflow shared by Accounts and Reviews. */
(function () {
  'use strict';

  const SB = window.Supabase;
  if (!SB) return;

  const RPC_TIMEOUT_MS = 12_000;
  const REQUEST_SELECT = 'id,portal_email,mentor_id,anketa_code,anketa_name,title,body,request_status,delivered_to_member_id,delivered_to_telegram_user_id,created_at,updated_at,resolved_at,resolved_by_label,resolution_comment,source_review_id,source_profile_id,source_revision';

  async function rpc(name, body = {}) {
    const controller = new AbortController();
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        const error = new Error('REQUEST_TIMEOUT');
        error.code = 'REQUEST_TIMEOUT';
        reject(error);
      }, RPC_TIMEOUT_MS);
    });
    let response;
    try {
      response = await Promise.race([
        SB.authFetch(`${SB.URL}/rest/v1/rpc/${name}`, {
          method: 'POST',
          headers: {
            apikey: SB.KEY,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify(body),
          signal: controller.signal
        }),
        timeout
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(String(payload.message || payload.details || `HTTP ${response.status}`));
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function portalForMentor(store, mentorId) {
    const portals = store && store.state && store.state.clientPortals || [];
    return portals.find(item => item && item.email
      && Array.isArray(item.mentorIds)
      && item.mentorIds.includes(mentorId)) || null;
  }

  function mentorFor(store, mentorId) {
    return (store && store.state && store.state.mentors || [])
      .find(item => item && item.id === mentorId) || null;
  }

  function reviewAccountLabel(store, review) {
    if (!store || !store.state || !review || !review.profileId) return 'Аккаунт';
    const registration = store.getAccountReg ? store.getAccountReg(review.profileId) : null;
    if (registration && String(registration.ownerName || '').trim()) {
      return String(registration.ownerName).trim();
    }
    const used = new Set();
    (store.state.profileStatuses || [])
      .filter(item => item && item.mentorId === review.mentorId)
      .forEach(item => used.add(item.profileId));
    (store.state.reviews || [])
      .filter(item => item && item.mentorId === review.mentorId)
      .forEach(item => used.add(item.profileId));
    const ordered = [
      ...(store.state.profiles || []),
      ...(store.state.archivedProfiles || [])
    ].filter(item => item && used.has(item.id));
    const index = ordered.findIndex(item => item.id === review.profileId);
    return index >= 0 ? `Аккаунт #${index + 1}` : 'Аккаунт';
  }

  function errorMessage(error) {
    const raw = String(error && error.message || error || '');
    if (raw.includes('PORTAL_NOT_FOUND')) return 'Для анкеты не найден личный кабинет клиента.';
    if (raw.includes('ANKETA_NOT_FOUND')) return 'Анкета ещё не попала в снимок личного кабинета. Обновите данные и повторите.';
    if (raw.includes('TEXT_APPROVAL_ALREADY_PENDING')) return 'По этому отзыву уже ожидается ответ клиента.';
    if (raw.includes('AUTH_REQUIRED')) return 'У этой учётной записи нет права отправлять тексты клиенту.';
    if (raw.includes('REQUEST_TIMEOUT') || raw.includes('AbortError')) return 'CRM сохранена, но отправка клиенту не ответила за 12 секунд. Повторите отправку в разделе «Отзывы».';
    return 'Не удалось отправить текст клиенту. Он сохранён в CRM, отправку можно повторить в разделе «Отзывы».';
  }

  async function sendReview(store, review) {
    if (!store || !review || !review.id || !review.mentorId || !String(review.text || '').trim()) {
      return { ok: false, message: 'Не хватает данных отзыва для отправки.' };
    }
    review.clientApprovalRequired = true;
    review.clientApprovalLastError = '';
    const portal = portalForMentor(store, review.mentorId);
    if (!portal) {
      review.clientApprovalLastError = 'PORTAL_NOT_FOUND';
      store.save();
      return { ok: false, message: 'Для этой анкеты не найден личный кабинет клиента.' };
    }
    const mentor = mentorFor(store, review.mentorId);
    const code = String(mentor && mentor.code || '').trim();
    const account = reviewAccountLabel(store, review);
    const title = ['Текст отзыва', code, account].filter(Boolean).join(' · ');
    try {
      const row = await rpc('create_review_text_approval', {
        p_portal_email: portal.email,
        p_mentor_id: review.mentorId,
        p_source_review_id: review.id,
        p_source_profile_id: review.profileId,
        p_title: title,
        p_body: String(review.text).trim()
      });
      review.clientApprovalRequestId = row && row.id || null;
      review.clientApprovalSentAt = row && row.created_at || new Date().toISOString();
      review.clientApprovalLastError = '';
      store.save();
      return {
        ok: true,
        row,
        telegramDelivered: Boolean(row && row.delivered_to_member_id)
      };
    } catch (error) {
      review.clientApprovalLastError = String(error && error.message || error || 'SEND_FAILED').slice(0, 500);
      store.save();
      console.warn('[ClientTextApprovals] review send failed', error);
      return { ok: false, error, message: errorMessage(error) };
    }
  }

  async function cancelReview(sourceReviewId) {
    if (!sourceReviewId) return { ok: true, count: 0 };
    try {
      const count = await rpc('cancel_review_text_approval', {
        p_source_review_id: sourceReviewId
      });
      return { ok: true, count: Number(count) || 0 };
    } catch (error) {
      console.warn('[ClientTextApprovals] review cancellation failed', error);
      const timedOut = String(error && error.message || error || '').includes('REQUEST_TIMEOUT');
      return {
        ok: false,
        error,
        message: timedOut
          ? 'Сервер не ответил за 12 секунд. Кнопка снова доступна — повторите действие.'
          : 'Не удалось отменить запрос клиента. Повторите действие после восстановления связи.'
      };
    }
  }

  async function loadRequests(limit = 300) {
    const params = new URLSearchParams({
      select: REQUEST_SELECT,
      order: 'created_at.desc',
      limit: String(Math.max(1, Math.min(1000, Number(limit) || 300)))
    });
    const response = await SB.authFetch(`${SB.URL}/rest/v1/client_text_approval_requests?${params}`, {
      headers: { apikey: SB.KEY, Accept: 'application/json' }
    });
    const payload = await response.json().catch(() => []);
    if (!response.ok) throw new Error(String(payload.message || `HTTP ${response.status}`));
    return Array.isArray(payload) ? payload : [];
  }

  async function loadLatestForReview(sourceReviewId) {
    if (!sourceReviewId) return null;
    const params = new URLSearchParams({
      select: REQUEST_SELECT,
      source_review_id: `eq.${sourceReviewId}`,
      order: 'source_revision.desc,id.desc',
      limit: '1'
    });
    const response = await SB.authFetch(`${SB.URL}/rest/v1/client_text_approval_requests?${params}`, {
      headers: { apikey: SB.KEY, Accept: 'application/json' }
    });
    const payload = await response.json().catch(() => []);
    if (!response.ok) throw new Error(String(payload.message || `HTTP ${response.status}`));
    return Array.isArray(payload) ? (payload[0] || null) : null;
  }

  function latestByReview(rows) {
    const result = new Map();
    (rows || []).forEach(row => {
      const key = String(row && row.source_review_id || '');
      if (!key) return;
      const previous = result.get(key);
      const revision = Number(row.source_revision) || 1;
      const previousRevision = Number(previous && previous.source_revision) || 0;
      if (!previous || revision > previousRevision
          || (revision === previousRevision && Number(row.id) > Number(previous.id))) {
        result.set(key, row);
      }
    });
    return result;
  }

  function statusMeta(row) {
    if (!row) return { key: 'missing', label: 'Не отправлен клиенту', cls: 'is-missing' };
    if (row.request_status === 'approved') {
      return { key: 'approved', label: 'Клиент согласовал', cls: 'is-approved' };
    }
    if (row.request_status === 'changes_requested') {
      return { key: 'changes_requested', label: 'Клиент отклонил', cls: 'is-changes' };
    }
    if (row.request_status === 'cancelled') {
      return { key: 'cancelled', label: 'Согласование отменено', cls: 'is-cancelled' };
    }
    if (!row.delivered_to_member_id) {
      return { key: 'portal_only', label: 'В кабинете · Telegram не подключён', cls: 'is-portal-only' };
    }
    return { key: 'pending', label: 'Ждём ответ клиента', cls: 'is-pending' };
  }

  window.ClientTextApprovals = {
    sendReview,
    cancelReview,
    loadRequests,
    loadLatestForReview,
    latestByReview,
    statusMeta,
    errorMessage,
    portalForMentor
  };
})();
