/* Owner workflow for sending review text to the client's Telegram approver. */
(function () {
  'use strict';

  const SB = window.Supabase;
  if (!SB) return;

  let store = null;
  let toast = null;
  let root = null;
  let members = [];
  let requests = [];
  let composeOpen = false;
  let selectedPortal = '';

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  }

  function fmtDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  async function rpc(name, body = {}) {
    const response = await SB.authFetch(`${SB.URL}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: SB.KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(payload.message || payload.details || `HTTP ${response.status}`));
    return payload;
  }

  async function loadRequests() {
    const params = new URLSearchParams({
      select: 'id,portal_email,mentor_id,anketa_code,anketa_name,title,body,request_status,created_at,resolved_at,resolved_by_label,resolution_comment',
      order: 'created_at.desc',
      limit: '40'
    });
    const response = await SB.authFetch(`${SB.URL}/rest/v1/client_text_approval_requests?${params}`, {
      headers: { apikey: SB.KEY, Accept: 'application/json' }
    });
    const payload = await response.json().catch(() => []);
    if (!response.ok) throw new Error(String(payload.message || `HTTP ${response.status}`));
    requests = Array.isArray(payload) ? payload : [];
  }

  async function load() {
    const [memberRows] = await Promise.all([
      rpc('list_client_telegram_members_for_owner', { p_portal_email: null }),
      loadRequests()
    ]);
    members = Array.isArray(memberRows) ? memberRows : [];
  }

  function portals() {
    return (store && store.state && store.state.clientPortals || [])
      .filter(item => item && item.email)
      .slice()
      .sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email), 'ru'));
  }

  function mentorsFor(portalEmail) {
    const portal = portals().find(item => String(item.email).toLowerCase() === String(portalEmail).toLowerCase());
    if (!portal) return [];
    const allowed = new Set(Array.isArray(portal.mentorIds) ? portal.mentorIds : []);
    return (store.state.mentors || [])
      .filter(item => allowed.has(item.id))
      .slice()
      .sort((a, b) => String(a.code || '').localeCompare(String(b.code || ''), 'ru', { numeric: true }));
  }

  function approverFor(portalEmail) {
    return members.find(item =>
      String(item.portal_email).toLowerCase() === String(portalEmail).toLowerCase()
      && item.is_text_approver
    ) || null;
  }

  function portalLabel(portalEmail) {
    const portal = portals().find(item => String(item.email).toLowerCase() === String(portalEmail).toLowerCase());
    return portal ? (portal.name || portal.email) : portalEmail;
  }

  function statusMeta(status) {
    if (status === 'approved') return { label: 'Согласован', cls: 'is-approved' };
    if (status === 'changes_requested') return { label: 'Нужны правки', cls: 'is-changes' };
    if (status === 'cancelled') return { label: 'Отменён', cls: 'is-cancelled' };
    return { label: 'Ждём ответ', cls: 'is-pending' };
  }

  function requestHtml(item) {
    const status = statusMeta(item.request_status);
    const resolved = item.resolved_by_label
      ? `<span>Ответил: ${esc(item.resolved_by_label)}</span>`
      : '';
    const comment = item.resolution_comment
      ? `<div class="rv-approval-item__comment">${esc(item.resolution_comment)}</div>`
      : '';
    const cancel = item.request_status === 'pending'
      ? `<button type="button" class="btn btn--ghost btn--sm" data-text-approval-cancel="${Number(item.id)}">Отменить</button>`
      : '';
    return `
      <article class="rv-approval-item">
        <div class="rv-approval-item__head">
          <div>
            <strong>${esc(item.title || 'Текст отзыва')}</strong>
            <span>${esc(portalLabel(item.portal_email))}${item.anketa_code ? ` · ${esc(item.anketa_code)}` : ''}</span>
          </div>
          <span class="rv-approval-status ${status.cls}">${status.label}</span>
        </div>
        <details>
          <summary>Показать текст</summary>
          <div class="rv-approval-item__body">${esc(item.body || '')}</div>
        </details>
        ${comment}
        <div class="rv-approval-item__foot">
          <span>${fmtDate(item.created_at)}</span>
          ${resolved}
          ${cancel}
        </div>
      </article>`;
  }

  function composeHtml() {
    if (!composeOpen) return '';
    const portalRows = portals();
    if (!selectedPortal && portalRows.length) selectedPortal = portalRows[0].email;
    const mentorRows = mentorsFor(selectedPortal);
    const approver = approverFor(selectedPortal);
    const approverText = approver
      ? `Согласует: ${esc(approver.contact_label || 'контакт')}${approver.telegram_username ? ` · @${esc(approver.telegram_username)}` : ''}`
      : 'В этом кабинете ещё не отмечен контакт, который согласовывает тексты.';
    return `
      <form class="rv-approval-compose" data-text-approval-form>
        <div class="rv-approval-compose__grid">
          <label>
            <span>Кабинет клиента</span>
            <select class="select" data-text-approval-portal required>
              ${portalRows.map(portal => `<option value="${esc(portal.email)}" ${String(portal.email).toLowerCase() === String(selectedPortal).toLowerCase() ? 'selected' : ''}>${esc(portal.name || portal.email)}</option>`).join('')}
            </select>
          </label>
          <label>
            <span>Анкета</span>
            <select class="select" data-text-approval-mentor required>
              ${mentorRows.map(mentor => `<option value="${esc(mentor.id)}">${esc(mentor.code || '—')} · ${esc(mentor.name || '')}</option>`).join('')}
            </select>
          </label>
        </div>
        <label class="rv-approval-compose__field">
          <span>Название</span>
          <input class="input" data-text-approval-title maxlength="200" value="Текст отзыва" required/>
        </label>
        <label class="rv-approval-compose__field">
          <span>Текст на согласование</span>
          <textarea class="input" data-text-approval-body maxlength="3000" rows="7" required></textarea>
        </label>
        <div class="rv-approval-compose__approver ${approver ? 'is-ready' : 'is-missing'}" data-text-approval-approver>${approverText}</div>
        <div class="rv-approval-compose__actions">
          <button type="submit" class="btn btn--primary" data-text-approval-submit ${approver && mentorRows.length ? '' : 'disabled'}>Отправить на согласование</button>
          <button type="button" class="btn btn--ghost" data-text-approval-close>Закрыть</button>
          <span data-text-approval-result></span>
        </div>
      </form>`;
  }

  function render() {
    if (!root) return;
    const pending = requests.filter(item => item.request_status === 'pending').length;
    root.hidden = false;
    root.innerHTML = `
      <div class="rv-approval-head">
        <div>
          <h2>Согласование текстов</h2>
          <p>Отправка идёт только контакту с пометкой «Согласовывает тексты».</p>
        </div>
        <button type="button" class="btn btn--primary btn--sm" data-text-approval-open>${composeOpen ? 'Скрыть форму' : 'Отправить текст'}</button>
      </div>
      ${pending ? `<div class="rv-approval-pending">Ожидают ответа: ${pending}</div>` : ''}
      ${composeHtml()}
      <div class="rv-approval-list">
        ${requests.length ? requests.slice(0, 12).map(requestHtml).join('') : '<div class="rv-approval-empty">Запросов на согласование пока нет.</div>'}
      </div>`;
    bind();
  }

  function bind() {
    root.querySelector('[data-text-approval-open]').addEventListener('click', () => {
      composeOpen = !composeOpen;
      render();
    });

    const form = root.querySelector('[data-text-approval-form]');
    if (form) {
      form.querySelector('[data-text-approval-close]').addEventListener('click', () => {
        composeOpen = false;
        render();
      });
      form.querySelector('[data-text-approval-portal]').addEventListener('change', event => {
        selectedPortal = event.target.value;
        render();
      });
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const button = form.querySelector('[data-text-approval-submit]');
        const result = form.querySelector('[data-text-approval-result]');
        button.disabled = true;
        result.textContent = 'Отправляем…';
        try {
          await rpc('create_client_text_approval', {
            p_portal_email: form.querySelector('[data-text-approval-portal]').value,
            p_mentor_id: form.querySelector('[data-text-approval-mentor]').value,
            p_title: form.querySelector('[data-text-approval-title]').value.trim(),
            p_body: form.querySelector('[data-text-approval-body]').value.trim()
          });
          composeOpen = false;
          await loadRequests();
          render();
          if (toast) toast('Текст отправлен клиенту в Telegram');
        } catch (error) {
          const raw = String(error && error.message || error || '');
          result.textContent = raw.includes('TEXT_APPROVER_NOT_LINKED')
            ? 'У клиента не назначен контакт для согласования текстов.'
            : 'Не удалось отправить. Проверьте связь и попробуйте ещё раз.';
          button.disabled = false;
        }
      });
    }

    root.querySelectorAll('[data-text-approval-cancel]').forEach(button => {
      button.addEventListener('click', async () => {
        if (!confirm('Отменить этот запрос на согласование?')) return;
        button.disabled = true;
        try {
          await rpc('cancel_client_text_approval', {
            p_request_id: Number(button.dataset.textApprovalCancel)
          });
          await loadRequests();
          render();
        } catch (_) {
          button.disabled = false;
          if (toast) toast('Запрос уже обработан или связь недоступна', 'error');
        }
      });
    });
  }

  async function init(options) {
    store = options && options.Store;
    toast = options && options.toast;
    root = document.getElementById('textApprovalsRoot');
    if (!root || !store) return;
    root.hidden = false;
    root.innerHTML = '<div class="rv-approval-empty">Загружаем согласования…</div>';
    try {
      await load();
      render();
    } catch (error) {
      console.warn('[ClientTextApprovals] load failed', error);
      root.innerHTML = '<div class="rv-approval-empty is-error">Не удалось загрузить согласования.</div>';
    }
  }

  window.ClientTextApprovals = { init, refresh: async () => { await load(); render(); } };
})();
