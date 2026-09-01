'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
const syncSource = fs.readFileSync(path.join(root, 'js/outreach-schedule-sync.js'), 'utf8');
const clientApp = fs.readFileSync(path.join(root, 'pages/client/client-app.js'), 'utf8');
const clientCss = fs.readFileSync(path.join(root, 'pages/client/client.css'), 'utf8');
const clientsHtml = fs.readFileSync(path.join(root, 'pages/clients.html'), 'utf8');
const tasksHtml = fs.readFileSync(path.join(root, 'pages/tasks.html'), 'utf8');
const planHtml = fs.readFileSync(path.join(root, 'pages/plan.html'), 'utf8');
const dashboardHtml = fs.readFileSync(path.join(root, 'pages/dashboard.html'), 'utf8');
const migration = fs.readFileSync(
  path.join(root, 'sql/migrations/2026-08-20_client_outreach_slots.sql'),
  'utf8'
);
const hardeningMigration = fs.readFileSync(
  path.join(root, 'sql/migrations/2026-08-20_client_planning_hardening.sql'),
  'utf8'
);
const expiryMigration = fs.readFileSync(
  path.join(root, 'sql/migrations/2026-08-20_client_outreach_expiry.sql'),
  'utf8'
);
const tomorrowMinimumMigration = fs.readFileSync(
  path.join(root, 'sql/migrations/2026-08-24_client_outreach_tomorrow_minimum.sql'),
  'utf8'
);
const sundayDayOffMigration = fs.readFileSync(
  path.join(root, 'sql/migrations/2026-08-26_client_outreach_sunday_day_off.sql'),
  'utf8'
);
const dailyCapacityMigration = fs.readFileSync(
  path.join(root, 'sql/migrations/2026-08-26_client_outreach_daily_capacity.sql'),
  'utf8'
);
const currentSundayClosureMigration = fs.readFileSync(
  path.join(root, 'sql/migrations/2026-08-27_client_outreach_close_current_sunday.sql'),
  'utf8'
);
const moscowExpiryMigration = fs.readFileSync(
  path.join(root, 'sql/migrations/2026-08-27_client_outreach_moscow_expiry.sql'),
  'utf8'
);

const noop = () => {};
const context = {
  console,
  Date,
  Promise,
  setInterval: noop,
  clearInterval: noop,
  setTimeout: noop,
  clearTimeout: noop,
  CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  document: {
    readyState: 'loading',
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
    Supabase: { URL: 'https://example.test', KEY: 'anon', authFetch: noop }
  }
};
context.window.window = context.window;
vm.createContext(context);
vm.runInContext(appSource, context);
vm.runInContext(syncSource, context);

const { Store, PROFILE_STATUSES, STATUS_SELECT } = context.window.App;
let saves = 0;
Store.save = () => { saves++; };
Store.state = {
  mentors: [
    { id: 'mentor-a1', code: 'a1' },
    { id: 'mentor-a2', code: 'a2' }
  ],
  clients: [
    { id: 'client-a1', code: 'a1', schedule: [{ date: '2026-08-20', count: 9 }] },
    { id: 'client-a2', code: 'a2', schedule: [{ date: '2026-08-25', count: 1 }] }
  ],
  profileStatuses: [{
    id: 'status-a1', mentorId: 'mentor-a1', profileId: 'profile-1',
    status: STATUS_SELECT, date: '2026-08-20', history: []
  }]
};

context.window.OutreachScheduleSync.syncStateFromRows([
  { id: 0, mentor_id: 'mentor-a1', scheduled_date: '2026-08-19', slot_status: 'scheduled' },
  { id: 1, mentor_id: 'mentor-a1', scheduled_date: '2026-08-20', slot_status: 'completed' },
  { id: 2, mentor_id: 'mentor-a1', scheduled_date: '2026-08-20', slot_status: 'scheduled' },
  { id: 3, mentor_id: 'mentor-a1', scheduled_date: '2026-08-20', slot_status: 'scheduled' },
  { id: 4, mentor_id: 'mentor-a1', scheduled_date: '2026-08-21', slot_status: 'cancelled' }
], '2026-08-20');

