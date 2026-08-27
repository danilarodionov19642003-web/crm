const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const migration = read(
  'sql/migrations/2026-08-27_client_text_approval_message_cleanup.sql'
);
const botPatch = read(
  'ops/telegram/patches/client-text-approval-message-cleanup.patch'
);
const patchReadme = read('ops/telegram/patches/README.md');

function assertUnifiedPatchHunksAreBalanced(source) {
  let expectedOld = null;
  let expectedNew = null;
  let actualOld = 0;
  let actualNew = 0;
  const finish = () => {
    if (expectedOld === null) return;
    assert.equal(actualOld, expectedOld, 'old-side hunk length is corrupt');
    assert.equal(actualNew, expectedNew, 'new-side hunk length is corrupt');
  };
  for (const line of source.split('\n')) {
    const header = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
    if (header) {
      finish();
      expectedOld = Number(header[1] || 1);
      expectedNew = Number(header[2] || 1);
      actualOld = 0;
      actualNew = 0;
      continue;
    }
    if (expectedOld === null || line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (line.startsWith(' ')) { actualOld += 1; actualNew += 1; }
    else if (line.startsWith('-')) actualOld += 1;
    else if (line.startsWith('+')) actualNew += 1;
  }
  finish();
}

test('approval Telegram deliveries retain an exact, private message identity', () => {
  assert.match(migration, /create table if not exists public\.client_telegram_message_deliveries/);
  assert.match(migration, /telegram_chat_id bigint not null/);
  assert.match(migration, /telegram_message_id bigint not null/);
  assert.match(migration, /unique \(telegram_chat_id, telegram_message_id\)/);
  assert.match(migration, /delivery_status in \('active', 'delete_pending', 'deleted', 'compacted', 'delete_failed'\)/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on public\.client_telegram_message_deliveries from public, anon, authenticated/);
  assert.match(migration, /grant all on public\.client_telegram_message_deliveries to service_role/);
});

test('delivery recording handles Mini App resolution racing Telegram sendMessage', () => {
  assert.match(migration, /record_client_text_approval_telegram_delivery/);
  assert.match(migration, /auth\.role\(\) <> 'service_role'/);
  assert.match(migration, /TELEGRAM_CHAT_MISMATCH/);
  assert.match(migration, /where id = v_request_id\s+for update/);
  assert.match(migration, /TEXT_APPROVAL_REQUEST_NOT_FOUND/);
  assert.match(migration, /Keep the lock order request -> outbox/);
  assert.match(migration, /v_should_delete := v_request_status is distinct from 'pending'/);
  assert.match(migration, /case when v_should_delete then 'delete_pending' else 'active' end/);
  assert.match(migration, /when v_should_delete then 'skipped'[\s\S]*else 'sent'/);
  assert.match(migration, /on conflict \(telegram_chat_id, telegram_message_id\) do update/);
  assert.match(migration, /if v_delivery\.delivered_audit_at is null then/);
  assert.match(migration, /set delivered_audit_at = now\(\)/);
});

test('every terminal approval decision queues deletion idempotently', () => {
  assert.match(migration, /old\.request_status = 'pending' and new\.request_status <> 'pending'/);
  assert.match(migration, /delivery_status = 'delete_pending'/);
  assert.match(migration, /delivery_status in \('active', 'delete_failed'\)/);
  assert.match(migration, /text_approval_message_delete_queued/);
  assert.match(migration, /after update of request_status on public\.client_text_approval_requests/);
  assert.doesNotMatch(migration, /delete from public\.notification_outbox/);
  assert.doesNotMatch(migration, /delete from public\.client_text_approval_requests/);
});

test('delete completion has valid CASE assignment and audited retry states', () => {
  assert.match(
    migration,
    /set delivery_status = case[\s\S]*else 'delete_pending'\s+end,\s+delete_attempts = delete_attempts \+ 1/
  );
  assert.doesNotMatch(migration, /end,\s+end,\s+delete_attempts/);
  assert.match(migration, /when coalesce\(p_final, false\) then 'delete_failed'/);
  assert.match(migration, /text_approval_message_deleted/);
  assert.match(migration, /text_approval_message_compacted/);
  assert.match(migration, /text_approval_message_delete_failed/);
  assert.match(migration, /telegram_message_id', v_delivery\.telegram_message_id/);
});

test('notifier records sendMessage result and deletes only the tracked message', () => {
  assert.match(botPatch, /telegram_message\.get\("message_id"\)/);
  assert.match(botPatch, /result_chat\.get\("id"\)/);
  assert.match(botPatch, /record_client_text_approval_telegram_delivery/);
  assert.match(botPatch, /approval\.get\("request_status"\) != "pending"/);
  assert.match(botPatch, /delete_order_status_message\(chat_id, message_id\)/);
  assert.match(botPatch, /_bot_api_url\("deleteMessage"\)/);
  assert.match(botPatch, /payload = \{"chat_id": int\(chat_id\), "message_id": int\(message_id\)\}/);
  assert.match(botPatch, /complete_client_telegram_message_deletion/);
  assert.match(botPatch, /message to delete not found/);
  assert.match(botPatch, /delete_attempts,resolution_status/);
  assert.match(botPatch, /compact_order_status_message/);
  assert.match(botPatch, /✅ <b>Текст согласован<\/b>/);
  assert.match(botPatch, /✏️ <b>Запрошены правки<\/b>/);
  assert.match(botPatch, /_bot_api_url\("editMessageText"\)/);
  assert.match(botPatch, /"reply_markup": \{"inline_keyboard": \[\]\}/);
  assert.match(botPatch, /deletions = await _fetch_pending_message_deletions/);
  assert.equal(
    (botPatch.match(/deletions = await _fetch_pending_message_deletions/g) || []).length,
    1
  );
});

test('a delivered message is removed if recording its identity fails', () => {
  assert.match(botPatch, /for _attempt in range\(2\)/);
  assert.match(
    botPatch,
    /except Exception:[\s\S]*sendMessage succeeded[\s\S]*delete_order_status_message\([\s\S]*telegram_message\["chat"\]\["id"\][\s\S]*telegram_message\["message_id"\]/
  );
  assert.match(botPatch, /approval message sent but could not be recorded or deleted/);
});

test('cleanup bot patch stays after notification copy and before onboarding reminder', () => {
  const passwordlessIndex = patchReadme.indexOf('`client-passwordless-login-settings.patch` adds');
  const cleanupIndex = patchReadme.indexOf('`client-text-approval-message-cleanup.patch` records');
  const reminderIndex = patchReadme.indexOf('`client-schedule-onboarding-reminder.patch` sends');
  assert.ok(passwordlessIndex >= 0 && cleanupIndex > passwordlessIndex && reminderIndex > cleanupIndex);
  assert.match(patchReadme, /Apply it after `client-notification-copy\.patch`/);
  assert.match(patchReadme, /2026-08-27_client_text_approval_message_cleanup\.sql/);
});

test('maintained cleanup patch has valid unified-diff hunk lengths', () => {
  assertUnifiedPatchHunksAreBalanced(botPatch);
});
