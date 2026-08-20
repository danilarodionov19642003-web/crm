const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const teamSql = read('sql/migrations/2026-08-20_client_portal_telegram_team.sql');
const approvalSql = read('sql/migrations/2026-08-20_client_text_approvals.sql');
const settingsJs = read('pages/client/client-settings.js');
const approvalJs = read('js/client-text-approvals.js');
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
  assert.match(approvalJs, /create_client_text_approval/);
  assert.match(approvalJs, /cancel_client_text_approval/);
  assert.match(approvalJs, /Согласует:/);
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
