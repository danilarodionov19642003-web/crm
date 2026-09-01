-- Let a client request the date of the next workflow status, not only the
-- publication date. Existing publication requests remain valid and keep the
-- same staff approval/Telegram callback path.

begin;

alter table public.client_publication_requests
  add column if not exists current_status text,
  add column if not exists target_status text;

update public.client_publication_requests
set current_status = coalesce(current_status, '🏆 Выбран'),
    target_status = coalesce(target_status, '🎯 Опубликован')
where current_status is null or target_status is null;

alter table public.client_publication_requests
  alter column current_status set not null,
  alter column target_status set not null;

create or replace function public.client_status_action_target(p_status text)
returns text
language sql
immutable
set search_path = public
as $$
  select case p_status
    when '💬 Начать диалог' then '✅ Обменяться'
    when '✅ Обменяться' then '⭐ Выбрать'
    when '⭐ Выбрать' then '🏆 Выбран'
    when '🏆 Выбран' then '🎯 Опубликован'
    else null
  end
$$;

revoke all on function public.client_status_action_target(text)
  from public, anon, authenticated;
grant execute on function public.client_status_action_target(text)
  to service_role;

alter table public.client_publication_requests
  drop constraint if exists client_publication_requests_status_transition_check;
alter table public.client_publication_requests
  add constraint client_publication_requests_status_transition_check
  check (target_status = public.client_status_action_target(current_status));

create or replace function public.request_client_publication_date(
  p_status_id text,
  p_requested_date date
)
returns public.client_publication_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_email text := public.current_client_portal_email();
  snapshot_payload jsonb;
  anketa jsonb;
  status_row jsonb;
  current_status_value text;
  target_status_value text;
  existing_row public.client_publication_requests;
  result_row public.client_publication_requests;
  business_today date := (now() at time zone 'Europe/Moscow')::date;
begin
  if auth.role() <> 'authenticated'
     or coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'client'
     or caller_email = '' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_status_id is null or btrim(p_status_id) = '' then
    raise exception 'STATUS_REQUIRED' using errcode = '22023';
  end if;
  if p_requested_date is null
     or p_requested_date < business_today
     or p_requested_date > business_today + 180 then
    raise exception 'DATE_OUT_OF_RANGE' using errcode = '22023';
  end if;

  select payload into snapshot_payload
  from public.client_snapshots
  where lower(email) = caller_email;
  if snapshot_payload is null then
    raise exception 'SNAPSHOT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select a.item, s.item into anketa, status_row
  from jsonb_array_elements(coalesce(snapshot_payload -> 'anketas', '[]'::jsonb)) a(item)
  cross join lateral jsonb_array_elements(coalesce(a.item -> 'statuses', '[]'::jsonb)) s(item)
  where s.item ->> 'id' = p_status_id
    and not coalesce((a.item ->> 'closed')::boolean, false)
  limit 1;

  current_status_value := status_row ->> 'status';
  target_status_value := public.client_status_action_target(current_status_value);
  if status_row is null or target_status_value is null then
    raise exception 'STATUS_NOT_AVAILABLE' using errcode = '42501';
  end if;

  select * into existing_row
  from public.client_publication_requests
  where lower(client_email) = caller_email and status_id = p_status_id;
  if existing_row.id is not null
     and existing_row.request_status = 'accepted'
     and existing_row.status_date = (status_row ->> 'date')::date
     and existing_row.current_status = current_status_value then
    raise exception 'DATE_ALREADY_ACCEPTED' using errcode = '23505';
  end if;

  insert into public.client_publication_requests (
    client_email, status_id, mentor_id, profile_id, status_date,
    anketa_code, anketa_name, account_name, current_status, target_status,
    requested_date, request_status, created_at, updated_at, resolved_at, resolved_by
  ) values (
    caller_email,
    p_status_id,
    status_row ->> 'mentorId',
    status_row ->> 'profileId',
    (status_row ->> 'date')::date,
    anketa ->> 'code',
    anketa ->> 'name',
    status_row ->> 'profileName',
    current_status_value,
    target_status_value,
    p_requested_date,
    'pending', now(), now(), null, null
  )
  on conflict (client_email, status_id) do update set
    mentor_id = excluded.mentor_id,
    profile_id = excluded.profile_id,
    status_date = excluded.status_date,
    anketa_code = excluded.anketa_code,
    anketa_name = excluded.anketa_name,
    account_name = excluded.account_name,
    current_status = excluded.current_status,
    target_status = excluded.target_status,
    requested_date = excluded.requested_date,
    request_status = 'pending',
    updated_at = now(),
    resolved_at = null,
    resolved_by = null
  returning * into result_row;
  return result_row;
end;
$$;

revoke all on function public.request_client_publication_date(text, date)
  from public, anon, authenticated, service_role;
