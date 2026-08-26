-- Account-level text approval and publication planning inside the token-gated
-- Telegram Mini App. The bearer token identifies one active Telegram member;
-- it never grants access to another client cabinet or to the CRM blob.

begin;

-- Keep a clean chronological replay safe even if this migration is applied
-- before the narrower account-link overload.
alter table public.client_text_approval_requests
  add column if not exists source_profile_id text;

create or replace function public.get_client_telegram_calendar(
  p_token text,
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_portal text;
  v_member_id bigint;
  v_snapshot jsonb;
  v_payload jsonb;
  v_calendar jsonb;
  v_anketas jsonb;
  v_text_approvals jsonb;
  v_publication_requests jsonb;
  v_can_approve boolean := false;
  v_today date := (now() at time zone 'Europe/Moscow')::date;
begin
  select ctx.portal_email, ctx.member_id
  into v_portal, v_member_id
  from public.client_telegram_webapp_context(p_token) ctx;
  if v_portal is null then
    raise exception 'TOKEN_INVALID_OR_EXPIRED' using errcode = '42501';
  end if;

  select member.is_text_approver
  into v_can_approve
  from public.client_telegram_members member
  where member.id = v_member_id and member.is_active;

  select snapshot.payload
  into v_snapshot
  from public.client_snapshots snapshot
  where lower(snapshot.email) = lower(v_portal);
  if v_snapshot is null then
    raise exception 'PORTAL_NOT_FOUND' using errcode = 'P0002';
  end if;

  v_payload := public.get_client_telegram_calendar_v1(p_token, p_from, p_to);

  select coalesce(jsonb_agg(
    item || jsonb_build_object(
      'capacity', public.client_outreach_capacity((item ->> 'date')::date),
      'available_count', greatest(
        0,
        public.client_outreach_capacity((item ->> 'date')::date)
          - coalesce((item ->> 'used_count')::int, 0)
      )
    ) order by item ->> 'date'
  ), '[]'::jsonb)
  into v_calendar
  from jsonb_array_elements(coalesce(v_payload -> 'calendar', '[]'::jsonb)) item;

  select coalesce(jsonb_agg(
    mini.item || jsonb_build_object(
      'statuses', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', status.item ->> 'id',
          'profile_id', status.item ->> 'profileId',
          'profile_name', status.item ->> 'profileName',
          'status', status.item ->> 'status',
          'date', status.item ->> 'date',
          'next_action_date', status.item ->> 'nextActionDate',
          'publication_wait_days', public.client_publication_wait_days(
            v_portal, status.item ->> 'id'
          ),
          'publication_minimum_date', greatest(
            v_today,
            case
              when coalesce(status.item ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$'
                then (status.item ->> 'date')::date
              else v_today
            end + public.client_publication_wait_days(v_portal, status.item ->> 'id')
          )
        ) order by status.item ->> 'date' desc, status.item ->> 'id')
        from jsonb_array_elements(coalesce(source.item -> 'statuses', '[]'::jsonb)) status(item)
      ), '[]'::jsonb)
    ) order by coalesce((mini.item ->> 'closed')::boolean, false), mini.item ->> 'code'
  ), '[]'::jsonb)
  into v_anketas
  from jsonb_array_elements(coalesce(v_payload -> 'anketas', '[]'::jsonb)) mini(item)
  left join lateral (
    select original.item
    from jsonb_array_elements(coalesce(v_snapshot -> 'anketas', '[]'::jsonb)) original(item)
    where original.item ->> 'mentorId' = mini.item ->> 'mentor_id'
    limit 1
  ) source on true;

  select coalesce(jsonb_agg(to_jsonb(request_row) order by request_row.created_at desc), '[]'::jsonb)
  into v_text_approvals
  from (
    select request.id, request.mentor_id, request.anketa_code, request.anketa_name,
           request.title, request.body, request.request_status,
           request.created_at, request.resolved_at, request.resolved_by_label,
           request.resolution_comment, request.source_review_id,
           request.source_profile_id, request.source_revision
    from public.client_text_approval_requests request
    where lower(request.portal_email) = lower(v_portal)
      and request.request_status <> 'cancelled'
    order by request.created_at desc
    limit 100
  ) request_row;

  select coalesce(jsonb_agg(to_jsonb(publication_row) order by publication_row.updated_at desc), '[]'::jsonb)
  into v_publication_requests
  from (
    select request.id, request.status_id, request.mentor_id, request.profile_id,
           request.status_date, request.requested_date, request.request_status,
           request.updated_at, request.resolved_at
    from public.client_publication_requests request
    where lower(request.client_email) = lower(v_portal)
    order by request.updated_at desc
  ) publication_row;

  update public.client_telegram_webapp_tokens
  set last_used_at = now()
  where member_id = v_member_id
    and token_hash = digest(btrim(p_token), 'sha256');

  return v_payload || jsonb_build_object(
    'calendar', v_calendar,
    'anketas', v_anketas,
    'text_approvals', v_text_approvals,
    'publication_requests', v_publication_requests,
    'can_approve_texts', coalesce(v_can_approve, false)
  );
