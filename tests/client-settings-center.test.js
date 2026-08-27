const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const indexHtml = read('pages/client/index.html');
const clientApp = read('pages/client/client-app.js');
const settingsJs = read('pages/client/client-settings.js');
const clientCss = read('pages/client/client.css');
const appJs = read('js/app.js');
const cloudSyncJs = read('js/cloud-sync.js');
const migration = read('sql/migrations/2026-08-20_client_settings_center.sql');
const referralMigration = read('sql/migrations/2026-08-20_client_referrals.sql');
const notificationEventsMigration = read('sql/migrations/2026-08-26_client_notification_events.sql');
const notificationTemplatesMigration = read('sql/migrations/2026-08-27_client_schedule_notification_templates.sql');
const notificationCopyPatch = read('ops/telegram/patches/client-notification-copy.patch');
const paymentDomain = read('payments/app/domain.py');
const paymentMain = read('payments/app/main.py');

test('settings open from the client avatar and no longer occupy the dashboard', () => {
  assert.match(clientApp, /id="cliSettingsOpen"/);
  assert.match(clientApp, /window\.ClientSettings\.open\(\)/);
  assert.match(indexHtml, /data-cli-settings-modal/);
  assert.match(indexHtml, /role="dialog" aria-modal="true"/);
  assert.doesNotMatch(indexHtml, /<section class="cli-settings"/);
  assert.match(settingsJs, /activeTab = 'profile'/);
  assert.match(settingsJs, /Контактные данные/);
  assert.match(settingsJs, /Вход и пароль/);
  assert.match(settingsJs, /Telegram и уведомления/);
  assert.match(settingsJs, /Реферальная программа/);
});

