const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const migration = read('sql/migrations/2026-09-02_client_review_text_replacement.sql');
const patch = read('ops/telegram/patches/client-review-text-replacement.patch');
const statuses = read('pages/statuses.html');
const reviews = read('pages/reviews.html');
const app = read('js/app.js');
const approvals = read('js/client-text-approvals.js');
const patchReadme = read('ops/telegram/patches/README.md');

test('Telegram replacement is atomic, exact and recoverable', () => {
  assert.match(migration, /v_decision not in \('approved', 'changes_requested', 'replacement'\)/);
  assert.match(migration, /where id = p_request_id\s+for update/);
  assert.match(migration, /from public\.crm_state\s+where id = 'main'\s+for update/);
  assert.match(migration, /where item ->> 'id' = v_request\.source_review_id/);
  assert.match(migration, /v_review ->> 'mentorId' is distinct from v_request\.mentor_id/);
  assert.match(migration, /v_review ->> 'profileId' is distinct from v_request\.source_profile_id/);
  assert.match(migration, /insert into public\.crm_state_history/);
  assert.match(migration, /client_review_text_replacement:/);
  assert.match(migration, /'text', v_replacement/);
  assert.match(migration, /body = case when v_decision = 'replacement' then v_replacement else body end/);
  assert.match(migration, /request_status = case when v_decision = 'replacement' then 'approved'/);
  assert.match(migration, /client_replacement_body/);
  assert.match(migration, /text_approval_resolved/);
});

test('bot accepts a full free-form alternative and preserves old buttons', () => {
  assert.match(patch, /Нет, пришлю свой вариант/);
  assert.match(patch, /callback_data=f"ctxt:r:\{request_id\}"/);
  assert.match(patch, /parts\[1\] in \("r", "c"\)/);
  assert.match(patch, /TextApprovalFSM\.awaiting_replacement/);
  assert.match(patch, /decision="replacement"/);
  assert.match(patch, /len\(replacement\) > 3000/);
  assert.match(patch, /Ваш вариант сохранён как согласованный текст отзыва/);
  assert.match(patchReadme, /client-review-text-replacement\.patch/);
});

test('an existing CRM review can be corrected without creating a duplicate', () => {
  assert.match(app, /updateReviewText\(id, text, metadata = \{\}\)/);
  assert.match(statuses, /id="chgExistingReviewText" class="input chg-review-text"/);
  assert.match(statuses, /\.chg-review-text\s*\{[^}]*width:\s*100%/s);
  assert.match(statuses, /Изменённый текст уже согласован вне кабинета/);
  assert.match(statuses, /Store\.updateReviewText\(existingReview\.id, editedExistingText/);
  assert.match(statuses, /published_correction/);
  assert.match(statuses, /sendReviewInBackground\(existingReview\)/);
  assert.match(statuses, /clientApprovalPreconfirmed: treatedAsPreapproved/);
  assert.match(approvals, /Клиент прислал свой текст/);
  assert.match(reviews, /approval\.client_replacement_body \|\| r\.text/);
  assert.doesNotMatch(statuses, /Store\.addReview\([^)]*editedExistingText/);
});
