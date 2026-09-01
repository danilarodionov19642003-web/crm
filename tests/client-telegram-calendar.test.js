const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('pages/client/telegram-calendar.html');
const js = read('pages/client/telegram-calendar.js');
const css = read('pages/client/telegram-calendar.css');
const sql = read('sql/migrations/2026-08-26_client_telegram_calendar.sql');
const cabinetSql = read('sql/migrations/2026-08-26_client_telegram_miniapp_cabinet.sql');
const sundaySql = read('sql/migrations/2026-08-26_client_outreach_sunday_day_off.sql');
const capacitySql = read('sql/migrations/2026-08-26_client_outreach_daily_capacity.sql');
const currentSundayClosureSql = read('sql/migrations/2026-08-27_client_outreach_close_current_sunday.sql');
const accountSql = read('sql/migrations/2026-08-26_client_telegram_z_account_details.sql');
const moscowExpirySql = read('sql/migrations/2026-08-27_client_outreach_moscow_expiry.sql');
const nextStatusSql = read('sql/migrations/2026-09-01_client_next_status_planning.sql');
const staffPlanVisibilitySql = read('sql/migrations/2026-09-01_staff_status_plans_client_visibility.sql');

test('Telegram calendar uses short-lived hashed tokens without portal password', () => {
  assert.match(sql, /token_hash bytea not null unique/);
  assert.match(sql, /digest\(v_token, 'sha256'\)/);
  assert.match(sql, /interval '30 minutes'/);
  assert.match(sql, /TOKEN_INVALID_OR_EXPIRED/);
  assert.doesNotMatch(sql, /update\s+public\.crm_state/i);
  assert.doesNotMatch(js, /signIn|password|localStorage/);
});

test('Telegram direct menu keeps its bearer credential out of HTTP requests', () => {
  assert.match(js, /fragmentParams/);
  assert.match(js, /location\.hash/);
  assert.match(js, /fragmentParams\.get\('token'\)/);
  assert.match(html, /telegram-calendar\.js\?v=20260901d/);
  assert.match(html, /telegram-calendar\.css\?v=20260901c/);
});

test('Telegram calendar reads capacity and schedules through bounded RPCs', () => {
  assert.match(sql, /get_client_telegram_calendar/);
  assert.match(sql, /manage_client_telegram_outreach_slot/);
  assert.match(sql, /p_target_date < current_date \+ 1/);
  assert.match(sql, /v_used >= 7/);
  assert.match(sql, /SCHEDULE_LIMIT_REACHED/);
  assert.match(js, /get_client_telegram_calendar/);
  assert.match(js, /manage_client_telegram_outreach_slot/);
  assert.match(js, /data-cancel-slot/);
});

