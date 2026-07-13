const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const clientApp = read('pages/client/client-app.js');
const clientIndex = read('pages/client/index.html');
const clientCss = read('pages/client/client.css');
const crmApp = read('js/app.js');

assert.doesNotMatch(clientApp, /_reqRows|_reqBlockHtml|_bindCopyButtons|pay\.requisites|Реквизиты для оплаты/);
assert.doesNotMatch(clientIndex, /реквизит/i);
assert.doesNotMatch(clientCss, /\.cli-req-/);
assert.doesNotMatch(crmApp, /requisites:\s*\(this\.state\.paymentSettings/);
assert.match(clientApp, /if \(!tariffs\.length\)/);

console.log('client payment UI without requisites: OK');
