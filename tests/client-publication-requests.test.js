'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
const clientApp = fs.readFileSync(path.join(root, 'pages/client/client-app.js'), 'utf8');
const clientIndex = fs.readFileSync(path.join(root, 'pages/client/index.html'), 'utf8');
const profileHtml = fs.readFileSync(path.join(root, 'pages/client/profile.html'), 'utf8');
const tasksHtml = fs.readFileSync(path.join(root, 'pages/tasks.html'), 'utf8');
const migration = fs.readFileSync(
  path.join(root, 'sql/migrations/2026-08-20_client_publication_requests.sql'),
  'utf8'
);
const hardeningMigration = fs.readFileSync(
  path.join(root, 'sql/migrations/2026-08-20_client_planning_hardening.sql'),
  'utf8'
);
const minimumMigration = fs.readFileSync(
  path.join(root, 'sql/migrations/2026-08-20_client_publication_minimum.sql'),
  'utf8'
);
const nextStatusMigration = fs.readFileSync(
  path.join(root, 'sql/migrations/2026-09-01_client_next_status_planning.sql'),
  'utf8'
);
const staffPlanVisibilityMigration = fs.readFileSync(
  path.join(root, 'sql/migrations/2026-09-01_staff_status_plans_client_visibility.sql'),
  'utf8'
);
const telegramPatch = fs.readFileSync(
  path.join(root, 'ops/telegram/patches/client-publication-approval.patch'),
  'utf8'
);

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

const { Store, STATUS_CHOSEN } = context.window.App;
Store.state = {
  mentors: [{ id: 'mentor-a21', code: 'a21', name: 'Столичный уют' }],
  clients: [{ id: 'client-a21', code: 'a21', name: 'Столичный уют', ordered: 2, niche: 'remont', closed: true }],
  nicheConfig: {
    remont: { label: 'Ремонт квартир', daysToPublish: 30, clientMinPublicationDays: 20 }
  },
  profiles: [{ id: 'profile-1', code: '8-8' }, { id: 'profile-2', code: '8-9' }],
  archivedProfiles: [],
  accountRegs: [
    { id: 'reg-1', profileId: 'profile-1', ownerName: 'Александр' },
    { id: 'reg-2', profileId: 'profile-2', ownerName: 'Ольга' }
  ],
  profileStatuses: [
    {
      id: 'status-1', mentorId: 'mentor-a21', profileId: 'profile-1',
      status: STATUS_CHOSEN, date: '2026-06-15', history: []
    },
    {
      id: 'status-2', mentorId: 'mentor-a21', profileId: 'profile-2',
      status: '🎯 Опубликован', date: '2026-07-30', history: []
    }
  ],
  reviews: [{
    id: 'review-2', mentorId: 'mentor-a21', profileId: 'profile-2',
    moderation: 'approved', submittedAt: '2026-07-30T12:00:00Z'
  }],
  income: []
};
const snapshot = Store._buildAnketaSnapshot('mentor-a21');
assert.equal(snapshot.statuses[0].id, 'status-1');
assert.equal(snapshot.statuses[0].mentorId, 'mentor-a21');
assert.equal(snapshot.statuses[0].profileId, 'profile-1');
assert.equal(snapshot.statuses[0].profileName, 'Александр');
assert.equal(snapshot.reviews[0].profileId, 'profile-2');
assert.equal(snapshot.reviews[0].profileName, 'Ольга');
assert.equal(snapshot.niche, 'remont');
assert.equal(snapshot.publicationWaitDays, 20);
assert.equal(snapshot.closed, true, 'закрытая CRM-анкета должна попасть в завершённые кабинета');

