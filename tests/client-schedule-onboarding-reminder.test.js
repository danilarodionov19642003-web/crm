'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const patch = fs.readFileSync(
  path.join(root, 'ops/telegram/patches/client-schedule-onboarding-reminder.patch'),
  'utf8'
);
const readme = fs.readFileSync(path.join(root, 'ops/telegram/patches/README.md'), 'utf8');

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

test('newly linked clients receive one schedule onboarding reminder', () => {
  const prepareIndex = patch.indexOf('await _prepare_client_miniapp_access(m, bot, force=True)');
  const reminderIndex = patch.indexOf('📅 <b>Проверьте график откликов</b>');
  const returnIndex = patch.indexOf('return');
  assert.ok(prepareIndex >= 0 && reminderIndex > prepareIndex && returnIndex > reminderIndex);
  assert.match(patch, /предварительные даты/);
  assert.match(patch, /каждую активную анкету/);
  assert.match(patch, /оставьте удобные даты/);
  assert.match(patch, /перенесите неподходящие/);
  assert.match(patch, /отмените даты/);
  assert.match(patch, /кнопки «Кабинет»/);
  assert.match(patch, /reply_markup=client_ui\.kb_client_root\(\)/);
  assert.doesNotMatch(patch, /crm_state|notification_outbox|send_my_schedule/);
});

test('schedule reminder remains the last maintained bot patch', () => {
  const cleanupIndex = readme.indexOf('`client-text-approval-message-cleanup.patch` records');
  const reminderIndex = readme.indexOf('`client-schedule-onboarding-reminder.patch` sends');
  assert.ok(cleanupIndex >= 0 && reminderIndex > cleanupIndex);
  assert.match(readme, /Apply it last, after\s+`client-text-approval-message-cleanup\.patch`/);
});

test('schedule onboarding patch has valid unified-diff hunk lengths', () => {
  assertUnifiedPatchHunksAreBalanced(patch);
});
