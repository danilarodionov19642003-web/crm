const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const offer = read('legal/offer.html');
const app = read('pages/client/client-app.js');
const legalContent = read('pages/client/legal-content.js');
const clients = read('pages/clients.html');
const crmApp = read('js/app.js');

assert.match(offer, /Редакция 2 от 13 июля 2026 года/);
assert.match(offer, /оплаченные суммы после акцепта заказа возврату не подлежат/);
assert.match(offer, /не предоставляет Заказчику внутренние калькуляции/);
assert.match(offer, /Обязательные права потребителя не ограничиваются/);
assert.equal((offer.match(/<h2>/g) || []).length, 11, 'в оферте должно быть 11 разделов');

assert.match(app, /fetch\('\.\.\/\.\.\/legal\/offer\.html\?v=20260713d'/);
assert.match(app, /offer_text: offerText/);
assert.doesNotMatch(app, /LEGAL\.offerText|pay\.offerText/);
assert.doesNotMatch(legalContent, /offerText|возврату не подлежат/);
assert.doesNotMatch(clients, /id="reqOffer"|safeAdditionalTerms|OFFER_DRAFT/);
assert.doesNotMatch(clients, /offerText/);
assert.match(crmApp, /delete ps\.offerText/);
assert.doesNotMatch(crmApp, /paymentSettings\.offerText/);

console.log('legal offer consistency: OK');