test('every cabinet without Telegram gets a reminder and any client can unlink a contact', () => {
  assert.match(indexHtml, /data-cli-tg-reminder/);
  assert.match(indexHtml, /Подключите Telegram для уведомлений/);
  assert.match(indexHtml, /cli-tg-reminder__mobile">Telegram для уведомлений/);
  assert.match(indexHtml, /cli-tg-reminder__mobile">Подключить/);
  assert.doesNotMatch(clientApp, /TELEGRAM_REMINDER_TEST_EMAIL|test@test\.com/);
  assert.match(clientApp, /const shouldShow = Number\.isFinite\(count\) && count === 0/);
  assert.match(clientApp, /ClientSettings\.open\('telegram'\)/);
  assert.match(settingsJs, /Отвязать Telegram/);
  assert.match(settingsJs, /revoke_my_client_telegram_member/);
  assert.match(clientCss, /@keyframes cliTgReminderGlow/);
  assert.match(clientCss, /prefers-reduced-motion: reduce/);
  assert.match(clientCss, /@media \(max-width: 700px\)[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.match(clientCss, /cli-tg-reminder__copy strong[\s\S]*white-space: nowrap/);
  assert.match(clientCss, /cli-tg-reminder__action[\s\S]*justify-self: end/);
  assert.match(clientCss, /cli-tg-reminder__close[\s\S]*top: 2px;[\s\S]*right: 2px/);
});

test('main dashboard only points to anketa approvals and keeps legal links in the footer', () => {
  assert.match(indexHtml, /data-cli-text-approval-notices/);
  assert.match(indexHtml, /renderTextApprovalNotices/);
  assert.doesNotMatch(indexHtml, /class="cli-terms-card"/);
  assert.match(indexHtml, /href="\.\.\/\.\.\/legal\/offer\.html"/);
});

test('referral link records Telegram attribution and grants one bonus only on first paid order', () => {
  assert.match(referralMigration, /create table if not exists public\.client_referral_codes/);
  assert.match(referralMigration, /telegram_user_id bigint not null unique/);
  assert.match(referralMigration, /SELF_REFERRAL/);
  assert.match(referralMigration, /REFERRAL_ALREADY_ATTRIBUTED/);
  assert.match(referralMigration, /reserve_client_referral_bonus/);
  assert.match(referralMigration, /previous\.parent_order_id is null/);
  assert.match(referralMigration, /previous\.status = 'confirmed'/);
  assert.match(referralMigration, /'Реферальный бонус', 0, 1, 0/);
  assert.match(referralMigration, /on conflict \(parent_order_id, parent_item_id\)/);
  assert.match(settingsJs, /get_my_client_referral_dashboard/);
  assert.match(settingsJs, /\?start=ref_/);
  assert.match(settingsJs, /Бонус начислен/);
  assert.match(paymentDomain, /_referral_bonus_qty/);
  assert.match(paymentDomain, /referral_bonus/);
  assert.match(paymentMain, /reserve_referral_bonus\(conn, order\)/);
  assert.match(paymentMain, /complete_referral_bonus\(conn, order, applied\)/);
  assert.doesNotMatch(referralMigration, /update\s+public\.crm_state/i);
});

test('contact profile is normalized and cannot write the CRM blob', () => {
  assert.match(migration, /create table if not exists public\.client_portal_profiles/);
  assert.match(migration, /portal_email text primary key/);
  assert.match(migration, /current_client_portal_email\(\)/);
  assert.match(migration, /CONTACT_NAME_TOO_LONG/);
  assert.match(migration, /PHONE_TOO_LONG/);
  assert.doesNotMatch(migration, /update\s+public\.crm_state/i);
  assert.doesNotMatch(migration, /insert\s+into\s+public\.crm_state/i);
  assert.match(settingsJs, /get_my_client_portal_profile/);
  assert.match(settingsJs, /update_my_client_portal_profile/);
});

test('every Telegram contact controls concrete notification types', () => {
  assert.match(migration, /low_reviews_notifications boolean not null default true/);
  assert.match(migration, /order_completed_notifications boolean not null default true/);
  assert.match(migration, /update_my_client_telegram_settings/);
  assert.match(settingsJs, /Ежедневный план откликов/);
  assert.match(settingsJs, /Остался один отзыв/);
  assert.match(settingsJs, /Пакет выполнен/);
  assert.match(settingsJs, /p_low_reviews_notifications/);
  assert.match(settingsJs, /p_order_completed_notifications/);
  assert.match(migration, /when 'schedule' then member\.schedule_notifications/);
  assert.match(migration, /when 'low_reviews' then member\.low_reviews_notifications/);
  assert.match(migration, /when 'order_completed' then member\.order_completed_notifications/);
});

test('package progress is queued only after review approval and deduplicated', () => {
  assert.match(appJs, /approveReview[\s\S]*_queueClientProgressNotification\(r\)/);
  assert.doesNotMatch(appJs, /remaining !== 1 && remaining !== 0/);
  assert.match(appJs, /const remaining = clientReviewsRemaining\(this\.state, mentor\)/);
  assert.doesNotMatch(appJs, /clientRemainingReviews/);
  assert.match(appJs, /remaining === 1 \? 'low_reviews' : 'review_published'/);
  assert.match(appJs, /Последний отзыв опубликован/);
  assert.match(appJs, /ОТЗЫВ ОПУБЛИКОВАН/);
  assert.match(appJs, /ОСТАЛСЯ ПОСЛЕДНИЙ ОТЗЫВ/);
  assert.match(appJs, /ПАКЕТ ВЫПОЛНЕН/);
  assert.match(appJs, /В пакете остался 1 отзыв/);
  assert.match(appJs, /action_ref: `review:\$\{review\.id\}:remaining:\$\{remaining\}`/);
  assert.match(cloudSyncJs, /rpc\/queue_client_progress_notification/);
  assert.match(migration, /notification_outbox_client_progress_unique_idx/);
  assert.match(migration, /on conflict do nothing/);
  assert.match(notificationEventsMigration, /review_published/);
  assert.match(notificationEventsMigration, /notify_client_outreach_slot_change/);
  assert.match(notificationEventsMigration, /member\.schedule_notifications/);
});

test('client Telegram notifications share one visual system and the schedule names the start time', () => {
  const headings = [
    'АККАУНТ ВЫБРАН',
    'ОТЗЫВ ОПУБЛИКОВАН',
    'ОСТАЛСЯ ПОСЛЕДНИЙ ОТЗЫВ',
    'ПАКЕТ ВЫПОЛНЕН'
  ];
  assert.equal(new Set(headings).size, 4);
  headings.forEach(heading => assert.match(appJs, new RegExp(heading)));
  assert.match(appJs, /CLIENT_NOTIFICATION_DIVIDER = '━━━━━━━━━━━━━━'/);
  assert.match(appJs, /🏆 <b>АККАУНТ ВЫБРАН<\/b>/);
  assert.match(appJs, /telegramHtml\(mentorLabel\)/);
  assert.match(appJs, /telegramHtml\(accountLabel\)/);
  assert.match(notificationTemplatesMigration, /📅 <b>ОТКЛИК ЗАПЛАНИРОВАН<\/b>/);
  assert.match(notificationTemplatesMigration, /🔄 <b>ДАТА ОТКЛИКА ИЗМЕНЕНА<\/b>/);
  assert.match(notificationTemplatesMigration, /❌ <b>ОТКЛИК ОТМЕНЁН<\/b>/);
  assert.match(notificationTemplatesMigration, /не раньше 13:30 по МСК/);
  assert.match(notificationTemplatesMigration, /Отклик снова доступен для планирования/);
  assert.match(notificationCopyPatch, /🌅 <b>ДОБРОЕ УТРО!<\/b>/);
  assert.match(notificationCopyPatch, /не раньше 13:30 по МСК/);
  assert.match(notificationCopyPatch, /html\.escape/);
});

test('settings are bounded on desktop and full-screen without overflow on mobile', () => {
  assert.match(clientCss, /grid-template-columns: 200px minmax\(0, 1fr\)/);
  assert.match(clientCss, /@media \(max-width: 700px\)[\s\S]*height: 100dvh/);
  assert.match(clientCss, /cli-settings-nav[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(clientCss, /cli-settings-nav[\s\S]{0,200}overflow-x: auto/);
  assert.match(clientCss, /cli-settings-content \{ min-width: 0; overflow: auto/);
});
