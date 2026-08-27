const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const teamSql = read('sql/migrations/2026-08-20_client_portal_telegram_team.sql');
const approvalSql = read('sql/migrations/2026-08-20_client_text_approvals.sql');
const reviewApprovalSql = read('sql/migrations/2026-08-20_review_text_approval_link.sql');
const accountApprovalSql = read('sql/migrations/2026-08-26_client_text_approval_account_link.sql');
const selectedStatusSql = read('sql/migrations/2026-08-26_client_status_selected_notification.sql');
const settingsJs = read('pages/client/client-settings.js');
const approvalJs = read('js/client-text-approvals.js');
const clientApp = read('pages/client/client-app.js');
const telegramCalendarJs = read('pages/client/telegram-calendar.js');
const clientIndex = read('pages/client/index.html');
const clientProfile = read('pages/client/profile.html');
const statusesHtml = read('pages/statuses.html');
const reviewsHtml = read('pages/reviews.html');
const appJs = read('js/app.js');
const cloudSyncJs = read('js/cloud-sync.js');
const botPatch = read('ops/telegram/patches/client-telegram-team.patch');
const notificationBotPatch = read('ops/telegram/patches/client-notification-upgrades.patch');
const calendarMenuBotPatch = read('ops/telegram/patches/client-calendar-menu.patch');
const visualCabinetBotPatch = read('ops/telegram/patches/client-visual-cabinet.patch');
const directMenuAppPatch = read('ops/telegram/patches/client-direct-menu-app.patch');
const miniappOnlyPatch = read('ops/telegram/patches/client-miniapp-only-subscription.patch');
const textApprovalActionsPatch = read('ops/telegram/patches/client-text-approval-actions.patch');
const directMenuSql = read('sql/migrations/2026-08-26_client_telegram_direct_menu.sql');
const channelGateSql = read('sql/migrations/2026-08-27_client_telegram_channel_gate.sql');
const passwordlessSql = read('sql/migrations/2026-08-27_client_telegram_passwordless_login_and_bot_settings.sql');
const passwordlessBotPatch = read('ops/telegram/patches/client-passwordless-login-settings.patch');
const ownerInviteSql = read('sql/migrations/2026-08-26_owner_client_telegram_invites.sql');
const ownerInviteRolesSql = read('sql/migrations/2026-08-27_owner_client_telegram_invite_roles.sql');
const clientsHtml = read('pages/clients.html');
const clientAccessHtml = read('pages/client-access.html');

test('client login uses an immutable portal key', () => {
  const supabase = read('js/supabase-client.js');
  const clientApp = read('pages/client/client-app.js');
  assert.match(supabase, /portalEmail\(\)/);
  assert.match(supabase, /appMeta\.portal_email \|\| u\.email/);
  assert.ok((clientApp.match(/Auth\.portalEmail\(\)/g) || []).length >= 5);
  assert.match(teamSql, /raw_app_meta_data[\s\S]*portal_email/);
  assert.match(teamSql, /change_my_client_credentials/);
  assert.doesNotMatch(teamSql, /update auth\.identities\s+set email\s*=/i);
});

test('owner can copy a one-time Telegram link without client cabinet login', () => {
  assert.match(ownerInviteSql, /create_client_telegram_invite_for_owner/);
  assert.match(ownerInviteSql, /app_metadata'[\s\S]*role'[\s\S]*<> 'owner'/);
  assert.match(ownerInviteSql, /interval '24 hours'/);
  assert.match(ownerInviteSql, /digest\(convert_to\(v_token, 'UTF8'\), 'sha256'\)/);
  assert.match(ownerInviteSql, /client_snapshots/);
  assert.match(ownerInviteSql, /client_telegram_invites/);
  assert.doesNotMatch(ownerInviteSql, /update\s+public\.crm_state/i);
  assert.doesNotMatch(clientsHtml, /data-act="telegram-link"/,
    'в карточке отдельной анкеты не должно быть ссылки всего кабинета');
  assert.match(clientAccessHtml, /data-act="telegram-link"/);
  assert.match(clientAccessHtml, /create_client_telegram_invite_for_owner/);
  assert.match(clientAccessHtml, /p_portal_email: portal\.email/,
    'одна ссылка должна создаваться по ключу кабинета, а не по анкете');
  assert.match(clientAccessHtml, /navigator\.clipboard\.writeText\(url\)/);
  assert.match(clientAccessHtml, /Действует 24 часа и только для одного Telegram-аккаунта/);
});