assert.deepEqual(JSON.parse(JSON.stringify(Store.state.clients[0].schedule)), [
  { date: '2026-08-20', count: 3 }
]);
assert.equal(
  context.window.App.clientScheduleBreakdown(Store.state, Store.state.clients[0])[0].remaining,
  2,
  'legacy schedule must show exactly two canonical active slots after subtracting one real start'
);
assert.deepEqual(JSON.parse(JSON.stringify(Store.state.clients[1].schedule)), [
  { date: '2026-08-25', count: 1 }
], 'clients without canonical rows must stay untouched');
assert.equal(saves, 1);
assert.equal(
  context.window.OutreachScheduleSync.moscowTodayISO(new Date('2026-08-26T22:30:00.000Z')),
  '2026-08-27',
  'рабочий день должен переключаться в полночь по Москве, а не по UTC'
);

context.window.OutreachScheduleSync.syncStateFromRows([
  { id: 1, mentor_id: 'mentor-a1', scheduled_date: '2026-08-20', slot_status: 'completed' },
  { id: 2, mentor_id: 'mentor-a1', scheduled_date: '2026-08-20', slot_status: 'scheduled' },
  { id: 3, mentor_id: 'mentor-a1', scheduled_date: '2026-08-20', slot_status: 'scheduled' }
], '2026-08-21');
assert.deepEqual(JSON.parse(JSON.stringify(Store.state.clients[0].schedule)), [
  { date: '2026-08-20', count: 1 }
], 'после смены московского дня незавершённые слоты исчезают, а фактический старт остаётся в истории');
assert.equal(
  context.window.App.clientScheduleBreakdown(Store.state, Store.state.clients[0])[0].remaining,
  0,
  'вчерашний незавершённый отклик не должен висеть остатком в старом плане'
);

let completedArgs = null;
context.window.CloudSync = {
  completeOutreachSlot: (...args) => {
    completedArgs = args;
    return Promise.resolve(true);
  }
};
Store.state.profileStatuses.push({
  id: 'status-a1-planned', mentorId: 'mentor-a1', profileId: 'profile-2',
  status: PROFILE_STATUSES[0], date: '2026-08-22', history: []
});
Store.setProfileStatus('mentor-a1', 'profile-2', STATUS_SELECT, '', '2026-08-23');
assert.deepEqual(completedArgs, ['mentor-a1', '2026-08-23'],
  'starting real work must close one canonical outreach slot');

