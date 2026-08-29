'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const dashboard = read('pages/dashboard.html');
const statuses = read('pages/statuses.html');

assert.doesNotMatch(dashboard, /Telegram-рассыльщик/);
assert.doesNotMatch(dashboard, /Заявки из @MentoriTG_bot/);
assert.doesNotMatch(dashboard, /Аккаунты рассыльщика/);
assert.doesNotMatch(dashboard, /bot-stats\.js/);

assert.match(statuses, /id="btnScrollAccountsEnd"/);
assert.match(statuses, /id="btnRefreshIpQuick"/);
assert.match(statuses, /class="accounts-jump accounts-jump--ip"/);
assert.match(statuses, /Store\.state\.proxyLinks/);
assert.match(statuses, /Promise\.allSettled\(links\.map\(proxy =>/);
assert.match(statuses, /fetch\(proxy\.url, \{ method: 'GET', mode: 'no-cors', cache: 'no-store' \}\)/);
assert.match(statuses, /id="addAccountCard"/);
assert.match(statuses, /data-act="new-account"/);
assert.match(statuses, /scrollIntoView\(\{ behavior: 'smooth', block: 'center' \}\)/);
assert.doesNotMatch(statuses, /id="btnNewMentor"/);

console.log('dashboard cleanup and account controls: OK');
