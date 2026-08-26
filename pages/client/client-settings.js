/* Separate client-cabinet settings: profile, credentials, Telegram and referrals. */
(function () {
  'use strict';

  const SB = window.Supabase;
  if (!SB) return;
  const { Auth, authFetch } = SB;
  const root = () => document.querySelector('[data-cli-settings-body]');
  const modal = () => document.querySelector('[data-cli-settings-modal]');
  let members = [];
  let profile = { contact_name: '', phone: '' };
  let referralDashboard = {
    referral_code: '', bot_username: 'MentoriTG_bot',
    bonus_earned: 0, bonus_used: 0, bonus_available: 0, referrals: []
  };
  let displayName = '';
  let activeTab = 'profile';
  let pollTimer = null;
  let closeTimer = null;
  let initialized = false;

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
    if (raw.includes('CONTACT_NAME_TOO_LONG')) return 'Имя контактного лица слишком длинное.';
    if (raw.includes('PHONE_TOO_LONG') || raw.includes('PHONE_INVALID')) return 'Проверьте номер телефона.';
    return 'Не удалось сохранить. Проверьте связь и попробуйте ещё раз.';
  }

  async function loadMembers() {
    const result = await rpc('list_my_client_telegram_members');
    members = Array.isArray(result) ? result : [];
    document.dispatchEvent(new CustomEvent('client-telegram-members-changed', {
      detail: { count: members.length }
    }));
    return members;
  }

  async function loadProfile() {
    const result = await rpc('get_my_client_portal_profile');
    profile = result && typeof result === 'object'
      ? result
      : { contact_name: '', phone: '' };
    return profile;
  }

  async function loadReferralDashboard() {
    const result = await rpc('get_my_client_referral_dashboard');
    referralDashboard = result && typeof result === 'object'
      ? result
      : {
          referral_code: '', bot_username: 'MentoriTG_bot',
          bonus_earned: 0, bonus_used: 0, bonus_available: 0, referrals: []
        };
    if (!Array.isArray(referralDashboard.referrals)) referralDashboard.referrals = [];
    return referralDashboard;
  }

  function checked(value) {
    return value === false ? '' : 'checked';
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
          <label><input type="checkbox" data-member-status ${checked(member.status_notifications)}/> Изменения статусов</label>
          <label><input type="checkbox" data-member-schedule ${checked(member.schedule_notifications)}/> Ежедневный план откликов</label>
          <label><input type="checkbox" data-member-low ${checked(member.low_reviews_notifications)}/> Остался один отзыв</label>
          <label><input type="checkbox" data-member-completed ${checked(member.order_completed_notifications)}/> Пакет выполнен</label>
        </div>
        <div class="cli-tg-member__actions">
          <button type="submit" class="cli-settings__button">Сохранить</button>
          <button type="button" class="cli-settings__button cli-settings__button--danger" data-member-revoke>Отвязать Telegram</button>
          <span class="cli-settings__result" data-member-result aria-live="polite"></span>
        </div>
      </form>`;
  }

  function profilePanel() {
    return `
      <section class="cli-settings-panel" aria-labelledby="cliSettingsProfileTitle">
        <div class="cli-settings-panel__intro">
          <h3 id="cliSettingsProfileTitle">Контактные данные</h3>
          <p>Эти данные относятся только к вашему кабинету и не меняют анкету.</p>
        </div>
        <form class="cli-settings-form" data-profile-form>
          ${displayName ? `
            <div class="cli-settings-readonly">
              <span>Название кабинета</span>
              <strong>${esc(displayName)}</strong>
            </div>` : ''}
          <label class="cli-field">
            <span>Контактное лицо</span>
            <input type="text" maxlength="100" autocomplete="name" data-profile-name value="${esc(profile.contact_name || '')}" placeholder="Имя человека для связи"/>
          </label>
          <label class="cli-field">
            <span>Телефон</span>
            <input type="tel" maxlength="32" autocomplete="tel" inputmode="tel" data-profile-phone value="${esc(profile.phone || '')}" placeholder="+7 999 000-00-00"/>
          </label>
          <div class="cli-settings-form__actions">
            <button type="submit" class="cli-settings__button cli-settings__button--primary">Сохранить контакты</button>
            <span class="cli-settings__result" data-profile-result aria-live="polite"></span>
          </div>
        </form>
      </section>`;
  }

  function credentialsPanel() {
    return `
      <section class="cli-settings-panel" aria-labelledby="cliSettingsCredentialsTitle">
        <div class="cli-settings-panel__intro">
          <h3 id="cliSettingsCredentialsTitle">Вход и пароль</h3>
          <p>После изменения данных входа кабинет попросит авторизоваться заново.</p>
        </div>
        <form class="cli-settings-form" data-credentials-form>
          <label class="cli-field">
            <span>Email для входа</span>
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
          <div class="cli-settings-form__actions">
            <button type="submit" class="cli-settings__button cli-settings__button--primary">Сохранить вход</button>
            <span class="cli-settings__result" data-credentials-result aria-live="polite"></span>
          </div>
        </form>
      </section>`;
  }

  function telegramPanel() {
    const hasTextApprover = members.some(member => member.is_text_approver);
    const canAdd = members.length < 6;
    return `
      <section class="cli-settings-panel" aria-labelledby="cliSettingsTelegramTitle">
        <div class="cli-settings-panel__intro cli-settings-panel__intro--split">
          <div>
            <h3 id="cliSettingsTelegramTitle">Telegram и уведомления</h3>
            <p>Можно подключить до шести контактов и выбрать уведомления для каждого.</p>
          </div>
          <span class="cli-settings-count">${members.length}/6</span>
        </div>
        <div class="cli-tg-list">
          ${members.length ? members.map(memberHtml).join('') : '<div class="cli-settings__empty">Telegram пока не подключён.</div>'}
        </div>
        ${canAdd ? `
          <form class="cli-tg-connect" data-tg-connect>
            <h4>Подключить ещё один Telegram</h4>
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
            <div class="cli-settings__result" data-tg-result aria-live="polite"></div>
          </form>` : '<div class="cli-settings__limit">Подключено максимальное число Telegram-контактов.</div>'}
      </section>`;
  }

  function referralPerson(referral) {
    if (referral.username) return `@${referral.username}`;
    return [referral.first_name, referral.last_name].filter(Boolean).join(' ') || 'Пользователь Telegram';
  }

  function referralState(referral) {
    if (Number(referral.referrer_bonus_qty) > 0) return { label: 'Бонус начислен: +1 отзыв вам', cls: 'is-applied' };
    if (referral.status === 'applied') return { label: 'Бонус начисляется', cls: 'is-reserved' };
    if (referral.status === 'reserved') return { label: 'Заказ подтверждается', cls: 'is-reserved' };
    if (referral.status === 'rejected_self') return { label: 'Не засчитан', cls: 'is-rejected' };
    if (referral.linked_at) return { label: 'Кабинет подключён', cls: 'is-linked' };
    return { label: 'Перешёл в бота', cls: 'is-pending' };
  }

  function referralPanel() {
    const bot = referralDashboard.bot_username || 'MentoriTG_bot';
    const code = referralDashboard.referral_code || '';
    const link = code ? `https://t.me/${encodeURIComponent(bot)}?start=ref_${encodeURIComponent(code)}` : '';
    const referrals = referralDashboard.referrals || [];
    const bonusAvailable = Math.max(0, Number(referralDashboard.bonus_available) || 0);
    const bonusEarned = Math.max(0, Number(referralDashboard.bonus_earned) || 0);
    return `
      <section class="cli-settings-panel" aria-labelledby="cliSettingsReferralTitle">
        <div class="cli-settings-panel__intro">
          <h3 id="cliSettingsReferralTitle">Реферальная программа</h3>
          <p>После первой оплаты друг получит один отзыв в подарок, и ещё один бонусный отзыв начислится вам.</p>
        </div>
        <div class="cli-referral-bonus" aria-label="Баланс бонусных отзывов">
          <div><strong>${bonusAvailable}</strong><span>доступно</span></div>
          <p>Бонусных отзывов на вашем балансе${bonusEarned ? ` · всего начислено ${bonusEarned}` : ''}</p>
        </div>
        <div class="cli-referral-link">
          <span>Ваша ссылка</span>
          <div class="cli-referral-link__row">
            <input type="text" readonly data-referral-link value="${esc(link)}" aria-label="Реферальная ссылка"/>
            <button type="button" class="cli-settings__button cli-settings__button--primary" data-referral-copy>Скопировать</button>
            <a class="cli-settings__button" href="${esc(link)}" target="_blank" rel="noopener">Открыть</a>
          </div>
          <div class="cli-settings__result" data-referral-result aria-live="polite"></div>
        </div>
        <div class="cli-referral-list">
          <div class="cli-referral-list__head">
            <h4>Приглашённые</h4>
            <span>${referrals.length}</span>
          </div>
          ${referrals.length ? referrals.map(referral => {
            const state = referralState(referral);
            return `
              <div class="cli-referral-person">
                <div>
                  <strong>${esc(referralPerson(referral))}</strong>
                  <span>${referral.referrer_bonus_awarded_at
                    ? `Оплатил заказ ${new Date(referral.referrer_bonus_awarded_at).toLocaleDateString('ru-RU')}`
                    : (referral.joined_at ? new Date(referral.joined_at).toLocaleDateString('ru-RU') : '')}</span>
                </div>
                <span class="cli-referral-person__state ${state.cls}">${state.label}</span>
              </div>`;
          }).join('') : '<div class="cli-settings__empty">Переходов по ссылке пока нет.</div>'}
        </div>
      </section>`;
  }

  function panelHtml() {
    if (activeTab === 'credentials') return credentialsPanel();
    if (activeTab === 'telegram') return telegramPanel();
    if (activeTab === 'referral') return referralPanel();
    return profilePanel();
  }

  function render() {
    const host = root();
    if (!host) return;
    host.innerHTML = `
      <div class="cli-settings-shell">
        <nav class="cli-settings-nav" role="tablist" aria-label="Разделы настроек">
          <button type="button" role="tab" data-settings-tab="profile" aria-selected="${activeTab === 'profile'}" class="${activeTab === 'profile' ? 'is-active' : ''}">Контактные данные</button>
          <button type="button" role="tab" data-settings-tab="credentials" aria-selected="${activeTab === 'credentials'}" class="${activeTab === 'credentials' ? 'is-active' : ''}">Вход и пароль</button>
          <button type="button" role="tab" data-settings-tab="telegram" aria-selected="${activeTab === 'telegram'}" class="${activeTab === 'telegram' ? 'is-active' : ''}">Telegram</button>
          <button type="button" role="tab" data-settings-tab="referral" aria-selected="${activeTab === 'referral'}" class="${activeTab === 'referral' ? 'is-active' : ''}">Реферальная программа</button>
        </nav>
        <div class="cli-settings-content" role="tabpanel">${panelHtml()}</div>
      </div>`;
    bindTabEvents(host);
    if (activeTab === 'profile') bindProfileEvents(host);
    if (activeTab === 'credentials') bindCredentialsEvents(host);
    if (activeTab === 'telegram') bindTelegramEvents(host);
    if (activeTab === 'referral') bindReferralEvents(host);
  }

  function bindTabEvents(host) {
    host.querySelectorAll('[data-settings-tab]').forEach(button => {
      button.addEventListener('click', () => {
        activeTab = button.dataset.settingsTab || 'profile';
        render();
        const active = root().querySelector(`[data-settings-tab="${activeTab}"]`);
        if (active) active.focus();
      });
    });
  }

  function bindProfileEvents(host) {
    const form = host.querySelector('[data-profile-form]');
    if (!form) return;
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      const result = form.querySelector('[data-profile-result]');
      button.disabled = true;
      result.textContent = 'Сохраняем…';
      result.className = 'cli-settings__result';
      try {
        profile = await rpc('update_my_client_portal_profile', {
          p_contact_name: form.querySelector('[data-profile-name]').value.trim(),
          p_phone: form.querySelector('[data-profile-phone]').value.trim()
        });
        result.textContent = 'Контактные данные сохранены.';
        result.className = 'cli-settings__result is-success';
      } catch (error) {
        result.textContent = errorMessage(error);
        result.className = 'cli-settings__result is-error';
      } finally {
        button.disabled = false;
      }
    });
  }

  function bindReferralEvents(host) {
    const input = host.querySelector('[data-referral-link]');
    const button = host.querySelector('[data-referral-copy]');
    const result = host.querySelector('[data-referral-result]');
    if (!input || !button || !result) return;
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(input.value);
        result.textContent = 'Ссылка скопирована.';
        result.className = 'cli-settings__result is-success';
      } catch (_) {
        input.focus();
        input.select();
        result.textContent = 'Ссылка выделена.';
      }
    });
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

  function bindTelegramEvents(host) {
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
          await rpc('update_my_client_telegram_settings', {
            p_member_id: Number(form.dataset.memberId),
            p_contact_label: form.querySelector('[data-member-label]').value.trim(),
            p_is_text_approver: form.querySelector('[data-member-approver]').checked,
            p_status_notifications: form.querySelector('[data-member-status]').checked,
            p_schedule_notifications: form.querySelector('[data-member-schedule]').checked,
            p_low_reviews_notifications: form.querySelector('[data-member-low]').checked,
            p_order_completed_notifications: form.querySelector('[data-member-completed]').checked
          });
          await loadMembers();
          render();
        } catch (error) {
          result.textContent = errorMessage(error);
          result.className = 'cli-settings__result is-error';
          button.disabled = false;
        }
      });

      form.querySelector('[data-member-revoke]').addEventListener('click', async () => {
        const member = members.find(item => Number(item.id) === Number(form.dataset.memberId));
        const button = form.querySelector('[data-member-revoke]');
        const label = member ? memberName(member) : 'этот контакт';
        if (!confirm(`Отвязать Telegram «${label}» от кабинета? Уведомления на него больше приходить не будут.`)) return;
        const result = form.querySelector('[data-member-result]');
        button.disabled = true;
        button.textContent = 'Отвязываем…';
        try {
          await rpc('revoke_my_client_telegram_member', {
            p_member_id: Number(form.dataset.memberId)
          });
          await loadMembers();
          render();
        } catch (error) {
          result.textContent = errorMessage(error);
          result.className = 'cli-settings__result is-error';
          button.disabled = false;
          button.textContent = 'Отвязать Telegram';
        }
      });
    });

    const connect = host.querySelector('[data-tg-connect]');
    if (!connect) return;
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
  }

  function bindCredentialsEvents(host) {
    const credentials = host.querySelector('[data-credentials-form]');
    if (!credentials) return;
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

  function open(tab) {
    const box = modal();
    if (!box) return;
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = null;
    if (tab) activeTab = tab;
    render();
    box.hidden = false;
    box.setAttribute('aria-hidden', 'false');
    document.body.classList.add('cli-settings-open');
    requestAnimationFrame(() => {
      box.classList.add('is-open');
      const selected = box.querySelector('[data-settings-tab][aria-selected="true"]');
      if (selected) selected.focus();
    });
  }

  function close() {
    const box = modal();
    if (!box || box.hidden) return;
    stopPolling();
    box.classList.remove('is-open');
    box.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('cli-settings-open');
    closeTimer = setTimeout(() => {
      box.hidden = true;
      closeTimer = null;
    }, 180);
    const trigger = document.getElementById('cliSettingsOpen');
    if (trigger) trigger.focus();
  }

  function bindModalEvents() {
    const box = modal();
    if (!box || initialized) return;
    initialized = true;
    box.querySelectorAll('[data-cli-settings-close]').forEach(button => {
      button.addEventListener('click', close);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !box.hidden) close();
    });
  }

  async function init(options = {}) {
    if (!root()) return null;
    displayName = String(options.displayName || '').trim();
    bindModalEvents();
    try {
      await Promise.all([loadMembers(), loadProfile(), loadReferralDashboard()]);
      render();
      return { telegramMemberCount: members.length };
    } catch (error) {
      root().innerHTML = `<div class="cli-settings__result is-error">${esc(errorMessage(error))}</div>`;
      return null;
    }
  }

  window.addEventListener('pagehide', stopPolling);
  window.ClientSettings = {
    init, open, close, loadMembers, loadProfile, loadReferralDashboard
  };
})();
