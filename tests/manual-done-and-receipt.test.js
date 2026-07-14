const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const crmApp = read('js/app.js');
const clients = read('pages/clients.html');
const clientApp = read('pages/client/client-app.js');

assert.match(crmApp, /Math\.max\(realDone, Number\(client && client\.manualDone\) \|\| 0\)/);
assert.match(clients, /Math\.max\(realDone, Number\(client\.manualDone\) \|\| 0\)/);
assert.match(clientApp, /confirmed_at,receipt_url,offer_agreed/);
assert.match(clientApp, /class="cli-order__receipt"/);
assert.match(clientApp, />Открыть чек<\/a>/);

console.log('manual done override and client receipt link: OK');