test('owner creates a separate labelled Telegram invite for every contact', () => {
  assert.match(clientAccessHtml, /id="cpTelegramInviteModal"/);
  assert.match(clientAccessHtml, /name="cpTgInviteRole" value="owner"/);
  assert.match(clientAccessHtml, /name="cpTgInviteRole" value="manager"/);
  assert.match(clientAccessHtml, /id="cpTgInviteName"[^>]*maxlength="80"/);
  assert.match(clientAccessHtml, /id="cpTgInviteApprover"/);
  assert.match(clientAccessHtml, /p_contact_label: `\$\{contactName\} · \$\{roleLabel\}`/);
  assert.match(clientAccessHtml, /p_is_text_approver: isTextApprover/);
  assert.match(clientAccessHtml, /Создать ещё контакт/);
  assert.match(clientAccessHtml, /plannedApproverPortals/);
  assert.match(ownerInviteRolesSql, /v_make_approver boolean := coalesce\(p_is_text_approver, false\)/);
  assert.doesNotMatch(ownerInviteRolesSql, /p_is_text_approver, false\) or not exists/);
  assert.match(teamSql, /v_invite\.is_text_approver[\s\S]*or not exists/,
    'первый реально подключившийся контакт всё равно должен стать согласующим');
});

test('Telegram linking is short-lived, one-time and bounded', () => {
  assert.match(teamSql, /expires_at[\s\S]*now\(\) \+ interval '10 minutes'/);
  assert.match(teamSql, /token_hash text not null unique/);
  assert.match(teamSql, /encode\(digest\(convert_to\(v_token/);
  assert.match(teamSql, /if v_invite\.used_at is not null[\s\S]*INVITE_ALREADY_USED/);
  assert.match(teamSql, /if v_active_count >= 6[\s\S]*MEMBER_LIMIT_REACHED/);
  assert.match(teamSql, /telegram_user_id bigint not null unique/);
  assert.match(teamSql, /p_telegram_user_id <> p_telegram_chat_id/);
});

test('exactly one active contact can approve texts', () => {
  assert.match(teamSql, /client_telegram_one_text_approver_idx[\s\S]*where is_active and is_text_approver/);
  assert.match(settingsJs, /Согласовывает тексты/);
  assert.match(settingsJs, /data-member-approver/);
  assert.match(settingsJs, /other\.checked = false/);
  assert.match(settingsJs, /Сначала отметьте другой Telegram/);
  assert.match(teamSql, /v_member\.is_text_approver and not coalesce\(p_is_text_approver, false\)[\s\S]*TEXT_APPROVER_REQUIRED/);
  assert.match(teamSql, /if v_member\.is_text_approver then[\s\S]*new_text_approver_member_id/);
  assert.match(approvalSql, /is_active and is_text_approver/);
  assert.match(approvalSql, /TEXT_APPROVER_REQUIRED/);
});

test('text approval is atomic and audited', () => {
  assert.match(approvalSql, /where id = p_request_id[\s\S]*for update/);
  assert.match(approvalSql, /where id = v_request\.id and request_status = 'pending'/);
  assert.match(approvalSql, /ALREADY_RESOLVED/);
  assert.match(approvalSql, /text_approval_created/);
  assert.match(approvalSql, /text_approval_resolved/);
  assert.match(approvalSql, /client_text_approval_result/);
  assert.match(approvalJs, /create_review_text_approval/);
  assert.match(approvalJs, /cancel_review_text_approval/);
  assert.match(approvalJs, /latestByReview/);
});

test('review-linked approval is idempotent and survives a missing Telegram contact', () => {
  assert.match(reviewApprovalSql, /source_review_id text/);
  assert.match(reviewApprovalSql, /source_revision integer not null default 1/);
  assert.match(reviewApprovalSql, /client_text_approvals_source_revision_uidx/);
  assert.match(reviewApprovalSql, /pg_advisory_xact_lock/);
  assert.match(reviewApprovalSql, /v_role not in \('owner', 'team'\)/);
  assert.match(reviewApprovalSql, /if v_member\.id is not null then[\s\S]*notification_outbox/);
  assert.doesNotMatch(reviewApprovalSql, /raise exception 'TEXT_APPROVER_NOT_LINKED'/);
  assert.match(reviewApprovalSql, /resolve_my_client_text_approval/);
  assert.match(reviewApprovalSql, /where id = p_request_id and lower\(portal_email\) = lower\(v_portal\)[\s\S]*for update/);
  assert.match(reviewApprovalSql, /cancel_review_text_approval/);
  assert.match(accountApprovalSql, /source_profile_id text/);
  assert.match(accountApprovalSql, /create_review_text_approval\([\s\S]*p_source_profile_id text/);
  assert.match(approvalJs, /p_source_profile_id: review\.profileId/);
});

test('review text can be sent before Ready and Ready remains the publication marker', () => {
  assert.match(statusesHtml, /client-text-approvals\.js/);
  assert.match(statusesHtml, /client-text-approvals\.js\?v=20260826b/);
  assert.match(reviewsHtml, /client-text-approvals\.js\?v=20260826b/);
  assert.equal((statusesHtml.match(/ClientTextApprovals\.sendReview\(Store, review\)/g) || []).length, 1,
    'единая фоновая отправка должна обслуживать оба сценария сохранения');
  assert.match(statusesHtml, /clientApprovalRequired: true/);
  assert.match(statusesHtml, /cancelReviewInBackground\(existingReview\.id\)/);
  assert.match(statusesHtml, /cancelReviewInBackground\(linkedReview\.id\)/);
  assert.match(statusesHtml, /function sendReviewInBackground\(review\)/);
  assert.match(statusesHtml, /sendReviewInBackground\(review\)/);
  assert.match(statusesHtml, /Можно отправить заранее при любом рабочем статусе/);
  assert.match(statusesHtml, /newStatus === DONE_STATUS && !existingReview/);
  assert.match(statusesHtml, /existingReview\.publishedAt = new Date\(\)\.toISOString\(\)/);
  assert.match(statusesHtml, /Статус аккаунта от этого не изменится/);
  assert.doesNotMatch(statusesHtml, /button\.disabled = true;[\s\S]{0,300}ClientTextApprovals\.sendReview/);
  assert.match(statusesHtml, /function cancelReviewInBackground\(reviewId\)/);
  assert.match(statusesHtml, /Store\.deleteReviewsForPair\(chgPid, chgMid\);[\s\S]*cancelReviewInBackground\(existingReview\.id\)/);
  assert.doesNotMatch(statusesHtml, /currentTarget\.disabled\s*=\s*true[\s\S]{0,300}cancelReview/);
  assert.match(approvalJs, /RPC_TIMEOUT_MS = 12_000/);
  assert.match(approvalJs, /Promise\.race/);
  assert.match(approvalJs, /REQUEST_TIMEOUT/);
});

test('Reviews embeds client approval status and no longer has a manual compose block', () => {
  assert.doesNotMatch(reviewsHtml, /id="textApprovalsRoot"/);
  assert.doesNotMatch(reviewsHtml, /Отправить текст<\/button>/);
  assert.match(reviewsHtml, /clientApprovalHtml\(r\)/);
  assert.match(reviewsHtml, /data-act="send-client"/);
  assert.match(reviewsHtml, /data-act="revise-client"/);
  assert.match(approvalJs, /Клиент согласовал/);
});

test('client cabinet displays and can resolve its own text approvals', () => {
  assert.doesNotMatch(clientIndex, /data-cli-text-approvals/);
  assert.match(clientIndex, /data-cli-text-approval-notices/);
  assert.match(clientIndex, /loadMyTextApprovals\(\)/);
  assert.match(clientIndex, /renderTextApprovalNotices/);
  assert.match(clientProfile, /loadMyTextApprovals\(\)/);
  assert.match(clientProfile, /renderProfileDetail\([\s\S]*textApprovals/);
  assert.match(clientApp, /data-cli-text-approvals/);
  assert.match(clientApp, /row\.mentor_id === mentorId/);
  assert.match(clientApp, /client_text_approval_requests/);
  assert.match(clientApp, /resolve_my_client_text_approval/);
  assert.match(clientApp, /data-text-approve/);
  assert.match(clientApp, /data-text-change-submit/);
  assert.match(clientApp, /row\.request_status === 'pending'/);
  assert.match(clientApp, /approvedTextsByProfile/);
  assert.match(clientApp, /Текст <b>✓<\/b>/);
  assert.match(clientApp, /Отзыв <b>✓<\/b>/);
  assert.match(clientApp, /Согласованный текст/);
  assert.match(clientApp, /data-approved-text-toggle/);
  assert.match(clientApp, /data-approved-text-row/);
  assert.match(clientApp, /data-approved-text-copy/);
  assert.match(approvalJs, /reviewAccountLabel/);
  assert.match(approvalJs, /Текст отзыва'[\s\S]*code[\s\S]*account/);
});

test('status notifications fan out with a legacy-only fallback', () => {
  assert.match(appJs, /queueClientTelegramNotification/);
  assert.match(appJs, /oldStatus !== STATUS_SELECT \|\| newStatus !== STATUS_CHOSEN/);
  assert.doesNotMatch(appJs, /if \(!portal\.telegramChatId\) return/);
  assert.match(cloudSyncJs, /rpc\/queue_client_telegram_notification/);
  assert.match(cloudSyncJs, /no normalized Telegram recipients, using legacy fallback/);
  assert.match(teamSql, /member\.is_active and member\.status_notifications/);
  assert.match(selectedStatusSql, /NEW\.old_status = '⭐ Выбрать'/);
  assert.match(selectedStatusSql, /NEW\.new_status = '🏆 Выбран'/);
  assert.match(selectedStatusSql, /return 0;/);
  assert.match(selectedStatusSql, /before insert on public\.notification_outbox/);
});

test('bot patch links before ordinary start routing and supports decisions', () => {
  const linkIndex = botPatch.indexOf('arg.startswith("link_")');
  const leadIndex = botPatch.indexOf('arg == "razbor"');
  assert.ok(linkIndex >= 0 && leadIndex > linkIndex);
  assert.match(botPatch, /link_client_telegram_member/);
  assert.match(botPatch, /resolve_client_telegram_context/);
  assert.match(botPatch, /get_client_telegram_recipients/);
  assert.match(botPatch, /client_text_approval/);
  assert.match(botPatch, /ctxt:a:/);
  assert.match(botPatch, /ctxt:r:/);
  assert.doesNotMatch(botPatch, /(?:patch|post)\([^\n]*crm_state/i);
  assert.match(notificationBotPatch, /✕ Отменить/);
  assert.match(notificationBotPatch, /ctxt:c:/);
  assert.match(notificationBotPatch, /issue_client_telegram_webapp_token/);
  assert.match(notificationBotPatch, /📅 Открыть календарь/);
  assert.match(notificationBotPatch, /decision="changes_requested"/);
  assert.match(calendarMenuBotPatch, /Command\("calendar"\)/);
  assert.match(calendarMenuBotPatch, /BTN_CAB_CALENDAR/);
  assert.match(calendarMenuBotPatch, /set_my_commands/);
  assert.match(calendarMenuBotPatch, /_send_client_calendar_button/);
  assert.match(calendarMenuBotPatch, /issue_client_telegram_webapp_token/);
  assert.match(calendarMenuBotPatch, /WebAppInfo/);
  assert.doesNotMatch(calendarMenuBotPatch, /portal.password|signInWithPassword/);
  assert.match(visualCabinetBotPatch, /📱 Открыть кабинет/);
  assert.match(visualCabinetBotPatch, /answer_photo/);
  assert.match(visualCabinetBotPatch, /avatar_url/);
  assert.match(visualCabinetBotPatch, /initial_view/);
  assert.match(visualCabinetBotPatch, /"calendar"/);
  assert.match(directMenuAppPatch, /MenuButtonWebApp/);
  assert.match(directMenuAppPatch, /text="Кабинет"/);
  assert.match(directMenuAppPatch, /set_chat_menu_button/);
  assert.match(directMenuAppPatch, /get_chat_menu_button/);
  assert.match(directMenuAppPatch, /#token=/);
  assert.match(directMenuAppPatch, /_sync_client_cabinet_menu_buttons/);
  assert.match(directMenuAppPatch, /force=True/);
  assert.match(directMenuSql, /token_kind text not null default 'session'/);
  assert.match(directMenuSql, /issue_client_telegram_menu_token/);
  assert.match(directMenuSql, /activate_client_telegram_menu_token/);
  assert.match(directMenuSql, /digest\(v_token, 'sha256'\)/);
  assert.match(directMenuSql, /member\.is_active/);
  assert.match(directMenuSql, /auth\.role\(\) <> 'service_role'/);
});

test('client bot chat is Mini App only and keeps just the manager reply button', () => {
  assert.match(miniappOnlyPatch, /^\+\s+return _kb\(\[\[BTN_CAB_CONTACT\]\]\)$/m);
  assert.match(miniappOnlyPatch, /^\+\s+menu_button=MenuButtonCommands\(\),$/m);
  assert.match(miniappOnlyPatch, /_show_client_miniapp_only/);
  assert.match(miniappOnlyPatch, /Согласование теперь доступно только в Mini App/);
  assert.match(miniappOnlyPatch, /График теперь меняется только в Mini App/);
  assert.match(miniappOnlyPatch, /Согласуйте текст в Mini App через кнопку «Кабинет»/);
  assert.match(miniappOnlyPatch, /^\+\s+await bot\.send_message\(chat_id=chat_id, text=text\)$/m);
  assert.doesNotMatch(miniappOnlyPatch, /^\+.*_send_client_calendar_button/m);
  assert.doesNotMatch(miniappOnlyPatch, /^\+.*callback_data=f"ctxt:/m);
  assert.match(miniappOnlyPatch, /^-\s+BotCommand\(command="calendar"/m);
  assert.match(miniappOnlyPatch, /^-\s+BotCommand\(command="my_schedule"/m);
});

test('text approval notifications restore only confirm and reject actions', () => {
  assert.match(textApprovalActionsPatch, /ТЕКСТ НА СОГЛАСОВАНИЕ/);
  assert.match(textApprovalActionsPatch, /📋 <b>Анкета:<\/b>/);
  assert.match(textApprovalActionsPatch, /👤 <b>Аккаунт:<\/b>/);
  assert.match(textApprovalActionsPatch, /<blockquote>/);
  assert.match(textApprovalActionsPatch, /Проверьте текст и выберите действие/);
  assert.match(textApprovalActionsPatch, /✅ Подтвердить/);
  assert.match(textApprovalActionsPatch, /❌ Отклонить/);
  assert.match(textApprovalActionsPatch, /ctxt:a:/);
  assert.match(textApprovalActionsPatch, /ctxt:c:/);
  assert.doesNotMatch(textApprovalActionsPatch, /_send_client_calendar_button/);
  assert.doesNotMatch(textApprovalActionsPatch, /BTN_CAB_CALENDAR/);
});

test('Mini App access requires a live Mentori channel subscription', () => {
  assert.match(channelGateSql, /channel_subscription_active boolean not null default false/);
  assert.match(channelGateSql, /set_client_telegram_channel_subscription/);
  assert.match(channelGateSql, /list_client_telegram_channel_members/);
  assert.match(channelGateSql, /set revoked_at = coalesce\(revoked_at, now\(\)\)/);
  assert.match(channelGateSql, /CHANNEL_SUBSCRIPTION_REQUIRED/);
  assert.match(channelGateSql, /issue_client_telegram_webapp_token[\s\S]*channel_subscription_active/);
  assert.match(channelGateSql, /issue_client_telegram_menu_token[\s\S]*channel_subscription_active/);
  assert.match(channelGateSql, /activate_client_telegram_menu_token[\s\S]*member\.channel_subscription_active/);
  assert.match(channelGateSql, /client_telegram_webapp_context[\s\S]*CHANNEL_SUBSCRIPTION_REQUIRED/);
  assert.match(miniappOnlyPatch, /get_chat_member/);
  assert.match(miniappOnlyPatch, /set_client_telegram_channel_subscription/);
  assert.match(miniappOnlyPatch, /on_chat_member/);
  assert.match(telegramCalendarJs, /CHANNEL_SUBSCRIPTION_REQUIRED/);
});

test('Telegram can issue a bounded passwordless client-cabinet login', () => {
  const authClient = read('js/supabase-client.js');
  const clientLogin = read('pages/client/login.html');
  assert.match(passwordlessSql, /prepare_client_telegram_passwordless_login/);
  assert.match(passwordlessSql, /telegram_user_id = p_telegram_user_id/);
  assert.match(passwordlessSql, /telegram_chat_id = p_telegram_chat_id/);
  assert.match(passwordlessSql, /channel_subscription_active/);
  assert.match(passwordlessSql, /from auth\.users/);
  assert.match(passwordlessSql, /raw_app_meta_data ->> 'portal_email'/);
  assert.match(passwordlessSql, /raw_app_meta_data ->> 'role'[^\n]*= 'client'/);
  assert.match(passwordlessSql, /auth\.role\(\) <> 'service_role'/);
  assert.match(passwordlessSql, /telegram_passwordless_login_prepared/);
  assert.doesNotMatch(passwordlessSql, /encrypted_password|password_hash|update\s+auth\.users/i);

  assert.match(passwordlessBotPatch, /auth\/v1\/admin\/generate_link/);
  assert.match(passwordlessBotPatch, /"type": "magiclink"/);
  assert.match(passwordlessBotPatch, /redirect_to/);
  assert.match(passwordlessBotPatch, /canonical_verify_path/);
  assert.match(passwordlessBotPatch, /action_url\.path == "\/verify"/);
  assert.match(passwordlessBotPatch, /_replace\(path=canonical_verify_path\)/);
  assert.match(passwordlessBotPatch, /action_url\.netloc != public_api\.netloc/);
  assert.match(passwordlessBotPatch, /Войти без пароля/);
  assert.match(passwordlessBotPatch, /Не пересылайте её другим людям/);
  assert.doesNotMatch(passwordlessBotPatch, /signInWithPassword|portal\.password/);

  assert.match(authClient, /async consumeUrlSession\(\)/);
  assert.match(authClient, /auth\/v1\/user/);
  assert.match(authClient, /history\.replaceState/);
  assert.match(clientLogin, /Auth\.consumeUrlSession\(\)/);
  assert.match(clientLogin, /Auth\.role\(\) !== 'client'/);
  assert.match(clientLogin, /supabase-client\.js\?v=20260827a/);
});

test('Telegram notification settings mirror the four cabinet preferences', () => {
  assert.match(passwordlessSql, /get_client_telegram_bot_settings/);
  assert.match(passwordlessSql, /update_client_telegram_bot_notification_setting/);
  assert.match(passwordlessSql, /v_setting not in \('status', 'schedule', 'low_reviews', 'order_completed'\)/);
  assert.match(passwordlessSql, /member_bot_notifications_updated/);
  assert.match(passwordlessBotPatch, /BTN_CAB_NOTIFICATIONS/);
  assert.match(passwordlessBotPatch, /Изменения статусов/);
  assert.match(passwordlessBotPatch, /Ежедневный план откликов/);
  assert.match(passwordlessBotPatch, /Остался один отзыв/);
  assert.match(passwordlessBotPatch, /Пакет выполнен/);
  assert.match(passwordlessBotPatch, /callback_data=f"ctgn:/);
  assert.match(passwordlessBotPatch, /update_client_telegram_bot_notification_setting/);
  assert.match(passwordlessBotPatch, /\[BTN_CAB_LOGIN\][\s\S]*\[BTN_CAB_NOTIFICATIONS\][\s\S]*\[BTN_CAB_CONTACT\]/);
  assert.doesNotMatch(passwordlessBotPatch, /^\+.*BTN_CAB_(?:ANKETAS|CALENDAR|SCHEDULE)/m);
});
