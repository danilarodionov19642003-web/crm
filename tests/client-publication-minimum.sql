\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if value is not true then raise exception 'VERIFY_FAILED: %', message; end if;
end;
$$;

create temp table publication_verify (
  email text not null,
  status_id text not null,
  mentor_id text not null,
  profile_id text not null
) on commit drop;

insert into publication_verify
select
  'publication-' || replace(gen_random_uuid()::text, '-', '') || '@example.test',
  gen_random_uuid()::text,
  gen_random_uuid()::text,
  gen_random_uuid()::text;

grant select on publication_verify to service_role, authenticated;

set local role service_role;
insert into public.client_snapshots (email, payload, updated_at)
select email, jsonb_build_object(
  'name', 'Проверка минимальной даты',
  'anketas', jsonb_build_array(jsonb_build_object(
    'mentorId', mentor_id,
    'code', 'a-publication-verify',
    'name', 'Строительная анкета',
    'niche', 'remont',
    'publicationWaitDays', 20,
    'statuses', jsonb_build_array(jsonb_build_object(
      'id', status_id,
      'mentorId', mentor_id,
      'profileId', profile_id,
      'profileName', 'Проверочный аккаунт',
      'status', '🏆 Выбран',
      'date', current_date::text
    ))
  ))
), now()
from publication_verify;
reset role;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', gen_random_uuid()::text,
    'email', (select email from publication_verify),
    'role', 'authenticated',
    'app_metadata', jsonb_build_object(
      'role', 'client',
      'portal_email', (select email from publication_verify)
    )
  )::text,
  true
);
set local role authenticated;

do $$
declare
  v_status_id text := (select status_id from publication_verify);
begin
  begin
    perform public.request_client_publication_date(v_status_id, current_date + 19);
    raise exception 'VERIFY_FAILED: too-early publication date was accepted';
  exception
    when sqlstate '22023' then
      if position('PUBLICATION_TOO_EARLY:' in sqlerrm) = 0 then raise; end if;
  end;
end;
$$;

select public.request_client_publication_date(
  (select status_id from publication_verify),
  current_date + 20
);
reset role;

select pg_temp.assert_true(
  (select count(*) = 1
   from public.client_publication_requests request
   join publication_verify verify on request.client_email = verify.email
   where request.status_id = verify.status_id
     and request.requested_date = current_date + 20
     and request.request_status = 'pending'),
  'valid publication date was not saved'
);

rollback;

select 'CLIENT_PUBLICATION_MINIMUM_VERIFY_OK' as result;