assert.match(migration, /create table if not exists public\.client_outreach_slots/i);
assert.match(migration, /pg_advisory_xact_lock/);
assert.match(migration, /outreach-client:/);
assert.match(migration, /used_on_target >= 7/);
assert.match(migration, /caller_app_role <> 'client'/);
assert.match(migration, /client_email = lower\(coalesce\(auth\.jwt\(\) ->> 'email'/);
assert.match(migration, /kind, message, status, mentor_id, client_email/);
assert.match(migration, /staff_adjust_outreach_slot/);
assert.match(migration, /staff_move_outreach_slot/);
assert.match(migration, /staff_complete_outreach_slot/);
assert.match(migration, /scheduled_date <= p_date/);
assert.doesNotMatch(migration, /grant insert on public\.client_outreach_slots to authenticated/i);
assert.match(hardeningMigration, /scheduled_date < current_date/);
assert.match(hardeningMigration, /source in \('snapshot_seed', 'legacy_seed'\)/);
assert.match(hardeningMigration, /slot_status = 'cancelled'/,
  'прошедшие планы из старого снимка должны стать историей');
assert.match(expiryMigration, /scheduled_date < current_date/,
  'неиспользованный план должен автоматически истекать после своей даты');
assert.match(expiryMigration, /slot_status = 'cancelled'/);
assert.match(expiryMigration, /manage_client_outreach_slot_v1/,
  'серверная проверка лимита должна выполняться после очистки просроченных планов');
assert.match(expiryMigration, /get_client_outreach_calendar_v1/,
  'открытие клиентского календаря должно запускать очистку просроченных планов');
assert.match(tomorrowMinimumMigration, /action_name in \('add', 'move'\)/);
assert.match(tomorrowMinimumMigration, /now\(\) at time zone 'Europe\/Moscow'/,
  'граница дня должна считаться по рабочему московскому времени');
assert.match(tomorrowMinimumMigration, /p_target_date < business_today \+ 1/,
  'сервер должен запрещать новый или перенесённый отклик на сегодня');
assert.match(tomorrowMinimumMigration, /OUTREACH_PREPARATION_DAY/);
assert.match(tomorrowMinimumMigration, /manage_client_outreach_slot_v1/,
  'после проверки дня подготовки должны сохраниться лимиты и блокировки исходной функции');
assert.match(sundayDayOffMigration, /date '2026-09-06'/,
  'ближайшее воскресенье 30.08 должно остаться разрешённым');
assert.match(sundayDayOffMigration, /extract\(isodow from p_date\) = 7/);
assert.match(sundayDayOffMigration, /before insert or update of scheduled_date/,
  'серверный запрет должен покрывать сайт, Telegram и ручной график CRM');
assert.match(sundayDayOffMigration, /OUTREACH_DAY_OFF/);
assert.doesNotMatch(sundayDayOffMigration, /delete from public\.client_outreach_slots|update public\.client_outreach_slots/,
  'миграция не должна снимать уже запланированные отклики');
assert.match(dailyCapacityMigration, /client_outreach_capacity/);
assert.match(dailyCapacityMigration, /extract\(isodow from p_date\) = 6 then 3/,
  'в субботу общий предел должен быть равен трём');
assert.match(dailyCapacityMigration, /else 7/,
  'с понедельника по пятницу общий предел должен оставаться равным семи');
assert.match(dailyCapacityMigration, /date '2026-09-06'[\s\S]*extract\(isodow from p_date\) = 7 then 0/,
  'воскресенье должно быть закрыто после сохранённого исключения 30.08');
assert.match(dailyCapacityMigration, /OUTREACH_SATURDAY_FULL/);
assert.match(dailyCapacityMigration, /client-outreach-capacity:/,
  'единый триггер должен сериализовать конкурирующие записи на одну дату');
assert.match(dailyCapacityMigration, /before insert or update of scheduled_date, slot_status/,
  'лимит должен действовать на все способы вернуть слот в активное расписание');
assert.doesNotMatch(dailyCapacityMigration, /delete from public\.client_outreach_slots|update public\.client_outreach_slots/,
  'новый предел не должен удалять или переносить существующие планы');
assert.match(currentSundayClosureMigration, /date '2026-08-30'/,
  'новые записи должны быть закрыты уже на ближайшее воскресенье');
assert.match(currentSundayClosureMigration, /client_outreach_day_off/);
assert.match(currentSundayClosureMigration, /client_outreach_capacity/);
assert.doesNotMatch(currentSundayClosureMigration, /delete from public\.client_outreach_slots|update public\.client_outreach_slots/,
  'уже поставленный отклик 30.08 должен сохраниться');
assert.match(moscowExpiryMigration, /now\(\) at time zone 'Europe\/Moscow'/,
  'истечение плана должно переключаться в московскую полночь');
assert.match(moscowExpiryMigration, /scheduled_date < v_business_today/);
assert.match(moscowExpiryMigration, /slot_status = 'cancelled'/,
  'просроченный план должен освобождать остаток, а не считаться выполненным');
assert.match(moscowExpiryMigration, /changed_by = 'system-expired-outreach'/,
  'автоматическое снятие должно оставаться в аудите');
assert.doesNotMatch(moscowExpiryMigration, /delete\s+from\s+public\.client_outreach_slots/i,
  'историческая строка не должна удаляться');
assert.match(moscowExpiryMigration, /staff_expire_past_client_outreach_slots/);
assert.match(moscowExpiryMigration, /v_auth_role <> 'service_role'[\s\S]*v_app_role not in \('owner', 'team'\)/,
  'RPC очистки должен принимать только сервис или сотрудников CRM');
assert.match(moscowExpiryMigration, /from public, anon, authenticated, service_role;[\s\S]*to authenticated, service_role/,
  'анонимные и клиентские вызовы не должны получать прямой доступ к очистке');
assert.match(moscowExpiryMigration, /select public\.expire_past_client_outreach_slots\(\);/,
  'миграция должна сразу снять уже просроченные планы');

assert.match(clientApp, /manage_client_outreach_slot/);
assert.match(clientApp, /get_client_outreach_calendar/);
assert.match(clientApp, /scheduled_date=gte\.\$\{todayISO\(\)\}/,
  'кабинет должен загружать только актуальный план');
assert.match(clientApp, /activeOutreachSlots[\s\S]*scheduled_date \|\| ''\)\.slice\(0, 10\) >= todayISO\(\)/,
  'повторный защитный фильтр не должен пропускать старые даты в обработчики карточки');
assert.match(clientApp, /data-outreach-move/);
assert.match(clientApp, /data-outreach-cancel/);
assert.match(clientApp, /data-outreach-inline-date/);
assert.match(clientApp, /ownSlots\.length \? 'cancel' : 'add'/);
assert.match(clientApp, /const action = ownSlots\.length \? 'cancel' : 'add';[\s\S]{0,220}if \(action === 'cancel' && !\(await confirmOutreachCancellation\(ownSlots\[0\]\)\)\) return;[\s\S]{0,520}manageOutreachSlot\(action/,
  'клик по своему дню должен спрашивать подтверждение до отмены');
assert.match(clientApp, /const slot = slotsById\.get\(button\.dataset\.outreachCancel\);[\s\S]{0,140}await confirmOutreachCancellation\(slot\)[\s\S]{0,220}manageOutreachSlot\('cancel'/,
  'кнопка отмены в списке должна использовать то же предупреждение');
assert.match(clientApp, /id = 'cliOutreachCancelModal'/);
assert.match(clientApp, /Вернуть его на сегодняшний день уже не получится/);
assert.match(clientApp, /день на закупку и подготовку/);
assert.match(clientApp, /data-outreach-cancel-confirm/);
assert.match(clientApp, /acceptedPublicationDates\(meta\.anketa, context\.publicationRequests\)/,
  'календарь внутри анкеты должен учитывать подтверждённые публикации');
assert.match(clientApp, /eventLabels\.join\('<br>'\)/,
  'отклик и публикация в один день должны отображаться раздельно');
assert.match(clientApp, /load\.available > 0 && meta\.availableToAdd > 0/);
assert.match(clientApp, /function outreachMinimumDate\(\)[\s\S]*addDaysISO\(todayISO\(\), 1\)/);
assert.match(clientApp, /const isPreparationDate = !isPastDate && date < minimumDate/);
assert.match(clientApp, /const showAvailability = meta\.availableToAdd > 0/);
assert.match(clientApp, /!showAvailability\s*\? ''/,
  'если у анкеты нет свободных откликов, календарь не должен показывать глобальную подготовку и занятость');
assert.match(clientApp, /showAvailability && isPreparationDate && !hasClientEvent/,
  'подготовка должна отображаться только для анкеты, у которой ещё можно планировать');
assert.match(clientApp, /const canAdd = date >= minimumDate/,
  'сегодня нельзя использовать для нового отклика даже при наличии мест');
assert.match(clientApp, /const disabled = date < minimumDate/,
  'окно переноса также должно начинаться только с завтра');
assert.match(clientApp, /OUTREACH_PREPARATION_DAY/);
assert.match(clientApp, /OUTREACH_SUNDAY_DAY_OFF_FROM = '2026-08-30'/);
assert.match(clientApp, /isOutreachDayOff/);
assert.match(clientApp, /OUTREACH_DAY_OFF/);
assert.match(clientApp, /OUTREACH_SATURDAY_FULL/);
assert.match(clientApp, /isDayOff \? 'выходной'/);
assert.match(clientApp, /На закупку и подготовку нужен один день/);
assert.match(clientApp, /const isPastDate = date < today/);
assert.match(clientApp, /const label = isPastDate\s*\?\s*''/,
  'на прошедших днях не должно быть надписей «свободно» или «ваш отклик»');
assert.match(clientApp, /canAdd \? 'есть места'/,
  'клиент должен видеть только наличие мест без их количества');
assert.doesNotMatch(clientApp, /свободно \$\{load\.available\}/,
  'клиенту нельзя показывать точное количество свободных мест');
assert.doesNotMatch(clientApp, /\$\{load\.available\} из 7/,
  'в окне переноса нельзя раскрывать загрузку дня');
assert.match(clientApp, /Доступно для планирования: <b>\$\{availableToAdd\}<\/b>/,
  'клиент должен видеть остаток планов именно по своей анкете');
assert.doesNotMatch(clientApp, /просроченный план снимается автоматически/,
  'служебное пояснение не должно перегружать шапку плана');
assert.match(clientCss, /\.cli-outreach__available \{/,
  'доступный остаток должен быть визуально выделен');
assert.doesNotMatch(clientApp, /до 7 в день|запланировано 7 откликов/,
  'дневную ёмкость CRM клиенту показывать нельзя');
assert.match(appSource, /scheduleLimit: client \? manualScheduleLimit/);
assert.match(appSource, /item\.remaining > 0 && item\.date >= todayISO\(\)/,
  'устаревший план не должен попадать даже в резервный снимок кабинета');
assert.match(clientCss, /\.cli-status-mobile__item/);
assert.match(clientCss, /\.cli-outreach-cal__grid/);
assert.match(clientCss, /\.cli-outreach__body/);
assert.match(clientCss, /grid-template-columns: minmax\(260px, \.85fr\) minmax\(380px, 1\.15fr\)/);
assert.match(clientCss, /\.cli-donut__sub \{[^}]*letter-spacing: 0/);
assert.match(clientsHtml, /outreachSlotsOnDate/);
assert.match(clientsHtml, /function outreachCapacityForDate/);
assert.match(clientsHtml, /day === 6 \? 3 : 7/);
assert.match(clientsHtml, /\$\{daySlots\}\/\$\{dayCapacity\}/);
assert.match(clientsHtml, /OUTREACH_SATURDAY_FULL/);
assert.match(clientsHtml, /OUTREACH_SUNDAY_DAY_OFF_FROM = '2026-08-30'/);
assert.match(clientsHtml, /delta > 0 && isOutreachDayOff\(isoDate\)/,
  'CRM должна запрещать добавление, но сохранять возможность снять план');
assert.match(tasksHtml, /outreach-schedule-sync\.js/);
assert.match(planHtml, /outreach-schedule-sync\.js/);
assert.match(syncSource, /timeZone: 'Europe\/Moscow'/,
  'просрочка должна определяться по рабочей московской дате');
assert.match(syncSource, /row\.slot_status === 'scheduled' && row\.scheduled_date >= businessToday/,
  'даже при недоступном RPC прошедший слот не должен оставаться в плане');
assert.match(syncSource, /rpc\/staff_expire_past_client_outreach_slots[\s\S]*const nextRows = await request/,
  'перед чтением расписания CRM должна попросить сервер закрыть просроченные слоты');
assert.match(syncSource, /expiry RPC failed[\s\S]*const nextRows = await request/,
  'ошибка очистки не должна блокировать загрузку актуального расписания');
[dashboardHtml, planHtml, clientsHtml, tasksHtml].forEach(html => {
  assert.match(html, /outreach-schedule-sync\.js\?v=20260827a/,
    'все административные страницы должны получить новую версию синхронизации');
});

console.log('client outreach scheduling: OK');
