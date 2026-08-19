'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'pages', 'client-access.html'), 'utf8');

assert.match(html, /\.cp-mentors\s*\{[\s\S]*?flex-direction:\s*column;/);
assert.match(html, /\.cp-mentors\s*\{[\s\S]*?flex-wrap:\s*nowrap;/);
assert.match(html, /\.cp-mentors\s*\{[\s\S]*?overflow-x:\s*hidden;/);
assert.match(html, /\.cp-mentors\s*\{[\s\S]*?overflow-y:\s*auto;/);
assert.match(html, /id="cpMentors" class="cp-mentors"/);
assert.doesNotMatch(html, /id="cpMentors"[^>]*flex-wrap:\s*wrap/);
assert.match(html, /\.sort\(\(a, b\) => compareClientCodes\(a\.code, b\.code\)\)/);
assert.match(html, /@media \(max-width: 640px\)[\s\S]*?\.cp-mentor-fields\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/);

console.log('client access mentor list: OK');
