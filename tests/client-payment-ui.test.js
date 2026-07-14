const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const clientApp = read('pages/client/client-app.js');
const clientIndex = read('pages/client/index.html');
const clientCss = read('pages/client/client.css');
const crmApp = read('js/app.js');
const crmClients = read('pages/clients.html');

assert.doesNotMatch(clientApp, /_reqRows|_reqBlockHtml|_bindCopyButtons|pay\.requisites|Реквизиты для оплаты/);
assert.doesNotMatch(clientIndex, /реквизит/i);
assert.doesNotMatch(clientCss, /\.cli-req-/);
assert.doesNotMatch(crmApp, /requisites:\s*\(this\.state\.paymentSettings/);
assert.match(clientApp, /if \(!tariffs\.length\)/);
assert.match(clientApp, /const PAYMENTS_API = 'https:\/\/mentori\.tech\/api\/payments'/);
assert.match(clientApp, /startPayment\(order\.id, btn, result\)/);
assert.match(clientApp, /Prefer': 'return=representation'/);
assert.match(clientApp, /data-pay-order/);
assert.match(clientApp, /const fullOnly = curTariff\(\)\.fullOnly === true/);
assert.match(clientApp, /halfPay\.disabled = fullOnly/);
assert.match(crmApp, /paymentTariffs\.concat\(privateTariffs\)/);
assert.doesNotMatch(clientApp, /id="ordReceipt"|id="remainReceipt"/);
assert.doesNotMatch(clientApp, /id="ordSubmit">Я оплатил|id="remainSubmit">Я оплатил/);
assert.match(crmClients, /const canConfirm = o\.status === 'new' && \(!onlinePayment \|\| onlinePaid\)/);
assert.match(crmClients, /const canDelete = !onlinePayment/);
assert.match(crmClients, /const canReject = o\.status === 'new' && !onlineActive && !onlinePaid/);

console.log('client payment UI without requisites: OK');
