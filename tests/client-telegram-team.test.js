const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const teamSql = read('sql/migrations/2026-08-20_client_portal_telegram_team.sql');
const approvalSql = read('sql/migrations/2026-08-20_client_text_approvals.sql');
const reviewApprovalSql = read('sql/migrations/2026-08-20_review_text_approval_link.sql');
const settingsJs = read('pages/client/client-settings.js');
const approvalJs = read('js/client-text-approvals.js');
const clientApp = read('pages/client/client-app.js');
const clientIndex = read('pages/client/index.html');
const statusesHtml = read('pages/statuses.html');
const reviewsHtml = read('pages/reviews.html');
const appJs = read('js/app.js');
const cloudSyncJs = read('js/cloud-sync.js');
const botPatch = read('ops/telegram/patches/client-telegram-team.patch');

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
});

test('setting Ready sends the saved review through the linked approval workflow', () => {
  assert.match(statusesHtml, /client-text-approvals\.js/);
  assert.ok((statusesHtml.match(/ClientTextApprovals\.sendReview\(Store, review\)/g) || []).length >= 2);
  assert.match(statusesHtml, /clientApprovalRequired: true/);
  assert.match(statusesHtml, /ClientTextApprovals\.cancelReview\(existingReview\.id\)/);
  assert.match(statusesHtml, /ClientTextApprovals\.cancelReview\(linkedReview\.id\)/);
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
  assert.match(clientIndex, /data-cli-text-approvals/);
  assert.match(clientIndex, /loadMyTextApprovals\(\)/);
  assert.match(clientIndex, /renderTextApprovals\(textApprovals\)/);
  assert.match(clientApp, /client_text_approval_requests/);
  assert.match(clientApp, /resolve_my_client_text_approval/);
  assert.match(clientApp, /data-text-approve/);
  assert.match(clientApp, /data-text-change-submit/);
});

test('status notifications fan out with a legacy-only fallback', () => {
  assert.match(appJs, /queueClientTelegramNotification/);
  assert.doesNotMatch(appJs, /if \(!portal\.telegramChatId\) return/);
  assert.match(cloudSyncJs, /rpc\/queue_client_telegram_notification/);
  assert.match(cloudSyncJs, /no normalized Telegram recipients, using legacy fallback/);
  assert.match(teamSql, /member\.is_active and member\.status_notifications/);
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
});
