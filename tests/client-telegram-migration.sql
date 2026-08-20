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
  u.id::text as uid,
  lower(u.email) as login_email,
  lower(coalesce(u.raw_app_meta_data ->> 'portal_email', u.email)) as portal_email
from auth.users u
join public.client_snapshots snapshot
  on lower(snapshot.email) = lower(coalesce(u.raw_app_meta_data ->> 'portal_email', u.email))
where u.raw_app_meta_data ->> 'role' = 'client'
order by u.created_at
limit 1
\gset verify_

select pg_temp.assert_true(:'verify_uid' <> '', 'client auth user is missing');
select pg_temp.assert_true(
  (select count(*) = 0 from auth.users
   where raw_app_meta_data ->> 'role' = 'client'
     and coalesce(raw_app_meta_data ->> 'portal_email', '') = ''),
  'portal_email was not backfilled'
);

select 'new-client-' || replace(gen_random_uuid()::text, '-', '') || '@example.test' as created_email
\gset verify_

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
select public.create_client_user(
  :'verify_created_email', 'CreatedClient123!', 'Проверочный клиент'
);
reset role;
select pg_temp.assert_true(
  (select count(*) = 1
   from auth.users u
   join auth.identities i on i.user_id = u.id and i.provider = 'email'
   where lower(u.email) = :'verify_created_email'
     and lower(i.email) = :'verify_created_email'
     and lower(u.raw_app_meta_data ->> 'portal_email') = :'verify_created_email'),
  'new client auth user or identity is invalid'
);

select 'verify-' || replace(:'verify_uid', '-', '') || '@example.test' as new_email
\gset verify_

update auth.users
set encrypted_password = crypt('VerifyCurrent123!', gen_salt('bf', 10))
where id = :'verify_uid'::uuid;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', :'verify_uid',
    'email', :'verify_login_email',
    'role', 'authenticated',
    'app_metadata', jsonb_build_object(
      'role', 'client',
      'portal_email', :'verify_portal_email'
    )
  )::text,
  true
);
set local role authenticated;

select public.change_my_client_credentials(
  'VerifyCurrent123!', :'verify_new_email', 'VerifyNew123!'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', :'verify_uid',
    'email', :'verify_new_email',
    'role', 'authenticated',
    'app_metadata', jsonb_build_object(
      'role', 'client',
      'portal_email', :'verify_portal_email'
    )
  )::text,
  true
);

select pg_temp.assert_true(
  public.current_client_portal_email() = :'verify_portal_email',
  'stable portal key changed with login email'
);
select pg_temp.assert_true(
  (select count(*) = 1 from public.client_snapshots),
  'client lost its snapshot after login change'
);

select (public.create_client_telegram_invite('Тестовый контакт', true) ->> 'token') as invite_token
\gset verify_

reset role;

select pg_temp.assert_true(
  (select lower(email) = :'verify_new_email'
     and lower(raw_app_meta_data ->> 'portal_email') = :'verify_portal_email'
   from auth.users where id = :'verify_uid'::uuid),
  'auth user email or portal metadata mismatch'
);
select pg_temp.assert_true(
  (select lower(email) = :'verify_new_email'
     and lower(identity_data ->> 'email') = :'verify_new_email'
   from auth.identities
   where user_id = :'verify_uid'::uuid and provider = 'email'),
  'auth identity email mismatch'
);

select (900000000000 + floor(random() * 90000000))::bigint as telegram_id
\gset verify_

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
set local role service_role;

select public.link_client_telegram_member(
  :'verify_invite_token', :'verify_telegram_id'::bigint, :'verify_telegram_id'::bigint,
  'verify_contact', 'Verify', 'Contact'
);

reset role;

create or replace function pg_temp.assert_invite_rejected(token text, telegram_id bigint)
returns void language plpgsql as $$
begin
  begin
    perform public.link_client_telegram_member(
      token, telegram_id, telegram_id, 'verify_contact', 'Verify', 'Contact'
    );
    raise exception 'REUSE_DID_NOT_FAIL';
  exception when others then
    if sqlerrm = 'REUSE_DID_NOT_FAIL'
       or position('INVITE_ALREADY_USED' in sqlerrm) = 0 then
      raise;
    end if;
  end;
end;
$$;

select pg_temp.assert_invite_rejected(
  :'verify_invite_token', :'verify_telegram_id'::bigint
);

select pg_temp.assert_true(
  (select count(*) = 1
   from public.client_telegram_members
   where portal_email = :'verify_portal_email'
     and telegram_user_id = :'verify_telegram_id'::bigint
     and is_active and is_text_approver),
  'linked primary Telegram contact is missing'
);

select id as member_id
from public.client_telegram_members
where portal_email = :'verify_portal_email'
  and telegram_user_id = :'verify_telegram_id'::bigint
\gset verify_

create or replace function pg_temp.assert_primary_cannot_be_unset(member_id bigint)
returns void language plpgsql as $$
begin
  begin
    perform public.update_my_client_telegram_member(
      member_id, 'Тестовый контакт', false, true, true
    );
    raise exception 'PRIMARY_UNSET_DID_NOT_FAIL';
  exception when others then
    if sqlerrm = 'PRIMARY_UNSET_DID_NOT_FAIL'
       or position('TEXT_APPROVER_REQUIRED' in sqlerrm) = 0 then
      raise;
    end if;
  end;
end;
$$;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', :'verify_uid',
    'email', :'verify_new_email',
    'role', 'authenticated',
    'app_metadata', jsonb_build_object(
      'role', 'client',
      'portal_email', :'verify_portal_email'
    )
  )::text,
  true
);
set local role authenticated;
select pg_temp.assert_primary_cannot_be_unset(:'verify_member_id'::bigint);
reset role;

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

select id as request_id
from public.create_client_text_approval(
  :'verify_portal_email', null, 'Проверка миграции', 'Тестовый текст'
)
\gset verify_

reset role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

select public.resolve_client_text_approval(
  :'verify_request_id'::bigint, 'approved',
  :'verify_telegram_id'::bigint, :'verify_telegram_id'::bigint, null
) as first_resolution
\gset verify_

select pg_temp.assert_true(
  (:'verify_first_resolution'::jsonb ->> 'ok')::boolean,
  'primary contact could not approve text'
);

select public.resolve_client_text_approval(
  :'verify_request_id'::bigint, 'approved',
  :'verify_telegram_id'::bigint, :'verify_telegram_id'::bigint, null
) as second_resolution
\gset verify_

select pg_temp.assert_true(
  not (:'verify_second_resolution'::jsonb ->> 'ok')::boolean
  and :'verify_second_resolution'::jsonb ->> 'reason' = 'ALREADY_RESOLVED',
  'text decision was not first-writer-wins'
);

reset role;
select pg_temp.assert_true(
  (select request_status = 'approved'
   from public.client_text_approval_requests
   where id = :'verify_request_id'::bigint),
  'approval status was not persisted'
);
select pg_temp.assert_true(
  (select count(*) = 1
   from public.notification_outbox
   where kind = 'client_text_approval'
     and action_ref = :'verify_request_id'),
  'client approval notification was not queued exactly once'
);
select pg_temp.assert_true(
  (select count(*) = 1
   from public.notification_outbox
   where kind = 'client_text_approval_result'
     and action_ref = :'verify_request_id'),
  'owner result notification was not queued exactly once'
);

rollback;

\echo 'CLIENT_TELEGRAM_MIGRATION_VERIFY_OK'