grant execute on function public.request_client_publication_date(text, date)
  to authenticated;

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
  v_current_status text;
  v_target_status text;
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
    and not coalesce((anketa.item ->> 'closed')::boolean, false)
  limit 1;

  v_current_status := v_status ->> 'status';
  v_target_status := public.client_status_action_target(v_current_status);
  if v_status is null or v_target_status is null then
    raise exception 'STATUS_NOT_AVAILABLE' using errcode = '42501';
  end if;

  select * into v_existing
  from public.client_publication_requests request
  where lower(request.client_email) = lower(v_portal)
    and request.status_id = p_status_id;
  if v_existing.id is not null
     and v_existing.request_status = 'accepted'
     and v_existing.status_date = (v_status ->> 'date')::date
     and v_existing.current_status = v_current_status then
    raise exception 'DATE_ALREADY_ACCEPTED' using errcode = '23505';
  end if;

  insert into public.client_publication_requests (
    client_email, status_id, mentor_id, profile_id, status_date,
    anketa_code, anketa_name, account_name, current_status, target_status,
    requested_date, request_status, created_at, updated_at, resolved_at, resolved_by
  ) values (
    lower(v_portal), p_status_id,
    v_status ->> 'mentorId', v_status ->> 'profileId',
    (v_status ->> 'date')::date,
    v_anketa ->> 'code', v_anketa ->> 'name', v_status ->> 'profileName',
    v_current_status, v_target_status,
    p_requested_date, 'pending', now(), now(), null, null
  )
  on conflict (client_email, status_id) do update set
    mentor_id = excluded.mentor_id,
    profile_id = excluded.profile_id,
    status_date = excluded.status_date,
    anketa_code = excluded.anketa_code,
    anketa_name = excluded.anketa_name,
    account_name = excluded.account_name,
    current_status = excluded.current_status,
    target_status = excluded.target_status,
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
  from public, anon, authenticated, service_role;
grant execute on function public.request_client_telegram_publication_date(text, text, date)
  to anon, authenticated;

create or replace function public.enforce_client_publication_minimum()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wait integer;
  v_minimum date;
  v_today date := (now() at time zone 'Europe/Moscow')::date;
begin
  if NEW.request_status not in ('pending', 'accepted')
     or NEW.current_status <> '🏆 Выбран'
     or NEW.target_status <> '🎯 Опубликован' then
    return NEW;
  end if;

  v_wait := public.client_publication_wait_days(NEW.client_email, NEW.status_id);
  v_minimum := greatest(v_today, NEW.status_date + v_wait);
  if NEW.requested_date < v_minimum then
    raise exception 'PUBLICATION_TOO_EARLY:%:%', v_minimum, v_wait
      using errcode = '22023';
  end if;
  return NEW;
end;
$$;

create or replace function public.resolve_client_publication_request(
  p_request_id bigint,
  p_accept boolean
)
returns public.client_publication_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_role text := coalesce(auth.role()::text, '');
  app_role text := coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '');
  actor_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  desired_status text;
  request_row public.client_publication_requests;
  state_data jsonb;
  status_list jsonb;
  status_row jsonb;
  status_index int;
