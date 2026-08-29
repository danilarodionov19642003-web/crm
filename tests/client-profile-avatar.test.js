'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
const clientsHtml = fs.readFileSync(path.join(root, 'pages/clients.html'), 'utf8');
const statusesHtml = fs.readFileSync(path.join(root, 'pages/statuses.html'), 'utf8');
const clientApp = fs.readFileSync(path.join(root, 'pages/client/client-app.js'), 'utf8');
const clientCss = fs.readFileSync(path.join(root, 'pages/client/client.css'), 'utf8');
const clientIndex = fs.readFileSync(path.join(root, 'pages/client/index.html'), 'utf8');

const noop = () => {};
const context = {
  console,
  Date,
  setTimeout,
  clearTimeout,
  CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  document: {
    addEventListener: noop,
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
    body: { appendChild: noop },
    createElement: () => ({ className: '', textContent: '', appendChild: noop, remove: noop })
  },
  window: { addEventListener: noop, dispatchEvent: noop }
};
context.window.window = context.window;
vm.createContext(context);
vm.runInContext(appSource, context);

const { Store } = context.window.App;
const client = {
  id: 'client-a46',
  code: 'A-46',
  name: 'Анна',
  platform: 'Профи.ру',
  ordered: 3,
  profileUrl: 'https://profi.ru/profile/BobryshevaAI3/',
  avatarUrl: 'https://cdn.profi.ru/xfiles/pfiles/bobrysheva.jpg'
};
Store.state = {
  clients: [client],
  mentors: [{ id: 'mentor-a46', code: 'a46', name: 'Старое имя' }],
  profiles: [],
  archivedProfiles: [],
  accountRegs: [],
  profileStatuses: [],
  reviews: [],
  income: []
};

const mentor = Store._ensureMentorForClient(client);
assert.equal(mentor.name, 'Анна');
assert.equal(mentor.profileUrl, client.profileUrl);
assert.equal(mentor.avatarUrl, client.avatarUrl);

const snapshot = Store._buildAnketaSnapshot('mentor-a46');
assert.equal(snapshot.profileUrl, client.profileUrl);
assert.equal(snapshot.avatarUrl, client.avatarUrl);

assert.match(clientsHtml, /profile-avatar\/resolve/);
assert.match(clientsHtml, /profile_name/);
assert.match(clientsHtml, /name: resolved\.profileName/);
assert.match(clientsHtml, /фотографию и имя/);
assert.match(clientsHtml, /resolvedName = resolved\.profileName \|\| enteredName/);
assert.match(clientsHtml, /name:\s+resolvedName/);
assert.match(clientsHtml, /id="profilePhotoModal"/);
assert.match(clientsHtml, /data-act="profile-photo"/);
assert.match(statusesHtml, /function mentorAvatar\(m\)/);
assert.match(statusesHtml, /class="stg__chip__avatar"/);
assert.match(clientApp, /function anketaAvatarHtml\(anketa/);
assert.match(clientApp, /anketaAvatarHtml\(e\.anketaData, 'is-calendar-event'\)/,
  'события выбранного дня должны показывать аватар анкеты вместо служебного смайлика');
assert.doesNotMatch(clientApp, /function renderFeed\(/,
  'неиспользуемый раздел последних действий должен быть удалён');
assert.doesNotMatch(clientIndex, /data-cli-feed|renderFeed/,
  'главная кабинета не должна загружать раздел последних действий');
assert.match(clientApp, /safeProfiProfileUrl/);
assert.match(clientCss, /\.cli-anketa-avatar/);
assert.match(clientCss, /\.cli-anketa-avatar\.is-calendar-event/);
assert.match(clientCss, /\.cli-detail-head/);
assert.match(clientApp, /cli-kpis cli-profile-money-kpis/);
assert.match(clientApp, /Оплачено \/ Остаток/,
  'оплата и остаток должны занимать одну финансовую карточку');
assert.match(clientApp, /cli-kpi__money-divider/);
assert.match(clientApp, /Сделано \/ В работе/,
  'сводка должна объединять готовые и активные отклики в одной карточке');
assert.doesNotMatch(clientApp, /<div class="cli-kpi__label">Остаток<\/div>/,
  'денежный остаток не должен дублироваться в верхней сводке');
assert.match(clientCss, /\.cli-profile-money-kpis \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/,
  'финансовый ряд профиля должен состоять ровно из двух карточек');
assert.match(clientCss, /\.cli-summary-kpis \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
assert.match(clientCss, /\.cli-summary-kpis \.cli-kpi \{[\s\S]*min-height: 80px/,
  'карточки сводки должны быть такими же компактными, как платёжные CTA');
assert.match(clientCss, /@media \(max-width: 560px\) \{[\s\S]*\.cli-cta-row \{ flex-wrap: nowrap; gap: 8px; \}/,
  'кнопки покупки и доплаты должны оставаться рядом на телефоне');
assert.ok(
  clientIndex.indexOf('data-cli-calendar') < clientIndex.indexOf('data-cli-anketas'),
  'общий календарь должен находиться выше списка анкет'
);
assert.doesNotMatch(clientIndex, /cli-cols|cli-col--right/,
  'старый двухколоночный порядок не должен отправлять календарь вниз на телефоне');

console.log('client Profi profile avatars: OK');