assert.match(migration, /security definer/i);
assert.match(migration, /client_snapshots/);
assert.match(migration, /s\.item ->> 'status' = '🏆 Выбран'/);
assert.match(migration, /p_requested_date < current_date/);
assert.match(migration, /p_requested_date > current_date \+ 180/);
assert.match(migration, /client_email = lower\(coalesce\(auth\.jwt\(\) ->> 'email'/);
assert.match(migration, /kind, message, status, mentor_id, profile_id, client_email/);
assert.doesNotMatch(migration, /grant insert on public\.client_publication_requests to authenticated/i,
  'клиент не получает прямой INSERT в таблицу запросов');

assert.match(hardeningMigration, /resolve_client_publication_request/);
assert.match(hardeningMigration, /from public\.crm_state[\s\S]*for update/i,
  'подтверждение должно блокировать текущий CRM-снимок');
assert.match(hardeningMigration, /insert into public\.crm_state_history/,
  'перед серверной правкой должен сохраняться восстановимый снимок');
assert.match(hardeningMigration, /jsonb_set\(status_list, array\[status_index::text\]/,
  'RPC должен менять только целевой статус');
assert.match(hardeningMigration, /revoke update on public\.client_publication_requests from authenticated/i,
  'прямое закрытие запроса без атомарной правки CRM должно быть запрещено');
assert.match(hardeningMigration, /action_ref/);

assert.match(minimumMigration, /client_publication_wait_days/);
assert.match(minimumMigration, /clientMinPublicationDays/);
assert.match(minimumMigration, /v_niche = 'remont'[\s\S]*v_wait := 20/);
assert.match(minimumMigration, /PUBLICATION_TOO_EARLY/);
assert.match(minimumMigration, /before insert or update of requested_date, request_status, status_date/i);

assert.match(nextStatusMigration, /add column if not exists current_status text/);
assert.match(nextStatusMigration, /add column if not exists target_status text/);
assert.match(nextStatusMigration, /when '💬 Начать диалог' then '✅ Обменяться'/);
assert.match(nextStatusMigration, /when '✅ Обменяться' then '⭐ Выбрать'/);
assert.match(nextStatusMigration, /when '⭐ Выбрать' then '🏆 Выбран'/);
assert.match(nextStatusMigration, /when '🏆 Выбран' then '🎯 Опубликован'/);
assert.match(nextStatusMigration, /status_row ->> 'status' <> request_row\.current_status/,
  'подтверждение должно отклонять устаревший запрос после смены статуса');
assert.match(nextStatusMigration, /'taskPlanSource', 'client'/,
  'подтверждённая дата должна сохранять источник планирования');
assert.match(nextStatusMigration, /Клиент выбрал дату следующего этапа/,
  'владельцу должно приходить уведомление о каждой клиентской дате');
assert.match(nextStatusMigration, /NEW\.current_status \|\| ' → ' \|\| NEW\.target_status/);
assert.match(nextStatusMigration, /not coalesce\(\(a\.item ->> 'closed'\)::boolean, false\)/,
  'закрытая анкета не должна принимать новые даты из веб-кабинета');
assert.match(nextStatusMigration, /not coalesce\(\(anketa\.item ->> 'closed'\)::boolean, false\)/,
  'закрытая анкета не должна принимать новые даты из Mini App');
assert.match(nextStatusMigration, /client_snapshots[\s\S]*raise exception 'STATUS_NOT_AVAILABLE'/,
  'ранее созданный запрос нельзя подтвердить после закрытия анкеты');

assert.match(clientApp, /function nextStatusTarget\(status\)/);
assert.match(clientApp, /'💬 Начать диалог': '✅ Обменяться'/);
assert.match(clientApp, /'✅ Обменяться': '⭐ Выбрать'/);
assert.match(clientApp, /'⭐ Выбрать': '🏆 Выбран'/);
assert.match(clientApp, /'🏆 Выбран': '🎯 Опубликован'/);
assert.match(clientApp, /function clientStatusFlow\(status\)/);
assert.match(clientApp, /'⭐ Выбрать': 'Выбрать специалиста'/);
assert.match(clientApp, /'🏆 Выбран': 'Специалист выбран'/);
assert.match(clientApp, /'🎯 Опубликован': 'Отзыв опубликован'/);
assert.match(clientApp, /Когда опубликовать отзыв\?/);
assert.match(clientApp, /Сейчас → дальше/,
  'клиент должен видеть текущий и следующий этап одной цепочкой');
assert.match(clientApp, /request_client_publication_date/);
assert.match(clientApp, /Ожидает подтверждения/);
assert.match(clientApp, /const isReadyStatus = status => status\.status === STATUS_DONE/);
assert.match(clientApp, /Опубликовано/);
assert.match(clientApp, /statusAge\(s\)/);
assert.match(clientApp, /nextStatusMinimumDate\(a, status\)/);
assert.match(clientApp, /data-publication-min/);
assert.match(clientApp, /data-publication-wait/);
assert.match(clientApp, /min="\$\{escapeAttr\(minimumDate\)\}"/);
assert.match(clientApp, /Минимальная дата публикации/);
assert.match(clientApp, /PUBLICATION_TOO_EARLY/);
assert.match(clientApp, /isCompletedAnketa\(a\) && !isReadyStatus\(status\)/,
  'в завершённой анкете статусы остаются видны, но дальнейшее планирование блокируется');
assert.match(clientApp, /Работа по анкете завершена/,
  'план откликов завершённой анкеты должен быть только для просмотра');
assert.match(profileHtml, /loadMyPublicationRequests/);
assert.match(clientApp, /request\.request_status === 'accepted'/);
assert.match(clientApp, /kind: 'status-plan'/);
assert.match(clientApp, /\? 'Запланирована публикация'/);
assert.match(clientApp, /Назначено менеджером/,
  'назначенная сотрудником дата должна иметь явную подпись в кабинете');
assert.match(clientApp, /canonicalPlanStatusIds/,
  'канонический план статуса должен подавлять устаревший accepted-запрос');
assert.match(clientIndex, /loadMyPublicationRequests\(\)/,
  'главный календарь клиента должен загружать подтверждённые публикации');
assert.match(clientIndex, /renderCalendar\(snap\.payload, outreachSlots, publicationRequests\)/,
  'подтверждённые публикации должны передаваться в календарь');

assert.match(tasksHtml, /client_publication_request/);
assert.match(tasksHtml, /id="publicationQueue"/);
assert.match(tasksHtml, /data-queue-accept/);
assert.match(tasksHtml, /data-queue-reject/);
assert.match(tasksHtml, /rpc\/resolve_client_publication_request/);
assert.doesNotMatch(tasksHtml, /Store\.setProfileStatusTaskDate\(request\.status_id, request\.requested_date\)/);
assert.match(tasksHtml, /pushClientSnapshots\(Store\.state\)/);
assert.match(tasksHtml, /task\.planSource === 'client'/,
  'подтверждённая клиентская дата должна оставаться заметной в календаре');
assert.match(tasksHtml, /КЛИЕНТ \$\{clientTaskTotal\}/,
  'в ячейке календаря должна быть явная клиентская метка');

assert.match(staffPlanVisibilityMigration, /client_snapshot_with_status_plans/);
assert.match(staffPlanVisibilityMigration, /client_snapshots_status_plans_trg/,
  'старый кэшированный клиент CRM не должен снова удалить планы из снимка');
assert.match(staffPlanVisibilityMigration, /source\.item ->> 'mentorId' = v_snapshot_status ->> 'mentorId'/);
assert.match(staffPlanVisibilityMigration, /source\.item ->> 'profileId' = v_snapshot_status ->> 'profileId'/);
assert.match(staffPlanVisibilityMigration, /planned_action_date/);
assert.match(staffPlanVisibilityMigration, /next_action_status/);
assert.match(staffPlanVisibilityMigration, /task_plan_source/);
assert.match(staffPlanVisibilityMigration, /CLIENT_SNAPSHOT_STATUS_COUNT_CHANGED/,
  'миграция должна прерываться, если изменилось количество клиентских статусов');

assert.match(telegramPatch, /cpub:c:/);
assert.match(telegramPatch, /cpub:r:/);
assert.match(telegramPatch, /resolve_client_publication_request/);

console.log('client publication requests: OK');