test('Mini App requires an explicit destructive confirmation before cancellation', () => {
  assert.match(js, /function confirmOutreachCancellation\(scheduledDate\)/);
  assert.match(js, /state\.payload && state\.payload\.minimum_date/,
    'необратимость сегодняшней отмены должна считаться по серверной минимальной дате');
  assert.match(js, /function moscowDateAfter\(days\)/,
    'долго открытая Mini App должна пересчитывать минимальную дату после полуночи по Москве');
  assert.match(js, /payloadMinimum > liveMinimum/);
  assert.match(js, /Вернуть его на сегодняшний день уже не получится/);
  assert.match(js, /день на закупку и подготовку/);
  assert.match(js, /tg\.showPopup/);
  assert.match(js, /type: 'destructive'/);
  assert.match(js, /data-cancel-date/);
  assert.match(js, /if \(await confirmOutreachCancellation\(button\.dataset\.cancelDate\)\)[\s\S]{0,120}manage\('cancel'/,
    'RPC отмены должен вызываться только после явного подтверждения');
});

test('Mini App renders a compact mobile calendar and initializes Telegram WebApp', () => {
  assert.match(html, /telegram\.org\/js\/telegram-web-app\.js/);
  assert.match(js, /Telegram\.WebApp/);
  assert.match(js, /tg\.expand\(\)/);
  assert.match(css, /grid-template-columns: repeat\(7/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
});

test('Mini App mirrors the client cabinet with branded home and anketa details', () => {
  assert.match(html, /Личный кабинет Mentori/);
  assert.match(js, /data-view="home"/);
  assert.match(js, /data-view="calendar"/);
  assert.match(js, /data-open-anketa/);
  assert.match(js, /Ваши анкеты/);
  assert.match(js, /function renderHome\(\)[\s\S]*const anketas = activeAnketas\(\)/,
    'главная Mini App должна показывать только активные анкеты');
  assert.match(js, /const totals = activeAnketaTotals\(anketas\)/,
    'плашки Mini App должны считать только активные анкеты');
  assert.match(js, /Активных анкет сейчас нет/);
  assert.match(js, /Опубликованные отзывы/);
  assert.match(js, /avatar_url/);
  assert.match(css, /\.tgapp-hero/);
  assert.match(css, /\.tgapp-anketa-card/);
  assert.match(css, /\.tgapp-profile-hero/);
  assert.match(cabinetSql, /'totals'/);
  assert.match(cabinetSql, /'avatar_url'/);
  assert.match(cabinetSql, /'statuses'/);
  assert.match(cabinetSql, /'reviews'/);
  assert.doesNotMatch(cabinetSql, /crm_state/);
});

test('Mini App opens an account with its review text and next-status date control', () => {
  assert.match(js, /data-open-account/);
  assert.match(js, /function renderAccountDetail/);
  assert.match(js, /Текст отзыва/);
  assert.match(js, /Согласовать/);
  assert.match(js, /Нужны правки/);
  assert.match(js, /request_client_telegram_publication_date/);
  assert.match(js, /resolve_client_telegram_webapp_text_approval/);
  assert.match(css, /\.tgapp-account-hero/);
  assert.match(css, /\.tgapp-publication__control/);
  assert.match(accountSql, /'profile_id'/);
  assert.match(accountSql, /'text_approvals'/);
  assert.match(accountSql, /'publication_requests'/);
  assert.match(accountSql, /source_profile_id/);
  assert.match(accountSql, /STATUS_NOT_AVAILABLE/);
  assert.match(accountSql, /client_publication_minimum_trg|client_publication_wait_days/);
  assert.match(accountSql, /TEXT_APPROVER_REQUIRED/);
  assert.match(accountSql, /Europe\/Moscow/);
  assert.doesNotMatch(accountSql, /update\s+public\.crm_state/i);
  assert.match(js, /function nextStatusTarget\(status\)/);
  assert.match(js, /'💬 Начать диалог': '✅ Обменяться'/);
  assert.match(js, /'✅ Обменяться': '⭐ Выбрать'/);
  assert.match(js, /'⭐ Выбрать': '🏆 Выбран'/);
  assert.match(js, /'🏆 Выбран': '🎯 Опубликован'/);
  assert.match(js, /function clientStatusFlow\(status, extraClass = ''\)/);
  assert.match(js, /'⭐ Выбрать': 'Выбрать специалиста'/);
  assert.match(js, /'🏆 Выбран': 'Специалист выбран'/);
  assert.match(js, /'🎯 Опубликован': 'Отзыв опубликован'/);
  assert.match(js, /function clientStatusActionLabel\(status\)/);
  assert.match(js, /'🏆 Выбран': 'выбрать специалиста'/);
  assert.match(js, /clientStatusActionTitle\(plan\.targetStatus\)/,
    'будущая дата должна называться действием, а не уже наступившим статусом');
  assert.doesNotMatch(js, /clientStatusLabel\(plan\.targetStatus\)/);
  assert.match(js, /Когда опубликовать отзыв\?/);
  assert.match(css, /\.tgapp-stage-flow/);
  assert.match(js, /state\.payload\.business_today/);
  assert.match(nextStatusSql, /request_client_telegram_publication_date/);
  assert.match(nextStatusSql, /current_status, target_status/);
  assert.match(nextStatusSql, /'\{business_today\}'/);
  assert.match(staffPlanVisibilitySql, /planned_action_date/);
  assert.match(staffPlanVisibilitySql, /next_action_status/);
  assert.match(staffPlanVisibilitySql, /task_plan_source/);
  assert.match(js, /function statusPlan\(status, anketa\)/);
  assert.match(js, /Назначено менеджером/);
  assert.match(js, /Ближайшие действия/);
  assert.match(js, /Действия по аккаунтам/);
  assert.match(css, /\.tgcal-day\.has-status-plan/);
});

test('Mini App highlights every pending text and opens its exact account directly', () => {
  assert.match(js, /function pendingTextApprovals/);
  assert.match(js, /function approvalTarget/);
  assert.match(js, /data-open-pending-approval/);
  assert.match(js, /Текст ждёт согласования/);
  assert.match(js, /state\.view = target\.status \? 'account' : 'anketa'/);
  assert.match(js, /is-approval-pending/);
  assert.match(css, /\.tgapp-pending-approval/);
  assert.match(css, /\.tgapp-status-row\.is-approval-pending/);
});

test('Mini App closes the nearest Sunday while preserving existing rows', () => {
  assert.match(js, /OUTREACH_SUNDAY_DAY_OFF_FROM = '2026-08-30'/);
  assert.match(js, /isOutreachDayOff/);
  assert.match(js, /OUTREACH_DAY_OFF/);
  assert.match(js, /dayOff \? 'выходной'/);
  assert.match(css, /\.tgcal-day\.is-day-off/);
  assert.match(sundaySql, /OUTREACH_DAY_OFF/);
  assert.match(currentSundayClosureSql, /date '2026-08-30'/);
  assert.doesNotMatch(currentSundayClosureSql, /delete from public\.client_outreach_slots|update public\.client_outreach_slots/);
});

test('Mini App applies the shared weekday, Saturday and Sunday capacity', () => {
  assert.match(js, /function outreachCapacityForDate/);
  assert.match(js, /day === 6 \? 3 : 7/);
  assert.match(js, /OUTREACH_SATURDAY_FULL/);
  assert.match(capacitySql, /client_outreach_capacity/);
  assert.match(capacitySql, /get_client_telegram_calendar_v1/);
  assert.match(capacitySql, /OUTREACH_SATURDAY_FULL/);
});

test('Mini App expires old plans and starts new planning from Moscow tomorrow', () => {
  assert.match(moscowExpirySql, /get_client_telegram_calendar_v2\(text,date,date\)/);
  assert.match(moscowExpirySql, /manage_client_telegram_outreach_slot_v1\(text,text,text,bigint,date\)/);
  assert.match(moscowExpirySql, /to_regprocedure\('public\.get_client_telegram_calendar_v2/,
    'calendar delegate rename must be safe on migration rerun');
  assert.match(moscowExpirySql, /to_regprocedure\('public\.manage_client_telegram_outreach_slot_v1/,
    'management delegate rename must be safe on migration rerun');
  assert.match(moscowExpirySql, /client_telegram_webapp_context\(p_token\)[\s\S]*TOKEN_INVALID_OR_EXPIRED[\s\S]*expire_past_client_outreach_slots/,
    'only a valid Telegram token may trigger cleanup through a public wrapper');
  assert.match(moscowExpirySql, /v_from date := greatest\(coalesce\(p_from, v_business_today \+ 1\), v_business_today \+ 1\)/);
  assert.match(moscowExpirySql, /'\{minimum_date\}'[\s\S]*v_business_today \+ 1/);
  assert.match(moscowExpirySql, /p_target_date < v_business_today \+ 1/,
    'Telegram add and move must reject the Moscow current day');
  assert.match(moscowExpirySql, /get_client_telegram_calendar_v2\(p_token, v_from, v_to\)/,
    'Moscow wrapper must retain the complete existing cabinet payload');
  assert.match(moscowExpirySql, /manage_client_telegram_outreach_slot_v1\([\s\S]*p_token, p_action, p_mentor_id, p_slot_id, p_target_date/,
    'Moscow wrapper must retain existing capacity, package, notification and audit checks');
});
