\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if value is not true then
    raise exception 'VERIFY_FAILED: %', message;
  end if;
end;
$$;

select
  'settings-' || replace(gen_random_uuid()::text, '-', '') || '@example.test' as portal_email,
  gen_random_uuid()::text as client_uid,
  (910000000000 + floor(random() * 80000000))::bigint as telegram_id,
  'settings-progress-' || gen_random_uuid()::text as action_ref,
  (select md5(data::text) from public.crm_state where id = 'main') as crm_hash,
  (select count(*) from public.client_snapshots) as snapshot_count
\gset settings_

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

insert into public.client_telegram_members (
  portal_email, telegram_user_id, telegram_chat_id, telegram_username,
  contact_label, is_active, is_text_approver,
  status_notifications, schedule_notifications,
  low_reviews_notifications, order_completed_notifications
) values (
  :'settings_portal_email', :'settings_telegram_id'::bigint,
  :'settings_telegram_id'::bigint, 'settings_verify',
  'Проверочный контакт', true, false, true, true, true, true
);

reset role;

select id as member_id
from public.client_telegram_members
where portal_email = :'settings_portal_email'
  and telegram_user_id = :'settings_telegram_id'::bigint
\gset settings_

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', :'settings_client_uid',
    'email', :'settings_portal_email',
    'role', 'authenticated',
    'app_metadata', jsonb_build_object(
      'role', 'client',
      'portal_email', :'settings_portal_email'
    )
  )::text,
  true
);
set local role authenticated;

select public.update_my_client_portal_profile(
  'Анна, согласование', '+7 999 123-45-67'
);

select public.update_my_client_telegram_settings(
  :'settings_member_id'::bigint,
  'Анна, согласование',
  false,
  true,
  true,
  false,
  true
);

select pg_temp.assert_true(
  (public.get_my_client_portal_profile() ->> 'contact_name') = 'Анна, согласование'
  and (public.get_my_client_portal_profile() ->> 'phone') = '+7 999 123-45-67',
  'client profile RPC did not persist contact data'
);

reset role;

select pg_temp.assert_true(
  (select not low_reviews_notifications and order_completed_notifications
   from public.client_telegram_members where id = :'settings_member_id'::bigint),
  'Telegram notification preferences were not persisted'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', gen_random_uuid()::text,
    'email', 'owner@verify.test',
    'role', 'authenticated',
    'app_metadata', jsonb_build_object('role', 'owner')
  )::text,
  true
);
set local role authenticated;

select pg_temp.assert_true(
  public.queue_client_progress_notification(
    :'settings_portal_email', 'low_reviews', 'Остался один отзыв',
    'mentor-settings', 'profile-settings', :'settings_action_ref', 'verify'
  ) = 0,
  'disabled low-review notification was queued'
);

select pg_temp.assert_true(
  public.queue_client_progress_notification(
    :'settings_portal_email', 'order_completed', 'Пакет выполнен',
    'mentor-settings', 'profile-settings', :'settings_action_ref', 'verify'
  ) = 1,
  'enabled package-completed notification was not queued'
);

select pg_temp.assert_true(
  public.queue_client_progress_notification(
    :'settings_portal_email', 'order_completed', 'Пакет выполнен',
    'mentor-settings', 'profile-settings', :'settings_action_ref', 'verify'
  ) = 0,
  'duplicate package-completed notification was queued'
);

reset role;

select pg_temp.assert_true(
  (select count(*) = 1 from public.notification_outbox
   where kind = 'order_completed'
     and action_ref = :'settings_action_ref'
     and telegram_chat_id = :'settings_telegram_id'::bigint),
  'package progress outbox row is missing or duplicated'
);

select pg_temp.assert_true(
  (select md5(data::text) from public.crm_state where id = 'main') = :'settings_crm_hash',
  'settings changed crm_state'
);

select pg_temp.assert_true(
  (select count(*) from public.client_snapshots) = :'settings_snapshot_count'::bigint,
  'settings changed client snapshots'
);

rollback;

select 'CLIENT_SETTINGS_MIGRATION_VERIFY_OK' as result;
