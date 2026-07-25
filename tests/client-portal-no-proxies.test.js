const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const files = [
  'pages/client/index.html',
  'pages/client/client-app.js',
  'pages/client/client.css',
  'assets/website/client-cabinet-demo.html'
];

for (const relativePath of files) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  assert.doesNotMatch(
    source,
    /client_proxies|renderProxies|data-cli-proxies|Прокси для Telegram|Показать прокси/,
    `${relativePath} must not contain the retired Telegram proxy block`
  );
}

console.log('client portal proxy block removed: OK');
