-- Expire unfinished outreach plans at the Moscow business-day boundary. Keep
-- expired rows for audit, but release them from the client's active plan so
-- the unused package remainder can be scheduled again.

begin;

create or replace function public.expire_past_client_outreach_slots()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business_today date := (now() at time zone 'Europe/Moscow')::date;
  v_changed_count int;
begin
  update public.client_outreach_slots
  set slot_status = 'cancelled',
      cancelled_at = coalesce(cancelled_at, now()),
      updated_at = now(),
      changed_by = 'system-expired-outreach'
  where slot_status = 'scheduled'
    and scheduled_date < v_business_today;

  get diagnostics v_changed_count = row_count;
  return v_changed_count;
end;
$$;

revoke all on function public.expire_past_client_outreach_slots()
  from public, anon, authenticated, service_role;

-- Staff pages use this narrow RPC before reading the shared schedule. The
-- underlying mutator remains private, and client sessions cannot run it.
create or replace function public.staff_expire_past_client_outreach_slots()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auth_role text := coalesce(auth.role(), '');
  v_app_role text := coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '');
begin
  if v_auth_role <> 'service_role'
     and (v_auth_role <> 'authenticated' or v_app_role not in ('owner', 'team')) then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  return public.expire_past_client_outreach_slots();
end;
$$;

revoke all on function public.staff_expire_past_client_outreach_slots()
  from public, anon, authenticated, service_role;
grant execute on function public.staff_expire_past_client_outreach_slots()
  to authenticated, service_role;

-- Preserve the current, feature-complete Telegram implementations as private
-- delegates. The wrappers add the Moscow date boundary without duplicating
-- the existing token, ownership, package, capacity and audit logic.
do $$
begin
  if to_regprocedure('public.get_client_telegram_calendar_v2(text,date,date)') is null then
    if to_regprocedure('public.get_client_telegram_calendar(text,date,date)') is null then
      raise exception 'get_client_telegram_calendar is missing';
    end if;
    alter function public.get_client_telegram_calendar(text, date, date)
      rename to get_client_telegram_calendar_v2;
  end if;

  if to_regprocedure('public.manage_client_telegram_outreach_slot_v1(text,text,text,bigint,date)') is null then
    if to_regprocedure('public.manage_client_telegram_outreach_slot(text,text,text,bigint,date)') is null then
      raise exception 'manage_client_telegram_outreach_slot is missing';
    end if;
    alter function public.manage_client_telegram_outreach_slot(text, text, text, bigint, date)
      rename to manage_client_telegram_outreach_slot_v1;
  end if;
end;
$$;

revoke all on function public.get_client_telegram_calendar_v2(text, date, date)
  from public, anon, authenticated, service_role;
revoke all on function public.manage_client_telegram_outreach_slot_v1(
  text, text, text, bigint, date
) from public, anon, authenticated, service_role;

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
  v_business_today date := (now() at time zone 'Europe/Moscow')::date;
  v_from date := greatest(coalesce(p_from, v_business_today + 1), v_business_today + 1);
  v_to date := coalesce(p_to, v_business_today + 45);
  v_payload jsonb;
begin
  perform 1
  from public.client_telegram_webapp_context(p_token);
  if not found then
    raise exception 'TOKEN_INVALID_OR_EXPIRED' using errcode = '42501';
  end if;

  perform public.expire_past_client_outreach_slots();

  v_payload := public.get_client_telegram_calendar_v2(p_token, v_from, v_to);

  return jsonb_set(
    v_payload,
    '{minimum_date}',
    to_jsonb((v_business_today + 1)::text),
    true
  );
end;
$$;

revoke all on function public.get_client_telegram_calendar(text, date, date)
  from public, anon, authenticated, service_role;
grant execute on function public.get_client_telegram_calendar(text, date, date)
  to anon, authenticated;

create or replace function public.manage_client_telegram_outreach_slot(
  p_token text,
  p_action text,
  p_mentor_id text,
  p_slot_id bigint,
  p_target_date date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business_today date := (now() at time zone 'Europe/Moscow')::date;
  v_action text := lower(btrim(coalesce(p_action, '')));
begin
  perform 1
  from public.client_telegram_webapp_context(p_token);
  if not found then
    raise exception 'TOKEN_INVALID_OR_EXPIRED' using errcode = '42501';
  end if;

  perform public.expire_past_client_outreach_slots();

  if v_action in ('add', 'move')
     and (
       p_target_date is null
       or p_target_date < v_business_today + 1
       or p_target_date > v_business_today + 180
     ) then
    raise exception 'DATE_OUT_OF_RANGE' using errcode = '22023';
  end if;

  return public.manage_client_telegram_outreach_slot_v1(
    p_token, p_action, p_mentor_id, p_slot_id, p_target_date
  );
end;
$$;

revoke all on function public.manage_client_telegram_outreach_slot(
  text, text, text, bigint, date
) from public, anon, authenticated, service_role;
grant execute on function public.manage_client_telegram_outreach_slot(
  text, text, text, bigint, date
) to anon, authenticated;

-- Apply the new boundary immediately to rows that became stale after midnight
-- in Moscow, including any row still considered current by UTC PostgreSQL.
select public.expire_past_client_outreach_slots();

notify pgrst, 'reload schema';

commit;
