/* Client cabinet settings: shared credentials and Telegram contacts. */
(function () {
  'use strict';

  const SB = window.Supabase;
  if (!SB) return;
  const { Auth, authFetch } = SB;
  const root = () => document.querySelector('[data-cli-settings-body]');
  let members = [];
  let pollTimer = null;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  async function rpc(name, body = {}) {
    const res = await authFetch(`${SB.URL}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: SB.KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(body)
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(String(payload.message || payload.details || `HTTP ${res.status}`));
      error.status = res.status;
      throw error;
    }
    return payload;
  }

  function memberName(member) {
    return member.contact_label
      || [member.first_name, member.last_name].filter(Boolean).join(' ')
      || (member.username ? `@${member.username}` : 'Telegram-контакт');
  }

  function errorMessage(error) {
    const raw = String(error && error.message || error || '');
    if (raw.includes('MEMBER_LIMIT_REACHED')) return 'К кабинету уже подключено максимальное число Telegram-контактов.';
    if (raw.includes('CURRENT_PASSWORD_INVALID')) return 'Текущий пароль введён неверно.';
    if (raw.includes('EMAIL_ALREADY_USED')) return 'Этот email уже используется другим кабинетом.';
    if (raw.includes('EMAIL_INVALID')) return 'Проверьте новый email.';
    if (raw.includes('PASSWORD_TOO_SHORT')) return 'Новый пароль должен содержать не менее 8 символов.';
    if (raw.includes('NOTHING_TO_CHANGE')) return 'Укажите новый email или новый пароль.';
    if (raw.includes('MEMBER_NOT_FOUND')) return 'Контакт уже отключён. Обновите страницу.';
    if (raw.includes('TEXT_APPROVER_REQUIRED')) return 'Сначала отметьте другой Telegram, который будет согласовывать тексты.';
    return 'Не удалось сохранить. Проверьте связь и попробуйте ещё раз.';
  }

  async function loadMembers() {
    const result = await rpc('list_my_client_telegram_members');
    members = Array.isArray(result) ? result : [];
    return members;
  }

  function memberHtml(member) {
    const username = member.username ? `@${esc(member.username)}` : 'username не указан';
    const title = esc(memberName(member));
    return `
      <form class="cli-tg-member" data-member-id="${Number(member.id)}">
        <div class="cli-tg-member__top">
          <div>
            <strong>${title}</strong>
            <span>${username}</span>
          </div>
          ${member.is_text_approver ? '<span class="cli-tg-member__badge">Согласовывает тексты</span>' : ''}
        </div>
        <label class="cli-field">
          <span>Контактное лицо (чей Telegram)</span>
          <input type="text" maxlength="100" data-member-label value="${esc(member.contact_label || memberName(member))}"/>
        </label>
        <div class="cli-settings__checks">
          <label><input type="checkbox" data-member-approver ${member.is_text_approver ? 'checked' : ''}/> Согласовывает тексты</label>
          <label><input type="checkbox" data-member-status ${member.status_notifications ? 'checked' : ''}/> Статусы аккаунтов</label>
          <label><input type="checkbox" data-member-schedule ${member.schedule_notifications ? 'checked' : ''}/> Расписание</label>
        </div>
        <div class="cli-tg-member__actions">
          <button type="submit" class="cli-settings__button">Сохранить</button>
          <button type="button" class="cli-settings__button cli-settings__button--danger" data-member-revoke>Отключить</button>
          <span class="cli-settings__result" data-member-result></span>
        </div>
      </form>`;
  }

  function render() {
    const host = root();
    if (!host) return;
    const hasTextApprover = members.some(member => member.is_text_approver);
    host.innerHTML = `
      <div class="cli-settings__block">
        <div class="cli-settings__title-row">
          <h3>Telegram</h3>
          <span>${members.length}/6</span>
        </div>
        <div class="cli-tg-list">
          ${members.length ? members.map(memberHtml).join('') : '<div class="cli-settings__empty">Telegram пока не подключён.</div>'}
        </div>
        <form class="cli-tg-connect" data-tg-connect>
          <label class="cli-field">
            <span>Контактное лицо (чей Telegram)</span>
            <input type="text" maxlength="100" required data-tg-label placeholder="Например, Анна, менеджер"/>
          </label>
          <label class="cli-check-row">
            <input type="checkbox" data-tg-approver ${hasTextApprover ? '' : 'checked'}/>
            <span>Согласовывает тексты</span>
          </label>
          <button type="submit" class="cli-settings__button cli-settings__button--primary">Подключить Telegram</button>
          <div class="cli-tg-link" data-tg-link hidden></div>
          <div class="cli-settings__result" data-tg-result></div>
        </form>
      </div>

      <details class="cli-settings__block cli-credentials">
        <summary>Изменить общий логин или пароль</summary>
        <form data-credentials-form>
          <label class="cli-field">
            <span>Новый email для входа</span>
            <input type="email" autocomplete="email" data-new-email value="${esc(Auth.email() || '')}"/>
          </label>
          <label class="cli-field">
            <span>Текущий пароль</span>
            <input type="password" autocomplete="current-password" required data-current-password/>
          </label>
          <div class="cli-settings__password-grid">
            <label class="cli-field">
              <span>Новый пароль</span>
              <input type="password" minlength="8" autocomplete="new-password" data-new-password/>
            </label>
            <label class="cli-field">
              <span>Повторите новый пароль</span>
              <input type="password" minlength="8" autocomplete="new-password" data-new-password-repeat/>
            </label>
          </div>
          <button type="submit" class="cli-settings__button">Сохранить вход</button>
          <div class="cli-settings__result" data-credentials-result></div>
        </form>
      </details>`;

    bindEvents(host);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function startPolling(previousCount) {
    stopPolling();
    let attempts = 0;
    pollTimer = setInterval(async () => {
      attempts += 1;
      try {
        await loadMembers();
        if (members.length > previousCount) {
          stopPolling();
          render();
          return;
        }
      } catch (_) {}
      if (attempts >= 30) stopPolling();
    }, 4000);
  }

  function bindEvents(host) {
    host.querySelectorAll('[data-member-approver]').forEach(input => {
      input.addEventListener('change', () => {
        if (!input.checked) {
          const form = input.closest('.cli-tg-member');
          const member = members.find(item => Number(item.id) === Number(form && form.dataset.memberId));
          if (member && member.is_text_approver) {
            input.checked = true;
            const result = form.querySelector('[data-member-result]');
            result.textContent = 'Сначала отметьте другой Telegram для согласования текстов.';
            result.className = 'cli-settings__result is-error';
          }
          return;
        }
        host.querySelectorAll('[data-member-approver]').forEach(other => {
          if (other !== input) other.checked = false;
        });
      });
    });

    host.querySelectorAll('.cli-tg-member').forEach(form => {
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const result = form.querySelector('[data-member-result]');
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        result.textContent = 'Сохраняем…';
        result.className = 'cli-settings__result';
        try {
          await rpc('update_my_client_telegram_member', {
            p_member_id: Number(form.dataset.memberId),
            p_contact_label: form.querySelector('[data-member-label]').value.trim(),
            p_is_text_approver: form.querySelector('[data-member-approver]').checked,
            p_status_notifications: form.querySelector('[data-member-status]').checked,
            p_schedule_notifications: form.querySelector('[data-member-schedule]').checked
          });
          await loadMembers();
          render();
        } catch (error) {
          result.textContent = errorMessage(error);
          result.className = 'cli-settings__result is-error';
        } finally {
          button.disabled = false;
        }
      });

      form.querySelector('[data-member-revoke]').addEventListener('click', async () => {
        if (!confirm('Отключить этот Telegram от кабинета?')) return;
        const result = form.querySelector('[data-member-result]');
        try {
          await rpc('revoke_my_client_telegram_member', {
            p_member_id: Number(form.dataset.memberId)
          });
          await loadMembers();
          render();
        } catch (error) {
          result.textContent = errorMessage(error);
          result.className = 'cli-settings__result is-error';
        }
      });
    });

    const connect = host.querySelector('[data-tg-connect]');
    connect.addEventListener('submit', async event => {
      event.preventDefault();
      const button = connect.querySelector('button[type="submit"]');
      const result = connect.querySelector('[data-tg-result]');
      const linkBox = connect.querySelector('[data-tg-link]');
      button.disabled = true;
      result.textContent = 'Готовим подключение…';
      result.className = 'cli-settings__result';
      try {
        const invite = await rpc('create_client_telegram_invite', {
          p_contact_label: connect.querySelector('[data-tg-label]').value.trim(),
          p_is_text_approver: connect.querySelector('[data-tg-approver]').checked
        });
        const url = `https://t.me/${encodeURIComponent(invite.bot_username || 'MentoriTG_bot')}?start=link_${encodeURIComponent(invite.token)}`;
        linkBox.hidden = false;
        linkBox.innerHTML = `
          <a class="cli-settings__button cli-settings__button--primary" href="${esc(url)}" target="_blank" rel="noopener">Открыть Telegram</a>
          <button type="button" class="cli-settings__button" data-copy-link>Скопировать ссылку</button>
          <span>Ссылка действует 10 минут и только один раз.</span>`;
        linkBox.querySelector('[data-copy-link]').addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(url);
            result.textContent = 'Ссылка скопирована.';
          } catch (_) {
            result.textContent = url;
          }
        });
        result.textContent = 'Откройте ссылку и нажмите Start в Telegram.';
        startPolling(members.length);
      } catch (error) {
        result.textContent = errorMessage(error);
        result.className = 'cli-settings__result is-error';
      } finally {
        button.disabled = false;
      }
    });

    const credentials = host.querySelector('[data-credentials-form]');
    credentials.addEventListener('submit', async event => {
      event.preventDefault();
      const result = credentials.querySelector('[data-credentials-result]');
      const button = credentials.querySelector('button[type="submit"]');
      const currentPassword = credentials.querySelector('[data-current-password]').value;
      const newEmail = credentials.querySelector('[data-new-email]').value.trim().toLowerCase();
      const newPassword = credentials.querySelector('[data-new-password]').value;
      const repeat = credentials.querySelector('[data-new-password-repeat]').value;
      if (newPassword !== repeat) {
        result.textContent = 'Новые пароли не совпадают.';
        result.className = 'cli-settings__result is-error';
        return;
      }
      button.disabled = true;
      result.textContent = 'Сохраняем…';
      result.className = 'cli-settings__result';
      try {
        const changed = await rpc('change_my_client_credentials', {
          p_current_password: currentPassword,
          p_new_email: newEmail || null,
          p_new_password: newPassword || null
        });
        alert(`Данные входа изменены. Войдите заново с email ${changed.email}.`);
        try { Auth.signOut(); } catch (_) {}
        location.replace('../../');
      } catch (error) {
        result.textContent = errorMessage(error);
        result.className = 'cli-settings__result is-error';
        button.disabled = false;
      }
    });
  }

  async function init() {
    if (!root()) return;
    try {
      await loadMembers();
      render();
    } catch (error) {
      root().innerHTML = `<div class="cli-settings__result is-error">${esc(errorMessage(error))}</div>`;
    }
  }

  window.addEventListener('pagehide', stopPolling);
  window.ClientSettings = { init, loadMembers };
})();
