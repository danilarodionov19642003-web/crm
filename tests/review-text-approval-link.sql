\set ON_ERROR_STOP on

begin;

create temp table approval_test_fixture as
select email as portal_email, anketa ->> 'mentorId' as mentor_id
from public.client_snapshots,
     lateral jsonb_array_elements(coalesce(payload -> 'anketas', '[]'::jsonb)) anketa
where coalesce(anketa ->> 'mentorId', '') <> ''
order by email
limit 1;

grant select on approval_test_fixture to authenticated;

set local role authenticated;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'role', 'authenticated',
    'email', 'approval-test-owner@mentori.local',
    'app_metadata', jsonb_build_object('role', 'owner')
  )::text,
  true
);

do $$
declare
  v_portal text;
  v_mentor_id text;
  v_first public.client_text_approval_requests;
  v_retry public.client_text_approval_requests;
  v_result jsonb;
  v_cancelled integer;
begin
  select portal_email, mentor_id
  into v_portal, v_mentor_id
  from approval_test_fixture;

  if v_portal is null or v_mentor_id is null then
    raise exception 'TEST_FIXTURE_MISSING';
  end if;

  select * into v_first
  from public.create_review_text_approval(
    v_portal, v_mentor_id, 'approval-test-review',
    'Тест согласования', 'Тестовый текст, не сохраняется.',
    'approval-test-profile'
  );
  select * into v_retry
  from public.create_review_text_approval(
    v_portal, v_mentor_id, 'approval-test-review',
    'Тест согласования', 'Тестовый текст, не сохраняется.',
    'approval-test-profile'
  );

  if v_first.id is distinct from v_retry.id then
    raise exception 'IDEMPOTENCY_FAILED';
  end if;
  if v_first.source_revision <> 1 or v_first.source_review_id <> 'approval-test-review' then
    raise exception 'SOURCE_LINK_FAILED';
  end if;
  if v_first.source_profile_id <> 'approval-test-profile' then
    raise exception 'PROFILE_LINK_FAILED';
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'email', v_portal,
      'app_metadata', jsonb_build_object('role', 'client', 'portal_email', v_portal)
    )::text,
    true
  );
  select public.resolve_my_client_text_approval(v_first.id, 'approved', null)
  into v_result;
  if not coalesce((v_result ->> 'ok')::boolean, false)
     or v_result ->> 'status' <> 'approved' then
    raise exception 'CLIENT_RESOLUTION_FAILED: %', v_result;
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'email', 'approval-test-team@mentori.local',
      'app_metadata', jsonb_build_object('role', 'team')
    )::text,
    true
  );
  select * into v_first
  from public.create_review_text_approval(
    v_portal, v_mentor_id, 'approval-test-cancel',
    'Тест отмены', 'Этот запрос будет отменён и откатан.'
  );
  select public.cancel_review_text_approval('approval-test-cancel') into v_cancelled;
  if v_cancelled <> 1 then
    raise exception 'CANCELLATION_FAILED';
  end if;
end;
$$;

rollback;
