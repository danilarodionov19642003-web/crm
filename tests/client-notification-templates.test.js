'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
const noop = () => {};
let statusPayload = null;
let progressPayload = null;
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
  window: {
    addEventListener: noop,
    dispatchEvent: noop,
    CloudSync: {
      queueClientTelegramNotification: row => {
        statusPayload = row;
        return Promise.resolve(true);
      },
      queueClientProgressNotification: row => {
        progressPayload = row;
        return Promise.resolve(true);
      }
    }
  }
};
context.window.window = context.window;
vm.createContext(context);
vm.runInContext(source, context);

const { Store, STATUS_SELECT, STATUS_CHOSEN, STATUS_READY } = context.window.App;

function baseState(ordered, readyCount) {
  const reviews = [];
  const profileStatuses = [];
  const profiles = [];
  const accountRegs = [];
  for (let index = 1; index <= readyCount; index += 1) {
    const profileId = `p${index}`;
    profiles.push({ id: profileId, code: `22-${index}` });
    accountRegs.push({ profileId, ownerName: index === 1 ? 'Дарья <тест>' : `Аккаунт ${index}` });
    reviews.push({
      id: `r${index}`,
      mentorId: 'm37',
      profileId,
      moderation: 'approved',
      moderatedBy: 'owner@test.com'
    });
    profileStatuses.push({ mentorId: 'm37', profileId, status: STATUS_READY });
  }
  return {
    clients: [{ id: 'c37', code: 'A37', ordered }],
    mentors: [{ id: 'm37', code: 'A37', name: 'Александр <тест>' }],
    profiles,
    archivedProfiles: [],
    accountRegs,
    reviews,
    profileStatuses,
    clientPortals: [{ email: 'client@test.com', mentorIds: ['m37'] }]
  };
}

test('selected status has a dedicated escaped Telegram card', () => {
  Store.state = baseState(3, 1);
  Store._queueStatusNotification(
    'm37', 'p1', STATUS_CHOSEN, STATUS_SELECT,
    'Комментарий <важно>', false
  );

  assert.equal(statusPayload.kind, 'status_change');
  assert.match(statusPayload.message, /^🏆 <b>АККАУНТ ВЫБРАН<\/b>/);
  assert.match(statusPayload.message, /📋 <b>Анкета:<\/b> A37 · Александр &lt;тест&gt;/);
  assert.match(statusPayload.message, /👤 <b>Аккаунт:<\/b> Дарья &lt;тест&gt;/);
  assert.match(statusPayload.message, /⭐ Выбрать → 🏆 Выбран/);
  assert.match(statusPayload.message, /<blockquote>Комментарий &lt;важно&gt;<\/blockquote>/);
});

test('published, one-left and completed package cards have distinct headings', () => {
  Store.state = baseState(3, 1);
  Store._queueClientProgressNotification(Store.state.reviews[0]);
  assert.equal(progressPayload.kind, 'review_published');
  assert.match(progressPayload.message, /^✅ <b>ОТЗЫВ ОПУБЛИКОВАН<\/b>/);
  assert.match(progressPayload.message, /Осталось в пакете:<\/b> 2/);

  Store.state = baseState(3, 2);
  Store._queueClientProgressNotification(Store.state.reviews[1]);
  assert.equal(progressPayload.kind, 'low_reviews');
  assert.match(progressPayload.message, /^🔥 <b>ОСТАЛСЯ ПОСЛЕДНИЙ ОТЗЫВ<\/b>/);
  assert.match(progressPayload.message, /В пакете остался 1 отзыв/);

  Store.state = baseState(3, 3);
  Store._queueClientProgressNotification(Store.state.reviews[2]);
  assert.equal(progressPayload.kind, 'order_completed');
  assert.match(progressPayload.message, /^🎉 <b>ПАКЕТ ВЫПОЛНЕН<\/b>/);
  assert.match(progressPayload.message, /Работа по пакету завершена/);
});