begin
  if caller_role <> 'service_role'
     and (caller_role <> 'authenticated' or app_role not in ('owner', 'team')) then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_request_id is null or p_accept is null then
    raise exception 'INVALID_ARGUMENTS' using errcode = '22023';
  end if;

  desired_status := case when p_accept then 'accepted' else 'rejected' end;

  select * into request_row
  from public.client_publication_requests
  where id = p_request_id
  for update;

  if request_row.id is null then
    raise exception 'REQUEST_NOT_FOUND' using errcode = 'P0002';
  end if;
  if request_row.request_status = desired_status then
    return request_row;
  end if;
  if request_row.request_status <> 'pending' then
    raise exception 'REQUEST_ALREADY_RESOLVED' using errcode = 'P0001';
  end if;

  if p_accept then
    select data into state_data
    from public.crm_state
    where id = 'main'
    for update;

    if state_data is null then
      raise exception 'CRM_STATE_NOT_FOUND' using errcode = 'P0002';
    end if;

    if exists (
      select 1
      from public.client_snapshots snapshot
      cross join lateral jsonb_array_elements(
        coalesce(snapshot.payload -> 'anketas', '[]'::jsonb)
      ) anketa(item)
      where lower(snapshot.email) = lower(request_row.client_email)
        and anketa.item ->> 'mentorId' = request_row.mentor_id
        and coalesce((anketa.item ->> 'closed')::boolean, false)
    ) then
      raise exception 'STATUS_NOT_AVAILABLE' using errcode = 'P0001';
    end if;

    status_list := coalesce(state_data -> 'profileStatuses', '[]'::jsonb);
    select item, (ordinality - 1)::int
      into status_row, status_index
    from jsonb_array_elements(status_list) with ordinality as status_item(item, ordinality)
    where item ->> 'id' = request_row.status_id
    limit 1;

    if status_row is null
       or status_row ->> 'status' <> request_row.current_status
       or public.client_status_action_target(status_row ->> 'status') <> request_row.target_status
       or status_row ->> 'mentorId' <> request_row.mentor_id
       or status_row ->> 'profileId' <> request_row.profile_id
       or substring(coalesce(status_row ->> 'date', '') from 1 for 10) <> request_row.status_date::text then
      raise exception 'STATUS_NOT_AVAILABLE' using errcode = 'P0001';
    end if;

    insert into public.crm_state_history (state_id, data, client_info)
    values ('main', state_data, 'resolve_client_status_action_request:' || request_row.id::text);

    status_row := status_row || jsonb_build_object(
      'plannedActionDate', request_row.requested_date::text,
      'nextActionStatus', request_row.target_status,
      'taskPlanSchema', 'separate-v1',
      'taskPlanSource', 'client',
      'updatedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
    status_list := jsonb_set(status_list, array[status_index::text], status_row, false);

    update public.crm_state
    set data = jsonb_set(state_data, '{profileStatuses}', status_list, true),
        updated_at = clock_timestamp()
    where id = 'main';
  end if;

  update public.client_publication_requests
  set request_status = desired_status,
      resolved_at = now(),
      resolved_by = coalesce(nullif(actor_email, ''), nullif(caller_role, ''), 'server'),
      updated_at = now()
  where id = request_row.id
  returning * into request_row;

  return request_row;
end;
$$;

revoke all on function public.resolve_client_publication_request(bigint, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.resolve_client_publication_request(bigint, boolean)
  to authenticated, service_role;

create or replace function public.notify_owner_publication_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owner_chat bigint := 6876234451;
  msg text;
begin
  if NEW.request_status <> 'pending' then return NEW; end if;
  if TG_OP = 'UPDATE'
     and OLD.request_status = 'pending'
     and OLD.requested_date = NEW.requested_date
     and OLD.current_status = NEW.current_status then
    return NEW;
  end if;

  msg := '📅 Клиент выбрал дату следующего этапа' || E'\n'
      || '👤 ' || coalesce(NEW.anketa_code, '—') || ' · '
      || coalesce(NEW.anketa_name, NEW.client_email) || E'\n'
      || 'Аккаунт: ' || coalesce(NEW.account_name, '—') || E'\n'
      || 'Этап: ' || NEW.current_status || ' → ' || NEW.target_status || E'\n'
      || 'Дата: ' || to_char(NEW.requested_date, 'DD.MM.YYYY');

  insert into public.notification_outbox (
    telegram_chat_id, kind, message, status,
    mentor_id, profile_id, client_email, action_ref
  ) values (
    owner_chat, 'client_publication_request', msg, 'pending',
    NEW.mentor_id, NEW.profile_id, NEW.client_email, NEW.id::text
  );
  return NEW;
end;
$$;

-- The public Telegram wrapper was introduced after the full cabinet function.
-- Keep the private v2 delegate intact and enrich only its request payload.
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
  v_business_today date := (now() at time zone 'Europe/Moscow')::date;
  v_from date := greatest(coalesce(p_from, v_business_today + 1), v_business_today + 1);
  v_to date := coalesce(p_to, v_business_today + 45);
  v_payload jsonb;
  v_requests jsonb;
begin
  select ctx.portal_email into v_portal
  from public.client_telegram_webapp_context(p_token) ctx;
  if v_portal is null then
    raise exception 'TOKEN_INVALID_OR_EXPIRED' using errcode = '42501';
  end if;

  perform public.expire_past_client_outreach_slots();
  v_payload := public.get_client_telegram_calendar_v2(p_token, v_from, v_to);

  select coalesce(jsonb_agg(to_jsonb(request_row) order by request_row.updated_at desc), '[]'::jsonb)
  into v_requests
  from (
    select request.id, request.status_id, request.mentor_id, request.profile_id,
           request.status_date, request.current_status, request.target_status,
           request.requested_date, request.request_status,
           request.updated_at, request.resolved_at
    from public.client_publication_requests request
    where lower(request.client_email) = lower(v_portal)
    order by request.updated_at desc
  ) request_row;

  v_payload := jsonb_set(v_payload, '{publication_requests}', v_requests, true);
  v_payload := jsonb_set(v_payload, '{minimum_date}', to_jsonb((v_business_today + 1)::text), true);
  return jsonb_set(v_payload, '{business_today}', to_jsonb(v_business_today::text), true);
end;
$$;

revoke all on function public.get_client_telegram_calendar(text, date, date)
  from public, anon, authenticated, service_role;
grant execute on function public.get_client_telegram_calendar(text, date, date)
  to anon, authenticated;

notify pgrst, 'reload schema';

commit;