end;
$$;

revoke all on function public.get_client_telegram_calendar(text, date, date)
  from public;
grant execute on function public.get_client_telegram_calendar(text, date, date)
  to anon, authenticated;

create or replace function public.request_client_telegram_publication_date(
  p_token text,
  p_status_id text,
  p_requested_date date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_portal text;
  v_member_id bigint;
  v_snapshot jsonb;
  v_anketa jsonb;
  v_status jsonb;
  v_existing public.client_publication_requests;
  v_result public.client_publication_requests;
  v_today date := (now() at time zone 'Europe/Moscow')::date;
begin
  select ctx.portal_email, ctx.member_id
  into v_portal, v_member_id
  from public.client_telegram_webapp_context(p_token) ctx;
  if v_portal is null then
    raise exception 'TOKEN_INVALID_OR_EXPIRED' using errcode = '42501';
  end if;
  if coalesce(btrim(p_status_id), '') = '' then
    raise exception 'STATUS_REQUIRED' using errcode = '22023';
  end if;
  if p_requested_date is null
     or p_requested_date < v_today
     or p_requested_date > v_today + 180 then
    raise exception 'DATE_OUT_OF_RANGE' using errcode = '22023';
  end if;

  select snapshot.payload into v_snapshot
  from public.client_snapshots snapshot
  where lower(snapshot.email) = lower(v_portal);

  select anketa.item, status.item
  into v_anketa, v_status
  from jsonb_array_elements(coalesce(v_snapshot -> 'anketas', '[]'::jsonb)) anketa(item)
  cross join lateral jsonb_array_elements(coalesce(anketa.item -> 'statuses', '[]'::jsonb)) status(item)
  where status.item ->> 'id' = p_status_id
    and status.item ->> 'status' = '🏆 Выбран'
  limit 1;
  if v_status is null then
    raise exception 'STATUS_NOT_AVAILABLE' using errcode = '42501';
  end if;

  select * into v_existing
  from public.client_publication_requests request
  where lower(request.client_email) = lower(v_portal)
    and request.status_id = p_status_id;
  if v_existing.id is not null
     and v_existing.request_status = 'accepted'
     and v_existing.status_date = (v_status ->> 'date')::date then
    raise exception 'DATE_ALREADY_ACCEPTED' using errcode = '23505';
  end if;

  insert into public.client_publication_requests (
    client_email, status_id, mentor_id, profile_id, status_date,
    anketa_code, anketa_name, account_name, requested_date,
    request_status, created_at, updated_at, resolved_at, resolved_by
  ) values (
    lower(v_portal), p_status_id,
    v_status ->> 'mentorId', v_status ->> 'profileId',
    (v_status ->> 'date')::date,
    v_anketa ->> 'code', v_anketa ->> 'name', v_status ->> 'profileName',
    p_requested_date, 'pending', now(), now(), null, null
  )
  on conflict (client_email, status_id) do update set
    mentor_id = excluded.mentor_id,
    profile_id = excluded.profile_id,
    status_date = excluded.status_date,
    anketa_code = excluded.anketa_code,
    anketa_name = excluded.anketa_name,
    account_name = excluded.account_name,
    requested_date = excluded.requested_date,
    request_status = 'pending',
    updated_at = now(),
    resolved_at = null,
    resolved_by = null
  returning * into v_result;

  update public.client_telegram_webapp_tokens
  set last_used_at = now()
  where member_id = v_member_id
    and token_hash = digest(btrim(p_token), 'sha256');

  return to_jsonb(v_result);
end;
$$;

revoke all on function public.request_client_telegram_publication_date(text, text, date)
  from public, anon, authenticated;
grant execute on function public.request_client_telegram_publication_date(text, text, date)
  to anon, authenticated;

create or replace function public.resolve_client_telegram_webapp_text_approval(
  p_token text,
  p_request_id bigint,
  p_decision text,
  p_comment text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_portal text;
  v_member_id bigint;
  v_decision text := lower(btrim(coalesce(p_decision, '')));
  v_request public.client_text_approval_requests;
  v_member public.client_telegram_members;
begin
  select ctx.portal_email, ctx.member_id
  into v_portal, v_member_id
  from public.client_telegram_webapp_context(p_token) ctx;
  if v_portal is null then
    raise exception 'TOKEN_INVALID_OR_EXPIRED' using errcode = '42501';
  end if;
  if v_decision not in ('approved', 'changes_requested') then
    raise exception 'DECISION_INVALID' using errcode = '22023';
  end if;
  if v_decision = 'changes_requested' and coalesce(btrim(p_comment), '') = '' then
    raise exception 'COMMENT_REQUIRED' using errcode = '22023';
  end if;
  if length(coalesce(p_comment, '')) > 1500 then
    raise exception 'COMMENT_TOO_LONG' using errcode = '22023';
  end if;

  select * into v_member
  from public.client_telegram_members member
  where member.id = v_member_id
    and lower(member.portal_email) = lower(v_portal)
    and member.is_active and member.is_text_approver
  for update;
  if v_member.id is null then
    raise exception 'TEXT_APPROVER_REQUIRED' using errcode = '42501';
  end if;

  select * into v_request
  from public.client_text_approval_requests request
  where request.id = p_request_id
    and lower(request.portal_email) = lower(v_portal)
  for update;
  if v_request.id is null then
    return jsonb_build_object('ok', false, 'reason', 'REQUEST_NOT_FOUND');
  end if;
  if v_request.request_status <> 'pending' then
    return jsonb_build_object(
      'ok', false, 'reason', 'ALREADY_RESOLVED',
      'status', v_request.request_status,
      'resolved_by', v_request.resolved_by_label
    );
  end if;

  update public.client_text_approval_requests
  set request_status = v_decision,
      updated_at = now(),
      resolved_at = now(),
      resolved_by_member_id = v_member.id,
      resolved_by_telegram_user_id = v_member.telegram_user_id,
      resolved_by_label = coalesce(v_member.contact_label,
        nullif(v_member.telegram_first_name, ''),
        nullif(v_member.telegram_username, ''), 'Контакт'),
      resolution_comment = nullif(btrim(p_comment), '')
  where id = v_request.id and request_status = 'pending'
  returning * into v_request;

  update public.notification_outbox
  set status = 'skipped', last_error = 'resolved in Telegram Mini App'
  where kind = 'client_text_approval'
    and action_ref = v_request.id::text
    and status = 'pending';

  insert into public.client_telegram_audit (
    portal_email, member_id, event_name, actor, details
  ) values (
    v_request.portal_email, v_member.id, 'text_approval_resolved',
    'telegram_webapp:' || v_member.telegram_user_id::text,
    jsonb_build_object(
      'request_id', v_request.id,
      'decision', v_decision,
      'source_review_id', v_request.source_review_id
    )
  );

  update public.client_telegram_webapp_tokens
  set last_used_at = now()
  where member_id = v_member_id
    and token_hash = digest(btrim(p_token), 'sha256');

  return jsonb_build_object(
    'ok', true,
    'request_id', v_request.id,
    'status', v_request.request_status,
    'resolved_by', v_request.resolved_by_label
  );
end;
$$;

revoke all on function public.resolve_client_telegram_webapp_text_approval(text, bigint, text, text)
  from public, anon, authenticated;
grant execute on function public.resolve_client_telegram_webapp_text_approval(text, bigint, text, text)
  to anon, authenticated;

notify pgrst, 'reload schema';

commit;
