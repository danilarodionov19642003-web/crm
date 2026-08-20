-- Harden client outreach history and publication approvals.
--
-- 1. Old snapshot-seeded outreach slots become history instead of staying in
--    the client's active plan forever.
-- 2. Publication approval updates the request and exactly one status row in
--    crm_state under a database lock. No full-blob read/modify/write race.
-- 3. Telegram notifications carry a stable request id for inline actions.

begin;

alter table public.notification_outbox
  add column if not exists action_ref text;

create index if not exists notification_outbox_kind_action_ref_idx
  on public.notification_outbox (kind, action_ref)
  where action_ref is not null;

-- Snapshot migration rows represent the old calendar copy. Once their date is
-- in the past they must not remain an active promise in the client cabinet.
update public.client_outreach_slots
set slot_status = 'cancelled',
    cancelled_at = coalesce(cancelled_at, now()),
    updated_at = now(),
    changed_by = 'migration-expired-plan'
where slot_status = 'scheduled'
  and scheduled_date < current_date
  and source in ('snapshot_seed', 'legacy_seed');

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

    status_list := coalesce(state_data -> 'profileStatuses', '[]'::jsonb);
    select item, (ordinality - 1)::int
      into status_row, status_index
    from jsonb_array_elements(status_list) with ordinality as status_item(item, ordinality)
    where item ->> 'id' = request_row.status_id
    limit 1;

    if status_row is null
       or status_row ->> 'status' <> '🏆 Выбран'
       or status_row ->> 'mentorId' <> request_row.mentor_id
       or status_row ->> 'profileId' <> request_row.profile_id
       or substring(coalesce(status_row ->> 'date', '') from 1 for 10) <> request_row.status_date::text then
      raise exception 'STATUS_NOT_AVAILABLE' using errcode = 'P0001';
    end if;

    -- Keep a recoverable before-state for this server-side point update.
    insert into public.crm_state_history (state_id, data, client_info)
    values ('main', state_data, 'resolve_client_publication_request:' || request_row.id::text);

    status_row := status_row || jsonb_build_object(
      'plannedActionDate', request_row.requested_date::text,
      'taskPlanSchema', 'separate-v1',
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

revoke all on function public.resolve_client_publication_request(bigint, boolean) from public;
grant execute on function public.resolve_client_publication_request(bigint, boolean)
  to authenticated, service_role;

-- Direct PATCH could close a request without updating crm_state. Force staff to
-- use the atomic RPC above.
drop policy if exists client_publication_requests_staff_update
  on public.client_publication_requests;
revoke update on public.client_publication_requests from authenticated;

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
     and OLD.requested_date = NEW.requested_date then
    return NEW;
  end if;

  msg := '📅 Клиент выбрал дату публикации' || E'\n'
      || '👤 ' || coalesce(NEW.anketa_code, '—') || ' · '
      || coalesce(NEW.anketa_name, NEW.client_email) || E'\n'
      || 'Аккаунт: ' || coalesce(NEW.account_name, '—') || E'\n'
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

-- Attach request ids to notifications that were queued before this migration.
update public.notification_outbox as outbox
set action_ref = (
  select request.id::text
  from public.client_publication_requests as request
  where request.request_status = 'pending'
    and request.client_email is not distinct from outbox.client_email
    and request.mentor_id is not distinct from outbox.mentor_id
    and request.profile_id is not distinct from outbox.profile_id
  order by request.updated_at desc
  limit 1
)
where outbox.kind = 'client_publication_request'
  and outbox.status = 'pending'
  and outbox.action_ref is null
  and exists (
    select 1
    from public.client_publication_requests as request
    where request.request_status = 'pending'
      and request.client_email is not distinct from outbox.client_email
      and request.mentor_id is not distinct from outbox.mentor_id
      and request.profile_id is not distinct from outbox.profile_id
  );

notify pgrst, 'reload schema';

commit;
