const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('pages/client/telegram-calendar.html');
const js = read('pages/client/telegram-calendar.js');
const css = read('pages/client/telegram-calendar.css');
const sql = read('sql/migrations/2026-08-26_client_telegram_calendar.sql');

test('Telegram calendar uses short-lived hashed tokens without portal password', () => {
  assert.match(sql, /token_hash bytea not null unique/);
  assert.match(sql, /digest\(v_token, 'sha256'\)/);
  assert.match(sql, /interval '30 minutes'/);
  assert.match(sql, /TOKEN_INVALID_OR_EXPIRED/);
  assert.doesNotMatch(sql, /update\s+public\.crm_state/i);
  assert.doesNotMatch(js, /signIn|password|localStorage/);
});

test('Telegram calendar reads capacity and schedules through bounded RPCs', () => {
  assert.match(sql, /get_client_telegram_calendar/);
  assert.match(sql, /manage_client_telegram_outreach_slot/);
  assert.match(sql, /p_target_date < current_date \+ 1/);
  assert.match(sql, /v_used >= 7/);
  assert.match(sql, /SCHEDULE_LIMIT_REACHED/);
  assert.match(js, /get_client_telegram_calendar/);
  assert.match(js, /manage_client_telegram_outreach_slot/);
  assert.match(js, /data-cancel-slot/);
});

test('Mini App renders a compact mobile calendar and initializes Telegram WebApp', () => {
  assert.match(html, /telegram\.org\/js\/telegram-web-app\.js/);
  assert.match(js, /Telegram\.WebApp/);
  assert.match(js, /tg\.expand\(\)/);
  assert.match(css, /grid-template-columns: repeat\(7/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
});
