const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const botPatch = read('ops/telegram/patches/client-referrals.patch');
const migration = read('sql/migrations/2026-08-20_client_referrals.sql');

test('bot handles referral links before ordinary start routing', () => {
  const referralIndex = botPatch.indexOf('arg.startswith("ref_")');
  assert.ok(referralIndex >= 0);
  assert.match(botPatch, /@@ -985,0 \+986,39 @@/);
  assert.match(botPatch, /await client_ui\.entry_start\(m, bot, state\)[\s\S]*return/);
  assert.match(botPatch, /register_client_referral/);
  assert.match(botPatch, /один отзыв в подарок/);
});

test('bonus is reserved, released on a failed CRM update and completed once', () => {
  assert.match(botPatch, /reserve_client_referral_bonus/);
  assert.match(botPatch, /release_client_referral_bonus/);
  assert.match(botPatch, /complete_client_referral_bonus/);
  assert.match(migration, /bonus_order_id bigint unique/);
  assert.match(migration, /on conflict \(parent_order_id, parent_item_id\)/);
});

test('referral patch does not add direct CRM blob writes', () => {
  assert.doesNotMatch(botPatch, /(?:patch|post)\([^\n]*crm_state/i);
  assert.doesNotMatch(migration, /update\s+public\.crm_state/i);
});
