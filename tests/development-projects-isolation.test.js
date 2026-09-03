const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const page = read('pages/projects.html');
const script = read('js/projects.js');
const sidebar = read('components/sidebar.js');
const migration = read('sql/migrations/2026-09-01_development_projects.sql');
const paymentMigration = read('sql/migrations/2026-09-03_development_project_income_links.sql');
const finance = read('pages/finance.html');
const app = read('js/app.js');

test('projects are an owner-only standalone section', () => {
  assert.match(sidebar, /id: 'projects'[\s\S]*ownerOnly: true/);
  assert.match(page, /data-active="projects"/);
  assert.match(page, /js\/projects\.js/);
  assert.doesNotMatch(page, /js\/app\.js|cloud-sync\.js|reviews-sync\.js|accounts-sync\.js/);
  assert.doesNotMatch(script, /window\.App|Store\.state|crm_state/);
});

test('development storage is normalized and does not touch mentoring data', () => {
  assert.match(migration, /create table if not exists public\.development_projects/);
  assert.match(migration, /create table if not exists public\.development_project_activity/);
  assert.match(migration, /create table if not exists public\.development_project_resources/);
  assert.match(migration, /app_metadata'[\s\S]*role'[\s\S]*= 'owner'/);
  assert.doesNotMatch(migration, /(?:update|insert into|delete from|references)\s+public\.(?:crm_state|clients|reviews|tasks|subscriptions)/i);
});

test('project resources deliberately have no password or secret field', () => {
  const resourceTable = migration.split('create table if not exists public.development_project_resources')[1].split(');')[0];
  assert.match(resourceTable, /login text/);
  assert.match(resourceTable, /notes text/);
  assert.doesNotMatch(resourceTable, /password|secret|token/i);
  assert.match(page, /Сам пароль сюда не записывайте/);
});

test('projects link to global income without duplicating finance records', () => {
  assert.match(migration, /contract_amount numeric/);
  assert.match(migration, /received_amount numeric/);
  assert.match(migration, /expense_amount numeric/);
  assert.match(paymentMigration, /create table if not exists public\.development_project_income_links/);
  assert.match(paymentMigration, /income_id text primary key/);
  assert.match(paymentMigration, /project_id uuid not null references public\.development_projects/);
  assert.match(paymentMigration, /create or replace function public\.list_development_project_payments/);
  assert.match(paymentMigration, /auth\.jwt\(\)[\s\S]*app_metadata[\s\S]*role[\s\S]*owner/);
  assert.match(paymentMigration, /jsonb_array_elements[\s\S]*state\.data -> 'income'/);
  assert.match(script, /rpc\/list_development_project_payments/);
  assert.match(script, /Из финансов:/);
  assert.match(script, /Добавить платёж/);
  assert.match(finance, /id="iProject"/);
  assert.match(finance, /development_project_income_links/);
  assert.match(finance, /data-project-link/);
  assert.doesNotMatch(script, /addIncome|addExpense|income\.push|expenses\.push/);
});

test('development revenue has explicit service categories', () => {
  assert.match(app, /'Разработка CRM'/);
  assert.match(app, /'Telegram Mini App'/);
  assert.match(app, /'Разработка сайта'/);
  assert.match(app, /'Продажа анкеты'/);
});

test('finance page scripts remain valid after project-link controls', () => {
  const inlineScripts = [...finance.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1].trim())
    .filter(Boolean);
  assert.ok(inlineScripts.length > 0);
  inlineScripts.forEach(code => assert.doesNotThrow(() => new vm.Script(code)));
});
