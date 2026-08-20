'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
function htmlFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => path.join(dir, entry.name));
}

const pages = [
  path.join(root, 'index.html'),
  ...htmlFiles(path.join(root, 'legal')),
  ...htmlFiles(path.join(root, 'pages')),
  ...htmlFiles(path.join(root, 'pages', 'client')),
  ...htmlFiles(path.join(root, 'pages', 'employee'))
];
assert.ok(pages.length > 0, 'HTML-страницы CRM не найдены');

pages.forEach((file) => {
  const source = fs.readFileSync(file, 'utf8');
  assert.match(source, /rel="icon"[^>]+favicon-32\.png/,
    `${path.relative(root, file)}: отсутствует favicon`);
  assert.match(source, /rel="apple-touch-icon"[^>]+apple-touch-icon\.png/,
    `${path.relative(root, file)}: отсутствует иконка ярлыка iPhone`);
  assert.match(source, /rel="manifest"/,
    `${path.relative(root, file)}: отсутствует web app manifest`);
});

const adminManifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
const clientManifest = JSON.parse(fs.readFileSync(path.join(root, 'pages', 'client', 'manifest.webmanifest'), 'utf8'));

assert.equal(adminManifest.start_url, '/', 'ярлык CRM должен открывать административный вход');
assert.equal(clientManifest.start_url, '/pages/client/login.html',
  'ярлык клиента должен открывать клиентский вход');
assert.equal(clientManifest.scope, '/pages/client/', 'клиентский ярлык должен оставаться в своём разделе');

[
  'favicon.ico',
  'assets/icons/favicon-32.png',
  'assets/icons/apple-touch-icon.png',
  'assets/icons/mentori-crm-icon-192.png',
  'assets/icons/mentori-crm-icon-512.png'
].forEach((relativePath) => {
  const stat = fs.statSync(path.join(root, relativePath));
  assert.ok(stat.size > 500, `${relativePath}: файл иконки пуст или повреждён`);
});

console.log('app icons and manifests: OK');
