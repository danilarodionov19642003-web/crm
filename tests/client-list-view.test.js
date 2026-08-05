const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'pages', 'clients.html'), 'utf8');

assert.match(html, /data-cl-view="cards"/);
assert.match(html, /data-cl-view="list"/);
assert.match(html, /const CLIENT_VIEW_KEY = 'mentori-clients-view'/);
assert.match(html, /localStorage\.setItem\(CLIENT_VIEW_KEY, clientView\)/);
assert.match(html, /clientView === 'list'\s*\? listHeaderHtml\(\) \+ rows\.map\(r => listRowHtml\(r\)\)\.join\(''\)/);
assert.match(html, /class="cl-list__row[^"`]*" data-client-row data-id=/);
assert.match(html, /querySelectorAll\('#clCards \[data-client-row\]'\)/);

for (const field of ['name', 'customer', 'manager', 'tariff', 'platform', 'niche', 'weeklyPace', 'ordered', 'paid', 'remain', 'date', 'deadline']) {
  const listSource = html.slice(html.indexOf('function listRowHtml'), html.indexOf('function countReviewsForClient'));
  assert.match(listSource, new RegExp(`data-field="${field}"`), `list view must keep ${field} editable`);
}

assert.match(html, /@media \(max-width: 900px\)[\s\S]*?\.cl-list__head \{ display: none; \}/);
assert.match(html, /\.cl-page-actions \{ width: 100%; justify-content: flex-start; \}/);

console.log('client cards/list view: OK');
